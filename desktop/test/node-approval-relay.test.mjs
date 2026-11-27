// A node host's approval is asked where the owner is: in the chat on the computer whose bot asked
// (and so on their phone), not on the node. The node still decides and enforces it.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Workspace as RealWorkspace } from "../desktop/workspace.mjs";
import { Workspace as StarterWorkspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

async function until(read, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(15);
  }
  throw new Error("Timed out waiting for condition");
}

const peer = {
  profileId: "owner-profile",
  serverId: "source-host",
  serverKey: "key-source",
  targetId: "node-host",
  targetKey: "key-node",
  name: "Workstation",
  verify: async () => {},
};

/** A source workspace whose bot runs `argv` on a real node workspace, wired straight through. */
function pair(t, argv) {
  const node = new RealWorkspace(join(tempDir(t), "node"), fakeClient().client, () => {});
  t.after(() => node.nodeHost.close());
  node.nodeHost.setup({ name: "Studio" });
  const calls = [];
  const { client } = fakeClient(async (_id, _options, session) => {
    try {
      const result = JSON.parse(await session.tool("node_exec", { host: "node-host", argv }));
      return { data: { content: "EXIT:" + result.exitCode + " OUT:" + String(result.stdout ?? "").trim() } };
    } catch (error) {
      return { data: { content: "ERR:" + error.message } };
    }
  });
  const source = new StarterWorkspace(join(tempDir(t), "source"), client, () => {});
  source.teamworkPeers = {
    available: () => true,
    hosts: async (withPin) => [{ serverId: "node-host", name: "Studio", ...(withPin && { pin: "pin" }) }],
    call: async (_id, op, data) => {
      calls.push(op);
      return node.nodeHost.receive(peer, op, structuredClone(data));
    },
  };
  return { node, source, calls };
}

test("the node's approval shows in the asking chat, and answering it there runs the job on the node", async (t) => {
  const { node, source, calls } = pair(t, ["echo", "hello"]);
  const chatId = source.createChat("pip");
  const sent = source.send(chatId, "Run it on the studio");

  const card = await until(() => source.interactions.snapshot().find((r) => r.chatId === chatId && r.kind === "permission"));
  assert.equal(card.dispatch, true);
  assert.match(card.title, /run a command on Studio/);
  assert.equal(card.preview, "echo hello");
  // Nothing to answer on the node: the owner isn't there.
  assert.deepEqual(node.interactions.snapshot(), []);

  source.interactions.respond(card.id, { action: "remember" });
  await sent;
  assert.equal(source.chat(chatId).messages.at(-1).text, "EXIT:0 OUT:hello");
  assert.ok(calls.includes("job.answer"));
  // The node kept the grant: the same command runs again without asking anyone.
  assert.equal(node.nodeHost.grants.length, 1);
  const again = source.send(chatId, "Again");
  await again;
  assert.equal(source.chat(chatId).messages.at(-1).text, "EXIT:0 OUT:hello");
  assert.deepEqual(source.interactions.snapshot(), []);
});

test("a denial in the chat denies the job on the node, and the card goes when the turn is stopped", async (t) => {
  const { node, source } = pair(t, ["echo", "no"]);
  const chatId = source.createChat("pip");
  const sent = source.send(chatId, "Run it");
  const card = await until(() => source.interactions.snapshot().find((r) => r.chatId === chatId));
  source.interactions.respond(card.id, { action: "deny" });
  await sent;
  assert.match(source.chat(chatId).messages.at(-1).text, /^ERR:.*declined/);
  assert.equal(node.nodeHost.grants.length, 0);

  const second = source.send(chatId, "Run it again");
  await until(() => source.interactions.snapshot().find((r) => r.chatId === chatId));
  source.stop(chatId);
  await second;
  await until(() => !source.interactions.snapshot().some((r) => r.chatId === chatId));
  await until(() => node.nodeHost.records.every((row) => row.status !== "pending" && row.status !== "working"));
});

test("an answer must name the node's current ask, and an older caller still gets the approval on the node", async (t) => {
  const node = new RealWorkspace(join(tempDir(t), "node"), fakeClient().client, () => {});
  t.after(() => node.nodeHost.close());
  node.nodeHost.setup({ name: "Studio" });
  const base = { sourceBotId: "pip", sourceBotName: "Pip", operation: "system.run", params: { argv: ["echo", "x"] }, createdAt: Date.now() };

  const relayed = crypto.randomUUID();
  const first = await node.nodeHost.receive(peer, "job.submit", { id: relayed, ...base, relayApproval: true });
  const { ask } = first.ask ? first : await until(() => node.nodeHost.receive(peer, "job.status", { id: relayed }).then((s) => s.ask && s));
  assert.match(ask.title, /run a command/);
  await assert.rejects(node.nodeHost.receive(peer, "job.answer", { id: relayed, askId: "stale", action: "approve" }), /closed/);
  await assert.rejects(node.nodeHost.receive(peer, "job.answer", { id: relayed, askId: ask.id, action: "sudo" }), /Unknown approval/);
  await node.nodeHost.receive(peer, "job.answer", { id: relayed, askId: ask.id, action: "deny" });
  assert.equal((await until(() => node.nodeHost.receive(peer, "job.status", { id: relayed }).then((s) => s.status === "denied" && s))).status, "denied");

  const legacy = crypto.randomUUID();
  await node.nodeHost.receive(peer, "job.submit", { id: legacy, ...base, createdAt: Date.now() });
  const local = await until(() => node.interactions.snapshot().find((r) => r.chatId === "node-job-" + legacy));
  assert.equal(local.nodeJob, true);
  assert.equal((await node.nodeHost.receive(peer, "job.status", { id: legacy })).ask, undefined);
  node.interactions.respond(local.id, { action: "deny" });
});
