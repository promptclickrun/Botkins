// Checks a deployment from outside, as a phone that is away from the server would use it.
//
//   node deploy/azure/verify.mjs "<pairing link>" [--screen]
//
// It takes only the pairing link the deployment returned (https://<server>/pair#…). It has no
// direct route to the server: every request that is not through the relay is refused here. It
//   1. reads https://<server>/v1/health (Node checks the certificate against the public roots),
//   2. pairs through the relay with the code in the link,
//   3. opens a session and makes calls,
//   4. with --screen, turns the screen on the way the phone app does (a ticket, signed by the
//      phone's presence key), reads one picture of the server's display, and turns it off again.
// The pairing code works once, so each run needs a new link (`botkins pair` on the server).
// It uses the app's own link client, and needs no `npm install`.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { LinkClient, isRelayHost, pair, parsePairingUrl, relayFetch } from "../../desktop/desktop/remote/link-client.mjs";

const [link, ...flags] = process.argv.slice(2);
if (!link) {
  console.error('Usage: node deploy/azure/verify.mjs "<pairing link>" [--screen] [--save-frame <file.jpg>]');
  process.exit(64);
}
const screen = flags.includes("--screen");
const frameFile = flags.includes("--save-frame") ? flags[flags.indexOf("--save-frame") + 1] : null;
const step = (text) => console.log("ok  " + text);
const until = async (what, check, ms = 30_000) => {
  for (const end = Date.now() + ms; !(await check()); ) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const page = new URL(link);
assert.equal(page.protocol, "https:", "the pairing link is an https page");
assert.equal(page.pathname, "/pair");
assert.equal(page.search, "", "the pairing query is in the fragment only");

const health = await fetch(page.origin + "/v1/health");
assert.deepEqual([health.status, await health.json()], [200, { ok: true }]);
step(page.origin + "/v1/health answers {\"ok\":true} with a certificate Node trusts");

const target = parsePairingUrl("botkins://pair?" + page.hash.slice(1));
assert.ok(target, "the link holds a pairing code");
assert.ok(target.hosts.length > 0 && target.hosts.every(isRelayHost), "the link offers the relay only");
assert.ok(target.hosts.every((host) => host.endsWith("@" + page.host)), "the relay is the server's own");
step("the link offers only the server's own relay: " + target.hosts.map((host) => host.replace(/^relay![^@]+/, "relay!<room>")).join(", "));

// No direct route: whatever is not a relay address fails at once, as on a phone on another network.
let direct = 0;
const away = () => {
  direct++;
  return Promise.reject(new TypeError("Network request failed"));
};
const fetcher = relayFetch(away, { idleMs: 60_000, connectMs: 15_000 });
// The key the phone keeps behind Face ID. The server learns its public half when the phone pairs.
const presence = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const identity = { name: "Deployment check", platform: "ios", presenceKey: presence.publicKey.export({ type: "spki", format: "der" }).toString("base64url") };
const pairing = await pair(fetcher, target, identity);
step("paired through the relay as \"" + identity.name + "\" with \"" + pairing.name + "\"");

const parts = {};
let route = null;
const phone = new LinkClient(pairing, { fetch: fetcher, onState() {}, onParts: (next) => Object.assign(parts, next), onRoute: (next) => (route = next) });
let failed = false;
try {
  phone.start();
  await until("the first sync", () => phone.state === "online" && !!parts.bots);
  assert.equal(route ?? phone.route, "relay");
  step("a session is open over the relay, and the workspace synced (" + parts.bots.length + " bots, " + (parts.chats?.length ?? 0) + " chats)");

  const devices = await phone.call("link.devices.list");
  assert.ok(devices.some((device) => device.id === pairing.deviceId), "the server lists this device");
  step("link.devices.list names this device among " + devices.length);
  await until("what the server says about itself", () => !!parts.host && !!parts.meta);
  step("the server says: " + JSON.stringify(parts.host));

  if (screen) {
    assert.equal(parts.host.headless, true);
    assert.equal(parts.host.display?.available, true, "the server reports its display as available");
    assert.ok(parts.meta.capabilities.includes("screen-grant-v1") && parts.meta.capabilities.includes("screen-grant-relay-v1"), "the server takes a screen grant through its own relay");
    assert.equal(parts.phones?.[pairing.deviceId]?.presence, true, "the server kept this phone's presence key");
    if (parts.host.screen !== "off") await phone.call("link.screen.revoke");
    assert.equal((await phone.call("link.screen.info")).canView, false, "nothing is granted before the phone confirms");
    // What ScreenAccess.tsx does after Face ID: a ticket from the server, signed by the presence key.
    const level = "view";
    const { ticket } = await phone.call("link.screen.grant.begin", level);
    const challenge = JSON.stringify(["botkins-screen-grant-v1", pairing.serverId, pairing.deviceId, level, ticket]);
    const signature = sign("sha256", Buffer.from(challenge), presence.privateKey).toString("base64url");
    assert.deepEqual(await phone.call("link.screen.grant.confirm", ticket, signature), { screen: level });
    step("screen access granted at \"view\" with a signed ticket");
    const after = await phone.call("link.screen.info");
    assert.equal(after.canView, true);
    const display = String(after.displays?.[0]?.id ?? "1");
    const shot = await phone.call("link.screen.frame", { display });
    const jpeg = Buffer.from(shot.jpeg, "base64");
    assert.ok(jpeg.length > 1000 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg.at(-2) === 0xff && jpeg.at(-1) === 0xd9, "a JPEG picture");
    if (frameFile) writeFileSync(frameFile, jpeg);
    step("link.screen.frame returned a JPEG of display " + display + ": " + jpeg.length + " bytes" + (shot.width ? ", " + shot.width + "x" + shot.height : "") + (frameFile ? ", saved to " + frameFile : ""));
    await phone.call("link.screen.revoke");
    step("screen access revoked");
  } else {
    const info = await phone.call("link.screen.info");
    step("link.screen.info: " + JSON.stringify(info));
  }
  console.log("\nAll checks passed. Direct requests refused here: " + direct + ". Device id on the server: " + pairing.deviceId);
} catch (error) {
  failed = true;
  console.error("FAILED: " + (error?.stack ?? error));
} finally {
  phone.stop();
}
process.exit(failed ? 1 : 0);
