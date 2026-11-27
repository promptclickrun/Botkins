// Node host: lets a computer act as a remote-controlled node for the owner's other Botkins hosts,
// offering scoped file operations, policy-gated shell execution, computer control, and notifications.
// Policy and grants live strictly on this node, keyed by (source host, source bot, operation, resource),
// and are separate from cross-host conversation grants.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { listConversionSnapshots, receiveMigration, summarizeJob } from "./node-convert.mjs";
import {
  inspectWriteTarget,
  nodeDelete,
  nodeMkdir,
  nodeMove,
  nodeReadFile,
  nodeSearch,
  nodeStat,
  nodeWriteFile,
  resolveFileScope,
  WHOLE_COMPUTER_RESOURCE,
} from "./node-files.mjs";
import {
  DEFAULT_EXEC_MODE,
  evaluateExecPolicy,
  EXEC_MODES,
  nodeWhich,
  prepareExecRequest,
  runBoundExec,
  verifyExecBinding,
} from "./node-exec.mjs";
import { nodeScreenCapture, nodeScreenInfo, nodeScreenInput } from "./node-screen.mjs";
import { formatVisibleText } from "./computer-use.mjs";
import {
  permissionWaitingDetail,
  runImsgSend,
  startImsgWatcherProcess,
} from "./channels/adapters/imessage.mjs";

export const CAPABILITIES_VERSION = 1;
export const LIST_FILES_OPERATION = "project.list_files";
export const LIST_FILES_VERSION = 1;
export const REMOTE_CONTROL_OPERATIONS = new Set([
  "pause",
  "resume",
  "share",
  "unshare",
  "revoke",
  "rename",
  "disconnect",
]);
export const MAX_LISTING_ENTRIES = 500;
export const MAX_LISTING_BYTES = 64 * 1024;
export const MAX_AUDIT_ENTRIES = 250;
export const NODE_OPERATIONS = Object.freeze([
  "project.list_files",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.move",
  "fs.delete",
  "fs.stat",
  "fs.search",
  "system.run",
  "system.which",
  "screen.info",
  "screen.capture",
  "screen.input",
  "computer.apps",
  "computer.observe",
  "computer.act",
  "node.notify",
  "channel.imessage.watch",
  "channel.imessage.send",
]);

const FILE_OPERATIONS = new Set([
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.move",
  "fs.delete",
  "fs.stat",
  "fs.search",
]);
const SCREEN_OPERATIONS = new Set(["screen.info", "screen.capture", "screen.input"]);
const COMPUTER_OPERATIONS = new Set(["computer.apps", "computer.observe", "computer.act"]);
const SYSTEM_OPERATIONS = new Set(["system.run", "system.which"]);
const IMESSAGE_CHANNEL_OPERATIONS = new Set(["channel.imessage.watch", "channel.imessage.send"]);
const ALL_OPERATIONS = new Set(NODE_OPERATIONS);
const SYSTEM_RESOURCE = "@system";
const SCREEN_RESOURCE = "@screen";
const COMPUTER_RESOURCE = "@computer-use";
const NOTIFY_RESOURCE = "@notify";
const IMESSAGE_RESOURCE = "@imessage";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (values) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
const active = (row) => row.status === "pending" || row.status === "working";
const safeText = (value, max = 80) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max)
    : "";
const validName = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value);

function isInsideRoot(rootReal, targetReal) {
  const rel = relative(rootReal, targetReal);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeRelativePath(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw new Error("Subfolder path must be text.");
  if (raw.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw))
    throw new Error("Subfolder path contains disallowed characters.");
  if (isAbsolute(raw) || raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:/.test(raw))
    throw new Error("Subfolder path must stay inside the shared folder.");
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (part === "..") throw new Error("Subfolder path cannot move outside the shared folder.");
  }
  const clean = parts.filter((part) => part !== ".");
  return clean.join("/");
}

/**
 * Lists one directory inside a shared project folder, enforcing the folder boundary with
 * canonical realpath checks (no `..`, no symlink escape) and capping entries and response size.
 */
export function listProjectFiles(rootDir, relPath = "", { maxEntries = MAX_LISTING_ENTRIES, maxBytes = MAX_LISTING_BYTES } = {}) {
  if (typeof rootDir !== "string" || !rootDir.trim())
    throw new Error("This shared project has no folder.");
  let rootReal;
  try {
    rootReal = realpathSync(rootDir);
  } catch {
    throw new Error("The shared project folder is unavailable.");
  }
  if (!statSync(rootReal).isDirectory())
    throw new Error("The shared project folder is unavailable.");

  const cleanRel = normalizeRelativePath(relPath);
  const candidate = cleanRel ? resolve(rootReal, cleanRel) : rootReal;
  if (!isInsideRoot(rootReal, candidate))
    throw new Error("Subfolder path cannot move outside the shared folder.");

  let targetReal;
  try {
    targetReal = realpathSync(candidate);
  } catch {
    throw new Error("That subfolder does not exist inside the shared project.");
  }
  if (!isInsideRoot(rootReal, targetReal))
    throw new Error("Subfolder path cannot follow a link outside the shared folder.");
  if (!statSync(targetReal).isDirectory())
    throw new Error("That path is not a folder.");

  const dirents = readdirSync(targetReal, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  const entries = [];
  let bytes = 2; // []
  let truncated = false;
  let visibleTotal = 0;

  for (const dirent of dirents) {
    const full = join(targetReal, dirent.name);
    let type = "other";
    let size;
    if (dirent.isSymbolicLink()) {
      let resolvedEntry;
      try {
        resolvedEntry = realpathSync(full);
      } catch {
        continue;
      }
      if (!isInsideRoot(rootReal, resolvedEntry)) continue;
      try {
        const st = statSync(resolvedEntry);
        type = st.isDirectory() ? "directory" : st.isFile() ? "file" : "other";
        if (type === "file") size = st.size;
      } catch {
        continue;
      }
    } else if (dirent.isDirectory()) {
      type = "directory";
    } else if (dirent.isFile()) {
      type = "file";
      try {
        size = statSync(full).size;
      } catch {
        size = undefined;
      }
    }
    visibleTotal++;
    if (truncated) continue;
    if (entries.length >= maxEntries) {
      truncated = true;
      continue;
    }
    const item = { name: dirent.name, type, ...(size !== undefined && { size }) };
    const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + itemBytes > maxBytes) {
      truncated = true;
      continue;
    }
    bytes += itemBytes;
    entries.push(item);
  }

  return {
    path: cleanRel,
    entries,
    truncated,
    totalEntries: visibleTotal,
  };
}

function jobResult(row) {
  return {
    status: row.status,
    ...(row.status === "pending" && row.ask && { ask: row.ask }),
    ...(row.status === "working" && row.output && { output: row.output }),
    ...(row.result && { result: row.result }),
    ...(row.error && { error: row.error }),
  };
}

function summarizeGrant(grant) {
  return {
    id: grant.id,
    sourceHostName: grant.sourceHostName,
    sourceBotId: grant.sourceBotId,
    sourceBotName: grant.sourceBotName,
    operation: grant.operation,
    resourceId: grant.resourceId,
    resourceName: grant.resourceName,
    scope: grant.until === null ? "always" : "today",
    until: grant.until,
    createdAt: grant.createdAt,
  };
}

function summarizeLastCompleted(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string") return null;
  return {
    id: item.id,
    operation: safeText(item.operation, 80),
    resourceId: safeText(item.resourceId, 160),
    resourceName: safeText(item.resourceName, 160),
    sourceBotId: safeText(item.sourceBotId, 160),
    sourceBotName: safeText(item.sourceBotName, 160),
    sourceHostName: safeText(item.sourceHostName, 160),
    status: safeText(item.status, 32),
    finishedAt: Number.isFinite(item.finishedAt) ? item.finishedAt : 0,
  };
}

function cleanAllowlistRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const pattern = safeText(rule.pattern, 240);
  if (!pattern) return null;
  const botId = safeText(rule.botId, 160) || "*";
  return {
    id: typeof rule.id === "string" && rule.id ? rule.id : randomUUID(),
    botId,
    pattern,
    createdAt: Number.isFinite(rule.createdAt) ? rule.createdAt : Date.now(),
  };
}

function cleanAuditEntry(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string") return null;
  return {
    id: entry.id,
    time: Number.isFinite(entry.time) ? entry.time : Date.now(),
    operation: safeText(entry.operation, 80),
    sourceHostName: safeText(entry.sourceHostName, 160),
    sourceBotId: safeText(entry.sourceBotId, 160),
    sourceBotName: safeText(entry.sourceBotName, 160),
    resourceId: safeText(entry.resourceId, 160),
    resourceName: safeText(entry.resourceName, 160),
    argsSummary: safeText(entry.argsSummary, 240),
    status: safeText(entry.status, 32),
    ...(entry.exitCode !== undefined && entry.exitCode !== null && { exitCode: entry.exitCode }),
    ...(entry.error && { error: safeText(entry.error, 240) }),
    ...(Number.isFinite(entry.durationMs) && { durationMs: entry.durationMs }),
  };
}

