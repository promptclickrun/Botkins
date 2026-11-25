// Focused unit tests for Node Host role, boundary checks, caps, grants, retries and profile publishing.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CAPABILITIES_VERSION,
  LIST_FILES_OPERATION,
  LIST_FILES_VERSION,
  listProjectFiles,
} from "../desktop/node-host.mjs";
import { Workspace as RealWorkspace } from "../desktop/workspace.mjs";
import { ProfileManager } from "../desktop/profile.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

function makePeer(overrides = {}) {
  return {
    profileId: "owner-profile",
    serverId: "host-a",
    serverKey: "key-a",
    name: "Laptop",
    targetId: "host-b",
    targetKey: "key-b",
    targetName: "Studio",
    verify: async () => {},
    ...overrides,
  };
}

test("listProjectFiles lists sorted entries, enforces boundaries, filters escaping symlinks and caps output", (t) => {
  const base = tempDir(t);
  const shared = join(base, "shared");
  const outside = join(base, "outside");
  mkdirSync(join(shared, "docs"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(shared, "readme.md"), "hello world");
  writeFileSync(join(shared, "docs", "notes.txt"), "notes");
  writeFileSync(join(outside, "secret.txt"), "top secret");

  // Symlinks: one staying inside the root, two escaping outside.
  symlinkSync(join(shared, "readme.md"), join(shared, "inside-link.md"));
  symlinkSync(join(outside, "secret.txt"), join(shared, "escape-file.txt"));
  symlinkSync(outside, join(shared, "escape-dir"));

  const rootListing = listProjectFiles(shared);
  assert.equal(rootListing.path, "");
  assert.equal(rootListing.truncated, false);
  const names = rootListing.entries.map((entry) => entry.name);
  assert.deepEqual(names, ["docs", "inside-link.md", "readme.md"]);
  assert.equal(rootListing.entries.find((e) => e.name === "docs").type, "directory");
  assert.equal(rootListing.entries.find((e) => e.name === "readme.md").size, 11);
  assert.ok(!names.includes("escape-file.txt"));
  assert.ok(!names.includes("escape-dir"));

  const subListing = listProjectFiles(shared, "docs");
  assert.equal(subListing.path, "docs");
  assert.deepEqual(subListing.entries.map((e) => e.name), ["notes.txt"]);

  // Boundary violations must throw.
  assert.throws(() => listProjectFiles(shared, "../outside"), /outside/i);
  assert.throws(() => listProjectFiles(shared, "docs/../../outside"), /outside/i);
  assert.throws(() => listProjectFiles(shared, "/etc"), /inside/i);
  assert.throws(() => listProjectFiles(shared, "C:\\Windows"), /inside/i);
  assert.throws(() => listProjectFiles(shared, "docs\0evil"), /disallowed/i);
  assert.throws(() => listProjectFiles(shared, "escape-dir"), /link outside/i);
  assert.throws(() => listProjectFiles(shared, "escape-dir/sub"), /does not exist|outside/i);

  // Entry cap and byte cap.
  const entryCapped = listProjectFiles(shared, "", { maxEntries: 2 });
  assert.equal(entryCapped.entries.length, 2);
  assert.equal(entryCapped.truncated, true);
  assert.equal(entryCapped.totalEntries, 3);

  const byteCapped = listProjectFiles(shared, "", { maxBytes: 50 });
  assert.equal(byteCapped.truncated, true);
  assert.ok(byteCapped.entries.length < 3);
  assert.equal(byteCapped.totalEntries, 3);
});

test("empty node host finishes setup without creating a bot, persists across restart, and fails interrupted working jobs", (t) => {
  const dir = tempDir(t);
  const dataDir = join(dir, "data");
  const folder = join(dir, "assets");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "hero.png"), "pngdata");

  const { client } = fakeClient();
  const ws = new RealWorkspace(dataDir, client, () => {});
  assert.equal(ws.state.bots.length, 0);
  assert.equal(ws.state.chats.length, 0);
  assert.equal(ws.state.settings.onboarded, false);

  const view = ws.nodeHost.setup({ name: "Studio Mac" });
  assert.equal(view.enabled, true);
  assert.equal(view.role, "node");
  assert.equal(view.name, "Studio Mac");
  assert.equal(view.online, true);
  assert.equal(ws.state.bots.length, 0);
  assert.equal(ws.state.settings.onboarded, true);

  const projectId = ws.projects.create({ name: "Assets", folder });
  ws.nodeHost.shareProject(projectId, true);

  // Simulate an interrupted in-flight job persisted on disk before shutdown.
  ws.nodeHost.records.push({
    id: randomUUID(),
    host: "some-host-digest",
    status: "working",
    createdAt: Date.now(),
  });
  ws.save();

  // Restart into a fresh Workspace from the same data directory.
  const restarted = new RealWorkspace(dataDir, client, () => {});
  assert.equal(restarted.state.bots.length, 0);
  assert.equal(restarted.state.settings.onboarded, true);
  assert.equal(restarted.nodeHost.enabled, true);
  assert.equal(restarted.nodeHost.name, "Studio Mac");
  assert.deepEqual(restarted.nodeHost.sharedProjects, [projectId]);
  assert.equal(restarted.nodeHost.records[0].status, "failed");

  const caps = restarted.nodeHost.capabilities();
  assert.equal(caps.version, CAPABILITIES_VERSION);
  assert.equal(caps.role, "node");
  assert.equal(caps.name, "Studio Mac");
  assert.equal(caps.online, true);
  assert.deepEqual(caps.operations, [{ id: LIST_FILES_OPERATION, version: LIST_FILES_VERSION, readOnly: true }]);
  assert.deepEqual(caps.projects, [{ id: projectId, name: "Assets" }]);
});

