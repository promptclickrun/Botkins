// The relay link: how a phone that is away from this computer's network reaches it.
//
// The computer keeps an active relay socket and, with v3, a standby. The phone opens one too, and the relay passes
// RPC requests, follow parts and final answers between them. Those are already sealed end to end (see
// server.mjs), so the relay sees sizes and timing, never what a message says. The wire format is in
// tests/fake-relay.ts, which is also an in-memory relay for tests.
//
//   key    = an Ed25519 key pair this computer makes once; the private key stays in link.json
//   room   = base64url(SHA-256("botkins-relay-room-v1:" + base64url(public key)))
//   socket = <relay>/v1/host/<room>, v2 subprotocols
//            ["botkins.host.v2", "k." + public key, "t." + seconds, "s." + signature]
//            where the signature is over "botkins-relay-host-v2:" + room + ":" + seconds, made afresh for
//            every attempt. Nothing secret is sent: the relay can check the seat, never take it.
//
//   relay → computer   [conn 8][from 8][0x01][id u32][route u8][n u8][session n][body…]   a request
//   computer → relay   [conn 8][0x02][id u32][status u16][body…]                          its answer
//   computer → relay   [conn 8][0x07][id u32][counter u64][sealed news…]                   a follow part
//   relay → computer   [conn 8][from 8][0x04]                                             that phone left
//   v3 relay → computer [conn 8][from 8][0x06][id u32]                                      answer accepted
//
// Nothing here throws into the caller: a failure is logged and the link goes on, or tries again.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** The relay a new install uses. */
export const DEFAULT_RELAY_URL = "https://relay.botkins.app";
export const HOST_PROTOCOL = "botkins.host.v2";
export const HOST_PROTOCOL_V3 = "botkins.host.v3";
export const MAX_MESSAGE = 8 * 1024 * 1024;
/** The most a phone's message may be (the relay's limit), and so the most a request frame may be, with its 16 bytes of addressing. */
export const MAX_REQUEST_FRAME = 6 * 1024 * 1024 + 64 * 1024 + 16;
const PUSH_BUFFER_LIMIT = 256 * 1024; // Recompute news after the active socket drains.
const MAX_CONNS = 64; // phones with a request in flight at once
const TAKEN_AFTER = 3; // closes with 4000 in a row before this computer reports the seat as taken
const TAKEN_RETRY_MS = 10 * 60_000; // and how long it then waits between tries
const ROUTES = { 1: "hello", 2: "pair", 3: "session", 4: "rpc", 5: "join", 6: "profile" };
const PER_CONN = 8;
const IN_ALL = 256;
const PING_MS = 25_000;
const DEAD_MS = 10_000;
const STABLE_MS = 30_000;
const FIRST_MS = 1_000;
const SLOWEST_MS = 60_000;
const V3_PING_MS = 5_000;
const V3_DEAD_MS = 4_000;

export const roomOf = (publicKey) => createHash("sha256").update("botkins-relay-room-v1:" + publicKey).digest("base64url");
export const hostChallenge = (room, seconds) => "botkins-relay-host-v2:" + room + ":" + seconds;
export const hostChallengeV3 = (room, group, seconds) => "botkins-relay-host-v3:" + room + ":" + group + ":" + seconds;
const KEY = /^[A-Za-z0-9_-]{43}$/;

/** A new relay key pair: raw 32-byte Ed25519 keys, base64url. The private one never leaves this computer. */
export function newRelayKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: jwk.x, privateKey: jwk.d };
}
const privateObject = (key) => createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey, d: key.privateKey }, format: "jwk" });
/** Whether a stored key pair is whole and its two halves belong together. */
export function validRelayKey(key) {
  try {
    if (!KEY.test(key?.publicKey) || !KEY.test(key?.privateKey)) return false;
    return createPublicKey(privateObject(key)).export({ format: "jwk" }).x === key.publicKey;
  } catch {
    return false;
  }
}
/** An Ed25519 signature (base64url) over `text`, made with the relay key. The push route checks it with the public half. */
export const signWithRelayKey = (key, text) => sign(null, Buffer.from(text, "utf8"), privateObject(key)).toString("base64url");
/** The subprotocols that take the seat of `roomOf(key.publicKey)` at `seconds` (Unix time). */
export function hostOffer(key, seconds) {
  const room = roomOf(key.publicKey);
  const signature = sign(null, Buffer.from(hostChallenge(room, seconds), "utf8"), privateObject(key)).toString("base64url");
  return [HOST_PROTOCOL, "k." + key.publicKey, "t." + seconds, "s." + signature];
}

/** The v3 seat proof. The group is shared by the active and standby sockets of one runtime. */
export function hostOfferV3(key, group, seconds) {
  const room = roomOf(key.publicKey);
  const signature = sign(null, Buffer.from(hostChallengeV3(room, group, seconds), "utf8"), privateObject(key)).toString("base64url");
  return [HOST_PROTOCOL_V3, "k." + key.publicKey, "g." + group, "t." + seconds, "s." + signature];
}

