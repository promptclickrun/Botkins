// What a chat's Live Activity shows, on the phone (src/state/activity.ts) and from the computer
// (activityState in link-host/push.mjs): the two build the same shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityState } from "../link-host/push.mjs";
import type { ActivityState, Run } from "../src/link/types";
import { activityView } from "../src/state/activity";

const T0 = 1_795_000_000_000;
const run = (more: Partial<Run> = {}): Run => ({ id: "r1", chatId: "c1", title: "", time: T0, status: "Working", ...more });
const step = (label: string, status = "Done") => ({ id: label, name: "tool", label, status, started: T0 });
const quiet = { active: true, asked: false, streaming: false, previews: true, now: T0 + 5000 };

test("a turn under way says what it is doing", () => {
  assert.deepEqual(activityView({ ...quiet, run: run() }), { steps: 0, startedAt: T0 / 1000, phase: "thinking", label: "Thinking" });
  const working = run({ steps: [step("Read the plan"), step("Searching the wiki", "Running")] });
  assert.deepEqual(activityView({ ...quiet, run: working }), { steps: 2, startedAt: T0 / 1000, phase: "working", label: "Searching the wiki" });
  assert.equal(activityView({ ...quiet, run: working, previews: false }).label, "Working", "no step names when previews are off");
  assert.equal(activityView({ ...quiet, run: working, streaming: true }).label, "Writing");
  assert.deepEqual(activityView({ ...quiet, run: working, asked: true, streaming: true }).phase, "needs-you");
});

test("a finished turn is marked done, with when it ended, and nothing counts on", () => {
  const done = activityView({ ...quiet, active: false, run: run({ status: "Completed", finished: T0 + 42_000, steps: [step("a"), step("b"), step("c")] }) });
  assert.deepEqual(done, { steps: 3, startedAt: T0 / 1000, phase: "done", label: "Done", finishedAt: T0 / 1000 + 42 });
  for (const status of ["Needs you", "Stopped", "Interrupted", "Failed"]) assert.deepEqual(activityView({ ...quiet, active: false, run: run({ status, finished: T0 + 9000 }) }).phase, "failed", status);
  // The chat is not on screen: the list of runs says how it ended.
  const away = activityView({ ...quiet, active: false, summary: run({ status: "Completed", finished: T0 + 61_000 }), previous: { steps: 4, startedAt: T0 / 1000, phase: "working", label: "Working" } });
  assert.deepEqual(away, { steps: 4, startedAt: T0 / 1000, phase: "done", label: "Done", finishedAt: T0 / 1000 + 61 });
  // Nothing is known of the run any more: it is over as of now, from what the card last showed.
  const blind = activityView({ ...quiet, active: false, previous: { steps: 2, startedAt: T0 / 1000 - 30, phase: "working", label: "Writing" } });
  assert.deepEqual(blind, { steps: 2, startedAt: T0 / 1000 - 30, phase: "done", label: "Done", finishedAt: T0 / 1000 + 5 });
  // A later look doesn't move the end.
  assert.equal(activityView({ ...quiet, now: T0 + 900_000, active: false, previous: blind }), blind);
});

test("a turn whose detail the phone doesn't have is working, not done", () => {
  const previous: ActivityState = { steps: 3, startedAt: T0 / 1000, phase: "working", label: "Searching the wiki" };
  // The person left the chat's screen: no detail, but the chat is still active.
  assert.deepEqual(activityView({ ...quiet, previous }), { steps: 3, startedAt: T0 / 1000, phase: "working", label: "Working" });
  assert.deepEqual(activityView({ ...quiet, previous: { ...previous, phase: "thinking", label: "Thinking" } }).phase, "thinking");
  assert.equal(activityView({ ...quiet, previous, asked: true }).phase, "needs-you");
  // A card that showed a finished turn, and a new turn begins in that chat: it starts afresh.
  const again = activityView({ ...quiet, summary: run({ id: "r2", time: T0 + 60_000 }), previous: { steps: 5, startedAt: T0 / 1000, phase: "done", label: "Done", finishedAt: T0 / 1000 + 40 } });
  assert.deepEqual(again, { steps: 0, startedAt: T0 / 1000 + 60, phase: "working", label: "Working" });
});

test("the computer builds the same shape for its pushes", () => {
  const working = run({ steps: [step("Read the plan"), step("Searching the wiki", "Running")] });
  const state = { requests: [], streams: {} };
  assert.deepEqual(activityState(state, "c1", working, true), activityView({ ...quiet, run: working }));
  assert.deepEqual(activityState({ ...state, streams: { c1: "Here" } }, "c1", working, true), activityView({ ...quiet, run: working, streaming: true }));
  assert.deepEqual(activityState({ ...state, requests: [{ chatId: "c1" }] }, "c1", working, false), activityView({ ...quiet, run: working, asked: true, previews: false }));
  const finished = run({ status: "Completed", finished: T0 + 42_000, steps: [step("a")] });
  assert.deepEqual(activityState(state, "c1", finished, true), activityView({ ...quiet, active: false, run: finished }));
  const failed = run({ status: "Needs you", finished: T0 + 7000 });
  assert.deepEqual(activityState(state, "c1", failed, true), activityView({ ...quiet, active: false, run: failed }));
  // Only what the card's type holds, so an older app on a phone still reads it.
  assert.deepEqual(Object.keys(activityState(state, "c1", finished, true)).sort(), ["finishedAt", "label", "phase", "startedAt", "steps"]);
});
