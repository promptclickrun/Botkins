// Tests for Settings › Storage on mobile: formatting/preset logic, LinkHost RPC owner-only
// enforcement, MockBackend workspaceStats/workspacePrune, and trimmed run rendering.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost, authorize } from "../link-host/index.mjs";
import { REMOTE_METHODS, remoteArgs } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { LinkClient, pair } from "../src/link/client";
import type { Run, WorkspacePruneResult, WorkspaceStats } from "../src/link/types";
import { formatStorageBytes, parseCustomDays, presetForDays } from "../src/features/settings/storageLogic";
import { formatFeedWork, groupForOpenMode, stepHeadline } from "../src/features/chat/activityModel";

const fetcher = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => {
  const response = await fetch(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body instanceof Uint8Array ? Buffer.from(init.body) : init?.body,
    signal: init?.signal,
  });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    arrayBuffer: () => response.arrayBuffer(),
  };
};

test("storageLogic formats bytes and resolves day presets cleanly", () => {
  assert.equal(formatStorageBytes(512), "512 B");
  assert.equal(formatStorageBytes(2048), "2.0 KB");
  assert.equal(formatStorageBytes(106 * 1024 * 1024), "106.0 MB");

  assert.equal(presetForDays(7), "7");
  assert.equal(presetForDays(14), "14");
  assert.equal(presetForDays(30), "30");
  assert.equal(presetForDays(90), "90");
  assert.equal(presetForDays(45), "custom");

  assert.equal(parseCustomDays("45"), 45);
  assert.equal(parseCustomDays(" 1 "), 1);
  assert.equal(parseCustomDays("3650"), 3650);
  assert.equal(parseCustomDays("0"), null);
  assert.equal(parseCustomDays("-5"), null);
  assert.equal(parseCustomDays("3651"), null);
  assert.equal(parseCustomDays("abc"), null);
});

test("REMOTE_METHODS, remoteArgs, and authorize enforce owner-only workspace prune RPCs", () => {
  assert.ok(REMOTE_METHODS.has("workspaceStats"));
  assert.ok(REMOTE_METHODS.has("workspacePrune"));

  assert.deepEqual(remoteArgs("workspaceStats", []), []);
  assert.deepEqual(remoteArgs("workspacePrune", [{ keepDays: 30, keepRuns: 100, mode: "trim", dryRun: true }]), [
    { keepDays: 30, keepRuns: 100, mode: "trim", dryRun: true },
  ]);
  assert.throws(() => remoteArgs("workspacePrune", [{ keepDays: 0 }]), /1 to 3,650/);
  assert.throws(() => remoteArgs("workspacePrune", [{ mode: "nuke" }]), /trim or delete/);

  const team = {
    roles: [{ id: "admin", name: "Admin", permissions: { agents: ["view", "chat", "manage"], settings: ["view", "manage"] } }],
    groups: [{ id: "g1", name: "Team", roleId: "admin", bots: "all" }],
    members: [{ id: "m1", name: "Sam", groupId: "g1" }],
  };
  const owner = { kind: "owner" };
  const member = { kind: "member", memberId: "m1", id: "m1", groupId: "g1", roleId: "admin" };

  assert.equal(authorize(owner, team, "workspaceStats", []), "");
  assert.equal(authorize(owner, team, "workspacePrune", [{ dryRun: true }]), "");
  assert.match(authorize(member, team, "workspaceStats", []), /owner/i);
  assert.match(authorize(member, team, "workspacePrune", [{ dryRun: true }]), /owner/i);
  assert.match(authorize(member, team, "setPreferences", [{ workspacePrune: { auto: true } }]), /display preferences only|owner|role/i);
});

test("end-to-end LinkClient workspaceStats, dryRun preview, trim prune, and trimmed run rendering", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-storage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const backend = new MockBackend({ speed: 0.01 });
  const day = 24 * 60 * 60 * 1000;
  const oldTime = Date.now() - 60 * day;
  const chatId = backend.state.chats[0].id;
  backend.state.runs.push({
    id: "run-old-heavy",
    chatId,
    title: "Old heavy run",
    time: oldTime,
    finished: oldTime + 5000,
    status: "Completed",
    detail: "",
    summary: "Ran 1 command",
    usage: { input: 500, output: 120 },
    steps: [
      {
        id: "step-old-1",
        name: "bash",
        label: "npm run lint",
        input: JSON.stringify({ command: "npm run lint" }),
        output: "ok\n".repeat(2000),
        status: "Done",
        started: oldTime + 100,
        finished: oldTime + 2000,
      },
    ],
  });

  const link = new LinkHost({ dir, backend, port: 0, relay: false, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  t.after(() => link.stop());

  const paired = await pair(
    fetcher,
    { hosts: [`127.0.0.1:${link.port}`], code: link.startPairing().code },
    { name: "Test Phone", platform: "ios" },
  );
  const client = new LinkClient(paired, { fetch: fetcher, onState() {}, onParts() {} });
  t.after(() => client.stop());

  const stats = await client.call<WorkspaceStats>("workspaceStats");
  assert.ok(stats.bytes > 5000);
  assert.ok(stats.runCount >= 1);

  const preview = await client.call<WorkspacePruneResult>("workspacePrune", {
    keepDays: 30,
    keepRuns: 0,
    mode: "trim",
    dryRun: true,
  });
  assert.equal(preview.dryRun, true);
  assert.ok(preview.trimmedCount >= 1);
  assert.ok(preview.savedBytes > 4000);
  // Still unmutated after dry run.
  const beforeRun = backend.state.runs.find((r: Run) => r.id === "run-old-heavy");
  assert.ok(beforeRun?.steps?.[0]?.output);

  const done = await client.call<WorkspacePruneResult>("workspacePrune", {
    keepDays: 30,
    keepRuns: 0,
    mode: "trim",
    dryRun: false,
  });
  assert.equal(done.dryRun, false);
  assert.ok(done.trimmedCount >= 1);
  assert.ok(done.archivePath?.endsWith(".json.gz"));

  // Trimmed run renders cleanly on mobile chat timeline helpers without crashing.
  const trimmedRun: Run = backend.state.runs.find((r: Run) => r.id === "run-old-heavy");
  assert.ok(trimmedRun);
  assert.equal(trimmedRun.steps?.[0]?.output, undefined);
  assert.equal(trimmedRun.steps?.[0]?.input, undefined);
  assert.ok(stepHeadline(trimmedRun.steps![0]).includes("npm run lint"));
  const groups = groupForOpenMode(trimmedRun.steps!);
  assert.equal(groups.length, 1);
  const feed = formatFeedWork(trimmedRun);
  assert.equal(feed.stepCount, 1);
  assert.ok(feed.summary.length > 0);
});
