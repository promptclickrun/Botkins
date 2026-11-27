import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import {
  analyzeWorkflowFields,
  evaluateCondition,
  parseTemplateTokens,
  resolveTemplate,
  validateWorkflow,
} from "../desktop/workflow-fields.mjs";
import { exportWorkflow, parseImportedWorkflow, WORKFLOW_SCHEMA_VERSION } from "../desktop/workflow-port.mjs";
import { EventEmitter } from "node:events";
import {
  WorkflowGithubAuth,
  findMentionInText,
  parseGhAuthStatus,
  parseGhDeviceOutput,
  parseMentionHandles,
} from "../desktop/workflow-github.mjs";

function setup(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-workflows-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prompts = [];
  const handlers = new Set();
  const notifications = [];
  let replyFn = opts.replyFn ?? ((prompt) => `Agent summary for: ${prompt.slice(0, 60)}`);

  const session = {
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    emit: (event) => handlers.forEach((handler) => handler(event)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      prompts.push(prompt);
      const messageId = "wf-msg-" + prompts.length;
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      const content = await replyFn(prompt, prompts.length);
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };

  const client = async () => ({
    createSession: async () => session,
    resumeSession: async () => session,
    deleteSession: async () => {},
  });

  const ws = new Workspace(
    dir,
    client,
    (ev) => notifications.push(ev),
    { workflows: opts.workflows },
  );

  return {
    ws,
    prompts,
    notifications,
    setReplyFn: (fn) => {
      replyFn = fn;
    },
  };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for condition");
}

/* ================================================================
   1. Field resolver, path analysis & no-model condition evaluator
   ================================================================ */

test("{{field}} resolver supports dotted fields, optional syntax, and missing-field warnings", () => {
  const tokens = parseTemplateTokens("Hi {{title}}, result={{result?}} and {{missing}} ({{nested.key}})");
  assert.deepEqual(
    tokens.map((t) => [t.name, t.optional]),
    [
      ["title", false],
      ["result", true],
      ["missing", false],
      ["nested.key", false],
    ],
  );

  const rendered = resolveTemplate("Task {{title}} → {{to}} ({{note?}}) [{{nope}}]", {
    title: "Ship workflows",
    to: "review",
  });
  assert.equal(rendered, "Task Ship workflows → review () []");
  assert.throws(
    () => resolveTemplate("Task {{title}} [{{nope}}]", { title: "Ship" }, { strict: true }),
    /nope/,
  );
  // Optional missing field does not throw even in strict mode
  assert.equal(resolveTemplate("Task {{title}} ({{note?}})", { title: "Ship" }, { strict: true }), "Task Ship ()");
});

test("analyzeWorkflowFields flags partial-path fields when not every upstream path provides them", () => {
  const wf = {
    nodes: [
      { id: "t1", kind: "trigger", triggerKind: "task", label: "Task trigger", config: {} },
      { id: "c1", kind: "condition", label: "Check", config: { expression: "to = review" } },
      {
        id: "m1",
        kind: "model",
        label: "Classify",
        config: { prompt: "{{title}}", outputFields: [{ name: "severity", type: "string", choices: ["low", "high"] }] },
      },
      {
        id: "o1",
        kind: "output",
        label: "Notify",
        // `severity` comes ONLY through m1, NOT through c1 -> o1 directly, so it is partial!
        config: { destination: "chat", template: "{{title}} · {{severity}} · {{unknown_field}}" },
      },
    ],
    edges: [
      { id: "e1", from: "t1", to: "c1", branch: "default" },
      { id: "e2", from: "c1", to: "m1", branch: "yes" },
      { id: "e3", from: "m1", to: "o1", branch: "default" },
      { id: "e4", from: "c1", to: "o1", branch: "no" },
    ],
  };

  const analysis = analyzeWorkflowFields(wf);
  const out = analysis.o1;
  assert.ok(out.available.some((f) => f.name === "title" && f.guaranteed === true));
  assert.ok(out.available.some((f) => f.name === "severity" && f.guaranteed === false));
  assert.ok(out.problems.some((p) => p.kind === "partial" && p.field === "severity"));
  assert.ok(out.problems.some((p) => p.kind === "missing" && p.field === "unknown_field"));
});

test("condition evaluator works deterministically with no model", () => {
  assert.equal(evaluateCondition({ expression: "status = review" }, { status: "review" }).matched, true);
  assert.equal(evaluateCondition({ expression: "status = review" }, { status: "working" }).matched, false);
  assert.equal(evaluateCondition({ expression: "count >= 3" }, { count: 5 }).matched, true);
  assert.equal(evaluateCondition({ expression: "title contains urgent" }, { title: "Urgent hotfix" }).matched, true);

  assert.equal(
    evaluateCondition(
      {
        match: "all",
        rules: [
          { field: "to", op: "equals", value: "review" },
          { field: "bot", op: "in", value: "Alfie, Glory" },
        ],
      },
      { to: "review", bot: "Alfie" },
    ).matched,
    true,
  );
  assert.equal(
    evaluateCondition(
      {
        match: "any",
        rules: [
          { field: "to", op: "equals", value: "done" },
          { field: "result", op: "exists" },
        ],
      },
      { to: "review", result: "PR #42" },
    ).matched,
    true,
  );
});

test("validateWorkflow rejects cyclic graphs", () => {
  const res = validateWorkflow({
    nodes: [
      { id: "a", kind: "trigger", triggerKind: "manual", label: "M", config: {} },
      { id: "b", kind: "condition", label: "C", config: {} },
    ],
    edges: [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "a" },
    ],
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /cycle/i.test(e)));
});

