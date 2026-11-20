// The computer's screen, live, in a chat and in the side pane (src/features/pane/screenLive.ts):
// which gate applies, how large and how often pictures are asked for, which card is live, the
// words, and that the computer is told once when nothing shows the screen any more.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardRole, cardSize, feedPlan, inWindow, newestScreen, PLANS, screenGate, screenLabel, screenLook, screenWatchers, type Seen, WORDS } from "../src/features/pane/screenLive";
import type { ChatPane, HostPart, PanePanel } from "../src/link/types";

const panel = (id: string, kind: PanePanel["kind"] = "screen"): PanePanel => ({ id, kind, title: id, botId: "bot", createdAt: 1, updatedAt: 1 });
const pane = (...panels: PanePanel[]): ChatPane => ({ panels, active: panels[0]?.id ?? null });
const host = (screen: HostPart["screen"], more: Partial<HostPart> = {}): HostPart => ({ screen, ...more });
const CAPS = ["screen-v1", "credentials-v1"];

// What the computer takes (link-host/screen.mjs: `clamp(maxWidth, 480, 1920)`, `clamp(quality, 30, 85)`)
// and how long it counts a phone as watching after its last ask (VIEWER_MS).
const WIDTHS = [480, 1920];
const QUALITIES = [30, 85];
const VIEWER_MS = 5000;

test("the card asks for small pictures slowly, the pane for more, and the relay for less", () => {
  const card = feedPlan("card", "direct");
  const pane = feedPlan("pane", "direct");
  const cardAway = feedPlan("card", "relay");
  const paneAway = feedPlan("pane", "relay");
  assert.ok(card.maxWidth < pane.maxWidth && card.gapMs > pane.gapMs);
  assert.ok(cardAway.maxWidth <= card.maxWidth && cardAway.quality <= card.quality && cardAway.gapMs > card.gapMs);
  assert.ok(paneAway.maxWidth < pane.maxWidth && paneAway.quality < pane.quality && paneAway.gapMs > pane.gapMs);
  // No route yet counts as direct: the phone always tries the computer's own addresses first.
  assert.deepEqual(feedPlan("card", null), card);
  for (const place of Object.values(PLANS))
    for (const plan of Object.values(place)) {
      assert.ok(plan.maxWidth >= WIDTHS[0]! && plan.maxWidth <= WIDTHS[1]!, "a width the computer takes as it is");
      assert.ok(plan.quality >= QUALITIES[0]! && plan.quality <= QUALITIES[1]!, "a quality the computer takes as it is");
      // The next ask arrives before the computer stops counting the phone as watching, with a second to spare.
      assert.ok(plan.gapMs > 0 && plan.gapMs <= VIEWER_MS - 1000);
    }
});

test("the gates come in order: the app on the computer, the screen's level, then the owner check", () => {
  assert.deepEqual(screenGate({ capabilities: undefined, host: host("view"), owner: "open" }), { kind: "waiting" });
  assert.deepEqual(screenGate({ capabilities: ["credentials-v1"], host: host("off"), owner: "unasked" }), { kind: "update" });
  assert.deepEqual(screenGate({ capabilities: CAPS, host: host("off"), owner: "open" }), { kind: "off", headless: false });
  assert.deepEqual(screenGate({ capabilities: CAPS, host: host("off", { headless: true }), owner: "unasked" }), { kind: "off", headless: true });
  // No host part: off, as Settings › Screen reads it.
  assert.deepEqual(screenGate({ capabilities: CAPS, host: undefined, owner: "open" }), { kind: "off", headless: false });
  // A bot showing the screen never asks for Face ID by itself: covered until a tap.
  assert.deepEqual(screenGate({ capabilities: CAPS, host: host("view"), owner: "unasked" }), { kind: "covered", checking: false });
  assert.deepEqual(screenGate({ capabilities: CAPS, host: host("control"), owner: "checking" }), { kind: "covered", checking: true });
  assert.deepEqual(screenGate({ capabilities: CAPS, host: host("control"), owner: "locked" }), { kind: "covered", checking: false });
  assert.deepEqual(screenGate({ capabilities: CAPS, host: host("view"), owner: "open" }), { kind: "open" });
});

