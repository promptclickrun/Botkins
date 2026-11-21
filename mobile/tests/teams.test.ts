import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { random } from "../link-host/crypto.mjs";
import { REMOTE_METHODS } from "../link-host/methods.mjs";
import { LinkStore } from "../link-host/store.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { Push } from "../link-host/push.mjs";
import { newRelayKey } from "../link-host/relay.mjs";
import { LinkHost } from "../link-host/index.mjs";
import { type FetchLike, LinkClient, LinkError, checkJoin, findInvite, join as joinTeam, pair, startJoin, type JoinAttempt, type LinkState } from "../src/link/client";
import { newKeyPair as newClientKeyPair, b64u as clientB64u } from "../src/link/crypto";
import { FakeRelay } from "./fake-relay";
import { formatCode as formatPairCode, normalizeCode as normalizeClientCode, parseJoinUrl } from "../src/link/pairing";
import { isRelayHost, relayFetch } from "../src/link/relay";
import {
  TEAM_METHODS,
  authorize,
  cleanRole,
  filterParts,
  formatCode,
  normalizeCode,
} from "../link-host/team.mjs";

test("team methods cover every remote method and invite codes are easy to type", () => {
  for (const method of REMOTE_METHODS) assert.ok(TEAM_METHODS[method], method + " has a team policy");
  for (const method of ["link.sync", "link.messages", "link.team.get"]) assert.ok(TEAM_METHODS[method], method + " has a team policy");
  const server = readFileSync(join(import.meta.dirname, "../link-host/server.mjs"), "utf8");
  for (const match of server.matchAll(/"(link\.[^"]+)":/g)) assert.ok(TEAM_METHODS[match[1]], match[1] + " is dispatched but has no team policy");

  assert.equal(normalizeCode(" il o-23456 7890 "), "110234567890");
  assert.equal(formatCode("abcdefghij"), "ABCDE-FGH1J");
  assert.deepEqual(cleanRole({
    id: "r_test123456",
    name: " Reader ",
    perms: { agents: ["manage"], today: [], skills: ["read"], mcp: [], plugins: [], settings: [] },
    bots: [],
  }), {
    id: "r_test123456",
    name: "Reader",
    perms: { agents: ["view", "manage"], today: [], skills: ["read"], mcp: [], plugins: [], settings: [] },
    bots: [],
  });
});

test("authorization checks role, bot visibility, ownership and member-safe preferences", () => {
  const team = {
    roles: [{ id: "r_member", name: "Member", perms: { agents: ["view", "chat"], today: ["view"], skills: ["read"], mcp: [], plugins: [], settings: ["view", "manage"] }, bots: ["bot-visible"] }],
    groups: [{ id: "g_member", name: "Members", roleId: "r_member" }],
    members: [{ id: "m_one", name: "Sam", groupId: "g_member" }],
  };
  const principal = { kind: "member", memberId: "m_one", name: "Sam", groupId: "g_member" };
  const chats = [
    { id: "chat-own", botId: "bot-visible", createdBy: "m_one" },
    { id: "chat-owner", botId: "bot-visible" },
  ];
  const requests = [
    { id: "req-question", chatId: "chat-own", kind: "question" },
    { id: "req-secure", chatId: "chat-own", kind: "secure" },
  ];
  const lookups = {
    bot: (id: string) => [{ id: "bot-visible" }, { id: "bot-hidden" }].find((bot) => bot.id === id),
    chat: (id: string) => chats.find((chat) => chat.id === id),
    request: (id: string) => requests.find((request) => request.id === id),
    run: () => null,
  };

  assert.equal(authorize(principal, team, "createChat", ["bot-visible"], lookups), "");
  assert.match(authorize(principal, team, "createChat", ["bot-hidden"], lookups), /bot/);
  assert.equal(authorize(principal, team, "send", ["chat-own", "Hello"], lookups), "");
  assert.match(authorize(principal, team, "send", ["chat-owner", "Hello"], lookups), /chat/);
  assert.equal(authorize(principal, team, "respond", ["req-question", { action: "accept", value: "yes" }], lookups), "");
  assert.match(authorize(principal, team, "respond", ["req-secure", { action: "accept" }], lookups), /owner|approve/i);
  assert.equal(authorize(principal, team, "setPreferences", [{ appearance: { theme: "dark" }, readAloud: true }], lookups), "");
  assert.match(authorize(principal, team, "setPreferences", [{ approval: "all" }], lookups), /settings|preference/i);
  assert.equal(authorize(principal, team, "link.push.register", [{ token: "x" }], lookups), "");
  assert.match(authorize(principal, team, "link.devices.list", [], lookups), /owner/);
});

