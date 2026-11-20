// Turning the screen on from a phone, on a headless host ("screen-grant-v1"; link-host/grant.mjs).
// The computer's side runs for real (LinkHost with the phone's client library); the phone's
// presence key is a P-256 key made here, standing in for the one a phone keeps behind Face ID.
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEVICE_TOOLS } from "../link-host/device.mjs";
import { cleanPresenceKey, GRANT_CAPABILITY, grantMessage as hostMessage, NO_PRESENCE_KEY, NOT_A_PHONE, NOT_CONFIRMED, NOT_DIRECT, NOT_HEADLESS, ScreenGrants, TICKET_GONE, TICKET_MS } from "../link-host/grant.mjs";
import { LinkHost } from "../link-host/index.mjs";
import { REMOTE_METHODS } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { PHONE_TOOLS } from "../src/device/tools";
import { BLOCKED, confirmWords, displayLine, displayNote, levelOf, LEVELS, screenAccess, setByLine } from "../src/features/remote/grantWords";
import { type FetchLike, grantMessage, LinkClient, type LinkState, type Pairing, pair } from "../src/link/client";
import { isRelayHost, relayFetch } from "../src/link/relay";
import type { HostPart, Meta, PhoneRecord, ScreenTicket } from "../src/link/types";
import { FakeRelay } from "./fake-relay";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const folder = (name: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  folders.push(dir);
  return dir;
};
async function until(check: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** A phone's presence key: what it gives the computer when it pairs, and how it signs a ticket. */
function presence() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { spki: publicKey.export({ type: "spki", format: "der" }).toString("base64url"), privateKey };
}
const signed = (key: KeyObject, message: string) => sign("sha256", Buffer.from(message, "utf8"), key).toString("base64url");

function follow(pairing: Pairing, fetcher: FetchLike = real) {
  const parts: Record<string, any> = {};
  const states: LinkState[] = [];
  const client = new LinkClient(pairing, { fetch: fetcher, onParts: (next) => void Object.assign(parts, next), onState: (state) => void states.push(state) });
  client.start();
  return { client, parts, states, pairing };
}
type Followed = ReturnType<typeof follow>;
const online = (each: Followed) => until(() => each.states.at(-1) === "online" && !!each.parts.host, each.pairing.name + " online");
const hostOf = (each: Followed) => each.parts.host as HostPart;
/** What the computer keeps for this phone, once it has said so. */
async function recordOf(each: Followed): Promise<PhoneRecord> {
  const mine = () => (each.parts.phones as Record<string, PhoneRecord> | undefined)?.[each.pairing.deviceId];
  await until(() => !!mine(), each.pairing.name + " in the list of phones");
  return mine()!;
}

/** A computer. `headless` makes it a server with no window of its own; `display` is what it says about its display. */
async function host({ headless = true, display = { available: true, kind: "xvfb" } as { available: boolean; kind?: string; note?: string }, dir = folder("botkins-grant-"), relay = false as false | object } = {}) {
  const backend = new MockBackend({ speed: 0.05 }) as MockBackend & { headless?: boolean; displayStatus?: () => unknown };
  if (headless) {
    backend.headless = true;
    backend.displayStatus = () => display;
  }
  const link = new LinkHost({ relay, dir, backend, port: 0, extraHosts: ["127.0.0.1"], searchPath: [] });
  await link.setEnabled(true);
  return { link, backend, dir, at: "127.0.0.1:" + link.port, display };
}
const pairPhone = (at: string, link: LinkHost, presenceKey?: string, more: object = {}) => pair(real, { hosts: [at], code: link.startPairing().code }, { name: "Colt's phone", platform: "ios", ...(presenceKey && { presenceKey }), ...more });
const refused = (work: Promise<unknown>, sentence: string) => assert.rejects(work, (error: Error) => error.message === sentence, sentence);

