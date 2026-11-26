// The fields Botkins reads from workspace.json. The loader runs before any part can save or
// publish the workspace. Settings, messages and other user content keep their own formats.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { botAccess } from "./access.mjs";

const workspaceFields = new Set([
  "apps", "board", "bots", "chats", "claudeArtifacts", "frames", "mcpServers", "mediaPass", "panels",
  "hostDispatch", "nodeHost", "outgoingDispatches", "detachedQuestions", "pendingMessages", "proactive", "projects", "runs", "sections", "settings", "skills", "spaces", "tasks", "templates",
]);
const projectFields = new Set([
  "id", "name", "description", "folder", "color", "todos", "artifacts", "lastUsed", "createdAt",
  "folders", "mode",
  "path", // migrateProject reads the folder from this field in early files.
]);

function writeAtomic(file, text) {
  writeFileSync(file + ".tmp", text, { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

const digest = text => createHash("sha256").update(text).digest("hex");
const checkpointDir = file => join(dirname(file), "turn-checkpoints");
const checkpointPath = (dir, base, runId) =>
  join(dir, digest(JSON.stringify([base, runId])) + ".json");

// Checkpoints belong to one full save. A crash after replacing workspace.json but before
// removing old checkpoints cannot replay an older draft over a stopped or deleted run.
export class WorkspaceWriter {
  constructor(file) {
    this.file = file;
    this.directory = checkpointDir(file);
    this.turns = new Map();
    this.dirty = new Set();
    this.written = new Set();
    if (existsSync(this.directory)) {
      for (const name of readdirSync(this.directory)) {
        if (/^[a-f0-9]{64}\.json(?:\.tmp)?$/.test(name)) this.written.add(join(this.directory, name));
      }
    }
  }

  save(state, active) {
    const base = active.size ? randomUUID() : null;
    const turns = new Map();
    for (const chat of active.size ? state.chats : []) {
      const run = active.get(chat.id)?.run;
      if (run?.status !== "Working") continue;
      // Tool boundaries append interim messages. The last row of the full save may also
      // change in place while recording speech or finishing an interim reply.
      const last = chat.messages.at(-1);
      const from = last && (last.voicePartial || last.interim) ? chat.messages.length - 1 : chat.messages.length;
      turns.set(run, { chat, from, file: checkpointPath(this.directory, base, run.id) });
    }
    writeAtomic(this.file, JSON.stringify(turns.size ? { ...state, turnCheckpointBase: base } : state));
    this.turns = turns;
    this.dirty.clear();
    for (const file of this.written) rmSync(file, { force: true });
    this.written.clear();
  }

  mark(run) {
    if (!this.turns.has(run)) return false;
    this.dirty.add(run);
    return true;
  }

  // A partial voice transcript can revise an older utterance or insert it before its reply.
  // The next checkpoint must replace the suffix starting at that row, including any shifted rows.
  voiceChanged(run, voiceId) {
    const turn = this.turns.get(run);
    if (!turn || !turn.from) return;
    const index = turn.chat.messages.findLastIndex(message => message.voiceId === voiceId);
    turn.from = Math.min(turn.from, Math.max(0, index));
  }

  checkpoint(indexMessages) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const run of this.dirty) {
      const { chat, from, file } = this.turns.get(run);
      indexMessages(chat);
      const { messages, ...fields } = chat;
      const data = JSON.stringify({ run, chat: fields, from, messages: messages.slice(from) });
      writeAtomic(file, `{"digest":"${digest(data)}","data":${data}}`);
      this.written.add(file);
      this.dirty.delete(run);
    }
  }
}

function restoreCheckpoints(file, state) {
  const base = state.turnCheckpointBase;
  delete state.turnCheckpointBase;
  if (!base) return;
  const directory = checkpointDir(file);
  for (const [index, existing] of state.runs.entries()) {
    if (existing.status !== "Working") continue;
    let saved;
    try {
      const record = JSON.parse(readFileSync(checkpointPath(directory, base, existing.id), "utf8"));
      // Treat damaged optional progress as a missed checkpoint; the full save remains authoritative.
      if (!record?.data || record.digest !== digest(JSON.stringify(record.data))) continue;
      saved = record.data;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) continue;
      throw error;
    }
    const chatIndex = state.chats.findIndex(chat => chat.id === existing.chatId);
    const chat = state.chats[chatIndex];
    if (!chat || saved?.run?.id !== existing.id || saved.run.chatId !== existing.chatId ||
        saved.run.status !== "Working" || saved.chat?.id !== chat.id || saved.chat.botId !== chat.botId ||
        !Number.isSafeInteger(saved.from) || saved.from < 0 || saved.from > chat.messages.length ||
        !Array.isArray(saved.messages) || !saved.messages.every(message => typeof message?.role === "string")) continue;
    state.runs[index] = saved.run;
    state.chats[chatIndex] = { ...saved.chat, messages: chat.messages.slice(0, saved.from).concat(saved.messages) };
  }
}