/**
 * A relay address as its origin ("https://relay.example.com"), or a thrown message a person can read.
 * Only https is accepted, and http for this computer itself (local development).
 */
export function cleanRelayUrl(value) {
  const bad = new Error("That relay address isn't valid. Use an https:// address.");
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw bad;
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw bad;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw bad;
  return url.origin;
}

const json = (value) => Buffer.from(JSON.stringify(value), "utf8");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

export class RelayLink {
  /**
   * @param options.url       The relay's http(s) origin.
   * @param options.key       This computer's relay key pair { publicKey, privateKey } (see newRelayKey).
   * @param options.serve     async ({ route, session, body, from, conn, gone }) → { status, body }. `route` is
   *                          "hello", "pair", "session" or "rpc"; `from` and `conn` are hex; `gone` is a
   *                          promise that resolves when that phone's socket closed or ours dropped.
   * @param options.onGone    (conn) when a phone with a request in flight left, or for each of them when ours dropped.
   * @param options.onChange  (connected) when the socket comes up or goes down.
   * @param options.onTaken   () when another computer has taken the room three times in a row and this one gives up.
   * @param options.log       Where a line goes. The private key is never in one.
   * @param options.WebSocket The class to open the socket with (tests pass a fake relay's).
   * @param options.timers    { setTimeout, clearTimeout, random, now }: tests pass their own clock.
   */
  constructor({ url, key, serve, onGone = () => {}, onChange = () => {}, onTaken = () => {}, log = () => {}, WebSocket = globalThis.WebSocket, timers = {} }) {
    this.key = key;
    this.secret = key?.privateKey;
    this.publicKey = key?.publicKey;
    this.serve = serve;
    this.onTakenCallback = onTaken;
    this.onGoneCallback = onGone;
    this.onChangeCallback = onChange;
    this.logTo = log;
    this.WebSocketClass = WebSocket;
    this.timers = {
      setTimeout: timers.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
      clearTimeout: timers.clearTimeout ?? ((id) => globalThis.clearTimeout(id)),
      random: timers.random ?? Math.random,
      now: timers.now ?? Date.now,
    };
    this.running = false;
    this.socket = null;
    this.up = false;
    this.attempt = 0;
    this.conns = new Map(); // conn (hex) → { busy }
    this.inFlight = 0;
    this.endpoint = null;
    this.taken = false; // gave up the seat: another computer keeps taking it
    this.takenInARow = 0;
    try {
      const origin = cleanRelayUrl(url);
      if (!validRelayKey(key)) throw new Error("no key");
      this.room = roomOf(key.publicKey);
      this.endpoint = origin.replace(/^http/, "ws") + "/v1/host/" + this.room;
    } catch (error) {
      this.say("relay: not started: " + (error?.message ?? error));
    }
  }

  get connected() {
    return this.up;
  }
  say(text) {
    try {
      this.logTo(this.secret ? String(text).split(this.secret).join("•••") : String(text));
    } catch {}
  }
  later(ms, fn) {
    const id = this.timers.setTimeout(() => {
      try {
        fn();
      } catch (error) {
        this.say("relay: " + (error?.message ?? error));
      }
    }, ms);
    id?.unref?.();
    return id;
  }
  clear(id) {
    if (id !== undefined && id !== null) this.timers.clearTimeout(id);
  }

  /** Opens the socket, and keeps it open until stop(). */
  start() {
    if (this.running || !this.endpoint) return;
    this.running = true;
    this.connect();
  }
  /** Closes the socket and stops trying again. */
  stop() {
    this.running = false;
    this.clear(this.retry);
    this.retry = null;
    const socket = this.socket;
    if (socket) this.lost(socket, 1000, true);
    try {
      socket?.close();
    } catch {}
  }

  connect() {
    this.retry = null;
    if (!this.running || this.socket) return;
    const Socket = this.WebSocketClass;
    if (typeof Socket !== "function") {
      this.say("relay: this system has no WebSocket");
      return;
    }
    let socket;
    try {
      // A fresh signature for every attempt: the relay accepts only a recent time.
      socket = new Socket(this.endpoint, hostOffer(this.key, Math.floor(this.timers.now() / 1000)));
      socket.binaryType = "arraybuffer";
    } catch (error) {
      this.say("relay: couldn't open the socket: " + (error?.message ?? error));
      this.schedule(1006);
      return;
    }
    this.socket = socket;
    const mine = (fn) => (event) => {
      if (this.socket !== socket) return;
      try {
        fn(event);
      } catch (error) {
        this.say("relay: " + (error?.message ?? error));
      }
    };
    socket.onopen = mine(() => this.opened(socket));
    socket.onmessage = mine((event) => this.heard(socket, event.data));
    socket.onclose = mine((event) => this.lost(socket, Number(event?.code) || 1006));
    socket.onerror = () => {};
  }

