import assert from "node:assert/strict";
import test from "node:test";
import { RelayHost, RelayLink, newRelayKey, HOST_PROTOCOL, HOST_PROTOCOL_V3 } from "../desktop/link/relay.mjs";

class Clock {
  constructor() { this.time = 1_700_000_000_000; this.next = 1; this.tasks = new Map(); }
  setTimeout = (fn, ms) => { const id = this.next++; this.tasks.set(id, { at: this.time + ms, fn }); return id; };
  clearTimeout = (id) => this.tasks.delete(id);
  random = () => 0;
  now = () => this.time;
  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.tasks.delete(next[0]); next[1].fn(); await Promise.resolve();
    }
    this.time = end;
  }
  get timers() { return { setTimeout: this.setTimeout, clearTimeout: this.clearTimeout, random: this.random, now: this.now }; }
}

class Socket {
  static all = [];
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; this.readyState = 0; Socket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(data) { this.sent.push(Buffer.from(data)); }
  close(code = 1006) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  feed(data) { this.onmessage?.({ data }); }
}

const frame = (conn, id, body = "{}") => {
  const payload = Buffer.from(body); const out = Buffer.alloc(23 + payload.length);
  Buffer.from(conn, "hex").copy(out, 0); Buffer.from("b".repeat(16), "hex").copy(out, 8);
  out[16] = 1; out.writeUInt32BE(id, 17); out[21] = 4; out[22] = 0; payload.copy(out, 23); return out;
};
const ackFrame = (conn, id) => {
  const out = Buffer.alloc(21);
  Buffer.from(conn, "hex").copy(out, 0); Buffer.from("b".repeat(16), "hex").copy(out, 8);
  out[16] = 6; out.writeUInt32BE(id, 17); return out;
};
const answerId = (bytes) => bytes.readUInt32BE(9);

function newLink(options = {}) {
  Socket.all = []; const clock = new Clock();
  const link = new RelayHost({ url: "https://relay.test", key: newRelayKey(), serve: async () => ({ status: 200, body: Buffer.from("ok") }), WebSocket: Socket, timers: clock.timers, ...options });
  return { link, clock };
}

test("v3 uses one signed group for active and standby seats", async () => {
  const { link, clock } = newLink(); link.start(); assert.equal(Socket.all.length, 1);
  const active = Socket.all[0]; assert.equal(active.protocols[0], HOST_PROTOCOL_V3);
  const group = active.protocols.find((part) => part.startsWith("g.")); assert.match(group, /^g\.[A-Za-z0-9_-]{43}$/);
  active.open(); await clock.advance(0); assert.equal(Socket.all.length, 2);
  assert.equal(Socket.all[1].protocols[0], HOST_PROTOCOL_V3); assert.equal(Socket.all[1].protocols.find((part) => part.startsWith("g.")), group); link.stop();
});

test("v3 probes every five seconds and reconnects both dead seats within the first retry", async () => {
  const { link, clock } = newLink(); link.start();
  const active = Socket.all[0]; active.open(); await clock.advance(0);
  const standby = Socket.all[1]; standby.open();

  await clock.advance(4_999); assert.deepEqual(active.sent, []);
  await clock.advance(1); assert.deepEqual(active.sent, [Buffer.from("ping")]);
  await clock.advance(3_999); assert.equal(active.readyState, 1);
  await clock.advance(1); assert.equal(active.readyState, 3);

  await clock.advance(749); assert.equal(Socket.all.length, 2);
  await clock.advance(1); assert.equal(Socket.all.length, 4);
  link.stop();
});

test("v2 keeps its existing heartbeat timing", async () => {
  Socket.all = []; const clock = new Clock();
  const link = new RelayLink({ url: "https://relay.test", key: newRelayKey(), serve: async () => ({ status: 200, body: Buffer.from("ok") }), WebSocket: Socket, timers: clock.timers });
  link.start(); const socket = Socket.all[0]; socket.open();

  await clock.advance(24_999); assert.deepEqual(socket.sent, []);
  await clock.advance(1); assert.deepEqual(socket.sent, [Buffer.from("ping")]);
  await clock.advance(9_999); assert.equal(socket.readyState, 1);
  await clock.advance(1); assert.equal(socket.readyState, 3);
  link.stop();
});

