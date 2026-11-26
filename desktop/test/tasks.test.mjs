import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Tasks, taskNeedsPerson } from "../desktop/tasks.mjs";

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

test("moving back transitions, disallowed transitions, and history recording", async (t) => {
  const { ws, tasks, pip } = setup(t);
  const id = tasks.save({ title: "Fix login bug", botId: pip, status: "ready" });
  tasks.start(id);
  // Disallowed: moving a working task or moving into working.
  assert.throws(() => tasks.move(id, "ready"), /Stop the task's chat/);
  assert.throws(() => tasks.move(id, "done"), /Stop the task's chat/);
  await settle(ws);
  assert.equal(tasks.get(id).status, "review");
  assert.throws(() => tasks.move(id, "working"), /start working on their own/);
  assert.throws(() => tasks.move(id, "nope"), /Unknown lane/);

  // review -> ready ("Request changes") with note
  tasks.move(id, "ready", { by: "person", note: "Handle empty password case" });
  assert.equal(tasks.get(id).status, "ready");
  assert.equal(tasks.get(id).pendingNote?.text, "Handle empty password case");
  let last = tasks.get(id).history.at(-1);
  assert.deepEqual([last.from, last.to, last.by, last.note], ["review", "ready", "person", "Handle empty password case"]);

  // review -> later
  tasks.move(id, "review");
  tasks.move(id, "later", { by: "person", note: "Defer to next week" });
  assert.equal(tasks.get(id).status, "later");
  last = tasks.get(id).history.at(-1);
  assert.deepEqual([last.from, last.to, last.note], ["review", "later", "Defer to next week"]);

  // done -> ready ("Reopen")
  tasks.move(id, "done");
  assert.equal(tasks.get(id).status, "done");
  tasks.move(id, "ready", { by: "person", note: "Regression found" });
  assert.equal(tasks.get(id).status, "ready");
  assert.equal(tasks.get(id).pendingNote?.text, "Regression found");
  last = tasks.get(id).history.at(-1);
  assert.deepEqual([last.from, last.to, last.note], ["done", "ready", "Regression found"]);

  // blocked -> ready (retry)
  tasks.move(id, "blocked");
  tasks.get(id).problem = "Rate limited";
  tasks.move(id, "ready", { by: "person", note: "Try again" });
  assert.equal(tasks.get(id).status, "ready");
  assert.equal(tasks.get(id).problem, undefined);

  // archived -> disallowed jumps (cannot jump archived -> done/review/blocked), only ready/later
  tasks.move(id, "archived");
  assert.throws(() => tasks.move(id, "done"), /Cannot move a task from archived to done/);
  assert.throws(() => tasks.move(id, "review"), /Cannot move a task from archived to review/);
  tasks.move(id, "ready");
  assert.equal(tasks.get(id).status, "ready");
});

test("request changes resumes the same chat with the feedback note and previous result", async (t) => {
  const prompts = [];
  const { ws, tasks, pip } = setup(t, (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1 ? "First pass complete: added validation." : "Second pass complete: added edge-case test.";
  });
  const id = tasks.save({ title: "Add form validation", botId: pip, status: "ready" });
  tasks.start(id);
  await settle(ws);
  const firstChatId = tasks.get(id).chatId;
  assert.equal(tasks.get(id).status, "review");
  assert.match(tasks.get(id).result, /First pass complete/);

  tasks.move(id, "ready", { by: "person", note: "Please add an edge-case test for empty email." });
  tasks.tick();
  await settle(ws);

  assert.equal(tasks.get(id).chatId, firstChatId, "resumes in the same chat session");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /sent this task back for changes/);
  assert.match(prompts[1], /Please add an edge-case test for empty email\./);
  assert.match(prompts[1], /First pass complete: added validation\./);
  assert.equal(tasks.get(id).status, "review");
  assert.match(tasks.get(id).result, /Second pass complete/);
});

test("orchestrated bot-created task routes review to creator bot, notifies creator, enforces creator-only review, and allows person override", async (t) => {
  const prompts = [];
  const { ws, tasks, pip, scout } = setup(t, (prompt) => {
    prompts.push(prompt);
    return "Implemented feature and ran unit tests.";
  });
  const third = ws.state.bots[2].id;
  const creatorChatId = ws.createChat(pip, "Alfie orchestration");
  const active = { stopped: false };
  ws.active.set(creatorChatId, active);
  const pipTools = Object.fromEntries(tasks.tools(ws.bot(pip), ws.chat(creatorChatId), { id: "r-pip" }, active).map((x) => [x.name, x]));

  const created = JSON.parse(await pipTools.task_create.handler({ title: "Build review flow", details: "Ship it", bot: ws.bot(scout).name, status: "ready" }));
  assert.equal(created.review, "creator", "bot-created tasks default to creator review");
  assert.equal(tasks.get(created.id).createdChatId, creatorChatId);
  ws.active.delete(creatorChatId);

  const notified = [];
  ws.events.on("task.creatorNotified", (ev) => notified.push(ev));

  tasks.tick();
  await settle(ws);
  await settle(ws);
  const after = tasks.get(created.id);
  assert.equal(after.status, "review");
  assert.equal(after.reviewerBotId, pip, "routed to creator bot for review");
  assert.equal(taskNeedsPerson(after), false, "not counted as waiting on the person");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].chatId, creatorChatId);
  assert.equal(notified[0].autoAccepted, false);
  assert.ok(prompts.some((p) => p.includes("[Task ready for your review]") && p.includes(created.id)), "creator chat received the review prompt");

  // A non-creator bot (the assignee Scout, or an unrelated third bot) is refused from accepting or sending back.
  const scoutChatId = ws.createChat(scout);
  const scoutActive = { stopped: false };
  ws.active.set(scoutChatId, scoutActive);
  const scoutTools = Object.fromEntries(tasks.tools(ws.bot(scout), ws.chat(scoutChatId), { id: "r-scout" }, scoutActive).map((x) => [x.name, x]));
  await assert.rejects(() => scoutTools.task_update.handler({ id: created.id, status: "done" }), /Only the bot that created this task/);
  await assert.rejects(() => scoutTools.task_update.handler({ id: created.id, status: "ready", note: "nope" }), /Only the bot that created this task/);
  ws.active.delete(scoutChatId);

  const thirdChatId = ws.createChat(third);
  const thirdActive = { stopped: false };
  ws.active.set(thirdChatId, thirdActive);
  const thirdTools = Object.fromEntries(tasks.tools(ws.bot(third), ws.chat(thirdChatId), { id: "r-third" }, thirdActive).map((x) => [x.name, x]));
  await assert.rejects(() => thirdTools.task_update.handler({ id: created.id, status: "done" }), /your own tasks/);
  ws.active.delete(thirdChatId);

  // Creator bot sends it back with a note.
  ws.active.set(creatorChatId, active);
  const sentBack = JSON.parse(await pipTools.task_update.handler({ id: created.id, status: "ready", note: "Fix typo in error message" }));
  assert.equal(sentBack.status, "ready");
  assert.equal(tasks.get(created.id).reviewerBotId, undefined);
  assert.equal(tasks.get(created.id).pendingNote?.text, "Fix typo in error message");
  ws.active.delete(creatorChatId);

  // Run second pass -> back to creator review -> creator marks done.
  tasks.tick();
  await settle(ws);
  await settle(ws);
  assert.equal(tasks.get(created.id).status, "review");
  assert.equal(tasks.get(created.id).reviewerBotId, pip);

  ws.active.set(creatorChatId, active);
  const accepted = JSON.parse(await pipTools.task_update.handler({ id: created.id, status: "done", note: "Looks good" }));
  assert.equal(accepted.status, "done");
  assert.equal(tasks.get(created.id).reviewerBotId, undefined);
  ws.active.delete(creatorChatId);

  // Person override: reopen and approve a bot-reviewed task directly.
  tasks.move(created.id, "ready", { by: "person", note: "One more tweak" });
  tasks.tick();
  await settle(ws);
  await settle(ws);
  assert.equal(tasks.get(created.id).reviewerBotId, pip);
  tasks.move(created.id, "done", { by: "person" });
  assert.equal(tasks.get(created.id).status, "done");
  assert.equal(tasks.get(created.id).reviewerBotId, undefined);
});