/* ================================================================
   2. Export / Import: agents by name, secret refusal, update required
   ================================================================ */

test("export/import serializes agents by name, refuses secrets, rejects newer schema versions, and starts paused", () => {
  const bots = [{ id: "bot_1", name: "Alfie" }];
  const wf = {
    id: "wf_1",
    name: "Review handoff",
    description: "Clean workflow",
    enabled: true,
    nodes: [
      {
        id: "t1",
        kind: "trigger",
        triggerKind: "webhook",
        label: "Webhook",
        position: { x: 40, y: 80 },
        config: { routeId: "rt_abc", secretRef: "vault:v_1", hasSecret: true },
      },
      {
        id: "a1",
        kind: "agent",
        label: "Run Alfie",
        position: { x: 340, y: 80 },
        config: { botId: "bot_1", prompt: "Inspect {{payload}}" },
      },
    ],
    edges: [{ id: "e1", from: "t1", to: "a1", branch: "default" }],
  };

  const exported = exportWorkflow(wf, bots);
  assert.equal(exported.schemaVersion, WORKFLOW_SCHEMA_VERSION);
  assert.equal(exported.workflow.nodes[1].config.botName, "Alfie");
  assert.equal(exported.workflow.nodes[1].config.botId, undefined);
  // Secrets & vault refs are stripped from export
  assert.equal(exported.workflow.nodes[0].config.secretRef, undefined);
  assert.equal(exported.workflow.nodes[0].config.secret, undefined);

  // Import resolves Alfie by name and always starts paused (`enabled: false`)
  const imported = parseImportedWorkflow(exported, bots);
  assert.equal(imported.draft.enabled, false);
  assert.equal(imported.draft.nodes[1].config.botId, "bot_1");
  assert.deepEqual(imported.unresolvedAgents, []);

  // Refuse files containing a secret (e.g. GitHub PAT or OpenAI key)
  const leaky = structuredClone(exported);
  leaky.workflow.nodes[1].config.prompt = "Use token ghp_1234567890abcdefghij1234567890abcdef";
  assert.throws(() => parseImportedWorkflow(leaky, bots), /secret/i);

  // Refuse export when a user accidentally typed a secret into a prompt
  const leakyWf = structuredClone(wf);
  leakyWf.nodes[1].config.prompt = "Bearer sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz";
  assert.throws(() => exportWorkflow(leakyWf, bots), /secret/i);

  // Refuse newer schema version with "Update required"
  const future = structuredClone(exported);
  future.schemaVersion = WORKFLOW_SCHEMA_VERSION + 5;
  assert.throws(() => parseImportedWorkflow(future, bots), /update required/i);
});

/* ================================================================
   3. Graph runner: branching, model step, approval wait, retry, pause,
      one-open-run rule & missed-schedule collapse
   ================================================================ */

test("graph runner branches deterministically with condition (no model) and skips untaken branch", async (t) => {
  const { ws } = setup(t);
  const wf = ws.workflows.create({
    name: "Branch test",
    nodes: [
      { id: "t1", kind: "trigger", triggerKind: "manual", label: "Manual", config: {} },
      { id: "c1", kind: "condition", label: "Is urgent?", config: { expression: "priority = urgent" } },
      { id: "o_yes", kind: "output", label: "Urgent feed", config: { destination: "feed", title: "URGENT {{item}}", template: "Go now" } },
      { id: "o_no", kind: "output", label: "Normal idea", config: { destination: "idea", title: "Later {{item}}", template: "Backlog" } },
    ],
    edges: [
      { id: "e1", from: "t1", to: "c1", branch: "default" },
      { id: "e2", from: "c1", to: "o_yes", branch: "yes" },
      { id: "e3", from: "c1", to: "o_no", branch: "no" },
    ],
  });

  const runYes = await ws.workflows.runManual(wf.id, { inputs: { priority: "urgent", item: "DB outage" } });
  await waitFor(() => ws.workflows.getRun(runYes.id)?.status === "completed");
  const doneYes = ws.workflows.getRun(runYes.id);
  assert.equal(doneYes.steps.c1.branch, "yes");
  assert.equal(doneYes.steps.o_yes.status, "completed");
  assert.equal(doneYes.steps.o_no.status, "skipped");
  assert.ok(ws.state.board.some((b) => b.kind === "feed" && b.title === "URGENT DB outage"));

  const runNo = await ws.workflows.runManual(wf.id, { inputs: { priority: "low", item: "Refactor" } });
  await waitFor(() => ws.workflows.getRun(runNo.id)?.status === "completed");
  const doneNo = ws.workflows.getRun(runNo.id);
  assert.equal(doneNo.steps.c1.branch, "no");
  assert.equal(doneNo.steps.o_no.status, "completed");
  assert.equal(doneNo.steps.o_yes.status, "skipped");
  assert.ok(ws.state.board.some((b) => b.kind === "idea" && b.title === "Later Refactor"));
});

