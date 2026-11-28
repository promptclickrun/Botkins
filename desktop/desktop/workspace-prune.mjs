// Workspace run pruning, storage statistics, and auto-prune settings (desktop/workspace-prune.mjs).
//
// Keeps workspace.json fast to save by trimming large per-step payloads (or deleting old runs)
// outside a retention window while preserving protected/active runs and writing a gzip archive
// before any mutation.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const PRUNE_MODES = ["trim", "delete"];
export const DEFAULT_KEEP_DAYS = 30;
export const DEFAULT_KEEP_RUNS = 200;
export const MIN_KEEP_DAYS = 1;
export const MAX_KEEP_DAYS = 3650;
export const MIN_KEEP_RUNS = 0;
export const MAX_KEEP_RUNS = 100_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The default `settings.workspacePrune` preference: auto-prune is off by default. */
export const defaultWorkspacePrune = Object.freeze({
  auto: false,
  keepDays: DEFAULT_KEEP_DAYS,
  mode: "trim",
});

/**
 * Validates and completes a `workspacePrune` preference object (merging a partial patch with `current`).
 */
export function workspacePruneField(value, current = defaultWorkspacePrune) {
  const base = {
    auto: typeof current?.auto === "boolean" ? current.auto : defaultWorkspacePrune.auto,
    keepDays: Number.isInteger(current?.keepDays) && current.keepDays >= MIN_KEEP_DAYS && current.keepDays <= MAX_KEEP_DAYS
      ? current.keepDays
      : defaultWorkspacePrune.keepDays,
    mode: PRUNE_MODES.includes(current?.mode) ? current.mode : defaultWorkspacePrune.mode,
  };
  if (value === undefined || value === null) return base;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace prune setting");
  const allowed = new Set(["auto", "keepDays", "mode"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error("Unknown workspace prune setting: " + key);
  }
  const next = { ...base };
  if (value.auto !== undefined) {
    if (typeof value.auto !== "boolean") throw new Error("Choose on or off for automatic workspace pruning.");
    next.auto = value.auto;
  }
  if (value.keepDays !== undefined) {
    if (!Number.isInteger(value.keepDays) || value.keepDays < MIN_KEEP_DAYS || value.keepDays > MAX_KEEP_DAYS) {
      throw new Error(`Keep days must be a whole number from ${MIN_KEEP_DAYS} to ${MAX_KEEP_DAYS}.`);
    }
    next.keepDays = value.keepDays;
  }
  if (value.mode !== undefined) {
    if (!PRUNE_MODES.includes(value.mode)) throw new Error("Choose trim or delete for workspace prune mode.");
    next.mode = value.mode;
  }
  return next;
}

/** Validates arguments to `pruneWorkspace({ keepDays, keepRuns, mode, dryRun })`. */
export function parsePruneOptions(options = {}, defaults = defaultWorkspacePrune) {
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    throw new Error("Invalid prune options.");
  }
  const keepDays = options.keepDays === undefined ? (defaults.keepDays ?? DEFAULT_KEEP_DAYS) : options.keepDays;
  if (!Number.isInteger(keepDays) || keepDays < MIN_KEEP_DAYS || keepDays > MAX_KEEP_DAYS) {
    throw new Error(`keepDays must be a whole number from ${MIN_KEEP_DAYS} to ${MAX_KEEP_DAYS}.`);
  }
  const keepRuns = options.keepRuns === undefined ? DEFAULT_KEEP_RUNS : options.keepRuns;
  if (!Number.isInteger(keepRuns) || keepRuns < MIN_KEEP_RUNS || keepRuns > MAX_KEEP_RUNS) {
    throw new Error(`keepRuns must be a whole number from ${MIN_KEEP_RUNS} to ${MAX_KEEP_RUNS}.`);
  }
  const mode = options.mode === undefined ? (defaults.mode ?? "trim") : options.mode;
  if (!PRUNE_MODES.includes(mode)) {
    throw new Error("mode must be 'trim' or 'delete'.");
  }
  const dryRun = options.dryRun === undefined ? false : options.dryRun;
  if (typeof dryRun !== "boolean") {
    throw new Error("dryRun must be true or false.");
  }
  return { keepDays, keepRuns, mode, dryRun };
}

