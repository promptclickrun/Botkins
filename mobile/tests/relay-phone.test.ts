// The phone's end of the relay (src/link/relay.ts, and what findHost and LinkClient do with a relay entry),
// against the in-memory relay of tests/fake-relay.ts. The test plays the computer itself.
// Run by `npm test` (tsx); it is left out of `tsc`.
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, randomBytes as nodeRandom, sign } from "node:crypto";
import { test } from "node:test";
import { agree, b64u, box, concat, fromUtf8, hkdf, INFO, newKeyPair, open, seal, seqBytes, seqNonce, unb64u, unbox, utf8 } from "../src/link/crypto";
import { findHost, type FetchLike, LinkClient, LinkError, type LinkRoute, type LinkState, pair, type Pairing } from "../src/link/client";
import { normalizeHost, parsePairingUrl } from "../src/link/pairing";
import { isRelayHost, makeRelayHost, parseRelayHost, relayFetch } from "../src/link/relay";
import { FakeRelay, HOST_PROTOCOL, hostChallenge, roomOf } from "./fake-relay";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await wait(5);
  }
}

// The computer's seat on the relay is a key pair. Its public key (as text) names the seat in these
// tests, where older ones had a token; `offer` is what the computer shows to sit down.
const seats = new Map<string, KeyObject>();
const newToken = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const name = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
  seats.set(name, privateKey);
  return name;
};
const offer = (token: string) => {
  const seconds = Math.floor(Date.now() / 1000);
  return [HOST_PROTOCOL, "k." + token, "t." + seconds, "s." + sign(null, Buffer.from(hostChallenge(roomOf(token), seconds)), seats.get(token)!).toString("base64url")];
};
const AUTHORITY = "127.0.0.1:8787";
/** A room on a fresh relay, with the entry the phone saves for it. */
function room() {
  const relay = new FakeRelay();
  const token = newToken();
  const name = roomOf(token);
  return { relay, token, name, entry: makeRelayHost(name, AUTHORITY) };
}
const relayUrl = (entry: string, route: string) => "http://" + entry + "/botkins/v1/" + route;

type Frame = { conn: Uint8Array; bytes: Uint8Array };
/** The computer's socket on the relay. `frames` holds every phone message that arrived (without the 16-byte prefix). */
function computerSocket(relay: FakeRelay, token: string, onFrame?: (frame: Frame, answer: (status: number, body: Uint8Array | string, id?: number) => void) => void) {
  const socket: any = new (relay.WebSocket as any)("ws://" + AUTHORITY + "/v1/host/" + roomOf(token), offer(token));
  const frames: Frame[] = [];
  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("The computer's socket was refused"));
  });
  const answerFor = (frame: Frame) => (status: number, body: Uint8Array | string = new Uint8Array(0), id = new DataView(frame.bytes.buffer, frame.bytes.byteOffset).getUint32(1)) => {
    const payload = typeof body === "string" ? utf8(body) : body;
    const out = new Uint8Array(8 + 7 + payload.length);
    out.set(frame.conn, 0);
    out[8] = 0x02;
    new DataView(out.buffer).setUint32(9, id);
    new DataView(out.buffer).setUint16(13, status);
    out.set(payload, 15);
    socket.send(out);
  };
  socket.onmessage = (event: { data: ArrayBuffer }) => {
    const all = new Uint8Array(event.data);
    if (all.length < 17 || all[16] !== 0x01) return;
    const frame = { conn: all.slice(0, 8), bytes: all.slice(16) };
    frames.push(frame);
    onFrame?.(frame, answerFor(frame));
  };
  return { socket, frames, opened, answer: (index: number, status: number, body?: Uint8Array | string, id?: number) => answerFor(frames[index])(status, body, id) };
}

const idOf = (frame: Frame) => new DataView(frame.bytes.buffer, frame.bytes.byteOffset).getUint32(1);

test("relay entries: the helpers accept the right ones and reject the rest", () => {
  const roomName = roomOf(newToken());
  assert.equal(roomName.length, 43);
  const good = [
    "relay!" + roomName + "@relay.botkins.app",
    "relay!" + roomName + "@relay.example.com:8443",
    "relay!" + roomName + "@127.0.0.1:8787",
    "relay!" + roomName + "@localhost",
    "relay!" + roomName + "@[::1]:8787",
  ];
  for (const entry of good) {
    assert.equal(isRelayHost(entry), true, entry);
    assert.equal(normalizeHost(entry), entry, "kept unchanged: " + entry);
  }
  assert.deepEqual(parseRelayHost(good[0]), { entry: good[0], room: roomName, authority: "relay.botkins.app", host: "relay.botkins.app", url: "wss://relay.botkins.app/v1/room/" + roomName });
  assert.equal(parseRelayHost(good[1])?.url, "wss://relay.example.com:8443/v1/room/" + roomName);
  assert.equal(parseRelayHost(good[2])?.url, "ws://127.0.0.1:8787/v1/room/" + roomName);
  assert.equal(parseRelayHost(good[3])?.url, "ws://localhost/v1/room/" + roomName);
  assert.equal(parseRelayHost(good[4])?.url, "ws://[::1]:8787/v1/room/" + roomName);
  assert.equal(makeRelayHost(roomName, "relay.example.com"), "relay!" + roomName + "@relay.example.com");

  const bad = [
    "relay!" + roomName.slice(1) + "@relay.example.com", // 42 characters
    "relay!" + roomName + "x@relay.example.com", // 44 characters
    "relay!" + roomName.slice(1) + "+@relay.example.com", // not base64url
    "relay!" + roomName + "@",
    "relay!" + roomName + "@relay.example.com/path",
    "relay!" + roomName + "@relay.example.com:99999",
    "relay!" + roomName + "@relay.example.com:0",
    "relay!" + roomName + "@user:pw@relay.example.com",
    "relay!" + roomName + "@bad host",
    "relay!" + roomName + "@a..b",
    "relay!" + roomName + "@[::2]:80",
    "relay!@relay.example.com",
    "relay " + roomName + "@relay.example.com",
    "192.168.1.20:47610",
  ];
  for (const entry of bad) {
    assert.equal(isRelayHost(entry), false, entry);
    assert.equal(parseRelayHost(entry), null, entry);
  }
  // A malformed relay entry is not turned into a plain host either.
  assert.equal(normalizeHost(bad[0]), null);
  assert.equal(normalizeHost("relay!x@y"), null);
  // Plain hosts are as before.
  assert.equal(normalizeHost("Mac.local"), "mac.local:47610");
  assert.equal(normalizeHost("http://192.168.1.20:5000/x"), "192.168.1.20:5000");
});

