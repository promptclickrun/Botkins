// Pure unread/changed rules shared by Home's bot dots, BotMenu, Chats, and Spaces
// (src/features/chat/unread.ts; mirrors desktop/src/unread.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { allUnreadChats, botUnreadChats, changedSpaces, isUnreadConversation } from "../src/features/chat/unread";
import type { ChatSummary } from "../src/link/types";

const chat = (id: string, more: Partial<ChatSummary> = {}): ChatSummary => ({ id, botId: "mira", title: id, time: 1, count: 2, ...more });

test("an older unread chat counts toward its bot's unread list even when the newest chat is read", () => {
  const chats = [
    chat("older-work", { time: 10, unread: true }),
    chat("latest-read", { time: 50, unread: false }),
    chat("group-unread", { time: 60, botIds: ["mira", "patch"], unread: true }),
    chat("archived-unread", { time: 70, archived: true, unread: true }),
    chat("panel-unread", { time: 80, panelId: "p1", unread: true }),
    chat("routine-unread", { time: 90, schedules: [{ id: "s", routine: true } as never], unread: true }),
    chat("other-bot", { time: 100, botId: "patch", unread: true }),
  ];
  assert.deepEqual(
    botUnreadChats(chats, "mira").map((c) => c.id),
    ["older-work"],
  );
  assert.deepEqual(
    allUnreadChats(chats).map((c) => c.id),
    ["older-work", "group-unread", "other-bot"],
  );
  assert.equal(isUnreadConversation(chats[0]), true);
  assert.equal(isUnreadConversation(chats[3]), false);
  assert.equal(isUnreadConversation(chats[4]), false);
  assert.equal(isUnreadConversation(chats[5]), false);
});

test("changedSpaces returns only spaces with changed > 0", () => {
  const spaces = [
    { id: "s_1", changed: 0 },
    { id: "s_2", changed: 3 },
    { id: "s_3", changed: 1 },
  ];
  assert.deepEqual(
    changedSpaces(spaces).map((space) => space.id),
    ["s_2", "s_3"],
  );
});
