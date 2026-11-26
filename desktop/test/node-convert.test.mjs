// Unit & workflow tests for one-step "Convert this computer to a Node host":
// - Plan builder (move / keep / delete per bot, same-for-all shortcut, typed DELETE confirmation, vault note)
// - Transfer verify-before-delete (checksum/count mismatch leaves source 100% untouched)
// - Idempotent re-run after mid-move interruption / offline target
// - Routine de-duplication (never enabled on both hosts simultaneously; schedules & timezones preserved)
// - Local snapshot + one-click undo (phone link & vault survive; remote rollback or safe local pause)
// - Owner-only remote node control authorization (never in REMOTE_METHODS, team members rejected,
//   approval model + isolated grant scope)
// - CLI `botkins node convert --json` non-interactive mode
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import {
  buildConversionPlan,
  DELETE_CONFIRM_PHRASE,
  exportBotBundle,
  inspectLocalWorkspace,
  receiveMigration,
  runConversion,
  undoConversion,
  verifyTransferReceipt,
} from "../desktop/node-convert.mjs";
import { REMOTE_METHODS } from "../desktop/link/methods.mjs";
import { remoteNodeControl, remoteNodeStatus } from "../desktop/remote-teamwork.mjs";
import { writeProfile, readProfile } from "../desktop/bot-profile-files.mjs";
import { main as cliMain } from "../cli/main.mjs";

function makeWorkspace(t) {
  const dir = tempDir(t);
  const ws = new Workspace(dir, fakeClient().client, () => {});
  t.after(() => {
    ws.nodeHost.close();
    ws.hostDispatch.close();
  });
  return { dir, ws };
}

function seedBot(ws, { name, role = "Helper", memory = "", agentsMd = "", routine = null, panel = null, skill = null, projectFolder = null }) {
  const botId = ws.addBot({ name, role, instructions: `You are ${name}.` });
  const mainChat = ws.state.chats.find((c) => c.botId === botId);
  mainChat.messages.push(
    { role: "user", text: `Hello ${name}`, time: 1700000001000 },
    { role: "assistant", text: `Hi from ${name}!`, time: 1700000002000 },
  );
  if (memory) ws.memory.write(botId, memory);
  if (agentsMd) writeProfile(ws, botId, { file: "AGENTS.md", previous: "", text: agentsMd });
  if (routine) {
    mainChat.schedules ??= [];
    mainChat.schedules.push({
      id: "sched-" + botId,
      name: routine.name || "Morning Check",
      prompt: routine.prompt || "Run check",
      cron: routine.cron || "0 9 * * 1-5",
      timezone: routine.timezone || "America/Chicago",
      recurring: true,
      routine: true,
      enabled: routine.enabled !== false,
      nextAt: Date.now() + 3600_000,
    });
  }
  if (panel) {
    ws.state.panels.push({
      id: "panel-" + botId,
      spaceId: "today",
      botId,
      key: panel.key || "daily-brief",
      title: panel.title || "Daily Brief",
      blocks: [{ type: "markdown", text: panel.text || "All clear." }],
      revision: 1,
      updatedAt: Date.now(),
    });
  }
  if (skill) {
    const skillDir = join(ws.dir, "skills", skill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skill.content || `# ${skill.name}\n`);
  }
  if (projectFolder) {
    const projectId = ws.projects.create({ name: projectFolder.name, folder: projectFolder.dir });
    mainChat.projectId = projectId;
  }
  ws.save();
  return botId;
}

function makeDirectPeers(targetWs, { sourcePeer, intercept } = {}) {
  const peerInfo = sourcePeer ?? {
    profileId: "owner-profile",
    serverId: "host-source",
    serverKey: "source-key",
    targetId: "host-target",
    targetKey: "target-key",
    name: "Source Mac",
    targetName: "Target Mac",
    verify: async () => {},
  };
  return {
    available: () => true,
    hosts: async () => [{ serverId: "host-target", name: "Target Mac", pin: "pin-target" }],
    call: async (hostId, operation, payload, pin) => {
      if (intercept) {
        const custom = await intercept(hostId, operation, payload, pin);
        if (custom !== undefined) return custom;
      }
      if (operation === "capabilities") return targetWs.nodeHost.capabilities();
      return targetWs.nodeHost.receive(peerInfo, operation, payload);
    },
  };
}

