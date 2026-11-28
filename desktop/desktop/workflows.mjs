// Event-based Workflows for Botkins Routines.
// Workflows live beside existing Routines in workspace state (`state.workflows` and `state.workflowRuns`),
// so existing cron routines keep working unchanged with zero data loss.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "./providers/provider.mjs";
import { nextTime } from "./panels.mjs";
import { compileCadence, describeCadence, localZone } from "./routines.mjs";
import { applyA2uiMessages, summarizeA2uiSurface } from "./link/a2ui.mjs";
import { collectChatSurfaces } from "./a2ui-host.mjs";
import {
  NODE_KINDS,
  TRIGGER_KINDS,
  OUTPUT_DESTINATIONS,
  defaultNodeLabel,
  nodeOutputFields,
  resolveTemplate,
  parseNeedsYou,
  frameExternalPrompt,
  lookupField,
  evaluateCondition,
  analyzeWorkflowFields,
  validateWorkflow,
  isValidFieldName,
} from "./workflow-fields.mjs";
import {
  WorkflowGithubAuth,
  createDefaultGithubPoller,
  findMentionInText,
  parseMentionHandles,
} from "./workflow-github.mjs";
import {
  buildGithubTriggerPayload,
  evaluateGithubTriggerFilters,
  extractFailingCheckConclusion,
  normalizeAssigneeList,
  normalizeGithubEvents,
  normalizeGithubRepos,
  normalizeGithubTriggerConfig,
  normalizeLabelList,
} from "./workflow-github-events.mjs";
import {
  createDefaultGithubOutputClient,
  createWorkspaceActionStore,
  executeGithubOutputNode,
} from "./workflow-github-output.mjs";
import { exportWorkflow, parseImportedWorkflow } from "./workflow-port.mjs";

const MAX_RUNS = 200;
const MAX_WEBHOOK_BYTES = 64 * 1024;
const ACTIVE_STATUSES = new Set(["running", "waiting_approval"]);
const FINAL_STEP_STATUSES = new Set(["completed", "failed", "skipped", "rejected"]);
const GOAL_CATEGORIES = ["health", "relationships", "finance", "career", "interests", "productivity", "other"];

