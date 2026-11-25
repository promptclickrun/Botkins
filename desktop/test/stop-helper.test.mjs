// Stopping one helper or background command of a turn ("stop-helper-v1"): the workspace's call
// and the marks it keeps (`stoppable`), against a Copilot session whose runtime can cancel tasks
// and one that can't, and the link's end of the call (its arguments, its permission, its capability).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { CAPABILITIES, linkCapabilities } from "../desktop/runtime.mjs";
import { REMOTE_METHODS, remoteArgs } from "../desktop/link/methods.mjs";
import { TEAM_METHODS } from "../desktop/link/team.mjs";
import { runPart } from "../desktop/link/parts.mjs";
import { finishCanvas } from "../desktop/canvas.mjs";
import { CopilotProvider } from "../desktop/providers/copilot/index.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

/** A Copilot session. `tasks` is what the runtime's task list holds; `script(emit, session)` is the turn. */
function fakeSession(script, { tasks } = {}) {
  const all = new Set();
  const session = {
    sent: [],
    cancelled: [],
    on(fn) {
      all.add(fn);
      return () => all.delete(fn);
    },
    emit(event) {
      for (const fn of [...all]) fn(event);
    },
    rpc: {
      plan: { readSqlTodosWithDependencies: async () => null },
      ...(tasks && {
        tasks: {
          list: async () => ({ tasks: tasks() }),
          cancel: async ({ id }) => {
            session.cancelled.push(id);
            session.onCancel?.(id);
            return { cancelled: true };
          },
        },
      }),
    },
    abort: async () => {},
    disconnect: async () => {},
    async send(options) {
      session.sent.push(options);
      await script(session.emit.bind(session), session);
      const messageId = "message:" + session.sent.length;
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Done" } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };
  return session;
}

function open(session, t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-stop-helper-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({ createSession: async () => session, resumeSession: async () => session }), () => {});
  return { ws, id: ws.createChat("pip") };
}

const helper = (emit, id) => {
  emit({ type: "tool.execution_start", data: { toolCallId: id, toolName: "task", arguments: { prompt: "Find it" } } });
  emit({ type: "subagent.started", data: { toolCallId: id, agentName: "explore", agentDescription: "Find it" } });
};
const shell = (emit, id, command) => emit({ type: "tool.execution_start", data: { toolCallId: id, toolName: "bash", arguments: { command, run_in_background: true } } });

test("a running helper and a running background command are marked stoppable, and stopping one leaves the turn going", async (t) => {
  const tasks = [];
  let seen;
  const session = fakeSession(async (emit, self) => {
    helper(emit, "h1");
    helper(emit, "h2");
    shell(emit, "s1", "npm run dev");
    emit({ type: "tool.execution_start", data: { toolCallId: "plain", toolName: "view", arguments: { path: "/a" } } });
    emit({ type: "tool.execution_start", data: { toolCallId: "inner", toolName: "grep", arguments: { pattern: "x" } }, agentId: "h1" });
    tasks.push(
      { type: "agent", id: "task-1", toolCallId: "h1", status: "running" },
      { type: "agent", id: "task-2", toolCallId: "h2", status: "running" },
      { type: "shell", id: "shell-1", command: "npm run dev", status: "running", startedAt: new Date().toISOString() },
    );
    const run = ws.state.runs[0];
    const marks = () => [run.agents.map((a) => a.stoppable === true), run.steps.map((s) => [s.id, s.stoppable === true])];
    seen = { before: marks(), part: structuredClone(runPart(ws.state, id)) };
    // The runtime reports a cancelled helper the way it does when its own cancel is used.
    self.onCancel = (task) => task.startsWith("task-") && emit({ type: "subagent.failed", data: { toolCallId: task === "task-1" ? "h1" : "h2", error: "Cancelled" } });
    await ws.stopHelper(id, "h1");
    await ws.stopHelper(id, "s1");
    seen.after = marks();
    seen.agents = structuredClone(run.agents);
    seen.steps = structuredClone(run.steps);
    seen.cancelled = [...self.cancelled];
    seen.again = await ws.stopHelper(id, "h1").catch((error) => error.message);
    seen.second = run.agents.find((a) => a.id === "h2").status;
    emit({ type: "subagent.completed", data: { toolCallId: "h2", result: "ok" } });
  }, { tasks: () => tasks });
  const { ws, id } = open(session, t);
  await ws.send(id, "go");
  const run = ws.state.runs[0];

  assert.deepEqual(seen.before[0], [true, true], "both helpers");
  assert.deepEqual(seen.before[1], [["h1", false], ["h2", false], ["s1", true], ["plain", false], ["inner", false]], "a background command, and not a plain tool or a helper's own step");
  assert.equal(seen.part.agents[0].stoppable, true, "the run part a phone is sent carries the mark");
  assert.equal(seen.part.steps.find((s) => s.id === "s1").stoppable, true);
  assert.deepEqual(seen.cancelled, ["task-1", "shell-1"], "a helper by its call, a command by its text");
  assert.deepEqual(seen.agents.map((a) => [a.id, a.status, a.detail, a.stoppable]), [["h1", "Stopped", "Stopped by you", undefined], ["h2", "Running", undefined, true]], "the runtime's later report of a cancel does not change it, and the other helper goes on");
  assert.deepEqual(seen.steps.filter((s) => ["h1", "s1", "inner", "plain"].includes(s.id)).map((s) => [s.id, s.status, s.stoppable]), [["h1", "Stopped", undefined], ["s1", "Stopped", undefined], ["plain", "Running", undefined], ["inner", "Stopped", undefined]], "the helper's own steps stop with it");
  assert.equal(seen.again, "That helper already finished.");
  assert.equal(run.status, "Completed", "the turn was not stopped");
  assert.equal(run.agents.find((a) => a.id === "h2").status, "Done");
  assert.ok(run.agents.every((a) => a.stoppable === undefined) && run.steps.every((s) => s.stoppable === undefined), "no mark is left once the turn is over");
});

test("a call that is not a running helper or background command of the chat's turn is refused in plain words", async (t) => {
  const tasks = [{ type: "agent", id: "task-1", toolCallId: "h1", status: "running" }];
  const outcomes = {};
  const session = fakeSession(async (emit) => {
    helper(emit, "h1");
    emit({ type: "tool.execution_start", data: { toolCallId: "plain", toolName: "view", arguments: { path: "/a" } } });
    emit({ type: "subagent.completed", data: { toolCallId: "h1", result: "ok" } });
    helper(emit, "h3");
    for (const [name, call] of [["done", () => ws.stopHelper(id, "h1")], ["plain", () => ws.stopHelper(id, "plain")], ["unknown", () => ws.stopHelper(id, "nope")], ["empty", () => ws.stopHelper(id, "")], ["other chat", () => ws.stopHelper("elsewhere", "h3")], ["gone from the list", () => ws.stopHelper(id, "h3")]])
      outcomes[name] = await call().then(() => "stopped", (error) => error.message);
  }, { tasks: () => tasks });
  const { ws, id } = open(session, t);
  assert.equal(await ws.stopHelper(id, "h1").catch((error) => error.message), "This chat isn't working on a turn right now.", "no turn under way");
  await ws.send(id, "go");
  assert.deepEqual(outcomes, {
    done: "That helper already finished.",
    plain: "That isn't a helper or a background command of this turn.",
    unknown: "That isn't a helper or a background command of this turn.",
    empty: "Choose a helper or a command to stop.",
    "other chat": "This chat isn't working on a turn right now.",
    "gone from the list": "That helper already finished.",
  });
  assert.deepEqual(session.cancelled, [], "nothing was cancelled by a refused call");
});

test("a model that can't stop one helper marks none and says so", async (t) => {
  let seen;
  const session = fakeSession(async (emit) => {
    helper(emit, "h1");
    shell(emit, "s1", "sleep 9");
    const run = ws.state.runs[0];
    seen = { marks: [...run.agents, ...run.steps].map((item) => item.stoppable), error: await ws.stopHelper(id, "h1").catch((error) => error.message) };
  });
  const { ws, id } = open(session, t);
  await ws.send(id, "go");
  assert.deepEqual(seen.marks.filter((mark) => mark), []);
  assert.equal(seen.error, "This model can't stop one helper on its own. Stop the whole turn instead.");
});

test("a runtime that refuses the cancel gives a plain sentence and the helper goes on", async (t) => {
  let seen;
  const tasks = [{ type: "agent", id: "task-1", toolCallId: "h1", status: "running" }];
  const session = fakeSession(async (emit, self) => {
    helper(emit, "h1");
    self.rpc.tasks.cancel = async () => {
      throw new Error("method not found");
    };
    seen = await ws.stopHelper(id, "h1").catch((error) => error.message);
    seen = [seen, ws.state.runs[0].agents[0].status, ws.state.runs[0].agents[0].stoppable];
  }, { tasks: () => tasks });
  const { ws, id } = open(session, t);
  await ws.send(id, "go");
  assert.deepEqual(seen, ["Botkins couldn't stop it: method not found", "Running", true]);
});

test("the end of a turn takes every stoppable mark away", () => {
  const run = { agents: [{ id: "a", status: "Running", stoppable: true }], steps: [{ id: "a", background: true, status: "Running", stoppable: true }] };
  finishCanvas(run);
  assert.deepEqual([run.agents[0].status, run.agents[0].stoppable, run.steps[0].stoppable], ["Stopped", undefined, undefined]);
});

test("the link carries stopHelper for the same people as stop, with two ids and nothing else", () => {
  assert.ok(REMOTE_METHODS.has("stopHelper"));
  assert.deepEqual(TEAM_METHODS.stopHelper, TEAM_METHODS.stop);
  assert.deepEqual(remoteArgs("stopHelper", ["chat-1", "tool-1"]), ["chat-1", "tool-1"]);
  for (const args of [[], ["chat-1"], ["chat-1", ""], ["chat-1", 5], [null, "x"], ["chat-1", "x", "extra"], ["chat-1", "a\0b"]])
    assert.throws(() => remoteArgs("stopHelper", args), /Choose the helper or command to stop\./, JSON.stringify(args));
});

test("the capability is named only when the link carries the call, and the phone's copies of the link files are the same", () => {
  assert.ok(CAPABILITIES.includes("stop-helper-v1"));
  assert.equal(linkCapabilities(new Set()).includes("stop-helper-v1"), false);
  assert.equal(linkCapabilities(new Set(["stopHelper"])).includes("stop-helper-v1"), true);
  for (const file of ["methods.mjs", "team.mjs"])
    assert.equal(readFileSync(new URL("../desktop/link/" + file, import.meta.url), "utf8"), readFileSync(new URL("../../mobile/link-host/" + file, import.meta.url), "utf8"), file + " is the same on the phone's side");
});

test("Copilot matches a helper by its call and a shell by its command, and says plainly when there is none", async (t) => {
  const folder = tempDir(t);
  let tasks = [];
  let answer = { cancelled: true };
  const cancelled = [];
  const fake = fakeClient(undefined, {
    rpc: (id, log) => ({
      model: { switchTo: async () => ({}) },
      permissions: { setMode: async () => ({ success: true }) },
      tasks: { list: async () => ({ tasks }), cancel: async ({ id }) => (cancelled.push(id), answer) },
    }),
  });
  const copilot = new CopilotProvider({ connect: fake.client });
  t.after(() => copilot.stop());
  const session = await copilot.openSession({ sessionId: "stop-chat", folder, model: { model: "auto" }, approval: "ask", instructions: "", skills: { directories: [], disabled: [] }, mcpServers: {}, plugins: [], tools: [] });
  const events = [];
  session.on((event) => events.push(event));
  const live = fake.log.sessions.get("stop-chat");
  const at = (offset) => new Date(Date.now() + offset).toISOString();
  live.emit({ type: "tool.execution_start", data: { toolCallId: "s-old", toolName: "bash", arguments: { command: "npm run dev  " } } });
  await new Promise((resolve) => setTimeout(resolve, 15));
  live.emit({ type: "tool.execution_start", data: { toolCallId: "s-new", toolName: "bash", arguments: { command: "npm run dev" } } });
  assert.equal(events.length, 2, "the events still reach the workspace");
  assert.equal(session.canStopHelper("anything"), true);

  tasks = [
    { type: "agent", id: "task-a", toolCallId: "h1", status: "running" },
    { type: "agent", id: "task-done", toolCallId: "h9", status: "completed" },
    { type: "shell", id: "shell-1", command: "npm run dev", status: "running", startedAt: at(-60_000) },
    { type: "shell", id: "shell-2", command: "npm run dev", status: "running", startedAt: at(0) },
    { type: "shell", id: "shell-3", command: "npm test", status: "running", startedAt: at(0) },
  ];
  await session.stopHelper("h1");
  await session.stopHelper("s-new");
  await session.stopHelper("s-old");
  assert.deepEqual(cancelled, ["task-a", "shell-2", "shell-2"], "a helper by its call; a shell by its command (trimmed), the one that began when the call did");
  await assert.rejects(session.stopHelper("h9"), /^Error: That helper already finished\.$/, "a task that ended");
  await assert.rejects(session.stopHelper("nope"), /^Error: That helper already finished\.$/);
  live.emit({ type: "tool.execution_start", data: { toolCallId: "s-other", toolName: "bash", arguments: { command: "make" } } });
  await assert.rejects(session.stopHelper("s-other"), /^Error: That command already finished\.$/);
  answer = { cancelled: false };
  await assert.rejects(session.stopHelper("h1"), /^Error: That helper already finished\.$/, "a cancel the runtime declined");
  fake.log.sessions.get("stop-chat").rpc.tasks.cancel = async () => {
    throw new Error("boom");
  };
  await assert.rejects(session.stopHelper("h1"), /^Error: Botkins couldn't stop it: boom$/);
  fake.log.sessions.get("stop-chat").rpc.tasks.list = async () => {
    throw new Error("no list");
  };
  await assert.rejects(session.stopHelper("h1"), /^Error: Botkins couldn't stop it: no list$/);
  delete fake.log.sessions.get("stop-chat").rpc.tasks;
  assert.equal(session.canStopHelper("h1"), false, "a runtime without the task calls can't");
  await assert.rejects(session.stopHelper("h1"), /Botkins couldn't stop it: this version of Copilot can't stop one helper\./);
});
