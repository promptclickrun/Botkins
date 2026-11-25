import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import {
  REASONING_CAP,
  forkTranscript,
  mapTodos,
  validateAttachments,
  workSummary,
} from "../desktop/canvas.mjs";
import { changeSettings, defaultSettings } from "../desktop/preferences.mjs";
import { liveTurnDisplay, updateInChat } from "../src/liveDisplay.ts";

/** A fake Copilot session: `script(emit, options)` runs during send. */
function fakeSession(script) {
  const all = new Set();
  const typed = new Map();
  const session = {
    sent: [],
    on(type, fn) {
      if (typeof type === "function") {
        all.add(type);
        return () => all.delete(type);
      }
      typed.set(fn, type);
      return () => typed.delete(fn);
    },
    emit(event) {
      for (const fn of all) fn(event);
      for (const [fn, type] of typed) if (type === event.type) fn(event);
    },
    rpc: {
      plan: {
        readSqlTodosWithDependencies: async () => session.todos,
      },
    },
    abort: async () => session.aborted?.(),
    disconnect: async () => {},
    async send(options) {
      session.sent.push(options);
      const response = await script(session.emit.bind(session), options);
      // Some canvas tests emit their own user boundary to exercise event mapping. The adapter
      // still needs a correlated boundary for the SDK send result, so add a test-only one after
      // the script when the script did not provide a message id.
      const messageId = "message:" + session.sent.length;
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: response?.data?.content ?? "" } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };
  return session;
}

function workspaceWith(session, t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-canvas-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = async () => ({
    createSession: async () => session,
    resumeSession: async () => session,
    ...extra,
  });
  return { ws: new Workspace(dir, client, () => {}), dir };
}

const tick = () => new Promise((r) => setImmediate(r));

test("reasoning, usage, context, subagents and todos are recorded for the main agent", async (t) => {
  let live;
  const session = fakeSession(async (emit) => {
    // The plan below ends with steps open, so Botkins gives the bot a second turn (desktop/keep-moving.mjs); it has nothing to add.
    if (session.sent.length > 1) return { data: { content: "Done" } };
    emit({ type: "assistant.reasoning_delta", data: { reasoningId: "r1", deltaContent: "Let me " } });
    emit({ type: "assistant.reasoning_delta", data: { reasoningId: "r1", deltaContent: "think." } });
    emit({ type: "assistant.reasoning_delta", agentId: "sub", data: { reasoningId: "x", deltaContent: "helper" } });
    live = ws.snapshot().thinking[id];
    emit({ type: "assistant.reasoning", data: { reasoningId: "r1", content: "Let me think." } });
    emit({ type: "assistant.usage", data: { model: "m1", inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cost: 1, duration: 900 } });
    emit({ type: "assistant.usage", agentId: "sub", data: { model: "m2", inputTokens: 10, outputTokens: 5 } });
    emit({ type: "session.usage_info", data: { currentTokens: 3800, tokenLimit: 10000, messagesLength: 4 } });
    emit({ type: "subagent.started", data: { toolCallId: "a1", agentName: "explore", agentDisplayName: "Explorer", agentDescription: "Looks around" } });
    emit({ type: "subagent.started", data: { toolCallId: "a2", agentName: "task", agentDisplayName: "Task", agentDescription: "" } });
    emit({ type: "subagent.completed", data: { toolCallId: "a1", agentName: "explore", agentDisplayName: "Explorer" } });
    emit({ type: "subagent.failed", data: { toolCallId: "a2", agentName: "task", agentDisplayName: "Task", error: "boom" } });
    emit({ type: "tool.execution_start", data: { toolCallId: "t1", toolName: "bash", arguments: { command: "ls -la" } } });
    emit({ type: "tool.execution_complete", data: { toolCallId: "t1", success: true } });
    emit({ type: "tool.execution_start", data: { toolCallId: "t2", toolName: "view", arguments: { path: "/a" } } });
    emit({ type: "tool.execution_complete", data: { toolCallId: "t2", success: true } });
    session.todos = {
      rows: [
        { id: "a", title: "Plan", status: "done" },
        { id: "b", title: "List", status: "in_progress" },
        { id: "c", title: "Report", status: "pending" },
        { id: "d", title: "Skip", status: "cancelled" },
      ],
      dependencies: [{ todoId: "c", dependsOn: "b" }],
    };
    emit({ type: "session.todos_changed", data: {} });
    await tick();
    return { data: { content: "Done" } };
  });
  const { ws } = workspaceWith(session, t);
  const id = ws.createChat("pip");
  await ws.send(id, "Go");
  const run = ws.state.runs[0];
  const chat = ws.chat(id);
  assert.equal(live, "Let me think.");
  assert.equal(run.reasoning.length, 1);
  assert.equal(run.reasoning[0].text, "Let me think.");
  assert.ok(run.reasoning[0].finished >= run.reasoning[0].started);
  assert.deepEqual(run.usage, { input: 110, output: 25, cacheRead: 50, cost: 1, durationMs: 900, model: "m1" });
  // The window's makeup is kept for the context details popup; updatedAt is the time it was recorded.
  const { updatedAt, ...context } = chat.context;
  assert.ok(updatedAt > 0);
  assert.deepEqual(context, { current: 3800, limit: 10000, messages: 4 });
  assert.deepEqual(run.agents.map((a) => [a.name, a.status]), [["Explorer", "Done"], ["Task", "Failed"]]);
  assert.equal(run.agents[1].detail, "boom");
  assert.deepEqual(run.todos.map((t) => t.status), ["done", "in_progress", "pending", "cancelled"]);
  assert.deepEqual(run.todos[2].dependsOn, ["b"]);
  assert.deepEqual(chat.todos, run.todos);
  assert.equal(run.summary, "Ran a command, read a file");
  assert.ok(run.finished >= run.time);
  assert.equal(ws.snapshot().thinking[id], undefined);
});

