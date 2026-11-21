import { createHash } from "node:crypto";
import { random } from "./crypto.mjs";

export const SCOPE_ACTIONS = Object.freeze({
  agents: Object.freeze(["view", "chat", "create", "manage", "delete"]),
  today: Object.freeze(["view", "use", "create", "manage", "delete"]),
  skills: Object.freeze(["read", "use", "create", "manage", "delete"]),
  mcp: Object.freeze(["view", "use", "create", "manage", "delete"]),
  plugins: Object.freeze(["view", "use", "install", "manage", "uninstall"]),
  settings: Object.freeze(["view", "manage"]),
});
export const SCOPES = Object.freeze(Object.keys(SCOPE_ACTIONS));
const all = (scope) => [...SCOPE_ACTIONS[scope]];

export const BUILTIN_ROLES = Object.freeze([
  Object.freeze({ id: "r_guest", name: "Guest", perms: Object.freeze({ agents: Object.freeze(["view", "chat"]), today: Object.freeze(["view"]), skills: Object.freeze(["read", "use"]), mcp: Object.freeze(["view", "use"]), plugins: Object.freeze(["view", "use"]), settings: Object.freeze([]) }), bots: Object.freeze([]) }),
  Object.freeze({ id: "r_collab", name: "Collaborator", perms: Object.freeze({ agents: Object.freeze(["view", "chat", "create", "manage"]), today: Object.freeze(["view", "use", "create", "manage"]), skills: Object.freeze(["read", "use", "create", "manage"]), mcp: Object.freeze(["view", "use"]), plugins: Object.freeze(["view", "use"]), settings: Object.freeze([]) }), bots: "all" }),
  Object.freeze({ id: "r_admin", name: "Admin", perms: Object.freeze(Object.fromEntries(SCOPES.map((scope) => [scope, Object.freeze(all(scope))]))), bots: "all" }),
]);
export const EVERYONE_GROUP = Object.freeze({ id: "g_everyone", name: "Everyone", roleId: "r_guest" });

export const MEMBER_PREFERENCE_FIELDS = Object.freeze(["appearance", "foldTools", "showThinking", "linkPreviews", "readAloud"]);

