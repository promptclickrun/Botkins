// Keeping the work moving, through a whole turn (desktop/workspace.mjs): plan auto-continue, the
// "next step" catch, merged queued messages, and questions that detach. The model is a scripted
// fake session; nothing here reaches a real one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { DETACHED_NOTE } from "../desktop/interactions.mjs";
import { STALL_NOTE, planNote } from "../desktop/keep-moving.mjs";
import { pass, settle, until } from "./quiet-turns.mjs";

/**
 * A fake Copilot session. `reply(n, { emit, options, session })` runs for the n-th send (from 1), may set
 * `session.todos`, and answers the reply's text. Every prompt that was sent is in `session.sent`.
 */
function fakeSession(reply) {
  const handlers = new Set();
  const session = {
    sent: [],
    todos: undefined,
    on: (fn) => (handlers.add(fn), () => handlers.delete(fn)),
    emit: (event) => handlers.forEach((fn) => fn(event)),
    rpc: { plan: { readSqlTodosWithDependencies: async () => session.todos } },
    abort: async () => {},
    disconnect: async () => {},
    async send(options) {
      session.sent.push(options);
      const n = session.sent.length;
      const text = await reply(n, { emit: session.emit, options, session });
      const id = "message:" + n;
      session.emit({ type: "user.message", id, data: { messageId: id } });
      session.emit({ type: "assistant.message", data: { originatingMessageId: id, content: text ?? "" } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return id;
    },
  };
  return session;
}

function setup(t, reply) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-keep-moving-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = fakeSession(reply);
  const client = async () => ({ createSession: async () => session, resumeSession: async () => session });
  const ws = new Workspace(dir, client, () => {});
  return { ws, session, dir, chat: ws.createChat("pip") };
}

const plan = (session, ...rows) => {
  session.todos = { rows: rows.map(([id, title, status]) => ({ id, title, status })), dependencies: [] };
  session.emit({ type: "session.todos_changed", data: {} });
};
const runOf = (ws, chat) => ws.state.runs.find((run) => run.chatId === chat);
const replies = (ws, chat) => ws.chat(chat).messages.filter((m) => m.role === "assistant" && !m.interim).map((m) => m.text);

test("a plan with open steps gets another turn in the same session and run, until it is done", async (t) => {
  const { ws, session, chat } = setup(t, (n, { session }) => {
    if (n === 1) { plan(session, ["a", "Read the code", "in_progress"], ["b", "Write the fix", "pending"]); return "I read the code."; }
    if (n === 2) { plan(session, ["a", "Read the code", "done"], ["b", "Write the fix", "in_progress"]); return "Writing the fix."; }
    plan(session, ["a", "Read the code", "done"], ["b", "Write the fix", "done"]);
    return "All done.";
  });
  await ws.send(chat, "Fix the bug");
  assert.equal(session.sent.length, 3);
  assert.equal(session.sent[1].prompt, planNote([{ title: "Read the code", status: "in_progress" }, { title: "Write the fix", status: "pending" }], 1));
  assert.equal(session.sent[2].prompt, planNote([{ title: "Write the fix", status: "in_progress" }], 2));
  assert.equal(ws.state.runs.length, 1, "the same run");
  const run = runOf(ws, chat);
  assert.equal(run.status, "Completed");
  assert.deepEqual(run.continued, { count: 2, limit: 8, reason: "plan", open: 1 });
  assert.deepEqual(run.plan, { open: 0, total: 2 });
  assert.equal(run.stoppedOpen, undefined);
  assert.deepEqual(replies(ws, chat), ["I read the code.", "Writing the fix.", "All done."]);
  assert.equal(ws.chat(chat).messages.filter((m) => m.role === "user").length, 1, "Botkins' note is not a message from the person");
});

test("a chain goes on at most 8 times, then the run says it stopped with open steps", async (t) => {
  const { ws, session, chat } = setup(t, (n, { session }) => {
    plan(session, ["s" + n, "Step " + n, "pending"]);
    return "Step " + n + " is started.";
  });
  await ws.send(chat, "Go");
  assert.equal(session.sent.length, 9, "the first turn and 8 continuations");
  assert.match(session.sent[8].prompt, /Botkins kept going 8 of 8 times/);
  const run = runOf(ws, chat);
  assert.equal(run.status, "Completed");
  assert.equal(run.continued.count, 8);
  assert.deepEqual(run.plan, { open: 1, total: 1 });
  assert.equal(run.stoppedOpen, true);
});

test("the same open steps coming back stop the chain", async (t) => {
  const { ws, session, chat } = setup(t, (n, { session }) => {
    plan(session, ["a", "Deploy", "pending"]);
    return "Waiting on something.";
  });
  await ws.send(chat, "Go");
  assert.equal(session.sent.length, 2, "one continuation, which changed nothing");
  const run = runOf(ws, chat);
  assert.equal(run.continued.count, 1);
  assert.equal(run.stoppedOpen, true);
  assert.deepEqual(run.plan, { open: 1, total: 1 });
});

test("a message waiting in the queue runs instead of a continuation", async (t) => {
  let id;
  const { ws, session, chat } = setup(t, (n, { session }) => {
    if (n === 1) { plan(session, ["a", "One", "pending"]); ws.submit(id, "Actually, do this first."); }
    return "Reply " + n;
  });
  id = chat;
  await ws.send(chat, "Go");
  await until(() => session.sent.length === 2 && !ws.active.has(chat), "the queued message's turn");
  assert.equal(session.sent[1].prompt, "Actually, do this first.");
  const first = ws.state.runs.at(-1);
  assert.equal(first.continued, undefined);
  assert.equal(first.stoppedOpen, true, "it ended with a step open and nothing went on");
});

test("Stop ends the chain", async (t) => {
  let id;
  const { ws, session, chat } = setup(t, async (n, { session }) => {
    plan(session, ["a", "One", "pending"]);
    if (n === 1) await ws.stop(id);
    return "Reply";
  });
  id = chat;
  await ws.send(chat, "Go");
  assert.equal(session.sent.length, 1);
  const run = runOf(ws, chat);
  assert.equal(run.status, "Stopped");
  assert.equal(run.continued, undefined);
  assert.equal(run.stoppedOpen, true);
});

test("an open question or approval stops the chain", async (t) => {
  let id;
  const { ws, session, chat } = setup(t, (n, { session }) => {
    plan(session, ["a", "One", "pending"]);
    if (n === 1) {
      const task = ws.active.get(id);
      // Left unanswered: the turn ends with it open (a detached question is the same to the chain).
      ws.interactions.request(ws.chat(id), task, { kind: "question", title: "Which?", choices: [], freeform: true });
      ws.interactions.detach([...ws.interactions.entries.keys()][0]);
    }
    return "Reply";
  });
  id = chat;
  await ws.send(chat, "Go");
  assert.equal(session.sent.length, 1);
  assert.equal(runOf(ws, chat).stoppedOpen, true);
  assert.equal(ws.interactions.snapshot().length, 1, "the waiting question stays");
});

test("a reply that ends with a question to the person is not continued", async (t) => {
  const { ws, session, chat } = setup(t, (n, { session }) => {
    plan(session, ["a", "Pick a name", "pending"]);
    return "I found two names.\n\nWhich one do you want?";
  });
  await ws.send(chat, "Go");
  assert.equal(session.sent.length, 1);
  assert.equal(runOf(ws, chat).stoppedOpen, true);
});

test("a task or routine run is never continued", async (t) => {
  const { ws, session, chat } = setup(t, (n, { session }) => {
    plan(session, ["a", "One", "pending"]);
    return "Next I'll run it.";
  });
  await ws.send(chat, "Go", { taskId: "t1" });
  assert.equal(session.sent.length, 1);
  const run = runOf(ws, chat);
  assert.equal(run.continued, undefined);
  assert.equal(run.plan, undefined);
  assert.equal(run.stoppedOpen, undefined);
});

test("a reply that names its next step is told to do it, at most twice", async (t) => {
  const { ws, session, chat } = setup(t, () => "Tests pass. Next I'll update the docs.");
  await ws.send(chat, "Go");
  assert.equal(session.sent.length, 3, "the first turn and 2 catches");
  assert.equal(session.sent[1].prompt, STALL_NOTE);
  const run = runOf(ws, chat);
  assert.deepEqual(run.continued, { count: 2, limit: 8, reason: "next-step", open: 0 });
  assert.equal(run.plan, undefined);
  assert.equal(run.stoppedOpen, undefined, "no plan, so no open steps");
});

test("the catch stops once the bot does the step", async (t) => {
  const { ws, session, chat } = setup(t, (n) => (n === 1 ? "Let me now run the tests." : "Ran them: all 12 pass."));
  await ws.send(chat, "Go");
  assert.equal(session.sent.length, 2);
  assert.deepEqual(replies(ws, chat), ["Let me now run the tests.", "Ran them: all 12 pass."]);
});

test("a continuation that fails leaves the finished reply standing, with the steps open", async (t) => {
  const { ws, session, chat } = setup(t, (n, { session }) => {
    if (n === 2) throw new Error("The model is overloaded");
    plan(session, ["a", "One", "pending"]);
    return "Started.";
  });
  await ws.send(chat, "Go");
  const run = runOf(ws, chat);
  assert.equal(run.status, "Completed");
  assert.equal(run.stoppedOpen, true);
  assert.deepEqual(replies(ws, chat), ["Started."]);
});

// ── Merged queued messages ──────────────────────────────────────────────────────────────────────

test("messages queued by one person are read in one turn; another person's get their own", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-merge-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const one = join(dir, "one.txt");
  const two = join(dir, "two.txt");
  writeFileSync(one, "1");
  writeFileSync(two, "2");
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { ws, session, chat } = setup(t, async (n) => {
    if (n === 1) await held;
    return "Reply " + n;
  });
  const first = ws.send(chat, "Start");
  const ann = { memberId: "m1", name: "Ann" };
  ws.submit(chat, "second", { attachments: [one], clientMessageId: "c-2" });
  ws.submit(chat, "third", { attachments: [{ path: two }], clientMessageId: "c-3" });
  ws.submit(chat, "from Ann", { author: ann });
  ws.submit(chat, "and later");
  release();
  await first;
  await until(() => !ws.active.has(chat) && session.sent.length >= 4 && !ws.queues.has(chat), "the queue to drain");
  await settle();
  const prompts = session.sent.map((sent) => sent.prompt);
  assert.equal(prompts.length, 4, "Start; second and third together; Ann's; the owner again");
  assert.match(prompts[1], /^(?:\[[^\]]*\]\n)?\[Botkins\] The person sent 2 messages while you were busy\. Here they are in order; read them all before you reply\.\n\nMessage 1:\nsecond\n\nMessage 2:\nthird/);
  assert.deepEqual(session.sent[1].attachments.map((a) => a.path), [one, two], "each message keeps its attachments");
  assert.match(prompts[2], /from Ann/);
  assert.doesNotMatch(prompts[2], /The person sent 2 messages/);
  assert.equal(prompts[3], "and later", "the owner after Ann is not read with the owner before her");
  const runs = ws.state.runs.filter((run) => run.chatId === chat);
  assert.equal(runs.length, 4);
  const users = ws.chat(chat).messages.filter((m) => m.role === "user");
  assert.deepEqual(users.map((m) => m.text), ["Start", "second", "third", "from Ann", "and later"], "each is still its own message in the chat");
  assert.deepEqual(users.map((m) => m.clientMessageId), [undefined, "c-2", "c-3", undefined, undefined]);
  assert.equal(users[2].steeredRunId, users[1].runId);
  assert.deepEqual(users[2].attachments.map((a) => a.path), [two]);
});

