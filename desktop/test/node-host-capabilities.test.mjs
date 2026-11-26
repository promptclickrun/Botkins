// Security and capability tests for Node Host operations:
// - Files (read, write, mkdir, move, delete, stat, search), path/symlink escapes, size limits, whole-computer opt-in
// - Shell exec (system.run, system.which), policy modes (deny / allowlist / ask / full), per-bot allowlist
// - Exact approval binding (post-approval command edit & script drift rejected), interpreter pinning, dangerous env
// - Computer control (screen.info, screen.capture, screen.input) and node.notify
// - Grant scoping (list never implies write/delete/exec; create never implies overwrite)
// - Kill switch (setPaused(true) kills a running exec process immediately)
// - Audit log recording and persistence
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Workspace as RealWorkspace } from "../desktop/workspace.mjs";
import { LIST_FILES_OPERATION } from "../desktop/node-host.mjs";
import { MAX_FILE_WRITE_BYTES, WHOLE_COMPUTER_RESOURCE } from "../desktop/node-files.mjs";
import { verifyExecBinding } from "../desktop/node-exec.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

const makePeer = (id = "host-a", name = "Workstation") => ({
  profileId: "owner-profile",
  serverId: id,
  serverKey: `key-${id}`,
  targetId: "node-target",
  targetKey: "key-node-target",
  hostName: name,
  verify: async () => {},
});

async function until(read, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const val = await read();
    if (val) return val;
    await delay(15);
  }
  throw new Error("Timed out waiting for condition");
}

async function submitAndWait(ws, peer, payload, { approve } = {}) {
  const id = payload.id ?? randomUUID();
  await ws.nodeHost.receive(peer, "job.submit", {
    id,
    sourceBotId: "bot-a",
    sourceBotName: "Helper",
    createdAt: Date.now(),
    ...payload,
  });
  if (approve) {
    const req = await until(() => ws.interactions.snapshot().find((r) => r.nodeJob && r.chatId === "node-job-" + id));
    const choice = typeof approve === "function" ? approve(req) : approve;
    ws.interactions.respond(req.id, { action: choice }, true);
  }
  return await until(async () => {
    const st = await ws.nodeHost.receive(peer, "job.status", { id });
    return st.status === "pending" || st.status === "working" ? null : st;
  });
}

