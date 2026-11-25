import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { ROUTINE_DELIVERY, deliveryField, notifyField } from "../desktop/routines.mjs";
import { decide } from "../desktop/notify.mjs";

const NY = "America/New_York";
const T0 = Date.UTC(2026, 10, 17, 12);
const DAILY = { kind: "daily", time: "09:00" };

// A workspace whose fake model answers with `script.reply`, and records every prompt it was sent.
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-delivery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = { reply: "Time to review your inbox.\nStart with anything from today.", prompts: [], hook: null };
  const handlers = new Set();
  const session = {
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    emit: (event) => handlers.forEach((handler) => handler(event)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      script.prompts.push(prompt);
      const messageId = "message:" + script.prompts.length;
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      await script.hook?.();
      if (script.reply instanceof Error) throw script.reply;
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: script.reply } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };
  const client = async () => ({
    createSession: async () => session,
    resumeSession: async () => session,
    deleteSession: async () => {},
  });
  const ws = new Workspace(dir, client, () => {}, () => ({ kind: "reject" }));
  return { ws, r: ws.panels.routines, script };
}
const make = (r, deliver, extra = {}) =>
  r.create({ botId: "pip", name: "Inbox", prompt: "Remind me to review my inbox.", cadence: DAILY, timezone: NY, ...(deliver !== undefined && { deliver }), ...extra }, T0);
const entryOf = (ws, id) => ws.chat(id).schedules[0];
const lastRun = (ws) => ws.state.runs[0];

test("the delivery version is exported", () => {
  assert.equal(ROUTINE_DELIVERY, "routine-delivery-v1");
});

test("each destination is saved and read back, and the default writes nothing", (t) => {
  const { ws, r } = setup(t);
  const plain = make(r);
  assert.equal("deliver" in entryOf(ws, plain), false, "no deliver means the routine chat");
  assert.equal("deliver" in r.view(ws.chat(plain), entryOf(ws, plain)), false);
  const explicit = make(r, { to: "routine" });
  assert.equal("deliver" in entryOf(ws, explicit), false, "the default is never written");

  const main = make(r, { to: "chat" });
  assert.deepEqual(entryOf(ws, main).deliver, { to: "chat" });
  assert.deepEqual(r.view(ws.chat(main), entryOf(ws, main)).deliver, { to: "chat" });
  const mine = ws.createChat("pip");
  const picked = make(r, { to: "chat", chatId: mine });
  assert.deepEqual(entryOf(ws, picked).deliver, { to: "chat", chatId: mine });
  assert.deepEqual(entryOf(ws, make(r, { to: "feed" })).deliver, { to: "feed" });
  assert.deepEqual(entryOf(ws, make(r, { to: "idea" })).deliver, { to: "idea" });
  assert.deepEqual(entryOf(ws, make(r, { to: "goal" })).deliver, { to: "goal" });
  assert.deepEqual(entryOf(ws, make(r, { to: "goal", category: "health" })).deliver, { to: "goal", category: "health" });

  // Editing changes the destination, and the default removes it again.
  r.update(main, { deliver: { to: "feed" } }, T0);
  assert.deepEqual(entryOf(ws, main).deliver, { to: "feed" });
  r.update(main, { name: "Inbox sweep" }, T0);
  assert.deepEqual(entryOf(ws, main).deliver, { to: "feed" }, "an edit that leaves it out keeps it");
  r.update(main, { deliver: { to: "routine" } }, T0);
  assert.equal("deliver" in entryOf(ws, main), false);
  r.update(picked, { deliver: null }, T0);
  assert.equal("deliver" in entryOf(ws, picked), false, "null clears it");

  // Duplicating keeps the destination; a chat of another bot is dropped for the new bot's latest chat.
  const copy = r.duplicate(make(r, { to: "goal", category: "career" }), "pip", T0);
  assert.deepEqual(entryOf(ws, copy).deliver, { to: "goal", category: "career" });
  const same = r.duplicate(picked, "pip", T0);
  assert.equal("deliver" in entryOf(ws, same), false);
  const withChat = make(r, { to: "chat", chatId: mine });
  assert.deepEqual(entryOf(ws, r.duplicate(withChat, "pip", T0)).deliver, { to: "chat", chatId: mine });
  assert.deepEqual(entryOf(ws, r.duplicate(withChat, "scout", T0)).deliver, { to: "chat" });
});

