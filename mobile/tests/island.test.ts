// The island: Steps and Thinking set to Open (the owner's approved mockup, 2026-11-24). What goes
// into its window and in which order, the header's words, the receipt, when the capsule shows, how
// a saved choice is read, and where the island sits in the chat's list. The plain logic is
// src/features/chat/islandModel.ts and src/features/chat/turn.ts; Island.tsx draws it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, Reasoning, Run, Step } from "../src/link/types";
import { settleSteps, settleThinking } from "../src/features/chat/fold";
import { capsuleShown, elapsed, islandFacts, islandLabel, islandLines, islandOn, islandWindow, reasoningTail, receiptLine, thinkingHeading, thoughtParts, WINDOW } from "../src/features/chat/islandModel";
import { createChatViewport, islandAboveDock } from "../src/features/chat/scroll";
import { chatTimeline, type Item, liveRowVisible, type TimelineInput, type TurnPrefs } from "../src/features/chat/turn";

const T0 = 1_700_000_000_000;
const at = (seconds: number) => T0 + seconds * 1000;
const step = (id: string, seconds: number, more: Partial<Step> = {}): Step => ({ id, name: "bash", label: "Ran " + id, status: "Done", started: at(seconds), finished: at(seconds + 1), ...more });
const thought = (id: string, seconds: number, text: string): Reasoning => ({ id, text, started: at(seconds) });
const run = (more: Partial<Run> = {}): Run => ({ id: "r1", chatId: "c1", title: "Trip", time: at(0), status: "Working", ...more });
const ask: Message = { role: "user", text: "Find the cheapest way to Austin", runId: "r1", time: at(0) };

const OPEN: TurnPrefs = { steps: "show", thinking: "show", foldFinishedSteps: true, island: true };
const input = (more: Partial<TimelineInput>): TimelineInput => ({ messages: [], from: 0, runs: {}, timeline: true, group: false, prefs: OPEN, ...more });

function shape(items: Item[]): string[] {
  return items.map((item) => {
    if (item.kind === "message") return (item.message.interim ? "interim" : item.message.role) + ":" + item.message.text;
    if (item.kind === "fold") return (item.island ? (item.live ? "island*" : "receipt") : item.live ? "fold*" : "fold") + ":" + item.line;
    if (item.kind === "work") return "steps:" + item.steps.map((s) => s.id).join(",") + (item.thinking ? "+thinking" : "");
    if (item.kind === "live") return "live:" + item.steps.map((s) => s.id).join(",") + "|" + item.text + (item.thinking ? "+thinking" : "");
    if (item.kind === "text") return "text:" + item.text;
    return item.kind;
  });
}

// ── When it is on ────────────────────────────────────────────────────────────────────────────────

test("Open on Steps or on Thinking makes the island; Folded, Hidden and Failed only don't", () => {
  assert.equal(islandOn({ steps: "show", thinking: "show" }), true);
  assert.equal(islandOn({ steps: "show", thinking: "hide" }), true);
  assert.equal(islandOn({ steps: "folded", thinking: "show" }), true);
  assert.equal(islandOn({ steps: "failed", thinking: "show" }), true);
  assert.equal(islandOn({ steps: "folded", thinking: "folded" }), false);
  assert.equal(islandOn({ steps: "failed", thinking: "hide" }), false);
});

// ── Defaults and the migration ───────────────────────────────────────────────────────────────────

test("Open is the default for both; a saved Thinking without the flag keeps only Open and Hidden", () => {
  assert.equal(settleSteps({}), "show");
  assert.equal(settleSteps({ steps: "folded" }), "show", "unpicked Folded was the old default");
  assert.equal(settleSteps({ steps: "folded", stepsPicked: true }), "folded");
  assert.equal(settleSteps({ steps: "failed", stepsPicked: true }), "failed");

  assert.equal(settleThinking({}), "show");
  assert.equal(settleThinking({ thinking: "folded" }), "show", "Folded was the old default, not a pick");
  assert.equal(settleThinking({ thinking: "hide" }), "hide", "Hidden was never a default: the person chose it");
  assert.equal(settleThinking({ thinking: "show" }), "show");
  assert.equal(settleThinking({ thinking: "nonsense" }), "show");
  assert.equal(settleThinking({ thinking: "folded", thinkingPicked: true }), "folded", "a pick made after the flag is kept");
  assert.equal(settleThinking({ thinking: "hide", thinkingPicked: true }), "hide");
  assert.equal(settleThinking({ thinking: "nonsense", thinkingPicked: true }), "show");
});