  opened(socket) {
    this.up = true;
    // A connection that lasts 30 seconds counts as a good one: the next failure starts the backoff over.
    this.stable = this.later(STABLE_MS, () => {
      this.attempt = 0;
      this.takenInARow = 0;
      // A connection that lasts 30 seconds means the seat is ours again.
      if (this.taken) {
        this.taken = false;
        this.say("relay: the seat is ours again");
        this.onChangeCallback(this.up);
      }
    });
    this.nextPing(socket);
    this.say("relay: connected");
    this.onChangeCallback(true);
  }
  nextPing(socket) {
    this.pingTimer = this.later(PING_MS, () => {
      if (this.socket !== socket) return;
      try {
        socket.send("ping");
      } catch {
        return this.drop(socket);
      }
      this.clear(this.deadTimer);
      this.deadTimer = this.later(DEAD_MS, () => {
        this.say("relay: no answer, reconnecting");
        this.drop(socket);
      });
      this.nextPing(socket);
    });
  }
  /** A socket that went quiet is let go and replaced. */
  drop(socket) {
    this.lost(socket, 1006);
    try {
      socket.close();
    } catch {}
  }

  /** The socket ended (or was let go). Every phone that was on it is gone, and a new try is planned. */
  lost(socket, code, stopping = false) {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const id of [this.pingTimer, this.deadTimer, this.stable]) this.clear(id);
    this.pingTimer = this.deadTimer = this.stable = undefined;
    const was = this.up;
    this.up = false;
    for (const conn of [...this.conns.keys()]) this.leave(conn);
    this.conns.clear();
    if (was) {
      try {
        this.onChangeCallback(false);
      } catch (error) {
        this.say("relay: " + (error?.message ?? error));
      }
    }
    if (stopping || !this.running) return;
    this.takenInARow = code === 4000 ? this.takenInARow + 1 : 0;
    if (this.takenInARow >= TAKEN_AFTER) {
      // Something keeps taking this seat. Say so once, and go on trying, but only every 10 minutes: tries
      // in quick succession would only take turns, and a seat proof replayed by someone else must not
      // end the link for good.
      if (!this.taken) {
        this.taken = true;
        this.say("relay: another computer keeps taking this room with the same key; trying again every 10 minutes");
        try {
          this.onTakenCallback();
        } catch (error) {
          this.say("relay: " + (error?.message ?? error));
        }
      }
      return this.schedule(code);
    }
    if (code === 4000) this.say("relay: another computer took over this room with the same key; trying again later");
    else this.say("relay: disconnected (" + code + ")");
    this.schedule(code);
  }
  schedule(code) {
    if (!this.running) return;
    // 1 second, doubling to 60, with a little jitter. Being replaced (4000) waits the longest, so two
    // computers sharing a key don't keep taking the room from each other.
    const base = this.taken && code === 4000 ? TAKEN_RETRY_MS : code === 4000 ? SLOWEST_MS : Math.min(SLOWEST_MS, FIRST_MS * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 16);
    const wait = Math.min(base, Math.round(base * (0.75 + 0.5 * this.timers.random())));
    this.clear(this.retry);
    this.retry = this.later(wait, () => this.connect());
  }

  // ── Messages ────────────────────────────────────────────────────────────────────────────────

  heard(socket, data) {
    // Anything heard shows the socket is alive.
    this.clear(this.deadTimer);
    this.deadTimer = undefined;
    if (typeof data === "string") return;
    // A frame larger than the relay passes is dropped before it is copied or read.
    if (data?.byteLength > MAX_REQUEST_FRAME) return;
    let frame;
    if (data instanceof ArrayBuffer) frame = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) frame = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else return;
    // [conn 8][from 8][type]: shorter than that isn't a frame.
    if (frame.length < 17) return;
    const conn = hex(frame.subarray(0, 8));
    if (frame[16] === 0x04) return this.leave(conn);
    if (frame[16] === 0x01) this.request(socket, frame, conn);
  }
  /** A phone's socket closed (or ours did): what waits on it is told, once. Only phones with a request in flight are known. */
  leave(conn) {
    const state = this.conns.get(conn);
    if (!state) return;
    this.conns.delete(conn);
    state.release();
    try {
      this.onGoneCallback(conn);
    } catch (error) {
      this.say("relay: " + (error?.message ?? error));
    }
  }
  request(socket, frame, conn) {
    // [conn 8][from 8][0x01][id u32][route u8][n u8][session n][body…]
    if (frame.length < 23) return;
    const id = frame.readUInt32BE(17);
    const route = ROUTES[frame[21]];
    const n = frame[22];
    if (!route || 23 + n > frame.length) return;
    const session = frame.subarray(23, 23 + n).toString("latin1");
    const body = frame.subarray(23 + n);
    const reply = (status, bytes) => this.answer(socket, frame.subarray(0, 8), id, status, bytes);
    const slow = () => reply(429, json({ error: "slow_down" }));
    let state = this.conns.get(conn);
    if (!state) {
      // At most 64 phones are known at once, and a phone is known only while it has a request in flight.
      if (this.conns.size >= MAX_CONNS) return slow();
      state = { busy: 0 };
      state.gone = new Promise((resolve) => (state.release = resolve));
      this.conns.set(conn, state);
    }
    // A phone has 8 requests going at most, and all phones together 256. More are told to slow down at once.
    if (state.busy >= PER_CONN || this.inFlight >= IN_ALL) {
      if (!state.busy) this.conns.delete(conn);
      return slow();
    }
    state.busy++;
    this.inFlight++;
    Promise.resolve()
      .then(() => this.serve({ route, session, body, from: hex(frame.subarray(8, 16)), conn, gone: state.gone }))
      .then(
        (answer) => reply(Number(answer?.status) || 500, Buffer.from(answer?.body ?? "")),
        (error) => {
          this.say("relay: " + (error?.message ?? error));
          reply(500, json({ error: "failed" }));
        },
      )
      .finally(() => {
        this.inFlight--;
        // Nothing is kept for a phone with nothing in flight.
        if (--state.busy === 0 && this.conns.get(conn) === state) this.conns.delete(conn);
      });
  }
  answer(socket, conn, id, status, body) {
    if (this.socket !== socket || !this.up) return;
    let bytes = Buffer.concat([conn, Buffer.alloc(7), body]);
    bytes[8] = 0x02;
    bytes.writeUInt32BE(id, 9);
    bytes.writeUInt16BE(status, 13);
    // The relay closes a socket that sends more than 8 MiB, which would cut off every phone.
    if (bytes.length > MAX_MESSAGE) {
      bytes = Buffer.concat([conn, Buffer.alloc(7), json({ error: "too_large" })]);
      bytes[8] = 0x02;
      bytes.writeUInt32BE(id, 9);
      bytes.writeUInt16BE(413, 13);
    }
    try {
      socket.send(bytes);
    } catch (error) {
      this.say("relay: " + (error?.message ?? error));
    }
  }
}

