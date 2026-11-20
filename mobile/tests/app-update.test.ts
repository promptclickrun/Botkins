// The computer's own updates from a phone ("app-update-v1"; docs/link-contract.md): what the
// computer's page says and offers, the link's calls and their shape, the owner-only rule, the
// "a newer Botkins is out" notification (link-host/push.mjs), and the demo computer end to end.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { remoteArgs, REMOTE_METHODS } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { DEMO_LATEST, DEMO_VERSION } from "../link-host/mock-update.mjs";
import { authorize, TEAM_METHODS } from "../link-host/team.mjs";
import { afterRestart, installQuestion, lastLine, restartPending, RESTART_MS, updateButton, updateLine } from "../src/features/settings/updates";
import { type FetchLike, LinkClient, pair, type Pairing } from "../src/link/client";
import { agree, fromUtf8, hkdf, open, unb64u, utf8 } from "../src/link/crypto";
import type { AppUpdate } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const CALLS = ["appUpdateStatus", "checkAppUpdate", "installAppUpdate", "setAppUpdateAuto"];
const update = (more: Partial<AppUpdate>): AppUpdate => ({ status: "idle", current: "0.16.4", canInstall: false, ...more });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the page says where the update stands in the desktop app's words, the computer's own sentence first", () => {
  assert.equal(updateLine(update({ status: "current" })), "You’re up to date.");
  assert.equal(updateLine(update({ status: "available", latest: "0.16.5", canInstall: true })), "Version 0.16.5 is available.");
  assert.equal(updateLine(update({ status: "checking" })), "Checking GitHub…");
  assert.equal(updateLine(update({ status: "downloading" })), "Downloading update…");
  assert.equal(updateLine(update({ status: "restarting" })), "Restarting after the current request…");
  assert.equal(updateLine(update({ status: "idle" })), "Botkins checks GitHub Releases automatically.");
  // A copy that can't install it says what to do instead, and an error says what failed.
  const docker = "This copy runs in Docker. Pull the new image to update.";
  assert.equal(updateLine(update({ status: "available", latest: "0.16.5", message: docker })), docker);
  assert.equal(updateLine(update({ status: "error", message: "GitHub could not check for updates (HTTP 503)." })), "GitHub could not check for updates (HTTP 503).");
  assert.equal(updateLine(update({ status: "error" })), "Botkins couldn't check for updates.");
});

test("the page's button installs what this copy can install, and otherwise checks", () => {
  assert.deepEqual(updateButton(update({ status: "available", latest: "0.16.5", canInstall: true })), { kind: "install", title: "Update and restart", disabled: false });
  assert.deepEqual(updateButton(update({ status: "available", latest: "0.16.5" })), { kind: "check", title: "Check for updates", disabled: false });
  assert.deepEqual(updateButton(update({ status: "current" })), { kind: "check", title: "Check for updates", disabled: false });
  for (const status of ["checking", "downloading", "restarting"] as const) assert.equal(updateButton(update({ status })).disabled, true, status);
  assert.equal(updateButton(undefined).disabled, true);
  const question = installQuestion("Studio server", "0.16.5");
  assert.equal(question.title, "Update Botkins on Studio server?");
  assert.match(question.message, /restarts to install version 0\.16\.5/);
});

