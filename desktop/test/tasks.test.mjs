import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Tasks } from "../desktop/tasks.mjs";

function setup(t, reply = (prompt) => "Done: " + prompt.split("\n")[2]) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-tasks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handlers = new Set();
  const session = {
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    emit: (event) => handlers.forEach((handler) => handler(event)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      const text = reply(prompt);
      if (text instanceof Error) throw text;
      const messageId = "message:" + prompt.length;
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: text } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };
  const ws = new Workspace(dir, async () => ({ createSession: async () => session, resumeSession: async () => session }), () => {});
  return { ws, tasks: new Tasks(ws), pip: ws.state.bots[0].id, scout: ws.state.bots[1].id };
}
const settle = (ws) => Promise.all([...ws.locks.values()].map((p) => p.catch(() => {})));

test("tasks are saved, validated and moved between lanes", (t) => {
  const { tasks, pip } = setup(t);
  const id = tasks.save({ title: " Draft the newsletter ", body: "Two paragraphs", botId: pip, priority: "high" });
  const task = tasks.get(id);
  assert.deepEqual([task.title, task.status, task.priority, task.createdBy], ["Draft the newsletter", "later", "high", "person"]);
  assert.throws(() => tasks.save({ title: "x", priority: "asap" }), /low, normal, high or urgent/);
  assert.throws(() => tasks.save({ title: "x", status: "done" }), /Later or Ready/);
  assert.throws(() => tasks.save({ title: "x", botId: "nope" }), /Unknown bot/);
  assert.throws(() => tasks.move(id, "working"), /start working on their own/);
  tasks.move(id, "done");
  assert.equal(task.status, "done");
  tasks.remove(id);
  assert.throws(() => tasks.get(id), /no longer exists/);
});

test("the dispatcher starts the most urgent ready task, and a finished task waits for review", async (t) => {
  const { ws, tasks, pip } = setup(t);
  const low = tasks.save({ title: "Low one", botId: pip, priority: "low", status: "ready" });
  const urgent = tasks.save({ title: "Urgent one", botId: pip, priority: "urgent", status: "ready" });
  tasks.save({ title: "Unassigned", status: "ready" });
  tasks.tick();
  assert.equal(tasks.get(urgent).status, "working");
  assert.equal(tasks.get(low).status, "ready", "one task per bot at a time");
  const chat = ws.chat(tasks.get(urgent).chatId);
  assert.equal(chat.title, "Task · Urgent one");
  await settle(ws);
  assert.equal(tasks.get(urgent).status, "review");
  assert.match(tasks.get(urgent).result, /Done: Task: Urgent one/);
  assert.equal(ws.state.runs.find((r) => r.chatId === chat.id).taskId, urgent);
  tasks.tick();
  assert.equal(tasks.get(low).status, "working");
  await settle(ws);
  assert.equal(tasks.get(low).status, "review");
  assert.equal(tasks.all.find((x) => x.title === "Unassigned").status, "ready", "a task without a bot waits");
});

test("a failed task is blocked, and Try again sends it back to Ready", async (t) => {
  const { ws, tasks, pip } = setup(t, () => new Error("Rate limited"));
  const id = tasks.save({ title: "Fragile", botId: pip, status: "ready" });
  tasks.tick();
  await settle(ws);
  assert.deepEqual([tasks.get(id).status, tasks.get(id).problem], ["blocked", "Rate limited"]);
  tasks.move(id, "ready");
  assert.equal(tasks.get(id).problem, undefined);
});

test("a task left working on restart is blocked; deleting a bot unassigns its tasks", (t) => {
  const { ws, tasks, pip } = setup(t);
  const id = tasks.save({ title: "Interrupted", botId: pip });
  tasks.get(id).status = "working";
  const again = new Tasks(ws);
  assert.equal(again.get(id).status, "blocked");
  tasks.removeBot(pip);
  assert.equal(tasks.get(id).botId, null);
});

