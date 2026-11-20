// End-to-end continuity and transport-fault check. Uses real WebSocket sockets and the current
// phone client (load this file with this checkout's mobile tsx loader).
//
// Local: node --import "../mobile/node_modules/tsx/dist/loader.mjs" test/relay-fault-live.mjs --local
// Live:  BOTKINS_RELAY_URL=https://relay.botkins.app node --import "../mobile/node_modules/tsx/dist/loader.mjs" test/relay-fault-live.mjs
//
// The host owns the only socket this script terminates. It uses a temp pairing store and bounded
// defaults: 240 ordinary requests, six 2.4 MB answers and six injected host-socket resets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LinkHost } from "../desktop/link/index.mjs";

const require = createRequire(new URL("../../mobile/relay/package.json", import.meta.url));
const WebSocket = require("ws");
const phoneRoot = fileURLToPath(new URL("../../mobile/", import.meta.url));
const relayUrlArg = process.env.BOTKINS_RELAY_URL;
const local = process.argv.includes("--local") || process.env.BOTKINS_FAULT_MODE === "local" || !relayUrlArg;
const requestCount = boundedInt("BOTKINS_FAULT_REQUESTS", 240, 100, 1000);
const resetCount = boundedInt("BOTKINS_FAULT_RESETS", 5, 1, 12);
const silentSeatMaxMs = boundedInt("BOTKINS_FAULT_SILENT_MAX_MS", 15_000, 1_000, 15_000);
const burstCount = 6;
const burstBytes = 2_400_000;
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, check, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await tick(40);
  }
};
function boundedInt(name, fallback, low, high) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < low || value > high) throw new Error(`${name} must be an integer from ${low} to ${high}`);
  return value;
}

/** Start the real Wrangler/workerd relay for a local run. Pass BOTKINS_RELAY_URL to use a dev URL. */
async function openLocalRelay() {
  const port = Number(process.env.BOTKINS_LOCAL_RELAY_PORT ?? 8790);
  const cwd = join(phoneRoot, "relay");
  const bin = join(cwd, "node_modules/.bin/wrangler");
  const child = spawn(bin, ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port)], { cwd, env: { ...process.env, RATE_LIMITS: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  child.stdout.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
  child.stderr.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
  await until("the local Wrangler relay", async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok; } catch { return false; }
  }, 45_000).catch((error) => { child.kill("SIGTERM"); throw new Error(error.message + "\n" + lines.slice(-20).join("\n")); });
  return { url: `http://127.0.0.1:${port}`, close: async () => { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); } };
}