// v3 keeps the phone side of a relay session alive while the computer's transport is replaced.
// It deliberately lives beside RelayLink: old releases and old relays continue to use the v2 class,
// while LinkServer can opt into the two-seat transport without changing the sealed link protocol.
const V3_GROUP = /^[A-Za-z0-9_-]{43}$/;
const V3_GRACE_MS = 15_000;
const V3_CACHE_MS = 5 * 60_000;
const V3_RESULT_BYTES = MAX_MESSAGE - 15;
const V3_CACHE_BYTES = 48 * V3_RESULT_BYTES;
const V3_RETIRED_MAX = 8192;
const V3_MAX_CONNS = 64;
const V3_PER_CONN = 8;
const V3_IN_ALL = 256;

/**
 * A v3 host relay. The relay routes phone requests to its first seat and keeps the second seat hot.
 * The host therefore treats either socket as a transport, and treats requests as durable by
 * conn+id until the phone leaves or the reconnect grace window expires.
 */
export class RelayHost {
  constructor({ url, key, serve, onGone = () => {}, onChange = () => {}, onTaken = () => {}, log = () => {}, WebSocket = globalThis.WebSocket, timers = {}, group, fallbackV2 = true }) {
    this.key = key;
    this.secret = key?.privateKey;
    this.publicKey = key?.publicKey;
    this.serve = serve;
    this.onGoneCallback = onGone;
    this.onChangeCallback = onChange;
    this.onTakenCallback = onTaken;
    this.logTo = log;
    this.WebSocketClass = WebSocket;
    this.timers = {
      setTimeout: timers.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
      clearTimeout: timers.clearTimeout ?? ((id) => globalThis.clearTimeout(id)),
      random: timers.random ?? Math.random,
      now: timers.now ?? Date.now,
    };
    this.running = false;
    this.sockets = new Map(); // socket -> { slot, mode, ping, dead, stable }
    this.socket = null; // active socket, retained for LinkServer's status/debug callers
    this.standby = null;
    this.standbyRetry = null;
    this.standbyAttempt = 0;
    this.up = false;
    this.mode = "v3";
    this.everV3 = false;
    this.fallbackFromV3 = false;
    this.fallbackV2 = fallbackV2 !== false;
    this.group = V3_GROUP.test(group ?? "") ? group : randomBytes(32).toString("base64url");
    this.attempt = 0;
    this.retry = null;
    this.grace = null;
    this.conns = new Map(); // conn hex -> durable request state
    this.cacheBytes = 0;
    this.reservedBytes = 0;
    this.inFlight = 0;
    this.taken = false;
    this.takenInARow = 0;
    this.endpoint = null;
    try {
      const origin = cleanRelayUrl(url);
      if (!validRelayKey(key)) throw new Error("no key");
      this.room = roomOf(key.publicKey);
      this.endpoint = origin.replace(/^http/, "ws") + "/v1/host/" + this.room;
    } catch (error) {
      this.say("relay: not started: " + (error?.message ?? error));
    }
  }