function summarizeArgs(operation, params = {}, extra = {}) {
  if (operation === LIST_FILES_OPERATION) return params.path ? `path=${params.path}` : "root";
  if (operation === "fs.read" || operation === "fs.stat" || operation === "fs.mkdir" || operation === "fs.delete") {
    return `${params.path || ""}${params.recursive ? " (recursive)" : ""}`.trim();
  }
  if (operation === "fs.write") {
    const bytes = typeof params.content === "string" ? Buffer.byteLength(params.content, params.encoding === "base64" ? "base64" : "utf8") : 0;
    return `${params.path || ""} (${bytes}B${params.overwrite ? ", overwrite" : ""})`;
  }
  if (operation === "fs.move") {
    return `${params.from || ""} -> ${params.to || ""}${params.overwrite ? " (overwrite)" : ""}`;
  }
  if (operation === "fs.search") {
    return [params.path && `in ${params.path}`, params.pattern && `pattern=${params.pattern}`, params.query && `query=${params.query}`].filter(Boolean).join(" ");
  }
  if (operation === "system.run") {
    const cmd = extra.binding?.argv?.join(" ") || (Array.isArray(params.argv) ? params.argv.join(" ") : String(params.command || ""));
    return cmd.slice(0, 220);
  }
  if (operation === "system.which") {
    return Array.isArray(params.names) ? params.names.join(", ") : "";
  }
  if (operation === "screen.info") return "displays";
  if (operation === "screen.capture") return `display=${params.display || "primary"}`;
  if (operation === "screen.input") return `display=${params.display || "primary"} events=${Array.isArray(params.events) ? params.events.length : 0}`;
  if (operation === "computer.apps") return params.include_background ? "include_background=true" : "apps";
  if (operation === "computer.observe") return `pid=${params.pid ?? "?"}${params.window_id ? ` window=${params.window_id}` : ""}`;
  if (operation === "computer.act") {
    const target = params.element_token ? `token=${params.element_token}` : params.x != null && params.y != null ? `(${params.x},${params.y})` : "";
    const base = `${params.action || "act"} pid=${params.pid ?? "?"}${target ? ` ${target}` : ""} (${params.delivery_mode || "background"})`;
    if ((params.action === "type_text" || params.action === "set_value") && typeof params.text === "string") {
      return `${base} text="${formatVisibleText(params.text, 200)}"`;
    }
    if (params.action === "hotkey" && Array.isArray(params.keys) && params.keys.length) {
      return `${base} keys=${params.keys.join("+")}`;
    }
    if (params.action === "press_key" && typeof params.key === "string") {
      return `${base} key=${params.key}`;
    }
    return base;
  }
  if (operation === "node.notify") return safeText(params.title || "", 120);
  if (operation === "channel.imessage.watch") return safeText(`iMessage watch (${params.action || "poll"})`, 120);
  if (operation === "channel.imessage.send") return safeText(`iMessage send chat ${params.chatId || ""}`, 120);
  return "";
}

function describeApproval(row, nodeLabel) {
  const op = row.grantOperation || row.operation;
  const who = `${row.sourceBotName} on ${row.sourceHostName}`;
  if (row.operation === LIST_FILES_OPERATION) {
    const folderDetail = row.path ? `${row.resourceName} (${row.resourceFolder || ""}${sep}${row.path})` : `${row.resourceName} (${row.resourceFolder || ""})`;
    return {
      title: `${who} wants to list files in ${row.resourceName} on ${nodeLabel}`,
      detail: `Operation: list files (${row.operation})\nFolder: ${folderDetail}`,
      label: "Allow for today and Always allow apply only to list files in this shared folder for this source bot on these two computers.",
    };
  }
  if (FILE_OPERATIONS.has(row.operation)) {
    const verb =
      op === "fs.write.overwrite"
        ? "overwrite a file"
        : op === "fs.move.overwrite"
          ? "overwrite on move"
          : {
              "fs.read": "read a file",
              "fs.write": "write a file",
              "fs.mkdir": "create a folder",
              "fs.move": "move/rename",
              "fs.delete": "delete",
              "fs.stat": "inspect",
              "fs.search": "search files",
            }[row.operation] || row.operation;
    const summary = summarizeArgs(row.operation, row.params);
    return {
      title: `${who} wants to ${verb} in ${row.resourceName} on ${nodeLabel}`,
      preview: summary || undefined,
      detail: `Operation: ${op}\nScope: ${row.resourceName} (${row.resourceId})\nTarget: ${summary}`,
      label: `Allow for today and Always allow apply only to ${op} in ${row.resourceName} for this source bot on these two computers.`,
    };
  }
  if (row.operation === "system.run") {
    const b = row.execBinding;
    const lines = [
      `Operation: system.run`,
      `Executable: ${b.resolvedExecutable}`,
      `Argv: ${JSON.stringify(b.argv)}`,
      `Working dir: ${b.cwd}`,
      `Env overrides: ${b.env.length ? b.env.map(([k]) => k).join(", ") : "(none)"}`,
      ...(b.pinnedScript ? [`Pinned script: ${b.pinnedScript.path} (sha256:${b.pinnedScript.hash.slice(0, 12)})`] : []),
      `Binding: ${b.bindingHash.slice(0, 16)}`,
    ];
    return {
      title: `${who} wants to run a command on ${nodeLabel}`,
      preview: b.argv.join(" "),
      detail: lines.join("\n"),
      label: "Approval binds this exact command, executable, working directory, and environment. Allow for today / Always allow covers only this exact bound command.",
    };
  }
  if (row.operation === "system.which") {
    const names = Array.isArray(row.params?.names) ? row.params.names.join(", ") : "";
    return {
      title: `${who} wants to locate commands on ${nodeLabel}`,
      preview: names,
      detail: `Operation: system.which\nCommands: ${names}`,
      label: "Allow for today and Always allow apply only to system.which for this source bot on these two computers.",
    };
  }
  if (SCREEN_OPERATIONS.has(row.operation)) {
    const verb =
      row.operation === "screen.info"
        ? "inspect displays"
        : row.operation === "screen.capture"
          ? "take a screenshot"
          : "send mouse/keyboard input";
    const summary = summarizeArgs(row.operation, row.params);
    return {
      title: `${who} wants to ${verb} on ${nodeLabel}`,
      preview: summary || undefined,
      detail: `Operation: ${row.operation}\nDetails: ${summary}`,
      label: `Allow for today and Always allow apply only to ${row.operation} for this source bot on these two computers.`,
    };
  }
  if (COMPUTER_OPERATIONS.has(row.operation)) {
    const verb =
      row.operation === "computer.apps"
        ? "list running apps"
        : row.operation === "computer.observe"
          ? "inspect an app window"
          : "perform a native app action";
    const summary = summarizeArgs(row.operation, row.params);
    return {
      title: `${who} wants to ${verb} on ${nodeLabel}`,
      preview: summary || undefined,
      detail: `Operation: ${row.operation}\nDetails: ${summary}`,
      label: `Allow for today and Always allow apply only to ${row.operation} for this source bot on these two computers.`,
    };
  }
  if (row.operation === "node.notify") {
    return {
      title: `${who} wants to show a notification on ${nodeLabel}`,
      preview: row.params?.title || undefined,
      detail: `Operation: node.notify\nTitle: ${row.params?.title || ""}${row.params?.body ? `\nBody: ${row.params.body}` : ""}`,
      label: "Allow for today and Always allow apply only to notifications for this source bot on these two computers.",
    };
  }
  if (row.operation === "channel.imessage.watch") {
    return {
      title: `${who} wants to watch incoming iMessages on ${nodeLabel}`,
      preview: `Channel connection ${row.params?.connectionId || ""}`.trim(),
      detail: `Operation: channel.imessage.watch\nAction: ${row.params?.action || "start"}`,
      label: "Allow for today and Always allow apply only to watching iMessage channel events for this source bot on these two computers.",
    };
  }
  if (row.operation === "channel.imessage.send") {
    return {
      title: `${who} wants to send an iMessage reply on ${nodeLabel}`,
      preview: `Chat ${row.params?.chatId || ""}`.trim(),
      detail: `Operation: channel.imessage.send\nChat: ${row.params?.chatId || ""}`,
      label: "Allow for today and Always allow apply only to sending iMessage channel replies for this source bot on these two computers.",
    };
  }
  return {
    title: `${who} wants to run ${row.operation} on ${nodeLabel}`,
    detail: `Operation: ${row.operation}`,
    label: "Allow for today and Always allow apply only to this operation and resource.",
  };
}

