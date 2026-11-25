import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { electronVideoRecorder } from "../desktop/host/electron-video.mjs";
import { ScreenVideo } from "../desktop/host/screen-video.mjs";
import { x11Screen } from "../desktop/host/x11screen.mjs";
import { findTool, searchDirs } from "../desktop/link/tools.mjs";
import { screenAdapter } from "../desktop/screenshare.mjs";

const run = promisify(execFile);
const mp4 = 'video/mp4; codecs="avc1.42C01F"';
const mp4High = 'video/mp4; codecs="avc1.42C02A"';
const webm = 'video/webm; codecs="vp8"';
const options = { display: "1", maxWidth: 321, fps: 15, mimeTypes: [mp4, webm] };
const linux = process.platform === "linux";
const realDisplay = linux && ["Xvfb", "xsetroot", "ffmpeg", "ffprobe"].every(name => findTool(name, searchDirs()));

function temp(t) {
  const path = mkdtempSync(join(tmpdir(), "botkins-video-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("screen sources without a video encoder keep their JPEG interface", () => {
  assert.equal(x11Screen({ display: ":20", dirs: [] }).openVideo, undefined);
  assert.equal(screenAdapter({}).openVideo, undefined);
});

test("encoded reads split and combine arbitrary producer chunks without changing the bytes", async () => {
  const cancel = new AbortController();
  const video = new ScreenVideo(cancel.signal, () => {});
  const packet = Buffer.alloc(410_000);
  for (let i = 0; i < packet.length; i++) packet[i] = i % 251;
  video.push(mp4, packet.subarray(0, 80));
  video.push(mp4, packet.subarray(80));
  const source = await video.opening.promise;
  const one = await source.read();
  const two = await source.read();
  assert.ok(one.length <= 256 * 1024 && two.length <= 256 * 1024);
  assert.deepEqual(Buffer.concat([one, two]), packet);
  const waiting = source.read();
  cancel.abort();
  await assert.rejects(waiting);
  await assert.rejects(source.read());
});

test("a viewer that falls behind releases the encoder and cannot read a corrupt continuation", async () => {
  let closed = 0;
  const video = new ScreenVideo(undefined, () => closed++);
  const packet = Buffer.alloc(256 * 1024);
  video.push(mp4, packet);
  const stream = await video.opening.promise;
  for (let i = 0; i < 32; i++) video.push(mp4, packet);
  assert.equal(closed, 1);
  await assert.rejects(stream.read(), /behind/);
  stream.close();
  assert.equal(closed, 1);
});

test("revoking Electron capture during source enumeration releases the display listener and never starts a renderer", async () => {
  const screen = new EventEmitter();
  let views = 0;
  const capture = electronVideoRecorder({ screen, WebContentsView: class { constructor() { views++; } } });
  const cancel = new AbortController();
  const source = Promise.withResolvers();
  const opening = capture({ ...options, signal: cancel.signal, selectSource: () => source.promise, target: { id: 9, size: { width: 800, height: 600 } } });
  assert.equal(screen.listenerCount("display-removed"), 1);
  cancel.abort();
  await assert.rejects(opening);
  source.resolve({ id: "screen:2:0", display_id: "9" });
  await delay(0);
  assert.equal(views, 0);
  assert.equal(screen.listenerCount("display-removed"), 0);
});

test("the Electron pointer is relative to the numbered monitor containing the system cursor", async () => {
  const displays = [
    { id: 22, bounds: { x: -800, y: -120, width: 800, height: 480 }, size: { width: 800, height: 480 }, scaleFactor: 2 },
    { id: 11, bounds: { x: 0, y: 0, width: 1280, height: 720 }, size: { width: 1280, height: 720 }, scaleFactor: 1 },
  ];
  let point = { x: -400, y: 0 };
  const screen = { getPrimaryDisplay: () => displays[1], getAllDisplays: () => displays, getCursorScreenPoint: () => point };
  const adapter = screenAdapter({ screen, platform: "win32" });
  assert.equal(typeof adapter.pointer, "function");
  assert.deepEqual(await adapter.pointer(), { display: "2", x: 0.5, y: 0.25 });
  point = { x: 0, y: 0 };
  assert.deepEqual(await adapter.pointer(), { display: "1", x: 0, y: 0 });
  point = { x: 0, y: -120 };
  assert.equal(await adapter.pointer(), null);
});

test("Electron supplies Linux input coordinates in X11 root pixels and rejects ambiguous monitor origins", () => {
  const displays = [
    { id: 11, nativeOrigin: { x: 1200, y: 0 }, size: { width: 800, height: 600 }, scaleFactor: 2 },
    { id: 22, nativeOrigin: { x: 0, y: 250 }, size: { width: 1200, height: 720 }, scaleFactor: 1 },
  ];
  const adapter = screenAdapter({ screen: { getPrimaryDisplay: () => displays[0], getAllDisplays: () => displays }, platform: "linux", sessionType: "x11" });
  assert.equal(typeof adapter.inputBounds, "function");
  assert.deepEqual(adapter.inputBounds("1"), { x: 1200, y: 0, width: 1600, height: 1200 });
  assert.deepEqual(adapter.inputBounds("2"), { x: 0, y: 250, width: 1200, height: 720 });
  assert.throws(() => adapter.inputBounds("3"), /display/i);
  displays[1].nativeOrigin = displays[0].nativeOrigin;
  assert.throws(() => adapter.inputBounds("1"), /display/i);
  delete displays[1].nativeOrigin;
  assert.throws(() => adapter.inputBounds("2"), /display/i);
});

test("the X11 encoder rejects an unknown display or codec and cancels a silent startup", { skip: !linux }, async t => {
  const dir = temp(t);
  const fake = join(dir, "ffmpeg");
  writeFileSync(fake, "#!" + process.execPath + "\nrequire('node:fs').writeFileSync(__dirname + '/pid', String(process.pid)); setInterval(() => {}, 1000);\n");
  chmodSync(fake, 0o700);
  const screen = x11Screen({ display: ":20", dirs: [dir] });
  assert.equal(typeof screen.openVideo, "function");
  await assert.rejects(screen.openVideo({ ...options, display: "2" }), /display/i);
  await assert.rejects(screen.openVideo({ ...options, mimeTypes: [webm] }), /format|codec/i);
  await assert.rejects(screen.openVideo({ ...options, signal: AbortSignal.abort() }));
  const cancel = new AbortController();
  t.after(() => cancel.abort());
  const opening = screen.openVideo({ ...options, signal: cancel.signal });
  let pid;
  for (let i = 0; !pid && i < 100; i++) {
    try { pid = Number(readFileSync(join(dir, "pid"))); } catch { await delay(20); }
  }
  assert.ok(pid, "the test encoder started");
  cancel.abort();
  await assert.rejects(opening);
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(20);
  }
  assert.fail("aborting startup left the encoder running");
});

