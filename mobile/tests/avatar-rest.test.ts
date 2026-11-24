import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { AVATAR_ANIMATIONS_WARNING, readAvatarAnimations } from "../src/state/avatarPrefs";
import {
  avatarBeat,
  avatarCanMove,
  avatarMotion,
  nextPass,
  REST_BEAT_MS,
  REST_LATE_MS,
  REST_SPREAD_MS,
  schedulePasses,
  scheduleRestPasses,
} from "../src/ui/avatarRest";

test("only working states loop, resting states pause, and outcomes play once", () => {
  for (const state of ["thinking", "planning", "browsing", "coding", "working", "retrying", "talking", "listening"] as const)
    assert.equal(avatarMotion[state], "loop", state);
  for (const state of ["idle", "waiting", "needs-input", "pending", "sleeping"] as const)
    assert.equal(avatarMotion[state], "rest", state);
  for (const state of ["completed", "happy", "error", "like", "love", "laugh", "sad"] as const)
    assert.equal(avatarMotion[state], "once", state);
});

test("phone avatar animation is off unless the person enables it", () => {
  assert.equal(readAvatarAnimations(undefined), true, "a phone that never chose gets motion, as the desktop does");
  assert.equal(readAvatarAnimations("yes"), true, "an invalid saved value falls back to the default");
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

// The owner's rule (2026-11-24, after OpenBot): the agent you're with moves; lists hold still.
// Only these places may ask for motion. Everything else (Home, the Chats list, Work, Spaces, Market,
// pickers, message and reply rows) holds its state's pose. Add a place only with the owner's word.
const MOVING_SCREENS = ["src/features/bots/BotPage.tsx"];
const MOVING_FACES = [
  "src/features/chat/ChatScreen.tsx", // the chat's header face (one bot, or a group's two)
  "src/features/chat/StatusCapsule.tsx", // the face in the working capsule, shown while a turn runs
  "src/features/voice/VoiceDock.tsx", // live voice
  "src/features/bots/LookStage.tsx", // the look editor's preview: part of the bot's own page, as on the desktop
];
const root = new URL("..", import.meta.url).pathname;
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [relative(root, path)] : [];
  });
}
const screens = [...sources(join(root, "src/features")), ...sources(join(root, "src/app"))];

test("only a bot's page wraps itself in AvatarMotion", () => {
  const moving = screens.filter((file) => /<AvatarMotion(?![^>]*on=\{false\})[^>]*>/.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(moving, MOVING_SCREENS);
});

test("in a chat only the header face, the working capsule's face and live voice move", () => {
  const asking = new Map<string, number>();
  for (const file of screens) {
    const text = readFileSync(join(root, file), "utf8");
    // `animated` on its own, `animated={true}` or `animated={something}`: anything but `animated={false}`,
    // or a face handing its caller's `animated={animated}` on (GroupFace).
    const tags = text.match(/<(?:BotAvatar|GroupFace)\b[\s\S]*?\/>/g) ?? [];
    const count = tags.filter((tag) => /\sanimated(?!=\{(?:false|animated)\})(?:=\{[^}]*\})?[\s/]/.test(tag)).length;
    if (count) asking.set(file, count);
  }
  assert.deepEqual([...asking.keys()].sort(), [...MOVING_FACES].sort());
  assert.equal(asking.get("src/features/chat/ChatScreen.tsx"), 2, "the header's group face and single face");
  assert.equal(asking.get("src/features/chat/StatusCapsule.tsx"), 1);
  assert.equal(asking.get("src/features/voice/VoiceDock.tsx"), 2, "the dock's face and its quiet row");
});

test("a moving avatar still yields to the phone's setting and Reduce Motion", () => {
  for (const asked of [true, undefined]) {
    const requested = asked ?? true;
    assert.equal(avatarCanMove(true, false, requested), true);
    assert.equal(avatarCanMove(true, true, requested), false, "Reduce Motion stills everything");
    assert.equal(avatarCanMove(false, false, requested), false, "the phone's setting stills everything");
  }
  assert.equal(avatarCanMove(true, false, false), false, "a list or a row holds still");
});
