// CLI & control-socket tests for node host approvals, `botkins chats approve` with node-job IDs,
// `interactions.list`, NEEDS_YES enforcement on `chat.respond`, and node policy/allowlist/audit CLI commands.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
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

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const sink = (write) => new Writable({ write(chunk, _, done) { write(chunk.toString()); done(); } });

async function startNodeService(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-node-cli-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
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
  return { dir, runtime: running.runtime, client, botkins };
}

async function until(read, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const val = await read();
    if (val) return val;
    await delay(15);
  }
  throw new Error("Timed out waiting for condition");
}

test("CLI node approvals, node approve (TTY & non-TTY), chats approve with node-job id, and NEEDS_YES gate", async (t) => {
  const { runtime, client, botkins } = await startNodeService(t);
  await botkins(["node", "setup", "--name", "Approval Box"]);
  const peer = {
    profileId: "owner",
    serverId: "host-a",
    serverKey: "key-host-a",
    targetId: "node-a",
    targetKey: "key-node-a",
    hostName: "Laptop",
    verify: async () => {},
  };

  // Trigger a pending node-job approval
  const job1 = randomUUID();
  await runtime.workspace.nodeHost.receive(peer, "job.submit", {
    id: job1,
    sourceBotId: "bot-a",
    sourceBotName: "Scout",
    operation: "system.run",
    params: { argv: ["echo", "approved-via-node-cli"] },
    createdAt: Date.now(),
  });
  const pending1 = await until(() =>
    runtime.workspace.interactions.snapshot().find((r) => r.nodeJob && r.chatId === "node-job-" + job1),
  );

  // 1. interactions.list RPC returns the nodeJob entry
  const listed = await client.call("interactions.list");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, pending1.id);
  assert.equal(listed[0].nodeJob, true);
  assert.equal(listed[0].chatId, "node-job-" + job1);

  // 2. `botkins node approvals --json` lists it
  const appJson = await botkins(["node", "approvals", "--json"]);
  assert.equal(appJson.exit, 0);
  const parsed = JSON.parse(appJson.out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, pending1.id);
  assert.equal(parsed[0].operation, "system.run");

  // 3. chat.respond MUST still refuse a yes without `{ agreed: true }`
  for (const action of ["approve", "today", "remember"]) {
    await assert.rejects(client.call("chat.respond", pending1.id, { action }), { code: "NEEDS_YES" });
  }
  await assert.rejects(client.call("chat.respond", pending1.id, { action: "approve" }, { agreed: "yes" }), { code: "NEEDS_YES" });

  // 4. `botkins node approve` refuses without a TTY
  const noTty = await botkins(["node", "approve", pending1.id], { input: "1\n", tty: false });
  assert.notEqual(noTty.exit, 0);
  assert.match(noTty.err, /interactive terminal/i);

  // 5. `botkins node approve` succeeds with a TTY choosing "1" (Allow once)
  const approved1 = await botkins(["node", "approve", pending1.id], { input: "1\n", tty: true });
  assert.equal(approved1.exit, 0, approved1.err);
  const res1 = await until(async () => {
    const st = await runtime.workspace.nodeHost.receive(peer, "job.status", { id: job1 });
    return st.status === "pending" || st.status === "working" ? null : st;
  });
  assert.equal(res1.status, "completed");
  assert.equal(res1.result.stdout.trim(), "approved-via-node-cli");

  // 6. `botkins chats approve <node-job-id>` and `botkins chats approve <request-id>` both work (no "Unknown chat" error!)
  const job2 = randomUUID();
  await runtime.workspace.nodeHost.receive(peer, "job.submit", {
    id: job2,
    sourceBotId: "bot-a",
    sourceBotName: "Scout",
    operation: "system.run",
    params: { argv: ["echo", "approved-via-chats-cli"] },
    createdAt: Date.now(),
  });
  await until(() => runtime.workspace.interactions.snapshot().find((r) => r.nodeJob && r.chatId === "node-job-" + job2));

  const approved2 = await botkins(["chats", "approve", "node-job-" + job2], { input: "1\n", tty: true });
  assert.equal(approved2.exit, 0, approved2.err);
  const res2 = await until(async () => {
    const st = await runtime.workspace.nodeHost.receive(peer, "job.status", { id: job2 });
    return st.status === "pending" || st.status === "working" ? null : st;
  });
  assert.equal(res2.status, "completed");
  assert.equal(res2.result.stdout.trim(), "approved-via-chats-cli");
});

test("CLI node policy, allowlist, whole-computer, audit, status and pause commands", async (t) => {
  const { dir, runtime, botkins } = await startNodeService(t);
  const folder = join(dir, "proj");
  mkdirSync(folder, { recursive: true });
  runtime.workspace.projects.create({ name: "Proj", folder });

  assert.equal((await botkins(["node", "setup", "--name", "Policy Box"])).exit, 0);
  assert.equal((await botkins(["node", "policy", "allowlist"])).exit, 0);
  assert.equal((await botkins(["node", "allowlist", "--add", "uname", "--bot", "bot-1"])).exit, 0);
  assert.equal((await botkins(["node", "whole-computer", "on"])).exit, 0);

  const listRules = await botkins(["node", "allowlist", "--json"]);
  assert.equal(listRules.exit, 0);
  const rules = JSON.parse(listRules.out);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].pattern, "uname");
  assert.equal(rules[0].botId, "bot-1");

  // Run allowlisted command, then inspect via `node status` and `node audit`
  const peer = {
    profileId: "owner",
    serverId: "host-a",
    serverKey: "key-host-a",
    targetId: "node-a",
    targetKey: "key-node-a",
    hostName: "Laptop",
    verify: async () => {},
  };
  const jobId = randomUUID();
  await runtime.workspace.nodeHost.receive(peer, "job.submit", {
    id: jobId,
    sourceBotId: "bot-1",
    sourceBotName: "Scout",
    operation: "system.run",
    params: { argv: ["uname", "-s"] },
    createdAt: Date.now(),
  });
  await until(async () => (await runtime.workspace.nodeHost.receive(peer, "job.status", { id: jobId })).status === "completed");

  const statusOut = await botkins(["node", "status"]);
  assert.equal(statusOut.exit, 0);
  assert.match(statusOut.out, /allowlist/i);
  assert.match(statusOut.out, /Whole computer\s+enabled/i);
  assert.match(statusOut.out, /Recent audit log/i);
  assert.match(statusOut.out, /system\.run/);

  const auditOut = await botkins(["node", "audit", "--json"]);
  assert.equal(auditOut.exit, 0);
  const auditEntries = JSON.parse(auditOut.out);
  assert.ok(auditEntries.some((e) => e.id === jobId && e.exitCode === 0));

  // Remove allowlist rule, toggle whole-computer off, pause & resume
  assert.equal((await botkins(["node", "allowlist", "--remove", rules[0].id])).exit, 0);
  assert.equal((await botkins(["node", "whole-computer", "off"])).exit, 0);
  assert.equal((await botkins(["node", "pause"])).exit, 0);
  assert.equal(runtime.workspace.nodeHost.paused, true);
  assert.equal((await botkins(["node", "resume"])).exit, 0);
  assert.equal(runtime.workspace.nodeHost.paused, false);
});
