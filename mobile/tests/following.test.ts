// Which chats the link follows (src/state/following.ts): a chat that was just left is kept a little
// longer, so coming straight back to it tells the computer nothing; then it is let go as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollowing, LINGER_MS, RETURN_GRACE_MS } from "../src/state/following";

/** A following on a clock and timers the test moves by hand. `sent` is every set the link was told. */
function following() {
  const sent: string[][] = [];
  const timers: { fn: () => void; at: number; live: boolean }[] = [];
  const phone = { now: 1_000_000, away: false };
  const follow = createFollowing({
    send: (ids) => sent.push(ids),
    away: () => phone.away,
    now: () => phone.now,
    setTimer(fn, ms) {
      const timer = { fn, at: phone.now + ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer(handle) {
      (handle as { live: boolean }).live = false;
    },
  });
  /** Moves the clock, running each timer that comes due, in order. */
  const pass = (ms: number) => {
    const end = phone.now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      phone.now = Math.max(phone.now, due.at);
      due.live = false;
      due.fn();
    }
    phone.now = end;
  };
  return { follow, sent, phone, pass, timers };
}

test("a chat covered by a page and shown again within the linger tells the computer nothing", () => {
  const { follow, sent, pass } = following();
  const stop = follow.watch("a");
  assert.deepEqual(sent, [["a"]]);
  // Ten times: a page over the chat, Control Center, Face ID, another app for a moment.
  let last = stop;
  for (let n = 0; n < 10; n++) {
    last();
    assert.deepEqual(follow.shown(), [], "it is not on screen meanwhile");
    assert.deepEqual(follow.ids(), ["a"], "but still followed");
    pass(LINGER_MS - 1);
    last = follow.watch("a");
    pass(LINGER_MS * 2);
  }
  assert.deepEqual(sent, [["a"]], "the link heard of the chat once");
  assert.deepEqual(follow.shown(), ["a"]);
});

test("a chat left for longer is let go, so nothing out of view is followed for long", () => {
  const { follow, sent, pass } = following();
  follow.watch("a")();
  pass(LINGER_MS - 1);
  assert.deepEqual(sent, [["a"]]);
  pass(1);
  assert.deepEqual(sent, [["a"], []]);
  assert.deepEqual(follow.ids(), []);
});

test("only one chat is kept, and two screens on one chat count once", () => {
  const { follow, sent, pass } = following();
  const first = follow.watch("a");
  const sheet = follow.watch("a");
  assert.deepEqual(sent, [["a"]], "the activity sheet over the chat adds nothing");
  sheet();
  assert.deepEqual(follow.ids(), ["a"]);
  first();
  // Another chat opens while the first is kept: both are followed, the one on screen first.
  const second = follow.watch("b");
  assert.deepEqual(sent.at(-1), ["b", "a"]);
  // Leaving that one too keeps it and lets the older one go.
  second();
  assert.deepEqual(sent.at(-1), ["b"]);
  pass(LINGER_MS);
  assert.deepEqual(sent.at(-1), []);
  assert.equal(sent.length, 4);
});

test("a timer that came due in the background lets nothing go until the app has been in front a moment", () => {
  const { follow, sent, phone, pass } = following();
  const stop = follow.watch("a");
  // The app goes to the background: the chat's screen stops watching and the phone suspends the app.
  phone.away = true;
  stop();
  pass(LINGER_MS * 4);
  assert.deepEqual(sent, [["a"]], "the overdue timer let nothing go");
  // In front again: the screen says it is on show a moment after the app does.
  phone.away = false;
  follow.returned();
  pass(RETURN_GRACE_MS - 1);
  follow.watch("a");
  pass(LINGER_MS);
  assert.deepEqual(sent, [["a"]], "coming back told the link nothing, so its quick check ran undisturbed");
});

test("back in front on another screen, the kept chat is let go after the moment", () => {
  const { follow, sent, phone, pass } = following();
  const stop = follow.watch("a");
  phone.away = true;
  stop();
  pass(LINGER_MS * 4);
  phone.away = false;
  follow.returned();
  pass(RETURN_GRACE_MS);
  assert.deepEqual(sent, [["a"], []]);
});

test("a wake in the background and another computer let the kept chat go at once", () => {
  const { follow, sent, phone } = following();
  const stop = follow.watch("a");
  phone.away = true;
  stop();
  follow.release();
  assert.deepEqual(sent, [["a"], []], "a push's sync brings no chat's page");
  follow.release();
  assert.equal(sent.length, 2, "letting go twice says it once");
  // A chat on screen is never let go this way.
  phone.away = false;
  follow.watch("b");
  follow.release();
  assert.deepEqual(sent.at(-1), ["b"]);
  assert.equal(sent.length, 3);
});
