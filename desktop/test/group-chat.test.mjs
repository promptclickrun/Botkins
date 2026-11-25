// Group chat turns and coding-session settings, with fake Copilot sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { memberSessionId } from "../desktop/groups.mjs";
import { decide } from "../desktop/providers/copilot/permissions.mjs";

const tick = () => new Promise((r) => setImmediate(r));

/**
 * A fake client. `reply(sessionId, options, session)` answers each send.
 * Records created and resumed session ids, configs and deleted sessions.
 */
function fakeClient(reply) {
  const log = { created: [], resumed: [], deleted: [], configs: new Map(), sent: [], modes: [] };
  const make = (id, config) => {
    const handlers = new Set();
    const session = {
      sessionId: id,
      on(fn) {
        handlers.add(fn);
        return () => handlers.delete(fn);
      },
      emit(event) {
        for (const fn of handlers) fn(event);
      },
      rpc: { mode: { set: async (p) => log.modes.push([id, p]) } },
      abort: async () => session.aborted?.(),
      disconnect: async () => {},
      async send(options) {
        log.sent.push([id, options.prompt]);
        const messageId = id + ":message:" + log.sent.length;
        session.emit({ type: "user.message", id: messageId, data: { messageId } });
        const response = await reply(id, options, session);
        session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: response?.data?.content ?? "" } });
        session.emit({ type: "session.idle", data: { mode: "interactive" } });
        return messageId;
      },
    };
    log.configs.set(id, config);
    return session;
  };
  const client = async () => ({
    createSession: async (config) => (log.created.push(config.sessionId), make(config.sessionId, config)),
    resumeSession: async (id, config) => (log.resumed.push(id), make(id, config)),
    deleteSession: async (id) => log.deleted.push(id),
  });
  return { client, log };
}

function setup(t, reply) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-group-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { client, log } = fakeClient(reply);
  const ws = new Workspace(join(dir, "data"), client, () => {});
  return { ws, log, dir, client };
}

/** Each bot echoes its name; the prompt it got is recorded in log.sent. */
const named = (ws) => (id) => ws.state.bots.find((b) => id.endsWith("-" + b.id))?.name;

test("two members answer in order, each from its own session, and the second sees the first", async (t) => {
  let ws;
  const ctx = setup(t, async (id) => ({ data: { content: named(ws)(id) + " here." } }));
  ws = ctx.ws;
  const { log } = ctx;
  const id = ws.createGroupChat(["pip", "scout"]);
  await ws.send(id, "Hello both");
  const chat = ws.chat(id);
  assert.deepEqual(
    chat.messages.map((m) => [m.role, m.botId ?? null, m.text]),
    [
      ["user", null, "Hello both"],
      ["assistant", "pip", "Pip here."],
      ["assistant", "scout", "Scout here."],
    ],
  );
  assert.equal(chat.title, "Pip, Scout", "a group keeps its members' names as the title");
  assert.deepEqual(log.created, [memberSessionId(chat, "pip"), memberSessionId(chat, "scout")]);
  assert.match(log.sent[1][1], /Person: Hello both\n\nPip: Pip here\.\n\n\(Reply as Scout\.\)/);
  assert.doesNotMatch(log.sent[0][1], /Scout/);
  // Each member gets its own instructions plus the group's.
  const scoutConfig = log.configs.get(memberSessionId(chat, "scout"));
  assert.match(scoutConfig.systemMessage.content, /You are Scout, Research partner/);
  assert.match(scoutConfig.systemMessage.content, /group chat with the person and these bots: Pip/);
  assert.deepEqual(chat.members.pip, { seen: 2, established: true, sessionProvider: "copilot" });
  assert.deepEqual(chat.members.scout, { seen: 3, established: true, sessionProvider: "copilot" });
  assert.equal(ws.state.runs[0].status, "Completed");
  assert.equal(chat.established, false, "the group itself has no session");

  // Next turn: sessions resume, and Pip catches up on Scout's reply.
  await ws.send(id, "Again");
  assert.deepEqual(log.resumed, [memberSessionId(chat, "pip"), memberSessionId(chat, "scout")]);
  assert.equal(log.sent[2][1], "Scout: Scout here.\n\nPerson: Again\n\n(Reply as Pip.)");
});

