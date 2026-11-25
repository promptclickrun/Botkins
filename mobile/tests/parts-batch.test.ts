import assert from "node:assert/strict";
import { test } from "node:test";
import { createPartsBatcher, isSummaryOnlyParts, isTextOnlyParts, SUMMARY_FLUSH_MS } from "../src/state/partsBatch";
import { applyParts, forgetComputer, useApp } from "../src/state/store";

test("partsBatcher coalesces multiple text-only ticks into one frame flush", () => {
  const commits: Record<string, unknown>[] = [];
  const callbacks: Array<() => void> = [];
  const batcher = createPartsBatcher(
    (parts) => commits.push(parts),
    {
      schedule(fn) {
        callbacks.push(fn);
        return callbacks.length;
      },
      cancel() {},
    },
  );

  batcher.push({ "text:c1": { stream: "Hel" } });
  batcher.push({ "text:c1": { stream: "Hello" } });
  batcher.push({ "text:c1": { stream: "Hello world" } });

  assert.equal(commits.length, 0, "text ticks wait for the next animation frame");
  assert.equal(callbacks.length, 1, "only one frame callback is scheduled");

  callbacks[0]!();
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], { "text:c1": { stream: "Hello world" } });
});

test("partsBatcher flushes pending text atomically before structural updates", () => {
  const commits: Record<string, unknown>[] = [];
  let cancelled = 0;
  const batcher = createPartsBatcher(
    (parts) => commits.push(parts),
    {
      schedule() {
        return 1;
      },
      cancel() {
        cancelled++;
      },
    },
  );

  batcher.push({ "text:c1": { stream: "partial" } });
  batcher.push({ "chat:c1": { messages: [{ id: "m1" }] }, "text:c1": null });

  assert.equal(cancelled, 1, "pending frame callback is cancelled");
  assert.equal(commits.length, 1, "merged into one atomic commit");
  assert.deepEqual(commits[0], { "text:c1": null, "chat:c1": { messages: [{ id: "m1" }] } });
});

test("applyParts keeps parts, chats, and running identities unchanged on text-only ticks", () => {
  forgetComputer();
  applyParts({
    chats: [{ id: "c1", title: "One" }],
    live: { streams: { c1: true }, thinking: {}, requests: [], queued: {}, working: {} },
    "run:c1": { id: "r1", status: "running", steps: [] },
  });
  const before = useApp.getState();

  assert.equal(isTextOnlyParts({ "text:c1": { stream: "hi" } }), true);
  applyParts({ "text:c1": { stream: "hi" } });
  const after = useApp.getState();

  assert.equal(after.parts, before.parts, "parts reference unchanged on text-only tick");
  assert.equal(after.chats, before.chats, "chats reference unchanged on text-only tick");
  assert.equal(after.running, before.running, "running reference unchanged on text-only tick");
  assert.equal(after.texts.c1?.stream, "hi");

  // Re-sending an identical run does not churn the running map reference.
  applyParts({ "run:c1": { id: "r1", status: "running", steps: [] } });
  assert.equal(useApp.getState().running, after.running);
});

/** A batcher on a clock and timers the test moves by hand. */
function paced() {
  const commits: Record<string, unknown>[] = [];
  const frames: Array<() => void> = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const clock = { now: 10_000 };
  const batcher = createPartsBatcher((parts) => commits.push(parts), {
    schedule(fn) {
      frames.push(fn);
      return frames.length;
    },
    cancel() {},
    later(fn, ms) {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return timer;
    },
    cancelLater(handle) {
      (handle as { live: boolean }).live = false;
    },
    now: () => clock.now,
  });
  return { commits, frames, timers, clock, batcher };
}

test("run summaries alone reach the store once per second, with the first at once", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const commits: Record<string, unknown>[] = [];
  const batcher = createPartsBatcher((parts) => commits.push(parts));
  assert.equal(isSummaryOnlyParts({ runs: [] }), true);
  assert.equal(isSummaryOnlyParts({ runs: [], live: {} }), false);
  batcher.push({ runs: [{ id: "r", stepCount: 1 }] });
  assert.equal(commits.length, 1);

  for (let step = 2; step <= 31; step++) {
    t.mock.timers.tick(30);
    batcher.push({ runs: [{ id: "r", stepCount: step }] });
  }
  assert.equal(commits.length, 1);
  t.mock.timers.tick(SUMMARY_FLUSH_MS - 30 * 30);
  assert.deepEqual(commits[1], { runs: [{ id: "r", stepCount: 31 }] });
  t.mock.timers.tick(SUMMARY_FLUSH_MS);
  batcher.push({ runs: [{ id: "r", stepCount: 32 }] });
  assert.equal(commits.length, 3);
});

test("waiting run summaries go with whatever comes next, in order", () => {
  const { commits, frames, timers, clock, batcher } = paced();
  batcher.push({ runs: ["first"] });
  clock.now += 100;
  batcher.push({ runs: ["held"] });
  assert.equal(commits.length, 1);

  // A structural part takes them along in the same store update.
  batcher.push({ live: { streams: {} } });
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[1], { runs: ["held"], live: { streams: {} } });
  assert.equal(timers[0]!.live, false, "and their timer is cancelled");

  // So does a reply's text, with its frame.
  clock.now += 100;
  batcher.push({ runs: ["held again"] });
  batcher.push({ "text:c1": { stream: "Hi" } });
  assert.equal(timers[1]!.live, false);
  assert.equal(commits.length, 2, "text still waits for its frame");
  frames.at(-1)!();
  assert.deepEqual(commits[2], { runs: ["held again"], "text:c1": { stream: "Hi" } });

  // A flush (the app goes to the background) leaves nothing behind.
  clock.now += 100;
  batcher.push({ runs: ["last"] });
  batcher.flush();
  assert.deepEqual(commits[3], { runs: ["last"] });
});

test("a burst from a faster computer paints at most four times a second and completion clears the pending text", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const commits: Record<string, unknown>[] = [];
  const batch = createPartsBatcher((parts) => commits.push(parts));
  for (let n = 1; n <= 50; n++) {
    batch.push({ "text:c": { stream: "x".repeat(n) } });
    t.mock.timers.tick(20);
  }
  assert.equal(commits.length, 4, "fifty incoming bodies share four paints");
  batch.push({ "text:c": { stream: "last" } });
  batch.push({ "chat:c": { messages: ["finished"] }, "text:c": null });
  t.mock.timers.tick(1000);
  assert.deepEqual(commits.at(-1), { "chat:c": { messages: ["finished"] }, "text:c": null });
  assert.equal(commits.length, 5);
});

test("a summary timer never holds the start, end or removal of a run", () => {
  const { commits, clock, batcher } = paced();
  const run = { id: "r", status: "Working", stepCount: 1 };
  batcher.push({ runs: [run] });
  clock.now += 20;
  batcher.push({ runs: [{ ...run, stepCount: 2 }] });
  assert.equal(commits.length, 1);
  const ended = { ...run, status: "Completed", stepCount: 2 };
  batcher.push({ runs: [ended] });
  assert.deepEqual(commits.at(-1), { runs: [ended] });
  const another = { ...run, id: "new" };
  batcher.push({ runs: [another, ended] });
  assert.deepEqual(commits.at(-1), { runs: [another, ended] });
  batcher.push({ runs: [] });
  assert.deepEqual(commits.at(-1), { runs: [] });
});
