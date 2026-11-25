// Node host: lets a computer advertise its shared bots and read-only project folder listing
// to the owner's other Botkins hosts without creating local bots or falling back to first-run setup.
// Grants live on this node, keyed by (source host, source bot, operation, resource), and are
// separate from cross-host conversation grants.
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const CAPABILITIES_VERSION = 1;
export const LIST_FILES_OPERATION = "project.list_files";
export const LIST_FILES_VERSION = 1;
export const MAX_LISTING_ENTRIES = 500;
export const MAX_LISTING_BYTES = 64 * 1024;

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

export class NodeHost {
  live = new Map();
  constructor(ws, data = {}) {
    this.ws = ws;
    this.enabled = data?.enabled === true;
    this.name = safeText(data?.name, 80);
    this.paused = data?.paused === true;
    this.sharedProjects = Array.isArray(data?.sharedProjects)
      ? [...new Set(data.sharedProjects.filter((id) => typeof id === "string" && id.trim()))]
      : [];
    this.lastCompleted = summarizeLastCompleted(data?.lastCompleted);
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
    // A job that was working when the host shut down must never silently run twice on restart.
    for (const row of this.records) {
      if (row.status === "working") {
        row.status = "failed";
        row.error = "The node host closed during this request.";
      }
    }
  }