test("how the last install ended is said once the computer is back, a rollback too", () => {
  assert.equal(lastLine({ at: "2026-11-20T20:00:00Z", from: "0.16.4", to: "0.16.5", ok: true }), "Updated from 0.16.4 to 0.16.5.");
  assert.equal(lastLine({ at: "2026-11-20T20:00:00Z", from: "0.16.4", to: "0.16.5", ok: false, message: "0.16.5 didn't stay up, so 0.16.4 is back." }), "0.16.5 didn't stay up, so 0.16.4 is back.");
  assert.equal(lastLine({ at: "2026-11-20T20:00:00Z", from: "0.16.4", to: "0.16.5", ok: false }), "The update to 0.16.5 didn't finish, so 0.16.4 is back.");
  assert.equal(lastLine(undefined), null);

  const since = Date.parse("2026-11-20T20:00:00Z");
  const pending = { serverId: "s1", since, from: "0.16.4", to: "0.16.5" };
  // While it downloads or restarts there is nothing to say yet.
  assert.deepEqual(afterRestart(pending, update({ status: "restarting" })), { done: false });
  assert.deepEqual(afterRestart(pending, update({ status: "current", current: "0.16.5", last: { at: "2026-11-20T20:01:00Z", from: "0.16.4", to: "0.16.5", ok: true } })), { done: true, ok: true, text: "Updated from 0.16.4 to 0.16.5." });
  assert.deepEqual(afterRestart(pending, update({ status: "idle", last: { at: "2026-11-20T20:01:00Z", from: "0.16.4", to: "0.16.5", ok: false, message: "Rolled back." } })), { done: true, ok: false, text: "Rolled back." });
  // An older `last` says nothing about this install: the version running decides.
  const old = { at: "2026-11-01T00:00:00Z", from: "0.16.2", to: "0.16.3", ok: true };
  assert.deepEqual(afterRestart(pending, update({ status: "current", current: "0.16.5", last: old })), { done: true, ok: true, text: "Botkins is now 0.16.5." });
  assert.deepEqual(afterRestart(pending, update({ status: "error", current: "0.16.4", last: old, message: "The update could not be installed." })), { done: true, ok: false, text: "The update could not be installed." });
  // The restart counts only for the computer it was started on, and not for ever.
  assert.equal(restartPending(pending, "s1", since + 1000), true);
  assert.equal(restartPending(pending, "s2", since + 1000), false);
  assert.equal(restartPending(pending, "s1", since + RESTART_MS + 1), false);
  assert.equal(restartPending(null, "s1", since), false);
});

test("the link lets the owner's devices make the four calls, with nothing in them but one switch", () => {
  for (const method of CALLS) {
    assert.ok(REMOTE_METHODS.has(method), method + " is a phone's call");
    assert.equal(TEAM_METHODS[method], "owner", method + " is the owner's alone");
  }
  // No version, address or channel gets through.
  assert.deepEqual(remoteArgs("installAppUpdate", ["0.99.0", "https://evil.example/botkins.tar.gz"]), []);
  assert.deepEqual(remoteArgs("checkAppUpdate", [{ channel: "beta" }]), []);
  assert.deepEqual(remoteArgs("appUpdateStatus", [1]), []);
  assert.deepEqual(remoteArgs("setAppUpdateAuto", [true]), [true]);
  assert.deepEqual(remoteArgs("setAppUpdateAuto", [false]), [false]);
  for (const bad of [[], ["true"], [1], [true, false], [{ on: true }], [null]]) assert.throws(() => remoteArgs("setAppUpdateAuto", bad), /on or off/, JSON.stringify(bad));
  // A team member's device is refused every one of them.
  const team = { roles: [{ id: "r_admin", name: "Admin", perms: { agents: ["view", "chat", "create", "manage"], today: [], skills: [], mcp: [], plugins: [], settings: ["view", "manage"] }, bots: "all" }], groups: [{ id: "g_x", name: "X", roleId: "r_admin" }], members: [{ id: "m_1", name: "Sam", groupId: "g_x" }] };
  const member = { kind: "member", memberId: "m_1", name: "Sam", groupId: "g_x" };
  for (const method of CALLS) assert.match(authorize(member, team, method, method === "setAppUpdateAuto" ? [true] : []), /owner/i, method);
  assert.equal(authorize({ kind: "owner" }, team, "installAppUpdate", []), "");
});