test("a RelayHost v2 fallback keeps its existing heartbeat timing", async () => {
  class V2Socket extends Socket {
    constructor(url, protocols) {
      super(url, protocols);
      if (protocols[0] === HOST_PROTOCOL_V3) queueMicrotask(() => this.close(1002));
    }
  }
  Socket.all = []; const clock = new Clock();
  const link = new RelayHost({ url: "https://relay.test", key: newRelayKey(), serve: async () => ({ status: 200, body: Buffer.from("ok") }), WebSocket: V2Socket, timers: clock.timers });
  link.start(); await Promise.resolve(); const legacy = Socket.all[1]; legacy.open();

  await clock.advance(24_999); assert.deepEqual(legacy.sent, []);
  await clock.advance(1); assert.deepEqual(legacy.sent, [Buffer.from("ping")]);
  await clock.advance(9_999); assert.equal(legacy.readyState, 1);
  await clock.advance(1); assert.equal(legacy.readyState, 3);
  link.stop();
});

test("v3 double losses of a known-good group restart the active retry backoff", async () => {
  const { link, clock } = newLink(); link.start();
  const firstActive = Socket.all[0]; firstActive.open(); await clock.advance(0);
  const firstStandby = Socket.all[1]; firstStandby.open();

  for (let cycle = 0; cycle < 5; cycle++) {
    const active = link.socket; const standby = link.standby;
    assert.ok(active); assert.ok(standby);
    const before = Socket.all.length;
    active.close(1006); standby.close(1006);
    await clock.advance(749); assert.equal(Socket.all.length, before);
    await clock.advance(1); assert.equal(Socket.all.length, before + 2, `cycle ${cycle}: reconnect both seats`);
    const [nextStandby, nextActive] = Socket.all.slice(before);
    nextActive.open(); nextStandby.open();
  }
  link.stop();
});

test("v3 failures before a socket opens keep exponential active backoff", async () => {
  class RejectV3 extends Socket {
    constructor(url, protocols) {
      super(url, protocols);
      queueMicrotask(() => this.close(1006));
    }
  }
  Socket.all = []; const clock = new Clock();
  const link = new RelayHost({ url: "https://relay.test", key: newRelayKey(), serve: async () => ({ status: 200, body: Buffer.from("ok") }), WebSocket: RejectV3, timers: clock.timers, fallbackV2: false });
  link.start(); await Promise.resolve();
  for (const wait of [750, 1_500, 3_000]) {
    const before = Socket.all.length;
    await clock.advance(wait - 1); assert.equal(Socket.all.length, before);
    await clock.advance(1); assert.equal(Socket.all.length, before + 1);
    await Promise.resolve();
  }
  link.stop();
});

test("v3 services and answers authenticated requests on either seat exactly once", async () => {
  let calls = 0;
  const { link, clock } = newLink({ serve: async () => { calls++; return { status: 200, body: Buffer.from("ok") }; } });
  link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0);
  const standby = Socket.all[1]; standby.open();
  const activeConn = "07".repeat(8); const standbyConn = "08".repeat(8);

  active.feed(frame(activeConn, 1, "active")); standby.feed(frame(standbyConn, 2, "standby"));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(calls, 2);
  assert.deepEqual(active.sent.map(answerId), [1]);
  assert.deepEqual(standby.sent.map(answerId), [2]);

  active.feed(ackFrame(activeConn, 1)); standby.feed(ackFrame(standbyConn, 2));
  assert.equal(link.cacheBytes, 0);
  active.feed(frame(activeConn, 1)); standby.feed(frame(standbyConn, 2));
  for (let i = 0; i < 2; i++) await Promise.resolve();
  assert.equal(active.sent.at(-1).readUInt16BE(13), 409);
  assert.equal(standby.sent.at(-1).readUInt16BE(13), 409);
  link.stop();
});

test("v3 answers a pending replay on the latest observed seat", async () => {
  let calls = 0; let finish;
  const { link, clock } = newLink({ serve: () => { calls++; return new Promise((resolve) => (finish = resolve)); } });
  link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0);
  const standby = Socket.all[1]; standby.open(); const conn = "09".repeat(8);

  active.feed(frame(conn, 1, "original"));
  for (let i = 0; i < 2; i++) await Promise.resolve();
  assert.equal(calls, 1);
  standby.feed(frame(conn, 1, "replay"));
  finish({ status: 200, body: Buffer.from("done") });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(active.sent.map(answerId), []);
  assert.deepEqual(standby.sent.map(answerId), [1]);
  link.stop();
});

test("an in-flight request runs once and answers after active transport promotion", async () => {
  let calls = 0; let finish;
  const { link, clock } = newLink({ serve: () => { calls++; return new Promise((resolve) => (finish = resolve)); } });
  link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0); const standby = Socket.all[1]; standby.open();
  const conn = "01".repeat(8); active.feed(frame(conn, 42)); active.feed(frame(conn, 42)); await Promise.resolve();
  assert.equal(calls, 1, "a duplicate received before the first answer must not run the handler twice"); active.close(); finish({ status: 200, body: Buffer.from("done") });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(link.connected, true); assert.deepEqual(standby.sent.map(answerId), [42]); link.stop();
});

