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

/** Why a call has no command. The list is fixed: a new reason is a decision, not an entry. */
export const REASONS = {
  window: "needs a window", // a file dialog, the clipboard, a folder opened in the file manager, a notification, a microphone
  "window's own": "the window's own", // what only the window uses to draw itself: a pane, a preview, a thumbnail
  "phone's own": "a phone's own", // what only a paired phone uses: its notifications, the screen it is shown, its uploads
};

/** The parts of the work that still owe commands, in the order they are built. When all are done, `owed` is no longer accepted. */
export const PARTS = {
  c: "plugins: the reviewed revision, settings, chosen bots, a folder plugin, sign-in",
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
  ...each("duplicateBot reorderBots makePrimary setBotFlags botMemory setBotMemory addSection renameSection deleteSection importableAgents importAgents", owed("d")),
  ...each("saveTemplate renameTemplate deleteTemplate exportTemplateText importTemplateText", owed("d")),
  setBotIntegrations: cmd("bots tools"),
  setBotAccess: cmd("bots access"),
  catalog: cmd("bots menu"),
  clearApprovals: cmd("tools forget-approvals"),
  listFolders: cmd("folders"),
  // ── Model providers and models ──
  providers: cmd("providers list"),
  setProviderEnabled: cmd("providers enable"),
  providerServices: cmd("providers services"),
  ...each("providerSignInStart providerSignInRead providerSignInInput providerSignInCancel", cmd("providers login")),
  models: cmd("models"),
  setModel: cmd("models"),
  ...each("auth signIn cancelSignIn signOut installProvider providerUseToken connectProviderService finishProviderService cancelProviderService disconnectProviderService providerUsage", owed("d")),
  // ── Chats ──
  ...each("createChat send stop respond", cmd("chat")),
  // (A side question is a person's act in a chat, which the phone has as /btw: it gets a command with the chat commands.)
  ...each("renameChat deleteChat forkChat compact setChatFlags setChatProject createGroupChat retry unqueue sendNow mentionables sideQuestion", owed("d")),
  ...each("link.chats.addSection link.chats.renameSection link.chats.deleteSection link.chats.orderSections link.chats.setSection", owed("d")), // sections on the Chats page, by the link's names
  // ── Routines ──
  runRoutine: cmd("routines run"),
  setRoutineEnabled: cmd("routines pause"),
  ...each("createRoutine updateRoutine deleteRoutine duplicateRoutine previewCadence changeSchedule", owed("d")),
  // ── Plugins ──
  "plugins.marketplaces": cmd("plugins marketplaces"),
  "plugins.addMarketplace": cmd("plugins add-marketplace"),
  "plugins.removeMarketplace": cmd("plugins remove-marketplace"),
  "plugins.browse": cmd("plugins browse"),
  "plugins.install": cmd("plugins install"),
  "plugins.update": cmd("plugins update"),
  "plugins.setEnabled": cmd("plugins enable"),
  "plugins.uninstall": cmd("plugins uninstall"),
  ...each("plugins.preview plugins.configure plugins.setBots plugins.addFolder", owed("c")),
  // ── Tools (MCP servers) and skills ──
  saveMcpServer: cmd("tools add"),
  setMcpServerEnabled: cmd("tools enable"),
  removeMcpServer: cmd("tools remove"),
  testMcpServer: cmd("tools test"),
  importMcpServers: cmd("tools import"),
  signOutMcpServer: cmd("tools sign-out"),
  // A tool's sign-in opens a browser on this computer and waits for it to come back. A host with
  // no screen has none: there a paired phone signs the tool in and hands the sign-in over.
  ...each("signInMcpServer cancelMcpSignIn", no("window")),
  importMcpServerFile: no("window"), // a file dialog; `tools import <file>` reads the file itself
  skills: cmd("skills list"),
  readSkill: cmd("skills show"),
  saveSkill: cmd("skills add"),
  setSkillEnabled: cmd("skills enable"),
  removeSkill: cmd("skills remove"),
  addSkillFolderAt: cmd("skills add-folder"),
  removeSkillFolder: cmd("skills remove-folder"),
  // ── Projects ──
  ...each("createProject addProject renameProject updateProject removeProject addProjectFolder addProjectArtifact removeProjectArtifact projectArtifacts projectChanges projectDiff projectCommit startProjectChat", owed("d")),
  ...each("addTodo updateTodo moveTodo deleteTodo", owed("d")),
  // ── Tasks, the wiki, artifacts ──
  ...each("saveTask moveTask startTask deleteTask", owed("d")),
  ...each("wikiTree wikiPage searchWiki createWikiPage createWikiPageFor createWikiFolder saveWikiPage moveWiki deleteWiki wikiHistory wikiVersion restoreWikiVersion wikiExportPlan wikiExportPages exportWikiFile", owed("d")),
  ...each("artifacts.list artifacts.read artifacts.resolve", owed("d")),
  // ── Preferences, credentials, usage, voice ──
  setPreferences: owed("d"),
  ...each("credentials removeCredential savedCredentials saveSavedCredential checkSavedCredential removeSavedCredential resetVault", owed("d")),
  ...each("passwordManagers passwordManagerVaults passwordManagerItems passwordManagerItem linkPasswordManagerField lockPasswordManager unlockPasswordManager", owed("d")),
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
  ...each("link.chats.addSection link.chats.renameSection link.chats.deleteSection link.chats.orderSections link.chats.setSection", owed("d")),
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
 * thing (a bot, a device, a setting), a function that finds its name in what was given, or null
 * when there is none to name. A change made through
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
  "config.set": 0,
  "config.replace": null,
  "relay.set": null,
  "relay.reset": null,
  "update.install": null,
  "tools.add": (args) => args?.[0]?.name,
  "tools.edit": 0,
  "tools.remove": 0,
  "tools.enable": 0,
  "tools.test": 0,
  "tools.import": null,
  "tools.signOut": 0,
  "tools.forgetApprovals": null,
  "skills.save": (args) => args?.[0]?.name,
  "skills.remove": 0,
  "skills.enable": 0,
  "skills.addFolder": null,
  "skills.removeFolder": null,
  "bots.tools.set": 0,
  "bots.access.set": 0,
};
/** The service's own calls that only read, wait or talk in a chat: no line. Every call is in this list or in CHANGES. */
export const READS = ["status", "logs.read", "doctor", "events.wait", "pair.status", "devices.list", "bots.list", "bots.get", "providers.list", "providers.services", "providers.login.read", "providers.login.input", "providers.login.cancel", "models", "chat.open", "chat.list", "chat.send", "chat.read", "chat.stop", "chat.respond", "runs.list", "routines.list", "plugins.list", "plugins.marketplaces", "plugins.browse", "plugins.preview", "config.get", "config.describe", "relay.status", "update.status", "update.check", "methods", "tools.list", "tools.get", "tools.import.preview", "skills.list", "skills.get", "bots.tools", "bots.access", "bots.menu", "folders.list"];

/** A short name that is safe to write in a log: an id or a name, one line, no more than 80 characters. Anything else is left out. */
export const thingForLog = (value) => (typeof value === "string" && /^[^\u0000-\u001f\u007f]{1,80}$/.test(value) ? value : null);