test("a headless host says so, with its display; a computer with its own window says neither and takes no grant", async () => {
  const server = await host({ display: { available: false, kind: "xvfb", note: "The virtual display isn't running." } });
  const key = presence();
  const phone = follow(await pairPhone(server.at, server.link, key.spki));
  await online(phone);
  assert.ok((phone.parts.meta as Meta).capabilities.includes(GRANT_CAPABILITY));
  assert.deepEqual(hostOf(phone), { screen: "off", relay: false, headless: true, display: { available: false, kind: "xvfb", note: "The virtual display isn't running." } });
  // The display comes up: the app tells the link something changed, and the phone hears it.
  server.display.available = true;
  delete server.display.note;
  server.link.changed();
  await until(() => hostOf(phone).display?.available === true, "the display to show as available");
  assert.deepEqual(hostOf(phone).display, { available: true, kind: "xvfb" });

  const desktop = await host({ headless: false });
  const other = follow(await pairPhone(desktop.at, desktop.link, presence().spki));
  await online(other);
  assert.equal((other.parts.meta as Meta).capabilities.includes(GRANT_CAPABILITY), false);
  assert.deepEqual(hostOf(other), { screen: "off", relay: false });
  await refused(other.client.call("link.screen.grant.begin", "view"), NOT_HEADLESS);
  await refused(other.client.call("link.screen.revoke"), NOT_HEADLESS);
  assert.equal(desktop.link.status().screen.mode, "off");

  for (const each of [phone, other]) each.client.stop();
  await server.link.stop();
  await desktop.link.stop();
});

test("a phone turns the screen on with a ticket and its signature, it stays on over a restart, and off is one call", async () => {
  const server = await host();
  const key = presence();
  const pairing = await pairPhone(server.at, server.link, key.spki);
  const phone = follow(pairing);
  await online(phone);
  assert.equal((await recordOf(phone)).presence, true);

  const before = Date.now();
  const { ticket, expiresAt } = await phone.client.call<ScreenTicket>("link.screen.grant.begin", "control");
  assert.ok(Buffer.from(ticket, "base64url").length >= 32, "at least 32 random bytes");
  assert.ok(expiresAt >= before + TICKET_MS - 50 && expiresAt <= Date.now() + TICKET_MS);
  // Both ends build the same text to sign.
  const message = grantMessage(pairing.serverId, pairing.deviceId, "control", ticket);
  assert.equal(message, hostMessage(pairing.serverId, pairing.deviceId, "control", ticket));
  assert.equal(message, JSON.stringify(["botkins-screen-grant-v1", pairing.serverId, pairing.deviceId, "control", ticket]));
  assert.equal(hostOf(phone).screen, "off", "a ticket alone changes nothing");

  assert.deepEqual(await phone.client.call("link.screen.grant.confirm", ticket, signed(key.privateKey, message)), { screen: "control" });
  await until(() => hostOf(phone).screen === "control", "the phone to hear the new level");
  const by = hostOf(phone).screenSetBy!;
  assert.deepEqual({ deviceId: by.deviceId, name: by.name }, { deviceId: pairing.deviceId, name: "Colt's phone" });
  assert.ok(by.at >= before && by.at <= Date.now());
  assert.equal(server.link.status().screen.mode, "control");

  // The host restarts: the level and who set it are in link.json.
  phone.client.stop();
  await server.link.stop();
  const again = await host({ dir: server.dir });
  assert.equal(again.link.status().screen.mode, "control");
  assert.deepEqual(again.link.status().screen.setBy, by);
  const back = follow({ ...pairing, hosts: [again.at] });
  await online(back);
  assert.equal(hostOf(back).screen, "control");

  // Off is one call: no ticket, no signature.
  assert.deepEqual(await back.client.call("link.screen.revoke"), { screen: "off" });
  await until(() => hostOf(back).screen === "off", "the phone to hear it is off");
  assert.equal(hostOf(back).screenSetBy?.deviceId, pairing.deviceId, "and it says who turned it off");
  back.client.stop();
  await again.link.stop();
});

