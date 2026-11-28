// SQLite-backed workspace store (`workspace.db`).
//
// Replaces full-file JSON.stringify rewrites of `workspace.json` with row-level persistence
// inside a WAL-mode SQLite database using Node's built-in `node:sqlite` (`DatabaseSync`).
//
// Key design properties:
// - WAL mode (`PRAGMA journal_mode = WAL`), `PRAGMA synchronous = NORMAL`, `PRAGMA foreign_keys = ON`.
// - Normalized tables for bots, chats, messages, runs, run_steps (input/output stored in dedicated
//   columns so long tool payloads can load lazily on demand), tasks, routines, projects, spaces,
//   panels, plus a `kv` table for singleton settings and smaller collections.
// - Incremental dirty-row persistence: `save()` and `saveSoon()` flush only rows touched since
//   the last commit inside one transaction, keeping per-turn save cost O(touched) rather than
//   O(total history).
// - Lazy run-step payloads: finished runs whose steps exceed `LIGHT_STEP_TEXT` (400 chars) are
//   loaded with `more: true` and without their big `input`/`output` blobs in memory; callers read
//   full payloads on demand via `stepDetail(chatId, runId, stepId)` or `hydrateStep(runId, stepId)`.
// - Atomic idempotent migration from legacy `workspace.json` (plus any `turn-checkpoints/`),
//   verifying row counts before renaming `workspace.json` -> `workspace.json.migrated-<ts>`.
//   If migration fails, the caller falls back to the JSON backend and logs loudly.

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LIGHT_STEP_TEXT } from "./link/parts.mjs";
import { isBackgroundStep } from "./link/activity-steps.mjs";
import { readWorkspace } from "./workspace-file.mjs";

export const WORKSPACE_DB_FILENAME = "workspace.db";
export const SCHEMA_VERSION = 1;

