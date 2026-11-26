// Backend metadata tests for bot-to-bot messages (teamwork, task handoffs, remote dispatch)
// and desktop/link rail-coverage deduplication.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Tasks } from "../desktop/tasks.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";
import { readFileSync } from "node:fs";
import { finishCanvas } from "../desktop/canvas.mjs";
import { recordActivity } from "../desktop/activity.mjs";
import { formatFeedWork, isStepCoveredByRail } from "../desktop/link/activityModel.mjs";
import { baseParts } from "../desktop/link/parts.mjs";

function setup(t, reply, options = {}) {
  const dir = tempDir(t);
  const fake = fakeClient(reply, options.extra);
  const ws = new Workspace(join(dir, "data"), fake.client, () => {});
  return { dir, ws, ...fake };
}

test("teamwork ask stamps structured from metadata on run.teamwork and helper chat messages", async (t) => {
  const { ws } = setup(t, async (id, _options, session) => {
    if (id.includes("-team-")) return { data: { content: "Scout answer: tide is at 14:20" } };
    const out = JSON.parse(await session.tool("ask_teammate", { teammate: "Scout", message: "Check the tide chart" }));
    return { data: { content: "Got it: " + out.reply } };
  });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "When is high tide?");

  const run = ws.state.runs.find((r) => r.chatId === chatId);
  assert.ok(run, "run recorded");
  assert.equal(run.teamwork?.length, 1);
  const ask = run.teamwork[0];
  assert.deepEqual(ask.from, {
    kind: "bot",
    botId: "pip",
    name: "Pip",
    chatId,
    via: "teamwork",
  });
  assert.equal(ask.botId, "scout");
  assert.equal(ask.status, "answered");
  assert.equal(ask.reply, "Scout answer: tide is at 14:20");

  // Helper conversation also stores structured `from` metadata on the incoming message.
  const chat = ws.chat(chatId);
  const helperMsgs = chat.helpers?.scout?.messages ?? [];
  assert.equal(helperMsgs.length, 2);
  assert.equal(helperMsgs[0].role, "user");
  assert.deepEqual(helperMsgs[0].from, {
    kind: "bot",
    botId: "pip",
    name: "Pip",
    chatId,
    via: "teamwork",
  });
  assert.equal(typeof helperMsgs[0].time, "number");
});

test("task_create by a bot for another bot stamps run.taskHandoffs and incoming from metadata on the task chat", async (t) => {
  const { ws } = setup(t, async () => ({ data: { content: "Task finished cleanly" } }));
  const tasks = new Tasks(ws);
  const pip = ws.bot("pip");
  const scout = ws.bot("scout");
  const sourceChatId = ws.createChat(pip.id);
  const sourceRun = { id: "r-source", chatId: sourceChatId, botId: pip.id, status: "Working", time: Date.now() };
  ws.state.runs.unshift(sourceRun);
  const active = {};
  ws.active.set(sourceChatId, active);
  const tools = Object.fromEntries(tasks.tools(pip, ws.chat(sourceChatId), sourceRun, active).map((tool) => [tool.name, tool]));

  const created = JSON.parse(await tools.task_create.handler({
    title: "Audit mobile header spacing",
    details: "Check compact breakpoints and dark mode contrast.",
    bot: scout.name,
    priority: "high",
    status: "later",
  }));
  assert.ok(created.id);

  // Source run records the outgoing task handoff card metadata.
  assert.equal(sourceRun.taskHandoffs?.length, 1);
  const handoff = sourceRun.taskHandoffs[0];
  assert.equal(handoff.taskId, created.id);
  assert.equal(handoff.title, "Audit mobile header spacing");
  assert.equal(handoff.botId, scout.id);
  assert.equal(handoff.fromBotId, pip.id);
  assert.equal(handoff.priority, "high");
  assert.deepEqual(handoff.from, {
    kind: "bot",
    botId: pip.id,
    name: pip.name,
    chatId: sourceChatId,
    via: "task",
  });

  // Starting the task stamps `from` on the task chat's opening user message with originating chatId.
  const task = tasks.get(created.id);
  assert.equal(task.createdChatId, sourceChatId);
  tasks.start(created.id);
  await Promise.all([...ws.locks.values()].map((p) => p.catch(() => {})));

  const taskChat = ws.chat(task.chatId);
  assert.ok(taskChat, "task chat created");
  const firstUser = taskChat.messages.find((m) => m.role === "user");
  assert.ok(firstUser, "task opening user message exists");
  assert.deepEqual(firstUser.from, {
    kind: "bot",
    botId: pip.id,
    name: pip.name,
    chatId: sourceChatId,
    via: "task",
  });
  // Handoff record also gets linked to the task chatId once started.
  assert.equal(handoff.chatId, task.chatId);
});

