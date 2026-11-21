// The command line's cover of what Botkins can do, as one table.
//
// Every call the app's window can make (each key of `runtime.handlers`), and every call of the
// phone link that an owner makes and that is not one of those, has one entry here:
//
//   cmd("bots add")      the command that does it
//   no("window")         it has no command, for one reason from the short list below
//   owed("b")            its command is not written yet; the letter names the part of the work that owes it
//
// test/terminal-coverage.test.mjs reads the calls from a running service and from the link, and
// fails when a call has no entry, when an entry names a call that is gone, and when a command
// that is named here no longer exists. So a new call in the window cannot ship without its
// command, or a stated reason. This is the command line's part of the rule the phone has
// ("Parity with the computer", mobile/AGENTS.md): what a person can do in the window, a person
// or an agent can do from a terminal, unless it needs the window itself.
//
// The table also decides what the hidden `botkins call` may reach (`callRule` in control.mjs). A call
// that a command covers, or that has a reason, is refused there: the command shows what it changes
// and leaves a line in the log, and a reason says where the call is done. Only `owed` calls run
// through `call`, and a few of those are held (`HELD` in control.mjs) while their command is not
// written. When nothing is owed any more, `call` has nothing left to reach that a command does not,
// and `call` goes: take it out with the last `owed`.

/** Why a call has no command. The list is fixed: a new reason is a decision, not an entry. */
import { hasUnplain } from "../shown-text.mjs";

export const REASONS = {
  window: "needs a window", // a file dialog, the clipboard, a folder opened in the file manager, a notification, a microphone
  "window's own": "the window's own", // what only the window uses to draw itself: a pane, a preview, a thumbnail
  "phone's own": "a phone's own", // what only a paired phone uses: its notifications, the screen it is shown, its uploads
  // A new reason is a decision (test/terminal-coverage.test.mjs). This one is for the password managers and what is like them. Decided on 2026-11-21 in the thread 'Keep Headless and Desktop in Sync', as the safe side. The owner agreed to this on 2026-11-21: "nothing that reaches a saved secret runs from the command line, so unlocking a password manager and using a saved credential by reference stay in the window and on the phone."
  person: "needs a person at the app: the window, or a phone with its owner check", // a call that reaches a secret which a caller of the socket cannot read by itself, or sends one somewhere: the socket cannot know that a person is there
};

/** The parts of the work that still owe commands, in the order they are built. When all are done, `owed` is no longer accepted. */
export const PARTS = {
  d: "projects, routines, tasks, the wiki, chats, preferences, credentials, usage, and the rest of a bot",
  e: "Spaces, panels and the team",
};

const cmd = (command) => ({ command });
const no = (reason) => ({ reason });
const owed = (part) => ({ owed: part });
const each = (names, entry) => Object.fromEntries(names.split(/\s+/).filter(Boolean).map((name) => [name, entry]));