test("a pairing link with a relay entry in h= round-trips through the parser", () => {
  const { entry } = room();
  const key = b64u(nodeRandom(32));
  const url = "botkins://pair?v=1&s=srv&k=" + key + "&c=ABCD-EFGH-JKLM&h=" + encodeURIComponent("192.168.1.20:47610," + entry + ",relay!short@bad.example.com") + "&n=Mac";
  const target = parsePairingUrl(url);
  assert.ok(target);
  // The malformed entry is dropped; the good one is kept exactly.
  assert.deepEqual(target.hosts, ["192.168.1.20:47610", entry]);
  assert.equal(target.serverKey, key);
  // An unescaped link works too.
  const plain = parsePairingUrl("botkins://pair?v=1&k=" + key + "&c=ABCDEFGHJKLM&h=" + entry);
  assert.deepEqual(plain?.hosts, [entry]);
});

test("relayFetch hands URLs that are not relay entries to the inner fetch untouched", async () => {
  const seen: unknown[][] = [];
  const inner: FetchLike = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const { relay, name } = room();
  const fetcher = relayFetch(inner, { WebSocket: relay.WebSocket });
  const init = { method: "POST", headers: { "x-botkins-session": "abc" }, body: "x" };
  await fetcher("http://192.168.1.20:47610/botkins/v1/rpc", init);
  await fetcher("https://example.com/other", undefined);
  await fetcher("http://relay!tooshort@host.example/botkins/v1/hello");
  // A relay-shaped entry that is malformed is not carried over a socket either.
  assert.equal(seen.length, 3);
  assert.equal(seen[0][0], "http://192.168.1.20:47610/botkins/v1/rpc");
  assert.equal(seen[0][1], init, "the very same init object");
  assert.equal(seen[1][0], "https://example.com/other");
  assert.equal(relay.phonesIn(name).length, 0, "no socket was opened");
});

test("each route's frame is byte-exact", async () => {
  const { relay, token, name, entry } = room();
  const computer = computerSocket(relay, token);
  await computer.opened;
  const fetcher = relayFetch(async () => assert.fail("not for the inner fetch"), { WebSocket: relay.WebSocket, idleMs: 100 });

  void fetcher(relayUrl(entry, "hello")).catch(() => {});
  void fetcher(relayUrl(entry, "pair"), { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":"é"}' }).catch(() => {});
  void fetcher(relayUrl(entry, "session"), { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([1, 2]) }).catch(() => {});
  void fetcher(relayUrl(entry, "rpc"), { method: "POST", headers: { "content-type": "application/octet-stream", "x-botkins-session": "sess-123" }, body: new Uint8Array([9, 8, 7, 0, 255]) }).catch(() => {});
  await until(() => computer.frames.length === 4, "four frames");

  const [hello, pair, session, rpc] = computer.frames.map((frame) => frame.bytes);
  const ids = computer.frames.map(idOf);
  assert.deepEqual([...hello], [0x01, ...u32(ids[0]), 1, 0], "hello: route 1, no session, empty body");
  assert.deepEqual([...pair], [0x01, ...u32(ids[1]), 2, 0, ...utf8('{"a":"é"}')], "pair: a string body is UTF-8");
  assert.deepEqual([...session], [0x01, ...u32(ids[2]), 3, 0, 1, 2], "session: route 3, empty session");
  assert.deepEqual([...rpc], [0x01, ...u32(ids[3]), 4, 8, ...utf8("sess-123"), 9, 8, 7, 0, 255], "rpc: route 4, the session id, the binary body");
  assert.equal(new Set(ids).size, 4, "every id is different");
  assert.deepEqual(ids, [ids[0], ids[0] + 1, ids[0] + 2, ids[0] + 3], "ids count up");
  assert.equal(relay.phonesIn(name).length, 1, "one socket carries all of them");
  assert.deepEqual(computer.frames[0].conn, relay.phonesIn(name)[0].conn);
  assert.equal(relay.phonesIn(name)[0].protocol, "botkins.phone.v1");
  for (let i = 0; i < 4; i++) computer.answer(i, 200, "{}");
  await wait(150);
});
const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];

test("an answer resolves with its status, json() and arrayBuffer()", async () => {
  const { relay, token, entry } = room();
  const computer = computerSocket(relay, token, (frame, answer) => {
    const route = frame.bytes[5];
    if (route === 1) answer(200, '{"botkins":1,"serverId":"s"}');
    else if (route === 4) answer(200, frame.bytes.subarray(7 + frame.bytes[6]));
    else answer(403, '{"error":"unknown_device"}');
  });
  await computer.opened;
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, idleMs: 100 });

  const hello = await fetcher(relayUrl(entry, "hello"));
  assert.equal(hello.ok, true);
  assert.equal(hello.status, 200);
  assert.deepEqual(await hello.json(), { botkins: 1, serverId: "s" });

  const bytes = new Uint8Array([0, 1, 2, 250, 251]);
  const rpc = await fetcher(relayUrl(entry, "rpc"), { method: "POST", headers: { "x-botkins-session": "s1" }, body: bytes });
  assert.deepEqual([...new Uint8Array(await rpc.arrayBuffer())], [...bytes]);

  const refused = await fetcher(relayUrl(entry, "session"), { method: "POST", body: "{}" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "unknown_device" });
});

