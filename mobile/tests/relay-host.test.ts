// The computer's end of the relay: link-host/relay.mjs and the way LinkHost uses it. The relay is
// FakeRelay (tests/fake-relay.ts, whose header is the wire format), and the clock is a fake one, so
// backoff and pings are tested without waiting. A phone is played by hand with frames, and once by
// the real phone client over a fetch that carries its calls through the fake relay.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { newKeyPair, unbox } from "../link-host/crypto.mjs";
import { LinkHost, qrText } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { cleanRelayUrl, DEFAULT_RELAY_URL, hostOffer, MAX_REQUEST_FRAME, newRelayKey, RelayLink, roomOf as hostRoomOf } from "../link-host/relay.mjs";
import { LinkStore } from "../link-host/store.mjs";
import { type FetchLike, LinkClient, LinkError, pair } from "../src/link/client";
import { FakeRelay, hostProof, MAX_PHONE_MESSAGE, roomOf } from "./fake-relay";

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const folders: string[] = [];
const scratch = () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "botkins-relay-")));
  folders.push(folder);
  return folder;
};
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await tick(10);
  }
}

/** A clock the test turns by hand. `random` is fixed at the middle, so jitter is exactly 1. */
function clock() {
  let now = 0;
  let next = 0;
  let skew = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        pending.set(++next, { at: now + ms, fn });
        return next;
      },
      clearTimeout: (id: number) => void pending.delete(id),
      random: () => 0.5,
      // The computer's wall clock, which signs its seat. `time.skew(ms)` sets it wrong on purpose.
      now: () => Date.now() + skew,
    },
    skew: (ms: number) => void (skew = ms),
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    /** How long until each pending timer, soonest first. */
    delays: () => [...pending.values()].map((t) => t.at - now).sort((a, b) => a - b),
  };
}

/** A computer with the relay on, connected to a fake relay. */
async function start(options: Record<string, unknown> = {}) {
  const relay = new FakeRelay();
  const time = clock();
  const logs: string[] = [];
  const dir = scratch();
  const link = new LinkHost({
    dir,
    backend: new MockBackend({ speed: 0.05 }),
    port: 0,
    extraHosts: ["127.0.0.1"],
    searchPath: [],
    log: (line: string) => logs.push(line),
    relay: { url: "https://relay.test", WebSocket: relay.WebSocket, timers: time.timers },
    ...options,
    ...(typeof options.relay === "function" ? { relay: options.relay(relay, time) } : {}),
  });
  await link.setEnabled(true);
  // The relay is off until someone turns it on; an object given to the constructor only overrides address, socket class and clock.
  link.setRelay({ enabled: true });
  const key: { publicKey: string; privateKey: string } = link.store.relayKey();
  const room = roomOf(key.publicKey);
  await until(() => link.status().relay.connected, "the computer to connect");
  return { relay, time, logs, link, key, room, dir };
}

const u32 = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const stepBack = async (time: ReturnType<typeof clock>) => {
  await until(() => time.delays().length > 0, "the reconnect timer");
  time.advance(time.delays()[0]);
  await until(() => time.delays().length > 0, "the handshake to schedule its next timer");
};

/** A phone played by hand: it sends request frames and collects the answers. */
function phone(relay: FakeRelay, room: string, from = 1) {
  relay.nextFrom = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, from);
  const socket: any = new (relay.WebSocket as any)("wss://relay.test/v1/room/" + room, ["botkins.phone.v1"]);
  socket.binaryType = "arraybuffer";
  const waiting = new Map<number, { resolve: (a: any) => void; reject: (e: Error) => void }>();
  let next = 1;
  const opened = new Promise<void>((resolve) => (socket.onopen = () => resolve()));
  socket.onmessage = (event: { data: ArrayBuffer | string }) => {
    if (typeof event.data === "string") return;
    const bytes = Buffer.from(event.data);
    if (bytes[0] === 0x05) {
      // The computer left the relay: nothing that is waiting will be answered.
      for (const [, entry] of waiting) entry.reject(new TypeError("The computer left the relay"));
      return waiting.clear();
    }
    if (bytes.length < 5) return;
    const id = bytes.readUInt32BE(1);
    if (bytes[0] === 0x02) waiting.get(id)?.resolve({ status: bytes.readUInt16BE(5), body: bytes.subarray(7) });
    else if (bytes[0] === 0x03) waiting.get(id)?.resolve({ status: 0, body: Buffer.alloc(0), relayDown: true });
    waiting.delete(id);
  };
  socket.onclose = () => {
    for (const [, entry] of waiting) entry.reject(new TypeError("The socket closed"));
    waiting.clear();
  };
  /** Sends one request. route: 1 hello, 2 pair, 3 session, 4 rpc. */
  const ask = async (route: number, session = "", body: Buffer | Uint8Array | string = Buffer.alloc(0)) => {
    await opened;
    const id = next++;
    const frame = Buffer.concat([Buffer.from([0x01]), u32(id), Buffer.from([route, session.length]), Buffer.from(session, "ascii"), Buffer.from(body)]);
    return new Promise<{ status: number; body: Buffer; relayDown?: boolean }>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      socket.send(frame);
    });
  };
  const text = (answer: { body: Buffer }) => answer.body.toString("utf8");
  return { socket, ask, opened, text };
}

/** A fetch for the phone client whose calls travel through the fake relay instead of HTTP. */
function overRelay(thePhone: ReturnType<typeof phone>): FetchLike {
  return async (url, init) => {
    const route = url.endsWith("/hello") ? 1 : url.endsWith("/pair") ? 2 : url.endsWith("/session") ? 3 : url.endsWith("/rpc") ? 4 : 0;
    const answer = await thePhone.ask(route, init?.headers?.["x-botkins-session"] ?? "", init?.body ?? "");
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => JSON.parse(answer.body.toString("utf8")), arrayBuffer: async () => answer.body.buffer.slice(answer.body.byteOffset, answer.body.byteOffset + answer.body.length) as ArrayBuffer };
  };
}

/** A phone paired through the relay with the real client's crypto. */
async function pairedOverRelay(link: any, relay: FakeRelay, room: string, from = 1) {
  const thePhone = phone(relay, room, from);
  const fetcher = overRelay(thePhone);
  const paired = await pair(fetcher, { hosts: ["127.0.0.1:1"], code: link.startPairing().code }, { name: "Relay phone", platform: "ios" });
  const client = new LinkClient(paired, { fetch: fetcher, onParts() {}, onState() {} });
  return { thePhone, client, paired, call: (method: string, ...args: unknown[]): Promise<any> => (client as any).call(method, ...args) };
}

const finish = async (link: any, ...phones: { socket: any }[]) => {
  for (const one of phones) one.socket.close();
  await link.stop();
};

// ── The routes ────────────────────────────────────────────────────────────────────────────────