const POLICY = {
  setPreferences: ["settings", "manage"],
  appInfo: ["settings", "view"],
  appUpdateStatus: "owner",
  checkAppUpdate: "owner",
  installAppUpdate: "owner",
  setAppUpdateAuto: "owner",
  addBot: ["agents", "create"],
  updateBot: ["agents", "manage"],
  // Hiding, pinning and ordering bots is each person's own view (memberView below): it needs no more than seeing them.
  setBotFlags: ["agents", "view"],
  makePrimary: ["agents", "manage"],
  reorderBots: ["agents", "view"],
  deleteBot: ["agents", "delete"],
  duplicateBot: ["agents", "create"],
  importableAgents: ["agents", "create"],
  importAgents: ["agents", "create"],
  setBotAccess: "owner",
  setBotIntegrations: "owner",
  botMemory: "owner",
  setBotMemory: "owner",
  addSection: ["agents", "manage"],
  renameSection: ["agents", "manage"],
  deleteSection: ["agents", "manage"],
  saveTemplate: "owner",
  renameTemplate: "owner",
  deleteTemplate: "owner",
  exportTemplateText: "owner",
  importTemplateText: "owner",
  createChat: ["agents", "chat"],
  createGroupChat: ["agents", "chat"],
  setChatFlags: ["agents", "chat"],
  renameChat: ["agents", "chat"],
  deleteChat: ["agents", "chat"],
  forkChat: ["agents", "chat"],
  warmChat: ["agents", "chat"],
  setChatProject: "owner",
  startProjectChat: "owner",
  send: ["agents", "chat"],
  stop: ["agents", "chat"],
  unqueue: ["agents", "chat"],
  sendNow: ["agents", "chat"],
  retry: ["agents", "chat"],
  compact: ["agents", "chat"],
  sideQuestion: ["agents", "chat"],
  respond: ["agents", "chat"],
  clearApprovals: ["agents", "chat"],
  mentionables: ["agents", "chat"],
  catalog: ["agents", "chat"],
  linkPreview: ["agents", "chat"],
  models: ["agents", "view"],
  setModel: ["agents", "manage"],
  providers: ["settings", "view"],
  setProviderEnabled: "owner",
  auth: "owner",
  signIn: "owner",
  cancelSignIn: "owner",
  signOut: "owner",
  providerServices: ["settings", "view"],
  connectProviderService: "owner",
  finishProviderService: "owner",
  cancelProviderService: "owner",
  disconnectProviderService: "owner",
  providerSignInStart: "owner",
  providerSignInRead: "owner",
  providerSignInInput: "owner",
  providerSignInCancel: "owner",
  providerUseToken: "owner",
  installProvider: "owner",
  createRoutine: ["today", "create"],
  updateRoutine: ["today", "manage"],
  setRoutineEnabled: ["today", "manage"],
  deleteRoutine: ["today", "delete"],
  runRoutine: ["today", "use"],
  duplicateRoutine: ["today", "create"],
  previewCadence: ["today", "use"],
  changeSchedule: ["today", "manage"],
  saveTask: "owner",
  moveTask: "owner",
  startTask: "owner",
  deleteTask: "owner",
  refreshPanel: ["today", "use"],
  changePanel: ["today", "manage"],
  routine: ["today", "manage"],
  boardAct: ["today", "use"],
  skills: ["skills", "read"],
  readSkill: ["skills", "read"],
  saveSkill: ["skills", "create"],
  removeSkill: ["skills", "delete"],
  setSkillEnabled: ["skills", "manage"],
  removeSkillFolder: ["skills", "manage"],
  saveMcpServer: ["mcp", "create"],
  setMcpServerEnabled: ["mcp", "manage"],
  removeMcpServer: ["mcp", "delete"],
  testMcpServer: ["mcp", "use"],
  signInMcpServer: "owner",
  cancelMcpSignIn: "owner",
  signOutMcpServer: "owner",
  importMcpServers: "owner",
  credentials: "owner",
  removeCredential: "owner",
  createProject: "owner",
  updateProject: "owner",
  renameProject: "owner",
  removeProject: "owner",
  projectChanges: "owner",
  projectDiff: "owner",
  projectCommit: "owner",
  addTodo: "owner",
  addProjectArtifact: "owner",
  removeProjectArtifact: "owner",
  projectArtifacts: "owner",
  updateTodo: "owner",
  deleteTodo: "owner",
  moveTodo: "owner",
  wikiTree: "owner",
  wikiPage: "owner",
  saveWikiPage: "owner",
  createWikiPage: "owner",
  createWikiPageFor: "owner",
  createWikiFolder: "owner",
  moveWiki: "owner",
  deleteWiki: "owner",
  searchWiki: "owner",
  wikiHistory: "owner",
  wikiVersion: "owner",
  restoreWikiVersion: "owner",
  wikiExportPlan: "owner",
  exportWikiFile: "owner",
  usage: "owner",
  exportUsageText: "owner",
  cacheInfo: "owner",
  clearCache: "owner",
  providerUsage: "owner",
  testNotification: "owner",
  listFolders: "owner",
  addProjectFolder: "owner",
  addSkillFolderAt: "owner",
  "artifacts.list": "owner",
  "artifacts.read": "owner",
  "artifacts.thumbnail": "owner",
  "artifacts.resolve": "owner",
  sidePane: ["agents", "chat"],
  "plugins.marketplaces": ["plugins", "view"],
  "plugins.addMarketplace": ["plugins", "manage"],
  "plugins.removeMarketplace": ["plugins", "manage"],
  "plugins.browse": ["plugins", "view"],
  "plugins.preview": ["plugins", "view"],
  "plugins.install": ["plugins", "install"],
  "plugins.addFolder": "owner",
  "plugins.configure": ["plugins", "manage"],
  "plugins.setBots": ["plugins", "manage"],
  "plugins.setEnabled": ["plugins", "manage"],
  "plugins.update": ["plugins", "manage"],
  "plugins.uninstall": ["plugins", "uninstall"],
  "link.sync": ["agents", "view"],
  "link.messages": ["agents", "chat"],
  "link.step": ["agents", "chat"],
  "link.setLook": ["agents", "manage"],
  "link.unpair": ["settings", "view"],
  "link.push.register": ["settings", "view"],
  "link.push.prefs": ["settings", "view"],
  "link.push.unregister": ["settings", "view"],
  "link.push.presence": ["settings", "view"],
  "link.push.activity": ["settings", "view"],
  "link.push.test": "owner",
  "link.voice.set": "owner",
  "link.voice.key": "owner",
  "link.voice.options": ["settings", "view"],
  "link.voice.transcribe": ["agents", "chat"],
  "link.voice.speak": ["agents", "chat"],
  "link.voice.live": ["agents", "chat"],
  "link.voice.endLive": ["agents", "chat"],
  "link.device.sources": "owner",
  "link.device.answer": "owner",
  "link.device.file": "owner",
  "link.devices.list": "owner",
  "link.devices.rename": "owner",
  "link.devices.setPerson": "owner",
  "link.devices.remove": "owner",
  "link.frame.page": ["today", "view"],
  "link.frame.chat": ["today", "view"],
  "link.upload": ["agents", "chat"],
  "link.pullRequests": "owner",
  "link.credentials.save": "owner",
  "link.credentials.remove": "owner",
  "link.credentials.check": "owner",
  "link.credentials.managers": "owner",
  "link.credentials.unlock": "owner",
  "link.credentials.lock": "owner",
  "link.credentials.vaults": "owner",
  "link.credentials.items": "owner",
  "link.credentials.item": "owner",
  "link.credentials.link": "owner",
  "link.screen.info": "owner",
  "link.screen.frame": "owner",
  "link.screen.input": "owner",
  "link.screen.stop": "owner",
  "link.screen.grant.begin": "owner",
  "link.screen.grant.confirm": "owner",
  "link.screen.revoke": "owner",
  "link.team.get": "owner",
  "link.team.saveRole": "owner",
  "link.team.deleteRole": "owner",
  "link.team.saveGroup": "owner",
  "link.team.deleteGroup": "owner",
  "link.team.createInvite": "owner",
  "link.team.revokeInvite": "owner",
  "link.team.approve": "owner",
  "link.team.deny": "owner",
  "link.team.moveMember": "owner",
  "link.team.removeMember": "owner",
  "link.team.rename": "owner",
  // The people in a chat ("team-people-v1"): its creator or the owner invites; an invited person may leave.
  "link.team.inviteToChat": ["agents", "chat"],
  "link.team.removeFromChat": ["agents", "chat"],
};

