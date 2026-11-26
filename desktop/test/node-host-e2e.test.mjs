// Two-host end-to-end test:
// Source host runs `uname -a` on the node host under default `ask` policy over real LinkHost +
// TeamworkPeers transport. The node hands the approval back to the source, which approves it via the
// real `botkins node approve` CLI against its own control socket, and gets the real `uname -a` output
// and exit code 0 back.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { main } from "../cli/main.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";
import { installTeamworkPeers } from "../desktop/teamwork-peers.mjs";

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const sink = (write) => new Writable({ write(chunk, _, done) { write(chunk.toString()); done(); } });

async function startRealHost(t, { name, directory }) {
  const dir = mkdtempSync(join(tmpdir(), "bk-node-e2e-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  const runtime = running.runtime;
  await runtime.link.setEnabled(true);
  const client = controlClient(paths.socket, { timeout: 40_000 });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });

  // Same Botkins owner profile on both hosts
  runtime.link.store.set({
    profiles: {
      owner: { profileId: "owner-profile-1", deviceId: name, statusKey: "e2e-key", name: "Owner" },
      members: {},
    },
  });
  const address = "127.0.0.1:" + runtime.link.port;
  const row = {
    name,
    serverId: runtime.link.store.data.serverId,
    serverKey: runtime.link.store.data.keys.publicKey.toString("base64url"),
    member: false,
    hosts: [address],
  };
  directory.push(row);
  installTeamworkPeers(
    { workspace: runtime.workspace, link: runtime.link },
    {
      session: { profileId: "owner-profile-1" },
      token: () => "test-session-token",
      profileApi: () => ({ home: async () => ({ hosts: directory, profile: { id: "owner-profile-1" } }) }),
    },
  );
  const botkins = async (argv, { input = "", tty = false } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    const exit = await main(argv, {
      stdout: sink((text) => void (out += text)),
      stderr: sink((text) => void (err += text)),
      stdin,
      env: {},
      client,
    });
    return { exit, out, err };
  };
  return { dir, runtime, client, row, botkins };
}

async function until(read, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const val = await read();
    if (val) return val;
    await delay(25);
  }
  throw new Error("Timed out waiting for condition");
}

test("two-host E2E: source runs uname -a on node under ask, approves via CLI, gets real output back", async (t) => {
  const directory = [];
  const node = await startRealHost(t, { name: "Build Node", directory });
  const source = await startRealHost(t, { name: "Control Host", directory });

  // Configure node host with default `ask` policy via CLI
  assert.equal((await node.botkins(["node", "setup", "--name", "Build Node"])).exit, 0);
  assert.equal(node.runtime.workspace.nodeHost.execPolicy.mode, "ask");

  // Prepare a bot + active turn on the source host
  const botId = source.runtime.workspace.addBot({ name: "Operator", role: "Operations", instructions: "Run node tools." });
  const bot = source.runtime.workspace.bot(botId);
  const chatId = source.runtime.workspace.createChat(botId, "Node Check");
  const chat = source.runtime.workspace.chat(chatId);
  const run = { id: "run-e2e", chatId: chat.id, botId: bot.id, started: Date.now(), teamwork: [] };
  const task = { run, stopped: false, ended: false, helpers: new Set() };
  source.runtime.workspace.active.set(chat.id, task);
  t.after(() => source.runtime.workspace.active.delete(chat.id));

  // Source invokes node_exec (`system.run` with `["uname", "-a"]`) over the real peer transport
  const remotePromise = source.runtime.workspace.teamwork.runNodeOperation(chat, bot, run, task, "system.run", {
    host: node.row.serverId,
    argv: ["uname", "-a"],
  });

  // The approval is asked where the owner is: on the source host, in the asking chat. Poll the source's
  // CLI `botkins node approvals --json` until it arrives; the node has nothing to answer.
  const pending = await until(async () => {
    const res = await source.botkins(["node", "approvals", "--json"]);
    if (res.exit !== 0) return null;
    const list = JSON.parse(res.out);
    return list.length ? list[0] : null;
  });
  assert.equal(pending.chatId, chatId);
  assert.equal(pending.operation, "system.run");
  assert.equal(pending.sourceBotName, "Operator");
  assert.deepEqual(JSON.parse((await node.botkins(["node", "approvals", "--json"])).out), []);

  // Approve via real CLI `botkins node approve <request-id>` with interactive TTY choosing "1" (Allow once)
  const approveRes = await source.botkins(["node", "approve", pending.id], { input: "1\n", tty: true });
  assert.equal(approveRes.exit, 0, approveRes.err);

  // Source receives the real `uname -a` output back
  const rawJson = await remotePromise;
  const payload = JSON.parse(rawJson);
  const expectedUname = execFileSync("uname", ["-a"], { encoding: "utf8" }).trim();
  assert.equal(payload.operation, "system.run");
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.stdout.trim(), expectedUname);

  // Node's audit log records the completed command with exit code 0
  const auditRes = await node.botkins(["node", "audit", "--json"]);
  assert.equal(auditRes.exit, 0);
  const entries = JSON.parse(auditRes.out);
  assert.ok(entries.some((e) => e.operation === "system.run" && e.status === "completed" && e.exitCode === 0));
});