// ── Questions that detach ───────────────────────────────────────────────────────────────────────

const MINUTE = 60000;

test("a question unanswered for 10 minutes lets its turn go on, and stays open as waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, session, chat } = setup(t, () => "Done.");
  const task = { run: { id: "r1" }, stopped: false, ended: false };
  const asked = ws.interactions.question(ws.chat(chat), task, { question: "Which color?", choices: ["Red", "Blue"], allowFreeform: false });
  let result;
  asked.then((value) => (result = value));
  await pass(t, 9 * MINUTE);
  assert.equal(result, undefined, "still waiting at 9 minutes");
  await pass(t, MINUTE);
  assert.deepEqual(result, { answer: DETACHED_NOTE, wasFreeform: true });
  assert.equal(DETACHED_NOTE, "No answer yet. The question stays visible in the chat. If the person answers later, the answer will reach you as a new message that quotes the question. Finish this turn now.");
  const [view] = ws.interactions.snapshot();
  assert.deepEqual([view.title, view.kind, view.detached], ["Which color?", "question", true]);
  // A turn's end cancels what the turn waits for; a waiting question is nobody's turn, so it stays.
  ws.interactions.cancel(chat);
  assert.equal(ws.interactions.snapshot().length, 1);
  // It does not hold the chat: a new message starts a turn at once.
  await ws.send(chat, "Hello");
  assert.equal(session.sent.length, 1);
  assert.equal(ws.interactions.snapshot().length, 1);
  // The answer is a new message that quotes the question, and starts a turn.
  ws.interactions.respond(view.id, { action: "answer", value: "Blue" });
  assert.equal(ws.interactions.snapshot().length, 0);
  await ws.active.get(chat)?.done;
  const answer = ws.chat(chat).messages.findLast((m) => m.role === "user");
  assert.deepEqual([answer.text, answer.quote], ["Blue", "Which color?"]);
  assert.equal(session.sent.length, 2);
  assert.match(session.sent[1].prompt, /Replying to this earlier text:\n> Which color\?\n\nBlue$/);
});