/** A computer with one paired phone whose notifications are on, and a stand-in for the relay's push route. */
async function withPush() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-update-")));
  folders.push(dir);
  const sent: any[] = [];
  const relay = (async (_url: string, init: any) => {
    const items = JSON.parse(JSON.parse(init.body).sends);
    sent.push(...items);
    return new Response(JSON.stringify({ results: items.map(() => ({ status: 200 })) }), { status: 200 });
  }) as unknown as typeof fetch;
  const link = new LinkHost({ dir, backend: new MockBackend({ speed: 0.01 }), port: 0, extraHosts: ["127.0.0.1"], searchPath: [], relay: false, fetch: relay });
  (link as any).relayUrl = () => "https://relay.test";
  await link.setEnabled(true);
  link.setName("Studio server");
  const paired = await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" });
  const client = new LinkClient(paired, { fetch: real, onParts() {}, onState() {} });
  await client.call("link.push.register", { token: "ab".repeat(32), env: "production" }, {});
  return { link, client, paired, sent, settle: () => delay(80), stop: async () => (client.stop(), await link.stop()) };
}
function unseal(paired: Pairing, b: string) {
  const deviceKey = hkdf(agree(unb64u(paired.secretKey), unb64u(paired.serverKey)), utf8(paired.deviceId), "botkins/device/v1");
  const key = hkdf(deviceKey, utf8(paired.deviceId), "botkins/push/v1");
  const bytes = new Uint8Array(Buffer.from(b, "base64"));
  return JSON.parse(fromUtf8(open(key, bytes.subarray(0, 12), bytes.subarray(12), "botkins-push-v1")));
}

test("a newer Botkins is told to the owner's phone once per version, sealed, under the computer's name", async () => {
  const { link, client, paired, sent, settle, stop } = await withPush();
  try {
    assert.equal(link.push.updateAvailable("0.16.5"), 1);
    await settle();
    assert.equal(sent.length, 1);
    const [alert] = sent;
    // What Apple and the relay see: a generic line. What the phone shows: the computer's name and the version.
    assert.deepEqual(alert.payload.aps.alert, { title: "Botkins", body: "An update is available" });
    assert.deepEqual(unseal(paired, alert.payload.b), { t: "Studio server", m: "Botkins 0.16.5 is available.", k: "update" });
    // Once per version, also after the phone registers again; a newer one is told; a non-version never.
    assert.equal(link.push.updateAvailable("0.16.5"), 0);
    await client.call("link.push.register", { token: "ab".repeat(32), env: "production" }, {});
    assert.equal(link.push.updateAvailable("v0.16.5"), 0);
    assert.equal(link.push.updateAvailable("0.16.6"), 1);
    for (const bad of ["", "latest", "1.2", "0.16.7; rm -rf /", null]) assert.equal(link.push.updateAvailable(bad), 0, String(bad));
    // The phone's own choice turns it off.
    await client.call("link.push.prefs", { updates: false });
    assert.equal(link.push.updateAvailable("0.16.8"), 0);
    // A phone registered before the choice existed counts as wanting it.
    const record = link.store.push(paired.deviceId);
    const { updates: _gone, ...older } = record.prefs;
    link.store.setPush(paired.deviceId, { ...record, prefs: older });
    assert.equal(link.push.updateAvailable("0.16.9"), 1);
  } finally {
    await stop();
  }
});

test("a team member's device never hears of an update", async () => {
  const { link, sent, settle, stop } = await withPush();
  try {
    const member = link.store.addDevice({ name: "Member phone", platform: "ios", publicKey: new Uint8Array(32).fill(7), memberId: "m_1", person: "Sam" });
    link.store.setPush(member.id, { token: "cd".repeat(32), env: "production", prefs: { replies: true, requests: true, routines: true, previews: true, activities: true, updates: true }, activities: {} });
    assert.equal(link.push.updateAvailable("0.17.0"), 1, "the owner's phone only");
    await settle();
    assert.deepEqual(sent.map((item) => item.token), ["ab".repeat(32)]);
  } finally {
    await stop();
  }
});

