// What selecting a bot opens, and when a chat left without a message is archived
// (src/features/chat/habits.ts; the desktop app follows the same rules).
import assert from "node:assert/strict";
import { test } from "node:test";
import { archivesWhenLeft, botTapOf, BOT_TAPS, chatForTap } from "../src/features/chat/habits";
import type { ChatSummary } from "../src/link/types";

const chat = (id: string, more: Partial<ChatSummary> = {}): ChatSummary => ({ id, botId: "mira", title: id, time: 1, count: 2, ...more });

test("selecting a bot opens its latest chat, or a new one each time", () => {
  assert.deepEqual(BOT_TAPS.map((choice) => choice.label), ["Open the latest chat", "Start a new chat"]);
  assert.equal(botTapOf("new"), "new");
  assert.equal(botTapOf("latest"), "latest");
  assert.equal(botTapOf(undefined), "latest");
  assert.equal(botTapOf("often"), "latest");
  const chats = [
    chat("old", { time: 10 }),
    chat("newest", { time: 30 }),
    chat("group", { time: 99, botIds: ["mira", "patch"] }),
    chat("archived", { time: 98, archived: true }),
    chat("panel", { time: 97, panelId: "p1" }),
    chat("routine", { time: 96, schedules: [{ id: "s", routine: true } as never] }),
    chat("other", { time: 95, botId: "patch" }),
  ];
  assert.deepEqual(chatForTap(chats, "mira", "latest"), { id: "newest" });
  assert.equal(chatForTap(chats, "tally", "latest"), null, "none yet: one is made");
  // A new chat each time...
  assert.equal(chatForTap(chats, "mira", "new"), null);
  // ...unless the bot already has one nobody wrote in.
  assert.deepEqual(chatForTap([...chats, chat("empty", { time: 5, count: 0 })], "mira", "new"), { id: "empty" });
  // One that was archived when it was left is used again, and comes out of the archive.
  assert.deepEqual(chatForTap([...chats, chat("left", { time: 5, count: 0, archived: true })], "mira", "new"), { id: "left", archived: true });
  assert.deepEqual(chatForTap([...chats, chat("left", { time: 9, count: 0, archived: true }), chat("open", { time: 5, count: 0 })], "mira", "new"), { id: "open" });
  // Never one that was started in a project.
  assert.equal(chatForTap([...chats, chat("in-project", { time: 5, count: 0, projectId: "p1" })], "mira", "new"), null);
  // Not another bot's, and "latest" never opens an archived chat.
  assert.equal(chatForTap([...chats, chat("empty", { time: 5, count: 0, botId: "patch" })], "mira", "new"), null);
  assert.deepEqual(chatForTap([chat("gone", { archived: true, time: 99 }), chat("kept", { time: 1 })], "mira", "latest"), { id: "kept" });
});

test("a chat left with no message is archived, unless something keeps it", () => {
  const quiet = { messages: 0, working: false, waiting: 0, draft: "" };
  const empty = chat("c", { count: 0 });
  assert.equal(archivesWhenLeft(empty, quiet), true);
  // A group chat and a chat in a project follow the same rule.
  assert.equal(archivesWhenLeft(chat("g", { count: 0, botIds: ["mira", "patch"] }), quiet), true);
  assert.equal(archivesWhenLeft(chat("p", { count: 0, projectId: "proj" }), quiet), true);
  // Someone wrote in it: by the summary's count, or by the page that is loaded.
  assert.equal(archivesWhenLeft(chat("c", { count: 1 }), quiet), false);
  assert.equal(archivesWhenLeft(empty, { ...quiet, messages: 1 }), false);
  // Kept: pinned, a schedule of any kind, a panel's chat, typed text, a bot at work, a message waiting.
  assert.equal(archivesWhenLeft(chat("c", { count: 0, pinned: true }), quiet), false);
  assert.equal(archivesWhenLeft(chat("c", { count: 0, schedules: [{ id: "s" } as never] }), quiet), false);
  assert.equal(archivesWhenLeft(chat("c", { count: 0, panelId: "p1" }), quiet), false);
  assert.equal(archivesWhenLeft(empty, { ...quiet, draft: "half a thought" }), false);
  assert.equal(archivesWhenLeft(empty, { ...quiet, draft: "   " }), true);
  assert.equal(archivesWhenLeft(empty, { ...quiet, working: true }), false);
  assert.equal(archivesWhenLeft(empty, { ...quiet, waiting: 1 }), false);
  // Already archived, or gone (another computer is in use): nothing to do.
  assert.equal(archivesWhenLeft(chat("c", { count: 0, archived: true }), quiet), false);
  assert.equal(archivesWhenLeft(undefined, quiet), false);
});