test("plan builder handles per-bot move/keep/delete, same-for-all shortcut, offline rejection, delete confirmation and vault note", (t) => {
  const { dir, ws } = makeWorkspace(t);
  const projDir = join(dir, "repo");
  mkdirSync(projDir, { recursive: true });
  const moverId = seedBot(ws, {
    name: "Mover",
    memory: "- Remembers deploy scripts",
    agentsMd: "# Mover rules",
    routine: { name: "Standup", cron: "30 8 * * 1-5", timezone: "America/New_York" },
    panel: { key: "status", title: "Status" },
    skill: { name: "deploy-helper" },
    projectFolder: { name: "App Repo", dir: projDir },
  });
  const keeperId = seedBot(ws, { name: "Keeper", memory: "- Local helper" });
  const trashId = seedBot(ws, { name: "TrashBot" });
  const starterBots = ws.state.bots.filter((b) => ![moverId, keeperId, trashId].includes(b.id));

  // Add a fake vault entry (metadata only, secret never transmitted).
  ws.vault.entries["secret-1"] = { label: "Deploy Token", kind: "api-key", owner: "owner", secret: "SUPER-SECRET-VALUE" };
  mkdirSync(join(ws.dir, "wiki"), { recursive: true });
  writeFileSync(join(ws.dir, "wiki", "index.md"), "# Team Wiki\n");

  const onlineHosts = [
    { serverId: "host-target", name: "Studio Mac", role: "standard", online: true, unavailable: false, botCount: 2 },
    { serverId: "host-offline", name: "Sleepy Laptop", role: "standard", online: false, unavailable: true, botCount: 1 },
  ];

  // Inventory never leaks vault secret values.
  const inv = inspectLocalWorkspace(ws);
  assert.equal(inv.shared.vault.count, 1);
  assert.equal(JSON.stringify(inv).includes("SUPER-SECRET-VALUE"), false);

  // Per-bot plan with move + keep + delete.
  const plan = buildConversionPlan(
    ws,
    {
      nodeName: "Mac Mini Node",
      botActions: [
        ...starterBots.map((b) => ({ botId: b.id, action: "keep" })),
        { botId: moverId, action: "move", targetHostId: "host-target" },
        { botId: keeperId, action: "keep" },
        { botId: trashId, action: "delete" },
      ],
      requireConfirmation: true,
    },
    onlineHosts,
  );
  // Missing typed DELETE confirmation makes plan invalid when requireConfirmation is true.
  assert.equal(plan.valid, false);
  assert.equal(plan.requiresDeleteConfirmation, true);
  assert.equal(plan.deleteConfirmed, false);
  assert.match(plan.errors[0], /Type DELETE/);

  // With typed DELETE confirmation -> valid with exact counts.
  const confirmed = buildConversionPlan(
    ws,
    {
      nodeName: "Mac Mini Node",
      botActions: [
        ...starterBots.map((b) => ({ botId: b.id, action: "keep" })),
        { botId: moverId, action: "move", targetHostId: "host-target" },
        { botId: keeperId, action: "keep" },
        { botId: trashId, action: "delete" },
      ],
      confirmDelete: DELETE_CONFIRM_PHRASE,
      requireConfirmation: true,
    },
    onlineHosts,
  );
  assert.equal(confirmed.valid, true);
  assert.equal(confirmed.counts.moveBots, 1);
  assert.equal(confirmed.counts.keepBots, starterBots.length + 1);
  assert.equal(confirmed.counts.deleteBots, 1);
  assert.equal(confirmed.counts.routinesMoving, 1);
  assert.equal(confirmed.counts.panelsMoving, 1);
  assert.equal(confirmed.counts.vaultEntriesLeftBehind, 1);
  assert.equal(confirmed.counts.wikiPagesKept, inv.shared.wiki.pageCount);
  assert.ok(confirmed.counts.wikiPagesKept >= 1);

  // Offline target host is rejected.
  const offlinePlan = buildConversionPlan(
    ws,
    {
      nodeName: "Mac Mini Node",
      sameForAll: { action: "move", targetHostId: "host-offline" },
    },
    onlineHosts,
  );
  assert.equal(offlinePlan.valid, false);
  assert.match(offlinePlan.errors[0], /offline/i);

  // Same-for-all shortcut applies to every bot, while allowing per-bot override.
  const allMove = buildConversionPlan(
    ws,
    {
      nodeName: "Mac Mini Node",
      sameForAll: { action: "move", targetHostId: "host-target" },
      botActions: [{ botId: keeperId, action: "keep" }],
    },
    onlineHosts,
  );
  assert.equal(allMove.valid, true);
  assert.equal(allMove.counts.keepBots, 1);
  assert.equal(allMove.counts.moveBots, ws.state.bots.length - 1);

  // Exported bot bundle NEVER contains vault secret value.
  const { payload } = exportBotBundle(ws, moverId, { serverId: "host-source", name: "Mac Mini Node" });
  assert.equal(JSON.stringify(payload).includes("SUPER-SECRET-VALUE"), false);
  assert.equal(payload.vaultNote.leftBehindCount, 1);
});

