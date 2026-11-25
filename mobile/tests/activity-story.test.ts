// The turn as a story, its crew and the crew's lanes (src/features/chat/activityStory.ts, the same
// file as the desktop app's src/activityStory.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { crewLanes, crewLine, crewOf, storyChapters, thoughtHeading, type StoryRun, type StoryStep } from "../src/features/chat/activityStory";

const T0 = 1_700_000_000_000;
const at = (seconds: number) => T0 + seconds * 1000;
const step = (id: string, seconds: number, more: Partial<StoryStep> = {}): StoryStep => ({ id, name: "view", label: "view", status: "Done", started: at(seconds), finished: at(seconds + 1), ...more });
const thought = (id: string, seconds: number, text: string) => ({ id, text, started: at(seconds) });

test("each thought opens a chapter with the steps and updates after it, in order", () => {
  const run: StoryRun = {
    time: at(0),
    reasoning: [thought("t1", 2, "**Finding where coupons apply**\nThe route calls applyCoupon before tax."), thought("t2", 20, "Why the test fails. The discount runs twice.")],
    steps: [
      step("early", 1, { name: "grep", label: "grep" }),
      step("a", 3),
      step("b", 5, { name: "grep", label: "grep" }),
      step("c", 21, { name: "bash", label: "bash", status: "Failed" }),
      step("d", 25, { status: "Running", finished: undefined }),
    ],
  };
  const chapters = storyChapters(run, [{ key: "u1", at: at(22), text: "Found it: the coupon runs twice." }]);
  assert.deepEqual(
    chapters.map((c) => [c.heading, c.items.map((item) => item.key)]),
    [
      ["Searched files", ["step-early"]],
      ["Finding where coupons apply", ["step-a", "step-b"]],
      ["Why the test fails", ["step-c", "update-u1", "step-d"]],
    ],
    "what came before the first thought is a chapter of its own, headed by what it did",
  );
  assert.equal(chapters[1].thought?.snippet, "The route calls applyCoupon before tax.");
  assert.deepEqual(chapters[1].counts, [{ kind: "read", count: 1 }, { kind: "search-files", count: 1 }]);
  assert.deepEqual([chapters[2].failed, chapters[2].running], [1, true]);
  assert.equal(chapters[0].thought, undefined);
});

test("thoughts with nothing between them make one chapter", () => {
  const run: StoryRun = { time: at(0), reasoning: [thought("t1", 1, "**Planning**\nFirst the files."), thought("t2", 2, "**Still planning**\nThen the tests."), thought("t3", 9, "Done reading.")], steps: [step("a", 3)] };
  const chapters = storyChapters(run);
  assert.deepEqual(chapters.map((c) => [c.heading, c.thought?.ids]), [["Planning", ["t1", "t2"]], ["Done reading", ["t3"]]]);
  assert.equal(chapters[0].thought?.snippet, "First the files. Still planning Then the tests.");
  assert.equal(chapters[1].items.length, 0, "a last thought with no steps is still a chapter");
});

test("a helper's steps, background commands and quiet bookkeeping stay out of the story", () => {
  const run: StoryRun = {
    time: at(0),
    reasoning: [thought("t1", 0, "Look around.")],
    steps: [step("a", 1), step("h1", 2, { agentId: "task-1" }), step("bg", 3, { name: "bash", background: true }), step("q", 4, { name: "report_intent" }), step("q2", 5, { name: "report_intent", status: "Failed" })],
  };
  assert.deepEqual(storyChapters(run)[0].items.map((item) => item.key), ["step-a", "step-q2"], "a failed bookkeeping step still shows");
});

test("with no thinking, each update closes a chapter and the heading says what was done", () => {
  const run: StoryRun = { time: at(0), steps: [step("a", 1), step("b", 2), step("c", 6, { name: "bash", label: "bash" })] };
  const chapters = storyChapters(run, [{ key: "u1", at: at(4), text: "Read both files." }]);
  assert.deepEqual(chapters.map((c) => [c.heading, c.items.map((item) => item.key)]), [["Read 2 files", ["step-a", "step-b", "update-u1"]], ["Ran a command", ["step-c"]]]);
  assert.deepEqual(storyChapters({ time: at(0) }), [], "an empty turn has no chapters");
  assert.deepEqual(storyChapters({ time: at(0) }, [{ key: "u", at: at(1), text: "Hello" }]).map((c) => c.heading), ["Update"]);
});

