import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Workspace } from "../desktop/workspace.mjs";
import { LinkHost, authorize } from "../desktop/link/index.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { headlessHost } from "../desktop/host/headless.mjs";
import {
  computeWorkspaceStats,
  defaultWorkspacePrune,
  parsePruneOptions,
  trimRun,
  workspacePruneField,
} from "../desktop/workspace-prune.mjs";
import { formatFeedWork, groupForOpenMode, partitionForFoldMode, stepHeadline, summarizeSteps } from "../desktop/link/activityModel.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-27T12:00:00Z");

function makeWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-prune-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({
    start: async () => {},
    stop: async () => {},
    listModels: async () => [],
    getAuthStatus: async () => ({ isAuthenticated: false }),
    createSession: async () => { throw new Error("unused"); },
    resumeSession: async () => { throw new Error("unused"); },
  }), () => {});
  return { dir, ws };
}

function makeHeavyRun(id, chatId, ageDays, overrides = {}) {
  const time = NOW - ageDays * DAY_MS;
  return {
    id,
    chatId,
    title: "Run " + id,
    time,
    finished: time + 4000,
    status: "Completed",
    detail: "",
    summary: "Ran 2 commands",
    usage: { input: 1200, output: 300, cost: 0.01 },
    todos: [{ id: "t1", title: "Verify", status: "done" }],
    steps: [
      {
        id: id + "-s1",
        name: "bash",
        label: "npm test",
        input: JSON.stringify({ command: "npm test", padding: "x".repeat(4000) }),
        output: "PASS " + "y".repeat(6000),
        progress: "running tests...",
        status: "Done",
        started: time + 100,
        finished: time + 2000,
      },
      {
        id: id + "-s2",
        name: "read",
        label: "README.md",
        input: JSON.stringify({ path: "README.md" }),
        output: "z".repeat(4000),
        status: "Done",
        started: time + 2100,
        finished: time + 3500,
      },
    ],
    reasoning: [{ id: id + "-r1", text: "Thinking ".repeat(200), started: time + 50, finished: time + 90 }],
    ...overrides,
  };
}

test("workspacePruneField and parsePruneOptions validate inputs and defaults", () => {
  assert.deepEqual(workspacePruneField(undefined), defaultWorkspacePrune);
  assert.deepEqual(workspacePruneField({ auto: true, keepDays: 14, mode: "delete" }), { auto: true, keepDays: 14, mode: "delete" });
  assert.throws(() => workspacePruneField({ keepDays: 0 }), /Keep days/);
  assert.throws(() => workspacePruneField({ keepDays: 9999 }), /Keep days/);
  assert.throws(() => workspacePruneField({ mode: "purge" }), /trim or delete/);
  assert.throws(() => workspacePruneField({ auto: "yes" }), /on or off/);
  assert.throws(() => workspacePruneField({ bogus: 1 }), /Unknown workspace prune setting/);

  assert.deepEqual(parsePruneOptions({}), { keepDays: 30, keepRuns: 200, mode: "trim", dryRun: false });
  assert.throws(() => parsePruneOptions({ keepRuns: -1 }), /keepRuns/);
  assert.throws(() => parsePruneOptions({ dryRun: "yes" }), /dryRun/);
});