test("transfer verify-before-delete refuses deletion and restores source routines when target checksum mismatches", async (t) => {
  const { ws: sourceWs } = makeWorkspace(t);
  const { ws: targetWs } = makeWorkspace(t);
  const moverId = seedBot(sourceWs, {
    name: "Alpha",
    memory: "- Critical note",
    agentsMd: "# Alpha instructions",
    routine: { name: "Hourly", cron: "0 * * * *", timezone: "UTC" },
  });
  const keepIds = sourceWs.state.bots.filter((b) => b.id !== moverId).map((b) => b.id);

  const peers = makeDirectPeers(targetWs, {
    intercept: async (_hostId, op, payload) => {
      if (op === "migrate.verify") {
        const real = await receiveMigration(targetWs, { serverId: "host-source", name: "Source", verify: async () => {} }, op, payload);
        return {
          ...real,
          verification: { ...real.verification, contentSha256: "0000tampered0000" },
        };
      }
    },
  });

  const result = await runConversion(
    sourceWs,
    {
      nodeName: "Source Node",
      botActions: [
        ...keepIds.map((botId) => ({ botId, action: "keep" })),
        { botId: moverId, action: "move", targetHostId: "host-target" },
      ],
    },
    { peers },
  );

  assert.equal(result.job.status, "failed");
  assert.match(result.job.error, /Verification mismatch/i);
  // Source bot was NOT deleted!
  assert.ok(sourceWs.state.bots.some((b) => b.id === moverId));
  assert.equal(sourceWs.memory.read(moverId).trim(), "- Critical note");
  assert.equal(readProfile(sourceWs, moverId, "AGENTS.md"), "# Alpha instructions");
  // Source routine was restored to enabled since transfer did not verify!
  const srcChat = sourceWs.state.chats.find((c) => c.botId === moverId);
  assert.equal(srcChat.schedules[0].enabled, true);
  // Target routine was NEVER activated!
  const tgtBot = targetWs.state.bots.find((b) => b.name === "Alpha");
  const tgtChat = targetWs.state.chats.find((c) => c.botId === tgtBot.id);
  assert.equal(tgtChat.schedules[0].enabled, false);
  // Node host role was NOT turned on while conversion failed.
  assert.equal(sourceWs.nodeHost.enabled, false);
});

test("idempotent re-run after mid-move offline interruption finishes cleanly without duplicating bots", async (t) => {
  const { ws: sourceWs } = makeWorkspace(t);
  const { ws: targetWs } = makeWorkspace(t);
  const bot1Id = seedBot(sourceWs, { name: "BotOne", memory: "- One" });
  const bot2Id = seedBot(sourceWs, {
    name: "BotTwo",
    memory: "- Two",
    routine: { name: "Daily", cron: "0 7 * * *", timezone: "America/Chicago" },
  });
  const keepIds = sourceWs.state.bots.filter((b) => b.id !== bot1Id && b.id !== bot2Id).map((b) => b.id);

  let failSecondBot = true;
  let beganCount = 0;
  const peers = makeDirectPeers(targetWs, {
    intercept: async (_hostId, op, payload) => {
      if (op === "migrate.begin") {
        beganCount++;
        if (failSecondBot && payload.botId === bot2Id) {
          throw Object.assign(new Error("Target offline"), { code: "TEAMWORK_OFFLINE" });
        }
      }
    },
  });

  // First run: BotOne succeeds, BotTwo hits offline target -> pauses cleanly.
  const first = await runConversion(
    sourceWs,
    {
      nodeName: "Edge Mac",
      botActions: [
        ...keepIds.map((botId) => ({ botId, action: "keep" })),
        { botId: bot1Id, action: "move", targetHostId: "host-target" },
        { botId: bot2Id, action: "move", targetHostId: "host-target" },
      ],
    },
    { peers },
  );
  assert.equal(first.job.status, "paused");
  assert.equal(first.job.items.find((i) => i.botId === bot1Id).stage, "done");
  assert.equal(first.job.items.find((i) => i.botId === bot2Id).stage, "failed");
  // BotTwo is still untouched on source with its routine enabled!
  assert.ok(sourceWs.state.bots.some((b) => b.id === bot2Id));
  assert.equal(sourceWs.state.chats.find((c) => c.botId === bot2Id).schedules[0].enabled, true);
  // BotOne is already on target.
  assert.equal(targetWs.state.bots.filter((b) => b.name === "BotOne").length, 1);

  // Target comes back online; resume conversion!
  failSecondBot = false;
  const resumed = await runConversion(sourceWs, { resume: true }, { peers });
  assert.equal(resumed.job.status, "completed");
  assert.equal(sourceWs.nodeHost.enabled, true);
  assert.equal(sourceWs.nodeHost.online, undefined); // property on view(), not class
  assert.equal(sourceWs.nodeHost.view().online, true);

  // Neither BotOne nor BotTwo is duplicated on target!
  assert.equal(targetWs.state.bots.filter((b) => b.name === "BotOne").length, 1);
  assert.equal(targetWs.state.bots.filter((b) => b.name === "BotTwo").length, 1);
  assert.equal(sourceWs.state.bots.some((b) => b.id === bot1Id || b.id === bot2Id), false);
  // BotTwo's routine is now active on target with timezone preserved!
  const tgtBot2 = targetWs.state.bots.find((b) => b.name === "BotTwo");
  const tgtBot2Chat = targetWs.state.chats.find((c) => c.botId === tgtBot2.id);
  assert.equal(tgtBot2Chat.schedules[0].enabled, true);
  assert.equal(tgtBot2Chat.schedules[0].timezone, "America/Chicago");

  // Re-running a completed job ID is a no-op (strictly idempotent).
  const rerun = await runConversion(sourceWs, { jobId: resumed.job.id }, { peers });
  assert.equal(rerun.job.status, "completed");
  assert.equal(targetWs.state.bots.filter((b) => b.name === "BotOne").length, 1);
  assert.equal(targetWs.state.bots.filter((b) => b.name === "BotTwo").length, 1);
  assert.ok(beganCount >= 2);
});