test("a silent group member leaves the next member free to reply", async (t) => {
  const { ws, log } = setup(t, async id => ({ data: { content: id.endsWith("-pip") ? "[SILENT]" : "Hello!" } }));
  const chat = ws.createGroupChat(["pip", "scout"]);
  await ws.send(chat, "Hello both");
  assert.deepEqual(ws.chat(chat).messages.map(m => m.text), ["Hello both", "Hello!"]);
  assert.ok(!log.sent[1][1].includes("[SILENT]"));
});

test("an entirely silent group turn completes without marking the chat unread", async (t) => {
  const { ws } = setup(t, async () => ({ data: { content: " [SILENT] " } }));
  const chat = ws.createGroupChat(["pip", "scout"]);
  await ws.send(chat, "Hello both");
  const run = ws.state.runs[0];
  assert.equal(run.status, "Completed");
  assert.equal(run.noOutput, true);
  assert.ok(!ws.chat(chat).unread);
  assert.deepEqual(ws.chat(chat).messages.map(m => m.role), ["user"]);
});

test("@mentions choose who answers", async (t) => {
  let ws;
  const ctx = setup(t, async (id) => ({ data: { content: named(ws)(id) + " ok" } }));
  ws = ctx.ws;
  const id = ws.createGroupChat(["pip", "scout", "patch"]);
  await ws.send(id, "@Patch can you check this?");
  assert.deepEqual(
    ws.chat(id).messages.filter((m) => m.role === "assistant").map((m) => m.botId),
    ["patch"],
  );
  assert.deepEqual(ws.state.runs[0].speakers, ["patch"]);
  await ws.send(id, "@scout then @pip");
  assert.deepEqual(
    ws.chat(id).messages.filter((m) => m.role === "assistant").map((m) => m.botId),
    ["patch", "scout", "pip"],
  );
});

test("the snapshot names the speaker while a member replies, and Stop halts the rest", async (t) => {
  let release;
  const speakers = [];
  let ws;
  const ctx = setup(t, (id, _o, session) => {
    speakers.push(ws.snapshot().speakers[ws.state.chats[0].id]);
    session.emit({ type: "assistant.message_delta", data: { deltaContent: "Thinking about it" } });
    session.aborted = () => release({ data: { content: "partial" } });
    return new Promise((resolve) => (release = resolve));
  });
  ws = ctx.ws;
  const { log } = ctx;
  const id = ws.createGroupChat(["pip", "scout", "patch"]);
  const turn = ws.send(id, "Long question");
  await tick();
  await tick();
  assert.equal(ws.snapshot().speakers[id], "pip");
  assert.equal(ws.snapshot().streams[id], "Thinking about it");
  await ws.stop(id);
  await turn;
  assert.deepEqual(speakers, ["pip"]);
  assert.equal(log.sent.length, 1, "members not yet started never run");
  assert.equal(ws.state.runs[0].status, "Stopped");
  assert.deepEqual(ws.chat(id).messages.filter(m => m.role === "assistant").map(m => [m.botId, m.text, m.interim]),
    [["pip", "Thinking about it", true]]);
  assert.equal(ws.state.runs[0].ending, "stopped");
  assert.equal(ws.snapshot().speakers[id], undefined);
});