test("cutoff logic: prunes only runs older than keepDays AND not among newest keepRuns", async (t) => {
  const { ws } = makeWorkspace(t);
  ws.state.chats = [{ id: "chat-1", botId: "b1", title: "Main", time: NOW, messages: [] }];
  // 5 runs: ages 1d, 10d, 40d, 50d, 60d. Newest run per chat (1d) is also protected.
  // With keepDays=30 and keepRuns=3:
  //   newest 3 are 1d, 10d, 40d -> kept!
  //   only 50d and 60d are older than 30d AND outside newest 3.
  ws.state.runs = [
    makeHeavyRun("r-1d", "chat-1", 1),
    makeHeavyRun("r-10d", "chat-1", 10),
    makeHeavyRun("r-40d", "chat-1", 40),
    makeHeavyRun("r-50d", "chat-1", 50),
    makeHeavyRun("r-60d", "chat-1", 60),
  ];
  ws.save(false);

  const dry = await ws.pruneWorkspace({ keepDays: 30, keepRuns: 3, mode: "trim", dryRun: true }, { now: NOW });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.trimmedCount, 2);
  assert.equal(dry.deletedCount, 0);
  assert.equal(dry.affectedCount, 2);
  assert.ok(dry.savedBytes > 10_000);
  assert.ok(dry.afterBytes < dry.beforeBytes);
  assert.ok(dry.archivePath && dry.archivePath.endsWith(".json.gz"));
  // Dry run must NOT write archive or mutate state.
  assert.equal(existsSync(dry.archivePath), false, "dryRun must not write archive");
  assert.ok(ws.state.runs.find((r) => r.id === "r-60d").steps[0].output, "dryRun must not mutate runs");

  // Real trim run.
  const res = await ws.pruneWorkspace({ keepDays: 30, keepRuns: 3, mode: "trim", dryRun: false }, { now: NOW });
  assert.equal(res.dryRun, false);
  assert.equal(res.trimmedCount, 2);
  assert.equal(res.deletedCount, 0);
  assert.ok(res.archivePath && existsSync(res.archivePath), "archive written");
  assert.ok(res.afterBytes < res.beforeBytes);

  // Verify 40d was kept untouched because it is in newest 3 (keepRuns=3), while 50d and 60d were trimmed.
  const r40 = ws.state.runs.find((r) => r.id === "r-40d");
  const r50 = ws.state.runs.find((r) => r.id === "r-50d");
  const r60 = ws.state.runs.find((r) => r.id === "r-60d");
  assert.ok(r40.steps[0].output, "run within keepRuns keeps payload");
  assert.equal(r50.steps[0].output, undefined, "trimmed step drops output");
  assert.equal(r50.steps[0].input, undefined, "trimmed step drops input");
  assert.equal(r50.steps[0].progress, undefined, "trimmed step drops progress");
  assert.equal(r50.reasoning, undefined, "trimmed run drops reasoning");
  // Essential metadata preserved.
  assert.equal(r50.steps[0].name, "bash");
  assert.equal(r50.steps[0].label, "npm test");
  assert.equal(r50.steps[0].status, "Done");
  assert.equal(r50.summary, "Ran 2 commands");
  assert.deepEqual(r50.usage, { input: 1200, output: 300, cost: 0.01 });
  assert.deepEqual(r50.todos, [{ id: "t1", title: "Verify", status: "done" }]);
  assert.equal(r60.steps[0].output, undefined);

  // Verify gzip archive contains the removed payloads.
  const archive = JSON.parse(gunzipSync(readFileSync(res.archivePath)).toString("utf8"));
  assert.equal(archive.version, 1);
  assert.equal(archive.mode, "trim");
  assert.equal(archive.count, 2);
  assert.deepEqual(archive.runs.map((r) => r.id).sort(), ["r-50d", "r-60d"]);
  assert.ok(archive.runs[0].steps[0].output.startsWith("PASS "));

  // Running trim again on already-trimmed runs is a no-op (no empty archive written).
  const again = await ws.pruneWorkspace({ keepDays: 30, keepRuns: 3, mode: "trim", dryRun: false }, { now: NOW });
  assert.equal(again.affectedCount, 0);
  assert.equal(again.archivePath, null);
});

