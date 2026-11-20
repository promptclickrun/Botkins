import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinkStore } from "../desktop/link/store.mjs";
import { LinkHost } from "../desktop/link/index.mjs";
import { phonePage } from "../desktop/phonepage.mjs";
import { decide } from "../desktop/notify.mjs";
import { LinkClient, join as joinTeam, pair } from "../desktop/remote/link-client.mjs";

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-person-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("old device records keep their model and acquire a person only when named", (t) => {
  const dir = folder(t);
  const store = new LinkStore(dir);
  const device = { name: "iPhone", platform: "ios", publicKey: Buffer.alloc(32, 1) };
  const old = store.addDevice(device);
  const tagged = store.addDevice({ ...device, publicKey: Buffer.alloc(32, 2), person: "  River\nLee  " });
  const loaded = new LinkStore(dir);
  assert.equal(Object.hasOwn(loaded.device(old.id), "person"), false);
  assert.equal(loaded.device(tagged.id).person, "River Lee");
  assert.equal(loaded.setPerson("gone", "A"), false);
  for (const invalid of ["", " \n\u007f ", null, 42]) assert.throws(() => loaded.setPerson(old.id, invalid));
  assert.equal(loaded.device(old.id).person, undefined);
  loaded.setPerson(old.id, "x".repeat(80));
  assert.equal(new LinkStore(dir).device(old.id).person, "x".repeat(60));
  assert.equal(loaded.device(old.id).name, "iPhone");
});

test("screen viewers and the screen setting use current person names and keep the recorded fallback", () => {
  const status = {
    relay: {},
    devices: [{ id: "phone-1", name: "iPhone", person: "River" }],
    screen: {
      mode: "view",
      viewers: [{ deviceId: "phone-1", name: "iPhone", since: 1 }],
      setBy: { deviceId: "old-device", name: "Previous phone", at: 1 },
    },
  };
  const page = phonePage({ link: () => ({ status: () => status, meta: () => ({ capabilities: [] }) }), screens: { granted: () => ({}) } });
  assert.equal(page.phoneLink().canSetPerson, false);
  assert.equal(page.phoneLink().screen.viewers[0].name, "River");
  assert.deepEqual(page.phoneLink().screen.setBy, status.screen.setBy);
});

test("paired owner can set a person's name independently of the model over sealed RPC", async (t) => {
  const host = new LinkHost({
    dir: folder(t),
    port: 0,
    relay: false,
    backend: {
      info: () => ({ app: "botkins" }),
      snapshot: () => ({ bots: [], chats: [], runs: [] }),
      subscribe: () => () => {},
    },
  });
  t.after(() => host.stop());
  await host.setEnabled(true);
  const target = () => ({ hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code });
  const device = await pair(fetch, target(), { name: "iPhone", person: "  Rowan  ", platform: "ios" });
  const legacy = await pair(fetch, target(), { name: "iPhone", platform: "ios" });
  const client = new LinkClient(device, { fetch });
  t.after(() => client.stop());
  const roster = await client.call("link.devices.list");
  assert.equal(roster.find(d => d.current).person, "Rowan");
  assert.equal(roster.find(d => d.id === legacy.deviceId).person, undefined);
  host.applyScreen("view", { deviceId: legacy.deviceId, name: "iPhone", at: 100 });
  let statusEvents = 0;
  host.on("status", () => statusEvents++);
  const result = await client.call("link.devices.setPerson", legacy.deviceId, " Avery ");
  assert.ok(statusEvents > 0);
  assert.equal(result.find(d => d.id === legacy.deviceId).person, "Avery");
  const desktop = phonePage({ link: () => host, screens: { granted: () => ({}) } });
  assert.equal(desktop.phoneLink().canSetPerson, true);
  assert.equal(desktop.phoneLink().screen.setBy.name, "Avery");
  await client.call("link.devices.rename", legacy.deviceId, "Test phone");
  assert.deepEqual(host.devices().map(d => [d.name, d.person]), [["iPhone", "Rowan"], ["Test phone", "Avery"]]);
  for (const invalid of [" \n ", 42]) {
    await assert.rejects(client.call("link.devices.setPerson", legacy.deviceId, invalid), /Give the person a name/);
  }
  await assert.rejects(client.call("link.devices.setPerson", "unknown", "Someone"), /no longer paired/);
  await assert.rejects(client.call("link.devices.setPerson", legacy.deviceId, "x".repeat(201)), /Give the person a name/);

  const invite = await client.call("link.team.createInvite", { groupId: "g_everyone", days: 1, maxUses: 1 });
  const teamTarget = {
    hosts: ["127.0.0.1:" + host.port],
    code: invite.code,
    serverId: host.status().serverId,
    serverKey: Buffer.from(host.store.data.keys.publicKey).toString("base64url"),
  };
  const guestPhone = { name: "iPhone", person: " River ", platform: "ios", kind: "phone" };
  const pending = await joinTeam(fetch, teamTarget, guestPhone);
  const request = host.team().requests.find(r => r.id === pending.requestId);
  assert.equal(request.person, "River");
  assert.equal(decide({ type: "joinRequest", request }, { settings: { notifications: { requests: true } } }).title, "River wants to join your team");
  await client.call("link.team.approve", pending.requestId);
  const approved = await joinTeam(fetch, teamTarget, guestPhone, pending.attempt);
  const member = new LinkClient(approved.pairing, { fetch });
  t.after(() => member.stop());
  await assert.rejects(member.call("link.devices.setPerson", legacy.deviceId, "Someone"), /owner/i);
  const joined = host.team().members[0];
  assert.equal(joined.name, "River");
  const sibling = host.store.addDevice({ name: "Tablet", memberId: joined.id, publicKey: Buffer.alloc(32, 3) });
  await client.call("link.devices.setPerson", approved.pairing.deviceId, "Robin");
  assert.equal(host.team().members[0].name, "Robin");
  assert.equal(host.store.device(sibling.id).person, "Robin");
  assert.equal(host.store.device(sibling.id).name, "Tablet");
});
