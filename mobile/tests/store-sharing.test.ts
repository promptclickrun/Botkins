// What arrives again unchanged stays the same object in the store (src/state/store.ts), so what is
// drawn from it is not drawn again: a chat's page that comes whole with every reply, and the lists
// the computer sends whole when one row changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatTimeline, indexMessageOwnership, reuseItems } from "../src/features/chat/turn";
import type { Message, Run } from "../src/link/types";
import { applyParts, forgetComputer, mergeChat, useApp } from "../src/state/store";

const words = "The quick brown fox jumps over the lazy dog and keeps going until the paragraph is long enough. ";
const fresh = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function empty() {
  forgetComputer();
  useApp.setState({ parts: {}, texts: {}, chats: {}, running: {}, synced: false });
}

/** A chat of 30 turns: each a question, eight steps and a reply; every fifth question has a file. */
function chat() {
  const messages: Message[] = [];
  const runs: Run[] = [];
  for (let n = 0; n < 30; n++) {
    const runId = "run-" + n;
    messages.push({ role: "user", text: "Question " + n, time: 1000 + n * 10, ...(n % 5 === 0 && { attachments: [{ name: "a.png", path: "/tmp/a.png" }] }) } as Message);
    messages.push({ role: "assistant", text: "## Answer " + n + "\n\n" + words.repeat(4), time: 1005 + n * 10, runId, botId: "b" } as Message);
    runs.push({ id: runId, chatId: "c", title: "Run " + n, status: "Completed", time: 1000 + n * 10, finished: 1004 + n * 10, steps: Array.from({ length: 8 }, (_, s) => ({ id: runId + "-s" + s, name: "shell", label: "Run " + s, status: "Done", started: s, finished: s + 1, more: true })) } as Run);
  }
  const page = (extra: Message[] = []) => fresh({ id: "c", from: 0, total: messages.length + extra.length, messages: [...messages, ...extra], runs });
  return { page };
}
const prefs = { steps: "fold", thinking: "fold", updates: true, foldFinishedSteps: true, island: false } as const;
function rows() {
  const view = useApp.getState().chats.c!;
  return chatTimeline({ messages: view.messages, from: view.from, runs: view.runs, running: null, live: {}, marks: {}, timeline: true, group: false, prefs, ownership: indexMessageOwnership(view.messages) });
}
/** How many of the chat's rows are new objects after `change`: each of those is drawn again. */
function drawnAgain(change: () => void) {
  const before = reuseItems(undefined, rows());
  change();
  const after = reuseItems(before.byKey, rows());
  return { again: after.items.filter((item) => before.byKey.get(item.key) !== item).length, of: after.items.length };
}

test("a chat's page that arrives again unchanged changes nothing in the store", () => {
  empty();
  const { page } = chat();
  applyParts({ "chat:c": page() });
  const held = useApp.getState().chats.c;
  let updates = 0;
  const stop = useApp.subscribe(() => void updates++);
  const { again, of } = drawnAgain(() => applyParts({ "chat:c": page() }));
  stop();
  assert.equal(of, 90);
  assert.equal(again, 0, "no row is drawn again");
  assert.strictEqual(useApp.getState().chats.c, held, "the chat is the object it was");
  assert.equal(updates, 0, "and no screen heard of a change");
});

test("a reply landing draws its own rows, not the chat's other 89", () => {
  empty();
  const { page } = chat();
  applyParts({ "chat:c": page() });
  const held = useApp.getState().chats.c!;
  const { again, of } = drawnAgain(() => applyParts({ "chat:c": page([{ role: "assistant", text: "New", time: 9999, botId: "b" } as Message]) }));
  assert.equal(of, 91);
  // The new reply, and the reply before it, which is no longer the newest.
  assert.ok(again <= 2, again + " rows drawn again");
  const now = useApp.getState().chats.c!;
  assert.strictEqual(now.messages[0], held.messages[0]);
  assert.strictEqual(now.runs["run-0"], held.runs["run-0"]);
  assert.equal(now.total, 61);
});