test("delete mode removes old runs entirely after writing archive", async (t) => {
  const { ws } = makeWorkspace(t);
  ws.state.chats = [{ id: "chat-1", botId: "b1", title: "Main", time: NOW, messages: [] }];
  ws.state.runs = [
    makeHeavyRun("r-new", "chat-1", 2),
    makeHeavyRun("r-old-1", "chat-1", 45),
    makeHeavyRun("r-old-2", "chat-1", 90),
  ];
  ws.save(false);

  const res = await ws.pruneWorkspace({ keepDays: 30, keepRuns: 0, mode: "delete", dryRun: false }, { now: NOW });
  assert.equal(res.deletedCount, 2);
  assert.equal(res.trimmedCount, 0);
  assert.deepEqual(ws.state.runs.map((r) => r.id), ["r-new"]);
  assert.ok(res.archivePath && existsSync(res.archivePath));
  const archive = JSON.parse(gunzipSync(readFileSync(res.archivePath)).toString("utf8"));
  assert.equal(archive.mode, "delete");
  assert.equal(archive.runs.length, 2);
  assert.equal(archive.runs[0].steps[0].output.startsWith("PASS "), true);
});

test("protected runs are never pruned (working, queued, active chat, newest per chat, approvals, tasks, workflows, panel checks)", async (t) => {
  const { ws } = makeWorkspace(t);
  ws.state.chats = [
    { id: "chat-working", botId: "b1", title: "W", time: NOW, messages: [] },
    { id: "chat-queued", botId: "b1", title: "Q", time: NOW, messages: [] },
    { id: "chat-solo", botId: "b1", title: "Solo", time: NOW, messages: [] },
    { id: "chat-refs", botId: "b1", title: "Refs", time: NOW, messages: [] },
  ];
  ws.state.runs = [
    // Working status
    makeHeavyRun("r-working", "chat-working", 100, { status: "Working", finished: undefined }),
    // Active chat (even older completed run in active chat is skipped)
    makeHeavyRun("r-in-active-chat", "chat-working", 120),
    // Queued status
    makeHeavyRun("r-queued", "chat-queued", 100, { status: "Queued", finished: undefined }),
    // Only (and thus newest) run of chat-solo
    makeHeavyRun("r-solo-newest", "chat-solo", 200),
    // Newest run of chat-refs
    makeHeavyRun("r-refs-newest", "chat-refs", 100),
    // Referenced by pending interaction
    makeHeavyRun("r-pending-approval", "chat-refs", 110),
    // Referenced by task
    makeHeavyRun("r-task-ref", "chat-refs", 115),
    // Referenced by workflow run
    makeHeavyRun("r-wf-ref", "chat-refs", 120),
    // Referenced by panel lastCheck
    makeHeavyRun("r-panel-ref", "chat-refs", 125),
    // Eligible unprotected old run
    makeHeavyRun("r-unprotected", "chat-refs", 130),
  ];

  // Mark chat-working as active and chat-queued as having queued messages.
  ws.active.set("chat-working", { run: ws.state.runs[0] });
  ws.queues.set("chat-queued", [{ id: "q1", text: "next" }]);
  // Pending approval referencing r-pending-approval.
  ws.interactions.entries.set("req-1", {
    chat: ws.state.chats[3],
    task: { run: { id: "r-pending-approval" } },
    view: { id: "req-1", kind: "permission", chatId: "chat-refs", runId: "r-pending-approval", title: "Allow?" },
  });
  // Task referencing r-task-ref.
  ws.state.tasks = [{ id: "task-1", title: "Job", status: "done", runId: "r-task-ref" }];
  // Workflow run referencing r-wf-ref.
  ws.state.workflowRuns = [{
    id: "wfr-1",
    workflowId: "wf-1",
    status: "completed",
    steps: { n1: { nodeId: "n1", status: "completed", runId: "r-wf-ref" } },
  }];
  // Panel referencing r-panel-ref.
  ws.state.panels = [{ id: "p1", lastCheck: { runId: "r-panel-ref", time: NOW - 125 * DAY_MS, status: "Completed" } }];

  // Need to clear chat-refs from activeChatIds (only req-1 had chatId: "chat-refs", let's put req-1 on its own chat so r-unprotected is testable!)
  ws.state.chats.push({ id: "chat-approval", botId: "b1", title: "App", time: NOW, messages: [] });
  ws.interactions.entries.get("req-1").chat = ws.state.chats[4];
  ws.interactions.entries.get("req-1").view.chatId = "chat-approval";

  ws.save(false);

  const res = await ws.pruneWorkspace({ keepDays: 7, keepRuns: 0, mode: "delete", dryRun: false }, { now: NOW });
  assert.equal(res.deletedCount, 1);
  assert.equal(ws.state.runs.some((r) => r.id === "r-unprotected"), false, "unprotected old run deleted");
  for (const id of [
    "r-working",
    "r-in-active-chat",
    "r-queued",
    "r-solo-newest",
    "r-refs-newest",
    "r-pending-approval",
    "r-task-ref",
    "r-wf-ref",
    "r-panel-ref",
  ]) {
    assert.ok(ws.state.runs.some((r) => r.id === id), `protected run ${id} must survive`);
  }
});