test("bot tools create, list and update their own tasks, with a per-turn limit", async (t) => {
  const { ws, tasks, pip, scout } = setup(t);
  const chatId = ws.createChat(pip);
  const active = { stopped: false };
  ws.active.set(chatId, active);
  const tools = Object.fromEntries(tasks.tools(ws.bot(pip), ws.chat(chatId), { id: "r" }, active).map((x) => [x.name, x]));
  const made = JSON.parse(await tools.task_create.handler({ title: "Research flights", bot: "scout", status: "ready" }));
  assert.deepEqual([made.bot, made.status], ["Scout", "ready"]);
  assert.equal(tasks.get(made.id).botId, scout);
  assert.equal(tasks.get(made.id).createdBy, pip);
  await assert.rejects(async () => tools.task_create.handler({ title: "x", bot: "Nobody" }), /No bot is named Nobody/);
  assert.equal(JSON.parse(await tools.task_list.handler({})).length, 1);
  await tools.task_update.handler({ id: made.id, status: "later", priority: "high" });
  assert.deepEqual([tasks.get(made.id).status, tasks.get(made.id).priority], ["later", "high"]);
  const other = tasks.save({ title: "Not mine", botId: scout });
  await assert.rejects(async () => tools.task_update.handler({ id: other, status: "done" }), /your own tasks/);
  const own = tasks.save({ title: "Running one", body: "Person's words", botId: pip });
  const runTools = Object.fromEntries(tasks.tools(ws.bot(pip), ws.chat(chatId), { id: "r2", taskId: own }, active).map((x) => [x.name, x]));
  // On the task it is working on, nothing a bot naturally does fails: each call answers with what will happen.
  tasks.get(own).status = "working";
  const done = JSON.parse(await runTools.task_update.handler({ id: own, status: "done" }));
  assert.equal(done.id, own);
  assert.match(done.note, /^Noted\. This task moves to Review when your reply ends/);
  assert.deepEqual([Object.keys(done)[0], done.status, done.next], ["note", "working", "review, when your reply ends"], "the note is read first, and what happens next is beside the status");
  assert.equal(tasks.get(own).status, "working", "the board sets the status itself when the reply ends");
  assert.match(JSON.parse(await runTools.task_update.handler({ id: own, status: "review" })).note, /^Noted\./);
  assert.match(JSON.parse(await runTools.task_update.handler({ id: own, status: "later" })).note, /its status stays as it is/);
  const reworded = JSON.parse(await runTools.task_update.handler({ id: own, details: "Overwritten", title: "Mine now" }));
  assert.match(reworded.note, /stay as the person wrote them/);
  assert.deepEqual([tasks.get(own).body, tasks.get(own).title], ["Person's words", "Running one"]);
  // A priority is still its to set, alone or beside a status.
  assert.equal(JSON.parse(await runTools.task_update.handler({ id: own, priority: "urgent" })).priority, "urgent");
  assert.equal(JSON.parse(await runTools.task_update.handler({ id: own, status: "done", priority: "low" })).priority, "low");
  assert.equal("note" in JSON.parse(await runTools.task_update.handler({ id: own, priority: "normal" })), false, "nothing to explain when nothing was held back");
  // When the reply ends, the board moves it to Review, as the note said.
  tasks.finished({ taskId: own, chatId, status: "Completed", id: "r2" });
  assert.equal(tasks.get(own).status, "review");
  // The tool and the task's own message say so up front.
  assert.match(runTools.task_update.description, /moves to Review by itself when your reply ends/);
  assert.deepEqual(runTools.task_update.parameters.properties.status.enum, ["later", "ready", "review", "done", "archived"]);
  assert.match(tasks.prompt(tasks.get(own)), /You don't change this task's status: when your reply ends the task moves to Review by itself/);
  for (let i = 0; i < 9; i++) await tools.task_create.handler({ title: "Bulk " + i });
  await assert.rejects(async () => tools.task_create.handler({ title: "Eleventh" }), /at most ten/);
});