test("many requests in flight on one socket resolve to the right callers, answered out of order", async () => {
  const { relay, token, name, entry } = room();
  const computer = computerSocket(relay, token);
  await computer.opened;
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, idleMs: 100 });
  const count = 12;
  const calls = Array.from({ length: count }, (_, i) => fetcher(relayUrl(entry, "rpc"), { method: "POST", headers: { "x-botkins-session": "s" }, body: new Uint8Array([i]) }));
  await until(() => computer.frames.length === count, "all requests");
  assert.equal(relay.phonesIn(name).length, 1);
  // Answer in a shuffled order; each answer carries the request's own body.
  const order = [...Array(count).keys()].sort((a, b) => ((a * 7) % count) - ((b * 7) % count));
  assert.notDeepEqual(order, [...Array(count).keys()]);
  for (const index of order) computer.answer(index, 200, new Uint8Array([index, 100 + index]));
  const answers = await Promise.all(calls);
  for (let i = 0; i < count; i++) assert.deepEqual([...new Uint8Array(await answers[i].arrayBuffer())], [i, 100 + i]);
});

test("a computer that is not on the relay rejects like a failed fetch, and the socket stays usable", async () => {
  const { relay, token, name, entry } = room();
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, idleMs: 200 });
  await assert.rejects(fetcher(relayUrl(entry, "hello")), (error: unknown) => error instanceof Error);
  assert.equal(relay.phonesIn(name).length, 1, "the phone's socket is still open");
  const first = relay.phonesIn(name)[0];
  const computer = computerSocket(relay, token, (_frame, answer) => answer(200, "{}"));
  await computer.opened;
  const response = await fetcher(relayUrl(entry, "hello"));
  assert.equal(response.status, 200);
  assert.equal(relay.phonesIn(name)[0], first, "the same socket carried it");
});

test("a relay that is down rejects, and the next request tries again", async () => {
  const { relay, token, entry } = room();
  const computer = computerSocket(relay, token, (_frame, answer) => answer(200, "{}"));
  await computer.opened;
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, idleMs: 100 });
  relay.down = true;
  await assert.rejects(fetcher(relayUrl(entry, "hello")), (error: unknown) => error instanceof Error);
  relay.down = false;
  assert.equal((await fetcher(relayUrl(entry, "hello"))).status, 200);
});

test("a socket that never opens fails after connectMs", async () => {
  const { entry } = room();
  let closed = 0;
  class Never {
    binaryType = "";
    readyState = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    send() {}
    close() {
      closed++;
    }
  }
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: Never as any, connectMs: 30 });
  const started = Date.now();
  await assert.rejects(fetcher(relayUrl(entry, "hello")), (error: unknown) => error instanceof Error);
  assert.ok(Date.now() - started < 1000);
  assert.equal(closed, 1, "the socket was closed");
});

test("a dropped phone socket rejects what was pending, and the next request opens a new socket", async () => {
  const { relay, token, name, entry } = room();
  const computer = computerSocket(relay, token);
  await computer.opened;
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, idleMs: 200 });
  const a = fetcher(relayUrl(entry, "hello"));
  const b = fetcher(relayUrl(entry, "hello"));
  const settled = Promise.allSettled([a, b]);
  await until(() => computer.frames.length === 2, "both requests");
  const first = relay.phonesIn(name)[0];
  relay.dropPhones(name);
  const results = await settled;
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);

  const next = fetcher(relayUrl(entry, "hello"));
  await until(() => computer.frames.length === 3, "the next request");
  const second = relay.phonesIn(name)[0];
  assert.ok(second && second !== first, "a new socket");
  computer.answer(2, 200, "{}");
  assert.equal((await next).status, 200);
});

test("when the computer's own socket drops, the next request is refused at once, and works once it is back", async () => {
  const { relay, token, name, entry } = room();
  const first = computerSocket(relay, token, (_frame, answer) => answer(200, "{}"));
  await first.opened;
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, idleMs: 300 });
  assert.equal((await fetcher(relayUrl(entry, "hello"))).status, 200);
  relay.dropHost(name);
  await assert.rejects(fetcher(relayUrl(entry, "hello")), (error: unknown) => error instanceof Error);
  const second = computerSocket(relay, token, (_frame, answer) => answer(200, "{}"));
  await second.opened;
  assert.equal((await fetcher(relayUrl(entry, "hello"))).status, 200);
});

