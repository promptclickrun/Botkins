// The person a paired device belongs to ("device-person-v1"). "Your name" is asked before a phone
// pairs or joins a team, and is sent sealed beside the device's model: the computer lists "Jordan"
// with "iPhone 17 Pro" under it, an owner can change the name, and a phone or a file from before
// (no `person`) works as it did.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { random } from "../link-host/crypto.mjs";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { LinkStore, personName } from "../link-host/store.mjs";
import { teamPart } from "../link-host/team.mjs";
import { cleanPerson, deviceSubtitle, deviceTitle, PERSON_MAX, personProblem } from "../src/features/pair/person";
import { checkJoin, type FetchLike, LinkClient, pair, startJoin } from "../src/link/client";
import type { Meta, PairedDevice } from "../src/link/types";

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

async function host() {
  const link = new LinkHost({ relay: false, dir: folder("botkins-person-"), backend: new MockBackend({ speed: 0.05 }), port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  return { link, at: "127.0.0.1:" + link.port };
}

/** A fetcher that keeps every body sent to the pair and join routes: what a relay would carry. */
function recording() {
  const bodies: string[] = [];
  const fetcher: FetchLike = (url, init) => {
    if (/\/(pair|join)$/.test(String(url)) && typeof init?.body === "string") bodies.push(init.body);
    return real(url, init);
  };
  return { fetcher, bodies };
}

test("the name step blocks an empty name and sends a clean one", () => {
  // Continue stays off for these: nothing is sent.
  for (const empty of ["", "   ", "\n\t", "\u0007"]) assert.equal(personProblem(empty), "Enter your name.", JSON.stringify(empty));
  assert.equal(personProblem("x".repeat(PERSON_MAX + 1)), "Use 60 characters or fewer.");
  assert.equal(personProblem("x".repeat(PERSON_MAX)), null);
  assert.equal(personProblem("  Jordan "), null);
  assert.equal(cleanPerson("  Jordan\u0000 "), "Jordan");
  assert.equal(cleanPerson("Jo\ndan"), "Jo dan");
  // The computer cleans it the same way, and leaves out what is empty.
  assert.equal(personName("  Jordan\u0000 "), "Jordan");
  assert.equal(personName("x".repeat(80)).length, 60);
  assert.equal(personName("   "), "");
  assert.equal(personName(42), "");
});

test("a row shows the person first and the device under it, or the device alone", () => {
  const named = { name: "iPhone 17 Pro", person: "Jordan" };
  const old = { name: "iPhone" };
  assert.equal(deviceTitle(named), "Jordan");
  assert.equal(deviceSubtitle(named, "Connected"), "iPhone 17 Pro · Connected");
  assert.equal(deviceTitle(old), "iPhone");
  assert.equal(deviceSubtitle(old, "Connected"), "Connected");
  assert.equal(deviceTitle({ name: "iPhone", person: "" }), "iPhone");
});

test("pairing sends the person sealed beside the model, and the computer lists both", async () => {
  const { link, at } = await host();
  const { fetcher, bodies } = recording();
  const pairing = await pair(fetcher, { hosts: [at], code: link.startPairing().code }, { name: "iPhone 17 Pro", platform: "ios", person: "  Jordan " });
  // What crosses the network (and a relay) is a key and a sealed box: the name is not in it.
  assert.equal(bodies.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(bodies[0])).sort(), ["box", "publicKey"]);
  assert.ok(!bodies[0].includes("Jordan") && !bodies[0].includes("iPhone"));
  const kept = link.store.device(pairing.deviceId);
  assert.equal(kept.person, "Jordan");
  assert.equal(kept.name, "iPhone 17 Pro");

  let meta: Meta | undefined;
  const client = new LinkClient(pairing, { fetch: real, onParts: (parts) => void (parts.meta && (meta = parts.meta as Meta)), onState() {} });
  client.start();
  try {
    const end = Date.now() + 6000;
    while (!meta && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 15));
    assert.ok(meta?.capabilities.includes("device-person-v1"));
    const [row] = await client.call<PairedDevice[]>("link.devices.list");
    assert.equal(row.person, "Jordan");
    assert.equal(row.name, "iPhone 17 Pro");
    assert.equal(row.current, true);
  } finally {
    client.stop();
    await link.stop();
  }
});

test("a phone from before pairs without a person, and the owner can add one or change it", async () => {
  const { link, at } = await host();
  const owner = await pair(real, { hosts: [at], code: link.startPairing().code }, { name: "iPhone 17 Pro", platform: "ios", person: "Alex" });
  const old = await pair(real, { hosts: [at], code: link.startPairing().code }, { name: "iPhone", platform: "ios" });
  const client = new LinkClient(owner, { fetch: real, onParts() {}, onState() {} });
  try {
    let list = await client.call<PairedDevice[]>("link.devices.list");
    const before = list.find((device) => device.id === old.deviceId)!;
    assert.equal(before.name, "iPhone");
    assert.ok(!("person" in before), "no person until someone gives one");

    list = await client.call<PairedDevice[]>("link.devices.setPerson", old.deviceId, " Jordan ");
    assert.equal(list.find((device) => device.id === old.deviceId)?.person, "Jordan");
    // The device keeps its own name, and renaming the device keeps the person.
    list = await client.call<PairedDevice[]>("link.devices.rename", old.deviceId, "Jordan's work phone");
    const renamed = list.find((device) => device.id === old.deviceId)!;
    assert.equal(renamed.name, "Jordan's work phone");
    assert.equal(renamed.person, "Jordan");

    await assert.rejects(client.call("link.devices.setPerson", old.deviceId, "   "), /Give the person a name/);
    await assert.rejects(client.call("link.devices.setPerson", old.deviceId, 7), /Give the person a name/);
    await assert.rejects(client.call("link.devices.setPerson", old.deviceId, "x".repeat(201)), /Give the person a name/);
    await assert.rejects(client.call("link.devices.setPerson", "nope", "Jordan"), /no longer paired/);
    assert.equal(link.store.device(old.deviceId).person, "Jordan", "a refused name changes nothing");
  } finally {
    client.stop();
    await link.stop();
  }
});