test("auto-accept bot-created task goes straight to done and notifies creator", async (t) => {
  const { ws, tasks, pip, scout } = setup(t, () => "Generated weekly report.");
  const creatorChatId = ws.createChat(pip, "Orchestrator");
  const active = { stopped: false };
  ws.active.set(creatorChatId, active);
  const pipTools = Object.fromEntries(tasks.tools(ws.bot(pip), ws.chat(creatorChatId), { id: "r-auto" }, active).map((x) => [x.name, x]));
  const created = JSON.parse(await pipTools.task_create.handler({ title: "Generate report", bot: ws.bot(scout).name, status: "ready", review: "auto" }));
  assert.equal(created.review, "auto");
  ws.active.delete(creatorChatId);

  const notified = [];
  ws.events.on("task.creatorNotified", (ev) => notified.push(ev));

  tasks.tick();
  await settle(ws);

  const after = tasks.get(created.id);
  assert.equal(after.status, "done");
  assert.equal(after.reviewerBotId, undefined);
  assert.equal(taskNeedsPerson(after), false);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].autoAccepted, true);
  assert.equal(notified[0].chatId, creatorChatId);
  const msg = ws.chat(creatorChatId).messages.at(-1);
  assert.equal(msg.taskResult?.autoAccepted, true);
  assert.match(msg.text, /auto-accepted/);
});