  persisted() {
    if (
      !this.enabled &&
      !this.name &&
      !this.paused &&
      !this.sharedProjects.length &&
      !this.lastCompleted &&
      !this.grants.length &&
      !this.records.length
    )
      return {};
    return {
      nodeHost: {
        enabled: this.enabled,
        name: this.name,
        paused: this.paused,
        sharedProjects: this.sharedProjects,
        lastCompleted: this.lastCompleted,
        grants: this.grants,
        records: this.records,
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
    return {
      enabled: this.enabled,
      role: this.enabled ? "node" : "standard",
      name: this.name,
      paused: this.paused,
      online: this.enabled && !this.paused,
      capabilitiesVersion: CAPABILITIES_VERSION,
      sharedProjects: shared,
      availableProjects,
      grants: this.activeGrants().map(summarizeGrant),
      lastCompleted: this.lastCompleted,
    };
  }

  /** Versioned capability document advertised to other same-owner hosts over Link/teamwork-peers. */
  capabilities() {
    const bots = this.ws.hostDispatch.roster().map(({ id, name, role }) => ({ id, name, role }));
    const projects = this.enabled
      ? this.sharedProjectRecords().map(({ id, name }) => ({ id, name }))
      : [];
    return {
      version: CAPABILITIES_VERSION,
      role: this.enabled ? "node" : "standard",
      name: this.enabled && this.name ? this.name : undefined,
      online: this.enabled ? !this.paused : true,
      paused: this.enabled ? this.paused : false,
      bots,
      operations: this.enabled && projects.length
        ? [{ id: LIST_FILES_OPERATION, version: LIST_FILES_VERSION, readOnly: true }]
        : [],
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

  setPaused(paused) {
    this.paused = paused === true;
    if (this.paused) {
      for (const row of this.records) {
        if (row.status === "pending") this.cancel(row);
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
      // Cancel pending requests targeting the unshared project.
      for (const row of this.records) {
        if (row.resourceId === projectId && row.status === "pending") this.cancel(row);
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

  /** Disconnect this node host: cancel active jobs and disable node hosting. */
  disconnect() {
    for (const row of this.records) {
      if (active(row)) this.cancel(row);
    }
    this.enabled = false;
    this.paused = false;
    this.ws.save();
    return this.view();
  }

  close() {
    for (const row of this.records) {
      if (active(row)) this.cancel(row);
    }
  }

  cancel(row) {
    const task = this.live.get(row);
    row.status = "cancelled";
    if (task) {
      task.stopped = true;
      task.sourceReady?.resolve();
      this.ws.interactions.cancel("node-job-" + row.id);
    }
    this.ws.save();
  }

  recordCompletion(row) {
    if (!row.operation || !row.resourceId) return;
    this.lastCompleted = {
      id: row.id,
      operation: row.operation,
      resourceId: row.resourceId,
      resourceName: row.resourceName || row.resourceId,
      sourceBotId: row.sourceBotId || "",
      sourceBotName: row.sourceBotName || "Bot",
      sourceHostName: row.sourceHostName || "Other computer",
      status: row.status,
      finishedAt: Date.now(),
    };
  }

  async receive(peer, operation, payload = {}) {
    if (this.ws.closing) throw new Error("The destination is closing.");
    const identity = [peer.profileId, peer.serverId, peer.serverKey, peer.targetId, peer.targetKey];
    if (!identity.every((value) => typeof value === "string" && value.length))
      throw new Error("Missing host identity.");

    if (operation === "capabilities") return this.capabilities();

    if (!["job.submit", "job.status", "job.cancel"].includes(operation) || typeof payload?.id !== "string" || !UUID.test(payload.id))
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
      const { sourceBotId, sourceBotName, operation: jobOp, resourceId, path: relPath = "", createdAt } = payload;
      if (
        ![sourceBotId, sourceBotName, jobOp, resourceId].every(validName) ||
        typeof relPath !== "string" ||
        relPath.length > 1024 ||
        !Number.isSafeInteger(createdAt)
      )
        throw new Error("Invalid node job payload.");
      const fingerprint = digest([sourceBotId, sourceBotName, jobOp, resourceId, relPath, createdAt]);
      if (row && row.fingerprint !== fingerprint)
        throw new Error("This request ID already identifies a different job.");
      if (!row) {
        if (!this.enabled) throw new Error("Node host mode is not enabled on this computer.");
        if (this.paused) throw new Error("This node host is paused.");
        if (jobOp !== LIST_FILES_OPERATION) throw new Error("This node host does not support that operation.");
        const now = Date.now();
        if (createdAt < now - WEEK || createdAt > now + 300_000)
          throw new Error("Job timestamp is outside the retry window.");
        const project = this.sharedProjectRecords().find((item) => item.id === resourceId);
        if (!project) throw new Error("That project folder is not shared by this node host.");
        // Validate the path syntax early so obviously invalid boundary escapes fail immediately.
        const normalizedPath = normalizeRelativePath(relPath);
        // Key grants separately from conversation grants: (source host, source bot, operation, resource).
        const scope = digest(["node-job", ...identity, sourceBotId, jobOp, project.id]);
        row = {
          id: payload.id,
          host,
          scope,
          fingerprint,
          operation: jobOp,
          resourceId: project.id,
          resourceName: project.name,
          path: normalizedPath,
          sourceBotId,
          sourceBotName,
          sourceHostName: peer.name,
          createdAt,
          status: "pending",
        };
        this.records = this.records.filter((item) => active(item) || item.createdAt >= now - WEEK);
        this.records.push(row);
        this.ws.save();
      }
    }

    if (!row) throw new Error("Unknown node job request.");
    if (operation === "job.cancel" && active(row)) this.cancel(row);
    if (operation === "job.status" || operation === "job.submit") this.live.get(row)?.sourceReady?.resolve();
    if (row.status === "pending" && !this.live.has(row)) {
      const task = {};
      this.live.set(row, task);
      void this.process(row, task, peer).catch((error) => console.error("Could not finish node job:", error.message));
    }
    return jobResult(row);
  }

  async process(row, task, peer) {
    try {
      const targetProject = () => {
        if (!this.enabled) throw new Error("Node host mode is not enabled on this computer.");
        if (this.paused) throw new Error("This node host is paused.");
        const project = this.sharedProjectRecords().find((item) => item.id === row.resourceId);
        if (!project || !project.folder) throw new Error("That project folder is no longer shared by this node host.");
        return project;
      };
      const project = targetProject();
      const hasGrant = () => this.grants.some((grant) => grant.scope === row.scope && (grant.until === null || grant.until > Date.now()));
      const nodeLabel = this.name || peer.targetName || "this node";
      const folderDetail = row.path ? `${project.name} (${project.folder}${sep}${row.path})` : `${project.name} (${project.folder})`;
      let action;
      let until;

      if (!hasGrant()) {
        const syntheticChat = { id: "node-job-" + row.id };
        ({ action } = await this.ws.interactions.request(syntheticChat, task, {
          kind: "permission",
          dispatch: true,
          nodeJob: true,
          title: `${row.sourceBotName} on ${peer.name} wants to list files in ${project.name} on ${nodeLabel}`,
          detail: `Operation: list files (${row.operation})\nFolder: ${folderDetail}`,
          sourceBotName: row.sourceBotName,
          targetBotName: nodeLabel,
          sourceHostName: peer.name,
          targetHostName: nodeLabel,
          operation: row.operation,
          resourceId: project.id,
          resourceName: project.name,
          label: "Allow for today and Always allow apply only to list files in this shared folder for this source bot on these two computers.",
        }));
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
      const freshProject = targetProject();
      if (!action && (task.grantsCleared || !hasGrant()))
        throw new Error("The node host grant expired or was revoked.");

      row.status = "working";
      this.ws.save();

      await peer.verify();
      if (task.stopped || this.ws.closing) return;
      const verifiedProject = targetProject();
      if (!action && (task.grantsCleared || !hasGrant()))
        throw new Error("The node host grant expired or was revoked.");

      if (!task.grantsCleared && (action === "remember" || (action === "today" && until > Date.now()))) {
        this.grants = this.grants.filter((grant) => grant.until === null || grant.until > Date.now());
        const existing = this.grants.find((grant) => grant.scope === row.scope);
        if (!existing) {
          this.grants.push({
            id: randomUUID(),
            scope: row.scope,
            sourceHostName: peer.name,
            sourceBotId: row.sourceBotId,
            sourceBotName: row.sourceBotName,
            operation: row.operation,
            resourceId: verifiedProject.id,
            resourceName: verifiedProject.name,
            until: until ?? null,
            createdAt: Date.now(),
          });
        } else if (action === "remember") {
          existing.until = null;
          existing.resourceName = verifiedProject.name;
          existing.sourceBotName = row.sourceBotName;
          existing.sourceHostName = peer.name;
        } else if (existing.until !== null) {
          existing.until = Math.max(existing.until, until);
        }
      }

      const listing = listProjectFiles(verifiedProject.folder, row.path);
      if (task.stopped || this.ws.closing) return;
      row.result = {
        projectId: verifiedProject.id,
        projectName: verifiedProject.name,
        ...listing,
      };
      row.status = "completed";
      this.recordCompletion(row);
    } catch (error) {
      if (!task.stopped) {
        row.status = "failed";
        row.error = String(error?.message || "The node host could not complete this request.").slice(0, 360);
        this.recordCompletion(row);
      }
    } finally {
      if (active(row)) row.status = "cancelled";
      this.live.delete(row);
      this.ws.save();
    }
  }
}
