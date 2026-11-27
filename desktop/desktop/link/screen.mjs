// The computer's screen, for a phone that is allowed to see it (and, in "control" mode, to use it).
//
// The person chooses on the computer: off, view or control (LinkHost.setScreenMode). Pictures come
// from an adapter the desktop app passes as backend.screen:
//   displays()                                   → [{ id, label, width, height, primary }]
//   capture({ display, maxWidth, quality })      → { jpeg: Buffer, width, height }
//   permissions?()                               → { screenRecording, accessibility }
// With no adapter, macOS falls back on its own screencapture and sips tools (one display).
//
// A phone asks for frames one after another. Each picture has a number that goes up when it
// changes, so a phone that already has number N asks "after N" and is told "nothing new" instead of
// being sent the same picture again. A device that asked for a frame in the last 5 seconds is a viewer.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEvents, injectorFor, macScript, MAX_EXPANDED, NEED_ACCESSIBILITY } from "./input.mjs";
import { Failure, runTool, toolEnv } from "./tools.mjs";

import { VideoStreams, VIDEO_FORMATS } from "./video.mjs";

export const MODES = ["off", "view", "control"];
const NEED_RECORDING = "Allow screen recording for this app in System Settings › Privacy & Security.";
const NO_VIEWING = "Viewing the screen isn't available in this app yet.";
const POLL_MS = 300;
const MAX_POLL_MS = 1500;
const WAIT_MS = 1500;
const VIEWER_MS = 5000;
const DISPLAYS_TTL = 5000;
const LOOKUP_TTL = 5000; // how long info() reuses what it learned about permissions
const MAX_PENDING = 8; // input calls waiting their turn
const MAX_SIZES = 8; // remember cursors only, never cached pictures
const MAX_JPEG = 3 * 1024 * 1024;