test("archive is written before ws.save() mutation", async (t) => {
  const { ws } = makeWorkspace(t);
  ws.state.chats = [{ id: "chat-1", botId: "b1", title: "Main", time: NOW, messages: [] }];
  ws.state.runs = [
    makeHeavyRun("r-1", "chat-1", 1),
    makeHeavyRun("r-2", "chat-1", 60),
  ];
  ws.save(false);

  let archiveExistedDuringSave = false;
  const origSave = ws.save.bind(ws);
  let saveCalls = 0;
  ws.save = (...args) => {
    saveCalls++;
    const archiveDir = join(ws.dir, "archive");
    archiveExistedDuringSave = existsSync(archiveDir);
    return origSave(...args);
  };

  const res = await ws.pruneWorkspace({ keepDays: 30, keepRuns: 0, mode: "trim", dryRun: false }, { now: NOW });
  assert.equal(saveCalls, 1, "prune mutates in a single save");
  assert.equal(archiveExistedDuringSave, true, "archive exists on disk before save runs");
  assert.ok(res.archivePath && existsSync(res.archivePath));
});

test("auto-prune preference is off by default and runAutoPrune respects it", async (t) => {
  const { ws } = makeWorkspace(t);
  assert.deepEqual(ws.state.settings.workspacePrune, { auto: false, keepDays: 30, mode: "trim" });
  ws.state.chats = [{ id: "chat-1", botId: "b1", title: "Main", time: NOW, messages: [] }];
  ws.state.runs = [makeHeavyRun("r-new", "chat-1", 1), makeHeavyRun("r-old", "chat-1", 60)];
  ws.save(false);

  // Off by default -> does nothing.
  assert.equal(await ws.runAutoPrune({ now: NOW }), null);
  assert.ok(ws.state.runs[1].steps[0].output);

  // Enable via setPreferences.
  ws.setPreferences({ workspacePrune: { auto: true, keepDays: 30, mode: "trim" } });
  assert.deepEqual(ws.state.settings.workspacePrune, { auto: true, keepDays: 30, mode: "trim" });

  // Auto-prune runs (with keepRuns=200 default, add >200 runs or verify keepRuns behavior; test explicit trim with 202 runs).
  const many = [makeHeavyRun("r-new", "chat-1", 1)];
  for (let i = 0; i < 205; i++) many.push(makeHeavyRun(`r-old-${i}`, "chat-1", 40 + i));
  ws.state.runs = many;
  ws.save(false);

  const autoRes = await ws.runAutoPrune({ now: NOW });
  assert.ok(autoRes);
  assert.equal(autoRes.trimmedCount, 6);
  const stats = computeWorkspaceStats(ws);
  assert.equal(stats.runCount, 206);
  assert.equal(stats.trimmedRuns, 6);
});