/** The app's own calls: every key of `runtime.handlers`. */
export const WORKSPACE = {
  // ── Bots ──
  addBot: cmd("bots add"),
  updateBot: cmd("bots edit"),
  deleteBot: cmd("bots remove"),
  duplicateBot: cmd("bots duplicate"),
  reorderBots: cmd("bots order"),
  makePrimary: cmd("bots primary"),
  setBotFlags: cmd("bots flags"),
  ...each("botMemory setBotMemory", cmd("bots memory")),
  ...each("addSection", cmd("bots sections add")),
  renameSection: cmd("bots sections rename"),
  deleteSection: cmd("bots sections remove"),
  ...each("importableAgents importAgents", cmd("bots import")),
  saveTemplate: cmd("templates save"),
  renameTemplate: cmd("templates rename"),
  deleteTemplate: cmd("templates remove"),
  exportTemplateText: cmd("templates export"),
  importTemplateText: cmd("templates import"),
  setBotIntegrations: cmd("bots tools"),
  setBotAccess: cmd("bots access"),
  catalog: cmd("bots menu"),
  clearApprovals: cmd("tools forget-approvals"),
  listFolders: cmd("folders"),
  // ── Model providers and models ──
  providers: cmd("providers list"),
  harnesses: owed("d"),
  setProviderEnabled: cmd("providers enable"),
  providerServices: cmd("providers services"),
  ...each("providerSignInStart providerSignInRead providerSignInInput providerSignInCancel", cmd("providers login")),
  models: cmd("models"),
  setModel: cmd("models"),
  ...each("auth signIn cancelSignIn signOut installProvider providerUseToken connectProviderService finishProviderService cancelProviderService disconnectProviderService providerUsage", owed("d")),
  // ── Chats ──
  ...each("createChat send stop respond", cmd("chat")),
  // (A side question is a person's act in a chat, which the phone has as /btw: it gets a command with the chat commands.)
  renameChat: cmd("chats rename"),
  deleteChat: cmd("chats delete"),
  forkChat: cmd("chats fork"),
  compact: cmd("chats compact"),
  setChatFlags: cmd("chats flags"),
  setChatProject: cmd("chats project"),
  createGroupChat: cmd("chats group"),
  retry: cmd("chats retry"),
  unqueue: cmd("chats unqueue"),
  sendNow: cmd("chats send-now"),
  mentionables: cmd("chats mentions"),
  sideQuestion: cmd("chats aside"),
  // Sections on the Chats page, by the link's names: the window's own calls, made as the owner. The link keeps them.
  "link.chats.addSection": cmd("chats sections add"),
  "link.chats.renameSection": cmd("chats sections rename"),
  "link.chats.deleteSection": cmd("chats sections delete"),
  "link.chats.orderSections": cmd("chats sections order"),
  "link.chats.setSection": cmd("chats sections set"),
  // ── Routines ──
  runRoutine: cmd("routines run"),
  setRoutineEnabled: cmd("routines pause"),
  createRoutine: cmd("routines add"),
  updateRoutine: cmd("routines edit"),
  deleteRoutine: cmd("routines remove"),
  duplicateRoutine: cmd("routines duplicate"),
  previewCadence: cmd("routines when"),
  changeSchedule: cmd("routines schedule"),
  // ── Plugins ──
  "plugins.marketplaces": cmd("plugins marketplaces"),
  "plugins.addMarketplace": cmd("plugins add-marketplace"),
  "plugins.removeMarketplace": cmd("plugins remove-marketplace"),
  "plugins.browse": cmd("plugins browse"),
  "plugins.install": cmd("plugins install"),
  "plugins.update": cmd("plugins update"),
  "plugins.setEnabled": cmd("plugins enable"),
  "plugins.uninstall": cmd("plugins uninstall"),
  "plugins.preview": cmd("plugins show"),
  "plugins.configure": cmd("plugins configure"),
  "plugins.setBots": cmd("plugins bots"),
  "plugins.addFolder": cmd("plugins add-folder"),
  // ── Tools (MCP servers) and skills ──
  saveMcpServer: cmd("tools add"),
  setMcpServerEnabled: cmd("tools enable"),
  removeMcpServer: cmd("tools remove"),
  testMcpServer: cmd("tools test"),
  importMcpServers: cmd("tools import"),
  signOutMcpServer: cmd("tools sign-out"),
  // A tool's sign-in from a terminal: the page is handed to the person, who signs in on another
  // device and gives back the address the browser was sent to (`tools sign-in`). The tools of a
  // plugin, whose ids start with "plugin-", sign in with `plugins sign-in` (the same calls of the
  // window, by the plugin's name and the tool's); `tools sign-out` forgets the tools a person added
  // and `plugins sign-out` those of a plugin.
  ...each("signInMcpServer cancelMcpSignIn", cmd("tools sign-in")),
  importMcpServerFile: no("window"), // a file dialog; `tools import <file>` reads the file itself
  skills: cmd("skills list"),
  readSkill: cmd("skills show"),
  saveSkill: cmd("skills add"),
  setSkillEnabled: cmd("skills enable"),
  removeSkill: cmd("skills remove"),
  addSkillFolderAt: cmd("skills add-folder"),
  removeSkillFolder: cmd("skills remove-folder"),
  // ── Projects ──
  ...each("createProject addProjectFolder", cmd("projects add")),
  addProject: no("window"), // a folder dialog; `projects add <folder>` takes the path itself
  renameProject: cmd("projects rename"),
  updateProject: cmd("projects edit"),
  removeProject: cmd("projects remove"),
  addProjectArtifact: cmd("projects add-artifact"),
  removeProjectArtifact: cmd("projects remove-artifact"),
  projectArtifacts: cmd("projects artifacts"),
  projectChanges: cmd("projects changes"),
  projectDiff: cmd("projects diff"),
  projectCommit: cmd("projects commit"),
  startProjectChat: cmd("projects chat"),
  addTodo: cmd("todos add"),
  updateTodo: cmd("todos edit"),
  moveTodo: cmd("todos move"),
  deleteTodo: cmd("todos remove"),
  // ── Tasks, the wiki, artifacts ──
  saveTask: cmd("tasks add"), // and `tasks edit`
  moveTask: cmd("tasks move"),
  startTask: cmd("tasks start"),
  deleteTask: cmd("tasks remove"),
  wikiTree: cmd("wiki tree"),
  wikiPage: cmd("wiki show"),
  searchWiki: cmd("wiki search"),
  // A new page: from a title, from a text, or for a project (`--for`: the app's only record kind).
  ...each("createWikiPage createWikiPageFor", cmd("wiki add")),
  createWikiFolder: cmd("wiki add-folder"),
  saveWikiPage: cmd("wiki save"),
  moveWiki: cmd("wiki move"),
  deleteWiki: cmd("wiki remove"),
  wikiHistory: cmd("wiki history"),
  wikiVersion: cmd("wiki version"),
  restoreWikiVersion: cmd("wiki restore"),
  // The export: the window's save dialog has no place on a command line. `wiki export` asks for the plan (`--list` shows it),
  // takes the pages' text through the same calls the web page's layout uses, and writes the file where --output says.
  ...each("wikiExportPlan wikiExportPages exportWikiFile", cmd("wiki export")),
  "artifacts.list": cmd("artifacts list"),
  "artifacts.read": cmd("artifacts read"),
  "artifacts.resolve": cmd("artifacts resolve"),
  // ── Preferences, credentials, usage, voice ──
  setPreferences: owed("d"),
  ...each("credentials removeCredential savedCredentials saveSavedCredential checkSavedCredential removeSavedCredential resetVault", owed("d")),
  // These five need a person at the app. After an unlock, a password manager's session stays in the
  // service's memory, so every later caller of the socket could list the person's logins. And a
  // field that is linked under a name that the caller chose is a secret that the person's own
  // picker then hands over. (`passwordManagers` and `lockPasswordManager` get commands later.)
  ...each("unlockPasswordManager passwordManagerVaults passwordManagerItems passwordManagerItem linkPasswordManagerField", no("person")),
  ...each("passwordManagers lockPasswordManager", owed("d")),
  ...each("usage exportUsageText cacheInfo clearCache", owed("d")),
  ...each("voiceSettings voiceOptions setVoice setVoiceKey", owed("d")),
  ...each("macToolsStatus setMacTool", owed("d")),
  // ── Panels and the team ──
  ...each("changePanel refreshPanel routine boardAct", owed("e")),
  // Spaces ("spaces-v1"): the app's twelve calls, and the link's own for sharing, order and "Notify me", as the owner's window makes them.
  ...each("spaces.read spaces.create spaces.rename spaces.remove spaces.setProject spaces.setPanelProject spaces.newPanel spaces.ask spaces.movePanel spaces.patchState spaces.note spaces.removeNote", owed("e")),
  ...each("link.spaces.share link.spaces.newLink link.spaces.arrange link.spaces.seen link.spaces.notify link.spaces.here link.team.setLinkSharing", owed("e")),
  ...each("team renameTeam saveTeamRole deleteTeamRole saveTeamGroup deleteTeamGroup createTeamInvite revokeTeamInvite approveTeamRequest denyTeamRequest moveTeamMember removeTeamMember chatPeople inviteToChat removeFromChat", owed("e")),
  // ── This computer: updates, phones, the relay ──
  ...each("appUpdateStatus checkAppUpdate installAppUpdate", cmd("update")),
  setAppUpdateAuto: cmd("config set"),
  ...each("snapshot appInfo phoneLink", cmd("status")),
  ...each("startPhonePairing cancelPhonePairing", cmd("pair")),
  setPhoneLink: cmd("config set"),
  renamePhoneLinkComputer: cmd("config set"),
  renamePhone: cmd("devices rename"),
  setPhonePerson: cmd("devices set-person"),
  removePhone: cmd("devices remove"),
  setPhoneRelay: cmd("relay on"),
  resetPhoneRelay: cmd("relay reset"),
  // ── What needs a window ──
  ...each("chooseFiles chooseProjectFolder pickPluginFolder addSkillFolder", no("window")), // a file or folder dialog (a path is given to the command instead)
  ...each("revealProject revealSkill revealWiki revealWikiExport openChatPath openLink openAppRelease", no("window")), // opens a folder, a file or a link on the computer's screen
  ...each("copyText copyReply", no("window")), // the clipboard
  ...each("exportTemplate importTemplate exportUsage exportWiki", no("window")), // a save or open dialog; the text forms have commands
  ...each("startDictation startLiveVoice endLiveVoice liveVoiceTool transcribe speak", no("window")), // the window's microphone and speaker
  ...each("testNotification requestScreenPermission allowLocalNetwork grantMacTool setPhoneScreen", no("window")), // a notification or a permission the system asks for on the screen
  // ── What only the window uses to draw itself ──
  ...each("sidePane frameAnswer frameOpenLink linkPreview previewChatPath thumbnailChatPath inspectChatPaths artifacts.thumbnail warmChat", no("window's own")),
};