test("a waiting question can still be dismissed, and a wrong answer is still refused", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, session, chat } = setup(t, () => "Done.");
  const task = { run: { id: "r1" }, stopped: false, ended: false };
  void ws.interactions.question(ws.chat(chat), task, { question: "Which color?", choices: ["Red", "Blue"], allowFreeform: false });
  await pass(t, 10 * MINUTE);
  const [view] = ws.interactions.snapshot();
  assert.throws(() => ws.interactions.respond(view.id, { action: "answer", value: "Green" }), /Choose an answer/);
  assert.equal(ws.interactions.snapshot().length, 1);
  ws.interactions.respond(view.id, { action: "cancel" });
  assert.equal(ws.interactions.snapshot().length, 0);
  assert.equal(session.sent.length, 0, "a dismissal starts nothing");
});

test("an answer given while the chat is busy waits in the queue as a message that quotes the question", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { ws, session, chat } = setup(t, async (n) => {
    if (n === 1) await held;
    return "Reply " + n;
  });
  const task = { run: { id: "r1" }, stopped: false, ended: false };
  void ws.interactions.question(ws.chat(chat), task, { question: "Which color?", choices: [], allowFreeform: true });
  await pass(t, 10 * MINUTE);
  const [view] = ws.interactions.snapshot();
  const busy = ws.send(chat, "Work");
  ws.interactions.respond(view.id, { action: "answer", value: "Teal" });
  assert.equal(ws.queues.get(chat)[0].quote, "Which color?");
  release();
  await busy;
  await until(() => session.sent.length === 2, "the answer's turn");
  assert.match(session.sent[1].prompt, /> Which color\?\n\nTeal$/);
});

