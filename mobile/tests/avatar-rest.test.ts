import assert from "node:assert/strict";
import { test } from "node:test";
import { AVATAR_ANIMATIONS_WARNING, readAvatarAnimations } from "../src/state/avatarPrefs";
import { avatarBeat, avatarCanMove, avatarMotion, nextPass, REST_BEAT_MS, REST_LATE_MS, REST_SPREAD_MS, schedulePasses, scheduleRestPasses } from "../src/ui/avatarRest";

test("only working states loop, resting states pause, and outcomes play once", () => {
  for (const state of ["thinking", "planning", "browsing", "coding", "working", "retrying", "talking", "listening"] as const)
    assert.equal(avatarMotion[state], "loop", state);
  for (const state of ["idle", "waiting", "needs-input", "pending", "sleeping"] as const)
    assert.equal(avatarMotion[state], "rest", state);
  for (const state of ["completed", "happy", "error", "like", "love", "laugh", "sad"] as const)
    assert.equal(avatarMotion[state], "once", state);
});

test("phone avatar animation is off unless the person enables it", () => {
  assert.equal(readAvatarAnimations(undefined), false, "older saved preferences");
  assert.equal(readAvatarAnimations("yes"), false, "invalid saved preferences");
  assert.equal(readAvatarAnimations(true), true);
  assert.equal(readAvatarAnimations(false), false);
  assert.equal(AVATAR_ANIMATIONS_WARNING, "May consume battery faster on this phone");
  assert.ok(AVATAR_ANIMATIONS_WARNING.split(" ").length >= 5 && AVATAR_ANIMATIONS_WARNING.split(" ").length <= 8);
  assert.equal(avatarCanMove(false, false, true), false, "the preference wins");
  assert.equal(avatarCanMove(true, true, true), false, "Reduce Motion wins");
  assert.equal(avatarCanMove(true, false, false), false, "the screen may hold still");
  assert.equal(avatarCanMove(true, false, true), true);
});

test("all resting characters wait for the next wall-clock beat, with fixed offsets", () => {
  const names = ["Beacon", "Crumb", ""];
  const offsets = names.map(name => nextPass(0, name) - REST_BEAT_MS);
  assert.notEqual(offsets[0], offsets[1]);
  for (const [index, name] of names.entries()) {
    assert.ok(offsets[index] >= 0 && offsets[index] <= REST_SPREAD_MS);
    for (const now of [0, 1, REST_BEAT_MS - 1, REST_BEAT_MS, REST_BEAT_MS + 100, 1_796_000_000_000]) {
      const nextBeat = (Math.floor(now / REST_BEAT_MS) + 1) * REST_BEAT_MS;
      assert.equal(now + nextPass(now, name), nextBeat + offsets[index]);
    }
  }
});

test("rest timers skip a missed window and rejoin the clock without drift", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const play = t.mock.fn();
  const stop = scheduleRestPasses("Crumb", play);
  const first = nextPass(0, "Crumb");
  t.mock.timers.tick(REST_BEAT_MS + REST_SPREAD_MS + REST_LATE_MS + 1);
  assert.equal(play.mock.callCount(), 0);
  t.mock.timers.tick(REST_BEAT_MS + first - Date.now());
  assert.equal(play.mock.callCount(), 1);
  t.mock.timers.tick(REST_BEAT_MS);
  assert.equal(play.mock.callCount(), 2);
  stop();
  t.mock.timers.tick(REST_BEAT_MS);
  assert.equal(play.mock.callCount(), 2);
});

test("each character has a repeatable first blink and blink period", () => {
  const beacon = avatarBeat("Beacon");
  const crumb = avatarBeat("Crumb");
  for (const key of ["blinkMs", "firstBlinkMs"] as const) assert.notEqual(beacon[key], crumb[key]);
  for (const name of ["Beacon", "Crumb", ""]) {
    const beat = avatarBeat(name);
    assert.deepEqual(beat, avatarBeat(name));
    assert.ok(beat.blinkMs >= 3800 && beat.blinkMs <= 5000);
    assert.ok(beat.firstBlinkMs >= beat.blinkMs * 0.92 && beat.firstBlinkMs < beat.blinkMs * 0.92 + 2200);
  }
});

test("a scheduled pass waits for its beat, repeats, and stops on cleanup", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const play = t.mock.fn();
  const stop = schedulePasses(20_000, 23_400, play);
  t.mock.timers.tick(19_999);
  assert.equal(play.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(play.mock.callCount(), 1);
  t.mock.timers.tick(23_399);
  assert.equal(play.mock.callCount(), 1);
  t.mock.timers.tick(1);
  assert.equal(play.mock.callCount(), 2);
  stop();
  t.mock.timers.tick(30_000);
  assert.equal(play.mock.callCount(), 2);
});

test("a rest pass that starts a little late still plays", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const play = t.mock.fn();
  // The slowest start in the window, and a timer that is 200 ms late on top.
  const name = ["Beacon", "Crumb", "Luna", "Pip", "Wick"].reduce((a, b) => (nextPass(0, a) >= nextPass(0, b) ? a : b));
  const stop = scheduleRestPasses(name, play);
  t.mock.timers.tick(nextPass(0, name) + 200);
  assert.equal(play.mock.callCount(), 1);
  assert.ok(REST_LATE_MS >= 200);
  stop();
});