/** The phone link's own calls: every `link.*` name of `LinkHost` (desktop/link/server.mjs). */
export const LINK = {
  "link.devices.list": cmd("devices list"),
  "link.devices.rename": cmd("devices rename"),
  "link.devices.setPerson": cmd("devices set-person"),
  "link.devices.remove": cmd("devices remove"),
  ...each("link.team.get link.team.rename link.team.saveRole link.team.deleteRole link.team.saveGroup link.team.deleteGroup link.team.createInvite link.team.revokeInvite link.team.approve link.team.deny link.team.moveMember link.team.removeMember link.team.inviteToChat link.team.removeFromChat link.team.setLinkSharing", owed("e")),
  ...each("link.spaces.share link.spaces.newLink link.spaces.arrange link.spaces.seen link.spaces.notify link.spaces.here", owed("e")),
  // Sections on the Chats screen ("chat-sections-v1"): a person's own way to group their chats.
  "link.chats.addSection": cmd("chats sections add"),
  "link.chats.renameSection": cmd("chats sections rename"),
  "link.chats.deleteSection": cmd("chats sections delete"),
  "link.chats.orderSections": cmd("chats sections order"),
  "link.chats.setSection": cmd("chats sections set"),
  // Admin mode is each owner device's own way of looking: the command line shows everything, as an owner with it on.
  "link.team.setAdminMode": no("phone's own"),
  // A phone's way to the computer's saved credentials and password managers. The owner at the terminal uses the app's own calls for them (part d).
  ...each("link.credentials.check link.credentials.item link.credentials.items link.credentials.link link.credentials.lock link.credentials.managers link.credentials.remove link.credentials.save link.credentials.unlock link.credentials.vaults", no("phone's own")),
  ...each("link.device.answer link.device.file link.device.sources link.upload link.pullRequests", no("phone's own")),
  ...each("link.push.activity link.push.prefs link.push.presence link.push.register link.push.test link.push.unregister", no("phone's own")),
  ...each("link.screen.frame link.screen.grant.begin link.screen.grant.confirm link.screen.info link.screen.input link.screen.revoke link.screen.stop", no("phone's own")),
  ...each("link.frame.chat link.frame.page", no("phone's own")),
  ...each("link.voice.endLive link.voice.key link.voice.live link.voice.options link.voice.set link.voice.speak link.voice.transcribe", no("phone's own")),
};