test("requests on one connection run concurrently, so a long poll does not block the next answer", async () => {
  const finishes = new Map();
  const { link, clock } = newLink({ serve: ({ body }) => new Promise((resolve) => finishes.set(body.toString(), resolve)) });
  link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0);
  active.feed(frame("03".repeat(8), 1, "long-poll")); active.feed(frame("03".repeat(8), 2, "ordinary-rpc"));
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.equal(finishes.size, 2);
  finishes.get("ordinary-rpc")({ status: 200, body: Buffer.from("second") });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.deepEqual(active.sent.map(answerId), [2]);
  finishes.get("long-poll")({ status: 200, body: Buffer.from("first") });
  link.stop();
});

test("a standby that finishes while the active socket is down is promoted before a new active attempt", async () => {
  const { link, clock } = newLink(); link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0);
  const standby = Socket.all[1]; active.close(); standby.open();
  assert.equal(link.connected, true); assert.equal(link.socket, standby); assert.equal(link.standby, null);
  link.stop();
});

test("rejected standby sockets use bounded backoff instead of a reconnect loop", async () => {
  class RejectStandby extends Socket {
    constructor(url, protocols) {
      super(url, protocols);
      if (Socket.all.length > 1 && protocols[0] === HOST_PROTOCOL_V3) queueMicrotask(() => this.close(1006));
    }
  }
  Socket.all = []; const clock = new Clock();
  const link = new RelayHost({ url: "https://relay.test", key: newRelayKey(), serve: async () => ({ status: 200, body: Buffer.from("ok") }), WebSocket: RejectStandby, timers: clock.timers });
  link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0); await Promise.resolve();
  const afterFirst = Socket.all.length;
  await clock.advance(749); assert.equal(Socket.all.length, afterFirst);
  await clock.advance(1); await Promise.resolve();
  assert.equal(Socket.all.length, afterFirst + 1);
  link.stop();
});

test("the bounded result window rejects new calls before evicting unacknowledged replies", async () => {
  let calls = 0;
  const { link, clock } = newLink({ serve: async () => { calls++; return { status: 200, body: Buffer.alloc(5_000_000) }; } });
  link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0);
  const conns = Array.from({ length: 6 }, (_, index) => (index + 4).toString(16).repeat(16));
  for (const conn of conns) for (let id = 1; id <= 8; id++) active.feed(frame(conn, id));
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(calls, 48); assert.equal(link.reservedBytes, 48 * (8 * 1024 * 1024 - 15));
  const extra = "10".repeat(8); active.feed(frame(extra, 1)); await Promise.resolve();
  assert.equal(calls, 48); assert.equal(active.sent.at(-1).readUInt16BE(13), 429);
  active.feed(ackFrame(conns[0], 1)); active.feed(frame(extra, 1));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(calls, 49); assert.equal(active.sent.at(-1).readUInt16BE(13), 200); link.stop();
});

test("a v3 answer acknowledgement releases its body but still refuses a replay", async () => {
  const { link, clock } = newLink(); link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0);
  const conn = "05".repeat(8); active.feed(frame(conn, 9));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(link.cacheBytes, 2);
  active.feed(ackFrame(conn, 9)); assert.equal(link.cacheBytes, 0);
  active.feed(frame(conn, 9)); await Promise.resolve();
  assert.equal(active.sent.at(-1).readUInt16BE(13), 409); link.stop();
});

test("expired cached replies release their byte accounting and stay replay-protected", async () => {
  const { link, clock } = newLink(); link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0);
  const conn = "06".repeat(8); active.feed(frame(conn, 1));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(link.cacheBytes, 2);
  clock.time += 300_001; active.feed(frame(conn, 2));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(link.cacheBytes, 2);
  active.feed(frame(conn, 1)); await Promise.resolve();
  assert.equal(active.sent.at(-1).readUInt16BE(13), 409); link.stop();
});

test("a dead relay is tolerated for the grace window, then releases phones", async () => {
  const gone = []; const { link, clock } = newLink({ onGone: (conn) => gone.push(conn) });
  link.start(); const active = Socket.all[0]; active.open(); await clock.advance(0); active.feed(frame("02".repeat(8), 1)); await Promise.resolve(); active.close();
  await clock.advance(14_999); assert.deepEqual(gone, []); await clock.advance(1); assert.deepEqual(gone, ["0202020202020202"]); link.stop();
});