export const TEAM_METHODS = Object.freeze(Object.fromEntries(Object.entries(POLICY).map(([name, value]) => [name, value === "owner" ? "owner" : Object.freeze(value)])));

const nameOf = (value, field, limit) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/.test(text)) throw new Error("Give the " + field + " a name of up to " + limit + " characters.");
  return text;
};
const idOf = (value, prefix, field) => {
  const id = typeof value === "string" ? value.trim() : "";
  const fixed = field === "role" ? ["r_guest", "r_collab", "r_admin"] : ["g_everyone"];
  const shape = field === "role" ? /^r_[0-9A-HJKMNP-TV-Z]{10}$/i : /^g_[A-Za-z0-9_-]{1,45}$/;
  if (!fixed.includes(id) && !shape.test(id)) throw new Error("That " + field + " is no longer available.");
  return id;
};

/** One role after its permissions and bot list have been checked. Non-view actions imply their first action. */
export function cleanRole(role) {
  if (!role || typeof role !== "object" || Array.isArray(role)) throw new Error("That role can't be saved.");
  const id = idOf(role.id, "r_", "role");
  const name = nameOf(role.name, "role", 40);
  if (!role.perms || typeof role.perms !== "object" || Array.isArray(role.perms) || Object.keys(role.perms).some((scope) => !SCOPES.includes(scope))) throw new Error("That role has a permission Botkins doesn't know.");
  const perms = {};
  for (const scope of SCOPES) {
    const values = role.perms?.[scope];
    if (!Array.isArray(values) || values.some((action) => !SCOPE_ACTIONS[scope].includes(action))) throw new Error("That role has a permission Botkins doesn't know.");
    const kept = [...new Set(values)];
    const first = SCOPE_ACTIONS[scope][0];
    if (kept.some((action) => action !== first) && !kept.includes(first)) kept.unshift(first);
    perms[scope] = SCOPE_ACTIONS[scope].filter((action) => kept.includes(action));
  }
  if (role.bots !== "all" && (!Array.isArray(role.bots) || role.bots.length > 200 || role.bots.some((bot) => typeof bot !== "string" || !bot || bot.length > 200))) throw new Error("Choose which bots this role can see.");
  return { id, name, perms, bots: role.bots === "all" ? "all" : [...new Set(role.bots)] };
}

