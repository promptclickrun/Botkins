import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProfileManager } from "../desktop/profile.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "botkins-profile-"));
  const calls = [];
  const api = {
    start: async () => ({ id: "attempt_123", verifier: "private-verifier", code: "123456" }),
    finish: async () => ({ token: "private-token", profileId: "profile-1", deviceId: "device-1", name: "Ada", email: "ada@example.com", avatar: "🦊" }),
    home: async () => ({ profile: { id: "profile-1", name: "Ada", email: "ada@example.com", avatar: "🦊" }, hosts: [], devices: [{ id: "device-1", label: "Mac", current: true }], pending: [] }),
    proof: async (...args) => { calls.push(["proof", ...args]); return "ticket"; },
    putHost: async (...args) => calls.push(["putHost", ...args]),
    update: async (...args) => calls.push(["update", ...args]),
    removeHost: async (...args) => calls.push(["removeHost", ...args]),
    revoke: async (...args) => calls.push(["revoke", ...args]),
  };
  const linkState = { enabled: true, listening: true };
  const local = {
    status: () => ({ ...linkState, serverId: "server-1", serverKey: "public-key", name: "Mac", addresses: ["192.0.2.4"] }),
    setEnabled: async (enabled) => { linkState.enabled = enabled; linkState.listening = enabled; },
    hosts: () => ["192.0.2.4:6365"],
    bindOwnerProfile: async () => { calls.push(["bindOwnerProfile"]); return { serverId: "server-1", serverKey: "public-key", name: "Mac", hosts: ["192.0.2.4:6365"] }; },
    unbindOwnerProfile: async (profileId) => calls.push(["unbindOwnerProfile", profileId]),
  };
  const remote = { list: () => [], dropProfileBound: () => calls.push(["dropProfileBound"]) };
  const protect = { wrap: (text) => "sealed:" + Buffer.from(text).toString("base64"), unwrap: (value) => Buffer.from(value.slice(7), "base64").toString() };
  const manager = new ProfileManager({ file: join(root, "profile.json"), protect, lib: { profileApi: api }, local, remote, workspace: () => true, changed: () => calls.push(["changed"]) });
  return { root, manager, api, calls, local, linkState };
}

