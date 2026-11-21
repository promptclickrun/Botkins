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
// What a bot made or was given is read through "artifacts.list", "artifacts.read",
// "artifacts.thumbnail" and "artifacts.resolve". The app keeps the index and reads only what is in
// it, checked again at each read: none of these is a way to read any file on the computer.
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
import { botVoiceField } from "./voice.mjs";

/**
 * The plugin calls ("plugins-v1"), by their wire names. A rename is a change here and in pluginArgs.
 * "plugins.refresh" ("market-refresh-v1") reads every marketplace again now, for a person who asked.
 */
export const PLUGIN_METHODS = [
  "plugins.marketplaces", "plugins.addMarketplace", "plugins.removeMarketplace", "plugins.browse", "plugins.preview",
  "plugins.install", "plugins.addFolder", "plugins.configure", "plugins.setBots", "plugins.setEnabled", "plugins.update", "plugins.uninstall",
  "plugins.refresh",
];

/** Agent templates in a marketplace ("agent-templates-v1", docs/agent-templates.md): reads only. */
export const AGENT_METHODS = ["agents.browse", "agents.template"];

/**
 * Marketplace › Apps on the computer: the apps of the person's Composio account, through the
 * computer's own Composio tool and its sign-in (desktop/composio.mjs). A phone signs in to Composio
 * itself; these are for a window that uses this computer from another one.
 */
export const COMPOSIO_METHODS = ["composio.catalog", "composio.connected", "composio.accounts", "composio.connect", "composio.removeAccount"];

/** The app's space calls ("spaces-v1"), by their wire names. A rename is a change here and in spaceArgs. */
export const SPACE_METHODS = [
  "spaces.read", "spaces.create", "spaces.rename", "spaces.remove", "spaces.setProject", "spaces.setPanelProject",
  "spaces.newPanel", "spaces.ask", "spaces.movePanel", "spaces.patchState", "spaces.note", "spaces.removeNote",
];
/** How a new panel may start, and the limits of what people write into a space. */
export const PANEL_STARTS = ["checklist", "tracker", "chart", "table", "notes", "app"];
export const SPACE_SIZES = { name: 40, prompt: 4000, note: 2000, label: 80, state: 64 * 1024, stateKeys: 200 };