test("a ticket works once, for one level, one session and one signature", async () => {
  const server = await host();
  const key = presence();
  const pairing = await pairPhone(server.at, server.link, key.spki);
  const phone = follow(pairing);
  await online(phone);
  const begin = (level: "view" | "control", each = phone) => each.client.call<ScreenTicket>("link.screen.grant.begin", level);
  const confirm = (ticket: string, signature: string, each = phone) => each.client.call("link.screen.grant.confirm", ticket, signature);
  const sig = (level: string, ticket: string, with_ = key.privateKey) => signed(with_, hostMessage(pairing.serverId, pairing.deviceId, level, ticket));

  // A signature for another level, by another key, over other words, or none: refused, and the ticket is used up.
  for (const bad of [(t: string) => sig("view", t), (t: string) => sig("control", t, presence().privateKey), (t: string) => signed(key.privateKey, t), () => "", () => "AAAA"]) {
    const { ticket } = await begin("control");
    await refused(confirm(ticket, bad(ticket)), NOT_CONFIRMED);
    await refused(confirm(ticket, sig("control", ticket)), TICKET_GONE);
  }
  // Used once.
  const first = await begin("view");
  assert.deepEqual(await confirm(first.ticket, sig("view", first.ticket)), { screen: "view" });
  await refused(confirm(first.ticket, sig("view", first.ticket)), TICKET_GONE);
  // Asking again ends the ticket before.
  const older = await begin("control");
  const newer = await begin("control");
  await refused(confirm(older.ticket, sig("control", older.ticket)), TICKET_GONE);
  await refused(confirm(newer.ticket, sig("control", newer.ticket)), TICKET_GONE);
  // A ticket belongs to its session: the same phone on another session can't use it.
  const { ticket } = await begin("control");
  const second = follow(pairing);
  await online(second);
  await refused(confirm(ticket, sig("control", ticket), second), TICKET_GONE);
  // Any change of the level ends open tickets: one made on the computer, and turning it off.
  for (const change of [() => server.link.setScreenMode("view"), () => phone.client.call("link.screen.revoke")]) {
    const open = await begin("control");
    await change();
    await refused(confirm(open.ticket, sig("control", open.ticket)), TICKET_GONE);
  }
  // Something that is not a ticket at all.
  await begin("control");
  await refused(confirm("nope", "AAAA"), TICKET_GONE);
  await refused(phone.client.call("link.screen.grant.begin", "off"), "The screen can be set to view or control.");
  assert.equal(server.link.status().screen.mode, "off", "none of the refused tries turned the screen on");

  for (const each of [phone, second]) each.client.stop();
  await server.link.stop();
});

test("a ticket lasts a minute, and ends with its session or its device", () => {
  let now = 1_000_000;
  const key = presence();
  const device = { id: "dev1", name: "Phone", kind: "phone", presenceKey: key.spki };
  const applied: unknown[] = [];
  const grants = new ScreenGrants({ serverId: "srv", device: (id: string) => (id === "dev1" ? device : undefined), headless: () => true, apply: (level: string, by: unknown) => void applied.push([level, by]), now: () => now });
  const session = { id: "s1", deviceId: "dev1" };
  const sig = (ticket: string) => signed(key.privateKey, hostMessage("srv", "dev1", "view", ticket));
  const says = (work: () => unknown) => {
    try {
      work();
    } catch (error) {
      return (error as Error).message;
    }
    return null;
  };

  let open = grants.begin(session, "http", "view");
  assert.equal(open.expiresAt, now + TICKET_MS);
  now += TICKET_MS + 1;
  assert.equal(says(() => grants.confirm(session, "http", open.ticket, sig(open.ticket))), TICKET_GONE);

  open = grants.begin(session, "http", "view");
  now += TICKET_MS;
  assert.deepEqual(grants.confirm(session, "http", open.ticket, sig(open.ticket)), { screen: "view" });
  assert.deepEqual(applied, [["view", { deviceId: "dev1", name: "Phone", at: now }]]);

  open = grants.begin(session, "http", "view");
  grants.dropSession("s1");
  assert.equal(says(() => grants.confirm(session, "http", open.ticket, sig(open.ticket))), TICKET_GONE);
  open = grants.begin(session, "http", "view");
  grants.forget("dev1");
  assert.equal(says(() => grants.confirm(session, "http", open.ticket, sig(open.ticket))), TICKET_GONE);

  // Through the relay nothing is taken, whatever the session: begin, confirm and revoke alike.
  open = grants.begin(session, "http", "view");
  assert.equal(says(() => grants.confirm(session, "relay", open.ticket, sig(open.ticket))), NOT_DIRECT);
  assert.equal(says(() => grants.begin(session, "relay", "view")), NOT_DIRECT);
  assert.equal(says(() => grants.revoke(session, "relay")), NOT_DIRECT);
  assert.equal(applied.length, 1);
});