test("files: CRUD, search, stat, traversal/symlink escapes, size limits, and wholeComputer opt-in", async (t) => {
  const dir = tempDir(t);
  const shared = join(dir, "shared");
  const outside = join(dir, "outside");
  mkdirSync(shared, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "top-secret");
  symlinkSync(join(outside, "secret.txt"), join(shared, "escape-file.txt"));
  symlinkSync(outside, join(shared, "escape-dir"));

  const { client } = fakeClient();
  const ws = new RealWorkspace(join(dir, "data"), client, () => {});
  t.after(() => ws.nodeHost.close());
  ws.nodeHost.setup({ name: "Files Node" });
  const projectId = ws.projects.create({ name: "Shared", folder: shared });
  ws.nodeHost.shareProject(projectId, true);
  const peer = makePeer();

  // mkdir
  const mk = await submitAndWait(ws, peer, { operation: "fs.mkdir", resourceId: projectId, params: { path: "sub/nested" } }, { approve: "approve" });
  assert.equal(mk.status, "completed");
  assert.equal(mk.result.created, true);

  // write (create) with Always allow
  const wr = await submitAndWait(
    ws,
    peer,
    { operation: "fs.write", resourceId: projectId, params: { path: "sub/nested/hello.txt", content: "hello world" } },
    { approve: "remember" },
  );
  assert.equal(wr.status, "completed");
  assert.equal(wr.result.overwritten, false);
  assert.equal(readFileSync(join(shared, "sub/nested/hello.txt"), "utf8"), "hello world");

  // Overwriting existing file without overwrite:true is rejected immediately
  await assert.rejects(
    submitAndWait(
      ws,
      peer,
      { operation: "fs.write", resourceId: projectId, params: { path: "sub/nested/hello.txt", content: "v2" } },
      { approve: "approve" },
    ),
    /already exists/i,
  );

  // Overwriting WITH overwrite:true requires its OWN destructive grant (fs.write.overwrite), NOT reusing fs.write Always allow!
  const overwriteId = randomUUID();
  await ws.nodeHost.receive(peer, "job.submit", {
    id: overwriteId,
    sourceBotId: "bot-a",
    sourceBotName: "Helper",
    operation: "fs.write",
    resourceId: projectId,
    params: { path: "sub/nested/hello.txt", content: "updated content", overwrite: true },
    createdAt: Date.now(),
  });
  const overwriteReq = await until(() =>
    ws.interactions.snapshot().find((r) => r.nodeJob && r.chatId === "node-job-" + overwriteId),
  );
  assert.equal(overwriteReq.operation, "fs.write.overwrite");
  ws.interactions.respond(overwriteReq.id, { action: "approve" }, true);
  const wrOver = await until(async () => {
    const st = await ws.nodeHost.receive(peer, "job.status", { id: overwriteId });
    return st.status === "pending" || st.status === "working" ? null : st;
  });
  assert.equal(wrOver.status, "completed");
  assert.equal(readFileSync(join(shared, "sub/nested/hello.txt"), "utf8"), "updated content");

  // read + stat + search
  const rd = await submitAndWait(ws, peer, { operation: "fs.read", resourceId: projectId, params: { path: "sub/nested/hello.txt" } }, { approve: "remember" });
  assert.equal(rd.status, "completed");
  assert.equal(rd.result.content, "updated content");

  const stRes = await submitAndWait(ws, peer, { operation: "fs.stat", resourceId: projectId, params: { path: "sub/nested/hello.txt" } }, { approve: "approve" });
  assert.equal(stRes.status, "completed");
  assert.equal(stRes.result.exists, true);
  assert.equal(stRes.result.type, "file");

  const srch = await submitAndWait(ws, peer, { operation: "fs.search", resourceId: projectId, params: { query: "updated" } }, { approve: "approve" });
  assert.equal(srch.status, "completed");
  assert.equal(srch.result.matches.length, 1);
  assert.equal(srch.result.matches[0].path, "sub/nested/hello.txt");

  // Traversal & symlink escape blocked immediately (even with fs.read Always allow)
  await assert.rejects(
    submitAndWait(ws, peer, { operation: "fs.read", resourceId: projectId, params: { path: "../outside/secret.txt" } }),
    /outside the shared folder|stays inside|escapes/i,
  );

  await assert.rejects(
    submitAndWait(ws, peer, { operation: "fs.read", resourceId: projectId, params: { path: "escape-file.txt" } }),
    /outside the shared folder|escapes/i,
  );

  await assert.rejects(
    submitAndWait(ws, peer, { operation: "fs.read", resourceId: projectId, params: { path: "escape-dir/secret.txt" } }),
    /outside the shared folder|escapes/i,
  );

  // Size limit enforced
  const huge = await submitAndWait(ws, peer, {
    operation: "fs.write",
    resourceId: projectId,
    params: { path: "big.txt", content: "x".repeat(MAX_FILE_WRITE_BYTES + 10) },
  });
  assert.equal(huge.status, "failed");
  assert.match(huge.error, /too large|limit|exceeds/i);

  // move + delete
  const mv = await submitAndWait(ws, peer, { operation: "fs.move", resourceId: projectId, params: { from: "sub/nested/hello.txt", to: "moved.txt" } }, { approve: "approve" });
  assert.equal(mv.status, "completed");
  assert.equal(existsSync(join(shared, "moved.txt")), true);

  const del = await submitAndWait(ws, peer, { operation: "fs.delete", resourceId: projectId, params: { path: "moved.txt" } }, { approve: "approve" });
  assert.equal(del.status, "completed");
  assert.equal(existsSync(join(shared, "moved.txt")), false);

  // Whole-computer scope refused while off, allowed once owner turns it on
  await assert.rejects(
    ws.nodeHost.receive(peer, "job.submit", {
      id: randomUUID(),
      sourceBotId: "bot-a",
      sourceBotName: "Helper",
      operation: "fs.read",
      resourceId: WHOLE_COMPUTER_RESOURCE,
      params: { path: join(outside, "secret.txt") },
      createdAt: Date.now(),
    }),
    /Whole-computer file access is (turned )?off/i,
  );
  ws.nodeHost.setWholeComputer(true);
  const wholeRd = await submitAndWait(
    ws,
    peer,
    { operation: "fs.read", resourceId: WHOLE_COMPUTER_RESOURCE, params: { path: join(outside, "secret.txt") } },
    { approve: "approve" },
  );
  assert.equal(wholeRd.status, "completed");
  assert.equal(wholeRd.result.content, "top-secret");
});