test("a request for each route is served and answered with the right status and body", async () => {
  const { relay, link, room } = await start();
  const one = phone(relay, room);

  // hello says only what pairing needs. The same call over HTTP says more.
  const hello = await one.ask(1);
  assert.equal(hello.status, 200);
  assert.deepEqual(JSON.parse(one.text(hello)), { botkins: 1, serverId: link.store.data.serverId, publicKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url") });
  assert.equal("pairing" in JSON.parse(one.text(hello)), false, "a stranger can't watch for an open code");
  const http = await (await fetch("http://127.0.0.1:" + link.port + "/botkins/v1/hello")).json();
  assert.ok(http.name && http.app && http.version, "HTTP's hello is the full one");
  link.startPairing();
  assert.equal("pairing" in JSON.parse(one.text(await one.ask(1))), false, "not even while a code is open");
  assert.equal((await (await fetch("http://127.0.0.1:" + link.port + "/botkins/v1/hello")).json()).pairing, true, "HTTP's hello still says");

  // pair, session and rpc: the same statuses and bodies as over HTTP.
  link.cancelPairing();
  assert.deepEqual([(await one.ask(2, "", "{}")).status, one.text(await one.ask(2, "", "{}"))], [403, '{"error":"pair_closed"}']);
  link.startPairing();
  const garbage = await one.ask(2, "", "not json");
  assert.deepEqual([garbage.status, one.text(garbage)], [400, '{"error":"bad_json"}']);
  const badKey = await one.ask(2, "", JSON.stringify({ publicKey: "x" }));
  assert.deepEqual([badKey.status, one.text(badKey)], [400, '{"error":"bad_key"}']);
  const unknown = await one.ask(3, "", JSON.stringify({ device: "nobody" }));
  assert.deepEqual([unknown.status, one.text(unknown)], [403, '{"error":"unknown_device"}']);
  const noSession = await one.ask(4, "", Buffer.alloc(40));
  assert.deepEqual([noSession.status, one.text(noSession)], [401, '{"error":"session"}']);
  const wrongSession = await one.ask(4, "no-such-session", Buffer.alloc(40));
  assert.equal(wrongSession.status, 401);
  const nothing = await one.ask(2, "", Buffer.alloc(0));
  assert.equal(nothing.status, 400);
  await finish(link, one);
});

test("a real pairing, a session and calls go through the relay with the phone client's own crypto", async () => {
  const { relay, link, room } = await start();
  const phoneOne = await pairedOverRelay(link, relay, room);
  assert.equal(link.status().devices.length, 1);
  assert.equal(link.status().devices[0].name, "Relay phone");
  assert.ok(Array.isArray(await phoneOne.call("models")));
  const id = await phoneOne.call("addBot", { name: "Nova", role: "Tester", instructions: "Test things.", face: "idle" });
  assert.ok(link.backend.state.bots.some((bot: { id: string }) => bot.id === id));
  // The relay saw sealed bytes: no bot name in anything it passed on.
  assert.ok(!relay.passed.some((bytes) => Buffer.from(bytes).includes("Nova")));
  await finish(link, phoneOne.thePhone);
});

test("a body that is too big is refused with 413, and a call needs its session first", async () => {
  const { relay, link, room } = await start();
  const paired = await pairedOverRelay(link, relay, room);
  const session = [...link.sessions.keys()][0] ?? (await paired.call("models"), [...link.sessions.keys()][0]);
  const one = phone(relay, room, 2);
  assert.equal((await one.ask(2, "", Buffer.alloc(64 * 1024 + 1, 0x20))).status, 413);
  assert.equal((await one.ask(3, "", Buffer.alloc(64 * 1024 + 1, 0x20))).status, 413);
  assert.equal((await one.ask(4, session, Buffer.alloc(6 * 1024 * 1024 + 1))).status, 413);
  // Without a session, size doesn't matter: it is 401 first.
  assert.equal((await one.ask(4, "", Buffer.alloc(6 * 1024 * 1024 + 1))).status, 401);
  assert.equal((await one.ask(4, "unknown", Buffer.alloc(40))).status, 401);
  // A body of the same size over the limit is refused the same way over HTTP.
  const http = await fetch("http://127.0.0.1:" + link.port + "/botkins/v1/pair", { method: "POST", body: Buffer.alloc(64 * 1024 + 1, 0x20) }).catch(() => null);
  assert.ok(!http || http.status === 413);
  await finish(link, one, paired.thePhone);
});

test("attempts are limited for each relay caller by itself, and never by a socket address", async () => {
  const { relay, link, room } = await start();
  // A phone's address tag is taken when its socket opens, so each is opened before the next is made.
  const flood = phone(relay, room, 7);
  await flood.opened;
  const fine = phone(relay, room, 8);
  await fine.opened;
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) statuses.push((await flood.ask(3, "", JSON.stringify({ device: "nobody" }))).status);
  assert.equal(statuses.filter((status) => status === 403).length, 20);
  assert.deepEqual(statuses.slice(20), [429, 429, 429, 429, 429]);
  assert.equal((await flood.ask(2, "", "{}")).status, 429);
  assert.equal((await fine.ask(3, "", JSON.stringify({ device: "nobody" }))).status, 403, "another caller still gets through");
  // A caller on a second socket from the same address shares the first one's count.
  const again = phone(relay, room, 7);
  await again.opened;
  assert.equal((await again.ask(3, "", JSON.stringify({ device: "nobody" }))).status, 429);
  // HTTP callers are counted by their own address, apart from the relay's.
  const http = await fetch("http://127.0.0.1:" + link.port + "/botkins/v1/session", { method: "POST", body: JSON.stringify({ device: "nobody" }) });
  assert.equal(http.status, 403);
  await finish(link, flood, fine, again);
});

// ── The socket: caps, malformed frames, going away ────────────────────────────────────────────

class Stub {
  static made: Stub[] = [];
  readyState = 1;
  binaryType = "";
  sent: Buffer[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    Stub.made.push(this);
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: Uint8Array | string) {
    if (typeof data !== "string") this.sent.push(Buffer.from(data));
  }
  close() {}
  feed(frame: Uint8Array) {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer });
  }
}
const conn = (n: number) => Buffer.from([0, 0, 0, 0, 0, 0, 0, n]);
const frame = (c: Buffer, id: number, route = 1, session = "", body = "") =>
  Buffer.concat([c, Buffer.from([0, 0, 0, 0, 0, 0, 0, 9]), Buffer.from([0x01]), u32(id), Buffer.from([route, session.length]), Buffer.from(session), Buffer.from(body)]);
const KEY = newRelayKey();

async function stubbed(serve: (request: any) => Promise<any> | any, extra: Record<string, unknown> = {}) {
  Stub.made.length = 0;
  const gone: string[] = [];
  const link = new RelayLink({ url: "https://relay.test", key: KEY, serve, onGone: (c: string) => gone.push(c), WebSocket: Stub as unknown as typeof WebSocket, ...extra });
  link.start();
  await tick();
  return { link, socket: Stub.made[0], gone };
}

test("the socket is opened as the relay expects, and what is served and answered has the wire format", async () => {
  const seen: any[] = [];
  const { link, socket } = await stubbed((request) => {
    seen.push(request);
    return { status: 201, body: Buffer.from("xyz") };
  });
  assert.equal(socket.url, "wss://relay.test/v1/host/" + hostRoomOf(KEY.publicKey));
  assert.equal(hostRoomOf(KEY.publicKey), roomOf(KEY.publicKey));
  // The seat is proved with a signature, and nothing secret is sent.
  assert.deepEqual(socket.protocols.slice(0, 2), ["botkins.host.v2", "k." + KEY.publicKey]);
  assert.equal(socket.protocols.length, 4);
  assert.ok(hostProof(socket.protocols, roomOf(KEY.publicKey), Math.floor(Date.now() / 1000)), "the relay would let it in");
  assert.ok(!socket.protocols.join(" ").includes(KEY.privateKey));
  assert.equal(socket.binaryType, "arraybuffer");
  assert.equal(link.connected, true);
  socket.feed(frame(conn(3), 0x01020304, 4, "sess-1", "hello body"));
  await tick();
  const { gone: promise, ...asked } = seen[0];
  assert.deepEqual(asked, { route: "rpc", session: "sess-1", body: Buffer.from("hello body"), from: "0000000000000009", conn: "0000000000000003" });
  assert.ok(promise instanceof Promise, "each request gets a promise for its phone leaving");
  assert.deepEqual(socket.sent[0], Buffer.concat([conn(3), Buffer.from([0x02, 1, 2, 3, 4, 0, 201]), Buffer.from("xyz")]));
  link.stop();
  assert.equal(link.connected, false);

  // http origins give ws, for local development.
  Stub.made.length = 0;
  new RelayLink({ url: "http://127.0.0.1:8787", key: KEY, serve: () => ({ status: 200, body: "" }), WebSocket: Stub as unknown as typeof WebSocket }).start();
  assert.equal(Stub.made[0].url, "ws://127.0.0.1:8787/v1/host/" + roomOf(KEY.publicKey));
});