  get connected() {
    return this.up;
  }

  say(text) {
    try {
      this.logTo(this.secret ? String(text).split(this.secret).join("•••") : String(text));
    } catch {}
  }

  later(ms, fn) {
    const id = this.timers.setTimeout(() => {
      try {
        fn();
      } catch (error) {
        this.say("relay: " + (error?.message ?? error));
      }
    }, ms);
    id?.unref?.();
    return id;
  }

  clear(id) {
    if (id !== undefined && id !== null) this.timers.clearTimeout(id);
  }

  start() {
    if (this.running || !this.endpoint) return;
    this.running = true;
    this.connect("active");
  }

  stop() {
    this.running = false;
    this.clear(this.retry);
    this.retry = null;
    this.clear(this.standbyRetry);
    this.standbyRetry = null;
    this.clear(this.grace);
    this.grace = null;
    for (const [socket] of [...this.sockets]) this.finishSocket(socket, 1000, true);
    for (const conn of [...this.conns.keys()]) this.leave(conn);
    this.conns.clear();
    this.clear(this.retry);
    this.retry = null;
  }

  connect(slot) {
    if (!this.running || !this.endpoint || this.socketsFor(slot).length) return;
    const Socket = this.WebSocketClass;
    if (typeof Socket !== "function") {
      this.say("relay: this system has no WebSocket");
      return;
    }
    const seconds = Math.floor(this.timers.now() / 1000);
    const protocols = this.mode === "v3" ? hostOfferV3(this.key, this.group, seconds) : hostOffer(this.key, seconds);
    let socket;
    try {
      socket = new Socket(this.endpoint, protocols);
      socket.binaryType = "arraybuffer";
    } catch (error) {
      this.say("relay: couldn't open the socket: " + (error?.message ?? error));
      if (this.mode === "v3" && this.fallbackV2 && !this.everV3) {
        this.mode = "v2";
        this.fallbackFromV3 = true;
        return this.connect(slot);
      }
      if (this.mode === "v3" && slot === "standby") {
        this.scheduleStandby();
        return;
      }
      this.schedule(1006);
      return;
    }
    const meta = { closed: new AbortController(), slot, mode: this.mode, ping: null, dead: null, stable: null, opened: false };
    this.sockets.set(socket, meta);
    const mine = (fn) => (event) => {
      if (this.sockets.get(socket) !== meta) return;
      try {
        fn(event);
      } catch (error) {
        this.say("relay: " + (error?.message ?? error));
      }
    };
    socket.onopen = mine(() => this.opened(socket, meta));
    socket.onmessage = mine((event) => this.heard(socket, event.data));
    socket.onclose = mine((event) => this.lost(socket, Number(event?.code) || 1006));
    socket.onerror = () => {};
  }

  socketsFor(slot) {
    return [...this.sockets.values()].filter((meta) => meta.slot === slot);
  }

  opened(socket, meta) {
    if (!this.running || this.sockets.get(socket) !== meta) return;
    meta.opened = true;
    if (meta.mode === "v3") this.everV3 = true;
    this.clear(this.grace);
    this.grace = null;
    const wasUp = this.up;
    if (meta.slot === "active" || !this.socket) {
      this.sockets.get(this.socket)?.closed.abort();
      this.socket = socket;
      meta.slot = "active";
      this.standby = null;
      this.up = true;
      this.resendDone(socket);
    } else {
      this.standby = socket;
      this.clear(this.standbyRetry);
      this.standbyRetry = null;
      this.standbyAttempt = 0;
      this.up = true;
    }
    this.armStable(socket, meta);
    this.say("relay: connected");
    if (!wasUp) {
      try {
        this.onChangeCallback(true);
      } catch (error) {
        this.say("relay: " + (error?.message ?? error));
      }
    }
    this.nextPing(socket, meta);
    // The relay accepts two sockets for one v3 group. A v2 relay is left with one seat.
    if (meta.mode === "v3" && !this.standby && meta.slot === "active") this.scheduleStandby(true);
  }