/** Preserve sections outside the current format before the next workspace save drops them. */
function archiveSections(dir, sections) {
  const text = JSON.stringify(sections, null, 2) + "\n";
  for (let n = 1; ; n++) {
    const file = join(dir, n === 1 ? "archived-records.json" : "archived-records-" + n + ".json");
    try {
      writeFileSync(file, text, { mode: 0o600, flag: "wx" });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    // A previous start may have written the archive before it could save the active workspace.
    const stat = lstatSync(file);
    if (stat.isFile() && stat.size === Buffer.byteLength(text) && readFileSync(file, "utf8") === text) return;
  }
}

/** Early workspaces granted access to groups of projects as well as to individual projects.
 * Materialize an inherited grant only when its saved collection, record and project link agree.
 * Current-format workspaces and live access updates accept only explicit projects.
 */
function restoreProjectGrants(state, retired) {
  if (Object.hasOwn(state, "spaces") || retired.length !== 1) return;
  const [section, rows] = retired[0];
  if (!section.endsWith("s") || !Array.isArray(rows) || !rows.length) return;
  if (!rows.every((row) => typeof row?.id === "string" && row.id && typeof row.name === "string")) return;
  const parentField = section.slice(0, -1) + "Id";
  const records = new Set(rows.map((row) => row.id));
  for (const { access } of state.bots) {
    if (!Array.isArray(access?.[section])) continue;
    const granted = new Set(access[section].filter((id) => records.has(id)));
    if (!granted.size) continue;
    const direct = Array.isArray(access.projects) ? access.projects : [];
    const inherited = (state.projects ?? []).filter((project) => granted.has(project[parentField]));
    access.projects = [...new Set([...direct, ...inherited.map((project) => project.id)])];
  }
}

// Sent messages keep an inert label for a reference that no longer has a target.
// A queued message keeps its text and only sends references the host can still resolve.
const mentionKinds = new Set(["board", "file", "project", "wiki"]);
function restoreMentions(message, sent) {
  if (!Array.isArray(message.mentions) || message.mentions.every((mention) => mentionKinds.has(mention?.kind))) return;
  message.mentions = message.mentions.flatMap((mention, index) => {
    if (mentionKinds.has(mention?.kind)) return [mention];
    if (sent && typeof mention?.label === "string") return [{ kind: "label", id: String(index), label: mention.label }];
    return [];
  });
  if (!message.mentions.length) delete message.mentions;
}

// Move extra fields out of active records, keeping a private recovery copy of their values.
function takeExtras(record, supported) {
  const entries = Object.entries(record).filter(([key]) => !supported.has(key));
  for (const [key] of entries) delete record[key];
  return entries.filter(([, value]) => value != null && !(Array.isArray(value) && !value.length));
}

const grantFields = new Set(["all", "projects"]);
export function readWorkspace(file) {
  const state = JSON.parse(readFileSync(file, "utf8"));
  restoreCheckpoints(file, state);
  const sections = takeExtras(state, workspaceFields);
  const recovery = {};
  if (sections.length) {
    recovery.sections = Object.fromEntries(sections);
    restoreProjectGrants(state, sections);
  }
  for (const project of state.projects ?? []) {
    const extra = takeExtras(project, projectFields);
    if (extra.length) (recovery.projects ??= []).push({ id: project.id, fields: Object.fromEntries(extra) });
  }
  for (const bot of state.bots) {
    if (!bot.access) continue;
    const extra = takeExtras(bot.access, grantFields);
    if (extra.length) (recovery.grants ??= []).push({ id: bot.id, fields: Object.fromEntries(extra) });
    bot.access = botAccess(bot);
  }
  if (Object.keys(recovery).length) archiveSections(dirname(file), recovery);
  for (const chat of state.chats) for (const message of chat.messages) restoreMentions(message, true);
  for (const queue of Object.values(state.pendingMessages ?? {})) {
    for (const message of queue) restoreMentions(message, false);
  }
  return state;
}