test("one member's failure is recorded and the others still answer", async (t) => {
  let ws;
  const ctx = setup(t, async (id, _o, session) => {
    if (id.endsWith("-scout")) throw new Error("model unavailable");
    session.emit({ type: "tool.execution_start", data: { toolCallId: "t-" + id, toolName: "bash", arguments: { command: "ls" } } });
    session.emit({ type: "tool.execution_complete", data: { toolCallId: "t-" + id, success: true } });
    session.emit({ type: "assistant.reasoning", data: { reasoningId: "r-" + id, content: "hmm" } });
    session.emit({ type: "assistant.usage", data: { inputTokens: 10, outputTokens: 2 } });
    return { data: { content: named(ws)(id) + " done" } };
  });
  ws = ctx.ws;
  const id = ws.createGroupChat(["pip", "scout", "patch"]);
  await ws.send(id, "Go");
  const run = ws.state.runs[0];
  assert.deepEqual(
    ws.chat(id).messages.filter((m) => m.role === "assistant").map((m) => m.botId),
    ["pip", "patch"],
  );
  assert.equal(run.status, "Completed");
  assert.deepEqual(run.failures, [{ botId: "scout", detail: "model unavailable" }]);
  assert.match(run.detail, /Scout: model unavailable/);
  assert.deepEqual(run.steps.map((s) => s.botId), ["pip", "patch"]);
  assert.deepEqual(run.reasoning.map((r) => r.botId), ["pip", "patch"]);
  assert.deepEqual(run.usage, { input: 20, output: 4, cacheRead: 0, cacheWrite: 0 });
  // Group chats are text only.
  assert.throws(() => ws.send(id, "file", { attachments: [ctx.dir] }), /text only/);
  await assert.rejects(ws.forkChat(id, 0), /can't be forked/);
});

test("a group turn where every member fails needs the person", async (t) => {
  const { ws } = setup(t, async () => {
    throw new Error("offline");
  });
  const id = ws.createGroupChat(["pip", "scout"]);
  await ws.send(id, "Hi");
  assert.equal(ws.state.runs[0].status, "Needs you");
});

test("deleting a group chat deletes every member session; deleting a member bot shrinks or ends groups", async (t) => {
  let ws;
  const ctx = setup(t, async (id) => ({ data: { content: named(ws)(id) + "!" } }));
  ws = ctx.ws;
  const { log } = ctx;
  const extra = ws.addBot({ name: "Nova", role: "Editor", instructions: "Edit", face: "idle" });
  const pair = ws.createGroupChat(["pip", extra]);
  const trio = ws.createGroupChat([extra, "scout", "patch"]);
  const solo = ws.createChat(extra);
  await ws.send(pair, "hi");
  await ws.send(trio, "hi");
  await ws.send(solo, "hi");
  const pairChat = ws.chat(pair);
  const trioChat = ws.chat(trio);

  await ws.agents.deleteBot(extra);
  // The pair would have one member left, so it is deleted. The trio keeps Scout and Patch.
  assert.equal(ws.state.chats.some((c) => c.id === pair), false);
  assert.equal(ws.state.chats.some((c) => c.id === solo), false);
  const kept = ws.chat(trio);
  assert.deepEqual(kept.botIds, ["scout", "patch"]);
  assert.equal(kept.botId, "scout", "a new lead takes over");
  assert.equal(kept.members[extra], undefined);
  assert.deepEqual(
    [...log.deleted].sort(),
    [solo, memberSessionId(pairChat, "pip"), memberSessionId(pairChat, extra), memberSessionId(trioChat, extra)].sort(),
  );
  assert.equal(ws.state.runs.some((r) => r.chatId === pair), false);

  log.deleted.length = 0;
  await ws.agents.deleteChat(trio);
  assert.deepEqual(log.deleted.sort(), [memberSessionId(trioChat, "patch"), memberSessionId(trioChat, "scout")].sort());
});

test("a coding chat works in its project folder; other chats keep the bot folder", async (t) => {
  const { ws, log, dir } = setup(t, async () => ({ data: { content: "ok" } }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const project = ws.projects.add(repo);
  const coding = ws.createChat("patch");
  ws.projects.setChatProject(coding, project, "default");
  const plain = ws.createChat("patch");
  await ws.send(coding, "hi");
  await ws.send(plain, "hi");
  assert.equal(log.configs.get(coding).workingDirectory, repo);
  assert.equal(log.configs.get(plain).workingDirectory, join(ws.dir, "files", "patch"));
  const group = ws.createGroupChat(["pip", "scout"]);
  assert.throws(() => ws.projects.setChatProject(group, project, "default"), /Group chats/);
});

test("plan mode reaches the session, and leaving it returns to interactive", async (t) => {
  const { ws, log, dir } = setup(t, async () => ({ data: { content: "ok" } }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const project = ws.projects.add(repo);
  const id = ws.createChat("patch");
  ws.projects.setChatProject(id, project, "plan");
  await ws.send(id, "Plan a refactor");
  assert.deepEqual(log.modes, [[id, { mode: "plan" }]]);
  await ws.send(id, "Keep planning");
  assert.equal(log.modes.length, 2);
  ws.projects.setChatProject(id, project, "default");
  await ws.send(id, "Now do it");
  assert.deepEqual(log.modes.at(-1), [id, { mode: "interactive", expectedMode: "plan" }]);
  await ws.send(id, "More");
  assert.equal(log.modes.length, 3, "a chat that never planned isn't touched");
  const other = ws.createChat("patch");
  await ws.send(other, "hi");
  assert.equal(log.modes.length, 3);
});

test("YOLO approves tools only in its own coding chat, and managed policy still wins", async (t) => {
  const { ws, dir } = setup(t, async () => ({ data: { content: "ok" } }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const project = ws.projects.add(repo);
  const yolo = ws.chat(ws.createChat("patch"));
  ws.projects.setChatProject(yolo.id, project, "yolo");
  const normal = ws.chat(ws.createChat("patch"));
  ws.projects.setChatProject(normal.id, project, "default");
  const plain = ws.chat(ws.createChat("patch"));
  const task = { stopped: false };
  const req = { kind: "shell", fullCommandText: "rm -rf build", intention: "Clean" };
  const permission = (chat, request) => decide((r) => ws.interactions.permission(chat, task, r), request);
  const yes = await permission(yolo, req);
  assert.notEqual(yes.kind, "reject");
  assert.equal(ws.interactions.snapshot().length, 0, "YOLO doesn't ask");
  // Other chats still ask.
  for (const chat of [normal, plain]) {
    const pending = permission(chat, req);
    await tick();
    const asked = ws.interactions.snapshot().find((r) => r.chatId === chat.id);
    assert.ok(asked, "chat " + chat.id + " asks");
    ws.interactions.respond(asked.id, { action: "deny" });
    assert.equal((await pending).kind, "reject");
  }
  // A managed policy that requires approval still asks in YOLO.
  const managed = permission(yolo, { ...req, managedApprovalRequired: true });
  await tick();
  const asked = ws.interactions.snapshot().find((r) => r.chatId === yolo.id);
  assert.ok(asked);
  ws.interactions.respond(asked.id, { action: "deny" });
  assert.equal((await managed).kind, "reject");
});

test("restarting a group reply continues with the unfinished member", async (t) => {
  const started = Promise.withResolvers();
  const interrupted = Promise.withResolvers();
  let sent = 0;
  const { ws, client, dir, log } = setup(t, async (id) => {
    if (++sent === 2) {
      started.resolve();
      return interrupted.promise;
    }
    return { data: { content: "Reply from " + id } };
  });
  const id = ws.createGroupChat(["pip", "scout"]);
  const turn = ws.send(id, "Hello both");
  await started.promise;
  ws.closing = true;
  interrupted.reject(new Error("Session disconnected while waiting for a response"));
  await turn;
  const again = new Workspace(join(dir, "data"), client, () => {});
  await Promise.all(again.resumeActive());
  assert.deepEqual(again.chat(id).messages.slice(1).map((m) => m.botId), ["pip", "scout"]);
  assert.deepEqual(again.state.runs.map((r) => r.status), ["Completed"]);
  assert.deepEqual(log.resumed, [memberSessionId(again.chat(id), "scout")]);
});
