// Two real Link listeners, two workspaces and a paired trusted device for Node Host mode.
// Covers the full 6-step acceptance flow from docs/node-host.md, plus deny, boundary checks,
// sleeping/unavailable node discovery, separate grants from conversations, and retry idempotency.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LinkHost } from "../desktop/link/server.mjs";
import { LinkClient, pair } from "../desktop/remote/link-client.mjs";
import { installTeamworkPeers } from "../desktop/teamwork-peers.mjs";
import { deviceCall } from "../desktop/device-call.mjs";
import { Workspace as RealWorkspace } from "../desktop/workspace.mjs";
import { Workspace as StarterWorkspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

async function startComputer(t, { dir, name, directory, answer, empty = false }) {
  const listeners = new Set();
  const fake = fakeClient(answer);
  const WorkspaceClass = empty ? RealWorkspace : StarterWorkspace;
  const workspace = new WorkspaceClass(join(dir, "workspace"), fake.client, () => listeners.forEach((fn) => fn()));
  const link = new LinkHost({
    dir: join(dir, "link"),
    port: 0,
    relay: false,
    backend: {
      info: () => ({ app: "botkins", version: "test", platform: process.platform }),
      snapshot: () => workspace.snapshot(),
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      call: deviceCall({
        workspace,
        folders: {},
        handlers: {
          respond: (id, choice, person) => workspace.interactions.respond(id, choice, true, person),
        },
      }),
    },
  });
  await link.setEnabled(true);
  t.after(async () => {
    workspace.nodeHost.close();
    workspace.hostDispatch.close();
    await link.stop();
  });
  link.store.set({
    profiles: {
      owner: { profileId: "person", deviceId: name, statusKey: "testing", name: "Owner" },
      members: {},
    },
  });
  const address = "127.0.0.1:" + link.port;
  const row = {
    name,
    serverId: link.store.data.serverId,
    serverKey: link.store.data.keys.publicKey.toString("base64url"),
    member: false,
    hosts: [address],
  };
  const existingIndex = directory.findIndex((item) => item.serverId === row.serverId);
  if (existingIndex >= 0) directory[existingIndex] = row;
  else directory.push(row);
  installTeamworkPeers(
    { workspace, link },
    {
      session: { profileId: "person" },
      token: () => "test-session",
      profileApi: () => ({ home: async () => ({ hosts: directory, profile: { id: "person" } }) }),
    },
  );
  return { dir, row, workspace, link, address, log: fake.log };
}

async function until(read, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = read();
    if (result) return result;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}

test("acceptance flow: pair fresh empty node, restart, approve list_node_files, repeat without prompt, revoke, prompt again", async (t) => {
  const directory = [];
  const nodeDir = tempDir(t);
  const hostADir = tempDir(t);
  const sharedRoot = join(tempDir(t), "StudioAssets");
  const outsideRoot = join(tempDir(t), "OutsideSecret");
  mkdirSync(join(sharedRoot, "renders"), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  writeFileSync(join(sharedRoot, "manifest.json"), '{"v":1}');
  writeFileSync(join(sharedRoot, "renders", "frame01.png"), "png");
  writeFileSync(join(outsideRoot, "private.key"), "secret");
  symlinkSync(outsideRoot, join(sharedRoot, "escape-link"));

  // Step 1: Pair a fresh empty node (no bots, no chats), set up as Node Host and share a project folder.
  let node = await startComputer(t, { dir: nodeDir, name: "Studio Mac", directory, empty: true });
  assert.equal(node.workspace.state.bots.length, 0);
  assert.equal(node.workspace.state.chats.length, 0);
  node.workspace.nodeHost.setup({ name: "Studio Mac" });
  const projectId = node.workspace.projects.create({ name: "Studio Assets", folder: sharedRoot });
  node.workspace.nodeHost.shareProject(projectId, true);

  const pairing = await pair(
    fetch,
    { hosts: [node.address], code: node.link.startPairing().code, serverKey: node.row.serverKey },
    { name: "Owner phone", platform: "ios" },
  );

  // Step 2: Finish setup and restart the node host cleanly.
  node.workspace.nodeHost.close();
  await node.link.stop();
  node = await startComputer(t, { dir: nodeDir, name: "Studio Mac", directory, empty: true });
  assert.equal(node.workspace.state.bots.length, 0);
  assert.equal(node.workspace.state.settings.onboarded, true);
  assert.equal(node.workspace.nodeHost.enabled, true);
  assert.equal(node.workspace.nodeHost.name, "Studio Mac");

  // Reconnect the paired trusted device to the restarted node's new ephemeral port.
  const parts = {};
  const owner = new LinkClient(
    { ...pairing, hosts: [node.address] },
    { fetch, onParts: (changes) => Object.assign(parts, changes), onState() {} },
  );
  t.after(() => owner.stop());
  owner.start();
  await until(() => Array.isArray(parts.bots));

  // Start Host A with a scripted stand-in model driven by the prompt text.
  const hostA = await startComputer(t, {
    dir: hostADir,
    name: "Laptop",
    directory,
    answer: async (_id, { prompt }, session) => {
      if (prompt === "discover-and-list") {
        const discovered = JSON.parse(await session.tool("list_node_hosts", {}));
        const studio = discovered.hosts.find((item) => item.serverId === node.row.serverId);
        assert.ok(studio, "Studio Mac should be discovered");
        assert.equal(studio.name, "Studio Mac");
        assert.equal(studio.online, true);
        assert.equal(studio.version, 1);
        assert.equal(studio.projects[0].id, projectId);
        try {
          const result = JSON.parse(
            await session.tool("list_node_files", { host: studio.serverId, project: projectId }),
          );
          return { data: { content: "FILES:" + result.entries.map((e) => e.name).join(",") } };
        } catch (error) {
          return { data: { content: "ERROR:" + error.message } };
        }
      }
      if (prompt === "list-subdir") {
        const result = JSON.parse(
          await session.tool("list_node_files", {
            host: node.row.serverId,
            project: projectId,
            path: "renders",
          }),
        );
        return { data: { content: "SUB:" + result.entries.map((e) => e.name).join(",") } };
      }
      if (prompt === "list-escape-dotdot") {
        try {
          await session.tool("list_node_files", {
            host: node.row.serverId,
            project: projectId,
            path: "../OutsideSecret",
          });
          return { data: { content: "ESCAPED" } };
        } catch (error) {
          return { data: { content: "BLOCKED:" + error.message } };
        }
      }
      if (prompt === "list-escape-symlink") {
        try {
          await session.tool("list_node_files", {
            host: node.row.serverId,
            project: projectId,
            path: "escape-link",
          });
          return { data: { content: "ESCAPED" } };
        } catch (error) {
          return { data: { content: "BLOCKED:" + error.message } };
        }
      }
      return { data: { content: "unknown" } };
    },
  });

  const chat = hostA.workspace.mainChat("pip");

  // Step 3: First run asks on the trusted device; approve with Always allow ("remember").
  const firstTurn = hostA.workspace.send(chat, "discover-and-list");
  const card1 = await until(() => parts.live?.requests?.find((item) => item.nodeJob));
  assert.equal(card1.dispatch, true);
  assert.equal(card1.nodeJob, true);
  assert.match(card1.title, /Pip.*Laptop.*Studio Assets.*Studio Mac/);
  assert.match(card1.detail, /project\.list_files/);
  await owner.call("respond", card1.id, { action: "remember" });
  await firstTurn;
  assert.equal(hostA.workspace.chat(chat).messages.at(-1).text, "FILES:manifest.json,renders");
  assert.equal(node.workspace.nodeHost.view().grants.length, 1);
  assert.equal(node.workspace.nodeHost.view().lastCompleted?.status, "completed");

  // Step 4: Second run succeeds immediately without showing an approval card.
  await hostA.workspace.send(chat, "list-subdir");
  assert.equal(hostA.workspace.chat(chat).messages.at(-1).text, "SUB:frame01.png");
  assert.equal(node.workspace.interactions.snapshot().length, 0);

  // Boundary checks over the wire while grant is active.
  await hostA.workspace.send(chat, "list-escape-dotdot");
  assert.match(hostA.workspace.chat(chat).messages.at(-1).text, /^BLOCKED:.*outside/i);
  await hostA.workspace.send(chat, "list-escape-symlink");
  assert.match(hostA.workspace.chat(chat).messages.at(-1).text, /^BLOCKED:.*link outside/i);

  // Step 5: Revoke the grant on the node.
  const [grant] = node.workspace.nodeHost.view().grants;
  node.workspace.nodeHost.revokeGrant(grant.id);
  assert.equal(node.workspace.nodeHost.view().grants.length, 0);

  // Step 6: Next run asks for approval again! Deny it first, then verify denial returns cleanly.
  const deniedTurn = hostA.workspace.send(chat, "discover-and-list");
  const card2 = await until(() => parts.live?.requests?.find((item) => item.nodeJob && item.id !== card1.id));
  await owner.call("respond", card2.id, { action: "deny" });
  await deniedTurn;
  assert.match(hostA.workspace.chat(chat).messages.at(-1).text, /declined|denied/i);
  assert.equal(node.workspace.nodeHost.view().grants.length, 0);

  // Ask one more time and approve once ("approve"): succeeds without persisting a grant.
  const onceTurn = hostA.workspace.send(chat, "discover-and-list");
  const card3 = await until(() => parts.live?.requests?.find((item) => item.nodeJob && item.id !== card2.id));
  await owner.call("respond", card3.id, { action: "approve" });
  await onceTurn;
  assert.equal(hostA.workspace.chat(chat).messages.at(-1).text, "FILES:manifest.json,renders");
  assert.equal(node.workspace.nodeHost.view().grants.length, 0);
});

test("conversation Always allow does not grant node file listing, and a sleeping node shows as unavailable", async (t) => {
  const directory = [];
  const nodeDir = tempDir(t);
  const hostADir = tempDir(t);
  const sharedRoot = join(tempDir(t), "SharedDocs");
  mkdirSync(sharedRoot, { recursive: true });
  writeFileSync(join(sharedRoot, "plan.md"), "# Plan");

  const node = await startComputer(t, {
    dir: nodeDir,
    name: "Studio",
    directory,
    answer: async (_id, { prompt }) => ({ data: { content: "Scout replies: " + prompt } }),
  });
  node.workspace.nodeHost.setup({ name: "Studio" });
  const projectId = node.workspace.projects.create({ name: "Docs", folder: sharedRoot });
  node.workspace.nodeHost.shareProject(projectId, true);

  const pairing = await pair(
    fetch,
    { hosts: [node.address], code: node.link.startPairing().code, serverKey: node.row.serverKey },
    { name: "Owner phone", platform: "ios" },
  );
  const parts = {};
  const owner = new LinkClient(pairing, { fetch, onParts: (changes) => Object.assign(parts, changes), onState() {} });
  t.after(() => owner.stop());
  owner.start();
  await until(() => parts.bots);

  const hostA = await startComputer(t, {
    dir: hostADir,
    name: "Laptop",
    directory,
    answer: async (_id, { prompt }, session) => {
      if (prompt === "ask-bot") {
        const res = JSON.parse(
          await session.tool("ask_teammate", {
            host: node.row.serverId,
            teammate: "scout",
            message: "ping",
          }),
        );
        return { data: { content: res.reply } };
      }
      if (prompt === "list-files") {
        const res = JSON.parse(
          await session.tool("list_node_files", {
            host: node.row.serverId,
            project: projectId,
          }),
        );
        return { data: { content: "FILES:" + res.entries.map((e) => e.name).join(",") } };
      }
      if (prompt === "check-sleeping") {
        const discovered = JSON.parse(await session.tool("list_node_hosts", {}));
        const studio = discovered.hosts.find((item) => item.serverId === node.row.serverId);
        return { data: { content: JSON.stringify({ unavailable: studio.unavailable, online: studio.online }) } };
      }
      return { data: { content: "unknown" } };
    },
  });

  const chat = hostA.workspace.mainChat("pip");

  // 1. Grant permanent Always allow for cross-host messages from Pip -> Scout on Studio.
  const msgTurn = hostA.workspace.send(chat, "ask-bot");
  const msgCard = await until(() => parts.live?.requests?.find((item) => item.dispatch && !item.nodeJob));
  await owner.call("respond", msgCard.id, { action: "remember" });
  await msgTurn;
  assert.match(hostA.workspace.chat(chat).messages.at(-1).text, /Scout replies: ping/);

  // 2. Listing files from the exact same bot (Pip) on the exact same node (Studio) MUST STILL ASK.
  const fileTurn = hostA.workspace.send(chat, "list-files");
  const fileCard = await until(() => parts.live?.requests?.find((item) => item.nodeJob));
  assert.equal(fileCard.nodeJob, true);
  await owner.call("respond", fileCard.id, { action: "approve" });
  await fileTurn;
  assert.equal(hostA.workspace.chat(chat).messages.at(-1).text, "FILES:plan.md");

  // 3. Stop the node's listener to simulate a sleeping/unreachable node.
  node.workspace.nodeHost.close();
  await node.link.stop();
  await hostA.workspace.send(chat, "check-sleeping");
  assert.deepEqual(JSON.parse(hostA.workspace.chat(chat).messages.at(-1).text), {
    unavailable: true,
    online: false,
  });
});

test("lost job.submit reply retries with the exact same request ID so the job never runs twice", async (t) => {
  const submitted = [];
  const { client } = fakeClient(async (_id, _options, session) => {
    const res = JSON.parse(
      await session.tool("list_node_files", { host: "host-b", project: "proj-1" }),
    );
    return { data: { content: "COUNT:" + res.entries.length } };
  });
  const ws = new StarterWorkspace(join(tempDir(t), "data"), client, () => {});
  ws.teamworkPeers = {
    available: () => true,
    hosts: async (withPin) => [{ serverId: "host-b", name: "Studio", ...(withPin && { pin: "peer-pin" }) }],
    call: (_id, op, data) => {
      if (op === "capabilities") {
        return {
          version: 1,
          role: "node",
          name: "Studio",
          online: true,
          paused: false,
          bots: [],
          operations: [{ id: "project.list_files", version: 1, readOnly: true }],
          projects: [{ id: "proj-1", name: "Assets" }],
        };
      }
      if (op === "job.submit") {
        submitted.push(data);
        if (submitted.length === 1) throw Object.assign(new Error("Lost reply"), { code: "TEAMWORK_OFFLINE" });
        return {
          status: "completed",
          result: {
            projectId: "proj-1",
            projectName: "Assets",
            path: "",
            entries: [{ name: "one.txt", type: "file", size: 3 }],
            truncated: false,
            totalEntries: 1,
          },
        };
      }
      throw new Error("Unexpected op: " + op);
    },
  };

  const chat = ws.createChat("pip");
  await ws.send(chat, "List files");
  assert.equal(ws.chat(chat).messages.at(-1).text, "COUNT:1");
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[0], submitted[1]);
});
