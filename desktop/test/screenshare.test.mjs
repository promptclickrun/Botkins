// The screen adapter the phone link is given (desktop/screenshare.mjs), with a stand-in for Electron.
import test from "node:test";
import assert from "node:assert/strict";
import { Screen } from "../desktop/link/screen.mjs";
import { screenAdapter, screenStatus } from "../desktop/screenshare.mjs";

/** Two displays: an external one listed first by the system, and the built-in main one. */
function electron({ recording = "granted", trusted = true, empty = false, named = true } = {}) {
  const displays = [
    { id: 77, label: "Studio Display", size: { width: 2560, height: 1440 }, scaleFactor: 2 },
    { id: 1, label: "", size: { width: 1512, height: 982 }, scaleFactor: 2 },
  ];
  const asked = [];
  const prompted = [];
  const opened = [];
  const state = { recording, trusted };
  const thumbnail = (id, size) => ({ isEmpty: () => empty, getSize: () => size, toJPEG: (quality) => Buffer.from("jpeg:" + id + ":" + quality) });
  return {
    asked,
    prompted,
    opened,
    state,
    openExternal: async (url) => void opened.push(url),
    screen: { getPrimaryDisplay: () => displays[1], getAllDisplays: () => displays },
    desktopCapturer: {
      getSources: async (options) => {
        asked.push(options);
        return displays.map((d) => ({ display_id: named ? String(d.id) : "", thumbnail: thumbnail(d.id, options.thumbnailSize) }));
      },
    },
    // Only a Grant button asks with the prompt; every look at the state asks without it.
    systemPreferences: { getMediaAccessStatus: () => state.recording, isTrustedAccessibilityClient: (prompt) => (prompt && prompted.push("accessibility"), state.trusted) },
  };
}

