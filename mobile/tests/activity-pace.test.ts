import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVITY_MIN_INTERVAL_MS, ACTIVITY_QUIET_MS, createCoalescedPacer, WIDGET_MIN_INTERVAL_MS, WIDGET_QUIET_MS } from "../src/state/activityPace";

test("createCoalescedPacer coalesces rapid bursts and enforces minIntervalMs", async () => {
  let runs = 0;
  let clock = 1000;
  const pacer = createCoalescedPacer({
    quietMs: 15,
    minIntervalMs: 80,
    now: () => clock,
    run: () => {
      runs += 1;
    },
  });

  // Burst of 10 rapid schedule calls collapses into a single run after quietMs.
  for (let i = 0; i < 10; i++) pacer.schedule();
  assert.equal(pacer.pending(), true);
  assert.equal(runs, 0);

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 1);
  assert.equal(pacer.pending(), false);

  // Another burst right after respects minIntervalMs (80 ms from lastRun).
  clock += 10;
  pacer.schedule();
  pacer.schedule();
  assert.equal(pacer.pending(), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 1);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 2);
  assert.equal(pacer.pending(), false);
});

test("createCoalescedPacer flushNow runs immediately and leaves no pending timer", () => {
  let runs = 0;
  const pacer = createCoalescedPacer({
    quietMs: WIDGET_QUIET_MS,
    minIntervalMs: WIDGET_MIN_INTERVAL_MS,
    run: () => {
      runs += 1;
    },
  });

  pacer.schedule();
  assert.equal(pacer.pending(), true);
  pacer.flushNow();
  assert.equal(runs, 1);
  assert.equal(pacer.pending(), false);

  // Sanity check exported pacing constants for widgets and Live Activities.
  assert.ok(WIDGET_MIN_INTERVAL_MS >= 10_000);
  assert.ok(ACTIVITY_MIN_INTERVAL_MS >= 1000);
  assert.ok(ACTIVITY_QUIET_MS > 0);
});
