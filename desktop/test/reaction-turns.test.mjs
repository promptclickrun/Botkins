// A person's reaction gives the bot a quiet turn, and [SILENT] leaves nothing (desktop/reaction-turns.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Workspace } from "./starter.mjs";
import { decide } from "../desktop/notify.mjs";
import { mayBeSilent, mostUsed, PER_DAY, reactionPrompt } from "../desktop/reaction-turns.mjs";

/** A workspace whose bot streams `script.reply` in pieces, and every snapshot the apps were sent. */
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-reaction-turns-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = { reply: ["Hello", " there!"], prompts: [], handlers: new Set(), hold: null, tools: [], act: null };
  const session = {
    setTools: async (tools) => void (script.tools = tools),
    on: (handler) => (script.handlers.add(handler), () => script.handlers.delete(handler)),
    disconnect: async () => {},
    abort: async () => script.release?.(),
    send: async ({ prompt }) => {
      script.prompts.push(prompt);
      const id = "message:" + script.prompts.length;
      const emit = (event) => { for (const handler of script.handlers) handler(event); };
      emit({ type: "user.message", id, data: { messageId: id } });
      // A tool the bot calls before it answers, as the runtime would call it.
      if (script.act) await script.act((name, args) => script.tools.find((t) => t.name === name).handler(args, { toolCallId: "t1" }));
      for (const piece of script.reply) {
        emit({ type: "assistant.message_delta", data: { messageId: id, deltaContent: piece } });
        if (script.hold) await script.hold();
      }
      emit({ type: "assistant.message", data: { messageId: id, content: script.reply.join("") } });
      emit({ type: "session.idle", data: { mode: "interactive" } });
      return id;
    },
  };
  const opened = async (config) => ((script.tools = config?.tools?.definitions ?? script.tools), session);
  const client = async () => ({ createSession: opened, resumeSession: async (_id, config) => opened(config), deleteSession: async () => {} });
  const seen = [];
  let ws;
  ws = new Workspace(dir, client, () => ws && seen.push(ws.snapshot()), () => ({ kind: "reject" }));
  ws.reactionTurns.debounceMs = 5;
  return { ws, script, seen };
}

/** A chat where the bot has said hello, and the index of its message. */
async function greeted(ws) {
  const chat = ws.createChat("pip");
  await ws.send(chat, "Hi");
  const index = ws.chat(chat).messages.findIndex((m) => m.role === "assistant");
  assert.ok(index > 0);
  return { chat, index, time: ws.chat(chat).messages[index].time };
}

/** Waits for the reaction's turn to start and finish; returns its run, or undefined when none started. */
async function reactionRun(ws, chat) {
  for (let i = 0; i < 100 && !ws.state.runs.some((r) => r.reaction && r.chatId === chat); i++) await wait(5);
  await ws.active.get(chat)?.done;
  return ws.state.runs.find((r) => r.reaction && r.chatId === chat);
}

const shows = (snapshot, chat, runId) =>
  snapshot.runs.some((r) => r.id === runId) || chat in snapshot.streams || chat in snapshot.intents;

test("a reaction answered with [SILENT] leaves nothing: no message, typing, unread mark or notification", async (t) => {
  const { ws, script, seen } = setup(t);
  const { chat, index, time } = await greeted(ws);
  const before = ws.chat(chat).messages.length;
  ws.chat(chat).unread = false;
  script.reply = ["[SIL", "ENT", "]"];
  const from = seen.length;
  ws.reactToMessage(chat, index, time, "👍", "owner");
  const run = await reactionRun(ws, chat);
  assert.ok(run, "the reaction started a turn");
  assert.equal(run.status, "Completed", run.detail);
  assert.equal(run.silent, true);
  assert.equal(ws.chat(chat).messages.length, before, "no message, from the person or the bot");
  assert.equal(ws.chat(chat).unread, false);
  assert.ok(seen.length > from, "the apps were sent snapshots while it ran");
  for (const snapshot of seen.slice(from)) assert.equal(shows(snapshot, chat, run.id), false, "never shown working or streaming");
  assert.equal(decide({ type: "turn", bot: ws.bot("pip"), chat: ws.chat(chat), run }, { settings: ws.state.settings, focused: false }), null);
  // What the bot was told: the reaction, the message, and how to stay quiet.
  const prompt = script.prompts.at(-1);
  assert.match(prompt, /reacted 👍 to your latest message: “Hello there!”/);
  assert.match(prompt, /reply with exactly \[SILENT\] and nothing else/);
});