test("person-created tasks do not stamp bot from metadata", async (t) => {
  const { ws } = setup(t, async () => ({ data: { content: "Person task done" } }));
  const tasks = new Tasks(ws);
  const id = tasks.save({ title: "Person task", body: "Check metrics", botId: "scout", status: "later" });
  const task = tasks.get(id);
  tasks.start(id);
  await Promise.all([...ws.locks.values()].map((p) => p.catch(() => {})));

  const taskChat = ws.chat(task.chatId);
  const firstUser = taskChat.messages.find((m) => m.role === "user");
  assert.ok(firstUser);
  assert.equal(firstUser.from, undefined);
});

test("remote host dispatch stamps remote from metadata on the recipient chat message", async (t) => {
  const { ws } = setup(t, async () => ({ data: { content: "Remote reply" } }));
  const peer = {
    profileId: "owner-id",
    serverId: "vps-host",
    serverKey: "vps-key",
    name: "Alfie VPS",
    targetId: "mac-host",
    targetKey: "mac-key",
    targetName: "Mac Studio",
    verify: async () => {},
  };
  const body = {
    id: randomUUID(),
    sourceBotId: "alfie",
    sourceBotName: "Alfie",
    targetBotId: "scout",
    message: "Please verify the release notes",
    createdAt: Date.now(),
  };

  assert.deepEqual(await ws.hostDispatch.receive(peer, "submit", body), { status: "pending" });
  const [card] = ws.interactions.snapshot();
  ws.interactions.respond(card.id, { action: "approve" });
  let finalRes;
  for (let i = 0; i < 50; i++) {
    finalRes = await ws.hostDispatch.receive(peer, "status", { id: body.id });
    if (!["pending", "working"].includes(finalRes.status)) break;
    await tick();
  }
  assert.equal(finalRes.status, "answered");
  const dispatchChat = ws.state.chats.find((c) => c.hostDispatch);
  assert.ok(dispatchChat, "hostDispatch chat created");
  const incoming = dispatchChat.messages.find((m) => m.role === "user" && m.text === body.message);
  assert.ok(incoming, "incoming remote message recorded");
  assert.deepEqual(incoming.from, {
    kind: "bot",
    botId: "alfie",
    name: "Alfie",
    hostId: "vps-host",
    hostName: "Alfie VPS",
    via: "remote",
  });
});

