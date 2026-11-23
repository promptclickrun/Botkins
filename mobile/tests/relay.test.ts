// The whole relay path, end to end: the phone's real client (src/link, with relayFetch) through
// the in-memory relay (tests/fake-relay.ts) to a real LinkHost with its own relay link. Nothing
// here plays either side by hand; the two halves were written apart and meet in this file.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import { parsePairingUrl } from "../src/link/pairing";
import { isRelayHost, relayFetch } from "../src/link/relay";
import { FakeRelay } from "./fake-relay";

const phone = { name: "Test phone", platform: "ios" };
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await tick(10);
  }
}

/** A computer with its relay link up, and a phone-side fetch whose direct path can be cut. */
async function setup() {
  const relay = new FakeRelay();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-relay-e2e-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], searchPath: [], relay: { url: "https://relay.test", WebSocket: relay.WebSocket } });
  await link.setEnabled(true);
  // The relay is off until the person turns it on.
  assert.equal(link.status().relay.enabled, false);
  assert.ok(!link.hosts().some(isRelayHost));
  link.setRelay({ enabled: true });
  await until(() => link.status().relay.connected, "the computer to reach the relay");
  const net = { direct: true };
  // The phone's network: the real fetch for the computer's own address while `direct` holds.
  const inner: FetchLike = (url, init) => (net.direct ? (fetch as unknown as FetchLike)(url, init) : Promise.reject(new TypeError("Network request failed")));
  const fetcher = relayFetch(inner, { WebSocket: relay.WebSocket as any, idleMs: 200 });
  const room = link.hosts().find(isRelayHost)!.slice("relay!".length).split("@")[0];
  return { relay, link, backend, net, fetcher, room };
}

function follow(paired: Awaited<ReturnType<typeof pair>>, fetcher: FetchLike, probeMs = 60_000) {
  const parts: Record<string, any> = {};
  const routes: (string | null)[] = [];
  const client = new LinkClient(paired, {
    fetch: fetcher,
    probeMs,
    onParts: (next) => void Object.assign(parts, next),
    onState() {},
    onRoute: (route) => void routes.push(route),
  } as any);
  client.start();
  return { client, parts, routes };
}

test("the pairing link carries the relay, and a phone that can't reach the computer pairs and works through it", async () => {
  const { relay, link, backend, net, fetcher, room } = await setup();
  const target = parsePairingUrl(link.startPairing().url)!;
  assert.ok(target.hosts.some(isRelayHost), "the link names the relay");
  assert.ok(target.hosts.some((host) => !isRelayHost(host)), "and the computer's own addresses");

  net.direct = false; // the phone is somewhere else
  const paired = await pair(fetcher, target, phone);
  assert.equal(paired.name, link.status().name);
  assert.equal(link.status().devices.length, 1);

  const { client, parts } = follow(paired, fetcher);
  await until(() => !!parts.bots, "the first state through the relay");
  assert.equal(client.route, "relay");
  assert.ok(Array.isArray(await client.call("models")));

  // A change on the computer reaches the phone through the waiting sync.
  const before = parts.bots.length;
  await client.call("addBot", { name: "Relay bot", role: "Tester", instructions: "x" });
  await until(() => parts.bots.length === before + 1, "the new bot");
  assert.ok(backend.state.bots.some((bot: any) => bot.name === "Relay bot"));

  // The relay passed plenty, and none of it readable.
  assert.ok(relay.passed.length > 6);
  const seen = Buffer.concat(relay.passed.map((bytes) => Buffer.from(bytes))).toString("latin1");
  for (const secret of ["Relay bot", "Tester", "Mira", "models", "link.sync"]) assert.ok(!seen.includes(secret), secret + " crossed the relay in the clear");
  assert.equal(relay.phonesIn(room).length, 1, "one socket carries every call");

  client.stop();
  await link.stop();
});

