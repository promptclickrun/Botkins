// Convert an existing full Botkins host into a Node host:
// - Inspect everything local (grouped by bots + shared workspace resources)
// - Build & validate a per-bot plan (move to an online same-owner host, keep locally as shared bot, or delete)
// - Snapshot local workspace data before any mutation, with one-click undo (preserving phone link & vault)
// - Chunked, verified, idempotent bot transfer over same-owner teamwork-peers (verify-before-delete, routine de-dupe)
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { profileFiles, readProfile } from "./bot-profile-files.mjs";
import { conversations } from "./link/main-chat.mjs";
import { isGroup, GROUP_MIN, memberSessionId } from "./groups.mjs";
import { holderSessions } from "./providers/sessions.mjs";
import { helperSessionId } from "./teamwork.mjs";
import { nextTime } from "./panels.mjs";
import { readWorkspace } from "./workspace-file.mjs";
import { peerCapabilities } from "./remote-teamwork.mjs";

export const CONVERT_SCHEMA_VERSION = 1;
export const DELETE_CONFIRM_PHRASE = "DELETE";
export const CHUNK_BYTES = 48 * 1024; // Fits comfortably under teamwork-peers 160 KiB envelope after JSON/encryption
export const MAX_TRANSFER_BYTES = 24 * 1024 * 1024;
export const MAX_TRANSFER_CHUNKS = 600;
const SNAPSHOTS_DIR = "node-convert-snapshots";
const VALID_ACTIONS = new Set(["move", "keep", "delete"]);

const safeText = (value, max = 80) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max)
    : "";

const sha256 = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");

/** Deterministic JSON serialization with sorted object keys for cross-host checksum verification. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

function ownedBotChats(ws, botId) {
  return ws.state.chats.filter((chat) => chat.botId === botId && !isGroup(chat));
}

function chatSchedulesOf(chats) {
  const list = [];
  for (const chat of chats) {
    for (const schedule of chat.schedules ?? []) {
      list.push({ chatId: chat.id, schedule });
    }
  }
  return list;
}

function listCustomSkillDirs(ws) {
  const skillsDir = join(ws.dir, "skills");
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const full = join(skillsDir, entry.name);
    if (existsSync(join(full, "SKILL.md"))) out.push({ name: entry.name, dir: full });
  }
  return out;
}

function readSkillFiles(skillDir) {
  const rootReal = realpathSync(skillDir);
  const files = [];
  let totalBytes = 0;
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const st = statSync(full);
        if (st.size > 512 * 1024 || totalBytes + st.size > 2 * 1024 * 1024) continue;
        const real = realpathSync(full);
        const rel = relative(rootReal, real).replace(/\\/g, "/");
        if (!rel || rel.startsWith("..")) continue;
        const buf = readFileSync(real);
        totalBytes += buf.length;
        files.push({ relPath: rel, contentBase64: buf.toString("base64") });
      }
    }
  };
  walk(rootReal);
  return files;
}

function listWikiPagesSafe(ws) {
  try {
    if (typeof ws.wiki?.list === "function") {
      const items = ws.wiki.list();
      return Array.isArray(items) ? items.map((item) => item.path || String(item)) : [];
    }
  } catch {}
  const wikiDir = join(ws.dir, "wiki");
  if (!existsSync(wikiDir)) return [];
  const pages = [];
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile() && entry.name.endsWith(".md")) pages.push(rel);
    }
  };
  try {
    walk(wikiDir);
  } catch {}
  return pages.sort();
}

function listVaultMetadata(ws) {
  const raw = ws.vault?.entries ?? {};
  return Object.entries(raw).map(([id, entry]) => ({
    id,
    label: safeText(entry?.label, 120) || id,
    kind: safeText(entry?.kind, 40) || "secret",
    owner: safeText(entry?.owner, 120) || "",
  }));
}

function listBotProjectRefs(ws, botId, chats, panels) {
  const ids = new Set();
  for (const chat of chats) {
    if (chat.projectId) ids.add(chat.projectId);
  }
  for (const panel of panels) {
    if (panel.projectId) ids.add(panel.projectId);
  }
  const botAccessProjects = ws.state.access?.bots?.[botId]?.projects;
  if (Array.isArray(botAccessProjects)) {
    for (const id of botAccessProjects) ids.add(id);
  }
  const byId = new Map((ws.state.projects ?? []).map((p) => [p.id, p]));
  const sharedSet = new Set(ws.nodeHost?.sharedProjects ?? []);
  return [...ids]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description ?? "",
      color: project.color ?? "",
      folder: project.folder ?? "",
      sharedOnSource: sharedSet.has(project.id),
    }));
}

function readBotProfileMap(ws, botId) {
  const out = {};
  for (const file of profileFiles) {
    try {
      const content = readProfile(ws, botId, file);
      if (content) out[file] = content;
    } catch {}
  }
  return out;
}

/**
 * Inspects every local entity in the workspace, grouped into bots + shared host resources.
 * Never returns vault secret values — only entry labels/kinds and a clear security note.
 */
export function inspectLocalWorkspace(ws) {
  const customSkills = listCustomSkillDirs(ws);
  const linkedSkillFolders = Array.isArray(ws.state.integrations?.skillFolders)
    ? ws.state.integrations.skillFolders
    : [];
  const pluginRecords = Array.isArray(ws.plugins?.records) ? ws.plugins.records : [];
  const wikiPages = listWikiPagesSafe(ws);
  const vaultEntries = listVaultMetadata(ws);
  const sharedProjects = new Set(ws.nodeHost?.sharedProjects ?? []);
  const projects = (ws.state.projects ?? []).map((project) => ({
    id: project.id,
    name: project.name,
    folder: project.folder ?? "",
    hasFolder: Boolean(project.folder && project.folder.trim()),
    shared: sharedProjects.has(project.id),
  }));

  const bots = (ws.state.bots ?? []).map((bot) => {
    const chats = ownedBotChats(ws, bot.id);
    const schedules = chatSchedulesOf(chats);
    const activeRoutines = schedules.filter((entry) => entry.schedule.enabled !== false);
    const messageCount = chats.reduce((sum, chat) => sum + (chat.messages?.length ?? 0), 0);
    const memoryText = ws.memory?.read ? ws.memory.read(bot.id) : "";
    const memoryEntries = memoryText
      ? memoryText.split("\n").map((line) => line.trim()).filter(Boolean).length
      : 0;
    const profiles = readBotProfileMap(ws, bot.id);
    const panels = (ws.state.panels ?? []).filter((panel) => panel.botId === bot.id);
    const projectRefs = listBotProjectRefs(ws, bot.id, chats, panels);
    const offSkills = new Set(Array.isArray(bot.skillsOff) ? bot.skillsOff : []);
    const enabledCustomSkills = customSkills.filter((skill) => !offSkills.has(skill.name)).map((skill) => skill.name);
    const botPlugins = pluginRecords
      .filter((row) => row.enabled && (row.bots === "all" || (Array.isArray(row.bots) && row.bots.includes(bot.id))))
      .map((row) => ({ id: row.id, name: row.name || row.id }));
    const groupChatCount = (ws.state.chats ?? []).filter((chat) => isGroup(chat) && chat.botIds?.includes(bot.id)).length;

    return {
      id: bot.id,
      name: bot.name,
      role: bot.role ?? "",
      summary: bot.summary ?? "",
      look: bot.look ?? null,
      hidden: !!bot.hidden,
      teamwork: bot.teamwork !== false,
      chatCount: chats.length,
      messageCount,
      groupChatCount,
      routineCount: schedules.length,
      activeRoutineCount: activeRoutines.length,
      routineTimezones: [...new Set(schedules.map((entry) => entry.schedule.timezone).filter(Boolean))],
      memoryBytes: Buffer.byteLength(memoryText, "utf8"),
      memoryEntries,
      profileFiles: Object.keys(profiles),
      panelCount: panels.length,
      skillCount: enabledCustomSkills.length,
      skills: enabledCustomSkills,
      plugins: botPlugins,
      projectRefs,
    };
  });

  const groupChats = (ws.state.chats ?? [])
    .filter((chat) => isGroup(chat))
    .map((chat) => ({
      id: chat.id,
      title: chat.title || "Group chat",
      botIds: [...(chat.botIds ?? [])],
      messageCount: chat.messages?.length ?? 0,
    }));

  const panels = ws.state.panels ?? [];
  const botPanelCount = panels.filter((panel) => bots.some((b) => b.id === panel.botId)).length;
  const snapshots = listConversionSnapshots(ws);
  const latestSnapshot = snapshots.find((item) => item.status === "active") ?? null;
  const activeJob = ws.nodeHost?.conversionJobs?.at(-1) ?? null;

  return {
    hasLocalData: bots.length > 0 || (ws.state.chats?.length ?? 0) > 0,
    bots,
    shared: {
      wiki: {
        pageCount: wikiPages.length,
        pages: wikiPages.slice(0, 50),
        note: "Shared wiki pages remain on this computer and are never deleted during conversion.",
      },
      skills: {
        customCount: customSkills.length,
        linkedCount: linkedSkillFolders.length,
        names: customSkills.map((skill) => skill.name),
      },
      plugins: {
        count: pluginRecords.length,
        items: pluginRecords.map((row) => ({
          id: row.id,
          name: row.name || row.id,
          enabled: !!row.enabled,
          bots: row.bots === "all" ? "all" : [...(row.bots ?? [])],
        })),
      },
      panels: {
        count: panels.length,
        botOwnedCount: botPanelCount,
        otherCount: panels.length - botPanelCount,
      },
      vault: {
        count: vaultEntries.length,
        locked: !!ws.vault?.locked,
        entries: vaultEntries,
        note: "Vault secrets stay encrypted locally on this computer and are never sent in plaintext over the network.",
      },
      projects: {
        count: projects.length,
        items: projects,
      },
      groupChats: {
        count: groupChats.length,
        items: groupChats,
      },
    },
    snapshot: latestSnapshot,
    activeJob: activeJob ? summarizeJob(activeJob) : null,
  };
}