test("an approval keeps waiting with no limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, chat } = setup(t, () => "Done.");
  const task = { run: { id: "r1" }, stopped: false, ended: false };
  const asked = ws.interactions.request(ws.chat(chat), task, { kind: "permission", label: "Run", title: "Run it?", preview: "ls" });
  let result;
  asked.then((value) => (result = value));
  await pass(t, 24 * 60 * MINUTE);
  assert.equal(result, undefined);
  assert.equal(ws.interactions.snapshot()[0].detached, undefined);
  ws.interactions.cancel(chat);
  await settle();
  assert.deepEqual(result, { action: "cancel" });
});

// ── Restarts ────────────────────────────────────────────────────────────────────────────────────

/** Opens the workspace in `dir` again, as after a restart, with a new session behind it. */
const reopen = (dir, session) => new Workspace(dir, async () => ({ createSession: async () => session, resumeSession: async () => session }), () => {});
const hangs = () => new Promise(() => {});

test("a restart during a continuation does not give the chain its limits back", async (t) => {
  const { ws, session, dir, chat } = setup(t, (n, { session }) => {
    // The 8th continuation (the 9th send) is where Botkins closes.
    if (n === 9) return hangs();
    plan(session, ["s" + n, "Step " + n, "pending"]);
    return "Step " + n + " is started.";
  });
  void ws.send(chat, "Go");
  await until(() => session.sent.length === 9, "the 8th continuation");
  const again = reopen(dir, fakeSession((n, { session }) => (plan(session, ["after", "Step after", "pending"]), "Back again.")));
  const resumed = again.state.runs[0];
  assert.equal(resumed.status, "Working");
  await Promise.all(again.resumeActive());
  assert.equal(again.state.runs[0].status, "Completed");
  assert.equal(again.state.runs[0].continued.count, 8, "no ninth continuation");
  assert.equal(again.state.runs[0].stoppedOpen, true);
});