export function cleanGroup(group) {
  if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("That group can't be saved.");
  return { id: idOf(group.id, "g_", "group"), name: nameOf(group.name, "group", 40), roleId: idOf(group.roleId, "r_", "role") };
}

/** Invite codes accept the familiar Crockford aliases and ignore spaces and dashes. */
export function normalizeCode(value) {
  return String(value ?? "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0").replace(/[\s-]/g, "");
}
/** A ten-character invite code as people read it. */
export function formatCode(value) {
  const code = normalizeCode(value);
  return code.length === 10 ? code.slice(0, 5) + "-" + code.slice(5) : code.replace(/(.{4})(?=.)/g, "$1-");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newInviteCode() {
  let out = "";
  for (const byte of random(10)) out += CROCKFORD[byte & 31];
  return out;
}
export const generateInviteCode = newInviteCode;

export const inviteLookup = (code) => createHash("sha256").update("botkins-invite-v1:" + normalizeCode(code)).digest("base64url");
export function inviteLink(code, serverKey, relayBase = "https://relay.botkins.app") {
  const origin = (() => {
    try {
      return new URL(relayBase).origin;
    } catch {
      return "https://relay.botkins.app";
    }
  })();
  return origin + "/join#c=" + encodeURIComponent(normalizeCode(code)) + "&k=" + encodeURIComponent(serverKey);
}

export function defaultTeam() {
  return {
    name: "My team",
    roles: BUILTIN_ROLES.map((role) => ({ id: role.id, name: role.name, perms: Object.fromEntries(SCOPES.map((scope) => [scope, [...role.perms[scope]]])), bots: role.bots === "all" ? "all" : [...role.bots] })),
    groups: [{ ...EVERYONE_GROUP }],
    members: [],
    invites: [],
    requests: [],
    chats: {},
    views: {},
  };
}

export const hasAction = (perms, scope, action) => Array.isArray(perms?.[scope]) && perms[scope].includes(action);

const SELF_METHODS = new Set([
  "link.push.register",
  "link.push.prefs",
  "link.push.unregister",
  "link.push.presence",
  "link.push.activity",
  "link.sync",
  // A member may always leave: it removes only their own device.
  "link.unpair",
]);
const BOT_METHODS = new Set(["updateBot", "setBotFlags", "makePrimary", "reorderBots", "deleteBot", "duplicateBot", "setBotAccess", "setBotIntegrations", "botMemory", "setBotMemory", "saveTemplate", "exportTemplateText", "link.setLook"]);
const CHAT_METHODS = new Set(["setChatFlags", "renameChat", "deleteChat", "forkChat", "warmChat", "setChatProject", "send", "stop", "unqueue", "sendNow", "compact", "sideQuestion", "clearApprovals", "mentionables", "link.messages", "link.step", "sidePane", "changeSchedule", "link.voice.live", "link.voice.endLive", "link.team.inviteToChat", "link.team.removeFromChat"]);
/** What only the person who started a chat (or the owner) may do to it; someone invited may not. */
const CREATOR_METHODS = new Set(["renameChat", "deleteChat", "setChatProject", "changeSchedule", "setModel", "clearApprovals", "compact", "link.team.inviteToChat"]);
/** A routine is its chat: these take the routine's (chat's) id first ("routine-owner-v1"). */
const ROUTINE_METHODS = new Set(["updateRoutine", "setRoutineEnabled", "deleteRoutine", "runRoutine", "duplicateRoutine"]);

/** The owner as a person in a chat, beside the members' ids. */
export const OWNER = "owner";
/** The person a principal is: "owner", or a member's id. */
export const personOf = (principal) => (principal?.kind === "member" ? principal.memberId : OWNER);
/** A chat's people ("team-people-v1"): who started it, and who was invited. Kept in the team, by chat id. */
export function chatPeople(team, chat) {
  const invited = chat ? team?.chats?.[chat.id] : undefined;
  return { createdBy: chat?.createdBy || OWNER, invited: Array.isArray(invited) ? [...invited] : [] };
}
/** Whether a person is in a chat: they started it, or were invited. */
export function inChat(team, chat, person) {
  if (!chat) return false;
  const people = chatPeople(team, chat);
  return people.createdBy === person || people.invited.includes(person);
}
/** The most people a chat holds, its creator included. */
export const MAX_CHAT_PEOPLE = 20;

/**
 * A member's own view ("team-people-v1"): the bots they hid or pinned and their order, and their
 * flags on chats. Kept in the team by member id, never in the workspace, so one person's view is
 * never another's. `seen` is the chat's time when the member last marked it read.
 */
export function viewOf(team, memberId) {
  const view = team?.views?.[memberId];
  return { bots: view?.bots ?? {}, order: Array.isArray(view?.order) ? view.order : [], chats: view?.chats ?? {} };
}
const flag = (value) => (value === true ? true : value === false ? false : undefined);
/** A member's view after `setBotFlags(id, flags)`: only `hidden` and `pinned` are theirs. */
export function withBotFlags(view, botId, flags) {
  const held = { ...(view.bots[botId] ?? {}) };
  for (const name of ["hidden", "pinned"]) {
    const value = flag(flags?.[name]);
    if (value === true) held[name] = true;
    else if (value === false) delete held[name];
  }
  const bots = { ...view.bots };
  if (Object.keys(held).length) bots[botId] = held;
  else delete bots[botId];
  return { ...view, bots };
}
/** A member's view after `setChatFlags(id, flags)`. `time` is the chat's time now. */
export function withChatFlags(view, chatId, flags, time) {
  const held = { ...(view.chats[chatId] ?? {}) };
  for (const name of ["pinned", "archived"]) {
    const value = flag(flags?.[name]);
    if (value === true) held[name] = true;
    else if (value === false) delete held[name];
  }
  if (flag(flags?.unread) === true) held.unread = true;
  else if (flag(flags?.unread) === false) {
    delete held.unread;
    held.seen = Number.isFinite(time) ? time : 0;
  }
  return { ...view, chats: { ...view.chats, [chatId]: held } };
}
/** The flags of `setBotFlags` that are not a person's view: a member needs "manage" for them, and a section is never theirs. */
export function sharedBotFlags(flags) {
  const { hidden: _hidden, pinned: _pinned, sectionId: _section, ...rest } = flags && typeof flags === "object" ? flags : {};
  return rest;
}
const READ_REQUEST_METHODS = new Set(["respond"]);

function roleFor(principal, team) {
  if (principal?.kind !== "member") return null;
  const member = team?.members?.find((item) => item.id === principal.memberId);
  const groupId = member?.groupId ?? principal.groupId;
  const group = team?.groups?.find((item) => item.id === groupId);
  return team?.roles?.find((item) => item.id === group?.roleId) ?? null;
}
function lookup(kind, value, lookups) {
  const source = lookups?.[kind];
  if (typeof source === "function") return source(value);
  if (source && typeof source.get === "function") return source.get(value);
  if (Array.isArray(source)) return source.find((item) => item.id === value);
  return source && typeof source === "object" ? source[value] : null;
}
function visible(role, botId) {
  return role?.bots === "all" || (Array.isArray(role?.bots) && role.bots.includes(botId));
}
function botIdOf(method, args) {
  if (BOT_METHODS.has(method)) {
    if (method === "exportTemplateText") return args[0]?.botId;
    return typeof args[0] === "string" ? args[0] : args[0]?.botId;
  }
  if (method === "createChat") return args[0];
  if (method === "catalog") return args[0];
  if (method === "createGroupChat") return args[0];
  if (method === "createRoutine") return args[0]?.botId;
  if (method === "duplicateRoutine") return args[1];
  if (method === "link.voice.live") return args[0]?.botId;
  if (method === "setModel" && args[0] === "bot") return args[1];
  if (method === "plugins.setBots") return args[1];
  if (method === "plugins.install" && Array.isArray(args[1]?.bots)) return args[1].bots;
  if (method === "mentionables") return args[1];
  return null;
}
function chatIdOf(method, args, lookups) {
  if (CHAT_METHODS.has(method)) return method === "link.voice.live" || method === "link.voice.endLive" ? args[0]?.chatId : typeof args[0] === "string" ? args[0] : null;
  if (method === "retry") return lookup("run", args[0], lookups)?.chatId;
  if (method === "setModel" && args[0] === "chat") return args[1];
  if (method === "catalog") return args[1] || null;
  if (method === "mentionables") return args[0] || null;
  if (READ_REQUEST_METHODS.has(method)) return lookup("request", args[0], lookups)?.chatId;
  return null;
}

/** One member's refusal sentence, or "" when the call may proceed. */
export function authorize(principal, team, method, args = [], lookups = {}) {
  if (principal?.kind === "owner") return "";
  if (principal?.kind !== "member") return "Only a paired owner or team member can do that.";
  const role = roleFor(principal, team);
  if (!role) return "That team membership is no longer available.";
  // A chat's card on a phone (its Live Activity) is for that chat's people.
  if (method === "link.push.activity") {
    // Taking a card's address back (no token) is always a device's own to do, also after it left the chat.
    if (args[1] == null) return "";
    const chat = lookup("chat", args[0], lookups);
    return chat && inChat(team, chat, principal.memberId) ? "" : "That chat belongs to the owner or another member.";
  }
  if (SELF_METHODS.has(method)) return "";
  const policy = TEAM_METHODS[method] ?? "owner";
  let [scope, action] = policy === "owner" ? [] : policy;
  if (policy === "owner") return "Only the owner can do that.";
  if (method === "boardAct" && args[1] === "delete") action = "delete";
  else if (method === "boardAct" && (args[1] === "yes" || args[1] === "goal")) action = "create";
  else if (method === "changePanel" && args[1] === "delete") action = "delete";
  else if (method === "routine" && args[1]?.action === "remove") action = "delete";
  else if (method === "saveSkill" && args[0]?.original) action = "manage";
  if (!hasAction(role.perms, scope, action)) return "Your team role can't do that.";
  if (method === "setPreferences") {
    const patch = args[0];
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((field) => !MEMBER_PREFERENCE_FIELDS.includes(field))) return "Your team role can change display preferences only.";
  }
  const bot = botIdOf(method, args);
  const botIds = Array.isArray(bot) ? bot : bot == null ? [] : [bot];
  if (botIds.length) {
    for (const id of botIds) {
      if (!lookup("bot", id, lookups) || !visible(role, id)) return "That bot isn't available to your team role.";
    }
  }
  const request = method === "respond" ? lookup("request", args[0], lookups) : null;
  if (request && (request.kind === "permission" || request.kind === "secure")) return "The owner needs to approve that request.";
  if (method === "setBotFlags" && Object.keys(sharedBotFlags(args[1])).length && !hasAction(role.perms, "agents", "manage")) return "Your team role can't do that.";
  // A routine is its chat: only the member who made it may change, run or delete it, once the app
  // says who made each one ("routine-owner-v1", `lookups.routineOwners`).
  if (ROUTINE_METHODS.has(method) && lookups.routineOwners) {
    const routine = typeof args[0] === "string" ? lookup("chat", args[0], lookups) : null;
    const maker = routine?.createdBy ?? routine?.schedules?.find((entry) => entry.routine)?.createdBy;
    if (!routine || maker !== principal.memberId) return "That routine belongs to the owner or another member.";
    if (!visible(role, routine.botId)) return "That bot isn't available to your team role.";
  }
  const chatId = chatIdOf(method, args, lookups);
  if (chatId) {
    const chat = lookup("chat", chatId, lookups);
    const mine = !!chat && chat.createdBy === principal.memberId;
    const invited = !!chat && !mine && inChat(team, chat, principal.memberId);
    if (!mine && !invited) return "That chat belongs to the owner or another member.";
    if (invited) {
      // Someone invited may leave, never remove another; and may not do what only the chat's starter does.
      if (method === "link.team.removeFromChat") return args[1] === principal.memberId ? "" : "Only the person who started this chat can do that.";
      if (CREATOR_METHODS.has(method)) return "Only the person who started this chat can do that.";
    }
    // An invite never widens a role: the chat's bot has to be one the role may use.
    if (!visible(role, chat.botId)) return "That chat's bot isn't available to your team role.";
  } else if (method === "respond" || method === "retry") {
    return "That request is no longer available.";
  } else if (CHAT_METHODS.has(method) && args[0] !== undefined) {
    return "That chat is no longer available.";
  }
  return "";
}