test("displays are numbered from the main one, and a capture is of the display asked for", async () => {
  const fake = electron();
  const adapter = screenAdapter({ ...fake, platform: "darwin" });
  assert.deepEqual(await adapter.displays(), [
    { id: "1", label: "Main display", width: 1512, height: 982, primary: true },
    { id: "2", label: "Studio Display", width: 2560, height: 1440, primary: false },
  ]);
  const main = await adapter.capture({ display: "1", maxWidth: 1280, quality: 60 });
  assert.equal(main.jpeg.toString(), "jpeg:1:60");
  assert.deepEqual([main.width, main.height], [1280, 831], "scaled to the width the phone asked for, in the display's shape");
  assert.deepEqual(fake.asked[0], { types: ["screen"], thumbnailSize: { width: 1280, height: 831 } });
  const other = await adapter.capture({ display: "2", maxWidth: 9000, quality: 85 });
  assert.equal(other.jpeg.toString(), "jpeg:77:85");
  assert.equal(other.width, 5120, "never larger than the display's own pixels");
  await assert.rejects(adapter.capture({ display: "3", maxWidth: 1280, quality: 60 }), /That display isn't available/);
  await assert.rejects(adapter.capture({ display: "../1", maxWidth: 1280, quality: 60 }), /That display isn't available/);
});

test("where the system doesn't say which source is which display, they are matched by order", async () => {
  const adapter = screenAdapter({ ...electron({ named: false }), platform: "win32" });
  assert.equal((await adapter.capture({ display: "1", maxWidth: 1280, quality: 60 })).jpeg.toString(), "jpeg:1:60");
  assert.equal((await adapter.capture({ display: "2", maxWidth: 1280, quality: 60 })).jpeg.toString(), "jpeg:77:60");
});

test("permissions say what macOS still has to allow, and a refused capture says why", async () => {
  assert.deepEqual(await screenAdapter({ ...electron(), platform: "darwin" }).permissions(), { screenRecording: true, accessibility: true });
  assert.deepEqual(await screenAdapter({ ...electron({ recording: "denied", trusted: false }), platform: "darwin" }).permissions(), { screenRecording: false, accessibility: false });
  // Not asked yet counts as allowed, so the first capture makes macOS ask.
  assert.equal((await screenAdapter({ ...electron({ recording: "not-determined" }), platform: "darwin" }).permissions()).screenRecording, true);
  assert.deepEqual(await screenAdapter({ ...electron({ recording: "denied", trusted: false }), platform: "win32" }).permissions(), { screenRecording: true, accessibility: true }, "Windows asks for neither");
  await assert.rejects(screenAdapter({ ...electron({ recording: "denied", empty: true }), platform: "darwin" }).capture({ display: "1", maxWidth: 1280, quality: 60 }), /Allow screen recording for Botkins/);
  await assert.rejects(screenAdapter({ ...electron({ empty: true }), platform: "darwin" }).capture({ display: "1", maxWidth: 1280, quality: 60 }), /couldn't be captured/);
});

test("the Phone page is told the choice, who is watching and what macOS has allowed", () => {
  const fake = electron({ trusted: false });
  const adapter = screenAdapter({ ...fake, platform: "darwin" });
  assert.deepEqual(screenStatus({ mode: "control", viewers: [{ deviceId: "d1", name: "Phone", since: 5 }] }, adapter), {
    mode: "control",
    viewers: [{ deviceId: "d1", name: "Phone", since: 5 }],
    permissions: { system: true, screenRecording: true, accessibility: false },
  });
  assert.equal(screenStatus(undefined, adapter).mode, "off", "a link from before this setting is off");
  assert.equal(screenStatus({ mode: "everything" }, adapter).mode, "off");
  // For the page, not asked yet is not allowed yet: that is when it shows a Grant button.
  assert.equal(screenAdapter({ ...electron({ recording: "not-determined" }), platform: "darwin" }).granted().screenRecording, false);
  assert.deepEqual(screenAdapter({ ...electron({ recording: "denied", trusted: false }), platform: "win32" }).granted(), { system: false, screenRecording: true, accessibility: true }, "Windows asks for neither");
  assert.deepEqual(fake.prompted, [], "looking at the state asks the person nothing");
});

test("Grant asks macOS for the permission and opens the page where Botkins is switched on", async () => {
  // Screen Recording: the first capture is what makes macOS ask; then System Settings opens at that list.
  const fake = electron({ recording: "not-determined", trusted: false });
  const adapter = screenAdapter({ ...fake, platform: "darwin" });
  assert.deepEqual(await adapter.request("screenRecording"), { system: true, screenRecording: false, accessibility: false });
  assert.deepEqual(fake.asked, [{ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }]);
  assert.deepEqual(fake.opened, ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
  assert.deepEqual(fake.prompted, []);
  // Accessibility: asked with the prompt, which is what lists Botkins there.
  await adapter.request("accessibility");
  assert.deepEqual(fake.prompted, ["accessibility"]);
  assert.equal(fake.opened.at(-1), "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  // Once the person has switched it on, the page says so and Grant asks nothing more.
  fake.state.recording = "granted";
  fake.state.trusted = true;
  assert.deepEqual(await adapter.request("screenRecording"), { system: true, screenRecording: true, accessibility: true });
  await adapter.request("accessibility");
  assert.equal(fake.asked.length, 1);
  assert.equal(fake.opened.length, 2);
  assert.deepEqual(fake.prompted, ["accessibility"]);
  // Only the two permissions the screen needs can be asked for, and other systems are asked for nothing.
  await assert.rejects(adapter.request("camera"), /Unknown permission/);
  await assert.rejects(adapter.request("constructor"), /Unknown permission/);
  const windows = electron({ recording: "denied", trusted: false });
  assert.deepEqual(await screenAdapter({ ...windows, platform: "win32" }).request("accessibility"), { system: false, screenRecording: true, accessibility: true });
  assert.deepEqual([windows.asked, windows.opened, windows.prompted], [[], [], []]);
});

test("on Windows the other displays are numbered left to right, as the link's own input script numbers them", async () => {
  // Three displays in the order the system happens to list them: one to the right, the main one, one to the left.
  const displays = [
    { id: 30, label: "Right", size: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 1920, y: 0 } },
    { id: 10, label: "Main", size: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 0, y: 0 } },
    { id: 20, label: "Left", size: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: -1920, y: 0 } },
  ];
  const electron = (named) => ({
    screen: { getPrimaryDisplay: () => displays[1], getAllDisplays: () => displays },
    desktopCapturer: { getSources: async ({ thumbnailSize }) => displays.map((d) => ({ display_id: named ? String(d.id) : "", thumbnail: { isEmpty: () => false, getSize: () => thumbnailSize, toJPEG: () => Buffer.from("jpeg:" + d.label) } })) },
    systemPreferences: {},
  });
  const windows = screenAdapter({ ...electron(true), platform: "win32" });
  assert.deepEqual((await windows.displays()).map((d) => [d.id, d.label]), [["1", "Main"], ["2", "Left"], ["3", "Right"]]);
  for (const [id, label] of [["1", "Main"], ["2", "Left"], ["3", "Right"]]) assert.equal((await windows.capture({ display: id, maxWidth: 1280, quality: 60 })).jpeg.toString(), "jpeg:" + label);
  // Sources that don't say which display they are come in the system's order, and still match.
  const unnamed = screenAdapter({ ...electron(false), platform: "win32" });
  for (const [id, label] of [["1", "Main"], ["2", "Left"], ["3", "Right"]]) assert.equal((await unnamed.capture({ display: id, maxWidth: 1280, quality: 60 })).jpeg.toString(), "jpeg:" + label);
  // macOS keeps the system's order after the main display.
  assert.deepEqual((await screenAdapter({ ...electron(true), systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true }, platform: "darwin" }).displays()).map((d) => d.label), ["Main", "Right", "Left"]);
});

test("stopping during a capture cancels that viewer's wait even when the same phone opens it again", async (t) => {
  let captures = 0;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const adapter = {
    displays: async () => [{ id: "1", width: 100, height: 100 }],
    async capture() {
      if (++captures === 2) {
        started.resolve();
        await release.promise;
      }
      return { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: 100, height: 100 };
    },
  };
  const screen = new Screen({ dirs: [], adapter: () => adapter, mode: () => "view" });
  t.after(() => screen.dispose());
  const first = await screen.frame("phone", {});
  const old = screen.frame("phone", { after: first.seq });
  await started.promise;
  screen.stop("phone");
  const reopened = screen.frame("phone", {});
  release.resolve();
  await assert.rejects(old, /stopped/);
  assert.ok((await reopened).jpeg);
  assert.ok(captures <= 3, "the old long poll never captured again");
});

test("leaving while a drag is being posted releases its button and discards queued input", async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const events = [];
  const adapter = { displays: async () => [{ id: "1" }] };
  const screen = new Screen({ dirs: [], adapter: () => adapter, mode: () => "control", inject: async job => {
    events.push(...job.events);
    if (job.events[0].type === "down") {
      started.resolve();
      await finish.promise;
    }
  } });
  const down = screen.input("phone", "1", [{ type: "down", x: 0.3, y: 0.4 }]);
  await started.promise;
  const queued = screen.input("phone", "1", [{ type: "text", text: "late" }]);
  screen.stop("phone");
  finish.resolve();
  await down;
  await assert.rejects(queued, /stopped/);
  await screen.queue;
  assert.deepEqual(events.map(e => e.type), ["down", "up"]);
  assert.equal(screen.held, null);
});