export const REMOTE_METHODS = new Set([
  // Preferences
  "setPreferences", "appInfo",
  // The computer's own updates ("app-update-v1"). Where a release comes from is fixed on the computer:
  // no call takes a version, an address or a channel (appUpdateArgs).
  "appUpdateStatus", "checkAppUpdate", "installAppUpdate", "setAppUpdateAuto",
  // Bots
  "addBot", "updateBot", "setBotFlags", "makePrimary", "reorderBots", "deleteBot", "duplicateBot",
  "importableAgents", "importAgents", "setBotAccess", "setBotIntegrations", "botMemory", "setBotMemory",
  "addSection", "renameSection", "deleteSection",
  "saveTemplate", "renameTemplate", "deleteTemplate", "exportTemplateText", "importTemplateText",
  // Chats
  "createChat", "createGroupChat", "setChatFlags", "renameChat", "deleteChat", "forkChat", "warmChat",
  "setChatProject", "startProjectChat", "recordVoiceLine",
  "send", "stop", "unqueue", "sendNow", "retry", "compact", "sideQuestion", "respond", "clearApprovals",
  "mentionables", "catalog", "linkPreview",
  // Models and providers
  "models", "setModel", "providers", "harnesses", "setProviderEnabled", "auth", "signIn", "cancelSignIn", "signOut",
  "providerServices", "connectProviderService", "finishProviderService", "cancelProviderService", "disconnectProviderService",
  // Signing in and installing from a phone ("provider-signin-v1"): the computer runs the provider's
  // own sign-in or install command; the phone only names the provider.
  "providerSignInStart", "providerSignInRead", "providerSignInInput", "providerSignInCancel", "providerUseToken", "installProvider",
  // Routines and tasks
  "createRoutine", "updateRoutine", "setRoutineEnabled", "deleteRoutine", "runRoutine", "duplicateRoutine",
  "previewCadence", "changeSchedule",
  "saveTask", "moveTask", "startTask", "deleteTask",
  // Today
  "refreshPanel", "changePanel", "routine", "boardAct",
  // Spaces ("spaces-v1", docs/spaces.md): pages of panels, private or shared. Each is cut to its shape (spaceArgs).
  ...SPACE_METHODS,
  // Skills and MCP servers
  "skills", "readSkill", "saveSkill", "removeSkill", "setSkillEnabled", "removeSkillFolder",
  "saveMcpServer", "setMcpServerEnabled", "removeMcpServer", "testMcpServer", "signInMcpServer",
  "cancelMcpSignIn", "signOutMcpServer", "importMcpServers",
  "credentials", "removeCredential",
  // Projects
  "createProject", "updateProject", "renameProject", "removeProject", "projectChanges", "projectDiff", "projectCommit",
  "addTodo", "updateTodo", "deleteTodo", "moveTodo",
  // What a project keeps of the artifacts ("project-artifacts-v1"): a list of ids on the project.
  "addProjectArtifact", "removeProjectArtifact", "projectArtifacts",
  // Wiki
  "wikiTree", "wikiPage", "saveWikiPage", "createWikiPage", "createWikiPageFor", "createWikiFolder", "moveWiki",
  "deleteWiki", "searchWiki", "wikiHistory", "wikiVersion", "restoreWikiVersion", "wikiExportPlan", "exportWikiFile",
  // Usage and storage. "testNotification" shows a notification on the computer, which is what its button is for.
  "usage", "exportUsageText", "cacheInfo", "clearCache", "providerUsage", "testNotification",
  // The computer's folders, by name only, and the two calls that take one a person chose there
  "listFolders", "addProjectFolder", "addSkillFolderAt",
  // What a bot made or was given ("artifacts-v1"): the app keeps an index, and these read only what is in it
  "artifacts.list", "artifacts.read", "artifacts.thumbnail", "artifacts.resolve",
  // The side pane a bot opened beside a chat: what the person does with it (the desktop app's docs/SIDE_PANE.md)
  "sidePane",
  // Plugins ("plugins-v1", docs/plugins.md): catalogs, installing, settings, bots, on and off
  ...PLUGIN_METHODS,
  // Agent templates ("agent-templates-v1") and the computer's Composio apps
  ...AGENT_METHODS,
  ...COMPOSIO_METHODS,
]);