test("pause and disconnect gate capabilities and incoming node jobs", async (t) => {
  const dir = tempDir(t);
  const folder = join(dir, "repo");
  mkdirSync(folder, { recursive: true });
  const { client } = fakeClient();
  const ws = new RealWorkspace(join(dir, "data"), client, () => {});
  ws.nodeHost.setup({ name: "Build Box" });
  const projectId = ws.projects.create({ name: "Repo", folder });
  ws.nodeHost.shareProject(projectId, true);

  const peer = makePeer();
  const makeSubmit = () => ({
    id: randomUUID(),
    sourceBotId: "pip",
    sourceBotName: "Pip",
    operation: LIST_FILES_OPERATION,
    resourceId: projectId,
    path: "",
    createdAt: Date.now(),
  });

  ws.nodeHost.setPaused(true);
  assert.equal(ws.nodeHost.capabilities().online, false);
  assert.equal(ws.nodeHost.capabilities().paused, true);
  await assert.rejects(ws.nodeHost.receive(peer, "job.submit", makeSubmit()), /paused/i);

  ws.nodeHost.setPaused(false);
  assert.equal(ws.nodeHost.capabilities().online, true);

  ws.nodeHost.disconnect();
  const caps = ws.nodeHost.capabilities();
  assert.equal(caps.role, "standard");
  assert.deepEqual(caps.operations, []);
  assert.deepEqual(caps.projects, []);
  await assert.rejects(ws.nodeHost.receive(peer, "job.submit", makeSubmit()), /not enabled/i);
});

test("idempotent job.submit reuses the same request ID and rejects conflicting payloads", async (t) => {
  const dir = tempDir(t);
  const folder = join(dir, "shared");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a.txt"), "alpha");
  const { client } = fakeClient();
  const ws = new RealWorkspace(join(dir, "data"), client, () => {});
  ws.nodeHost.setup({ name: "Studio Mac" });
  const projectId = ws.projects.create({ name: "Shared", folder });
  ws.nodeHost.shareProject(projectId, true);

  const peer = makePeer();
  const payload = {
    id: randomUUID(),
    sourceBotId: "pip",
    sourceBotName: "Pip",
    operation: LIST_FILES_OPERATION,
    resourceId: projectId,
    path: "",
    createdAt: Date.now(),
  };

  const first = await ws.nodeHost.receive(peer, "job.submit", payload);
  assert.equal(first.status, "pending");
  // Duplicate submit with identical request ID & payload returns existing job without duplicating cards.
  const second = await ws.nodeHost.receive(peer, "job.submit", payload);
  assert.equal(second.status, "pending");
  assert.equal(ws.interactions.snapshot().length, 1);

  // Conflicting payload with the same request ID is rejected.
  await assert.rejects(
    ws.nodeHost.receive(peer, "job.submit", { ...payload, path: "other" }),
    /different job/i,
  );

  // Clean up pending card.
  ws.nodeHost.close();
});

test("ProfileManager.ensureLocalHost publishes an empty node host when nodeHost.enabled is true", async (t) => {
  const dir = tempDir(t);
  const { client } = fakeClient();
  const ws = new RealWorkspace(join(dir, "data"), client, () => {});
  ws.nodeHost.setup({ name: "Empty Node" });
  assert.equal(ws.state.bots.length, 0);
  assert.equal(ws.state.chats.length, 0);

  let enabled = false;
  let bound = 0;
  const putHosts = [];
  const serverKey = "A".repeat(43);
  const local = {
    status: () => ({
      enabled,
      listening: enabled,
      locked: false,
      serverId: "node-server-1",
      serverKey,
      name: "Empty Node",
    }),
    hosts: () => ["127.0.0.1:47610"],
    setEnabled: async (next) => { enabled = next === true; },
    bindOwnerProfile: async () => {
      bound++;
      return { serverId: "node-server-1", serverKey, name: "Empty Node", hosts: ["127.0.0.1:47610"] };
    },
  };
  const api = {
    start: async () => ({}),
    finish: async () => ({}),
    proof: async () => ({ ticket: "proof-1" }),
    putHost: async (_token, descriptor) => { putHosts.push(descriptor); },
    home: async () => ({ profile: { id: "owner-1" }, hosts: [] }),
  };
  const profile = new ProfileManager({
    file: join(dir, "profile.json"),
    protect: { wrap: (v) => v, unwrap: (v) => v },
    lib: { profileApi: api },
    local: () => local,
    workspace: () => !!ws.state.bots.length || !!ws.state.chats.length || !!ws.nodeHost?.enabled,
    changed: () => {},
    log: () => {},
  });
  profile.session = { profileId: "owner-1", deviceId: "dev-1", name: "Owner", token: "session-token" };
  profile.directory = { profile: { id: "owner-1" }, hosts: [] };

  const published = await profile.ensureLocalHost();
  assert.equal(enabled, true);
  assert.equal(bound, 1);
  assert.equal(putHosts.length, 1);
  assert.equal(published?.serverId, "node-server-1");
});