test("a message or a run that changed is taken as it came", () => {
  empty();
  const { page } = chat();
  applyParts({ "chat:c": page() });
  const held = useApp.getState().chats.c!;
  const next = page();
  next.messages[3]!.text = "Edited";
  (next.messages[5] as Message & { reactions?: unknown }).reactions = [{ emoji: "👍", by: ["owner"] }];
  next.runs[2]!.steps![0]!.status = "Failed";
  applyParts({ "chat:c": next });
  const now = useApp.getState().chats.c!;
  assert.notStrictEqual(now, held);
  assert.equal(now.messages[3]!.text, "Edited");
  assert.deepEqual((now.messages[5] as Message & { reactions?: unknown }).reactions, [{ emoji: "👍", by: ["owner"] }]);
  assert.equal(now.runs["run-2"]!.steps![0]!.status, "Failed");
  assert.strictEqual(now.messages[4], held.messages[4], "the message between them is the one held");
  assert.strictEqual(now.runs["run-1"], held.runs["run-1"]);
  // Earlier pages stay, and a page for another fork starts over, as before.
  const earlier = mergeChat({ ...held, from: 10, messages: held.messages.slice(10) }, { ...page(), from: 40, messages: page().messages.slice(40) });
  assert.equal(earlier.from, 10);
  assert.equal(earlier.messages.length, 50);
  assert.equal(mergeChat(held, { ...page(), activeFork: "other" }).activeFork, "other");
});

test("one chat's context changing leaves the other 299 chats the objects they were", () => {
  empty();
  const chats = Array.from({ length: 300 }, (_, n) => ({ id: "chat-" + n, botId: "b" + (n % 20), title: "Chat " + n, time: 5000 - n, count: 12, last: { role: "assistant", text: words, time: 5000 - n }, context: { current: 1000 + n, limit: 200000, updatedAt: 1 } }));
  applyParts({ chats: fresh(chats) });
  const held = useApp.getState().parts.chats!;
  // Every model call of any bot does this: the whole list comes again.
  const next = fresh(chats);
  next[7]!.context.current += 500;
  applyParts({ chats: next });
  const now = useApp.getState().parts.chats!;
  assert.equal(now.filter((chat, index) => chat !== held[index]).length, 1);
  assert.equal(now[7]!.context!.current, 1507);
  // The same list again is no change at all: no selector runs.
  let updates = 0;
  const stop = useApp.subscribe(() => void updates++);
  applyParts({ chats: fresh(next) });
  stop();
  assert.equal(updates, 0);
  assert.strictEqual(useApp.getState().parts.chats, now);
  // A row that moved, came or went changes the list, and keeps the rows that are the same.
  const moved = fresh(next);
  moved.unshift(moved.pop()!);
  moved.push({ ...fresh(chats[0]!), id: "new" });
  applyParts({ chats: moved });
  const after = useApp.getState().parts.chats!;
  assert.deepEqual(after.map((chat) => chat.id), moved.map((chat) => chat.id));
  assert.strictEqual(after[1], now[0]);
  assert.strictEqual(after[0], now[299]);
});

test("parts that are not lists of rows with an id arrive as they are", () => {
  empty();
  applyParts({ settings: { theme: "ink" }, skills: 3, revs: { providers: 1 } });
  applyParts({ settings: { theme: "fern" }, skills: 4, revs: { providers: 2 }, board: [] });
  const parts = useApp.getState().parts as Record<string, unknown>;
  assert.deepEqual(parts.settings, { theme: "fern" });
  assert.equal(parts.skills, 4);
  assert.deepEqual(parts.board, []);
  applyParts({ board: [{ id: "a", title: "One" }] });
  applyParts({ board: [] });
  assert.deepEqual((useApp.getState().parts as Record<string, unknown>).board, [], "a list that emptied is empty");
});