/**
 * Strips heavy per-step payloads (`input`, `output`, `progress`, etc.) from a single step while
 * preserving its identity, name, source, label, status, timestamps, agent/bot links and flags
 * so chat timelines continue to render cleanly.
 */
export function trimStep(step) {
  if (!step || typeof step !== "object") return step;
  const kept = {};
  for (const key of ["id", "name", "source", "label", "status", "started", "finished", "agentId", "botId", "background"]) {
    if (step[key] !== undefined) kept[key] = step[key];
  }
  return kept;
}

/** Returns true if a step carries any payload that `trimStep` would remove. */
function stepHasHeavyPayload(step) {
  if (!step || typeof step !== "object") return false;
  for (const key of Object.keys(step)) {
    if (key === "id" || key === "name" || key === "source" || key === "label" || key === "status" || key === "started" || key === "finished" || key === "agentId" || key === "botId" || key === "background") continue;
    if (step[key] !== undefined) return true;
  }
  return false;
}

/**
 * Produces a trimmed copy of a run record and an object describing what was removed, or null if
 * the run has nothing left to trim.
 * Keeps id, chatId, status, times, todos, usage, summary, step names/kinds, etc.; drops
 * `steps[].input`, `steps[].output`, `steps[].progress`, `teamwork[].steps[].*` payloads,
 * `teamwork[].reply`, `agents[].prompt`/`result`, `reasoning`, `recovery`, and other large
 * per-step payloads.
 */
export function trimRun(run) {
  if (!run || typeof run !== "object") return null;
  let changed = false;
  const removed = { id: run.id, chatId: run.chatId, time: run.time };
  const next = { ...run };

  if (Array.isArray(run.steps) && run.steps.some(stepHasHeavyPayload)) {
    const removedSteps = [];
    next.steps = run.steps.map((step) => {
      if (!stepHasHeavyPayload(step)) return step;
      changed = true;
      const trimmed = trimStep(step);
      const dropped = { id: step.id, name: step.name };
      for (const [k, v] of Object.entries(step)) {
        if (!Object.hasOwn(trimmed, k) && v !== undefined) dropped[k] = v;
      }
      removedSteps.push(dropped);
      return trimmed;
    });
    if (removedSteps.length) removed.steps = removedSteps;
  }

  if (Array.isArray(run.teamwork) && run.teamwork.length) {
    let twChanged = false;
    const removedTeamwork = [];
    const nextTeamwork = run.teamwork.map((ask) => {
      if (!ask || typeof ask !== "object") return ask;
      let askChanged = false;
      const nextAsk = { ...ask };
      const droppedAsk = { id: ask.id };
      if (Array.isArray(ask.steps) && ask.steps.some(stepHasHeavyPayload)) {
        const droppedSteps = [];
        nextAsk.steps = ask.steps.map((step) => {
          if (!stepHasHeavyPayload(step)) return step;
          askChanged = true;
          const trimmed = trimStep(step);
          const dropped = { id: step.id, name: step.name };
          for (const [k, v] of Object.entries(step)) {
            if (!Object.hasOwn(trimmed, k) && v !== undefined) dropped[k] = v;
          }
          droppedSteps.push(dropped);
          return trimmed;
        });
        if (droppedSteps.length) droppedAsk.steps = droppedSteps;
      }
      if (ask.reply !== undefined) {
        askChanged = true;
        droppedAsk.reply = ask.reply;
        delete nextAsk.reply;
      }
      if (askChanged) {
        twChanged = true;
        removedTeamwork.push(droppedAsk);
        return nextAsk;
      }
      return ask;
    });
    if (twChanged) {
      changed = true;
      next.teamwork = nextTeamwork;
      removed.teamwork = removedTeamwork;
    }
  }

  if (Array.isArray(run.agents) && run.agents.some((a) => a && (a.prompt !== undefined || a.result !== undefined))) {
    const removedAgents = [];
    next.agents = run.agents.map((agent) => {
      if (!agent || (agent.prompt === undefined && agent.result === undefined)) return agent;
      changed = true;
      const nextAgent = { ...agent };
      const dropped = { id: agent.id };
      if (agent.prompt !== undefined) {
        dropped.prompt = agent.prompt;
        delete nextAgent.prompt;
      }
      if (agent.result !== undefined) {
        dropped.result = agent.result;
        delete nextAgent.result;
      }
      removedAgents.push(dropped);
      return nextAgent;
    });
    if (removedAgents.length) removed.agents = removedAgents;
  }

  if (Array.isArray(run.reasoning) && run.reasoning.length) {
    changed = true;
    removed.reasoning = run.reasoning;
    delete next.reasoning;
  }

  if (run.recovery !== undefined) {
    changed = true;
    removed.recovery = run.recovery;
    delete next.recovery;
  }

  if (!changed) return null;
  return { trimmed: next, removed };
}

