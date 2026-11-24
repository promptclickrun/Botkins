import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createRelay } from "../../mobile/relay/node/server.mjs";
import { join as joinPath } from "node:path";
import { LinkHost } from "../../desktop/desktop/link/index.mjs";
import { ProfileManager } from "../../desktop/desktop/profile.mjs";
import {
  LinkClient,
  join,
  pair,
  profileApi,
  profileConnect,
  relayFetch,
  isRelayHost,
} from "../../desktop/desktop/remote/link-client.mjs";
import { setup, passkey, signup } from "./support.mjs";
import { ORIGIN } from "../src/common.mjs";

test("an existing desktop links two environments and a new phone opens each with its original host identity", async (t) => {
  const f = setup(t),
    originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, init) =>
    String(url).startsWith(ORIGIN + "/") ? f.fetchWorker(url, init) : originalFetch(url, init),
  );
  const { session, auth } = await signup(f);
  async function localHost(name) {
    const dir = mkdtempSync(joinPath(tmpdir(), "botkins-profile-host-"));
    const link = new LinkHost({
      dir,
      port: 0,
      extraHosts: ["127.0.0.1"],
      relay: false,
      profileFetch: f.fetchWorker,
      backend: {
        info: () => ({ app: "botkins" }),
        snapshot: () => ({ bots: [], chats: [], runs: [] }),
        subscribe: () => () => {},
      },
    });
    t.after(async () => {
      await link.stop();
      rmSync(dir, { force: true, recursive: true });
    });
    await link.setEnabled(true);
    link.setName(name);
    const legacy = await pair(
      fetch,
      { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code },
      { name: "Original", platform: "darwin", kind: "desktop" },
    );
    return { link, legacy };
  }
  function client(pairing) {
    const c = new LinkClient(pairing, { fetch });
    t.after(() => c.stop());
    return c;
  }
  const mine = await localHost("My computer"),
    studio = await localHost("Studio");
  const owner = client(mine.legacy),
    studioAdmin = client(studio.legacy);
  const invite = await studioAdmin.call("link.team.createInvite", {
    groupId: "g_everyone",
    days: 1,
    maxUses: 1,
  });
  const target = { ...studio.legacy, code: invite.code },
    identity = { name: "Other desktop", person: "River", platform: "darwin", kind: "desktop" };
  const waiting = await join(fetch, target, identity);
  await studioAdmin.call("link.team.approve", waiting.requestId);
  const approved = await join(fetch, target, identity, waiting.attempt);
  const guest = client(approved.pairing),
    oldMember = studio.link.store.device(approved.pairing.deviceId).memberId;

  for (const [connection, pairing] of [
    [owner, mine.legacy],
    [guest, approved.pairing],
  ]) {
    const ticket = await profileApi.proof(session.token, "bind", pairing.serverId, pairing.serverKey);
    const descriptor = await connection.call("link.profile.bind", ticket);
    await profileApi.putHost(session.token, descriptor);
  }
  assert.equal(mine.link.store.device(mine.legacy.deviceId)?.profile?.deviceId, session.deviceId);
  assert.equal(studio.link.store.device(approved.pairing.deviceId)?.profile?.deviceId, session.deviceId);
  assert.equal(
    studio.link.store.device(studio.legacy.deviceId)?.profile,
    undefined,
    "the unrelated studio owner remains local-only",
  );
  const fresh = await f.begin("Fresh phone");
  await passkey(fresh, auth);
  await profileApi.approve(session.token, fresh.id, fresh.code);
  const { session: phone } = await fresh.finish();
  const directory = await profileApi.home(phone.token);
  assert.equal(directory.hosts.length, 2);
  let phoneOnMyComputer;
  for (const descriptor of directory.hosts) {
    const pairing = await profileConnect(
      fetch,
      descriptor,
      { name: "Phone", platform: "ios", kind: "phone" },
      (key) => profileApi.proof(phone.token, "connect", descriptor.serverId, descriptor.serverKey, key),
    );
    const remote = client(pairing);
    if (descriptor.member) {
      assert.equal(studio.link.store.device(pairing.deviceId).memberId, oldMember);
      await assert.rejects(remote.call("link.devices.list"));
    } else {
      phoneOnMyComputer = remote;
      assert.ok(Array.isArray(await remote.call("link.devices.list")));
    }
  }
  assert.ok(
    mine.link.store.device(mine.legacy.deviceId),
    "enrolling the phone keeps the original desktop paired",
  );
  assert.equal(studio.link.store.device(approved.pairing.deviceId)?.memberId, oldMember);
  await profileApi.revoke(phone.token, phone.deviceId);
  const afterLease = Date.now() + 6 * 60_000;
  t.mock.method(Date, "now", () => afterLease);
  await assert.rejects(phoneOnMyComputer.call("link.devices.list"));
  assert.ok(Array.isArray(await owner.call("link.devices.list")), "the original desktop still has access");
  await assert.rejects(profileApi.home(phone.token));
  assert.equal((await profileApi.home(session.token)).hosts.length, 2);

  const additional = await f.begin("Trusted tablet");
  await passkey(additional, auth);
  await profileApi.approve(session.token, additional.id, additional.code);
  const { session: tablet } = await additional.finish();
  const hostApp = new ProfileManager({ lib: { profileApi }, local: mine.link });
  hostApp.session = session;
  await hostApp.signOut();
  assert.equal((await profileApi.home(tablet.token)).hosts.length, 2);
  const ownHost = directory.hosts.find((d) => !d.member);
  const tabletKey = await profileConnect(fetch, ownHost, { name: "Tablet", platform: "ios" }, (key) =>
    profileApi.proof(tablet.token, "connect", ownHost.serverId, ownHost.serverKey, key),
  );
  assert.ok(
    Array.isArray(await client(tabletKey).call("link.devices.list")),
    "a host stays available when its original desktop signs out",
  );
  await assert.rejects(profileApi.home(session.token));
});
test("a directory host with only a relay route admits an enrolled installation", async (t) => {
  const fixture = setup(t),
    { session, auth } = await signup(fixture);
  const phone = await fixture.begin("Away from home");
  await passkey(phone, auth);
  await fixture.api("devices/approve", { id: phone.id, code: phone.code }, session.token);
  const { session: trusted } = await phone.finish();
  const dir = mkdtempSync(joinPath(tmpdir(), "botkins-profile-relay-"));
  const WebSocket = createRequire(new URL("../../mobile/relay/package.json", import.meta.url))("ws");
  const relay = createRelay({ dataDir: joinPath(dir, "relay"), limits: false });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + relay.address().port;
  const link = new LinkHost({
    dir: joinPath(dir, "host"),
    port: 0,
    relay: { url, WebSocket },
    profileFetch: fixture.fetchWorker,
    backend: {
      info: () => ({ app: "botkins" }),
      snapshot: () => ({ bots: [], chats: [], runs: [] }),
      subscribe: () => () => {},
    },
  });
  let client;
  try {
    await link.setEnabled(true);
    link.setRelay({ enabled: true, url });
    const expires = Date.now() + 8000;
    while (!link.status().relay.connected && Date.now() < expires) await delay(20);
    assert.ok(link.status().relay.connected);
    const serverKey = Buffer.from(link.store.data.keys.publicKey).toString("base64url"),
      serverId = link.store.data.serverId;
    const grant = async (token, purpose, publicKey) =>
      (await fixture.api("proofs/issue", { serverId, serverKey, purpose, publicKey }, token)).ticket;
    const descriptor = await link.bindOwnerProfile(await grant(session.token, "bind"));
    await fixture.api(
      "hosts/put",
      { ...descriptor, hosts: descriptor.hosts.filter(isRelayHost) },
      session.token,
    );
    const { hosts } = await fixture.api("home", {}, trusted.token);
    assert.equal(hosts[0].hosts.length, 1);
    const relayOnly = relayFetch(
      async () => {
        throw new Error("LAN is unreachable");
      },
      { WebSocket, idleMs: 100 },
    );
    const bound = await profileConnect(
      relayOnly,
      hosts[0],
      { name: "Remote phone", platform: "ios" },
      (key) => grant(trusted.token, "connect", key),
    );
    client = new LinkClient(bound, { fetch: relayOnly });
    assert.ok(Array.isArray(await client.call("link.devices.list")));
    assert.equal(link.store.device(bound.deviceId)?.profile?.deviceId, trusted.deviceId);
  } finally {
    client?.stop();
    await link.stop();
    await new Promise((resolve) => relay.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