test("video resolves the requested physical monitor even when the source list is reordered", async () => {
  const displays = [11, 22].map(id => ({ id, size: { width: 800, height: 480 } }));
  let sources = [
    { id: "screen:7:0", display_id: "22" }, { id: "screen:4:0", display_id: "11" },
  ];
  const screen = { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] };
  const adapter = screenAdapter({ screen, desktopCapturer: { getSources: async () => sources },
    recordVideo: ({ selectSource }) => selectSource() });
  assert.equal(typeof adapter.openVideo, "function");
  assert.equal((await adapter.openVideo(options)).id, "screen:4:0");
  assert.equal((await adapter.openVideo({ ...options, display: "2" })).id, "screen:7:0");
  sources = [{ id: "screen:7:0", display_id: "22" }];
  await assert.rejects(adapter.openVideo(options), /display/i);
  sources = [{ id: "screen:4:0", display_id: "" }, { id: "screen:7:0", display_id: "" }];
  await assert.rejects(adapter.openVideo(options), /display/i);
  displays.pop();
  sources = [{ id: "window:4:0", display_id: "11" }];
  await assert.rejects(adapter.openVideo(options), /display/i);
  sources = [{ id: "screen:4:0", display_id: "" }];
  assert.equal((await adapter.openVideo(options)).id, "screen:4:0");
});

test("JPEG fallback rejects an incomplete unnamed list or a window in place of the selected screen", async () => {
  const displays = [11, 22].map(id => ({ id, size: { width: 800, height: 480 } }));
  const thumbnail = { isEmpty: () => false, getSize: () => ({ width: 10, height: 6 }), toJPEG: () => Buffer.from("other monitor") };
  let sources = [{ id: "screen:7:0", display_id: "", thumbnail }];
  const adapter = screenAdapter({ platform: "win32",
    screen: { getPrimaryDisplay: () => displays[0], getAllDisplays: () => displays },
    desktopCapturer: { getSources: async () => sources } });
  await assert.rejects(adapter.capture(options), /captured|display/);
  sources = [{ id: "window:88:1", display_id: "11", thumbnail }];
  await assert.rejects(adapter.capture(options), /captured|display/);
});

