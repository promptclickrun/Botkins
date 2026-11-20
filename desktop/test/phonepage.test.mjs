// Settings › Phone, from the desktop's side (desktop/phonepage.mjs): what the page is shown and the
// calls only it makes, above all "Use away from home". A real LinkHost runs against the phone
// repo's in-memory relay (test/fixtures/fake-relay.ts, copied unchanged) and a clock turned by
// hand. No test opens a socket to the real relay.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LinkHost, qrPath, REMOTE_METHODS } from "../desktop/link/index.mjs";
import { DEFAULT_RELAY_URL, hostOffer } from "../desktop/link/relay.mjs";
import { phonePage } from "../desktop/phonepage.mjs";

const folders = [];
const scratch = () => {
  const folder = mkdtempSync(join(tmpdir(), "botkins-phonepage-"));
  folders.push(folder);
  return folder;
};
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
// The fixture is the phone repo's TypeScript file as it is; its types are taken out here to load it.
const fixture = join(scratch(), "fake-relay.mjs");
const warn = process.emitWarning;
process.emitWarning = () => {};
writeFileSync(fixture, stripTypeScriptTypes(readFileSync(new URL("./fixtures/fake-relay.ts", import.meta.url), "utf8"), { mode: "transform" }));
process.emitWarning = warn;
const { FakeRelay, roomOf } = await import(pathToFileURL(fixture).href);

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await tick();
  }
}
/** A clock the test turns by hand, as the phone repo's relay tests use. */
function clock() {
  let now = 0;
  let next = 0;
  const pending = new Map();
  return {
    timers: {
      setTimeout: (fn, ms) => (pending.set(++next, { at: now + ms, fn }), next),
      clearTimeout: (id) => void pending.delete(id),
      random: () => 0.5,
      now: () => Date.now(),
    },
    /** Runs the timer that is due soonest. */
    step() {
      const due = [...pending.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) return false;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      return true;
    },
  };
}
const asked = [];
const screens = { granted: () => ({ system: true, screenRecording: true, accessibility: asked.includes("accessibility") }), request: async (kind) => void asked.push(kind) };
/** A computer as desktop/main.mjs sets it up, with the relay's socket class and clock replaced. */
function computer(t, dir = scratch()) {
  const relay = new FakeRelay();
  const time = clock();
  const link = new LinkHost({
    dir,
    port: 0,
    extraHosts: ["127.0.0.1"],
    searchPath: [],
    backend: { info: () => ({ app: "botkins", version: "0.0.0", platform: process.platform }), snapshot: () => ({ bots: [], chats: [], runs: [] }), call: () => {}, subscribe: () => () => {} },
    relay: { url: "https://relay.test", WebSocket: relay.WebSocket, timers: time.timers },
  });
  t.after(() => link.stop());
  const changes = [];
  link.on("status", () => changes.push(link.status().relay));
  return { relay, time, link, dir, changes, page: phonePage({ link: () => link, qrPath, screens }) };
}
/** The link's own file, or nothing when it has saved nothing yet. */
const saved = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, "link.json"), "utf8"));
  } catch {
    return {};
  }
};
/** True while a computer's socket sits in a place on the relay. */
const seated = (relay, room) => !!relay.hostOf(room);

test("away from home is off until the person turns it on, and the page is told nothing about a key", async (t) => {
  const { page, link, dir } = computer(t);
  assert.deepEqual(page.phoneLink().relay, { enabled: false, connected: false });
  await page.setPhoneLink(true);
  assert.deepEqual(page.phoneLink().relay, { enabled: false, connected: false }, "turning phone access on doesn't turn it on");
  assert.notEqual(saved(dir).relay?.enabled, true);
  // The real relay's address is the link's own default, so the app passes none.
  assert.equal(DEFAULT_RELAY_URL, "https://relay.botkins.app");
  // With it off, a pairing code is for a phone on this network: it carries no relay entry.
  assert.ok(!page.startPhonePairing().pairing.url.includes("relay"));
  link.cancelPairing();
});