async function main() {
  const [{ LinkClient, pair }, { relayFetch }, { parsePairingUrl }] = await Promise.all([
    import(pathToFileURL(join(phoneRoot, "src/link/client.ts")).href),
    import(pathToFileURL(join(phoneRoot, "src/link/relay.ts")).href),
    import(pathToFileURL(join(phoneRoot, "src/link/pairing.ts")).href),
  ]);
  const localRelay = local ? await openLocalRelay() : null;
  const relayUrl = localRelay?.url ?? relayUrlArg;
  const dir = mkdtempSync(join(tmpdir(), "botkins-relay-fault-"));
  const calls = [], states = [], routes = [], injectedSockets = new WeakSet(), silentSockets = new Set();
  let spontaneousCloses = 0, handshakeCloses = 0, hostSocketOpens = 0, hostSocketCloses = 0, shuttingDown = false;
  let failures = 0;
  let holdHandshakes = false;
  const heldHandshakes = [];
  let hostSocketSequence = 0;
  const hostSocketRecords = new WeakMap();
  let killOnTrigger = null, triggerReceived = null;
  class HostSocket extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { autoPong: false, finishRequest(request) {
        if (holdHandshakes) heldHandshakes.push(request);
        else request.end();
      } });
      hostSocketOpens++;
      const record = {
        id: ++hostSocketSequence,
        opened: false,
        injected: false,
        code: null,
        group: Array.isArray(protocols) ? protocols.find((part) => String(part).startsWith("g."))?.slice(2) ?? null : null,
        silent: false,
        suppressedInbound: 0,
        suppressedOutbound: 0,
        suppressedCloses: 0,
        closeAttemptTransportOpen: false,
      };
      hostSocketRecords.set(this, record);
      this.addEventListener("open", () => { record.opened = true; });
      this.addEventListener("close", (event) => {
        hostSocketCloses++;
        record.code = Number(event?.code) || 1006;
        if (!shuttingDown && !injectedSockets.has(this)) {
          if (record.opened) spontaneousCloses++;
          else handshakeCloses++;
        }
      });
    }

    set onmessage(handler) {
      this._relayOnMessage = handler;
      super.onmessage = typeof handler === "function" ? (event) => {
        const record = hostSocketRecords.get(this);
        if (record?.silent) {
          record.suppressedInbound++;
          return;
        }
        handler(event);
      } : null;
    }

    get onmessage() {
      return this._relayOnMessage ?? null;
    }

    send(data, ...args) {
      const record = hostSocketRecords.get(this);
      if (record?.silent) {
        record.suppressedOutbound++;
        return;
      }
      return super.send(data, ...args);
    }

    close(...args) {
      const record = hostSocketRecords.get(this);
      if (record?.silent) {
        record.suppressedCloses++;
        record.closeAttemptTransportOpen = this.readyState === WebSocket.OPEN && !!this._socket && !this._socket.destroyed;
        return;
      }
      return super.close(...args);
    }
  }
  class PhoneSocket extends WebSocket {
    static latest = null;
    constructor(...args) { super(...args); PhoneSocket.latest = this; }
  }
  const backend = {
    info: () => ({ app: "botkins", version: "0.16.2-fault-test", platform: process.platform }),
    snapshot: () => ({ bots: [{ id: "pip", name: "Pip" }], chats: [], runs: [], settings: {}, live: {}, revs: {} }),
    call: async (method, args) => {
      assert.equal(method, "usage", "the verifier uses a legitimate desktop call");
      const request = args[0] ?? {}, marker = String(request.marker ?? ""), bytes = Number(request.bytes) || 0;
      calls.push({ marker, at: Date.now() });
      if (marker === "trigger-reset") {
        triggerReceived?.();
        // Keep the provider turn open while the host transport is terminated. This is the point at
        // which a real provider could be between its response chunks.
        await tick(100);
        killOnTrigger?.();
        await tick(250);
      }
      return { marker, payload: "b".repeat(bytes) };
    },
    subscribe: () => () => {},
  };
  const link = new LinkHost({ dir, port: 0, extraHosts: ["127.0.0.1"], searchPath: [], relay: { url: relayUrl, WebSocket: HostSocket }, backend });
  let phone;
  const phoneCall = (...args) => phone.call(...args).catch((error) => {
    failures++;
    throw error;
  });
  const silenceHostTransport = (socket) => {
    assert.ok(socket, "the host owns a relay socket to silence");
    const record = hostSocketRecords.get(socket);
    assert.ok(record?.opened, "the host relay socket is open before silence");
    record.silent = true;
    silentSockets.add(socket);
    return record;
  };
  try {
    await link.setEnabled(true);
    link.setRelay({ enabled: true, url: relayUrl });
    await until("the host relay socket", () => link.status().relay.connected);
    const target = parsePairingUrl(link.startPairing().url);
    assert.ok(target, "the host produced a pairing URL");
    const directFetch = () => Promise.reject(new TypeError("the verifier is relay-only"));
    const fetcher = relayFetch(directFetch, { WebSocket: PhoneSocket, idleMs: 60_000, connectMs: 8_000 });
    const paired = await pair(fetcher, target, { name: "Fault test phone", platform: "ios" });
    const pinnedPhoneSocket = PhoneSocket.latest;
    const parts = {};
    phone = new LinkClient(paired, { fetch: fetcher, onParts: (next) => Object.assign(parts, next), onState: (state) => states.push({ state, at: Date.now() }), onRoute: (route) => routes.push({ route, at: Date.now() }), onUnreachable: () => states.push({ state: "unreachable", at: Date.now() }) });
    phone.start();
    await until("the initial phone state", () => phone.state === "online" && !!parts.bots);
    assert.equal(phone.route, "relay", "the paired phone uses the relay path");
    console.log(JSON.stringify({ phase: "paired", route: phone.route, hostSocketOpens }));

    const sessionIds = () => [...link.sessions.values()].filter(s => s.deviceId === paired.deviceId).map(s => s.id);
    const originalSessions = sessionIds();
    assert.equal(originalSessions.length, 1);
    await until("two authenticated host sockets", () => link.relayLink.socket?.protocol === "botkins.host.v3" && link.relayLink.standby?.protocol === "botkins.host.v3");

    const burstStarted = Date.now();
    const burst = await Promise.all(Array.from({ length: burstCount }, (_, index) => phoneCall("usage", { marker: `burst-${index}`, bytes: burstBytes })));
    const burstMs = Date.now() - burstStarted;
    assert.ok(burst.every((reply, index) => reply.marker === `burst-${index}` && reply.payload.length === burstBytes));
    assert.ok(burstMs < 10_000, `the six-response burst took ${burstMs}ms`);
    console.log(JSON.stringify({ phase: "response-burst", count: burstCount, bytes: burstBytes, elapsedMs: burstMs }));

    let warmStandbyWaitMs = 0;
    const killHostTransport = (socket = link.relayLink?.socket) => {
      assert.ok(socket, "the host owns a relay socket to terminate");
      injectedSockets.add(socket);
      const record = hostSocketRecords.get(socket);
      if (record) record.injected = true;
      if (typeof socket.terminate === "function") socket.terminate(); else socket._socket?.destroy();
      return socket;
    };
    killOnTrigger = killHostTransport;

    let activeResetCount = 0, bothDownSockets = 0;

    // Kill the active host socket after it has accepted a provider-sized turn but before the reply.
    // The next request is deliberately sent while the warm standby is taking over. This verifies
    // both the in-flight response and a new request across one pinned phone session.
    if (process.env.BOTKINS_FAULT_MID_REQUEST !== "0") {
      let releaseTrigger;
      const triggerSeen = new Promise((resolve) => { releaseTrigger = resolve; });
      triggerReceived = releaseTrigger;
      const activeSocket = link.relayLink?.socket;
      assert.ok(activeSocket, "the active host socket received the trigger");
      const pinnedSession = [...link.sessions.values()].find((session) => session.deviceId === paired.deviceId)?.id;
      const standbyAtReset = link.relayLink.standby;
      holdHandshakes = true;
      const closesBefore = hostSocketCloses;
      killOnTrigger = () => killHostTransport(activeSocket);
      const first = phoneCall("usage", { marker: "trigger-reset", bytes: 0 });
      await triggerSeen;
      const resetAt = Date.now();
      await until("the active host socket to close", () => hostSocketCloses > closesBefore, 5_000);
      assert.equal(PhoneSocket.latest, pinnedPhoneSocket, "the phone keeps its relay socket during takeover");
      const requestAt = Date.now();
      let replyMs;
      const during = phoneCall("usage", { marker: "during-reset", bytes: 0 }).then(answer => {
        replyMs = Date.now() - requestAt;
        return answer;
      });
      const outcomes = await Promise.allSettled([first, during]);
      await until("the warm standby socket", () => link.status().relay.connected && phone.state === "online", 30_000);
      warmStandbyWaitMs = Date.now() - resetAt;
      assert.equal([...link.sessions.values()].find((session) => session.deviceId === paired.deviceId)?.id, pinnedSession, "the phone keeps its session during takeover");
      assert.ok(outcomes.every((result) => result.status === "fulfilled"), `requests crossing the reset failed: ${outcomes.map(outcome => outcome.status).join(", ")}`);
      assert.deepEqual(outcomes.map((result) => result.status === "fulfilled" && result.value.marker), ["trigger-reset", "during-reset"]);
      assert.equal(link.relayLink.socket, standbyAtReset, "the original standby served the replies while new handshakes were blocked");
      holdHandshakes = false;
      for (const request of heldHandshakes.splice(0)) request.end();
      console.log(JSON.stringify({ phase: "warm-standby", replyMs, phoneState: phone.state, phoneRoute: phone.route }));
      triggerReceived = null;
      killOnTrigger = null;
      activeResetCount++;
    }

    // Exercise the durable recovery window: take both host seats before sending a new request.
    // The phone socket and session stay pinned while the relay holds the opaque request for the
    // replacement host; no reconnect wait is inserted before making the call.
    await until("a warm active and standby host pair", () => !!link.relayLink?.socket && !!link.relayLink?.standby, 30_000);
    const bothDownActive = link.relayLink?.socket;
    const bothDownStandby = link.relayLink?.standby;
    assert.ok(bothDownActive && bothDownStandby && bothDownActive !== bothDownStandby, "both host seats are distinct");
    const bothDownClosesBefore = hostSocketCloses;
    killHostTransport(bothDownActive);
    killHostTransport(bothDownStandby);
    bothDownSockets = 2;
    await until("both host sockets to close", () => hostSocketCloses >= bothDownClosesBefore + 2, 5_000);
    await tick(20);
    assert.equal(PhoneSocket.latest, pinnedPhoneSocket, "the phone keeps its relay socket while both host seats are down");
    console.log(JSON.stringify({ phase: "both-down", hostSocketCloses, phoneState: phone.state, phoneRoute: phone.route }));
    const pinnedSession = [...link.sessions.values()].find((session) => session.deviceId === paired.deviceId)?.id;
    const bothDownStarted = Date.now();
    const bothDownReply = await phoneCall("usage", { marker: "both-down", bytes: 0 });
    warmStandbyWaitMs = Math.max(warmStandbyWaitMs, Date.now() - bothDownStarted);
    assert.equal(bothDownReply.marker, "both-down");
    assert.equal([...link.sessions.values()].find((session) => session.deviceId === paired.deviceId)?.id, pinnedSession, "the phone keeps its session across the two-seat gap");
    console.log(JSON.stringify({ phase: "both-down-recovered", elapsedMs: Date.now() - bothDownStarted, phoneState: phone.state, phoneRoute: phone.route }));

    // Leave both live host transports open while suppressing every application frame in both
    // directions, including the desktop's heartbeat pings. The desktop must time out both wrappers
    // itself, then seat fresh sockets in the same v3 group while the relay replays these requests.
    await until("a warm active and standby host pair before silent loss", () => !!link.relayLink?.socket && !!link.relayLink?.standby, 30_000);
    const silentActive = link.relayLink?.socket;
    const silentStandby = link.relayLink?.standby;
    assert.ok(silentActive && silentStandby && silentActive !== silentStandby, "silent loss starts with two distinct host seats");
    const silentGroup = link.relayLink.group;
    const silentActiveRecord = silenceHostTransport(silentActive);
    const silentStandbyRecord = silenceHostTransport(silentStandby);
    const silentStarted = Date.now();
    const silentMarkers = ["silent-double-loss-0001", "silent-double-loss-0002"];
    let silentFirstAnswerMs = null;
    const silentCompletions = [];
    const silentCalls = silentMarkers.map((marker) => phoneCall("usage", { marker, bytes: 0 }).then((answer) => {
      const elapsed = Date.now() - silentStarted;
      silentFirstAnswerMs ??= elapsed;
      silentCompletions.push({ marker, elapsed });
      return answer;
    }));
    const silentOutcomesPromise = Promise.allSettled(silentCalls);
    await until("fresh active and standby seats after silent loss", () => {
      const active = link.relayLink?.socket;
      const standby = link.relayLink?.standby;
      return !!active && !!standby && active !== silentActive && active !== silentStandby && standby !== silentActive && standby !== silentStandby;
    }, silentSeatMaxMs);
    const silentSeatMs = Date.now() - silentStarted;
    const freshActive = link.relayLink?.socket;
    const freshStandby = link.relayLink?.standby;
    const freshActiveRecord = hostSocketRecords.get(freshActive);
    const freshStandbyRecord = hostSocketRecords.get(freshStandby);
    assert.ok(freshActive && freshStandby && freshActive !== freshStandby, "silent loss reseated two host sockets");
    assert.notEqual(freshActive, silentActive, "silent loss has a fresh active socket");
    assert.notEqual(freshStandby, silentStandby, "silent loss has a fresh standby socket");
    assert.equal(freshActive.protocol, "botkins.host.v3", "silent loss reseated an authenticated v3 active");
    assert.equal(freshStandby.protocol, "botkins.host.v3", "silent loss reseated an authenticated v3 standby");
    assert.equal(freshActiveRecord?.group, silentGroup, "fresh active stays in the original runtime group");
    assert.equal(freshStandbyRecord?.group, silentGroup, "fresh standby stays in the original runtime group");
    assert.ok(silentActiveRecord.suppressedOutbound > 0 && silentStandbyRecord.suppressedOutbound > 0, "both silent transports suppressed heartbeat output");
    // Only the room knows which of the two authenticated transports it last promoted.
    assert.ok(silentActiveRecord.suppressedInbound + silentStandbyRecord.suppressedInbound > 0, "the relay sent traffic into the silent host pair");
    assert.ok(silentActiveRecord.suppressedCloses > 0 && silentStandbyRecord.suppressedCloses > 0, "desktop timed out both silent transports");
    assert.equal(silentActiveRecord.closeAttemptTransportOpen, true, "active timeout did not close the underlying TCP socket");
    assert.equal(silentStandbyRecord.closeAttemptTransportOpen, true, "standby timeout did not close the underlying TCP socket");
    assert.ok(silentSeatMs <= silentSeatMaxMs, `silent host seats took ${silentSeatMs}ms; expected <= ${silentSeatMaxMs}ms`);
    await until("the first successful phone answer after silent loss", () => silentFirstAnswerMs !== null, Math.max(1, silentSeatMaxMs - (Date.now() - silentStarted)));
    assert.ok(silentFirstAnswerMs <= silentSeatMaxMs, `the first silent answer took ${silentFirstAnswerMs}ms; expected <= ${silentSeatMaxMs}ms`);
    await until("all silent phone answers", () => silentCompletions.length === silentMarkers.length, Math.max(1, silentSeatMaxMs - (Date.now() - silentStarted)));
    const silentOutcomes = await silentOutcomesPromise;
    assert.equal(silentOutcomes.filter((result) => result.status === "rejected").length, 0, "silent double loss produced no failed calls");
    assert.deepEqual(silentCompletions.map(({ marker }) => marker), silentMarkers, "silent responses complete in request order");
    console.log(JSON.stringify({ phase: "silent-double-loss-recovered", seatSeconds: Number((silentSeatMs / 1000).toFixed(3)), firstAnswerSeconds: Number((silentFirstAnswerMs / 1000).toFixed(3)), activeReseated: true, standbyReseated: true, phoneState: phone.state, phoneRoute: phone.route }));

    const expected = [], interval = Math.max(1, Math.floor(requestCount / (resetCount + 1)));
    let pendingResetAt = null;
    let resets = 0;
    for (let i = 0; i < requestCount; i++) {
      const marker = `request-${String(i).padStart(4, "0")}`;
      assert.equal((await phoneCall("usage", { marker, bytes: 0 })).marker, marker);
      if (pendingResetAt !== null) {
        warmStandbyWaitMs = Math.max(warmStandbyWaitMs, Date.now() - pendingResetAt);
        pendingResetAt = null;
      }
      expected.push(marker);
      if ((i + 1) % interval === 0 && i + 1 < requestCount && resets < resetCount) {
        const resetAt = Date.now();
        resets++;
        activeResetCount++;
        killHostTransport();
        console.log(JSON.stringify({ phase: "inject-reset", reset: resets, hostSocketOpens, relayConnected: link.status().relay.connected, phoneState: phone.state }));
        // The next loop iteration is the request during takeover; it is intentionally not gated on
        // hostSocketOpens or relay.connected becoming true.
        pendingResetAt = resetAt;
      }
    }
    const actual = calls.filter(({ marker }) => /^request-\d{4}$/.test(marker)).map(({ marker }) => marker);
    assert.deepEqual(actual, expected, "legitimate requests arrive in order and exactly once");
    assert.equal(new Set(actual).size, requestCount, "no request is duplicated");
    assert.equal(new Set(calls.map(call => call.marker)).size, calls.length, "every backend side effect happened once, including those in flight");
    assert.deepEqual(sessionIds(), originalSessions, "no replacement phone session was established");
    assert.equal(PhoneSocket.latest, pinnedPhoneSocket, "no new phone socket was needed");
    assert.ok(!states.some(({ state }) => state === "offline"), "no injected reset produced a visible offline gap");
    assert.equal(failures, 0, "the live smoke produced zero failed calls");
    const allMarkers = calls.map(({ marker }) => marker);
    assert.equal(new Set(allMarkers).size, allMarkers.length, "every backend side effect marker is unique");
    assert.deepEqual(calls.filter(({ marker }) => marker.startsWith("silent-double-loss-")).map(({ marker }) => marker), silentMarkers, "silent side effects happen exactly once and in order");
    console.log(JSON.stringify({ phase: "faults", requests: requestCount, activeResets: activeResetCount, bothDownSockets, silentDoubleLoss: true, failures, spontaneousCloses, handshakeCloses, maxResetToReplyMs: warmStandbyWaitMs, hostSocketOpens, hostSocketCloses, states: states.map((entry) => entry.state) }));
    console.log("relay fault verification: ok");
  } finally {
    shuttingDown = true;
    for (const socket of silentSockets) {
      try { socket.terminate(); } catch {}
    }
    phone?.stop(); await link.stop().catch(() => {}); await localRelay?.close().catch(() => {}); rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error?.stack ?? error); process.exitCode = 1; });
