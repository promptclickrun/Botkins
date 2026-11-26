// Two real Link listeners, two workspaces and a paired trusted device for Node Host mode.
// Covers the full 6-step acceptance flow from docs/node-host.md, plus deny, boundary checks,
// sleeping/unavailable node discovery, separate grants from conversations, and retry idempotency.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LinkHost } from "../desktop/link/server.mjs";
import { LinkClient, pair } from "../desktop/remote/link-client.mjs";
import { installTeamworkPeers } from "../desktop/teamwork-peers.mjs";
import { deviceCall } from "../desktop/device-call.mjs";
import { Workspace as RealWorkspace } from "../desktop/workspace.mjs";
import { Workspace as StarterWorkspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { DELETE_CONFIRM_PHRASE, runConversion, undoConversion } from "../desktop/node-convert.mjs";
import { remoteNodeControl, remoteNodeStatus } from "../desktop/remote-teamwork.mjs";
import { readProfile, writeProfile } from "../desktop/bot-profile-files.mjs";

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

test("full conversion of a 3-bot host (move 1, keep 1, delete 1) over real Teamwork, remote node control, and one-click undo", async (t) => {
  const directory = [];
  const sourceDir = tempDir(t);
  const targetDir = tempDir(t);
  const repoDir = join(tempDir(t), "client-app");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# Client App\n");

  const source = await startComputer(t, {
    dir: sourceDir,
    name: "Mac Mini",
    directory,
    answer: async (_id, { prompt }) => ({ data: { content: "Kept-on-node reply: " + prompt } }),
  });
  const target = await startComputer(t, {
    dir: targetDir,
    name: "Mac Studio",
    directory,
    answer: async (_id, { prompt }, session) => {
      if (prompt === "ask-kept-bot") {
        const res = JSON.parse(
          await session.tool("ask_teammate", {
            host: source.row.serverId,
            teammate: "scout",
            message: "still there?",
          }),
        );
        return { data: { content: res.reply } };
      }
      return { data: { content: "Studio reply: " + prompt } };
    },
  });

  // Clean source down to exactly 3 distinct bots:
  // 1) "scout" (keep locally as shared bot)
  // 2) "Atlas" (move to Mac Studio with chat, memory, AGENTS.md, routine, Today panel, skill, project ref)
  // 3) "TempBot" (delete with typed confirmation)
  // Keep starter "scout" as our kept bot and remove any other starter bots so we have a clean 3-bot host.
  const keptId = "scout";
  source.workspace.state.bots = source.workspace.state.bots.filter((b) => b.id === keptId);
  source.workspace.state.chats = source.workspace.state.chats.filter((c) => c.botId === keptId);
  source.workspace.memory.write(keptId, "- Knows local build scripts");

  const movedId = source.workspace.addBot({
    name: "Atlas",
    role: "Ops Lead",
    instructions: "You track deployments.",
  });
  const atlasChat = source.workspace.state.chats.find((c) => c.botId === movedId);
  atlasChat.messages.push(
    { role: "user", text: "Deploy status?", time: 1700000010000 },
    { role: "assistant", text: "All green on staging.", time: 1700000011000 },
  );
  atlasChat.schedules = [
    {
      id: "sched-atlas-1",
      name: "Weekday Ops Brief",
      prompt: "Summarize ops",
      cron: "0 9 * * 1-5",
      timezone: "America/Chicago",
      recurring: true,
      routine: true,
      enabled: true,
      nextAt: Date.now() + 600_000,
    },
  ];
  const atlasProjectId = source.workspace.projects.create({ name: "Client App", folder: repoDir });
  atlasChat.projectId = atlasProjectId;
  source.workspace.memory.write(movedId, "- Staging deploys run at 9am CT");
  writeProfile(source.workspace, movedId, { file: "AGENTS.md", previous: "", text: "# Atlas Operating Rules\nAlways check staging first.\n" });
  source.workspace.state.panels.push({
    id: "panel-atlas-ops",
    spaceId: "today",
    botId: movedId,
    key: "ops-health",
    title: "Ops Health",
    blocks: [{ type: "markdown", text: "Staging healthy" }],
    revision: 1,
    updatedAt: Date.now(),
  });
  const skillDir = join(source.workspace.dir, "skills", "deploy-check");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Deploy Check\nVerify health endpoint.\n");

  const deletedId = source.workspace.addBot({
    name: "TempBot",
    role: "Scratchpad",
    instructions: "Temporary helper.",
  });
  source.workspace.memory.write(deletedId, "- Disposable notes");

  // Add a local encrypted vault secret to confirm it is NEVER transmitted over the wire.
  source.workspace.vault.entries["aws-prod"] = {
    label: "AWS Prod Key",
    kind: "api-key",
    owner: "owner",
    secret: "DO-NOT-TRANSMIT-SECRET-999",
  };
  source.workspace.save();

  assert.equal(source.workspace.state.bots.length, 3);

  // Pair an owner phone to the source computer before conversion (must survive!).
  const pairing = await pair(
    fetch,
    { hosts: [source.address], code: source.link.startPairing().code, serverKey: source.row.serverKey },
    { name: "Owner iPhone", platform: "ios" },
  );
  const phoneParts = {};
  const ownerPhone = new LinkClient(pairing, {
    fetch,
    onParts: (changes) => Object.assign(phoneParts, changes),
    onState() {},
  });
  t.after(() => ownerPhone.stop());
  ownerPhone.start();
  await until(() => phoneParts.bots);

  // Execute one-step conversion: Move Atlas -> Mac Studio, Keep Scout, Delete TempBot.
  const conv = await runConversion(
    source.workspace,
    {
      nodeName: "Mac Mini Node",
      botActions: [
        { botId: movedId, action: "move", targetHostId: target.row.serverId },
        { botId: keptId, action: "keep" },
        { botId: deletedId, action: "delete" },
      ],
      sharedProjects: [atlasProjectId],
      confirmDelete: DELETE_CONFIRM_PHRASE,
    },
    { peers: source.workspace.teamworkPeers },
  );

  assert.equal(conv.job.status, "completed");
  assert.ok(conv.job.snapshotPath && existsSync(conv.job.snapshotPath));

  // Verify post-conversion state on source:
  // - Node role is enabled and Online; first-run setup does not reappear.
  assert.equal(source.workspace.nodeHost.enabled, true);
  assert.equal(source.workspace.nodeHost.view().online, true);
  assert.equal(source.workspace.nodeHost.view().name, "Mac Mini Node");
  assert.equal(source.workspace.state.bots.length, 1);
  assert.equal(source.workspace.state.bots[0].id, keptId);
  assert.equal(source.workspace.nodeHost.capabilities().bots.some((b) => b.id === keptId), true);
  assert.equal(source.workspace.nodeHost.capabilities().projects.some((p) => p.id === atlasProjectId), true);

  // Verify moved bot ("Atlas") landed cleanly on target ("Mac Studio") with all data intact:
  const targetAtlas = target.workspace.state.bots.find((b) => b.name === "Atlas");
  assert.ok(targetAtlas, "Atlas should now live on Mac Studio");
  const targetAtlasChat = target.workspace.state.chats.find((c) => c.botId === targetAtlas.id);
  assert.ok(targetAtlasChat.messages.some((m) => m.text.includes("All green on staging.")));
  assert.equal(target.workspace.memory.read(targetAtlas.id).trim(), "- Staging deploys run at 9am CT");
  assert.match(readProfile(target.workspace, targetAtlas.id, "AGENTS.md"), /Always check staging first/);
  assert.equal(targetAtlasChat.schedules.length, 1);
  assert.equal(targetAtlasChat.schedules[0].enabled, true);
  assert.equal(targetAtlasChat.schedules[0].cron, "0 9 * * 1-5");
  assert.equal(targetAtlasChat.schedules[0].timezone, "America/Chicago");
  assert.ok(target.workspace.state.panels.some((p) => p.botId === targetAtlas.id && p.key === "ops-health"));
  assert.equal(existsSync(join(target.workspace.dir, "skills", "deploy-check", "SKILL.md")), true);
  // Vault secret NEVER appeared anywhere on target!
  assert.equal(JSON.stringify(target.workspace.state).includes("DO-NOT-TRANSMIT-SECRET-999"), false);
  assert.equal(source.workspace.vault.entries["aws-prod"].secret, "DO-NOT-TRANSMIT-SECRET-999");

  // Verify kept bot ("scout") is reachable from Mac Studio via cross-host Teamwork,
  // AND that the paired phone still receives & approves requests after conversion!
  const targetChat = target.workspace.mainChat("pip");
  const askTurn = target.workspace.send(targetChat, "ask-kept-bot");
  const askCard = await until(() => phoneParts.live?.requests?.find((r) => r.dispatch && !r.nodeJob));
  await ownerPhone.call("respond", askCard.id, { action: "approve" });
  await askTurn;
  assert.match(target.workspace.chat(targetChat).messages.at(-1).text, /Kept-on-node reply: still there\?/);

  // Verify owner-only remote node control from Mac Studio -> Mac Mini Node over real encrypted Teamwork!
  const remoteSt = await remoteNodeStatus(target.workspace.teamworkPeers, source.row.serverId);
  assert.equal(remoteSt.nodeHost.name, "Mac Mini Node");
  assert.equal(remoteSt.nodeHost.online, true);

  // A paired phone can NEVER invoke node or conversion controls directly (gated out of REMOTE_METHODS).
  await assert.rejects(ownerPhone.call("nodePause", true), /can't be done from a phone/i);
  await assert.rejects(ownerPhone.call("nodeConvertRun", { nodeName: "Bad" }), /can't be done from a phone/i);
  await assert.rejects(ownerPhone.call("nodeRemoteControl", { hostId: source.row.serverId, action: "pause" }), /can't be done from a phone/i);

  // A team member's host (member: true) can NEVER invoke remote node control.
  const memberRow = { ...target.row, serverId: "member-host-id", member: true };
  directory.push(memberRow);
  await assert.rejects(remoteNodeStatus(source.workspace.teamworkPeers, "member-host-id"), /same-owner host|same Botkins profile/i);
  await assert.rejects(source.workspace.teamworkPeers.call("member-host-id", "control.status", {}), /same Botkins profile/i);
  directory.pop();

  // Remote pause -> approved on owner's paired phone!
  const pausePromise = remoteNodeControl(target.workspace.teamworkPeers, source.row.serverId, "pause", {}, { pollMs: 20 });
  const pauseCard = await until(() => phoneParts.live?.requests?.find((r) => r.nodeJob && /pause/i.test(r.title)));
  await ownerPhone.call("respond", pauseCard.id, { action: "approve" });
  const paused = await pausePromise;
  assert.equal(paused.nodeHost.paused, true);

  // Remote resume works even while paused -> approved on owner's paired phone!
  const resumePromise = remoteNodeControl(target.workspace.teamworkPeers, source.row.serverId, "resume", {}, { pollMs: 20 });
  const resumeCard = await until(() => phoneParts.live?.requests?.find((r) => r.nodeJob && /resume/i.test(r.title)));
  await ownerPhone.call("respond", resumeCard.id, { action: "approve" });
  const resumed = await resumePromise;
  assert.equal(resumed.nodeHost.paused, false);

  // One-click Undo conversion restores Atlas + TempBot on source, disables Atlas's routine on target,
  // turns node role off, and keeps phone pairing working!
  const undone = await undoConversion(source.workspace, { peers: source.workspace.teamworkPeers });
  assert.equal(undone.undone, true);
  assert.equal(source.workspace.nodeHost.enabled, false);
  assert.equal(source.workspace.state.bots.length, 3);
  assert.ok(source.workspace.state.bots.some((b) => b.id === movedId));
  assert.ok(source.workspace.state.bots.some((b) => b.id === deletedId));
  assert.equal(source.workspace.memory.read(movedId).trim(), "- Staging deploys run at 9am CT");
  // Atlas's routine is enabled on source and disabled on target -> zero double-fire!
  assert.equal(source.workspace.state.chats.find((c) => c.botId === movedId).schedules[0].enabled, true);
  assert.equal(target.workspace.state.chats.find((c) => c.botId === targetAtlas.id).schedules[0].enabled, false);
});