test("a restart during the second catch does not allow more catches", async (t) => {
  const { ws, session, dir, chat } = setup(t, (n) => (n === 3 ? hangs() : "Tests pass. Next I'll update the docs."));
  void ws.send(chat, "Go");
  await until(() => session.sent.length === 3, "the second catch");
  const next = fakeSession(() => "Docs updated. Next I'll update the changelog.");
  const again = reopen(dir, next);
  await Promise.all(again.resumeActive());
  assert.equal(next.sent.length, 1, "the resumed turn is not caught a third time");
  assert.equal(again.state.runs[0].continued.count, 2);
});

test("a restart before the provider send keeps every message of a merged batch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-merge-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "second.txt");
  writeFileSync(file, "2");
  // Botkins exits while the session starts: the provider input was never checkpointed.
  const ws = new Workspace(dir, () => hangs(), () => {});
  const chat = ws.createChat("pip");
  void ws.send(chat, "first", { merged: [{ text: "second", attachments: [file] }, { text: "third" }] });
  await settle();
  assert.equal(ws.state.runs[0].status, "Working");
  const session = fakeSession(() => "Read all three.");
  const again = reopen(dir, session);
  await Promise.all(again.resumeActive());
  assert.equal(session.sent.length, 1);
  assert.match(session.sent[0].prompt, /The person sent 3 messages while you were busy/);
  for (const text of ["first", "second", "third"]) assert.match(session.sent[0].prompt, new RegExp("Message \\d:\\n" + text));
  assert.deepEqual(session.sent[0].attachments.map((a) => a.path), [file]);
  assert.deepEqual(again.chat(chat).messages.filter((m) => m.role === "user").map((m) => m.text), ["first", "second", "third"], "each is still its own bubble");
});

