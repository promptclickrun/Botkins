// Background relay lifecycle tests: fake AppState + fake relay socket + LinkServer host end.
// Covers:
//  - background -> grace period -> clean socket close (code 1000) & host logs no errors
//  - no reconnect/retry attempts while in the background
//  - foreground reopens exactly once (and notification tap wakes immediately without duplicating)
//  - active voice call, Watch voice session, or upload keeps the socket open until it finishes
//  - returning to foreground before grace expires cancels the close
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { LinkClient, pair, type Pairing } from "../src/link/client";
import { parsePairingUrl } from "../src/link/pairing";
import { isRelayHost, relayFetch, type RelaySocket, type RelaySocketClass } from "../src/link/relay";
import { createBackgroundController } from "../src/state/backgroundRelay";
import { FakeRelay } from "./fake-relay";

const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await tick(15);
  }
  throw new Error("Timed out waiting for " + what);
}

/** Fake AppState that notifies listeners on transition. */
class FakeAppState {
  currentState = "active";
  private listeners = new Set<(state: string) => void>();
  addEventListener(_event: "change", fn: (state: string) => void) {
    this.listeners.add(fn);
    return { remove: () => this.listeners.delete(fn) };
  }
  set(next: string) {
    this.currentState = next;
    for (const fn of [...this.listeners]) fn(next);
  }
}

/** Wraps FakeRelay's WebSocket to count phone socket opens and capture close codes. */
function instrumentedSocket(Base: RelaySocketClass) {
  const opens: string[] = [];
  const closes: { url: string; code: number | undefined }[] = [];
  class CountingSocket implements RelaySocket {
    private inner: RelaySocket;
    constructor(url: string, protocols?: string | string[]) {
      opens.push(url);
      this.inner = new Base(url, protocols);
    }
    get binaryType() { return this.inner.binaryType; }
    set binaryType(v: string) { this.inner.binaryType = v; }
    get readyState() { return this.inner.readyState; }
    send(data: string | Uint8Array) { this.inner.send(data); }
    close(code?: number, reason?: string) {
      closes.push({ url: "", code });
      this.inner.close(code, reason);
    }
    get onopen() { return this.inner.onopen; }
    set onopen(v) { this.inner.onopen = v; }
    get onmessage() { return this.inner.onmessage; }
    set onmessage(v) { this.inner.onmessage = v; }
    get onclose() { return this.inner.onclose; }
    set onclose(v) { this.inner.onclose = v; }
    get onerror() { return this.inner.onerror; }
    set onerror(v) { this.inner.onerror = v; }
  }
  return { WebSocket: CountingSocket as unknown as RelaySocketClass, opens, closes };
}

