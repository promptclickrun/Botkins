// The activity island's rules (src/island.ts) and the defaults that make Open the island
// (src/chatDisplay.ts): Steps and Thinking are Open unless the person chose.
import assert from "node:assert/strict";
import test from "node:test";
import { settleChatDisplay } from "../src/chatDisplay.ts";
import { ISLAND_LINES, islandLabel, islandLines, islandMeta, islandWindow, reasoningTail, receiptLabel, thoughtParts } from "../src/island.ts";
import { defaultSettings } from "../desktop/preferences.mjs";

const step = (id, started, status = "Done", name = "bash") => ({ id, name, label: name, status, started });
const thought = (id, started, text) => ({ id, started, text });

test("the window holds the newest four lines and fades the rest", () => {
  const lines = islandLines({ steps: [1, 2, 3, 4, 5, 6].map((n) => step("s" + n, n)) }, { thoughts: false });
  const view = islandWindow(lines);
  assert.equal(ISLAND_LINES, 4);
  assert.deepEqual(view.shown.map((line) => line.key), ["step-s3", "step-s4", "step-s5", "step-s6"]);
  assert.equal(view.clipped, true);
  const few = islandWindow(lines.slice(0, 4));
  assert.equal(few.shown.length, 4);
  assert.equal(few.clipped, false, "four lines fit without a fade");
});

test("thoughts are rows between the steps, in the order they happened, and only when shown", () => {
  const run = {
    steps: [step("a", 10), step("b", 30), step("quiet", 35, "Done", "report_intent")],
    reasoning: [thought("t1", 20, "**Comparing fares**\n\nAlta Air lands at 12:40, early enough."), thought("t2", 30, "Checking the shuttle. The hotel runs one every 30 minutes.")],
  };
  const keep = (s) => s.name !== "report_intent";
  const both = islandLines(run, { thoughts: true, keep });
  assert.deepEqual(both.map((line) => line.key), ["step-a", "thought-t1", "thought-t2", "step-b"], "a thought that starts with a step leads it");
  assert.deepEqual([both[1].heading, both[1].snippet], ["Comparing fares", "Alta Air lands at 12:40, early enough."]);
  assert.deepEqual([both[2].heading, both[2].snippet], ["Checking the shuttle", "The hotel runs one every 30 minutes."]);
  assert.deepEqual(islandLines(run, { thoughts: false, keep }).map((line) => line.kind), ["step", "step"]);
});

test("a thought's heading is its bold title, else its first sentence or line", () => {
  assert.deepEqual(thoughtParts("**Reading the plan**\nThe file lists three legs."), { heading: "Reading the plan", snippet: "The file lists three legs." });
  assert.deepEqual(thoughtParts("Looking at dates.\nThen fares."), { heading: "Looking at dates", snippet: "Then fares." });
  assert.equal(thoughtParts("just a few words").heading, "just a few words");
});

test("Thinking alone shows the tail of the reasoning, from a word, with the top fading", () => {
  const long = "word ".repeat(200) + "the newest words";
  const tail = reasoningTail([thought("t", 1, "**Heading**\n" + long)]);
  assert.ok(tail.text.endsWith("the newest words"));
  assert.ok(tail.text.length <= 260);
  assert.ok(!tail.text.startsWith(" ") && tail.text.startsWith("word"), "it starts at a word");
  assert.equal(tail.clipped, true);
  assert.deepEqual(reasoningTail([thought("t", 1, "Short thought.")]), { text: "Short thought.", clipped: false });
  assert.deepEqual(reasoningTail(undefined), { text: "", clipped: false });
});

test("the header says who works, the thought's heading while it only thinks, and who is waited for", () => {
  const thinking = islandLines({ steps: [step("a", 1)], reasoning: [thought("t", 2, "**Comparing fares**\nmore")] }, { thoughts: true });
  assert.equal(islandLabel({ who: "Gordie", waiting: false, lines: thinking }), "Comparing fares");
  const running = islandLines({ steps: [step("a", 3, "Running")], reasoning: [thought("t", 2, "**Comparing fares**")] }, { thoughts: true });
  assert.equal(islandLabel({ who: "Gordie", waiting: false, lines: running }), "Gordie is working");
  assert.equal(islandLabel({ who: "Gordie", waiting: true, lines: thinking }), "Gordie needs you");
  assert.equal(islandLabel({ who: "Gordie", waiting: false, lines: [] }), "Gordie is working");
});

test("the clock and the receipt read as time and steps", () => {
  assert.equal(islandMeta(23_000, 7), "23s · 7 steps");
  assert.equal(islandMeta(4_000, 1), "4s · 1 step");
  assert.equal(islandMeta(4_000, 0), "4s");
  assert.equal(receiptLabel(42_000, 9), "Worked 42s · 9 steps");
  assert.equal(receiptLabel(95_000, 2), "Worked 1m 35s · 2 steps");
  assert.equal(receiptLabel(undefined, 3), "3 steps");
});

test("Open is the default for Steps and Thinking unless the person picked", () => {
  // The workspace defaults (foldTools and foldThinking on) are not a pick.
  assert.equal(defaultSettings.foldTools, true);
  assert.equal(defaultSettings.foldThinking, true);
  const fresh = settleChatDisplay({}, defaultSettings.showThinking);
  assert.deepEqual([fresh.steps, fresh.thinking], ["open", "open"]);
  // Steps: an unpicked Folded or Every was the old default.
  assert.equal(settleChatDisplay({ steps: "folded" }).steps, "open");
  assert.equal(settleChatDisplay({ steps: "every" }).steps, "open");
  assert.equal(settleChatDisplay({ steps: "failed" }).steps, "failed");
  assert.equal(settleChatDisplay({ steps: "folded", stepsPicked: true }).steps, "folded");
  assert.equal(settleChatDisplay({ steps: "failed", stepsPicked: true }).steps, "failed");
  // Thinking: an unpicked Folded was the old default; Open and Hidden were real choices.
  assert.equal(settleChatDisplay({ thinking: "folded" }).thinking, "open");
  assert.equal(settleChatDisplay({ thinking: "open" }).thinking, "open");
  assert.equal(settleChatDisplay({ thinking: "hidden" }).thinking, "hidden");
  assert.equal(settleChatDisplay({ thinking: "folded", thinkingPicked: true }).thinking, "folded");
  // The workspace's explicit showThinking: false still hides it, until the person picks here.
  assert.equal(settleChatDisplay({}, false).thinking, "hidden");
  assert.equal(settleChatDisplay({ thinking: "folded" }, false).thinking, "hidden");
  assert.equal(settleChatDisplay({ thinking: "open", thinkingPicked: true }, false).thinking, "open");
});