export class NodeHost {
  live = new Map();
  constructor(ws, data = {}) {
    this.ws = ws;
    this.enabled = data?.enabled === true;
    this.name = safeText(data?.name, 80);
    this.paused = data?.paused === true;
    this.wholeComputer = data?.wholeComputer === true;
    this.execPolicy = {
      mode: EXEC_MODES.includes(data?.execPolicy?.mode) ? data.execPolicy.mode : DEFAULT_EXEC_MODE,
      allowlist: Array.isArray(data?.execPolicy?.allowlist)
        ? data.execPolicy.allowlist.map(cleanAllowlistRule).filter(Boolean)
        : [],
    };
    this.sharedProjects = Array.isArray(data?.sharedProjects)
      ? [...new Set(data.sharedProjects.filter((id) => typeof id === "string" && id.trim()))]
      : [];
    this.lastCompleted = summarizeLastCompleted(data?.lastCompleted);
    this.auditLog = Array.isArray(data?.auditLog)
      ? data.auditLog.map(cleanAuditEntry).filter(Boolean).slice(-MAX_AUDIT_ENTRIES)
      : [];
    this.grants = Array.isArray(data?.grants)
      ? data.grants
          .filter((g) => g && typeof g.scope === "string" && (g.until === null || Number.isFinite(g.until)))
          .map((g) => ({
            id: typeof g.id === "string" && g.id ? g.id : randomUUID(),
            scope: g.scope,
            sourceHostName: safeText(g.sourceHostName, 160) || "Other computer",
            sourceBotId: safeText(g.sourceBotId, 160),
            sourceBotName: safeText(g.sourceBotName, 160) || "Bot",
            operation: safeText(g.operation, 80) || LIST_FILES_OPERATION,
            resourceId: safeText(g.resourceId, 160),
            resourceName: safeText(g.resourceName, 160) || "Project",
            until: g.until === null ? null : g.until,
            createdAt: Number.isFinite(g.createdAt) ? g.createdAt : Date.now(),
          }))
      : [];
    this.records = Array.isArray(data?.records)
      ? data.records.filter((row) => row && typeof row.id === "string")
      : [];
    this.conversionJobs = Array.isArray(data?.conversionJobs)
      ? data.conversionJobs.filter((job) => job && typeof job.id === "string").slice(-20)
      : [];
    this.imports =
      data?.imports && typeof data.imports === "object" && !Array.isArray(data.imports)
        ? { ...data.imports }
        : {};
    this.imessageWatchers = new Map();
    // A job that was working when the host shut down must never silently run twice on restart.
    for (const row of this.records) {
      if (row.status === "working") {
        row.status = "failed";
        row.error = "The node host closed during this request.";
      }
      // An approval handed to the asking computer belonged to a wait that is gone; the job asks again.
      delete row.ask;
    }
    for (const job of this.conversionJobs) {
      if (job.status === "running") {
        job.status = "paused";
        job.error = job.error || "Conversion stopped because Botkins closed. Resume to continue cleanly.";
      }
    }
  }

  /** Runtime adapters (screen capture, input injector, desktop notifier); injectable in tests. */
  adapters() {
    return this.ws.nodeAdapters ?? {};
  }

  persisted() {
    const importKeys = Object.keys(this.imports);
    if (importKeys.length > 100) {
      const sorted = importKeys.sort((a, b) => (this.imports[a]?.at ?? 0) - (this.imports[b]?.at ?? 0));
      for (const key of sorted.slice(0, importKeys.length - 100)) delete this.imports[key];
    }
    const jobs = this.conversionJobs.slice(-20);
    const hasCustomPolicy = this.execPolicy.mode !== DEFAULT_EXEC_MODE || this.execPolicy.allowlist.length > 0;
    if (
      !this.enabled &&
      !this.name &&
      !this.paused &&
      !this.wholeComputer &&
      !hasCustomPolicy &&
      !this.sharedProjects.length &&
      !this.lastCompleted &&
      !this.auditLog.length &&
      !this.grants.length &&
      !this.records.length &&
      !jobs.length &&
      !Object.keys(this.imports).length
    )
      return {};
    return {
      nodeHost: {
        enabled: this.enabled,
        name: this.name,
        paused: this.paused,
        wholeComputer: this.wholeComputer,
        execPolicy: this.execPolicy,
        sharedProjects: this.sharedProjects,
        lastCompleted: this.lastCompleted,
        auditLog: this.auditLog.slice(-MAX_AUDIT_ENTRIES),
        grants: this.grants,
        records: this.records,
        ...(jobs.length && { conversionJobs: jobs }),
        ...(Object.keys(this.imports).length && { imports: this.imports }),
      },
    };
  }

  activeGrants() {
    const now = Date.now();
    return this.grants.filter((grant) => grant.until === null || grant.until > now);
  }

  sharedProjectRecords() {
    const byId = new Map(this.ws.state.projects.map((project) => [project.id, project]));
    return this.sharedProjects
      .map((id) => byId.get(id))
      .filter((project) => project && typeof project.folder === "string" && project.folder.trim());
  }

  sharedProjectsForFiles() {
    return this.sharedProjectRecords().map((project) => ({
      id: project.id,
      name: project.name,
      path: project.folder,
    }));
  }

  /** Public summary included in workspace snapshots, CLI status and Settings. */
  view() {
    const shared = this.sharedProjectRecords().map((project) => ({
      id: project.id,
      name: project.name,
      folder: project.folder,
    }));
    const sharedSet = new Set(shared.map((project) => project.id));
    const availableProjects = this.ws.state.projects
      .filter((project) => typeof project.folder === "string" && project.folder.trim())
      .map((project) => ({
        id: project.id,
        name: project.name,
        folder: project.folder,
        shared: sharedSet.has(project.id),
      }));
    const snapshots = listConversionSnapshots(this.ws);
    const activeSnapshot = snapshots.find((item) => item.status === "active") ?? null;
    const lastJob = this.conversionJobs.at(-1) ?? null;
    const pendingApprovals = this.ws.interactions
      .snapshot()
      .filter((entry) => entry.nodeJob === true)
      .map((entry) => ({
        id: entry.id,
        chatId: entry.chatId,
        title: entry.title,
        operation: entry.operation,
        resourceId: entry.resourceId,
        resourceName: entry.resourceName,
        sourceBotName: entry.sourceBotName,
        sourceHostName: entry.sourceHostName,
        time: entry.time,
      }));
    return {
      enabled: this.enabled,
      role: this.enabled ? "node" : "standard",
      name: this.name,
      paused: this.paused,
      online: this.enabled && !this.paused,
      capabilitiesVersion: CAPABILITIES_VERSION,
      remoteControlSupported: true,
      hasLocalData: this.ws.state.bots.length > 0 || this.ws.state.chats.length > 0,
      wholeComputer: this.wholeComputer,
      execPolicy: {
        mode: this.execPolicy.mode,
        allowlist: this.execPolicy.allowlist.map((rule) => ({ ...rule })),
      },
      sharedProjects: shared,
      availableProjects,
      grants: this.activeGrants().map(summarizeGrant),
      pendingApprovals,
      auditLog: this.auditLog.slice(-50).reverse(),
      lastCompleted: this.lastCompleted,
      conversion: {
        activeJob: lastJob ? summarizeJob(lastJob) : null,
        snapshot: activeSnapshot
          ? {
              id: activeSnapshot.id,
              path: activeSnapshot.path,
              createdAt: activeSnapshot.createdAt,
              botCount: activeSnapshot.botCount,
              chatCount: activeSnapshot.chatCount,
              nodeName: activeSnapshot.nodeName,
            }
          : null,
      },
    };
  }

  computerUseAdapter() {
    if (this.adapters().computerUse) return this.adapters().computerUse;
    if (this.ws.computerUse?.enabled?.()) return this.ws.computerUse;
    return null;
  }

  /** Versioned capability document advertised to other same-owner hosts over Link/teamwork-peers. */
  capabilities() {
    const bots = this.ws.hostDispatch.roster().map(({ id, name, role }) => ({ id, name, role }));
    const projects = this.enabled
      ? this.sharedProjectRecords().map(({ id, name }) => ({ id, name }))
      : [];
    const operations = [];
    if (this.enabled) {
      if (projects.length > 0) {
        operations.push({ id: LIST_FILES_OPERATION, version: LIST_FILES_VERSION, readOnly: true });
      }
      if (projects.length > 0 || this.wholeComputer) {
        operations.push(
          { id: "fs.read", version: 1, readOnly: true },
          { id: "fs.stat", version: 1, readOnly: true },
          { id: "fs.search", version: 1, readOnly: true },
          { id: "fs.write", version: 1, readOnly: false },
          { id: "fs.mkdir", version: 1, readOnly: false },
          { id: "fs.move", version: 1, readOnly: false },
          { id: "fs.delete", version: 1, readOnly: false },
        );
      }
      if (this.execPolicy.mode !== "deny") {
        operations.push(
          { id: "system.run", version: 1, readOnly: false },
          { id: "system.which", version: 1, readOnly: true },
        );
      }
      if (this.adapters().screen) {
        operations.push(
          { id: "screen.info", version: 1, readOnly: true },
          { id: "screen.capture", version: 1, readOnly: true },
          { id: "screen.input", version: 1, readOnly: false },
        );
      }
      if (this.computerUseAdapter()) {
        operations.push(
          { id: "computer.apps", version: 1, readOnly: true },
          { id: "computer.observe", version: 1, readOnly: true },
          { id: "computer.act", version: 1, readOnly: false },
        );
      }
      operations.push({ id: "node.notify", version: 1, readOnly: false });
      if (this.execPolicy.mode !== "deny" && (process.platform === "darwin" || this.adapters().imessage)) {
        operations.push(
          { id: "channel.imessage.watch", version: 1, readOnly: true },
          { id: "channel.imessage.send", version: 1, readOnly: false },
        );
      }
    }
    return {
      version: CAPABILITIES_VERSION,
      role: this.enabled ? "node" : "standard",
      name: this.enabled && this.name ? this.name : undefined,
      online: this.enabled ? !this.paused : true,
      paused: this.enabled ? this.paused : false,
      remoteControl: this.enabled,
      wholeComputer: this.enabled ? this.wholeComputer : false,
      execPolicy: this.enabled ? { mode: this.execPolicy.mode } : undefined,
      bots,
      operations,
      projects,
    };
  }