test("a thought's heading is its bold or Markdown title, else its first sentence", () => {
  assert.deepEqual(thoughtHeading("**Reading the plan**\nThe file lists three legs."), { heading: "Reading the plan", snippet: "The file lists three legs." });
  assert.deepEqual(thoughtHeading("## Checking fares\nCheapest first."), { heading: "Checking fares", snippet: "Cheapest first." });
  assert.deepEqual(thoughtHeading("Looking at the dates. Then fares."), { heading: "Looking at the dates", snippet: "Then fares." });
  assert.equal(thoughtHeading("short words").heading, "short words");
  assert.ok(thoughtHeading("word ".repeat(40)).heading.endsWith("…"));
});

test("the crew: helpers and background commands in the order they started, with what each is doing", () => {
  const run: StoryRun = {
    time: at(0),
    agents: [
      { id: "task-2", name: "Docs reader", status: "Done", started: at(12), finished: at(33), result: "Notes\nStripe applies a coupon once per invoice" },
      { id: "task-1", name: "Code searcher", status: "Running", started: at(11), intent: "Reading subscription.ts", stoppable: true },
    ],
    steps: [
      step("bg", 5, { name: "bash", input: JSON.stringify({ command: "npm run dev", run_in_background: true }), background: true, status: "Running", finished: undefined, progress: "starting\n  ready on localhost:3000\n", stoppable: true }),
      step("s1", 13, { agentId: "task-1" }),
      step("s2", 14, { agentId: "task-1" }),
      step("d1", 15, { agentId: "task-2" }),
    ],
  };
  const crew = crewOf(run);
  assert.ok(crew);
  assert.deepEqual(
    crew.members.map((m) => [m.kind, m.name, m.doing ?? null, m.kind === "helper" ? (m.done ?? null) : null, m.stoppable]),
    [
      ["command", "npm run dev", "ready on localhost:3000", null, true],
      ["helper", "Code searcher", "Reading subscription.ts", null, true],
      ["helper", "Docs reader", null, "Stripe applies a coupon once per invoice", false],
    ],
  );
  assert.deepEqual([crew.at, crew.running, crew.failed, crew.steps], [at(5), 2, 0, 3]);
  assert.equal(crewLine(crew), "2 helpers · 1 command · 2 working");
  assert.equal(crewOf({ time: at(0), steps: [step("a", 1)] }), null, "no helpers, no crew");
});

test("the crew's folded line once it ended, and Stop only for one still running that the computer can stop", () => {
  const run: StoryRun = {
    time: at(0),
    agents: [
      { id: "h1", name: "A", status: "Done", started: at(1), finished: at(5), stoppable: true },
      { id: "h2", name: "B", status: "Failed", started: at(2), finished: at(3), detail: "Couldn't open CHANGELOG.md" },
    ],
    steps: [step("x", 2, { agentId: "h1" })],
  };
  const crew = crewOf(run);
  assert.ok(crew);
  assert.equal(crewLine(crew), "2 helpers · 1 step · 1 failed");
  assert.equal(crew.members[0].stoppable, false, "a finished helper is never stoppable");
  assert.equal(crew.members[1].kind === "helper" && crew.members[1].done, "Couldn't open CHANGELOG.md");
  assert.equal(crewLine(crewOf({ time: 0, agents: [{ id: "h", name: "A", status: "Done", started: 1, finished: 2 }] })!), "1 helper");
});

test("lanes: the bot waits while a step that started a helper runs, and each member spans its own time", () => {
  const run: StoryRun = {
    time: at(0),
    agents: [{ id: "task-1", name: "Code searcher", status: "Running", started: at(20) }],
    steps: [step("task-1", 20, { name: "task", label: "task", finished: at(60) }), step("bg", 10, { name: "bash", label: "bash", background: true, status: "Done", finished: at(30) })],
  };
  const { lanes, start, end } = crewLanes(run, at(100), "Pip");
  assert.deepEqual([start, end], [at(0), at(100)]);
  assert.deepEqual(lanes.map((lane) => [lane.kind, lane.label, lane.live]), [["bot", "Pip", true], ["command", "bash", false], ["helper", "Code searcher", true]]);
  assert.deepEqual(lanes[0].segments, [{ from: 0, to: 0.2, state: "work" }, { from: 0.2, to: 0.6, state: "wait" }, { from: 0.6, to: 1, state: "work" }]);
  assert.deepEqual(lanes[1].segments, [{ from: 0.1, to: 0.3, state: "work" }]);
  assert.deepEqual(lanes[2].segments, [{ from: 0.2, to: 1, state: "work" }]);
  const done = crewLanes({ time: at(0), finished: at(50), steps: [] }, at(100));
  assert.deepEqual([done.end, done.lanes[0].live, done.lanes[0].segments], [at(50), false, [{ from: 0, to: 1, state: "work" }]]);
});
