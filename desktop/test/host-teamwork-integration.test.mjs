// Two real Link listeners, two workspaces and a separately paired approval device.
// Only the hosted profile directory and model providers are replaced by test doubles.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LinkHost } from "../desktop/link/server.mjs";
import { LinkClient, pair } from "../desktop/remote/link-client.mjs";
import { installTeamworkPeers } from "../desktop/teamwork-peers.mjs";
import { deviceCall } from "../desktop/device-call.mjs";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

async function computer(t, name, directory, answer) {
  const dir = tempDir(t);
  const listeners = new Set();
  const fake = fakeClient(answer);
  const workspace = new Workspace(join(dir, "workspace"), fake.client, () => listeners.forEach(fn => fn()));
  const link = new LinkHost({ dir: join(dir, "link"), port: 0, relay: false, backend: {
    info: () => ({ app: "botkins", version: "test", platform: process.platform }),
    snapshot: () => workspace.snapshot(),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    call: deviceCall({ workspace, folders: {}, handlers: {
      respond: (id, choice, person) => workspace.interactions.respond(id, choice, true, person),
    } }),
  } });
  await link.setEnabled(true);
  t.after(() => link.stop());
  link.store.set({ profiles: { owner: { profileId: "person", deviceId: name, statusKey: "testing", name: "Owner" }, members: {} } });
  const address = "127.0.0.1:" + link.port;
  const row = { name, serverId: link.store.data.serverId, serverKey: link.store.data.keys.publicKey.toString("base64url"), member: false, hosts: [address] };
  directory.push(row);
  installTeamworkPeers({ workspace, link }, {
    session: { profileId: "person" }, token: () => "test-session",
    profileApi: () => ({ home: async () => ({ hosts: directory, profile: { id: "person" } }) }),
  });
  return { row, workspace, link, address, log: fake.log };
}

async function until(read) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const result = read();
    if (result) return result;
    await delay(20);
  }
  throw new Error("Timed out waiting for the paired device");
}

test("a trusted device on the destination decides before the target runs and its reply reaches the source chat", async t => {
  const directory = [];
  const b = await computer(t, "Studio", directory, async (_id, { prompt }) => ({ data: { content: "Studio received " + prompt } }));
  const a = await computer(t, "Laptop", directory, async (_id, _options, session) => {
    const { hosts } = JSON.parse(await session.tool("list_host_teammates", {}));
    const { host, bots } = JSON.parse(await session.tool("list_host_teammates", { host: hosts[0].serverId }));
    const target = bots.find(bot => bot.name === "Scout");
    const { reply } = JSON.parse(await session.tool("ask_teammate", { host: host.serverId, teammate: target.id, message: "a signed-off question" }));
    return { data: { content: reply } };
  });

  const pairing = await pair(fetch, { hosts: [b.address], code: b.link.startPairing().code, serverKey: b.row.serverKey }, { name: "Owner phone", platform: "ios" });
  const parts = {};
  const owner = new LinkClient(pairing, { fetch, onParts: changes => Object.assign(parts, changes), onState() {} });
  t.after(() => owner.stop());
  owner.start();
  await until(() => parts.bots);
  const chat = a.workspace.createChat("pip");
  const turn = a.workspace.send(chat, "Source chat history stays on Laptop.");
  try {
    const card = await until(() => parts.live?.requests?.find(item => item.dispatch));
    assert.match(card.title, /Pip.*Laptop.*Scout.*Studio/);
    assert.equal(card.detail, "a signed-off question");
    assert.equal(b.log.sent.length, 0);
    assert.equal(a.workspace.interactions.snapshot().length, 0);
    await owner.call("respond", card.id, { action: "today" });
    await turn;
    assert.equal(a.workspace.chat(chat).messages.at(-1).text, "Studio received a signed-off question");
    assert.deepEqual(b.log.sent.map(([, body]) => body), ["a signed-off question"]);
    await assert.rejects(owner.call("respond", card.id, { action: "approve" }));
    assert.equal(b.log.sent.length, 1);
  } finally {
    await a.workspace.stop(chat);
    b.workspace.hostDispatch.close();
  }
});