test("grant scoping: list_files grant never implies write, delete, or exec; bot grants do not leak across bots", async (t) => {
  const dir = tempDir(t);
  const shared = join(dir, "repo");
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "a.txt"), "alpha");
  const { client } = fakeClient();
  const ws = new RealWorkspace(join(dir, "data"), client, () => {});
  t.after(() => ws.nodeHost.close());
  ws.nodeHost.setup({ name: "Scoped Node" });
  const projectId = ws.projects.create({ name: "Repo", folder: shared });
  ws.nodeHost.shareProject(projectId, true);
  const peer = makePeer();

  // Grant Always allow for project.list_files to bot-a
  const listRes = await submitAndWait(
    ws,
    peer,
    { sourceBotId: "bot-a", operation: LIST_FILES_OPERATION, resourceId: projectId, path: "" },
    { approve: "remember" },
  );
  assert.equal(listRes.status, "completed");

  // Repeat list_files by bot-a runs without prompting
  const listAgain = await submitAndWait(ws, peer, { sourceBotId: "bot-a", operation: LIST_FILES_OPERATION, resourceId: projectId, path: "" });
  assert.equal(listAgain.status, "completed");

  // Same bot requesting fs.write MUST still prompt!
  const writeId = randomUUID();
  await ws.nodeHost.receive(peer, "job.submit", {
    id: writeId,
    sourceBotId: "bot-a",
    sourceBotName: "Helper",
    operation: "fs.write",
    resourceId: projectId,
    params: { path: "b.txt", content: "beta" },
    createdAt: Date.now(),
  });
  const writeReq = await until(() => ws.interactions.snapshot().find((r) => r.nodeJob && r.chatId === "node-job-" + writeId));
  assert.equal(writeReq.operation, "fs.write");
  ws.interactions.respond(writeReq.id, { action: "deny" }, true);
  const writeSt = await until(async () => {
    const s = await ws.nodeHost.receive(peer, "job.status", { id: writeId });
    return s.status === "pending" ? null : s;
  });
  assert.equal(writeSt.status, "denied");

  // Different bot requesting list_files MUST still prompt!
  const otherId = randomUUID();
  await ws.nodeHost.receive(peer, "job.submit", {
    id: otherId,
    sourceBotId: "bot-b",
    sourceBotName: "OtherBot",
    operation: LIST_FILES_OPERATION,
    resourceId: projectId,
    path: "",
    createdAt: Date.now(),
  });
  const otherReq = await until(() => ws.interactions.snapshot().find((r) => r.nodeJob && r.chatId === "node-job-" + otherId));
  ws.interactions.respond(otherReq.id, { action: "deny" }, true);
  await until(async () => (await ws.nodeHost.receive(peer, "job.status", { id: otherId })).status === "denied");
});

