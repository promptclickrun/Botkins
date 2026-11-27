// Pi & OMP plan sync: `update_plan` with optional explicit dependencies, OMP native `todo` /
// `/todo` / `todoPhases` synchronization, warm-session and recovery persistence, and Workspace
// parity with Copilot (desktop/providers/pi/plan.mjs, desktop/providers/pi/index.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OMP_ID, PI_ID, PiProvider } from "../desktop/providers/pi/index.mjs";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { PLAN_INSTRUCTIONS, PLAN_LIMIT, checkedPlan, planFromOmpPhases, planToOmpPhases, toTodoResult } from "../desktop/providers/pi/plan.mjs";
import { mapTodos } from "../desktop/canvas.mjs";
import { Workspace } from "./starter.mjs";
import { Providers } from "../desktop/providers/index.mjs";
import { ModelProvider, ProviderSession } from "../desktop/providers/provider.mjs";

const skipPosix = process.platform === "win32" && "Stand-in harness scripts are POSIX sh wrappers.";
const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "botkins-pi-plan-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const piBin = join(dir, "pi");
const ompBin = join(dir, "omp");
writeFileSync(piBin, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(FAKE_PI) + ' "$@"\n');
writeFileSync(ompBin, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(FAKE_OMP) + ' "$@"\n');
chmodSync(piBin, 0o755);
chmodSync(ompBin, 0o755);