function scrub(value) {
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (!value || typeof value !== "object") return value;
  const out = {};
  const secretField = value.secret === true;
  for (const [name, inner] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (["path", "filepath", "filename", "folder", "folderid", "cwd", "command", "args", "argv", "env", "environment", "headers", "header"].includes(lower)) continue;
    if (/secret|password|privatekey|accesstoken|apikey|credential|authorization/.test(lower) && typeof inner !== "boolean") continue;
    if (secretField && (lower === "value" || lower === "default")) continue;
    if ((lower === "source" || lower === "url") && typeof inner === "string" && /^(?:file:|\/|[A-Za-z]:[\\/])/.test(inner)) continue;
    const cleaned = scrub(inner);
    if (cleaned !== undefined) out[name] = cleaned;
  }
  return out;
}
const emptySkills = { folders: [], plugins: [], disabled: [] };

/** Everyone a chat can be shared with: the owner and each member, by id and name. */
export const teamPeople = (team, ownerName = "") => [{ id: OWNER, name: ownerName || "Owner" }, ...(team?.members ?? []).map((member) => ({ id: member.id, name: member.name }))];

export function teamPart(team, forOwner, principal = { kind: "owner" }, ownerName = "") {
  if (forOwner) {
    return {
      people: teamPeople(team, ownerName),
      name: team?.name ?? "",
      roles: team?.roles ?? [],
      groups: team?.groups ?? [],
      members: team?.members ?? [],
      invites: team?.invites ?? [],
      requests: (team?.requests ?? []).filter((request) => request.status === undefined || request.status === "pending").map((request) => {
        const { id, name, person, platform, kind, at, inviteId } = request;
        return { id, name, ...(person && { person }), platform, kind, at, inviteId };
      }),
    };
  }
  const role = roleFor(principal, team);
  const group = team?.groups?.find((item) => item.id === principal?.groupId);
  return {
    me: { memberId: principal.memberId, name: principal.name, group: { id: group?.id ?? principal.groupId, name: group?.name ?? "Everyone" }, role: { name: role?.name ?? "", perms: role?.perms ?? {}, bots: role?.bots ?? [] } },
    team: { name: team?.name ?? "" },
    people: teamPeople(team, ownerName),
  };
}