test("a helper still running when the reply ends is stopped, not failed", async (t) => {
  const session = fakeSession(async (emit) => {
    emit({ type: "subagent.started", data: { toolCallId: "h1", agentName: "research", agentDisplayName: "Researcher" } });
    return { data: { content: "Started it." } };
  });
  const { ws } = workspaceWith(session, t);
  const id = ws.createChat("pip");
  await ws.send(id, "Go");
  const [helper] = ws.state.runs[0].agents;
  assert.equal(helper.status, "Stopped");
  assert.equal(helper.detail, "Stopped with the reply");
  assert.ok(helper.finished >= helper.started);
});

test("reasoning is capped per run", async (t) => {
  const session = fakeSession(async (emit) => {
    for (let i = 0; i < 30; i++)
      emit({ type: "assistant.reasoning_delta", data: { reasoningId: "r" + (i % 3), deltaContent: "x".repeat(1000) } });
    return { data: { content: "ok" } };
  });
  const { ws } = workspaceWith(session, t);
  const id = ws.createChat("pip");
  await ws.send(id, "Go");
  const total = ws.state.runs[0].reasoning.reduce((n, r) => n + r.text.length, 0);
  assert.ok(total <= REASONING_CAP, String(total));
});

test("messages sent while a chat works are queued, removable and read together in order", async (t) => {
  const releases = [];
  const session = fakeSession(
    () => new Promise((resolve) => releases.push(() => resolve({ data: { content: "reply" } }))),
  );
  const { ws } = workspaceWith(session, t);
  const id = ws.createChat("pip");
  const first = ws.submit(id, "One");
  assert.ok(first);
  await tick();
  assert.equal(ws.submit(id, "Two"), null);
  assert.equal(ws.submit(id, "Three"), null);
  assert.equal(ws.submit(id, "Four"), null);
  const queued = ws.snapshot().queued[id];
  assert.deepEqual(queued.map((q) => q.text), ["Two", "Three", "Four"]);
  ws.unqueue(id, queued[1].id);
  releases.shift()();
  await first;
  await tick();
  await tick();
  // What is left in the queue is one person's: it is one turn, started with both messages (desktop/keep-moving.mjs).
  assert.equal(ws.active.has(id), true);
  assert.equal(ws.snapshot().queued[id], undefined);
  releases.shift()();
  await ws.active.get(id).done;
  await tick();
  assert.equal(session.sent.length, 2);
  assert.equal(session.sent[0].prompt, "One");
  assert.match(session.sent[1].prompt, /^\[Botkins\] The person sent 2 messages while you were busy\. Here they are in order; read them all before you reply\.\n\nMessage 1:\nTwo\n\nMessage 2:\nFour$/);
  assert.deepEqual(
    ws.chat(id).messages.filter((m) => m.role === "user").map((m) => m.text),
    ["One", "Two", "Four"],
  );
  assert.equal(ws.state.runs.length, 2);
  assert.equal(ws.snapshot().queued[id], undefined);
});