test("only a phone, only one that paired directly with a key, and never through the relay", async () => {
  const relay = new FakeRelay();
  const server = await host({ relay: { url: "https://relay.test", WebSocket: relay.WebSocket } });
  server.link.setRelay({ enabled: true });
  await until(() => server.link.status().relay.connected, "the computer to reach the relay");
  const phones = () => server.link.status().devices as { id: string; kind: string }[];

  // Another computer's app, with a key all the same: it is not a phone.
  const deskKey = presence();
  const desk = follow(await pairPhone(server.at, server.link, deskKey.spki, { name: "Studio Mac", platform: "darwin", kind: "desktop" }));
  await online(desk);
  await refused(desk.client.call("link.screen.grant.begin", "view"), NOT_A_PHONE);
  await refused(desk.client.call("link.screen.revoke"), NOT_A_PHONE);

  // A phone from before presence keys, and one that sent something that is not a P-256 key: no grant until they pair again.
  for (const sent of [undefined, "not-a-key", presence().spki.slice(0, 60), generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url")]) {
    const old = follow(await pairPhone(server.at, server.link, sent));
    await online(old);
    assert.equal("presence" in (await recordOf(old)), false);
    await refused(old.client.call("link.screen.grant.begin", "view"), NO_PRESENCE_KEY);
    // It can still turn the screen off.
    assert.deepEqual(await old.client.call("link.screen.revoke"), { screen: "off" });
    old.client.stop();
  }
  assert.equal(cleanPresenceKey(presence().spki) !== null, true);

  // A phone that paired directly, now away: through the relay the host takes none of the three calls.
  const key = presence();
  const pairing = await pairPhone(server.at, server.link, key.spki);
  const away: FetchLike = () => Promise.reject(new TypeError("Network request failed"));
  const far = follow({ ...pairing, hosts: server.link.hosts().filter(isRelayHost) }, relayFetch(away, { WebSocket: relay.WebSocket as any, idleMs: 200 }));
  await until(() => !!far.parts.host, "the phone through the relay", 10_000);
  assert.equal(far.client.route, "relay");
  await refused(far.client.call("link.screen.grant.begin", "view"), NOT_DIRECT);
  await refused(far.client.call("link.screen.grant.confirm", "x", "y"), NOT_DIRECT);
  await refused(far.client.call("link.screen.revoke"), NOT_DIRECT);

  // Pairing through the relay keeps no presence key, so such a phone can't grant even at home later.
  const viaRelay = relayFetch(away, { WebSocket: relay.WebSocket as any, idleMs: 200 });
  const relayed = await pair(viaRelay, { hosts: server.link.hosts().filter(isRelayHost), code: server.link.startPairing().code }, { name: "Paired away", platform: "ios", presenceKey: presence().spki });
  const home = follow({ ...relayed, hosts: [server.at] });
  await online(home);
  assert.equal("presence" in (await recordOf(home)), false);
  await refused(home.client.call("link.screen.grant.begin", "view"), NO_PRESENCE_KEY);

  assert.equal(server.link.status().screen.mode, "off");
  assert.ok(phones().length >= 3);
  for (const each of [desk, far, home]) each.client.stop();
  await server.link.stop();
});

test("set on the computer itself, the level carries no phone's name", async () => {
  const server = await host();
  const key = presence();
  const pairing = await pairPhone(server.at, server.link, key.spki);
  const phone = follow(pairing);
  await online(phone);
  const { ticket } = await phone.client.call<ScreenTicket>("link.screen.grant.begin", "view");
  await phone.client.call("link.screen.grant.confirm", ticket, signed(key.privateKey, grantMessage(pairing.serverId, pairing.deviceId, "view", ticket)));
  await until(() => !!hostOf(phone).screenSetBy, "the phone's name on the level");
  server.link.setScreenMode("control");
  await until(() => hostOf(phone).screen === "control", "the level set on the computer");
  assert.equal("screenSetBy" in hostOf(phone), false);
  assert.equal("setBy" in server.link.status().screen, false);
  phone.client.stop();
  await server.link.stop();
});

test("no bot can reach it: not a call the app offers phones, not a tool on the computer or on the phone", async () => {
  const names = ["link.screen.grant.begin", "link.screen.grant.confirm", "link.screen.revoke", "setScreenMode", "applyScreen"];
  for (const name of names) assert.equal(REMOTE_METHODS.has(name), false, name);
  assert.deepEqual([...REMOTE_METHODS].filter((name) => /screen|grant/i.test(name)), [], "none of the app's calls for phones names the screen");
  // The tools a bot can run on a phone, as the computer offers them and as the phone runs them.
  for (const tool of DEVICE_TOOLS as { name: string; description?: string }[]) assert.equal(/screen|grant/i.test(tool.name), false, tool.name);
  for (const name of Object.keys(PHONE_TOOLS)) assert.equal(/screen|grant/i.test(name), false, name);

  // The app's own calls, as a phone makes them, can't set the level; the stand-in app has no such call at all.
  const server = await host();
  const phone = follow(await pairPhone(server.at, server.link, presence().spki));
  await online(phone);
  for (const name of ["setScreenMode", "applyScreen"]) await assert.rejects(phone.client.call(name, "control"), /can't be done from a phone/);
  assert.equal(Object.keys(server.backend.handlers).some((name) => /screen/i.test(name) && !/pane/i.test(name)), false);
  assert.equal(server.link.status().screen.mode, "off");
  phone.client.stop();
  await server.link.stop();

  // On the phone: only the grant's own module makes these calls. No chat, custom view, notification,
  // phone tool or link handler does.
  const callers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && /link\.screen\.(grant|revoke)/.test(readFileSync(path, "utf8"))) callers.push(path.replace(/^.*\/src\//, "src/"));
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(callers.sort(), ["src/features/remote/grant.ts", "src/link/types.ts"]);
});

// ---- the phone's side: what the Screen section shows, and the gate before a level is turned on

const headlessHost: HostPart = { screen: "off", relay: false, headless: true, display: { available: true, kind: "xvfb" } };
const ready = { host: headlessHost, capable: true, online: true, route: "direct" as const, pinned: true, hasKey: true, canProve: true };

test("the Screen section: a computer with its own settings shows the level, a headless host lets the phone set it", () => {
  assert.deepEqual(screenAccess({ ...ready, host: undefined }), { kind: "none" });
  // A computer with a window, or one that doesn't name the capability: shown, changed there.
  assert.deepEqual(screenAccess({ ...ready, host: { screen: "control", relay: true }, capable: false }), { kind: "computer", level: "control" });
  assert.deepEqual(screenAccess({ ...ready, capable: false }), { kind: "computer", level: "off" });
  assert.deepEqual(screenAccess({ ...ready, host: { screen: "view" } }), { kind: "computer", level: "view" });

  // The three states of the toggle, as the host reports them.
  for (const level of ["off", "view", "control"] as const) {
    const access = screenAccess({ ...ready, host: { ...headlessHost, screen: level } });
    assert.deepEqual(access, { kind: "phone", level, display: { available: true, kind: "xvfb" }, turnOn: null, turnOff: null });
    assert.equal(levelOf(level).value, level);
  }
  assert.deepEqual(LEVELS.map((level) => level.label), ["Off", "View only", "View and control"]);
  for (const level of LEVELS) assert.ok(level.grants.length > 20 && /screen/.test(level.grants), "each level says what it grants");
  assert.match(levelOf("control").grants, /pointer and keyboard/);

  // Who set it, and the display.
  const by = { deviceId: "d1", name: "Colt's phone", at: 5 };
  const set = screenAccess({ ...ready, host: { ...headlessHost, screen: "view", screenSetBy: by } });
  assert.deepEqual(set.kind === "phone" && set.setBy, by);
  assert.equal(setByLine(by, "d1", "view"), "Set by this phone");
  assert.equal(setByLine(by, "d2", "view"), "Set by Colt's phone");
  assert.equal(setByLine(by, "d2", "off"), "Turned off by Colt's phone");
  assert.equal(setByLine(undefined, "d1", "view"), undefined);
  assert.equal(displayLine({ available: true, kind: "xvfb" }), "Running (xvfb)");
  assert.equal(displayLine({ available: true }), "Running");
  assert.equal(displayLine({ available: false, kind: "xvfb" }), "Not running");
  assert.equal(displayNote({ available: false, note: "The virtual display isn't running." }), "The virtual display isn't running.");
  assert.match(displayNote({ available: false })!, /no display/);
  assert.equal(displayNote({ available: true }), undefined);
  const down = screenAccess({ ...ready, host: { ...headlessHost, display: undefined } });
  assert.deepEqual(down.kind === "phone" && down.display, { available: false });
});

test("the gate: a level can be turned on only directly, by a phone that can prove a person holds it; off needs only the direct way", () => {
  const blocked = (change: Partial<typeof ready>) => {
    const access = screenAccess({ ...ready, ...change });
    assert.equal(access.kind, "phone");
    return access.kind === "phone" ? [access.turnOn, access.turnOff] : [];
  };
  assert.deepEqual(blocked({}), [null, null]);
  assert.deepEqual(blocked({ online: false }), ["offline", "offline"]);
  assert.deepEqual(blocked({ route: "relay" }), ["relay", "relay"]);
  // No passcode on the phone, no key kept by the computer, or the phone's half gone: on is closed, off is not.
  assert.deepEqual(blocked({ canProve: false }), ["passcode", null]);
  assert.deepEqual(blocked({ pinned: false }), ["pair-again", null]);
  assert.deepEqual(blocked({ hasKey: false }), ["pair-again", null]);
  assert.deepEqual(blocked({ canProve: false, pinned: false, hasKey: false }), ["passcode", null]);
  assert.deepEqual(blocked({ route: "relay", canProve: false }), ["relay", "relay"]);
  for (const why of ["offline", "relay", "pair-again", "passcode"] as const) assert.ok(BLOCKED[why].length > 10);

  // The question before a level is turned on says what it grants and how it is confirmed.
  const control = confirmWords("control", "Studio server");
  assert.equal(control.title, "Let phones view and control Studio server?");
  assert.match(control.message, /pointer and keyboard/);
  assert.match(control.message, /Face ID, Touch ID or your passcode/);
  assert.equal(control.action, "Turn on");
  assert.equal(confirmWords("view", "Studio server").title, "Let phones view Studio server's screen?");
});

test("on the phone, one section asks and one function signs: nothing else can", () => {
  const source = new URL("../src", import.meta.url).pathname;
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push({ path: path.replace(/^.*\/src\//, "src/"), text: readFileSync(path, "utf8") });
    }
  };
  walk(source);
  const using = (pattern: RegExp) => files.filter((file) => pattern.test(file.text)).map((file) => file.path).sort();
  // Only the Screen section uses the functions that make the calls.
  assert.deepEqual(using(/\b(grantScreen|revokeScreen)\b/), ["src/features/remote/ScreenAccess.tsx", "src/features/remote/grant.ts"]);
  // Only the grant signs with the presence key, and only the presence wrapper touches the native key.
  assert.deepEqual(using(/\bsignPresence\(/), ["src/features/remote/grant.ts", "src/state/presence.ts"]);
  assert.deepEqual(using(/botkins-presence/), ["src/state/presence.ts"]);
  // The section is on the computer's page and nowhere a bot's message, a custom view or a link can open it for the person.
  assert.deepEqual(using(/<ScreenAccess\b/), ["src/features/settings/Desktop.tsx"]);
  // In the grant, the signature comes between the ticket and the confirmation: there is no confirm without it.
  const grant = files.find((file) => file.path === "src/features/remote/grant.ts")!.text;
  const order = ["link.screen.grant.begin", "signPresence(", "link.screen.grant.confirm"].map((piece) => grant.indexOf(piece, grant.indexOf("export async function grantScreen")));
  assert.ok(order[0]! > 0 && order[0]! < order[1]! && order[1]! < order[2]!, "ticket, then signature, then confirm");
  // The section turns a level on only from the answer to its own question.
  const section = files.find((file) => file.path === "src/features/remote/ScreenAccess.tsx")!.text;
  assert.equal((section.match(/grantScreen\(/g) ?? []).length, 1);
  assert.match(section, /Alert\.alert\(words\.title/);
  assert.equal(/useLocalSearchParams|useEffect/.test(section), false, "nothing but a tap starts it: no route parameter, no effect");
});