test("a destination that makes no sense is refused with a sentence", (t) => {
  const { ws, r } = setup(t);
  const bad = (deliver, pattern) => assert.throws(() => deliveryField(deliver, ws, "pip"), pattern);
  bad("feed", /Choose where/);
  bad([], /Choose where/);
  bad({}, /Send the result to/);
  bad({ to: "email" }, /Send the result to/);
  bad({ to: "feed", extra: 1 }, /Unknown delivery setting: extra/);
  bad({ to: "feed", chatId: "x" }, /can only be chosen when the result goes to a chat/);
  bad({ to: "routine", chatId: "x" }, /can only be chosen when the result goes to a chat/);
  bad({ to: "idea", category: "health" }, /only applies when the result goes to a goal/);
  bad({ to: "chat", category: "health" }, /only applies when the result goes to a goal/);
  bad({ to: "goal", category: "fun" }, /goal categories/);
  bad({ to: "chat", chatId: "" }, /Choose a chat/);
  bad({ to: "chat", chatId: 7 }, /Choose a chat/);
  bad({ to: "chat", chatId: "nope" }, /no longer exists/);

  const own = ws.createChat("scout");
  bad({ to: "chat", chatId: own }, /with this bot/);
  const routine = make(r);
  bad({ to: "chat", chatId: routine }, /routine's chat/);
  const group = ws.createGroupChat(["pip", "scout"], "Pair");
  bad({ to: "chat", chatId: group }, /Group chats/);
  ws.chat(ws.createChat("pip")).temporary = true;
  const temp = ws.state.chats.find((c) => c.temporary).id;
  bad({ to: "chat", chatId: temp }, /temporary/);
  const archived = ws.createChat("pip");
  ws.chat(archived).archived = true;
  bad({ to: "chat", chatId: archived }, /archived/);

  // Saving refuses the same, and leaves nothing behind.
  const before = ws.state.chats.length;
  assert.throws(() => make(r, { to: "chat", chatId: own }), /with this bot/);
  assert.equal(ws.state.chats.length, before, "a refused routine makes no chat");
  assert.throws(() => r.update(routine, { deliver: { to: "feed", chatId: own } }, T0), /can only be chosen/);
  assert.equal("deliver" in entryOf(ws, routine), false);
});

test("a finished run posts its reply to the bot's latest chat as an unread message", async (t) => {
  const { ws, r, script } = setup(t);
  const older = ws.createChat("pip");
  const newer = ws.createChat("pip");
  ws.chat(older).time = 1;
  ws.chat(newer).time = 2;
  const id = make(r, { to: "chat" });
  await r.run(id);
  assert.equal(lastRun(ws).status, "Completed");
  assert.equal(lastRun(ws).detail, "");
  const posted = ws.chat(newer);
  assert.equal(posted.messages.length, 1);
  assert.equal(posted.messages[0].role, "assistant");
  assert.equal(posted.messages[0].text, script.reply, "the reply itself, not a quoted report");
  assert.equal(posted.unread, true);
  assert.equal(ws.chat(older).messages.length, 0);
  assert.ok(posted.time > 2, "the chat moves to the top");
  assert.equal(ws.chat(id).messages.at(-1).text, script.reply, "the routine chat keeps its own copy");
  assert.deepEqual(lastRun(ws).delivery, { to: "chat", chatId: newer });
  // The notification opens the chat the reply landed in.
  const bot = ws.bot("pip");
  const note = decide({ type: "turn", chat: ws.chat(id), run: lastRun(ws), bot }, { settings: ws.state.settings, focused: false, now: new Date(Date.UTC(2026, 0, 1, 15)), timeZone: "UTC" });
  assert.equal(note.chatId, newer);
});

test("a chosen chat gets the reply, and a bot with no chat gets one", async (t) => {
  const { ws, r } = setup(t);
  const chosen = ws.createChat("pip");
  const newest = ws.createChat("pip");
  ws.chat(newest).time = Date.now() + 1000;
  await r.run(make(r, { to: "chat", chatId: chosen }));
  assert.equal(ws.chat(chosen).messages.length, 1);
  assert.equal(ws.chat(newest).messages.length, 0);

  // Routine chats, groups and panel chats are not the main chat.
  const none = new Set(ws.state.chats.filter((c) => c.botId === "scout").map((c) => c.id));
  assert.deepEqual([...none], [ws.mainChat("scout")]);
  ws.createGroupChat(["scout", "patch"], "Pair");
  const id = r.create({ botId: "scout", name: "Digest", prompt: "Summarize.", cadence: DAILY, timezone: NY, deliver: { to: "chat" } }, T0);
  await r.run(id);
  const made = ws.state.chats.filter((c) => c.botId === "scout" && c.id !== id && !c.botIds && !none.has(c.id));
  assert.equal(made.length, 1, "one chat was made for the bot");
  assert.equal(made[0].title, "Digest");
  assert.equal(made[0].messages.length, 1);
  assert.equal(made[0].unread, true);
  await r.run(id);
  assert.equal(made[0].messages.length, 2, "the next run uses that chat");
});

test("a finished run posts to the feed, ideas and goals with the routine as its source", async (t) => {
  const { ws, r, script } = setup(t);
  await r.run(make(r, { to: "feed" }));
  const [feed] = ws.board.items;
  assert.deepEqual([feed.kind, feed.botId, feed.title, feed.source, feed.read, feed.status], ["feed", "pip", "Time to review your inbox.", "Inbox", false, "open"]);
  assert.equal(feed.body, "Start with anything from today.");
  assert.equal(lastRun(ws).detail, "");
  assert.deepEqual(lastRun(ws).delivery, { to: "feed", itemId: feed.id });

  await r.run(make(r, { to: "idea" }));
  assert.equal(ws.board.items[0].kind, "idea");

  await r.run(make(r, { to: "goal" }));
  assert.deepEqual([ws.board.items[0].kind, ws.board.items[0].category], ["goal", "other"]);
  await r.run(make(r, { to: "goal", category: "health" }));
  assert.equal(ws.board.items[0].category, "health");

  // A long first line becomes the title in full body text; a one-line reply has no body.
  script.reply = "x".repeat(300);
  await r.run(make(r, { to: "feed" }));
  assert.equal(ws.board.items[0].title.length, 120);
  assert.equal(ws.board.items[0].body, "x".repeat(300));
  script.reply = "# Just a title";
  await r.run(make(r, { to: "feed" }));
  assert.deepEqual([ws.board.items[0].title, ws.board.items[0].body], ["Just a title", ""]);
});

test("the default destination posts nothing outside the routine chat", async (t) => {
  const { ws, r } = setup(t);
  const spare = ws.createChat("pip");
  await r.run(make(r));
  assert.equal(ws.chat(spare).messages.length, 0);
  assert.equal(ws.board.items.length, 0);
  assert.equal("delivery" in lastRun(ws), false);
});

test("a failed, stopped or empty run posts nothing", async (t) => {
  const { ws, r, script } = setup(t);
  const spare = ws.createChat("pip");
  const chat = make(r, { to: "chat" });
  const feed = make(r, { to: "feed" });
  script.reply = new Error("The model is down.");
  await r.run(chat);
  assert.equal(lastRun(ws).status, "Needs you");
  await r.run(feed);
  script.reply = "";
  await r.run(chat);
  assert.equal(lastRun(ws).status, "Completed", "a routine may finish successfully without a reply");
  assert.equal(lastRun(ws).noOutput, true);
  assert.equal(ws.chat(spare).messages.length, 0, "an empty destination result is not posted");
  assert.equal(decide({ type: "turn", chat: ws.chat(chat), run: lastRun(ws), bot: ws.bot("pip") }, { settings: ws.state.settings, focused: false }), null);
  script.reply = "   \n ";
  await r.run(feed);
  assert.equal(ws.chat(spare).messages.length, 0);
  assert.equal(ws.board.items.length, 0);

  // A stopped run posts nothing either.
  script.reply = "Done.";
  script.hook = () => ws.stop(chat);
  await r.run(chat);
  assert.equal(lastRun(ws).status, "Stopped");
  assert.equal(ws.chat(spare).messages.length, 0);
});

test("a delivery that fails is recorded on the run and does not fail it", async (t) => {
  const { ws, r } = setup(t);
  const target = ws.createChat("pip");
  const id = make(r, { to: "chat", chatId: target });
  await ws.agents.deleteChat(target);
  await r.run(id);
  const run = lastRun(ws);
  assert.equal(run.status, "Completed");
  assert.match(run.detail, /Not delivered: .*no longer exists/);
  assert.equal("delivery" in run, false);
  assert.equal(ws.chat(id).messages.at(-1).role, "assistant", "the routine chat still has the reply");

  // A chat that became a group chat or was archived is refused the same way.
  const other = ws.createChat("pip");
  const second = make(r, { to: "chat", chatId: other });
  ws.chat(other).archived = true;
  await r.run(second);
  assert.match(lastRun(ws).detail, /Not delivered: .*archived/);
  assert.equal(lastRun(ws).status, "Completed");

  // A board that refuses the post is recorded too.
  const feed = make(r, { to: "feed" });
  ws.board.post = () => {
    throw new Error("The board is full.");
  };
  await r.run(feed);
  assert.equal(lastRun(ws).status, "Completed");
  assert.match(lastRun(ws).detail, /Not delivered: The board is full/);
});

test("the bot's turn says where its reply goes", async (t) => {
  const { ws, r, script } = setup(t);
  const run = async (deliver) => {
    script.prompts.length = 0;
    await r.run(make(r, deliver));
    return script.prompts[0];
  };
  assert.equal(await run(undefined), "Remind me to review my inbox.", "no line for the default");
  assert.equal(await run({ to: "routine" }), "Remind me to review my inbox.");
  assert.match(await run({ to: "chat" }), /^Remind me to review my inbox\.\n\nYour reply will be sent to the person as a message in your chat with them\./);
  assert.match(await run({ to: "feed" }), /Your reply will be posted to the person's Feed\./);
  assert.match(await run({ to: "idea" }), /Your reply will be posted to the person's Ideas\./);
  assert.match(await run({ to: "goal" }), /Your reply will be posted to the person's Goals\./);
  assert.match(await run({ to: "feed" }), /Begin with a one-line title/);
  // A retried run keeps the line.
  const id = make(r, { to: "feed" });
  await r.run(id);
  script.prompts.length = 0;
  await ws.retry(lastRun(ws).id);
  await ws.active.get(id)?.done;
  assert.match(script.prompts[0], /posted to the person's Feed/);
});

function activeTurn(ws, chatId) {
  const task = { stopped: false };
  ws.active.set(chatId, task);
  return { task, run: { id: "run-" + chatId, chatId } };
}

test("routine_create and routine_update take a destination", async (t) => {
  const { ws, r } = setup(t);
  const chatId = ws.createChat("pip");
  const { task, run } = activeTurn(ws, chatId);
  const tools = Object.fromEntries(r.tools(ws.bot("pip"), ws.chat(chatId), run, task).map((tool) => [tool.name, tool]));
  for (const name of ["routine_create", "routine_update"]) {
    const deliver = tools[name].parameters.properties.deliver;
    assert.deepEqual(deliver.properties.to.enum, ["none", "routine", "chat", "feed", "idea", "goal"]);
    assert.match(tools[name].description, /deliver/);
  }
  assert.match(tools.routine_create.parameters.properties.deliver.description, /remind/i);
  const created = JSON.parse(
    await tools.routine_create.handler({ name: "Inbox", instructions: "Remind the person to review their inbox.", cadence: "daily", time: "09:00", timezone: NY, deliver: { to: "chat" } }),
  );
  // "Remind me here": asked in a chat, a result for "chat" goes to that chat.
  assert.deepEqual(created.deliver, { to: "chat", chatId });
  assert.deepEqual(entryOf(ws, created.id).deliver, { to: "chat", chatId });
  const moved = JSON.parse(await tools.routine_update.handler({ id: created.id, deliver: { to: "goal", category: "career" } }));
  assert.deepEqual(moved.deliver, { to: "goal", category: "career" });
  const reset = JSON.parse(await tools.routine_update.handler({ id: created.id, deliver: { to: "routine" } }));
  assert.equal("deliver" in reset, false);
  await assert.rejects(async () => tools.routine_create.handler({ name: "Bad", instructions: "Hi.", cadence: "daily", time: "09:00", deliver: { to: "pager" } }), /Send the result to/);
  const plain = JSON.parse(await tools.routine_create.handler({ name: "Plain", instructions: "Hi.", cadence: "daily", time: "09:00" }));
  assert.equal("deliver" in plain, false);
  ws.active.delete(chatId);
});

test("a bot that is asked in a chat that can't take a result leaves the chat to be chosen later", async (t) => {
  const { ws, r } = setup(t);
  // A routine's own chat can't receive another routine's result.
  const routineChat = make(r);
  const { task, run } = activeTurn(ws, routineChat);
  const tools = Object.fromEntries(r.tools(ws.bot("pip"), ws.chat(routineChat), run, task).map((tool) => [tool.name, tool]));
  const created = JSON.parse(await tools.routine_create.handler({ name: "Ping", instructions: "Say hello.", cadence: "daily", time: "09:00", deliver: { to: "chat" } }));
  assert.deepEqual(created.deliver, { to: "chat" }, "the bot's latest chat with the person, found when the run finishes");
  const other = ws.createChat("pip");
  const named = JSON.parse(await tools.routine_update.handler({ id: created.id, deliver: { to: "chat", chatId: other } }));
  assert.deepEqual(named.deliver, { to: "chat", chatId: other }, "a chat the bot names is kept as named");
  ws.active.delete(routineChat);
});

test("the chat that receives a result is told of it at its next turn, once", async (t) => {
  const { ws, r, script } = setup(t);
  const mine = ws.createChat("pip");
  const id = make(r, { to: "chat", chatId: mine });
  await r.run(id);
  const posted = ws.chat(mine).messages.at(-1);
  assert.equal(posted.text, script.reply);
  assert.ok(posted.time > 0, "the message says when it came");
  script.prompts.length = 0;
  await ws.send(mine, "Thanks. Push it to ten tomorrow.");
  // The session behind this chat never saw the routine's message: the bot is told with the person's answer.
  assert.match(script.prompts[0], /^Thanks\. Push it to ten tomorrow\./);
  assert.ok(script.prompts[0].includes("your routine “Inbox” sent the person this message here, as you:]\n" + script.reply));
  assert.equal("posted" in ws.chat(mine), false);
  await ws.send(mine, "And the day after?");
  assert.ok(!script.prompts[1].includes("your routine"), "only once");
});

test("several results posted before the person answers are all told, the newest five at most", async (t) => {
  const { ws, r, script } = setup(t);
  const mine = ws.createChat("pip");
  const id = make(r, { to: "chat", chatId: mine });
  for (let i = 1; i <= 6; i++) {
    script.reply = "Reminder " + i;
    await r.run(id);
  }
  assert.equal(ws.chat(mine).messages.length, 6, "every message is in the chat");
  script.prompts.length = 0;
  script.reply = "ok";
  await ws.send(mine, "Got them.");
  assert.ok(!script.prompts[0].includes("Reminder 1\n") && !/Reminder 1$/.test(script.prompts[0]), "the oldest is left out of the note");
  for (let i = 2; i <= 6; i++) assert.ok(script.prompts[0].includes("Reminder " + i), "Reminder " + i);
});

test("a routine notifies unless it is told to run quietly, and only quiet is saved", (t) => {
  const { ws, r } = setup(t);
  assert.equal(notifyField(undefined), undefined);
  assert.equal(notifyField(null), undefined);
  assert.equal(notifyField(false), false);
  assert.equal(notifyField(true), true);
  for (const bad of ["no", 0, {}, []]) assert.throws(() => notifyField(bad), /Choose whether this routine notifies/);

  const usual = make(r);
  assert.equal("notify" in entryOf(ws, usual), false);
  assert.equal("notify" in r.view(ws.chat(usual), entryOf(ws, usual)), false);
  assert.equal("notify" in entryOf(ws, make(r, undefined, { notify: true })), false, "notifying is the usual way and is never written");
  const quiet = make(r, { to: "feed" }, { notify: false });
  assert.equal(entryOf(ws, quiet).notify, false);
  assert.equal(r.view(ws.chat(quiet), entryOf(ws, quiet)).notify, false);
  assert.throws(() => make(r, undefined, { notify: "false" }), /Choose whether this routine notifies/);

  // An edit that leaves it out keeps it; one that sets it changes it, without touching the schedule.
  const next = entryOf(ws, quiet).nextAt;
  r.update(quiet, { name: "Quiet inbox" }, T0);
  assert.equal(entryOf(ws, quiet).notify, false);
  r.update(quiet, { notify: true }, T0 + 60_000);
  assert.equal("notify" in entryOf(ws, quiet), false);
  assert.equal(entryOf(ws, quiet).nextAt, next);
  assert.deepEqual(entryOf(ws, quiet).deliver, { to: "feed" }, "and the destination stays");
  r.update(quiet, { notify: false }, T0);
  assert.equal(entryOf(ws, quiet).notify, false);
  // A copy runs as quietly as the routine it was made from.
  assert.equal(entryOf(ws, r.duplicate(quiet, "pip", T0)).notify, false);
  assert.equal("notify" in entryOf(ws, r.duplicate(usual, "pip", T0)), false);
});

test("a quiet routine's run sends no notification on the computer, whether it worked or failed", async (t) => {
  const { ws, r, script } = setup(t);
  const bot = ws.bot("pip");
  const when = { settings: ws.state.settings, focused: false, now: new Date(Date.UTC(2026, 0, 1, 15)), timeZone: "UTC" };
  const loud = make(r);
  await r.run(loud);
  assert.ok(decide({ type: "turn", chat: ws.chat(loud), run: lastRun(ws), bot }, when), "a routine that notifies still does");
  const quiet = make(r, undefined, { notify: false });
  await r.run(quiet);
  assert.equal(lastRun(ws).status, "Completed");
  assert.equal(decide({ type: "turn", chat: ws.chat(quiet), run: lastRun(ws), bot }, when), null);
  script.reply = new Error("The model is unavailable.");
  await r.run(quiet).catch(() => {});
  assert.notEqual(lastRun(ws).status, "Completed");
  assert.equal(decide({ type: "turn", chat: ws.chat(quiet), run: lastRun(ws), bot }, when), null, "a failed quiet run is quiet too");
});

test("routine_create and routine_update take notify", async (t) => {
  const { ws, r } = setup(t);
  const chatId = ws.createChat("pip");
  const { task, run } = activeTurn(ws, chatId);
  const tools = Object.fromEntries(r.tools(ws.bot("pip"), ws.chat(chatId), run, task).map((tool) => [tool.name, tool]));
  for (const name of ["routine_create", "routine_update"]) assert.equal(tools[name].parameters.properties.notify.type, "boolean", name);
  const created = JSON.parse(await tools.routine_create.handler({ name: "Sweep", instructions: "Tidy the notes.", cadence: "daily", time: "03:00", notify: false }));
  assert.equal(created.notify, false);
  assert.equal(entryOf(ws, created.id).notify, false);
  const loud = JSON.parse(await tools.routine_update.handler({ id: created.id, notify: true }));
  assert.equal("notify" in loud, false);
  const usual = JSON.parse(await tools.routine_create.handler({ name: "Brief", instructions: "Write the brief.", cadence: "daily", time: "07:00" }));
  assert.equal("notify" in usual, false);
  ws.active.delete(chatId);
});