test("an aborted request rejects at once, and a late answer for it is ignored", async () => {
  const { relay, token, entry } = room();
  const computer = computerSocket(relay, token);
  await computer.opened;
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, idleMs: 100 });

  const controller = new AbortController();
  const aborted = fetcher(relayUrl(entry, "rpc"), { method: "POST", headers: { "x-botkins-session": "s" }, body: new Uint8Array([1]), signal: controller.signal });
  const rejected = assert.rejects(aborted, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await until(() => computer.frames.length === 1, "the request");
  controller.abort();
  await rejected;

  // A request already aborted never goes out.
  await assert.rejects(fetcher(relayUrl(entry, "hello"), { signal: controller.signal }), (error: unknown) => error instanceof Error && error.name === "AbortError");
  await wait(20);
  assert.equal(computer.frames.length, 1);

  // The late answer to the forgotten id is ignored; the next request is not confused by it.
  const next = fetcher(relayUrl(entry, "hello"));
  await until(() => computer.frames.length === 2, "the next request");
  computer.answer(0, 200, "late");
  computer.answer(1, 200, '{"ok":true}');
  assert.deepEqual(await (await next).json(), { ok: true });
});

test("a socket with nothing pending closes after idleMs, and sends no more pings", async () => {
  const { relay, token, name, entry } = room();
  const computer = computerSocket(relay, token, (_frame, answer) => answer(200, "{}"));
  await computer.opened;
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, idleMs: 60, pingMs: 15 });
  await fetcher(relayUrl(entry, "hello"));
  const first = relay.phonesIn(name)[0];
  assert.ok(first);
  await until(() => relay.phonesIn(name).length === 0, "the idle close", 1000);
  const sent = first.sent;
  await wait(100);
  assert.equal(first.sent, sent, "no timer is left sending pings");
  // The next request opens a new socket.
  assert.equal((await fetcher(relayUrl(entry, "hello"))).status, 200);
  assert.notEqual(relay.phonesIn(name)[0], first);
});

test("a socket with a request pending stays open past idleMs and keeps it alive with pings", async () => {
  const { relay, token, name, entry } = room();
  const computer = computerSocket(relay, token);
  await computer.opened;
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, idleMs: 40, pingMs: 20, deadMs: 60 });
  const call = fetcher(relayUrl(entry, "hello"));
  await until(() => computer.frames.length === 1, "the request");
  const socket = relay.phonesIn(name)[0];
  await wait(250);
  assert.ok(socket.sent >= 4, "one request and several pings went out (" + socket.sent + ")");
  assert.equal(relay.phonesIn(name)[0], socket, "still the same socket");
  computer.answer(0, 200, "{}");
  assert.equal((await call).status, 200);
});

test("a socket that stops answering pings is dead: it closes and rejects what is pending", async () => {
  const { relay, token, name, entry } = room();
  const computer = computerSocket(relay, token);
  await computer.opened;
  const Base = relay.WebSocket as any;
  // A phone socket whose pings never get through, so no pong comes back.
  class Mute extends Base {
    send(data: any) {
      if (data === "ping") return;
      super.send(data);
    }
  }
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: Mute as any, idleMs: 100, pingMs: 20, deadMs: 40 });
  const started = Date.now();
  await assert.rejects(fetcher(relayUrl(entry, "hello")), (error: unknown) => error instanceof Error);
  const took = Date.now() - started;
  assert.ok(took >= 40 && took < 1000, "rejected after about pingMs + deadMs (" + took + " ms)");
  await until(() => relay.phonesIn(name).length === 0, "the dead socket to close");
});

// ---------------------------------------------------------------------------------------------
// The computer, with real crypto, for findHost and LinkClient.

type Seen = { via: "direct" | "relay"; route: string; method?: string };
class Computer {
  server = newKeyPair();
  serverId = "server-1";
  deviceId = "device-1";
  deviceKey: Uint8Array;
  sessions = new Map<string, { toHost: Uint8Array; toPhone: Uint8Array }>();
  seen: Seen[] = [];
  hosts: string[] = [];
  /** Another computer's id, for a direct address that answers as someone else. */
  impostor = false;
  /** A direct address that only plays the computer's public hello back: it can't open a session. */
  playsHello = false;
  constructor(private phonePublic: Uint8Array) {
    this.deviceKey = hkdf(agree(this.server.secretKey, phonePublic), utf8(this.deviceId), INFO.device);
  }
  hello(via: "direct" | "relay") {
    const base = { botkins: 1, serverId: this.impostor && via === "direct" ? "someone-else" : this.serverId, publicKey: b64u(this.server.publicKey), pairing: false };
    return via === "direct" ? { ...base, name: "Test Mac", app: "botkins", version: "1.0.0" } : base;
  }
  async handle(via: "direct" | "relay", route: string, sessionId: string, body: Uint8Array): Promise<{ status: number; body: Uint8Array }> {
    const json = (value: unknown) => ({ status: 200, body: utf8(JSON.stringify(value)) });
    if (route === "hello") {
      this.seen.push({ via, route });
      return json(this.hello(via));
    }
    if (route === "session") {
      this.seen.push({ via, route });
      if (this.playsHello && via === "direct") return { status: 403, body: utf8(JSON.stringify({ error: "bad_session" })) };
      const message = JSON.parse(fromUtf8(body));
      const hello = unbox<{ eph: string; nonce: string }>(this.deviceKey, message.box, "session:" + this.serverId);
      const mine = newKeyPair();
      const nonce = nodeRandom(16);
      const salt = concat(unb64u(hello.nonce), nonce);
      const master = hkdf(concat(agree(mine.secretKey, unb64u(hello.eph)), this.deviceKey), salt, INFO.session);
      const id = b64u(nodeRandom(12));
      this.sessions.set(id, { toHost: hkdf(master, salt, INFO.toHost), toPhone: hkdf(master, salt, INFO.toPhone) });
      return json({ box: box(this.deviceKey, { session: id, eph: b64u(mine.publicKey), nonce: b64u(nonce), epoch: "epoch-1", hosts: this.hosts }, "session-ok:" + this.serverId) });
    }
    if (route === "rpc") {
      const session = this.sessions.get(sessionId);
      if (!session) return { status: 401, body: new Uint8Array(0) };
      const seq = Number(new DataView(body.buffer, body.byteOffset).getBigUint64(0));
      const call = JSON.parse(fromUtf8(open(session.toHost, seqNonce(seq), body.subarray(8), "rpc:" + sessionId))) as { m: string; a: unknown[] };
      this.seen.push({ via, route, method: call.m });
      let result: unknown = null;
      if (call.m === "link.sync") {
        // A long poll, shortened.
        await wait(120);
        result = { epoch: "epoch-1", v: null, parts: {} };
      } else if (call.m === "slow") {
        await wait(300);
        result = "slow-done";
      } else if (call.m === "echo") result = call.a[0];
      return { status: 200, body: seal(session.toPhone, seqNonce(seq), utf8(JSON.stringify({ r: result })), "ok:" + sessionId) };
    }
    return { status: 404, body: utf8("{}") };
  }
  /** Serves what arrives from phones on the relay. */
  attach(relay: FakeRelay, token: string) {
    return computerSocket(relay, token, (frame, answer) => {
      const bytes = frame.bytes;
      const route = ["", "hello", "pair", "session", "rpc"][bytes[5]];
      const n = bytes[6];
      const id = idOf(frame);
      void this.handle("relay", route, fromUtf8(bytes.subarray(7, 7 + n)), bytes.slice(7 + n)).then((done) => answer(done.status, done.body, id));
    });
  }
}