test("cleaned move preserves activate-only checkpoint when target is absent on resume, then activates once on reconnect", async (t) => {
  const { ws: sourceWs } = makeWorkspace(t);
  const { ws: targetWs } = makeWorkspace(t);
  const botId = seedBot(sourceWs, {
    name: "ActivateOnlyBot",
    memory: "- Preserved memory",
    agentsMd: "# ActivateOnly rules",
    routine: { name: "Morning Digest", cron: "0 8 * * *", timezone: "America/Chicago", enabled: true },
  });
  const keepIds = sourceWs.state.bots.filter((b) => b.id !== botId).map((b) => b.id);

  let targetOnline = true;
  let failActivate = true;
  const ops = [];
  let activateSucceeded = 0;
  let bothEnabledObserved = false;
  const checkRoutinesNotDuplicated = () => {
    const srcChat = sourceWs.state.chats.find((c) => c.botId === botId);
    const srcEnabled = Boolean(srcChat?.schedules?.some((s) => s.enabled !== false));
    const tgtBot = targetWs.state.bots.find((b) => b.name === "ActivateOnlyBot");
    const tgtChat = tgtBot ? targetWs.state.chats.find((c) => c.botId === tgtBot.id) : null;
    const tgtEnabled = Boolean(tgtChat?.schedules?.some((s) => s.enabled !== false));
    if (srcEnabled && tgtEnabled) bothEnabledObserved = true;
  };

  const basePeers = makeDirectPeers(targetWs, {
    intercept: async (_hostId, op, payload) => {
      if (!op.startsWith("migrate.")) return undefined;
      ops.push(op);
      checkRoutinesNotDuplicated();
      if (op === "migrate.activate" && failActivate) {
        throw Object.assign(new Error("Target went offline during activation"), { code: "TEAMWORK_OFFLINE" });
      }
      const res = await receiveMigration(
        targetWs,
        { serverId: "host-source", name: "Source Mac", verify: async () => {} },
        op,
        payload,
      );
      if (op === "migrate.activate") activateSucceeded++;
      checkRoutinesNotDuplicated();
      return res;
    },
  });
  const peers = {
    ...basePeers,
    hosts: async () => (targetOnline ? basePeers.hosts() : []),
  };

  // 1. Initial run verifies on target and removes source bot, then fails during migrate.activate.
  const first = await runConversion(
    sourceWs,
    {
      nodeName: "Edge Node",
      botActions: [
        ...keepIds.map((id) => ({ botId: id, action: "keep" })),
        { botId, action: "move", targetHostId: "host-target" },
      ],
    },
    { peers },
  );
  checkRoutinesNotDuplicated();
  assert.equal(first.job.status, "paused");
  assert.equal(first.job.items.find((i) => i.botId === botId).stage, "cleaned");
  assert.equal(sourceWs.state.bots.some((b) => b.id === botId), false, "source bot was already removed");
  assert.equal(targetWs.state.bots.filter((b) => b.name === "ActivateOnlyBot").length, 1);
  assert.equal(
    targetWs.state.chats.find((c) => c.botId === targetWs.state.bots.find((b) => b.name === "ActivateOnlyBot").id).schedules[0].enabled,
    false,
  );
  assert.equal(sourceWs.nodeHost.enabled, false);
  const opsAfterFirstRun = ops.length;

  // 2. Resume while destination host is absent from peer discovery -> must keep "cleaned" checkpoint!
  targetOnline = false;
  const whileAbsent = await runConversion(sourceWs, { resume: true }, { peers });
  checkRoutinesNotDuplicated();
  assert.equal(whileAbsent.job.status, "paused");
  assert.equal(whileAbsent.job.items.find((i) => i.botId === botId).stage, "cleaned");
  assert.equal(sourceWs.state.bots.some((b) => b.id === botId), false, "source bot must not be recreated");
  assert.equal(ops.length, opsAfterFirstRun, "no migration calls while destination is absent");
  assert.equal(sourceWs.nodeHost.enabled, false);

  // 3. Destination reconnects -> resume only retries migrate.activate and completes cleanly!
  targetOnline = true;
  failActivate = false;
  const resumed = await runConversion(sourceWs, { resume: true }, { peers });
  checkRoutinesNotDuplicated();
  assert.equal(resumed.job.status, "completed");
  assert.equal(resumed.job.items.find((i) => i.botId === botId).stage, "done");
  assert.equal(sourceWs.nodeHost.enabled, true);
  assert.equal(sourceWs.state.bots.some((b) => b.id === botId), false, "source bot remains absent");

  // Only migrate.activate ran after reconnect — no bundle re-export or re-transfer.
  assert.deepEqual(ops.slice(opsAfterFirstRun), ["migrate.activate"]);
  assert.equal(ops.filter((op) => op === "migrate.begin").length, 1);
  assert.equal(activateSucceeded, 1);
  assert.equal(bothEnabledObserved, false, "routine must never be enabled on both hosts simultaneously");

  // Target bot is present once with data and activated routine intact.
  const tgtBots = targetWs.state.bots.filter((b) => b.name === "ActivateOnlyBot");
  assert.equal(tgtBots.length, 1);
  assert.equal(targetWs.memory.read(tgtBots[0].id).trim(), "- Preserved memory");
  assert.equal(readProfile(targetWs, tgtBots[0].id, "AGENTS.md"), "# ActivateOnly rules");
  const tgtSched = targetWs.state.chats.find((c) => c.botId === tgtBots[0].id).schedules[0];
  assert.equal(tgtSched.enabled, true);
  assert.equal(tgtSched.cron, "0 8 * * *");
  assert.equal(tgtSched.timezone, "America/Chicago");
});