test("migration setting leaves existing bot-created Review tasks untouched by default, and hands them to creator when opted in", (t) => {
  const { ws, tasks, pip, scout } = setup(t);
  // Simulate a legacy bot-created task already sitting in review without reviewerBotId or review field.
  const legacy = {
    id: "legacy-bot-task",
    title: "Legacy bot task",
    body: "",
    botId: scout,
    priority: "normal",
    status: "review",
    createdBy: pip,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
  };
  const personTask = {
    id: "legacy-person-task",
    title: "Legacy person task",
    body: "",
    botId: scout,
    priority: "normal",
    status: "review",
    createdBy: "person",
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
  };
  tasks.all.push(legacy, personTask);

  assert.equal(ws.state.settings.tasksCreatorReviewExisting, false);
  assert.equal(legacy.reviewerBotId, undefined);
  assert.equal(taskNeedsPerson(legacy), true, "untouched by default");

  ws.setPreferences({ tasksCreatorReviewExisting: true });
  assert.equal(legacy.reviewerBotId, pip, "legacy bot-created review task handed to creator");
  assert.equal(taskNeedsPerson(legacy), false);
  assert.equal(personTask.reviewerBotId, undefined, "person-created review task stays with person");
  assert.equal(taskNeedsPerson(personTask), true);
});

test("routine-created tasks default to Later, and owner-approved routine opt-in allows Ready when assigned to a bot", async (t) => {
  const { ws, tasks, pip, scout } = setup(t);
  // Default routine (allowReadyTasks not set): tasks forced to Later.
  const defaultRoutineChatId = ws.panels.routines.create({
    botId: pip,
    name: "Default watcher",
    prompt: "Check PRs",
    cadence: { kind: "daily", time: "09:00" },
  });
  const active1 = { stopped: false };
  ws.active.set(defaultRoutineChatId, active1);
  const defaultTools = Object.fromEntries(tasks.tools(ws.bot(pip), ws.chat(defaultRoutineChatId), { id: "r-def", scheduleId: 1 }, active1).map((x) => [x.name, x]));
  const forcedLater = JSON.parse(await defaultTools.task_create.handler({ title: "Follow-up blocked", bot: ws.bot(scout).name, status: "ready" }));
  assert.equal(forcedLater.status, "later", "default routine forces Later");
  ws.active.delete(defaultRoutineChatId);

  // Owner-approved routine with allowReadyTasks: true -> ready works when assigned to a bot, still Later if unassigned.
  const optInRoutineChatId = ws.panels.routines.create({
    botId: pip,
    name: "PR watcher",
    prompt: "Watch PRs and dispatch fixes",
    cadence: { kind: "daily", time: "09:00" },
    allowReadyTasks: true,
  });
  const active2 = { stopped: false };
  ws.active.set(optInRoutineChatId, active2);
  const optInTools = Object.fromEntries(tasks.tools(ws.bot(pip), ws.chat(optInRoutineChatId), { id: "r-opt", scheduleId: 1 }, active2).map((x) => [x.name, x]));
  const readyAssigned = JSON.parse(await optInTools.task_create.handler({ title: "Fix PR #264 blocker", bot: ws.bot(scout).name, status: "ready" }));
  assert.equal(readyAssigned.status, "ready", "opted-in routine creates Ready task for a bot");
  const unassignedStillLater = JSON.parse(await optInTools.task_create.handler({ title: "Needs owner pickup", status: "ready" }));
  assert.equal(unassignedStillLater.status, "later", "unassigned task stays in Later");
  ws.active.delete(optInRoutineChatId);

  // Non-owner (team member) cannot enable allowReadyTasks on a routine.
  assert.throws(
    () => ws.panels.routines.create({ botId: pip, name: "Member routine", prompt: "Hi", cadence: { kind: "daily", time: "09:00" }, allowReadyTasks: true }, Date.now(), "member-1"),
    /Only the computer's owner/,
  );
});