/** Timestamp for a run record: `finished` when present, otherwise `time` (or 0). */
function runTimestamp(run) {
  if (typeof run?.finished === "number" && Number.isFinite(run.finished)) return run.finished;
  if (typeof run?.time === "number" && Number.isFinite(run.time)) return run.time;
  return 0;
}

/**
 * Collects the set of run IDs and chat IDs that must never be pruned:
 * - runs with status "Working" or "Queued" (or belonging to an active/queued chat)
 * - the newest run of every chat
 * - runs referenced by any pending approval / interaction / detached question
 * - runs referenced by any active/non-done task or workflow run
 * - runs referenced by a panel's `lastCheck.runId`
 */
export function protectedRunIds(ws) {
  const state = ws.state ?? {};
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const protectedIds = new Set();
  const activeChatIds = new Set();

  if (ws.active instanceof Map) {
    for (const [chatId, task] of ws.active) {
      activeChatIds.add(chatId);
      if (task?.run?.id) protectedIds.add(task.run.id);
    }
  }
  if (ws.queues instanceof Map) {
    for (const [chatId, list] of ws.queues) {
      if (Array.isArray(list) && list.length > 0) activeChatIds.add(chatId);
    }
  }
  if (ws.hostDispatch?.live instanceof Map) {
    for (const [row, task] of ws.hostDispatch.live) {
      if (row?.chatId) activeChatIds.add(row.chatId);
      if (task?.run?.id) protectedIds.add(task.run.id);
    }
  }

  // Pending approvals / interactions / detached questions.
  const requests = typeof ws.interactions?.snapshot === "function" ? ws.interactions.snapshot() : [];
  for (const view of requests) {
    if (view?.chatId) activeChatIds.add(view.chatId);
    if (view?.runId) protectedIds.add(view.runId);
  }
  if (ws.interactions?.entries instanceof Map) {
    for (const entry of ws.interactions.entries.values()) {
      if (entry?.chat?.id) activeChatIds.add(entry.chat.id);
      if (entry?.task?.run?.id) protectedIds.add(entry.task.run.id);
      if (entry?.view?.runId) protectedIds.add(entry.view.runId);
    }
  }

  // Tasks referencing a runId or an active/in-progress task's chatId.
  for (const task of state.tasks ?? []) {
    if (!task) continue;
    if (task.runId) protectedIds.add(task.runId);
    if (task.chatId && task.status !== "done" && task.status !== "archived") {
      activeChatIds.add(task.chatId);
    }
  }

  // Workflow runs: protect any run referenced by a workflow run or step, and active workflow chats.
  const wfRuns = Array.isArray(state.workflowRuns) ? state.workflowRuns : (typeof ws.workflows?.listRuns === "function" ? ws.workflows.listRuns(null, 500) : []);
  for (const wfRun of wfRuns) {
    if (!wfRun) continue;
    const wfActive = wfRun.status === "running" || wfRun.status === "waiting_approval";
    if (wfRun.runId) protectedIds.add(wfRun.runId);
    for (const step of Object.values(wfRun.steps ?? {})) {
      if (!step) continue;
      if (step.runId) protectedIds.add(step.runId);
      if (step.outputs?.runId) protectedIds.add(String(step.outputs.runId));
      if (step.chatId && wfActive) activeChatIds.add(step.chatId);
    }
  }

  // Panels' latest check run.
  for (const panel of state.panels ?? []) {
    if (panel?.lastCheck?.runId) protectedIds.add(panel.lastCheck.runId);
  }

  // Newest run of each chat, plus any Working/Queued run or run in an active chat.
  const newestByChat = new Map();
  for (const run of runs) {
    if (!run?.id) continue;
    if (run.status === "Working" || run.status === "Queued" || activeChatIds.has(run.chatId)) {
      protectedIds.add(run.id);
    }
    if (run.chatId) {
      const ts = runTimestamp(run);
      const prev = newestByChat.get(run.chatId);
      if (!prev || ts > prev.ts) newestByChat.set(run.chatId, { id: run.id, ts });
    }
  }
  for (const { id } of newestByChat.values()) protectedIds.add(id);

  return { protectedIds, activeChatIds };
}