test("falls back to the v2 seat proof when a relay rejects v3 before opening", async () => {
  class V2OnlySocket extends Socket {
    constructor(url, protocols) { super(url, protocols); if (protocols[0] === HOST_PROTOCOL_V3) queueMicrotask(() => this.close(1002)); }
  }
  const clock = new Clock(); Socket.all = [];
  const link = new RelayHost({ url: "https://relay.test", key: newRelayKey(), serve: async () => ({ status: 200, body: Buffer.from("ok") }), WebSocket: V2OnlySocket, timers: clock.timers });
  link.start(); await Promise.resolve(); assert.equal(Socket.all.length, 2); assert.equal(Socket.all[1].protocols[0], HOST_PROTOCOL); link.stop();
});

test("reprobes v3 after an established compatibility connection drops", async () => {
  class ReprobeSocket extends Socket {
    constructor(url, protocols) {
      super(url, protocols);
      if (protocols[0] === HOST_PROTOCOL_V3) queueMicrotask(() => this.close(1006));
      else queueMicrotask(() => this.open());
    }
  }
  Socket.all = []; const clock = new Clock();
  const link = new RelayHost({ url: "https://relay.test", key: newRelayKey(), serve: async () => ({ status: 200, body: Buffer.from("ok") }), WebSocket: ReprobeSocket, timers: clock.timers });
  link.start();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(Socket.all[0].protocols[0], HOST_PROTOCOL_V3); assert.equal(Socket.all[1].protocols[0], HOST_PROTOCOL);
  Socket.all[1].close(1006); await clock.advance(750); await Promise.resolve();
  assert.equal(Socket.all[2].protocols[0], HOST_PROTOCOL_V3); link.stop();
});

test("the v2 fallback does not consume the v3 acknowledgement window", async () => {
  class V2Socket extends Socket {
    constructor(url, protocols) {
      super(url, protocols);
      if (protocols[0] === HOST_PROTOCOL_V3) queueMicrotask(() => this.close(1006));
      else queueMicrotask(() => this.open());
    }
  }
  let calls = 0; Socket.all = []; const clock = new Clock();
  const link = new RelayHost({ url: "https://relay.test", key: newRelayKey(), serve: async () => { calls++; return { status: 200, body: Buffer.from("ok") }; }, WebSocket: V2Socket, timers: clock.timers });
  link.start(); for (let i = 0; i < 5; i++) await Promise.resolve();
  const active = Socket.all[1]; const conn = "11".repeat(8);
  for (let id = 1; id <= 75; id++) {
    active.feed(frame(conn, id));
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }
  assert.equal(calls, 75); assert.equal(active.sent.at(-1).readUInt16BE(13), 200); link.stop();
});

test("follow parts use the active seat, respect backpressure and never enter the replay cache", async () => {
  let calls = 0;
  let stream;
  const { link, clock } = newLink({ serve: async ({ push }) => {
    calls++;
    stream = push;
    await new Promise(resolve => push.closed.addEventListener("abort", resolve, { once: true }));
    return { status: 200, body: Buffer.from("end") };
  } });
  link.start();
  const active = Socket.all[0];
  active.open();
  await clock.advance(0);
  const standby = Socket.all[1];
  standby.open();
  const request = frame("01".repeat(8), 42);
  active.feed(request);
  await Promise.resolve();
  active.bufferedAmount = 1024 * 1024;
  assert.equal(stream.ready(), false);
  active.bufferedAmount = 0;
  assert.equal(stream.ready(), true);
  stream.send(Buffer.from("part"));
  assert.equal(active.sent[0][8], 7);
  assert.equal(answerId(active.sent[0]), 42);
  assert.equal(link.cacheBytes, 0);
  active.feed(request);
  assert.equal(stream.closed.aborted, false);
  standby.feed(request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(stream.closed.aborted, true);
  assert.equal(standby.sent[0][8], 2);
  assert.equal(link.cacheBytes, 3);
  link.stop();
});

test("a new active seat sends unacknowledged answers again without a replay", async () => {
  const { link, clock } = newLink();
  link.start();
  const active = Socket.all[0];
  active.open();
  await clock.advance(0);
  const standby = Socket.all[1];
  standby.open();
  active.feed(frame("01".repeat(8), 7));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(answerId(active.sent.at(-1)), 7);
  // The answer may have been lost with the socket, and the room may have forgotten the request.
  active.close(1006);
  const again = standby.sent.find(bytes => bytes[8] === 2);
  assert.equal(answerId(again), 7);
  standby.feed(ackFrame("01".repeat(8), 7));
  assert.equal(link.cacheBytes, 0);
  link.stop();
});