test("a phone on the same network uses the direct path, moves to the relay when it leaves, and comes back", async () => {
  const { link, net, fetcher } = await setup();
  const paired = await pair(fetcher, parsePairingUrl(link.startPairing().url)!, phone);
  const { client, parts, routes } = follow(paired, fetcher, 100);
  await until(() => !!parts.bots, "the first state");
  assert.equal(client.route, "direct", "at home the relay is not used");

  // Leaving: the direct path stops working, and the phone carries on through the relay.
  net.direct = false;
  client.wake();
  await until(() => client.route === "relay", "the move to the relay", 20_000);
  assert.ok(Array.isArray(await client.call("models")));

  // Coming home: the probe finds the direct address and the phone goes back to it.
  net.direct = true;
  await until(() => client.route === "direct", "the move back to the direct path", 20_000);
  assert.ok(Array.isArray(await client.call("models")));
  assert.ok(routes.includes("relay") && routes.at(-1) === "direct");

  client.stop();
  await link.stop();
});

test("when the computer drops off the relay the phone is told at once, and carries on when it is back", async () => {
  const { relay, link, net, fetcher, room } = await setup();
  const target = parsePairingUrl(link.startPairing().url)!;
  net.direct = false;
  const paired = await pair(fetcher, target, phone);
  const { client, parts } = follow(paired, fetcher);
  await until(() => !!parts.bots, "the first state");

  // A call is waiting on the computer when its socket to the relay is cut.
  const started = Date.now();
  const waiting = client.call("link.sync", { have: {}, epoch: "none-such", wait: 20_000 }).catch((error: Error) => error);
  await tick(50);
  relay.dropHost(room);
  // It is settled in well under its 20 seconds: either told "the computer left" or already retried.
  await waiting;
  assert.ok(Date.now() - started < 8000, "the phone did not wait out the call");

  // The computer's link reconnects by itself, and the phone works again without pairing anew.
  await until(() => link.status().relay.connected, "the computer back on the relay", 10_000);
  await until(async () => true, "settle");
  let answer: unknown;
  await until(() => {
    void client.call("models").then((value) => (answer = value)).catch(() => {});
    return Array.isArray(answer);
  }, "a call after the computer came back", 15_000);
  assert.equal(link.status().devices.length, 1);

  client.stop();
  await link.stop();
});

test("turning the relay off on the computer cuts a phone that is away, and its own addresses still work", async () => {
  const { relay, link, net, fetcher, room } = await setup();
  const paired = await pair(fetcher, parsePairingUrl(link.startPairing().url)!, phone);
  link.setRelay({ enabled: false });
  await until(() => !relay.hostOf(room), "the computer's socket to close");
  assert.ok(!link.hosts().some(isRelayHost));

  // At home nothing changes.
  const home = new LinkClient(paired, { fetch: fetcher, onParts() {}, onState() {} });
  assert.ok(Array.isArray(await home.call("models")));
  home.stop();

  // Away, the relay has no computer to pass to: the phone is told it can't be reached.
  net.direct = false;
  const away = new LinkClient(paired, { fetch: fetcher, onParts() {}, onState() {} });
  await assert.rejects(away.call("models"), /can't be reached|didn't answer/);
  away.stop();
  await link.stop();
});