  /** Enable node host role with a persisted name and finish first-run setup without creating a bot. */
  setup({ name } = {}) {
    const clean = safeText(name, 80);
    if (!clean) throw new Error("Give this node host a name.");
    this.enabled = true;
    this.name = clean;
    this.paused = false;
    this.ws.state.settings.onboarded = true;
    this.ws.save();
    return this.view();
  }

  rename(name) {
    const clean = safeText(name, 80);
    if (!clean) throw new Error("Give this node host a name.");
    this.name = clean;
    this.ws.save();
    return this.view();
  }

  /** Toggle whole-computer file scope on this node. Turning it off cancels pending/working @computer jobs. */
  setWholeComputer(enabled) {
    this.wholeComputer = enabled === true;
    if (!this.wholeComputer) {
      for (const row of this.records) {
        if (row.resourceId === WHOLE_COMPUTER_RESOURCE && active(row)) this.cancel(row, "Whole-computer access was turned off.");
      }
    }
    this.ws.save();
    return this.view();
  }

  /** Update this node's exec policy mode (`deny` | `allowlist` | `ask` | `full`). */
  setExecMode(mode) {
    if (!EXEC_MODES.includes(mode)) {
      throw new Error(`Invalid exec policy mode. Choose one of: ${EXEC_MODES.join(", ")}.`);
    }
    this.execPolicy.mode = mode;
    if (mode === "deny") {
      for (const row of this.records) {
        if (row.operation === "system.run" && active(row)) {
          this.cancel(row, "Exec policy was changed to deny.");
        }
      }
    }
    this.ws.save();
    return this.view();
  }

  /** Add an allowlist rule for `system.run` (per node `botId: "*"` or per source bot `botId`). */
  addAllowlistRule({ pattern, botId = "*" } = {}) {
    const cleanPattern = safeText(pattern, 240);
    if (!cleanPattern) throw new Error("Provide a command or executable path pattern.");
    const cleanBot = safeText(botId, 160) || "*";
    const exists = this.execPolicy.allowlist.find(
      (rule) => rule.botId === cleanBot && rule.pattern === cleanPattern,
    );
    if (!exists) {
      this.execPolicy.allowlist.push({
        id: randomUUID(),
        botId: cleanBot,
        pattern: cleanPattern,
        createdAt: Date.now(),
      });
      this.ws.save();
    }
    return this.view();
  }

  /** Remove an allowlist rule by id (or all rules when no id is provided). */
  removeAllowlistRule(ruleId) {
    if (ruleId) {
      const before = this.execPolicy.allowlist.length;
      this.execPolicy.allowlist = this.execPolicy.allowlist.filter((rule) => rule.id !== ruleId);
      if (this.execPolicy.allowlist.length === before) throw new Error("Unknown allowlist rule.");
    } else {
      this.execPolicy.allowlist = [];
    }
    this.ws.save();
    return this.view();
  }

  /** Kill switch: immediately stops all pending and running operations, including active shell processes. */
  setPaused(paused) {
    this.paused = paused === true;
    if (this.paused) {
      for (const row of this.records) {
        if (active(row) && row.kind !== "control") this.cancel(row, "Node host paused.");
      }
    }
    this.ws.save();
    return this.view();
  }

  shareProject(projectId, shared = true) {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Choose a project.");
    const project = this.ws.state.projects.find((item) => item.id === projectId);
    if (shared) {
      if (!project) throw new Error("Unknown project.");
      if (!project.folder) throw new Error("That project has no folder to share.");
      if (!this.sharedProjects.includes(project.id)) this.sharedProjects.push(project.id);
    } else {
      this.sharedProjects = this.sharedProjects.filter((id) => id !== projectId);
      for (const row of this.records) {
        if (row.resourceId === projectId && active(row)) this.cancel(row, "Folder was unshared.");
      }
    }
    this.ws.save();
    return this.view();
  }

  /** Revoke one grant by its ID, or all node job grants when no ID is given. */
  revokeGrant(grantId) {
    const targetScope = grantId ? this.grants.find((g) => g.id === grantId)?.scope : null;
    if (grantId && !targetScope) throw new Error("Unknown node grant.");
    for (const [row, task] of this.live) {
      if ((!targetScope || row.scope === targetScope) && (row.status === "working" || task.sourceReady)) {
        task.grantsCleared = true;
      }
    }
    this.grants = grantId ? this.grants.filter((g) => g.id !== grantId) : [];
    this.ws.save();
    return this.view();
  }