async function setupEnv(t: { after(fn: () => void): void }, { graceMs = 60 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-bg-relay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const relay = new FakeRelay();
  const hostLogs: string[] = [];
  const backend = new MockBackend({ speed: 0.05 });
  const server = new LinkHost({
    dir,
    backend,
    port: 0,
    extraHosts: ["127.0.0.1"],
    searchPath: [],
    log: (line: string) => hostLogs.push(line),
    relay: { url: "https://relay.test", WebSocket: relay.WebSocket },
  });
  await server.setEnabled(true);
  server.setRelay({ enabled: true });
  await until(() => server.status().relay.connected, "host connected to fake relay");

  const phoneSocket = instrumentedSocket(relay.WebSocket as unknown as RelaySocketClass);
  const fetcher = relayFetch(
    async () => { throw new Error("direct unreachable"); },
    { WebSocket: phoneSocket.WebSocket, idleMs: 60_000, pingMs: 60_000 },
  );

  // Pair over the relay only (no direct addresses).
  const code = parsePairingUrl(server.startPairing().url)!;
  const relayEntry = server.hosts().find(isRelayHost)!;
  const room = relayEntry.slice("relay!".length).split("@")[0]!;
  const paired: Pairing = await pair(fetcher, { ...code, hosts: [relayEntry] }, { name: "iPhone", platform: "ios" });
  const relayOnlyPairing: Pairing = { ...paired, hosts: [relayEntry] };

  const appState = new FakeAppState();
  let syncs = 0;
  const client = new LinkClient(relayOnlyPairing, {
    fetch: fetcher,
    streamAppends: true,
    onParts() {},
    onState() {},
    onSync: () => { syncs++; },
    check: () => fetcher.check(),
    probeMs: 60_000,
  });
  t.after(() => {
    client.stop();
    fetcher.rest({ force: true });
    server.stop();
  });

  const controller = createBackgroundController({
    graceMs,
    initialState: appState.currentState,
    onSleep: () => {
      client.rest();
      fetcher.rest({ force: true });
    },
    onWake: () => {
      client.wake();
    },
  });
  t.after(() => controller.dispose());
  appState.addEventListener("change", (next) => controller.setAppState(next));

  client.start();
  await until(() => syncs >= 1 && relay.phonesIn(room).length === 1, "phone synced over relay");

  return { relay, room, server, hostLogs, phoneSocket, fetcher, client, appState, controller, syncs: () => syncs };
}

test("background -> grace period -> clean relay close, host logs no errors, no retries while backgrounded, foreground reopens once", async (t) => {
  const env = await setupEnv(t, { graceMs: 60 });
  const opensBeforeBg = env.phoneSocket.opens.length;
  const logsBeforeBg = env.hostLogs.length;

  // Move to background: socket stays open during grace period.
  env.appState.set("background");
  assert.equal(env.controller.sleeping, false);
  assert.equal(env.relay.phonesIn(env.room).length, 1, "socket still open during grace period");

  // After grace expires: socket closes cleanly (code 1000) and host releases follow without error logs.
  await until(() => env.relay.phonesIn(env.room).length === 0, "relay socket closes after grace");
  assert.equal(env.controller.sleeping, true);
  assert.equal(env.phoneSocket.closes.at(-1)?.code, 1000, "clean WebSocket close code 1000");
  await until(() => env.server.waiters.size === 0, "host releases follow waiter");
  assert.deepEqual(env.hostLogs.slice(logsBeforeBg), [], "host emits no error or warning logs on phone close");

  // Stay in the background for a while: no reconnect attempts occur.
  const opensAfterClose = env.phoneSocket.opens.length;
  await tick(150);
  assert.equal(env.phoneSocket.opens.length, opensAfterClose, "no reconnect attempts while in background");
  assert.equal(env.relay.phonesIn(env.room).length, 0, "still zero phone sockets in relay room");

  // Return to foreground: reopens exactly once.
  const syncsBeforeFg = env.syncs();
  env.appState.set("active");
  await until(() => env.syncs() > syncsBeforeFg && env.relay.phonesIn(env.room).length === 1, "reopened on foreground");
  assert.equal(env.controller.sleeping, false);
  assert.equal(env.phoneSocket.opens.length, opensBeforeBg + 1, "reopened exactly once on foreground");
  await tick(80);
  assert.equal(env.phoneSocket.opens.length, opensBeforeBg + 1, "no duplicate socket opens after foreground");
});

test("notification tap wakes immediately and subsequent foreground active does not reopen a second socket", async (t) => {
  const env = await setupEnv(t, { graceMs: 40 });
  env.appState.set("background");
  await until(() => env.relay.phonesIn(env.room).length === 0, "closed in background");
  const opensWhileSleeping = env.phoneSocket.opens.length;

  // Notification tap triggers wake() before AppState transitions to active.
  env.controller.wake();
  await until(() => env.relay.phonesIn(env.room).length === 1, "woken by notification tap");
  assert.equal(env.phoneSocket.opens.length, opensWhileSleeping + 1);

  // AppState then flips to active: reuses the socket without opening a second one.
  env.appState.set("active");
  await tick(80);
  assert.equal(env.phoneSocket.opens.length, opensWhileSleeping + 1, "still only one socket open");
});

test("returning to foreground before grace period expires cancels the close", async (t) => {
  const env = await setupEnv(t, { graceMs: 120 });
  const opensBefore = env.phoneSocket.opens.length;

  env.appState.set("background");
  await tick(30);
  assert.equal(env.relay.phonesIn(env.room).length, 1);

  env.appState.set("active");
  await tick(150);
  assert.equal(env.controller.sleeping, false);
  assert.equal(env.relay.phonesIn(env.room).length, 1, "socket stayed open across brief switch");
  assert.equal(env.phoneSocket.opens.length, opensBefore, "no extra socket opened");
});

test("active voice call or upload keeps the relay socket open in background and closes once finished", async (t) => {
  const env = await setupEnv(t, { graceMs: 40 });

  // Active upload holds the socket open while backgrounded.
  const releaseUpload = env.controller.hold("upload");
  env.appState.set("background");
  await tick(100);
  assert.equal(env.controller.sleeping, false, "not sleeping while upload is in progress");
  assert.equal(env.relay.phonesIn(env.room).length, 1, "socket stays open during upload");

  // A voice call starts before upload finishes; releasing upload alone still keeps it open.
  const releaseVoice = env.controller.hold("voice");
  releaseUpload();
  await tick(100);
  assert.equal(env.controller.sleeping, false, "still held by voice call");
  assert.equal(env.relay.phonesIn(env.room).length, 1, "socket stays open during voice call");

  // Ending the voice call while still backgrounded schedules grace and closes cleanly.
  releaseVoice();
  await until(() => env.relay.phonesIn(env.room).length === 0, "socket closes once all background holds release");
  assert.equal(env.controller.sleeping, true);
  assert.equal(env.phoneSocket.closes.at(-1)?.code, 1000);
});

test("unit: fake timer grace period, hold counts, and idempotent release", () => {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  let sleeps = 0;
  let wakes = 0;
  let backgrounds = 0;

  const ctrl = createBackgroundController({
    graceMs: 3000,
    onBackground: () => { backgrounds++; },
    onSleep: () => { sleeps++; },
    onWake: () => { wakes++; },
    setTimeout: ((fn: () => void) => {
      const id = nextId++;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
      timers.delete(id as unknown as number);
    }) as typeof clearTimeout,
  });

  // Go to background: onBackground fires immediately, onSleep waits for grace timer.
  ctrl.setAppState("background");
  assert.equal(backgrounds, 1);
  assert.equal(sleeps, 0);
  assert.equal(timers.size, 1);

  // Grace fires -> sleeps once.
  const [firstId, firstFn] = [...timers.entries()][0]!;
  timers.delete(firstId);
  firstFn();
  assert.equal(sleeps, 1);
  assert.equal(ctrl.sleeping, true);

  // Foreground wakes once; second active transition is a no-op.
  ctrl.setAppState("active");
  ctrl.setAppState("active");
  assert.equal(wakes, 1);
  assert.equal(ctrl.sleeping, false);

  // Hold acquired during background cancels grace; releasing twice is safe.
  const release = ctrl.hold("watch");
  assert.deepEqual(ctrl.holds(), { upload: 0, voice: 0, watch: 1, push: 0 });
  ctrl.setAppState("background");
  assert.equal(timers.size, 0, "no grace timer scheduled while held");
  release();
  release();
  assert.equal(ctrl.held, false);
  assert.equal(timers.size, 1, "grace timer scheduled after hold released in background");
  const [secondId, secondFn] = [...timers.entries()][0]!;
  timers.delete(secondId);
  secondFn();
  assert.equal(sleeps, 2);
});

test("watch hold acquired after background sleep wakes relay immediately and re-sleeps on release", async (t) => {
  const env = await setupEnv(t, { graceMs: 60 });
  const logsBeforeBg = env.hostLogs.length;

  // Background the phone and let the grace period put the link and relay socket to sleep.
  env.appState.set("background");
  await until(() => env.controller.sleeping && env.relay.phonesIn(env.room).length === 0, "relay socket asleep in background");
  const syncsBeforeWatch = env.syncs();

  // Watch voice starts while the iPhone is still backgrounded and asleep:
  // the "watch" hold must wake the link immediately and reopen the relay socket.
  const releaseWatch = env.controller.hold("watch");
  assert.equal(env.controller.sleeping, false, "watch hold wakes a sleeping background controller");
  assert.equal(env.controller.held, true);
  await until(() => env.relay.phonesIn(env.room).length === 1 && env.syncs() > syncsBeforeWatch, "relay socket reopened and synced for watch hold");

  // RPCs succeed over the woken relay.
  const syncRes = await env.client.call("link.sync", { have: {} });
  assert.ok(syncRes && typeof syncRes === "object", "link.sync succeeds during watch hold");

  // When Watch voice ends while the iPhone is still backgrounded, release cleanly re-sleeps.
  releaseWatch();
  assert.equal(env.controller.held, false);
  await until(() => env.controller.sleeping && env.relay.phonesIn(env.room).length === 0, "relay socket closes cleanly after watch hold releases");
  assert.deepEqual(env.hostLogs.slice(logsBeforeBg), [], "no host errors during watch wake/sleep cycle");
});

test("background RPC recovers when a cached direct session dies during sleep and fails over to relay", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-bg-failover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const relay = new FakeRelay();
  const server = new LinkHost({
    dir,
    backend: new MockBackend({ speed: 0.05 }),
    port: 0,
    extraHosts: ["127.0.0.1"],
    searchPath: [],
    relay: { url: "https://relay.test", WebSocket: relay.WebSocket },
  });
  await server.setEnabled(true);
  server.setRelay({ enabled: true });
  await until(() => server.status().relay.connected, "host connected to fake relay");

  let directUp = true;
  const baseFetch: typeof globalThis.fetch = (input, init) => {
    if (!directUp) return Promise.reject(new TypeError("network unreachable"));
    return globalThis.fetch(input, init);
  };
  const fetcher = relayFetch(baseFetch, {
    WebSocket: relay.WebSocket as unknown as RelaySocketClass,
    idleMs: 60_000,
    pingMs: 60_000,
  });

  const code = parsePairingUrl(server.startPairing().url)!;
  const directEntry = "127.0.0.1:" + server.port;
  const relayEntry = server.hosts().find(isRelayHost)!;
  const room = relayEntry.slice("relay!".length).split("@")[0]!;
  const paired: Pairing = await pair(fetcher, { ...code, hosts: [directEntry, relayEntry] }, { name: "iPhone", platform: "ios" });
  const dualPairing: Pairing = { ...paired, hosts: [directEntry, relayEntry] };

  const client = new LinkClient(dualPairing, {
    fetch: fetcher,
    onParts() {},
    onState() {},
  });
  t.after(() => {
    client.stop();
    fetcher.rest({ force: true });
    server.stop();
  });

  await client.call("link.sync", { have: {} });
  assert.equal(client.route, "direct");

  // App enters background and sleeps, then leaves the LAN.
  client.start({ resting: true });
  directUp = false;

  // A read can drop the dead direct session and fail over to relay after an ambiguous failure.
  const syncRes = await client.call("link.sync", { have: {} });
  assert.ok(syncRes && typeof syncRes === "object", "RPC failed over to relay after dead direct session");
  assert.equal(client.route, "relay");
  await until(() => relay.phonesIn(room).length === 1, "relay socket opened for failover");
});