test("verified move preserves verified stage when target is absent on resume, then finishes cleanup and activation without re-exporting", async (t) => {
  const { ws: sourceWs } = makeWorkspace(t);
  const { ws: targetWs } = makeWorkspace(t);
  const botId = seedBot(sourceWs, {
    name: "VerifiedCheckpointBot",
    routine: { name: "Hourly Check", cron: "0 * * * *", timezone: "UTC", enabled: true },
  });
  const keepIds = sourceWs.state.bots.filter((b) => b.id !== botId).map((b) => b.id);

  let targetOnline = true;
  const ops = [];
  const basePeers = makeDirectPeers(targetWs, {
    intercept: async (_hostId, op, payload) => {
      if (!op.startsWith("migrate.")) return undefined;
      ops.push(op);
      return receiveMigration(
        targetWs,
        { serverId: "host-source", name: "Source Mac", verify: async () => {} },
        op,
        payload,
      );
    },
  });
  const peers = {
    ...basePeers,
    hosts: async () => (targetOnline ? basePeers.hosts() : []),
  };

  // Run once, simulating a failure right after verification (source removal blocked by a busy chat).
  const origAssertIdle = sourceWs.agents.assertIdle;
  let blockRemoval = true;
  sourceWs.agents.assertIdle = (...args) => {
    if (blockRemoval) throw new Error("Chat is busy");
    return origAssertIdle.apply(sourceWs.agents, args);
  };

  const first = await runConversion(
    sourceWs,
    {
      nodeName: "Edge Node",
      botActions: [
        ...keepIds.map((id) => ({ botId: id, action: "keep" })),
        { botId, action: "move", targetHostId: "host-target" },
      ],
    },
    { peers },
  );
  assert.equal(first.job.status, "failed");
  assert.equal(first.job.items.find((i) => i.botId === botId).stage, "verified");
  assert.ok(sourceWs.state.bots.some((b) => b.id === botId));
  const opsAfterVerify = ops.length;

  // Resume while target is absent -> must keep "verified" stage.
  targetOnline = false;
  blockRemoval = false;
  const whileAbsent = await runConversion(sourceWs, { resume: true }, { peers });
  assert.equal(whileAbsent.job.status, "paused");
  assert.equal(whileAbsent.job.items.find((i) => i.botId === botId).stage, "verified");
  assert.equal(ops.length, opsAfterVerify);

  // Target reconnects -> finishes source cleanup and activates without re-transferring.
  targetOnline = true;
  const resumed = await runConversion(sourceWs, { resume: true }, { peers });
  assert.equal(resumed.job.status, "completed");
  assert.equal(resumed.job.items.find((i) => i.botId === botId).stage, "done");
  assert.deepEqual(ops.slice(opsAfterVerify), ["migrate.activate"]);
  assert.equal(sourceWs.state.bots.some((b) => b.id === botId), false);
  const tgtBot = targetWs.state.bots.find((b) => b.name === "VerifiedCheckpointBot");
  assert.equal(targetWs.state.chats.find((c) => c.botId === tgtBot.id).schedules[0].enabled, true);
});