test("on connects and says so, off closes it, and both are saved", async (t) => {
  const { page, link, relay, dir, changes } = computer(t);
  await page.setPhoneLink(true);
  const on = page.setPhoneRelay(true);
  assert.equal(on.relay.enabled, true);
  await until(() => page.phoneLink().relay.connected, "the computer to reach the relay");
  assert.deepEqual(page.phoneLink().relay, { enabled: true, connected: true });
  assert.ok(changes.some((r) => r.connected), "the page hears of it through the link's status event");
  assert.equal(saved(dir).relay.enabled, true);
  const key = link.store.relayKey();
  const room = roomOf(key.publicKey);
  assert.ok(seated(relay, room), "one outgoing socket, to this computer's own place");
  // What the page is given names neither the key, nor the place, nor the relay's address.
  const shown = JSON.stringify(page.phoneLink());
  for (const secret of [key.publicKey, key.privateKey, room, "relay.test"]) assert.ok(!shown.includes(secret), "the page is not shown " + secret.slice(0, 12));
  assert.deepEqual(Object.keys(page.phoneLink().relay), ["enabled", "connected"]);
  // With it on, the pairing code carries the way in from away, so a phone can pair from anywhere.
  const pairing = page.startPhonePairing().pairing;
  assert.ok(decodeURIComponent(pairing.url).includes("relay!" + room + "@relay.test"));
  assert.ok(pairing.qr.d.length > 100);
  link.cancelPairing();

  const off = page.setPhoneRelay(false);
  assert.deepEqual(off.relay, { enabled: false, connected: false });
  await until(() => !seated(relay, room), "the socket to close");
  assert.equal(saved(dir).relay.enabled, false);
  assert.ok(!page.startPhonePairing().pairing.url.includes("relay"));
});

test("while the relay can't be reached the page is told it is on and not connected, and the link keeps trying", async (t) => {
  const { page, relay, time } = computer(t);
  await page.setPhoneLink(true);
  relay.down = true;
  page.setPhoneRelay(true);
  await tick(30);
  assert.deepEqual(page.phoneLink().relay, { enabled: true, connected: false }, "Connecting…");
  relay.down = false;
  // The link tries again by itself after its wait.
  for (let i = 0; i < 5 && !page.phoneLink().relay.connected; i++) {
    time.step();
    await tick(20);
  }
  assert.deepEqual(page.phoneLink().relay, { enabled: true, connected: true });
});

test("it only runs while phone access is on: turning it on needs that, and turning phone access off stops it", async (t) => {
  const { page, link, relay, dir } = computer(t);
  assert.throws(() => page.setPhoneRelay(true), /Turn on phone access first/);
  assert.deepEqual(page.phoneLink().relay, { enabled: false, connected: false });
  assert.notEqual(saved(dir).relay?.enabled, true, "nothing was saved");
  // Off is always allowed.
  assert.deepEqual(page.setPhoneRelay(false).relay, { enabled: false, connected: false });
  await page.setPhoneLink(true);
  page.setPhoneRelay(true);
  await until(() => page.phoneLink().relay.connected, "the computer to reach the relay");
  const room = roomOf(link.store.relayKey().publicKey);
  // Phone access off: the socket closes. The choice itself is kept for when it is turned on again.
  const off = await page.setPhoneLink(false);
  assert.equal(off.enabled, false);
  assert.equal(off.relay.connected, false);
  await until(() => !seated(relay, room), "the socket to close with phone access");
  assert.equal(saved(dir).relay.enabled, true);
  await page.setPhoneLink(true);
  await until(() => page.phoneLink().relay.connected, "the relay to come back with phone access");
});

test("another computer in this computer's place shows as taken, and Reset gives it a new place", async (t) => {
  const { page, link, relay, time } = computer(t);
  await page.setPhoneLink(true);
  page.setPhoneRelay(true);
  await until(() => page.phoneLink().relay.connected, "the computer to reach the relay");
  const key = link.store.relayKey();
  const room = roomOf(key.publicKey);
  // A copy of this computer's link file, in use somewhere else, takes the seat again and again.
  const intruder = () => {
    const socket = new relay.WebSocket("wss://relay.test/v1/host/" + room, hostOffer(key, relay.now()));
    socket.onopen = () => {};
    socket.onmessage = () => {};
    return socket;
  };
  for (let round = 0; round < 6 && page.phoneLink().relay.problem !== "taken"; round++) {
    intruder();
    await until(() => !page.phoneLink().relay.connected, "the takeover to show");
    if (page.phoneLink().relay.problem === "taken") break;
    time.step();
    await tick(20);
    await until(() => page.phoneLink().relay.connected || page.phoneLink().relay.problem === "taken", "the computer to try again");
  }
  assert.deepEqual(page.phoneLink().relay, { enabled: true, connected: false, problem: "taken" });

  // Reset: a new key, so a new place, and the computer is connected again. The new place's name isn't handed to the page.
  const after = page.resetPhoneRelay();
  assert.equal(after.relay.problem, undefined);
  assert.equal(after.relay.enabled, true);
  const next = roomOf(link.store.relayKey().publicKey);
  assert.notEqual(next, room);
  assert.ok(!JSON.stringify(after).includes(next));
  await until(() => page.phoneLink().relay.connected, "the computer to take its new place");
  assert.ok(seated(relay, next));
  assert.ok(link.hosts().at(-1).startsWith("relay!" + next + "@"), "a new pairing code carries the new place");
});

