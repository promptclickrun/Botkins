import { strict as assert } from "node:assert";
import { test } from "node:test";
import { activeFeedCount, claimScreenFeed } from "../src/features/remote/feedRegistry";
import { runScreenFeed } from "../src/features/remote/screenFeed";
import { ledgerSnapshot, resetLedger, setLedgerEnabled } from "../src/state/ledger";

const frame = { jpeg: "image", display: "1", seq: 1, width: 640, height: 400 };

test("a visible card takes one picture and reports it live only when it has been drawn", async () => {
  const ready = Promise.withResolvers<boolean>();
  const decoding = Promise.withResolvers<void>();
  const states: string[] = [];
  let reads = 0;
  const done = runScreenFeed({ signal: new AbortController().signal, once: true, gapMs: 0,
    read: async () => { reads++; return frame; },
    draw: () => { decoding.resolve(); return ready.promise; },
    report: state => states.push(state),
  });
  await decoding.promise;
  assert.deepEqual(states, []);
  ready.resolve(true);
  await done;
  assert.deepEqual(states, ["live"]);
  assert.equal(reads, 1);
});

test("a late frame after leaving the viewer never reaches the image decoder", async () => {
  const request = Promise.withResolvers<typeof frame>();
  const controller = new AbortController();
  const done = runScreenFeed({ signal: controller.signal, once: false, gapMs: 0,
    read: () => request.promise, draw: () => assert.fail("drew a late frame"), report: () => assert.fail("published a late status"),
  });
  controller.abort();
  request.resolve(frame);
  await done;
});

test("a decode error requests the bytes again and teardown cancels the pending pace timer", async () => {
  const controller = new AbortController();
  const cursors: (number | undefined)[] = [];
  const states: string[] = [];
  const done = runScreenFeed({ signal: controller.signal, once: false, gapMs: 60_000,
    read: async after => { cursors.push(after); return frame; },
    draw: async () => cursors.length > 1,
    report: state => {
      states.push(state);
      if (state === "live") queueMicrotask(() => controller.abort());
    },
  });
  await done;
  assert.deepEqual(cursors, [undefined, undefined]);
  assert.deepEqual(states, ["retrying", "live"]);
});

test("a display switch orders the old drag release before new input; closing drops unsent keys", async t => {
  const { InputSender } = await import("../src/features/remote/input");
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const origFrame = globalThis.requestAnimationFrame, origCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = key => { frames.delete(key); };
  t.after(() => {
    globalThis.requestAnimationFrame = origFrame;
    globalThis.cancelAnimationFrame = origCancel;
  });
  const flush = () => {
    for (const [key, fn] of frames) { frames.delete(key); fn(0); }
  };
  const sent: string[] = [];
  const down = Promise.withResolvers<void>();
  const sender = new InputSender(async (display, events) => {
    sent.push(display + ":" + events.map(event => event.type).join(","));
    if (events[0]?.type === "down") await down.promise;
  }, assert.fail);
  sender.setDisplay("A");
  sender.push({ type: "down", x: 0.5, y: 0.5 });
  flush();
  sender.setDisplay("B");
  sender.push({ type: "click", x: 0.5, y: 0.5 });
  flush();
  assert.deepEqual(sent, ["A:down"]);
  down.resolve();
  await new Promise(resolve => setImmediate(resolve));
  flush();
  sender.push({ type: "key", key: "enter" });
  sender.close();
  await new Promise(resolve => setImmediate(resolve));
  flush();
  assert.deepEqual(sent, ["A:down", "A:up", "B:click"]);
});

test("a failed passive preview parks until the next visible visit", async () => {
  let samples = 0;
  const states: string[] = [];
  await runScreenFeed({
    signal: new AbortController().signal, once: true, gapMs: 0,
    read: async () => { samples++; throw new Error("offline"); },
    draw: () => assert.fail("no picture arrived"), report: state => states.push(state),
  });
  assert.deepEqual(states, ["failed"]);
  assert.equal(samples, 1);
});

test("claimScreenFeed enforces at most one active feed per host/display and tracks the ledger", () => {
  setLedgerEnabled(true);
  resetLedger();
  let firstAborted = 0;
  let secondAborted = 0;

  const release1 = claimScreenFeed("host-1", "1", "PaneScreen", () => { firstAborted += 1; });
  assert.equal(activeFeedCount(), 1);
  assert.equal(ledgerSnapshot().activeByKind.feed, 1);

  // Claiming the same host/display aborts the previous feed so only one stays active.
  const release2 = claimScreenFeed("host-1", "1", "Remote", () => { secondAborted += 1; });
  assert.equal(firstAborted, 1);
  assert.equal(secondAborted, 0);
  assert.equal(activeFeedCount(), 1);
  assert.equal(ledgerSnapshot().activeByKind.feed, 1);

  // Releasing the already-superseded handle is a no-op and does not drop the newer feed.
  release1();
  assert.equal(activeFeedCount(), 1);
  assert.equal(ledgerSnapshot().activeByKind.feed, 1);

  release2();
  assert.equal(activeFeedCount(), 0);
  assert.equal(ledgerSnapshot().activeByKind.feed, 0);
});

test("one feed per computer whatever the display; a smaller view waits and is woken when the slot frees", async () => {
  const { whenScreenFeedFree } = await import("../src/features/remote/feedRegistry");
  setLedgerEnabled(true);
  resetLedger();
  let paneAborted = 0;
  // The pane asks without a display, Settings › Screen with one: still the same computer's slot.
  const releasePane = claimScreenFeed("host-2", undefined, "PaneScreen", () => { paneAborted += 1; });
  assert.ok(releasePane);
  const releaseRemote = claimScreenFeed("host-2", "1", "Remote", assert.fail);
  assert.ok(releaseRemote);
  assert.equal(paneAborted, 1);
  assert.equal(activeFeedCount(), 1);

  // While Settings › Screen holds it, the pane and a chat card can't take it back; they wait.
  assert.equal(claimScreenFeed("host-2", undefined, "PaneScreen", assert.fail), null);
  assert.equal(claimScreenFeed("host-2", undefined, "ScreenCard", assert.fail), null);
  let woken = 0;
  const cancel = whenScreenFeedFree("host-2", () => { woken += 1; });
  let cancelledWoken = 0;
  whenScreenFeedFree("host-2", () => { cancelledWoken += 1; })();
  releasePane();
  assert.equal(woken, 0, "the superseded pane's release does not free the slot");
  releaseRemote();
  assert.equal(woken, 1);
  assert.equal(cancelledWoken, 0);
  assert.equal(activeFeedCount(), 0);
  cancel();

  // Free again: the pane takes it.
  const again = claimScreenFeed("host-2", undefined, "PaneScreen", () => {});
  assert.ok(again);
  again();
  assert.equal(ledgerSnapshot().activeByKind.feed, 0);
});