test("a question that detached comes back after a restart, and its answer still starts a turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, dir, chat } = setup(t, () => "Done.");
  const task = { run: { id: "r1" }, stopped: false, ended: false };
  void ws.interactions.question(ws.chat(chat), task, { question: "Which color?", choices: ["Red", "Blue"], allowFreeform: false });
  // A live question and an approval are waits of a turn that is gone after a restart.
  ws.interactions.question(ws.chat(chat), task, { question: "Live?", choices: [], allowFreeform: true }).catch(() => {});
  const [detachedView] = ws.interactions.snapshot();
  ws.interactions.detach(detachedView.id);
  void ws.interactions.permission(ws.chat(chat), task, { label: "Run", title: "Run it?", preview: "ls" });
  // The program quits the way runtime.stop does.
  ws.closing = true;
  ws.interactions.cancel(undefined, { detached: true, keep: true });
  ws.flushSave();
  const session = fakeSession(() => "Got it.");
  const again = reopen(dir, session);
  const [view, ...others] = again.interactions.snapshot();
  assert.deepEqual(others, [], "only the detached question is restored");
  assert.deepEqual([view.id, view.title, view.kind, view.detached, view.chatId, view.choices], [detachedView.id, "Which color?", "question", true, chat, ["Red", "Blue"]]);
  assert.equal(view.time, detachedView.time, "it keeps the time it was asked");
  assert.deepEqual(again.snapshot().requests.map((request) => request.id), [view.id]);
  again.interactions.respond(view.id, { action: "answer", value: "Blue" });
  await again.active.get(chat)?.done;
  assert.equal(again.interactions.snapshot().length, 0);
  assert.match(session.sent[0].prompt, /Replying to this earlier text:\n> Which color\?\n\nBlue$/);
  // Answered, it does not come back again.
  const third = reopen(dir, fakeSession(() => "x"));
  assert.deepEqual(third.interactions.snapshot(), []);
});

test("a question dismissed or whose chat is deleted does not come back, but a waiting one does", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, dir, chat } = setup(t, () => "Done.");
  const other = ws.createChat("pip");
  const task = { run: { id: "r1" }, stopped: false, ended: false };
  for (const [id, title] of [[chat, "Dismissed?"], [other, "Deleted?"], [chat, "Kept?"]])
    void ws.interactions.question(ws.chat(id), task, { question: title, choices: [], allowFreeform: true });
  await pass(t, 10 * MINUTE);
  const byTitle = (title) => ws.interactions.snapshot().find((view) => view.title === title);
  ws.interactions.respond(byTitle("Dismissed?").id, { action: "cancel" });
  await ws.agents.deleteChat(other);
  const kept = byTitle("Kept?").id;
  ws.closing = true;
  ws.interactions.cancel(undefined, { detached: true, keep: true });
  ws.flushSave();
  assert.deepEqual(reopen(dir, fakeSession(() => "x")).interactions.snapshot().map((view) => view.id), [kept]);
});

test("a fresh session receives the chat checklist and its replacement survives reload", async (t) => {
  const before = [{ id: "a", title: "Inspect receipts", status: "done" }, { id: "b", title: "Verify receipts", status: "blocked", dependsOn: ["a"] }];
  const { ws, session, chat, dir } = setup(t, (_n, { session }) => {
    plan(session, ["a", "Inspect receipts", "done"], ["b", "Verify receipts", "done"]);
    return "Verified.";
  });
  ws.chat(chat).todos = before;
  await ws.send(chat, "Finish the verification");
  assert.ok(session.sent[0].prompt.includes(JSON.stringify(before)));
  assert.deepEqual(ws.chat(chat).todos.map(({ id, status }) => [id, status]), [["a", "done"], ["b", "done"]]);
  assert.deepEqual(new Workspace(dir, async () => ({}), () => {}).chat(chat).todos, ws.chat(chat).todos);
  await ws.send(chat, "Thanks");
  assert.equal(session.sent.at(-1).prompt, "Thanks");
});

test("a legacy open checklist can be cleared without reviving an older turn on reload", async (t) => {
  const { ws, chat, session, dir } = setup(t, (n, { session }) => {
    if (n === 1) plan(session, ["old", "Old step", "pending"]);
    else plan(session);
    return "Ready?";
  });
  await ws.send(chat, "Plan");
  delete ws.chat(chat).todos;
  session.todos = null;
  await ws.send(chat, "Clear the checklist");
  assert.match(session.sent.at(-1).prompt, /Old step/);
  assert.deepEqual(new Workspace(dir, async () => ({}), () => {}).chat(chat).todos, []);
  await ws.send(chat, "Hello");
  assert.equal(session.sent.at(-1).prompt, "Hello");
});