test("Start now on a task whose chat is busy uses a fresh chat instead of getting stuck", async (t) => {
  const { ws, tasks, pip } = setup(t);
  const id = tasks.save({ title: "Busy chat", botId: pip, status: "ready" });
  tasks.start(id);
  await settle(ws);
  const first = tasks.get(id).chatId;
  tasks.move(id, "blocked");
  ws.active.set(first, { stopped: false }); // the person is talking in that chat
  tasks.start(id);
  assert.notEqual(tasks.get(id).chatId, first, "a fresh chat takes the task");
  assert.equal(tasks.get(id).status, "working");
  ws.active.delete(first);
  await settle(ws);
  assert.equal(tasks.get(id).status, "review");
});

test("tasks a bot adds during unattended work wait in Later and say who added them", async (t) => {
  const { ws, tasks, pip } = setup(t);
  const chatId = ws.createChat(pip);
  const active = { stopped: false };
  ws.active.set(chatId, active);
  const tools = (run) => Object.fromEntries(tasks.tools(ws.bot(pip), ws.chat(chatId), run, active).map((x) => [x.name, x]));
  const fromRoutine = JSON.parse(await tools({ id: "r", scheduleId: 1 }).task_create.handler({ title: "From a routine", bot: "Pip", status: "ready" }));
  assert.equal(fromRoutine.status, "later");
  const fromTask = JSON.parse(await tools({ id: "r2", taskId: "x" }).task_create.handler({ title: "From a task", status: "ready" }));
  assert.equal(fromTask.status, "later");
  const asked = JSON.parse(await tools({ id: "r3" }).task_create.handler({ title: "Asked for", bot: "Pip", status: "ready" }));
  assert.equal(asked.status, "ready", "a task added while the person is in the chat can start");
  assert.match(tasks.prompt(tasks.get(asked.id)), /Pip added it, not the person/);
  assert.match(tasks.prompt(tasks.get(tasks.save({ title: "Mine" }))), /from the person's task board/);
});

test("one tick starts as many ready tasks as the limits allow: per bot 1 by default, the computer's limit after", async (t) => {
  const { ws, tasks, pip, scout } = setup(t);
  const third = ws.state.bots[2].id;
  const ids = [pip, pip, scout, scout, third].map((botId, i) => tasks.save({ title: "Job " + i, botId, status: "ready" }));
  tasks.tick();
  const working = () => tasks.all.filter((x) => x.status === "working");
  assert.equal(working().length, 2, "two at once on the computer, as before");
  assert.deepEqual(new Set(working().map((x) => x.botId)), new Set([pip, scout]), "one task per bot by default");
  await settle(ws);
  ws.setPreferences({ tasksMax: 3 });
  tasks.tick();
  assert.equal(working().length, 3, "three start in one tick");
  assert.equal(new Set(working().map((x) => x.botId)).size, 3);
  await settle(ws);
  assert.ok(ids.every((id) => ["review", "ready"].includes(tasks.get(id).status)));
});

test("tasks at once per bot 2 runs two of one bot's tasks side by side, in separate chats", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { ws, tasks, pip } = setup(t);
  ws.setPreferences({ tasksPerBot: 2, tasksMax: 4 });
  const ids = [0, 1, 2].map((i) => tasks.save({ title: "Pip " + i, botId: pip, status: "ready" }));
  // The first task's old chat is busy with the person: the dispatcher must not reuse it.
  const busy = ws.createChat(pip, "Talking");
  tasks.get(ids[0]).chatId = busy;
  ws.active.set(busy, { stopped: false, done: gate });
  tasks.tick();
  const working = tasks.all.filter((x) => x.status === "working");
  assert.equal(working.length, 2, "two for Pip, not three");
  assert.ok(!working.some((x) => x.id === ids[0]), "a ready task whose chat is busy waits");
  assert.notEqual(working[0].chatId, working[1].chatId, "each task has its own chat");
  for (const x of working) assert.notEqual(x.chatId, busy);
  ws.active.delete(busy);
  release();
  await settle(ws);
  tasks.tick();
  assert.equal(tasks.get(ids[0]).status, "working");
  assert.notEqual(tasks.get(ids[0]).chatId, working[0].chatId);
  await settle(ws);
});