// ── Lines and the window ─────────────────────────────────────────────────────────────────────────

test("a thought is its heading and a fainter snippet", () => {
  assert.deepEqual(thoughtParts("**Comparing fares**\n\nAlta Air lands at 12:40, early enough."), { heading: "Comparing fares", snippet: "Alta Air lands at 12:40, early enough." });
  assert.deepEqual(thoughtParts("## Checking the shuttle\nThe hotel runs one every 30 minutes."), { heading: "Checking the shuttle", snippet: "The hotel runs one every 30 minutes." });
  assert.deepEqual(thoughtParts("Planning the search. First the outbound legs."), { heading: "Planning the search", snippet: "First the outbound legs." });
  assert.deepEqual(thoughtParts("Short one"), { heading: "Short one", snippet: "" });
  const long = thoughtParts("a very long thought with no stop that keeps going and going well past any heading's length");
  assert.ok(long.heading.endsWith("…") && long.heading.length <= 46, long.heading);
  assert.ok(long.snippet.length > 0);
});

test("steps and thoughts interleave in the order they happened; empty thoughts are left out", () => {
  const r = run({ steps: [step("a", 2), step("b", 5)], reasoning: [thought("t1", 1, "**Planning**"), thought("t2", 5, "**Comparing fares** …"), thought("t3", 6, "  ")] });
  const keys = (lines: ReturnType<typeof islandLines>) => lines.map((line) => line.key);
  assert.deepEqual(keys(islandLines(r, { steps: true, thoughts: true })), ["r:t1", "s:a", "r:t2", "s:b"], "a thought and a step at the same moment read thought first");
  assert.deepEqual(keys(islandLines(r, { steps: true, thoughts: false })), ["s:a", "s:b"]);
  assert.deepEqual(keys(islandLines(r, { steps: false, thoughts: true })), ["r:t1", "r:t2"]);
  assert.deepEqual(islandLines(undefined, { steps: true, thoughts: true }), []);
});

test("the window holds the newest 4 lines, and says when older ones are cut", () => {
  assert.equal(WINDOW, 4);
  const lines = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(islandWindow(lines), { lines: [4, 5, 6, 7], clipped: true });
  assert.deepEqual(islandWindow([1, 2, 3, 4]), { lines: [1, 2, 3, 4], clipped: false });
  assert.deepEqual(islandWindow([1]), { lines: [1], clipped: false });
});

test("with Thinking alone the window is the end of the thought being written, not all of it", () => {
  const words = Array.from({ length: 80 }, (_, i) => "word" + i).join(" ");
  const tail = reasoningTail([thought("t1", 1, "**Old** finished thought"), thought("t2", 2, "**Comparing fares**\n\n" + words)]);
  assert.ok(tail.clipped);
  assert.ok(tail.text.startsWith("…"), "cut at a word, marked");
  assert.ok(tail.text.endsWith("word79"), "ends where the bot is now");
  assert.ok(tail.text.length <= 202);
  assert.ok(!tail.text.includes("**"), "Markdown marks are left out");
  assert.deepEqual(reasoningTail([thought("t1", 1, "Short.")]), { text: "Short.", clipped: false });
  assert.deepEqual(reasoningTail([thought("t1", 1, "**Comparing fares**\n\nAlta lands at 12:40.")]), { text: "Alta lands at 12:40.", clipped: false }, "the heading is the header's; the window shows what follows");
  assert.deepEqual(reasoningTail([thought("t1", 1, "**Comparing fares**")]), { text: "Comparing fares", clipped: false }, "a heading alone is still shown");
  assert.deepEqual(reasoningTail([]), { text: "", clipped: false });
  assert.deepEqual(reasoningTail([thought("t1", 1, "   ")]), { text: "", clipped: false });
});

// ── The header ───────────────────────────────────────────────────────────────────────────────────

