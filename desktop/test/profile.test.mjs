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