test("exec policy modes: deny, allowlist (per-node and per-bot), ask, full", async (t) => {
  const dir = tempDir(t);
  const { client } = fakeClient();
  const ws = new RealWorkspace(join(dir, "data"), client, () => {});
  t.after(() => ws.nodeHost.close());
  ws.nodeHost.setup({ name: "Exec Node" });
  const peer = makePeer();

  // Default mode is ask
  assert.equal(ws.nodeHost.execPolicy.mode, "ask");

  // 1. deny mode rejects immediately without creating an approval prompt
  ws.nodeHost.setExecMode("deny");
  await assert.rejects(
    submitAndWait(ws, peer, { operation: "system.run", params: { argv: ["uname", "-s"] } }),
    /disabled|deny/i,
  );
  assert.equal(ws.interactions.snapshot().length, 0);

  // 2. allowlist mode: per-bot rule matches only that bot; unmatched command is denied without prompting
  ws.nodeHost.setExecMode("allowlist");
  ws.nodeHost.addAllowlistRule({ pattern: "uname", botId: "bot-allowed" });

  const okAllowed = await submitAndWait(ws, peer, {
    sourceBotId: "bot-allowed",
    operation: "system.run",
    params: { argv: ["uname", "-s"] },
  });
  assert.equal(okAllowed.status, "completed");
  assert.equal(okAllowed.result.exitCode, 0);
  assert.ok(okAllowed.result.stdout.trim().length > 0);

  // Different bot is denied under bot-scoped allowlist rule
  await assert.rejects(
    submitAndWait(ws, peer, {
      sourceBotId: "bot-other",
      operation: "system.run",
      params: { argv: ["uname", "-s"] },
    }),
    /allowlist/i,
  );

  // Unmatched executable is denied under allowlist mode
  await assert.rejects(
    submitAndWait(ws, peer, {
      sourceBotId: "bot-allowed",
      operation: "system.run",
      params: { argv: ["echo", "nope"] },
    }),
    /allowlist/i,
  );

  // Wildcard (*) allowlist rule allows any bot
  ws.nodeHost.addAllowlistRule({ pattern: "echo", botId: "*" });
  const okWildcard = await submitAndWait(ws, peer, {
    sourceBotId: "bot-other",
    operation: "system.run",
    params: { argv: ["echo", "hi-node"] },
  });
  assert.equal(okWildcard.status, "completed");
  assert.equal(okWildcard.result.stdout.trim(), "hi-node");

  // 3. full mode allows shell string without prompting
  ws.nodeHost.setExecMode("full");
  const fullRes = await submitAndWait(ws, peer, {
    sourceBotId: "bot-other",
    operation: "system.run",
    params: { command: "printf 'full-ok'" },
  });
  assert.equal(fullRes.status, "completed");
  assert.equal(fullRes.result.stdout, "full-ok");

  // system.which locates binaries
  const whichRes = await submitAndWait(ws, peer, { operation: "system.which", params: { names: ["uname", "definitely-missing-binary-xyz"] } }, { approve: "approve" });
  assert.equal(whichRes.status, "completed");
  assert.ok(whichRes.result.found.uname);
  assert.equal(whichRes.result.found["definitely-missing-binary-xyz"], null);
});