test("only the card of the newest screen tab is live", () => {
  const two = pane(panel("s1"), panel("t1", "table"), panel("s2"), panel("w1", "web"));
  assert.equal(newestScreen(two)?.id, "s2");
  assert.equal(newestScreen(pane(panel("t1", "table"))), undefined);
  assert.equal(newestScreen(undefined), undefined);
  assert.equal(cardRole(true, two, "s2"), "live");
  assert.equal(cardRole(true, two, "s1"), "older");
  // A card whose tab made room for others, while a newer screen tab is there: older too.
  assert.equal(cardRole(true, two, "gone"), "older");
  // No screen tab any more (or no pane at all): the screen is no longer shown.
  assert.equal(cardRole(true, pane(panel("t1", "table")), "s1"), "gone");
  assert.equal(cardRole(true, undefined, "s1"), "gone");
  // The chat isn't loaded yet: nothing is decided.
  assert.equal(cardRole(false, undefined, "s1"), "waiting");
});

const seen = (more: Partial<Seen> = {}): Seen => ({ gate: { kind: "open" }, role: "live", wants: true, online: true, problem: undefined, feed: "live", hasPicture: true, ...more });

test("what the picture shows while it is live, and while it can't be", () => {
  assert.deepEqual(screenLook(seen()), { live: true, dim: false, busy: false, line: null });
  // Starting: a spinner until the first picture.
  assert.deepEqual(screenLook(seen({ feed: "starting", hasPicture: false })), { live: false, dim: false, busy: true, line: null });
  // The computer can't be reached, or the picture was lost: the last one stays, dimmed, with a line.
  assert.deepEqual(screenLook(seen({ online: false })), { live: false, dim: true, busy: false, line: WORDS.away });
  assert.deepEqual(screenLook(seen({ online: false, hasPicture: false })), { live: false, dim: false, busy: false, line: WORDS.away });
  assert.deepEqual(screenLook(seen({ feed: "retrying" })), { live: false, dim: true, busy: false, line: WORDS.retrying });
  assert.deepEqual(screenLook(seen({ feed: "failed" })), { live: false, dim: true, busy: false, line: WORDS.lost });
  // The computer says why it can't show it.
  assert.deepEqual(screenLook(seen({ problem: "Allow screen recording for Botkins on your computer." })), { live: false, dim: true, busy: false, line: "Allow screen recording for Botkins on your computer." });
  assert.equal(screenLook(seen({ problem: "", hasPicture: false })).line, WORDS.cantSee);
  // Out of view, under the pane or in the background: the picture holds still, with nothing to say.
  assert.deepEqual(screenLook(seen({ wants: false })), { live: false, dim: false, busy: false, line: null });
  assert.deepEqual(screenLook(seen({ wants: false, hasPicture: false, feed: "starting" })), { live: false, dim: false, busy: false, line: null });
  // An older card, or one whose tab is gone: a picture it still holds is dimmed under the line.
  assert.deepEqual(screenLook(seen({ role: "older" })), { live: false, dim: true, busy: false, line: WORDS.older });
  assert.deepEqual(screenLook(seen({ role: "gone", hasPicture: false })), { live: false, dim: false, busy: false, line: WORDS.gone });
  assert.equal(screenLook(seen({ role: "gone", wants: false })).line, WORDS.gone);
});