  nextPing(socket, meta) {
    this.clear(meta.ping);
    const pingMs = meta.mode === "v3" ? V3_PING_MS : PING_MS;
    const deadMs = meta.mode === "v3" ? V3_DEAD_MS : DEAD_MS;
    meta.ping = this.later(pingMs, () => {
      if (this.sockets.get(socket) !== meta) return;
      try {
        socket.send("ping");
      } catch {
        return this.drop(socket);
      }
      this.clear(meta.dead);
      meta.dead = this.later(deadMs, () => this.drop(socket));
      this.nextPing(socket, meta);
    });
  }

  armStable(socket, meta) {
    if (meta.slot !== "active") return;
    this.clear(meta.stable);
    meta.stable = this.later(STABLE_MS, () => {
      if (this.sockets.get(socket) !== meta) return;
      this.attempt = 0;
      this.takenInARow = 0;
      if (this.taken) {
        this.taken = false;
        this.say("relay: the seat is ours again");
        try { this.onChangeCallback(true); } catch (error) { this.say("relay: " + (error?.message ?? error)); }
      }
    });
  }

  drop(socket) {
    if (!this.sockets.has(socket)) return;
    this.lost(socket, 1006);
    try {
      socket.close();
    } catch {}
  }

  lost(socket, code) {
    const meta = this.sockets.get(socket);
    if (!meta) return;
    const wasOpened = meta.opened;
    const takenCode = code === 4000;
    if (wasOpened && meta.mode === "v3" && !takenCode) this.attempt = 0;
    this.clear(meta.ping);
    this.clear(meta.dead);
    this.clear(meta.stable);
    this.sockets.delete(socket);
    meta.closed.abort();
    // A 4000 is a group-level seat loss. Do not promote the standby: a sibling
    // with the same proof would immediately take the room back from its owner.
    if (takenCode) {
      this.clear(this.standbyRetry);
      this.standbyRetry = null;
      this.standbyAttempt = 0;
      for (const [sibling, siblingMeta] of [...this.sockets]) {
        this.clear(siblingMeta.ping);
        this.clear(siblingMeta.dead);
        this.clear(siblingMeta.stable);
        this.sockets.delete(sibling);
        siblingMeta.closed.abort();
        try { sibling.close(4000); } catch {}
      }
      this.socket = null;
      this.standby = null;
    } else if (this.socket === socket) {
      this.socket = this.standby && this.sockets.has(this.standby) ? this.standby : null;
      if (this.socket) {
        const promoted = this.sockets.get(this.socket);
        if (promoted) {
          promoted.slot = "active";
          this.armStable(this.socket, promoted);
          this.resendDone(this.socket);
        }
        this.standby = null;
      }
    } else if (this.standby === socket) {
      this.standby = null;
    }
    const anyOpen = [...this.sockets.values()].some((entry) => entry.opened);
    if (anyOpen) {
      this.up = true;
      if (this.mode === "v3" && !this.standby) this.scheduleStandby();
    } else {
      this.up = false;
      if (this.mode === "v3") {
        if (this.conns.size) this.armGrace();
      } else {
        for (const conn of [...this.conns.keys()]) this.leave(conn);
      }
      try {
        this.onChangeCallback(false);
      } catch (error) {
        this.say("relay: " + (error?.message ?? error));
      }
    }
    if (!this.running) return;
    // A v3-only relay refuses the v3 seat before `open`; retrying v2 keeps old relays usable.
    if (!wasOpened && meta.mode === "v3" && this.fallbackV2 && !this.everV3) {
      this.say("relay: disconnected (" + code + ")");
      this.mode = "v2";
      this.fallbackFromV3 = true;
      this.connect(meta.slot);
      return;
    }
    if (this.mode === "v2" && this.fallbackFromV3 && wasOpened && !takenCode) {
      this.mode = "v3";
      this.everV3 = false;
      this.fallbackFromV3 = false;
      this.schedule(code);
      return;
    }
    if (takenCode) {
      this.takenInARow++;
      this.say("relay: another computer took over this room; trying again later");
    } else {
      this.takenInARow = 0;
      this.say("relay: disconnected (" + code + ")");
    }
    if (this.takenInARow >= TAKEN_AFTER && !this.taken) {
      this.taken = true;
      this.say("relay: another computer keeps taking this room with the same key; trying again every 10 minutes");
      try {
        this.onTakenCallback();
      } catch (error) {
        this.say("relay: " + (error?.message ?? error));
      }
    }
    this.schedule(code);
  }

  finishSocket(socket, code, stopping = false) {
    const meta = this.sockets.get(socket);
    if (!meta) return;
    this.lost(socket, code);
    try {
      socket.close(code);
    } catch {}
    if (stopping) this.sockets.delete(socket);
  }

  schedule(code) {
    if (!this.running || this.retry) return;
    const base = this.taken && code === 4000 ? TAKEN_RETRY_MS : code === 4000 ? SLOWEST_MS : Math.min(SLOWEST_MS, FIRST_MS * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 16);
    const wait = Math.min(base, Math.round(base * (0.75 + 0.5 * this.timers.random())));
    this.retry = this.later(wait, () => {
      this.retry = null;
      this.connect("active");
    });
  }