test("approval binding: post-approval edit, unpinned interpreter, script drift, and dangerous env are rejected", async (t) => {
  const dir = tempDir(t);
  const scriptPath = join(dir, "pinned.mjs");
  writeFileSync(scriptPath, 'console.log("pinned-v1");\n');
  const { client } = fakeClient();
  const ws = new RealWorkspace(join(dir, "data"), client, () => {});
  t.after(() => ws.nodeHost.close());
  ws.nodeHost.setup({ name: "Binding Node" });
  const peer = makePeer();

  // Unpinned interpreter command (`node -e ...`) is refused under ask mode
  await assert.rejects(
    submitAndWait(ws, peer, {
      operation: "system.run",
      params: { argv: [process.execPath, "-e", "console.log('bad')"] },
    }),
    /pinned|full mode/i,
  );

  // Dangerous env var (`NODE_OPTIONS` / `PATH` / `LD_PRELOAD`) is refused under ask mode
  await assert.rejects(
    submitAndWait(ws, peer, {
      operation: "system.run",
      params: { argv: ["uname", "-s"], env: { LD_PRELOAD: "/tmp/evil.so" } },
    }),
    /blocked|override|LD_PRELOAD/i,
  );

  // Pinned interpreter script succeeds under ask mode when untouched
  const okPinned = await submitAndWait(
    ws,
    peer,
    { operation: "system.run", params: { argv: [process.execPath, scriptPath] } },
    { approve: "approve" },
  );
  assert.equal(okPinned.status, "completed");
  assert.equal(okPinned.result.stdout.trim(), "pinned-v1");

  // Post-approval command edit is rejected!
  const editId = randomUUID();
  await ws.nodeHost.receive(peer, "job.submit", {
    id: editId,
    sourceBotId: "bot-a",
    sourceBotName: "Helper",
    operation: "system.run",
    params: { argv: ["echo", "original"] },
    createdAt: Date.now(),
  });
  const editReq = await until(() => ws.interactions.snapshot().find((r) => r.nodeJob && r.chatId === "node-job-" + editId));
  // Simulate tampering with the queued job's argv right before approval completes
  const row = ws.nodeHost.records.find((r) => r.id === editId);
  row.params.argv = ["echo", "tampered"];
  ws.interactions.respond(editReq.id, { action: "approve" }, true);
  const edited = await until(async () => {
    const st = await ws.nodeHost.receive(peer, "job.status", { id: editId });
    return st.status === "pending" || st.status === "working" ? null : st;
  });
  assert.equal(edited.status, "failed");
  assert.match(edited.error, /binding|changed after approval/i);

  // Script file modified on disk between approval and execution is rejected!
  const driftId = randomUUID();
  await ws.nodeHost.receive(peer, "job.submit", {
    id: driftId,
    sourceBotId: "bot-a",
    sourceBotName: "Helper",
    operation: "system.run",
    params: { argv: [process.execPath, scriptPath] },
    createdAt: Date.now(),
  });
  const driftReq = await until(() => ws.interactions.snapshot().find((r) => r.nodeJob && r.chatId === "node-job-" + driftId));
  writeFileSync(scriptPath, 'console.log("TAMPERED");\n');
  ws.interactions.respond(driftReq.id, { action: "approve" }, true);
  const drifted = await until(async () => {
    const st = await ws.nodeHost.receive(peer, "job.status", { id: driftId });
    return st.status === "pending" || st.status === "working" ? null : st;
  });
  assert.equal(drifted.status, "failed");
  assert.match(drifted.error, /Pinned script changed|binding mismatch|changed after approval/i);

  // Direct verifyExecBinding check also rejects env change
  assert.throws(
    () =>
      verifyExecBinding(
        {
          argv: ["echo", "ok"],
          cwd: dir,
          env: { FOO: "bar" },
          resolvedExecutable: process.execPath,
          execHash: "0",
          pinnedScript: null,
          bindingHash: "deadbeef",
        },
        { argv: ["echo", "ok"], cwd: dir, env: { FOO: "mutated" } },
      ),
    /changed after approval|Executable changed/i,
  );
});

