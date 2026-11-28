// The thinking slider's numbers (src/features/models/thinking.ts): stops, touches, bubbles and the Fast switch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bubbles, bubbleShows, fastCanChange, fastFlip, heatOf, isOff, moodAt, shortEffort, SLIDER, stopAt, stopX } from "../src/features/models/thinking";

const WIDTH = 294;

test("the knob's stops run from one end of the track to the other, evenly", () => {
  const first = stopX(0, 8, WIDTH);
  const last = stopX(7, 8, WIDTH);
  assert.equal(first, SLIDER.pad + SLIDER.knob / 2);
  assert.equal(last, WIDTH - SLIDER.pad - SLIDER.knob / 2);
  const step = stopX(1, 8, WIDTH) - first;
  for (let i = 1; i < 8; i++) assert.ok(Math.abs(stopX(i, 8, WIDTH) - stopX(i - 1, 8, WIDTH) - step) < 1e-9);
  // One level alone sits in the middle; an index past either end is held at the end.
  assert.equal(stopX(0, 1, WIDTH), WIDTH / 2);
  assert.equal(stopX(99, 8, WIDTH), last);
  assert.equal(stopX(-3, 8, WIDTH), first);
});

test("a touch means the nearest stop, and every stop is its own", () => {
  for (const count of [2, 3, 5, 8]) for (let i = 0; i < count; i++) assert.equal(stopAt(stopX(i, count, WIDTH), count, WIDTH), i);
  assert.equal(stopAt(-40, 5, WIDTH), 0);
  assert.equal(stopAt(WIDTH + 40, 5, WIDTH), 4);
  const between = (stopX(1, 5, WIDTH) + stopX(2, 5, WIDTH)) / 2;
  assert.equal(stopAt(between - 1, 5, WIDTH), 1);
  assert.equal(stopAt(between + 1, 5, WIDTH), 2);
  // No stops to tell apart, or a track with no width yet.
  assert.equal(stopAt(100, 1, WIDTH), 0);
  assert.equal(stopAt(100, 5, 0), 0);
});

test("the bot is asleep with thinking off and hard at work at the top", () => {
  assert.equal(moodAt(0, true), "sleeping");
  assert.equal(moodAt(heatOf(0, 4), false), "idle");
  assert.equal(moodAt(heatOf(2, 5), false), "thinking");
  assert.equal(moodAt(heatOf(4, 5), false), "working");
  assert.equal(heatOf(0, 1), 0);
  assert.ok(isOff("none") && isOff("off") && !isOff("low") && !isOff(undefined));
});

test("level names under the track are short", () => {
  assert.deepEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(shortEffort), ["Off", "Min", "Low", "Med", "High", "X-High", "Max", "Ultra"]);
  assert.ok(shortEffort("some-new-level").length <= 6);
});

test("the track fills behind the knob as the level rises, the same way every time", () => {
  const field = bubbles();
  assert.deepEqual(field, bubbles());
  assert.equal(field.length, SLIDER.bubbles);
  for (const bubble of field) assert.ok(bubble.u > 0 && bubble.u < 1 && bubble.v > 0.1 && bubble.v < 0.9 && bubble.from < 0.9);
  const shown = (index: number, count: number) => field.filter((bubble) => bubbleShows(bubble, heatOf(index, count), stopX(index, count, WIDTH), WIDTH));
  assert.equal(shown(0, 8).length, 0);
  let before = 0;
  for (let i = 1; i < 8; i++) {
    const now = shown(i, 8).length;
    assert.ok(now >= before, "level " + i + " shows no fewer than the one under it");
    before = now;
  }
  assert.ok(before >= 12, "the top level is busy (" + before + ")");
  // No bubble is under the knob or ahead of it.
  const knob = stopX(4, 8, WIDTH);
  for (const bubble of shown(4, 8)) assert.ok(SLIDER.pad + bubble.u * (WIDTH - 2 * SLIDER.pad) < knob - SLIDER.knob / 2);
});

test("the Fast switch saves the model's fast mode or off, and flipping back changes nothing", () => {
  assert.equal(fastFlip(true, { fast: "x" }, "off"), "fast");
  assert.equal(fastFlip(true, { fast: "x", ultrafast: "y" }, "off"), "fast");
  assert.equal(fastFlip(true, { ultrafast: "y" }, "off"), "ultrafast");
  assert.equal(fastFlip(false, { fast: "x" }, "fast"), "off");
  assert.equal(fastFlip(false, { fast: "x" }, "ultrafast"), "off");
  // Back to how it was saved: no edit, so what it follows is kept.
  assert.equal(fastFlip(false, { fast: "x" }, "off"), undefined);
  assert.equal(fastFlip(true, { fast: "x" }, "ultrafast"), undefined);
  // A model with no fast mode: the switch is fixed unless fast mode is on, when it can be turned off.
  assert.ok(!fastCanChange(undefined, "off"));
  assert.ok(fastCanChange(undefined, "fast"));
  assert.ok(fastCanChange({ ultrafast: "y" }, "off"));
});
