// Durable GitHub delivery ledger helpers, persisted cursors, per-item waiting queue,
// same-workflow 1h self-loop guard, cross-workflow 3-per-10m chain cap, and offline gap markers.
//
// Builds directly on #352's flat `state.workflowGithubDeliveries` array so there is a single
// delivery store shared by UI, CLI, replay, waiting queue, and push/poll deduplication.

import { isGithubBotActor, normalizeGithubRepos } from "./workflow-github-events.mjs";

export const GITHUB_DELIVERY_LEDGER_LIMIT = 50;
export const GITHUB_SELF_GUARD_WINDOW_MS = 60 * 60_000; // 1 hour
export const GITHUB_CHAIN_WINDOW_MS = 10 * 60_000; // 10 minutes
export const GITHUB_CHAIN_LIMIT = 3;
export const GITHUB_OFFLINE_MERGE_WINDOW_MS = 2 * 60_000; // 2 minutes
export const GITHUB_RUN_HISTORY_LIMIT = 400;
export const GITHUB_CURSOR_ITEM_LIMIT = 500;
export const GITHUB_RECENT_DEDUPE_LIMIT = 200;

export function triggerKey(workflowId, nodeId) {
  return `${workflowId}:${nodeId}`;
}

export function itemScopeKey(repository, number) {
  return `${String(repository || "").trim().toLowerCase()}#${Number(number) || 0}`;
}

/** Collects sorted, deduplicated lowercased `owner/repo` names across all enabled GitHub triggers (max 100). */
export function collectEnabledGithubRepos(workflows) {
  const seen = new Set();
  const out = [];
  for (const wf of Array.isArray(workflows) ? workflows : []) {
    if (!wf?.enabled) continue;
    for (const node of Array.isArray(wf.nodes) ? wf.nodes : []) {
      if (node?.kind !== "trigger" || node.triggerKind !== "github") continue;
      for (const repo of normalizeGithubRepos(node.config)) {
        const lower = repo.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          out.push(lower);
          if (out.length >= 100) {
            out.sort();
            return out;
          }
        }
      }
    }
  }
  out.sort();
  return out;
}

/**
 * Ensures all persisted GitHub workflow stores exist in workspace state.
 * Migrates any legacy object-keyed `workflowGithubDeliveries` shape into the canonical flat array.
 */
export function ensureGithubWorkflowStores(state) {
  if (!state.workflowGithubActions || typeof state.workflowGithubActions !== "object") {
    state.workflowGithubActions = {};
  }
  if (!state.workflowGithubCursors || typeof state.workflowGithubCursors !== "object") {
    state.workflowGithubCursors = {};
  }
  if (!Array.isArray(state.workflowGithubDeliveries)) {
    if (state.workflowGithubDeliveries && typeof state.workflowGithubDeliveries === "object") {
      const migrated = [];
      for (const rows of Object.values(state.workflowGithubDeliveries)) {
        if (Array.isArray(rows)) migrated.push(...rows);
      }
      state.workflowGithubDeliveries = migrated;
    } else {
      state.workflowGithubDeliveries = [];
    }
  }
  if (!Array.isArray(state.workflowGithubRuns)) {
    state.workflowGithubRuns = [];
  }
}

/** Serializes an in-memory cursor `{ initialized, prs: Map, issues: Map, comments: Map, recentFingerprints }` into plain JSON. */
export function serializeGithubCursor(cursor) {
  const serializeEntry = (entry) => ({
    ...entry,
    ...(entry.labels instanceof Set ? { labels: [...entry.labels] } : {}),
    ...(entry.assignees instanceof Set ? { assignees: [...entry.assignees] } : {}),
    ...(entry.reviewers instanceof Set ? { reviewers: [...entry.reviewers] } : {}),
  });
  const serializeMap = (map, max = GITHUB_CURSOR_ITEM_LIMIT) => {
    const out = {};
    const entries = map instanceof Map ? [...map.entries()] : Object.entries(map || {});
    const sliced = entries.length > max ? entries.slice(entries.length - max) : entries;
    for (const [k, v] of sliced) out[String(k)] = serializeEntry(v);
    return out;
  };
  return {
    initialized: Boolean(cursor?.initialized),
    lastPollAt: Number(cursor?.lastPollAt) || Date.now(),
    prs: serializeMap(cursor?.prs),
    issues: serializeMap(cursor?.issues),
    comments: serializeMap(cursor?.comments),
    recentFingerprints: Array.isArray(cursor?.recentFingerprints)
      ? cursor.recentFingerprints.slice(-GITHUB_RECENT_DEDUPE_LIMIT)
      : [],
  };
}