  /** Returns the node's audit log (newest first). */
  getAuditLog(limit = 50) {
    const count = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_AUDIT_ENTRIES) : 50;
    return this.auditLog.slice(-count).reverse();
  }

  /** Disconnect this node host: cancel active jobs (killing running processes) and disable node hosting. */
  disconnect(excludeRow = null) {
    for (const row of this.records) {
      if (row !== excludeRow && active(row)) this.cancel(row, "Node host disconnected.");
    }
    this.stopIMessageWatchers();
    this.enabled = false;
    this.paused = false;
    this.ws.save();
    return this.view();
  }

  close() {
    for (const row of this.records) {
      if (active(row)) this.cancel(row, "Node host closed.");
    }
    this.stopIMessageWatchers();
  }

  stopIMessageWatchers() {
    for (const entry of this.imessageWatchers.values()) {
      try {
        entry.handle?.stop?.();
      } catch {
        // Already stopped.
      }
    }
    this.imessageWatchers.clear();
  }

  cancel(row, reason = "Cancelled.") {
    const task = this.live.get(row);
    const wasActive = active(row);
    row.status = "cancelled";
    if (reason && !row.error) row.error = reason;
    if (task) {
      task.stopped = true;
      if (typeof task.kill === "function") {
        try {
          task.kill(reason);
        } catch {
          // Process already exited.
        }
      }
      task.sourceReady?.resolve();
      task.answer?.resolve({ action: "cancel" });
      delete row.ask;
      this.ws.interactions.cancel("node-job-" + row.id);
    }
    if (wasActive && row.operation) {
      this.recordAudit(row, { status: "cancelled", error: reason });
    }
    this.ws.save();
  }

  recordAudit(row, { status = row.status, exitCode = null, error = row.error, durationMs } = {}) {
    if (!row?.operation || row._audited) return;
    row._audited = true;
    const entry = cleanAuditEntry({
      id: row.id || randomUUID(),
      time: Date.now(),
      operation: row.grantOperation || row.operation,
      sourceHostName: row.sourceHostName || "Other computer",
      sourceBotId: row.sourceBotId || "",
      sourceBotName: row.sourceBotName || "Bot",
      resourceId: row.resourceId || "",
      resourceName: row.resourceName || row.resourceId || "",
      argsSummary: summarizeArgs(row.operation, row.params || { path: row.path }, { binding: row.execBinding }),
      status,
      exitCode,
      error,
      durationMs,
    });
    if (!entry) return;
    this.auditLog.push(entry);
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_ENTRIES);
    }
  }

  recordCompletion(row, extra = {}) {
    if (!row.operation || !row.resourceId) return;
    this.lastCompleted = {
      id: row.id,
      operation: row.grantOperation || row.operation,
      resourceId: row.resourceId,
      resourceName: row.resourceName || row.resourceId,
      sourceBotId: row.sourceBotId || "",
      sourceBotName: row.sourceBotName || "Bot",
      sourceHostName: row.sourceHostName || "Other computer",
      status: row.status,
      finishedAt: Date.now(),
    };
    this.recordAudit(row, { status: row.status, ...extra });
  }

  resolveExecCwd(params = {}) {
    if (typeof params.project === "string" && params.project.trim() && params.project !== WHOLE_COMPUTER_RESOURCE) {
      const project = this.sharedProjectRecords().find((item) => item.id === params.project);
      if (!project) throw new Error("That project folder is not shared by this node host.");
      const root = realpathSync(project.folder);
      if (typeof params.cwd === "string" && params.cwd.trim()) {
        const sub = normalizeRelativePath(params.cwd);
        const candidate = sub ? resolve(root, sub) : root;
        const real = realpathSync(candidate);
        if (!isInsideRoot(root, real)) throw new Error("Working directory cannot escape the shared folder.");
        return real;
      }
      return root;
    }
    const rawCwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : homedir();
    const expanded = rawCwd === "~" ? homedir() : rawCwd.startsWith("~/") ? join(homedir(), rawCwd.slice(2)) : rawCwd;
    if (!existsSync(expanded)) throw new Error("Working directory does not exist on this node.");
    return realpathSync(expanded);
  }

  /** Prepares operation metadata, validates inputs, and computes grant scope on submit. */
  async planOperation(identity, peer, { sourceBotId, sourceBotName, jobOp, resourceId, path, params }) {
    if (!ALL_OPERATIONS.has(jobOp)) {
      throw new Error("This node host does not support that operation.");
    }
    if (jobOp === LIST_FILES_OPERATION) {
      if (!validName(resourceId)) throw new Error("Invalid node job payload.");
      const project = this.sharedProjectRecords().find((item) => item.id === resourceId);
      if (!project) throw new Error("That project folder is not shared by this node host.");
      const normalizedPath = normalizeRelativePath(path ?? params?.path ?? "");
      return {
        grantOperation: LIST_FILES_OPERATION,
        resourceId: project.id,
        resourceName: project.name,
        resourceFolder: project.folder,
        path: normalizedPath,
        params: { path: normalizedPath },
        scope: digest(["node-job", ...identity, sourceBotId, LIST_FILES_OPERATION, project.id]),
      };
    }

    if (FILE_OPERATIONS.has(jobOp)) {
      const fileParams = params && typeof params === "object" ? params : {};
      const scopeObj = resolveFileScope({
        projectId: resourceId || fileParams.project,
        projects: this.sharedProjectsForFiles(),
        wholeComputer: this.wholeComputer,
      });
      let grantOperation = jobOp;
      if (jobOp === "fs.write") {
        const check = inspectWriteTarget(scopeObj, String(fileParams.path ?? ""));
        if (check.isOverwrite) {
          if (fileParams.overwrite !== true) {
            throw new Error("File already exists. Pass overwrite: true to replace it.");
          }
          grantOperation = "fs.write.overwrite";
        }
      } else if (jobOp === "fs.move") {
        // Validate both endpoints immediately so traversal/symlink escapes fail at submit time.
        inspectWriteTarget(scopeObj, String(fileParams.from ?? ""));
        const dest = inspectWriteTarget(scopeObj, String(fileParams.to ?? ""));
        if (dest.isOverwrite) {
          if (fileParams.overwrite !== true) {
            throw new Error("Destination already exists. Pass overwrite: true to replace it.");
          }
          grantOperation = "fs.move.overwrite";
        }
      } else if (jobOp === "fs.read" || jobOp === "fs.delete" || jobOp === "fs.stat" || jobOp === "fs.mkdir" || jobOp === "fs.search") {
        // Validate path boundaries early.
        const allowMissing = jobOp === "fs.mkdir" || jobOp === "fs.stat";
        const targetPath = jobOp === "fs.search"
          ? String(fileParams.path ?? (scopeObj.wholeComputer ? homedir() : ""))
          : String(fileParams.path ?? "");
        inspectWriteTarget(scopeObj, targetPath);
        if (!allowMissing && jobOp !== "fs.search" && !targetPath.trim() && scopeObj.wholeComputer) {
          throw new Error("Provide an absolute path for whole-computer file access.");
        }
      }
      return {
        grantOperation,
        resourceId: scopeObj.resourceId,
        resourceName: scopeObj.resourceName,
        params: fileParams,
        scope: digest(["node-job", ...identity, sourceBotId, grantOperation, scopeObj.resourceId]),
      };
    }

    if (jobOp === "system.which") {
      const sysParams = params && typeof params === "object" ? params : {};
      if (!Array.isArray(sysParams.names) || sysParams.names.length === 0) {
        throw new Error("Provide at least one command name for system.which.");
      }
      return {
        grantOperation: "system.which",
        resourceId: SYSTEM_RESOURCE,
        resourceName: "System commands",
        params: sysParams,
        scope: digest(["node-job", ...identity, sourceBotId, "system.which", SYSTEM_RESOURCE]),
      };
    }

    if (jobOp === "system.run") {
      const execParams = params && typeof params === "object" ? params : {};
      const prepared = prepareExecRequest(execParams, {
        resolveCwd: (p) => this.resolveExecCwd(p),
      });
      const decision = evaluateExecPolicy(prepared, {
        mode: this.execPolicy.mode,
        allowlist: this.execPolicy.allowlist,
        sourceBotId,
      });
      if (decision.decision === "deny") {
        this.recordAudit(
          {
            id: randomUUID(),
            operation: "system.run",
            sourceHostName: peer.name,
            sourceBotId,
            sourceBotName,
            resourceId: SYSTEM_RESOURCE,
            resourceName: prepared.binding.resolvedExecutable,
            params: execParams,
            execBinding: prepared.binding,
          },
          { status: "denied", error: decision.reason },
        );
        this.ws.save();
        throw new Error(decision.reason);
      }
      return {
        grantOperation: "system.run",
        resourceId: prepared.binding.bindingHash.slice(0, 16),
        resourceName: prepared.binding.argv.join(" ").slice(0, 120),
        params: execParams,
        execBinding: prepared.binding,
        execDecision: decision.decision,
        timeoutMs: prepared.timeoutMs,
        // Grant is bound strictly to this exact command + cwd + env + resolved executable + pinned script!
        scope: digest(["node-job", ...identity, sourceBotId, "system.run", prepared.binding.bindingHash]),
      };
    }

    if (SCREEN_OPERATIONS.has(jobOp)) {
      if (!this.adapters().screen) {
        throw new Error("Screen control is not available on this node.");
      }
      const screenParams = params && typeof params === "object" ? params : {};
      return {
        grantOperation: jobOp,
        resourceId: SCREEN_RESOURCE,
        resourceName: "Screen",
        params: screenParams,
        scope: digest(["node-job", ...identity, sourceBotId, jobOp, SCREEN_RESOURCE]),
      };
    }

    if (COMPUTER_OPERATIONS.has(jobOp)) {
      const cu = this.computerUseAdapter();
      if (!cu) {
        throw new Error("Native computer use is off on this node. Turn it on in Settings › Access.");
      }
      const cuParams = params && typeof params === "object" ? params : {};
      if (jobOp === "computer.act" && typeof cu.preflightAct === "function") {
        await cu.preflightAct(cuParams);
      }
      // Typing and hotkeys are approved one at a time: a remembered computer.act grant never covers them.
      const oneOff = jobOp === "computer.act" && ["type_text", "set_value", "hotkey"].includes(cuParams.action);
      return {
        grantOperation: jobOp,
        resourceId: COMPUTER_RESOURCE,
        resourceName: "Computer use",
        params: cuParams,
        ...(oneOff && { noGrant: true }),
        scope: digest(["node-job", ...identity, sourceBotId, jobOp, COMPUTER_RESOURCE, ...(oneOff ? ["one-off", randomUUID()] : [])]),
      };
    }

    if (jobOp === "node.notify") {
      const notifyParams = params && typeof params === "object" ? params : {};
      if (!validName(notifyParams.title)) throw new Error("Notification title is required.");
      return {
        grantOperation: "node.notify",
        resourceId: NOTIFY_RESOURCE,
        resourceName: "Notifications",
        params: {
          title: safeText(notifyParams.title, 120),
          body: safeText(notifyParams.body ?? "", 400),
        },
        scope: digest(["node-job", ...identity, sourceBotId, "node.notify", NOTIFY_RESOURCE]),
      };
    }

    if (IMESSAGE_CHANNEL_OPERATIONS.has(jobOp)) {
      if (this.execPolicy.mode === "deny") {
        this.recordAudit(
          {
            sourceHostName: peer.hostName || "Other computer",
            sourceBotId,
            sourceBotName,
            operation: jobOp,
            resourceId: IMESSAGE_RESOURCE,
            resourceName: "iMessage channel",
            params: params && typeof params === "object" ? params : {},
          },
          { status: "denied", error: "Node exec policy denies iMessage channel operations." },
        );
        this.ws.save();
        throw new Error("Node exec policy denies iMessage channel operations.");
      }
      if (process.platform !== "darwin" && !this.adapters().imessage) {
        throw new Error("iMessage channel operations are only available on a Mac node host.");
      }
      const p = params && typeof params === "object" ? params : {};
      if (jobOp === "channel.imessage.watch") {
        const action = ["start", "poll", "stop"].includes(p.action) ? p.action : "poll";
        const connectionId = safeText(p.connectionId || "default", 80) || "default";
        const cursor = Number.isFinite(Number(p.cursor)) ? Math.max(0, Math.floor(Number(p.cursor))) : 0;
        return {
          grantOperation: "channel.imessage.watch",
          resourceId: IMESSAGE_RESOURCE,
          resourceName: "iMessage channel",
          params: { action, connectionId, cursor },
          scope: digest(["node-job", ...identity, sourceBotId, "channel.imessage.watch", IMESSAGE_RESOURCE]),
        };
      }
      const chatId = safeText(String(p.chatId ?? ""), 120);
      if (!chatId) throw new Error("iMessage send requires chatId.");
      const text = typeof p.text === "string" ? p.text.slice(0, 4000) : "";
      if (!text.trim()) throw new Error("iMessage send requires text.");
      return {
        grantOperation: "channel.imessage.send",
        resourceId: IMESSAGE_RESOURCE,
        resourceName: "iMessage channel",
        params: {
          connectionId: safeText(p.connectionId || "", 80),
          chatId,
          text,
        },
        scope: digest(["node-job", ...identity, sourceBotId, "channel.imessage.send", IMESSAGE_RESOURCE]),
      };
    }

    throw new Error("This node host does not support that operation.");
  }

  async receive(peer, operation, payload = {}) {
    if (this.ws.closing) throw new Error("The destination is closing.");
    const identity = [peer.profileId, peer.serverId, peer.serverKey, peer.targetId, peer.targetKey];
    if (!identity.every((value) => typeof value === "string" && value.length))
      throw new Error("Missing host identity.");

    if (operation === "capabilities") return this.capabilities();
    if (operation === "control.status") return this.view();
    if (operation.startsWith("migrate.")) return receiveMigration(this.ws, peer, operation, payload);
    if (["control.submit", "control.poll", "control.cancel"].includes(operation)) {
      return this.receiveControl(peer, identity, operation, payload);
    }

    if (!["job.submit", "job.status", "job.cancel", "job.answer"].includes(operation) || typeof payload?.id !== "string" || !UUID.test(payload.id))
      throw new Error("Invalid node job request.");

    const host = digest(identity);
    let row = this.records.find((item) => item.id === payload.id && item.host === host);

    if (!row && operation === "job.cancel") {
      row = { id: payload.id, host, createdAt: Date.now() + 300_000, status: "cancelled" };
      this.records = this.records.filter((item) => active(item) || item.createdAt >= Date.now() - WEEK);
      this.records.push(row);
      this.ws.save();
    }

    if (operation === "job.submit") {
      if (row?.status === "cancelled" && !row.fingerprint) return jobResult(row);
      const { sourceBotId, sourceBotName, operation: jobOp, resourceId = "", path: relPath = "", params, createdAt, relayApproval } = payload;
      if (
        ![sourceBotId, sourceBotName, jobOp].every(validName) ||
        typeof resourceId !== "string" ||
        typeof relPath !== "string" ||
        relPath.length > 1024 ||
        (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) ||
        !Number.isSafeInteger(createdAt)
      )
        throw new Error("Invalid node job payload.");
      const fingerprint = digest([sourceBotId, sourceBotName, jobOp, resourceId, relPath, params ?? null, createdAt]);
      if (row && row.fingerprint !== fingerprint)
        throw new Error("This request ID already identifies a different job.");
      if (!row) {
        if (!this.enabled) throw new Error("Node host mode is not enabled on this computer.");
        if (this.paused) throw new Error("This node host is paused.");
        const now = Date.now();
        if (createdAt < now - WEEK || createdAt > now + 300_000)
          throw new Error("Job timestamp is outside the retry window.");
        const planned = await this.planOperation(identity, peer, {
          sourceBotId,
          sourceBotName,
          jobOp,
          resourceId,
          path: relPath,
          params,
        });
        row = {
          id: payload.id,
          host,
          scope: planned.scope,
          fingerprint,
          operation: jobOp,
          grantOperation: planned.grantOperation,
          resourceId: planned.resourceId,
          resourceName: planned.resourceName,
          ...(planned.resourceFolder && { resourceFolder: planned.resourceFolder }),
          ...(planned.path !== undefined && { path: planned.path }),
          params: planned.params,
          ...(planned.execBinding && { execBinding: planned.execBinding }),
          ...(planned.execDecision && { execDecision: planned.execDecision }),
          ...(planned.timeoutMs && { timeoutMs: planned.timeoutMs }),
          ...(planned.noGrant && { noGrant: true }),
          sourceBotId,
          sourceBotName,
          sourceHostName: peer.name,
          // The asking computer shows the approval in the chat the owner is in (it says so by sending
          // relayApproval). An older one doesn't, and the approval shows on this node as before.
          ...(relayApproval === true && { askSource: true }),
          createdAt,
          status: "pending",
        };
        this.records = this.records.filter((item) => active(item) || item.createdAt >= now - WEEK);
        this.records.push(row);
        this.ws.save();
      }
    }

    if (!row) throw new Error("Unknown node job request.");
    if (operation === "job.answer") this.answerSource(row, payload);
    if (operation === "job.cancel" && active(row)) this.cancel(row, "Cancelled by caller.");
    if (operation === "job.status" || operation === "job.submit") this.live.get(row)?.sourceReady?.resolve();
    if (row.status === "pending" && !this.live.has(row)) {
      const task = {};
      this.live.set(row, task);
      void this.process(row, task, peer).catch((error) => console.error("Could not finish node job:", error.message));
    }
    return jobResult(row);
  }

  /**
   * Hands an approval to the computer whose bot asked, so the owner answers it where they are (the
   * chat, their phone) and not on this node. The node still decides: the answer comes back through
   * job.answer for this exact ask, and grants, policy and the exec binding are kept and checked here.
   */
  askSource(row, task, view) {
    task.answer = Promise.withResolvers();
    row.ask = {
      id: randomUUID(),
      title: view.title,
      ...(view.preview && { preview: view.preview }),
      detail: view.detail,
      label: view.label,
      operation: view.operation,
      resourceName: view.resourceName,
      targetHostName: view.targetHostName,
    };
    this.ws.save();
    return task.answer.promise;
  }

  /** The owner's answer to an approval asked on the source computer (job.answer). */
  answerSource(row, payload) {
    const task = this.live.get(row);
    if (!row.ask || !task?.answer || payload?.askId !== row.ask.id) throw new Error("This approval has already closed.");
    if (!["approve", "today", "remember", "deny"].includes(payload.action)) throw new Error("Unknown approval response");
    delete row.ask;
    this.ws.save();
    task.answer.resolve({ action: payload.action });
  }

  async process(row, task, peer) {
    const startedAt = Date.now();
    try {
      const assertAvailable = () => {
        if (!this.enabled) throw new Error("Node host mode is not enabled on this computer.");
        if (this.paused) throw new Error("This node host is paused.");
      };
      assertAvailable();

      const hasGrant = () =>
        this.grants.some((grant) => grant.scope === row.scope && (grant.until === null || grant.until > Date.now()));
      const nodeLabel = this.name || peer.targetName || "this node";

      // Policy bypasses prompt only for `system.run` in `full` or matching `allowlist`.
      let policyAutoAllow = false;
      if (row.operation === "system.run") {
        const prepared = prepareExecRequest(row.params, { resolveCwd: (p) => this.resolveExecCwd(p) });
        const evalResult = evaluateExecPolicy(prepared, {
          mode: this.execPolicy.mode,
          allowlist: this.execPolicy.allowlist,
          sourceBotId: row.sourceBotId,
        });
        if (evalResult.decision === "deny") {
          row.status = "denied";
          row.error = evalResult.reason;
          this.recordCompletion(row, { error: evalResult.reason });
          return;
        }
        policyAutoAllow = evalResult.decision === "allow";
      }

      let action;
      let until;

      if (!policyAutoAllow && !hasGrant()) {
        const copy = describeApproval(row, nodeLabel);
        const syntheticChat = { id: "node-job-" + row.id };
        const view = {
          kind: "permission",
          dispatch: true,
          nodeJob: true,
          title: copy.title,
          ...(copy.preview && { preview: copy.preview }),
          detail: copy.detail,
          sourceBotName: row.sourceBotName,
          targetBotName: nodeLabel,
          sourceHostName: peer.name,
          targetHostName: nodeLabel,
          operation: row.grantOperation || row.operation,
          resourceId: row.resourceId,
          resourceName: row.resourceName,
          label: copy.label,
        };
        ({ action } = row.askSource ? await this.askSource(row, task, view) : await this.ws.interactions.request(syntheticChat, task, view));
        if (task.stopped) return;
        if (action === "deny" || action === "cancel") {
          row.status = action === "deny" ? "denied" : "cancelled";
          this.recordCompletion(row);
          return;
        }
        if (action === "today") {
          const midnight = new Date();
          midnight.setHours(24, 0, 0, 0);
          until = midnight.getTime();
        }
        // Wait for the source host to poll again so an orphaned approval never runs a cancelled job.
        task.sourceReady = Promise.withResolvers();
        this.ws.notify();
        await task.sourceReady.promise;
      }

      if (task.stopped || this.ws.closing) return;
      assertAvailable();
      if (!policyAutoAllow && !action && (task.grantsCleared || !hasGrant())) {
        throw new Error("The node host grant expired or was revoked.");
      }

      row.status = "working";
      this.ws.save();

      await peer.verify();
      if (task.stopped || this.ws.closing) return;
      assertAvailable();
      if (!policyAutoAllow && !action && (task.grantsCleared || !hasGrant())) {
        throw new Error("The node host grant expired or was revoked.");
      }

      // Persist grant if owner chose Allow for today / Always allow.
      if (!policyAutoAllow && !row.noGrant && !task.grantsCleared && (action === "remember" || (action === "today" && until > Date.now()))) {
        this.grants = this.grants.filter((grant) => grant.until === null || grant.until > Date.now());
        const existing = this.grants.find((grant) => grant.scope === row.scope);
        if (!existing) {
          this.grants.push({
            id: randomUUID(),
            scope: row.scope,
            sourceHostName: peer.name,
            sourceBotId: row.sourceBotId,
            sourceBotName: row.sourceBotName,
            operation: row.grantOperation || row.operation,
            resourceId: row.resourceId,
            resourceName: row.resourceName,
            until: until ?? null,
            createdAt: Date.now(),
          });
        } else if (action === "remember") {
          existing.until = null;
          existing.resourceName = row.resourceName;
          existing.sourceBotName = row.sourceBotName;
          existing.sourceHostName = peer.name;
        } else if (existing.until !== null) {
          existing.until = Math.max(existing.until, until);
        }
      }

      // Execute the operation.
      let exitCode = null;
      if (row.operation === LIST_FILES_OPERATION) {
        const project = this.sharedProjectRecords().find((item) => item.id === row.resourceId);
        if (!project || !project.folder) throw new Error("That project folder is no longer shared by this node host.");
        const listing = listProjectFiles(project.folder, row.path);
        if (task.stopped || this.ws.closing) return;
        row.result = {
          projectId: project.id,
          projectName: project.name,
          ...listing,
        };
      } else if (FILE_OPERATIONS.has(row.operation)) {
        const scopeObj = resolveFileScope({
          projectId: row.resourceId,
          projects: this.sharedProjectsForFiles(),
          wholeComputer: this.wholeComputer,
        });
        // Re-check overwrite protection right before executing write/move.
        if (row.operation === "fs.write") {
          const check = inspectWriteTarget(scopeObj, String(row.params?.path ?? ""));
          if (check.isOverwrite && row.grantOperation !== "fs.write.overwrite") {
            throw new Error("File appeared after approval; overwrite requires a separate overwrite grant.");
          }
          row.result = { resourceId: scopeObj.resourceId, resourceName: scopeObj.resourceName, ...nodeWriteFile(scopeObj, row.params) };
        } else if (row.operation === "fs.move") {
          const check = inspectWriteTarget(scopeObj, String(row.params?.to ?? ""));
          if (check.isOverwrite && row.grantOperation !== "fs.move.overwrite") {
            throw new Error("Destination appeared after approval; overwrite requires a separate overwrite grant.");
          }
          row.result = { resourceId: scopeObj.resourceId, resourceName: scopeObj.resourceName, ...nodeMove(scopeObj, row.params) };
        } else if (row.operation === "fs.read") {
          row.result = { resourceId: scopeObj.resourceId, resourceName: scopeObj.resourceName, ...nodeReadFile(scopeObj, row.params) };
        } else if (row.operation === "fs.mkdir") {
          row.result = { resourceId: scopeObj.resourceId, resourceName: scopeObj.resourceName, ...nodeMkdir(scopeObj, row.params) };
        } else if (row.operation === "fs.delete") {
          row.result = { resourceId: scopeObj.resourceId, resourceName: scopeObj.resourceName, ...nodeDelete(scopeObj, row.params) };
        } else if (row.operation === "fs.stat") {
          row.result = { resourceId: scopeObj.resourceId, resourceName: scopeObj.resourceName, ...nodeStat(scopeObj, row.params) };
        } else if (row.operation === "fs.search") {
          row.result = { resourceId: scopeObj.resourceId, resourceName: scopeObj.resourceName, ...nodeSearch(scopeObj, row.params) };
        }
      } else if (row.operation === "system.which") {
        row.result = nodeWhich(row.params?.names);
      } else if (row.operation === "system.run") {
        // Re-validate policy AND exact approval binding right before spawning!
        const fresh = prepareExecRequest(row.params, { resolveCwd: (p) => this.resolveExecCwd(p) });
        const recheck = evaluateExecPolicy(fresh, {
          mode: this.execPolicy.mode,
          allowlist: this.execPolicy.allowlist,
          sourceBotId: row.sourceBotId,
        });
        if (recheck.decision === "deny") throw new Error(recheck.reason);
        verifyExecBinding(row.execBinding, row.params, { resolveCwd: (p) => this.resolveExecCwd(p) });

        const handle = runBoundExec(row.execBinding, {
          timeoutMs: row.timeoutMs,
          payload: row.params,
          resolveCwd: (p) => this.resolveExecCwd(p),
          onOutput: (chunk) => {
            row.output = chunk;
          },
        });
        task.kill = handle.kill;
        const execResult = await handle.promise;
        if (task.stopped || this.ws.closing) return;
        exitCode = execResult.exitCode;
        delete row.output;
        row.result = execResult;
      } else if (row.operation === "screen.info") {
        row.result = await nodeScreenInfo(this.adapters().screen);
      } else if (row.operation === "screen.capture") {
        row.result = await nodeScreenCapture(this.adapters().screen, row.params);
      } else if (row.operation === "screen.input") {
        row.result = await nodeScreenInput(this.adapters(), row.params);
      } else if (COMPUTER_OPERATIONS.has(row.operation)) {
        const cu = this.computerUseAdapter();
        if (!cu) throw new Error("Native computer use is off on this node.");
        const actor = { botId: row.sourceBotId, botName: row.sourceBotName };
        if (row.operation === "computer.apps") {
          row.result = await cu.apps(row.params ?? {}, actor);
        } else if (row.operation === "computer.observe") {
          row.result = await cu.observe(row.params ?? {}, actor);
        } else if (row.operation === "computer.act") {
          row.result = await cu.act(row.params ?? {}, actor);
        }
      } else if (row.operation === "node.notify") {
        const notify = this.adapters().notify;
        if (typeof notify === "function") {
          await notify({ title: row.params.title, body: row.params.body });
        }
        row.result = { delivered: true, title: row.params.title };
      } else if (row.operation === "channel.imessage.watch") {
        if (this.execPolicy.mode === "deny") {
          throw new Error("Node exec policy denies iMessage channel operations.");
        }
        const imsgAdapter = this.adapters().imessage;
        const nodeName = this.name || this.ws.hostName?.() || "node";
        const { action, connectionId, cursor } = row.params;
        if (action === "stop") {
          const existing = this.imessageWatchers.get(connectionId);
          if (existing) {
            existing.handle?.stop?.();
            this.imessageWatchers.delete(connectionId);
          }
          row.result = { running: false, nodeName, events: [], cursor };
        } else {
          let entry = this.imessageWatchers.get(connectionId);
          if (!entry) {
            entry = { seq: 0, buffer: [], waitingForPermission: false, detail: "", handle: null };
            const pushEvent = (event) => {
              entry.seq += 1;
              entry.buffer.push({ seq: entry.seq, event });
              if (entry.buffer.length > 500) entry.buffer.splice(0, entry.buffer.length - 500);
            };
            if (typeof imsgAdapter?.startWatch === "function") {
              entry.handle = await imsgAdapter.startWatch({
                connectionId,
                onEvent: pushEvent,
                onPermissionWaiting: (detail) => {
                  entry.waitingForPermission = true;
                  entry.detail = detail || permissionWaitingDetail(nodeName);
                },
              });
            } else {
              entry.handle = startImsgWatcherProcess({
                findImsg: imsgAdapter?.findImsg,
                spawnProcess: imsgAdapter?.spawnProcess,
                nodeLabel: nodeName,
                onEvent: pushEvent,
                onPermissionWaiting: (detail) => {
                  entry.waitingForPermission = true;
                  entry.detail = detail || permissionWaitingDetail(nodeName);
                },
                onExit: () => {
                  this.imessageWatchers.delete(connectionId);
                },
              });
            }
            this.imessageWatchers.set(connectionId, entry);
          }
          const events = entry.buffer.filter((item) => item.seq > cursor).map((item) => item.event);
          row.result = {
            running: true,
            nodeName,
            cursor: entry.seq,
            events,
            ...(entry.waitingForPermission && {
              waitingForPermission: true,
              detail: entry.detail || permissionWaitingDetail(nodeName),
            }),
          };
        }
      } else if (row.operation === "channel.imessage.send") {
        if (this.execPolicy.mode === "deny") {
          throw new Error("Node exec policy denies iMessage channel operations.");
        }
        const imsgAdapter = this.adapters().imessage;
        const nodeName = this.name || this.ws.hostName?.() || "node";
        if (typeof imsgAdapter?.send === "function") {
          const sent = await imsgAdapter.send({
            chatId: row.params.chatId,
            text: row.params.text,
            nodeName,
          });
          row.result = {
            nodeName,
            ...(sent && typeof sent === "object" ? sent : { ok: true }),
            ...(sent?.waitingForPermission && !sent?.detail ? { detail: permissionWaitingDetail(nodeName) } : {}),
          };
        } else {
          const sent = await runImsgSend({
            chatId: row.params.chatId,
            text: row.params.text,
            findImsg: imsgAdapter?.findImsg,
            launch: imsgAdapter?.launch,
            timeout: imsgAdapter?.sendTimeoutMs ?? 15000,
            nodeLabel: nodeName,
          });
          row.result = { nodeName, ...sent };
        }
      } else {
        throw new Error("Unsupported node operation.");
      }

      if (task.stopped || this.ws.closing) return;
      row.status = "completed";
      this.recordCompletion(row, { exitCode, durationMs: Date.now() - startedAt });
    } catch (error) {
      if (!task.stopped) {
        row.status = "failed";
        row.error = String(error?.message || "The node host could not complete this request.").slice(0, 360);
        this.recordCompletion(row, { durationMs: Date.now() - startedAt });
      }
    } finally {
      delete row.output;
      if (active(row)) row.status = "cancelled";
      this.live.delete(row);
      this.ws.save();
    }
  }

  /**
   * Owner-only remote node management over same-owner teamwork-peers.
   * Gated to the owner's own hosts (teamwork-peers rejects team members and phones)
   * and uses the same trusted-device approval and grant model as node jobs, with a
   * distinct grant namespace ("node-control") so job grants never escalate to control.
   */
  async receiveControl(peer, identity, operation, payload = {}) {
    if (typeof payload?.id !== "string" || !UUID.test(payload.id)) {
      throw new Error("Invalid remote node control request.");
    }
    const host = digest(identity);
    let row = this.records.find((item) => item.id === payload.id && item.host === host && item.kind === "control");

    if (!row && operation === "control.cancel") {
      row = { id: payload.id, host, kind: "control", createdAt: Date.now() + 300_000, status: "cancelled" };
      this.records = this.records.filter((item) => active(item) || item.createdAt >= Date.now() - WEEK);
      this.records.push(row);
      this.ws.save();
    }

    if (operation === "control.submit") {
      if (row?.status === "cancelled" && !row.fingerprint) return jobResult(row);
      const action = safeText(payload.action, 32);
      const projectId = safeText(payload.projectId, 160);
      const grantId = safeText(payload.grantId, 160);
      const renameTo = safeText(payload.name, 80);
      const createdAt = payload.createdAt;
      if (!REMOTE_CONTROL_OPERATIONS.has(action) || !Number.isSafeInteger(createdAt)) {
        throw new Error("Invalid remote node control payload.");
      }
      if ((action === "share" || action === "unshare") && !projectId) {
        throw new Error("Choose a project to share or unshare.");
      }
      if (action === "rename" && !renameTo) {
        throw new Error("Give the node host a name.");
      }
      const fingerprint = digest(["control", action, projectId, grantId, renameTo, createdAt]);
      if (row && row.fingerprint !== fingerprint) {
        throw new Error("This request ID already identifies a different control action.");
      }
      if (!row) {
        if (!this.enabled) throw new Error("Node host mode is not enabled on this computer.");
        const now = Date.now();
        if (createdAt < now - WEEK || createdAt > now + 300_000) {
          throw new Error("Control request timestamp is outside the retry window.");
        }
        const resourceId = projectId || grantId || action;
        const project = projectId ? this.ws.state.projects.find((item) => item.id === projectId) : null;
        if (action === "share" && (!project || !project.folder)) {
          throw new Error("That project has no folder to share.");
        }
        const resourceName =
          action === "share" || action === "unshare"
            ? project?.name || projectId
            : action === "rename"
              ? renameTo
              : action === "revoke"
                ? grantId || "all grants"
                : this.name || "this node";
        // Distinct namespace: regular node-job grants never escalate to remote node control.
        const scope = digest(["node-control", ...identity, action, resourceId]);
        row = {
          id: payload.id,
          host,
          kind: "control",
          scope,
          fingerprint,
          operation: "node." + action,
          controlAction: action,
          projectId,
          grantId,
          renameTo,
          resourceId,
          resourceName,
          sourceBotId: "owner-host",
          sourceBotName: peer.name,
          sourceHostName: peer.name,
          createdAt,
          status: "pending",
        };
        this.records = this.records.filter((item) => active(item) || item.createdAt >= now - WEEK);
        this.records.push(row);
        this.ws.save();
      }
    }

    if (!row) throw new Error("Unknown remote node control request.");
    if (operation === "control.cancel" && active(row)) this.cancel(row);
    if (operation === "control.poll" || operation === "control.submit") this.live.get(row)?.sourceReady?.resolve();
    if (row.status === "pending" && !this.live.has(row)) {
      const task = {};
      this.live.set(row, task);
      void this.processControl(row, task, peer).catch((error) =>
        console.error("Could not finish remote node control:", error.message),
      );
    }
    return jobResult(row);
  }

  async processControl(row, task, peer) {
    try {
      if (!this.enabled) throw new Error("Node host mode is not enabled on this computer.");
      const hasGrant = () =>
        this.grants.some((grant) => grant.scope === row.scope && (grant.until === null || grant.until > Date.now()));
      const nodeLabel = this.name || peer.targetName || "this node";
      const actionSummary = {
        pause: `pause node host ${nodeLabel}`,
        resume: `resume node host ${nodeLabel}`,
        share: `share project ${row.resourceName} on ${nodeLabel}`,
        unshare: `stop sharing project ${row.resourceName} on ${nodeLabel}`,
        revoke: row.grantId ? `revoke grant ${row.grantId} on ${nodeLabel}` : `revoke all node grants on ${nodeLabel}`,
        rename: `rename node host ${nodeLabel} to ${row.renameTo}`,
        disconnect: `disconnect node host ${nodeLabel}`,
      }[row.controlAction];
      let decision;
      let until;

      if (!hasGrant()) {
        const syntheticChat = { id: "node-job-" + row.id };
        ({ action: decision } = await this.ws.interactions.request(syntheticChat, task, {
          kind: "permission",
          dispatch: true,
          nodeJob: true,
          title: `${peer.name} wants to ${actionSummary}`,
          detail: `Remote node control: ${row.operation}\nFrom your host: ${peer.name}`,
          sourceBotName: peer.name,
          targetBotName: nodeLabel,
          sourceHostName: peer.name,
          targetHostName: nodeLabel,
          operation: row.operation,
          resourceId: row.resourceId,
          resourceName: row.resourceName,
          label: "Allow for today and Always allow apply only to this remote control action from this same-owner computer.",
        }));
        if (task.stopped) return;
        if (decision === "deny" || decision === "cancel") {
          row.status = decision === "deny" ? "denied" : "cancelled";
          this.recordCompletion(row);
          return;
        }
        if (decision === "today") {
          const midnight = new Date();
          midnight.setHours(24, 0, 0, 0);
          until = midnight.getTime();
        }
        task.sourceReady = Promise.withResolvers();
        this.ws.notify();
        await task.sourceReady.promise;
      }

      if (task.stopped || this.ws.closing) return;
      if (!this.enabled) throw new Error("Node host mode is not enabled on this computer.");
      if (!decision && (task.grantsCleared || !hasGrant())) {
        throw new Error("The remote control grant expired or was revoked.");
      }

      row.status = "working";
      this.ws.save();

      await peer.verify();
      if (task.stopped || this.ws.closing) return;
      if (!decision && (task.grantsCleared || !hasGrant())) {
        throw new Error("The remote control grant expired or was revoked.");
      }

      if (!task.grantsCleared && (decision === "remember" || (decision === "today" && until > Date.now()))) {
        this.grants = this.grants.filter((grant) => grant.until === null || grant.until > Date.now());
        const existing = this.grants.find((grant) => grant.scope === row.scope);
        if (!existing) {
          this.grants.push({
            id: randomUUID(),
            scope: row.scope,
            sourceHostName: peer.name,
            sourceBotId: "owner-host",
            sourceBotName: peer.name,
            operation: row.operation,
            resourceId: row.resourceId,
            resourceName: row.resourceName,
            until: until ?? null,
            createdAt: Date.now(),
          });
        } else if (decision === "remember") {
          existing.until = null;
        } else if (existing.until !== null) {
          existing.until = Math.max(existing.until, until);
        }
      }

      let view;
      switch (row.controlAction) {
        case "pause":
          view = this.setPaused(true);
          break;
        case "resume":
          view = this.setPaused(false);
          break;
        case "share":
          view = this.shareProject(row.projectId, true);
          break;
        case "unshare":
          view = this.shareProject(row.projectId, false);
          break;
        case "revoke":
          view = this.revokeGrant(row.grantId || undefined);
          break;
        case "rename":
          view = this.rename(row.renameTo);
          break;
        case "disconnect":
          view = this.disconnect(row);
          break;
        default:
          throw new Error("Unknown remote node control action.");
      }

      if (task.stopped || this.ws.closing) return;
      row.result = { action: row.controlAction, nodeHost: view };
      row.status = "completed";
      this.recordCompletion(row);
    } catch (error) {
      if (!task.stopped) {
        row.status = "failed";
        row.error = String(error?.message || "The node host could not complete this control request.").slice(0, 360);
        this.recordCompletion(row);
      }
    } finally {
      if (active(row)) row.status = "cancelled";
      this.live.delete(row);
      this.ws.save();
    }
  }
}