test("kill switch: pause immediately kills a running exec process and audit log persists across restart", async (t) => {
  const dir = tempDir(t);
  const dataDir = join(dir, "data");
  const { client } = fakeClient();
  const ws = new RealWorkspace(dataDir, client, () => {});
  t.after(() => ws.nodeHost.close());
  ws.nodeHost.setup({ name: "Kill Switch Node" });
  ws.nodeHost.setExecMode("full");
  const peer = makePeer();

  // Start a long-running child process that prints its PID and sleeps for 60s
  const jobId = randomUUID();
  await ws.nodeHost.receive(peer, "job.submit", {
    id: jobId,
    sourceBotId: "bot-a",
    sourceBotName: "Helper",
    operation: "system.run",
    params: { argv: [process.execPath, "-e", "console.log('PID=' + process.pid); setTimeout(() => {}, 60000);"] },
    createdAt: Date.now(),
  });

  // Wait until the process is running and has printed its PID
  const running = await until(async () => {
    const st = await ws.nodeHost.receive(peer, "job.status", { id: jobId });
    return st.status === "working" && /PID=\d+/.test(st.output?.stdout || "") ? st : null;
  });
  const childPid = Number(/PID=(\d+)/.exec(running.output.stdout)[1]);
  assert.ok(childPid > 0);

  // Trigger kill switch
  ws.nodeHost.setPaused(true);

  const stopped = await until(async () => {
    const st = await ws.nodeHost.receive(peer, "job.status", { id: jobId });
    return st.status === "working" ? null : st;
  });
  assert.equal(stopped.status, "cancelled");

  // Confirm the child process is actually gone
  await until(() => {
    try {
      process.kill(childPid, 0);
      return false;
    } catch (e) {
      return e.code === "ESRCH";
    }
  });

  // Audit log has the cancelled entry and persists across restart
  const log = ws.nodeHost.getAuditLog();
  assert.ok(log.some((e) => e.id === jobId && e.operation === "system.run" && e.status === "cancelled"));
  ws.nodeHost.close();

  const restarted = new RealWorkspace(dataDir, client, () => {});
  t.after(() => restarted.nodeHost.close());
  assert.ok(restarted.nodeHost.getAuditLog().some((e) => e.id === jobId && e.operation === "system.run"));
});

test("computer control (screen.info, screen.capture, screen.input) and node.notify gated by grants", async (t) => {
  const dir = tempDir(t);
  const { client } = fakeClient();
  const ws = new RealWorkspace(join(dir, "data"), client, () => {});
  t.after(() => ws.nodeHost.close());
  const injected = [];
  const shown = [];
  ws.nodeAdapters = {
    screen: {
      displays: async () => [{ id: "main", name: "Main Display", width: 1440, height: 900, primary: true }],
      capture: async () => ({
        jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        width: 1280,
        height: 800,
      }),
      permissions: async () => ({ screenRecording: true, accessibility: true }),
    },
    injector: async (displayId, events) => {
      injected.push({ display: displayId, count: events.length, first: events[0] });
    },
    notify: (note) => shown.push(note),
  };
  ws.nodeHost.setup({ name: "Desktop Node" });
  const peer = makePeer();

  // Capabilities now advertise screen.* too
  const opIds = ws.nodeHost.capabilities().operations.map((o) => o.id);
  for (const op of ["screen.info", "screen.capture", "screen.input", "node.notify"]) {
    assert.ok(opIds.includes(op), `missing ${op}`);
  }

  const info = await submitAndWait(ws, peer, { operation: "screen.info", params: {} }, { approve: "approve" });
  assert.equal(info.status, "completed");
  assert.equal(info.result.displays[0].id, "main");
  assert.equal(info.result.available, true);

  const cap = await submitAndWait(ws, peer, { operation: "screen.capture", params: { display: "main" } }, { approve: "approve" });
  assert.equal(cap.status, "completed");
  assert.equal(cap.result.mime, "image/jpeg");
  assert.equal(cap.result.dataBase64, Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"));

  const inp = await submitAndWait(
    ws,
    peer,
    { operation: "screen.input", params: { display: "main", events: [{ type: "click", x: 0.5, y: 0.5 }] } },
    { approve: "approve" },
  );
  assert.equal(inp.status, "completed");
  assert.equal(inp.result.count, 1);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].first.type, "click");

  const note = await submitAndWait(
    ws,
    peer,
    { operation: "node.notify", params: { title: "Build done", body: "All green" } },
    { approve: "approve" },
  );
  assert.equal(note.status, "completed");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, "Build done");
});