const MAX_ATTACHMENTS = 10;
const MAX_MENTIONS = 12;
/** The most text a file from a phone may hold, in characters (a bot template). */
export const MAX_FILE_TEXT = 2 * 1024 * 1024;
const MAX_WIKI_PATHS = 2000;
const MAX_DAYS = 3660;
const WIKI_FORMATS = ["zip", "html", "pdf"];
const WIKI_SCOPES = ["all", "project", "page"];
/** An artifact is read in pieces of at most this many bytes. */
export const MAX_ARTIFACT_CHUNK = 512 * 1024;
/** How many paths of one message the app is asked about at once. */
export const MAX_RESOLVE_PATHS = 20;
const MAX_THUMBNAIL = 512;
const ARTIFACT_KINDS = ["files", "media"];
// A path as it stands in a message, or an artifact's id: text of a sensible length that never climbs.
const artifactRef = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0") && !climbs(value);
const whole = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

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
    case "artifacts.list": {
      if (!clean(object.botId)) refuse("Choose a bot.");
      for (const name of ["chatId", "folder", "cursor"]) if (object[name] !== undefined && !clean(object[name])) refuse("That list can't be shown.");
      if (object.kind !== undefined && !ARTIFACT_KINDS.includes(object.kind)) refuse("That list can't be shown.");
      return [{ botId: object.botId, ...(object.chatId !== undefined && { chatId: object.chatId }), ...(object.kind !== undefined && { kind: object.kind }), ...(object.folder !== undefined && { folder: object.folder }), ...(object.cursor !== undefined && { cursor: object.cursor }) }];
    }
    case "artifacts.read": {
      if (!artifactRef(first)) refuse("That file can't be opened.");
      const options = args[1] !== null && typeof args[1] === "object" && !Array.isArray(args[1]) ? args[1] : {};
      if (options.offset !== undefined && !whole(options.offset, 0, Number.MAX_SAFE_INTEGER)) refuse("That file can't be opened.");
      if (options.length !== undefined && !whole(options.length, 1, MAX_ARTIFACT_CHUNK)) refuse("That file can't be opened.");
      return [first, { ...(options.offset !== undefined && { offset: options.offset }), ...(options.length !== undefined && { length: options.length }) }];
    }
    case "artifacts.thumbnail": {
      if (!artifactRef(first)) refuse("That file can't be opened.");
      const size = args[1] !== null && typeof args[1] === "object" ? args[1].size : undefined;
      if (size !== undefined && !whole(size, 16, MAX_THUMBNAIL)) refuse("That picture can't be shown at that size.");
      return [first, size === undefined ? {} : { size }];
    }
    case "artifacts.resolve": {
      const paths = object.paths;
      if (!clean(object.chatId) || !Array.isArray(paths) || paths.length < 1 || paths.length > MAX_RESOLVE_PATHS || !paths.every(artifactRef)) refuse("Those paths can't be looked up.");
      return [{ chatId: object.chatId, paths: [...paths] }];
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

// Plugins (docs/plugins.md). Ids are opaque: only their length and shape are checked here.
export const PLUGIN_LIMITS = { id: 300, source: 300, query: 200, values: 32, value: 4000, bots: 200 };
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pluginText = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0");
const pluginId = (value) => {
  if (!pluginText(value, PLUGIN_LIMITS.id)) refuse("That plugin can't be found.");
  return value;
};
const revisionOf = (value) => {
  if (value === undefined) return undefined;
  if (!pluginText(value, PLUGIN_LIMITS.id)) refuse("That plugin can't be found.");
  return value;
};
/**
 * What a switch-on or a choice of bots may carry beside its value: nothing, or the revision of the
 * description the person looked at (the installed copy's hash, 64 hex characters), which the app
 * compares with the installed one. Nothing else passes.
 */
function revisionOption(value) {
  if (value === undefined || value === null) return [];
  if (!plain(value) || Object.keys(value).some((key) => key !== "revision")) refuse("Check the plugin request.");
  if (value.revision === undefined) return [];
  if (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) refuse("Check the plugin request.");
  return [{ revision: value.revision }];
}
/** "all", or bot ids: at least one, at most 200, each once. */
function pluginBots(value) {
  if (value === "all") return "all";
  if (!Array.isArray(value) || value.length < 1 || value.length > PLUGIN_LIMITS.bots || !value.every((id) => pluginText(id, PLUGIN_LIMITS.id))) refuse("Choose which bots use it.");
  return [...new Set(value)];
}
/**
 * A plugin's settings: at most 32, each text (4,000 characters at most), a saved credential
 * (`{ $credential: id }`, which the link fills in: credentials.mjs) or null to clear it. These are
 * the only places in a plugin call that may hold a credential.
 */
function pluginValues(value) {
  if (!plain(value)) refuse("Those settings can't be saved.");
  const keys = Object.keys(value);
  if (keys.length > PLUGIN_LIMITS.values) refuse("Those settings can't be saved.");
  const out = {};
  for (const key of keys) {
    const item = value[key];
    if (!pluginText(key, PLUGIN_LIMITS.id) || key === "__proto__") refuse("Those settings can't be saved.");
    if (item === null) out[key] = null;
    else if (typeof item === "string") {
      if (item.length > PLUGIN_LIMITS.value || item.includes("\0")) refuse("A setting is up to 4,000 characters.");
      out[key] = item;
    } else if (plain(item) && only(item, ["$credential"]) && pluginText(item.$credential, PLUGIN_LIMITS.id)) out[key] = { $credential: item.$credential };
    else refuse("Those settings can't be saved.");
  }
  return out;
}

/** Whether a saved credential's reference is anywhere in `value`. */
const holdsRef = (value, depth = 0) => depth <= 8 && value !== null && typeof value === "object" && (Object.hasOwn(value, "$credential") || Object.values(value).some((inner) => holdsRef(inner, depth + 1)));

/** The arguments of an agent template call or a Composio call, cut to its shape, or null when `method` is not one. */
const APP_SLUG = /^[a-z0-9_]{1,64}$/;
function marketArgs(method, args) {
  if (!AGENT_METHODS.includes(method) && !COMPOSIO_METHODS.includes(method)) return null;
  const first = args[0];
  switch (method) {
    case "agents.browse": {
      const query = plain(first) ? first : {};
      if (query.query !== undefined && (typeof query.query !== "string" || query.query.length > PLUGIN_LIMITS.query)) refuse("That search is too long.");
      for (const key of ["category", "marketplace"]) if (query[key] !== undefined && !pluginText(query[key], PLUGIN_LIMITS.id)) refuse("That list can't be shown.");
      const words = typeof query.query === "string" ? query.query.trim() : "";
      return [{ ...(words && { query: words }), ...(query.category !== undefined && { category: query.category }), ...(query.marketplace !== undefined && { marketplace: query.marketplace }) }];
    }
    case "agents.template":
      if (!pluginText(first, PLUGIN_LIMITS.id)) refuse("That template can't be found.");
      return [first];
    case "composio.catalog":
      // `{ fresh: true }`: the person asked for the list again, so the computer asks the server now.
      return plain(first) && first.fresh === true ? [{ fresh: true }] : [];
    case "composio.connected":
      return [];
    case "composio.accounts":
      if (!Array.isArray(first) || first.length > 50 || !first.every((slug) => typeof slug === "string" && APP_SLUG.test(slug))) refuse("Those apps can't be found.");
      return [[...new Set(first)]];
    case "composio.connect":
      if (typeof first !== "string" || !APP_SLUG.test(first)) refuse("That app can't be found.");
      return [first];
    case "composio.removeAccount":
      if (typeof first !== "string" || !APP_SLUG.test(first) || !pluginText(args[1], 200)) refuse("That account can't be found.");
      return [first, args[1]];
    default:
      return null;
  }
}

/** The arguments of a plugin call, cut to its shape, or null when `method` is not one. */
function pluginArgs(method, args) {
  if (!PLUGIN_METHODS.includes(method)) return null;
  // A saved credential may stand only for a setting's value: nowhere else in a plugin call.
  const rest = method === "plugins.configure" ? [args[0]] : method === "plugins.install" && plain(args[1]) ? [args[0], { ...args[1], config: undefined }, ...args.slice(2)] : args;
  if (holdsRef(rest)) refuse("A credential can't be used there.");
  const first = args[0];
  const second = plain(args[1]) ? args[1] : {};
  switch (method) {
    case "plugins.marketplaces":
    case "plugins.refresh":
      return [];
    case "plugins.addMarketplace": {
      const source = typeof first === "string" ? first.trim() : "";
      if (!pluginText(source, PLUGIN_LIMITS.source)) refuse("Enter owner/repo, a web address or a folder.");
      return [source];
    }
    case "plugins.removeMarketplace":
      if (!pluginText(first, PLUGIN_LIMITS.id)) refuse("That marketplace can't be found.");
      return [first];
    case "plugins.browse": {
      const query = plain(first) ? first : {};
      if (query.marketplace !== undefined && !pluginText(query.marketplace, PLUGIN_LIMITS.id)) refuse("That marketplace can't be found.");
      if (query.query !== undefined && (typeof query.query !== "string" || query.query.length > PLUGIN_LIMITS.query)) refuse("That search is too long.");
      if (query.cursor !== undefined && !pluginText(query.cursor, PLUGIN_LIMITS.id)) refuse("That list can't be shown.");
      const words = typeof query.query === "string" ? query.query.trim() : "";
      return [{ ...(query.marketplace !== undefined && { marketplace: query.marketplace }), ...(words && { query: words }), ...(query.cursor !== undefined && { cursor: query.cursor }) }];
    }
    case "plugins.preview":
    case "plugins.uninstall":
      return [pluginId(first)];
    case "plugins.update": {
      const revision = revisionOf(second.revision);
      return [pluginId(first), revision === undefined ? {} : { revision }];
    }
    case "plugins.install": {
      const revision = revisionOf(second.revision);
      return [pluginId(first), { ...(second.bots !== undefined && { bots: pluginBots(second.bots) }), ...(second.config !== undefined && { config: pluginValues(second.config) }), ...(revision !== undefined && { revision }) }];
    }
    case "plugins.addFolder":
      if (!folderPath(first)) refuse("Choose a folder.");
      return [first];
    case "plugins.configure":
      return [pluginId(first), pluginValues(args[1])];
    case "plugins.setBots":
      return [pluginId(first), pluginBots(args[1]), ...revisionOption(args[2])];
    case "plugins.setEnabled":
      if (typeof args[1] !== "boolean") refuse("Choose on or off.");
      return [pluginId(first), args[1], ...revisionOption(args[2])];
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
  // A bot's own voice ("bot-voice-v1"): only the shape the computer keeps; null clears it. Anything else is refused with a sentence.
  if ((method === "updateBot" || method === "addBot") && args[method === "addBot" ? 0 : 1]?.voice !== undefined) {
    const at = method === "addBot" ? 0 : 1;
    const data = args[at];
    if (data === null || typeof data !== "object" || Array.isArray(data)) return args;
    const next = [...args];
    next[at] = { ...data, voice: botVoiceField(data.voice) };
    return next;
  }
  return fileArgs(method, args) ?? pluginArgs(method, args) ?? marketArgs(method, args) ?? providerArgs(method, args) ?? appUpdateArgs(method, args) ?? projectArtifactArgs(method, args) ?? spaceArgs(method, args) ?? args;
}

/**
 * The space calls ("spaces-v1"), cut to their shape: ids as short strings, names and sentences of a
 * bounded length, an app panel's state as a small plain object. Null for any other call.
 */
function spaceArgs(method, args) {
  if (!SPACE_METHODS.includes(method)) return null;
  const id = (value, what) => (typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0") ? value : refuse("This " + what + " no longer exists."));
  const optional = (value, what) => (value == null ? null : id(value, what));
  const words = (value, limit, sentence) => (typeof value === "string" && value.trim() && value.trim().length <= limit ? value.trim() : refuse(sentence));
  const object = args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0]) ? args[0] : {};
  switch (method) {
    case "spaces.read":
    case "spaces.remove":
      return [id(args[0], "space")];
    case "spaces.create":
      return [{ name: words(object.name, SPACE_SIZES.name, "Give the space a name of up to 40 characters.") }];
    case "spaces.rename":
      return [id(args[0], "space"), words(args[1], SPACE_SIZES.name, "Give the space a name of up to 40 characters.")];
    case "spaces.setProject":
      return [id(args[0], "space"), optional(args[1], "project")];
    case "spaces.setPanelProject":
      return [id(args[0], "panel"), optional(args[1], "project")];
    case "spaces.newPanel": {
      const refresh = object.refresh;
      if (object.start !== undefined && !PANEL_STARTS.includes(object.start)) refuse("Choose what the panel starts from.");
      if (refresh !== undefined && !(refresh && typeof refresh === "object" && typeof refresh.cron === "string" && refresh.cron.trim().split(/\s+/).length === 5 && refresh.cron.length <= 160 && typeof refresh.timezone === "string" && refresh.timezone.length <= 80)) refuse("That refresh schedule can't be used.");
      return [{
        spaceId: id(object.spaceId, "space"),
        botId: id(object.botId, "bot"),
        prompt: words(object.prompt, SPACE_SIZES.prompt, "Say what the panel should show."),
        ...(object.start !== undefined && { start: object.start }),
        ...(refresh !== undefined && { refresh: { cron: refresh.cron.trim(), timezone: refresh.timezone } }),
        // The new panel's project. The owner's to say (team.mjs refuses it from a member).
        ...(object.projectId != null && { projectId: id(object.projectId, "project") }),
      }];
    }
    case "spaces.ask":
      return [{ spaceId: id(object.spaceId, "space"), botId: id(object.botId, "bot"), text: words(object.text, SPACE_SIZES.prompt, "Write what you want to ask."), ...(object.panelId !== undefined && { panelId: id(object.panelId, "panel") }) }];
    case "spaces.movePanel": {
      const to = args[1] !== null && typeof args[1] === "object" && !Array.isArray(args[1]) ? args[1] : {};
      return [id(args[0], "panel"), { spaceId: id(to.spaceId, "space"), before: optional(to.before, "panel") }];
    }
    case "spaces.patchState": {
      const patch = args[1];
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) refuse("That change can't be saved.");
      const keys = Object.keys(patch);
      let size = 0;
      try {
        size = JSON.stringify(patch).length;
      } catch {
        refuse("That change can't be saved.");
      }
      if (keys.length > SPACE_SIZES.stateKeys || size > SPACE_SIZES.state || keys.some((key) => key === "__proto__" || key.length > 200)) refuse("That change is too large to save.");
      const label = typeof args[2] === "string" && args[2].trim() ? args[2].trim().replace(/\s+/g, " ").slice(0, SPACE_SIZES.label) : undefined;
      return [id(args[0], "panel"), JSON.parse(JSON.stringify(patch)), ...(label ? [label] : [])];
    }
    case "spaces.note":
      return [id(args[0], "panel"), words(args[1], SPACE_SIZES.note, "A note has up to 2,000 characters.")];
    case "spaces.removeNote":
      return [id(args[0], "panel"), id(args[1], "note")];
    default:
      return null;
  }
}