test("Reset with away from home off still makes a new place, and connects nothing", async (t) => {
  const { page, link, relay } = computer(t);
  await page.setPhoneLink(true);
  const before = link.store.relayKey().publicKey;
  const status = page.resetPhoneRelay();
  assert.deepEqual(status.relay, { enabled: false, connected: false });
  assert.notEqual(link.store.relayKey().publicKey, before);
  assert.equal(seated(relay, roomOf(link.store.relayKey().publicKey)), false);
});

test("the choice survives a restart, and a phone can make none of the page's calls", async (t) => {
  const first = computer(t);
  await first.page.setPhoneLink(true);
  first.page.setPhoneRelay(true);
  await until(() => first.page.phoneLink().relay.connected, "the computer to reach the relay");
  await first.link.stop();
  // The app starts again on the same folder: phone access and away from home are both still on.
  const again = computer(t, first.dir);
  await again.link.start();
  await until(() => again.page.phoneLink().relay.connected, "the relay to come back after a restart");
  assert.deepEqual(again.page.phoneLink().relay, { enabled: true, connected: true });

  for (const name of Object.keys(again.page)) {
    assert.ok(!REMOTE_METHODS.has(name), name + " must not be callable from a phone");
    await assert.rejects(again.link.dispatch({}, { m: name, a: [true] }), /can't be done from a phone/, name);
  }
  assert.deepEqual(again.page.phoneLink().relay, { enabled: true, connected: true }, "and nothing a phone sent changed it");
});

test("the page is shown the screen choice, the pairing code as a drawing, and no identity", async (t) => {
  const { page } = computer(t);
  await page.setPhoneLink(true);
  const status = page.setPhoneScreen("view");
  assert.deepEqual(status.screen, { mode: "view", viewers: [], permissions: { system: true, screenRecording: true, accessibility: false } });
  // Grant asks the system and hands back what the page shows next.
  assert.equal((await page.requestScreenPermission("accessibility")).screen.permissions.accessibility, true);
  assert.deepEqual(asked, ["accessibility"]);
  assert.throws(() => page.setPhoneScreen("everything"), /off, view or control/);
  assert.equal("serverId" in status, false);
  const pairing = page.startPhonePairing().pairing;
  assert.match(pairing.code, /^[2-9A-HJ-NP-Z]{12}$/);
  assert.ok(pairing.qr.size > 20);
  await page.cancelPhonePairing();
  assert.equal(page.phoneLink().pairing, null);
});

test("the page is told whether a phone can find the computer by itself, and Grant opens the way to allow it", async (t) => {
  const { link } = computer(t);
  await link.setEnabled(true);
  let state = "blocked";
  const opened = [];
  const page = phonePage({ link: () => link, qrPath: () => ({ size: 1, d: "" }), screens, nearby: () => state, allowLocalNetwork: async () => void opened.push("local network") });
  // macOS has not allowed Botkins to use the local network: the page can say so.
  assert.equal(page.phoneLink().nearby, "blocked");
  state = "on";
  // Grant opens System Settings; what the page shows next is the state as it then is.
  assert.equal((await page.allowLocalNetwork()).nearby, "on");
  assert.deepEqual(opened, ["local network"]);
  // A page made without it (a test, another system) says "off" and has nothing to open.
  const plain = phonePage({ link: () => link, qrPath: () => ({ size: 1, d: "" }), screens });
  assert.equal(plain.phoneLink().nearby, "off");
  assert.equal((await plain.allowLocalNetwork()).nearby, "off");
});