test("model step performs one-shot structured extraction into downstream {{fields}}", async (t) => {
  const { ws } = setup(t, {
    replyFn: () => JSON.stringify({ risk: "high", summary: "Touches auth middleware" }),
  });
  const wf = ws.workflows.create({
    name: "Model structured output",
    nodes: [
      { id: "t1", kind: "trigger", triggerKind: "manual", label: "Manual", config: {} },
      {
        id: "m1",
        kind: "model",
        label: "Assess risk",
        config: {
          prompt: "Assess PR {{title}}",
          outputFields: [
            { name: "risk", type: "string", choices: ["low", "high"] },
            { name: "summary", type: "string" },
          ],
        },
      },
      { id: "o1", kind: "output", label: "Post Feed", config: { destination: "feed", title: "Risk: {{risk}}", template: "{{summary}}" } },
    ],
    edges: [
      { id: "e1", from: "t1", to: "m1" },
      { id: "e2", from: "m1", to: "o1" },
    ],
  });

  const run = await ws.workflows.runManual(wf.id, { inputs: { title: "Auth rewrite" } });
  await waitFor(() => ws.workflows.getRun(run.id)?.status === "completed");
  const feed = ws.state.board.find((b) => b.title === "Risk: high");
  assert.ok(feed);
  assert.equal(feed.body, "Touches auth middleware");
});

test("approval step pauses run, notifies person, and branches on Approve vs Reject", async (t) => {
  const { ws, notifications } = setup(t);
  const wf = ws.workflows.create({
    name: "Approval gate",
    nodes: [
      { id: "t1", kind: "trigger", triggerKind: "manual", label: "Manual", config: {} },
      { id: "ap1", kind: "approval", label: "Approve deploy?", config: { message: "Ship {{release}}?", noteField: "reviewer_note" } },
      { id: "o_ok", kind: "output", label: "Approved post", config: { destination: "feed", title: "Shipped {{release}}", template: "Note: {{reviewer_note}}" } },
      { id: "o_no", kind: "output", label: "Rejected post", config: { destination: "feed", title: "Held {{release}}", template: "Reason: {{reviewer_note}}" } },
    ],
    edges: [
      { id: "e1", from: "t1", to: "ap1" },
      { id: "e2", from: "ap1", to: "o_ok", branch: "approved" },
      { id: "e3", from: "ap1", to: "o_no", branch: "rejected" },
    ],
  });

  const approvalEvents = [];
  ws.events.on("workflow.approval", (ev) => approvalEvents.push(ev));

  // 1) Approve path
  const r1 = await ws.workflows.runManual(wf.id, { inputs: { release: "v2.0" } });
  await waitFor(() => ws.workflows.getRun(r1.id)?.status === "waiting_approval");
  assert.equal(approvalEvents.length, 1);
  assert.equal(ws.workflows.getRun(r1.id).pendingApproval.message, "Ship v2.0?");

  ws.workflows.respondApproval(r1.id, "ap1", "approved", "LGTM");
  await waitFor(() => ws.workflows.getRun(r1.id)?.status === "completed");
  assert.ok(ws.state.board.some((b) => b.title === "Shipped v2.0" && b.body === "Note: LGTM"));

  // 2) Reject path
  const r2 = await ws.workflows.runManual(wf.id, { inputs: { release: "v2.1" } });
  await waitFor(() => ws.workflows.getRun(r2.id)?.status === "waiting_approval");
  ws.workflows.respondApproval(r2.id, "ap1", "rejected", "Wait for tests");
  await waitFor(() => ws.workflows.getRun(r2.id)?.status === "completed");
  assert.ok(ws.state.board.some((b) => b.title === "Held v2.1" && b.body === "Reason: Wait for tests"));
});