/** The demo computer in one update case, with a paired owner phone. */
async function demo(mode: string) {
  const saved = process.env.BOTKINS_DEV_UPDATE;
  process.env.BOTKINS_DEV_UPDATE = mode;
  const backend = new MockBackend({ speed: 0.01 });
  if (saved === undefined) delete process.env.BOTKINS_DEV_UPDATE;
  else process.env.BOTKINS_DEV_UPDATE = saved;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-update-demo-")));
  folders.push(dir);
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false });
  await link.setEnabled(true);
  const told: string[] = [];
  let restarts = 0;
  backend.updates.onAvailable = (version: string) => void told.push(version);
  backend.updates.onRestart = async () => void restarts++;
  const paired = await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" });
  const client = new LinkClient(paired, { fetch: real, onParts() {}, onState() {} });
  const call = <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args);
  const until = async (check: (state: AppUpdate) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const state = await call<AppUpdate>("appUpdateStatus");
      if (check(state)) return state;
      await delay(10);
    }
    throw new Error("The demo's update never got there.");
  };
  return { backend, call, until, told, restarts: () => restarts, stop: async () => (client.stop(), await link.stop()) };
}

test("the demo installs an update from the phone, restarts, and says how it went", async () => {
  const { backend, call, until, told, restarts, stop } = await demo("available");
  try {
    assert.ok(backend.capabilities.includes("app-update-v1"));
    const first = await call<AppUpdate>("appUpdateStatus");
    assert.deepEqual(first, { status: "available", current: DEMO_VERSION, latest: DEMO_LATEST, canInstall: true, auto: false });
    assert.equal((await call<AppUpdate>("setAppUpdateAuto", true)).auto, true);
    await assert.rejects(call("setAppUpdateAuto", "yes"), /on or off/);
    // A check that finds the newer version tells the phones (link.push.updateAvailable on the real one).
    assert.equal((await call<AppUpdate>("checkAppUpdate")).status, "available");
    assert.deepEqual(told, [DEMO_LATEST]);
    assert.equal((await call<AppUpdate>("installAppUpdate")).status, "downloading");
    const done = await until((state) => !!state.last);
    assert.equal(restarts(), 1, "the link was restarted");
    assert.equal(done.current, DEMO_LATEST);
    assert.equal(done.status, "current");
    assert.deepEqual({ ...done.last, at: undefined }, { at: undefined, from: DEMO_VERSION, to: DEMO_LATEST, ok: true });
    assert.equal(backend.info().version, DEMO_LATEST);
    await assert.rejects(call("installAppUpdate"), /no update to install/);
  } finally {
    await stop();
  }
});

test("the demo's other cases: a rollback, a copy that can't install, a failed check, up to date, and off", async () => {
  const rollback = await demo("rollback");
  try {
    await rollback.call("installAppUpdate");
    const ended = await rollback.until((state) => !!state.last);
    assert.equal(ended.last?.ok, false);
    assert.equal(ended.current, DEMO_VERSION);
    assert.match(lastLine(ended.last) ?? "", /didn't stay up/);
  } finally {
    await rollback.stop();
  }
  const cannot = await demo("cannot");
  try {
    const state = await cannot.call<AppUpdate>("appUpdateStatus");
    assert.equal(state.canInstall, false);
    assert.equal(state.auto, undefined, "a copy that can't install has no switch");
    assert.match(updateLine(state), /docker compose pull/);
    await assert.rejects(cannot.call("installAppUpdate"), /docker compose pull/);
    await assert.rejects(cannot.call("setAppUpdateAuto", true), /can't install updates by itself/);
  } finally {
    await cannot.stop();
  }
  const failing = await demo("error");
  try {
    assert.equal((await failing.call<AppUpdate>("checkAppUpdate")).message, "GitHub could not check for updates (HTTP 503).");
    assert.deepEqual(failing.told, []);
  } finally {
    await failing.stop();
  }
  const current = await demo("current");
  try {
    assert.equal(updateLine(await current.call<AppUpdate>("checkAppUpdate")), "You’re up to date.");
  } finally {
    await current.stop();
  }
  const off = await demo("off");
  try {
    assert.ok(!off.backend.capabilities.includes("app-update-v1"));
  } finally {
    await off.stop();
  }
});