/**
 * Computes workspace storage statistics without mutating state.
 */
export function computeWorkspaceStats(ws) {
  const runs = Array.isArray(ws.state?.runs) ? ws.state.runs : [];
  const chats = Array.isArray(ws.state?.chats) ? ws.state.chats : [];
  let bytes = 0;
  if (ws.file) {
    try {
      bytes = statSync(ws.file).size;
    } catch {
      bytes = Buffer.byteLength(JSON.stringify(ws.state ?? {}));
    }
  } else {
    bytes = Buffer.byteLength(JSON.stringify(ws.state ?? {}));
  }
  const runsBytes = Buffer.byteLength(JSON.stringify(runs));
  let oldestRunAt = null;
  let newestRunAt = null;
  let trimmedRuns = 0;
  for (const run of runs) {
    const ts = runTimestamp(run);
    if (ts > 0) {
      if (oldestRunAt === null || ts < oldestRunAt) oldestRunAt = ts;
      if (newestRunAt === null || ts > newestRunAt) newestRunAt = ts;
    }
    if (Array.isArray(run?.steps) && run.steps.length > 0 && !run.steps.some(stepHasHeavyPayload)) {
      trimmedRuns++;
    }
  }
  return {
    bytes,
    runsBytes,
    runCount: runs.length,
    chatCount: chats.length,
    trimmedRuns,
    oldestRunAt,
    newestRunAt,
    archiveDir: ws.dir ? join(ws.dir, "archive") : null,
  };
}

/** Formats a UTC timestamp suitable for an archive filename: YYYYMMDD-HHMMSS-mmm. */
function archiveStamp(now) {
  const d = new Date(now);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "-" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "-" +
    pad(d.getUTCMilliseconds(), 3)
  );
}

/**
 * Runs a prune (or dry-run) against `ws`.
 *
 * Cutoff rule: a run is eligible if it is NOT protected, AND it is older than `keepDays` days,
 * AND it is NOT among the newest `keepRuns` runs overall.
 *
 * When `dryRun` is false and at least one run is affected:
 * 1. Writes a gzip archive at `<dataDir>/archive/workspace-runs-<ts>.json.gz` BEFORE mutating state.
 * 2. Applies the mutation to `ws.state.runs` and performs a single `ws.save()`.
 */
