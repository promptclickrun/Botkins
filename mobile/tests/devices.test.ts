// Several devices on one computer (docs/link-contract.md): two phones and another computer's app
// pair with one host, each with its own key, and are served at the same time. Pairing one more, or
// removing one, leaves the others as they were. A pairing made before devices had kinds still works.
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { b64u, newKeyPair } from "../link-host/crypto.mjs";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, LinkError, type LinkState, type Pairing, pair } from "../src/link/client";
import { isRelayHost, relayFetch } from "../src/link/relay";
import type { BotTask, ChatDetail, ChatSummary, Live, Meta, PairedDevice, PhoneRecord } from "../src/link/types";
import { FakeRelay } from "./fake-relay";

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
async function until(check: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** A client that keeps every part it is sent and every state it was in. */
function follow(pairing: Pairing, fetcher: FetchLike = real) {
  const parts: Record<string, any> = {};
  const states: LinkState[] = [];
  const seen = new Set<string>();
  const client = new LinkClient(pairing, {
    fetch: fetcher,
    onParts(next) {
      Object.assign(parts, next);
      // What a chat's stream looked like on the way, for each chat this client watches.
      for (const [chatId, text] of Object.entries((parts.live as Live | undefined)?.streams ?? {})) if (text) seen.add(chatId);
    },
    onState: (state) => void states.push(state),
  });
  client.start();
  return { client, parts, states, seen, pairing };
}
const THREE = [
  { name: "First phone", platform: "ios" },
  { name: "Second phone", platform: "android" },
  { name: "Studio Mac", platform: "darwin", kind: "desktop" as const },
];

async function host() {
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ relay: false, dir: folder("botkins-devices-"), backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  return { link, backend, at: "127.0.0.1:" + link.port };
}

test("three devices pair one after another, and each new one leaves the others as they were", async () => {
  const { link, at } = await host();
  const clients = [];
  for (const device of THREE) {
    const paired = await pair(real, { hosts: [at], code: link.startPairing().code }, device);
    clients.push(follow(paired));
    // Every client paired so far is still served, on the session it already had.
    for (const each of clients) {
      await until(() => each.states.at(-1) === "online", each.pairing.name + " online");
      assert.ok(Array.isArray(await each.client.call("models")));
      assert.ok(!each.states.includes("revoked"));
    }
  }
  // Each has its own id and its own secret key; none was handed another's.
  assert.equal(new Set(clients.map((each) => each.pairing.deviceId)).size, 3);
  assert.equal(new Set(clients.map((each) => each.pairing.secretKey)).size, 3);
  assert.ok((clients[0].parts.meta as Meta).capabilities.includes("devices-v1"));

  // The registry, as each of them reads it: three devices, with what each is and which one asks.
  for (const [index, each] of clients.entries()) {
    const list = await each.client.call<PairedDevice[]>("link.devices.list");
    assert.deepEqual(list.map((device) => [device.name, device.kind, device.platform]), [["First phone", "phone", "ios"], ["Second phone", "phone", "android"], ["Studio Mac", "desktop", "darwin"]]);
    assert.deepEqual(list.map((device) => !!device.current), [0, 1, 2].map((i) => i === index));
    assert.ok(list.every((device) => device.connected && device.createdAt > 0 && device.lastSeenAt >= device.createdAt));
    // Nothing of a key, a session or a notification address is in it.
    assert.deepEqual(Object.keys(list[0]).sort(), ["connected", "createdAt", "id", "kind", "lastSeenAt", "name", "platform", ...(list[0].current ? ["current"] : [])].sort());
  }
  // The computer's own page sees the same three (the desktop app's Settings reads this).
  assert.deepEqual(link.status().devices.map((device: { kind: string; connected: boolean }) => [device.kind, device.connected]), [["phone", true], ["phone", true], ["desktop", true]]);
  assert.ok(!JSON.stringify(link.status().devices).includes(clients[0].pairing.serverKey));
  for (const each of clients) each.client.stop();
  await link.stop();
});

test("a reply streams to all three at once, and what one changes the others see", async () => {
  const { link, at } = await host();
  const clients = [];
  for (const device of THREE) clients.push(follow(await pair(real, { hosts: [at], code: link.startPairing().code }, device)));
  for (const each of clients) await until(() => !!each.parts.chats, "the first state");
  const chatId = await clients[0].client.call<string>("createChat", "bot-mira");
  for (const each of clients) each.client.watch([chatId]);
  for (const each of clients) await until(() => !!each.parts["chat:" + chatId], "the chat's detail");

  // The other computer sends; the two phones and it all follow the same turn.
  await clients[2].client.call("send", chatId, "Plan the launch week");
  for (const each of clients) {
    await until(() => (each.parts["chat:" + chatId] as ChatDetail).messages.some((message) => message.role === "assistant"), each.pairing.name + " to get the reply", 10_000);
    assert.ok(each.seen.has(chatId), each.pairing.name + " saw the reply as it was written");
    const detail = each.parts["chat:" + chatId] as ChatDetail;
    assert.deepEqual(detail.messages.map((message) => message.role), ["user", "assistant"]);
    assert.match(detail.messages[1].text, /launch week/);
  }

  // The task board: one adds a task, every one of them has it.
  const taskId = await clients[1].client.call<string>("saveTask", { title: "Write the release notes" });
  for (const each of clients) await until(() => (each.parts.tasks as BotTask[]).some((task) => task.id === taskId), "the task on " + each.pairing.name);

  // Two of them act in the same moment: both chats and both tasks are there afterwards, on all three.
  const [a, b, t1, t2] = await Promise.all([
    clients[0].client.call<string>("createChat", "bot-mira"),
    clients[1].client.call<string>("createChat", "bot-mira"),
    clients[0].client.call<string>("saveTask", { title: "From the first phone" }),
    clients[2].client.call<string>("saveTask", { title: "From the other computer" }),
  ]);
  assert.notEqual(a, b);
  assert.notEqual(t1, t2);
  await Promise.all([clients[0].client.call("send", a, "First"), clients[1].client.call("send", b, "Second")]);
  for (const each of clients) {
    await until(() => [a, b].every((id) => (each.parts.chats as ChatSummary[]).some((chat) => chat.id === id)) && [t1, t2].every((id) => (each.parts.tasks as BotTask[]).some((task) => task.id === id)), "both changes on " + each.pairing.name);
    assert.equal(new Set((each.parts.tasks as BotTask[]).map((task) => task.id)).size, (each.parts.tasks as BotTask[]).length, "no task twice");
  }
  for (const each of clients) each.client.stop();
  await link.stop();
});

test("removing one device stops that one and only that one", async () => {
  const { link, at } = await host();
  const clients = [];
  for (const device of THREE) clients.push(follow(await pair(real, { hosts: [at], code: link.startPairing().code }, device)));
  for (const each of clients) await until(() => each.states.at(-1) === "online", "online");
  const [first, second, desk] = clients;
  const chatId = await first.client.call<string>("createChat", "bot-mira");
  for (const each of clients) each.client.watch([chatId]);

  // A phone renames the other computer, and removes the second phone.
  const renamed = await first.client.call<PairedDevice[]>("link.devices.rename", desk.pairing.deviceId, "  Office Mac  ");
  assert.equal(renamed.find((device) => device.id === desk.pairing.deviceId)?.name, "Office Mac");
  await until(() => (desk.parts.phones as Record<string, PhoneRecord>)[desk.pairing.deviceId]?.name === "Office Mac", "the new name on the renamed device");
  const left = await first.client.call<PairedDevice[]>("link.devices.remove", second.pairing.deviceId);
  assert.deepEqual(left.map((device) => device.name), ["First phone", "Office Mac"]);

  await until(() => second.states.includes("revoked"), "the removed phone to be told", 8000);
  await assert.rejects(second.client.call("models"), (error: unknown) => error instanceof LinkError && error.code === "revoked");
  // The others never noticed: same sessions, and a reply still streams to both.
  await first.client.call("send", chatId, "Still here?");
  for (const each of [first, desk]) {
    await until(() => (each.parts["chat:" + chatId] as ChatDetail | undefined)?.messages.some((message) => message.role === "assistant") === true, each.pairing.name + " to get the reply", 10_000);
    assert.ok(!each.states.includes("revoked") && !each.states.includes("offline"), each.pairing.name + " stayed online");
    assert.equal(Object.keys(each.parts.phones as object).length, 2);
  }
  assert.equal(link.status().devices.length, 2);
  // Words a person can read for a device that is gone, and no way to reach outside the list.
  await assert.rejects(first.client.call("link.devices.remove", second.pairing.deviceId), /no longer paired/);
  await assert.rejects(first.client.call("link.devices.rename", "__proto__", "x"), /no longer paired/);
  await assert.rejects(first.client.call("link.devices.rename", desk.pairing.deviceId, "   "), /Give the device a name/);

  // A device that removes itself is unpaired; the last one is untouched.
  const after = await desk.client.call<PairedDevice[]>("link.devices.remove", desk.pairing.deviceId);
  assert.deepEqual(after.map((device) => device.name), ["First phone"]);
  await until(() => desk.states.includes("revoked"), "the device that left to know");
  assert.ok(Array.isArray(await first.client.call("models")));
  for (const each of clients) each.client.stop();
  await link.stop();
});

test("another computer's app in front quiets a reply's ping, as this computer's own window does; a phone in front doesn't speak for the others", async () => {
  const { link, at } = await host();
  const phone = follow(await pair(real, { hosts: [at], code: link.startPairing().code }, THREE[0]));
  const desk = follow(await pair(real, { hosts: [at], code: link.startPairing().code }, THREE[2]));
  await until(() => phone.states.at(-1) === "online" && desk.states.at(-1) === "online", "online");
  assert.ok(!link.attention()?.focused);
  await phone.client.call("link.push.presence", true, "chat-1");
  assert.ok(!link.attention()?.focused, "a phone's own screen is its own business");
  await desk.client.call("link.push.presence", true, "chat-2");
  assert.deepEqual(link.attention(), { focused: true, chatId: "chat-2" });
  await desk.client.call("link.push.presence", false);
  assert.ok(!link.attention()?.focused);
  phone.client.stop();
  desk.client.stop();
  await link.stop();
});

test("a pairing made before the upgrade still works, with no new pairing", async () => {
  // Keep both records in the old format. Generate fresh keys for each test.
  const fixture = join(import.meta.dirname, "fixtures", "link-before-devices");
  const before = JSON.parse(readFileSync(join(fixture, "link.json"), "utf8"));
  assert.ok(!("kind" in before.devices[0]), "the fixture is from before");
  const dir = folder("botkins-upgrade-");
  const hostKeys = newKeyPair();
  const phoneKeys = newKeyPair();
  before.publicKey = b64u(hostKeys.publicKey);
  before.privateKey = b64u(hostKeys.privateKey);
  before.devices[0].publicKey = b64u(phoneKeys.publicKey);
  writeFileSync(join(dir, "link.json"), JSON.stringify(before));
  const link = new LinkHost({ relay: false, dir, backend: new MockBackend({ speed: 0.05 }), port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  assert.notEqual(link.port, 47610, "a test never sits on the real app's port");
  const saved = JSON.parse(readFileSync(join(fixture, "pairing.json"), "utf8")) as Pairing;
  saved.serverKey = before.publicKey;
  saved.secretKey = b64u(phoneKeys.privateKey);
  const old = follow({ ...saved, hosts: ["127.0.0.1:" + link.port] });
  await until(() => old.states.at(-1) === "online", "the old phone online");
  assert.equal((old.parts.meta as Meta).name, "Fixture Mac");
  assert.deepEqual((await old.client.call<PairedDevice[]>("link.devices.list")).map((device) => [device.id, device.name, device.kind, !!device.current]), [[saved.deviceId, "Old phone", "phone", true]]);

  // Two more pair with the upgraded computer. The old phone keeps its session and its key.
  const phone = follow(await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, THREE[1]));
  const desk = follow(await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, THREE[2]));
  await until(() => phone.states.at(-1) === "online" && desk.states.at(-1) === "online", "the new ones online");
  assert.ok(Array.isArray(await old.client.call("models")));
  assert.ok(!old.states.includes("revoked"));
  assert.deepEqual(link.status().devices.map((device: { kind: string }) => device.kind), ["phone", "phone", "desktop"]);
  // What is saved now still has everything the old file had, for the old phone.
  const now = JSON.parse(readFileSync(join(dir, "link.json"), "utf8"));
  assert.equal(now.version, before.version);
  assert.equal(now.publicKey, before.publicKey);
  assert.equal(now.devices[0].publicKey, before.devices[0].publicKey);
  assert.equal(now.devices[0].id, before.devices[0].id);
  for (const each of [old, phone, desk]) each.client.stop();
  await link.stop();
});

test("away from the computer's network, all three are served through the relay at once", async () => {
  const relay = new FakeRelay();
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ dir: folder("botkins-devices-relay-"), backend, port: 0, extraHosts: ["127.0.0.1"], searchPath: [], relay: { url: "https://relay.test", WebSocket: relay.WebSocket } });
  await link.setEnabled(true);
  link.setRelay({ enabled: true });
  await until(() => link.status().relay.connected, "the computer to reach the relay");
  const clients = [];
  for (const device of THREE) {
    // Paired at home, then away: each client has its own network, where only the relay answers.
    const paired = await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, device);
    const away: FetchLike = () => Promise.reject(new TypeError("Network request failed"));
    clients.push(follow({ ...paired, hosts: link.hosts().filter(isRelayHost) }, relayFetch(away, { WebSocket: relay.WebSocket as any, idleMs: 200 })));
  }
  for (const each of clients) await until(() => !!each.parts.chats, each.pairing.name + " through the relay", 10_000);
  const chatId = await clients[0].client.call<string>("createChat", "bot-mira");
  for (const each of clients) each.client.watch([chatId]);
  await clients[1].client.call("send", chatId, "Plan the launch week");
  for (const each of clients) {
    await until(() => (each.parts["chat:" + chatId] as ChatDetail | undefined)?.messages.some((message) => message.role === "assistant") === true, each.pairing.name + " to get the reply", 12_000);
    assert.equal(each.client.route, "relay");
  }
  // One is removed while away; the other two go on.
  await clients[0].client.call("link.devices.remove", clients[2].pairing.deviceId);
  await until(() => clients[2].states.includes("revoked"), "the removed one to be told", 10_000);
  assert.ok(Array.isArray(await clients[1].client.call("models")));
  for (const each of clients) each.client.stop();
  await link.stop();
});