test("chat timeline rendering for trimmed runs shows step names with no outputs and never crashes", () => {
  const heavy = makeHeavyRun("r-trim-ui", "chat-1", 60);
  const { trimmed } = trimRun(heavy);
  assert.equal(trimmed.steps.length, 2);
  assert.equal(trimmed.steps[0].output, undefined);
  assert.equal(trimmed.steps[0].input, undefined);

  // Activity model helpers used by both desktop and mobile chat timelines.
  const headline0 = stepHeadline(trimmed.steps[0]);
  const headline1 = stepHeadline(trimmed.steps[1]);
  assert.ok(headline0.includes("npm test") || headline0.includes("bash"));
  assert.ok(headline1.includes("README.md") || headline1.includes("read"));

  const groups = groupForOpenMode(trimmed.steps);
  assert.ok(Array.isArray(groups) && groups.length >= 1);
  const folded = partitionForFoldMode(trimmed.steps);
  assert.ok(Array.isArray(folded) && folded.length >= 1);
  const stepsSummary = summarizeSteps(trimmed.steps);
  assert.ok(typeof stepsSummary === "string" && stepsSummary.length > 0);
  const feed = formatFeedWork(trimmed);
  assert.equal(feed.stepCount, 2);
  assert.ok(typeof feed.summary === "string" && feed.summary.length > 0);
  assert.ok(Array.isArray(feed.kinds) && feed.kinds.length >= 1);
});

test("Link RPC workspaceStats and workspacePrune are strictly owner-only", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-prune-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = await createRuntime({
    host: headlessHost(dir),
    dataDir: join(dir, "data"),
    trial: true,
    link: { port: 0, announce: false },
  });
  t.after(() => runtime.stop());
  await runtime.listening;

  const { link, workspace } = runtime;
  assert.ok(link instanceof LinkHost);
  // Seed a chat + old run.
  workspace.state.chats = [{ id: "chat-1", botId: "b1", title: "Main", time: NOW, messages: [] }];
  workspace.state.runs = [makeHeavyRun("r-1", "chat-1", 1), makeHeavyRun("r-2", "chat-1", 60)];
  workspace.save(false);

  // Verify authorize() directly: owner passes, admin-role member is denied.
  const team = {
    roles: [{ id: "admin", name: "Admin", permissions: { agents: ["view", "chat", "manage"], settings: ["view", "manage"] } }],
    groups: [{ id: "g1", name: "Team", roleId: "admin", bots: "all" }],
    members: [{ id: "m1", name: "Sam", groupId: "g1" }],
  };
  const owner = { kind: "owner" };
  const member = { kind: "member", memberId: "m1", id: "m1", groupId: "g1", roleId: "admin" };
  assert.equal(authorize(owner, team, "workspaceStats", []), "");
  assert.equal(authorize(owner, team, "workspacePrune", [{ dryRun: true }]), "");
  assert.match(authorize(member, team, "workspaceStats", []), /owner/i);
  assert.match(authorize(member, team, "workspacePrune", [{ dryRun: true }]), /owner/i);
  assert.match(authorize(member, team, "setPreferences", [{ workspacePrune: { auto: true } }]), /display preferences only|owner|role can't do that/i);

  // Verify LinkHost.dispatch end-to-end: owner succeeds, member device is rejected.
  const ownerSession = { deviceId: "dev-owner" };
  const memberSession = { deviceId: "dev-member" };
  link.store.data.devices = [
    { id: "dev-owner", kind: "phone", name: "Owner Phone" },
    { id: "dev-member", kind: "phone", name: "Member Phone", memberId: "m1" },
  ];
  link.store.data.team = { name: "Acme", ...team, invites: [], requests: [], chats: {} };
  const stats = await link.dispatch(ownerSession, { m: "workspaceStats", a: [] });
  assert.equal(stats.runCount, 2);
  const dry = await link.dispatch(ownerSession, { m: "workspacePrune", a: [{ keepDays: 30, keepRuns: 0, mode: "trim", dryRun: true }] });
  assert.equal(dry.trimmedCount, 1);

  await assert.rejects(() => link.dispatch(memberSession, { m: "workspaceStats", a: [] }), /owner/i);
  await assert.rejects(() => link.dispatch(memberSession, { m: "workspacePrune", a: [{ dryRun: true }] }), /owner/i);
  await assert.rejects(() => link.dispatch(memberSession, { m: "setPreferences", a: [{ workspacePrune: { auto: true } }] }), /display preferences only|owner|role can't do that/i);
});
