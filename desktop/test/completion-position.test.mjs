import assert from "node:assert/strict";
import test from "node:test";
import { settleChatDisplay } from "../src/chatDisplay.ts";
import { CompletionScroll, finalReplyIndex } from "../src/completionScroll.ts";

const working = { id: "turn", chatId: "chat", time: 1, status: "Working" };
const done = { ...working, status: "Completed" };
const chat = { id: "chat", messages: [] };

test("the device defaults to latest, including unknown stored values", () => {
  for (const value of [undefined, null, "other", "latest"]) {
    assert.equal(settleChatDisplay({ completionPosition: value }).completionPosition, "latest");
  }
  assert.equal(settleChatDisplay({ completionPosition: "beginning" }).completionPosition, "beginning");
});

test("a successful completion waits for visibility and a rendered reply, then fires once", () => {
  const scroll = new CompletionScroll();
  scroll.observe([chat], [working], "beginning");
  assert.equal(scroll.take(chat.id, { visible: true, rendered: working.id }), false);
  scroll.observe([chat], [done], "beginning");
  assert.equal(scroll.take(chat.id, { visible: false, rendered: done.id }), false);
  assert.equal(scroll.take(chat.id, { visible: true, rendered: "other" }), false);
  assert.equal(scroll.take(chat.id, { visible: true, rendered: done.id }), true);
  scroll.observe([chat], [done], "beginning");
  assert.equal(scroll.take(chat.id, { visible: true, rendered: done.id }), false);
});

test("old history, failed, canceled, interrupted, quiet and default-mode turns stay put", () => {
  const scroll = new CompletionScroll();
  scroll.observe([chat], [done], "beginning");
  assert.equal(scroll.take(chat.id, { visible: true, rendered: done.id }), false);
  for (const [status, ending, noOutput, mode] of [
    ["Needs you", "failed"], ["Stopped", "stopped"], ["Interrupted", "interrupted"],
    ["Completed", "timed-out"], ["Completed", undefined, true], ["Completed", undefined, false, "latest"],
  ]) {
    const turn = new CompletionScroll();
    turn.observe([chat], [working], "beginning");
    turn.observe([chat], [{ ...done, status, ending, noOutput }], mode ?? "beginning");
    assert.equal(turn.take(chat.id, { visible: true, rendered: done.id }), false);
  }
});

test("leaving the live output suppresses the jump even after leaving and reopening that chat", () => {
  const scroll = new CompletionScroll();
  scroll.observe([chat], [working], "beginning");
  scroll.readerMoved(chat.id, working.id);
  scroll.observe([chat], [done], "beginning");
  assert.equal(scroll.take(chat.id, { visible: true, rendered: done.id }), false);
  const next = { ...done, time: 2, id: "fast" };
  scroll.observe([chat], [next, done], "beginning");
  assert.equal(scroll.take(chat.id, { visible: true, rendered: next.id }), true);
});

test("find the last final assistant message of this run on a hydrated transcript page", () => {
  const messages = [
    { role: "assistant", runId: "turn", text: "First speaker" },
    { role: "assistant", runId: "turn", text: "Last speaker" },
    { role: "assistant", runId: "turn", interim: true, text: "Update" },
    { role: "command", runId: "turn", text: "Output" },
    { role: "assistant", runId: "other", text: "Other reply" },
  ];
  assert.equal(finalReplyIndex({ messages, loaded: { from: 10, total: 15 } }, "turn"), 11);
  assert.equal(finalReplyIndex({ messages, loaded: { from: 10, total: 16 } }, "turn"), undefined);
  assert.equal(finalReplyIndex({ messages, loaded: null }, "turn"), undefined);
  assert.equal(finalReplyIndex({ messages, count: 16, loaded: { from: 10, total: 15 } }, "turn"), undefined);
  assert.equal(finalReplyIndex({ messages }, "missing"), undefined);
});

test("opening an older remote transcript cannot turn delayed run history into a new completion", () => {
  const scroll = new CompletionScroll();
  scroll.observe([{ ...chat, count: 12 }], [], "beginning");
  scroll.observe([chat], [done], "beginning");
  assert.equal(scroll.take(chat.id, { visible: true, rendered: done.id }), false);
});
