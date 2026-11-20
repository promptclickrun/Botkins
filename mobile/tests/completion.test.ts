// "Position after response completes" (src/features/chat/completion.ts): when a finished reply is
// shown from its beginning. Once per run, only after a reply that finished, only once it is drawn
// and the chat is on screen, and never when the person had scrolled away.
import assert from "node:assert/strict";
import { test } from "node:test";
import { completionPositionOf, type CompletionInput, createCompletions, outcomeOf } from "../src/features/chat/completion";
import type { Message, Run } from "../src/link/types";

const run = (status: string, more: Partial<Run> = {}): Run => ({ id: "r1", chatId: "c1", title: "", time: 0, status, ...more });
const ask: Message = { role: "user", text: "Write me a long answer" };
const interim: Message = { role: "assistant", text: "Looking…", runId: "r1", interim: true };
const reply: Message = { role: "assistant", text: "A long answer", runId: "r1" };

/** A chat with the reply drawn and on screen, the person at the newest content. */
const input = (more: Partial<CompletionInput> = {}): CompletionInput => ({
  mode: "beginning",
  running: null,
  messages: [ask, interim, reply],
  from: 10,
  runs: { r1: run("Completed") },
  visible: true,
  following: true,
  drawn: true,
  ...more,
});
const working = input({ running: run("Working"), messages: [ask, interim], runs: {} });

test("an unknown saved choice is the latest content", () => {
  assert.equal(completionPositionOf("beginning"), "beginning");
  assert.equal(completionPositionOf("latest"), "latest");
  for (const odd of [undefined, null, "top", "BEGINNING", 1, {}]) assert.equal(completionPositionOf(odd), "latest", String(odd));
});

test("a finished run is shown from the beginning of its final reply, once", () => {
  const completions = createCompletions();
  // While it streams nothing moves.
  assert.deepEqual(completions.check("c1", working), { kind: "wait" });
  // The final reply, not the text written on the way: index 12 is the third message from 10.
  const step = completions.check("c1", input());
  assert.deepEqual(step, { kind: "jump", runId: "r1", index: 12 });
  completions.done("c1", "r1");
  assert.deepEqual(completions.check("c1", input()), { kind: "none" }, "a second look at the same run moves nothing");
});

test("an error, a stop or an interruption moves nothing", () => {
  for (const status of ["Needs you", "Stopped", "Interrupted"]) {
    const completions = createCompletions();
    completions.check("c1", working);
    // The run part keeps the run when it ended without a reply.
    assert.deepEqual(completions.check("c1", input({ running: run(status), messages: [ask, interim], runs: {} })), { kind: "none" }, status);
    assert.deepEqual(completions.check("c1", input()), { kind: "none" }, status + " is forgotten");
  }
  // An ending given by turn-timeline-v1, even with text from the bot, moves nothing either.
  const completions = createCompletions();
  completions.check("c1", working);
  assert.deepEqual(completions.check("c1", input({ runs: { r1: run("Completed", { ending: "timed-out" }) } })), { kind: "none" });
});

test("a person who scrolled away while it streamed stays where they are", () => {
  const completions = createCompletions();
  completions.check("c1", working);
  completions.check("c1", { ...working, following: false });
  assert.deepEqual(completions.check("c1", input()), { kind: "none" });
  assert.deepEqual(completions.check("c1", input()), { kind: "none" }, "and coming back later doesn't move them either");
  // Scrolling away and back to the newest content before it ends still shows the reply's beginning.
  const back = createCompletions();
  back.check("c1", { ...working, following: false });
  back.check("c1", working);
  assert.equal(back.check("c1", input()).kind, "jump");
});

test("a reply that arrives all at once and moves the list is not the person scrolling away", () => {
  // The app was away while it streamed; when it comes back the whole reply lands and the list shifts.
  const completions = createCompletions();
  completions.check("c1", working);
  assert.equal(completions.check("c1", input({ following: false })).kind, "jump");
});

test("it waits until the chat is on screen, then moves once", () => {
  const completions = createCompletions();
  completions.check("c1", working);
  // Finished while the app was away or another screen was on top.
  assert.deepEqual(completions.check("c1", input({ visible: false })), { kind: "wait" });
  assert.deepEqual(completions.check("c1", input({ visible: false })), { kind: "wait" });
  // Back on the chat: now.
  const step = completions.check("c1", input());
  assert.equal(step.kind, "jump");
  completions.done("c1", "r1");
  assert.deepEqual(completions.check("c1", input()), { kind: "none" });
});

test("it waits until the final reply is drawn and is there", () => {
  const completions = createCompletions();
  completions.check("c1", working);
  // The stream is still drawn in place of the reply.
  assert.deepEqual(completions.check("c1", input({ drawn: false })), { kind: "wait" });
  // Finished, but the reply hasn't arrived yet.
  assert.deepEqual(completions.check("c1", input({ messages: [ask, interim], runs: {} })), { kind: "wait" });
  assert.equal(completions.check("c1", input()).kind, "jump");
});

test("keeping the latest content never moves, and forgets the run", () => {
  const completions = createCompletions();
  completions.check("c1", working);
  assert.deepEqual(completions.check("c1", input({ mode: "latest" })), { kind: "none" });
  assert.deepEqual(completions.check("c1", input()), { kind: "none" }, "turning it on later doesn't act on a run already finished");
});

test("only a run this phone saw under way moves the chat, and each chat keeps its own", () => {
  const completions = createCompletions();
  // A chat opened after its reply finished stays at its newest content.
  assert.deepEqual(completions.check("c1", input()), { kind: "none" });
  completions.check("c2", working);
  assert.deepEqual(completions.check("c1", input()), { kind: "none" });
  assert.equal(completions.check("c2", input()).kind, "jump");
  // A newer run takes the place of one that never finished.
  const again = createCompletions();
  again.check("c1", working);
  again.check("c1", input({ running: run("Working", { id: "r2" }), messages: [ask, interim], runs: {} }));
  assert.deepEqual(again.check("c1", input()), { kind: "wait" }, "r1's reply is not r2's");
  assert.deepEqual(again.check("c1", input({ messages: [ask, interim, { ...reply, runId: "r2" }], runs: { r2: run("Completed", { id: "r2" }) } })), { kind: "jump", runId: "r2", index: 12 });
});

test("the outcome of a run reads its reply, its run part and its summary", () => {
  assert.deepEqual(outcomeOf("r1", { running: run("Working"), messages: [ask], from: 0, runs: {} }), { kind: "pending" });
  assert.deepEqual(outcomeOf("r1", { running: run("Stopped"), messages: [ask], from: 0, runs: {} }), { kind: "failed" });
  assert.deepEqual(outcomeOf("r1", { running: null, messages: [ask, reply, interim], from: 4, runs: {} }), { kind: "completed", index: 5 });
  assert.deepEqual(outcomeOf("r1", { running: null, messages: [ask], from: 0, runs: { r1: run("Completed") } }), { kind: "pending" });
});