test("isStepCoveredByRail correlates individual steps to rail cards and preserves uncovered, failed, and legacy rows", () => {
  const runWithTeamwork = {
    teamwork: [{ id: "tw1", toolCallId: "s1", botId: "scout", name: "Scout", message: "hi", status: "answered", started: 1 }],
  };
  const runWithHandoff = {
    taskHandoffs: [{ id: "th1", taskId: "t1", toolCallId: "s5", title: "Task", botId: "scout", botName: "Scout", started: 1 }],
  };

  assert.equal(isStepCoveredByRail({ id: "s1", name: "ask_teammate", status: "Done" }, runWithTeamwork), true);
  assert.equal(isStepCoveredByRail({ id: "s1", name: "ask_teammate", status: "Running" }, runWithTeamwork), true);
  assert.equal(isStepCoveredByRail({ id: "s1", name: "ask_teammate", status: "Failed" }, runWithTeamwork), false, "failed tool calls stay visible in activity");
  assert.equal(isStepCoveredByRail({ id: "s2", name: "ask_teammate", status: "Done" }, runWithTeamwork), false, "unmatched ask_teammate step stays visible");
  assert.equal(isStepCoveredByRail({ id: "s4", name: "ask_teammate", status: "Done" }, {}), false, "without teamwork entries, fallback step stays visible");

  assert.equal(isStepCoveredByRail({ id: "s5", name: "task_create", status: "Done" }, runWithHandoff), true);
  assert.equal(isStepCoveredByRail({ id: "s6", name: "task_create", status: "Done" }, runWithHandoff), false, "separate self/unassigned task_create in same run stays visible");
  assert.equal(isStepCoveredByRail({ id: "s6", name: "task_create", status: "Done" }, {}), false, "person-only or self tasks without handoff stay visible");
  assert.equal(isStepCoveredByRail({ id: "s7", name: "read", status: "Done" }, runWithTeamwork), false);

  // Legacy rail entries (no toolCallId) match only when exact payload correlation proves correspondence, otherwise stay visible.
  const legacyRun = {
    teamwork: [{ id: "tw-legacy", botId: "scout", message: "Check tide", status: "answered", started: 1 }],
    taskHandoffs: [{ id: "t-delegated", taskId: "t-delegated", botId: "scout", title: "Delegated", status: "ready", started: 2 }],
  };
  assert.equal(
    isStepCoveredByRail({ id: "s-tw-match", name: "ask_teammate", status: "Done", input: JSON.stringify({ teammate: "Scout", message: "Check tide" }) }, legacyRun),
    true,
  );
  assert.equal(
    isStepCoveredByRail({ id: "s-tw-other", name: "ask_teammate", status: "Done", input: JSON.stringify({ teammate: "Scout", message: "Different ask" }) }, legacyRun),
    false,
  );
  assert.equal(
    isStepCoveredByRail({ id: "s-tw-no-input", name: "ask_teammate", status: "Done" }, legacyRun),
    false,
    "unprovable legacy teamwork step stays visible",
  );
  assert.equal(
    isStepCoveredByRail({ id: "s-th-match", name: "task_create", status: "Done", output: JSON.stringify({ id: "t-delegated", title: "Delegated" }) }, legacyRun),
    true,
  );
  assert.equal(
    isStepCoveredByRail({ id: "s-th-self", name: "task_create", status: "Done", output: JSON.stringify({ id: "t-self", title: "Self task" }) }, legacyRun),
    false,
  );
  assert.equal(
    isStepCoveredByRail({ id: "s-th-no-output", name: "task_create", status: "Done" }, legacyRun),
    false,
    "unprovable legacy task_create step stays visible",
  );
});

