import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, LinkError, pair, profileConnect } from "../src/link/client";
import type { ProfileHost } from "../src/link/profile";

const response = (status: number, body: unknown): Awaited<ReturnType<FetchLike>> => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
});

test("binds an owner profile and connects with a fresh encrypted device", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-profile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const redeemed: { ticket: string; purpose: string; serverId: string; serverKey: string; publicKey?: string }[] = [];
  const inactive = new Set<string>();
  const profileFetch = async (url: string, init?: { body?: string | Uint8Array }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/proofs/redeem")) {
      redeemed.push(body);
      return response(200, {
        profileId: "profile-owner",
        deviceId: body.purpose === "bind" ? "account-device" : body.ticket === "connect-ticket-2" ? "link-device-2" : "link-device",
        name: "Owner",
        statusKey: body.purpose === "bind" ? "bind-status" : body.ticket === "connect-ticket-2" ? "connect-status-2" : "connect-status",
      });
    }
    if (url.endsWith("/devices/status")) return response(200, { active: !inactive.has(body.statusKey) });
    throw new Error("unexpected profile request " + url);
  };
  const link = new LinkHost({
    relay: false,
    dir,
    backend: new MockBackend({ speed: 0.01 }),
    port: 0,
    extraHosts: ["127.0.0.1"],
    profileFetch,
  });
  await link.setEnabled(true);
  try {
    const paired: Record<string, unknown>[] = [];
    link.on("paired", (device) => paired.push(device));
    const descriptor = await link.bindOwnerProfile("bind-ticket");
    assert.deepEqual({ ...descriptor, hosts: undefined }, {
      serverId: link.store.data.serverId,
      serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"),
      name: link.store.name,
      hosts: undefined,
    });
    assert.ok(descriptor.hosts.includes("127.0.0.1:" + link.port));
    assert.equal(link.ownerName(), "Owner", "the verified owner profile name is used in host people displays");
    const target = descriptor as ProfileHost;
    let connectPublicKey = "";
    const pairing = await profileConnect(fetch as unknown as FetchLike, target, { name: "Profile phone", platform: "ios" }, async (publicKey) => {
      assert.match(publicKey, /^[A-Za-z0-9_-]{43}$/);
      connectPublicKey = publicKey;
      return "connect-ticket";
    });
    assert.equal(pairing.serverId, target.serverId);
    assert.equal(pairing.serverKey, target.serverKey);
    assert.equal(pairing.name, target.name);
    assert.equal(link.status().devices.length, 1);
    assert.equal(link.status().devices[0].name, "Profile phone");
    assert.equal((link.status().devices[0] as Record<string, unknown>).profile, undefined, "status never exposes profile proof material");
    assert.equal(paired[0]?.profile, undefined, "paired events never expose profile proof material");
    assert.deepEqual(redeemed.map(({ ticket, purpose, serverId, serverKey, publicKey }) => ({ ticket, purpose, serverId, serverKey, publicKey })), [
      { ticket: "bind-ticket", purpose: "bind", serverId: target.serverId, serverKey: target.serverKey, publicKey: undefined },
      { ticket: "connect-ticket", purpose: "connect", serverId: target.serverId, serverKey: target.serverKey, publicKey: connectPublicKey },
    ]);
    inactive.add("bind-status");
    link.profileStatus.clear();
    const reconnected = await profileConnect(fetch as unknown as FetchLike, target, { name: "Profile phone", platform: "ios" }, async () => "connect-ticket-2");
    assert.equal(reconnected.serverId, target.serverId, "a revoked bind seed does not block another active profile device");
    assert.equal(link.status().devices.length, 2, "a different cloud device does not replace an existing profile installation");
    const client = new LinkClient(reconnected, { fetch: fetch as unknown as FetchLike, onParts() {}, onState() {} });
    assert.ok(Array.isArray(await client.call("models")));
    inactive.add("connect-status-2");
    link.profileStatus.clear();
    assert.equal(await link.profileActive("connect-status-2"), false);
    await assert.rejects(client.call("models"), (error: unknown) => error instanceof LinkError && error.code === "revoked");
    assert.equal(link.status().devices.length, 1, "a revoked profile device is removed without touching another profile device");
    link.removeDevice(pairing.deviceId);
    assert.equal(link.status().devices.length, 0);
    await assert.rejects(profileConnect(fetch as unknown as FetchLike, target, { name: "Profile phone", platform: "ios" }, async () => "connect-ticket"), (error: unknown) => error instanceof LinkError && error.code === "revoked", "an explicitly removed cloud device stays tombstoned");
    link.unbindOwnerProfile("profile-owner");
    assert.equal(link.store.data.profiles.owner, null, "explicit host unbind clears the owner mapping");
    assert.equal(link.status().devices.length, 0, "explicit host unbind removes only this principal's profile devices");
    client.stop();
  } finally {
    await link.stop();
  }
});

