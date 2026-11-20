import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessBackend } from "../desktop/headless/backend.mjs";
import { listenWorkspace, workspaceRequest } from "../desktop/headless/transport.mjs";
import { workspaceActions } from "../desktop/headless/workspace.mjs";
import { phonePage } from "../desktop/phonepage.mjs";
import { REMOTE_METHODS } from "../desktop/link/methods.mjs";
import { LinkHost } from "../desktop/link/index.mjs";
import { LinkClient, isRelayHost, pair, parsePairingUrl, relayFetch } from "../desktop/remote/link-client.mjs";
import { Workspace } from "./starter.mjs";

const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" && "The Docker host uses Unix sockets." }, fn);

function stubWorkspace() {
  let change;
  const state = { bots: [], chats: [], runs: [], settings: {} };
  const displays = [{ id: "1", width: 1200, height: 800 }];
  const calls = [];
  const backend = {
    snapshot: () => state,
    capabilities: ["models-v2"],
    subscribe(listener) { change = listener; return () => { change = null; }; },
    call: (name, args) => { calls.push([name, ...args]); return "ok"; },
    screen: {
      displays: async () => displays,
      permissions: async () => ({ screenRecording: true, accessibility: true }),
      capture: async () => ({ jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: 1, height: 1 }),
    },
  };
  return { backend, state, displays, calls, changed: () => change() };
}

test("the public link reads workspace changes and loses display availability on disconnect", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  const socket = join(dir, "workspace.sock");
  const workspace = stubWorkspace();
  const actions = workspaceActions(workspace.backend, () => {});
  const close = await listenWorkspace(socket, actions.dispatch);
  t.after(() => { close(); actions.unsubscribe(); rmSync(dir, { recursive: true, force: true }); });
  const { backend, refresh } = headlessBackend((method, args) => workspaceRequest(socket, method, args), "test");
  let changes = 0;
  backend.subscribe(() => changes++);
  await refresh();
  assert.deepEqual(backend.displayStatus(), { available: true, kind: "xvfb" });
  await refresh();
  assert.equal(changes, 1);
  workspace.state.bots.push({ id: "pip" });
  workspace.changed();
  await refresh();
  assert.deepEqual(backend.snapshot().bots, [{ id: "pip" }]);
  const reply = await backend.call("renameChat", ["c", "New name"]);
  assert.equal(reply, "ok");
  assert.deepEqual(workspace.calls, [["renameChat", "c", "New name"]]);
  assert.deepEqual((await backend.screen.capture({})).jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  workspace.displays.length = 0;
  await refresh();
  assert.equal(backend.displayStatus().available, false);
  workspace.displays.push({ id: "1", width: 800, height: 600 });
  await refresh();
  assert.equal(backend.displayStatus().available, true);
  close();
  await refresh();
  assert.equal(backend.displayStatus().available, false);
});