test("routine de-duplication guarantees a routine is NEVER enabled on both source and target at the same time", async (t) => {
  const { ws: sourceWs } = makeWorkspace(t);
  const { ws: targetWs } = makeWorkspace(t);
  const botId = seedBot(sourceWs, {
    name: "SchedulerBot",
    routine: { name: "Nightly Sync", cron: "15 2 * * *", timezone: "Europe/Berlin", enabled: true },
  });
  const keepIds = sourceWs.state.bots.filter((b) => b.id !== botId).map((b) => b.id);

  let bothEnabledObserved = false;
  const timeline = [];
  const checkInvariant = (phase) => {
    const srcChat = sourceWs.state.chats.find((c) => c.botId === botId);
    const srcEnabled = Boolean(srcChat?.schedules?.some((s) => s.enabled !== false));
    const tgtBot = targetWs.state.bots.find((b) => b.name === "SchedulerBot");
    const tgtChat = tgtBot ? targetWs.state.chats.find((c) => c.botId === tgtBot.id) : null;
    const tgtEnabled = Boolean(tgtChat?.schedules?.some((s) => s.enabled !== false));
    timeline.push({ phase, srcEnabled, tgtEnabled });
    if (srcEnabled && tgtEnabled) bothEnabledObserved = true;
  };

  const peers = makeDirectPeers(targetWs, {
    intercept: async (_hostId, op, payload) => {
      if (!op.startsWith("migrate.")) return undefined;
      checkInvariant("before:" + op);
      const res = await receiveMigration(
        targetWs,
        { serverId: "host-source", name: "Source", verify: async () => {} },
        op,
        payload,
      );
      checkInvariant("after:" + op);
      return res;
    },
  });

  const result = await runConversion(
    sourceWs,
    {
      nodeName: "Node A",
      botActions: [
        ...keepIds.map((id) => ({ botId: id, action: "keep" })),
        { botId, action: "move", targetHostId: "host-target" },
      ],
    },
    { peers },
  );

  assert.equal(result.job.status, "completed");
  assert.equal(bothEnabledObserved, false, "Routine was enabled on both hosts simultaneously: " + JSON.stringify(timeline));
  // Verify schedule & timezone survived intact on target and is enabled ONLY on target.
  assert.equal(sourceWs.state.chats.some((c) => c.botId === botId), false);
  const tgtBot = targetWs.state.bots.find((b) => b.name === "SchedulerBot");
  const tgtSched = targetWs.state.chats.find((c) => c.botId === tgtBot.id).schedules[0];
  assert.equal(tgtSched.enabled, true);
  assert.equal(tgtSched.cron, "15 2 * * *");
  assert.equal(tgtSched.timezone, "Europe/Berlin");
});

test("snapshot + one-click undo restores source bots/data, preserves link/vault, and prevents routine double-fire", async (t) => {
  const { ws: sourceWs } = makeWorkspace(t);
  const { ws: targetWs } = makeWorkspace(t);
  const moverId = seedBot(sourceWs, {
    name: "MoveAndUndo",
    memory: "- Restorable memory",
    agentsMd: "# Restorable profile",
    routine: { name: "Digest", cron: "0 8 * * *", timezone: "America/Los_Angeles" },
  });
  const deleteId = seedBot(sourceWs, { name: "DeleteAndUndo", memory: "- Recoverable" });
  const keepIds = sourceWs.state.bots.filter((b) => b.id !== moverId && b.id !== deleteId).map((b) => b.id);

  // Place simulated link/ pairing file & vault.json to confirm neither is touched.
  const linkDir = join(sourceWs.dir, "link");
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(join(linkDir, "paired.json"), '{"phone":"paired-ok"}');
  writeFileSync(join(sourceWs.dir, "vault.json"), '{"encrypted":"untouched"}');

  const peers = makeDirectPeers(targetWs);
  const converted = await runConversion(
    sourceWs,
    {
      nodeName: "Converted Node",
      botActions: [
        ...keepIds.map((id) => ({ botId: id, action: "keep" })),
        { botId: moverId, action: "move", targetHostId: "host-target" },
        { botId: deleteId, action: "delete" },
      ],
      confirmDelete: DELETE_CONFIRM_PHRASE,
    },
    { peers },
  );

  assert.equal(converted.job.status, "completed");
  assert.ok(converted.job.snapshotPath && existsSync(converted.job.snapshotPath));
  assert.equal(sourceWs.state.bots.some((b) => b.id === moverId), false);
  assert.equal(sourceWs.state.bots.some((b) => b.id === deleteId), false);
  assert.equal(readFileSync(join(linkDir, "paired.json"), "utf8"), '{"phone":"paired-ok"}');
  assert.equal(readFileSync(join(sourceWs.dir, "vault.json"), "utf8"), '{"encrypted":"untouched"}');

  // Undo conversion while target is online -> target routine is rolled back (disabled), source restored!
  const undone = await undoConversion(sourceWs, { peers });
  assert.equal(undone.undone, true);
  assert.equal(sourceWs.nodeHost.enabled, false);
  assert.ok(sourceWs.state.bots.some((b) => b.id === moverId));
  assert.ok(sourceWs.state.bots.some((b) => b.id === deleteId));
  assert.equal(sourceWs.memory.read(moverId).trim(), "- Restorable memory");
  assert.equal(readProfile(sourceWs, moverId, "AGENTS.md"), "# Restorable profile");
  assert.equal(sourceWs.memory.read(deleteId).trim(), "- Recoverable");
  // Link & vault stayed completely intact.
  assert.equal(readFileSync(join(linkDir, "paired.json"), "utf8"), '{"phone":"paired-ok"}');
  assert.equal(readFileSync(join(sourceWs.dir, "vault.json"), "utf8"), '{"encrypted":"untouched"}');
  // Target routine was disabled on rollback so it does NOT run on both hosts!
  const tgtBot = targetWs.state.bots.find((b) => b.name === "MoveAndUndo");
  assert.equal(targetWs.state.chats.find((c) => c.botId === tgtBot.id).schedules[0].enabled, false);
  // Source routine is active again.
  assert.equal(sourceWs.state.chats.find((c) => c.botId === moverId).schedules[0].enabled, true);

  // Also test Undo when target is UNREACHABLE -> source routines for moved bots stay paused to prevent double-fire!
  const converted2 = await runConversion(
    sourceWs,
    {
      nodeName: "Converted Node 2",
      botActions: [
        ...keepIds.map((id) => ({ botId: id, action: "keep" })),
        { botId: moverId, action: "move", targetHostId: "host-target" },
        { botId: deleteId, action: "keep" },
      ],
    },
    { peers },
  );
  assert.equal(converted2.job.status, "completed");
  const undoneOffline = await undoConversion(sourceWs, { peers: { available: () => false } });
  assert.equal(undoneOffline.undone, true);
  assert.equal(undoneOffline.unreachableTargets.length, 1);
  assert.equal(undoneOffline.pausedToPreventDupes.length, 1);
  assert.equal(sourceWs.state.chats.find((c) => c.botId === moverId).schedules[0].enabled, false);
});