test("one relay follow streams ordered appends, recovers a missing frame, rejects replay and rests", async (t) => {
  const { link, net, relay, fetcher, room, backend } = await setup();
  t.after(() => link.stop());
  net.direct = false;
  const paired = await pair(fetcher, parsePairingUrl(link.startPairing().url)!, phone);
  const chat = backend.state.chats[0].id;
  const thought = { id: "thought", started: 1, text: "" };
  backend.state.runs.unshift({ id: "streaming", chatId: chat, status: "Working", steps: [], reasoning: [thought] });
  backend.changed();
  let thinking = "";
  const texts: string[] = [];
  const client = new LinkClient(paired, { fetch: fetcher, streamAppends: true, onState() {}, onParts(parts) {
    const text = parts["text:" + chat] as { stream: string } | undefined;
    if (text) texts.push(text.stream);
    const reasoning = parts["reasoning:" + chat] as { items: { text: string }[] } | undefined;
    if (reasoning) thinking = reasoning.items[0]?.text ?? "";
  } });
  client.watch([chat]);
  client.start();
  t.after(() => client.stop());
  const frames = () => relay.passed.filter(frame => frame[8] === 7);
  await until(() => [...link.sessions.values()].some(session => session.follow), "first follow");
  const requests = relay.requests;
  const change = (words: string) => {
    thought.text = "Thinking " + words;
    backend.state.streams[chat] = words;
    backend.changed();
  };
  let words = "";
  const expected: string[] = [];
  for (let i = 0; i < 10; i++) {
    words += " 🌱" + i;
    expected.push(words);
    change(words);
    await until(() => texts.at(-1) === words, "next reply suffix");
  }
  const socket = relay.hostOf(room)!;
  socket.bufferedAmount = 1024 * 1024;
  change(words + " held");
  await tick(150);
  assert.deepEqual(texts, expected, "no intermediate frame during backpressure");
  words += " held and coalesced";
  expected.push(words);
  change(words);
  socket.bufferedAmount = 0;
  await until(() => texts.at(-1) === words, "coalesced text after drain");
  assert.deepEqual(texts, expected);
  assert.equal(thinking, "Thinking " + words);
  assert.equal(relay.requests, requests);
  assert.equal(new Set(frames().map(f => Buffer.from(f).readUInt32BE(9))).size, 1, "one phone request ID");
  const before = frames().length;
  relay.dropPart = () => true;
  change(words + " missing");
  await until(() => frames().length > before, "dropped frame");
  relay.dropPart = undefined;
  words += " missing and restored";
  change(words);
  await until(() => texts.at(-1) === words, "recovered reply");
  assert.equal(relay.requests, requests + 1, "one replacement follow");
  assert.equal(thinking, "Thinking " + words);
  assert.deepEqual(texts, [...expected, words]);
  const last = frames().at(-1)!;
  relay.phonesIn(room)[0].deliver(last.subarray(8));
  await until(() => relay.requests === requests + 2, "replay rejected");
  assert.deepEqual(texts, [...expected, words]);
  client.rest();
  await until(() => link.waiters.size === 0, "host to release follow");
  const final = frames().length;
  change("while resting");
  await until(() => !relay.phonesIn(room).length, "idle socket to close");
  assert.equal(frames().length, final);
});

test("a computer without sync-push-v1 paces all relay poll news at 250 ms", async (t) => {
  const { link, net, relay, fetcher, backend } = await setup();
  t.after(() => link.stop());
  const meta = link.meta.bind(link);
  link.meta = () => {
    const result = meta();
    result.capabilities = result.capabilities.filter((name: string) => name !== "sync-push-v1");
    return result;
  };
  net.direct = false;
  const paired = await pair(fetcher, parsePairingUrl(link.startPairing().url)!, phone);
  const { client, parts } = follow(paired, fetcher);
  t.after(() => client.stop());
  await until(() => !!parts.meta, "initial state");
  const [session] = link.sessions.values();
  for (let i = 0; i < 3; i++) {
    const previous = session.lastNews;
    backend.state.chats[0].title = "Changed " + i;
    backend.changed();
    await until(() => parts.chats.some((chat: { title: string }) => chat.title === "Changed " + i), "polled title");
    assert.ok(session.lastNews - previous >= 250);
  }
  assert.equal(relay.passed.some(frame => frame[8] === 7), false);
});

test("quiet follows heartbeat at 25 seconds and renew at four minutes", async (t) => {
  const { link, net, relay, fetcher } = await setup();
  t.after(() => link.stop());
  net.direct = false;
  const paired = await pair(fetcher, parsePairingUrl(link.startPairing().url)!, phone);
  const client = new LinkClient(paired, { fetch: fetcher, onState() {}, onParts() {} });
  await client.call("models");
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  // The computer's own work (its files, its crypto) runs on the real event loop. On a busy machine it
  // needs more turns than one tick gives it, so wait for it with the mocked clock standing still.
  const settle = async (done: () => boolean) => {
    const end = performance.now() + 5000;
    while (!done() && performance.now() < end) await advance(0);
  };
  client.start();
  const pushes = () => relay.passed.filter(frame => frame[8] === 7);
  try {
    const [session] = link.sessions.values();
    for (let i = 0; i < 100 && !session.follow; i++) await advance(1);
    assert.ok(session.follow);
    assert.equal(pushes().length, 0);
    const initial = relay.requests;
    const first = session.used;
    while (Date.now() < first + 24_999) await advance(Math.min(1000, first + 24_999 - Date.now()));
    assert.equal(pushes().length, 0);
    for (let i = 0; i < 4 && !pushes().length; i++) {
      await advance(1);
      await settle(() => pushes().length > 0);
    }
    assert.equal(pushes().length, 1);
    assert.equal(session.used, first + 25_000);
    const body = Buffer.from(pushes()[0]);
    const count = Number(body.readBigUInt64BE(13));
    const { pushNonce, open } = await import("../link-host/crypto.mjs");
    const news = JSON.parse(open(session.toPhone, pushNonce(count), body.subarray(21), "push:" + session.id + ":" + session.syncSeq + ":first").toString());
    assert.deepEqual(news, { epoch: link.epoch, v: null, parts: {} });
    while (Date.now() < first + 239_999) await advance(Math.min(1000, first + 239_999 - Date.now()));
    assert.equal(relay.requests, initial);
    for (let i = 0; i < 12 && relay.requests === initial; i++) {
      await advance(1);
      await settle(() => relay.requests > initial);
    }
    assert.equal(relay.requests, initial + 1);
    assert.equal(link.sessions.size, 1);
    assert.ok(session.follow);
  } finally {
    client.stop();
    for (let i = 0; i < 8; i++) await advance(1);
    t.mock.timers.reset();
  }
});