test("malformed frames are ignored, and a serve that fails answers 500", async () => {
  const seen: unknown[] = [];
  const { link, socket } = await stubbed((request) => {
    seen.push(request);
    if (request.session === "boom") throw new Error("boom");
    return { status: 200, body: "ok" };
  });
  const good = frame(conn(1), 1, 1);
  for (const bad of [Buffer.alloc(0), Buffer.alloc(10), good.subarray(0, 16), good.subarray(0, 22), frame(conn(1), 2, 9), frame(conn(1), 3, 4, "abc").subarray(0, 24), Buffer.concat([conn(1), Buffer.alloc(8), Buffer.from([0x09])]), Buffer.concat([conn(1), Buffer.alloc(8), Buffer.from([0x02, 0, 0, 0, 1])])]) socket.feed(bad);
  socket.onmessage?.({ data: "pong" });
  socket.onmessage?.({ data: "not binary" });
  await tick();
  assert.equal(seen.length, 0);
  assert.equal(socket.sent.length, 0);
  socket.feed(frame(conn(1), 5, 4, "boom"));
  await tick();
  assert.deepEqual([socket.sent[0].readUInt16BE(13), socket.sent[0].subarray(15).toString()], [500, '{"error":"failed"}']);
  link.stop();
});

test("a phone has 8 requests in flight at most, and all phones 256; more are answered 429 at once", async () => {
  const release: (() => void)[] = [];
  const { link, socket } = await stubbed(() => new Promise((resolve) => release.push(() => resolve({ status: 200, body: "done" }))));
  for (let id = 1; id <= 9; id++) socket.feed(frame(conn(1), id, 4, "s"));
  await tick();
  assert.equal(release.length, 8);
  assert.equal(socket.sent.length, 1, "the ninth was answered at once");
  assert.deepEqual([socket.sent[0].readUInt32BE(9), socket.sent[0].readUInt16BE(13), socket.sent[0].subarray(15).toString()], [9, 429, '{"error":"slow_down"}']);
  // Another phone is not held up by it.
  socket.feed(frame(conn(2), 1, 4, "s"));
  await tick();
  assert.equal(release.length, 9);
  while (release.length) release.shift()!();
  await tick();
  assert.equal(socket.sent.filter((bytes) => bytes.readUInt16BE(13) === 200).length, 9);
  // After they finish, the phone can ask again.
  socket.feed(frame(conn(1), 10, 4, "s"));
  await tick();
  assert.equal(release.length, 1);
  while (release.length) release.shift()!();
  await tick();

  // 33 phones with 8 each is 264; the first 256 are served and the other 8 are turned away.
  socket.sent.length = 0;
  for (let c = 10; c < 43; c++) for (let id = 1; id <= 8; id++) socket.feed(frame(conn(c), id, 4, "s"));
  await tick(60);
  assert.equal(release.length, 256);
  assert.equal(socket.sent.filter((bytes) => bytes.readUInt16BE(13) === 429).length, 8);
  while (release.length) release.shift()!();
  link.stop();
});

test("an answer over 8 MiB is replaced by a 413, so the relay doesn't cut the socket", async () => {
  const { link, socket } = await stubbed(() => ({ status: 200, body: Buffer.alloc(8 * 1024 * 1024) }));
  socket.feed(frame(conn(1), 1, 4, "s"));
  await tick(60);
  assert.deepEqual([socket.sent[0].readUInt16BE(13), socket.sent[0].subarray(15).toString()], [413, '{"error":"too_large"}']);
  link.stop();
});

test("a phone that leaves is reported once, and so is every phone with a request in flight when the socket drops", async () => {
  const asked: { conn: string; gone: Promise<void> }[] = [];
  const { link, socket, gone } = await stubbed((request) => {
    asked.push({ conn: request.conn, gone: request.gone });
    return new Promise(() => {});
  });
  socket.feed(frame(conn(1), 1));
  socket.feed(frame(conn(2), 1));
  socket.feed(frame(conn(3), 1));
  await tick();
  assert.equal(asked.length, 3);
  let first = false;
  asked[0].gone.then(() => (first = true));
  socket.feed(Buffer.concat([conn(1), Buffer.alloc(8), Buffer.from([0x04])]));
  socket.feed(Buffer.concat([conn(1), Buffer.alloc(8), Buffer.from([0x04])]));
  socket.feed(Buffer.concat([conn(9), Buffer.alloc(8), Buffer.from([0x04])]));
  await tick();
  assert.deepEqual(gone, ["0000000000000001"], "once, and only for a phone that was known");
  assert.equal(first, true, "its requests' promise resolved");
  const rest = [asked[1], asked[2]].map((one) => {
    const state = { done: false };
    one.gone.then(() => (state.done = true));
    return state;
  });
  socket.onclose?.({ code: 1006 });
  await tick();
  assert.deepEqual(gone, ["0000000000000001", "0000000000000002", "0000000000000003"]);
  assert.deepEqual(rest.map((state) => state.done), [true, true]);
  link.stop();
});

test("a hostile relay can't grow what the computer keeps: 64 phones, bookkeeping freed when requests settle, no giant frames", async () => {
  const release: (() => void)[] = [];
  const seen: unknown[] = [];
  const { link, socket } = await stubbed((request) => {
    seen.push(request);
    return new Promise((resolve) => release.push(() => resolve({ status: 200, body: "ok" })));
  });
  // 64 phones with a request in flight are known; a 65th is answered 429 and not remembered.
  for (let c = 1; c <= 64; c++) socket.feed(frame(conn(c), 1, 4, "s"));
  await tick(40);
  assert.equal(link.conns.size, 64);
  socket.feed(frame(conn(65), 1, 4, "s"));
  await tick();
  assert.equal(release.length, 64);
  assert.equal(link.conns.size, 64);
  assert.deepEqual([socket.sent[0].readUInt16BE(13), socket.sent[0].subarray(15).toString()], [429, '{"error":"slow_down"}']);
  assert.deepEqual(socket.sent[0].subarray(0, 8), conn(65));
  // When a phone's last request settles, nothing is kept for it.
  release.shift()!();
  await tick();
  assert.equal(link.conns.size, 63);
  // Room again for the 65th.
  socket.feed(frame(conn(65), 2, 4, "s"));
  await tick();
  assert.equal(link.conns.size, 64);
  while (release.length) release.shift()!();
  await tick(40);
  assert.equal(link.conns.size, 0);
  assert.equal(link.inFlight, 0);

  // A phone turned away by the 8-request or 256-request limit isn't kept either.
  for (let id = 1; id <= 9; id++) socket.feed(frame(conn(70), id, 4, "s"));
  await tick();
  assert.equal(link.conns.get("0000000000000046").busy, 8);
  while (release.length) release.shift()!();
  await tick(40);
  assert.equal(link.conns.size, 0);

  // A request frame over 6 MiB + 64 KiB (+ its 16 bytes of addressing) is dropped without being read.
  const before = seen.length;
  const huge = Buffer.alloc(MAX_REQUEST_FRAME + 1);
  frame(conn(1), 1, 4, "s").copy(huge);
  socket.feed(huge);
  await tick(40);
  assert.equal(seen.length, before, "too big: dropped");
  // The biggest a phone may send (the relay's own limit) is still served.
  const biggest = Buffer.alloc(MAX_PHONE_MESSAGE + 16);
  frame(conn(1), 1, 4, "s").copy(biggest);
  socket.feed(biggest);
  await tick(60);
  assert.equal(seen.length, before + 1);
  while (release.length) release.shift()!();
  link.stop();
});