test("mixed run: delegated task_create is correlated to its rail card while self/unassigned task_create stays visible and Link summary agrees", async (t) => {
  const { ws } = setup(t, async () => ({ data: { content: "ok" } }));
  const tasks = new Tasks(ws);
  const pip = ws.bot("pip");
  const scout = ws.bot("scout");
  const chatId = ws.createChat(pip.id);
  const run = { id: "r-mixed", chatId, botId: pip.id, title: "Mixed task run", status: "Working", time: Date.now() };
  ws.state.runs.unshift(run);
  const active = {};
  ws.active.set(chatId, active);
  const tools = Object.fromEntries(tasks.tools(pip, ws.chat(chatId), run, active).map((tool) => [tool.name, tool]));

  // 1) Delegated task_create invoked with direct Copilot-style invocation.toolCallId
  const delegatedArgs = { title: "Delegate to Scout", bot: scout.name, status: "later" };
  recordActivity(run, { type: "tool.execution_start", data: { toolCallId: "call-delegated", toolName: "task_create", arguments: delegatedArgs } }, () => {});
  const delegatedOut = await tools.task_create.handler(delegatedArgs, { toolCallId: "call-delegated" });
  recordActivity(run, { type: "tool.execution_complete", data: { toolCallId: "call-delegated", success: true, result: { content: delegatedOut } } }, () => {});

  // 2) Self-assigned task_create in the same run (no rail card)
  const selfArgs = { title: "Reminder for myself", bot: pip.name, status: "later" };
  recordActivity(run, { type: "tool.execution_start", data: { toolCallId: "call-self", toolName: "task_create", arguments: selfArgs } }, () => {});
  const selfOut = await tools.task_create.handler(selfArgs, { toolCallId: "call-self" });
  recordActivity(run, { type: "tool.execution_complete", data: { toolCallId: "call-self", success: true, result: { content: selfOut } } }, () => {});

  // 3) Unassigned task_create via MCP-bridge style (no invocation.toolCallId)
  const unassignedArgs = { title: "Unassigned backlog item", status: "later" };
  recordActivity(run, { type: "tool.execution_start", data: { toolCallId: "call-unassigned", toolName: "task_create", arguments: unassignedArgs } }, () => {});
  const unassignedOut = await tools.task_create.handler(unassignedArgs);
  recordActivity(run, { type: "tool.execution_complete", data: { toolCallId: "call-unassigned", success: true, result: { content: unassignedOut } } }, () => {});

  // 4) Second delegated task_create via MCP-bridge style (no invocation.toolCallId, correlates via active running step)
  const bridgeDelegatedArgs = { title: "Second handoff over MCP", bot: scout.name, status: "later" };
  recordActivity(run, { type: "tool.execution_start", data: { toolCallId: "call-bridge-delegated", toolName: "task_create", arguments: bridgeDelegatedArgs } }, () => {});
  const bridgeDelegatedOut = await tools.task_create.handler(bridgeDelegatedArgs);
  recordActivity(run, { type: "tool.execution_complete", data: { toolCallId: "call-bridge-delegated", success: true, result: { content: bridgeDelegatedOut } } }, () => {});

  assert.equal(run.taskHandoffs?.length, 2);
  assert.equal(run.taskHandoffs[0].toolCallId, "call-delegated");
  assert.equal(run.taskHandoffs[1].toolCallId, "call-bridge-delegated");

  const visibleIds = run.steps.filter((s) => !isStepCoveredByRail(s, run)).map((s) => s.id);
  assert.deepEqual(visibleIds, ["call-self", "call-unassigned"]);

  finishCanvas(run);
  run.status = "Completed";
  assert.equal(run.summary, "Used 2 tools");

  // Link summary (baseParts -> runSummary -> formatFeedWork) stays in agreement with visible steps.
  const feed = formatFeedWork(run);
  assert.equal(feed.stepCount, 2);
  assert.equal(feed.summary, "Used 2 tools");
  assert.deepEqual(feed.kinds, ["tool"]);

  const parts = baseParts({ runs: [run] }, {});
  assert.equal(parts.runs[0].stepCount, 2);
  assert.equal(parts.runs[0].summary, "Used 2 tools");
  assert.deepEqual(parts.runs[0].stepKinds, ["tool"]);

  // Run with ONLY a rail-covered step leaves no ghost tool count in Link summary.
  const onlyRailRun = {
    id: "r-only-rail",
    chatId,
    title: "Delegated only",
    time: Date.now(),
    status: "Completed",
    steps: [{ id: "call-only", name: "task_create", status: "Done", started: 1 }],
    usedTools: ["task_create"],
    taskHandoffs: [{ id: "t-only", taskId: "t-only", toolCallId: "call-only", botId: scout.id, fromBotId: pip.id, title: "Only handoff", status: "ready", started: 1 }],
  };
  finishCanvas(onlyRailRun);
  assert.equal(onlyRailRun.summary, undefined);
  const onlyParts = baseParts({ runs: [onlyRailRun] }, {});
  assert.equal(onlyParts.runs[0].stepCount, undefined);
  assert.equal(onlyParts.runs[0].summary, undefined);
  assert.equal(onlyParts.runs[0].stepKinds, undefined);
});

test("desktop/desktop/link/activityModel.mjs stays byte-identical to mobile/link-host/activityModel.mjs", () => {
  const desktop = readFileSync(new URL("../desktop/link/activityModel.mjs", import.meta.url), "utf8");
  const phone = readFileSync(new URL("../../mobile/link-host/activityModel.mjs", import.meta.url), "utf8");
  assert.equal(desktop, phone);
});
