import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isLedgerEnabled, ledgerSnapshot, resetLedger, setLedgerEnabled, trackResource } from "../src/state/ledger";

afterEach(() => {
  resetLedger();
  setLedgerEnabled(undefined);
});

test("release mode (disabled) returns a zero-cost no-op handle and records nothing", () => {
  setLedgerEnabled(false);
  assert.equal(isLedgerEnabled(), false);
  const a = trackResource("timer", "useElapsedClock", "tick");
  const b = trackResource("animation", "Shimmer", "sweep");
  assert.equal(a, b, "disabled mode reuses a single frozen no-op handle");
  a.bump(5);
  a.fail("timeout");
  a.release();
  const snap = ledgerSnapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.totalActive, 0);
  assert.equal(snap.recentStopped.length, 0);
  assert.equal(snap.counters.timer, 0);
});

test("enabled ledger tracks start, ticks, failures, stop, and reports zero active after background cleanup", () => {
  setLedgerEnabled(true);
  const loop = trackResource("animation", "BotAvatar", "working-loop", "host-1");
  const timer = trackResource("timer", "useElapsedClock", "1s-clock");
  const poll = trackResource("poll", "link.sync", "long-poll", "host-1");
  const feed = trackResource("feed", "useFeed", "screen-viewer", "host-1");
  const keepAwake = trackResource("keep-awake", "Remote", "visible-feed", "host-1");

  loop.bump(3);
  timer.bump();
  poll.fail("aborted");

  const activeSnap = ledgerSnapshot();
  assert.equal(activeSnap.totalActive, 5);
  assert.equal(activeSnap.activeByKind.animation, 1);
  assert.equal(activeSnap.activeByKind.timer, 1);
  assert.equal(activeSnap.activeByKind.poll, 1);
  assert.equal(activeSnap.activeByKind.feed, 1);
  assert.equal(activeSnap.activeByKind["keep-awake"], 1);
  assert.equal(activeSnap.active.find((e) => e.owner === "BotAvatar")?.ticks, 3);
  assert.equal(activeSnap.active.find((e) => e.owner === "link.sync")?.lastFailure, "aborted");

  // Simulate app going to background: every app-owned loop, timer, poll, feed, keep-awake releases.
  loop.release();
  timer.release();
  poll.release();
  feed.release();
  keepAwake.release();
  // Releasing twice is idempotent.
  poll.release();

  const bgSnap = ledgerSnapshot();
  assert.equal(bgSnap.totalActive, 0);
  assert.equal(bgSnap.activeByKind.animation, 0);
  assert.equal(bgSnap.activeByKind.timer, 0);
  assert.equal(bgSnap.activeByKind.poll, 0);
  assert.equal(bgSnap.activeByKind.feed, 0);
  assert.equal(bgSnap.activeByKind["keep-awake"], 0);
  assert.equal(bgSnap.recentStopped.length, 5);
  assert.ok(bgSnap.recentStopped.every((e) => typeof e.stoppedAt === "number" && e.stoppedAt >= e.startedAt));
});