export function runWorkspacePrune(ws, rawOptions = {}, { now = Date.now() } = {}) {
  const { keepDays, keepRuns, mode, dryRun } = parsePruneOptions(rawOptions, ws.state?.settings?.workspacePrune);
  const runs = Array.isArray(ws.state?.runs) ? ws.state.runs : [];
  const cutoff = now - keepDays * DAY_MS;

  const { protectedIds } = protectedRunIds(ws);

  // Determine the newest `keepRuns` runs by timestamp (ties broken by array order, newest first).
  const ranked = runs
    .map((run, index) => ({ id: run?.id, ts: runTimestamp(run), index }))
    .sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : a.index - b.index));
  const newestKeptIds = new Set(ranked.slice(0, keepRuns).map((entry) => entry.id));

  // Measure beforeBytes accurately against the serialized workspace (or file size).
  const beforeJson = JSON.stringify(ws.state);
  let beforeBytes = Buffer.byteLength(beforeJson);
  if (ws.file) {
    try {
      beforeBytes = statSync(ws.file).size;
    } catch {
      // Fall back to serialized byte length.
    }
  }

  const nextRuns = [];
  const archived = [];
  let trimmedCount = 0;
  let deletedCount = 0;

  for (const run of runs) {
    const id = run?.id;
    const ts = runTimestamp(run);
    const eligible =
      Boolean(id) &&
      !protectedIds.has(id) &&
      !newestKeptIds.has(id) &&
      ts < cutoff;

    if (!eligible) {
      nextRuns.push(run);
      continue;
    }

    if (mode === "delete") {
      archived.push(run);
      deletedCount++;
    } else {
      const result = trimRun(run);
      if (result) {
        nextRuns.push(result.trimmed);
        archived.push(result.removed);
        trimmedCount++;
      } else {
        nextRuns.push(run);
      }
    }
  }

  const affected = trimmedCount + deletedCount;
  const stamp = archiveStamp(now);
  const archiveDir = ws.dir ? join(ws.dir, "archive") : null;
  const plannedArchivePath = affected > 0 && archiveDir ? join(archiveDir, `workspace-runs-${stamp}.json.gz`) : null;

  // Estimate afterBytes by comparing serialized runs delta to beforeBytes (keeps file-overhead parity).
  const runsBeforeBytes = Buffer.byteLength(JSON.stringify(runs));
  const runsAfterBytes = Buffer.byteLength(JSON.stringify(nextRuns));
  const deltaBytes = Math.max(0, runsBeforeBytes - runsAfterBytes);
  let afterBytes = Math.max(0, beforeBytes - deltaBytes);

  if (dryRun || affected === 0) {
    return {
      mode,
      keepDays,
      keepRuns,
      dryRun,
      beforeBytes,
      afterBytes,
      savedBytes: Math.max(0, beforeBytes - afterBytes),
      trimmedCount,
      deletedCount,
      affectedCount: affected,
      archivePath: dryRun ? plannedArchivePath : null,
    };
  }

  // Write the gzip archive BEFORE mutating state.
  let archivePath = null;
  if (archiveDir) {
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    archivePath = join(archiveDir, `workspace-runs-${stamp}.json.gz`);
    const payload = JSON.stringify({
      version: 1,
      createdAt: now,
      mode,
      keepDays,
      keepRuns,
      cutoff,
      count: archived.length,
      runs: archived,
    });
    writeFileSync(archivePath, gzipSync(Buffer.from(payload, "utf8")), { mode: 0o600 });
  }

  // Apply in one mutation and one save.
  ws.state.runs = nextRuns;
  ws.save();

  if (ws.file) {
    try {
      afterBytes = statSync(ws.file).size;
    } catch {
      // Keep estimate if file stat is unavailable.
    }
  }

  return {
    mode,
    keepDays,
    keepRuns,
    dryRun: false,
    beforeBytes,
    afterBytes,
    savedBytes: Math.max(0, beforeBytes - afterBytes),
    trimmedCount,
    deletedCount,
    affectedCount: affected,
    archivePath,
  };
}