test("the header: who is working, the thought's heading while only thinking, and who is needed", () => {
  assert.equal(islandLabel({ name: "Gordie", waiting: false }), "Gordie is working");
  assert.equal(islandLabel({ waiting: false }), "Working");
  assert.equal(islandLabel({ name: "Gordie", waiting: false, heading: "Comparing fares" }), "Comparing fares");
  assert.equal(islandLabel({ name: "Gordie", waiting: true, heading: "Comparing fares" }), "Gordie needs you", "waiting wins");

  const thinking = run({ steps: [step("a", 1)], reasoning: [thought("t1", 3, "**Comparing fares** Alta Air…")] });
  assert.equal(thinkingHeading(thinking), "Comparing fares", "the newest line is a thought and nothing runs");
  assert.equal(thinkingHeading(run({ steps: [step("a", 1, { status: "Running", finished: undefined })], reasoning: [thought("t1", 3, "**Comparing**")] })), undefined, "a running step: the bot is working");
  assert.equal(thinkingHeading(run({ steps: [step("a", 5)], reasoning: [thought("t1", 3, "**Comparing**")] })), undefined, "a step came after the thought");
  assert.equal(thinkingHeading(run({ steps: [] })), undefined);
});

test("time and steps on the right, in tabular words that tick each second", () => {
  assert.equal(elapsed(0), "0s");
  assert.equal(elapsed(23_400), "23s");
  assert.equal(elapsed(75_000), "1m 15s");
  assert.equal(islandFacts(23_000, 7), "23s · 7 steps");
  assert.equal(islandFacts(4_000, 1), "4s · 1 step");
  assert.equal(islandFacts(4_000, 0), "4s");
});

test("the receipt under the answer", () => {
  assert.equal(receiptLine({ took: 42_000, steps: 9, onlyThinking: false }), "Worked 42s · 9 steps");
  assert.equal(receiptLine({ took: 12_000, steps: 0, onlyThinking: true }), "Thought 12s");
  assert.equal(receiptLine({ steps: 3, onlyThinking: false }), "3 steps");
  assert.equal(receiptLine({ steps: 0, onlyThinking: false }), "Show work");
});

test("the capsule shows only while the island is out of view", () => {
  assert.equal(capsuleShown({ working: true, island: true, islandInView: true }), false);
  assert.equal(capsuleShown({ working: true, island: true, islandInView: false }), true);
  assert.equal(capsuleShown({ working: true, island: false, islandInView: true }), true, "without the island it shows as before");
  assert.equal(capsuleShown({ working: false, island: true, islandInView: false }), false);

  // The list runs on under the message box, so "in view" is worked out from the scroll offset and the island's height.
  assert.equal(islandAboveDock({ offset: 0, height: 160 }), true, "at the latest the island sits right above the message box");
  assert.equal(islandAboveDock({ offset: 100, height: 160 }), true, "scrolled a little: most of it still shows");
  assert.equal(islandAboveDock({ offset: 150, height: 160 }), false, "only a sliver above the message box: away");
  assert.equal(islandAboveDock({ offset: 900, height: 160 }), false);
  assert.equal(islandAboveDock({ offset: 900, height: 0 }), true, "not measured yet: no capsule over it");

  const viewport = createChatViewport();
  assert.equal(viewport.island.getState(), undefined, "not tracking: the list's viewability decides");
  viewport.islandHeight(160);
  viewport.trackIsland(true);
  assert.equal(viewport.island.getState(), true);
  viewport.scrolled(400);
  assert.equal(viewport.island.getState(), false);
  viewport.scrolled(10);
  assert.equal(viewport.island.getState(), true);
  viewport.trackIsland(false);
  assert.equal(viewport.island.getState(), undefined);
});

// ── In the chat's list ───────────────────────────────────────────────────────────────────────────

const working = run({
  steps: [step("a", 2), step("b", 3), step("c", 4), step("d", 5), step("e", 6, { status: "Running", finished: undefined })],
  reasoning: [thought("t1", 1, "**Planning the search** First the outbound legs.")],
});
const update: Message = { role: "assistant", text: "Found three nonstop options under $300.", runId: "r1", time: at(4.5), interim: true };

