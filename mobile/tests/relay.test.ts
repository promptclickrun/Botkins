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