/**
 * The service's own calls that change something, with the place of the argument that names the
 * thing (a bot, a device, a setting), a function that finds its name in what was given and what
 * was answered, or null when there is none to name. A change made through
 * the socket leaves one line in the log: which call, which thing, never a value. When a bot
 * changed its own tools, a person can see it afterwards (`botkins logs`).
 */
export const CHANGES = {
  stop: null,
  "pair.start": null,
  "pair.cancel": null,
  "devices.rename": 0,
  "devices.setPerson": 0,
  "devices.remove": 0,
  "bots.add": (args) => args?.[0]?.name,
  "bots.edit": 0,
  "bots.remove": 0,
  "providers.enable": 0,
  "providers.login": 0,
  "providers.logout": 0,
  "models.default": null,
  "routines.run": 0,
  "routines.pause": 0,
  "routines.resume": 0,
  "plugins.addMarketplace": null,
  "plugins.removeMarketplace": 0,
  "plugins.install": 0,
  "plugins.update": 0,
  "plugins.setEnabled": 0,
  "plugins.setBots": 0,
  "plugins.configure": 0,
  "plugins.addFolder": null,
  "plugins.uninstall": 0,
  "plugins.signOut": 0,
  "config.set": 0,
  "config.replace": null,
  "relay.set": null,
  "relay.reset": null,
  "update.install": null,
  "tools.add": (args) => args?.[0]?.name,
  // (By the tool's name, which the answer has, whether the caller gave its name or its id.)
  "tools.edit": (args, value) => value?.name ?? args?.[0],
  "tools.remove": (args, value) => value?.name ?? args?.[0],
  "tools.enable": (args, value) => value?.name ?? args?.[0],
  // A test starts the tool's program: it is in the log, though it changes nothing that is kept.
  "tools.test": (args, value) => value?.name ?? args?.[0],
  "tools.import": (args, value) => some(value?.added),
  "tools.signOut": (args, value) => value?.name ?? args?.[0],
  // A sign-in: the tool's name only (for a plugin's tool, the plugin's name and the tool's). The page's
  // address, the pasted address and its code are never the thing: when a call fails, only a first
  // argument that is a name is used, and one that looks like an address or holds a code is left out.
  "tools.signIn": (args, value) => value?.name ?? nameOnly(args?.[0]),
  "tools.signIn.answer": (args, value) => value?.name ?? nameOnly(args?.[0]),
  "tools.signIn.end": (args, value) => value?.name ?? nameOnly(args?.[0]),
  "plugins.signIn": (args, value) => value?.name ?? nameOnly(args?.[0]),
  "plugins.signIn.answer": (args, value) => value?.name ?? nameOnly(args?.[0]),
  "plugins.signIn.end": (args, value) => value?.name ?? nameOnly(args?.[0]),
  "tools.forgetApprovals": (args) => args?.[0] ?? "every chat",
  "skills.save": (args) => args?.[0]?.name,
  "skills.remove": 0,
  "skills.enable": 0,
  "skills.addFolder": 0,
  "skills.removeFolder": (args, value) => value?.path ?? args?.[0],
  "bots.tools.set": 0,
  "bots.access.set": 0,
  // ── More of a bot, and templates (control-bots.mjs) ──
  // (By the name of the bot, the section or the template, as the answer has it. The text of a memory, an agent's instructions and a template's words are never in a line.)
  "bots.duplicate": (args, value) => value?.name ?? args?.[0],
  "bots.order": null,
  "bots.primary": (args, value) => value?.name ?? args?.[0],
  "bots.flags.set": (args, value) => value?.name ?? args?.[0],
  "bots.memory.set": (args, value) => value?.name ?? args?.[0],
  "bots.sections.add": (args, value) => value?.name ?? args?.[0],
  "bots.sections.rename": (args, value) => value?.name ?? args?.[0],
  "bots.sections.remove": (args, value) => value?.name ?? args?.[0],
  "bots.import": (args, value) => some(value?.added?.map((bot) => bot.name)),
  "templates.save": (args, value) => value?.name ?? args?.[0],
  "templates.rename": (args, value) => value?.name ?? args?.[0],
  "templates.remove": (args, value) => value?.name ?? args?.[0],
  // An export also keeps a copy of the file among the bot's files: it is a change, by the file's name.
  "templates.export": (args, value) => value?.name,
  "templates.import": (args, value) => value?.name,
  // ── Chats (control-chats.mjs) ──
  // A chat is named by its id: a title is a text that a person (or a model) wrote, so it is not in the log. A section is by its id too, and a new one by its name.
  "chats.rename": (args, value) => value?.id,
  "chats.delete": (args, value) => value?.id,
  "chats.fork": (args, value) => value?.from,
  "chats.compact": (args, value) => value?.id,
  "chats.flags": (args, value) => value?.id,
  // By the chat's id and the mode that it has now ("<id> (yolo)"), so that a log line shows a chat that was given yolo.
  "chats.project": (args, value) => (value?.id ? value.id + " (" + (value.mode ?? "default") + ")" : null),
  "chats.group": (args, value) => value?.id,
  "chats.retry": (args, value) => value?.id,
  "chats.unqueue": (args, value) => value?.id,
  "chats.sendNow": (args, value) => value?.id,
  "chats.sections.add": (args, value) => value?.name,
  "chats.sections.rename": (args, value) => value?.id,
  "chats.sections.delete": (args, value) => value?.id,
  "chats.sections.order": null,
  "chats.sections.set": (args, value) => value?.id,
  // ── Routines (control-routines.mjs) ──
  // (By the routine's name, which the answer has, whether the caller gave its name or its id. Never the prompt.)
  // A routine that runs often says so: `Check (each 5 minutes)`, or `(each 5 minutes)` alone when the name cannot be in a line.
  "routines.add": (args, value) => (value?.fastMinutes ? withRate(value.name, value.fastMinutes) : (value?.name ?? args?.[0]?.name)),
  "routines.edit": (args, value) => (value?.fastMinutes ? withRate(value.name, value.fastMinutes) : (value?.name ?? args?.[0])),
  "routines.remove": (args, value) => value?.name ?? args?.[0],
  "routines.duplicate": (args, value) => (value?.fastMinutes ? withRate(value.name, value.fastMinutes) : (value?.name ?? args?.[0])),
  // A chat's own schedule (a prompt it set with /every or /after): the chat's title. The line does not say pause or delete.
  "routines.schedule": (args, value) => value?.chat ?? args?.[0],
  // ── Projects, to-dos, tasks and artifacts (control-projects.mjs) ──
  // The project's name (the answer has it, whether the caller gave its name or its id). Never a folder, a message, a to-do's words or a diff.
  "projects.add": (args, value) => value?.name ?? args?.[0]?.name,
  "projects.rename": (args, value) => value?.name ?? args?.[0],
  "projects.edit": (args, value) => value?.name ?? args?.[0],
  "projects.remove": (args, value) => value?.name ?? args?.[0],
  "projects.addArtifact": (args, value) => value?.project?.name ?? args?.[0],
  "projects.removeArtifact": (args, value) => value?.project?.name ?? args?.[0],
  // A commit is in the log by the project's name: not its message, not its files.
  "projects.commit": (args, value) => value?.name ?? args?.[0],
  // A chat in the mode yolo says so: `Site (yolo)`, or `(yolo)` alone when the name cannot be in a line. (Its mode is the one the chat got: a project with no folder gives default.)
  "projects.chat": (args, value) => {
    const name = value?.project?.name ?? args?.[0];
    if ((value ? value.mode : args?.[1]?.mode) !== "yolo") return name;
    return thingForLog(name) && name.length <= 73 ? name + " (yolo)" : "(yolo)";
  },
  // A to-do is a person's own text: its line names the project.
  "todos.add": (args, value) => value?.project?.name ?? args?.[0],
  "todos.edit": (args, value) => value?.project?.name ?? args?.[0],
  "todos.move": (args, value) => value?.project?.name ?? args?.[0],
  "todos.remove": (args, value) => value?.project?.name ?? args?.[0],
  // A task is named by its title (a title longer than 80 characters, or with a line break in it, is left out of the line by `thingForLog`). Not its details, its result or its bot's words.
  "tasks.add": (args, value) => value?.title ?? args?.[0]?.title,
  "tasks.edit": (args, value) => value?.title ?? args?.[0],
  "tasks.move": (args, value) => value?.title ?? args?.[0],
  "tasks.start": (args, value) => value?.title ?? args?.[0],
  "tasks.remove": (args, value) => value?.title ?? args?.[0],
  // ── The wiki (control-wiki.mjs) ──
  // (By the page's or section's path: the name that the wiki gives it, not its text.)
  "wiki.add": (args, value) => value?.path ?? args?.[0]?.title,
  "wiki.addFolder": (args, value) => value?.path ?? args?.[0]?.name,
  "wiki.save": (args, value) => value?.path ?? args?.[0],
  "wiki.move": (args, value) => value?.from ?? args?.[0],
  "wiki.remove": (args, value) => value?.removed ?? args?.[0],
  "wiki.restore": (args, value) => value?.path ?? args?.[0],
  // An export is kept among the artifacts of the first bot: the scope, and the page it started from.
  "wiki.export": (args) => (args?.[0]?.scope === "all" ? "all pages" : args?.[0]?.page),
  // ── Preferences, usage, the cache and the Mac tools (control-prefs.mjs) ──
  // ── Credentials, the vault, password managers and the rest of a provider (control-credentials.mjs) ──
  // ── Voice (control-voice.mjs) ──
};
/** The service's own calls that only read, wait or talk in a chat: no line. Every call is in this list or in CHANGES. */
export const READS = ["status", "logs.read", "doctor", "events.wait", "pair.status", "devices.list", "bots.list", "bots.get", "providers.list", "providers.services", "providers.login.read", "providers.login.input", "providers.login.cancel", "models", "chat.open", "chat.list", "chat.send", "chat.read", "chat.stop", "chat.respond", "runs.list", "routines.list", "plugins.list", "plugins.marketplaces", "plugins.browse", "plugins.preview", "config.get", "config.describe", "relay.status", "update.status", "update.check", "methods", "plugins.get", "tools.list", "tools.get", "tools.import.preview", "tools.signIn.read", "tools.signIn.input", "tools.signIn.cancel", "skills.list", "skills.get", "bots.tools", "bots.access", "bots.menu", "folders.list"];
// The reads of the rest of the workspace, one line for each area (each area's builder writes only its own line).
export const MORE_READS = {
  bots: ["bots.flags", "bots.memory", "bots.sections", "bots.sections.get", "bots.importable", "bots.import.preview", "templates.list", "templates.get", "templates.import.preview"],
  chats: ["chats.list", "chats.get", "chats.queue", "chats.mentions", "chats.aside", "chats.sections", "chats.projectLook"], // (`chats.aside` asks the chat's model a question that the chat does not keep.)
  routines: ["routines.get", "routines.review", "routines.when", "routines.schedules"],
  projects: ["projects.list", "projects.get", "projects.artifacts", "projects.changes", "projects.diff", "todos.list", "todos.get", "tasks.list", "tasks.get", "artifacts.list", "artifacts.read", "artifacts.resolve"],
  wiki: ["wiki.tree", "wiki.find", "wiki.page", "wiki.search", "wiki.history", "wiki.version", "wiki.exportPlan"],
  prefs: [],
  credentials: [],
  voice: [],
};
READS.push(...Object.values(MORE_READS).flat());

/** The first argument of a sign-in's call when it is a name (what the command line gives), and nothing when it could be an address with a code. */
const nameOnly = (value) => (typeof value === "string" && !/[:?=&#]/.test(value) ? value : null);

/** A few names for one line of the log: the first ones, then how many more. */
const some = (names) => (Array.isArray(names) && names.length ? names.slice(0, 4).join(", ").slice(0, 60) + (names.length > 4 ? " and " + (names.length - 4) + " more" : "") : null);

/** A short name that is safe to write in a log: an id or a name, one line, no more than 80 characters. Anything else is left out. It uses the short list (shown-text.mjs): a bot named with a flag or a family emoji is still in its line, and a name with a control character or a mark that turns text around is not. */
export const thingForLog = (value) => (typeof value === "string" && value.length >= 1 && value.length <= 80 && !hasUnplain(value) ? value : null);
/** A routine's name with how often it runs, for a routine that runs often: `Check (each 5 minutes)`. */
const withRate = (name, minutes) => {
  const rate = "(each " + (minutes === 1 ? "minute" : minutes + " minutes") + ")";
  return thingForLog(name) && name.length <= 80 - rate.length - 1 ? name + " " + rate : rate;
};