test("a waiting link.sync ends when its phone's socket closes, and when the computer's own socket drops", async () => {
  const { relay, link, room } = await start();
  const waits = async (one: Awaited<ReturnType<typeof pairedOverRelay>>) => {
    // What this phone holds: the versions of its own view, as one sync gave them.
    const { v: have } = await one.call("link.sync", { epoch: link.epoch, have: {} });
    const pending = one.call("link.sync", { epoch: link.epoch, have, wait: 25_000 }).catch(() => "ended");
    await until(() => link.waiters.size === 1, "the sync to wait");
    return { pending };
  };

  // The relay says the phone's socket closed (0x04).
  const first = await pairedOverRelay(link, relay, room, 1);
  const waiting = await waits(first);
  first.thePhone.socket.close();
  await until(() => link.waiters.size === 0, "the waiter to end after 0x04");
  await waiting.pending;

  // The computer's own socket drops: waiters of every phone end.
  const second = await pairedOverRelay(link, relay, room, 2);
  const again = await waits(second);
  relay.dropHost(room);
  await until(() => link.waiters.size === 0, "the waiter to end after the drop");
  second.thePhone.socket.close();
  await again.pending;
  await link.stop();
});

// ── Staying connected ─────────────────────────────────────────────────────────────────────────

test("after a drop it reconnects with a backoff of 1 s doubling to 60 s, and starts over after 30 s connected", async () => {
  const { relay, time, link, room, logs } = await start();
  const changes: boolean[] = [];
  link.on("status", () => changes.push(link.status().relay.connected));
  relay.down = true;
  relay.dropHost(room);
  await until(() => !link.status().relay.connected, "the drop to show");
  assert.ok(changes.includes(false), "status was emitted");
  assert.deepEqual(time.delays(), [1000]);
  const waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    waits.push(time.delays()[0]);
    await stepBack(time);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);

  // The relay is back: the next try connects.
  relay.down = false;
  await stepBack(time);
  await until(() => link.status().relay.connected, "the reconnect");
  assert.ok(link.relayLink.connected);
  assert.ok(logs.some((line) => /relay: connected/.test(line)));

  // A drop within 30 seconds goes on with the long waits; one after 30 seconds starts over at 1 s.
  relay.dropHost(room);
  await until(() => !link.status().relay.connected, "the second drop");
  assert.equal(time.delays()[0], 60_000);
  await stepBack(time);
  await until(() => link.status().relay.connected, "the second reconnect");
  time.advance(30_000);
  await tick();
  relay.dropHost(room);
  await until(() => !link.status().relay.connected, "the third drop");
  assert.equal(time.delays()[0], 1000, "the backoff started over");
  await stepBack(time);
  await until(() => link.status().relay.connected, "the third reconnect");
  await link.stop();
  assert.deepEqual(time.delays(), [], "nothing is left to fire");
});

test("a socket that stops answering pings is dropped after 10 seconds, and any message counts as an answer", async () => {
  const { relay, time, link, room } = await start();
  let mute = false;
  const receive = relay.receive.bind(relay);
  relay.receive = (socket: any, message: any) => {
    if (mute && message === "ping") return;
    receive(socket, message);
  };
  assert.ok(time.delays().includes(25_000), "a ping is planned");
  time.advance(25_000);
  await tick();
  assert.ok(link.status().relay.connected, "an answered ping keeps it");

  mute = true;
  time.advance(25_000);
  await tick();
  time.advance(9_999);
  await tick();
  assert.ok(link.status().relay.connected, "not yet");
  time.advance(1);
  await tick();
  assert.equal(link.status().relay.connected, false, "10 seconds without an answer");
  assert.equal(time.delays()[0], 1000);
  mute = false;
  await stepBack(time);
  await until(() => link.status().relay.connected, "the reconnect after the timeout");

  // Any frame from the relay is proof the socket lives, even if "pong" never comes.
  mute = true;
  time.advance(25_000);
  await tick();
  const one = phone(relay, room);
  await one.ask(1);
  time.advance(10_000);
  await tick();
  assert.ok(link.status().relay.connected, "a request counted as an answer");
  await finish(link, one);
});

test("another computer taking the room (close 4000) is logged and retried at the slow end", async () => {
  const { relay, time, link, room, key, logs } = await start();
  const taker: any = new (relay.WebSocket as any)("wss://relay.test/v1/host/" + room, hostOffer(key, relay.now()));
  taker.onopen = () => {};
  taker.onmessage = () => {};
  await until(() => !link.status().relay.connected, "the takeover to show");
  assert.ok(logs.some((line) => /another computer took over/.test(line)));
  assert.deepEqual(time.delays(), [60_000]);
  await stepBack(time);
  await until(() => link.status().relay.connected, "the room to be taken back");
  await link.stop();
});