test("the words for each gate, and what VoiceOver reads", () => {
  assert.equal(WORDS.update, "Update the app on your computer");
  assert.equal(WORDS.show, "Show screen");
  assert.match(WORDS.off(false), /^Screen is off/);
  assert.match(WORDS.off(false), /on your computer/);
  assert.match(WORDS.off(true), /Settings, on this computer's page/);
  const live = screenLabel("card", { live: true, dim: false, busy: false, line: null });
  assert.match(live, /computer's screen/);
  assert.match(live, /live/);
  assert.match(live, /[Tt]ap to open/);
  assert.equal(screenLabel("card", { live: false, dim: true, busy: false, line: WORDS.away }), "Your computer's screen. " + WORDS.away);
  assert.doesNotMatch(screenLabel("pane", { live: true, dim: false, busy: false, line: null }), /[Tt]ap/);
  // Sentence case and "your computer", never "desktop" or "host".
  for (const words of [WORDS.update, WORDS.off(true), WORDS.off(false), WORDS.away, WORDS.lost, WORDS.older, WORDS.gone, WORDS.covered, WORDS.control, WORDS.watch]) {
    assert.match(words, /^[A-Z]/);
    assert.doesNotMatch(words, /desktop|host/i);
  }
});

test("a card counts as in view while any of it is inside the window", () => {
  assert.equal(inWindow({ y: 100, height: 200 }, 800), true);
  assert.equal(inWindow({ y: -150, height: 200 }, 800), true);
  assert.equal(inWindow({ y: 790, height: 200 }, 800), true);
  assert.equal(inWindow({ y: -200, height: 200 }, 800), false);
  assert.equal(inWindow({ y: 800, height: 200 }, 800), false);
  // Not laid out (or not on screen at all): measured as zeros.
  assert.equal(inWindow({ y: 0, height: 0 }, 800), false);
});

test("the card takes the chat's width at the screen's own proportions, and never most of the window", () => {
  assert.deepEqual(cardSize(320, 1.6, 400), { width: 320, height: 200 });
  // A tall display is narrowed to keep its proportions.
  assert.deepEqual(cardSize(320, 0.5, 400), { width: 200, height: 400 });
  assert.deepEqual(cardSize(0, 1.6, 400), { width: 0, height: 0 });
  assert.deepEqual(cardSize(320, Number.NaN, 400), { width: 320, height: 200 });
});

function clock() {
  let now = 0;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let next = 1;
  return {
    set: (run: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clear: (id: unknown) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    tick(ms: number) {
      now += ms;
      for (const timer of timers.filter((item) => item.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

test("when nothing shows the screen any more, the computer is told once", () => {
  const time = clock();
  let stops = 0;
  const watch = screenWatchers(() => stops++, 2000, time);
  const card = watch.hold();
  const pane = watch.hold();
  card();
  time.tick(5000);
  assert.equal(stops, 0, "the pane still shows it");
  pane();
  pane();
  time.tick(1999);
  assert.equal(stops, 0, "a moment's grace");
  time.tick(1);
  assert.equal(stops, 1);
  time.tick(10_000);
  assert.equal(stops, 1, "once");

  // The card hands over to the pane within the grace: nothing is said.
  const again = watch.hold();
  again();
  time.tick(500);
  const next = watch.hold();
  time.tick(5000);
  assert.equal(stops, 1);
  // The app went to the background: at once, before the phone sleeps.
  next(true);
  assert.equal(stops, 2);
});

test("Settings › Screen stops by itself, so its time on the screen is never stopped twice", () => {
  const time = clock();
  let stops = 0;
  const watch = screenWatchers(() => stops++, 2000, time);
  // The card lets go as the Screen opens over the chat; the Screen takes over within the grace.
  const card = watch.hold();
  card();
  const remote = watch.hold({ own: true });
  time.tick(5000);
  assert.equal(stops, 0, "the Screen is still watching");
  remote();
  time.tick(5000);
  assert.equal(stops, 0, "the Screen told the computer itself");
  // The card comes back while the Screen is still closing: the card's own stop is still owed.
  const remote2 = watch.hold({ own: true });
  const card2 = watch.hold();
  remote2();
  card2();
  time.tick(2000);
  assert.equal(stops, 1);
  // Nothing held and nothing asked: nothing to say.
  const idle = watch.hold({ own: true });
  idle();
  time.tick(5000);
  assert.equal(stops, 1);
});