test("default desktop delivery and Send now steer the same turn without aborting or replaying", async (t) => {
  const session = fakeSession(() => {});
  const calls = [];
  session.send = async (options) => {
    calls.push(options);
    const messageId = "msg-" + calls.length;
    session.emit({ type: "user.message", id: messageId, data: { messageId, delivery: options.mode === "immediate" ? "steering" : undefined } });
    return messageId;
  };
  let aborts = 0;
  session.aborted = () => aborts++;
  const { ws } = workspaceWith(session, t);
  const id = ws.createChat("pip");
  const first = ws.submit(id, "Long job", { clientMessageId: "local-1" });
  await tick();
  ws.submit(id, "Use green", { delivery: "steer", clientMessageId: "local-2" });
  await tick();
  assert.equal(calls[1]?.mode, "immediate");
  ws.submit(id, "Make it small", { delivery: "queue", clientMessageId: "local-3" });
  const [queued] = ws.snapshot().queued[id];
  assert.equal(queued.clientMessageId, "local-3");
  await ws.sendNow(id, queued.id);
  assert.deepEqual(calls.map(o => o.prompt), ["Long job", "Use green", "Make it small"]);
  assert.equal(ws.state.runs.length, 1);
  assert.equal(ws.state.runs[0].status, "Working");
  assert.equal(aborts, 0);
  session.emit({ type: "assistant.message", data: { originatingMessageId: "msg-3", content: "Small and green" } });
  session.emit({ type: "session.idle", data: { mode: "interactive" } });
  await first;
  assert.equal(ws.state.runs[0].status, "Completed");
  assert.deepEqual(ws.chat(id).messages.map(m => m.text), ["Long job", "Use green", "Make it small", "Small and green"]);
  assert.deepEqual(ws.chat(id).messages.filter(m => m.role === "user").map(m => m.clientMessageId), ["local-1", "local-2", "local-3"]);
  assert.equal(ws.snapshot().queued[id], undefined);
});

test("a steer crossing the original idle event still receives its answer", async (t) => {
  const session = fakeSession(() => {});
  const { ws } = workspaceWith(session, t);
  const chat = ws.createChat("pip");
  session.send = async ({ mode, clientTurnId }) => {
    if (!mode) {
      session.emit({ type: "user.message", id: "start", data: { messageId: "original" } });
      return "original";
    }
    session.emit({ type: "assistant.message", data: { originatingMessageId: "original", content: "Initial answer" } });
    session.emit({ type: "session.idle", data: { mode: "interactive" } });
    await tick();
    session.emit({ type: "user.message", id: "followup", data: { messageId: "next", clientTurnId, delivery: "idle" } });
    session.emit({ type: "assistant.message", data: { originatingMessageId: "next", content: "Updated answer" } });
    session.emit({ type: "session.idle", data: { mode: "interactive" } });
    return "next";
  };
  const done = ws.submit(chat, "First request");
  // Send before the original request is admitted.
  ws.submit(chat, "Update it", { delivery: "steer" });
  await done;
  assert.equal(ws.state.runs.length, 1);
  assert.equal(ws.state.runs[0].status, "Completed");
  assert.deepEqual(ws.chat(chat).messages.map(m => m.text), ["First request", "Update it", "Updated answer"]);
});

