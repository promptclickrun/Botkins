// The live line's shimmer steps (src/ui/shimmer.ts): a sweep in a few native steps, then a rest with
// no updates at all, and nothing left running once it is stopped. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHIMMER_PAUSE_MS, SHIMMER_STEPS, SHIMMER_SWEEP_MS, startShimmerSteps } from "../src/ui/shimmer";

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