test("joining a team sends the person, and the owner approves and renames a member by it", async () => {
  const { link, at } = await host();
  const ownerPairing = await pair(real, { hosts: [at], code: link.startPairing().code }, { name: "iPhone 17 Pro", platform: "ios", person: "Alex" });
  const owner = new LinkClient(ownerPairing, { fetch: real, onParts() {}, onState() {} });
  try {
    const invite = await owner.call<any>("link.team.createInvite", { groupId: "g_everyone", days: 7, maxUses: 1 });
    const target = { hosts: [at], code: invite.code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name };
    let event: any = null;
    link.once("joinRequest", (next) => (event = next));
    const { fetcher, bodies } = recording();
    const started = await startJoin(fetcher, target, { name: "iPhone 16", platform: "ios", kind: "phone", person: "Jordan" });
    assert.ok(!bodies[0].includes("Jordan"), "the join request is sealed too");
    if (started.result.status !== "pending") throw new Error("not pending");
    assert.equal(event.person, "Jordan");
    assert.equal(event.name, "iPhone 16");
    // Both lists an owner reads ("link.team.get" and the team part) name the person.
    for (const request of [(await owner.call<any>("link.team.get")).requests[0], teamPart(link.store.data.team, true).requests[0]]) {
      assert.equal(request.person, "Jordan");
      assert.equal(request.name, "iPhone 16");
    }

    await owner.call("link.team.approve", started.result.requestId);
    const checked = await checkJoin(real, started.attempt);
    if (checked.status !== "approved") throw new Error("not approved");
    const member = link.team().members[0];
    assert.equal(member.name, "Jordan");
    assert.equal(member.devices[0].person, "Jordan");
    assert.equal(member.devices[0].name, "iPhone 16");
    const device = link.store.device(checked.pairing.deviceId);
    assert.equal(device.person, "Jordan");
    assert.equal(device.name, "iPhone 16");

    // The owner changes the name from the device list: the member takes it too.
    await owner.call("link.devices.setPerson", device.id, "Jordan B.");
    assert.equal(link.team().members[0].name, "Jordan B.");
    assert.equal(link.store.device(device.id).person, "Jordan B.");

    // A member can't name devices.
    const memberClient = new LinkClient(checked.pairing, { fetch: real, onParts() {}, onState() {} });
    try {
      await assert.rejects(memberClient.call("link.devices.setPerson", device.id, "Someone"), /owner|allowed|permission/i);
    } finally {
      memberClient.stop();
    }
  } finally {
    owner.stop();
    await link.stop();
  }
});

test("a join request from a phone from before is named by its device, as it was", async () => {
  const { link, at } = await host();
  const ownerPairing = await pair(real, { hosts: [at], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" });
  const owner = new LinkClient(ownerPairing, { fetch: real, onParts() {}, onState() {} });
  try {
    const invite = await owner.call<any>("link.team.createInvite", { groupId: "g_everyone", days: 7, maxUses: 1 });
    const target = { hosts: [at], code: invite.code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name };
    const started = await startJoin(real, target, { name: "Sam's phone", platform: "ios", kind: "phone" });
    if (started.result.status !== "pending") throw new Error("not pending");
    assert.ok(!("person" in teamPart(link.store.data.team, true).requests[0]));
    await owner.call("link.team.approve", started.result.requestId);
    assert.equal(link.team().members[0].name, "Sam's phone");
    assert.ok(!("person" in link.store.data.devices.find((device: any) => device.memberId)));
  } finally {
    owner.stop();
    await link.stop();
  }
});

test("the store keeps a person, loads a file without one, and refuses an empty name", () => {
  const dir = folder("botkins-person-store-");
  const store = new LinkStore(dir);
  const named = store.addDevice({ name: "iPhone 17 Pro", platform: "ios", publicKey: random(32), person: " Jordan\u0007" });
  const plain = store.addDevice({ name: "iPhone", platform: "ios", publicKey: random(32), person: "  " });
  assert.equal(named.person, "Jordan");
  assert.ok(!("person" in plain));

  // A file written before persons were kept.
  const file = join(dir, "link.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  for (const device of saved.devices) delete device.person;
  writeFileSync(file, JSON.stringify(saved));
  const loaded = new LinkStore(dir);
  assert.equal(loaded.device(named.id).name, "iPhone 17 Pro");
  assert.ok(!("person" in loaded.device(named.id)));

  assert.equal(loaded.setPerson("missing", "Jordan"), false);
  assert.throws(() => loaded.setPerson(plain.id, " \n "), /Give the person a name/);
  assert.equal(loaded.setPerson(plain.id, "Sam"), true);
  assert.equal(new LinkStore(dir).device(plain.id).person, "Sam", "the name is saved");
});