test("attachments are validated, sent through the SDK and stored with a quote", async (t) => {
  const session = fakeSession(async () => ({ data: { content: "Read it" } }));
  const { ws, dir } = workspaceWith(session, t);
  const file = join(dir, "note.txt");
  writeFileSync(file, "hello");
  const folder = join(dir, "folder");
  mkdirSync(folder);
  assert.throws(() => validateAttachments(["relative.txt"]), /full file path/);
  assert.throws(() => validateAttachments([join(dir, "missing.txt")]), /not found/);
  assert.throws(() => validateAttachments(Array(11).fill(file)), /up to 10/);
  assert.deepEqual(validateAttachments([file, file, { path: folder, name: "F" }]), [
    { name: "note.txt", path: file, kind: "file" },
    { name: "F", path: folder, kind: "directory" },
  ]);
  const id = ws.createChat("pip");
  await ws.submit(id, "What does it say?", { attachments: [{ path: file, name: "note.txt" }], quote: "Earlier line" });
  assert.deepEqual(session.sent[0].attachments, [{ type: "file", path: file, displayName: "note.txt" }]);
  assert.match(session.sent[0].prompt, /^Replying to this earlier text:\n> Earlier line\n\nWhat does it say\?$/);
  const message = ws.chat(id).messages[0];
  assert.equal(message.text, "What does it say?");
  assert.equal(message.quote, "Earlier line");
  assert.equal(message.attachments[0].path, file);
  assert.throws(() => ws.submit(id, "Bad", { attachments: ["/nope/never"] }), /not found/);
});

test("a failed turn can be retried with its attachments", async (t) => {
  let fail = true;
  const session = fakeSession(async () => {
    if (fail) throw new Error("Copilot is unavailable");
    return { data: { content: "Fine" } };
  });
  const { ws } = workspaceWith(session, t);
  const id = ws.createChat("pip");
  await ws.send(id, "Hello");
  const failed = ws.state.runs[0];
  assert.equal(failed.status, "Needs you");
  fail = false;
  await ws.retry(failed.id);
  assert.equal(ws.state.runs[0].status, "Completed");
  assert.equal(ws.chat(id).messages.at(-1).text, "Fine");
});

test("fork copies the transcript and gives the new session the earlier conversation", async (t) => {
  const configs = [];
  const session = fakeSession(async (_emit, { prompt }) => ({ data: { content: "echo " + prompt } }));
  const dir = mkdtempSync(join(tmpdir(), "botkins-fork-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = async () => ({
    createSession: async (cfg) => (configs.push(cfg), session),
    resumeSession: async (_id, cfg) => (configs.push(cfg), session),
    // No native fork: the transcript path must carry the context.
    rpc: { sessions: { fork: async () => { throw new Error("unsupported"); } } },
  });
  const ws = new Workspace(dir, client, () => {});
  const id = ws.createChat("pip");
  await ws.send(id, "The code is 4417");
  await ws.send(id, "Second");
  const forkId = await ws.forkChat(id, 1);
  const fork = ws.chat(forkId);
  assert.equal(fork.botId, "pip");
  assert.deepEqual(fork.messages.map((m) => m.text), ["The code is 4417", "echo The code is 4417"]);
  assert.deepEqual(fork.forkedFrom, { chatId: id, messageIndex: 1 });
  assert.match(fork.forkContext, /User: The code is 4417/);
  assert.doesNotMatch(fork.forkContext, /Second/);
  await ws.send(forkId, "What was the code?");
  assert.match(configs.at(-1).systemMessage.content, /earlier-conversation[\s\S]*4417/);
  assert.equal(configs.at(-1).inference.reasoningSummary, "detailed");
  assert.match(forkTranscript([{ role: "user", text: "x".repeat(50) }], "Pip", 20), /^…/);
});

test("fork uses Copilot's native fork at a mapped event boundary", async (t) => {
  const forks = [];
  const session = fakeSession(async (_emit, { prompt }) => {
    session.emit({ type: "user.message", id: "ev-" + prompt, data: {} });
    return { data: { content: "ok" } };
  });
  const { ws } = workspaceWith(session, t, {
    rpc: { sessions: { fork: async (p) => (forks.push(p), { sessionId: "forked-1" }) } },
  });
  const id = ws.createChat("pip");
  await ws.send(id, "A");
  await ws.send(id, "B");
  const forkId = await ws.forkChat(id, 1);
  assert.equal(forkId, "forked-1");
  assert.deepEqual(forks, [{ sessionId: id, toEventId: "ev-B" }]);
  assert.equal(ws.chat(forkId).established, true);
  assert.equal(ws.chat(forkId).forkContext, undefined);
});