/** Rehydrates a persisted cursor object back into `{ initialized, prs: Map, issues: Map, comments: Map, recentFingerprints }`. */
export function deserializeGithubCursor(raw) {
  if (!raw || typeof raw !== "object" || !raw.initialized) return null;
  const hydrateEntry = (entry) => ({
    ...entry,
    ...(Array.isArray(entry?.labels) ? { labels: new Set(entry.labels) } : {}),
    ...(Array.isArray(entry?.assignees) ? { assignees: new Set(entry.assignees) } : {}),
    ...(Array.isArray(entry?.reviewers) ? { reviewers: new Set(entry.reviewers) } : {}),
  });
  const prs = new Map();
  for (const [k, v] of Object.entries(raw.prs || {})) {
    const num = Number(k);
    if (Number.isFinite(num)) prs.set(num, hydrateEntry(v));
  }
  const issues = new Map();
  for (const [k, v] of Object.entries(raw.issues || {})) {
    const num = Number(k);
    if (Number.isFinite(num)) issues.set(num, hydrateEntry(v));
  }
  const comments = new Map();
  for (const [k, v] of Object.entries(raw.comments || {})) {
    comments.set(String(k), hydrateEntry(v));
  }
  return {
    initialized: true,
    lastPollAt: Number(raw.lastPollAt) || 0,
    prs,
    issues,
    comments,
    recentFingerprints: Array.isArray(raw.recentFingerprints) ? [...raw.recentFingerprints] : [],
  };
}

/** Computes a cross-source (push + poll) dedupe fingerprint for an item event. */
export function buildPushPollFingerprint(repo, event, number, updatedAt, extraId = "") {
  const r = String(repo || "").trim().toLowerCase();
  const ev = String(event || "").trim().toLowerCase();
  const n = Number(number) || 0;
  const u = String(updatedAt || "").trim();
  const ex = String(extraId || "").trim();
  return `${r}|${ev}|${n}|${u}|${ex}`;
}

/** Checks if a deliveryId or push/poll fingerprint has already been recorded for `(workflowId, nodeId)`. */
export function isDuplicateDelivery(state, workflowId, nodeId, deliveryId, fingerprint = "") {
  ensureGithubWorkflowStores(state);
  const list = state.workflowGithubDeliveries;
  for (const d of list) {
    if (!d || d.workflowId !== workflowId || d.nodeId !== nodeId) continue;
    if (deliveryId && d.deliveryId === deliveryId) return true;
    if (fingerprint && d.fingerprint && d.fingerprint === fingerprint) return true;
  }
  return false;
}

/**
 * Retains up to `limit` newest non-waiting deliveries per trigger plus ALL `waiting` deliveries
 * (never pruning `waiting`). Also bounds `payloadJson` per #352 rules: retained ONLY on `waiting`
 * rows (needed for dequeue) and on the single newest `outcome === "started"` (non-offline) row per trigger.
 */
export function pruneDeliveryLedger(list, limit = GITHUB_DELIVERY_LEDGER_LIMIT) {
  if (!Array.isArray(list)) return [];
  const byTrigger = new Map();
  for (const item of list) {
    if (!item) continue;
    const k = triggerKey(item.workflowId, item.nodeId);
    if (!byTrigger.has(k)) byTrigger.set(k, []);
    byTrigger.get(k).push(item);
  }
  const kept = [];
  for (const entries of byTrigger.values()) {
    const waiting = entries.filter((e) => e.outcome === "waiting");
    const rest = entries
      .filter((e) => e.outcome !== "waiting")
      .sort((a, b) => Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || ""))
      .slice(0, limit);

    let keptStartedPayload = false;
    for (const entry of rest) {
      if (entry.outcome === "started" && entry.reason !== "offline" && entry.payloadJson && !keptStartedPayload) {
        keptStartedPayload = true;
      } else if (entry.payloadJson !== undefined && entry.payloadJson !== null) {
        entry.payloadJson = null;
      }
    }
    kept.push(...waiting, ...rest);
  }
  return kept;
}