async function changingDisplay(t, size = "802x480x24") {
  // Xvfb picks an unused number and writes it only after its socket is ready.
  const server = spawn("Xvfb", ["-displayfd", "1", "-noreset", "-nolisten", "tcp", "-screen", "0", size], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = once(server, "exit");
  t.after(async () => { server.kill(); await exited; });
  const [number] = await once(server.stdout, "data", { signal: AbortSignal.timeout(10_000) });
  const display = ":" + String(number).trim();
  const env = { ...process.env, DISPLAY: display, XDG_SESSION_TYPE: "x11" };
  let red = true;
  const paint = () => run("xsetroot", ["-solid", red ? "#f02010" : "#1020f0"], { env });
  await paint();
  const interval = setInterval(() => { red = !red; paint().catch(() => {}); }, 150);
  t.after(() => clearInterval(interval));
  return display;
}

function verifyRecording(path, codec, { maxWidth = 321, level = 31, fps } = {}) {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const { streams } = JSON.parse(probe.stdout);
  assert.equal(streams.length, 1, "one video track only");
  assert.equal(streams[0].codec_name, codec);
  assert.ok(streams[0].width <= maxWidth && streams[0].width >= maxWidth - 5);
  assert.equal(streams[0].width % 2, 0);
  assert.equal(streams[0].height % 2, 0);
  if (codec === "h264") {
    assert.match(streams[0].profile, /Baseline/);
    assert.ok(streams[0].level <= level);
    if (fps) assert.equal(streams[0].r_frame_rate, fps + "/1");
    assert.ok(readFileSync(path).includes(Buffer.from("moof")), "MP4 is fragmented for live appends");
  }
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-an", "-vf", "scale=1:1", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  assert.equal(decoded.status, 0, String(decoded.stderr));
  const frames = [];
  for (let n = 0; n < decoded.stdout.length; n += 3) frames.push(decoded.stdout.subarray(n, n + 3));
  assert.ok(frames.some(([r,, b]) => r > 160 && b < 80), "decoded the red desktop");
  assert.ok(frames.some(([r,, b]) => b > 160 && r < 80), "decoded the blue desktop");
}

test("the terminal encoder streams a changing X display as decodable baseline H.264", { skip: !realDisplay }, async t => {
  const path = join(temp(t), "screen.mp4");
  const display = await changingDisplay(t);
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]);
  const screen = x11Screen({ display });
  if (findTool("xdotool", searchDirs())) {
    await run("xdotool", ["mousemove", "267", "120"], { env: { ...process.env, DISPLAY: display } });
    assert.deepEqual(await screen.pointer(), { display: "1", x: 267 / 801, y: 120 / 479 });
  }
  assert.equal(typeof screen.openVideo, "function");
  const source = await screen.openVideo({ ...options, signal });
  t.after(() => source.close());
  assert.equal(source.mimeType, mp4);
  const chunks = [];
  const until = Date.now() + 1200;
  do {
    const bytes = await source.read();
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024);
    chunks.push(bytes);
  } while (Date.now() < until);
  const waiting = source.read();
  abort.abort();
  await assert.rejects(waiting);
  await assert.rejects(source.read());
  writeFileSync(path, Buffer.concat(chunks));
  verifyRecording(path, "h264");
});

test("the X11 encoder negotiates 1600 pixels at 60 fps and respects the lower AVC level when offered alone", { skip: !realDisplay }, async t => {
  const dir = temp(t);
  const display = await changingDisplay(t, "1600x900x24");
  const screen = x11Screen({ display });
  for (const [mimeType, width, fps, level] of [[mp4High, 1600, 60, 42], [mp4, 1280, 30, 31]]) {
    const video = await screen.openVideo({ display: "1", maxWidth: 1600, fps: 60, mimeTypes: [mimeType], signal: AbortSignal.timeout(15_000) });
    t.after(() => video.close());
    assert.equal(video.mimeType, mimeType);
    const parts = [];
    const until = Date.now() + 900;
    do { parts.push(await video.read()); } while (Date.now() < until);
    video.close();
    const path = join(dir, level + ".mp4");
    writeFileSync(path, Buffer.concat(parts));
    verifyRecording(path, "h264", { maxWidth: width, level, fps });
  }
});

test("the sandboxed desktop recorder streams the selected X display in each offered format", { skip: !realDisplay }, async t => {
  const dir = temp(t);
  const display = await changingDisplay(t);
  const electron = createRequire(import.meta.url)("electron");
  const fixture = fileURLToPath(new URL("./fixtures/screen-video-electron.mjs", import.meta.url));
  const env = { ...process.env, DISPLAY: display, XDG_SESSION_TYPE: "x11" };
  delete env.ELECTRON_RUN_AS_NODE;
  await run(electron, ["--ozone-platform=x11", "--no-sandbox", "--disable-dev-shm-usage", "--user-data-dir=" + dir, fixture, dir], { env, timeout: 35_000, killSignal: "SIGKILL" });
  verifyRecording(join(dir, "screen.mp4"), "h264");
  verifyRecording(join(dir, "screen-high.mp4"), "h264", { level: 42 });
  verifyRecording(join(dir, "screen.webm"), "vp8");
});