test("a pane and a full viewer on the same display keep independent unchanged-frame cursors", async t => {
  const adapter = {
    displays: async () => [{ id: "1" }],
    capture: async ({ maxWidth }) => ({
      jpeg: Buffer.from([0xff, 0xd8, maxWidth >> 8, maxWidth & 255, 0xff, 0xd9]), width: maxWidth, height: 400,
    }),
  };
  const screen = new Screen({ dirs: [], adapter: () => adapter, mode: () => "view" });
  t.after(() => screen.dispose());
  const pane = await screen.frame("one", { maxWidth: 640 });
  const full = await screen.frame("two", { maxWidth: 1280 });
  assert.notEqual(pane.seq, full.seq);
  assert.equal((await screen.frame("one", { maxWidth: 640, after: pane.seq, wait: false })).jpeg, undefined);
  assert.equal((await screen.frame("two", { maxWidth: 1280, after: full.seq, wait: false })).jpeg, undefined);
});

test("static screen capture backs off instead of re-capturing every 300ms and resets on change", async (t) => {
  let version = 1;
  let captures = 0;
  const adapter = {
    displays: async () => [{ id: "1" }],
    capture: async () => {
      captures += 1;
      return { jpeg: Buffer.from([0xff, 0xd8, version, 0xff, 0xd9]), width: 640, height: 400 };
    },
  };
  const screen = new Screen({ dirs: [], adapter: () => adapter, mode: () => "view" });
  t.after(() => screen.dispose());

  const first = await screen.frame("phone", {});
  assert.equal(screen.pollDelay("1"), 300);

  // One full WAIT_MS (1500ms) unchanged poll should back off (300 -> 600 -> 1200 -> 1500)
  // rather than capturing 5-6 times every 300ms.
  captures = 0;
  const unchanged = await screen.frame("phone", { after: first.seq });
  assert.equal(unchanged.jpeg, undefined);
  assert.ok(captures <= 3, `expected <= 3 captures during static wait, got ${captures}`);
  assert.ok(screen.pollDelay("1") >= 1200, `expected backed-off delay, got ${screen.pollDelay("1")}`);

  // When the display changes, pollDelay snaps back to 300ms.
  version = 2;
  const changed = await screen.frame("phone", { after: first.seq, wait: false });
  assert.ok(changed.jpeg);
  assert.equal(screen.pollDelay("1"), 300);
});
