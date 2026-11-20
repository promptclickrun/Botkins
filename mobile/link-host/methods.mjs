// The desktop calls a paired phone may make. A call that opens a window, a file dialog or the
// clipboard on the computer is left out, and so is anything added to the desktop later until it is
// listed here.
//
// Where the app on the computer opens a dialog, a phone has a call that opens nothing: a file goes
// out and comes in as text ("exportTemplateText", "importTemplateText", "exportUsageText",
// "exportWikiFile"), and a folder is chosen from "listFolders", which names the folders inside the
// person's home folder and nothing else (no files, no contents). The desktop app decides what each
// may read; this file checks the shape of what a phone sends.
//
// What is listed still acts on the computer, as the person's own app would: it changes bots,
// projects, skills, the wiki and tool (MCP) servers, and a tool server may name a program to run.
// Pairing is a full-trust step, and the desktop app checks the arguments of each call. In
// particular a message may mention a file (`mentions`), and the desktop app itself checks that a
// mentioned file is inside the chat's own folders (the bot's workspace and the project folder).
// This file checks the shape of a mention, that its path never climbs with "..", that a wiki page is
// named from the wiki's own top, and what a message may attach (see remoteArgs).
import { basename } from "node:path";
import { safeName } from "./uploads.mjs";

export const REMOTE_METHODS = new Set([
  // Preferences
  "setPreferences", "appInfo",
  // Bots
  "addBot", "updateBot", "setBotFlags", "makePrimary", "reorderBots", "deleteBot", "duplicateBot",
  "importableAgents", "importAgents", "setBotAccess", "setBotIntegrations", "botMemory", "setBotMemory",
  "addSection", "renameSection", "deleteSection",
  "saveTemplate", "renameTemplate", "deleteTemplate", "exportTemplateText", "importTemplateText",
  // Chats
  "createChat", "createGroupChat", "setChatFlags", "renameChat", "deleteChat", "forkChat", "warmChat",
  "setChatProject", "startProjectChat",
  "send", "stop", "unqueue", "sendNow", "retry", "compact", "sideQuestion", "respond", "clearApprovals",
  "mentionables", "catalog", "linkPreview",
  // Models and providers
  "models", "setModel", "providers", "setProviderEnabled", "auth", "signIn", "cancelSignIn", "signOut",
  "providerServices", "connectProviderService", "finishProviderService", "cancelProviderService", "disconnectProviderService",
  // Routines and tasks
  "createRoutine", "updateRoutine", "setRoutineEnabled", "deleteRoutine", "runRoutine", "duplicateRoutine",
  "previewCadence", "changeSchedule",
  "saveTask", "moveTask", "startTask", "deleteTask",
  // Today
  "refreshPanel", "changePanel", "routine", "boardAct",
  // Skills and MCP servers
  "skills", "readSkill", "saveSkill", "removeSkill", "setSkillEnabled", "removeSkillFolder",
  "saveMcpServer", "setMcpServerEnabled", "removeMcpServer", "testMcpServer", "signInMcpServer",
  "cancelMcpSignIn", "signOutMcpServer", "importMcpServers",
  "credentials", "removeCredential",
  // Projects
  "createProject", "updateProject", "renameProject", "removeProject", "projectChanges", "projectDiff", "projectCommit",
  "addTodo", "updateTodo", "deleteTodo", "moveTodo",
  // Wiki
  "wikiTree", "wikiPage", "saveWikiPage", "createWikiPage", "createWikiPageFor", "createWikiFolder", "moveWiki",
  "deleteWiki", "searchWiki", "wikiHistory", "wikiVersion", "restoreWikiVersion", "wikiExportPlan", "exportWikiFile",
  // Usage and storage. "testNotification" shows a notification on the computer, which is what its button is for.
  "usage", "exportUsageText", "cacheInfo", "clearCache", "providerUsage", "testNotification",
  // The computer's folders, by name only, and the two calls that take one a person chose there
  "listFolders", "addProjectFolder", "addSkillFolderAt",
  // The side pane a bot opened beside a chat: what the person does with it (the desktop app's docs/SIDE_PANE.md)
  "sidePane",
]);

const MAX_ATTACHMENTS = 10;
const MAX_MENTIONS = 12;
/** The most text a file from a phone may hold, in characters (a bot template). */
export const MAX_FILE_TEXT = 2 * 1024 * 1024;
const MAX_WIKI_PATHS = 2000;
const MAX_DAYS = 3660;
const WIKI_FORMATS = ["zip", "html", "pdf"];
const WIKI_SCOPES = ["all", "project", "page"];