test("creator review queues while creator chat is busy, wakes automatically once idle, runs once, and skips resolved or overridden tasks", async (t) => {
  let releaseBusyCreator;
  const busyCreatorTurn = new Promise((resolve) => {
    releaseBusyCreator = resolve;
  });
  const creatorPrompts = [];
  let activeCreatorReviewPrompt = null;

  const dir = mkdtempSync(join(tmpdir(), "botkins-tasks-busy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const makeSession = () => {
    const handlers = new Set();
    const session = {
      on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
      emit: (event) => handlers.forEach((handler) => handler(event)),
      disconnect: async () => {},
      abort: async () => {},
      send: async ({ prompt }) => {
        const messageId = "msg:" + Math.random().toString(36).slice(2, 8);
        if (prompt.includes("Hold creator busy")) {
          await busyCreatorTurn;
          session.emit({ type: "user.message", id: messageId, data: { messageId } });
          session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Creator finished busy turn." } });
          session.emit({ type: "session.idle", data: { mode: "interactive" } });
          return messageId;
        }
        if (prompt.includes("[Task ready for your review]")) {
          creatorPrompts.push(prompt);
          activeCreatorReviewPrompt = prompt;
          session.emit({ type: "user.message", id: messageId, data: { messageId } });
          session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Reviewed and verified." } });
          session.emit({ type: "session.idle", data: { mode: "interactive" } });
          return messageId;
        }
        session.emit({ type: "user.message", id: messageId, data: { messageId } });
        session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Worker finished: " + prompt.slice(0, 40) } });
        session.emit({ type: "session.idle", data: { mode: "interactive" } });
        return messageId;
      },
    };
    return session;
  };

  const ws = new Workspace(
    dir,
    async () => ({ createSession: async () => makeSession(), resumeSession: async () => makeSession() }),
    () => {},
  );
  const tasks = ws.tasks;
  const pip = ws.state.bots[0].id;
  const scout = ws.state.bots[1].id;

  const creatorChatId = ws.createChat(pip, "Orchestrator");
  const notified = [];
  ws.events.on("task.creatorNotified", (ev) => notified.push(ev));

  // Start an in-flight turn in the creator chat so it is busy.
  const busyPromise = ws.send(creatorChatId, "Hold creator busy");
  assert.equal(ws.active.has(creatorChatId), true, "creator chat is busy");

  // Creator bot creates two ready tasks assigned to worker Scout while busy.
  const active = ws.active.get(creatorChatId);
  const pipTools = Object.fromEntries(tasks.tools(ws.bot(pip), ws.chat(creatorChatId), { id: "r-busy" }, active).map((x) => [x.name, x]));
  const taskA = JSON.parse(await pipTools.task_create.handler({ title: "Deliver after busy", bot: ws.bot(scout).name, status: "ready" }));
  const taskB = JSON.parse(await pipTools.task_create.handler({ title: "Person overrides before idle", bot: ws.bot(scout).name, status: "ready" }));

  // Allow two concurrent tasks for Scout so both finish while creator is still busy.
  ws.setPreferences({ tasksPerBot: 2 });
  tasks.tick();
  await Promise.all([ws.locks.get(tasks.get(taskA.id).chatId), ws.locks.get(tasks.get(taskB.id).chatId)]);

  assert.equal(tasks.get(taskA.id).status, "review");
  assert.equal(tasks.get(taskA.id).reviewerBotId, pip);
  assert.equal(tasks.get(taskB.id).status, "review");
  assert.equal(tasks.get(taskB.id).reviewerBotId, pip);
  assert.equal(taskNeedsPerson(tasks.get(taskA.id)), false, "creator-review task is excluded from Needs you");
  assert.equal(creatorPrompts.length, 0, "review does not interrupt busy creator");
  assert.deepEqual(
    notified.map((e) => [e.task.id, e.mode]),
    [
      [taskA.id, "queued"],
      [taskB.id, "queued"],
    ],
    "both completions are queued durably while creator is busy",
  );
  assert.equal(ws.snapshot().queued[creatorChatId], undefined, "internal review items stay hidden from user queued bar");

  // Person overrides taskB to done before the creator chat becomes idle; taskB must be skipped.
  tasks.move(taskB.id, "done", { by: "person" });
  assert.equal(tasks.get(taskB.id).status, "done");

  // Let the creator chat finish its busy turn; queued review for taskA must wake automatically without user input.
  releaseBusyCreator();
  await busyPromise;
  // Drain is scheduled on setImmediate after executeTurn's finally block.
  for (let i = 0; i < 6 && creatorPrompts.length === 0; i++) {
    await new Promise((r) => setImmediate(r));
    await settle(ws);
  }
  await settle(ws);
  await new Promise((r) => setImmediate(r));
  await settle(ws);

  assert.equal(creatorPrompts.length, 1, "only taskA woke a review turn, exactly once");
  assert.match(activeCreatorReviewPrompt, new RegExp(taskA.id));
  assert.doesNotMatch(activeCreatorReviewPrompt, new RegExp(taskB.id));
  assert.equal(
    ws.state.runs.filter((r) => r.chatId === creatorChatId && r.taskReviewId === taskA.id).length,
    1,
    "taskA review run started once",
  );
  assert.equal(
    ws.state.runs.filter((r) => r.chatId === creatorChatId && r.taskReviewId === taskB.id).length,
    0,
    "overridden taskB never started a review run",
  );
  assert.equal(ws.queues.has(creatorChatId), false, "queue is empty after drain");
  assert.deepEqual(
    notified.filter((e) => e.mode === "turn").map((e) => e.task.id),
    [taskA.id],
    "creatorNotified turn event fired once for taskA only",
  );

  // Re-ticking / re-draining does not re-trigger the already-delivered review.
  tasks.tick();
  ws.drain(creatorChatId);
  await settle(ws);
  assert.equal(creatorPrompts.length, 1, "review does not repeat on subsequent ticks or drains");
});

test("stale queued creator review left in durable queue is skipped on drain when task was resolved or reassigned", async (t) => {
  const { ws, tasks, pip, scout } = setup(t);
  const creatorChatId = ws.createChat(pip, "Orchestrator");
  const id = tasks.save({ title: "Already done", botId: scout, status: "ready", createdBy: pip, createdChatId: creatorChatId });
  tasks.get(id).status = "review";
  tasks.get(id).reviewerBotId = pip;

  // Simulate a durable queued review surviving restart, followed by external/manual state override before drain.
  ws.queues.set(creatorChatId, [
    { id: "q-review-1", steer: false, notify: false, title: "Review · Already done", taskReviewId: id, text: "[Task ready for your review]", attachments: [] },
  ]);
  // Simulate override directly on task state (e.g. reassigned reviewer or moved to done) so drain's guard is exercised.
  tasks.get(id).status = "done";
  delete tasks.get(id).reviewerBotId;

  ws.drain(creatorChatId);
  await settle(ws);

  assert.equal(ws.queues.has(creatorChatId), false, "stale review item removed from queue");
  assert.equal(ws.state.runs.filter((r) => r.taskReviewId === id).length, 0, "no review turn started for resolved task");
});
