// The fields Botkins reads from workspace.json. The loader runs before any part can save or
// publish the workspace. Settings, messages and other user content keep their own formats.
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { botAccess } from "./access.mjs";

const workspaceFields = new Set([
  "apps", "board", "bots", "chats", "frames", "mcpServers", "mediaPass", "panels",
  "hostDispatch", "nodeHost", "outgoingDispatches", "detachedQuestions", "pendingMessages", "proactive", "projects", "runs", "sections", "settings", "skills", "spaces", "tasks", "templates",
]);
const projectFields = new Set([
  "id", "name", "description", "folder", "color", "todos", "artifacts", "lastUsed", "createdAt",
  "folders", "mode",
  "path", // migrateProject reads the folder from this field in early files.
]);

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