function clampStr(v, max = 200) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function formatLocalParts(ms, timeZone) {
  const tz = timeZone || localZone();
  const date = new Date(ms);
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .formatToParts(date)
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(date);
    const hour = parts.hour === "24" ? "00" : parts.hour;
    return {
      local_date: `${parts.year}-${parts.month}-${parts.day}`,
      local_time: `${hour}:${parts.minute}`,
      weekday,
      run_time: date.toISOString(),
      timezone: tz,
    };
  } catch {
    const iso = date.toISOString();
    return {
      local_date: iso.slice(0, 10),
      local_time: iso.slice(11, 16),
      weekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()],
      run_time: iso,
      timezone: "UTC",
    };
  }
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Auto-places nodes cleanly in columns from left (triggers) to right (outputs) when positions are missing. */
export function autoLayoutNodes(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  const inDegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (byId.has(e.from) && byId.has(e.to)) {
      outgoing.get(e.from).push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }
  const depth = new Map();
  const queue = [];
  for (const n of nodes) {
    if (n.kind === "trigger" || (inDegree.get(n.id) ?? 0) === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  while (queue.length) {
    const id = queue.shift();
    const d = depth.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      const prev = depth.get(next);
      if (prev === undefined || prev < d + 1) {
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  const columns = new Map();
  for (const n of nodes) {
    const col = depth.get(n.id) ?? 0;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(n);
  }
  for (const [col, list] of columns.entries()) {
    list.forEach((n, row) => {
      if (!n.position || typeof n.position.x !== "number" || typeof n.position.y !== "number") {
        n.position = { x: 64 + col * 340, y: 72 + row * 190 };
      }
    });
  }
  return nodes;
}

function extractJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text.trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(candidate.slice(first, last + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function validateStructuredFields(obj, outputFields) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "Expected a JSON object." };
  const cleaned = {};
  const problems = [];
  for (const field of outputFields) {
    const has = Object.prototype.hasOwnProperty.call(obj, field.name);
    let val = has ? obj[field.name] : undefined;
    if ((val === undefined || val === null || val === "") && field.required !== false) {
      problems.push(`missing "${field.name}"`);
      continue;
    }
    if (val === undefined || val === null) {
      cleaned[field.name] = "";
      continue;
    }
    if (field.type === "number") {
      const num = Number(val);
      if (Number.isNaN(num)) {
        problems.push(`"${field.name}" must be a number`);
        continue;
      }
      val = num;
    } else if (field.type === "boolean") {
      if (typeof val === "string") {
        if (val.toLowerCase() === "true") val = true;
        else if (val.toLowerCase() === "false") val = false;
        else {
          problems.push(`"${field.name}" must be a boolean`);
          continue;
        }
      } else {
        val = Boolean(val);
      }
    } else {
      val = typeof val === "string" ? val : JSON.stringify(val);
    }
    if (Array.isArray(field.choices) && field.choices.length) {
      const match = field.choices.find((c) => String(c).toLowerCase() === String(val).toLowerCase());
      if (!match) {
        problems.push(`"${field.name}" must be one of: ${field.choices.join(", ")}`);
        continue;
      }
      val = match;
    }
    cleaned[field.name] = val;
  }
  return problems.length ? { ok: false, error: problems.join("; ") } : { ok: true, fields: cleaned };
}

function normalizeStatusList(val) {
  if (Array.isArray(val)) return val.map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  if (typeof val === "string" && val.trim()) {
    return val
      .split(",")
      .map((s) => s.toLowerCase().trim())
      .filter(Boolean);
  }
  return [];
}

function summarizeCiRollup(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  const states = rollup.map((item) => String(item?.conclusion || item?.state || item?.status || "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(s))) return "failing";
  if (states.some((s) => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING"].includes(s))) return "pending";
  if (states.every((s) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(s))) return "passing";
  return "mixed";
}

function formatGithubLabels(labels) {
  if (typeof labels === "string") return labels;
  if (!Array.isArray(labels)) return "";
  return labels
    .map((l) => (typeof l === "string" ? l : l?.name || ""))
    .filter(Boolean)
    .join(", ");
}

function githubUpdateFingerprint(item, labels) {
  return JSON.stringify([
    item.updatedAt || item.updated_at || "",
    String(item.state || "").toLowerCase(),
    item.title || "",
    item.body || "",
    labels,
  ]);
}

/** Strips vault references when sending workflows over sync / RPC to remote devices. */
const CARD_BADGE_TONES = new Set(["neutral", "positive", "warning", "negative", "accent"]);

function safeExternalUrl(raw) {
  if (typeof raw !== "string") return "";
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

function resolveCardBlock(block, context) {
  if (!block || typeof block !== "object" || typeof block.type !== "string") return null;
  const r = (v) => (typeof v === "string" ? resolveTemplate(v, context) : v);
  switch (block.type) {
    case "markdown": {
      const text = String(r(block.text ?? "")).trim();
      return text ? { type: "markdown", text } : null;
    }
    case "metric": {
      const label = String(r(block.label ?? "")).trim();
      const value = String(r(block.value ?? "")).trim();
      const note = block.note !== undefined ? String(r(block.note)).trim() : "";
      if (!label && !value) return null;
      return { type: "metric", label, value, ...(note ? { note } : {}) };
    }
    case "list": {
      const items = (Array.isArray(block.items) ? block.items : [])
        .map((it) => String(r(it)).trim())
        .filter(Boolean);
      return items.length ? { type: "list", items } : null;
    }
    case "table": {
      const columns = (Array.isArray(block.columns) ? block.columns : []).map((c) => String(r(c)).trim());
      const rows = (Array.isArray(block.rows) ? block.rows : [])
        .filter(Array.isArray)
        .map((row) => row.map((cell) => String(r(cell)).trim()));
      return columns.length && rows.length ? { type: "table", columns, rows } : null;
    }
    case "badges": {
      const items = (Array.isArray(block.items) ? block.items : [])
        .map((it) => {
          if (!it || typeof it !== "object") return null;
          const label = String(r(it.label ?? "")).trim();
          if (!label) return null;
          const tone = CARD_BADGE_TONES.has(it.tone) ? it.tone : undefined;
          return { label, ...(tone ? { tone } : {}) };
        })
        .filter(Boolean);
      return items.length ? { type: "badges", items } : null;
    }
    case "progress": {
      const label = String(r(block.label ?? "")).trim();
      const note = block.note !== undefined ? String(r(block.note)).trim() : "";
      return label ? { type: "progress", label, value: Number(block.value ?? 0), max: Number(block.max ?? 100), ...(note ? { note } : {}) } : null;
    }
    default:
      return null;
  }
}

function resolveOutputCard(cardCfg, context, fallbackTitle, fallbackText, ws) {
  const title = resolveTemplate(cardCfg.title || "", context).trim() || fallbackTitle;
  const subtitle = typeof cardCfg.subtitle === "string" ? resolveTemplate(cardCfg.subtitle, context).trim() : "";
  const rawNeedsYou = typeof cardCfg.needsYou === "string" ? resolveTemplate(cardCfg.needsYou, context) : cardCfg.needsYou;
  const needsYou = parseNeedsYou(rawNeedsYou);
  const body = typeof cardCfg.body === "string" ? resolveTemplate(cardCfg.body, context).trim() : "";

  const resolvedFields = Array.isArray(cardCfg.fields)
    ? cardCfg.fields
        .map((f) => {
          if (!f || typeof f !== "object") return null;
          const label = resolveTemplate(String(f.label ?? ""), context).trim();
          const value = resolveTemplate(String(f.value ?? ""), context).trim();
          if (!value) return null;
          const tone = CARD_BADGE_TONES.has(f.tone) ? f.tone : undefined;
          return { label, value, ...(tone ? { tone } : {}) };
        })
        .filter(Boolean)
    : [];

  let blocks = [];
  if (Array.isArray(cardCfg.blocks) && cardCfg.blocks.length) {
    blocks = cardCfg.blocks.map((b) => resolveCardBlock(b, context)).filter(Boolean);
  } else {
    if (resolvedFields.length) {
      blocks.push({
        type: "badges",
        items: resolvedFields.map((f) => ({
          label: f.label ? `${f.label}: ${f.value}` : f.value,
          ...(f.tone ? { tone: f.tone } : {}),
        })),
      });
    }
    const md = body || fallbackText;
    if (md) blocks.push({ type: "markdown", text: md });
  }

  let link;
  if (cardCfg.link && typeof cardCfg.link === "object") {
    const url = safeExternalUrl(resolveTemplate(String(cardCfg.link.url ?? ""), context));
    if (url) {
      const label = resolveTemplate(String(cardCfg.link.label ?? ""), context).trim() || "View on GitHub";
      link = { label, url };
    }
  }

  let dispatch;
  if (cardCfg.dispatch && typeof cardCfg.dispatch === "object") {
    const prompt = resolveTemplate(String(cardCfg.dispatch.prompt ?? ""), context).trim();
    if (prompt) {
      const botIdRaw = typeof cardCfg.dispatch.botId === "string" ? cardCfg.dispatch.botId.trim() : "";
      const botNameRaw = typeof cardCfg.dispatch.botName === "string" ? resolveTemplate(cardCfg.dispatch.botName, context).trim() : "";
      const bots = ws?.state?.bots ?? [];
      const matchedBot =
        (botIdRaw ? bots.find((b) => b.id === botIdRaw) : null) ??
        (botNameRaw ? bots.find((b) => b.name.toLowerCase() === botNameRaw.toLowerCase()) : null);
      const chatTitle =
        typeof cardCfg.dispatch.chatTitle === "string"
          ? resolveTemplate(cardCfg.dispatch.chatTitle, context).trim()
          : "";
      const label =
        typeof cardCfg.dispatch.label === "string"
          ? resolveTemplate(cardCfg.dispatch.label, context).trim()
          : "";
      dispatch = {
        ...(matchedBot ? { botId: matchedBot.id, botName: matchedBot.name } : {}),
        ...(!matchedBot && botIdRaw ? { botId: botIdRaw } : {}),
        ...(!matchedBot && botNameRaw ? { botName: botNameRaw } : {}),
        ...(label ? { label } : {}),
        ...(chatTitle ? { chatTitle } : {}),
        prompt,
      };
    }
  }

  const actionCard = {
    id: `card_${randomUUID().slice(0, 10)}`,
    title,
    ...(subtitle ? { subtitle } : {}),
    blocks,
    ...(link ? { link } : {}),
    needsYou,
    ...(dispatch ? { dispatch } : {}),
    state: "open",
  };

  const parts = [`**${title}** — ${needsYou ? "Needs your direction" : "No input needed"}`];
  if (subtitle) parts.push(subtitle);
  if (resolvedFields.length) {
    parts.push(resolvedFields.map((f) => (f.label ? `${f.label}: ${f.value}` : f.value)).join(" · "));
  }
  if (body) parts.push(body);
  else if (!fallbackText) {
    for (const b of blocks) {
      if (b.type === "markdown" && b.text) parts.push(b.text);
      else if (b.type === "list" && b.items?.length) parts.push(b.items.map((x) => `- ${x}`).join("\n"));
    }
  }
  if (link) parts.push(`[${link.label}](${link.url})`);

  return { actionCard, fallbackText: parts.join("\n\n") };
}

function resolveTemplateDeep(value, context, depth = 0) {
  if (depth > 16 || value === null || value === undefined) return value;
  if (typeof value === "string") return resolveTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => resolveTemplateDeep(item, context, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveTemplateDeep(v, context, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Resolves an Output node's `a2ui` configuration (array of v1.0 messages, `{ messages, onAction, targetWorkflowId, dispatch }`,
 * or JSON string) with `{{field}}` templates and validates it against A2UI v1.0 + the Basic Catalog.
 */
function resolveOutputA2ui(a2uiCfg, context, wf, run, bot, targetChat, ws) {
  let rawMessages;
  let onAction;
  let targetWorkflowId;
  let dispatch;
  let allowMembers = false;
  let decisions;
  let decision;
  if (typeof a2uiCfg === "string") {
    const resolvedStr = resolveTemplate(a2uiCfg, context).trim();
    const parsed = JSON.parse(resolvedStr);
    rawMessages = Array.isArray(parsed) ? parsed : [parsed];
  } else if (Array.isArray(a2uiCfg)) {
    rawMessages = resolveTemplateDeep(a2uiCfg, context);
  } else if (a2uiCfg && typeof a2uiCfg === "object") {
    onAction = a2uiCfg.onAction;
    targetWorkflowId = typeof a2uiCfg.targetWorkflowId === "string" && a2uiCfg.targetWorkflowId.trim() ? a2uiCfg.targetWorkflowId.trim() : undefined;
    allowMembers = a2uiCfg.allowMembers === true;
    if (a2uiCfg.decisions && typeof a2uiCfg.decisions === "object" && !Array.isArray(a2uiCfg.decisions)) {
      decisions = resolveTemplateDeep(a2uiCfg.decisions, context);
    }
    if (typeof a2uiCfg.decision === "string" && a2uiCfg.decision.trim()) {
      decision = resolveTemplate(a2uiCfg.decision, context).trim();
    }
    if (a2uiCfg.dispatch && typeof a2uiCfg.dispatch === "object") {
      dispatch = resolveTemplateDeep(a2uiCfg.dispatch, context);
    }
    if (typeof a2uiCfg.messages === "string") {
      const parsed = JSON.parse(resolveTemplate(a2uiCfg.messages, context).trim());
      rawMessages = Array.isArray(parsed) ? parsed : [parsed];
    } else if (Array.isArray(a2uiCfg.messages)) {
      rawMessages = resolveTemplateDeep(a2uiCfg.messages, context);
    } else if (a2uiCfg.version === "1.0") {
      rawMessages = [resolveTemplateDeep(a2uiCfg, context)];
    }
  }
  if (!Array.isArray(rawMessages) || !rawMessages.length) {
    throw new Error("Output a2ui resolved to no A2UI v1.0 messages.");
  }

  // Ensure workflow-posted createSurface IDs don't collide across multiple runs unless explicitly targeting an update.
  const existingEntries = collectChatSurfaces(targetChat, ws?.state?.runs ?? []);
  const existingSurfaces = [...existingEntries.values()].map((e) => e.surface);
  const usedIds = new Set(existingSurfaces.filter((s) => !s.deleted).map((s) => s.surfaceId));
  const idMap = new Map();
  const normalizedMessages = rawMessages.map((m) => {
    if (m?.createSurface?.surfaceId && usedIds.has(m.createSurface.surfaceId)) {
      const nextId = `${m.createSurface.surfaceId}-${run.id.slice(0, 8)}`;
      idMap.set(m.createSurface.surfaceId, nextId);
      return { ...m, createSurface: { ...m.createSurface, surfaceId: nextId } };
    }
    if (m?.updateComponents?.surfaceId && idMap.has(m.updateComponents.surfaceId)) {
      return { ...m, updateComponents: { ...m.updateComponents, surfaceId: idMap.get(m.updateComponents.surfaceId) } };
    }
    if (m?.updateDataModel?.surfaceId && idMap.has(m.updateDataModel.surfaceId)) {
      return { ...m, updateDataModel: { ...m.updateDataModel, surfaceId: idMap.get(m.updateDataModel.surfaceId) } };
    }
    if (m?.deleteSurface?.surfaceId && idMap.has(m.deleteSurface.surfaceId)) {
      return { ...m, deleteSurface: { ...m.deleteSurface, surfaceId: idMap.get(m.deleteSurface.surfaceId) } };
    }
    return m;
  });

  const wfMeta = {
    workflowId: wf.id,
    workflowName: wf.name,
    runId: run.id,
    ...(onAction && onAction !== "bot" ? { onAction } : {}),
    ...(targetWorkflowId ? { targetWorkflowId } : {}),
    ...(decisions ? { decisions } : {}),
    ...(decision ? { decision } : {}),
  };

  const applied = applyA2uiMessages(existingSurfaces, normalizedMessages, {
    botId: bot?.id,
    workflow: wfMeta,
    ...(allowMembers ? { allowMembers: true } : {}),
    ...(dispatch ? { dispatch } : {}),
    now: Date.now(),
  });

  // Apply in-place updates/deletes to previously posted surfaces in the target chat.
  for (const id of applied.updatedIds.concat(applied.deletedIds)) {
    const prev = existingEntries.get(id);
    const next = applied.surfaces.get(id);
    if (prev && next) {
      const list = prev.container.a2uiSurfaces;
      const idx = list.findIndex((s) => s.surfaceId === id);
      if (idx >= 0) list[idx] = next;
    }
  }

  const createdSurfaces = applied.createdIds
    .map((id) => applied.surfaces.get(id))
    .filter((s) => s && !s.deleted);
  const fallbackText = createdSurfaces
    .map((s) => summarizeA2uiSurface(s).text)
    .filter(Boolean)
    .join("\n\n");

  return { surfaces: createdSurfaces, updatedIds: applied.updatedIds, deletedIds: applied.deletedIds, fallbackText };
}

/** Strips vault references when sending workflows over sync / RPC to remote devices. */
export function sanitizeWorkflow(wf) {
  if (!wf || typeof wf !== "object") return wf;
  return {
    ...wf,
    nodes: (wf.nodes ?? []).map((n) => {
      if (n.kind !== "trigger" || n.triggerKind !== "webhook") return n;
      const { secretRef, secret, ...rest } = n.config ?? {};
      return { ...n, config: { ...rest, hasSecret: !!(secretRef || n.config?.hasSecret) } };
    }),
  };
}

export class Workflows {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.githubAuth = options.githubAuth ?? new WorkflowGithubAuth();
    this.githubPoller = options.githubPoller ?? createDefaultGithubPoller(this.githubAuth);
    this.githubOutputClient =
      options.githubOutputClient ??
      createDefaultGithubOutputClient({
        auth: this.githubAuth,
        getInstallationToken: options.getGithubInstallationToken,
      });
    this.githubActionStore = options.githubActionStore ?? createWorkspaceActionStore(ws);
    this.modelRunner = options.modelRunner ?? null;
    this.waitingTurns = new Map(); // turnRunId -> { resolve, reject, workflowRunId, nodeId, structuredAnswer }
    this.activeExecutions = new Map(); // workflowRunId -> Promise
    this.githubPolling = new Set(); // `${workflowId}:${nodeId}`
    this.githubLastPoll = new Map(); // `${workflowId}:${nodeId}` -> ms
    this.githubCursors = new Map(); // `${workflowId}:${nodeId}:${repoLower}` -> { initialized, prs, issues, comments }

    this.ensureState();
    this.bindEvents();
  }

  /** Local GitHub CLI auth status for Workflow GitHub triggers. */
  async githubStatus(options = {}) {
    return await this.githubAuth.status({ includeRepos: options?.includeRepos === true });
  }

  /** Starts an interactive `gh auth login --web` device-code sign-in on this host. */
  async githubSignInStart() {
    return await this.githubAuth.startSignIn();
  }

  /** Cancels an in-progress `gh auth login` device-code sign-in on this host. */
  async githubSignInCancel() {
    return await this.githubAuth.cancelSignIn();
  }

  /** Lists labels and assignees/reviewers across one or more repos for UI pickers. */
  async githubCatalog(options = {}) {
    const rawRepos = Array.isArray(options?.repos)
      ? options.repos
      : typeof options?.repo === "string" && options.repo.trim()
        ? [options.repo.trim()]
        : [];
    const repos = normalizeGithubRepos({ repos: rawRepos }).slice(0, 10);
    const includeLabels = options?.includeLabels !== false;
    const includeAssignees = options?.includeAssignees !== false;
    if (!repos.length) return { repos: [], labels: [], assignees: [] };

    const labelMap = new Map();
    const assigneeMap = new Map();

    await Promise.all(
      repos.map(async (repo) => {
        if (includeLabels && typeof this.githubAuth?.listRepoLabels === "function") {
          const list = await this.githubAuth.listRepoLabels(repo).catch(() => []);
          for (const item of Array.isArray(list) ? list : []) {
            const name = typeof item === "string" ? item.trim() : String(item?.name || "").trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (!labelMap.has(key)) {
              labelMap.set(key, {
                name,
                color: typeof item === "object" && typeof item?.color === "string" ? item.color : "",
                description: typeof item === "object" && typeof item?.description === "string" ? item.description : "",
              });
            }
          }
        }
        if (includeAssignees && typeof this.githubAuth?.listRepoAssignees === "function") {
          const list = await this.githubAuth.listRepoAssignees(repo).catch(() => []);
          for (const item of Array.isArray(list) ? list : []) {
            const login = typeof item === "string" ? item.trim() : String(item?.login || "").trim();
            if (!login) continue;
            const key = login.toLowerCase();
            if (!assigneeMap.has(key)) {
              assigneeMap.set(key, {
                login,
                type: typeof item === "object" && typeof item?.type === "string" ? item.type : "User",
              });
            }
          }
        }
      }),
    );

    return {
      repos,
      labels: [...labelMap.values()].slice(0, 500),
      assignees: [...assigneeMap.values()].slice(0, 500),
    };
  }

  /** Lists recorded GitHub deliveries for a trigger node (newest first, max 50). */
  listGithubDeliveries(workflowId, nodeId = null) {
    this.ensureState();
    const list = this.ws.state.workflowGithubDeliveries ?? [];
    return list
      .filter((d) => d && d.workflowId === workflowId && (!nodeId || d.nodeId === nodeId))
      .sort((a, b) => Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || ""))
      .slice(0, 50)
      .map(({ payloadJson, ...rest }) => ({
        ...rest,
        replayable: rest.outcome === "started" && rest.reason !== "offline" && Boolean(payloadJson),
      }));
  }

  /**
   * Persists a GitHub delivery record (keeping up to 50 non-waiting rows per trigger, never pruning `waiting`).
   * To keep workspace state compact, `payloadJson` is retained ONLY on `waiting` rows (needed for dequeue)
   * and on the single newest `outcome === "started"` row per trigger (for "Run last event").
   */
  recordGithubDelivery(record) {
    this.ensureState();
    const list = this.ws.state.workflowGithubDeliveries;
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
    // Prune per (workflowId, nodeId) to newest 50 non-waiting records while keeping all waiting records.
    const byTrigger = new Map();
    for (const item of list) {
      const k = `${item.workflowId}:${item.nodeId}`;
      if (!byTrigger.has(k)) byTrigger.set(k, []);
      byTrigger.get(k).push(item);
    }
    const kept = [];
    for (const entries of byTrigger.values()) {
      const waiting = entries.filter((e) => e.outcome === "waiting");
      const rest = entries
        .filter((e) => e.outcome !== "waiting")
        .sort((a, b) => Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || ""))
        .slice(0, 50);

      // Retain payloadJson only on the newest replayable (`outcome === "started"`) row per trigger.
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
    this.ws.state.workflowGithubDeliveries = kept;
    this.ws.save();
  }

  /** Replays the most recent started GitHub delivery payload for a trigger node. */
  replayLastGithubEvent(workflowId, nodeId = null) {
    this.ensureState();
    const wf = this.get(workflowId);
    const list = (this.ws.state.workflowGithubDeliveries ?? [])
      .filter(
        (d) =>
          d &&
          d.workflowId === workflowId &&
          (!nodeId || d.nodeId === nodeId) &&
          d.outcome === "started" &&
          d.reason !== "offline" &&
          d.payloadJson,
      )
      .sort((a, b) => Date.parse(b.receivedAt || "") - Date.parse(a.receivedAt || ""));
    const latest = list[0];
    if (!latest) {
      throw new Error("No previous GitHub event is available to replay for this trigger.");
    }
    const triggerNode = wf.nodes.find((n) => n.id === latest.nodeId && n.kind === "trigger" && n.triggerKind === "github");
    if (!triggerNode) {
      throw new Error("GitHub trigger node no longer exists on this workflow.");
    }
    let payload = {};
    try {
      payload = JSON.parse(latest.payloadJson);
    } catch {
      throw new Error("Stored GitHub event payload could not be parsed.");
    }
    // Re-evaluate current trigger filters so edits to filters (e.g. notBot/baseBranch/labels) are respected on replay.
    const filterResult = evaluateGithubTriggerFilters(triggerNode.config, payload, {
      sender: payload.sender ?? payload.author,
      author: payload.author,
    });
    if (!filterResult.pass) {
      throw new Error(`Last GitHub event no longer matches this trigger's filters (${filterResult.reason || "filter"}).`);
    }
    // Keep `manual: false` so untrusted external-event framing, model escaping, and echo guards remain enforced;
    // mark `replay: true` for audit and display only.
    const run = this.startRun(wf, triggerNode, payload, { manual: false, replay: true });
    this.recordGithubDelivery({
      workflowId: wf.id,
      nodeId: triggerNode.id,
      deliveryId: `replay:${randomUUID().slice(0, 12)}`,
      event: latest.event,
      repository: latest.repository ?? null,
      number: latest.number ?? null,
      pullRequest: latest.pullRequest ?? null,
      title: latest.title ?? null,
      url: latest.url ?? null,
      receivedAt: new Date().toISOString(),
      outcome: "started",
      reason: null,
      reasonDetail: null,
      runId: run.id,
      payloadJson: latest.payloadJson,
    });
    return run;
  }

  ensureState() {
    this.ws.state.workflows ??= [];
    this.ws.state.workflowRuns ??= [];
    this.ws.state.workflowGithubActions ??= {};
    this.ws.state.workflowGithubDeliveries ??= [];
  }

  get all() {
    this.ensureState();
    return this.ws.state.workflows;
  }

  get runs() {
    this.ensureState();
    return this.ws.state.workflowRuns;
  }

  bindEvents() {
    const events = this.ws.events;
    if (!events?.on) return;

    events.on("task.created", (payload) => {
      void this.onTaskEvent("created", payload);
    });
    events.on("task.status", (payload) => {
      void this.onTaskEvent("status_changed", payload);
    });
    events.on("turn", ({ chat, run }) => {
      this.onTurnFinished(chat, run);
    });
    events.on("chat.message", (payload) => {
      void this.onChatMessage(payload);
    });
  }

  /** Lists all workflows (with safe webhook secret flags). */
  list() {
    return this.all.map((wf) => sanitizeWorkflow(wf));
  }

  /** Lists runs (optionally filtered by workflowId). */
  listRuns(workflowId = null, limit = 50) {
    const src = workflowId ? this.runs.filter((r) => r.workflowId === workflowId) : this.runs;
    return src.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  get(id) {
    const wf = this.all.find((w) => w.id === id);
    if (!wf) throw new Error("Workflow not found.");
    return wf;
  }

  getRun(runId) {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) throw new Error("Workflow run not found.");
    return run;
  }

  /** Normalizes incoming workflow nodes & edges and compiles schedule triggers. */
  normalizeGraph(rawNodes, rawEdges, existingNodes = []) {
    const prevById = new Map(existingNodes.map((n) => [n.id, n]));
    const bots = this.ws.state.bots ?? [];

    const nodes = (Array.isArray(rawNodes) ? rawNodes : []).map((raw) => {
      const id = clampStr(raw?.id, 80) || "n_" + randomUUID().slice(0, 8);
      const kind = NODE_KINDS.includes(raw?.kind) ? raw.kind : "agent";
      const prev = prevById.get(id);
      const cfg = raw?.config && typeof raw.config === "object" ? structuredClone(raw.config) : {};

      // Resolve botName -> botId if only botName was supplied
      if (!cfg.botId && typeof cfg.botName === "string" && cfg.botName.trim()) {
        const match = bots.find((b) => b.name.toLowerCase() === cfg.botName.trim().toLowerCase());
        if (match) cfg.botId = match.id;
      }

      const node = {
        id,
        kind,
        ...(kind === "trigger" ? { triggerKind: TRIGGER_KINDS.includes(raw?.triggerKind) ? raw.triggerKind : "manual" } : {}),
        label: clampStr(raw?.label, 80) || defaultNodeLabel({ kind, triggerKind: raw?.triggerKind }),
        ...(raw?.position && typeof raw.position.x === "number" && typeof raw.position.y === "number"
          ? { position: { x: Math.round(raw.position.x), y: Math.round(raw.position.y) } }
          : {}),
        config: cfg,
      };

      if (node.kind === "trigger" && node.triggerKind === "schedule") {
        const kind = cfg.cadence || (cfg.cron ? "custom" : "daily");
        const compiled = compileCadence(
          {
            kind,
            time: cfg.time || "09:00",
            days: cfg.days,
            date: cfg.date,
            cron: cfg.cron,
          },
          cfg.timezone || localZone(),
        );
        node.config = {
          ...cfg,
          cadence: compiled.cadence.kind,
          cron: compiled.cron,
          timezone: compiled.timezone,
          when: describeCadence(compiled.cadence),
          // Preserve nextAt if cron/timezone didn't change, otherwise compute next future occurrence.
          nextAt:
            prev?.config?.cron === compiled.cron && prev?.config?.timezone === compiled.timezone && typeof prev?.config?.nextAt === "number"
              ? prev.config.nextAt
              : compiled.nextAt,
        };
      }

      if (node.kind === "trigger" && node.triggerKind === "webhook") {
        // Preserve existing routeId and vault secretRef unless explicitly replaced via rotateWebhookSecret.
        const routeId = clampStr(cfg.routeId, 64) || prev?.config?.routeId || randomBytes(12).toString("hex");
        const secretRef = prev?.config?.secretRef || (typeof cfg.secretRef === "string" && cfg.secretRef.startsWith("vault:") ? cfg.secretRef : null);
        delete node.config.secret;
        node.config.routeId = routeId;
        if (secretRef) node.config.secretRef = secretRef;
        node.config.hasSecret = !!secretRef;
      }

      if (node.kind === "trigger" && node.triggerKind === "github") {
        node.config = normalizeGithubTriggerConfig(node.config);
      }

      return node;
    });

    const ids = new Set(nodes.map((n) => n.id));
    const edges = (Array.isArray(rawEdges) ? rawEdges : [])
      .filter((e) => e && ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
      .map((e) => ({
        id: clampStr(e.id, 80) || "e_" + randomUUID().slice(0, 8),
        from: e.from,
        to: e.to,
        branch: clampStr(e.branch, 32) || "default",
      }));

    autoLayoutNodes(nodes, edges);
    return { nodes, edges };
  }

  /** Creates a new workflow. `strictFields: true` rejects missing/ambiguous/partial fields (used by bot tools). */
  create(data, { strictFields = false } = {}) {
    const name = clampStr(data?.name, 80);
    if (!name) throw new Error("Workflow name is required.");
    const now = Date.now();
    const { nodes, edges } = this.normalizeGraph(data?.nodes ?? [], data?.edges ?? []);
    const wf = {
      id: randomUUID(),
      name,
      description: clampStr(data?.description, 500),
      enabled: data?.enabled !== false,
      pausedAt: data?.enabled === false ? now : null,
      nodes,
      edges,
      createdAt: now,
      updatedAt: now,
    };

    const check = validateWorkflow(wf, { strictFields });
    if (!check.valid) throw new Error(check.errors.join(" "));

    // Ensure every webhook trigger has a vault-backed secret ready on creation if vault is available.
    this.ensureWebhookSecrets(wf);

    this.all.unshift(wf);
    this.ws.save();
    return sanitizeWorkflow(wf);
  }

  /** Updates an existing workflow's metadata, nodes, edges, or enabled state. */
  update(id, patch, { strictFields = false } = {}) {
    const wf = this.get(id);
    const nextName = patch?.name !== undefined ? clampStr(patch.name, 80) : wf.name;
    if (!nextName) throw new Error("Workflow name is required.");

    const graph =
      patch?.nodes !== undefined || patch?.edges !== undefined
        ? this.normalizeGraph(patch.nodes ?? wf.nodes, patch.edges ?? wf.edges, wf.nodes)
        : { nodes: wf.nodes, edges: wf.edges };

    const candidate = {
      ...wf,
      name: nextName,
      description: patch?.description !== undefined ? clampStr(patch.description, 500) : wf.description,
      nodes: graph.nodes,
      edges: graph.edges,
      updatedAt: Date.now(),
    };

    const check = validateWorkflow(candidate, { strictFields });
    if (!check.valid) throw new Error(check.errors.join(" "));

    wf.name = candidate.name;
    wf.description = candidate.description;
    wf.nodes = candidate.nodes;
    wf.edges = candidate.edges;
    wf.updatedAt = candidate.updatedAt;

    this.ensureWebhookSecrets(wf);

    if (patch?.enabled === false && wf.enabled) {
      wf.enabled = false;
      wf.pausedAt = Date.now();
    } else if (patch?.enabled === true && !wf.enabled) {
      this.applyResume(wf, Date.now());
    }

    this.ws.save();
    return sanitizeWorkflow(wf);
  }

  ensureWebhookSecrets(wf) {
    if (!this.ws.vault || this.ws.vault.locked) return;
    for (const node of wf.nodes) {
      if (node.kind === "trigger" && node.triggerKind === "webhook" && !node.config.secretRef) {
        const secret = "whsec_" + randomBytes(24).toString("hex");
        const ref = this.ws.vault.put(secret, {
          label: `Webhook · ${wf.name}`,
          kind: "workflow-webhook",
          owner: "workflow:" + wf.id,
        });
        node.config.secretRef = ref;
        node.config.hasSecret = true;
      }
    }
  }

  /** Generates a fresh webhook secret in the vault and returns the plaintext once for the person to copy. */
  rotateWebhookSecret(workflowId, nodeId) {
    const wf = this.get(workflowId);
    const node = wf.nodes.find((n) => n.id === nodeId && n.kind === "trigger" && n.triggerKind === "webhook");
    if (!node) throw new Error("Webhook trigger node not found.");
    if (!this.ws.vault || this.ws.vault.locked) throw new Error("Credential vault is unavailable.");
    const secret = "whsec_" + randomBytes(24).toString("hex");
    if (node.config.secretRef) {
      try {
        this.ws.vault.remove(node.config.secretRef);
      } catch {}
    }
    node.config.routeId ||= randomBytes(12).toString("hex");
    node.config.secretRef = this.ws.vault.put(secret, {
      label: `Webhook · ${wf.name}`,
      kind: "workflow-webhook",
      owner: "workflow:" + wf.id,
    });
    node.config.hasSecret = true;
    wf.updatedAt = Date.now();
    this.ws.save();
    return { routeId: node.config.routeId, secret };
  }

  /** Pauses a workflow: event & schedule triggers stop firing; manual runs still work. */
  pause(id) {
    const wf = this.get(id);
    wf.enabled = false;
    wf.pausedAt = Date.now();
    wf.updatedAt = wf.pausedAt;
    this.ws.save();
    return sanitizeWorkflow(wf);
  }

  applyResume(wf, now = Date.now()) {
    wf.enabled = true;
    wf.pausedAt = null;
    wf.updatedAt = now;
    // Skip any schedule occurrences missed while paused by advancing nextAt past `now`.
    for (const node of wf.nodes) {
      if (node.kind === "trigger" && node.triggerKind === "schedule" && node.config?.cron) {
        node.config.nextAt = nextTime(node.config.cron, node.config.timezone || localZone(), now);
      }
    }
  }

  /** Resumes a paused workflow, advancing schedule triggers past now so missed runs are skipped. */
  resume(id, now = Date.now()) {
    const wf = this.get(id);
    this.applyResume(wf, now);
    this.ws.save();
    return sanitizeWorkflow(wf);
  }

  /** Deletes a workflow and its vault-owned webhook secrets. */
  remove(id) {
    const wf = this.get(id);
    if (this.ws.vault && !this.ws.vault.locked) {
      for (const node of wf.nodes) {
        if (node.config?.secretRef) {
          try {
            this.ws.vault.remove(node.config.secretRef);
          } catch {}
        }
      }
    }
    this.ws.state.workflows = this.all.filter((w) => w.id !== id);
    this.ws.save();
    return true;
  }

  /** Exports a workflow as portable JSON (agents by name, no secrets). */
  exportJson(id, appVersion = "0.17.17") {
    const wf = this.get(id);
    return exportWorkflow(wf, this.ws.state.bots ?? [], appVersion);
  }

  /** Imports a portable JSON workflow. Starts paused (`enabled: false`). */
  importJson(raw, agentMap = {}) {
    const { draft, unresolvedAgents } = parseImportedWorkflow(raw, this.ws.state.bots ?? [], agentMap);
    const created = this.create(draft, { strictFields: false });
    return { workflow: created, unresolvedAgents };
  }

  /** Returns whether this workflow currently has an open (running or waiting_approval) run. */
  hasOpenRun(workflowId) {
    return this.runs.some((r) => r.workflowId === workflowId && ACTIVE_STATUSES.has(r.status));
  }

  /** Starts a workflow manually (works even when the workflow is paused!). */
  runManual(workflowId, { triggerNodeId = null, inputs = {}, triggeredBy = "person" } = {}) {
    const wf = this.get(workflowId);
    let trigger =
      (triggerNodeId ? wf.nodes.find((n) => n.id === triggerNodeId && n.kind === "trigger") : null) ||
      wf.nodes.find((n) => n.kind === "trigger" && n.triggerKind === "manual") ||
      wf.nodes.find((n) => n.kind === "trigger");
    if (!trigger) throw new Error("Workflow has no trigger node.");

    // Validate required declared inputs on manual triggers
    const declaredInputs = Array.isArray(trigger.config?.inputs) ? trigger.config.inputs : [];
    const provided = inputs && typeof inputs === "object" ? inputs : {};
    const extraFields = {};
    for (const spec of declaredInputs) {
      if (!spec?.name) continue;
      const val = provided[spec.name];
      if ((val === undefined || val === null || val === "") && spec.required) {
        throw new Error(`Missing required input "${spec.name}".`);
      }
      if (val !== undefined && val !== null) extraFields[spec.name] = val;
    }

    const basePayload =
      trigger.triggerKind === "schedule"
        ? formatLocalParts(Date.now(), trigger.config?.timezone || localZone())
        : {
            run_time: new Date().toISOString(),
            triggered_by: triggeredBy,
            ...provided,
            ...extraFields,
          };

    return this.startRun(wf, trigger, basePayload, { manual: true });
  }

  /**
   * Periodic tick (called every ~5s from runtime.mjs):
   * 1. Fires due schedule triggers (one open run per workflow; missed occurrences collapse to one run).
   * 2. Polls enabled GitHub triggers on their configured interval.
   */
  tick(now = Date.now()) {
    let dirty = false;
    const pendingPolls = [];
    for (const wf of this.all) {
      if (!wf.enabled) continue;
      for (const node of wf.nodes) {
        if (node.kind !== "trigger") continue;

        if (node.triggerKind === "schedule" && node.config?.cron) {
          const tz = node.config.timezone || localZone();
          if (typeof node.config.nextAt !== "number") {
            node.config.nextAt = nextTime(node.config.cron, tz, now);
            dirty = true;
            continue;
          }
          if (node.config.nextAt <= now) {
            // Advance past `now` first so multiple missed occurrences collapse into ONE run.
            node.config.nextAt = nextTime(node.config.cron, tz, now);
            dirty = true;
            // One open run per workflow for schedule triggers.
            if (this.hasOpenRun(wf.id)) continue;
            const payload = formatLocalParts(now, tz);
            this.startRun(wf, node, payload);
          }
        }

        if (node.triggerKind === "github" && normalizeGithubRepos(node.config).length > 0) {
          const key = `${wf.id}:${node.id}`;
          const intervalMs = Math.max(1, Number(node.config.pollMinutes) || 5) * 60_000;
          const last = this.githubLastPoll.get(key) ?? 0;
          if (!this.githubPolling.has(key) && now - last >= intervalMs) {
            this.githubLastPoll.set(key, now);
            const p = this.pollGithubTrigger(wf, node, key);
            pendingPolls.push(p);
          }
        }
      }
    }
    if (dirty) this.ws.save();
    return pendingPolls.length ? Promise.all(pendingPolls) : undefined;
  }

  /** Polls GitHub PRs, issues, comments, and mentions across all configured `repos[]` and fires matching events. */
  async pollGithubTrigger(wf, node, key) {
    if (this.githubPolling.has(key)) return;
    this.githubPolling.add(key);
    try {
      const repos = normalizeGithubRepos(node.config);
      if (!repos.length) return;
      for (const repo of repos) {
        await this.pollGithubTriggerRepo(wf, node, `${key}:${repo.toLowerCase()}`, repo);
      }
    } catch {
      // Quiet on transient poll errors; next tick retries.
    } finally {
      this.githubPolling.delete(key);
    }
  }

  async pollGithubTriggerRepo(wf, node, cursorKey, repo) {
    const rawBatch = await this.githubPoller(repo, node.config);
    const batch = Array.isArray(rawBatch)
      ? { prs: rawBatch, issues: [], comments: [], viewerLogin: "" }
      : {
          prs: Array.isArray(rawBatch?.prs) ? rawBatch.prs : [],
          issues: Array.isArray(rawBatch?.issues) ? rawBatch.issues : [],
          comments: Array.isArray(rawBatch?.comments) ? rawBatch.comments : [],
          viewerLogin: typeof rawBatch?.viewerLogin === "string" ? rawBatch.viewerLogin.trim().replace(/^@/, "") : "",
        };

    let cursor = this.githubCursors.get(cursorKey);
    // Legacy configs (single `repo` without `repos`, or explicit legacy event names) keep legacy poll event names
    // when no canonical event names were supplied, unless `config.events` uses canonical names.
    const legacyList = Array.isArray(node.config?._legacyEvents) ? node.config._legacyEvents : [];
    const evInfo = normalizeGithubEvents(node.config?.events);
    const hasExplicitCanonical = Array.isArray(node.config?.events) && node.config.events.length > 0 && legacyList.length === 0;
    const useLegacyNames = legacyList.length > 0 || (!hasExplicitCanonical && node.config?._legacyRepoOnly === true);
    const rawWantedSet = new Set(legacyList.map((e) => e.toLowerCase()));
    const canonicalSet = new Set(evInfo.canonical);
    const wantsAll = !evInfo.explicit;

    const wantsLegacy = (legacyEv) => useLegacyNames && (wantsAll || rawWantedSet.has(legacyEv));
    const wantsCanonical = (canonicalEv) => !useLegacyNames && (wantsAll || canonicalSet.has(canonicalEv));

    const mentionHandleStr = Array.isArray(node.config?.mentionHandles) && node.config.mentionHandles.length
      ? node.config.mentionHandles.join(",")
      : node.config?.mentionHandle;
    const botHandles = parseMentionHandles(mentionHandleStr);
    const userHandles = batch.viewerLogin ? parseMentionHandles(batch.viewerLogin, "") : [];
    const combinedHandles = [...new Set([...botHandles, ...userHandles])];

    const checkUserMention = (text) => (wantsLegacy("user_mentioned") && userHandles.length ? findMentionInText(text, userHandles) : null);
    const checkBotMention = (text) => (wantsLegacy("bot_mentioned") && botHandles.length ? findMentionInText(text, botHandles) : null);
    const checkCanonicalMention = (text) => (wantsCanonical("mention") && combinedHandles.length ? findMentionInText(text, combinedHandles) : null);

    const reviewerSet = (pr) => {
      const reqs = Array.isArray(pr.reviewRequests) ? pr.reviewRequests : Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : [];
      return new Set(reqs.map((r) => String(r?.login || r?.name || r || "").toLowerCase()).filter(Boolean));
    };

    const emit = (ev, item, opts) => this.fireGithubEvent(wf, node, repo, ev, item, opts);

    if (!cursor) {
      // First poll seeds current state unless `fireInitial` is explicitly set (useful in tests).
      cursor = { initialized: true, prs: new Map(), issues: new Map(), comments: new Map() };
      for (const pr of batch.prs) {
        const ci = summarizeCiRollup(pr.statusCheckRollup);
        const failConclusion = extractFailingCheckConclusion(pr.statusCheckRollup);
        const review = String(pr.reviewDecision || "NONE").toLowerCase();
        const labelsList = normalizeLabelList(pr.labels);
        const labelsStr = labelsList.join(", ");
        const assigneesList = normalizeAssigneeList(pr.assignees);
        const reviewers = reviewerSet(pr);
        const merged = Boolean(pr.merged || pr.mergedAt || pr.merged_at || String(pr.state || "").toLowerCase() === "merged");
        const fp = githubUpdateFingerprint(pr, labelsStr);
        const text = `${pr.title || ""}\n${pr.body || ""}`;
        const userMatch = checkUserMention(text);
        const botMatch = checkBotMention(text);
        const canonMatch = checkCanonicalMention(text);
        cursor.prs.set(pr.number, {
          review,
          ci,
          failConclusion,
          fp,
          merged,
          labels: new Set(labelsList.map((l) => l.toLowerCase())),
          assignees: new Set(assigneesList.map((a) => a.toLowerCase())),
          reviewers,
          userMentioned: Boolean(userMatch),
          botMentioned: Boolean(botMatch),
          canonicalMentioned: Boolean(canonMatch),
        });
        if (node.config?.fireInitial) {
          if (wantsLegacy("pr_opened")) emit("pr_opened", pr, { itemType: "pr", pullRequest: true, review, ci, labelsList, assigneesList });
          else if (wantsCanonical("pr.opened")) emit("pr.opened", pr, { itemType: "pr", pullRequest: true, review, ci, labelsList, assigneesList });
          if (userMatch) emit("user_mentioned", pr, { itemType: "pr", pullRequest: true, review, ci, labelsList, assigneesList, mention: userMatch });
          if (botMatch) emit("bot_mentioned", pr, { itemType: "pr", pullRequest: true, review, ci, labelsList, assigneesList, mention: botMatch });
          if (canonMatch) emit("mention", pr, { itemType: "pr", pullRequest: true, review, ci, labelsList, assigneesList, mention: canonMatch });
        }
      }
      for (const issue of batch.issues) {
        const labelsList = normalizeLabelList(issue.labels);
        const labelsStr = labelsList.join(", ");
        const assigneesList = normalizeAssigneeList(issue.assignees);
        const state = String(issue.state || "open").toLowerCase();
        const fp = githubUpdateFingerprint(issue, labelsStr);
        const text = `${issue.title || ""}\n${issue.body || ""}`;
        const userMatch = checkUserMention(text);
        const botMatch = checkBotMention(text);
        const canonMatch = checkCanonicalMention(text);
        cursor.issues.set(issue.number, {
          fp,
          state,
          labels: new Set(labelsList.map((l) => l.toLowerCase())),
          assignees: new Set(assigneesList.map((a) => a.toLowerCase())),
          userMentioned: Boolean(userMatch),
          botMentioned: Boolean(botMatch),
          canonicalMentioned: Boolean(canonMatch),
        });
        if (node.config?.fireInitial) {
          if (wantsLegacy("issue_opened")) emit("issue_opened", issue, { itemType: "issue", pullRequest: false, labelsList, assigneesList });
          else if (wantsCanonical("issue.opened")) emit("issue.opened", issue, { itemType: "issue", pullRequest: false, labelsList, assigneesList });
          if (userMatch) emit("user_mentioned", issue, { itemType: "issue", pullRequest: false, labelsList, assigneesList, mention: userMatch });
          if (botMatch) emit("bot_mentioned", issue, { itemType: "issue", pullRequest: false, labelsList, assigneesList, mention: botMatch });
          if (canonMatch) emit("mention", issue, { itemType: "issue", pullRequest: false, labelsList, assigneesList, mention: canonMatch });
        }
      }
      for (const comment of batch.comments) {
        const cid = String(comment.id ?? comment.url ?? "");
        if (!cid) continue;
        const labelsList = normalizeLabelList(comment.labels);
        const labelsStr = labelsList.join(", ");
        const fp = githubUpdateFingerprint(comment, labelsStr);
        const userMatch = checkUserMention(comment.body || "");
        const botMatch = checkBotMention(comment.body || "");
        const canonMatch = checkCanonicalMention(comment.body || "");
        cursor.comments.set(cid, {
          fp,
          userMentioned: Boolean(userMatch),
          botMentioned: Boolean(botMatch),
          canonicalMentioned: Boolean(canonMatch),
        });
        if (node.config?.fireInitial) {
          if (wantsLegacy("issue_comment")) emit("issue_comment", comment, { itemType: "comment", labelsList });
          else if (wantsCanonical("comment")) emit("comment", comment, { itemType: "comment", labelsList });
          if (userMatch) emit("user_mentioned", comment, { itemType: "comment", labelsList, mention: userMatch });
          if (botMatch) emit("bot_mentioned", comment, { itemType: "comment", labelsList, mention: botMatch });
          if (canonMatch) emit("mention", comment, { itemType: "comment", labelsList, mention: canonMatch });
        }
      }
      this.githubCursors.set(cursorKey, cursor);
      return;
    }

    // 1. Pull requests
    for (const pr of batch.prs) {
      const ci = summarizeCiRollup(pr.statusCheckRollup);
      const failConclusion = extractFailingCheckConclusion(pr.statusCheckRollup);
      const review = String(pr.reviewDecision || "NONE").toLowerCase();
      const labelsList = normalizeLabelList(pr.labels);
      const labelsStr = labelsList.join(", ");
      const assigneesList = normalizeAssigneeList(pr.assignees);
      const reviewers = reviewerSet(pr);
      const merged = Boolean(pr.merged || pr.mergedAt || pr.merged_at || String(pr.state || "").toLowerCase() === "merged");
      const fp = githubUpdateFingerprint(pr, labelsStr);
      const text = `${pr.title || ""}\n${pr.body || ""}`;
      const userMatch = checkUserMention(text);
      const botMatch = checkBotMention(text);
      const canonMatch = checkCanonicalMention(text);
      const prev = cursor.prs.get(pr.number);
      const common = { itemType: "pr", pullRequest: true, review, ci, checkConclusion: failConclusion || ci, labelsList, assigneesList, merged };

      if (!prev) {
        cursor.prs.set(pr.number, {
          review,
          ci,
          failConclusion,
          fp,
          merged,
          labels: new Set(labelsList.map((l) => l.toLowerCase())),
          assignees: new Set(assigneesList.map((a) => a.toLowerCase())),
          reviewers,
          userMentioned: Boolean(userMatch),
          botMentioned: Boolean(botMatch),
          canonicalMentioned: Boolean(canonMatch),
        });
        if (wantsLegacy("pr_opened")) emit("pr_opened", pr, common);
        else if (wantsCanonical("pr.opened")) emit("pr.opened", pr, common);
        if (wantsCanonical("assigned") && assigneesList.length) emit("assigned", pr, common);
        if (wantsCanonical("pr.reviewRequested") && reviewers.size) emit("pr.reviewRequested", pr, common);
        if (userMatch) emit("user_mentioned", pr, { ...common, mention: userMatch });
        if (botMatch) emit("bot_mentioned", pr, { ...common, mention: botMatch });
        if (canonMatch) emit("mention", pr, { ...common, mention: canonMatch });
      } else {
        if (prev.review !== review) {
          prev.review = review;
          if (wantsLegacy("pr_review")) emit("pr_review", pr, common);
          else if (wantsCanonical("pr.reviewSubmitted")) emit("pr.reviewSubmitted", pr, common);
        }
        if (prev.ci !== ci || prev.failConclusion !== failConclusion) {
          prev.ci = ci;
          prev.failConclusion = failConclusion;
          if (wantsLegacy("ci_status")) emit("ci_status", pr, common);
          else if (wantsCanonical("pr.checksFailed") && (failConclusion || ci === "failing")) {
            emit("pr.checksFailed", pr, { ...common, checkConclusion: failConclusion || "failure" });
          }
        }
        if (!prev.merged && merged) {
          prev.merged = true;
          if (wantsCanonical("pr.merged")) emit("pr.merged", pr, { ...common, state: "merged", merged: true });
        }
        const addedReviewers = [...reviewers].filter((r) => !prev.reviewers.has(r));
        if (addedReviewers.length) {
          prev.reviewers = reviewers;
          if (wantsCanonical("pr.reviewRequested")) emit("pr.reviewRequested", pr, common);
        }
        const addedAssignees = assigneesList.filter((a) => !prev.assignees.has(a.toLowerCase()));
        if (addedAssignees.length) {
          prev.assignees = new Set(assigneesList.map((a) => a.toLowerCase()));
          if (wantsCanonical("assigned")) emit("assigned", pr, common);
        }
        if (prev.fp !== fp) {
          prev.fp = fp;
          if (wantsLegacy("pr_updated")) emit("pr_updated", pr, common);
          else if (wantsCanonical("pr.updated")) emit("pr.updated", pr, common);
        }
        if (userMatch && !prev.userMentioned) {
          prev.userMentioned = true;
          emit("user_mentioned", pr, { ...common, mention: userMatch });
        } else if (!userMatch) {
          prev.userMentioned = false;
        }
        if (botMatch && !prev.botMentioned) {
          prev.botMentioned = true;
          emit("bot_mentioned", pr, { ...common, mention: botMatch });
        } else if (!botMatch) {
          prev.botMentioned = false;
        }
        if (canonMatch && !prev.canonicalMentioned) {
          prev.canonicalMentioned = true;
          emit("mention", pr, { ...common, mention: canonMatch });
        } else if (!canonMatch) {
          prev.canonicalMentioned = false;
        }
      }
    }

    // 2. Issues
    for (const issue of batch.issues) {
      const labelsList = normalizeLabelList(issue.labels);
      const labelsStr = labelsList.join(", ");
      const assigneesList = normalizeAssigneeList(issue.assignees);
      const state = String(issue.state || "open").toLowerCase();
      const fp = githubUpdateFingerprint(issue, labelsStr);
      const text = `${issue.title || ""}\n${issue.body || ""}`;
      const userMatch = checkUserMention(text);
      const botMatch = checkBotMention(text);
      const canonMatch = checkCanonicalMention(text);
      const prev = cursor.issues.get(issue.number);
      const common = { itemType: "issue", pullRequest: false, labelsList, assigneesList, state };

      if (!prev) {
        cursor.issues.set(issue.number, {
          fp,
          state,
          labels: new Set(labelsList.map((l) => l.toLowerCase())),
          assignees: new Set(assigneesList.map((a) => a.toLowerCase())),
          userMentioned: Boolean(userMatch),
          botMentioned: Boolean(botMatch),
          canonicalMentioned: Boolean(canonMatch),
        });
        if (wantsLegacy("issue_opened")) emit("issue_opened", issue, common);
        else if (wantsCanonical("issue.opened")) emit("issue.opened", issue, common);
        if (wantsCanonical("assigned") && assigneesList.length) emit("assigned", issue, common);
        if (userMatch) emit("user_mentioned", issue, { ...common, mention: userMatch });
        if (botMatch) emit("bot_mentioned", issue, { ...common, mention: botMatch });
        if (canonMatch) emit("mention", issue, { ...common, mention: canonMatch });
      } else {
        if (prev.state !== "closed" && state === "closed") {
          if (wantsCanonical("issue.closed")) emit("issue.closed", issue, common);
        }
        prev.state = state;

        const newlyAddedLabels = labelsList.filter((l) => !prev.labels.has(l.toLowerCase()));
        if (newlyAddedLabels.length) {
          prev.labels = new Set(labelsList.map((l) => l.toLowerCase()));
          if (wantsCanonical("issue.labeled")) {
            for (const addedLabel of newlyAddedLabels) {
              emit("issue.labeled", issue, { ...common, addedLabel });
            }
          }
        }
        const newlyAddedAssignees = assigneesList.filter((a) => !prev.assignees.has(a.toLowerCase()));
        if (newlyAddedAssignees.length) {
          prev.assignees = new Set(assigneesList.map((a) => a.toLowerCase()));
          if (wantsCanonical("assigned")) emit("assigned", issue, common);
        }
        if (prev.fp !== fp) {
          prev.fp = fp;
          if (wantsLegacy("issue_updated")) emit("issue_updated", issue, common);
        }
        if (userMatch && !prev.userMentioned) {
          prev.userMentioned = true;
          emit("user_mentioned", issue, { ...common, mention: userMatch });
        } else if (!userMatch) {
          prev.userMentioned = false;
        }
        if (botMatch && !prev.botMentioned) {
          prev.botMentioned = true;
          emit("bot_mentioned", issue, { ...common, mention: botMatch });
        } else if (!botMatch) {
          prev.botMentioned = false;
        }
        if (canonMatch && !prev.canonicalMentioned) {
          prev.canonicalMentioned = true;
          emit("mention", issue, { ...common, mention: canonMatch });
        } else if (!canonMatch) {
          prev.canonicalMentioned = false;
        }
      }
    }

    // 3. Issue & PR comments
    for (const comment of batch.comments) {
      const cid = String(comment.id ?? comment.url ?? "");
      if (!cid) continue;
      const labelsList = normalizeLabelList(comment.labels);
      const labelsStr = labelsList.join(", ");
      const fp = githubUpdateFingerprint(comment, labelsStr);
      const userMatch = checkUserMention(comment.body || "");
      const botMatch = checkBotMention(comment.body || "");
      const canonMatch = checkCanonicalMention(comment.body || "");
      const prev = cursor.comments.get(cid);
      const common = { itemType: "comment", labelsList };

      if (!prev) {
        cursor.comments.set(cid, {
          fp,
          userMentioned: Boolean(userMatch),
          botMentioned: Boolean(botMatch),
          canonicalMentioned: Boolean(canonMatch),
        });
        if (wantsLegacy("issue_comment")) emit("issue_comment", comment, common);
        else if (wantsCanonical("comment")) emit("comment", comment, common);
        if (userMatch) emit("user_mentioned", comment, { ...common, mention: userMatch });
        if (botMatch) emit("bot_mentioned", comment, { ...common, mention: botMatch });
        if (canonMatch) emit("mention", comment, { ...common, mention: canonMatch });
      } else {
        if (prev.fp !== fp) prev.fp = fp;
        if (userMatch && !prev.userMentioned) {
          prev.userMentioned = true;
          emit("user_mentioned", comment, { ...common, mention: userMatch });
        } else if (!userMatch) {
          prev.userMentioned = false;
        }
        if (botMatch && !prev.botMentioned) {
          prev.botMentioned = true;
          emit("bot_mentioned", comment, { ...common, mention: botMatch });
        } else if (!botMatch) {
          prev.botMentioned = false;
        }
        if (canonMatch && !prev.canonicalMentioned) {
          prev.canonicalMentioned = true;
          emit("mention", comment, { ...common, mention: canonMatch });
        } else if (!canonMatch) {
          prev.canonicalMentioned = false;
        }
      }
    }
  }

  fireGithubEvent(wf, node, repo, event, item, opts = {}) {
    if (!wf.enabled) return;
    const payload = buildGithubTriggerPayload(repo, event, item, opts);
    const filterResult = evaluateGithubTriggerFilters(node.config, payload, {
      sender: opts.sender ?? item.sender ?? item.user ?? item.author,
      author: item.author ?? item.user,
    });
    const deliveryId = opts.deliveryId || `poll:${repo}:${event}:${payload.number || 0}:${Date.now()}:${randomUUID().slice(0, 6)}`;
    let payloadJson = null;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {}

    if (!filterResult.pass) {
      this.recordGithubDelivery({
        workflowId: wf.id,
        nodeId: node.id,
        deliveryId,
        event: String(payload.event || event),
        repository: repo || null,
        number: Number(payload.number) || null,
        pullRequest: typeof payload.pull_request === "boolean" ? payload.pull_request : null,
        title: typeof payload.title === "string" && payload.title ? payload.title : null,
        url: typeof payload.url === "string" && payload.url ? payload.url : null,
        receivedAt: new Date().toISOString(),
        outcome: "skipped",
        reason: "filter",
        reasonDetail: filterResult.reason || null,
        runId: null,
        payloadJson: null,
      });
      return;
    }

    const run = this.startRun(wf, node, payload);
    this.recordGithubDelivery({
      workflowId: wf.id,
      nodeId: node.id,
      deliveryId,
      event: String(payload.event || event),
      repository: repo || null,
      number: Number(payload.number) || null,
      pullRequest: typeof payload.pull_request === "boolean" ? payload.pull_request : null,
      title: typeof payload.title === "string" && payload.title ? payload.title : null,
      url: typeof payload.url === "string" && payload.url ? payload.url : null,
      receivedAt: new Date().toISOString(),
      outcome: "started",
      reason: null,
      reasonDetail: null,
      runId: run.id,
      payloadJson,
    });
  }

  /** Handles Task Board created & status-changed events. */
  async onTaskEvent(eventKind, { task, from, to }) {
    if (!task) return;
    const bot = task.botId ? this.ws.state.bots.find((b) => b.id === task.botId) : null;
    const botName = bot?.name ?? "";

    for (const wf of this.all) {
      if (!wf.enabled) continue;
      for (const node of wf.nodes) {
        if (node.kind !== "trigger" || node.triggerKind !== "task") continue;
        const cfg = node.config ?? {};
        const wantedEvent = cfg.event || "status_changed";
        if (wantedEvent !== "any" && wantedEvent !== eventKind) continue;
        if (cfg.taskId && cfg.taskId !== task.id) continue;
        if (cfg.titleContains && !String(task.title || "").toLowerCase().includes(String(cfg.titleContains).toLowerCase())) continue;
        if (cfg.botId && cfg.botId !== task.botId) continue;
        if (!cfg.botId && cfg.botName && botName.toLowerCase() !== String(cfg.botName).toLowerCase()) continue;

        const fromList = normalizeStatusList(cfg.fromStatus);
        if (fromList.length && !fromList.includes(String(from ?? "").toLowerCase())) continue;
        const toList = normalizeStatusList(cfg.toStatus);
        if (toList.length && !toList.includes(String(to ?? task.status ?? "").toLowerCase())) continue;

        this.startRun(wf, node, {
          id: task.id,
          title: task.title || "",
          bot: botName,
          from: from ?? "",
          to: to ?? task.status ?? "",
          result: task.result ?? "",
          problem: task.problem ?? "",
          priority: task.priority ?? "normal",
        });
      }
    }
  }

  /** Handles finished turns: resolves in-flight agent steps and fires Routine-finished triggers. */
  onTurnFinished(chat, run) {
    if (!run) return;

    // 1. Resolve in-flight workflow agent step waiting on this turn.
    const waiter = this.waitingTurns.get(run.id);
    if (waiter) {
      this.waitingTurns.delete(run.id);
      const reply = this.extractTurnReply(chat, run);
      if (run.status === "Stopped" || run.ending === "stopped") {
        waiter.reject(new Error("Agent step was stopped."));
      } else if (run.status === "Needs you" || run.ending === "failed") {
        waiter.reject(new Error(run.detail || "Agent step failed."));
      } else {
        waiter.resolve({ reply, structuredAnswer: waiter.structuredAnswer, chatId: chat.id, runId: run.id });
      }
      return;
    }

    // 2. Fire Routine-finished triggers when an existing cron routine completes.
    if (run.scheduleId == null || !chat) return;
    const sched = (chat.schedules ?? []).find((s) => s.id === run.scheduleId && s.routine);
    if (!sched) return;

    const bot = this.ws.state.bots.find((b) => b.id === chat.botId);
    const botName = bot?.name ?? "";
    const result = this.extractTurnReply(chat, run);
    const status = run.ending === "failed" || run.status === "Needs you" ? "failed" : run.ending === "stopped" ? "stopped" : "done";

    for (const wf of this.all) {
      if (!wf.enabled) continue;
      for (const node of wf.nodes) {
        if (node.kind !== "trigger" || node.triggerKind !== "routine") continue;
        const cfg = node.config ?? {};
        if (cfg.routineChatId && cfg.routineChatId !== chat.id) continue;
        if (cfg.routineName && !String(chat.title || "").toLowerCase().includes(String(cfg.routineName).toLowerCase())) continue;
        if (cfg.botId && cfg.botId !== chat.botId) continue;
        if (cfg.onlyOnStatus && cfg.onlyOnStatus !== "any" && cfg.onlyOnStatus !== status) continue;

        this.startRun(wf, node, {
          routine_id: chat.id,
          routine_name: chat.title || "Routine",
          bot: botName,
          status,
          result,
          run_id: run.id,
          finished_at: new Date(run.finished || Date.now()).toISOString(),
        });
      }
    }
  }

  /** Handles ordinary chat messages to a bot (or @mentions). */
  async onChatMessage({ chat, bot, text, sender, time }) {
    if (!chat || !text) return;
    const botName = bot?.name ?? "";
    const lowText = String(text).toLowerCase();

    for (const wf of this.all) {
      if (!wf.enabled) continue;
      for (const node of wf.nodes) {
        if (node.kind !== "trigger" || node.triggerKind !== "chat") continue;
        const cfg = node.config ?? {};
        if (cfg.chatId && cfg.chatId !== chat.id) continue;
        if (cfg.botId && cfg.botId !== chat.botId) continue;
        if (cfg.mentionOnly) {
          const targetName = cfg.botId
            ? this.ws.state.bots.find((b) => b.id === cfg.botId)?.name ?? botName
            : botName;
          if (!targetName || !lowText.includes("@" + targetName.toLowerCase())) continue;
        }
        if (cfg.textContains && !lowText.includes(String(cfg.textContains).toLowerCase())) continue;

        this.startRun(wf, node, {
          chat_id: chat.id,
          chat_title: chat.title || "",
          bot: botName,
          sender: sender || "owner",
          text: String(text),
          time: new Date(time || Date.now()).toISOString(),
        });
      }
    }
  }

  /** Handles inbound messages from external Channel Hooks (Slack, Telegram, Discord, iMessage). */
  onChannelMessage({ channel, connection, conversation, sender, text, isDirect, mentionsBot } = {}) {
    if (!channel || !connection) return;
    const lowText = String(text ?? "").toLowerCase();
    for (const wf of this.all) {
      if (!wf.enabled) continue;
      for (const node of wf.nodes) {
        if (node.kind !== "trigger" || node.triggerKind !== "channel") continue;
        const cfg = node.config ?? {};
        if (cfg.channel && String(cfg.channel).toLowerCase() !== String(channel).toLowerCase()) continue;
        if (cfg.connection && cfg.connection !== connection) continue;
        if (cfg.conversation && cfg.conversation !== conversation) continue;
        if (cfg.sender && cfg.sender !== sender) continue;
        // (directOnly and mentionOnly are what the window saved before it used the trigger's own field names.)
        const direct = cfg.isDirect ?? (cfg.directOnly === true ? true : undefined);
        if (direct === true && !isDirect) continue;
        if (direct === false && isDirect) continue;
        if ((cfg.mentionsBot === true || cfg.mentionOnly === true) && !mentionsBot) continue;
        if (cfg.textContains && !lowText.includes(String(cfg.textContains).toLowerCase())) continue;

        this.startRun(wf, node, {
          channel: String(channel),
          connection: String(connection),
          conversation: String(conversation ?? ""),
          sender: String(sender ?? ""),
          text: String(text ?? ""),
          isDirect: Boolean(isDirect),
          mentionsBot: Boolean(mentionsBot),
        });
      }
    }
  }

  /**
   * Handles incoming local webhook HTTP requests (`POST /botkins/v1/webhooks/:routeId`).
   * Enforces 64KB max body, per-workflow secret stored in vault, and case-sensitive declared JSON fields.
   */
  handleWebhook(routeId, { method = "POST", headers = {}, rawBody = "" } = {}) {
    const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");
    if (bodyBuf.length > MAX_WEBHOOK_BYTES) {
      return { status: 413, body: { error: "Payload too large (max 64 KB)." } };
    }

    let matchWf = null;
    let matchNode = null;
    for (const wf of this.all) {
      const node = wf.nodes.find((n) => n.kind === "trigger" && n.triggerKind === "webhook" && n.config?.routeId === routeId);
      if (node) {
        matchWf = wf;
        matchNode = node;
        break;
      }
    }
    if (!matchWf || !matchNode) {
      return { status: 404, body: { error: "Webhook route not found." } };
    }
    if (!matchWf.enabled) {
      return { status: 409, body: { error: "Workflow is paused." } };
    }

    const expectedSecret = matchNode.config?.secretRef ? this.ws.vault?.get(matchNode.config.secretRef) : null;
    if (!expectedSecret) {
      return { status: 401, body: { error: "Webhook secret is not configured." } };
    }

    // Normalize header keys to lowercase
    const hdr = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      hdr[k.toLowerCase()] = Array.isArray(v) ? v[0] : String(v ?? "");
    }

    const authHeader = hdr["authorization"] || "";
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const direct = hdr["x-botkins-secret"] || "";
    const sigHeader = hdr["x-hub-signature-256"] || hdr["x-botkins-signature"] || "";
    const expectedHmac = "sha256=" + createHmac("sha256", expectedSecret).update(bodyBuf).digest("hex");

    const authorized =
      (bearer && safeEqual(bearer, expectedSecret)) ||
      (direct && safeEqual(direct, expectedSecret)) ||
      (sigHeader && safeEqual(sigHeader.trim(), expectedHmac));

    if (!authorized) {
      return { status: 401, body: { error: "Unauthorized webhook secret." } };
    }

    const rawText = bodyBuf.toString("utf8");
    let parsedJson = null;
    if (rawText.trim()) {
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        parsedJson = null;
      }
    }

    const payload = {
      body: rawText,
      payload: parsedJson !== null ? JSON.stringify(parsedJson, null, 2) : rawText,
      method: String(method).toUpperCase(),
      received_at: new Date().toISOString(),
    };

    // Extract declared webhook fields with exact case-sensitive key matching.
    const declaredFields = Array.isArray(matchNode.config?.fields) ? matchNode.config.fields : [];
    if (parsedJson && typeof parsedJson === "object") {
      for (const spec of declaredFields) {
        if (!spec?.name) continue;
        const val = lookupField(parsedJson, spec.path || spec.name);
        if (val !== undefined) payload[spec.name] = val;
      }
    }

    const run = this.startRun(matchWf, matchNode, payload);
    return { status: 202, body: { ok: true, runId: run.id, workflowId: matchWf.id } };
  }

  /** Creates a run record and begins executing the workflow graph asynchronously. */
  startRun(wf, triggerNode, triggerPayload, { manual = false, replay = false } = {}) {
    const now = Date.now();
    const steps = {};
    for (const node of wf.nodes) {
      steps[node.id] = {
        nodeId: node.id,
        kind: node.kind,
        label: node.label,
        status: node.id === triggerNode.id ? "completed" : "pending",
        ...(node.id === triggerNode.id ? { startedAt: now, finishedAt: now, outputs: structuredClone(triggerPayload) } : {}),
      };
    }

    const run = {
      id: randomUUID(),
      workflowId: wf.id,
      workflowName: wf.name,
      triggerNodeId: triggerNode.id,
      triggerKind: triggerNode.triggerKind,
      manual,
      ...(replay ? { replay: true } : {}),
      status: "running",
      startedAt: now,
      finishedAt: null,
      error: null,
      pendingApproval: null,
      context: structuredClone(triggerPayload),
      steps,
    };

    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
    this.ws.save();

    this.launchExecution(run.id);
    return run;
  }

  /**
   * Retries a failed (or rejected/cancelled) run from `fromNodeId` (or its first failed step),
   * using the workflow's CURRENT node settings and preserving completed upstream outputs.
   */
  retryRun(runId, fromNodeId = null, options = {}) {
    const run = this.getRun(runId);
    if (ACTIVE_STATUSES.has(run.status)) throw new Error("This run is already active.");
    const wf = this.get(run.workflowId);

    const targetId =
      fromNodeId ||
      Object.values(run.steps).find((s) => s.status === "failed")?.nodeId ||
      Object.values(run.steps).find((s) => s.status === "rejected")?.nodeId;
    if (!targetId) throw new Error("No failed step found to retry.");
    const targetNode = wf.nodes.find((n) => n.id === targetId);
    if (!targetNode) throw new Error("That step no longer exists in the workflow.");

    // Find target and all its downstream descendants in the CURRENT graph.
    const outgoing = new Map(wf.nodes.map((n) => [n.id, []]));
    for (const e of wf.edges) outgoing.get(e.from)?.push(e.to);

    const toReset = new Set([targetId]);
    const queue = [targetId];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of outgoing.get(cur) ?? []) {
        if (!toReset.has(next)) {
          toReset.add(next);
          queue.push(next);
        }
      }
    }

    // Ensure any newly added nodes in the current workflow exist in run.steps.
    for (const node of wf.nodes) {
      if (!run.steps[node.id] || toReset.has(node.id)) {
        run.steps[node.id] = {
          nodeId: node.id,
          kind: node.kind,
          label: node.label,
          status: "pending",
        };
      } else {
        run.steps[node.id].label = node.label;
      }
    }

    // Rebuild run.context cleanly from surviving completed steps so stale outputs from failed/downstream steps don't leak.
    const rebuilt = {};
    const ordered = Object.values(run.steps)
      .filter((s) => s.status === "completed" && s.outputs && typeof s.outputs === "object")
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const st of ordered) Object.assign(rebuilt, st.outputs);

    run.context = rebuilt;
    run.status = "running";
    run.finishedAt = null;
    run.error = null;
    run.errorCode = null;
    run.githubUncertain = null;
    run.pendingApproval = null;
    run.retriedAt = Date.now();
    run.retryPass = (Number(run.retryPass) || 0) + 1;
    run.allowUncertainRetry = options?.allowUncertainRetry === true;
    this.ws.save();

    this.launchExecution(run.id);
    return run;
  }

  /** Responds to a waiting approval step ("approved" or "rejected") and resumes the run. */
  respondApproval(runId, nodeId, decision, note = "") {
    const run = this.getRun(runId);
    if (run.status !== "waiting_approval") throw new Error("This run is not waiting for approval.");
    const targetNodeId = nodeId || run.pendingApproval?.nodeId;
    const step = run.steps[targetNodeId];
    if (!step || step.status !== "waiting_approval") throw new Error("That step is not waiting for approval.");
    const norm = String(decision || "").toLowerCase();
    if (norm !== "approved" && norm !== "rejected") throw new Error("Decision must be 'approved' or 'rejected'.");

    const wf = this.get(run.workflowId);
    const node = wf.nodes.find((n) => n.id === targetNodeId);
    const now = Date.now();
    const outputs = { approval_decision: norm };
    if (node?.config?.noteField && isValidFieldName(node.config.noteField)) {
      outputs[node.config.noteField] = String(note ?? "");
    }

    step.status = "completed";
    step.branch = norm;
    step.decision = norm;
    step.note = String(note ?? "").slice(0, 1000);
    step.outputs = outputs;
    step.finishedAt = now;
    Object.assign(run.context, outputs);
    run.pendingApproval = null;

    // If rejected and there is no outgoing "rejected" branch, finish the run as cancelled/rejected cleanly.
    const rejectedEdges = wf.edges.filter((e) => e.from === targetNodeId && e.branch === "rejected");
    if (norm === "rejected" && !rejectedEdges.length) {
      step.status = "rejected";
      run.status = "cancelled";
      run.finishedAt = now;
      run.error = note ? `Rejected: ${note}` : "Rejected by person.";
      this.markUntakenPendingAsSkipped(wf, run);
      this.ws.save();
      return run;
    }

    run.status = "running";
    this.ws.save();
    this.launchExecution(run.id);
    return run;
  }

  /** Cancels an active or waiting run. */
  cancelRun(runId) {
    const run = this.getRun(runId);
    if (!ACTIVE_STATUSES.has(run.status)) return run;
    run.status = "cancelled";
    run.finishedAt = Date.now();
    run.pendingApproval = null;
    for (const step of Object.values(run.steps)) {
      if (step.status === "running" || step.status === "waiting_approval") {
        step.status = "skipped";
        step.finishedAt = run.finishedAt;
      }
    }
    this.ws.save();
    return run;
  }

  /** Awaits completion (or waiting_approval pause) of an active run. Handy for tests and tools. */
  async waitForRun(runId) {
    const pending = this.activeExecutions.get(runId);
    if (pending) await pending;
    return this.getRun(runId);
  }

  launchExecution(runId) {
    if (this.activeExecutions.has(runId)) return;
    const p = this.executeRun(runId).finally(() => {
      this.activeExecutions.delete(runId);
    });
    this.activeExecutions.set(runId, p);
  }

  markUntakenPendingAsSkipped(wf, run) {
    for (const node of wf.nodes) {
      const st = run.steps[node.id];
      if (st && st.status === "pending") {
        st.status = "skipped";
        st.finishedAt = Date.now();
      }
    }
  }

  /** Computes which pending nodes can run now and which are permanently unreachable (skipped). */
  stepScheduling(wf, run) {
    const incoming = new Map(wf.nodes.map((n) => [n.id, []]));
    for (const e of wf.edges) {
      if (incoming.has(e.to)) incoming.get(e.to).push(e);
    }

    const edgeStatus = (edge) => {
      const src = run.steps[edge.from];
      if (!src) return "dead";
      if (src.status === "skipped" || src.status === "failed" || src.status === "rejected") return "dead";
      if (src.status !== "completed") return "waiting";
      // Check branch matching for condition & approval nodes
      if (src.kind === "condition") {
        const chosen = src.branch || "no";
        return edge.branch === chosen || (edge.branch === "default" && chosen === "yes") ? "active" : "dead";
      }
      if (src.kind === "approval") {
        const chosen = src.branch || "approved";
        return edge.branch === chosen || (edge.branch === "default" && chosen === "approved") ? "active" : "dead";
      }
      return "active";
    };

    const ready = [];
    const newlySkipped = [];

    for (const node of wf.nodes) {
      const st = run.steps[node.id];
      if (!st || st.status !== "pending") continue;
      if (node.kind === "trigger") {
        // Other trigger nodes on the same workflow that didn't fire this run are skipped.
        newlySkipped.push(node.id);
        continue;
      }
      const inc = incoming.get(node.id) ?? [];
      if (!inc.length) {
        newlySkipped.push(node.id);
        continue;
      }
      const states = inc.map(edgeStatus);
      if (states.every((s) => s === "dead")) {
        newlySkipped.push(node.id);
      } else if (states.every((s) => s === "active" || s === "dead") && states.some((s) => s === "active")) {
        ready.push(node);
      }
    }

    return { ready, newlySkipped };
  }

  /** Main DAG runner loop for a single workflow run. */
  async executeRun(runId) {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) return;
    let wf;
    try {
      wf = this.get(run.workflowId);
    } catch {
      run.status = "failed";
      run.error = "Workflow was deleted.";
      run.finishedAt = Date.now();
      this.ws.save();
      return;
    }

    while (run.status === "running") {
      // Refresh wf reference in case it was edited live while running
      wf = this.all.find((w) => w.id === run.workflowId) ?? wf;
      const { ready, newlySkipped } = this.stepScheduling(wf, run);

      if (newlySkipped.length) {
        const now = Date.now();
        for (const id of newlySkipped) {
          run.steps[id].status = "skipped";
          run.steps[id].finishedAt = now;
        }
        this.ws.save();
        continue;
      }

      if (!ready.length) {
        // Check if waiting on approval or finished
        const waiting = Object.values(run.steps).find((s) => s.status === "waiting_approval");
        if (waiting) {
          run.status = "waiting_approval";
          this.ws.save();
          return;
        }
        const failed = Object.values(run.steps).find((s) => s.status === "failed");
        run.status = failed ? "failed" : "completed";
        if (failed && !run.error) run.error = failed.error || "Step failed.";
        run.finishedAt = Date.now();
        this.ws.save();
        return;
      }

      // Execute ready nodes sequentially in deterministic order (safe for shared context and live UI updates).
      for (const node of ready) {
        if (run.status !== "running") break;
        const step = run.steps[node.id];
        step.status = "running";
        step.startedAt = Date.now();
        step.finishedAt = null;
        step.error = null;
        step.errorCode = null;
        step.githubUncertain = null;
        this.ws.save();

        try {
          const outcome = await this.executeNode(wf, run, node);
          if (run.status !== "running") return;

          if (outcome?.waitingApproval) {
            step.status = "waiting_approval";
            step.summary = outcome.message;
            run.status = "waiting_approval";
            run.pendingApproval = {
              nodeId: node.id,
              label: node.label,
              message: outcome.message,
              requestedAt: Date.now(),
            };
            this.ws.save();
            this.ws.events?.emit("workflow.approval", { workflow: sanitizeWorkflow(wf), run, node, message: outcome.message });
            return;
          }

          step.status = "completed";
          step.finishedAt = Date.now();
          if (outcome?.branch) step.branch = outcome.branch;
          if (outcome?.summary) step.summary = outcome.summary;
          if (outcome?.outputs && typeof outcome.outputs === "object") {
            step.outputs = outcome.outputs;
            Object.assign(run.context, outcome.outputs);
          }
          if (outcome?.chatId) step.chatId = outcome.chatId;
          this.ws.save();
        } catch (err) {
          step.status = "failed";
          step.finishedAt = Date.now();
          step.error = err?.message || String(err);
          const uncertain =
            err?.githubUncertain && typeof err.githubUncertain === "object"
              ? {
                  nodeId: node.id,
                  stepLabel: node.label,
                  action: String(err.githubUncertain.action || "comment"),
                  repository: String(err.githubUncertain.repository || ""),
                  number: Number.isInteger(err.githubUncertain.number) ? err.githubUncertain.number : null,
                  pullRequest: typeof err.githubUncertain.pullRequest === "boolean" ? err.githubUncertain.pullRequest : null,
                  url: typeof err.githubUncertain.url === "string" ? err.githubUncertain.url : null,
                }
              : null;
          step.errorCode =
            err?.code === "githubUncertain" || uncertain
              ? "githubUncertain"
              : typeof err?.code === "string" && err.code
                ? err.code
                : null;
          if (uncertain) step.githubUncertain = uncertain;
          run.status = "failed";
          run.error = `${node.label}: ${step.error}`;
          run.errorCode = step.errorCode;
          if (uncertain) run.githubUncertain = uncertain;
          run.finishedAt = Date.now();
          this.ws.save();
          return;
        }
      }
    }
  }

  async executeNode(wf, run, node) {
    switch (node.kind) {
      case "condition": {
        const res = evaluateCondition(node.config, run.context);
        return { branch: res.matched ? "yes" : "no", summary: res.detail };
      }
      case "approval": {
        const message = resolveTemplate(node.config?.message || `Approve step "${node.label}" in workflow "${wf.name}"?`, run.context);
        return { waitingApproval: true, message };
      }
      case "agent":
        return await this.executeAgentNode(wf, run, node);
      case "model":
        return await this.executeModelNode(wf, run, node);
      case "output":
        return await this.executeOutputNode(wf, run, node);
      default:
        throw new Error(`Unsupported step kind "${node.kind}".`);
    }
  }

  resolveBotForNode(node) {
    const bots = this.ws.state.bots ?? [];
    if (node.config?.botId) {
      const exact = bots.find((b) => b.id === node.config.botId);
      if (exact) return exact;
      if (node.config?.botName) {
        const byName = bots.find((b) => b.name.toLowerCase() === String(node.config.botName).toLowerCase());
        if (byName) return byName;
      }
      throw new Error(`Bot "${node.config.botName || node.config.botId}" is no longer available.`);
    }
    if (node.config?.botName) {
      const byName = bots.find((b) => b.name.toLowerCase() === String(node.config.botName).toLowerCase());
      if (byName) return byName;
      throw new Error(`Bot "${node.config.botName}" was not found.`);
    }
    const primary = bots.find((b) => b.primary) ?? bots[0];
    if (!primary) throw new Error("No bot available to run this step.");
    return primary;
  }

  /** Runs an Agent step by handing off to a Botkins bot via `ws.send(...)`; ends when its turn ends. */
  async executeAgentNode(wf, run, node) {
    const bot = this.resolveBotForNode(node);
    const reader = ["github", "webhook", "channel"].includes(run.triggerKind) && !run.manual ? "model" : "person";
    const stepPrompt = resolveTemplate(node.config?.prompt || "", run.context, { reader });
    if (!stepPrompt.trim()) throw new Error("Agent step prompt is empty.");
    const basePrompt = frameExternalPrompt(stepPrompt, run);

    const outputFields = Array.isArray(node.config?.outputFields)
      ? node.config.outputFields.filter((f) => f && isValidFieldName(f.name))
      : [];
    const outputKey = isValidFieldName(node.config?.outputKey) ? node.config.outputKey : "agent_reply";

    const schemaNote = outputFields.length
      ? `\n\n[Workflow structured output]\nCall the workflow_answer tool with these fields (or reply with a single JSON object containing them):\n` +
        outputFields
          .map((f) => `- ${f.name} (${f.type || "string"}${f.choices?.length ? `, choices: ${f.choices.join(" | ")}` : ""})${f.description ? `: ${f.description}` : ""}`)
          .join("\n")
      : "";

    const chatId = this.ws.createChat(bot.id, `Workflow · ${wf.name.slice(0, 60)}`);
    const chat = this.ws.state.chats.find((c) => c.id === chatId);
    if (chat) chat.workflowId = wf.id;

    const runOneAttempt = async (promptText) => {
      return await new Promise((resolve, reject) => {
        const entry = { resolve, reject, workflowRunId: run.id, nodeId: node.id, structuredAnswer: null };
        let started;
        try {
          started = this.ws.send(chatId, promptText, {
            workflowRunId: run.id,
            workflowNodeId: node.id,
            title: `Workflow · ${wf.name.slice(0, 60)} · ${node.label.slice(0, 40)}`,
          });
        } catch (err) {
          return reject(err);
        }
        const turnRun = this.ws.state.runs.find((r) => r.chatId === chatId && r.workflowRunId === run.id && r.workflowNodeId === node.id);
        if (!turnRun) return reject(new Error("Could not start agent turn."));
        this.waitingTurns.set(turnRun.id, entry);
        // Handle synchronous completion if the test harness finished the turn immediately.
        if (turnRun.finished) {
          this.onTurnFinished(chat, turnRun);
        }
        void Promise.resolve(started).catch((err) => {
          if (this.waitingTurns.has(turnRun.id)) {
            this.waitingTurns.delete(turnRun.id);
            reject(err);
          }
        });
      });
    };

    let attempt = await runOneAttempt(basePrompt + schemaNote);

    if (!outputFields.length) {
      return {
        chatId,
        summary: attempt.reply.slice(0, 240),
        outputs: { [outputKey]: attempt.reply },
      };
    }

    let parsed = attempt.structuredAnswer ?? extractJsonObject(attempt.reply);
    let check = validateStructuredFields(parsed, outputFields);
    if (!check.ok) {
      // Retry once with a concise correction prompt.
      const correction =
        `Your previous response did not provide valid structured workflow fields (${check.error}). ` +
        `Call workflow_answer or reply ONLY with a valid JSON object containing: ${outputFields.map((f) => f.name).join(", ")}.`;
      attempt = await runOneAttempt(correction);
      parsed = attempt.structuredAnswer ?? extractJsonObject(attempt.reply);
      check = validateStructuredFields(parsed, outputFields);
      if (!check.ok) {
        throw new Error(`Agent step did not return valid output fields (${check.error}).`);
      }
    }

    const outputs = { ...check.fields };
    if (isValidFieldName(node.config?.outputKey) && outputs[node.config.outputKey] === undefined) {
      outputs[node.config.outputKey] = attempt.reply;
    }
    return {
      chatId,
      summary: JSON.stringify(check.fields).slice(0, 240),
      outputs,
    };
  }

  /** Runs a one-shot LLM model step with NO tools and optional structured JSON output fields. */
  async executeModelNode(wf, run, node) {
    const reader = ["github", "webhook", "channel"].includes(run.triggerKind) && !run.manual ? "model" : "person";
    const stepPrompt = resolveTemplate(node.config?.prompt || "", run.context, { reader });
    if (!stepPrompt.trim()) throw new Error("Model step prompt is empty.");
    const prompt = frameExternalPrompt(stepPrompt, run);
    const outputFields = Array.isArray(node.config?.outputFields)
      ? node.config.outputFields.filter((f) => f && isValidFieldName(f.name))
      : [];
    const outputKey = isValidFieldName(node.config?.outputKey) ? node.config.outputKey : "model_reply";

    const schemaInstruction = outputFields.length
      ? `\n\nRespond ONLY with a valid JSON object (no markdown fences, no extra prose) matching these fields:\n` +
        outputFields
          .map((f) => `- "${f.name}": ${f.type || "string"}${f.choices?.length ? ` (one of: ${f.choices.join(", ")})` : ""}${f.description ? ` — ${f.description}` : ""}`)
          .join("\n")
      : "";

    const invoke = async (userPrompt) => {
      if (this.modelRunner) {
        return String(await this.modelRunner({ prompt: userPrompt, model: node.config?.model, node, workflow: wf, run }) ?? "");
      }
      return await this.runOneShotModel(userPrompt, node.config?.model);
    };

    let rawText = await invoke(prompt + schemaInstruction);

    if (!outputFields.length) {
      return {
        summary: rawText.slice(0, 240),
        outputs: { [outputKey]: rawText },
      };
    }

    let check = validateStructuredFields(extractJsonObject(rawText), outputFields);
    if (!check.ok) {
      rawText = await invoke(
        `${prompt}${schemaInstruction}\n\nYour previous reply was invalid (${check.error}). Reply ONLY with a strict JSON object.`,
      );
      check = validateStructuredFields(extractJsonObject(rawText), outputFields);
      if (!check.ok) {
        throw new Error(`Model step did not return valid JSON fields (${check.error}).`);
      }
    }

    const outputs = { ...check.fields };
    if (isValidFieldName(node.config?.outputKey) && outputs[node.config.outputKey] === undefined) {
      outputs[node.config.outputKey] = rawText;
    }
    return { summary: JSON.stringify(check.fields).slice(0, 240), outputs };
  }

  /** One-shot disposable model session (same pattern as desktop/summaries.mjs), zero tools. */
  async runOneShotModel(prompt, requestedModel) {
    const ws = this.ws;
    const settings = ws.state.settings ?? {};
    const fallbackBot = ws.state.bots.find((b) => b.primary) ?? ws.state.bots[0];
    const choice = requestedModel || settings.routineModel || fallbackBot?.model || settings.model;
    if (!choice) throw new Error("No model configured for this Model step.");
    const { provider, hosted } = await ws.runnerFor(choice);
    if (!provider?.openSession) throw new Error("Model provider is unavailable.");
    const folder = join(ws.dir, "files", "workflows");
    mkdirSync(folder, { recursive: true });
    const session = await provider.openSession({
      sessionId: "wf-model-" + randomUUID(),
      established: false,
      hasReplies: false,
      temporary: true,
      folder,
      coding: false,
      model: hosted?.model ?? choice,
      ...(hosted && { inference: hosted.inference }),
      approval: "ask",
      instructions:
        "You are a concise, precise step inside an automated workflow. Follow the prompt exactly and return only the requested output.",
      context: "",
      tools: [],
      skills: { directories: [], disabled: [] },
      mcpServers: {},
      plugins: [],
      history: () => [],
      handlers: null,
    });
    try {
      const { text } = await session.send({ prompt }, 120000);
      return String(text ?? "").trim();
    } finally {
      await session.close?.({ discard: true }).catch(() => {});
    }
  }

  /** Executes an Output step (chat / feed / idea / goal / notification / github) with resolved `{{field}}` templates. */
  async executeOutputNode(wf, run, node) {
    const cfg = node.config ?? {};
    const dest = OUTPUT_DESTINATIONS.includes(cfg.destination) ? cfg.destination : "chat";

    if (dest === "github") {
      const invokeModel = async (choicePrompt) => {
        const framed = frameExternalPrompt(choicePrompt, run);
        if (this.modelRunner) {
          return String(await this.modelRunner({ prompt: framed, model: cfg.model, node, workflow: wf, run }) ?? "");
        }
        return await this.runOneShotModel(framed, cfg.model);
      };
      return await executeGithubOutputNode({
        wf,
        run,
        node,
        client: this.githubOutputClient,
        actionStore: this.githubActionStore,
        runModel: invokeModel,
        pass: Number(run.retryPass ?? 0) || 0,
        allowUncertainRetry: run.allowUncertainRetry === true,
      });
    }

    const text = resolveTemplate(cfg.template || "", run.context).trim();
    const title = resolveTemplate(cfg.title || wf.name, run.context).trim() || wf.name;
    const hasCard = dest === "chat" && cfg.card && typeof cfg.card === "object" && !Array.isArray(cfg.card);
    const hasA2ui = dest === "chat" && cfg.a2ui !== undefined && cfg.a2ui !== null && (typeof cfg.a2ui !== "string" || cfg.a2ui.trim().length > 0);
    if (!hasCard && !hasA2ui && !text) throw new Error("Output message resolved to empty text.");

    if (dest === "chat") {
      const bot = this.resolveBotForNode(node);
      let target = cfg.chatId ? this.ws.state.chats.find((c) => c.id === cfg.chatId) : null;
      if (!target) {
        target =
          this.ws.state.chats.find((c) => c.botId === bot.id && c.main && !c.createdBy) ??
          this.ws.state.chats.find((c) => c.botId === bot.id && !c.archived && !c.panelId && !c.workflowId && !c.schedules?.some((s) => s.routine));
      }
      if (!target) {
        const id = this.ws.createChat(bot.id, wf.name);
        target = this.ws.state.chats.find((c) => c.id === id);
      }
      const now = Date.now();
      let actionCard;
      let a2uiSurfaces;
      let finalText = text;
      if (hasCard) {
        const built = resolveOutputCard(cfg.card, run.context, title, text, this.ws);
        actionCard = built.actionCard;
        finalText = text || built.fallbackText;
      }
      if (hasA2ui) {
        const built = resolveOutputA2ui(cfg.a2ui, run.context, wf, run, bot, target, this.ws);
        if (built.surfaces.length) a2uiSurfaces = built.surfaces;
        finalText = finalText || built.fallbackText || title;
        if (!a2uiSurfaces && !actionCard && !text && (built.updatedIds.length || built.deletedIds.length)) {
          this.ws.save();
          return { chatId: target.id, summary: `Updated A2UI surface in ${target.title || bot.name}` };
        }
      }
      target.messages.push({
        role: "assistant",
        text: finalText,
        time: now,
        fromWorkflow: { workflowId: wf.id, workflowName: wf.name, runId: run.id },
        ...(actionCard ? { actionCard } : {}),
        ...(a2uiSurfaces ? { a2uiSurfaces } : {}),
      });
      target.time = now;
      target.unread = true;
      (target.posted ??= []).push({ from: wf.name, text: finalText, time: now });
      if (target.posted.length > 10) target.posted.splice(0, target.posted.length - 10);
      this.ws.save();
      this.ws.events?.emit("chat.posted", { chat: target, bot, from: wf.name, text: finalText });
      return { chatId: target.id, summary: `Posted to ${target.title || bot.name}` };
    }

    if (dest === "feed" || dest === "idea" || dest === "goal") {
      const bot = this.resolveBotForNode(node);
      const lines = text.split("\n");
      const firstNonEmpty = lines.findIndex((l) => l.trim());
      const derivedTitle = firstNonEmpty >= 0 ? lines[firstNonEmpty].replace(/^[#>*\-\s`]+/, "").trim().slice(0, 120) : title;
      const derivedBody = firstNonEmpty >= 0 ? lines.slice(firstNonEmpty + 1).join("\n").trim() : text;
      const item = this.ws.board.post(bot.id, {
        kind: dest,
        title: (cfg.title ? title : derivedTitle || title).slice(0, 120),
        body: cfg.title ? text : derivedBody || text,
        ...(dest === "goal" && GOAL_CATEGORIES.includes(cfg.category) ? { category: cfg.category } : {}),
      });
      return { summary: `Posted to Today ${dest} (${item.title})` };
    }

    if (dest === "notification") {
      this.ws.events?.emit("workflow.notify", {
        workflow: sanitizeWorkflow(wf),
        run,
        node,
        title,
        body: text,
      });
      return { summary: `Sent notification: ${title}` };
    }

    throw new Error(`Unknown output destination "${dest}".`);
  }

  extractTurnReply(chat, run) {
    if (!chat?.messages?.length) return "";
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.role === "assistant" && (!m.runId || m.runId === run.id) && typeof m.text === "string" && m.text.trim()) {
        return m.text.trim();
      }
    }
    return "";
  }

  /** Bot tools for building, editing, pausing, resuming, and running workflows live. */
  tools(bot, chat, run, task) {
    const wf = this;
    const tools = [];

    // When this turn IS a workflow agent step with declared output fields, expose `workflow_answer`.
    if (run?.workflowRunId && run?.workflowNodeId) {
      const waiter = this.waitingTurns.get(run.id);
      const workflow = this.all.find((w) => w.id === this.runs.find((r) => r.id === run.workflowRunId)?.workflowId);
      const stepNode = workflow?.nodes.find((n) => n.id === run.workflowNodeId);
      const declared = Array.isArray(stepNode?.config?.outputFields) ? stepNode.config.outputFields : [];
      if (declared.length) {
        tools.push(
          defineTool("workflow_answer", {
            description:
              "Submit the structured output fields for the current workflow step. Call once when you have the required fields.",
            parameters: {
              type: "object",
              properties: {
                fields: {
                  type: "object",
                  description: "Object mapping each required output field name to its value.",
                },
              },
              required: ["fields"],
            },
            handler: async ({ fields }) => {
              const activeWaiter = wf.waitingTurns.get(run.id);
              const check = validateStructuredFields(fields, declared);
              if (!check.ok) return { error: check.error };
              if (activeWaiter) activeWaiter.structuredAnswer = check.fields;
              return { saved: true, fields: check.fields };
            },
          }),
        );
      }
    }

    // Panel refreshes and helper chats don't manage workflows.
    if (run?.panelId || chat?.helper) return tools;

    const record = (_name, fn) => async (args) => {
      if (task?.stopped || wf.ws.closing) throw new Error("This turn is no longer active");
      return await fn(args);
    };

    const nodeSchema = {
      type: "object",
      properties: {
        id: { type: "string", description: "Short unique node ID (e.g. 't1', 'agent1', 'cond1', 'out1')." },
        kind: { type: "string", enum: NODE_KINDS },
        triggerKind: { type: "string", enum: TRIGGER_KINDS, description: "Required when kind is 'trigger'." },
        label: { type: "string" },
        position: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
        },
        config: {
          type: "object",
          description:
            "Step config. Trigger(task): {event,toStatus,fromStatus,botName,taskId,titleContains}. Trigger(schedule): {cadence,time,days,cron,timezone}. Trigger(manual): {inputs}. Trigger(routine): {routineChatId,routineName,botId,onlyOnStatus}. Trigger(chat): {chatId,botId,mentionOnly,textContains}. Trigger(webhook): {fields}. Trigger(github): {repos,repo?,events,labels?,notBot?,firstTime?,titleContains?,baseBranch?,mentionHandles?,mentionHandle?,branch?,author?,pollMinutes?}. Events: issue.opened, issue.closed, issue.labeled, pr.opened, pr.updated, pr.reviewRequested, pr.reviewSubmitted, pr.checksFailed, pr.merged, comment, mention, assigned (legacy names migrated automatically). Trigger(channel): {channel,connection,conversation,sender,isDirect,mentionsBot,textContains}. Agent: {botName,botId,prompt,outputKey,outputFields}. Model: {model,prompt,outputKey,outputFields}. Condition: {expression,match,rules}. Approval: {message,noteField}. Output: {destination,chatId,botName,title,template,category,card,a2ui,action,repository,sameRepository,item,sameItem,body,labels,labelsFrom,assignees,reviewers,person,stateReason}. Destination 'github' supports actions: comment, label.add, label.remove, assign, review.request, review.approve, review.changes, close, reopen, issue.create. Optional card (chat destination only, {{field}} templates): {title,subtitle?,needsYou?,body?,fields?,link?,blocks?,dispatch?}. Optional a2ui (chat destination only, {{field}} templates in strings): array of A2UI v1.0 messages or {messages:[...],onAction?:'bot'|'resume'|'trigger',targetWorkflowId?,dispatch?}.",
        },
      },
      required: ["id", "kind"],
    };

    const edgeSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        branch: { type: "string", description: "'default', 'yes', 'no', 'approved', or 'rejected'." },
      },
      required: ["from", "to"],
    };

    tools.push(
      defineTool("workflow_list", {
        description:
          "List all event-based Workflows with their paused/active state, trigger kinds, step counts, and latest run status.",
        parameters: { type: "object", properties: {} },
        handler: record("workflow_list", async () =>
          wf.all.map((w) => {
            const latest = wf.runs.find((r) => r.workflowId === w.id);
            return {
              id: w.id,
              name: w.name,
              description: w.description,
              enabled: w.enabled,
              triggers: w.nodes.filter((n) => n.kind === "trigger").map((n) => ({ id: n.id, kind: n.triggerKind, label: n.label })),
              stepCount: w.nodes.length,
              latestRun: latest ? { id: latest.id, status: latest.status, startedAt: latest.startedAt, error: latest.error } : null,
            };
          }),
        ),
      }),
      defineTool("workflow_get", {
        description: "Inspect one workflow's nodes, edges, available fields per step, and recent runs.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Workflow ID from workflow_list." } },
          required: ["id"],
        },
        handler: record("workflow_get", async ({ id }) => {
          const item = wf.get(id);
          return {
            workflow: sanitizeWorkflow(item),
            fields: analyzeWorkflowFields(item),
            runs: wf.listRuns(id, 10),
          };
        }),
      }),
      defineTool("workflow_create", {
        description:
          "Create an event-based Workflow graph and show it live on the Routines › Workflows canvas. Rejects invalid graphs or broken/ambiguous {{field}} references; trigger fields are fixed per trigger kind (task: id,title,bot,from,to,result,problem,priority; schedule: local_date,local_time,weekday,run_time,timezone; manual: run_time,triggered_by; routine: routine_id,routine_name,bot,status,result,run_id,finished_at; chat: chat_id,chat_title,bot,sender,text,time; webhook: body,payload,method,received_at; github: event,repository,number,pull_request,title,body,url,state,author,sender,author_association,labels,added_label,assignees,base_branch,head_branch,head_sha,merged,review_state,review_body,comment_body,comment_url,check_conclusion,mention; channel: channel,connection,conversation,sender,text,isDirect,mentionsBot).",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            enabled: { type: "boolean", description: "Set false to create paused. Defaults to true." },
            nodes: { type: "array", items: nodeSchema },
            edges: { type: "array", items: edgeSchema },
          },
          required: ["name", "nodes", "edges"],
        },
        handler: record("workflow_create", async (args) => wf.create(args, { strictFields: true })),
      }),
      defineTool("workflow_update", {
        description:
          "Update an existing workflow's name, description, nodes, edges, or enabled state; updates the open canvas live and rejects broken or ambiguous {{field}} references.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Workflow ID from workflow_list." },
            name: { type: "string" },
            description: { type: "string" },
            enabled: { type: "boolean" },
            nodes: { type: "array", items: nodeSchema },
            edges: { type: "array", items: edgeSchema },
          },
          required: ["id"],
        },
        handler: record("workflow_update", async ({ id, ...patch }) => wf.update(id, patch, { strictFields: true })),
      }),
      defineTool("workflow_run", {
        description:
          "Start a manual run of a workflow immediately (works even when the workflow is paused) and return the new run ID.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Workflow ID from workflow_list." },
            inputs: { type: "object", description: "Optional input fields for the manual trigger." },
          },
          required: ["id"],
        },
        handler: record("workflow_run", async ({ id, inputs }) => {
          const created = wf.runManual(id, { inputs, triggeredBy: bot?.name || "bot" });
          return { runId: created.id, status: created.status };
        }),
      }),
      defineTool("workflow_pause", {
        description:
          "Pause a workflow so event and schedule triggers stop firing (manual runs still work; missed schedule runs are skipped on resume).",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Workflow ID from workflow_list." } },
          required: ["id"],
        },
        handler: record("workflow_pause", async ({ id }) => {
          const res = wf.pause(id);
          return { id: res.id, name: res.name, enabled: res.enabled };
        }),
      }),
      defineTool("workflow_resume", {
        description: "Resume a paused workflow so event and schedule triggers fire again (missed schedule occurrences during pause are skipped).",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Workflow ID from workflow_list." } },
          required: ["id"],
        },
        handler: record("workflow_resume", async ({ id }) => {
          const res = wf.resume(id);
          return { id: res.id, name: res.name, enabled: res.enabled };
        }),
      }),
      defineTool("workflow_delete", {
        description: "Delete a workflow permanently when the person asks.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Workflow ID from workflow_list." } },
          required: ["id"],
        },
        handler: record("workflow_delete", async ({ id }) => {
          wf.remove(id);
          return { deleted: true, id };
        }),
      }),
    );

    return tools;
  }
}