/** Steps whose input/output are small or rendered inline in the chat transcript. */
const KEEPS_STEP_TEXT = /^(ask_user|ask)$/i;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  name TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  name TEXT,
  created_at INTEGER,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  name TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panels (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  space_id TEXT,
  bot_id TEXT,
  chat_id TEXT,
  updated_at INTEGER,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  bot_id TEXT,
  created_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  run_id TEXT,
  role TEXT,
  created_at INTEGER,
  data TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_at INTEGER,
  data TEXT NOT NULL,
  PRIMARY KEY (chat_id, id),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  chat_id TEXT,
  status TEXT,
  created_at INTEGER,
  finished_at INTEGER,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_steps (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT,
  status TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  input TEXT,
  output TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  bot_id TEXT,
  chat_id TEXT,
  status TEXT,
  priority TEXT,
  created_at INTEGER,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  workflow_id TEXT,
  status TEXT,
  created_at INTEGER,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_bot ON chats(bot_id);
CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_routines_chat ON routines(chat_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_chat ON runs(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_steps_status ON run_steps(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id);
CREATE INDEX IF NOT EXISTS idx_panels_space ON panels(space_id);
CREATE INDEX IF NOT EXISTS idx_panels_chat ON panels(chat_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created ON workflow_runs(created_at);
`;

const TABLE_COLLECTION_KEYS = new Set([
  "bots", "chats", "runs", "tasks", "projects", "spaces", "panels", "workflows", "workflowRuns",
]);

/** Keys that are transient / never persisted into kv. */
const SKIP_KV_KEYS = new Set([
  ...TABLE_COLLECTION_KEYS,
  "turnCheckpointBase",
]);

function setPrivateMode(filePath) {
  if (process.platform === "win32") return;
  try {
    if (existsSync(filePath)) chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on filesystems that don't support POSIX modes.
  }
}

/**
 * Shallow structural signature for dirty detection without serializing large strings.
 * Strings are compared by identity (`===`) so multi-KB tool outputs cost O(1).
 */
function snapshotValue(value, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = snapshotValue(value[i], depth + 1);
    return out;
  }
  const keys = Object.keys(value);
  const vals = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) vals[i] = snapshotValue(value[keys[i]], depth + 1);
  return { __s: 1, keys, vals };
}

function sameSnapshot(snap, value) {
  if (snap === value) return true;
  if (value === null || snap === null || typeof value !== "object" || typeof snap !== "object") {
    // Handle depth-capped JSON string fallback
    if (typeof snap === "string" && value !== null && typeof value === "object") {
      return snap === JSON.stringify(value);
    }
    return false;
  }
  if (Array.isArray(value)) {
    if (!Array.isArray(snap) || snap.length !== value.length) return false;
    for (let i = 0; i < value.length; i++) if (!sameSnapshot(snap[i], value[i])) return false;
    return true;
  }
  if (!snap.__s) return false;
  const keys = Object.keys(value);
  if (keys.length !== snap.keys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key !== snap.keys[i]) return false;
    if (!sameSnapshot(snap.vals[i], value[key])) return false;
  }
  return true;
}

/** Snapshot of an object omitting specific top-level keys (e.g. `messages`/`schedules` on chat, `steps` on run). */
function snapshotObjectExcept(obj, omitA, omitB) {
  const keys = [];
  const vals = [];
  for (const key of Object.keys(obj)) {
    if (key === omitA || key === omitB) continue;
    keys.push(key);
    vals.push(snapshotValue(obj[key], 1));
  }
  return { __s: 1, keys, vals };
}

function sameObjectExcept(snap, obj, omitA, omitB) {
  if (!snap || !snap.__s) return false;
  const keys = Object.keys(obj);
  let idx = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === omitA || key === omitB) continue;
    if (idx >= snap.keys.length || key !== snap.keys[idx]) return false;
    if (!sameSnapshot(snap.vals[idx], obj[key])) return false;
    idx++;
  }
  return idx === snap.keys.length;
}

function serializeObjectExcept(obj, omitA, omitB) {
  const copy = {};
  for (const key of Object.keys(obj)) {
    if (key === omitA || key === omitB) continue;
    copy[key] = obj[key];
  }
  return JSON.stringify(copy);
}

/**
 * Strip `input`, `output`, and transient lazy marker `more` from a step before storing its
 * metadata JSON column.
 */
function stepMetaJson(step) {
  const meta = {};
  for (const key of Object.keys(step)) {
    if (key === "input" || key === "output" || key === "more") continue;
    meta[key] = step[key];
  }
  return JSON.stringify(meta);
}

/**
 * Symbol/WeakMap tracking lazy steps loaded from SQLite whose `input`/`output` were deferred.
 * Value: `{ inputDeferred: boolean, outputDeferred: boolean }`.
 */
const lazyStepMeta = new WeakMap();

/** True when a step object still has unloaded input or output in SQLite. */
export function isLazyStep(step) {
  return !!step && lazyStepMeta.has(step);
}

/**
 * Open a SQLite database with Botkins pragmas and ensure schema exists.
 */
export function openWorkspaceDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('__schema_version', ?)").run(String(SCHEMA_VERSION));
  setPrivateMode(dbPath);
  setPrivateMode(dbPath + "-wal");
  setPrivateMode(dbPath + "-shm");
  return db;
}

/**
 * Count logical records in an in-memory workspace state object (used for migration verification
 * and dry-run reporting).
 */
export function countStateRecords(state) {
  const bots = Array.isArray(state.bots) ? state.bots.length : 0;
  const chats = Array.isArray(state.chats) ? state.chats.length : 0;
  let messages = 0;
  let routines = 0;
  for (const chat of state.chats ?? []) {
    if (Array.isArray(chat?.messages)) messages += chat.messages.length;
    if (Array.isArray(chat?.schedules)) routines += chat.schedules.length;
  }
  const runs = Array.isArray(state.runs) ? state.runs.length : 0;
  let runSteps = 0;
  for (const run of state.runs ?? []) {
    if (Array.isArray(run?.steps)) runSteps += run.steps.length;
  }
  const tasks = Array.isArray(state.tasks) ? state.tasks.length : 0;
  const projects = Array.isArray(state.projects) ? state.projects.length : 0;
  const spaces = Array.isArray(state.spaces) ? state.spaces.length : 0;
  const panels = Array.isArray(state.panels) ? state.panels.length : 0;
  const workflows = Array.isArray(state.workflows) ? state.workflows.length : 0;
  const workflowRuns = Array.isArray(state.workflowRuns) ? state.workflowRuns.length : 0;
  const kvKeys = Object.keys(state).filter((k) => !SKIP_KV_KEYS.has(k) && state[k] !== undefined).length;
  return { bots, chats, messages, routines, runs, runSteps, tasks, projects, spaces, panels, workflows, workflowRuns, kvKeys };
}

/**
 * Count rows currently stored in an open SQLite workspace database.
 */
export function countDbRecords(db) {
  const count = (sql) => Number(db.prepare(sql).get().c);
  return {
    bots: count("SELECT COUNT(*) AS c FROM bots"),
    chats: count("SELECT COUNT(*) AS c FROM chats"),
    messages: count("SELECT COUNT(*) AS c FROM messages"),
    routines: count("SELECT COUNT(*) AS c FROM routines"),
    runs: count("SELECT COUNT(*) AS c FROM runs"),
    runSteps: count("SELECT COUNT(*) AS c FROM run_steps"),
    tasks: count("SELECT COUNT(*) AS c FROM tasks"),
    projects: count("SELECT COUNT(*) AS c FROM projects"),
    spaces: count("SELECT COUNT(*) AS c FROM spaces"),
    panels: count("SELECT COUNT(*) AS c FROM panels"),
    workflows: count("SELECT COUNT(*) AS c FROM workflows"),
    workflowRuns: count("SELECT COUNT(*) AS c FROM workflow_runs"),
    kvKeys: count("SELECT COUNT(*) AS c FROM kv WHERE key NOT LIKE '\\_\\_%' ESCAPE '\\'"),
  };
}

/**
 * Assign a stable unique key for a step inside a run (handles duplicate/missing ids defensively).
 */
function uniqueStepId(step, index, seen) {
  let id = typeof step?.id === "string" && step.id ? step.id : `step-${index}`;
  if (!seen.has(id)) {
    seen.add(id);
    return id;
  }
  let n = 2;
  while (seen.has(`${id}#${n}`)) n++;
  const dedup = `${id}#${n}`;
  seen.add(dedup);
  return dedup;
}

/**
 * Assign a stable unique key for a routine inside a chat.
 */
function uniqueRoutineId(schedule, index, seen) {
  let id = typeof schedule?.id === "string" && schedule.id ? schedule.id : `sched-${index}`;
  if (!seen.has(id)) {
    seen.add(id);
    return id;
  }
  let n = 2;
  while (seen.has(`${id}#${n}`)) n++;
  const dedup = `${id}#${n}`;
  seen.add(dedup);
  return dedup;
}

/**
 * Assign a stable unique primary key for rows in top-level tables (bots, chats, runs, tasks, etc.).
 */
function uniqueRowId(item, index, seen, prefix) {
  let id = typeof item?.id === "string" && item.id ? item.id : `${prefix}-${index}`;
  if (!seen.has(id)) {
    seen.add(id);
    return id;
  }
  let n = 2;
  while (seen.has(`${id}#${n}`)) n++;
  const dedup = `${id}#${n}`;
  seen.add(dedup);
  return dedup;
}

/**
 * Import a parsed workspace state object into an empty (or cleared) SQLite database in one transaction.
 * Verifies every table's row count before committing.
 */
function importStateIntoDb(db, state) {
  const expected = countStateRecords(state);

  const insKv = db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)");
  const insBot = db.prepare("INSERT INTO bots (id, sort_order, name, data) VALUES (?, ?, ?, ?)");
  const insProject = db.prepare("INSERT INTO projects (id, sort_order, name, created_at, data) VALUES (?, ?, ?, ?, ?)");
  const insSpace = db.prepare("INSERT INTO spaces (id, sort_order, name, builtin, created_at, data) VALUES (?, ?, ?, ?, ?, ?)");
  const insPanel = db.prepare("INSERT INTO panels (id, sort_order, space_id, bot_id, chat_id, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insChat = db.prepare("INSERT INTO chats (id, sort_order, bot_id, created_at, archived, data) VALUES (?, ?, ?, ?, ?, ?)");
  const insMsg = db.prepare("INSERT INTO messages (chat_id, seq, run_id, role, created_at, data) VALUES (?, ?, ?, ?, ?, ?)");
  const insRoutine = db.prepare("INSERT INTO routines (id, chat_id, seq, name, enabled, next_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insRun = db.prepare("INSERT INTO runs (id, sort_order, chat_id, status, created_at, finished_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insStep = db.prepare("INSERT INTO run_steps (run_id, id, seq, name, status, started_at, finished_at, input, output, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insTask = db.prepare("INSERT INTO tasks (id, sort_order, bot_id, chat_id, status, priority, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insWorkflow = db.prepare("INSERT INTO workflows (id, sort_order, name, enabled, created_at, data) VALUES (?, ?, ?, ?, ?, ?)");
  const insWorkflowRun = db.prepare("INSERT INTO workflow_runs (id, sort_order, workflow_id, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?)");

  db.exec("BEGIN IMMEDIATE");
  try {
    // Clear any partial rows if called on an existing DB
    db.exec(`
      DELETE FROM run_steps;
      DELETE FROM runs;
      DELETE FROM routines;
      DELETE FROM messages;
      DELETE FROM chats;
      DELETE FROM tasks;
      DELETE FROM workflow_runs;
      DELETE FROM workflows;
      DELETE FROM panels;
      DELETE FROM spaces;
      DELETE FROM projects;
      DELETE FROM bots;
      DELETE FROM kv WHERE key NOT LIKE '\\_\\_%' ESCAPE '\\';
    `);

    const botSeen = new Set();
    for (let i = 0; i < (state.bots ?? []).length; i++) {
      const bot = state.bots[i];
      if (!bot || typeof bot !== "object") continue;
      const id = uniqueRowId(bot, i, botSeen, "bot");
      insBot.run(id, i, typeof bot.name === "string" ? bot.name : null, JSON.stringify(bot));
    }

    const projectSeen = new Set();
    for (let i = 0; i < (state.projects ?? []).length; i++) {
      const p = state.projects[i];
      if (!p || typeof p !== "object") continue;
      const id = uniqueRowId(p, i, projectSeen, "proj");
      insProject.run(id, i, typeof p.name === "string" ? p.name : null, Number.isFinite(p.createdAt) ? p.createdAt : null, JSON.stringify(p));
    }

    const spaceSeen = new Set();
    for (let i = 0; i < (state.spaces ?? []).length; i++) {
      const sp = state.spaces[i];
      if (!sp || typeof sp !== "object") {
        // Legacy/corrupt entries (e.g. spaces-host.test.mjs) must still round-trip through load()
        const id = uniqueRowId(null, i, spaceSeen, "space");
        insSpace.run(id, i, null, 0, null, JSON.stringify(sp ?? null));
        continue;
      }
      const id = uniqueRowId(sp, i, spaceSeen, "space");
      insSpace.run(id, i, typeof sp.name === "string" ? sp.name : null, sp.builtin ? 1 : 0, Number.isFinite(sp.createdAt) ? sp.createdAt : null, JSON.stringify(sp));
    }

    const panelSeen = new Set();
    for (let i = 0; i < (state.panels ?? []).length; i++) {
      const panel = state.panels[i];
      if (!panel || typeof panel !== "object") continue;
      const id = uniqueRowId(panel, i, panelSeen, "panel");
      insPanel.run(
        id,
        i,
        typeof panel.spaceId === "string" ? panel.spaceId : null,
        typeof panel.botId === "string" ? panel.botId : null,
        typeof panel.chatId === "string" ? panel.chatId : null,
        Number.isFinite(panel.updatedAt) ? panel.updatedAt : null,
        JSON.stringify(panel),
      );
    }

    const chatSeen = new Set();
    for (let i = 0; i < (state.chats ?? []).length; i++) {
      const chat = state.chats[i];
      if (!chat || typeof chat !== "object") continue;
      const chatId = uniqueRowId(chat, i, chatSeen, "chat");
      insChat.run(
        chatId,
        i,
        typeof chat.botId === "string" ? chat.botId : null,
        Number.isFinite(chat.time) ? chat.time : null,
        chat.archived ? 1 : 0,
        serializeObjectExcept(chat, "messages", "schedules"),
      );
      const msgs = Array.isArray(chat.messages) ? chat.messages : [];
      for (let m = 0; m < msgs.length; m++) {
        const msg = msgs[m];
        insMsg.run(
          chatId,
          m,
          typeof msg?.runId === "string" ? msg.runId : null,
          typeof msg?.role === "string" ? msg.role : null,
          Number.isFinite(msg?.time) ? msg.time : null,
          JSON.stringify(msg),
        );
      }
      if (Array.isArray(chat.schedules)) {
        const schedSeen = new Set();
        for (let s = 0; s < chat.schedules.length; s++) {
          const sched = chat.schedules[s];
          const sid = uniqueRoutineId(sched, s, schedSeen);
          insRoutine.run(
            sid,
            chatId,
            s,
            typeof sched?.name === "string" ? sched.name : null,
            sched?.enabled === false ? 0 : 1,
            Number.isFinite(sched?.nextAt) ? sched.nextAt : null,
            JSON.stringify(sched),
          );
        }
      }
    }

    const runSeen = new Set();
    for (let i = 0; i < (state.runs ?? []).length; i++) {
      const run = state.runs[i];
      if (!run || typeof run !== "object") continue;
      const runId = uniqueRowId(run, i, runSeen, "run");
      insRun.run(
        runId,
        i,
        typeof run.chatId === "string" ? run.chatId : null,
        typeof run.status === "string" ? run.status : null,
        Number.isFinite(run.time) ? run.time : null,
        Number.isFinite(run.finished) ? run.finished : null,
        serializeObjectExcept(run, "steps"),
      );
      if (Array.isArray(run.steps)) {
        const stepSeen = new Set();
        for (let s = 0; s < run.steps.length; s++) {
          const step = run.steps[s];
          if (!step || typeof step !== "object") continue;
          const sid = uniqueStepId(step, s, stepSeen);
          insStep.run(
            runId,
            sid,
            s,
            typeof step.name === "string" ? step.name : null,
            typeof step.status === "string" ? step.status : null,
            Number.isFinite(step.started) ? step.started : null,
            Number.isFinite(step.finished) ? step.finished : null,
            typeof step.input === "string" ? step.input : null,
            typeof step.output === "string" ? step.output : null,
            stepMetaJson(step),
          );
        }
      }
    }

    const taskSeen = new Set();
    for (let i = 0; i < (state.tasks ?? []).length; i++) {
      const task = state.tasks[i];
      if (!task || typeof task !== "object") continue;
      const id = uniqueRowId(task, i, taskSeen, "task");
      insTask.run(
        id,
        i,
        typeof task.botId === "string" ? task.botId : null,
        typeof task.chatId === "string" ? task.chatId : null,
        typeof task.status === "string" ? task.status : null,
        typeof task.priority === "string" ? task.priority : null,
        Number.isFinite(task.createdAt) ? task.createdAt : null,
        JSON.stringify(task),
      );
    }

    const wfSeen = new Set();
    for (let i = 0; i < (state.workflows ?? []).length; i++) {
      const wf = state.workflows[i];
      if (!wf || typeof wf !== "object") continue;
      const id = uniqueRowId(wf, i, wfSeen, "wf");
      insWorkflow.run(
        id,
        i,
        typeof wf.name === "string" ? wf.name : null,
        wf.enabled === false ? 0 : 1,
        Number.isFinite(wf.createdAt) ? wf.createdAt : null,
        JSON.stringify(wf),
      );
    }

    const wfRunSeen = new Set();
    for (let i = 0; i < (state.workflowRuns ?? []).length; i++) {
      const wfr = state.workflowRuns[i];
      if (!wfr || typeof wfr !== "object") continue;
      const id = uniqueRowId(wfr, i, wfRunSeen, "wfr");
      insWorkflowRun.run(
        id,
        i,
        typeof wfr.workflowId === "string" ? wfr.workflowId : null,
        typeof wfr.status === "string" ? wfr.status : null,
        Number.isFinite(wfr.startedAt) ? wfr.startedAt : null,
        JSON.stringify(wfr),
      );
    }

    for (const [key, value] of Object.entries(state)) {
      if (SKIP_KV_KEYS.has(key) || value === undefined) continue;
      insKv.run(key, JSON.stringify(value));
    }
    // Preserve empty-array presence for optional table collections so export/load round-trips cleanly.
    for (const col of ["projects", "spaces", "panels", "tasks", "workflows", "workflowRuns"]) {
      if (Array.isArray(state[col]) && state[col].length === 0) {
        insKv.run("__empty_" + col, "1");
      }
    }

    // Verify counts inside the same transaction before committing.
    const actual = countDbRecords(db);
    const mismatches = [];
    for (const k of Object.keys(expected)) {
      if (actual[k] !== expected[k]) mismatches.push(`${k}: expected ${expected[k]}, got ${actual[k]}`);
    }
    if (mismatches.length) {
      throw new Error("Workspace SQLite migration count mismatch: " + mismatches.join("; "));
    }

    db.exec("COMMIT");
    return actual;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors if transaction already aborted.
    }
    throw error;
  }
}

/**
 * Migrate `workspace.json` in `dir` to `workspace.db`.
 *
 * - Idempotent: if `workspace.db` already exists, returns `{ status: "already-migrated", ... }`.
 * - If neither `workspace.json` nor `workspace.db` exists, returns `{ status: "empty", ... }`.
 * - When `dryRun: true`: reads `workspace.json`, imports into an in-memory (or temp) SQLite DB,
 *   verifies every count, reports timing & sizes, and makes ZERO changes on disk.
 * - When `dryRun: false`: writes to a temp file `workspace.db.migrating-<pid>` in `dir`, verifies
 *   counts, checkpoints WAL & closes, atomically renames to `workspace.db`, then renames
 *   `workspace.json` -> `workspace.json.migrated-<ts>` and removes superseded `turn-checkpoints/`.
 */
export function migrateWorkspaceFile(dir, { dryRun = false, now = Date.now } = {}) {
  const jsonPath = join(dir, "workspace.json");
  const dbPath = join(dir, WORKSPACE_DB_FILENAME);
  const hasDb = existsSync(dbPath);
  const hasJson = existsSync(jsonPath);

  if (hasDb) {
    const db = openWorkspaceDb(dbPath);
    try {
      const counts = countDbRecords(db);
      const dbBytes = statSync(dbPath).size;
      return {
        status: "already-migrated",
        dryRun,
        dir,
        jsonPath,
        dbPath,
        hasJson,
        dbBytes,
        counts,
      };
    } finally {
      db.close();
    }
  }

  if (!hasJson) {
    return {
      status: "empty",
      dryRun,
      dir,
      jsonPath,
      dbPath,
      hasJson: false,
      counts: countStateRecords({}),
    };
  }

  const startedAt = performance.now();
  const jsonBytes = statSync(jsonPath).size;
  const readStart = performance.now();
  const state = readWorkspace(jsonPath, { dryRun });
  const readMs = performance.now() - readStart;

  if (dryRun) {
    const importStart = performance.now();
    const mem = new DatabaseSync(":memory:");
    try {
      mem.exec("PRAGMA foreign_keys = ON;");
      mem.exec(SCHEMA_SQL);
      mem.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('__schema_version', ?)").run(String(SCHEMA_VERSION));
      const counts = importStateIntoDb(mem, state);
      const importMs = performance.now() - importStart;
      return {
        status: "dry-run",
        dryRun: true,
        dir,
        jsonPath,
        dbPath,
        jsonBytes,
        counts,
        readMs: Math.round(readMs * 10) / 10,
        importMs: Math.round(importMs * 10) / 10,
        totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      };
    } finally {
      mem.close();
    }
  }

  const ts = now();
  const tempDb = join(dir, `${WORKSPACE_DB_FILENAME}.migrating-${process.pid}-${ts}`);
  const cleanupTemp = () => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(tempDb + suffix, { force: true });
  };
  let db;
  let counts;
  const importStart = performance.now();
  try {
    db = openWorkspaceDb(tempDb);
    counts = importStateIntoDb(db, state);
    // Flush WAL into main DB file so a single rename atomically installs the full DB.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.exec("PRAGMA journal_mode = DELETE;");
    db.close();
    db = null;
    setPrivateMode(tempDb);
    // Remove any leftover -wal/-shm before atomic rename.
    rmSync(tempDb + "-wal", { force: true });
    rmSync(tempDb + "-shm", { force: true });
    renameSync(tempDb, dbPath);
    setPrivateMode(dbPath);
  } catch (error) {
    try {
      db?.close();
    } catch {}
    cleanupTemp();
    throw error;
  }

  const importMs = performance.now() - importStart;
  const backupName = `workspace.json.migrated-${ts}`;
  const backupPath = join(dir, backupName);
  renameSync(jsonPath, backupPath);
  // Old JSON turn-checkpoints were already folded in by readWorkspace(jsonPath).
  rmSync(join(dir, "turn-checkpoints"), { recursive: true, force: true });

  const dbBytes = statSync(dbPath).size;
  return {
    status: "migrated",
    dryRun: false,
    dir,
    jsonPath,
    dbPath,
    backupPath,
    backupName,
    jsonBytes,
    dbBytes,
    counts,
    readMs: Math.round(readMs * 10) / 10,
    importMs: Math.round(importMs * 10) / 10,
    totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}

/**
 * Row-level SQLite workspace store.
 *
 * Implements the same lifecycle methods as `WorkspaceWriter` (`save`, `mark`, `voiceChanged`,
 * `checkpoint`) plus `load()`, `stepDetail()`, `hydrateStep()`, `readRawState()`, and `close()`.
 */
export class SqliteWorkspaceStore {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.dbPath = join(dir, WORKSPACE_DB_FILENAME);
    this.lazySteps = options.lazySteps !== false;
    this.db = openWorkspaceDb(this.dbPath);
    this.closed = false;

    // Active-turn checkpoint tracking (compatible with Workspace.saveSoon / flushSave).
    this.turns = new Map();
    this.dirtyTurns = new Set();
    // Mirrors WorkspaceWriter.written so Workspace.flushSave() knows if pending checkpoints exist.
    this.written = new Set();

    // Last-persisted state trackers for O(dirty) diffing on save().
    this._botsSnap = new Map();
    this._botsOrder = [];
    this._projectsSnap = new Map();
    this._projectsOrder = [];
    this._spacesSnap = new Map();
    this._spacesOrder = [];
    this._panelsSnap = new Map();
    this._panelsOrder = [];
    this._tasksSnap = new Map();
    this._tasksOrder = [];
    this._workflowsSnap = new Map();
    this._workflowsOrder = [];
    this._workflowRunsSnap = new Map();
    this._workflowRunsOrder = [];
    this._chatsSnap = new Map();       // chatId -> { metaSnap, msgSnaps: [], schedSnaps: [] }
    this._chatsOrder = [];
    this._runsSnap = new Map();        // runId -> { metaSnap, stepSnaps: Map<stepId, snap>, stepOrder: string[] }
    this._runsOrder = [];
    this._kvSnap = new Map();          // key -> snapshotValue(value)

    this._prepareStatements();
  }

  _prepareStatements() {
    const db = this.db;
    this._stmt = {
      upsertKv: db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)"),
      deleteKv: db.prepare("DELETE FROM kv WHERE key = ?"),

      upsertBot: db.prepare("INSERT OR REPLACE INTO bots (id, sort_order, name, data) VALUES (?, ?, ?, ?)"),
      deleteBot: db.prepare("DELETE FROM bots WHERE id = ?"),

      upsertProject: db.prepare("INSERT OR REPLACE INTO projects (id, sort_order, name, created_at, data) VALUES (?, ?, ?, ?, ?)"),
      deleteProject: db.prepare("DELETE FROM projects WHERE id = ?"),

      upsertSpace: db.prepare("INSERT OR REPLACE INTO spaces (id, sort_order, name, builtin, created_at, data) VALUES (?, ?, ?, ?, ?, ?)"),
      deleteSpace: db.prepare("DELETE FROM spaces WHERE id = ?"),

      upsertPanel: db.prepare("INSERT OR REPLACE INTO panels (id, sort_order, space_id, bot_id, chat_id, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      deletePanel: db.prepare("DELETE FROM panels WHERE id = ?"),

      upsertTask: db.prepare("INSERT OR REPLACE INTO tasks (id, sort_order, bot_id, chat_id, status, priority, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
      deleteTask: db.prepare("DELETE FROM tasks WHERE id = ?"),

      upsertWorkflow: db.prepare("INSERT OR REPLACE INTO workflows (id, sort_order, name, enabled, created_at, data) VALUES (?, ?, ?, ?, ?, ?)"),
      deleteWorkflow: db.prepare("DELETE FROM workflows WHERE id = ?"),

      upsertWorkflowRun: db.prepare("INSERT OR REPLACE INTO workflow_runs (id, sort_order, workflow_id, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?)"),
      deleteWorkflowRun: db.prepare("DELETE FROM workflow_runs WHERE id = ?"),

      // Chat metadata changed or reordered: NEVER use INSERT OR REPLACE on chats, because
      // `ON DELETE CASCADE` on `messages`/`routines` would wipe all child rows! Use ON CONFLICT DO UPDATE.
      upsertChat: db.prepare(
        `INSERT INTO chats (id, sort_order, bot_id, created_at, archived, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sort_order = excluded.sort_order,
           bot_id = excluded.bot_id,
           created_at = excluded.created_at,
           archived = excluded.archived,
           data = excluded.data`,
      ),
      deleteChat: db.prepare("DELETE FROM chats WHERE id = ?"),

      upsertMsg: db.prepare("INSERT OR REPLACE INTO messages (chat_id, seq, run_id, role, created_at, data) VALUES (?, ?, ?, ?, ?, ?)"),
      deleteMsgsFrom: db.prepare("DELETE FROM messages WHERE chat_id = ? AND seq >= ?"),

      upsertRoutine: db.prepare("INSERT OR REPLACE INTO routines (id, chat_id, seq, name, enabled, next_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      deleteRoutinesForChat: db.prepare("DELETE FROM routines WHERE chat_id = ?"),

      // Same for `runs`: ON CONFLICT DO UPDATE avoids triggering `ON DELETE CASCADE` on `run_steps`!
      upsertRun: db.prepare(
        `INSERT INTO runs (id, sort_order, chat_id, status, created_at, finished_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sort_order = excluded.sort_order,
           chat_id = excluded.chat_id,
           status = excluded.status,
           created_at = excluded.created_at,
           finished_at = excluded.finished_at,
           data = excluded.data`,
      ),
      deleteRun: db.prepare("DELETE FROM runs WHERE id = ?"),

      upsertStepFull: db.prepare(
        "INSERT OR REPLACE INTO run_steps (run_id, id, seq, name, status, started_at, finished_at, input, output, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      upsertStepMetaKeepBlobs: db.prepare(
        `INSERT INTO run_steps (run_id, id, seq, name, status, started_at, finished_at, input, output, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, id) DO UPDATE SET
           seq = excluded.seq,
           name = excluded.name,
           status = excluded.status,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           input = CASE WHEN ? = 1 THEN run_steps.input ELSE excluded.input END,
           output = CASE WHEN ? = 1 THEN run_steps.output ELSE excluded.output END,
           data = excluded.data`,
      ),
      deleteStep: db.prepare("DELETE FROM run_steps WHERE run_id = ? AND id = ?"),
      deleteStepsForRun: db.prepare("DELETE FROM run_steps WHERE run_id = ?"),

      selectStepDetail: db.prepare("SELECT input, output FROM run_steps WHERE run_id = ? AND id = ?"),
      selectRunStepsFull: db.prepare("SELECT id, input, output, data FROM run_steps WHERE run_id = ? ORDER BY seq"),
    };
  }

  /**
   * Load workspace state from SQLite.
   *
   * When `lazySteps` is enabled (the default), finished runs with long step `input`/`output`
   * (> LIGHT_STEP_TEXT) omit those blobs from the in-memory step object and mark `more: true`.
   * Working runs and short/ask/helper steps keep full text in memory so crash recovery, UI
   * rendering, and light-step classification stay exact.
   */
  load({ hydrateAllSteps = false } = {}) {
    const db = this.db;
    const state = { bots: [], chats: [], runs: [] };

    // 1. kv
    this._kvSnap.clear();
    const emptyFlags = new Set();
    for (const row of db.prepare("SELECT key, value FROM kv").all()) {
      if (row.key.startsWith("__empty_")) {
        emptyFlags.add(row.key.slice("__empty_".length));
        continue;
      }
      if (row.key.startsWith("__")) continue;
      const parsed = JSON.parse(row.value);
      state[row.key] = parsed;
      this._kvSnap.set(row.key, snapshotValue(parsed));
    }
    this._emptyFlags = emptyFlags;

    // 2. bots
    this._botsSnap.clear();
    this._botsOrder = [];
    for (const row of db.prepare("SELECT id, data FROM bots ORDER BY sort_order").all()) {
      const bot = JSON.parse(row.data);
      state.bots.push(bot);
      this._botsOrder.push(row.id);
      this._botsSnap.set(row.id, snapshotValue(bot));
    }

    // 3. projects
    this._projectsSnap.clear();
    this._projectsOrder = [];
    const projectRows = db.prepare("SELECT id, data FROM projects ORDER BY sort_order").all();
    const hasEmptyFlag = (name) => emptyFlags.has(name);
    if (projectRows.length || hasEmptyFlag("projects")) {
      state.projects = [];
      for (const row of projectRows) {
        const project = JSON.parse(row.data);
        state.projects.push(project);
        this._projectsOrder.push(row.id);
        this._projectsSnap.set(row.id, snapshotValue(project));
      }
    }

    // 4. spaces
    this._spacesSnap.clear();
    this._spacesOrder = [];
    const spaceRows = db.prepare("SELECT id, data FROM spaces ORDER BY sort_order").all();
    if (spaceRows.length || hasEmptyFlag("spaces")) {
      state.spaces = [];
      for (const row of spaceRows) {
        const sp = JSON.parse(row.data);
        state.spaces.push(sp);
        this._spacesOrder.push(row.id);
        this._spacesSnap.set(row.id, snapshotValue(sp));
      }
    }

    // 5. panels
    this._panelsSnap.clear();
    this._panelsOrder = [];
    const panelRows = db.prepare("SELECT id, data FROM panels ORDER BY sort_order").all();
    if (panelRows.length || hasEmptyFlag("panels")) {
      state.panels = [];
      for (const row of panelRows) {
        const panel = JSON.parse(row.data);
        state.panels.push(panel);
        this._panelsOrder.push(row.id);
        this._panelsSnap.set(row.id, snapshotValue(panel));
      }
    }

    // 6. tasks
    this._tasksSnap.clear();
    this._tasksOrder = [];
    const taskRows = db.prepare("SELECT id, data FROM tasks ORDER BY sort_order").all();
    if (taskRows.length || hasEmptyFlag("tasks")) {
      state.tasks = [];
      for (const row of taskRows) {
        const task = JSON.parse(row.data);
        state.tasks.push(task);
        this._tasksOrder.push(row.id);
        this._tasksSnap.set(row.id, snapshotValue(task));
      }
    }

    // 6b. workflows & workflow_runs
    this._workflowsSnap.clear();
    this._workflowsOrder = [];
    const wfRows = db.prepare("SELECT id, data FROM workflows ORDER BY sort_order").all();
    if (wfRows.length || hasEmptyFlag("workflows")) {
      state.workflows = [];
      for (const row of wfRows) {
        const wf = JSON.parse(row.data);
        state.workflows.push(wf);
        this._workflowsOrder.push(row.id);
        this._workflowsSnap.set(row.id, snapshotValue(wf));
      }
    }
    this._workflowRunsSnap.clear();
    this._workflowRunsOrder = [];
    const wfRunRows = db.prepare("SELECT id, sort_order, data FROM workflow_runs ORDER BY sort_order").all();
    this._workflowRunSortKey = new Map();
    if (wfRunRows.length || hasEmptyFlag("workflowRuns")) {
      state.workflowRuns = [];
      for (const row of wfRunRows) {
        const wfr = JSON.parse(row.data);
        state.workflowRuns.push(wfr);
        this._workflowRunsOrder.push(row.id);
        this._workflowRunSortKey.set(row.id, row.sort_order);
        this._workflowRunsSnap.set(row.id, snapshotValue(wfr));
      }
    }

    // 7. chats + messages + routines
    this._chatsSnap.clear();
    this._chatsOrder = [];
    this._chatSortKey = new Map();
    const chatsById = new Map();
    for (const row of db.prepare("SELECT id, sort_order, data FROM chats ORDER BY sort_order").all()) {
      const chat = JSON.parse(row.data);
      chat.messages = [];
      state.chats.push(chat);
      chatsById.set(row.id, chat);
      this._chatsOrder.push(row.id);
      this._chatSortKey.set(row.id, row.sort_order);
      this._chatsSnap.set(row.id, {
        metaSnap: snapshotObjectExcept(chat, "messages", "schedules"),
        msgSnaps: [],
        schedSnaps: null,
      });
    }
    for (const row of db.prepare("SELECT chat_id, data FROM messages ORDER BY chat_id, seq").all()) {
      const chat = chatsById.get(row.chat_id);
      if (!chat) continue;
      const msg = JSON.parse(row.data);
      chat.messages.push(msg);
      this._chatsSnap.get(row.chat_id).msgSnaps.push(snapshotValue(msg));
    }
    for (const row of db.prepare("SELECT chat_id, data FROM routines ORDER BY chat_id, seq").all()) {
      const chat = chatsById.get(row.chat_id);
      if (!chat) continue;
      const sched = JSON.parse(row.data);
      if (!chat.schedules) chat.schedules = [];
      chat.schedules.push(sched);
      const tracker = this._chatsSnap.get(row.chat_id);
      if (!tracker.schedSnaps) tracker.schedSnaps = [];
      tracker.schedSnaps.push(snapshotValue(sched));
    }

    // 8. runs + run_steps (lazy input/output for finished runs with large payloads)
    this._runsSnap.clear();
    this._runsOrder = [];
    this._runSortKey = new Map();
    const runsById = new Map();
    const workingRunIds = new Set();
    const helperIdsByRun = new Map();
    for (const row of db.prepare("SELECT id, sort_order, status, data FROM runs ORDER BY sort_order").all()) {
      const run = JSON.parse(row.data);
      state.runs.push(run);
      runsById.set(row.id, run);
      if (row.status === "Working") workingRunIds.add(row.id);
      if (Array.isArray(run.agents) && run.agents.length) {
        helperIdsByRun.set(row.id, new Set(run.agents.map((a) => a.id)));
      }
      this._runsOrder.push(row.id);
      this._runSortKey.set(row.id, row.sort_order);
      this._runsSnap.set(row.id, {
        metaSnap: snapshotObjectExcept(run, "steps"),
        stepSnaps: new Map(),
        stepOrder: [],
        hadStepsArray: false,
        lastStatus: run.status,
        stepsRef: null,
        lastStepRef: null,
      });
    }

    const useLazy = this.lazySteps && !hydrateAllSteps;
    if (useLazy) {
      // Load full input/output ONLY for Working runs, short fields (<= LIGHT_STEP_TEXT),
      // or ask/ask_user steps. Everything else is loaded lazily on demand.
      const stepRows = db.prepare(`
        SELECT
          rs.run_id,
          rs.id,
          rs.name,
          rs.data,
          CASE
            WHEN r.status = 'Working'
              OR rs.input IS NULL
              OR length(rs.input) <= ${LIGHT_STEP_TEXT}
              OR lower(COALESCE(rs.name, '')) IN ('ask_user', 'ask')
            THEN rs.input
            ELSE NULL
          END AS input,
          CASE
            WHEN r.status = 'Working'
              OR rs.output IS NULL
              OR length(rs.output) <= ${LIGHT_STEP_TEXT}
              OR lower(COALESCE(rs.name, '')) IN ('ask_user', 'ask')
            THEN rs.output
            ELSE NULL
          END AS output,
          CASE
            WHEN r.status != 'Working'
              AND rs.input IS NOT NULL
              AND length(rs.input) > ${LIGHT_STEP_TEXT}
              AND lower(COALESCE(rs.name, '')) NOT IN ('ask_user', 'ask')
            THEN 1 ELSE 0
          END AS input_deferred,
          CASE
            WHEN r.status != 'Working'
              AND rs.output IS NOT NULL
              AND length(rs.output) > ${LIGHT_STEP_TEXT}
              AND lower(COALESCE(rs.name, '')) NOT IN ('ask_user', 'ask')
            THEN 1 ELSE 0
          END AS output_deferred
        FROM run_steps rs
        JOIN runs r ON r.id = rs.run_id
        ORDER BY rs.run_id, rs.seq
      `).all();

      for (const row of stepRows) {
        const run = runsById.get(row.run_id);
        if (!run) continue;
        const step = JSON.parse(row.data);
        const helpers = helperIdsByRun.get(row.run_id);
        const isHelper = helpers?.has(step.id);

        let inputDeferred = row.input_deferred === 1;
        let outputDeferred = row.output_deferred === 1;

        if ((inputDeferred || outputDeferred) && isHelper) {
          // Helper-launching steps keep full input/output so helper prompts stay available.
          const full = this._stmt.selectStepDetail.get(row.run_id, row.id);
          if (full) {
            if (full.input !== null) step.input = full.input;
            if (full.output !== null) step.output = full.output;
          }
          inputDeferred = false;
          outputDeferred = false;
        } else {
          if (row.input !== null) step.input = row.input;
          if (row.output !== null) step.output = row.output;
          if (inputDeferred || outputDeferred) {
            step.more = true;
            lazyStepMeta.set(step, { inputDeferred, outputDeferred });
          }
        }

        if (!run.steps) run.steps = [];
        run.steps.push(step);
        const tracker = this._runsSnap.get(row.run_id);
        tracker.hadStepsArray = true;
        tracker.stepOrder.push(row.id);
        tracker.stepSnaps.set(row.id, snapshotValue(step));
        tracker.stepsRef = run.steps;
        tracker.lastStepRef = step;
      }
    } else {
      const stepRows = db.prepare("SELECT run_id, id, input, output, data FROM run_steps ORDER BY run_id, seq").all();
      for (const row of stepRows) {
        const run = runsById.get(row.run_id);
        if (!run) continue;
        const step = JSON.parse(row.data);
        if (row.input !== null) step.input = row.input;
        if (row.output !== null) step.output = row.output;
        if (!run.steps) run.steps = [];
        run.steps.push(step);
        const tracker = this._runsSnap.get(row.run_id);
        tracker.hadStepsArray = true;
        tracker.stepOrder.push(row.id);
        tracker.stepSnaps.set(row.id, snapshotValue(step));
        tracker.stepsRef = run.steps;
        tracker.lastStepRef = step;
      }
    }

    return state;
  }

  /**
   * Read a single step's full `input` and `output` from SQLite on demand.
   * Returns `{ input?, output? }` or `null` when the step does not exist in the DB.
   */
  readStepPayload(runId, stepId) {
    if (this.closed || !runId || !stepId) return null;
    const row = this._stmt.selectStepDetail.get(String(runId), String(stepId));
    if (!row) return null;
    return {
      ...(row.input !== null && { input: row.input }),
      ...(row.output !== null && { output: row.output }),
    };
  }

  /**
   * Hydrate an in-memory lazy step object with its full `input` and `output` from SQLite.
   */
  hydrateStep(runId, step) {
    if (!step || !lazyStepMeta.has(step) || this.closed) return step;
    const payload = this.readStepPayload(runId, step.id);
    if (payload) {
      if (payload.input !== undefined && step.input === undefined) step.input = payload.input;
      if (payload.output !== undefined && step.output === undefined) step.output = payload.output;
    }
    delete step.more;
    lazyStepMeta.delete(step);
    return step;
  }

  /**
   * Export the complete persisted workspace state (including all step payloads) from SQLite.
   * Useful for diagnostics, snapshots (node-convert), and tests.
   */
  exportState() {
    const db = this.db;
    const state = { bots: [], chats: [], runs: [] };
    const exportEmpty = new Set();
    for (const row of db.prepare("SELECT key, value FROM kv").all()) {
      if (row.key.startsWith("__empty_")) {
        exportEmpty.add(row.key.slice("__empty_".length));
        continue;
      }
      if (row.key.startsWith("__")) continue;
      state[row.key] = JSON.parse(row.value);
    }
    for (const row of db.prepare("SELECT data FROM bots ORDER BY sort_order").all()) state.bots.push(JSON.parse(row.data));
    const projects = db.prepare("SELECT data FROM projects ORDER BY sort_order").all();
    if (projects.length || exportEmpty.has("projects")) state.projects = projects.map((r) => JSON.parse(r.data));
    const spaces = db.prepare("SELECT data FROM spaces ORDER BY sort_order").all();
    if (spaces.length || exportEmpty.has("spaces")) state.spaces = spaces.map((r) => JSON.parse(r.data));
    const panels = db.prepare("SELECT data FROM panels ORDER BY sort_order").all();
    if (panels.length || exportEmpty.has("panels")) state.panels = panels.map((r) => JSON.parse(r.data));
    const tasks = db.prepare("SELECT data FROM tasks ORDER BY sort_order").all();
    if (tasks.length || exportEmpty.has("tasks")) state.tasks = tasks.map((r) => JSON.parse(r.data));
    const workflows = db.prepare("SELECT data FROM workflows ORDER BY sort_order").all();
    if (workflows.length || exportEmpty.has("workflows")) state.workflows = workflows.map((r) => JSON.parse(r.data));
    const workflowRuns = db.prepare("SELECT data FROM workflow_runs ORDER BY sort_order").all();
    if (workflowRuns.length || exportEmpty.has("workflowRuns")) state.workflowRuns = workflowRuns.map((r) => JSON.parse(r.data));

    const chatsById = new Map();
    for (const row of db.prepare("SELECT id, data FROM chats ORDER BY sort_order").all()) {
      const chat = JSON.parse(row.data);
      chat.messages = [];
      state.chats.push(chat);
      chatsById.set(row.id, chat);
    }
    for (const row of db.prepare("SELECT chat_id, data FROM messages ORDER BY chat_id, seq").all()) {
      chatsById.get(row.chat_id)?.messages.push(JSON.parse(row.data));
    }
    for (const row of db.prepare("SELECT chat_id, data FROM routines ORDER BY chat_id, seq").all()) {
      const chat = chatsById.get(row.chat_id);
      if (chat) (chat.schedules ??= []).push(JSON.parse(row.data));
    }

    const runsById = new Map();
    for (const row of db.prepare("SELECT id, data FROM runs ORDER BY sort_order").all()) {
      const run = JSON.parse(row.data);
      state.runs.push(run);
      runsById.set(row.id, run);
    }
    for (const row of db.prepare("SELECT run_id, input, output, data FROM run_steps ORDER BY run_id, seq").all()) {
      const run = runsById.get(row.run_id);
      if (!run) continue;
      const step = JSON.parse(row.data);
      if (row.input !== null) step.input = row.input;
      if (row.output !== null) step.output = row.output;
      (run.steps ??= []).push(step);
    }
    return state;
  }

  /**
   * Sync a simple id-keyed collection table (`bots`, `projects`, `spaces`, `panels`, `tasks`).
   * Only writes rows whose contents or sort_order changed, and deletes removed rows.
   */
  _syncSimpleTable(items, prevSnap, prevOrder, prefix, upsertFn, deleteStmt) {
    const list = Array.isArray(items) ? items : [];
    const nextIds = new Set();
    const nextOrder = [];
    const seen = new Set();

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const id = uniqueRowId(item && typeof item === "object" ? item : null, i, seen, prefix);
      nextIds.add(id);
      nextOrder.push(id);
      const prev = prevSnap.get(id);
      const orderChanged = prevOrder[i] !== id;
      if (orderChanged || !prev || !sameSnapshot(prev, item)) {
        upsertFn(id, i, item);
        prevSnap.set(id, snapshotValue(item));
      }
    }

    for (const oldId of prevSnap.keys()) {
      if (!nextIds.has(oldId)) {
        deleteStmt.run(oldId);
        prevSnap.delete(oldId);
      }
    }
    return nextOrder;
  }

  /**
   * Persist one chat row + only its changed/appended messages and schedules.
   */
  _syncChat(chat, chatId, sortOrder, orderChanged) {
    let tracker = this._chatsSnap.get(chatId);
    if (!tracker) {
      this._stmt.upsertChat.run(
        chatId,
        sortOrder,
        typeof chat.botId === "string" ? chat.botId : null,
        Number.isFinite(chat.time) ? chat.time : null,
        chat.archived ? 1 : 0,
        serializeObjectExcept(chat, "messages", "schedules"),
      );
      const msgSnaps = [];
      const msgs = Array.isArray(chat.messages) ? chat.messages : [];
      for (let m = 0; m < msgs.length; m++) {
        const msg = msgs[m];
        this._stmt.upsertMsg.run(
          chatId,
          m,
          typeof msg?.runId === "string" ? msg.runId : null,
          typeof msg?.role === "string" ? msg.role : null,
          Number.isFinite(msg?.time) ? msg.time : null,
          JSON.stringify(msg),
        );
        msgSnaps.push(snapshotValue(msg));
      }
      let schedSnaps = null;
      if (Array.isArray(chat.schedules)) {
        schedSnaps = [];
        const schedSeen = new Set();
        for (let s = 0; s < chat.schedules.length; s++) {
          const sched = chat.schedules[s];
          const sid = uniqueRoutineId(sched, s, schedSeen);
          this._stmt.upsertRoutine.run(
            sid,
            chatId,
            s,
            typeof sched?.name === "string" ? sched.name : null,
            sched?.enabled === false ? 0 : 1,
            Number.isFinite(sched?.nextAt) ? sched.nextAt : null,
            JSON.stringify(sched),
          );
          schedSnaps.push(snapshotValue(sched));
        }
      }
      this._chatsSnap.set(chatId, {
        metaSnap: snapshotObjectExcept(chat, "messages", "schedules"),
        msgSnaps,
        schedSnaps,
      });
      return;
    }

    // Chat metadata changed or reordered
    if (orderChanged || !sameObjectExcept(tracker.metaSnap, chat, "messages", "schedules")) {
      this._stmt.upsertChat.run(
        chatId,
        sortOrder,
        typeof chat.botId === "string" ? chat.botId : null,
        Number.isFinite(chat.time) ? chat.time : null,
        chat.archived ? 1 : 0,
        serializeObjectExcept(chat, "messages", "schedules"),
      );
      tracker.metaSnap = snapshotObjectExcept(chat, "messages", "schedules");
    }

    // Messages: append / edit in-place / truncate
    // In-place edits (reactions, voice revisions, interim normalization) mutate objects inside
    // `chat.messages`, so we compare each slot against its last-saved structural snapshot (O(1) per string).
    const msgs = Array.isArray(chat.messages) ? chat.messages : [];
    const prevMsgs = tracker.msgSnaps;
    const minLen = Math.min(msgs.length, prevMsgs.length);
    for (let m = 0; m < minLen; m++) {
      if (!sameSnapshot(prevMsgs[m], msgs[m])) {
        const msg = msgs[m];
        this._stmt.upsertMsg.run(
          chatId,
          m,
          typeof msg?.runId === "string" ? msg.runId : null,
          typeof msg?.role === "string" ? msg.role : null,
          Number.isFinite(msg?.time) ? msg.time : null,
          JSON.stringify(msg),
        );
        prevMsgs[m] = snapshotValue(msg);
      }
    }
    if (msgs.length > prevMsgs.length) {
      for (let m = prevMsgs.length; m < msgs.length; m++) {
        const msg = msgs[m];
        this._stmt.upsertMsg.run(
          chatId,
          m,
          typeof msg?.runId === "string" ? msg.runId : null,
          typeof msg?.role === "string" ? msg.role : null,
          Number.isFinite(msg?.time) ? msg.time : null,
          JSON.stringify(msg),
        );
        prevMsgs.push(snapshotValue(msg));
      }
    } else if (msgs.length < prevMsgs.length) {
      this._stmt.deleteMsgsFrom.run(chatId, msgs.length);
      prevMsgs.length = msgs.length;
    }

    // Schedules / routines (typically small, 0..25 per chat)
    const scheds = Array.isArray(chat.schedules) ? chat.schedules : null;
    const prevScheds = tracker.schedSnaps;
    let schedChanged = false;
    if ((scheds === null) !== (prevScheds === null)) {
      schedChanged = true;
    } else if (scheds && prevScheds) {
      if (scheds.length !== prevScheds.length) schedChanged = true;
      else {
        for (let s = 0; s < scheds.length; s++) {
          if (!sameSnapshot(prevScheds[s], scheds[s])) {
            schedChanged = true;
            break;
          }
        }
      }
    }
    if (schedChanged) {
      this._stmt.deleteRoutinesForChat.run(chatId);
      if (scheds) {
        const nextSchedSnaps = [];
        const schedSeen = new Set();
        for (let s = 0; s < scheds.length; s++) {
          const sched = scheds[s];
          const sid = uniqueRoutineId(sched, s, schedSeen);
          this._stmt.upsertRoutine.run(
            sid,
            chatId,
            s,
            typeof sched?.name === "string" ? sched.name : null,
            sched?.enabled === false ? 0 : 1,
            Number.isFinite(sched?.nextAt) ? sched.nextAt : null,
            JSON.stringify(sched),
          );
          nextSchedSnaps.push(snapshotValue(sched));
        }
        tracker.schedSnaps = nextSchedSnaps;
      } else {
        tracker.schedSnaps = null;
      }
    }
  }

  /**
   * Persist one step row, respecting deferred lazy input/output so we never overwrite unloaded blobs
   * in SQLite with NULL.
   */
  _upsertStep(runId, stepId, seq, step) {
    const lazy = lazyStepMeta.get(step);
    const name = typeof step.name === "string" ? step.name : null;
    const status = typeof step.status === "string" ? step.status : null;
    const started = Number.isFinite(step.started) ? step.started : null;
    const finished = Number.isFinite(step.finished) ? step.finished : null;
    const input = typeof step.input === "string" ? step.input : null;
    const output = typeof step.output === "string" ? step.output : null;
    const meta = stepMetaJson(step);

    if (lazy) {
      const keepInput = lazy.inputDeferred && step.input === undefined ? 1 : 0;
      const keepOutput = lazy.outputDeferred && step.output === undefined ? 1 : 0;
      this._stmt.upsertStepMetaKeepBlobs.run(
        runId, stepId, seq, name, status, started, finished, input, output, meta,
        keepInput, keepOutput,
      );
      // If caller explicitly wrote a new input/output over a lazy step, clear the deferred flag.
      if (step.input !== undefined) lazy.inputDeferred = false;
      if (step.output !== undefined) lazy.outputDeferred = false;
      if (!lazy.inputDeferred && !lazy.outputDeferred) lazyStepMeta.delete(step);
    } else {
      this._stmt.upsertStepFull.run(runId, stepId, seq, name, status, started, finished, input, output, meta);
    }
  }

  /**
   * Persist one run row + only its changed/added/removed steps.
   */
  _syncRun(run, runId, sortOrder, orderChanged) {
    let tracker = this._runsSnap.get(runId);
    if (!tracker) {
      this._stmt.upsertRun.run(
        runId,
        sortOrder,
        typeof run.chatId === "string" ? run.chatId : null,
        typeof run.status === "string" ? run.status : null,
        Number.isFinite(run.time) ? run.time : null,
        Number.isFinite(run.finished) ? run.finished : null,
        serializeObjectExcept(run, "steps"),
      );
      const stepSnaps = new Map();
      const stepOrder = [];
      const hadStepsArray = Array.isArray(run.steps);
      if (hadStepsArray) {
        const stepSeen = new Set();
        for (let s = 0; s < run.steps.length; s++) {
          const step = run.steps[s];
          if (!step || typeof step !== "object") continue;
          const sid = uniqueStepId(step, s, stepSeen);
          this._upsertStep(runId, sid, s, step);
          stepOrder.push(sid);
          stepSnaps.set(sid, snapshotValue(step));
        }
      }
      this._runsSnap.set(runId, {
        metaSnap: snapshotObjectExcept(run, "steps"),
        stepSnaps,
        stepOrder,
        hadStepsArray,
        lastStatus: run.status,
        stepsRef: hadStepsArray ? run.steps : null,
        lastStepRef: hadStepsArray && run.steps.length ? run.steps[run.steps.length - 1] : null,
      });
      return;
    }

    if (orderChanged || !sameObjectExcept(tracker.metaSnap, run, "steps")) {
      this._stmt.upsertRun.run(
        runId,
        sortOrder,
        typeof run.chatId === "string" ? run.chatId : null,
        typeof run.status === "string" ? run.status : null,
        Number.isFinite(run.time) ? run.time : null,
        Number.isFinite(run.finished) ? run.finished : null,
        serializeObjectExcept(run, "steps"),
      );
      tracker.metaSnap = snapshotObjectExcept(run, "steps");
    }

    // Fast path: if this run is finished, already persisted, and still holds the exact same
    // steps array length with unchanged step object references/lazy states, check quickly.
    const steps = Array.isArray(run.steps) ? run.steps : null;
    if (!steps) {
      if (tracker.stepOrder.length) {
        this._stmt.deleteStepsForRun.run(runId);
        tracker.stepSnaps.clear();
        tracker.stepOrder = [];
      }
      tracker.hadStepsArray = false;
      tracker.lastStatus = run.status;
      tracker.stepsRef = null;
      tracker.lastStepRef = null;
      return;
    }

    // O(1) fast path for finished runs whose steps array hasn't been touched:
    // Completed/failed/stopped/interrupted runs with the exact same `steps` array reference,
    // same length, and same last step object reference cannot have changed unless mutated in place;
    // note that `trimRun` creates a new `steps` array reference (replacing `run.steps`), so it
    // automatically bypasses this fast path and clears trimmed `input`/`output` columns in SQLite!
    if (
      run.status !== "Working" &&
      tracker.lastStatus !== "Working" &&
      tracker.stepsRef === steps &&
      tracker.stepOrder.length === steps.length &&
      (steps.length === 0 || tracker.lastStepRef === steps[steps.length - 1])
    ) {
      return;
    }

    const nextIds = new Set();
    const nextOrder = [];
    const stepSeen = new Set();
    for (let s = 0; s < steps.length; s++) {
      const step = steps[s];
      if (!step || typeof step !== "object") continue;
      const sid = uniqueStepId(step, s, stepSeen);
      nextIds.add(sid);
      nextOrder.push(sid);
      const prev = tracker.stepSnaps.get(sid);
      const seqChanged = tracker.stepOrder[s] !== sid;
      if (seqChanged || !prev || !sameSnapshot(prev, step)) {
        this._upsertStep(runId, sid, s, step);
        tracker.stepSnaps.set(sid, snapshotValue(step));
      }
    }
    for (const oldSid of tracker.stepSnaps.keys()) {
      if (!nextIds.has(oldSid)) {
        this._stmt.deleteStep.run(runId, oldSid);
        tracker.stepSnaps.delete(oldSid);
      }
    }
    tracker.stepOrder = nextOrder;
    tracker.hadStepsArray = true;
    tracker.lastStatus = run.status;
    tracker.stepsRef = steps;
    tracker.lastStepRef = steps.length ? steps[steps.length - 1] : null;
  }

  /**
   * Flush all dirty rows of `state` in a single SQLite transaction.
   * Replaces the full-file JSON rewrite while keeping the exact `WorkspaceWriter.save(state, active)` signature.
   */
  save(state, active = new Map()) {
    if (this.closed) return;

    // Remember active runs for incremental saveSoon() turn checkpoints.
    const turns = new Map();
    if (active && active.size) {
      for (const chat of state.chats ?? []) {
        const run = active.get(chat.id)?.run;
        if (run?.status !== "Working") continue;
        turns.set(run, { chat, run });
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 1. Simple collections
      this._botsOrder = this._syncSimpleTable(
        state.bots, this._botsSnap, this._botsOrder, "bot",
        (id, i, bot) => this._stmt.upsertBot.run(id, i, typeof bot?.name === "string" ? bot.name : null, JSON.stringify(bot)),
        this._stmt.deleteBot,
      );
      this._projectsOrder = this._syncSimpleTable(
        state.projects, this._projectsSnap, this._projectsOrder, "proj",
        (id, i, p) => this._stmt.upsertProject.run(id, i, typeof p?.name === "string" ? p.name : null, Number.isFinite(p?.createdAt) ? p.createdAt : null, JSON.stringify(p)),
        this._stmt.deleteProject,
      );
      this._spacesOrder = this._syncSimpleTable(
        state.spaces, this._spacesSnap, this._spacesOrder, "space",
        (id, i, sp) => this._stmt.upsertSpace.run(id, i, typeof sp?.name === "string" ? sp.name : null, sp?.builtin ? 1 : 0, Number.isFinite(sp?.createdAt) ? sp.createdAt : null, JSON.stringify(sp ?? null)),
        this._stmt.deleteSpace,
      );
      this._panelsOrder = this._syncSimpleTable(
        state.panels, this._panelsSnap, this._panelsOrder, "panel",
        (id, i, panel) => this._stmt.upsertPanel.run(
          id, i,
          typeof panel?.spaceId === "string" ? panel.spaceId : null,
          typeof panel?.botId === "string" ? panel.botId : null,
          typeof panel?.chatId === "string" ? panel.chatId : null,
          Number.isFinite(panel?.updatedAt) ? panel.updatedAt : null,
          JSON.stringify(panel),
        ),
        this._stmt.deletePanel,
      );
      this._tasksOrder = this._syncSimpleTable(
        state.tasks, this._tasksSnap, this._tasksOrder, "task",
        (id, i, task) => this._stmt.upsertTask.run(
          id, i,
          typeof task?.botId === "string" ? task.botId : null,
          typeof task?.chatId === "string" ? task.chatId : null,
          typeof task?.status === "string" ? task.status : null,
          typeof task?.priority === "string" ? task.priority : null,
          Number.isFinite(task?.createdAt) ? task.createdAt : null,
          JSON.stringify(task),
        ),
        this._stmt.deleteTask,
      );
      this._workflowsOrder = this._syncSimpleTable(
        state.workflows, this._workflowsSnap, this._workflowsOrder, "wf",
        (id, i, wf) => this._stmt.upsertWorkflow.run(
          id, i,
          typeof wf?.name === "string" ? wf.name : null,
          wf?.enabled === false ? 0 : 1,
          Number.isFinite(wf?.createdAt) ? wf.createdAt : null,
          JSON.stringify(wf),
        ),
        this._stmt.deleteWorkflow,
      );
      this._syncWorkflowRunsOrdered(state.workflowRuns);

      // 2. Chats + messages + routines
      this._syncChatsOrdered(state.chats);

      // 3. Runs + run_steps
      // Use negative/decreasing sort_order for prepended runs (runs.unshift) so inserting one new
      // run at index 0 does NOT force rewriting sort_order on all 1,000+ historical runs!
      this._syncRunsOrdered(state.runs);

      // 4. Singleton / misc kv entries
      const seenKv = new Set();
      for (const [key, value] of Object.entries(state)) {
        if (SKIP_KV_KEYS.has(key) || value === undefined) continue;
        seenKv.add(key);
        const prev = this._kvSnap.get(key);
        if (prev === undefined || !sameSnapshot(prev, value)) {
          this._stmt.upsertKv.run(key, JSON.stringify(value));
          this._kvSnap.set(key, snapshotValue(value));
        }
      }
      for (const oldKey of this._kvSnap.keys()) {
        if (!seenKv.has(oldKey)) {
          this._stmt.deleteKv.run(oldKey);
          this._kvSnap.delete(oldKey);
        }
      }
      this._emptyFlags ??= new Set();
      for (const col of ["projects", "spaces", "panels", "tasks", "workflows", "workflowRuns"]) {
        const isEmpty = Array.isArray(state[col]) && state[col].length === 0;
        if (isEmpty && !this._emptyFlags.has(col)) {
          this._stmt.upsertKv.run("__empty_" + col, "1");
          this._emptyFlags.add(col);
        } else if (!isEmpty && this._emptyFlags.has(col)) {
          this._stmt.deleteKv.run("__empty_" + col);
          this._emptyFlags.delete(col);
        }
      }

      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    this.turns = turns;
    this.dirtyTurns.clear();
    this.written.clear();
  }

  /**
   * Sync `state.workflowRuns` with stable sort keys (workflowRuns are prepended via unshift).
   */
  _syncWorkflowRunsOrdered(list) {
    const items = Array.isArray(list) ? list : [];
    const nextIds = new Set();
    const seen = new Set();
    const ids = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== "object") continue;
      const id = uniqueRowId(item, i, seen, "wfr");
      ids[i] = id;
      nextIds.add(id);
    }

    this._workflowRunSortKey ??= new Map();
    if (this._workflowRunSortKey.size === 0 && this._workflowRunsOrder.length > 0) {
      for (let i = 0; i < this._workflowRunsOrder.length; i++) {
        this._workflowRunSortKey.set(this._workflowRunsOrder[i], i);
      }
    }

    let needsFullRenumber = false;
    let firstExistingIdx = -1;
    let lastKey = -Infinity;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const existingKey = this._workflowRunSortKey.get(id);
      if (existingKey !== undefined) {
        if (firstExistingIdx === -1) firstExistingIdx = i;
        if (existingKey <= lastKey) {
          needsFullRenumber = true;
          break;
        }
        lastKey = existingKey;
      } else if (firstExistingIdx !== -1) {
        let hasExistingAfter = false;
        for (let j = i + 1; j < ids.length; j++) {
          if (ids[j] && this._workflowRunSortKey.has(ids[j])) {
            hasExistingAfter = true;
            break;
          }
        }
        if (hasExistingAfter) {
          needsFullRenumber = true;
          break;
        }
      }
    }

    const upsert = (id, key, wfr) => {
      this._stmt.upsertWorkflowRun.run(
        id, key,
        typeof wfr?.workflowId === "string" ? wfr.workflowId : null,
        typeof wfr?.status === "string" ? wfr.status : null,
        Number.isFinite(wfr?.startedAt) ? wfr.startedAt : null,
        JSON.stringify(wfr),
      );
    };

    if (needsFullRenumber) {
      for (let i = 0; i < items.length; i++) {
        const id = ids[i];
        if (!id) continue;
        const prevKey = this._workflowRunSortKey.get(id);
        this._workflowRunSortKey.set(id, i);
        const prev = this._workflowRunsSnap.get(id);
        if (prevKey !== i || !prev || !sameSnapshot(prev, items[i])) {
          upsert(id, i, items[i]);
          this._workflowRunsSnap.set(id, snapshotValue(items[i]));
        }
      }
    } else {
      const firstExistingKey = firstExistingIdx >= 0 ? this._workflowRunSortKey.get(ids[firstExistingIdx]) : 0;
      let tailKey = lastKey === -Infinity ? 0 : lastKey;
      for (let i = 0; i < items.length; i++) {
        const id = ids[i];
        if (!id) continue;
        let key = this._workflowRunSortKey.get(id);
        let keyChanged = false;
        if (key === undefined) {
          if (firstExistingIdx >= 0 && i < firstExistingIdx) key = firstExistingKey - (firstExistingIdx - i);
          else {
            tailKey += 1;
            key = tailKey;
          }
          this._workflowRunSortKey.set(id, key);
          keyChanged = true;
        }
        const prev = this._workflowRunsSnap.get(id);
        if (keyChanged || !prev || !sameSnapshot(prev, items[i])) {
          upsert(id, key, items[i]);
          this._workflowRunsSnap.set(id, snapshotValue(items[i]));
        }
      }
    }

    for (const oldId of this._workflowRunsSnap.keys()) {
      if (!nextIds.has(oldId)) {
        this._stmt.deleteWorkflowRun.run(oldId);
        this._workflowRunsSnap.delete(oldId);
        this._workflowRunSortKey.delete(oldId);
      }
    }
    this._workflowRunsOrder = ids.filter(Boolean);
  }

  /**
   * Sync `state.chats` with stable sort keys so `chats.unshift(newChat)` only writes the 1 new row
   * instead of updating `sort_order` on every historical chat.
   */
  _syncChatsOrdered(chatsList) {
    const chats = Array.isArray(chatsList) ? chatsList : [];
    const nextChatIds = new Set();
    const chatSeen = new Set();
    const ids = new Array(chats.length);
    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i];
      if (!chat || typeof chat !== "object") continue;
      const id = uniqueRowId(chat, i, chatSeen, "chat");
      ids[i] = id;
      nextChatIds.add(id);
    }

    this._chatSortKey ??= new Map();
    if (this._chatSortKey.size === 0 && this._chatsOrder.length > 0) {
      for (let i = 0; i < this._chatsOrder.length; i++) {
        this._chatSortKey.set(this._chatsOrder[i], i);
      }
    }

    let needsFullRenumber = false;
    let firstExistingIdx = -1;
    let lastKey = -Infinity;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const existingKey = this._chatSortKey.get(id);
      if (existingKey !== undefined) {
        if (firstExistingIdx === -1) firstExistingIdx = i;
        if (existingKey <= lastKey) {
          needsFullRenumber = true;
          break;
        }
        lastKey = existingKey;
      } else if (firstExistingIdx !== -1) {
        let hasExistingAfter = false;
        for (let j = i + 1; j < ids.length; j++) {
          if (ids[j] && this._chatSortKey.has(ids[j])) {
            hasExistingAfter = true;
            break;
          }
        }
        if (hasExistingAfter) {
          needsFullRenumber = true;
          break;
        }
      }
    }

    if (needsFullRenumber) {
      for (let i = 0; i < chats.length; i++) {
        const id = ids[i];
        if (!id) continue;
        const prevKey = this._chatSortKey.get(id);
        this._chatSortKey.set(id, i);
        this._syncChat(chats[i], id, i, prevKey !== i);
      }
    } else {
      const firstExistingKey = firstExistingIdx >= 0 ? this._chatSortKey.get(ids[firstExistingIdx]) : 0;
      let tailKey = lastKey === -Infinity ? 0 : lastKey;
      for (let i = 0; i < chats.length; i++) {
        const id = ids[i];
        if (!id) continue;
        let key = this._chatSortKey.get(id);
        let keyChanged = false;
        if (key === undefined) {
          if (firstExistingIdx >= 0 && i < firstExistingIdx) {
            key = firstExistingKey - (firstExistingIdx - i);
          } else {
            tailKey += 1;
            key = tailKey;
          }
          this._chatSortKey.set(id, key);
          keyChanged = true;
        }
        this._syncChat(chats[i], id, key, keyChanged);
      }
    }

    for (const oldChatId of this._chatsSnap.keys()) {
      if (!nextChatIds.has(oldChatId)) {
        this._stmt.deleteChat.run(oldChatId);
        this._chatsSnap.delete(oldChatId);
        this._chatSortKey.delete(oldChatId);
      }
    }
    this._chatsOrder = ids.filter(Boolean);
  }

  /**
   * Sync `state.runs` with stable sort keys so `runs.unshift(newRun)` only inserts the 1 new row
   * (assigning `minSortOrder - 1`) instead of updating `sort_order` on every historical run!
   */
  _syncRunsOrdered(runsList) {
    const runs = Array.isArray(runsList) ? runsList : [];
    const nextRunIds = new Set();
    const runSeen = new Set();
    const ids = new Array(runs.length);
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (!run || typeof run !== "object") continue;
      const id = uniqueRowId(run, i, runSeen, "run");
      ids[i] = id;
      nextRunIds.add(id);
    }

    // Track per-run numeric sort_order keys in `this._runSortKey` (Map<runId, number>).
    this._runSortKey ??= new Map();
    if (this._runSortKey.size === 0 && this._runsOrder.length > 0) {
      for (let i = 0; i < this._runsOrder.length; i++) {
        this._runSortKey.set(this._runsOrder[i], i);
      }
    }

    // Fast path: check if existing runs still appear in strictly ascending sort_order key order.
    // New runs prepended at index 0..k-1 get keys (firstExistingKey - k) .. (firstExistingKey - 1).
    let needsFullRenumber = false;
    let firstExistingIdx = -1;
    let lastKey = -Infinity;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const existingKey = this._runSortKey.get(id);
      if (existingKey !== undefined) {
        if (firstExistingIdx === -1) firstExistingIdx = i;
        if (existingKey <= lastKey) {
          needsFullRenumber = true;
          break;
        }
        lastKey = existingKey;
      } else if (firstExistingIdx !== -1) {
        // A new run inserted in the middle or at the end: check if it's at the very end.
        // If at the end (no existing runs follow it), we can assign lastKey + 1; otherwise renumber.
        let hasExistingAfter = false;
        for (let j = i + 1; j < ids.length; j++) {
          if (ids[j] && this._runSortKey.has(ids[j])) {
            hasExistingAfter = true;
            break;
          }
        }
        if (hasExistingAfter) {
          needsFullRenumber = true;
          break;
        }
      }
    }

    if (needsFullRenumber) {
      for (let i = 0; i < runs.length; i++) {
        const id = ids[i];
        if (!id) continue;
        const prevKey = this._runSortKey.get(id);
        this._runSortKey.set(id, i);
        this._syncRun(runs[i], id, i, prevKey !== i);
      }
    } else {
      const firstExistingKey = firstExistingIdx >= 0 ? this._runSortKey.get(ids[firstExistingIdx]) : 0;
      let tailKey = lastKey === -Infinity ? 0 : lastKey;
      for (let i = 0; i < runs.length; i++) {
        const id = ids[i];
        if (!id) continue;
        let key = this._runSortKey.get(id);
        let keyChanged = false;
        if (key === undefined) {
          if (firstExistingIdx >= 0 && i < firstExistingIdx) {
            key = firstExistingKey - (firstExistingIdx - i);
          } else {
            tailKey += 1;
            key = tailKey;
          }
          this._runSortKey.set(id, key);
          keyChanged = true;
        }
        this._syncRun(runs[i], id, key, keyChanged);
      }
    }

    for (const oldRunId of this._runsSnap.keys()) {
      if (!nextRunIds.has(oldRunId)) {
        this._stmt.deleteRun.run(oldRunId);
        this._runsSnap.delete(oldRunId);
        this._runSortKey.delete(oldRunId);
      }
    }
    this._runsOrder = ids.filter(Boolean);
  }

  /**
   * Mark a live working run for incremental checkpoint on the next `saveSoon()` flush.
   * Returns `true` if the run is tracked as an active working turn; `false` triggers a full dirty-diff save.
   */
  mark(run) {
    if (!run || !this.turns.has(run)) return false;
    this.dirtyTurns.add(run);
    return true;
  }

  /**
   * Compatible with `WorkspaceWriter.voiceChanged`: our row-level chat sync already diffs
   * every message slot in the active chat so voice edits before the tail are preserved automatically.
   */
  voiceChanged(run) {
    if (run && this.turns.has(run)) this.dirtyTurns.add(run);
  }

  /**
   * Flush only the dirty active turns (their run metadata, changed steps, and chat/messages)
   * directly into SQLite in one tiny transaction — zero JSON sidecar files needed, and crash-safe
   * via SQLite WAL.
   */
  checkpoint(indexMessages) {
    if (this.closed || !this.dirtyTurns.size) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const run of this.dirtyTurns) {
        const entry = this.turns.get(run);
        if (!entry) continue;
        const { chat } = entry;
        indexMessages?.(chat);
        const chatKey = this._chatSortKey?.get(chat.id);
        if (chatKey !== undefined) {
          this._syncChat(chat, chat.id, chatKey, false);
        }
        const runKey = this._runSortKey?.get(run.id);
        if (runKey !== undefined) {
          this._syncRun(run, run.id, runKey, false);
        }
        this.dirtyTurns.delete(run);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  /**
   * Prune step payloads or delete runs directly in SQLite (used when coordinating with
   * workspace pruning on SQLite-backed workspaces).
   */
  pruneRunsSql({ trimRunIds = [], deleteRunIds = [] } = {}) {
    if (this.closed) return { trimmed: 0, deleted: 0 };
    let trimmed = 0;
    let deleted = 0;
    const clearStepBlobs = this.db.prepare("UPDATE run_steps SET input = NULL, output = NULL WHERE run_id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const runId of trimRunIds) {
        const res = clearStepBlobs.run(runId);
        trimmed += Number(res.changes ?? 0);
        const tracker = this._runsSnap.get(runId);
        if (tracker) {
          tracker.stepsRef = null;
          tracker.stepSnaps.clear();
        }
      }
      for (const runId of deleteRunIds) {
        const res = this._stmt.deleteRun.run(runId);
        deleted += Number(res.changes ?? 0);
        this._runsSnap.delete(runId);
        this._runSortKey?.delete(runId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    return { trimmed, deleted };
  }

  /**
   * Checkpoint WAL and close the SQLite handle cleanly.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Ignore close errors during shutdown.
    }
  }
}

/**
 * Helper: determine whether a data directory already has a workspace (either SQLite or legacy JSON).
 */
export function hasWorkspaceFile(dataDir) {
  return existsSync(join(dataDir, WORKSPACE_DB_FILENAME)) || existsSync(join(dataDir, "workspace.json"));
}

/**
 * Read a workspace's persisted state from either `workspace.db` or `workspace.json` in `dir`.
 * Used by tools, conversion snapshots, and tests.
 */
export function readWorkspaceState(dir, options = {}) {
  const dbPath = join(dir, WORKSPACE_DB_FILENAME);
  if (existsSync(dbPath)) {
    const store = new SqliteWorkspaceStore(dir, { lazySteps: false });
    try {
      return store.exportState();
    } finally {
      store.close();
    }
  }
  const jsonPath = join(dir, "workspace.json");
  if (existsSync(jsonPath)) return readWorkspace(jsonPath, options);
  return null;
}

/**
 * Return the active workspace storage path (`workspace.db` if present, else `workspace.json`).
 */
export function workspaceStorePath(dir) {
  const dbPath = join(dir, WORKSPACE_DB_FILENAME);
  if (existsSync(dbPath)) return dbPath;
  return join(dir, "workspace.json");
}

/**
 * Format a byte count for human-readable CLI output.
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Export a SQLite workspace (`workspace.db` in `dir`) to a standalone `workspace.json` file
 * using atomic temp-file write + rename (mode 0o600). Used for downgrade / backup.
 */
export function exportWorkspaceToJson(dir, outPath = join(dir, "workspace.json")) {
  const dbPath = join(dir, WORKSPACE_DB_FILENAME);
  if (!existsSync(dbPath)) {
    throw new Error(`No ${WORKSPACE_DB_FILENAME} found in ${dir}.`);
  }
  const t0 = performance.now();
  const store = new SqliteWorkspaceStore(dir, { lazySteps: false });
  let state;
  let counts;
  try {
    state = store.exportState();
    counts = countDbRecords(store.db);
  } finally {
    store.close();
  }
  const json = JSON.stringify(state);
  const parent = dirname(outPath);
  mkdirSync(parent, { recursive: true });
  const tmpPath = `${outPath}.export-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, json, { mode: 0o600 });
    renameSync(tmpPath, outPath);
    setPrivateMode(outPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  const bytes = statSync(outPath).size;
  const elapsedMs = Math.round((performance.now() - t0) * 10) / 10;
  return {
    status: "exported",
    dir,
    dbPath,
    outPath,
    bytes,
    elapsedMs,
    counts,
  };
}

/**
 * Resolve the path of the workspace file to inspect for a backup/snapshot file path.
 * Accepts either a directory or a direct file path (`workspace.db` or `workspace.json`).
 */
export function readWorkspaceFromPath(fileOrDir) {
  const base = basename(fileOrDir);
  if (base === WORKSPACE_DB_FILENAME) {
    const store = new SqliteWorkspaceStore(dirname(fileOrDir), { lazySteps: false });
    try {
      return store.exportState();
    } finally {
      store.close();
    }
  }
  if (base === "workspace.json") return readWorkspace(fileOrDir);
  return readWorkspaceState(fileOrDir);
}