/**
 * Discovers same-owner online hosts eligible as move targets.
 */
export async function listConversionTargets(ws, peers = ws.teamworkPeers) {
  if (!peers?.available()) return [];
  const { hosts } = await peerCapabilities(peers);
  return hosts.map((host) => ({
    serverId: host.serverId,
    name: host.name,
    role: host.role || "standard",
    online: host.online !== false && !host.unavailable,
    unavailable: !!host.unavailable,
    paused: !!host.paused,
    botCount: Array.isArray(host.bots) ? host.bots.length : 0,
  }));
}

/**
 * Builds and validates a conversion plan for all local bots.
 * Enforces per-bot choices (move / keep / delete), optional sameForAll shortcut,
 * online target host availability, and typed DELETE confirmation when deleting.
 */
export function buildConversionPlan(ws, input = {}, onlineHosts = []) {
  const inventory = inspectLocalWorkspace(ws);
  const nodeName = safeText(input.nodeName || ws.nodeHost?.name, 80);
  if (!nodeName) throw new Error("Give this node host a name.");

  const hostMap = new Map(onlineHosts.map((host) => [host.serverId, host]));
  const rawActions = new Map();

  if (input.sameForAll && typeof input.sameForAll === "object") {
    const { action, targetHostId } = input.sameForAll;
    if (!VALID_ACTIONS.has(action)) throw new Error("Choose move, keep, or delete for same-for-all.");
    for (const bot of inventory.bots) {
      rawActions.set(bot.id, { botId: bot.id, action, ...(targetHostId ? { targetHostId } : {}) });
    }
  }

  const supplied = Array.isArray(input.botActions)
    ? input.botActions
    : input.botActions && typeof input.botActions === "object"
      ? Object.entries(input.botActions).map(([botId, entry]) =>
          typeof entry === "string" ? { botId, action: entry } : { botId, ...entry },
        )
      : [];

  for (const item of supplied) {
    if (!item || typeof item.botId !== "string") continue;
    rawActions.set(item.botId, item);
  }

  const botPlans = [];
  const errors = [];

  for (const bot of inventory.bots) {
    const choice = rawActions.get(bot.id);
    if (!choice || !VALID_ACTIONS.has(choice.action)) {
      errors.push(`Choose Move, Keep locally, or Delete for ${bot.name}.`);
      continue;
    }
    let targetHostId = null;
    let targetHostName = null;
    if (choice.action === "move") {
      targetHostId = typeof choice.targetHostId === "string" ? choice.targetHostId.trim() : "";
      if (!targetHostId) {
        errors.push(`Choose a destination host to move ${bot.name}.`);
        continue;
      }
      const host = hostMap.get(targetHostId);
      if (!host) {
        errors.push(`Destination host for ${bot.name} was not found among your same-owner hosts.`);
        continue;
      }
      if (!host.online || host.unavailable) {
        errors.push(`Destination host ${host.name} is offline. Bring it online or pick another choice for ${bot.name}.`);
        continue;
      }
      targetHostName = host.name;
    }
    botPlans.push({
      botId: bot.id,
      botName: bot.name,
      role: bot.role,
      action: choice.action,
      targetHostId,
      targetHostName,
      chatCount: bot.chatCount,
      messageCount: bot.messageCount,
      routineCount: bot.routineCount,
      activeRoutineCount: bot.activeRoutineCount,
      panelCount: bot.panelCount,
      memoryBytes: bot.memoryBytes,
      profileFileCount: bot.profileFiles.length,
      skillCount: bot.skillCount,
      pluginCount: bot.plugins.length,
      projectRefCount: bot.projectRefs.length,
    });
  }

  const availableFolderProjectIds = new Set(
    inventory.shared.projects.items.filter((project) => project.hasFolder).map((project) => project.id),
  );
  const sharedProjects = Array.isArray(input.sharedProjects)
    ? [...new Set(input.sharedProjects.filter((id) => availableFolderProjectIds.has(id)))]
    : inventory.shared.projects.items.filter((project) => project.shared).map((project) => project.id);

  const moveItems = botPlans.filter((item) => item.action === "move");
  const keepItems = botPlans.filter((item) => item.action === "keep");
  const deleteItems = botPlans.filter((item) => item.action === "delete");

  const counts = {
    totalBots: inventory.bots.length,
    moveBots: moveItems.length,
    keepBots: keepItems.length,
    deleteBots: deleteItems.length,
    chatsMoving: moveItems.reduce((sum, item) => sum + item.chatCount, 0),
    chatsKeeping: keepItems.reduce((sum, item) => sum + item.chatCount, 0),
    chatsDeleting: deleteItems.reduce((sum, item) => sum + item.chatCount, 0),
    messagesMoving: moveItems.reduce((sum, item) => sum + item.messageCount, 0),
    routinesMoving: moveItems.reduce((sum, item) => sum + item.routineCount, 0),
    routinesKeeping: keepItems.reduce((sum, item) => sum + item.routineCount, 0),
    routinesDeleting: deleteItems.reduce((sum, item) => sum + item.routineCount, 0),
    panelsMoving: moveItems.reduce((sum, item) => sum + item.panelCount, 0),
    panelsDeleting: deleteItems.reduce((sum, item) => sum + item.panelCount, 0),
    memoryBotsMoving: moveItems.filter((item) => item.memoryBytes > 0).length,
    profileFilesMoving: moveItems.reduce((sum, item) => sum + item.profileFileCount, 0),
    skillsMoving: moveItems.reduce((sum, item) => sum + item.skillCount, 0),
    pluginEnablementsMoving: moveItems.reduce((sum, item) => sum + item.pluginCount, 0),
    projectRefsMoving: moveItems.reduce((sum, item) => sum + item.projectRefCount, 0),
    vaultEntriesLeftBehind: inventory.shared.vault.count,
    wikiPagesKept: inventory.shared.wiki.pageCount,
    projectsToShare: sharedProjects.length,
  };

  const requiresDeleteConfirmation = deleteItems.length > 0;
  const confirmDelete = typeof input.confirmDelete === "string" ? input.confirmDelete.trim() : "";
  const deleteConfirmed = !requiresDeleteConfirmation || confirmDelete === DELETE_CONFIRM_PHRASE;

  if (input.requireConfirmation && requiresDeleteConfirmation && !deleteConfirmed) {
    errors.push(`Type ${DELETE_CONFIRM_PHRASE} to confirm deleting ${deleteItems.length} bot${deleteItems.length === 1 ? "" : "s"}.`);
  }

  const warnings = [];
  if (inventory.shared.vault.count > 0) {
    warnings.push(
      `${inventory.shared.vault.count} vault secret${inventory.shared.vault.count === 1 ? "" : "s"} will remain encrypted locally on this computer and will not be sent over the network.`,
    );
  }
  if (inventory.shared.groupChats.count > 0 && (moveItems.length > 0 || deleteItems.length > 0)) {
    warnings.push(
      `${inventory.shared.groupChats.count} local group chat${inventory.shared.groupChats.count === 1 ? "" : "s"} will lose moved or deleted participants (groups left with fewer than 2 local bots are removed after snapshot).`,
    );
  }
  if (counts.routinesMoving > 0) {
    warnings.push(
      `${counts.routinesMoving} routine${counts.routinesMoving === 1 ? "" : "s"} will be disabled on this computer before being enabled on the destination host so nothing runs twice.`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    nodeName,
    sharedProjects,
    botPlans,
    counts,
    requiresDeleteConfirmation,
    deleteConfirmationPhrase: DELETE_CONFIRM_PHRASE,
    deleteConfirmed,
    snapshotDir: join(ws.dir, SNAPSHOTS_DIR),
  };
}

/**
 * Exports one bot's complete transferable bundle (never includes vault secret values).
 */
export function exportBotBundle(ws, botId, sourceHostMeta = {}, priorRoutines = null) {
  const bot = ws.state.bots.find((item) => item.id === botId);
  if (!bot) throw new Error("Bot not found: " + botId);

  const priorEnabledMap = new Map();
  if (Array.isArray(priorRoutines)) {
    for (const entry of priorRoutines) {
      if (entry?.chatId && entry?.scheduleId) {
        priorEnabledMap.set(`${entry.chatId}:${entry.scheduleId}`, entry.enabled !== false);
      }
    }
  }

  const chats = ownedBotChats(ws, botId);
  const chatIds = new Set(chats.map((chat) => chat.id));
  const panels = (ws.state.panels ?? []).filter((panel) => panel.botId === botId);
  const runs = (ws.state.runs ?? []).filter((run) => chatIds.has(run.chatId));
  const memory = ws.memory?.read ? ws.memory.read(botId) : "";
  const profileMap = readBotProfileMap(ws, botId);

  // Collect HTML frames owned by this bot's panels and chats.
  const frames = {};
  const frameEntries = (ws.state.frames ?? []).filter(
    (entry) =>
      entry.botId === botId ||
      panels.some((panel) => entry.owner === "panel:" + panel.id) ||
      chats.some((chat) => entry.owner === "chat:" + chat.id),
  );
  for (const entry of frameEntries) {
    try {
      const htmlPath = join(ws.dir, "frames", entry.id + ".html");
      const dataPath = join(ws.dir, "frames", entry.id + ".json");
      if (!existsSync(htmlPath)) continue;
      const html = readFileSync(htmlPath, "utf8");
      const data = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, "utf8")) : undefined;
      frames[entry.id] = { id: entry.id, owner: entry.owner, html, ...(data !== undefined && { data }) };
    } catch {}
  }

  // Sanitize chats: capture original routine enabled flags, force enabled=false during transfer.
  const exportedChats = chats.map((chat) => {
    const copy = structuredClone(chat);
    delete copy.helpers;
    delete copy.sessionId;
    delete copy.sessions;
    copy.restartSession = true;
    if (Array.isArray(copy.schedules)) {
      copy.schedules = copy.schedules.map((schedule) => ({
        ...schedule,
        originalEnabled: priorEnabledMap.has(`${chat.id}:${schedule.id}`)
          ? priorEnabledMap.get(`${chat.id}:${schedule.id}`)
          : schedule.enabled !== false,
        enabled: false,
      }));
    }
    return copy;
  });

  // Collect custom skills enabled for this bot.
  const offSkills = new Set(Array.isArray(bot.skillsOff) ? bot.skillsOff : []);
  const skills = listCustomSkillDirs(ws)
    .filter((skill) => !offSkills.has(skill.name))
    .map((skill) => ({ name: skill.name, files: readSkillFiles(skill.dir) }))
    .filter((skill) => skill.files.length > 0);

  // Plugin enablement metadata only (never secrets or unreviewed local executables).
  const pluginEnablement = (ws.plugins?.records ?? [])
    .filter((row) => row.enabled && (row.bots === "all" || (Array.isArray(row.bots) && row.bots.includes(botId))))
    .map((row) => ({
      id: row.id,
      name: row.name || row.id,
      marketplace: row.marketplace ?? null,
      source: row.source ?? null,
      scope: row.bots === "all" ? "all" : "selected",
    }));

  // Project folder references (host-relative metadata so target knows where the folder lives).
  const projectRefs = listBotProjectRefs(ws, botId, chats, panels).map((ref) => ({
    ...ref,
    sourceHostId: sourceHostMeta.serverId ?? "",
    sourceHostName: sourceHostMeta.name ?? ws.nodeHost?.name ?? "",
  }));

  const exportedBot = structuredClone(bot);
  const exportedPanels = panels.map((panel) => structuredClone(panel));
  const exportedRuns = runs.map((run) => structuredClone(run));

  const payload = {
    version: CONVERT_SCHEMA_VERSION,
    bot: exportedBot,
    profileFiles: profileMap,
    memory,
    chats: exportedChats,
    runs: exportedRuns,
    panels: exportedPanels,
    frames,
    skills,
    pluginEnablement,
    projectRefs,
    vaultNote: {
      leftBehindCount: listVaultMetadata(ws).length,
      message: "Vault secrets stay encrypted on the source computer and were not transmitted.",
    },
  };

  const manifest = computeBundleManifest(payload);
  return { payload, manifest };
}