test("member parts contain only visible, owned and scrubbed data", () => {
  const team = {
    name: "Design crew",
    roles: [{ id: "r_member", name: "Member", perms: { agents: ["view", "chat"], today: ["view"], skills: ["read", "use"], mcp: ["view"], plugins: ["view"], settings: ["view", "manage"] }, bots: ["bot-visible"] }],
    groups: [{ id: "g_member", name: "Members", roleId: "r_member" }],
    members: [{ id: "m_one", name: "Sam", groupId: "g_member" }],
  };
  const principal = { kind: "member", memberId: "m_one", name: "Sam", groupId: "g_member" };
  const ownerOnly = {
    meta: { capabilities: ["teams-v1"], name: "Owner Mac" },
    bots: [{ id: "bot-visible", name: "Visible" }, { id: "bot-hidden", name: "Hidden" }],
    chats: [{ id: "chat-own", botId: "bot-visible", createdBy: "m_one" }, { id: "chat-owner", botId: "bot-hidden", title: "Owner chat" }],
    live: {
      streams: { "chat-own": "mine", "chat-owner": "secret stream" },
      intents: { "chat-own": "Working", "chat-owner": "Owner" },
      thinking: {},
      speakers: {},
      queued: { "chat-own": [], "chat-owner": [{ id: "q", text: "secret" }] },
      requests: [{ id: "r1", chatId: "chat-own", kind: "permission", title: "Approve" }, { id: "r2", chatId: "chat-owner", kind: "question" }],
      active: ["chat-own", "chat-owner"],
    },
    runs: [{ id: "run-own", chatId: "chat-own" }, { id: "run-owner", chatId: "chat-owner" }],
    "chat:chat-own": { id: "chat-own", messages: [{ role: "user", text: "mine" }] },
    "chat:chat-owner": { id: "chat-owner", messages: [{ role: "user", text: "owner secret" }] },
    panels: [{ id: "panel-1" }],
    board: [{ id: "board-1" }],
    skills: { skills: [{ name: "review", path: "/secret/skills/review" }], folders: [{ id: "f1", path: "/secret/skills" }], plugins: [], disabled: [] },
    mcp: [{ id: "m1", name: "local", command: "node secret.mjs", args: ["--token", "secret"], env: ["TOKEN"], cwd: "/secret", headers: ["Authorization"], url: "https://example.com/mcp" }],
    plugins: [{ id: "p1", folder: "/secret/plugin", contents: { hooks: [{ event: "start", command: "secret command" }] }, config: [{ key: "TOKEN", secret: true, set: true, value: "secret value", default: "secret default" }, { key: "SITE", secret: false, value: "https://example.com" }] }],
    settings: { appearance: { theme: "dark" }, approval: "all", teamwork: true },
    credentials: [{ name: "Token", value: "secret credential" }],
    phones: { p1: { token: "secret token" } },
    asks: [{ id: "ask-owner" }],
    voice: { providers: { openai: { hasKey: true } } },
    host: { screen: "control" },
    projects: [{ folder: "/secret/project" }],
    tasks: [{ body: "owner task" }],
  };

  const filtered = filterParts(ownerOnly, principal, team);
  assert.equal(filtered.bots.length, 1);
  assert.deepEqual(filtered.chats.map((chat: any) => chat.id), ["chat-own"]);
  assert.deepEqual(filtered.live.active, ["chat-own"]);
  assert.deepEqual(filtered.live.requests, []);
  assert.deepEqual(filtered.runs.map((run: any) => run.id), ["run-own"]);
  assert.equal(filtered["chat:chat-own"].id, "chat-own");
  assert.equal(filtered["chat:chat-owner"], null);
  assert.deepEqual(filtered.panels, ownerOnly.panels);
  assert.deepEqual(filtered.board, ownerOnly.board);
  for (const value of ["credentials", "phones", "asks", "voice", "host", "projects", "tasks"]) assert.equal(value in filtered, false, value + " is absent");
  const safe = JSON.stringify(filtered);
  for (const secret of ["secret stream", "secret command", "secret value", "secret default", "secret credential", "secret token", "/secret"]) assert.ok(!safe.includes(secret), secret + " is removed");
  assert.equal(filtered.plugins[0].config[1].value, "https://example.com", "ordinary plugin settings stay visible");
  assert.deepEqual(filtered.settings, { appearance: { theme: "dark" } });
  assert.deepEqual(filtered.meta.you, { kind: "member", memberId: "m_one", name: "Sam" });
  assert.equal(filterParts(ownerOnly, { kind: "owner" }, team), ownerOnly);
});