test("profile setup protects verifier and session, then enrolls the local host once", async () => {
  const { root, manager, calls } = fixture();
  try {
    assert.equal(manager.status({ existing: true }).migration.needed, true);
    const attempt = await manager.start("Mac");
    assert.deepEqual(attempt, { id: "attempt_123", url: "https://profile.botkins.app/#attempt_123", code: "123456", label: "Mac" });
    assert.equal(manager.status().pending.url, "https://profile.botkins.app/#attempt_123");
    const raw = readFileSync(join(root, "profile.json"), "utf8");
    assert.equal(raw.includes("private-verifier"), false);
    assert.equal(raw.includes("private-token"), false);
    const session = await manager.finish();
    assert.deepEqual(session, { profileId: "profile-1", name: "Ada", email: "ada@example.com", avatar: "🦊", deviceId: "device-1" });
    assert.equal(calls.filter(([name]) => name === "proof").length, 1);
    await manager.refresh();
    assert.equal(calls.filter(([name]) => name === "proof").length, 1);
    assert.equal(manager.status().signedIn, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opt out and sign out revoke the current profile device but preserve the hosted directory", async () => {
  const { root, manager, calls } = fixture();
  try {
    await manager.start();
    await manager.finish();
    await manager.signOut();
    assert.deepEqual(calls.filter(([name]) => name === "revoke").map(([, token, id]) => [token, id]), [["private-token", "device-1"]]);
    assert.equal(calls.some(([name]) => name === "unbindOwnerProfile"), false, "other trusted devices keep the host grant");
    assert.equal(calls.some(([name]) => name === "removeHost"), false);
    assert.equal(manager.status().signedIn, false);
    assert.equal(manager.status({ existing: true }).migration.needed, false);
    await manager.start();
    await manager.finish();
    await manager.optOut();
    assert.equal(manager.status().optedOut, true);
    assert.equal(calls.filter(([name]) => name === "revoke").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an expired session invalidates and drops profile-bound pairings", async () => {
  const { root, manager, api, calls } = fixture();
  try {
    await manager.start();
    await manager.finish();
    api.home = async () => { const error = new Error("expired"); error.status = 401; throw error; };
    await assert.rejects(manager.home(), /expired/);
    assert.equal(manager.status().signedIn, false);
    assert.ok(calls.some(([name]) => name === "dropProfileBound"));
    assert.equal(calls.some(([name]) => name === "unbindOwnerProfile"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without secure storage only local migration choice is persisted", async () => {
  const root = mkdtempSync(join(tmpdir(), "botkins-profile-"));
  try {
    const manager = new ProfileManager({ file: join(root, "profile.json"), lib: { profileApi: { start: async () => ({ id: "a", verifier: "v", code: "123456" }), finish: async () => ({ token: "secret", profileId: "p", deviceId: "d", name: "Ada" }) } } });
    await manager.start();
    const raw = readFileSync(join(root, "profile.json"), "utf8");
    assert.equal(raw.includes("secret"), false);
    assert.equal(raw.includes("verifier"), false);
    const reopened = new ProfileManager({ file: join(root, "profile.json"), lib: { profileApi: {} } });
    assert.equal(reopened.status().signedIn, false);
    assert.ok(reopened.status().pending === null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile setup enables a configured local Link once, honors disable, and disconnects explicitly", async () => {
  const { root, manager, api, calls, linkState } = fixture();
  try {
    linkState.enabled = false;
    linkState.listening = false;
    await manager.start();
    await manager.finish();
    assert.equal(linkState.enabled, true);
    assert.ok(calls.some(([name]) => name === "bindOwnerProfile"));
    manager.noteLocalLinkSetting(false);
    linkState.enabled = false;
    linkState.listening = false;
    await manager.refresh();
    assert.equal(linkState.enabled, false, "an explicit local disable is not undone by refresh");
    await manager.update("Grace", "🌱");
    assert.deepEqual(calls.find(([name]) => name === "update"), ["update", "private-token", "Grace", "🌱"]);
    await manager.disconnectLocal();
    assert.ok(calls.some(([name, profileId]) => name === "unbindOwnerProfile" && profileId === "profile-1"));
    assert.deepEqual(calls.find(([name]) => name === "removeHost"), ["removeHost", "private-token", "server-1"]);
    const proofsBeforeReconnect = calls.filter(([name]) => name === "proof").length;
    await manager.bindAll();
    assert.equal(calls.filter(([name]) => name === "proof").length, proofsBeforeReconnect, "status retries do not republish a disconnected host");
    manager.noteLocalLinkSetting(true);
    linkState.enabled = true;
    linkState.listening = true;
    await manager.reconnectLocal();
    assert.ok(calls.filter(([name]) => name === "proof").length > proofsBeforeReconnect, "reconnect is explicit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent profile connects to the same server share one in-flight connection and recover after failure or sign-out", async () => {
  const root = mkdtempSync(join(tmpdir(), "botkins-profile-"));
  const hosts = [
    { serverId: "server-2", serverKey: "key-2", name: "Studio Mac", hosts: ["192.0.2.20:6365"] },
    { serverId: "server-3", serverKey: "key-3", name: "Mini", hosts: ["192.0.2.30:6365"] },
  ];
  let tokenNum = 0;
  const pendingConnects = [];
  const adopted = [];
  const api = {
    start: async () => ({ id: "attempt_1", verifier: "v", code: "123456" }),
    finish: async () => ({ token: "token-" + (++tokenNum), profileId: "profile-1", deviceId: "device-1", name: "Ada" }),
    home: async () => ({ profile: { id: "profile-1", name: "Ada" }, hosts, devices: [], pending: [] }),
    proof: async () => "ticket",
    revoke: async () => {},
  };
  const lib = {
    profileApi: api,
    profileConnect: (_transport, host, _device, issueTicket) => new Promise((resolve, reject) => {
      pendingConnects.push({ host, issueTicket, resolve, reject });
    }),
  };
  const remote = {
    list: () => [],
    transport: () => ({}),
    dropProfileBound: () => {},
    adoptPairing: (pairing, opts) => {
      adopted.push({ pairing, opts });
      return { id: pairing.serverId, name: opts.name };
    },
  };
  const protect = { wrap: (value) => value, unwrap: (value) => value };
  const manager = new ProfileManager({ file: join(root, "profile.json"), protect, lib, local: { status: () => ({}) }, remote });

  try {
    await manager.start();
    await manager.finish();

    // Two concurrent connects for the same serverId share one in-flight connection.
    const first = manager.connect("server-2");
    const second = manager.connect("server-2");
    assert.strictEqual(first, second, "concurrent connects to one server reuse the same promise");
    assert.equal(pendingConnects.length, 1, "only one profileConnect starts for the same serverId");

    // A different serverId connects concurrently without waiting on the first.
    const other = manager.connect("server-3");
    assert.notStrictEqual(first, other);
    assert.equal(pendingConnects.length, 2);

    pendingConnects[0].resolve({ serverId: "server-2", serverKey: "key-2", secretKey: "sec-2" });
    pendingConnects[1].resolve({ serverId: "server-3", serverKey: "key-3", secretKey: "sec-3" });

    const [res1, res2, res3] = await Promise.all([first, second, other]);
    assert.deepEqual(res1, { id: "server-2", name: "Studio Mac" });
    assert.deepEqual(res2, res1);
    assert.deepEqual(res3, { id: "server-3", name: "Mini" });
    assert.equal(adopted.length, 2);

    // After failure settles, a subsequent retry starts a fresh connect.
    const failedA = manager.connect("server-2");
    const failedB = manager.connect("server-2");
    assert.strictEqual(failedA, failedB);
    assert.equal(pendingConnects.length, 3);
    pendingConnects[2].reject(new Error("offline"));
    await assert.rejects(failedA, /offline/);
    await assert.rejects(failedB, /offline/);

    const retry = manager.connect("server-2");
    assert.equal(pendingConnects.length, 4);
    pendingConnects[3].resolve({ serverId: "server-2", serverKey: "key-2", secretKey: "sec-2b" });
    assert.deepEqual(await retry, { id: "server-2", name: "Studio Mac" });

    // Signing out and back in does not reuse a stale session's in-flight promise.
    const stale = manager.connect("server-2");
    assert.equal(pendingConnects.length, 5);
    await manager.signOut();
    await manager.start();
    await manager.finish();

    const fresh = manager.connect("server-2");
    assert.notStrictEqual(fresh, stale);
    assert.equal(pendingConnects.length, 6);
    pendingConnects[4].resolve({ serverId: "server-2", serverKey: "key-2", secretKey: "stale" });
    await assert.rejects(stale, /session ended/);
    pendingConnects[5].resolve({ serverId: "server-2", serverKey: "key-2", secretKey: "fresh" });
    assert.deepEqual(await fresh, { id: "server-2", name: "Studio Mac" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
