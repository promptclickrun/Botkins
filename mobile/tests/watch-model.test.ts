import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

// Metro resolves the avatar assets on device. Node only needs their names.
const load = createRequire(__filename);
load.extensions[".webp"] = (module, file) => { module.exports = file; };
const { encodeWatchSnapshot, parseWatchCommand, WATCH_MESSAGE_LIMIT, WATCH_SNAPSHOT_BYTES, WATCH_TEXT_LIMIT, watchSnapshotOf } =
  load("../src/features/watch/model") as typeof import("../src/features/watch/model");

const bot = { id: "bot-primary", name: "Koda", role: "Research assistant", instructions: "", face: "searching", look: { head: "sprig", palette: "original" } };
const otherBot = { ...bot, id: "bot-other", name: "Other", hidden: true };
const chat = { id: "chat-latest", botId: bot.id, title: "Secure input retry", time: 20, count: 3 };
const older = { ...chat, id: "chat-old", title: "Older", time: 10 };

function state() {
  return {
    pairing: { serverId: "host-1", name: "Studio Mac", serverKey: "", secretKey: "", deviceId: "phone-1", hosts: [] },
    link: "online" as const,
    parts: {
      bots: [otherBot, bot],
      chats: [older, chat],
      live: { requests: [], active: [], streams: {}, thinking: {}, intents: {}, speakers: {}, queued: {} },
    },
    chats: {
      [chat.id]: {
        from: 0,
        total: 3,
        messages: [
          { role: "user" as const, text: "Fix it", time: 1 },
          { role: "assistant" as const, text: "I found the retry branch.", time: 2 },
          { role: "command" as const, text: "/hidden" },
        ],
        runs: {},
      },
    },
    texts: {},
  } as any;
}

test("Watch sees the first visible Botkin, its latest one-to-one chat and a bounded transcript", () => {
  const snapshot = watchSnapshotOf({ state: state(), revision: 4 });
  assert.equal(snapshot.bot?.id, bot.id);
  assert.equal(snapshot.computer?.id, "host-1");
  assert.equal(snapshot.chat?.id, chat.id);
  assert.deepEqual(snapshot.chat?.messages.map((message) => message.who), ["you", "bot"]);
  assert.equal(snapshot.chat?.messages.at(-1)?.text, "I found the retry branch.");
  assert.equal(snapshot.revision, 4);
  assert.equal(snapshot.protocol, 1);
  assert.equal(watchSnapshotOf({ state: state(), revision: 5, chatId: older.id }).chat?.id, older.id);
});

test("Watch transcript clips text, drops excess entries and follows the current stream", () => {
  const input = state();
  input.chats[chat.id].messages = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: "x".repeat(WATCH_TEXT_LIMIT + 20),
    time: index,
  }));
  input.texts[chat.id] = { stream: "The fallback is now isolated.", thinking: "" };
  const snapshot = watchSnapshotOf({ state: input, revision: 5 });
  assert.ok(snapshot.chat);
  assert.ok(snapshot.chat.messages.length <= WATCH_MESSAGE_LIMIT);
  assert.ok(snapshot.chat.messages.every((message) => message.text.length <= WATCH_TEXT_LIMIT));
  assert.equal(snapshot.chat.messages.at(-1)?.text, "The fallback is now isolated.");
  assert.equal(snapshot.chat.messages.at(-1)?.final, false);
});

test("an encoded Watch snapshot remains inside application-context size and parses controls", () => {
  const input = watchSnapshotOf({ state: state(), revision: 8, voice: { status: "talking", sessionId: "voice-1", level: 0.3 } });
  const encoded = encodeWatchSnapshot(input);
  const bytes = Buffer.byteLength(encoded, "utf8");
  assert.ok(bytes <= WATCH_SNAPSHOT_BYTES);
  assert.deepEqual(parseWatchCommand({ command: "mute", value: true }), { command: "mute", value: true });
  assert.deepEqual(parseWatchCommand({ command: "openOnPhone", chatId: "chat-1" }), { command: "openOnPhone", chatId: "chat-1" });
  assert.deepEqual(parseWatchCommand({ command: "endVoice", value: 4 }), { command: "endVoice" });
  assert.equal(parseWatchCommand({ command: "mute", value: "yes" }), null);
  assert.equal(parseWatchCommand({ command: "unknown" }), null);
});