test("stop() closes the socket and stops trying; nothing throws", async () => {
  const { relay, time, link, room } = await start();
  link.relayLink.stop();
  link.relayLink.stop();
  await tick();
  assert.equal(relay.hostOf(room), null);
  assert.deepEqual(time.delays(), []);
  assert.equal(link.relayLink.connected, false);

  // A socket class that throws, or a missing one, is logged and never thrown into the caller.
  const logs: string[] = [];
  const broken = new RelayLink({ url: "https://relay.test", key: KEY, serve: () => ({ status: 200, body: "" }), WebSocket: class { constructor() { throw new Error("no sockets here"); } } as any, log: (line: string) => logs.push(line), timers: clock().timers });
  assert.doesNotThrow(() => broken.start());
  assert.ok(logs.some((line) => /couldn't open the socket/.test(line)));
  const none = new RelayLink({ url: "https://relay.test", key: KEY, serve: () => ({ status: 200, body: "" }), WebSocket: null as any, log: (line: string) => logs.push(line) });
  assert.doesNotThrow(() => none.start());
  const bad = new RelayLink({ url: "ftp://nope", key: KEY, serve: () => ({ status: 200, body: "" }), log: (line: string) => logs.push(line) });
  assert.doesNotThrow(() => (bad.start(), bad.stop()));
  assert.equal(bad.connected, false);
  await link.stop();
});

// ── Settings, hosts and secrets ───────────────────────────────────────────────────────────────

test("the relay entry is the last host, and turning the relay off closes the socket and removes it", async () => {
  // No address is given, so the saved one (the default) applies; the fake relay takes any host name.
  const { relay, link, room } = await start({ relay: (fake: FakeRelay, time: ReturnType<typeof clock>) => ({ WebSocket: fake.WebSocket, timers: time.timers }) });
  const entry = "relay!" + room + "@" + new URL(DEFAULT_RELAY_URL).host;
  const hosts = link.hosts();
  assert.equal(hosts.at(-1), entry);
  assert.ok(hosts.slice(0, -1).every((host: string) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(host)), "the others are addresses");
  assert.ok(link.status().addresses.every((a: { address: string }) => /^\d/.test(a.address)), "the address list stays real addresses");
  assert.deepEqual(link.status().relay, { enabled: true, connected: true, url: DEFAULT_RELAY_URL });
  const url = new URL(link.startPairing().url);
  assert.ok(url.searchParams.get("h")!.endsWith("," + entry));
  assert.ok(qrText(url.toString()).length > 100, "the pairing code still draws");
  // The entry is also in what a phone is told by a session reply, through the one hosts() method.
  const parts = (link.refresh([]), link.parts.get("host")!);
  assert.deepEqual(JSON.parse((parts as any).json), { screen: "off", relay: true });
  assert.ok(link.parts.get("meta") && JSON.parse((link.parts.get("meta") as any).json).capabilities.includes("relay-v1"));

  const changes: unknown[] = [];
  link.on("status", () => changes.push(link.status().relay));
  link.setRelay({ enabled: false });
  assert.equal(link.hosts().some((host: string) => host.startsWith("relay!")), false);
  await until(() => relay.hostOf(room) === null, "the socket to close");
  assert.deepEqual(link.status().relay, { enabled: false, connected: false, url: DEFAULT_RELAY_URL });
  assert.ok(changes.length > 0);
  link.refresh([]);
  assert.equal(JSON.parse((link.parts.get("host") as any).json).relay, false);

  // Saved: a new LinkStore reads the choice back. Turning it on again reconnects.
  assert.equal(new LinkStore(link.store.dir).data.relay.enabled, false);
  link.setRelay({ enabled: true });
  await until(() => link.status().relay.connected, "the relay to come back");
  assert.equal(link.hosts().at(-1), entry);

  // A new address moves the link at once and changes the entry's authority.
  link.setRelay({ url: "https://other.test:8443" });
  assert.equal(link.hosts().at(-1), "relay!" + room + "@other.test:8443");
  await until(() => link.status().relay.connected, "the new address to connect");
  assert.equal(link.status().relay.url, "https://other.test:8443");
  assert.throws(() => link.setRelay({ url: "http://relay.example.com" }), /isn't valid/);
  assert.equal(link.status().relay.url, "https://other.test:8443", "a bad address changes nothing");

  // Phone access off: the relay is closed with the rest, and on again opens it.
  await link.setEnabled(false);
  assert.equal(link.relayLink, null);
  await until(() => relay.hostOf(room) === null, "the socket to close with phone access");
  await link.setEnabled(true);
  await until(() => link.status().relay.connected, "the relay after phone access came back");
  await link.stop();
});

test("the private key stays on the computer: not in the status, a part, the pairing link, a host entry, a log or the file as it is wrapped", async () => {
  const wrapped = {
    protect: (text: string) => "wrapped:" + [...text].reverse().join(""),
    reveal: (text: string) => [...text.slice(8)].reverse().join(""),
  };
  const { relay, time, link, key, room, logs, dir } = await start(wrapped);
  // Make the log busy: drops, retries, and a refusal.
  relay.dropHost(room);
  await until(() => !link.status().relay.connected, "the drop to schedule a retry");
  relay.down = true;
  await stepBack(time);
  await stepBack(time);
  relay.down = false;
  await stepBack(time);
  await until(() => link.status().relay.connected, "the reconnect");
  link.refresh([]);
  const seen = JSON.stringify([link.status(), [...link.parts.values()].map((part: any) => part.json), link.startPairing().url, link.hosts(), logs]);
  assert.ok(!seen.includes(key.privateKey), "no private key in what the app or a phone can see");
  assert.ok(seen.includes(room), "the room (public) is in the pairing link");
  assert.ok(logs.length > 3);
  // What goes to the relay is public: the key's public half, a time and a signature. Nothing secret.
  assert.ok(!relay.passed.some((bytes) => Buffer.from(bytes).includes(key.privateKey)));
  const file = readFileSync(join(dir, "link.json"), "utf8");
  assert.ok(!file.includes(key.privateKey), "the file holds it wrapped");
  assert.match(JSON.parse(file).relay.key.privateKey, /^wrapped:/);
  assert.equal(JSON.parse(file).relay.key.publicKey, key.publicKey);
  assert.equal(JSON.parse(file).relay.token, undefined, "no token any more");
  // A restart with the same hooks gets the same room.
  assert.deepEqual(new LinkStore(dir, wrapped).data.relay.key, key);
  assert.equal(hostRoomOf(key.publicKey), room);
  await link.stop();
});

test("the relay is off until turned on, its key is made once and kept, and an old file with a token just gets a key", async () => {
  const dir = scratch();
  const store = new LinkStore(dir);
  assert.deepEqual({ enabled: store.data.relay.enabled, url: store.data.relay.url, key: store.data.relay.key }, { enabled: false, url: DEFAULT_RELAY_URL, key: null });
  assert.match(DEFAULT_RELAY_URL, /^https:\/\//);
  const key = store.relayKey();
  assert.match(key.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(key.privateKey, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(store.relayKey(), key);
  assert.deepEqual(new LinkStore(dir).data.relay.key, key, "kept in link.json");
  assert.notEqual(new LinkStore(scratch()).relayKey().publicKey, key.publicKey, "another computer has another");
  assert.equal(new LinkStore(dir).data.relay.enabled, false);

  // A key whose halves don't belong together, or a damaged one, is dropped; a token from before keys is ignored.
  const saved = JSON.parse(readFileSync(join(dir, "link.json"), "utf8"));
  for (const relay of [{ key: { publicKey: key.publicKey, privateKey: newRelayKey().privateKey } }, { key: { publicKey: "short", privateKey: "short" } }, { token: "A".repeat(43), url: 5, enabled: "yes" }, {}]) {
    const odd = scratch();
    writeFileSync(join(odd, "link.json"), JSON.stringify({ ...saved, relay }));
    const loaded = new LinkStore(odd);
    assert.deepEqual({ enabled: loaded.data.relay.enabled, url: loaded.data.relay.url, key: loaded.data.relay.key }, { enabled: false, url: DEFAULT_RELAY_URL, key: null }, JSON.stringify(relay));
    assert.match(loaded.relayKey().publicKey, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.parse(readFileSync(join(odd, "link.json"), "utf8")).relay.token, undefined);
  }

  // A new relay key is a new room, saved at once.
  const again = new LinkStore(dir);
  const next = again.resetRelayKey();
  assert.notEqual(next.publicKey, key.publicKey);
  assert.deepEqual(new LinkStore(dir).data.relay.key, next);
});

test("an object given to the constructor only overrides address, socket class and clock: the saved on/off still decides", async () => {
  const relay = new FakeRelay();
  const link = new LinkHost({ dir: scratch(), backend: new MockBackend(), port: 0, searchPath: [], relay: { url: "https://relay.test", WebSocket: relay.WebSocket, timers: clock().timers } });
  await link.setEnabled(true);
  assert.equal(link.relayLink, null, "off by default, object or not");
  assert.deepEqual(link.status().relay, { enabled: false, connected: false, url: "https://relay.test" });
  assert.equal(link.hosts().some((host: string) => host.startsWith("relay!")), false);
  link.setRelay({ enabled: true });
  await until(() => link.status().relay.connected, "the relay after it was turned on");
  assert.equal(link.hosts().at(-1)!.endsWith("@relay.test"), true);
  await link.stop();
});

test("relay: false opens nothing, whatever is saved, and an address that isn't valid is never used", async () => {
  const opened: string[] = [];
  const real = globalThis.WebSocket;
  (globalThis as any).WebSocket = class {
    constructor(url: string) {
      opened.push(url);
      throw new Error("no real sockets in tests");
    }
  };
  try {
    const dir = scratch();
    // Saved settings that would turn the relay on.
    const first = new LinkStore(dir);
    first.set({ relay: { enabled: true, url: "https://relay.test", key: first.relayKey() } });
    const off = new LinkHost({ relay: false, dir, backend: new MockBackend(), port: 0, searchPath: [] });
    await off.setEnabled(true);
    off.setRelay({ enabled: true });
    off.setRelay({ url: "https://another.test" });
    assert.equal(off.relayLink, null);
    assert.equal(off.hosts().some((host: string) => host.startsWith("relay!")), false);
    assert.deepEqual(off.status().relay, { enabled: false, connected: false, url: "https://another.test" });
    off.refresh([]);
    assert.equal(JSON.parse((off.parts.get("host") as any).json).relay, false);
    await off.stop();

    // A saved address that isn't valid doesn't open anything, and gives no entry for phones.
    const bad = scratch();
    const store = new LinkStore(bad);
    store.set({ relay: { enabled: true, url: "http://evil.example.com", key: store.relayKey() } });
    const link = new LinkHost({ dir: bad, backend: new MockBackend(), port: 0, searchPath: [], relay: {} });
    await link.setEnabled(true);
    assert.equal(link.relayLink, null);
    assert.equal(link.hosts().some((host: string) => host.startsWith("relay!")), false);
    assert.equal(link.status().relay.enabled, false);
    await link.stop();
    assert.deepEqual(opened, []);
  } finally {
    (globalThis as any).WebSocket = real;
  }
});

test("a computer whose clock is off is refused, and tries again with a fresh signature once it is right", async () => {
  const { relay, time, link, room } = await start();
  time.skew(400_000);
  relay.dropHost(room);
  await until(() => !link.status().relay.connected, "the drop");
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    waits.push(time.delays()[0]);
    await stepBack(time);
  }
  assert.deepEqual(waits, [1000, 2000, 4000], "a refusal is retried with the usual backoff");
  assert.equal(link.status().relay.connected, false);
  assert.equal(link.status().relay.problem, undefined, "a clock that is off isn't the taken state");
  time.skew(-400_000);
  await stepBack(time);
  assert.equal(link.status().relay.connected, false, "still too far the other way");
  time.skew(0);
  await stepBack(time);
  await until(() => link.status().relay.connected, "the connection with a right clock");
  await link.stop();
});

test("resetRelay() makes a new room: the old socket closes, the new entry is in hosts() and saved at once", async () => {
  const { relay, link, room, key, dir } = await start();
  const entry = link.hosts().at(-1)!;
  assert.ok(entry.includes(room));
  const changes: string[] = [];
  link.on("status", () => changes.push("status"));
  const next = link.resetRelay();
  assert.notEqual(next, room);
  assert.equal(link.hosts().at(-1)!.includes(next), true);
  assert.equal(link.hosts().some((host: string) => host.includes(room)), false, "the old room is gone from hosts()");
  assert.ok(changes.length > 0);
  assert.notEqual(new LinkStore(dir).data.relay.key.publicKey, key.publicKey, "saved at once");
  await until(() => relay.hostOf(room) === null, "the old socket to close");
  await until(() => !!relay.hostOf(next) && link.status().relay.connected, "the new room to connect");
  // With the relay off, a reset still makes the key, and nothing opens.
  link.setRelay({ enabled: false });
  const again = link.resetRelay();
  assert.notEqual(again, next);
  assert.equal(link.status().relay.connected, false);
  await link.stop();
});

test("three closes with 4000 in a row report the seat as taken, but it keeps trying every 10 minutes and clears when a connection lasts 30 seconds", async () => {
  const { relay, time, link, room, key, logs } = await start();
  const taken = () => new (relay.WebSocket as any)("wss://relay.test/v1/host/" + hostRoomOf(link.store.relayKey().publicKey), hostOffer(link.store.relayKey(), relay.now()));
  const statuses: unknown[] = [];
  link.on("status", () => statuses.push(link.status().relay.problem));
  const quiet = (socket: any) => {
    socket.onopen = () => {};
    socket.onmessage = () => {};
    return socket;
  };
  const takeoverAndBack = async (times: number) => {
    for (let i = 0; i < times; i++) {
      quiet(taken());
      await until(() => !link.status().relay.connected, "a takeover");
      if (i < times - 1) {
        await stepBack(time);
        await until(() => link.status().relay.connected, "the seat back");
      }
    }
  };
  quiet(taken());
  await until(() => !link.status().relay.connected, "the first takeover");
  assert.deepEqual(time.delays(), [60_000]);
  await stepBack(time);
  await until(() => link.status().relay.connected, "the seat back");
  quiet(taken());
  await until(() => !link.status().relay.connected, "the second takeover");
  assert.deepEqual(time.delays(), [60_000]);
  assert.equal(link.status().relay.problem, undefined);
  await stepBack(time);
  await until(() => link.status().relay.connected, "the seat back again");
  const before = logs.length;
  quiet(taken());
  await until(() => link.status().relay.problem === "taken", "the third takeover to be reported");
  assert.deepEqual(link.status().relay, { enabled: true, connected: false, url: "https://relay.test", problem: "taken" });
  assert.deepEqual(time.delays(), [600_000], "it goes on trying, every 10 minutes");
  assert.equal(logs.slice(before).filter((line) => /keeps taking/.test(line)).length, 1, "one line in the log");
  assert.ok(statuses.includes("taken"), "status was emitted");

  // The next try is 10 minutes on. It takes the seat back, and the problem stays until the connection has lasted 30 seconds.
  await stepBack(time);
  await until(() => link.status().relay.connected, "the try after 10 minutes");
  assert.equal(link.status().relay.problem, "taken");
  statuses.length = 0;
  time.advance(29_000);
  await tick();
  assert.equal(link.status().relay.problem, "taken");
  time.advance(1_000);
  await tick();
  assert.equal(link.status().relay.problem, undefined, "cleared after 30 seconds connected");
  assert.ok(statuses.includes(undefined), "status was emitted for it");
  assert.equal(logs.filter((line) => /keeps taking/.test(line)).length, 1, "and it was only said once");

  // Still taken, another takeover while taken waits another 10 minutes, and says nothing more.
  await takeoverAndBack(3);
  await until(() => link.status().relay.problem === "taken", "taken again");
  assert.deepEqual(time.delays(), [600_000]);
  quiet(taken());
  void room;
  // Each of these restarts it at once.
  for (const restart of [() => link.setRelay({}), () => link.resetRelay(), async () => (await link.setEnabled(false), await link.setEnabled(true))]) {
    await restart();
    await until(() => link.status().relay.connected, "the restart");
    assert.equal(link.status().relay.problem, undefined);
    await takeoverAndBack(3);
    await until(() => link.status().relay.problem === "taken", "taken again");
  }
  void key;
  await link.stop();
});

test("only failures count against a limit, each way in has its own, and a valid session is never held back", async () => {
  const { relay, link, room } = await start();
  // A phone on the network and a phone on the relay, both paired and not yet connected.
  const lan = await pair(fetch as unknown as FetchLike, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "LAN phone", platform: "ios" });
  const lanClient = () => new LinkClient(lan, { fetch: fetch as unknown as FetchLike, onParts() {}, onState() {} });
  const away = await pairedOverRelay(link, relay, room, 1);
  const nobody = JSON.stringify({ device: "nobody" });
  const flood = async (sources: number, each: number, via: string) => {
    for (let n = 0; n < sources; n++) for (let i = 0; i < each; i++) await link.serve({ route: "session", body: Buffer.from(nobody), from: "source-" + via + n, via });
  };

  // 10 relay sources failing 20 times each stop neither phone.
  await flood(10, 20, "relay");
  assert.ok(Array.isArray(await lanClient().call("models")), "the phone on the network opens a session");
  assert.ok(Array.isArray(await away.call("models")), "the phone on the relay opens a session");

  // 25 more sources trip the relay's backstop (400 failures in 10 seconds).
  await flood(25, 20, "relay");
  const fresh = (route: string, body: string) => link.serve({ route, body: Buffer.from(body), from: "fresh-source", via: "relay" });
  assert.equal((await fresh("session", nobody)).status, 429, "an unknown device is held back");
  assert.equal((await fresh("pair", "{}")).status, 429, "so is pairing");
  // A session for a known device that proves itself is not, from a source that has not failed.
  const another = phone(relay, room, 50);
  const second = new LinkClient(away.paired, { fetch: overRelay(another), onParts() {}, onState() {} });
  assert.ok(Array.isArray(await (second as any).call("models")), "a valid session opens while the backstop is tripped");
  assert.ok(Array.isArray(await lanClient().call("models")), "and so does the network phone's");
  // HTTP has its own counts: the relay's flood used none of them.
  const http = await fetch("http://127.0.0.1:" + link.port + "/botkins/v1/session", { method: "POST", body: nobody });
  assert.equal(http.status, 403);
  // And the other way: HTTP's backstop (200) and one source's limit don't touch the relay.
  for (let n = 0; n < 11; n++) for (let i = 0; i < 20; i++) await link.serve({ route: "session", body: Buffer.from(nobody), from: "http-source-" + n, via: "http" });
  assert.equal((await link.serve({ route: "session", body: Buffer.from(nobody), from: "another-http", via: "http" })).status, 429, "HTTP's backstop is tripped");
  assert.equal((await link.serve({ route: "session", body: Buffer.from(nobody), from: "another-relay-source", via: "relay" })).status, 429, "(the relay's still is too)");
  link.failures.relay.all.length = 0;
  link.failures.relay.by.clear();
  assert.equal((await link.serve({ route: "session", body: Buffer.from(nobody), from: "another-relay-source", via: "relay" })).status, 403, "with the relay's counts clear it is a plain failure again");
  assert.equal((await link.serve({ route: "session", body: Buffer.from(nobody), from: "yet-another-http", via: "http" })).status, 429, "while HTTP's stays tripped");

  // Successes cost nothing: 30 sessions from one address and one relay tag, never refused.
  for (let i = 0; i < 30; i++) assert.ok(Array.isArray(await lanClient().call("models")));
  for (let i = 0; i < 25; i++) assert.ok(Array.isArray(await new LinkClient(away.paired, { fetch: overRelay(another), onParts() {}, onState() {} }).call("models")));
  assert.ok(link.failures.relay.all.length <= 1, "no success was counted");
  await finish(link, away.thePhone, another);
});

test("wrong pairing codes are counted per source, and only many of them from everyone withdraw the code", async () => {
  const { relay, link, room } = await start();
  const wrong = (from: string, via = "relay") => link.serve({ route: "pair", body: Buffer.from(JSON.stringify({ publicKey: Buffer.from(newKeyPair().publicKey).toString("base64url"), box: Buffer.alloc(40).toString("base64url") })), from, via });
  const body = async (answer: Promise<{ status: number; body: Buffer }>) => {
    const done = await answer;
    return [done.status, done.body.toString()];
  };

  // Two relay sources use up their 8 tries each; the code is still open for a third source and for HTTP.
  link.startPairing();
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(await body(wrong("source-a")), [403, '{"error":"pair_failed"}']);
    assert.deepEqual(await body(wrong("source-b")), [403, '{"error":"pair_failed"}']);
  }
  assert.ok(link.status().pairing, "16 wrong tries don't withdraw the code");
  const third = phone(relay, room, 3);
  const code = link.activePairing().code;
  const paired = await pair(overRelay(third), { hosts: ["127.0.0.1:1"], code }, { name: "Third", platform: "ios" });
  assert.ok(paired.deviceId);
  assert.equal(link.status().pairing, null, "the right code closed it");

  // HTTP still pairs with a code that relay sources spent their tries on.
  link.startPairing();
  for (let i = 0; i < 8; i++) await wrong("source-c");
  const httpPhone = await pair(fetch as unknown as FetchLike, { hosts: ["127.0.0.1:" + link.port], code: link.activePairing().code }, { name: "LAN", platform: "ios" });
  assert.ok(httpPhone.deviceId);

  // A source that used its 8 tries is told to wait (429 "pair_wait") even with the right code.
  link.startPairing();
  // The relay tags a phone by an 8-byte hex of its network address; this phone's is 0000000000000004.
  const used = phone(relay, room, 4);
  await used.opened;
  for (let i = 0; i < 8; i++) await wrong("0000000000000004");
  // Even the right code: 429 "pair_wait" on the wire.
  const right = await used.ask(2, "", JSON.stringify({ publicKey: Buffer.from(newKeyPair().publicKey).toString("base64url"), box: Buffer.alloc(40).toString("base64url") }));
  assert.deepEqual([right.status, used.text(right)], [429, '{"error":"pair_wait"}']);
  await assert.rejects(pair(overRelay(used), { hosts: ["127.0.0.1:1"], code: link.activePairing().code }, { name: "Used up", platform: "ios" }), (error: unknown) => error instanceof LinkError);
  assert.equal(link.status().devices.length, 2, "nothing was paired");
  assert.ok(link.status().pairing, "the code is still open for others");
  assert.deepEqual(await body(wrong("0000000000000004")), [429, '{"error":"pair_wait"}'], "the ninth try is told to wait, not that its code is wrong");
  // The same source over HTTP is a different source.
  assert.ok((await pair(fetch as unknown as FetchLike, { hosts: ["127.0.0.1:" + link.port], code: link.activePairing().code }, { name: "LAN again", platform: "ios" })).deviceId);

  // 200 wrong tries in all withdraw it: 25 sources of 8.
  link.startPairing();
  for (let n = 0; n < 25; n++) {
    for (let i = 0; i < 8; i++) await wrong("many-" + n);
    if (n < 24) assert.ok(link.status().pairing, "still open after " + (n + 1) * 8 + " wrong tries");
  }
  assert.equal(link.status().pairing, null, "200 wrong tries withdrew the code");
  assert.deepEqual(await body(wrong("source-z")), [403, '{"error":"pair_closed"}']);

  // The tables are bounded and cleared with the code.
  link.startPairing();
  for (let n = 0; n < 400; n++) await wrong("spread-" + n);
  assert.ok(link.activePairing().by.size <= 256);
  const open = link.activePairing();
  link.cancelPairing();
  assert.ok(link.failures.relay.by.size <= 256, "sources seen are bounded");
  link.startPairing();
  assert.equal(link.activePairing().by.size, 0);
  assert.notEqual(link.activePairing(), open);
  await finish(link, third, used);
});

test("a recorded session request played again is refused like a bad box, and a phone's last 64 are remembered", async () => {
  const { relay, link, room } = await start();
  const one = phone(relay, room, 1);
  const bodies: Buffer[] = [];
  const inner = overRelay(one);
  const recording: FetchLike = (url, init) => {
    if (url.endsWith("/session")) bodies.push(Buffer.from(init!.body as string));
    return inner(url, init);
  };
  const paired = await pair(recording, { hosts: ["127.0.0.1:1"], code: link.startPairing().code }, { name: "Recorder", platform: "ios" });
  const open = async () => new LinkClient(paired, { fetch: recording, onParts() {}, onState() {} }).call("models");
  await open();
  assert.equal(bodies.length, 1);
  const sessions = link.sessions.size;
  const replay = await link.serve({ route: "session", body: bodies[0], from: "replayer", via: "relay" });
  assert.deepEqual([replay.status, replay.body.toString()], [403, '{"error":"bad_session"}'], "the same answer as a bad box");
  const bad = await link.serve({ route: "session", body: Buffer.from(JSON.stringify({ device: paired.deviceId, eph: "x", box: "x" })), from: "replayer", via: "relay" });
  assert.deepEqual([bad.status, bad.body.toString()], [replay.status, replay.body.toString()]);
  assert.equal(link.sessions.size, sessions, "no session slot was taken");

  // 64 are remembered: after 64 newer ones the first is forgotten (and a replayed one is a session again).
  for (let i = 0; i < 63; i++) await open();
  assert.equal((await link.serve({ route: "session", body: bodies[0], from: "replayer-2", via: "relay" })).status, 403, "still remembered after 63 newer");
  await open();
  assert.equal(link.nonces.get(paired.deviceId).size, 64);
  assert.equal((await link.serve({ route: "session", body: bodies[0], from: "replayer-3", via: "relay" })).status, 200, "forgotten after 64 newer");
  assert.equal(link.nonces.get(paired.deviceId).size, 64, "the memory stays at 64");
  // A removed phone's memory goes with it.
  link.removeDevice(paired.deviceId);
  assert.equal(link.nonces.has(paired.deviceId), false);
  await finish(link, one);
});

test("relay addresses: https, or http for this computer only, and nothing else", () => {
  assert.equal(cleanRelayUrl("https://relay.example.com"), "https://relay.example.com");
  assert.equal(cleanRelayUrl("https://Relay.Example.com/"), "https://relay.example.com");
  assert.equal(cleanRelayUrl("https://relay.example.com:8443"), "https://relay.example.com:8443");
  assert.equal(cleanRelayUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(cleanRelayUrl("http://localhost:8787"), "http://localhost:8787");
  assert.equal(cleanRelayUrl("http://[::1]:8787"), "http://[::1]:8787");
  for (const bad of ["http://relay.example.com", "http://192.168.1.5", "ws://relay.example.com", "wss://relay.example.com", "ftp://x", "javascript:alert(1)", "https://user:pw@relay.example.com", "https://relay.example.com/path", "https://relay.example.com/?a=1", "https://relay.example.com/#x", "relay.example.com", "", "not a url", undefined, null, 5]) {
    assert.throws(() => cleanRelayUrl(bad as any), /isn't valid/, String(bad));
  }
});

test("a computer with phone access off has no relay socket", async () => {
  const relay = new FakeRelay();
  const link = new LinkHost({ dir: scratch(), backend: new MockBackend(), port: 0, searchPath: [], relay: { url: "https://relay.test", WebSocket: relay.WebSocket, timers: clock().timers } });
  assert.equal(link.relayLink, null);
  assert.equal(link.status().relay.connected, false);
  await link.start();
  assert.equal(link.relayLink, null, "start() with access off listens and connects nothing");
  await link.stop();
});

test("a source that keeps failing can't keep a real phone out: a valid session is served, a failing one or an unknown device is held", async () => {
  const { relay, link, room } = await start();
  const lan = await pair(fetch as unknown as FetchLike, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "LAN phone", platform: "ios" });
  const away = await pairedOverRelay(link, relay, room, 6);
  const nobody = JSON.stringify({ device: "nobody" });
  const junk = (from: string, via: string, body = nobody) => link.serve({ route: "session", body: Buffer.from(body), from, via });

  // Over HTTP: this address (127.0.0.1, also the phone's) has failed 25 times.
  for (let i = 0; i < 25; i++) await junk("127.0.0.1", "http");
  assert.equal((await junk("127.0.0.1", "http")).status, 429, "an unknown device from it is held");
  assert.equal((await junk("127.0.0.1", "http", JSON.stringify({ device: lan.deviceId, eph: "x", box: "x" }))).status, 429, "so is a known device with a bad box");
  assert.equal((await junk("127.0.0.1", "http", "not json")).status, 429, "and a malformed request");
  assert.ok(Array.isArray(await new LinkClient(lan, { fetch: fetch as unknown as FetchLike, onParts() {}, onState() {} }).call("models")), "but the real phone's session opens");

  // Over the relay: the tag of the phone on the relay is 0000000000000006.
  for (let i = 0; i < 25; i++) await junk("0000000000000006", "relay");
  assert.equal((await junk("0000000000000006", "relay")).status, 429);
  const same = phone(relay, room, 6);
  assert.equal((await same.ask(3, "", nobody)).status, 429, "through a socket too");
  const second = new LinkClient(away.paired, { fetch: overRelay(same), onParts() {}, onState() {} });
  assert.ok(Array.isArray(await (second as any).call("models")), "the phone on the relay opens a session from the same source");

  // A pairing attempt from a source over its gate is told to wait, not that its code is wrong.
  link.startPairing();
  const gated = await link.serve({ route: "pair", body: Buffer.from("{}"), from: "0000000000000006", via: "relay" });
  assert.deepEqual([gated.status, gated.body.toString()], [429, '{"error":"pair_wait"}']);
  const open = await link.serve({ route: "pair", body: Buffer.from("{}"), from: "someone-else", via: "relay" });
  assert.equal(open.status, 400, "another source is answered as usual");
  await finish(link, away.thePhone, same);
});

test("a reset, or a change that adds, removes or moves the relay entry, ends every session so connected phones learn it at once", async () => {
  // No address is given, so the saved one applies and setRelay({ url }) can move it.
  const { link, room } = await start({ relay: (fake: FakeRelay, time: ReturnType<typeof clock>) => ({ WebSocket: fake.WebSocket, timers: time.timers }) });
  const lan = await pair(fetch as unknown as FetchLike, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "LAN phone", platform: "ios" });
  // What each session reply told the phone about where this computer is: read with the device's own key.
  const replies: string[][] = [];
  const spy: FetchLike = async (url, init) => {
    const answer = await (fetch as any)(url, init);
    if (url.endsWith("/session") && answer.ok) {
      const { box } = await answer.clone().json();
      replies.push(unbox(link.deviceKey(link.store.device(lan.deviceId)), box, "session-ok:" + link.store.data.serverId).hosts);
    }
    return answer;
  };
  const client = new LinkClient(lan, { fetch: spy, onParts() {}, onState() {} });
  const call = () => (client as any).call("models");
  await call();
  assert.equal(link.sessions.size, 1);
  assert.ok(replies.at(-1)!.some((host) => host.includes(room)), "the first session's hosts carry the relay entry");

  // A reset: the phone's next call opens a new session whose hosts carry the new room.
  const next = link.resetRelay();
  assert.equal(link.sessions.size, 0, "every session ended");
  await call();
  assert.equal(link.sessions.size, 1);
  assert.equal(replies.length, 2, "a new session was opened");
  assert.ok(replies.at(-1)!.some((host) => host.includes(next)), "the new room");
  assert.ok(!replies.at(-1)!.some((host) => host.includes(room)), "not the old one");

  // A change that doesn't touch the entry keeps sessions; turning it off, on and moving it each end them.
  link.setRelay({});
  assert.equal(link.sessions.size, 1, "nothing changed, nothing ended");
  link.setRelay({ enabled: false });
  assert.equal(link.sessions.size, 0);
  await call();
  assert.ok(!replies.at(-1)!.some((host) => host.startsWith("relay!")), "the entry is gone");
  link.setRelay({ enabled: true });
  assert.equal(link.sessions.size, 0);
  await call();
  assert.ok(replies.at(-1)!.some((host) => host.includes(next)), "the entry is back");
  link.setRelay({ url: "https://moved.test" });
  assert.equal(link.sessions.size, 0);
  await call();
  assert.ok(replies.at(-1)!.some((host) => host.endsWith("@moved.test")), "the entry moved");

  // A phone that is following (a wait open) learns it without a call of its own.
  const follower = new LinkClient(lan, { fetch: spy, onParts() {}, onState() {} });
  follower.start();
  await until(() => link.waiters.size >= 1, "the follower to wait");
  const count = replies.length;
  const latest = link.resetRelay();
  await until(() => replies.length > count && replies.at(-1)!.some((host) => host.includes(latest)), "the following phone to learn the new room", 5000);
  follower.stop();
  await link.stop();
});