const CONNECTION = {
  name: "botkins-claude",
  config: {
    name: "Claude",
    baseUrl: "http://127.0.0.1:1/claude",
    api: "anthropic-messages",
    apiKey: "s",
    models: [{ id: "opus", name: "Opus", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  },
};

const spec = (more = {}) => ({
  sessionId: "chat-1", established: false, hasReplies: false, folder: dir,
  model: { model: "opus", source: "botkins-claude" }, inference: { providers: [CONNECTION] },
  instructions: "You are Testy.", context: "", tools: [], skills: { directories: [], disabled: [] }, mcpServers: {},
  history: () => [], handlers: { permission: async () => ({ allow: true }) }, ...more,
});
let caseId = 0;
const piSession = async (more, options = {}) => new PiProvider({ dataDir: join(dir, "case-" + ++caseId), binary: join(dir, "none"), ...options }).openSession(spec(more));
const tool = (session) => session.planTools().find((each) => each.name === "update_plan");

test("update_plan keeps the plan and explicit dependencies on the session, tells the apps the task list changed, and todos() reads it", async () => {
  const session = await piSession();
  const events = [];
  session.on((event) => events.push(event.type));
  assert.equal(await session.todos(), null, "no plan until the model makes one");
  const update = tool(session);
  assert.equal(update.skipPermission, true, "Botkins' own tool never asks");
  const said = await update.handler({
    explanation: "Starting",
    steps: [
      { id: "a", text: "Read the code", status: "completed" },
      { id: "b", text: "Write the fix", status: "in_progress", dependsOn: ["a"] },
      { id: "c", text: "Run the tests", status: "pending", dependsOn: ["b", "b"] },
    ],
  });
  assert.equal(said, "Plan saved: 3 steps, 2 open.");
  assert.deepEqual(events, ["session.todos_changed"]);
  assert.deepEqual(await session.todos(), {
    rows: [
      { id: "a", title: "Read the code", status: "completed" },
      { id: "b", title: "Write the fix", status: "in_progress" },
      { id: "c", title: "Run the tests", status: "pending" },
    ],
    dependencies: [
      { todoId: "b", dependsOn: "a" },
      { todoId: "c", dependsOn: "b" },
    ],
  });
  // The workspace turns it into the chat's task list the way it does for Copilot.
  assert.deepEqual(mapTodos(await session.todos()), [
    { id: "a", title: "Read the code", status: "done" },
    { id: "b", title: "Write the fix", status: "in_progress", dependsOn: ["a"] },
    { id: "c", title: "Run the tests", status: "pending", dependsOn: ["b"] },
  ]);
  // Omitting dependsOn never invents dependencies.
  await update.handler({ steps: [{ id: "a", text: "Read the code", status: "completed" }, { id: "b", text: "Write the fix", status: "pending" }] });
  assert.deepEqual((await session.todos()).dependencies, []);
  assert.deepEqual(mapTodos(await session.todos()), [
    { id: "a", title: "Read the code", status: "done" },
    { id: "b", title: "Write the fix", status: "pending" },
  ]);
  assert.equal(await update.handler({ steps: [] }), "Plan cleared.");
  assert.deepEqual(mapTodos(await session.todos()), []);
});

test("a plan is checked: up to 100 steps, distinct ids, valid statuses, and valid acyclic dependsOn", async () => {
  const step = (more = {}) => ({ id: "a", text: "Do it", status: "pending", ...more });
  assert.throws(() => checkedPlan({}), /list of/);
  assert.throws(() => checkedPlan({ steps: [step({ id: "" })] }), /needs an id/);
  assert.throws(() => checkedPlan({ steps: [step(), step()] }), /used twice/);
  assert.throws(() => checkedPlan({ steps: [step({ text: "  " })] }), /needs text/);
  assert.throws(() => checkedPlan({ steps: [step({ status: "done" })] }), /pending, in_progress or completed/);
  assert.throws(() => checkedPlan({ steps: [step({ dependsOn: "a" })] }), /dependsOn must be a list/);
  assert.throws(() => checkedPlan({ steps: [step({ dependsOn: ["  "] })] }), /empty dependency id/);
  assert.throws(() => checkedPlan({ steps: [step({ dependsOn: ["a"] })] }), /cannot depend on itself/);
  assert.throws(() => checkedPlan({ steps: [step({ dependsOn: ["missing"] })] }), /unknown step missing/);
  assert.throws(() => checkedPlan({ steps: [step({ id: "a", dependsOn: ["b"] }), step({ id: "b", dependsOn: ["a"] })] }), /cycle/);
  assert.throws(() => checkedPlan({ steps: [step({ id: "a", dependsOn: ["b"] }), step({ id: "b", dependsOn: ["c"] }), step({ id: "c", dependsOn: ["a"] })] }), /cycle/);
  const many = Array.from({ length: PLAN_LIMIT }, (_, i) => step({ id: "s" + i }));
  assert.equal(checkedPlan({ steps: many }).length, PLAN_LIMIT);
  assert.throws(() => checkedPlan({ steps: [...many, step({ id: "extra" })] }), /up to 100/);
  assert.equal(checkedPlan({ steps: [step({ id: 7, text: "a\n  b" })] })[0].title, "a b");
  assert.equal(checkedPlan({ steps: [step({ text: "x".repeat(900) })] })[0].title.length, 300);
  // The tool refuses a bad plan with the same words, and keeps the plan it had.
  const session = await piSession();
  await assert.rejects(() => tool(session).handler({ steps: [step({ status: "weird" })] }), /Step a has status/);
  assert.equal(await session.todos(), null);
  await tool(session).handler({ steps: [step({ id: "a" })] });
  await assert.rejects(() => tool(session).handler({ steps: [step({ id: "a", dependsOn: ["nope"] })] }), /unknown step nope/);
  assert.deepEqual(mapTodos(await session.todos()), [{ id: "a", title: "Do it", status: "pending" }]);
});

test("both Pi and OMP get update_plan (including when warmed), not throwaway or sources-only sessions", async () => {
  assert.equal((await piSession()).planTools().length, 1);
  assert.equal((await piSession({}, { runtime: OMP_ID })).planTools().length, 1);
  assert.equal((await piSession({ temporary: true })).planTools().length, 0);
  assert.equal((await piSession({ temporary: true }, { runtime: OMP_ID })).planTools().length, 0);
  assert.equal((await piSession({ sourcesOnly: true })).planTools().length, 0);
  assert.equal((await piSession({ sourcesOnly: true }, { runtime: OMP_ID })).planTools().length, 0);
  // A chat warmed before its first message (no turn yet) declares it too: Pi/OMP list tools when connecting.
  assert.equal((await piSession({ handlers: null })).planTools().length, 1);
  assert.equal((await piSession({ handlers: null }, { runtime: OMP_ID })).planTools().length, 1);
});

test("Pi and OMP are both told to keep a plan for multi-step work once the tool can be reached", async () => {
  const session = await piSession();
  assert.equal((await session.describe()).prompt, "You are Testy.", "no bridge, no tool, no instruction");
  session.bridge = { url: "http://127.0.0.1:1/mcp/x", headers: {} };
  const { prompt } = await session.describe();
  assert.ok(prompt.startsWith("You are Testy.\n\n" + PLAN_INSTRUCTIONS));
  assert.match(PLAN_INSTRUCTIONS, /update_plan/);
  assert.match(PLAN_INSTRUCTIONS, /dependsOn/);
  const omp = await piSession({}, { runtime: OMP_ID });
  assert.equal((await omp.describe()).prompt, "You are Testy.", "OMP without bridge gets no instruction");
  omp.bridge = session.bridge;
  assert.ok((await omp.describe()).prompt.startsWith("You are Testy.\n\n" + PLAN_INSTRUCTIONS));
});

test("OMP native todoPhases conversion reconciles IDs and explicit deps and never invents dependencies", () => {
  const nativePhases = [
    { name: "Discovery", tasks: [{ content: "Audit files", status: "completed" }] },
    { name: "Build", tasks: [{ content: "Patch adapter", status: "in_progress" }, { content: "Drop old path", status: "abandoned" }] },
  ];
  const fromScratch = planFromOmpPhases(nativePhases, null);
  assert.deepEqual(fromScratch, {
    rows: [
      { id: "omp-1", title: "Audit files", status: "completed" },
      { id: "omp-2", title: "Patch adapter", status: "in_progress" },
      { id: "omp-3", title: "Drop old path", status: "abandoned" },
    ],
    dependencies: [],
  });
  assert.deepEqual(mapTodos(fromScratch), [
    { id: "omp-1", title: "Audit files", status: "done" },
    { id: "omp-2", title: "Patch adapter", status: "in_progress" },
    { id: "omp-3", title: "Drop old path", status: "cancelled" },
  ]);

  // Existing explicit plan created via update_plan preserves IDs and explicit edges when OMP updates statuses.
  const existing = toTodoResult(checkedPlan({
    steps: [
      { id: "read", text: "Read code", status: "completed" },
      { id: "fix", text: "Write fix", status: "in_progress", dependsOn: ["read"] },
      { id: "test", text: "Run tests", status: "pending", dependsOn: ["fix"] },
    ],
  }));
  const mirrored = planToOmpPhases(existing);
  assert.deepEqual(mirrored, [{
    name: "Plan",
    tasks: [
      { content: "Read code", status: "completed" },
      { content: "Write fix", status: "in_progress" },
      { content: "Run tests", status: "pending" },
    ],
  }]);
  const updatedPhases = [{
    name: "Plan",
    tasks: [
      { content: "Read code", status: "completed" },
      { content: "Write fix", status: "completed" },
      { content: "Run tests", status: "in_progress" },
      { content: "Added via native todo", status: "pending" },
    ],
  }];
  const reconciled = planFromOmpPhases(updatedPhases, existing);
  assert.deepEqual(reconciled, {
    rows: [
      { id: "read", title: "Read code", status: "completed" },
      { id: "fix", title: "Write fix", status: "completed" },
      { id: "test", title: "Run tests", status: "in_progress" },
      { id: "omp-1", title: "Added via native todo", status: "pending" },
    ],
    dependencies: [
      { todoId: "fix", dependsOn: "read" },
      { todoId: "test", dependsOn: "fix" },
    ],
  });
});

test("warm sessions and supported recovery preserve dependent plans on Pi and OMP, while stale recovery and delete clear them", { skip: skipPosix }, async (t) => {
  for (const [label, makeProvider] of [
    ["pi", (dataDir, env) => new PiProvider({ dataDir, binary: piBin, env })],
    ["omp", (dataDir, env) => new OmpProvider({ dataDir, binary: ompBin, env })],
  ]) {
    const caseDir = join(dir, "lifecycle-" + label + "-" + ++caseId);
    const logFile = join(caseDir, "log.jsonl");
    const env = { ...process.env, FAKE_PI_LOG: logFile, FAKE_OMP_LOG: logFile };
    const provider = makeProvider(caseDir, env);
    t.after(() => provider.stop());

    // Turn 1: create dependent plan on live session.
    const s1 = await provider.openSession(spec());
    await s1.send({ prompt: "start" });
    await tool(s1).handler({
      steps: [
        { id: "a", text: "Read code", status: "completed" },
        { id: "b", text: "Write fix", status: "in_progress", dependsOn: ["a"] },
        { id: "c", text: "Run tests", status: "pending", dependsOn: ["b"] },
      ],
    });
    const expected = {
      rows: [
        { id: "a", title: "Read code", status: "completed" },
        { id: "b", title: "Write fix", status: "in_progress" },
        { id: "c", title: "Run tests", status: "pending" },
      ],
      dependencies: [
        { todoId: "b", dependsOn: "a" },
        { todoId: "c", dependsOn: "b" },
      ],
    };
    assert.deepEqual(await s1.todos(), expected, label + ": Turn 1 plan");
    await s1.close();

    // Warm Turn 2: new session wrapper on the same warm live process sees the exact plan before and after send.
    const s2 = await provider.openSession(spec({ established: true, hasReplies: true }));
    assert.deepEqual(await s2.todos(), expected, label + ": warm session before start");
    await s2.send({ prompt: "continue" });
    assert.deepEqual(await s2.todos(), expected, label + ": warm session after send");
    await s2.close();

    // Supported recovery (restart / process stopped, same ref resumed from sessions.json).
    await provider.stop();
    const restarted = makeProvider(caseDir, env);
    t.after(() => restarted.stop());
    const s3 = await restarted.openSession(spec({ established: true, hasReplies: true }));
    assert.deepEqual(await s3.todos(), expected, label + ": resumed session before start");
    await s3.send({ prompt: "after restart" });
    assert.deepEqual(await s3.todos(), expected, label + ": resumed session after start");
    if (label === "omp") {
      const entries = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(entries.some((e) => e.command?.type === "set_todos" && e.command.phases?.[0]?.tasks?.length === 3), "OMP mirrors plan via set_todos");
    }
    await s3.close();

    // Folder change starts a fresh session without leaking the old folder's plan.
    const otherFolder = join(caseDir, "other-folder");
    const sFolder = await restarted.openSession(spec({ folder: otherFolder, established: true, hasReplies: true }));
    assert.equal(await sFolder.todos(), null, label + ": folder change does not carry old plan");
    await sFolder.close();

    // deleteSession removes persisted plan completely.
    await restarted.deleteSession("chat-1");
    const sDeleted = await restarted.openSession(spec());
    assert.equal(await sDeleted.todos(), null, label + ": deleted session has no plan");
    await sDeleted.close();
  }
});

test("OMP native todo tool, /todo slash commands, resumed todoPhases, and stale-ref recovery stay synchronized with Botkins", { skip: skipPosix }, async (t) => {
  const caseDir = join(dir, "omp-native-" + ++caseId);
  const logFile = join(caseDir, "log.jsonl");
  const env = { ...process.env, FAKE_OMP_LOG: logFile };
  const provider = new OmpProvider({ dataDir: caseDir, binary: ompBin, env });
  t.after(() => provider.stop());

  // 1. Native OMP `todo` tool_execution_end updates Botkins plan and emits session.todos_changed without inventing deps.
  const s1 = await provider.openSession(spec());
  const events = [];
  s1.on((e) => events.push(e.type));
  const initPayload = JSON.stringify({ op: "init", phases: [{ name: "Main", tasks: [{ content: "Inspect", status: "in_progress" }, { content: "Ship", status: "pending" }] }] });
  await s1.send({ prompt: "native-todo:" + initPayload });
  assert.equal(events.filter((e) => e === "session.todos_changed").length, 1);
  assert.deepEqual(await s1.todos(), {
    rows: [
      { id: "omp-1", title: "Inspect", status: "in_progress" },
      { id: "omp-2", title: "Ship", status: "pending" },
    ],
    dependencies: [],
  });

  // `op: "view"` does not emit spurious change events.
  const viewPayload = JSON.stringify({ op: "view", phases: [{ name: "Main", tasks: [{ content: "Inspect", status: "in_progress" }, { content: "Ship", status: "pending" }] }] });
  await s1.send({ prompt: "native-todo:" + viewPayload });
  assert.equal(events.filter((e) => e === "session.todos_changed").length, 1);

  // 2. `/todo done` and `/todo drop` slash commands (agentInvoked: false) settle cleanly and update Botkins todos.
  await s1.send({ prompt: "/todo done Inspect" });
  await s1.send({ prompt: "/todo drop Ship" });
  assert.equal(events.filter((e) => e === "session.todos_changed").length, 3);
  assert.deepEqual(mapTodos(await s1.todos()), [
    { id: "omp-1", title: "Inspect", status: "done" },
    { id: "omp-2", title: "Ship", status: "cancelled" },
  ]);
  await s1.close();

  // 3. Stale-ref recovery (missing native OMP session) clears the stale plan cleanly.
  await provider.stop();
  const staleProvider = new OmpProvider({ dataDir: caseDir, binary: ompBin, env: { ...env, FAKE_OMP_MISSING: "omp-session-1" } });
  t.after(() => staleProvider.stop());
  const sRecovered = await staleProvider.openSession(spec({ established: true, hasReplies: true }));
  await sRecovered.send({ prompt: "recover" });
  assert.equal(await sRecovered.todos(), null, "fresh recovered native session starts without stale plan");
  await sRecovered.close();

  // 4. Resuming an OMP session that already had native todoPhases in OMP state syncs them into Botkins with no invented deps.
  const preDir = join(dir, "omp-resumed-native-" + ++caseId);
  const prePhases = [{ name: "Work", tasks: [{ content: "Step X", status: "completed" }, { content: "Step Y", status: "pending" }] }];
  const preProvider = new OmpProvider({ dataDir: preDir, binary: ompBin, env: { ...process.env, FAKE_OMP_RESUMED_PHASES: JSON.stringify(prePhases) } });
  t.after(() => preProvider.stop());
  preProvider.sessions.set("chat-1", { ref: "omp-session-1", folder: dir });
  const sResumed = await preProvider.openSession(spec({ established: true, hasReplies: true }));
  const resumedEvents = [];
  sResumed.on((e) => resumedEvents.push(e.type));
  await sResumed.send({ prompt: "check" });
  assert.ok(resumedEvents.includes("session.todos_changed"));
  assert.deepEqual(await sResumed.todos(), {
    rows: [
      { id: "omp-1", title: "Step X", status: "completed" },
      { id: "omp-2", title: "Step Y", status: "pending" },
    ],
    dependencies: [],
  });
  await sResumed.close();
});

// End-to-end Workspace + keepMoving parity: Copilot vs Pi vs OMP on identical dependent plans.
async function runWorkspaceHarnessScenario(t, harness, scenario) {
  const wsDir = mkdtempSync(join(tmpdir(), "botkins-plan-parity-" + harness + "-"));
  t.after(() => rmSync(wsDir, { recursive: true, force: true }));
  const progressEvents = [];
  let turnNumber = 0;

  if (harness === "copilot") {
    const handlers = new Set();
    const session = {
      sent: [],
      todos: null,
      on: (fn) => (handlers.add(fn), () => handlers.delete(fn)),
      emit: (event) => {
        if (event.type === "session.todos_changed") progressEvents.push(mapTodos(session.todos));
        for (const fn of handlers) fn(event);
      },
      rpc: { plan: { readSqlTodosWithDependencies: async () => session.todos } },
      abort: async () => {},
      disconnect: async () => {},
      async send(options) {
        session.sent.push(options);
        turnNumber++;
        const { steps, reply } = await scenario(turnNumber, options);
        if (steps !== undefined) {
          session.todos = toTodoResult(checkedPlan({ steps }));
          session.emit({ type: "session.todos_changed", data: {} });
        }
        const id = "msg-" + turnNumber;
        session.emit({ type: "user.message", id, data: { messageId: id } });
        session.emit({ type: "assistant.message", data: { originatingMessageId: id, content: reply } });
        session.emit({ type: "session.idle", data: { mode: "interactive" } });
        return id;
      },
    };
    const ws = new Workspace(wsDir, async () => ({ createSession: async () => session, resumeSession: async () => session }), () => {});
    const chatId = ws.createChat("pip");
    await ws.send(chatId, "Build the feature");
    return { ws, chatId, progressEvents, sent: session.sent.map((s) => s.prompt) };
  }

  // Real PiSession / OmpProvider plan pipeline wired into Workspace through a lightweight scripted turn driver.
  const runtime = harness === "omp" ? OMP_ID : PI_ID;
  const sent = [];
  class ScriptedPiProvider extends PiProvider {
    constructor() {
      super({ dataDir: join(wsDir, runtime), runtime, binary: runtime === OMP_ID ? ompBin : piBin });
    }
    async openSession(sessionSpec) {
      const session = await super.openSession(sessionSpec);
      const update = tool(session);
      session.on((e) => {
        if (e.type === "session.todos_changed") progressEvents.push(mapTodos(session.storedPlan()));
      });
      session.send = async (message) => {
        sent.push(message.prompt);
        turnNumber++;
        session.emit("user.message", {});
        const { steps, reply } = await scenario(turnNumber, message);
        if (steps !== undefined) await update.handler({ steps });
        session.emit("assistant.message_delta", { deltaContent: reply });
        return { text: reply };
      };
      return session;
    }
  }
  class FakeModelProvider extends ModelProvider {
    id = "claude";
    name = "Claude";
    locate = async () => null;
    status = async () => ({ installed: true, connected: true });
    models = async () => [{ id: "opus", name: "Opus", provider: "claude", available: true, contextWindow: 10000 }];
  }
  const piLike = new ScriptedPiProvider();
  const providers = new Providers([new FakeModelProvider(), piLike]);
  const ws = new Workspace(wsDir, providers, () => {});
  t.after(() => ws.harness.stop());
  Object.assign(ws.state.settings, { harness: runtime, harnessPicked: true, model: { model: "opus", provider: "claude" } });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Build the feature");
  return { ws, chatId, progressEvents, sent };
}

test("Copilot, Pi and OMP produce identical workspace rows, dependency edges, progress events and continue/stop decisions", async (t) => {
  const dependentPlanFlow = (n) => {
    if (n === 1) {
      return {
        steps: [
          { id: "a", text: "Read the code", status: "completed" },
          { id: "b", text: "Write the fix", status: "in_progress", dependsOn: ["a"] },
          { id: "c", text: "Run the tests", status: "pending", dependsOn: ["b"] },
        ],
        reply: "Read the code and started the fix.",
      };
    }
    if (n === 2) {
      return {
        steps: [
          { id: "a", text: "Read the code", status: "completed" },
          { id: "b", text: "Write the fix", status: "completed", dependsOn: ["a"] },
          { id: "c", text: "Run the tests", status: "in_progress", dependsOn: ["b"] },
        ],
        reply: "Wrote the fix, running the tests.",
      };
    }
    return {
      steps: [
        { id: "a", text: "Read the code", status: "completed" },
        { id: "b", text: "Write the fix", status: "completed", dependsOn: ["a"] },
        { id: "c", text: "Run the tests", status: "completed", dependsOn: ["b"] },
      ],
      reply: "All tests pass.",
    };
  };

  const results = {};
  for (const harness of ["copilot", "pi", "omp"]) {
    const { ws, chatId, progressEvents, sent } = await runWorkspaceHarnessScenario(t, harness, dependentPlanFlow);
    const run = ws.state.runs.find((r) => r.chatId === chatId);
    const chat = ws.chat(chatId);
    results[harness] = {
      sentCount: sent.length,
      continuationPrompts: sent.slice(1),
      progressEvents,
      runTodos: run.todos,
      chatTodos: chat.todos,
      plan: run.plan,
      continued: run.continued,
      stoppedOpen: run.stoppedOpen,
      status: run.status,
    };
  }

  assert.deepEqual(results.pi, results.copilot, "Pi must match Copilot identically");
  assert.deepEqual(results.omp, results.copilot, "OMP must match Copilot identically");
  assert.equal(results.copilot.sentCount, 3);
  assert.deepEqual(results.copilot.runTodos, [
    { id: "a", title: "Read the code", status: "done" },
    { id: "b", title: "Write the fix", status: "done", dependsOn: ["a"] },
    { id: "c", title: "Run the tests", status: "done", dependsOn: ["b"] },
  ]);
  assert.deepEqual(results.copilot.plan, { open: 0, total: 3 });
  assert.deepEqual(results.copilot.continued, { count: 2, limit: 8, reason: "plan", open: 1 });
  assert.equal(results.copilot.stoppedOpen, undefined);

  // Stop decision parity: asking the user a question with open dependent steps stops identically on all 3 harnesses.
  const stopOnQuestion = () => ({
    steps: [
      { id: "a", text: "Read the code", status: "completed" },
      { id: "b", text: "Write the fix", status: "pending", dependsOn: ["a"] },
    ],
    reply: "I found two options.\n\nWhich approach should I take?",
  });
  const stopResults = {};
  for (const harness of ["copilot", "pi", "omp"]) {
    const { ws, chatId, progressEvents, sent } = await runWorkspaceHarnessScenario(t, harness, stopOnQuestion);
    const run = ws.state.runs.find((r) => r.chatId === chatId);
    stopResults[harness] = {
      sentCount: sent.length,
      progressEvents,
      runTodos: run.todos,
      chatTodos: ws.chat(chatId).todos,
      plan: run.plan,
      continued: run.continued,
      stoppedOpen: run.stoppedOpen,
    };
  }
  assert.deepEqual(stopResults.pi, stopResults.copilot, "Pi stop decision matches Copilot");
  assert.deepEqual(stopResults.omp, stopResults.copilot, "OMP stop decision matches Copilot");
  assert.equal(stopResults.copilot.sentCount, 1);
  assert.equal(stopResults.copilot.continued, undefined);
  assert.equal(stopResults.copilot.stoppedOpen, true);
  assert.deepEqual(stopResults.copilot.plan, { open: 1, total: 2 });
});

