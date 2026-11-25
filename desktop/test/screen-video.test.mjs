import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Screen } from "../desktop/link/screen.mjs";

const mime = 'video/mp4; codecs="avc1.42C01F"';
const options = { display: "1", fps: 30, maxWidth: 1280, mimeTypes: [mime] };
function viewer(openVideo, idleMs = 5000) {
  const state = { mode: "view", paired: true, recording: true };
  const source = {
    displays: async () => [{ id: "1", width: 1440, height: 900, primary: true }],
    permissions: async () => ({ screenRecording: state.recording, accessibility: true }),
    openVideo,
  };
  const screen = new Screen({ dirs: [], adapter: () => source, mode: () => state.mode, paired: () => state.paired, idleMs });
  return { state, screen };
}

test("video is negotiated for the selected display and reads ordered, retryable chunks", async (t) => {
  let reads = 0;
  let closed = 0;
  const { screen } = viewer(async (capture) => {
    assert.equal(capture.display, "1");
    assert.equal(capture.maxWidth, 1920);
    assert.equal(capture.fps, 60);
    assert.deepEqual(capture.mimeTypes, [mime]);
    return { mimeType: mime, read: async () => Buffer.from("part" + ++reads), close: () => ++closed };
  });
  t.after(() => screen.stopAll());
  assert.equal((await screen.info()).video, true);
  const id = randomUUID();
  assert.deepEqual(await screen.openVideo("phone", id, { ...options, fps: 5000, maxWidth: 8000 }), { mimeType: mime });
  assert.equal(screen.viewers().length, 1);
  const [first, retry] = await Promise.all([screen.readVideo("phone", id, 0), screen.readVideo("phone", id, 0)]);
  assert.equal(Buffer.from(first, "base64").toString(), "part1");
  assert.equal(retry, first);
  assert.equal(await screen.readVideo("phone", id, 0), first);
  await assert.rejects(screen.readVideo("another", id, 1), /ended/);
  await assert.rejects(screen.readVideo("phone", id, 2), /sequence/);
  assert.equal(Buffer.from(await screen.readVideo("phone", id, 1), "base64").toString(), "part2");
  screen.closeVideo("phone", randomUUID());
  assert.equal(closed, 0);
  screen.closeVideo("phone", id);
  assert.equal(closed, 1);
});

test("a revoked grant cancels pending video and suppresses already captured bytes", async (t) => {
  const bytes = Promise.withResolvers();
  let closed = 0;
  const { screen, state } = viewer(async () => ({ mimeType: mime, read: () => bytes.promise, close: () => ++closed }));
  t.after(() => screen.stopAll());
  const id = randomUUID();
  await screen.openVideo("phone", id, options);
  const read = screen.readVideo("phone", id, 0);
  state.mode = "off";
  screen.modeChanged();
  bytes.resolve(Buffer.from("private"));
  await assert.rejects(read);
  assert.equal(closed, 1);
  await assert.rejects(screen.openVideo("phone", randomUUID(), options), /off/);
  assert.deepEqual(screen.viewers(), []);
});

test("leaving during capture startup closes a late source and a vanished viewer releases the encoder", async (t) => {
  const pending = Promise.withResolvers();
  const starting = Promise.withResolvers();
  let closed = 0;
  const media = { mimeType: mime, read: async () => Buffer.from("encoded"), close: () => ++closed };
  let first = true;
  const { screen } = viewer(async ({ signal }) => {
    if (!first) return media;
    first = false;
    starting.resolve(signal);
    return pending.promise;
  }, 40);
  t.after(() => screen.stopAll());
  const id = randomUUID();
  const opened = screen.openVideo("phone", id, options);
  const signal = await starting.promise;
  screen.stop("phone");
  assert.equal(signal.aborted, true);
  pending.resolve(media);
  await assert.rejects(opened);
  assert.equal(closed, 1);
  await screen.openVideo("phone", randomUUID(), options);
  await delay(100);
  assert.equal(closed, 2);
});

test("denied capture, missing encoders and unknown display ids never start a stream", async () => {
  let started = 0;
  const { screen, state } = viewer(() => { started++; });
  try {
    state.recording = false;
    assert.ok(!(await screen.info()).video);
    await assert.rejects(screen.openVideo("phone", randomUUID(), options), /recording/i);
    state.recording = true;
    screen.modeChanged();
    await assert.rejects(screen.openVideo("phone", randomUUID(), { ...options, display: "2" }), /display/);
    await assert.rejects(screen.openVideo("phone", randomUUID(), { ...options, mimeTypes: ["text/html"] }), /format/);
    state.paired = false;
    await assert.rejects(screen.openVideo("phone", randomUUID(), options), /paired/);
    assert.equal(started, 0);
    assert.ok(!(await viewer(undefined).screen.info()).video);
  } finally {
    screen.stopAll();
  }
});

test("absolute clicks use the selected monitor's native X11 origin and extents", async () => {
  const { xdotoolCommands } = await import("../desktop/link/input.mjs");
  const bounds = { x: 1920, y: 90, width: 1280, height: 720 };
  assert.deepEqual(xdotoolCommands([{ type: "click", x: 1, y: 0 }], bounds), [["mousemove", "3199", "90", "click", "1"]]);
});