test("a reaction the bot answers is shown and kept as a reply", async (t) => {
  const { ws, script, seen } = setup(t);
  const { chat, index, time } = await greeted(ws);
  script.reply = ["Want me to", " go deeper on that?"];
  const from = seen.length;
  ws.reactToMessage(chat, index, time, "🤔", "owner");
  const run = await reactionRun(ws, chat);
  assert.equal(run.status, "Completed", run.detail);
  assert.equal(run.revealed, true);
  assert.equal(run.notify, undefined, "a real reply notifies as any reply does");
  const messages = ws.chat(chat).messages;
  assert.equal(messages.at(-1).role, "assistant");
  assert.equal(messages.at(-1).text, "Want me to go deeper on that?");
  assert.equal(messages.filter((m) => m.role === "user").length, 1, "the reaction's prompt is not a message");
  assert.ok(seen.slice(from).some((snapshot) => snapshot.runs.some((r) => r.id === run.id)), "the turn was shown once it replied");
  assert.ok(ws.chat(chat).unread);
});

test("a bot may answer a reaction with a reaction of its own, and nothing else shows", async (t) => {
  const { ws, script, seen } = setup(t);
  const { chat, index, time } = await greeted(ws);
  const before = ws.chat(chat).messages.length;
  script.act = (tool) => tool("react", { emoji: "❤️" });
  script.reply = ["[SILENT]"];
  const from = seen.length;
  ws.reactToMessage(chat, index, time, "❤️", "owner");
  const run = await reactionRun(ws, chat);
  assert.equal(run.status, "Completed", run.detail);
  assert.equal(ws.chat(chat).messages.length, before, "no new message");
  const person = ws.chat(chat).messages.findLast((m) => m.role === "user");
  assert.deepEqual(person.reactions, [{ actor: "bot:pip", emoji: "❤️" }], "the bot's ❤️ is on the person's latest message");
  for (const snapshot of seen.slice(from)) assert.equal(shows(snapshot, chat, run.id), false);
  assert.match(script.prompts.at(-1), /a reaction of your own \(react/);
  assert.doesNotMatch(script.prompts.at(-1), /don't react back/);
});

test("only a person's reaction to a bot's finished message, in a one-bot chat, starts a turn", async (t) => {
  const { ws } = setup(t);
  const { chat, index, time } = await greeted(ws);
  const user = ws.chat(chat).messages[0];
  ws.reactToMessage(chat, 0, user.time, "👍", "owner");
  ws.reactToMessage(chat, index, time, "👍", "bot:pip");
  assert.equal(await reactionRun(ws, chat), undefined);
  // A group chat's members answer messages, not reactions.
  const group = ws.createGroupChat?.(["pip", "scout"]);
  if (group) {
    ws.chat(group).messages.push({ role: "assistant", botId: "pip", text: "Hi all", time: Date.now() });
    ws.reactToMessage(group, ws.chat(group).messages.length - 1, ws.chat(group).messages.at(-1).time, "👍", "owner");
    assert.equal(await reactionRun(ws, group), undefined);
  }
});

test("reactions made together are one turn, and a message from the person replaces it", async (t) => {
  const { ws, script } = setup(t);
  const { chat, index, time } = await greeted(ws);
  const sent = script.prompts.length;
  script.reply = ["[SILENT]"];
  ws.reactToMessage(chat, index, time, "👍", "owner");
  ws.reactToMessage(chat, index, time, "❤️", "owner");
  await reactionRun(ws, chat);
  assert.equal(script.prompts.length, sent + 1, "one turn");
  assert.match(script.prompts.at(-1), /reacted ❤️/);
  assert.doesNotMatch(script.prompts.at(-1), /reacted 👍/, "the reaction they changed it from isn't told");

  // A reaction, then the person writes before its turn begins: only their message runs.
  ws.reactionTurns.debounceMs = 200;
  ws.reactToMessage(chat, index, time, "🎉", "owner");
  script.reply = ["Sure."];
  await ws.send(chat, "Also, one more thing");
  await wait(250);
  assert.equal(ws.state.runs.filter((r) => r.reaction).length, 1, "no second reaction turn");
});

test("the person's message during a reaction's hidden turn ends that turn and goes next", async (t) => {
  const { ws, script } = setup(t);
  const { chat, index, time } = await greeted(ws);
  let release;
  script.hold = () => new Promise((resolve) => (release = resolve));
  script.release = () => release?.();
  script.reply = ["[SIL", "ENT]"];
  ws.reactToMessage(chat, index, time, "👍", "owner");
  for (let i = 0; i < 100 && !release; i++) await wait(5);
  assert.ok(release, "the reaction's turn is streaming");
  script.hold = null;
  script.reply = ["Here you go."];
  assert.equal(ws.submit(chat, "What about tomorrow?"), null, "queued behind the hidden turn");
  release();
  for (let i = 0; i < 200 && ws.chat(chat).messages.at(-1)?.text !== "Here you go."; i++) await wait(5);
  const run = ws.state.runs.find((r) => r.reaction);
  assert.equal(run.status, "Stopped");
  assert.equal(ws.chat(chat).messages.at(-1).text, "Here you go.");
  assert.ok(!ws.chat(chat).messages.some((m) => /SIL/.test(m.text ?? "")));
});

test("a plan near its limits spends no turn on a reaction, and the bot is told how much is used", async (t) => {
  const { ws, script } = setup(t);
  const { chat, index, time } = await greeted(ws);
  let used = 95;
  ws.reactionTurns.usage = async () => ({ limits: [{ label: "monthly premium requests", percentUsed: used }, { label: "chat", unlimited: true }] });
  ws.reactToMessage(chat, index, time, "👍", "owner");
  await wait(40);
  assert.equal(await reactionRun(ws, chat), undefined, "no turn at 95% used");

  used = 62;
  script.reply = ["[SILENT]"];
  ws.reactToMessage(chat, index, time, "🙏", "owner");
  assert.ok(await reactionRun(ws, chat));
  assert.match(script.prompts.at(-1), /has used 62% of its monthly premium requests/);
});

test("a bot gets at most its daily number of reaction turns", async (t) => {
  const { ws } = setup(t);
  const { chat, index, time } = await greeted(ws);
  ws.reactionTurns.counts.set("pip", { day: new Date().toDateString(), n: PER_DAY });
  ws.reactToMessage(chat, index, time, "👍", "owner");
  await wait(40);
  assert.equal(await reactionRun(ws, chat), undefined);
});

test("bots are told about reactions and about confirming a routine's notifications", async (t) => {
  const { ws } = setup(t);
  const chat = ws.chat(ws.createChat("pip"));
  const text = ws.instructionsFor(chat, ws.bot("pip"), { id: "r" });
  assert.match(text, /react to your messages with an emoji/);
  // The bot judges a reaction by what it means in the conversation: no emoji is named as one to answer or not.
  const guidance = text.match(/\nThe person can react[^\n]*/)[0];
  assert.doesNotMatch(guidance, /\p{Extended_Pictographic}/u);
  const told = reactionPrompt([{ emoji: "👍", text: "Done.", latest: true }]).split("\n").filter((line) => !line.startsWith("- "));
  for (const line of told) assert.doesNotMatch(line, /\p{Extended_Pictographic}/u, line);
  assert.match(text, /\[SILENT\]/);
  assert.match(text, /Before you create a routine .* confirm with the person how often it runs, where its result goes, and whether they want a notification/);
});

test("streamed text is held back only while it can still be [SILENT]", () => {
  for (const text of ["", "  ", "[", "[SIL", " [SILENT", "[SILENT]", "[SILENT]\n"]) assert.equal(mayBeSilent(text), true, JSON.stringify(text));
  for (const text of ["Hi", "[S]", "[SILENT] but", "Sure [SILENT]"]) assert.equal(mayBeSilent(text), false, JSON.stringify(text));
  assert.deepEqual(mostUsed({ limits: [{ label: "a", percentRemaining: 30 }, { label: "b", percentUsed: 20 }, { label: "c", unlimited: true, percentUsed: 100 }] }), { percent: 70, label: "a" });
  assert.equal(mostUsed({ limits: [] }), null);
  assert.match(reactionPrompt([{ emoji: "👍", text: "x".repeat(900), latest: false }]), /an earlier message of yours: “x{599}…”/);
});