/**
 * Upserts a delivery record into `state.workflowGithubDeliveries` and prunes per trigger while
 * preserving all `waiting` rows and bounding `payloadJson` per #352 rules.
 */
export function recordGithubDelivery(state, record) {
  ensureGithubWorkflowStores(state);
  const list = state.workflowGithubDeliveries;
  const idx = list.findIndex(
    (d) =>
      d &&
      d.workflowId === record.workflowId &&
      d.nodeId === record.nodeId &&
      d.deliveryId === record.deliveryId,
  );
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...record };
  } else {
    list.unshift(record);
  }
  state.workflowGithubDeliveries = pruneDeliveryLedger(list, GITHUB_DELIVERY_LEDGER_LIMIT);
  return record;
}

/**
 * Records (or merges within 2 minutes) an `offline:<from>` gap delivery record on every enabled GitHub trigger.
 */
export function recordGithubOfflineGap(state, workflows, fromMs, toMs = Date.now()) {
  ensureGithubWorkflowStores(state);
  const start = Number(fromMs) || Date.now();
  const end = Math.max(start, Number(toMs) || Date.now());
  let changed = false;
  for (const wf of Array.isArray(workflows) ? workflows : []) {
    if (!wf?.enabled) continue;
    for (const node of Array.isArray(wf.nodes) ? wf.nodes : []) {
      if (node?.kind !== "trigger" || node.triggerKind !== "github") continue;
      const repos = normalizeGithubRepos(node.config);
      if (!repos.length) continue;
      const triggerRows = state.workflowGithubDeliveries
        .filter((d) => d && d.workflowId === wf.id && d.nodeId === node.id)
        .sort((a, b) => Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || ""));
      const latest = triggerRows[0];
      if (
        latest &&
        latest.outcome === "skipped" &&
        latest.reason === "offline" &&
        typeof latest.offlineToMs === "number" &&
        start - latest.offlineToMs <= GITHUB_OFFLINE_MERGE_WINDOW_MS
      ) {
        latest.offlineToMs = end;
        latest.receivedAt = new Date(end).toISOString();
        changed = true;
      } else {
        recordGithubDelivery(state, {
          workflowId: wf.id,
          nodeId: node.id,
          deliveryId: `offline:${start}`,
          event: "offline",
          repository: repos[0] || null,
          number: null,
          pullRequest: null,
          title: `Relay offline gap (${Math.max(1, Math.round((end - start) / 1000))}s)`,
          url: null,
          receivedAt: new Date(end).toISOString(),
          outcome: "skipped",
          reason: "offline",
          reasonDetail: null,
          runId: null,
          payloadJson: null,
          offlineFromMs: start,
          offlineToMs: end,
        });
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Checks the same-workflow 1-hour self-loop guard:
 * - Only triggers when the event looks bot-caused (sender/author is a Bot or matches `botLogin`).
 * - Blocks if `workflowGithubActions` has a row for `(workflowId, repository, number)` with `status === "sending"`
 *   (closes the webhook-before-REST-response race), OR if `objectKey` matches a recorded `objectIds` token
 *   for the SAME `workflowId` within 1 hour.
 * - Scoped strictly by `workflowId`, so Workflow A can intentionally trigger Workflow B.
 */
export function checkSameWorkflowSelfGuard(
  state,
  { workflowId, repository, number, objectKey = null, causedByBot = false, now = Date.now() },
) {
  if (!causedByBot) return { blocked: false };
  ensureGithubWorkflowStores(state);
  const repoLow = String(repository || "").trim().toLowerCase();
  const num = Number(number) || 0;
  const actions = Object.values(state.workflowGithubActions || {});

  for (const row of actions) {
    if (!row || row.workflowId !== workflowId) continue;
    if (String(row.repository || "").trim().toLowerCase() !== repoLow) continue;
    if (num && row.number && Number(row.number) !== num) continue;
    const age = now - (Number(row.createdAt) || 0);
    if (age > GITHUB_SELF_GUARD_WINDOW_MS) continue;

    if (row.status === "sending") {
      return { blocked: true, reason: "self", detail: "sending-race" };
    }
    if (objectKey && Array.isArray(row.objectIds) && row.objectIds.includes(objectKey)) {
      return { blocked: true, reason: "self", detail: `object:${objectKey}` };
    }
  }
  return { blocked: false };
}

/**
 * Checks the cross-workflow 3-per-10-minute chain cap for bot-caused runs on `(repository, number)`.
 * Checked both on ingress and again on waiting-queue dequeue.
 */
export function checkCrossWorkflowChainCap(state, { repository, number, causedByBot = false, now = Date.now() }) {
  if (!causedByBot) return { blocked: false, count: 0 };
  ensureGithubWorkflowStores(state);
  const repoLow = String(repository || "").trim().toLowerCase();
  const num = Number(number) || 0;
  let count = 0;
  for (const row of state.workflowGithubRuns) {
    if (!row || !row.causedByBot) continue;
    if (String(row.repository || "").trim().toLowerCase() !== repoLow) continue;
    if (Number(row.number) !== num) continue;
    if (now - (Number(row.startedAt) || 0) <= GITHUB_CHAIN_WINDOW_MS) {
      count++;
    }
  }
  if (count >= GITHUB_CHAIN_LIMIT) {
    return { blocked: true, reason: "chain", count };
  }
  return { blocked: false, count };
}

/** Records a started GitHub workflow run in `state.workflowGithubRuns` (bounded to GITHUB_RUN_HISTORY_LIMIT). */
export function recordGithubRunItem(state, entry) {
  ensureGithubWorkflowStores(state);
  state.workflowGithubRuns.unshift({
    runId: entry.runId,
    workflowId: entry.workflowId,
    nodeId: entry.nodeId,
    deliveryId: entry.deliveryId || "",
    repository: String(entry.repository || ""),
    number: Number(entry.number) || 0,
    pullRequest: Boolean(entry.pullRequest),
    title: String(entry.title || "").slice(0, 240),
    causedByBot: Boolean(entry.causedByBot),
    startedAt: Number(entry.startedAt) || Date.now(),
  });
  if (state.workflowGithubRuns.length > GITHUB_RUN_HISTORY_LIMIT) {
    state.workflowGithubRuns.length = GITHUB_RUN_HISTORY_LIMIT;
  }
}

/** Determines whether an incoming GitHub event was caused by a bot (including Botkins App `[bot]` actors). */
export function isEventCausedByBot(sender, author, extraBotLogins = []) {
  if (isGithubBotActor(sender) || isGithubBotActor(author)) return true;
  const sLogin = String(typeof sender === "object" ? sender?.login : sender || "").trim().toLowerCase();
  if (!sLogin) return false;
  for (const candidate of extraBotLogins) {
    const clean = String(candidate || "").trim().toLowerCase().replace(/^@/, "");
    if (clean && (sLogin === clean || sLogin === `${clean}[bot]`)) return true;
  }
  return false;
}

/** Lists deliveries for a workflow (or specific trigger node), newest first, stripping `payloadJson`. */
export function listGithubDeliveries(state, workflowId, nodeId = null, limit = 50) {
  ensureGithubWorkflowStores(state);
  return state.workflowGithubDeliveries
    .filter((d) => d && d.workflowId === workflowId && (!nodeId || d.nodeId === nodeId))
    .sort((a, b) => Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || ""))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
    .map(({ payloadJson, ...rest }) => ({
      ...rest,
      replayable: rest.outcome === "started" && rest.reason !== "offline" && Boolean(payloadJson),
    }));
}

/** Finds the oldest `waiting` delivery for `(workflowId, repository, number)` across that workflow's triggers. */
export function findOldestWaitingDelivery(state, workflowId, repository, number) {
  ensureGithubWorkflowStores(state);
  const repoLow = String(repository || "").trim().toLowerCase();
  const num = Number(number) || 0;
  let oldest = null;
  let oldestTime = Infinity;
  for (const row of state.workflowGithubDeliveries) {
    if (!row || row.workflowId !== workflowId || row.outcome !== "waiting") continue;
    if (String(row.repository || "").trim().toLowerCase() !== repoLow) continue;
    if (Number(row.number) !== num) continue;
    const t = Date.parse(row.receivedAt || 0) || 0;
    if (t <= oldestTime) {
      oldestTime = t;
      oldest = row;
    }
  }
  return oldest;
}
