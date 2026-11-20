// A live check of the deployed relay: a real LinkHost and the phone's real client, both using the
// system's WebSocket, meet through https://relay.botkins.app. Not part of `npm test`
// (it needs the network). Run: node --import tsx tests/live-relay.mts [relay url]
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { DEFAULT_RELAY_URL } from "../link-host/relay.mjs";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import { parsePairingUrl } from "../src/link/pairing";
import { isRelayHost, relayFetch } from "../src/link/relay";

const url = process.argv[2] ?? DEFAULT_RELAY_URL;
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await tick(50);
  }
}
const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-live-relay-")));
const link = new LinkHost({ dir, backend: new MockBackend({ speed: 0.05 }), port: 0, extraHosts: ["127.0.0.1"], searchPath: [], relay: { url } });
try {
  await link.setEnabled(true);
  link.setRelay({ enabled: true });
  await until(() => link.status().relay.connected, "the computer to reach " + url);
  console.log("computer connected to", url);
  // The phone is "away": no direct address works, so everything goes through the relay.
  const away: FetchLike = () => Promise.reject(new TypeError("Network request failed"));
  const fetcher = relayFetch(away, { idleMs: 500 });
  const target = parsePairingUrl(link.startPairing().url)!;
  assert.ok(target.hosts.some(isRelayHost));
  let started = Date.now();
  const paired = await pair(fetcher, target, { name: "Live test phone", platform: "ios" });
  console.log("paired through the relay in", Date.now() - started, "ms");
  const parts: Record<string, any> = {};
  const client = new LinkClient(paired, { fetch: fetcher, onParts: (next) => void Object.assign(parts, next), onState() {} });
  client.start();
  await until(() => !!parts.bots, "the first state");
  assert.equal(client.route, "relay");
  started = Date.now();
  for (let i = 0; i < 5; i++) assert.ok(Array.isArray(await client.call("models")));
  console.log("5 calls, average", Math.round((Date.now() - started) / 5), "ms each");
  const before = parts.bots.length;
  await client.call("addBot", { name: "Live relay bot", role: "Tester", instructions: "x" });
  await until(() => parts.bots.length === before + 1, "a change to arrive through the waiting sync");
  console.log("a change on the computer reached the phone");
  // A larger answer, the size of a screen frame.
  const big = await client.call<{ size: number }>("link.upload", { name: "frame.bin", data: Buffer.alloc(900_000, 7).toString("base64") });
  assert.equal(big.size, 900_000);
  console.log("a 900 KB upload passed");
  // Quiet for 40 seconds (the relay's object sleeps), then it must still work.
  await tick(40_000);
  assert.ok(Array.isArray(await client.call("models")));
  console.log("still working after 40 s of quiet");
  client.stop();
  console.log("OK");
} finally {
  await link.stop();
  rmSync(dir, { recursive: true, force: true });
}