test("the headless server opens and renews a private pairing file and clears it after direct pairing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  const owner = join(dir, "owner", "pairing.json");
  const actions = workspaceActions(stubWorkspace().backend, () => {});
  const socket = join(dir, "backend.sock");
  const close = await listenWorkspace(socket, actions.dispatch);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../desktop/headless/host.mjs", import.meta.url))], {
    env: { ...process.env, BOTKINS_DATA_DIR: join(dir, "link"), BOTKINS_OWNER_PAIRING_FILE: owner, BOTKINS_WORKSPACE_SOCKET: socket, BOTKINS_PAIR_ADDRESS: "", BOTKINS_LINK_PORT: "0" },
    stdio: "ignore",
  });
  const exit = once(child, "exit");
  async function pairing(previous) {
    for (let i = 0; i < 200 && child.exitCode === null; i++) {
      try {
        const value = JSON.parse(readFileSync(owner, "utf8"));
        if (value.code !== previous) return value;
      } catch (error) {
        // Renewal removes the old file before publishing the next code.
        if (error.code !== "ENOENT") throw error;
      }
      await delay(25);
    }
    throw new Error("The server did not publish a fresh pairing file.");
  }
  try {
    const first = await pairing();
    assert.equal(statSync(owner).mode & 0o777, 0o600);
    child.kill("SIGUSR2");
    const next = await pairing(first.code);
    const address = new URL(next.url).searchParams.get("h");
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    assert.equal(next.link, null);
    await pair(fetch, { hosts: [address], code: next.code }, { name: "Fixture phone", platform: "ios" });
    assert.equal(existsSync(owner), false);
    assert.equal(JSON.parse(readFileSync(join(dir, "link", "link.json"), "utf8")).devices.length, 1);
  } finally {
    child.kill("SIGTERM");
    await exit;
    close();
    actions.unsubscribe();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with BOTKINS_RELAY_URL the headless server pairs a phone through a self-hosted relay alone", async () => {
  const { createRelay } = await import("../../mobile/relay/node/server.mjs");
  const relay = createRelay({ limits: false, pushUpstream: "off" });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayUrl = "http://127.0.0.1:" + relay.address().port;
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  const owner = join(dir, "owner", "pairing.json");
  const actions = workspaceActions(stubWorkspace().backend, () => {});
  const socket = join(dir, "backend.sock");
  const close = await listenWorkspace(socket, actions.dispatch);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../desktop/headless/host.mjs", import.meta.url))], {
    env: { ...process.env, BOTKINS_DATA_DIR: join(dir, "link"), BOTKINS_OWNER_PAIRING_FILE: owner, BOTKINS_WORKSPACE_SOCKET: socket, BOTKINS_PAIR_ADDRESS: "", BOTKINS_LINK_PORT: "0", BOTKINS_RELAY_URL: relayUrl, BOTKINS_PAIR_TTL_MS: String(30 * 60_000) },
    stdio: "ignore",
  });
  const exit = once(child, "exit");
  try {
    let value;
    for (let i = 0; i < 400 && child.exitCode === null; i++) {
      if (existsSync(owner)) {
        value = JSON.parse(readFileSync(owner, "utf8"));
        if (value.relay?.connected) break;
      }
      await delay(25);
    }
    assert.equal(value?.relay?.connected, true, "the server reached the relay");
    assert.ok(value.expiresAt - Date.now() > 25 * 60_000, "the pairing lasts as long as asked");
    // Only the relay's entry: no container address that a phone could never reach.
    const hosts = new URL(value.url).searchParams.get("h").split(",");
    assert.equal(hosts.length, 1);
    assert.ok(isRelayHost(hosts[0]));
    // The web link carries the same pairing query, in the fragment only.
    const link = new URL(value.link);
    assert.equal(link.origin + link.pathname, relayUrl + "/pair");
    assert.equal(link.search, "");
    assert.equal(link.hash.slice(1), new URL(value.url).search.slice(1));
    // A phone that can't reach the server directly pairs through the relay.
    const away = () => Promise.reject(new TypeError("Network request failed"));
    const target = parsePairingUrl(value.url);
    await pair(relayFetch(away, { idleMs: 500 }), target, { name: "Away phone", platform: "ios" });
    for (let i = 0; i < 200 && existsSync(owner); i++) await delay(25);
    assert.equal(existsSync(owner), false);
    assert.equal(JSON.parse(readFileSync(join(dir, "link", "link.json"), "utf8")).devices.length, 1);
  } finally {
    child.kill("SIGTERM");
    await exit;
    close();
    actions.unsubscribe();
    await new Promise((resolve) => relay.close(resolve));
    relay.closeAllConnections?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with BOTKINS_RELAY_OWN a phone that only has the server's own relay sets the screen level and sees the display", async () => {
  const { createRelay } = await import("../../mobile/relay/node/server.mjs");
  const relay = createRelay({ limits: false, pushUpstream: "off" });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayUrl = "http://127.0.0.1:" + relay.address().port;
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  const owner = join(dir, "owner", "pairing.json");
  const actions = workspaceActions(stubWorkspace().backend, () => {});
  const socket = join(dir, "backend.sock");
  const close = await listenWorkspace(socket, actions.dispatch);
  const start = (own) =>
    spawn(process.execPath, [fileURLToPath(new URL("../desktop/headless/host.mjs", import.meta.url))], {
      env: { ...process.env, BOTKINS_DATA_DIR: join(dir, own ? "own" : "other"), BOTKINS_OWNER_PAIRING_FILE: owner, BOTKINS_WORKSPACE_SOCKET: socket, BOTKINS_PAIR_ADDRESS: "", BOTKINS_LINK_PORT: "0", BOTKINS_RELAY_URL: relayUrl, ...(own && { BOTKINS_RELAY_OWN: "1" }) },
      stdio: "ignore",
    });
  const away = () => Promise.reject(new TypeError("Network request failed"));
  /** Pairs through the relay alone, with a presence key, and opens a session. */
  const meet = async (child) => {
    let value;
    for (let i = 0; i < 400 && child.exitCode === null; i++) {
      if (existsSync(owner)) {
        value = JSON.parse(readFileSync(owner, "utf8"));
        if (value.relay?.connected) break;
      }
      await delay(25);
    }
    assert.equal(value?.relay?.connected, true, "the server reached the relay");
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const fetcher = relayFetch(away, { idleMs: 500 });
    const pairing = await pair(fetcher, parsePairingUrl(value.url), { name: "Away phone", platform: "ios", presenceKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64url") });
    const parts = {};
    const phone = new LinkClient(pairing, { fetch: fetcher, onState() {}, onParts: (next) => Object.assign(parts, next) });
    phone.start();
    for (let i = 0; i < 400 && !(parts.meta && parts.host); i++) await delay(25);
    return { phone, parts, pairing, key };
  };
  const stop = async (child) => {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
    rmSync(owner, { force: true });
  };
  let child = start(true);
  try {
    const { phone, parts, pairing, key } = await meet(child);
    assert.equal(phone.route, "relay");
    assert.ok(parts.meta.capabilities.includes("screen-grant-v1") && parts.meta.capabilities.includes("screen-grant-relay-v1"));
    assert.deepEqual(parts.host.display, { available: true, kind: "xvfb" });
    assert.equal((await phone.call("link.screen.info")).canView, false);
    const { ticket } = await phone.call("link.screen.grant.begin", "view");
    const challenge = JSON.stringify(["botkins-screen-grant-v1", pairing.serverId, pairing.deviceId, "view", ticket]);
    assert.deepEqual(await phone.call("link.screen.grant.confirm", ticket, sign("sha256", Buffer.from(challenge), key.privateKey).toString("base64url")), { screen: "view" });
    const shot = await phone.call("link.screen.frame", { display: "1" });
    assert.equal(shot.jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"));
    assert.deepEqual(await phone.call("link.screen.revoke"), { screen: "off" });
    phone.stop();
    await stop(child);

    // Without it the same relay is only a relay: the level can't be set through it.
    child = start(false);
    const plain = await meet(child);
    assert.equal(plain.parts.meta.capabilities.includes("screen-grant-relay-v1"), false);
    await assert.rejects(plain.phone.call("link.screen.grant.begin", "view"), /can't be changed through the relay/);
    plain.phone.stop();
  } finally {
    await stop(child);
    close();
    actions.unsubscribe();
    await new Promise((resolve) => relay.close(resolve));
    relay.closeAllConnections?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent tools, generic calls, the workspace socket and the virtual desktop cannot enable the public screen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  const socket = join(dir, "work.sock");
  const workspace = stubWorkspace();
  const actions = workspaceActions(workspace.backend, () => {});
  const close = await listenWorkspace(socket, actions.dispatch);
  t.after(() => { close(); actions.unsubscribe(); rmSync(dir, { recursive: true, force: true }); });
  const app = new Workspace(join(dir, "data"), () => {}, () => {});
  const chat = app.chat(app.createChat("pip"));
  const tools = app.sessionTools(app.bot("pip"), chat, { id: "run" }, {});
  const publicHost = headlessBackend((method, args) => workspaceRequest(socket, method, args), "test");
  for (const method of ["setPhoneScreen", "setScreenMode", "link.screen.grant.begin", "link.screen.grant.confirm", "link.screen.revoke", "startPhonePairing"]) {
    assert.equal(REMOTE_METHODS.has(method), false);
    assert.equal(tools.some((tool) => tool.name === method), false);
    await assert.rejects(workspaceRequest(socket, method, ["control"]), /Unknown workspace action/);
    await assert.rejects(workspaceRequest(socket, "call", [method, ["control"]]), /Unknown workspace call/);
    await assert.rejects(publicHost.backend.call(method, ["control"]), /Unknown workspace call/);
  }
  const local = phonePage({ managed: true, link: () => { throw Error("Reached the link"); } });
  assert.throws(() => local.setPhoneScreen("control"), /Manage phone access on the headless host/);
  assert.throws(() => local.startPhonePairing(), /Manage phone access on the headless host/);
  assert.deepEqual(workspace.calls, []);
});

test("a paired phone grants view and control across the workspace socket and can immediately revoke them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  const socket = join(dir, "work.sock");
  const input = [];
  const workspace = stubWorkspace();
  const actions = workspaceActions(workspace.backend, (job) => input.push(...job.events));
  const close = await listenWorkspace(socket, actions.dispatch);
  const { backend, refresh, screenInput } = headlessBackend((method, args) => workspaceRequest(socket, method, args), "test");
  const host = new LinkHost({ dir, backend, screenInput, relay: false, port: 0 });
  let phone;
  try {
    await refresh();
    await host.setEnabled(true);
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const identity = { name: "Fixture phone", platform: "ios", presenceKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64url") };
    const pairing = await pair(fetch, { hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code }, identity);
    phone = new LinkClient(pairing, { fetch, onState() {}, onParts() {} });
    const grant = async (level) => {
      const { ticket } = await phone.call("link.screen.grant.begin", level);
      const challenge = JSON.stringify(["botkins-screen-grant-v1", pairing.serverId, pairing.deviceId, level, ticket]);
      const signature = sign("sha256", Buffer.from(challenge), key.privateKey).toString("base64url");
      assert.deepEqual(await phone.call("link.screen.grant.confirm", ticket, signature), { screen: level });
    };
    const click = [{ type: "click", x: 0.5, y: 0.5 }];
    assert.equal((await phone.call("link.screen.info")).canView, false);
    const { ticket } = await phone.call("link.screen.grant.begin", "control");
    await assert.rejects(phone.call("link.screen.grant.confirm", ticket, ""), /confirm/);
    assert.equal(host.status().screen.mode, "off");
    await grant("view");
    const shot = await phone.call("link.screen.frame", { display: "1" });
    assert.equal(shot.jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"));
    await assert.rejects(phone.call("link.screen.input", "1", click), /control/i);
    assert.deepEqual(input, []);
    await grant("control");
    await phone.call("link.screen.input", "1", click);
    assert.equal(input[0].type, "click");
    await phone.call("link.screen.revoke");
    await assert.rejects(phone.call("link.screen.frame", { display: "1" }), /off/i);
  } finally {
    phone?.stop();
    await host.stop();
    close();
    actions.unsubscribe();
    rmSync(dir, { recursive: true, force: true });
  }
});