test("the store migrates teams and keeps owner and member device limits separate", () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-teams-store-"));
  try {
    const store = new LinkStore(dir);
    assert.equal(store.data.team.name, "My team");
    assert.deepEqual(store.data.team.groups, [{ id: "g_everyone", name: "Everyone", roleId: "r_guest" }]);
    assert.deepEqual(store.data.team.roles.find((role: any) => role.id === "r_guest").bots, []);
    const file = join(dir, "link.json");
    store.set({ name: "Studio" });
    const old = JSON.parse(readFileSync(file, "utf8"));
    delete old.team;
    writeFileSync(file, JSON.stringify(old));
    const migrated = new LinkStore(dir);
    assert.equal(migrated.data.team.roles[0].id, "r_guest");
    assert.equal(migrated.data.team.requests.length, 0);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).team.roles[0].id, "r_guest", "the migration is persisted");

    migrated.data.devices = [];
    for (let i = 0; i < 20; i++) migrated.addDevice({ name: "Owner " + i, platform: "ios", publicKey: random(32) });
    assert.throws(() => migrated.addDevice({ name: "Too many owners", platform: "ios", publicKey: random(32) }), /20|Too many/);
    for (let i = 0; i < 60; i++) migrated.addDevice({ name: "Member " + i, platform: "ios", publicKey: random(32), memberId: "m_one" });
    assert.throws(() => migrated.addDevice({ name: "Too many members", platform: "ios", publicKey: random(32), memberId: "m_one" }), /60|Too many/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("join links parse in app and web forms with the same invite code", () => {
  const key = "A".repeat(43);
  assert.deepEqual(parseJoinUrl("botkins://join?c=il-o123-4567&k=" + key), { code: "1101234567", serverKey: key });
  assert.deepEqual(parseJoinUrl("https://relay.botkins.app/join#c=12345-67890&k=" + key), { code: "1234567890", serverKey: key });
  assert.equal(parseJoinUrl("http://relay.botkins.app/join#c=12345-67890&k=" + key), null);
  assert.equal(normalizeClientCode(" o-i l 12-3456 "), "011123456");
  assert.equal(formatPairCode("1234567890"), "12345-67890");
});

test("an approved member is authorized, sees only their chat, and is revoked with the member", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-teams-host-"));
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, relay: false, port: 0, extraHosts: ["127.0.0.1"] });
  const clients: LinkClient[] = [];
  try {
    await link.setEnabled(true);
    const fetcher = fetch as unknown as FetchLike;
    const ownerPairing = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" });
    const owner = new LinkClient(ownerPairing, { fetch: fetcher, onParts() {}, onState() {} });
    clients.push(owner);
    const guest = structuredClone(link.store.data.team.roles.find((role: any) => role.id === "r_guest"));
    guest.bots = "all";
    await owner.call("link.team.saveRole", guest);
    const invite = await owner.call<any>("link.team.createInvite", { groupId: "g_everyone", days: 7, maxUses: 1 });
    const hello = await (await (fetch as any)("http://127.0.0.1:" + link.port + "/botkins/v1/hello")).json();
    assert.equal(hello.join, true, "a live invite is advertised without its code");
    const target = { hosts: ["127.0.0.1:" + link.port], code: invite.code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name };
    let requestEvent: any = null;
    link.once("joinRequest", (event) => (requestEvent = event));
    const started = await startJoin(fetcher, target, { name: "Sam's phone", platform: "ios", kind: "phone" });
    assert.equal(started.result.status, "pending");
    if (started.result.status !== "pending") throw new Error("not pending");
    assert.equal(requestEvent?.id, started.result.requestId);
    await owner.call("link.team.approve", started.result.requestId);
    const checked = await checkJoin(fetcher, started.attempt);
    assert.equal(checked.status, "approved");
    if (checked.status !== "approved") throw new Error("not approved");
    assert.equal(checked.pairing.member, true);

    const parts: Record<string, any> = {};
    const states: LinkState[] = [];
    const client = new LinkClient(checked.pairing, { fetch: fetcher, onParts: (next) => Object.assign(parts, next), onState: (state) => states.push(state) });
    clients.push(client);
    client.start();
    const until = async (test: () => boolean, label: string) => {
      const end = Date.now() + 6000;
      while (!test()) {
        if (Date.now() > end) throw new Error("Timed out waiting for " + label);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await until(() => Array.isArray(parts.bots), "member parts");
    assert.deepEqual(parts.meta.you, { kind: "member", memberId: link.team().members[0].id, name: "Sam's phone" });
    assert.equal(parts.bots.length, backend.state.bots.length);
    assert.deepEqual(parts.chats, []);
    await assert.rejects(client.call("addBot", { name: "Nope", role: "", instructions: "", face: "idle" }), /role/i);
    const chatId = await client.call<string>("createChat", "bot-mira");
    client.watch([chatId]);
    await until(() => parts["chat:" + chatId]?.id === chatId, "own chat");
    const chat = backend.state.chats.find((item: any) => item.id === chatId);
    assert.equal(chat.createdBy, link.team().members[0].id);
    assert.ok(!parts.chats.some((item: any) => item.id !== chatId));
    const memberId = link.team().members[0].id;
    // A member may leave on their own; leaving from their last device takes them off the team.
    assert.equal(await client.call("link.unpair"), true);
    await until(() => !link.team().members.some((item: any) => item.id === memberId), "member left");
    assert.ok(!link.store.data.devices.some((device: any) => device.memberId === memberId));
    await assert.rejects(owner.call("link.team.removeMember", memberId), /no longer on the team/);
  } finally {
    for (const client of clients) client.stop();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("join pushes go to owner devices, and a chat's pushes only to its people", async () => {
  const sent: any[] = [];
  const relayKey = newRelayKey();
  const devices = [
    { id: "owner", name: "Owner", kind: "phone", publicKey: "a".repeat(43) },
    { id: "member", name: "Member", kind: "phone", memberId: "m_one", publicKey: "b".repeat(43) },
  ];
  const records = new Map(devices.map((device) => [device.id, { token: "a".repeat(64), env: "sandbox", prefs: { replies: true, requests: true, routines: true, previews: true, activities: true }, activities: {} }]));
  const fake = {
    data: { devices, looks: {}, relay: { enabled: true } },
    relayKey: () => relayKey,
    push: (id: string) => records.get(id),
    setPush() {},
    name: "Team",
  };
  const state = {
    chats: [{ id: "owner-chat", botId: "b1" }, { id: "member-chat", botId: "b1", createdBy: "m_one" }],
    bots: [{ id: "b1", name: "Bot" }],
    runs: [
      { id: "owner-run", chatId: "owner-chat", status: "Working", finished: Date.now(), time: Date.now(), title: "Owner" },
      { id: "member-run", chatId: "member-chat", status: "Working", finished: Date.now(), time: Date.now(), title: "Member" },
    ],
    requests: [],
  };
  const push = new Push({
    store: fake,
    deviceKey: () => random(32),
    relayUrl: () => "https://relay.test",
    snapshot: () => state,
    fetch: async (_url: string, init: any) => {
      sent.push(...JSON.parse(JSON.parse(init.body).sends));
      return { ok: true, status: 204, json: async () => ({ results: [] }) };
    },
  });
  push.look();
  state.runs[0].status = "Failed";
  state.runs[1].status = "Failed";
  push.look();
  await new Promise((resolve) => setTimeout(resolve, 10));
  // "team-people-v1": the owner hears of the owner's chat and the member of theirs; a member's chat is no longer the owner's to hear of.
  assert.equal(sent.filter((item) => item.type === "alert").length, 2, "each person gets only their own chat");
  assert.ok(sent.every((item) => item.payload.b));
  sent.length = 0;
  // Invited to the member's chat, the owner hears of it too; an approval there reaches the owner either way.
  const invitedPush = new Push({
    store: fake,
    deviceKey: () => random(32),
    relayUrl: () => "https://relay.test",
    snapshot: () => state,
    people: (chat: any, person: string) => (chat.createdBy || "owner") === person || (chat.id === "member-chat" && person === "owner"),
    fetch: async (_url: string, init: any) => {
      sent.push(...JSON.parse(JSON.parse(init.body).sends));
      return { ok: true, status: 204, json: async () => ({ results: [] }) };
    },
  });
  state.runs.forEach((run) => (run.status = "Working"));
  invitedPush.look();
  state.runs.forEach((run) => (run.status = "Failed"));
  invitedPush.look();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.filter((item) => item.type === "alert").length, 3, "the invited owner hears of the member's chat as well");
  invitedPush.dispose();
  sent.length = 0;
  push.teamJoin({ name: "New member" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.filter((item) => item.type === "alert").length, 1, "only the owner gets the join request");
  push.dispose();
});

test("join requests can be denied or refused while preserving the same client key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-teams-join-status-"));
  const link = new LinkHost({ dir, backend: new MockBackend({ speed: 0.01 }), relay: false, port: 0, extraHosts: ["127.0.0.1"] });
  const fetcher = fetch as unknown as FetchLike;
  try {
    await link.setEnabled(true);
    const key = Buffer.from(link.store.data.keys.publicKey).toString("base64url");
    const invite = await link.createInvite({ groupId: "g_everyone", days: 1, maxUses: 5 });
    const target = { hosts: ["127.0.0.1:" + link.port], code: invite.code, serverId: link.status().serverId, serverKey: key };
    const pending = await startJoin(fetcher, target, { name: "Deny me", platform: "ios", kind: "phone" });
    assert.equal(pending.result.status, "pending");
    if (pending.result.status !== "pending") throw new Error("pending");
    assert.equal(pending.attempt.keys.publicKey, (await checkJoin(fetcher, pending.attempt)).status === "pending" ? pending.attempt.keys.publicKey : "wrong");
    await link.deny(pending.result.requestId);
    assert.equal((await checkJoin(fetcher, pending.attempt)).status, "denied");

    const revoked = await link.createInvite({ groupId: "g_everyone", days: 1, maxUses: 1 });
    await link.revokeInvite(revoked.id);
    await assert.rejects(startJoin(fetcher, { ...target, code: revoked.code }, { name: "Revoked", platform: "ios" }), (error) => error instanceof LinkError && error.code === "join_closed");
    const expired = await link.createInvite({ groupId: "g_everyone", days: 1, maxUses: 1 });
    link.store.data.team.invites.find((item: any) => item.id === expired.id).expiresAt = Date.now() - 1;
    await assert.rejects(startJoin(fetcher, { ...target, code: expired.code }, { name: "Expired", platform: "ios" }), (error) => error instanceof LinkError && error.code === "join_closed");

    const ownerKeys = newClientKeyPair();
    link.store.addDevice({ name: "Owner key", platform: "ios", publicKey: ownerKeys.publicKey });
    const ownerAttempt: JoinAttempt = {
      target,
      device: { name: "Owner key", platform: "ios" },
      keys: { publicKey: clientB64u(ownerKeys.publicKey), secretKey: clientB64u(ownerKeys.secretKey) },
    };
    await assert.rejects(checkJoin(fetcher, ownerAttempt), (error) => error instanceof LinkError && error.code === "join_owner");

    for (let attempt = 0; attempt < 8; attempt++) {
      const error = await joinTeam(fetcher, { ...target, code: "BBBBBBBBBB" }, { name: "Guesser", platform: "ios" }).catch((value) => value);
      assert.equal(error instanceof LinkError && (error.code === "join_closed" || error.code === "join_wait"), true);
    }
    await assert.rejects(joinTeam(fetcher, target, { name: "Real", platform: "ios" }), (error) => error instanceof LinkError && error.code === "join_wait");
  } finally {
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invite cards are signed exactly, found by code and deleted on revoke", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-teams-invite-card-"));
  const relay = new FakeRelay();
  const calls: any[] = [];
  let card = "";
  let failPut = false;
  const fakeFetch: FetchLike = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    let status = 204;
    let json: any = {};
    if (init.method === "PUT") {
      if (failPut) throw new Error("relay unavailable");
      const sent = JSON.parse(String(init.body));
      assert.ok(Number.isInteger(sent.expiresAt));
      assert.ok(sent.expiresAt > Date.now());
      assert.ok(sent.expiresAt <= Date.now() + 30 * 24 * 60 * 60_000);
      assert.ok(Buffer.from(String(init.body)).length <= 16 * 1024);
      assert.ok(Buffer.from(sent.card, "base64url").length <= 4096);
      assert.match(String(init.headers?.["x-botkins-key"]), /^[A-Za-z0-9_-]{43}$/);
      assert.match(String(init.headers?.["x-botkins-sig"]), /^[A-Za-z0-9_-]{86}$/);
      assert.ok(Math.abs(Math.floor(Date.now() / 1000) - Number(init.headers?.["x-botkins-time"])) <= 300);
      card = sent.card;
    } else if (init.method === "DELETE") {
      card = "";
    } else {
      status = card ? 200 : 404;
      json = card ? { card } : {};
    }
    const bytes = Buffer.from(JSON.stringify(json));
    return { ok: status >= 200 && status < 300, status, json: async () => json, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const link = new LinkHost({ dir, backend: new MockBackend(), relay: { url: "https://relay.test", WebSocket: relay.WebSocket }, fetch: fakeFetch, port: 0, extraHosts: ["127.0.0.1"] });
  try {
    await link.setEnabled(true);
    link.setRelay({ enabled: true });
    const until = Date.now() + 5000;
    while (!link.status().relay.connected) {
      if (Date.now() > until) throw new Error("relay did not connect");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const invite = await link.createInvite({ groupId: "g_everyone", days: 1, maxUses: 5 });
    assert.equal(invite.published, true);
    const put = calls.find((item) => item.method === "PUT");
    assert.ok(put);
    const body = JSON.parse(put.body);
    const lookup = new URL(put.url).pathname.split("/").at(-1);
    const relayKey = link.store.relayKey();
    const cardHash = createHash("sha256").update(body.card, "utf8").digest("base64url");
    const room = createHash("sha256").update("botkins-relay-room-v1:" + relayKey.publicKey, "utf8").digest("base64url");
    assert.match(put.headers["x-botkins-key"], /^[A-Za-z0-9_-]{43}$/);
    assert.match(put.headers["x-botkins-sig"], /^[A-Za-z0-9_-]{86}$/);
    const proof = [
      "botkins-relay-invite-v1",
      room,
      lookup,
      body.expiresAt,
      cardHash,
      put.headers["x-botkins-time"],
    ].join(":");
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(put.headers["x-botkins-key"], "base64url")]), format: "der", type: "spki" });
    assert.equal(verify(null, Buffer.from(proof), publicKey, Buffer.from(put.headers["x-botkins-sig"], "base64url")), true);

    const found = await findInvite(fakeFetch, invite.code, "https://relay.test");
    assert.equal(found.serverKey, Buffer.from(link.store.data.keys.publicKey).toString("base64url"));
    assert.equal(found.serverId, link.status().serverId);
    assert.ok(found.hosts.some((host) => host.startsWith("relay!")));
    await assert.rejects(findInvite(fakeFetch, invite.code, "https://relay.test", "X".repeat(43)), /different computer|invite/);

    await link.revokeInvite(invite.id);
    const del = calls.find((item) => item.method === "DELETE");
    assert.ok(del);
    const deleteProof = ["botkins-relay-invite-del-v1", room, lookup, del.headers["x-botkins-time"]].join(":");
    assert.equal(verify(null, Buffer.from(deleteProof), publicKey, Buffer.from(del.headers["x-botkins-sig"], "base64url")), true);
    failPut = true;
    const unpublished = await link.createInvite({ groupId: "g_everyone", days: 1, maxUses: 1 });
    assert.equal(unpublished.published, false, "a publication failure does not cancel an otherwise valid invite");
    assert.ok(link.team().invites.some((item: any) => item.id === unpublished.id));
  } finally {
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a member can join through the relay and open a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-teams-relay-join-"));
  const relay = new FakeRelay();
  const link = new LinkHost({
    dir,
    backend: new MockBackend({ speed: 0.01 }),
    relay: { url: "https://relay.test", WebSocket: relay.WebSocket },
    port: 0,
    extraHosts: ["127.0.0.1"],
    fetch: async () => ({ ok: true, status: 204, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  let client: LinkClient | null = null;
  try {
    await link.setEnabled(true);
    link.setRelay({ enabled: true });
    const until = async (test: () => boolean, label: string) => {
      const end = Date.now() + 8000;
      while (!test()) {
        if (Date.now() > end) throw new Error("Timed out waiting for " + label);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await until(() => link.status().relay.connected, "relay");
    const invite = await link.createInvite({ groupId: "g_everyone", days: 1, maxUses: 1 });
    const away = (() => Promise.reject(new TypeError("offline"))) as unknown as FetchLike;
    const fetcher = relayFetch(away, { WebSocket: relay.WebSocket as any, idleMs: 200 });
    const target = {
      code: invite.code,
      hosts: link.hosts().filter(isRelayHost),
      serverId: link.status().serverId,
      serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"),
      name: link.status().name,
    };
    const pending = await startJoin(fetcher, target, { name: "Away member", platform: "ios", kind: "phone" });
    assert.equal(pending.result.status, "pending");
    if (pending.result.status !== "pending") throw new Error("not pending");
    await link.approve(pending.result.requestId);
    const approved = await checkJoin(fetcher, pending.attempt);
    assert.equal(approved.status, "approved");
    if (approved.status !== "approved") throw new Error("not approved");
    client = new LinkClient(approved.pairing, { fetch: fetcher, onParts() {}, onState() {} });
    assert.ok(Array.isArray(await client.call("models")));
    assert.equal(client.route, "relay");
  } finally {
    client?.stop();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