test("a silent follow times out at 40 seconds, then reports the blip and offline", async (t) => {
  const { link, net, fetcher } = await setup();
  t.after(() => link.stop());
  net.direct = false;
  const paired = await pair(fetcher, parsePairingUrl(link.startPairing().url)!, phone);
  let silent = false;
  let waiting = false;
  const transport: FetchLike = (url, init) => {
    if (init?.onPart && silent) {
      waiting = true;
      return new Promise(() => {});
    }
    if (waiting) return Promise.reject(new Error("path lost"));
    return fetcher(url, init);
  };
  const states: string[] = [];
  const client = new LinkClient(paired, { fetch: Object.assign(transport, { supportsPush: true }), onState: s => states.push(s), onParts() {} });
  client.start();
  try {
    await until(() => [...link.sessions.values()].some(session => session.follow), "first follow");
    client.rest();
    await until(() => link.waiters.size === 0, "rest before measuring");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    silent = true;
    client.wake();
    for (let i = 0; !waiting && i < 100; i++) {
      t.mock.timers.tick(1);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(waiting);
    t.mock.timers.tick(39_999);
    assert.equal(client.state, "online");
    t.mock.timers.tick(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(states.slice(-2), ["connecting", "offline"]);
  } finally {
    client.stop();
    t.mock.timers.reset();
  }
});

test("changing watches and text mode replaces a follow, and closing the phone socket releases it", async (t) => {
  const { link, net, relay, room, fetcher, backend } = await setup();
  t.after(() => link.stop());
  net.direct = false;
  const paired = await pair(fetcher, parsePairingUrl(link.startPairing().url)!, phone);
  let stream = true;
  const client = new LinkClient(paired, { fetch: fetcher, streamAppends: true, textStreaming: () => stream, onState() {}, onParts() {} });
  client.start();
  t.after(() => client.stop());
  await until(() => [...link.sessions.values()].some(s => s.follow), "first follow");
  const [session] = link.sessions.values();
  const first = session.follow;
  const id = backend.state.chats[0].id;
  client.watch([id]);
  await until(() => session.follow && session.follow !== first, "watch to replace the follow");
  assert.equal(link.waiters.has(first), false);
  assert.deepEqual(session.follow.watching, [id]);
  const second = session.follow;
  stream = false;
  client.textStreamingChanged();
  await until(() => session.follow && session.follow !== second, "whole text mode to replace the follow");
  assert.equal(session.noText, true);
  assert.equal(link.waiters.size, 1);
  relay.down = true;
  relay.dropPhones(room);
  await until(() => !session.follow, "phone departure to end the follow");
});

test("a fetch transport without push support polls even when the host offers follows", async (t) => {
  const { link, net, relay, fetcher } = await setup();
  t.after(() => link.stop());
  net.direct = false;
  const paired = await pair(fetcher, parsePairingUrl(link.startPairing().url)!, phone);
  const { client, parts } = follow(paired, (url, options) => fetcher(url, options));
  t.after(() => client.stop());
  await until(() => !!parts.meta && link.waiters.size === 1, "long poll");
  assert.ok(parts.meta.capabilities.includes("sync-push-v1"));
  const [session] = link.sessions.values();
  assert.equal(session.follow, undefined);
  assert.equal(relay.passed.some(frame => frame[8] === 7), false);
});
