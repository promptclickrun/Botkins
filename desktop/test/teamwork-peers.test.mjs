import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkHost } from "../desktop/link/server.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { relayFetch } from "../desktop/remote/link-client.mjs";
import { installTeamworkPeers } from "../desktop/teamwork-peers.mjs";

for (const viaRelay of [false, true]) test("authenticated teamwork over " + (viaRelay ? "a self-hosted relay" : "direct HTTP"), async (t) => {
  let relay;
  let relayUrl;
  if (viaRelay) {
    const { createRelay } = await import("../../mobile/relay/node/server.mjs");
    relay = createRelay({ limits: false, pushUpstream: "off" });
    await new Promise(resolve => relay.listen(0, "127.0.0.1", resolve));
    relayUrl = "http://127.0.0.1:" + relay.address().port;
  }
  // Close both hosts before waiting for their relay sockets to close.
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    if (relay) await new Promise(resolve => relay.close(resolve));
  });
  const send = viaRelay ? relayFetch(() => { throw new Error("Direct connection unavailable."); }, { idleMs: 50 }) : fetch;
  const rows = [];
  const endpoints = [];
  let captured, peer, tamperReply = false, stage = "pending", calls = 0, reads = 0;
  for (const name of ["Office", "Kitchen"]) {
    const dir = mkdtempSync(join(tmpdir(), "botkins-peers-"));
    const link = new LinkHost({ dir, relay: viaRelay ? { url: relayUrl } : false, port: 0, backend: {
      info: () => ({}), snapshot: () => ({ bots: [], chats: [] }), subscribe: () => () => {},
    } });
    cleanups.push(async () => { await link.stop(); rmSync(dir, { recursive: true, force: true }); });
    await link.setEnabled(true);
    if (viaRelay) {
      link.setRelay({ enabled: true, url: relayUrl });
      const until = Date.now() + 5000;
      while (!link.status().relay.connected && Date.now() < until) await delay(20);
      assert.ok(link.status().relay.connected);
    }
    link.store.set({ profiles: { owner: { profileId: "owner" }, members: {} } });
    const row = { serverId: link.store.data.serverId, serverKey: link.store.data.keys.publicKey.toString("base64url"), hosts: [viaRelay ? link.relayEntry() : "127.0.0.1:" + link.port], name };
    rows.push(row);
    const profile = { session: { profileId: "owner" }, token: () => "session", profileApi: () => ({ home: async () => { reads++; return { profile: { id: "owner" }, hosts: structuredClone(rows) }; } }) };
    const workspace = { hostDispatch: { receive(auth, operation, payload) { calls++; peer = auth; return operation === "status" ? { status: stage } : { operation, message: payload.message }; } } };
    installTeamworkPeers({ link, workspace }, profile, async (url, init) => {
      if (init?.method === "POST") captured = init.body;
      const response = await send(url, init);
      if (tamperReply && init?.method === "POST") return { ok: true, status: 200, json: async () => ({ box: "forged-reply" }) };
      return response;
    });
    endpoints.push({ link, workspace, profile, row });
  }
  const [a, b] = endpoints;
  assert.deepEqual(await a.workspace.teamworkPeers.hosts(), [{ serverId: b.row.serverId, name: "Kitchen" }]);
  const data = { message: "private question", serverId: "spoof", name: "spoof" };
  assert.deepEqual(await a.workspace.teamworkPeers.call(b.row.serverId, "submit", data), { operation: "submit", message: data.message });
  assert.equal(peer.name, "Office");
  assert.equal(peer.serverId, a.row.serverId);
  assert.equal(peer.targetKey, b.row.serverKey);
  assert.ok(!captured.includes(data.message));
  const replay = await b.link.serve({ route: "profile", via: "relay", body: Buffer.from(captured) });
  assert.equal(replay.status, 403);
  assert.equal(calls, 1);
  await peer.verify();
  const beforePolling = reads;
  await Promise.all(Array.from({ length: 4 }, () => a.workspace.teamworkPeers.call(b.row.serverId, "status", {})));
  assert.ok(reads - beforePolling <= 2, "four concurrent polls share the account reads");
  const beforeAgain = reads;
  await a.workspace.teamworkPeers.call(b.row.serverId, "status", {});
  assert.equal(reads, beforeAgain, "an immediately following pending poll reuses the directory");
  stage = "answered";
  const originalApi = b.profile.profileApi;
  const [pinned] = await a.workspace.teamworkPeers.hosts(true);
  assert.ok(pinned.pin);
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "submit", data, "a different host identity"));
  // A lost submit reply can be retried after the bot finished. If the source was removed
  // after B accepted the retry, B must withhold that saved reply just as for a status poll.
  let lookups = 0;
  b.profile.profileApi = () => ({ home: async () => ({ profile: { id: "owner" }, hosts: ++lookups === 1 ? rows : [b.row] }) });
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "submit", data, pinned.pin));
  b.profile.profileApi = originalApi;
  b.profile.profileApi = () => ({ home: async () => ({ profile: { id: "owner" }, hosts: [b.row, { ...a.row, member: true }] }) });
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "submit", data));
  b.profile.profileApi = () => ({ home: async () => ({ profile: { id: "owner" }, hosts: [b.row, { ...a.row, serverKey: b.row.serverKey }] }) });
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "submit", data));
  b.profile.profileApi = originalApi;
  await peer.verify();
  b.profile.profileApi = () => ({ home: async () => ({ profile: { id: "owner" }, hosts: [b.row] }) });
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "status", {}));
  await assert.rejects(peer.verify());
  b.profile.profileApi = originalApi;
  await peer.verify();
  b.profile.profileApi = () => ({ home: async () => { throw new Error("offline"); } });
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "status", {}), { code: "TEAMWORK_OFFLINE" });
  b.profile.profileApi = originalApi;
  const sourceApi = a.profile.profileApi;
  a.profile.profileApi = () => ({ home: async () => ({ profile: { id: "owner" }, hosts: [a.row] }) });
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "status", {}));
  a.profile.profileApi = sourceApi;
  await a.workspace.teamworkPeers.hosts();
  tamperReply = true;
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "status", {}));
  tamperReply = false;
  a.row.member = true;
  await assert.rejects(peer.verify());
  delete a.row.member;
  const key = a.row.serverKey;
  a.row.serverKey = b.row.serverKey;
  await assert.rejects(peer.verify());
  a.row.serverKey = key;
  b.link.store.data.profiles.owner.profileId = "other";
  await assert.rejects(peer.verify());
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "submit", data));
  await assert.rejects(a.workspace.teamworkPeers.call(b.row.serverId, "link.sync", {}));
  assert.ok(calls >= 7);
});