test("while a turn runs, Open keeps its steps and thoughts out of the chat: the island under the newest text holds them, and updates stay in the chat", () => {
  const items = chatTimeline(input({ messages: [ask, update], running: working, live: { stream: "" } }));
  assert.deepEqual(shape(items), ["user:" + ask.text, "text:" + update.text, "island*:Working… · 5 steps"]);
  const island = items.at(-1);
  assert.ok(island?.kind === "fold" && island.key === "f:r1", "the same key as the receipt it becomes");

  const streaming = chatTimeline(input({ messages: [ask, update], running: working, live: { stream: "Alta Air 214 is the pick" } }));
  assert.deepEqual(shape(streaming).slice(-2), ["live:|Alta Air 214 is the pick", "island*:Working… · 5 steps"], "the island sits under the text being written");
  const live = streaming.find((item) => item.kind === "live");
  assert.ok(live?.kind === "live");
  assert.equal(liveRowVisible(live, { stream: "", thinking: "" }, working, OPEN), false, "no row of its own for thinking: that is in the island");
});

test("updates off: they stay out of the chat, and still never go into the island", () => {
  const items = chatTimeline(input({ messages: [ask, update], running: working, live: { stream: "" }, prefs: { ...OPEN, updates: false } }));
  assert.deepEqual(shape(items), ["user:" + ask.text, "island*:Working… · 5 steps"]);
});

test("a finished turn folds into the receipt under the answer, with updates left where they landed and only steps and thoughts inside", () => {
  const done = run({ ...working, status: "Completed", finished: at(42), steps: working.steps?.map((s) => ({ ...s, status: "Done", finished: s.started + 1000 })) });
  const steer: Message = { role: "user", text: "Aisle seat please", steeredRunId: "r1", time: at(5.5) };
  const answer: Message = { role: "assistant", text: "Alta Air 214 is the pick.", runId: "r1", time: at(41) };
  const items = chatTimeline(input({ messages: [ask, update, steer, answer], runs: { r1: done } }));
  assert.deepEqual(shape(items), ["user:" + ask.text, "text:" + update.text, "user:Aisle seat please", "assistant:" + answer.text, "receipt:Worked 42s · 5 steps"]);
  const receipt = items.at(-1);
  assert.ok(receipt?.kind === "fold");
  assert.deepEqual(receipt.entries.map((entry) => entry.kind + ":" + entry.key), ["thought:r:t1", "step:s:a", "step:s:b", "step:s:c", "step:s:d", "step:s:e"]);

  // "Fold finished steps" off doesn't matter with the island: it always becomes the receipt.
  const unfolded = chatTimeline(input({ messages: [ask, update, answer], runs: { r1: done }, prefs: { ...OPEN, foldFinishedSteps: false } }));
  assert.equal(shape(unfolded).at(-1), "receipt:Worked 42s · 5 steps");
});

test("Folded and Failed only draw as they did: no island", () => {
  const folded = chatTimeline(input({ messages: [ask], running: working, live: { stream: "" }, prefs: { steps: "folded", thinking: "folded", foldFinishedSteps: true } }));
  assert.deepEqual(shape(folded), ["user:" + ask.text, "fold*:Working… · 5 steps"]);
  const failing = run({ ...working, steps: [...(working.steps ?? []).slice(0, 4), step("x", 7, { status: "Failed" })] });
  const failed = chatTimeline(input({ messages: [ask], running: failing, live: { stream: "" }, prefs: { steps: "failed", thinking: "hide", foldFinishedSteps: true } }));
  assert.deepEqual(shape(failed), ["user:" + ask.text, "live:x|", "fold*:Working… · 5 steps"]);
});

test("Thinking Open with Failed only: failed steps stay in the chat and the thinking is in the island", () => {
  const failing = run({ ...working, steps: [...(working.steps ?? []).slice(0, 4), step("x", 7, { status: "Failed" })] });
  const items = chatTimeline(input({ messages: [ask], running: failing, live: { stream: "" }, prefs: { steps: "failed", thinking: "show", foldFinishedSteps: true, island: true } }));
  assert.deepEqual(shape(items), ["user:" + ask.text, "live:x|", "island*:Working… · 5 steps"]);
});