const clamp = (value, low, high, fallback) => (typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : fallback);
const clampFraction = value => Math.max(0, Math.min(1, value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The size of a JPEG, read from its header. */
export function jpegSize(bytes) {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // The frame header: every start-of-frame marker except the table ones (C4, C8, CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/** macOS without an adapter: the system's own tools, one display. */
function macAdapter(dirs) {
  const env = toolEnv(dirs);
  return {
    async displays() {
      const info = await macScript({ action: "info" }, dirs).catch(() => ({}));
      return [{ id: "1", label: "Main display", width: info.width ?? 0, height: info.height ?? 0, primary: true }];
    },
    async capture({ display, maxWidth, quality }) {
      if (!/^[1-9]$/.test(display)) throw new Failure("That display isn't available.");
      const folder = mkdtempSync(join(tmpdir(), "botkins-screen-"));
      const file = join(folder, "screen.jpg");
      try {
        try {
          await runTool("Screen capture", "/usr/sbin/screencapture", ["-x", "-t", "jpg", "-D", display, file], { env, timeout: 15_000 });
        } catch (error) {
          // "Busy" and "too slow" are not about permission, and are said as they are.
          if (error?.kind === "busy" || error?.kind === "timeout") throw error;
          throw new Failure(NEED_RECORDING);
        }
        await runTool("Screen capture", "/usr/bin/sips", ["-Z", String(maxWidth), "-s", "formatOptions", String(quality), file], { env, timeout: 15_000 });
        const jpeg = readFileSync(file);
        const size = jpegSize(jpeg);
        if (!size) throw new Failure(NEED_RECORDING);
        return { jpeg, ...size };
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    async permissions() {
      const info = await macScript({ action: "info" }, dirs).catch(() => ({}));
      // Screen recording can't be asked for ahead of time here: a capture says so when it is refused.
      return { screenRecording: true, accessibility: info.accessibility === true };
    },
  };
}

export class Screen {
  /**
   * @param options.adapter  () → the desktop's adapter, or undefined.
   * @param options.mode     () → "off", "view" or "control".
   * @param options.inject   Replaces the system's input injector (tests use it, so nothing is clicked).
   * @param options.emit     (deviceId, started) when a device starts or stops viewing.
   * @param options.paired   (deviceId) → whether that phone is still paired.
   * @param options.log      Where a failure in a timer is written. Timers never throw.
   */
  constructor({ adapter = () => undefined, mode, inject, emit = () => {}, paired = () => true, log = () => {}, dirs, platform = process.platform, idleMs = VIEWER_MS }) {
    Object.assign(this, { adapter, mode, emit, paired, log, dirs, platform, idleMs });
    this.held = null; // { deviceId, display, x, y } while a phone holds the mouse button down
    this.inputs = new Set(); // includes the batch currently being injected
    this.lookups = null;
    this.override = inject;
    this.fallback = platform === "darwin" ? macAdapter(dirs) : null;
    this.readers = new Set(); // frame requests, including those still looking up the display
    this.connections = new WeakMap(); // relay requests share one disconnect promise per connection
    this.shots = new Map(); // display → one capture lane, a cursor per recent size and quality
    this.video = new VideoStreams();
    this.viewing = new Map(); // deviceId → { since, timer }
    this.displayCache = null;
    this.queue = Promise.resolve();
    this.botActivity = null; // latest native computer-use action marker for live viewers
    this.activitySeq = 0;
    this.cuaFrame = null; // optional JPEG frame emitted by cua-driver (e.g. background window capture)
  }

  source() {
    return this.adapter() ?? this.fallback;
  }
  need(mode) {
    const now = this.mode();
    if (now === "off") throw new Failure("Screen sharing is off. Turn it on in the app on your computer.");
    if (mode === "control" && now !== "control") throw new Failure("Controlling the screen is off. Turn it on in the app on your computer.");
  }
  async displays() {
    if (this.displayCache && Date.now() - this.displayCache.at < DISPLAYS_TTL) return this.displayCache.list;
    const source = this.source();
    if (!source) throw new Failure(NO_VIEWING);
    const raw = await source.displays();
    const list = (Array.isArray(raw) ? raw : []).map((d) => ({ id: String(d.id), label: String(d.label ?? "Display " + d.id).slice(0, 80), width: Number(d.width) || 0, height: Number(d.height) || 0, primary: d.primary === true }));
    this.displayCache = { at: Date.now(), list };
    return list;
  }
  async pick(id) {
    const list = await this.displays();
    const display = id == null ? (list.find((d) => d.primary) ?? list[0]) : list.find((d) => d.id === String(id));
    if (!display) throw new Failure("That display isn't available.");
    return display;
  }
  /** Why a phone can't control the screen, or null. */
  async controlProblem() {
    if (this.override) return null;
    return injectorFor(this.platform, this.dirs).problem ?? null;
  }
  /** What info() learns about permissions, reused for 5 seconds so a phone asking again and again costs one lookup. */
  async lookup(source) {
    if (this.lookups && this.lookups.source === source && Date.now() - this.lookups.at < LOOKUP_TTL) return this.lookups.value;
    const raw = source.permissions ? await source.permissions().catch(() => null) : null;
    const value = { screenRecording: raw?.screenRecording, accessibility: await this.accessibility(source, raw) };
    this.lookups = { at: Date.now(), source, value };
    return value;
  }
  /** Whether this app may post clicks and keys: the adapter knows, else macOS is asked, else it is assumed. */
  async accessibility(source, known) {
    const raw = known !== undefined ? known : source?.permissions ? await source.permissions().catch(() => null) : undefined;
    if (raw) return raw.accessibility !== false;
    // An adapter that can't say is trusted; so is a test's injector.
    if (source?.permissions || this.override) return true;
    return this.platform === "darwin" ? (await macScript({ action: "info" }, this.dirs).catch(() => ({}))).accessibility === true : true;
  }

  // ── What the phone is told about the screen ────────────────────────────────────────────────

  async info(includePointer = false) {
    const mode = this.mode();
    const off = (problem) => ({ mode, displays: [], canView: false, canControl: false, problem });
    if (mode === "off") return off("Screen sharing is off. Turn it on in the app on your computer.");
    const source = this.source();
    if (!source) return off(NO_VIEWING);
    let displays;
    try {
      displays = await this.displays();
    } catch (error) {
      return off(error instanceof Failure ? error.message : "The computer's displays couldn't be read.");
    }
    const permissions = await this.lookup(source);
    if (permissions.screenRecording === false) return { mode, displays, canView: false, canControl: false, problem: NEED_RECORDING };
    const canView = displays.length > 0;
    const video = canView && typeof source.openVideo === "function" ? { video: true } : {};
    if (mode !== "control") return { mode, displays, canView, ...video, canControl: false, ...(!canView && { problem: "No display was found." }) };
    const problem = (await this.controlProblem()) ?? (permissions.accessibility ? null : NEED_ACCESSIBILITY);
    let pointer;
    if (includePointer && canView && !problem && source.pointer) {
      const at = await source.pointer().catch(() => null);
      if (this.mode() === "control" && displays.some(item => item.id === at?.display) &&
          Number.isFinite(at.x) && Number.isFinite(at.y)) {
        pointer = { display: at.display, x: clampFraction(at.x), y: clampFraction(at.y) };
      }
    }
    const superKey = (this.platform === "linux" || this.platform === "win32") && (!this.override || source.superKey === true);
    return { mode, displays, canView, ...video, ...(pointer && { pointer }), ...(superKey && { superKey: true }), canControl: canView && !problem, ...(problem && { problem }) };
  }

  /** Interactive viewing shares the same pairing, screen permission and viewer indicator as stills. */
  async openVideo(deviceId, id, options) {
    this.stillAllowed(deviceId);
    const source = this.source();
    const mimeTypes = VIDEO_FORMATS.filter(type => Array.isArray(options?.mimeTypes) && options.mimeTypes.includes(type));
    if (!source?.openVideo || !mimeTypes.length) throw new Failure("No compatible desktop video format is available.");
    const check = () => this.stillAllowed(deviceId);
    const opened = await this.video.open(deviceId, id, async signal => {
      const display = await this.pick(options?.display);
      const permissions = await this.lookup(source);
      if (permissions.screenRecording === false) throw new Failure(NEED_RECORDING);
      signal.throwIfAborted();
      check();
      this.watch(deviceId, 15_000);
      const media = await source.openVideo({
        display: display.id, maxWidth: clamp(options.maxWidth, 480, 1920, 1280),
        fps: clamp(options.fps, 5, 60, 30), mimeTypes, signal,
      });
      if (!mimeTypes.includes(media.mimeType)) {
        media.close();
        throw new Failure("No compatible desktop video format is available.");
      }
      return media;
    });
    check();
    this.watch(deviceId);
    return opened;
  }

  async readVideo(deviceId, id, seq) {
    this.stillAllowed(deviceId);
    const bytes = await this.video.read(deviceId, id, seq);
    this.stillAllowed(deviceId);
    this.watch(deviceId);
    return bytes;
  }

  closeVideo(deviceId, id) {
    if (typeof id === "string") this.video.close(deviceId, id);
  }

  // ── Pictures ───────────────────────────────────────────────────────────────────────────────

  /** One capture at a time per display: a caller with the same wishes shares it, another waits its turn. */
  async grab(display, size, check) {
    const key = size.maxWidth + "x" + size.quality;
    let entry = this.shots.get(display);
    if (!entry) this.shots.set(display, (entry = { seq: Math.floor(Math.random() * 1e6), sizes: new Map(), inflight: null }));
    while (entry.inflight) {
      if (entry.inflight.key === key) return entry.inflight.promise;
      await entry.inflight.promise.catch(() => {});
    }
    check();
    const promise = this.capture(display, size, entry, key).finally(() => {
      entry.inflight = null;
    });
    entry.inflight = { key, promise };
    return promise;
  }
  async capture(display, size, entry, key) {
    let shot;
    try {
      shot = await this.source().capture({ display, ...size });
    } catch (error) {
      throw error instanceof Failure ? error : new Failure(typeof error?.message === "string" && error.message.length <= 200 ? error.message : "The screen couldn't be captured.");
    }
    const jpeg = Buffer.from(shot?.jpeg ?? []);
    if (!jpeg.length) throw new Failure("The screen couldn't be captured.");
    // Only a picture that is a JPEG, and not huge, goes to a phone.
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.length > MAX_JPEG) throw new Failure("The screen's picture couldn't be used.");
    const hash = createHash("sha1").update(jpeg).digest("hex");
    const before = entry.sizes.get(key);
    const cursor = before?.hash === hash ? before : { hash, seq: ++entry.seq };
    entry.sizes.delete(key);
    entry.sizes.set(key, cursor);
    if (entry.sizes.size > MAX_SIZES) entry.sizes.delete(entry.sizes.keys().next().value);
    return { seq: cursor.seq, jpeg, width: Number(shot.width) || 0, height: Number(shot.height) || 0 };
  }
  /** A relay connection can carry thousands of frames before it disconnects. Observe it once. */
  connection(gone) {
    if (!gone) return;
    let connection = this.connections.get(gone);
    if (!connection) {
      connection = { closed: false };
      this.connections.set(gone, connection);
      gone.then(() => { connection.closed = true; });
    }
    return connection;
  }
  /** Compute the next capture poll interval, backing off while frames remain unchanged. */
  pollDelay(display) {
    const entry = this.shots.get(display);
    const unchanged = entry?.unchanged ?? 0;
    if (unchanged <= 0) return POLL_MS;
    return Math.min(MAX_POLL_MS, Math.round(POLL_MS * Math.pow(2, Math.min(unchanged, 4))));
  }
  /** A phone just acted on this display: look again at the normal pace, not the backed-off one. */
  noteInput(display) {
    const entry = this.shots.get(display);
    if (entry) entry.unchanged = 0;
  }
  /**
   * Native computer-use activity (cua-driver): records a live action marker and optional JPEG
   * frame so paired phones watching the Screen stream see what the bot did immediately, including
   * when background delivery leaves the person's pointer untouched.
   */
  noteBotActivity(activity, frame) {
    if (!activity || typeof activity !== "object") return null;
    const seq = ++this.activitySeq;
    const at = Date.now();
    const clean = (value, max = 120) => (typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : undefined);
    const point =
      activity.point &&
      typeof activity.point.x === "number" &&
      Number.isFinite(activity.point.x) &&
      typeof activity.point.y === "number" &&
      Number.isFinite(activity.point.y)
        ? { x: Math.round(activity.point.x), y: Math.round(activity.point.y) }
        : undefined;
    this.botActivity = {
      seq,
      at,
      ...(clean(activity.botId, 64) && { botId: clean(activity.botId, 64) }),
      ...(clean(activity.botName, 80) && { botName: clean(activity.botName, 80) }),
      action: clean(activity.action, 48) ?? "act",
      ...(clean(activity.summary, 180) && { summary: clean(activity.summary, 180) }),
      ...(clean(activity.app, 80) && { app: clean(activity.app, 80) }),
      ...(clean(activity.windowTitle, 120) && { windowTitle: clean(activity.windowTitle, 120) }),
      deliveryMode: activity.deliveryMode === "foreground" ? "foreground" : "background",
      pointerUntouched: activity.pointerUntouched !== false,
      ...(point && { point }),
    };
    if (frame?.jpeg) {
      const jpeg = Buffer.isBuffer(frame.jpeg) ? frame.jpeg : Buffer.from(frame.jpeg);
      if (jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg.length <= MAX_JPEG) {
        const size = jpegSize(jpeg);
        this.cuaFrame = {
          seq,
          at,
          jpeg,
          width: Number(frame.width) || size?.width || 0,
          height: Number(frame.height) || size?.height || 0,
        };
      }
    }
    for (const entry of this.shots.values()) entry.unchanged = 0;
    return this.botActivity;
  }
  /** Latest fresh bot activity marker (within 20s), or null. */
  recentActivity(now = Date.now()) {
    if (!this.botActivity || now - this.botActivity.at > 20_000) return null;
    return this.botActivity;
  }
  /** An interactive viewer waits for a change. A paced preview (wait: false) samples once. */
  async frame(deviceId, options, gone) {
    this.stillAllowed(deviceId);
    const o = options && typeof options === "object" ? options : {};
    const size = { maxWidth: clamp(o.maxWidth, 480, 1920, 1280), quality: clamp(o.quality, 30, 85, 60) };
    const after = typeof o.after === "number" && Number.isFinite(o.after) ? o.after : null;
    const connection = this.connection(gone);
    const reader = { deviceId };
    this.readers.add(reader);
    const check = () => {
      this.stillAllowed(deviceId);
      if (!this.readers.has(reader) || connection?.closed) throw new Failure("Screen viewing stopped.");
    };
    try {
      const activity = this.recentActivity();
      const source = this.source();
      if (!source && this.cuaFrame && Date.now() - this.cuaFrame.at <= 20_000) {
        check();
        this.watch(deviceId);
        const f = this.cuaFrame;
        return {
          seq: f.seq,
          display: "1",
          width: f.width,
          height: f.height,
          ...(f.seq !== after && { jpeg: f.jpeg.toString("base64") }),
          ...(activity && { activity }),
        };
      }
      const display = await this.pick(o.display);
      check();
      this.watch(deviceId);
      let shot = await this.grab(display.id, size, check);
      const entry = this.shots.get(display.id);
      if (entry) entry.unchanged = shot.seq === after ? (entry.unchanged ?? 0) + 1 : 0;
      let grabbedAt = Date.now();
      const until = Date.now() + WAIT_MS;
      const startActivitySeq = this.activitySeq;
      while (o.wait !== false && shot.seq === after && this.activitySeq === startActivitySeq && Date.now() < until) {
        check();
        // Wake at the normal pace, but capture only once the backed-off delay has passed, so input
        // (which resets the delay through `noteInput`) shows within one POLL_MS on a quiet screen.
        await sleep(Math.min(POLL_MS, Math.max(0, until - Date.now())));
        check();
        if (Date.now() < until && Date.now() - grabbedAt < this.pollDelay(display.id)) continue;
        shot = await this.grab(display.id, size, check);
        grabbedAt = Date.now();
        if (entry) entry.unchanged = shot.seq === after ? (entry.unchanged ?? 0) + 1 : 0;
      }
      check();
      const latestActivity = this.recentActivity();
      const freshCua =
        latestActivity?.deliveryMode === "background" &&
        this.cuaFrame &&
        this.cuaFrame.seq === latestActivity.seq &&
        Date.now() - this.cuaFrame.at <= 10_000
          ? this.cuaFrame
          : null;
      if (freshCua && shot.seq === after) {
        const seq = Math.max(shot.seq + 1, freshCua.seq);
        return {
          seq,
          display: display.id,
          width: freshCua.width || shot.width,
          height: freshCua.height || shot.height,
          jpeg: freshCua.jpeg.toString("base64"),
          activity: latestActivity,
        };
      }
      return { seq: shot.seq, display: display.id, width: shot.width, height: shot.height,
        ...(shot.seq !== after && { jpeg: shot.jpeg.toString("base64") }),
        ...(latestActivity && { activity: latestActivity }) };
    } finally {
      this.readers.delete(reader);
    }
  }

  /** The mode may have been turned off, or the phone removed, while the picture was being taken: then it isn't sent. */
  stillAllowed(deviceId) {
    this.need("view");
    if (!this.paired(deviceId)) throw new Failure("This phone isn't paired.");
  }

  // ── Viewers ────────────────────────────────────────────────────────────────────────────────

  /** A device asked for a frame: it is viewing until 5 seconds pass without another. */
  watch(deviceId, lifetime = this.idleMs) {
    let viewer = this.viewing.get(deviceId);
    if (viewer) clearTimeout(viewer.timer);
    else {
      viewer = { since: Date.now() };
      this.viewing.set(deviceId, viewer);
      this.emit(deviceId, true);
    }
    viewer.timer = setTimeout(() => {
      try {
        // Expire the viewer and any held input. A slow first capture may still finish.
        this.endViewer(deviceId);
      } catch (error) {
        this.log("screen: " + (error?.message ?? error));
      }
    }, lifetime);
    viewer.timer.unref?.();
  }
  stop(deviceId) {
    for (const reader of this.readers) if (reader.deviceId === deviceId) this.readers.delete(reader);
    this.endViewer(deviceId);
  }
  endViewer(deviceId) {
    this.video.close(deviceId);
    // A phone that lets go of the screen lets go of the mouse button too.
    this.cancelInput(deviceId);
    const viewer = this.viewing.get(deviceId);
    if (!viewer) return;
    clearTimeout(viewer.timer);
    this.viewing.delete(deviceId);
    this.emit(deviceId, false);
  }
  stopAll() {
    this.video.closeAll();
    this.readers.clear();
    for (const id of [...this.viewing.keys()]) this.stop(id);
    this.cancelInput();
  }
  viewers() {
    return [...this.viewing].map(([deviceId, viewer]) => ({ deviceId, since: viewer.since }));
  }
  /** The person changed the mode. */
  modeChanged() {
    this.displayCache = null;
    this.lookups = null;
    if (this.mode() === "off") this.stopAll();
    else this.cancelInput();
  }
  /** Stop queued actions. A down can already be in the injector: put its up after that
   * batch and before input from any subsequently opened viewer. */
  cancelInput(deviceId) {
    let release = !!this.held && (!deviceId || this.held.deviceId === deviceId);
    for (const job of this.inputs) {
      if (deviceId && job.deviceId !== deviceId) continue;
      job.stopped = true;
      release = true;
    }
    if (release) this.queue = this.queue.then(() => this.release(deviceId)).catch(error => this.log("screen: " + (error?.message ?? error)));
  }
  async release(deviceId) {
    const held = this.held;
    if (!held || (deviceId && held.deviceId !== deviceId)) return;
    this.held = null;
    const inject = this.override ?? injectorFor(this.platform, this.dirs).inject;
    if (inject) await inject({ release: true, display: held.display, displays: [held.display], events: [{ type: "up", x: held.x, y: held.y }] });
  }

  // ── Input ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Posts a phone's clicks, scrolls and typing. Calls run one at a time, in the order they arrived, and
   * at most 8 wait. A call whose phone is gone, or whose mode is no longer "control", is skipped.
   */
  input(deviceId, displayId, events) {
    if (this.inputs.size >= MAX_PENDING) return Promise.reject(new Failure("Too many actions are waiting. Try again in a moment."));
    const job = { deviceId, stopped: false };
    this.inputs.add(job);
    const run = this.queue.then(() => this.post(job, displayId, events)).finally(() => this.inputs.delete(job));
    this.queue = run.catch(() => {});
    return run;
  }
  async post(job, displayId, events) {
    const { deviceId } = job;
    const check = () => {
      if (!this.paired(deviceId)) throw new Failure("This phone isn't paired.");
      this.need("control");
      if (job.stopped) throw new Failure("Screen control stopped.");
    };
    check();
    // Checked before anything is posted, so a call with one bad action does nothing at all.
    const clean = cleanEvents(events, !!this.held);
    if (clean.events.length > MAX_EXPANDED) throw new Failure("Too much to type at once.");
    const display = await this.pick(displayId);
    const problem = await this.controlProblem();
    if (problem) throw new Failure(problem);
    if (!(await this.accessibility(this.source()))) throw new Failure(NEED_ACCESSIBILITY);
    if (!clean.events.length) return;
    const inject = this.override ?? injectorFor(this.platform, this.dirs).inject;
    const displays = await this.displays();
    check();
    const bounds = this.source()?.inputBounds?.(display.id);
    await inject({ display, displays, ...(bounds && { bounds }), events: clean.events });
    this.noteInput(display.id);
    const last = clean.events.findLast((e) => e.x !== undefined);
    this.held = clean.pressed && last ? { deviceId, display, x: last.x, y: last.y } : null;
    // The phone left, or control was turned off, while this was being posted: let go at once.
    if (this.held && (this.mode() !== "control" || !this.paired(deviceId))) await this.release(deviceId);
  }
  dispose() {
    this.stopAll();
  }
}
