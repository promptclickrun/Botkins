import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./starter.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-cua-driver.mjs", import.meta.url));

function makeNodeWorkspace(t, { computerUse = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-node-cua-"));
  const logFile = join(dir, "node-cua.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const client = async () => ({
    createSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
    resumeSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
    deleteSession: async () => {},
  });

  const ws = new Workspace(dir, client, () => {}, {
    computerUse: {
      command: process.execPath,
      args: [FIXTURE],
      env: { FAKE_CUA_LOG: logFile },
    },
  });
  t.after(() => ws.computerUse.close());

  ws.nodeHost.setup({ name: "Mac Studio" });
  ws.setPreferences({ computerUse });
  const peer = {
    profileId: "prof-1",
    serverId: "srv-caller",
    serverKey: "key-caller",
    targetId: "srv-node",
    targetKey: "key-node",
    name: "MacBook Pro",
    targetName: "Mac Studio",
    verify: async () => {},
  };
  const readLog = () => {
    try {
      return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { ws, peer, readLog };
}

async function runRelayedJob(ws, peer, { operation, params = {}, answer = "approve" }) {
  const id = randomUUID();
  let status = await ws.nodeHost.receive(peer, "job.submit", {
    id,
    sourceBotId: "pip",
    sourceBotName: "Pip",
    operation,
    params,
    createdAt: Date.now(),
    relayApproval: true,
  });
  for (let i = 0; i < 60 && !["completed", "failed", "denied", "cancelled"].includes(status.status); i++) {
    if (status.ask) {
      status = await ws.nodeHost.receive(peer, "job.answer", { id, askId: status.ask.id, action: answer });
    } else {
      await new Promise((r) => setTimeout(r, 15));
      status = await ws.nodeHost.receive(peer, "job.status", { id });
    }
  }
  return status;
}

test("node host advertises computer.* only when computerUse is enabled and relays approvals (#290)", async (t) => {
  const { ws, peer, readLog } = makeNodeWorkspace(t, { computerUse: false });

  // Off by default: capabilities omit computer.* and submit rejects.
  const offOps = ws.nodeHost.capabilities().operations.map((o) => o.id);
  for (const op of ["computer.apps", "computer.observe", "computer.act"]) {
    assert.ok(!offOps.includes(op), `${op} must not be advertised when computerUse is off`);
  }
  await assert.rejects(
    () =>
      ws.nodeHost.receive(peer, "job.submit", {
        id: randomUUID(),
        sourceBotId: "pip",
        sourceBotName: "Pip",
        operation: "computer.apps",
        params: {},
        createdAt: Date.now(),
        relayApproval: true,
      }),
    /off on this node/i,
  );

  // Enable computerUse on the node host: capabilities now advertise computer.*.
  ws.setPreferences({ computerUse: true });
  const onOps = ws.nodeHost.capabilities().operations.map((o) => o.id);
  for (const op of ["computer.apps", "computer.observe", "computer.act"]) {
    assert.ok(onOps.includes(op), `${op} must be advertised when computerUse is on`);
  }

  // Run computer.apps, computer.observe, computer.act through relayed approval.
  const appsJob = await runRelayedJob(ws, peer, { operation: "computer.apps", params: {} });
  assert.equal(appsJob.status, "completed");
  assert.equal(appsJob.result.apps.length, 2);

  const obsJob = await runRelayedJob(ws, peer, { operation: "computer.observe", params: { pid: 4242 } });
  assert.equal(obsJob.status, "completed");
  assert.equal(obsJob.result.window_id, "win-1");

  const actJob = await runRelayedJob(ws, peer, {
    operation: "computer.act",
    params: { action: "click", pid: 4242, element_token: "tok-submit" },
  });
  assert.equal(actJob.status, "completed");
  assert.equal(actJob.result.delivery_mode, "background");
  assert.equal(actJob.result.effect.delivered, true);
  assert.equal(readLog().filter((c) => c.name === "click").length, 1);

  // Secure-field refusal applies on node hosts too!
  const secureJob = await runRelayedJob(ws, peer, {
    operation: "computer.act",
    params: { action: "type_text", pid: 4242, element_token: "tok-password", text: "secret" },
  });
  assert.equal(secureJob.status, "failed");
  assert.match(secureJob.error, /secure\/password field/i);
  assert.equal(readLog().filter((c) => c.name === "type_text").length, 0);
});

test("teamwork exposes node_computer_apps, node_computer_observe, and node_computer_act tools", (t) => {
  const { ws } = makeNodeWorkspace(t, { computerUse: true });
  const chatId = ws.createChat("pip");
  const chat = ws.chat(chatId);
  const bot = ws.bot("pip");
  const run = { id: "run-1", chatId, botId: bot.id };
  const task = { stopped: false, run };
  ws.active.set(chatId, task);
  t.after(() => ws.active.delete(chatId));

  // Force remote host availability so teamwork tools are exposed.
  ws.teamworkPeers = {
    available: () => true,
    configured: () => true,
    hosts: () => [{ id: "node-1", name: "Mac Studio", online: true }],
  };
  const tools = new Map(ws.teamwork.tools(bot, chat, run, task).map((tool) => [tool.name, tool]));
  for (const name of ["node_computer_apps", "node_computer_observe", "node_computer_act"]) {
    assert.ok(tools.has(name), `missing teamwork tool ${name}`);
  }
});