/**
 * Computes deterministic counts and SHA-256 checksum for a bot bundle.
 * Used on both source (before send) and target (read-back after persist) for verify-before-delete.
 */
export function computeBundleManifest(bundle) {
  const chats = Array.isArray(bundle.chats) ? bundle.chats : [];
  const messageCount = chats.reduce((sum, chat) => sum + (chat.messages?.length ?? 0), 0);
  const routineCount = chats.reduce((sum, chat) => sum + (chat.schedules?.length ?? 0), 0);
  const panels = Array.isArray(bundle.panels) ? bundle.panels : [];
  const frames = bundle.frames && typeof bundle.frames === "object" ? bundle.frames : {};
  const profiles = bundle.profileFiles && typeof bundle.profileFiles === "object" ? bundle.profileFiles : {};
  const skills = Array.isArray(bundle.skills) ? bundle.skills : [];
  const pluginEnablement = Array.isArray(bundle.pluginEnablement) ? bundle.pluginEnablement : [];
  const projectRefs = Array.isArray(bundle.projectRefs) ? bundle.projectRefs : [];
  const memory = typeof bundle.memory === "string" ? bundle.memory : "";

  const normalizedForHash = {
    bot: {
      name: bundle.bot?.name ?? "",
      role: bundle.bot?.role ?? "",
      instructions: bundle.bot?.instructions ?? "",
      summary: bundle.bot?.summary ?? "",
      skillsOff: bundle.bot?.skillsOff ?? [],
      mcpOff: bundle.bot?.mcpOff ?? [],
    },
    profileFiles: Object.fromEntries(
      Object.entries(profiles)
        .filter(([, text]) => typeof text === "string" && text.length > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    memory: memory.replace(/\r\n/g, "\n").trim(),
    chats: chats
      .map((chat) => ({
        title: chat.title ?? "",
        main: !!chat.main,
        messages: (chat.messages ?? []).map((msg) => ({
          role: msg.role ?? "",
          text: msg.text ?? "",
          time: msg.time ?? 0,
        })),
        schedules: (chat.schedules ?? []).map((sched) => ({
          name: sched.name ?? "",
          prompt: sched.prompt ?? "",
          cron: sched.cron ?? "",
          timezone: sched.timezone ?? "",
          recurring: !!sched.recurring,
          routine: !!sched.routine,
        })),
      }))
      .sort((a, b) => (a.main === b.main ? a.title.localeCompare(b.title) : a.main ? -1 : 1)),
    panels: panels
      .map((panel) => ({
        key: panel.key ?? "",
        title: panel.title ?? "",
        blocks: panel.blocks ?? [],
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    skills: skills
      .map((skill) => ({
        name: skill.name,
        files: (skill.files ?? []).map((f) => ({ relPath: f.relPath, sha256: sha256(f.contentBase64) })).sort((a, b) => a.relPath.localeCompare(b.relPath)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    pluginEnablement: pluginEnablement
      .map((item) => ({ id: item.id, name: item.name, scope: item.scope }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    projectRefs: projectRefs
      .map((ref) => ({ id: ref.id, name: ref.name, folder: ref.folder ?? "" }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };

  return {
    botId: bundle.bot?.id ?? "",
    botName: bundle.bot?.name ?? "",
    chatCount: chats.length,
    messageCount,
    routineCount,
    panelCount: panels.length,
    frameCount: Object.keys(frames).length,
    profileFileCount: Object.keys(normalizedForHash.profileFiles).length,
    skillCount: skills.length,
    pluginCount: pluginEnablement.length,
    projectRefCount: projectRefs.length,
    memoryBytes: Buffer.byteLength(normalizedForHash.memory, "utf8"),
    contentSha256: sha256(canonicalJson(normalizedForHash)),
  };
}

/**
 * Compares source expected manifest with target's persisted read-back verification.
 */
export function verifyTransferReceipt(expected, actual) {
  if (!expected || !actual) return { ok: false, reason: "Missing transfer verification receipt." };
  const fields = [
    "chatCount",
    "messageCount",
    "routineCount",
    "panelCount",
    "profileFileCount",
    "skillCount",
    "pluginCount",
    "projectRefCount",
    "memoryBytes",
    "contentSha256",
  ];
  for (const field of fields) {
    if (expected[field] !== actual[field]) {
      return {
        ok: false,
        reason: `Verification mismatch on ${field}: expected ${expected[field]}, target reported ${actual[field]}.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Reads back an imported bot from the target workspace & disk and computes its verification manifest.
 */
export function readBackImportedBot(ws, importRecord) {
  const botId = importRecord.targetBotId;
  const bot = ws.state.bots.find((item) => item.id === botId);
  if (!bot) throw new Error("Imported bot is missing from target workspace.");

  const chats = ownedBotChats(ws, botId);
  const panels = (ws.state.panels ?? []).filter((panel) => panel.botId === botId);
  const memory = ws.memory?.read ? ws.memory.read(botId) : "";
  const profileMap = readBotProfileMap(ws, botId);

  const frames = {};
  const frameEntries = (ws.state.frames ?? []).filter(
    (entry) =>
      entry.botId === botId ||
      panels.some((panel) => entry.owner === "panel:" + panel.id) ||
      chats.some((chat) => entry.owner === "chat:" + chat.id),
  );
  for (const entry of frameEntries) {
    const htmlPath = join(ws.dir, "frames", entry.id + ".html");
    if (existsSync(htmlPath)) frames[entry.id] = { id: entry.id };
  }

  const importedSkillNames = Array.isArray(importRecord.skillNames) ? importRecord.skillNames : [];
  const skills = importedSkillNames
    .map((name) => {
      const dir = join(ws.dir, "skills", name);
      if (!existsSync(dir)) return null;
      return { name, files: readSkillFiles(dir) };
    })
    .filter(Boolean);

  const pluginEnablement = Array.isArray(bot.migratedPluginEnablement) ? bot.migratedPluginEnablement : [];
  const projectRefs = Array.isArray(bot.migratedProjectRefs) ? bot.migratedProjectRefs : [];

  return computeBundleManifest({
    bot,
    profileFiles: profileMap,
    memory,
    chats,
    panels,
    frames,
    skills,
    pluginEnablement,
    projectRefs,
  });
}

// ---------------------------------------------------------------------------
// Target-side migration receiver (called over same-owner teamwork-peers)
// ---------------------------------------------------------------------------

function writeBotProfileDirect(ws, botId, file, text) {
  if (!profileFiles.includes(file) || !/^[\w-]{1,80}$/.test(botId)) return;
  const folder = join(ws.dir, "files", botId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = join(folder, file);
  writeFileSync(target + ".tmp", text, { mode: 0o600 });
  renameSync(target + ".tmp", target);
}

function writeImportedSkill(ws, skill) {
  if (!skill || typeof skill.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.name)) return false;
  const base = join(ws.dir, "skills");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = join(base, skill.name);
  if (existsSync(dir)) {
    // Already exists on target; keep existing skill rather than clobbering silently.
    return true;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rootReal = realpathSync(dir);
  for (const file of skill.files ?? []) {
    if (typeof file.relPath !== "string" || !file.relPath || file.relPath.includes("..") || file.relPath.startsWith("/")) {
      continue;
    }
    const dest = resolve(rootReal, file.relPath);
    if (!dest.startsWith(rootReal + "/") && dest !== rootReal) continue;
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, Buffer.from(file.contentBase64, "base64"), { mode: 0o600 });
  }
  return true;
}

function importBotBundleOnTarget(ws, peer, transferId, jobId, bundle, manifest) {
  const existing = ws.nodeHost.imports[transferId];
  if (existing && ws.state.bots.some((b) => b.id === existing.targetBotId)) {
    const verification = readBackImportedBot(ws, existing);
    return { status: existing.status, targetBotId: existing.targetBotId, verification, alreadyImported: true };
  }

  const incomingBot = structuredClone(bundle.bot);
  const sourceBotId = incomingBot.id;
  // Preserve bot ID if unused on target; otherwise allocate a fresh UUID and remap references.
  const idTaken = ws.state.bots.some((b) => b.id === sourceBotId);
  const targetBotId = idTaken ? randomUUID() : sourceBotId;
  incomingBot.id = targetBotId;
  incomingBot.face = "idle";
  incomingBot.migratedFrom = {
    hostId: peer.serverId,
    hostName: peer.name,
    sourceBotId,
    transferId,
    at: Date.now(),
  };
  incomingBot.migratedPluginEnablement = Array.isArray(bundle.pluginEnablement) ? bundle.pluginEnablement : [];
  incomingBot.migratedProjectRefs = Array.isArray(bundle.projectRefs) ? bundle.projectRefs : [];

  ws.state.bots.push(incomingBot);

  // Import chats with remapped IDs where needed to prevent collisions.
  const chatIdMap = new Map();
  const importedChats = [];
  for (const rawChat of bundle.chats ?? []) {
    const chat = structuredClone(rawChat);
    const oldChatId = chat.id;
    const chatCollision = ws.state.chats.some((c) => c.id === oldChatId);
    const newChatId = chatCollision || (chat.main && idTaken) ? randomUUID() : oldChatId;
    chatIdMap.set(oldChatId, newChatId);
    chat.id = newChatId;
    chat.botId = targetBotId;
    chat.restartSession = true;
    // Routines ALWAYS stay disabled on target until source verifies and calls migrate.activate!
    if (Array.isArray(chat.schedules)) {
      chat.schedules = chat.schedules.map((schedule) => ({
        ...schedule,
        originalEnabled: schedule.originalEnabled ?? (schedule.enabled !== false),
        enabled: false,
      }));
    }
    importedChats.push(chat);
  }
  ws.state.chats.push(...importedChats);

  // Import runs associated with the imported chats.
  const importedRuns = [];
  for (const rawRun of bundle.runs ?? []) {
    const mappedChatId = chatIdMap.get(rawRun.chatId);
    if (!mappedChatId) continue;
    const run = structuredClone(rawRun);
    if (ws.state.runs.some((r) => r.id === run.id)) run.id = randomUUID();
    run.chatId = mappedChatId;
    if (run.botId === sourceBotId) run.botId = targetBotId;
    importedRuns.push(run);
  }
  ws.state.runs.push(...importedRuns);

  // Import Today panels and remap panel IDs & frame owners cleanly.
  const panelIdMap = new Map();
  for (const rawPanel of bundle.panels ?? []) {
    const panel = structuredClone(rawPanel);
    const oldPanelId = panel.id;
    const newPanelId = ws.state.panels.some((p) => p.id === oldPanelId) ? randomUUID() : oldPanelId;
    panelIdMap.set(oldPanelId, newPanelId);
    panel.id = newPanelId;
    panel.botId = targetBotId;
    if (panel.refreshChatId && chatIdMap.has(panel.refreshChatId)) {
      panel.refreshChatId = chatIdMap.get(panel.refreshChatId);
    }
    ws.state.panels.push(panel);
    if (panel.spaceId) ws.spaces?.touch?.(panel.spaceId);
  }

  // Import HTML frames.
  const framesDir = join(ws.dir, "frames");
  const frameEntries = Object.values(bundle.frames ?? {});
  if (frameEntries.length) {
    mkdirSync(framesDir, { recursive: true, mode: 0o700 });
    ws.state.frames ??= [];
    for (const frame of frameEntries) {
      let owner = frame.owner || "";
      if (owner.startsWith("panel:")) {
        const oldId = owner.slice("panel:".length);
        owner = "panel:" + (panelIdMap.get(oldId) ?? oldId);
      } else if (owner.startsWith("chat:")) {
        const oldId = owner.slice("chat:".length);
        owner = "chat:" + (chatIdMap.get(oldId) ?? oldId);
      }
      const frameId = ws.state.frames.some((f) => f.id === frame.id) ? randomUUID() : frame.id;
      writeFileSync(join(framesDir, frameId + ".html"), String(frame.html ?? ""), { mode: 0o600 });
      if (frame.data !== undefined) {
        writeFileSync(join(framesDir, frameId + ".json"), JSON.stringify(frame.data), { mode: 0o600 });
      }
      ws.state.frames.push({ id: frameId, owner, botId: targetBotId });
    }
  }

  // Import memory & profile files.
  if (typeof bundle.memory === "string" && bundle.memory.trim()) {
    ws.memory.write(targetBotId, bundle.memory);
  }
  for (const [file, text] of Object.entries(bundle.profileFiles ?? {})) {
    if (typeof text === "string" && text.length > 0) {
      writeBotProfileDirect(ws, targetBotId, file, text);
    }
  }

  // Import custom skills.
  const importedSkillNames = [];
  for (const skill of bundle.skills ?? []) {
    if (writeImportedSkill(ws, skill)) importedSkillNames.push(skill.name);
  }

  // Apply plugin enablement for plugins already installed on the target host.
  if (Array.isArray(ws.plugins?.records) && Array.isArray(bundle.pluginEnablement)) {
    let pluginsChanged = false;
    for (const pref of bundle.pluginEnablement) {
      const row = ws.plugins.records.find((r) => r.id === pref.id || r.name === pref.name);
      if (row && Array.isArray(row.bots) && !row.bots.includes(targetBotId)) {
        row.bots.push(targetBotId);
        pluginsChanged = true;
      }
    }
    if (pluginsChanged && typeof ws.plugins.save === "function") {
      try {
        ws.plugins.save();
      } catch {}
    }
  }

  const record = {
    transferId,
    jobId,
    sourceHostId: peer.serverId,
    sourceHostName: peer.name,
    sourceBotId,
    targetBotId,
    botName: incomingBot.name,
    skillNames: importedSkillNames,
    manifest,
    status: "imported",
    routinesActivated: false,
    at: Date.now(),
  };
  ws.nodeHost.imports[transferId] = record;
  ws.clearCatalogs?.();
  ws.save();

  const verification = readBackImportedBot(ws, record);
  return { status: "imported", targetBotId, verification, alreadyImported: false };
}

/**
 * Handles incoming migration RPCs on a target host over same-owner teamwork-peers.
 */
export async function receiveMigration(ws, peer, operation, payload = {}) {
  if (ws.closing) throw new Error("The destination is closing.");
  const transferId = safeText(payload.transferId, 120);
  if (!transferId) throw new Error("Missing transfer ID.");
  const staging = (ws.nodeHost.migrationStaging ??= new Map());

  if (operation === "migrate.begin") {
    const existing = ws.nodeHost.imports[transferId];
    if (existing && ws.state.bots.some((b) => b.id === existing.targetBotId)) {
      const verification = readBackImportedBot(ws, existing);
      return {
        status: existing.status,
        alreadyImported: true,
        targetBotId: existing.targetBotId,
        verification,
      };
    }
    const totalChunks = Number(payload.totalChunks);
    const totalBytes = Number(payload.totalBytes);
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_TRANSFER_CHUNKS) {
      throw new Error("Invalid migration chunk count.");
    }
    if (!Number.isInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_TRANSFER_BYTES) {
      throw new Error("Migration payload exceeds maximum size.");
    }
    const existingStage = staging.get(transferId);
    if (existingStage && existingStage.peerServerId === peer.serverId && existingStage.totalChunks === totalChunks) {
      return {
        status: "ready",
        alreadyImported: false,
        receivedChunks: [...existingStage.chunks.keys()].sort((a, b) => a - b),
      };
    }
    staging.set(transferId, {
      transferId,
      jobId: safeText(payload.jobId, 120),
      peerServerId: peer.serverId,
      manifest: payload.manifest ?? null,
      totalChunks,
      totalBytes,
      chunks: new Map(),
      createdAt: Date.now(),
    });
    return { status: "ready", alreadyImported: false, receivedChunks: [] };
  }

  if (operation === "migrate.chunk") {
    const stage = staging.get(transferId);
    if (!stage || stage.peerServerId !== peer.serverId) {
      throw new Error("Unknown or expired migration staging session.");
    }
    const index = Number(payload.index);
    if (!Number.isInteger(index) || index < 0 || index >= stage.totalChunks) {
      throw new Error("Invalid chunk index.");
    }
    if (typeof payload.data !== "string" || typeof payload.sha256 !== "string") {
      throw new Error("Invalid chunk payload.");
    }
    const buf = Buffer.from(payload.data, "base64");
    if (sha256(buf) !== payload.sha256) {
      throw new Error("Chunk checksum mismatch.");
    }
    stage.chunks.set(index, buf);
    return { status: "chunk_ok", index, received: stage.chunks.size, totalChunks: stage.totalChunks };
  }

  if (operation === "migrate.commit") {
    const existing = ws.nodeHost.imports[transferId];
    if (existing && ws.state.bots.some((b) => b.id === existing.targetBotId)) {
      const verification = readBackImportedBot(ws, existing);
      return { status: existing.status, targetBotId: existing.targetBotId, verification, alreadyImported: true };
    }
    const stage = staging.get(transferId);
    if (!stage || stage.peerServerId !== peer.serverId) {
      throw new Error("Unknown migration staging session.");
    }
    if (stage.chunks.size !== stage.totalChunks) {
      throw new Error(`Incomplete migration transfer (${stage.chunks.size}/${stage.totalChunks} chunks received).`);
    }
    const ordered = [];
    for (let i = 0; i < stage.totalChunks; i++) {
      const chunk = stage.chunks.get(i);
      if (!chunk) throw new Error(`Missing migration chunk ${i}.`);
      ordered.push(chunk);
    }
    const fullBuf = Buffer.concat(ordered);
    if (fullBuf.length > MAX_TRANSFER_BYTES) throw new Error("Migration payload exceeds size limit.");
    let bundle;
    try {
      bundle = JSON.parse(fullBuf.toString("utf8"));
    } catch {
      throw new Error("Migration bundle JSON is invalid.");
    }
    const computed = computeBundleManifest(bundle);
    if (stage.manifest?.contentSha256 && computed.contentSha256 !== stage.manifest.contentSha256) {
      throw new Error("Migration bundle checksum mismatch before import.");
    }
    await peer.verify();
    const res = importBotBundleOnTarget(ws, peer, transferId, stage.jobId, bundle, computed);
    staging.delete(transferId);
    return res;
  }

  if (operation === "migrate.verify") {
    const record = ws.nodeHost.imports[transferId];
    if (!record) throw new Error("Unknown migration transfer.");
    const verification = readBackImportedBot(ws, record);
    return { status: record.status, targetBotId: record.targetBotId, verification };
  }

  if (operation === "migrate.activate") {
    const record = ws.nodeHost.imports[transferId];
    if (!record) throw new Error("Unknown migration transfer.");
    await peer.verify();
    let activatedRoutines = 0;
    const now = Date.now();
    for (const chat of ownedBotChats(ws, record.targetBotId)) {
      for (const schedule of chat.schedules ?? []) {
        const shouldEnable = schedule.originalEnabled !== false;
        delete schedule.originalEnabled;
        schedule.enabled = shouldEnable;
        if (shouldEnable) {
          activatedRoutines++;
          if (schedule.recurring && schedule.cron) {
            try {
              schedule.nextAt = nextTime(schedule.cron, schedule.timezone, now);
            } catch {}
          }
        }
      }
    }
    record.status = "committed";
    record.routinesActivated = true;
    record.activatedAt = now;
    ws.save();
    return { status: "committed", targetBotId: record.targetBotId, activatedRoutines };
  }

  if (operation === "migrate.rollback") {
    const record = ws.nodeHost.imports[transferId];
    if (!record) return { status: "not_found", disabledRoutines: 0 };
    await peer.verify();
    let disabledRoutines = 0;
    for (const chat of ownedBotChats(ws, record.targetBotId)) {
      for (const schedule of chat.schedules ?? []) {
        if (schedule.enabled !== false) {
          schedule.enabled = false;
          disabledRoutines++;
        }
      }
    }
    record.status = "rolled_back";
    record.routinesActivated = false;
    ws.save();
    return { status: "rolled_back", targetBotId: record.targetBotId, disabledRoutines };
  }

  throw new Error("Unknown migration operation.");
}

// ---------------------------------------------------------------------------
// Local snapshot & one-click Undo (never touches link/ or vault.json)
// ---------------------------------------------------------------------------

export function listConversionSnapshots(ws) {
  const root = join(ws.dir, SNAPSHOTS_DIR);
  if (!existsSync(root)) return [];
  const list = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestFile = join(root, entry.name, "manifest.json");
    if (!existsSync(manifestFile)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      list.push({ ...manifest, path: join(root, entry.name) });
    } catch {}
  }
  return list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function updateSnapshotManifest(snapshotPath, patch) {
  const file = join(snapshotPath, "manifest.json");
  if (!existsSync(file)) return;
  const current = JSON.parse(readFileSync(file, "utf8"));
  const next = { ...current, ...patch };
  writeFileSync(file + ".tmp", JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

/**
 * Takes a full local backup snapshot of workspace state, bot memories, profile files,
 * HTML frames, custom skills, and plugin config before any move or delete occurs.
 * Phone link (`link/`) and credential vault (`vault.json`/`vault.key`) are untouched.
 */
export function createConversionSnapshot(ws, jobId, meta = {}) {
  ws.flushSave?.();
  ws.save();
  const id = "snap-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const root = join(ws.dir, SNAPSHOTS_DIR);
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const copied = [];
  const copyIfExists = (name) => {
    const src = join(ws.dir, name);
    if (!existsSync(src)) return;
    cpSync(src, join(dir, name), { recursive: true });
    copied.push(name);
  };

  copyIfExists("workspace.json");
  copyIfExists("memory");
  copyIfExists("files");
  copyIfExists("frames");
  copyIfExists("skills");
  copyIfExists("plugins.json");

  const workspaceBytes = existsSync(join(dir, "workspace.json"))
    ? readFileSync(join(dir, "workspace.json"))
    : Buffer.alloc(0);

  const manifest = {
    id,
    jobId,
    createdAt: Date.now(),
    status: "active",
    nodeName: meta.nodeName || "",
    priorNodeHost: ws.nodeHost.view(),
    priorOnboarded: !!ws.state.settings?.onboarded,
    copied,
    workspaceSha256: sha256(workspaceBytes),
    botCount: ws.state.bots.length,
    chatCount: ws.state.chats.length,
    transfers: [],
  };

  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { ...manifest, path: dir };
}

/**
 * Restores this computer from a conversion snapshot (one-click Undo).
 * Rolls back routines on reachable target hosts so nothing runs on both computers.
 * Preserves phone link & pairing (`link/`) and vault (`vault.json`).
 */
export async function undoConversion(ws, { snapshotId, peers } = {}) {
  const snapshots = listConversionSnapshots(ws);
  const snapshot = snapshotId
    ? snapshots.find((s) => s.id === snapshotId)
    : snapshots.find((s) => s.status === "active");
  if (!snapshot) throw new Error("No conversion backup snapshot is available to undo.");

  const savedFile = join(snapshot.path, "workspace.json");
  if (!existsSync(savedFile)) throw new Error("Conversion snapshot is missing workspace.json.");

  // Check if any active turns are running before restoring.
  if (ws.active.size > 0) {
    throw new Error("Stop running chats before undoing conversion.");
  }

  // Attempt to disable routines on target hosts for any bots that were moved.
  const unreachableTargets = [];
  const rolledBackBots = [];
  const transfers = Array.isArray(snapshot.transfers) ? snapshot.transfers : [];
  if (transfers.length && peers?.available?.()) {
    let hosts = [];
    try {
      hosts = await peers.hosts(true);
    } catch {}
    const pinByHost = new Map(hosts.map((h) => [h.serverId, h.pin]));
    for (const transfer of transfers) {
      const pin = pinByHost.get(transfer.targetHostId);
      if (!pin) {
        unreachableTargets.push(transfer);
        continue;
      }
      try {
        await peers.call(transfer.targetHostId, "migrate.rollback", { transferId: transfer.transferId }, pin);
        rolledBackBots.push(transfer.botId);
      } catch {
        unreachableTargets.push(transfer);
      }
    }
  } else if (transfers.length) {
    unreachableTargets.push(...transfers);
  }

  // Restore filesystem directories from snapshot (never touches link/ or vault.json!).
  const restoreDir = (name) => {
    const src = join(snapshot.path, name);
    const dst = join(ws.dir, name);
    rmSync(dst, { recursive: true, force: true });
    if (existsSync(src)) cpSync(src, dst, { recursive: true });
  };
  restoreDir("memory");
  restoreDir("files");
  restoreDir("frames");
  restoreDir("skills");
  if (existsSync(join(snapshot.path, "plugins.json"))) {
    cpSync(join(snapshot.path, "plugins.json"), join(ws.dir, "plugins.json"));
    if (ws.plugins) {
      try {
        ws.plugins.records = JSON.parse(readFileSync(join(ws.dir, "plugins.json"), "utf8"));
      } catch {}
    }
  }

  // Reload workspace.json in-memory state.
  const restored = readWorkspace(savedFile);
  const restoredNodeHost = restored.nodeHost ?? {};
  delete restored.nodeHost;
  delete restored.hostDispatch;
  delete restored.pendingMessages;
  delete restored.detachedQuestions;
  delete restored.outgoingDispatches;

  ws.state = restored;
  ws.state.panels ??= [];
  ws.nodeHost.enabled = restoredNodeHost.enabled === true;
  ws.nodeHost.name = safeText(restoredNodeHost.name, 80);
  ws.nodeHost.paused = restoredNodeHost.paused === true;
  ws.nodeHost.sharedProjects = Array.isArray(restoredNodeHost.sharedProjects) ? restoredNodeHost.sharedProjects : [];
  ws.nodeHost.grants = Array.isArray(restoredNodeHost.grants) ? restoredNodeHost.grants : [];
  ws.nodeHost.lastCompleted = restoredNodeHost.lastCompleted ?? null;

  // Safety: if a target host was unreachable during rollback, keep that moved bot's routines paused
  // on the restored source so routines NEVER run on both hosts simultaneously.
  const pausedToPreventDupes = [];
  const unreachableBotIds = new Set(unreachableTargets.map((item) => item.botId));
  if (unreachableBotIds.size > 0) {
    for (const chat of ws.state.chats) {
      if (!unreachableBotIds.has(chat.botId)) continue;
      for (const schedule of chat.schedules ?? []) {
        if (schedule.enabled !== false) {
          schedule.enabled = false;
          pausedToPreventDupes.push({ botId: chat.botId, routineName: schedule.name || chat.title });
        }
      }
    }
  }

  // Record undone state on snapshot & conversion job.
  updateSnapshotManifest(snapshot.path, { status: "undone", undoneAt: Date.now() });
  for (const job of ws.nodeHost.conversionJobs) {
    if (job.snapshotId === snapshot.id) {
      job.status = "undone";
      job.updatedAt = Date.now();
    }
  }
  ws.clearCatalogs?.();
  ws.save();

  return {
    undone: true,
    snapshotId: snapshot.id,
    snapshotPath: snapshot.path,
    restoredBots: ws.state.bots.length,
    restoredChats: ws.state.chats.length,
    nodeHost: ws.nodeHost.view(),
    rolledBackRemoteBots: rolledBackBots,
    unreachableTargets: unreachableTargets.map((t) => ({
      botId: t.botId,
      botName: t.botName,
      targetHostName: t.targetHostName,
    })),
    pausedToPreventDupes,
  };
}

// ---------------------------------------------------------------------------
// Safe bot removal on source (allows removing the last bot for node conversion)
// ---------------------------------------------------------------------------

export async function removeBotForConversion(ws, botId) {
  const bot = ws.state.bots.find((b) => b.id === botId);
  if (!bot) return false;

  const groups = ws.state.chats.filter((c) => isGroup(c) && c.botIds?.includes(botId));
  const chats = ownedBotChats(ws, botId);
  ws.agents.assertIdle([...chats, ...groups], "bot");

  const ended = groups.filter((g) => g.botIds.length - 1 < GROUP_MIN);
  chats.push(...ended);

  const memberSessions = [];
  const def = ws.providers?.default?.id;
  for (const group of groups) {
    if (ended.includes(group)) continue;
    if (group.members?.[botId]) {
      memberSessions.push(...holderSessions(group.members[botId], memberSessionId(group, botId), def));
    }
    group.botIds = group.botIds.filter((b) => b !== botId);
    delete group.members?.[botId];
    if (group.botId === botId) group.botId = group.botIds[0];
  }

  for (const chat of ws.state.chats.flatMap(conversations)) {
    if (!chat.helpers?.[botId]) continue;
    if (!chats.includes(chat)) {
      memberSessions.push(...holderSessions(chat.helpers[botId], helperSessionId(chat, botId), def));
    }
    delete chat.helpers[botId];
  }

  const chatIds = new Set(chats.map((c) => c.id));
  ws.mcpApps?.removeChats?.([...chatIds]);
  ws.state.bots = ws.state.bots.filter((b) => b.id !== botId);
  ws.state.chats = ws.state.chats.filter((c) => !chatIds.has(c.id));
  ws.state.runs = ws.state.runs.filter((r) => !chatIds.has(r.chatId));
  for (const panel of ws.state.panels) {
    if (panel.botId !== botId) continue;
    ws.frames?.removeOwner?.("panel:" + panel.id);
    ws.spaces?.touch?.(panel.spaceId);
  }
  for (const chatId of chatIds) ws.frames?.removeOwner?.("chat:" + chatId);
  ws.state.panels = ws.state.panels.filter((p) => p.botId !== botId);
  ws.board?.removeBot?.(botId);
  ws.apps?.removeChats?.([...chatIds]);
  ws.tasks?.removeBot?.(botId);
  ws.memory?.remove?.(botId);
  // Remove bot profile files directory (<data>/files/<botId>).
  rmSync(join(ws.dir, "files", botId), { recursive: true, force: true });
  ws.sessionPrompts?.forget?.((record) => record.botId === botId || chatIds.has(record.chatId));
  ws.proactive?.sync?.();
  if (ws.state.bots[0]) ws.state.bots[0].hidden = false;
  ws.clearCatalogs?.();
  ws.save();
  if (typeof ws.agents?.deleteSessions === "function") {
    await ws.agents.deleteSessions(chats, memberSessions).catch(() => {});
  }
  return true;
}

// ---------------------------------------------------------------------------
// Conversion runner (idempotent, resumable, verify-before-delete, routine de-dupe)
// ---------------------------------------------------------------------------

export function summarizeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    nodeName: job.nodeName,
    sharedProjects: [...(job.sharedProjects ?? [])],
    snapshotId: job.snapshotId ?? null,
    snapshotPath: job.snapshotPath ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error ?? null,
    items: (job.items ?? []).map((item) => ({
      botId: item.botId,
      botName: item.botName,
      action: item.action,
      targetHostId: item.targetHostId ?? null,
      targetHostName: item.targetHostName ?? null,
      transferId: item.transferId ?? null,
      targetBotId: item.targetBotId ?? null,
      stage: item.stage,
      error: item.error ?? null,
      verification: item.verification ?? null,
    })),
  };
}

function disableSourceRoutines(ws, botId) {
  const prior = [];
  for (const chat of ownedBotChats(ws, botId)) {
    for (const schedule of chat.schedules ?? []) {
      prior.push({ chatId: chat.id, scheduleId: schedule.id, enabled: schedule.enabled !== false });
      schedule.enabled = false;
    }
  }
  if (prior.length) ws.save();
  return prior;
}

function restoreSourceRoutines(ws, prior) {
  if (!Array.isArray(prior) || !prior.length) return;
  let changed = false;
  for (const entry of prior) {
    const chat = ws.state.chats.find((c) => c.id === entry.chatId);
    const schedule = chat?.schedules?.find((s) => s.id === entry.scheduleId);
    if (schedule && schedule.enabled !== entry.enabled) {
      schedule.enabled = entry.enabled;
      changed = true;
    }
  }
  if (changed) ws.save();
}

async function transferBotToTarget(ws, peers, item, { serverId, name }, pin) {
  const { payload, manifest } = exportBotBundle(ws, item.botId, { serverId, name }, item.priorRoutines);
  const serialized = Buffer.from(JSON.stringify(payload), "utf8");
  if (serialized.length > MAX_TRANSFER_BYTES) {
    throw new Error(`${item.botName} exceeds the maximum transfer size (${MAX_TRANSFER_BYTES} bytes).`);
  }
  const chunks = [];
  for (let offset = 0; offset < serialized.length; offset += CHUNK_BYTES) {
    chunks.push(serialized.subarray(offset, offset + CHUNK_BYTES));
  }

  const beginRes = await peers.call(
    item.targetHostId,
    "migrate.begin",
    {
      transferId: item.transferId,
      jobId: item.jobId,
      botId: item.botId,
      manifest,
      totalChunks: chunks.length,
      totalBytes: serialized.length,
    },
    pin,
  );

  if (beginRes?.alreadyImported) {
    const check = verifyTransferReceipt(manifest, beginRes.verification);
    if (!check.ok) throw new Error(check.reason);
    return { targetBotId: beginRes.targetBotId, verification: beginRes.verification, manifest };
  }

  const received = new Set(Array.isArray(beginRes?.receivedChunks) ? beginRes.receivedChunks : []);
  for (let i = 0; i < chunks.length; i++) {
    if (received.has(i)) continue;
    await peers.call(
      item.targetHostId,
      "migrate.chunk",
      {
        transferId: item.transferId,
        index: i,
        data: chunks[i].toString("base64"),
        sha256: sha256(chunks[i]),
      },
      pin,
    );
  }

  const commitRes = await peers.call(
    item.targetHostId,
    "migrate.commit",
    { transferId: item.transferId },
    pin,
  );

  const verifyRes = await peers.call(
    item.targetHostId,
    "migrate.verify",
    { transferId: item.transferId },
    pin,
  );

  const check = verifyTransferReceipt(manifest, verifyRes?.verification ?? commitRes?.verification);
  if (!check.ok) throw new Error(check.reason);

  return {
    targetBotId: verifyRes?.targetBotId ?? commitRes?.targetBotId,
    verification: verifyRes?.verification ?? commitRes?.verification,
    manifest,
  };
}

/**
 * Executes or resumes a conversion job.
 * - Creates a local backup snapshot before any move or delete.
 * - Disables routines on source before transferring and enabling on target.
 * - Verifies counts & SHA-256 checksum on target before deleting anything on source.
 * - Stops cleanly if a target host goes offline mid-move, leaving unmoved items untouched on source.
 * - Idempotent & resumable: re-running with the same jobId (or resuming an interrupted job) skips finished items.
 */
export async function runConversion(ws, input = {}, { peers, link, announce, onProgress } = {}) {
  const effectivePeers = peers ?? ws.teamworkPeers;

  // Check if resuming an existing unfinished conversion job.
  let job = input.jobId
    ? ws.nodeHost.conversionJobs.find((j) => j.id === input.jobId)
    : input.resume
      ? [...ws.nodeHost.conversionJobs].reverse().find((j) => j.status === "failed" || j.status === "paused" || j.status === "running")
      : null;

  const onlineHosts = effectivePeers?.available?.()
    ? await listConversionTargets(ws, effectivePeers)
    : [];

  if (!job) {
    const plan = buildConversionPlan(ws, { ...input, requireConfirmation: true }, onlineHosts);
    if (!plan.valid) throw new Error(plan.errors[0] || "Conversion plan is incomplete.");

    const jobId = randomUUID();
    job = {
      id: jobId,
      status: "running",
      nodeName: plan.nodeName,
      sharedProjects: plan.sharedProjects,
      snapshotId: null,
      snapshotPath: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
      items: plan.botPlans.map((bp) => ({
        jobId,
        botId: bp.botId,
        botName: bp.botName,
        action: bp.action,
        targetHostId: bp.targetHostId,
        targetHostName: bp.targetHostName,
        transferId: bp.action === "move" ? `convert-${jobId}-${bp.botId}` : null,
        targetBotId: null,
        stage: "pending",
        priorRoutines: null,
        verification: null,
        error: null,
      })),
    };
    ws.nodeHost.conversionJobs.push(job);
    ws.save();
  } else {
    if (job.status === "completed") {
      return { job: summarizeJob(job), nodeHost: ws.nodeHost.view() };
    }
    job.status = "running";
    job.error = null;
    job.updatedAt = Date.now();
    ws.save();
  }

  const emit = () => {
    job.updatedAt = Date.now();
    ws.save();
    onProgress?.(summarizeJob(job));
  };

  // Step 1: Take local backup snapshot BEFORE any move or delete (idempotent on resume).
  if (!job.snapshotId || !job.snapshotPath || !existsSync(job.snapshotPath)) {
    const snap = createConversionSnapshot(ws, job.id, { nodeName: job.nodeName });
    job.snapshotId = snap.id;
    job.snapshotPath = snap.path;
    emit();
  }

  // Build peer pin map for move operations.
  const pinByHost = new Map();
  if (job.items.some((item) => item.action === "move" && item.stage !== "done")) {
    if (!effectivePeers?.available?.()) {
      job.status = "failed";
      job.error = "Cannot reach other computers right now. Sign in and enable host teamwork to move bots.";
      emit();
      return { job: summarizeJob(job), nodeHost: ws.nodeHost.view() };
    }
    try {
      const hosts = await effectivePeers.hosts(true);
      for (const host of hosts) pinByHost.set(host.serverId, host.pin);
    } catch (error) {
      job.status = "failed";
      job.error = String(error?.message || "Could not look up destination hosts.");
      emit();
      return { job: summarizeJob(job), nodeHost: ws.nodeHost.view() };
    }
  }

  const sourceHostMeta = {
    serverId: link?.store?.data?.serverId ?? "",
    name: job.nodeName,
  };

  const recordSnapshotTransfer = (item) => {
    if (!job.snapshotPath) return;
    try {
      const file = join(job.snapshotPath, "manifest.json");
      const cur = JSON.parse(readFileSync(file, "utf8"));
      const transfers = Array.isArray(cur.transfers) ? cur.transfers : [];
      if (!transfers.some((t) => t.transferId === item.transferId)) {
        transfers.push({
          transferId: item.transferId,
          botId: item.botId,
          botName: item.botName,
          targetHostId: item.targetHostId,
          targetHostName: item.targetHostName,
          targetBotId: item.targetBotId,
        });
        updateSnapshotManifest(job.snapshotPath, { transfers });
      }
    } catch {}
  };

  // Step 2: Process each bot cleanly.
  for (const item of job.items) {
    if (["done", "kept", "deleted"].includes(item.stage)) continue;

    if (item.action === "keep") {
      const bot = ws.state.bots.find((b) => b.id === item.botId);
      if (bot) {
        ws.state.settings.teamwork = true;
        bot.hidden = false;
        bot.teamwork = true;
      }
      item.stage = "kept";
      item.error = null;
      emit();
      continue;
    }

    if (item.action === "delete") {
      try {
        await removeBotForConversion(ws, item.botId);
        item.stage = "deleted";
        item.error = null;
        emit();
      } catch (error) {
        item.stage = "failed";
        item.error = String(error?.message || "Could not delete bot.");
        job.status = "failed";
        job.error = item.error;
        emit();
        return { job: summarizeJob(job), nodeHost: ws.nodeHost.view() };
      }
      continue;
    }

    if (item.action === "move") {
      const pin = pinByHost.get(item.targetHostId);
      if (!pin) {
        item.stage = "failed";
        item.error = `${item.targetHostName || "Destination host"} is offline. Unmoved bots remain untouched on this computer.`;
        job.status = "paused";
        job.error = item.error;
        emit();
        return { job: summarizeJob(job), nodeHost: ws.nodeHost.view() };
      }

      try {
        // 2a. If already cleaned on source (interrupted right before activate), only finish activation!
        if (item.stage === "cleaned") {
          await effectivePeers.call(item.targetHostId, "migrate.activate", { transferId: item.transferId }, pin);
          item.stage = "done";
          item.error = null;
          emit();
          continue;
        }

        // 2b. Disable routines on source FIRST so nothing can ever run twice!
        if (item.stage === "pending" || item.stage === "failed") {
          item.priorRoutines = disableSourceRoutines(ws, item.botId);
          item.stage = "routines_disabled";
          item.error = null;
          emit();
        }

        // 2c. Transfer & verify counts + SHA-256 on target BEFORE deleting anything on source.
        if (item.stage === "routines_disabled" || item.stage === "transferring") {
          item.stage = "transferring";
          emit();
          const { targetBotId, verification } = await transferBotToTarget(
            ws,
            effectivePeers,
            item,
            sourceHostMeta,
            pin,
          );
          item.targetBotId = targetBotId;
          item.verification = verification;
          item.stage = "verified";
          recordSnapshotTransfer(item);
          emit();
        }

        // 2d. Verified! Now remove from source (never before verification passed).
        if (item.stage === "verified") {
          await removeBotForConversion(ws, item.botId);
          item.stage = "cleaned";
          emit();
        }

        // 2e. Now enable moved routines on target (source bot is gone, so routines run in one place only!).
        if (item.stage === "cleaned") {
          await effectivePeers.call(item.targetHostId, "migrate.activate", { transferId: item.transferId }, pin);
          item.stage = "done";
          item.error = null;
          emit();
        }
      } catch (error) {
        // If we haven't deleted the bot on source yet, restore its routine enabled state so source stays untouched!
        if (item.stage !== "cleaned" && item.stage !== "done" && item.priorRoutines) {
          restoreSourceRoutines(ws, item.priorRoutines);
          item.priorRoutines = null;
        }
        const offlineError =
          error?.code === "TEAMWORK_OFFLINE"
            ? `${item.targetHostName || "Destination host"} went offline while moving ${item.botName}. Unmoved items remain untouched on this computer.`
            : String(error?.message || `Could not move ${item.botName}.`);
        item.stage = item.stage === "cleaned" ? "cleaned" : "failed";
        item.error = offlineError;
        job.status = error?.code === "TEAMWORK_OFFLINE" ? "paused" : "failed";
        job.error = offlineError;
        emit();
        return { job: summarizeJob(job), nodeHost: ws.nodeHost.view() };
      }
    }
  }

  // Step 3: Enable Node host role, share selected project folders, keep phone link enabled (preserving pairings!).
  ws.nodeHost.setup({ name: job.nodeName });
  for (const projectId of job.sharedProjects ?? []) {
    try {
      ws.nodeHost.shareProject(projectId, true);
    } catch {}
  }
  if (link && !link.store?.data?.locked) {
    if (link.store.data.name !== job.nodeName && typeof link.setName === "function") {
      link.setName(job.nodeName);
    }
    if (typeof link.status === "function" && !link.status().enabled && typeof link.setEnabled === "function") {
      await link.setEnabled(true).catch(() => {});
    }
    announce?.();
  }

  job.status = "completed";
  job.error = null;
  emit();

  return {
    job: summarizeJob(job),
    nodeHost: ws.nodeHost.view(),
  };
}