test("binds a member profile to the existing member principal and never to its name", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-profile-member-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profileFetch = async (url: string, init?: { body?: string | Uint8Array }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/proofs/redeem")) return response(200, {
      profileId: "profile-member",
      deviceId: "member-account-device",
      name: "A different cloud name",
      statusKey: "member-status",
    });
    if (url.endsWith("/devices/status")) return response(200, { active: true });
    throw new Error("unexpected profile request " + url + " " + JSON.stringify(body));
  };
  const link = new LinkHost({ relay: false, dir, backend: new MockBackend(), port: 0, extraHosts: ["127.0.0.1"], profileFetch });
  await link.setEnabled(true);
  try {
    const legacy = await pair(fetch as unknown as FetchLike, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Legacy", platform: "ios" });
    link.store.data.team.members.push({ id: "member-1", name: "The Existing Member", groupId: "g_everyone" });
    link.store.data.devices[0].memberId = "member-1";
    link.store.save();
    const legacyClient = new LinkClient(legacy, { fetch: fetch as unknown as FetchLike, onParts() {}, onState() {} });
    const bound = await legacyClient.call<ProfileHost>("link.profile.bind", "member-ticket");
    assert.equal(bound.member, true);
    assert.equal(bound.name, link.store.name);
    assert.equal(link.store.data.team.members[0].name, "A different cloud name", "the verified profile name is used for the member display");
    assert.equal(link.store.device(legacy.deviceId)?.profile?.profileId, "profile-member", "the explicit bind upgrades only the calling legacy device to profile trust");
    const profilePairing = await profileConnect(fetch as unknown as FetchLike, bound, { name: "New profile phone", platform: "ios", kind: "gadget" as unknown as "phone", presenceKey: "must-not-cross" }, async () => "member-connect-ticket");
    assert.equal(profilePairing.member, true);
    const profileDevice = link.store.device(profilePairing.deviceId);
    assert.equal(profileDevice?.memberId, "member-1");
    assert.equal(profileDevice?.kind, "phone", "a profile device cannot become a gadget");
    assert.equal(profileDevice?.presenceKey, undefined, "a profile enrollment cannot grant sensitive presence access");
    assert.equal(profileDevice?.person, undefined, "the cloud name cannot replace the member identity");
    assert.equal(link.store.data.profiles.members["member-1"].profileId, "profile-member");
    await assert.rejects(link.bindOwnerProfile("member-ticket"), /already bound/);
    legacyClient.stop();
    const unbindLegacy = await pair(fetch as unknown as FetchLike, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Unbind legacy", platform: "ios" });
    link.store.device(unbindLegacy.deviceId).memberId = "member-1";
    link.store.save();
    const unbindClient = new LinkClient(unbindLegacy, { fetch: fetch as unknown as FetchLike, onParts() {}, onState() {} });
    await unbindClient.call("link.profile.unbind", "profile-member");
    assert.equal(link.store.data.profiles.members["member-1"], undefined, "sealed unbind clears only the member's host mapping");
    assert.equal(link.store.data.devices.some((device) => device.memberId === "member-1" && device.profile), false, "sealed unbind invalidates only that member's profile devices");
    unbindClient.stop();
    legacyClient.stop();
  } finally {
    await link.stop();
  }
});
