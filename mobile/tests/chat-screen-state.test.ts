// When a chat's page says "This chat is gone" (src/features/chat/chatScreenState.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatScreenState } from "../src/features/chat/chatScreenState";
import type { ChatSummary } from "../src/link/types";

const chat = (id: string): ChatSummary => ({ id, botId: "mira", title: id, time: 1, count: 0 });
const none = new Set<string>();
const base = { id: "c2", chats: [chat("c1")], synced: true, deletedIds: none, leaving: false };

test("a chat in the list is shown", () => {
  assert.equal(chatScreenState({ ...base, chats: [chat("c1"), chat("c2")] }), "chat");
});

test("a new chat that the list doesn't have yet is loading, not gone", () => {
  assert.equal(chatScreenState(base), "loading");
});

test("a chat opened from a notification before the list or the first sync is loading", () => {
  assert.equal(chatScreenState({ ...base, chats: undefined, synced: false }), "loading");
  assert.equal(chatScreenState({ ...base, synced: false }), "loading");
});

test("a chat the computer said it doesn't have is gone", () => {
  assert.equal(chatScreenState({ ...base, deletedIds: new Set(["c2"]) }), "gone");
  // Another chat's answer doesn't count for this one.
  assert.equal(chatScreenState({ ...base, deletedIds: new Set(["c9"]) }), "loading");
});

test("a chat that is in the list again is shown, whatever was answered before", () => {
  assert.equal(chatScreenState({ ...base, chats: [chat("c2")], deletedIds: new Set(["c2"]) }), "chat");
});

test("a page that is being left is blank, never gone", () => {
  assert.equal(chatScreenState({ ...base, deletedIds: new Set(["c2"]), leaving: true }), "blank");
  assert.equal(chatScreenState({ ...base, leaving: true }), "blank");
});

test("a page whose id is missing (it lost its route on the way out) is loading, never gone", () => {
  assert.equal(chatScreenState({ ...base, id: undefined, deletedIds: new Set(["c2"]) }), "loading");
});