/** A copy of the named parts with everything outside a member's role and ownership removed. */
export function filterParts(parts, principal, team) {
  if (principal?.kind === "owner") return parts;
  const role = roleFor(principal, team);
  const me = principal.memberId;
  const view = viewOf(team, me);
  // A member's chats: the ones they started, and the ones they were invited to.
  const shared = (parts.chats ?? []).filter((chat) => inChat(team, chat, me) && (chat.createdBy === me || visible(role, chat.botId)));
  const ownChats = new Set(shared.map((chat) => chat.id));
  const can = (scope, action = SCOPE_ACTIONS[scope][0]) => hasAction(role?.perms, scope, action);
  const out = { ...parts };
  // `sections` are the owner's arrangement of Home; a member arranges their own view (below).
  for (const name of ["credentials", "phones", "asks", "voice", "host", "projects", "tasks", "templates", "sections"]) delete out[name];
  // A bot as a member sees it: without what the owner wrote for it or where it came from, and with
  // the member's own hidden and pinned marks and order. The owner's marks are the owner's.
  const mayManage = can("agents", "manage");
  const seen = (bot) => {
    // What the owner wrote for the bot (both of its prompts) is for a role that manages bots; where it came from is the owner's alone.
    const { hidden: _hidden, pinned: _pinned, sectionId: _section, origin: _origin, instructions, clarificationInstructions, ...rest } = bot;
    const own = view.bots[bot.id] ?? {};
    return {
      ...rest,
      ...(mayManage && instructions !== undefined && { instructions }),
      ...(mayManage && clarificationInstructions !== undefined && { clarificationInstructions }),
      ...(own.hidden && { hidden: true }),
      ...(own.pinned && { pinned: true }),
    };
  };
  const place = new Map(view.order.map((id, index) => [id, index]));
  const visibleBots = can("agents") ? (parts.bots ?? []).filter((bot) => visible(role, bot.id)) : [];
  out.bots = visibleBots.map(seen).sort((a, b) => (place.get(a.id) ?? Infinity) - (place.get(b.id) ?? Infinity));
  const botIds = new Set(visibleBots.map((bot) => bot.id));
  // A chat's flags are the member's own. Unread is theirs too: since they last marked it read; a
  // chat they never marked follows the workspace when they started it, and is new to them otherwise.
  out.chats = shared.map((chat) => {
    const { pinned: _pinned, archived: _archived, unread, ...rest } = chat;
    const own = view.chats[chat.id];
    const mine = chat.createdBy === me;
    const fresh = own?.unread === true || (own?.seen !== undefined ? chat.time > own.seen : mine ? !!unread : chat.count > 0);
    const people = chatPeople(team, chat);
    return { ...rest, ...(own?.pinned && { pinned: true }), ...(own?.archived && { archived: true }), ...(fresh && { unread: true }), ...(people.invited.length && { invited: people.invited }) };
  });
  const live = parts.live ?? {};
  const byChat = (value) => Object.fromEntries(Object.entries(value ?? {}).filter(([id]) => ownChats.has(id)));
  out.live = {
    ...live,
    streams: byChat(live.streams),
    intents: byChat(live.intents),
    thinking: byChat(live.thinking),
    speakers: byChat(live.speakers),
    queued: byChat(live.queued),
    ...(live.steerable && { steerable: byChat(live.steerable) }),
    requests: (live.requests ?? []).filter((request) => ownChats.has(request.chatId) && request.kind !== "permission" && request.kind !== "secure"),
    active: (live.active ?? []).filter((id) => ownChats.has(id)),
  };
  out.runs = (parts.runs ?? []).filter((run) => ownChats.has(run.chatId));
  for (const name of Object.keys(parts)) {
    const chat = /^chat:(.+)$/.exec(name);
    const run = /^run:(.+)$/.exec(name);
    if (chat && !ownChats.has(chat[1])) out[name] = null;
    if (run && !ownChats.has(run[1])) out[name] = null;
  }
  // Today's panels and board items name a bot (and a chat): only those of bots the role may see.
  out.panels = can("today") ? (parts.panels ?? []).filter((panel) => !panel.botId || botIds.has(panel.botId)) : [];
  out.board = can("today") ? (parts.board ?? []).filter((item) => !item.botId || botIds.has(item.botId)) : [];
  out.skills = can("skills") ? scrub(parts.skills ?? emptySkills) : emptySkills;
  out.mcp = can("mcp") ? scrub(parts.mcp ?? []) : [];
  out.plugins = can("plugins") ? scrub(parts.plugins ?? []) : [];
  out.settings = can("settings") ? Object.fromEntries(Object.entries(parts.settings ?? {}).filter(([name]) => MEMBER_PREFERENCE_FIELDS.includes(name))) : {};
  out.revs = {};
  // The owner's name as a person comes with the owner's own team part; else the computer's name stands in.
  out.team = teamPart(team, false, principal, parts.team?.people?.find((person) => person.id === OWNER)?.name ?? parts.meta?.name);
  // Who is on the team is for someone who can start a chat and invite to it. Anyone else gets the
  // owner and the people of the chats they are in.
  if (!can("agents", "chat")) {
    const known = new Set([OWNER, me, ...shared.flatMap((chat) => [chat.createdBy || OWNER, ...(team?.chats?.[chat.id] ?? [])])]);
    out.team.people = out.team.people.filter((person) => known.has(person.id));
  }
  out.meta = { ...(parts.meta ?? {}), you: { kind: "member", memberId: principal.memberId, name: principal.name } };
  return out;
}
