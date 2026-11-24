// The live line's shimmer steps (src/ui/shimmerSteps.ts): a sweep in a few native steps, then a rest with
// no updates at all, and nothing left running once it is stopped. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createShimmerCoordinator,
  SHIMMER_MAX_MS,
  SHIMMER_PAUSE_MS,
  SHIMMER_STEPS,
  SHIMMER_SWEEP_MS,
  startShimmerSteps,
} from "../src/ui/shimmerSteps";

test("a sweep steps from just past the start to the end, then rests before the next", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const values: number[] = [];
  const stop = startShimmerSteps({ setValue: (value) => values.push(value) });
  const step = SHIMMER_SWEEP_MS / SHIMMER_STEPS;

  // Node's mock clock runs one timer per tick, so the sweep is ticked a step at a time.
  for (let i = 0; i < SHIMMER_STEPS; i++) t.mock.timers.tick(step);
  assert.equal(values.length, SHIMMER_STEPS);
  assert.equal(values[0], 1 / SHIMMER_STEPS);
  assert.equal(values.at(-1), 1);

  // The rest: no update while the band sits off the line.
  t.mock.timers.tick(SHIMMER_PAUSE_MS);
  assert.equal(values.length, SHIMMER_STEPS);
  t.mock.timers.tick(step);
  assert.equal(values.length, SHIMMER_STEPS + 1);
  assert.equal(values.at(-1), 1 / SHIMMER_STEPS);
  stop();
});

test("stopping leaves no timer behind", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const values: number[] = [];
  const stop = startShimmerSteps({ setValue: (value) => values.push(value) });
  t.mock.timers.tick(SHIMMER_SWEEP_MS / SHIMMER_STEPS);
  stop();
  const seen = values.length;
  t.mock.timers.tick(60_000);
  assert.equal(values.length, seen);
});

test("a whole cycle is a handful of updates a second, not a frame loop", () => {
  const perSecond = SHIMMER_STEPS / ((SHIMMER_SWEEP_MS + SHIMMER_PAUSE_MS) / 1000);
  assert.ok(perSecond < 6, `${perSecond.toFixed(1)} updates a second`);
});

test("long-running shimmer stops after SHIMMER_MAX_MS and fires onDone", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const values: number[] = [];
  let doneCalls = 0;
  const stop = startShimmerSteps(
    { setValue: (value) => values.push(value) },
    { onDone: () => { doneCalls += 1; } },
  );
  assert.equal(SHIMMER_MAX_MS, 10_000);
  // Advance past 10 s in step-sized ticks.
  for (let ms = 0; ms < 12_000; ms += 100) t.mock.timers.tick(100);
  assert.equal(doneCalls, 1);
  assert.equal(values.at(-1), 0, "resets progress to 0 on expiry");
  const countAtStop = values.length;
  t.mock.timers.tick(60_000);
  assert.equal(values.length, countAtStop, "no more updates after 10 s cap");
  stop();
});

test("shimmer coordinator allows only one active shimmer at a time and hands off on release", () => {
  const coord = createShimmerCoordinator();
  let notifications = 0;
  const unsub = coord.subscribe(() => {
    notifications += 1;
  });
  assert.equal(coord.acquire("step-1"), true);
  assert.equal(coord.acquire("step-2"), false);
  assert.equal(coord.activeId(), "step-1");
  const beforeRelease = notifications;
  coord.release("step-1");
  assert.equal(coord.activeId(), null);
  assert.equal(notifications, beforeRelease + 1);
  assert.equal(coord.acquire("step-2"), true);
  assert.equal(coord.activeId(), "step-2");
  unsub();
});