  scheduleStandby(immediate = false) {
    if (!this.running || this.mode !== "v3" || this.standby || this.standbyRetry || this.socketsFor("standby").length) return;
    const base = immediate ? 0 : Math.min(SLOWEST_MS, FIRST_MS * 2 ** this.standbyAttempt++);
    const wait = immediate ? 0 : Math.min(base, Math.round(base * (0.75 + 0.5 * this.timers.random())));
    this.standbyRetry = this.later(wait, () => {
      this.standbyRetry = null;
      this.connect("standby");
    });
  }

  armGrace() {
    if (this.grace || !this.conns.size) return;
    this.grace = this.later(V3_GRACE_MS, () => {
      this.grace = null;
      for (const conn of [...this.conns.keys()]) this.leave(conn);
      this.conns.clear();
    });
  }

  heard(socket, data) {
    // Any frame, including pong, proves this transport is alive.
    const meta = this.sockets.get(socket);
    if (!meta) return;
    this.clear(meta.dead);
    meta.dead = null;
    if (typeof data === "string") return;
    if (data?.byteLength > MAX_REQUEST_FRAME) return;
    let frame;
    if (data instanceof ArrayBuffer) frame = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) frame = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else return;
    if (frame.length < 17) return;
    const conn = hex(frame.subarray(0, 8));
    if (frame[16] === 0x04) return this.leave(conn);
    if (frame[16] === 0x06) return meta.mode === "v3" && this.ack(frame, conn);
    if (frame[16] === 0x01) return this.request(socket, frame, conn, meta.mode === "v3");
  }

  /** The v3 room acknowledges an answer after accepting it; keep only a replay tombstone. */
  ack(frame, conn) {
    if (frame.length < 21) return;
    const state = this.conns.get(conn);
    const id = frame.readUInt32BE(17);
    const entry = state?.entries.get(id);
    if (!entry || entry.kind !== "done") return;
    state.entries.delete(id);
    this.reservedBytes -= V3_RESULT_BYTES;
    this.cacheBytes -= entry.body.length;
    this.retire(state, id);
  }

  /**
   * A seat that just became active sends again every answer the room has not acknowledged. The room
   * keeps requests in memory only, so after a gap it may not ask for them again. It drops a repeat
   * of an answer it already took, and a phone ignores an answer it no longer waits for.
   */
  resendDone(socket) {
    if (this.sockets.get(socket)?.mode !== "v3") return;
    for (const [conn, state] of this.conns) {
      for (const [id, entry] of state.entries) {
        if (entry.kind === "done") this.answer(socket, Buffer.from(conn, "hex"), id, entry.status, entry.body);
      }
    }
  }

  stateFor(conn) {
    let state = this.conns.get(conn);
    if (state) return state;
    if (this.conns.size >= V3_MAX_CONNS) return null;
    state = { left: new AbortController(), busy: 0, entries: new Map(), retired: new Set(), retiredOrder: [], gone: null, release: null };
    state.gone = new Promise((resolve) => (state.release = resolve));
    this.conns.set(conn, state);
    return state;
  }

  prune(state) {
    const now = this.timers.now();
    for (const [id, entry] of [...state.entries]) {
      if (entry.kind === "done" && now - entry.at > V3_CACHE_MS) {
        state.entries.delete(id);
        this.reservedBytes -= V3_RESULT_BYTES;
        this.cacheBytes -= entry.body.length;
        this.retire(state, id);
      }
    }
  }

  pruneAll() {
    for (const state of this.conns.values()) this.prune(state);
  }

  retire(state, id) {
    state.retired.add(id);
    state.retiredOrder.push(id);
    while (state.retiredOrder.length > V3_RETIRED_MAX) state.retired.delete(state.retiredOrder.shift());
  }

  request(socket, frame, conn, isV3 = true) {
    // [conn 8][from 8][0x01][id u32][route u8][n u8][session n][body…]
    if (frame.length < 23) return;
    const id = frame.readUInt32BE(17);
    const route = ROUTES[frame[21]];
    const n = frame[22];
    if (!route || 23 + n > frame.length) return;
    // Only the room's active seat receives requests. It can reseat before a local close arrives.
    if (isV3 && this.standby === socket && this.socket) {
      const previous = this.sockets.get(this.socket);
      previous.closed.abort();
      previous.closed = new AbortController();
      previous.slot = "standby";
      this.clear(previous.stable);
      this.standby = this.socket;
      this.socket = socket;
      const active = this.sockets.get(socket);
      active.slot = "active";
      this.armStable(socket, active);
      this.resendDone(socket);
    }
    if (isV3) this.pruneAll();
    const state = this.stateFor(conn);
    if (!state) return this.answer(socket, frame.subarray(0, 8), id, 429, json({ error: "slow_down" }));
    this.prune(state);
    const existing = state.entries.get(id);
    if (existing) {
      if (existing.kind === "done") this.answer(socket, frame.subarray(0, 8), id, existing.status, existing.body);
      else existing.socket = socket;
      // A duplicate pending request deliberately does not call serve again, but the latest seat
      // that observed it is the best route for the eventual answer if the original is blackholed.
      return;
    }
    if (state.retired.has(id)) return this.answer(socket, frame.subarray(0, 8), id, 409, json({ error: "replay" }));
    if (state.busy >= V3_PER_CONN || this.inFlight >= V3_IN_ALL) return this.answer(socket, frame.subarray(0, 8), id, 429, json({ error: "slow_down" }));
    if (isV3 && this.reservedBytes + V3_RESULT_BYTES > V3_CACHE_BYTES) return this.answer(socket, frame.subarray(0, 8), id, 429, json({ error: "slow_down" }));
    const item = {
      id,
      connBytes: frame.subarray(0, 8),
      from: hex(frame.subarray(8, 16)),
      route,
      session: frame.subarray(23, 23 + n).toString("latin1"),
      body: frame.subarray(23 + n),
      isV3,
      socket,
    };
    if (isV3) this.reservedBytes += V3_RESULT_BYTES;
    const closed = AbortSignal.any([state.left.signal, this.sockets.get(socket).closed.signal]);
    const push = {
      closed,
      ready: () => this.socket === socket && !(socket.bufferedAmount > PUSH_BUFFER_LIMIT),
      send: (part) => {
        if (part.length + 13 > MAX_MESSAGE) throw new Error("Follow part too large");
        const header = Buffer.alloc(13);
        item.connBytes.copy(header);
        header[8] = 0x07;
        header.writeUInt32BE(id, 9);
        socket.send(Buffer.concat([header, part]));
      },
    };
    state.entries.set(id, { kind: "pending", at: this.timers.now(), socket, isV3 });
    state.busy++;
    this.inFlight++;
    Promise.resolve()
      .then(() => this.serve({ route: item.route, session: item.session, body: item.body, from: item.from, conn: item.connBytes.toString("hex"), gone: state.gone, push }))
      .then(
        (answer) => this.complete(state, item, Number(answer?.status) || 500, Buffer.from(answer?.body ?? "")),
        (error) => {
          this.say("relay: " + (error?.message ?? error));
          this.complete(state, item, 500, json({ error: "failed" }));
        },
      )
      .finally(() => {
        this.inFlight--;
        state.busy--;
        if (!item.isV3 && state.busy === 0 && this.conns.get(item.connBytes.toString("hex")) === state) {
          this.conns.delete(item.connBytes.toString("hex"));
          state.entries.clear();
        }
      });
  }

  complete(state, item, status, body) {
    const entry = state.entries.get(item.id);
    if (!entry || entry.kind !== "pending") return;
    if (body.length + 15 > MAX_MESSAGE) {
      status = 413;
      body = json({ error: "too_large" });
    }
    const destination = this.sockets.has(entry.socket) ? entry.socket : this.socket ?? this.standby;
    if (!item.isV3) {
      this.answer(destination, item.connBytes, item.id, status, body);
      state.entries.delete(item.id);
      return;
    }
    this.cacheBytes += body.length;
    state.entries.set(item.id, { kind: "done", status, body, at: this.timers.now() });
    this.prune(state);
    this.answer(destination, item.connBytes, item.id, status, body);
  }

  answer(socket, conn, id, status, body) {
    if (!socket || !this.sockets.has(socket)) return;
    let bytes = Buffer.concat([conn, Buffer.alloc(7), body]);
    bytes[8] = 0x02;
    bytes.writeUInt32BE(id, 9);
    bytes.writeUInt16BE(status, 13);
    if (bytes.length > MAX_MESSAGE) {
      bytes = Buffer.concat([conn, Buffer.alloc(7), json({ error: "too_large" })]);
      bytes[8] = 0x02;
      bytes.writeUInt32BE(id, 9);
      bytes.writeUInt16BE(413, 13);
    }
    try {
      socket.send(bytes);
    } catch (error) {
      this.say("relay: " + (error?.message ?? error));
    }
  }

  leave(conn) {
    const state = this.conns.get(conn);
    if (!state) return;
    this.conns.delete(conn);
    state.left.abort();
    for (const entry of state.entries.values()) {
      if (entry.kind === "done" || entry.isV3) this.reservedBytes -= V3_RESULT_BYTES;
      if (entry.kind === "done") this.cacheBytes -= entry.body.length;
    }
    state.entries.clear();
    try {
      state.release?.();
    } catch {}
    try {
      this.onGoneCallback(conn);
    } catch (error) {
      this.say("relay: " + (error?.message ?? error));
    }
  }
}