test("retry from failed step reuses upstream values and runs with the node's CURRENT settings", async (t) => {
  const { ws } = setup(t);
  const wf = ws.workflows.create({
    name: "Retry test",
    nodes: [
      { id: "t1", kind: "trigger", triggerKind: "manual", label: "Manual", config: {} },
      // Initially broken: agent references an unknown botId so it fails!
      { id: "a1", kind: "agent", label: "Bot step", config: { botId: "missing_bot_id", prompt: "Handle {{item}}", outputKey: "agent_reply" } },
      { id: "o1", kind: "output", label: "Feed", config: { destination: "feed", title: "Retried {{item}}", template: "{{agent_reply}}" } },
    ],
    edges: [
      { id: "e1", from: "t1", to: "a1" },
      { id: "e2", from: "a1", to: "o1" },
    ],
  });

  const run = await ws.workflows.runManual(wf.id, { inputs: { item: "Invoice #9" } });
  await waitFor(() => ws.workflows.getRun(run.id)?.status === "failed");
  assert.equal(ws.workflows.getRun(run.id).steps.a1.status, "failed");

  // Fix the node's config on the workflow (point to valid primary bot "pip")
  const primaryBotId = ws.state.bots[0].id;
  ws.workflows.update(wf.id, {
    nodes: wf.nodes.map((n) => (n.id === "a1" ? { ...n, config: { ...n.config, botId: primaryBotId, prompt: "Updated prompt for {{item}}" } } : n)),
  });

  // Retry from the failed step — should pick up the new botId & prompt AND still have {{item}} from t1!
  await ws.workflows.retryRun(run.id);
  await waitFor(() => ws.workflows.getRun(run.id)?.status === "completed");
  const done = ws.workflows.getRun(run.id);
  assert.equal(done.steps.a1.status, "completed");
  assert.equal(done.steps.o1.status, "completed");
  const post = ws.state.board.find((b) => b.title === "Retried Invoice #9");
  assert.ok(post);
  assert.match(post.body, /Updated prompt for Invoice #9/);
});

test("pause semantics, one-open-run rule, and missed-schedule collapse", async (t) => {
  const { ws } = setup(t);
  const T0 = Date.UTC(2026, 5, 1, 8, 0, 0); // 2026-06-01 08:00 UTC

  const wf = ws.workflows.create({
    name: "Scheduled gate",
    nodes: [
      { id: "t1", kind: "trigger", triggerKind: "schedule", label: "Every hour", config: { cadence: "custom", cron: "0 * * * *", timezone: "UTC" } },
      { id: "ap1", kind: "approval", label: "Hold", config: { message: "Run at {{local_date}}" } },
    ],
    edges: [{ id: "e1", from: "t1", to: "ap1" }],
  });

  // Set nextAt explicitly to T0 + 1h (09:00)
  const trig = ws.state.workflows[0].nodes[0];
  trig.config.nextAt = T0 + 3600_000;

  // 1) Pause: schedule ticks are skipped (no run starts), but manual run STILL works!
  ws.workflows.pause(wf.id);
  await ws.workflows.tick(T0 + 5 * 3600_000); // 5 hours later while paused
  assert.equal(ws.workflows.listRuns(wf.id).length, 0);

  const manual = await ws.workflows.runManual(wf.id);
  await waitFor(() => ws.workflows.getRun(manual.id)?.status === "waiting_approval");
  ws.workflows.cancelRun(manual.id);
  assert.equal(ws.workflows.listRuns(wf.id).length, 1);

  // 2) Resume skips missed occurrences (sets nextAt strictly after resume time)
  ws.workflows.resume(wf.id, T0 + 5 * 3600_000 + 60_000); // 13:01 UTC -> nextAt should be 14:00 UTC
  assert.ok(trig.config.nextAt > T0 + 5 * 3600_000 + 60_000);
  await ws.workflows.tick(T0 + 5 * 3600_000 + 120_000); // 13:02 UTC -> still before 14:00, no catch-up run
  assert.equal(ws.workflows.listRuns(wf.id).length, 1);

  // 3) Missed occurrences while enabled collapse to ONE run (advance 4 hours past 14:00 -> 18:05)
  await ws.workflows.tick(T0 + 10 * 3600_000 + 300_000);
  await waitFor(() => ws.workflows.listRuns(wf.id).length === 2);
  const runsAfterCollapse = ws.workflows.listRuns(wf.id);
  assert.equal(runsAfterCollapse.length, 2); // only 1 new schedule run, NOT 5!
  assert.equal(runsAfterCollapse[0].status, "waiting_approval");

  // 4) One-open-run rule: while that run is still open (waiting_approval), another due tick does NOT open a second run
  trig.config.nextAt = T0 + 11 * 3600_000;
  await ws.workflows.tick(T0 + 12 * 3600_000);
  assert.equal(ws.workflows.listRuns(wf.id).length, 2);
});

/* ================================================================
   4. All Triggers + End-to-End Task → Review → Agent → Chat
   ================================================================ */

test("END-TO-END: task status → review → condition → agent step → chat output fires exactly once", async (t) => {
  const { ws, prompts } = setup(t, {
    replyFn: (prompt) => `Reviewed! Summary based on: ${prompt.split("\n")[0]}`,
  });
  const bot = ws.state.bots[0];
  const targetChatId = ws.state.chats.find((c) => c.botId === bot.id && !c.panelId)?.id ?? ws.newChat(bot.id).id;

  const wf = ws.workflows.create({
    name: "Task review to chat",
    nodes: [
      { id: "trig", kind: "trigger", triggerKind: "task", label: "Task moves to Review", config: { event: "status_changed", toStatus: "review" } },
      { id: "cond", kind: "condition", label: "Confirm review", config: { expression: "to = review" } },
      {
        id: "agent",
        kind: "agent",
        label: "Bot summarizes result",
        config: { botId: bot.id, outputKey: "agent_reply", prompt: "Task {{title}} moved {{from}}→{{to}}. Result: {{result}}" },
      },
      {
        id: "out",
        kind: "output",
        label: "Post to chat",
        config: { destination: "chat", chatId: targetChatId, botId: bot.id, template: "[Review Ready] {{title}} — {{agent_reply}}" },
      },
    ],
    edges: [
      { id: "e1", from: "trig", to: "cond" },
      { id: "e2", from: "cond", to: "agent", branch: "yes" },
      { id: "e3", from: "agent", to: "out" },
    ],
  });

  // Create a task in "later" -> should NOT fire
  const taskId = ws.tasks.save({ title: "Ship Workflows PR", details: "Add visual canvas", botId: bot.id, status: "later" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ws.workflows.listRuns(wf.id).length, 0);

  // Set a task result and flip to "review" -> fires EXACTLY ONCE
  const taskObj = ws.state.tasks.find((x) => x.id === taskId);
  taskObj.result = "PR #404 opened with tests passing";
  ws.tasks.move(taskId, "review");

  // Re-moving to "review" (no-op) must NOT fire a second time!
  ws.tasks.move(taskId, "review");

  const finished = await waitFor(() => {
    const runs = ws.workflows.listRuns(wf.id);
    return runs.length > 0 && runs[0].status === "completed" ? runs[0] : null;
  });

  assert.equal(ws.workflows.listRuns(wf.id).length, 1);
  assert.equal(finished.steps.trig.status, "completed");
  assert.equal(finished.steps.cond.branch, "yes");
  assert.equal(finished.steps.agent.status, "completed");
  assert.equal(finished.steps.out.status, "completed");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Ship Workflows PR/);
  assert.match(prompts[0], /PR #404 opened/);

  // Verify the formatted message landed in the target chat!
  const chatMessages = ws.chat(targetChatId).messages;
  const posted = chatMessages.find((m) => m.role === "assistant" && m.text.includes("[Review Ready] Ship Workflows PR"));
  assert.ok(posted, "Expected workflow output message in target chat");
  assert.match(posted.text, /Reviewed! Summary based on: Task Ship Workflows PR/);
});

test("webhook trigger enforces secret auth (Bearer & HMAC), 64KB body cap, and case-sensitive JSON fields", async (t) => {
  const { ws } = setup(t);
  const wf = ws.workflows.create({
    name: "Webhook deploy",
    nodes: [
      {
        id: "wh",
        kind: "trigger",
        triggerKind: "webhook",
        label: "Deploy hook",
        config: { fields: [{ name: "Service", type: "string" }, { name: "service", type: "string" }] },
      },
      { id: "o1", kind: "output", label: "Feed", config: { destination: "feed", title: "{{Service}} / {{service}}", template: "{{payload}}" } },
    ],
    edges: [{ id: "e1", from: "wh", to: "o1" }],
  });

  const { routeId, secret } = ws.workflows.rotateWebhookSecret(wf.id, "wh");

  // Missing/wrong secret -> 401
  const bad = await ws.workflows.handleWebhook(routeId, { headers: {}, rawBody: Buffer.from("{}") });
  assert.equal(bad.status, 401);

  // Oversized body (> 64KB) -> 413
  const huge = await ws.workflows.handleWebhook(routeId, {
    headers: { authorization: `Bearer ${secret}` },
    rawBody: Buffer.alloc(70 * 1024, "a"),
  });
  assert.equal(huge.status, 413);

  // Valid HMAC-SHA256 signature with case-sensitive JSON keys
  const bodyBuf = Buffer.from(JSON.stringify({ Service: "API", service: "web" }));
  const sig = "sha256=" + createHmac("sha256", secret).update(bodyBuf).digest("hex");
  const ok = await ws.workflows.handleWebhook(routeId, {
    headers: { "x-hub-signature-256": sig, "content-type": "application/json" },
    rawBody: bodyBuf,
  });
  assert.equal(ok.status, 202);
  await waitFor(() => ws.workflows.getRun(ok.body.runId)?.status === "completed");
  assert.ok(ws.state.board.some((b) => b.title === "API / web"));
});

test("routine finished, chat mention, and GitHub polling triggers fire with expected fields", async (t) => {
  let prBatch = [];

  const { ws } = setup(t, {
    workflows: {
      githubPoller: async () => prBatch,
    },
  });
  const bot = ws.state.bots[0];

  // 1) Routine finished trigger + existing routine compatibility (runs a real existing routine!)
  const routineId = ws.panels.routines.create({
    botId: bot.id,
    name: "Morning check",
    prompt: "Check inbox",
    cadence: { kind: "daily", time: "09:00" },
  });
  const wfRoutine = ws.workflows.create({
    name: "After morning check",
    nodes: [
      { id: "tr", kind: "trigger", triggerKind: "routine", label: "After routine", config: { routineChatId: routineId } },
      { id: "o1", kind: "output", label: "Feed", config: { destination: "feed", title: "Follow-up: {{routine_name}}", template: "{{result}}" } },
    ],
    edges: [{ id: "e1", from: "tr", to: "o1" }],
  });
  await ws.panels.routines.run(routineId);
  await waitFor(() => ws.workflows.listRuns(wfRoutine.id)[0]?.status === "completed");
  assert.ok(ws.state.board.some((b) => b.title.includes("Morning check") && b.body.includes("Agent summary")));

  // 2) Chat message / @mention trigger
  const wfChat = ws.workflows.create({
    name: "Mention watcher",
    nodes: [
      { id: "tc", kind: "trigger", triggerKind: "chat", label: "On @mention", config: { mentionOnly: true, textContains: "deploy" } },
      { id: "o1", kind: "output", label: "Feed", config: { destination: "feed", title: "Mention from {{sender}}", template: "{{text}}" } },
    ],
    edges: [{ id: "e1", from: "tc", to: "o1" }],
  });
  const sampleChat = ws.state.chats[0];
  // Without mention -> ignored
  await ws.workflows.onChatMessage({ chat: sampleChat, bot, sender: "Colt", text: "deploy now", time: Date.now() });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ws.workflows.listRuns(wfChat.id).length, 0);
  // With mention -> fires
  await ws.workflows.onChatMessage({ chat: sampleChat, bot, sender: "Colt", text: `@${bot.name} deploy now`, time: Date.now() });
  await waitFor(() => ws.workflows.listRuns(wfChat.id)[0]?.status === "completed");
  assert.ok(ws.state.board.some((b) => b.title === "Mention from Colt"));

  // 3) GitHub polling trigger (seeds baseline, fires on new PR, deduplicates unchanged, fires on review change)
  const wfGh = ws.workflows.create({
    name: "PR watcher",
    nodes: [
      { id: "tg", kind: "trigger", triggerKind: "github", label: "Botkins PRs", config: { repo: "promptclickrun/Botkins", pollMinutes: 1 } },
      { id: "o1", kind: "output", label: "Feed", config: { destination: "feed", title: "PR #{{number}} ({{event}})", template: "{{title}} · {{status}}" } },
    ],
    edges: [{ id: "e1", from: "tg", to: "o1" }],
  });
  const baseNow = Date.UTC(2026, 6, 1, 12, 0, 0);
  // Seed baseline with empty open PR list
  await ws.workflows.tick(baseNow);
  assert.equal(ws.workflows.listRuns(wfGh.id).length, 0);

  // New PR #12 opens -> fires pr_opened
  prBatch = [
    {
      number: 12,
      title: "Add workflow canvas",
      url: "https://github.com/promptclickrun/Botkins/pull/12",
      author: { login: "glory" },
      state: "OPEN",
      reviewDecision: "",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      updatedAt: "2026-06-01T10:00:00Z",
    },
  ];
  await ws.workflows.tick(baseNow + 120_000);
  await waitFor(() => ws.workflows.listRuns(wfGh.id)[0]?.status === "completed");
  assert.equal(ws.workflows.listRuns(wfGh.id).length, 1);
  assert.ok(ws.state.board.some((b) => b.title === "PR #12 (pr_opened)"));

  // Same PR snapshot on next poll -> 0 new runs
  await ws.workflows.tick(baseNow + 240_000);
  assert.equal(ws.workflows.listRuns(wfGh.id).length, 1);

  // Review approved on next poll -> fires pr_review
  prBatch = [{ ...prBatch[0], reviewDecision: "APPROVED" }];
  await ws.workflows.tick(baseNow + 360_000);
  await waitFor(() => ws.workflows.listRuns(wfGh.id).length === 2 && ws.workflows.listRuns(wfGh.id)[0].status === "completed");
  assert.ok(ws.state.board.some((b) => b.title === "PR #12 (pr_review)"));
});

/* ================================================================
   5. Bot tools: create / update / list / pause / resume / run / delete
   ================================================================ */

test("bot workflow tools create, update, pause, resume, run and delete workflows live", async (t) => {
  const { ws } = setup(t);
  const bot = ws.state.bots[0];
  const chat = ws.state.chats[0];
  const tools = ws.workflows.tools(bot, chat, null, null);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.ok(byName.has("workflow_create"));
  assert.ok(byName.has("workflow_update"));
  assert.ok(byName.has("workflow_list"));
  assert.ok(byName.has("workflow_run"));
  assert.ok(byName.has("workflow_pause"));
  assert.ok(byName.has("workflow_resume"));
  assert.ok(byName.has("workflow_delete"));

  // Strict field validation rejects undeclared fields when bots create workflows
  await assert.rejects(
    () =>
      byName.get("workflow_create").handler({
        name: "Broken refs",
        nodes: [
          { id: "m", kind: "trigger", triggerKind: "manual", label: "Manual", config: {} },
          { id: "o", kind: "output", label: "Post Feed", config: { destination: "feed", title: "{{nonexistent}}", template: "Hi" } },
        ],
        edges: [{ id: "e1", from: "m", to: "o" }],
      }),
    /nonexistent/,
  );

  const created = await byName.get("workflow_create").handler({
    name: "Built by bot",
    nodes: [
      { id: "m", kind: "trigger", triggerKind: "manual", label: "Manual", config: { inputs: [{ name: "note", type: "string" }] } },
      { id: "o", kind: "output", label: "Post Feed", config: { destination: "feed", title: "Bot built {{note}}", template: "Live!" } },
    ],
    edges: [{ id: "e1", from: "m", to: "o" }],
  });
  assert.ok(created.id);
  assert.equal(ws.state.workflows.length, 1);

  await byName.get("workflow_pause").handler({ id: created.id });
  assert.equal(ws.workflows.get(created.id).enabled, false);

  await byName.get("workflow_resume").handler({ id: created.id });
  assert.equal(ws.workflows.get(created.id).enabled, true);

  const runRes = await byName.get("workflow_run").handler({ id: created.id, inputs: { note: "v1" } });
  await waitFor(() => ws.workflows.getRun(runRes.runId)?.status === "completed");
  assert.ok(ws.state.board.some((b) => b.title === "Bot built v1"));

  await byName.get("workflow_update").handler({ id: created.id, name: "Built & updated by bot" });
  assert.equal(ws.workflows.get(created.id).name, "Built & updated by bot");

  const listed = await byName.get("workflow_list").handler({});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Built & updated by bot");

  await byName.get("workflow_delete").handler({ id: created.id });
  assert.equal(ws.state.workflows.length, 0);
});

test("workflows and workflowRuns persist across workspace restart", async (t) => {
  const { ws, providers } = setup(t);
  const wf = ws.workflows.create({
    name: "Persisted flow",
    nodes: [
      { id: "m", kind: "trigger", triggerKind: "manual", label: "Manual", config: {} },
      { id: "o", kind: "output", label: "Feed", config: { destination: "feed", title: "Saved", template: "Persisted" } },
    ],
    edges: [{ id: "e1", from: "m", to: "o" }],
  });
  const run = await ws.workflows.runManual(wf.id);
  await waitFor(() => ws.workflows.getRun(run.id)?.status === "completed");
  ws.save();

  const reloaded = new Workspace(ws.dir, providers, () => {});
  assert.equal(reloaded.workflows.list().length, 1);
  assert.equal(reloaded.workflows.list()[0].name, "Persisted flow");
  assert.equal(reloaded.workflows.listRuns(wf.id).length, 1);
  assert.equal(reloaded.workflows.listRuns(wf.id)[0].status, "completed");
});

/* ================================================================
   6. GitHub issues, comments, mentions & local gh device-code auth
   ================================================================ */

test("GitHub trigger polls issues, PR updates, comments, user mentions, and @bot mentions", async (t) => {
  let snapshot = { prs: [], issues: [], comments: [], viewerLogin: "colt" };

  const { ws } = setup(t, {
    workflows: {
      githubPoller: async () => snapshot,
    },
  });

  const wf = ws.workflows.create({
    name: "GitHub triage",
    nodes: [
      {
        id: "tg",
        kind: "trigger",
        triggerKind: "github",
        label: "Botkins GitHub",
        config: {
          repo: "promptclickrun/Botkins",
          events: ["issue_opened", "issue_updated", "pr_updated", "issue_comment", "user_mentioned", "bot_mentioned"],
          mentionHandle: "@botkins-bot, @glory-bot",
          pollMinutes: 1,
        },
      },
      {
        id: "o1",
        kind: "output",
        label: "Feed",
        config: {
          destination: "feed",
          title: "{{event}}:{{item_type}}#{{number}}:{{mention}}",
          template: "{{title}} | {{body}} | {{labels}}",
        },
      },
    ],
    edges: [{ id: "e1", from: "tg", to: "o1" }],
  });

  const baseNow = Date.UTC(2026, 6, 2, 12, 0, 0);
  // 1) Initial seed baseline (existing issue #1 should NOT fire)
  snapshot = {
    viewerLogin: "colt",
    prs: [
      {
        number: 5,
        title: "Existing PR",
        body: "Initial body",
        url: "https://github.com/promptclickrun/Botkins/pull/5",
        author: { login: "alice" },
        state: "OPEN",
        labels: [{ name: "enhancement" }],
        updatedAt: "2026-07-02T10:00:00Z",
      },
    ],
    issues: [
      {
        number: 1,
        title: "Old issue",
        body: "Hello @botkins-bot",
        url: "https://github.com/promptclickrun/Botkins/issues/1",
        author: { login: "alice" },
        state: "OPEN",
        labels: [{ name: "bug" }],
        updatedAt: "2026-07-02T10:00:00Z",
      },
    ],
    comments: [],
  };
  await ws.workflows.tick(baseNow);
  assert.equal(ws.workflows.listRuns(wf.id).length, 0);

  // 2) New issue #2 mentioning @botkins-bot + PR #5 updated -> fires issue_opened, bot_mentioned, pr_updated
  snapshot = {
    ...snapshot,
    prs: [
      {
        ...snapshot.prs[0],
        title: "Existing PR (edited)",
        updatedAt: "2026-07-02T12:01:00Z",
      },
    ],
    issues: [
      ...snapshot.issues,
      {
        number: 2,
        title: "Crash on watch",
        body: "Hey @botkins-bot can you investigate?",
        url: "https://github.com/promptclickrun/Botkins/issues/2",
        author: { login: "bob" },
        state: "OPEN",
        labels: [{ name: "bug" }, { name: "watch" }],
        updatedAt: "2026-07-02T12:01:30Z",
      },
    ],
  };
  await ws.workflows.tick(baseNow + 120_000);
  await waitFor(() => ws.workflows.listRuns(wf.id).length === 3 && ws.workflows.listRuns(wf.id).every((r) => r.status === "completed"));
  const titlesAfterStep2 = ws.state.board.map((b) => b.title);
  assert.ok(titlesAfterStep2.includes("issue_opened:issue#2:"));
  assert.ok(titlesAfterStep2.includes("bot_mentioned:issue#2:@botkins-bot"));
  assert.ok(titlesAfterStep2.includes("pr_updated:pr#5:"));
  const botPost = ws.state.board.find((b) => b.title === "bot_mentioned:issue#2:@botkins-bot");
  assert.ok(botPost.body.includes("bug, watch"));

  // 3) Re-polling unchanged snapshot does NOT duplicate any run
  await ws.workflows.tick(baseNow + 240_000);
  assert.equal(ws.workflows.listRuns(wf.id).length, 3);

  // 4) Comment mentioning @colt (signed-in user) and issue #2 updated -> fires issue_updated, issue_comment, user_mentioned
  snapshot = {
    ...snapshot,
    issues: snapshot.issues.map((iss) =>
      iss.number === 2 ? { ...iss, state: "CLOSED", updatedAt: "2026-07-02T12:05:00Z" } : iss,
    ),
    comments: [
      {
        id: "issue:9001",
        number: 2,
        itemType: "comment",
        title: "Crash on watch",
        body: "cc @colt and @glory-bot (ignoring foo@colt.io and @colt2)",
        author: "carol",
        url: "https://github.com/promptclickrun/Botkins/issues/2#issuecomment-9001",
        updatedAt: "2026-07-02T12:05:10Z",
      },
    ],
  };
  await ws.workflows.tick(baseNow + 360_000);
  await waitFor(() => ws.workflows.listRuns(wf.id).length === 7 && ws.workflows.listRuns(wf.id).every((r) => r.status === "completed"));
  const titlesAfterStep4 = ws.state.board.map((b) => b.title);
  assert.ok(titlesAfterStep4.includes("issue_updated:issue#2:"));
  assert.ok(titlesAfterStep4.includes("issue_comment:comment#2:"));
  assert.ok(titlesAfterStep4.includes("user_mentioned:comment#2:@colt"));
  assert.ok(titlesAfterStep4.includes("bot_mentioned:comment#2:@glory-bot"));
});

test("workflow-github helpers parse mentions, gh auth status, and device-code sign-in lifecycle", async () => {
  assert.deepEqual(parseMentionHandles("@botkins-bot, glory-bot"), ["@botkins-bot", "@glory-bot"]);
  assert.equal(findMentionInText("please help @botkins-bot!", ["@botkins-bot"]), "@botkins-bot");
  assert.equal(findMentionInText("email@botkins-bot.com and @botkins-bot2", ["@botkins-bot"]), null);

  const parsedAuth = parseGhAuthStatus(`github.com
  ✓ Logged in to github.com account coltcoan (keyring)
  - Active account: true
  - Token scopes: 'gist', 'read:org', 'repo'`);
  assert.equal(parsedAuth.authenticated, true);
  assert.equal(parsedAuth.login, "coltcoan");
  assert.deepEqual(parsedAuth.scopes, ["gist", "read:org", "repo"]);
  assert.equal(parseGhAuthStatus("You are not logged into any GitHub hosts.").authenticated, false);

  const device = parseGhDeviceOutput("! First copy your one-time code: ABCD-1234\nPress Enter to open https://github.com/login/device in your browser...");
  assert.equal(device.code, "ABCD-1234");
  assert.equal(device.url, "https://github.com/login/device");

  // Mock gh spawn to verify WorkflowGithubAuth device sign-in and cancellation
  let fakeChild = null;
  let loggedIn = false;
  const auth = new WorkflowGithubAuth({
    findGh: () => "/usr/bin/gh",
    execGh: async (_bin, args) => {
      if (args[0] === "auth" && args[1] === "status") {
        return loggedIn
          ? { ok: true, stdout: "Logged in to github.com account coltcoan\nToken scopes: 'repo'", stderr: "" }
          : { ok: false, stdout: "", stderr: "You are not logged into any GitHub hosts." };
      }
      if (args[0] === "api" && args[1] === "user") {
        return loggedIn ? { ok: true, stdout: "coltcoan\n", stderr: "" } : { ok: false, stdout: "", stderr: "" };
      }
      if (args[0] === "repo") {
        return { ok: true, stdout: JSON.stringify([{ nameWithOwner: "promptclickrun/Botkins" }]), stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    spawnGh: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {} };
      child.kill = () => child.emit("close", 1);
      fakeChild = child;
      setTimeout(() => {
        child.stderr.emit("data", "! First copy your one-time code: WXYZ-9876\nPress Enter to open https://github.com/login/device in your browser...\n");
      }, 15);
      return child;
    },
  });

  const before = await auth.status();
  assert.equal(before.installed, true);
  assert.equal(before.authenticated, false);

  const started = await auth.startSignIn();
  assert.equal(started.status, "waiting");
  assert.equal(started.code, "WXYZ-9876");
  assert.equal(started.url, "https://github.com/login/device");

  loggedIn = true;
  fakeChild.emit("close", 0);
  await waitFor(() => auth.signInSnapshot().status === "done");
  assert.equal(auth.signInSnapshot().login, "coltcoan");

  const after = await auth.status({ includeRepos: true });
  assert.equal(after.authenticated, true);
  assert.equal(after.login, "coltcoan");
  assert.deepEqual(after.repos, ["promptclickrun/Botkins"]);

  // Starting another sign-in and cancelling resets signIn to idle
  await auth.startSignIn();
  const cancelled = await auth.cancelSignIn();
  assert.equal(cancelled.signIn.status, "idle");
  auth.stop();
});


test("a channel trigger's Direct messages only and Mentions only filters apply, including what the window saved before", async (t) => {
  const { ws } = setup(t);
  const started = [];
  const original = ws.workflows.startRun.bind(ws.workflows);
  ws.workflows.startRun = (wf, node, context) => started.push({ name: wf.name, context });
  t.after(() => (ws.workflows.startRun = original));
  const make = (name, config) =>
    ws.workflows.create({
      name,
      nodes: [
        { id: "t1", kind: "trigger", triggerKind: "channel", label: "Channel", config },
        { id: "o1", kind: "output", label: "Feed", config: { destination: "feed", title: "x", template: "y" } },
      ],
      edges: [{ id: "e1", from: "t1", to: "o1", branch: "default" }],
    });
  make("direct", { isDirect: true });
  make("mention", { mentionsBot: true });
  make("legacy-direct", { directOnly: true });
  make("legacy-mention", { mentionOnly: true });
  make("any", {});
  const fire = (event) => {
    started.length = 0;
    ws.workflows.onChannelMessage({ channel: "slack", connection: "c1", conversation: "g", sender: "u", text: "hi", ...event });
    return started.map((s) => s.name).sort();
  };
  assert.deepEqual(fire({ isDirect: false, mentionsBot: false }), ["any"]);
  assert.deepEqual(fire({ isDirect: true, mentionsBot: false }), ["any", "direct", "legacy-direct"]);
  assert.deepEqual(fire({ isDirect: false, mentionsBot: true }), ["any", "legacy-mention", "mention"]);
});