test("owner-only remote node control enforces REMOTE_METHODS isolation, approval model, grant isolation, and works while paused", async (t) => {
  // 1. None of the node or conversion controls may ever be in REMOTE_METHODS (phones / team members).
  const forbiddenRemote = [
    "nodeStatus",
    "nodeSetup",
    "nodeRename",
    "nodePause",
    "nodeShareProject",
    "nodeRevokeGrant",
    "nodeDisconnect",
    "nodeConvertInspect",
    "nodeConvertPlan",
    "nodeConvertRun",
    "nodeConvertStatus",
    "nodeConvertUndo",
    "nodeRemoteStatus",
    "nodeRemoteControl",
  ];
  for (const method of forbiddenRemote) {
    assert.equal(REMOTE_METHODS.has(method), false, `${method} must never be in REMOTE_METHODS`);
  }

  // 2. Test same-owner remote node control approval, isolated grants, pause/resume/rename/share/unshare/revoke/disconnect.
  const { dir, ws: nodeWs } = makeWorkspace(t);
  const folder = join(dir, "shared-repo");
  mkdirSync(folder, { recursive: true });
  const projectId = nodeWs.projects.create({ name: "Shared Repo", folder });
  nodeWs.nodeHost.setup({ name: "Build Mac" });

  // Pretend a file-listing "Always allow" grant already exists; it must NOT authorize remote node control!
  nodeWs.nodeHost.grants.push({
    id: "file-grant-1",
    scope: "unrelated-node-job-scope",
    sourceHostName: "Owner Laptop",
    sourceBotId: "bot-a",
    sourceBotName: "Scout",
    operation: "project.list_files",
    resourceId: projectId,
    resourceName: "Shared Repo",
    until: null,
    createdAt: Date.now(),
  });

  const peers = makeDirectPeers(nodeWs, {
    sourcePeer: {
      profileId: "owner-profile",
      serverId: "host-owner-laptop",
      serverKey: "laptop-key",
      targetId: "host-node",
      targetKey: "node-key",
      name: "Owner Laptop",
      targetName: "Build Mac",
      verify: async () => {},
    },
  });

  // Read-only status works immediately for same-owner host.
  const st = await remoteNodeStatus(peers, "host-target");
  assert.equal(st.nodeHost.name, "Build Mac");
  assert.equal(st.nodeHost.online, true);

  // Remote pause requires approval -> approve with "remember" (Always allow for pause).
  const pausePromise = remoteNodeControl(peers, "host-target", "pause", {}, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  const pending = nodeWs.interactions.snapshot();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].nodeJob, true);
  assert.match(pending[0].title, /pause node host Build Mac/i);
  nodeWs.interactions.respond(pending[0].id, { action: "remember" }, true, "owner");
  const pauseRes = await pausePromise;
  assert.equal(pauseRes.nodeHost.paused, true);

  // Remote resume MUST work even while the node is paused! Approve once.
  const resumePromise = remoteNodeControl(peers, "host-target", "resume", {}, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  const pendingResume = nodeWs.interactions.snapshot();
  assert.equal(pendingResume.length, 1);
  nodeWs.interactions.respond(pendingResume[0].id, { action: "approve" }, true, "owner");
  const resumeRes = await resumePromise;
  assert.equal(resumeRes.nodeHost.paused, false);

  // Second remote pause uses the saved "Always allow" grant without prompting again!
  const pauseAgain = await remoteNodeControl(peers, "host-target", "pause", {}, { pollMs: 10 });
  assert.equal(pauseAgain.nodeHost.paused, true);
  assert.equal(nodeWs.interactions.snapshot().length, 0);

  // Denied remote rename fails cleanly and does not change the node name.
  const renamePromise = remoteNodeControl(peers, "host-target", "rename", { name: "Hacked" }, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  const pendingRename = nodeWs.interactions.snapshot();
  assert.equal(pendingRename.length, 1);
  nodeWs.interactions.respond(pendingRename[0].id, { action: "deny" }, true, "owner");
  await assert.rejects(renamePromise, /declined/i);
  assert.equal(nodeWs.nodeHost.name, "Build Mac");

  // Remote share + revoke + disconnect succeed when approved.
  const sharePromise = remoteNodeControl(peers, "host-target", "share", { projectId }, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  nodeWs.interactions.respond(nodeWs.interactions.snapshot()[0].id, { action: "approve" }, true, "owner");
  const shareRes = await sharePromise;
  assert.equal(shareRes.nodeHost.sharedProjects.length, 1);

  const revokePromise = remoteNodeControl(peers, "host-target", "revoke", {}, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  nodeWs.interactions.respond(nodeWs.interactions.snapshot()[0].id, { action: "approve" }, true, "owner");
  const revokeRes = await revokePromise;
  assert.equal(revokeRes.nodeHost.grants.length, 0);

  const disconnectPromise = remoteNodeControl(peers, "host-target", "disconnect", {}, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  nodeWs.interactions.respond(nodeWs.interactions.snapshot()[0].id, { action: "approve" }, true, "owner");
  const disconnectRes = await disconnectPromise;
  assert.equal(disconnectRes.nodeHost.enabled, false);
});

test("CLI `botkins node convert` works non-interactively with --json, --dry-run, --all keep, and --undo", async (t) => {
  const { ws } = makeWorkspace(t);
  seedBot(ws, { name: "LocalBot" });

  const calls = {
    "node.convert.inspect": async () => ({
      ...inspectLocalWorkspace(ws),
      targets: [],
      suggestedName: "CLI Mac",
    }),
    "node.convert.plan": async (input) => buildConversionPlan(ws, input, []),
    "node.convert.run": async (input) => runConversion(ws, input, { peers: { available: () => false } }),
    "node.convert.undo": async () => undoConversion(ws, { peers: { available: () => false } }),
  };

  const runCli = async (argv) => {
    let stdout = "";
    let stderr = "";
    const code = await cliMain(argv, {
      stdin: { isTTY: false },
      stdout: { write: (s) => void (stdout += s) },
      stderr: { write: (s) => void (stderr += s) },
      client: {
        call: async (method, ...args) => calls[method](...args),
      },
    });
    return { code, stdout, stderr };
  };

  // Dry run with --json
  const dry = await runCli(["node", "convert", "--name", "CLI Mac", "--all", "keep", "--dry-run", "--json"]);
  assert.equal(dry.code, 0);
  const dryJson = JSON.parse(dry.stdout);
  assert.equal(dryJson.valid, true);
  assert.equal(dryJson.counts.keepBots, ws.state.bots.length);
  assert.equal(ws.nodeHost.enabled, false);

  // Execute conversion non-interactively with --yes --json
  const exec = await runCli(["node", "convert", "--name", "CLI Mac", "--all", "keep", "--yes", "--json"]);
  assert.equal(exec.code, 0);
  const execJson = JSON.parse(exec.stdout);
  assert.equal(execJson.job.status, "completed");
  assert.equal(ws.nodeHost.enabled, true);

  // Undo non-interactively with --undo --yes --json
  const undone = await runCli(["node", "convert", "--undo", "--yes", "--json"]);
  assert.equal(undone.code, 0);
  const undoJson = JSON.parse(undone.stdout);
  assert.equal(undoJson.undone, true);
  assert.equal(ws.nodeHost.enabled, false);
});

test("verifyTransferReceipt catches count and checksum mismatches", () => {
  const base = {
    chatCount: 2,
    messageCount: 10,
    routineCount: 1,
    panelCount: 1,
    profileFileCount: 1,
    skillCount: 1,
    pluginCount: 0,
    projectRefCount: 1,
    memoryBytes: 42,
    contentSha256: "abc123",
  };
  assert.equal(verifyTransferReceipt(base, { ...base }).ok, true);
  assert.equal(verifyTransferReceipt(base, { ...base, messageCount: 9 }).ok, false);
  assert.equal(verifyTransferReceipt(base, { ...base, contentSha256: "xyz" }).ok, false);
});