/**
 * A project's artifacts ("project-artifacts-v1"), cut to their shape: the project's id, and for the
 * two that change the list an artifact's id (or a path the artifact index knows). Null for any other call.
 */
function projectArtifactArgs(method, args) {
  if (method !== "addProjectArtifact" && method !== "removeProjectArtifact" && method !== "projectArtifacts") return null;
  const project = args[0];
  if (typeof project !== "string" || !project || project.length > 200) throw new Error("Unknown project");
  if (method === "projectArtifacts") return [project];
  const artifact = args[1];
  if (typeof artifact !== "string" || !artifact || artifact.length > 4096 || artifact.includes("\0")) throw new Error("This artifact no longer exists.");
  return [project, artifact];
}

/** The longest of each thing a phone sends to sign a provider in or install one. */
export const PROVIDER_LIMITS = { id: 100, session: 100, service: 200, text: 4000, token: 8000 };
const cut = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : "");

/**
 * The provider sign-in and install calls ("provider-signin-v1"), cut to their shape: ids and lines
 * as strings of a bounded length, a token as a string or a saved credential reference, nothing
 * else. Null for any other call.
 */
function providerArgs(method, args) {
  const id = () => cut(args[0], PROVIDER_LIMITS.id);
  const session = () => cut(args[0], PROVIDER_LIMITS.session);
  const service = (options) => (options && typeof options === "object" && typeof options.service === "string" ? { service: options.service.slice(0, PROVIDER_LIMITS.service) } : {});
  switch (method) {
    case "providerSignInStart": {
      const options = args[1] && typeof args[1] === "object" ? args[1] : {};
      return [id(), { ...service(options), ...(typeof options.method === "string" && { method: options.method.slice(0, PROVIDER_LIMITS.service) }) }];
    }
    case "providerSignInRead":
      return [session(), Number.isSafeInteger(args[1]) && args[1] > 0 ? args[1] : 0];
    case "providerSignInInput":
      if (typeof args[1] !== "string" || args[1].length > PROVIDER_LIMITS.text) throw new Error("That is too long to be a code.");
      return [session(), args[1]];
    case "providerSignInCancel":
      return [session()];
    case "providerUseToken": {
      const token = args[1];
      const reference = token && typeof token === "object" && typeof token.$credential === "string";
      if (!reference && (typeof token !== "string" || !token.trim() || token.length > PROVIDER_LIMITS.token)) throw new Error("Paste the token or key.");
      return [id(), reference ? { $credential: token.$credential } : token, service(args[2])];
    }
    case "installProvider":
      return [id()];
    default:
      return null;
  }
}

/** The update calls ("app-update-v1"), cut to their shape: nothing at all, or exactly one boolean. Null for any other call. */
function appUpdateArgs(method, args) {
  if (method === "appUpdateStatus" || method === "checkAppUpdate" || method === "installAppUpdate") return [];
  if (method !== "setAppUpdateAuto") return null;
  if (args.length !== 1 || typeof args[0] !== "boolean") throw new Error("Say on or off, and nothing else.");
  return [args[0]];
}