test("work summaries use tool names only", () => {
  assert.equal(
    workSummary([
      { name: "bash", label: "rm -rf secret" },
      { name: "bash" },
      { name: "bash" },
      { name: "view" },
      { name: "view" },
      { name: "web_search" },
      { name: "report_intent" },
    ]),
    "Ran 3 commands, read 2 files, searched the web",
  );
  assert.equal(workSummary([{ name: "lookup", source: "my-mcp" }]), "Used a tool");
  assert.equal(workSummary([{ name: "report_intent" }]), "");
});

test("todo statuses map to Botkins' set", () => {
  assert.deepEqual(
    mapTodos({ rows: [{ id: "1", title: "a", status: "completed" }, { id: "2", status: "blocked", title: "b" }, { id: "3", title: "c", status: "weird" }, { id: "4", title: "d", status: "failed" }] }).map((t) => t.status),
    ["done", "blocked", "pending", "failed"],
  );
  assert.deepEqual(mapTodos(undefined), []);
});

test("showThinking and showUpdates are independent boolean settings that default on", () => {
  assert.equal(defaultSettings.showThinking, true);
  assert.equal(defaultSettings.showUpdates, true);

  const updatesOnly = changeSettings(defaultSettings, { showThinking: false });
  assert.equal(updatesOnly.showThinking, false);
  assert.equal(updatesOnly.showUpdates, true);

  const thinkingOnly = changeSettings(defaultSettings, { showUpdates: false });
  assert.equal(thinkingOnly.showThinking, true);
  assert.equal(thinkingOnly.showUpdates, false);

  assert.throws(() => changeSettings(defaultSettings, { showThinking: "no" }));
  assert.throws(() => changeSettings(defaultSettings, { showUpdates: "no" }));
});

test("liveTurnDisplay gates chain of thought and interim updates independently", () => {
  const sample = { stream: "Checking calendar…", thinking: "Step 1: inspect dates", intent: "Reading calendar" };

  assert.deepEqual(
    liveTurnDisplay({ settings: { showThinking: true, showUpdates: true }, ...sample }),
    { showThinking: true, showUpdates: true, liveThinking: "Step 1: inspect dates", liveStream: "Checking calendar…", liveIntent: "Reading calendar" },
  );

  assert.deepEqual(
    liveTurnDisplay({ settings: { showThinking: false, showUpdates: true }, ...sample }),
    { showThinking: false, showUpdates: true, liveThinking: undefined, liveStream: "Checking calendar…", liveIntent: "Reading calendar" },
  );

  assert.deepEqual(
    liveTurnDisplay({ settings: { showThinking: true, showUpdates: false }, ...sample }),
    { showThinking: true, showUpdates: false, liveThinking: "Step 1: inspect dates", liveStream: "", liveIntent: "" },
  );

  assert.deepEqual(
    liveTurnDisplay({ settings: { showThinking: false, showUpdates: false }, ...sample }),
    { showThinking: false, showUpdates: false, liveThinking: undefined, liveStream: "", liveIntent: "" },
  );

  // Older remote hosts that omit showUpdates default to showing updates.
  assert.equal(
    liveTurnDisplay({ settings: { showThinking: true }, ...sample }).liveStream,
    "Checking calendar…",
  );
});

test("a finished turn's updates stay in the chat only where its thinking does", () => {
  const open = { showUpdates: true, showThinking: true, thinkingMode: "open", islandMode: false };
  assert.equal(updateInChat({ ...open, live: true, thinkingMode: "folded" }), true, "while the turn runs, updates are in the chat");
  assert.equal(updateInChat({ ...open, live: true, showUpdates: false }), false);
  assert.equal(updateInChat({ ...open, live: false }), true, "thinking open in the chat: the updates stay with it");
  assert.equal(updateInChat({ ...open, live: false, islandMode: true }), false, "the island's receipt holds both");
  assert.equal(updateInChat({ ...open, live: false, thinkingMode: "folded" }), false, "folded thinking: the updates fold with it");
  assert.equal(updateInChat({ ...open, live: false, showThinking: false }), false);
});