const response = (status: number, body: Uint8Array) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(fromUtf8(body)), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer });

/** The computer's direct address as a fetch: up, down (refuses at once) or hang (no answer until aborted). */
function directFetch(computer: Computer, mode: { state: "up" | "down" | "hang" | "stuck" }, calls: string[] = []): FetchLike {
  return async (url, init) => {
    const match = /^http:\/\/([^/]+)\/botkins\/v1\/(\w+)$/.exec(url);
    assert.ok(match, "an unexpected URL reached the inner fetch: " + url);
    calls.push(match[1]);
    if (mode.state === "down") throw new TypeError("Network request failed");
    if (mode.state === "hang") {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    // A request the system dropped under a suspended app: it never settles, not even when aborted.
    if (mode.state === "stuck") await new Promise(() => {});
    const body = typeof init?.body === "string" ? utf8(init.body) : (init?.body ?? new Uint8Array(0));
    const done = await computer.handle("direct", match[2], init?.headers?.["x-botkins-session"] ?? "", body);
    return response(done.status, done.body);
  };
}

const DIRECT = "10.0.0.2:47610";
function scene(options: { idleMs?: number } = {}) {
  const { relay, token, name, entry } = room();
  const phone = newKeyPair();
  const computer = new Computer(phone.publicKey);
  computer.hosts = [DIRECT, entry];
  const host = computer.attach(relay, token);
  const mode: { state: "up" | "down" | "hang" | "stuck" } = { state: "down" };
  const direct: string[] = [];
  const fetcher = relayFetch(directFetch(computer, mode, direct), { WebSocket: relay.WebSocket, idleMs: options.idleMs ?? 80 });
  const pairing: Pairing = { serverId: computer.serverId, serverKey: b64u(computer.server.publicKey), deviceId: computer.deviceId, secretKey: b64u(phone.secretKey), hosts: [DIRECT, entry], name: "Test Mac" };
  return { relay, name, entry, computer, host, mode, direct, fetcher, pairing, expect: { serverId: computer.serverId, serverKey: pairing.serverKey } };
}

test("findHost prefers a direct address when both answer", async () => {
  const s = scene();
  await s.host.opened;
  s.mode.state = "up";
  // The relay entry is listed first, and is still not the one chosen.
  const found = await findHost(s.fetcher, [s.entry, DIRECT], s.expect);
  assert.equal(found.host, DIRECT);
  assert.equal(found.hello.name, "Test Mac");
  assert.equal(s.host.frames.length, 0, "the relay was never asked");
  assert.deepEqual(s.computer.seen.map((seen) => seen.via), ["direct"]);
});

test("findHost falls back to the relay when the direct addresses are dead, and the hello there has no name", async () => {
  const s = scene();
  await s.host.opened;
  s.mode.state = "down";
  const found = await findHost(s.fetcher, [DIRECT, s.entry], s.expect);
  assert.equal(found.host, s.entry);
  assert.equal(found.hello.serverId, s.computer.serverId);
  assert.equal(found.hello.name, undefined);
  assert.equal(found.hello.app, undefined);
  assert.equal(found.hello.version, undefined);
});

test("findHost gives the direct addresses 1.5 s when there is a relay entry to fall back on", async () => {
  const s = scene();
  await s.host.opened;
  s.mode.state = "hang";
  const started = Date.now();
  const found = await findHost(s.fetcher, [DIRECT, s.entry], s.expect);
  const took = Date.now() - started;
  assert.equal(found.host, s.entry);
  assert.ok(took >= 1400 && took < 3500, "waited about 1500 ms for the direct address (" + took + " ms)");
});

test("findHost tries the relay even when a direct address is the wrong computer, and says so when nothing works", async () => {
  const s = scene();
  await s.host.opened;
  s.mode.state = "up";
  s.computer.impostor = true;
  const found = await findHost(s.fetcher, [DIRECT, s.entry], s.expect);
  assert.equal(found.host, s.entry, "the relay answered as the right computer");

  // With the relay down as well, the person is told a different computer answered.
  s.relay.down = true;
  s.relay.dropPhones(s.name);
  await assert.rejects(
    findHost(s.fetcher, [DIRECT, s.entry], s.expect),
    (error: any) => error.code === "not-found" && /different computer/.test(error.message),
  );
  // And with nobody wrong, it is the plain message.
  s.computer.impostor = false;
  s.mode.state = "down";
  await assert.rejects(findHost(s.fetcher, [DIRECT, s.entry], s.expect), (error: any) => error.code === "not-found" && /didn't answer/.test(error.message));
});

test("findHost without a relay entry works as before", async () => {
  const s = scene();
  s.mode.state = "down";
  await assert.rejects(findHost(s.fetcher, [DIRECT], s.expect, 100), (error: any) => error.code === "not-found" && /didn't answer/.test(error.message));
  s.mode.state = "up";
  assert.equal((await findHost(s.fetcher, [DIRECT], s.expect, 100)).host, DIRECT);
  // Only a relay entry: it is the one asked.
  await s.host.opened;
  assert.equal((await findHost(s.fetcher, [s.entry], s.expect)).host, s.entry);
});

type Run = ReturnType<typeof scene> & { client: LinkClient; routes: (LinkRoute | null)[]; states: LinkState[]; saved: string[][] };
function startClient(s: ReturnType<typeof scene>, probeMs: number): Run {
  const routes: (LinkRoute | null)[] = [];
  const states: LinkState[] = [];
  const saved: string[][] = [];
  const client = new LinkClient(s.pairing, { fetch: s.fetcher, onParts() {}, onState: (state) => states.push(state), onRoute: (route) => routes.push(route), onHosts: (hosts) => saved.push(hosts), probeMs });
  client.start();
  return { ...s, client, routes, states, saved };
}

test("LinkClient reports route relay after a session opened through the relay, and keeps the relay entry saved", async () => {
  const s = startClient(scene(), 1e9);
  try {
    await s.host.opened;
    await until(() => s.client.route === "relay", "the relay route");
    await until(() => s.states.includes("online"), "online through the relay");
    assert.deepEqual(s.routes, ["relay"]);
    assert.ok(s.saved.length > 0, "the computer's addresses were saved");
    assert.ok(s.saved.at(-1)!.includes(s.entry), "the relay entry is kept");
    assert.ok(s.saved.at(-1)!.includes(DIRECT));
    assert.ok(s.computer.seen.some((seen) => seen.route === "rpc" && seen.via === "relay"));
    assert.equal(await s.client.call("echo", "hi"), "hi");
  } finally {
    s.client.stop();
  }
  assert.equal(s.client.route, null);
  assert.equal(s.routes.at(-1), null);
});

test("LinkClient returns to the direct path once the probe finds a direct address", async () => {
  const s = startClient(scene(), 40);
  try {
    await until(() => s.client.route === "relay", "the relay route");
    await until(() => s.states.includes("online"), "online");
    s.mode.state = "up";
    await until(() => s.client.route === "direct", "the direct route");
    assert.deepEqual(s.routes, ["relay", null, "direct"]);
    // The follow loop carries on over the direct session.
    await until(() => s.computer.seen.some((seen) => seen.route === "rpc" && seen.via === "direct"), "a direct sync request");
    assert.equal(await s.client.call("echo", 7), 7);
    assert.equal(s.computer.seen.at(-1)?.via === "direct" || s.computer.seen.some((seen) => seen.method === "echo" && seen.via === "direct"), true);
    // No probing while direct: the route stays.
    await wait(150);
    assert.equal(s.client.route, "direct");
  } finally {
    s.client.stop();
  }
});

test("wake() probes at once; a direct address that is another computer does not move the phone", async () => {
  const s = startClient(scene(), 1e9);
  try {
    await until(() => s.client.route === "relay", "the relay route");
    await until(() => s.states.includes("online"), "online");
    // Direct answers, but as someone else: nothing changes.
    s.mode.state = "up";
    s.computer.impostor = true;
    assert.equal(await s.client.probeDirect(), false);
    assert.equal(s.client.route, "relay");
    // The right computer: wake() starts the probe without waiting for the interval.
    s.computer.impostor = false;
    s.client.wake();
    await until(() => s.client.route === "direct", "the direct route after wake()");
    assert.deepEqual(s.routes, ["relay", null, "direct"]);
  } finally {
    s.client.stop();
  }
});

test("switching to the direct path does not break a call in flight", async () => {
  const s = startClient(scene(), 1e9);
  try {
    await until(() => s.client.route === "relay", "the relay route");
    await until(() => s.states.includes("online"), "online");
    const slow = s.client.call("slow");
    await until(() => s.computer.seen.some((seen) => seen.method === "slow"), "the slow call to arrive");
    s.mode.state = "up";
    assert.equal(await s.client.probeDirect(), true);
    assert.equal(await slow, "slow-done", "the call finished on the session it began with");
    await until(() => s.client.route === "direct", "the direct route");
    assert.equal(await s.client.call("echo", "after"), "after");
    assert.ok(s.computer.seen.some((seen) => seen.method === "echo" && seen.via === "direct"), "the next call went direct");
    assert.ok(s.states.every((state) => state !== "offline"), "the phone never showed as unreachable: " + s.states.join());
  } finally {
    s.client.stop();
  }
});

test("a direct address that plays the hello back but can't open a session doesn't keep the phone off the relay", async () => {
  const base = scene();
  base.mode.state = "up";
  base.computer.playsHello = true;
  const s = startClient(base, 1e9);
  try {
    // The direct address answers the hello, fails the session, and the relay takes over in the same attempt.
    await until(() => s.client.route === "relay", "the relay route");
    await until(() => s.states.includes("online"), "online through the relay");
    assert.equal(await s.client.call("echo", "x"), "x");
    assert.ok(s.states.every((state) => state !== "offline"), "never shown as unreachable: " + s.states.join());
    // It is not asked again for a while: a look for the direct path finds nothing to try.
    const sessionsBefore = s.computer.seen.filter((seen) => seen.route === "session" && seen.via === "direct").length;
    assert.equal(await s.client.probeDirect(), false);
    assert.equal(s.client.route, "relay");
    assert.equal(s.computer.seen.filter((seen) => seen.route === "session" && seen.via === "direct").length, sessionsBefore);
    // On another network it gets a fresh try, and this time it is the real computer.
    s.computer.playsHello = false;
    s.client.wake("network");
    await until(() => s.client.route === "direct", "the direct route after a network change");
    assert.equal(await s.client.call("echo", "y"), "y");
  } finally {
    s.client.stop();
  }
});

test("pairing says so when the computer has had too many tries from this network", async () => {
  const keys = newKeyPair();
  const fetcher: FetchLike = async (url) =>
    url.endsWith("/hello")
      ? response(200, utf8(JSON.stringify({ botkins: 1, serverId: "server-1", publicKey: b64u(keys.publicKey), pairing: true, name: "Test Mac" })))
      : response(429, utf8(JSON.stringify({ error: "pair_wait" })));
  await assert.rejects(pair(fetcher, { hosts: ["192.168.1.9:47610"], code: "ABCDEFGHJKLM" }, { name: "Phone", platform: "ios" }), (error: unknown) => {
    assert.ok(error instanceof LinkError);
    assert.match(error.message, /Too many tries/);
    return true;
  });
});

test("an address the computer announced is learned: tried first, saved, and used at once", async () => {
  const phone = newKeyPair();
  const computer = new Computer(phone.publicKey);
  const OLD = "192.0.2.1:47610";
  const NEW = "192.0.2.50:51234";
  computer.hosts = [NEW];
  const inner = directFetch(computer, { state: "up" });
  // The address the phone saved no longer answers; the computer is at a new one.
  const fetcher: FetchLike = (url, init) => (url.includes(OLD) ? Promise.reject(new TypeError("Network request failed")) : inner(url, init));
  const pairing: Pairing = { serverId: computer.serverId, serverKey: b64u(computer.server.publicKey), deviceId: computer.deviceId, secretKey: b64u(phone.secretKey), hosts: [OLD], name: "Test Mac" };
  const states: LinkState[] = [];
  const saved: string[][] = [];
  const client = new LinkClient(pairing, { fetch: fetcher, onParts() {}, onState: (state) => states.push(state), onHosts: (hosts) => saved.push(hosts) });
  client.start();
  try {
    await until(() => states.includes("offline") || states.includes("connecting"), "the phone to notice the computer is gone");
    await assert.rejects(client.call("echo", 1));
    client.learn(NEW);
    assert.deepEqual(saved.at(-1), [NEW, OLD], "the found address goes first and the old one is kept");
    await until(() => client.route === "direct", "a session at the new address");
    assert.equal(await client.call("echo", 2), 2);
    // Learning it again, or a relay entry, changes nothing.
    const count = saved.length;
    client.learn(NEW);
    client.learn("relay!" + "A".repeat(43) + "@relay.botkins.app");
    assert.equal(saved.length, count);
  } finally {
    client.stop();
  }
});

// ---------------------------------------------------------------------------------------------
// Coming back after the app was in the background.

test("after a wake, a path that died while the phone was away is given up in seconds, and the phone carries on another way", async () => {
  const s = scene();
  s.mode.state = "up";
  const states: LinkState[] = [];
  const client = new LinkClient(s.pairing, { fetch: s.fetcher, onParts() {}, onState: (state) => states.push(state), probeMs: 1e9, wakeMs: 80, check: () => s.fetcher.check(80) });
  client.start();
  try {
    await until(() => client.route === "direct" && states.includes("online"), "online on the direct path");
    // The phone left the network while the app was suspended: requests to the old address never
    // settle, not even when they are aborted.
    s.mode.state = "stuck";
    const started = Date.now();
    client.wake();
    await until(() => client.route === "relay", "the move to the relay", 6000);
    assert.ok(Date.now() - started < 4000, "it did not wait out a 40-second sync (" + (Date.now() - started) + " ms)");
    assert.equal(await client.call("echo", "back"), "back");
    assert.ok(!states.includes("offline"), "the computer was never reported as unreachable");
  } finally {
    client.stop();
  }
});

test("check() ends a relay socket that looks open but is dead, long before the next regular ping", async () => {
  const { relay, token, name, entry } = room();
  const computer = computerSocket(relay, token); // never answers
  await computer.opened;
  const Base = relay.WebSocket as any;
  class Mute extends Base {
    send(data: any) {
      if (data === "ping") return;
      super.send(data);
    }
  }
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: Mute as any, pingMs: 60_000, deadMs: 60_000 });
  const pending = fetcher(relayUrl(entry, "hello"));
  await until(() => relay.phonesIn(name).length === 1, "the phone socket to open");
  await wait(20);
  const started = Date.now();
  fetcher.check(50);
  await assert.rejects(pending, /stopped answering/);
  assert.ok(Date.now() - started < 1000);
  await until(() => relay.phonesIn(name).length === 0, "the dead socket to close");
});

test("check() leaves a healthy relay socket alone", async () => {
  const { relay, token, entry } = room();
  let answerLater: (() => void) | undefined;
  const computer = computerSocket(relay, token, (frame, answer) => {
    answerLater = () => answer(200, "{}", idOf(frame));
  });
  await computer.opened;
  const fetcher = relayFetch(async () => assert.fail("inner"), { WebSocket: relay.WebSocket, pingMs: 60_000, deadMs: 60_000 });
  const pending = fetcher(relayUrl(entry, "hello"));
  await until(() => !!answerLater, "the request to reach the computer");
  fetcher.check(40);
  await wait(120); // well past the check's deadline: the pong kept the socket
  answerLater!();
  assert.equal((await pending).status, 200);
});

test("every offline attempt reports unreachable, but a recovered blip stays quiet", async () => {
  const s = scene();
  const states: LinkState[] = [];
  const misses: LinkState[] = [];
  let blip = false;
  const client = new LinkClient({ ...s.pairing, hosts: [DIRECT] }, {
    fetch: (url, init) => {
      if (blip && url.endsWith("/rpc")) {
        blip = false;
        return Promise.reject(new Error("missed answer"));
      }
      return s.fetcher(url, init);
    },
    onParts() {},
    onState: (state) => states.push(state),
    onUnreachable: () => misses.push(client.state),
  });
  client.start();
  try {
    await until(() => s.direct.length >= 2, "two failed attempts");
    assert.deepEqual(misses, ["offline", "offline"]);
    s.mode.state = "up";
    client.learn(DIRECT);
    await until(() => client.state === "online", "the known address to wake the link", 600);
    blip = true;
    await until(() => states.filter(state => state === "online").length === 2, "the recovered blip");
    assert.deepEqual(misses, ["offline", "offline"]);
  } finally {
    client.stop();
  }
});

test("a late session answers its caller without publishing after stop", async () => {
  const s = scene();
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let opening = false;
  const reports: unknown[] = [];
  const client = new LinkClient(s.pairing, {
    fetch: async (url, init) => {
      if (url.endsWith("/session")) {
        opening = true;
        await gate;
      }
      return s.fetcher(url, init);
    },
    onParts: parts => reports.push(parts), onState: state => reports.push(state),
    onHosts: hosts => reports.push(hosts), onRoute: route => reports.push(route),
  });
  client.start();
  try {
    const answer = client.call("echo", "done");
    await until(() => opening, "session POST");
    client.stop();
    resume();
    assert.equal(await answer, "done");
    assert.equal(client.route, null);
    assert.deepEqual(reports, []);
    client.start();
    await until(() => client.state === "online", "restart");
  } finally {
    resume();
    client.stop();
  }
});

test("a one-call relay client neither syncs nor schedules probes", async (t) => {
  const s = scene();
  const delay = 12_345;
  const interval = t.mock.method(globalThis, "setInterval");
  const timeout = t.mock.method(globalThis, "setTimeout");
  const client = new LinkClient(s.pairing, { fetch: s.fetcher, onParts() {}, onState() {}, probeMs: delay });
  try {
    assert.equal(await client.call("echo", "once"), "once");
    assert.deepEqual(s.computer.seen.filter(item => item.method).map(item => item.method), ["echo"]);
    assert.ok(![...interval.mock.calls, ...timeout.mock.calls].some(call => call.arguments[1] === delay));
  } finally {
    client.stop();
  }
});

test("relay probes back off to the limit and wake restarts the short wait", async (t) => {
  const s = scene();
  const hellos: number[] = [];
  const timeout = t.mock.method(globalThis, "setTimeout");
  const waits = () => timeout.mock.calls.map(call => call.arguments[1]).filter(ms => [83, 166, 241].includes(ms));
  const client = new LinkClient(s.pairing, {
    fetch: (url, init) => {
      if (url.includes(DIRECT) && url.endsWith("/hello")) hellos.push(performance.now());
      return s.fetcher(url, init);
    },
    onParts() {}, onState() {}, probeMs: 83, probeMaxMs: 241,
  });
  client.start();
  try {
    await until(() => hellos.length >= 5, "four probes after the initial hello");
    for (const [i, gap] of [83, 166, 241, 241].entries()) {
      const elapsed = hellos[i + 1] - hellos[i];
      assert.ok(elapsed >= gap - 3, "gap of " + elapsed + " ms, expected " + gap);
    }
    assert.deepEqual(waits().slice(0, 4), [83, 166, 241, 241]);
    s.computer.sessions.clear();
    assert.equal(await client.call("echo", "renew"), "renew");
    assert.equal(waits().at(-1), 241, "renewing on the relay keeps the longer wait");

    const count = hellos.length;
    client.wake();
    assert.equal(hellos.length, count + 1);
    await until(() => hellos.length >= count + 2, "short wait after wake");
    const elapsed = hellos[count + 1] - hellos[count];
    assert.ok(elapsed >= 80, "gap after wake: " + elapsed);
    assert.deepEqual(waits().slice(-2), [83, 166]);
  } finally {
    client.stop();
  }
});