const clean = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
const only = (object, keys) => Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
// No step of a path may climb out of where it starts.
const climbs = (path) => path.split(/[\\/]/).includes("..");
// A wiki page is named from the wiki's own top: never from the disk's, and never upward.
const inWiki = (path) => !climbs(path) && !/^([\\/]|[A-Za-z]:)/.test(path);

/** The mentions of a message that have exactly the shape the composer sends; anything else is dropped. */
function cleanMentions(mentions) {
  const kept = [];
  for (const item of Array.isArray(mentions) ? mentions : []) {
    if (kept.length >= MAX_MENTIONS) break;
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    if ((item.kind === "project" || item.kind === "board") && only(item, ["kind", "id"]) && clean(item.id)) kept.push({ kind: item.kind, id: item.id });
    else if ((item.kind === "file" || item.kind === "wiki") && only(item, ["kind", "path"]) && clean(item.path) && (item.kind === "wiki" ? inWiki(item.path) : !climbs(item.path))) kept.push({ kind: item.kind, path: item.path });
  }
  return kept;
}

// A folder on the computer: its whole path from the top of the disk, with no step that climbs.
const folderPath = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0") && !climbs(value) && /^([\\/]|[A-Za-z]:[\\/])/.test(value);
const refuse = (sentence) => {
  throw new Error(sentence);
};

/** The arguments of a call that stands in for a file or folder dialog, or null when `method` is not one. */
function fileArgs(method, args) {
  const first = args[0];
  const object = first !== null && typeof first === "object" && !Array.isArray(first) ? first : {};
  switch (method) {
    case "importTemplateText": {
      if (typeof object.text !== "string" || !object.text.trim()) refuse("That file is empty.");
      if (object.text.length > MAX_FILE_TEXT) refuse("That file is too big to import (2 MB at most).");
      const name = typeof object.name === "string" ? safeName(object.name) : "";
      return [{ ...(name && { name }), text: object.text }];
    }
    case "exportTemplateText":
      if (clean(object.templateId)) return [{ templateId: object.templateId }];
      if (clean(object.botId)) return [{ botId: object.botId }];
      return refuse("Choose a bot or a template to export.");
    case "exportUsageText":
      if (!Number.isInteger(first) || first < 1 || first > MAX_DAYS) refuse("Choose a range to export.");
      return [first];
    case "exportWikiFile": {
      if (!WIKI_FORMATS.includes(object.format)) refuse("Choose a format to export.");
      const paths = Array.isArray(object.paths) ? object.paths : [];
      if (paths.length > MAX_WIKI_PATHS || !paths.every((path) => clean(path) && inWiki(path))) refuse("Those pages can't be exported.");
      // A phone never brings the document itself (`html`): the computer lays it out from the pages.
      return [{ format: object.format, paths, ...(typeof object.title === "string" && { title: object.title.slice(0, 200) }), ...(object.everything === true && { everything: true }) }];
    }
    case "wikiExportPlan": {
      const path = object.path;
      if (!WIKI_SCOPES.includes(object.scope) || (path !== undefined && !(clean(path) && inWiki(path)))) refuse("Those pages can't be exported.");
      return [{ scope: object.scope, ...(path !== undefined && { path }) }];
    }
    case "listFolders":
      if (first === undefined || first === null) return [];
      if (!folderPath(first)) refuse("That folder can't be shown.");
      return [first];
    case "addProjectFolder":
    case "addSkillFolderAt":
      if (!folderPath(first)) refuse("Choose a folder.");
      return [first];
    default:
      return null;
  }
}

/**
 * Arguments as a phone may send them. A call that stands in for a file or folder dialog is cut to
 * the shape above and refused with a sentence when it has another. A message can attach only files this phone uploaded itself
 * (`context.uploads`, for `context.deviceId`); any other attachment is dropped without a word, and the
 * path kept is the file's real one. Its mentions are cleaned to the shapes above.
 */
export function remoteArgs(method, args, { deviceId, uploads } = {}) {
  if (method === "send" && args[2] && typeof args[2] === "object") {
    const { attachments, mentions, ...options } = args[2];
    const own = [];
    for (const item of Array.isArray(attachments) ? attachments : []) {
      const path = uploads?.ownFile(deviceId, item?.path);
      if (path && own.length < MAX_ATTACHMENTS && !own.some((a) => a.path === path)) own.push({ name: typeof item.name === "string" ? safeName(item.name) : basename(path), path, kind: "file" });
    }
    const said = cleanMentions(mentions);
    return [args[0], args[1], { ...options, ...(own.length && { attachments: own }), ...(said.length && { mentions: said }) }];
  }
  return fileArgs(method, args) ?? args;
}
