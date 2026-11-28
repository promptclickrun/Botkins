// The command line's cover of what Botkins can do, as one table.
//
// Every call the app's window can make (each key of `runtime.handlers`), and every call of the
// phone link that an owner makes and that is not one of those, has one entry here:
//
//   cmd("bots add")      the command that does it
//   no("window")         it has no command, for one reason from the short list below
//
// Nothing is owed: every call has a command or a reason. A new call of the app comes with its command,
// or with a reason, in the same piece of work. (There is no hidden `botkins call`: nothing is left that
// a command does not reach, and a call that a command covers must be done by that command, which shows
// what it changes and leaves a line in the log.)
//
// test/terminal-coverage.test.mjs reads the calls from a running service and from the link, and
// fails when a call has no entry, when an entry names a call that is gone, and when a command
// that is named here no longer exists. So a new call in the window cannot ship without its
// command, or a stated reason. This is the command line's part of the rule the phone has
// ("Parity with the computer", mobile/AGENTS.md): what a person can do in the window, a person
// or an agent can do from a terminal, unless it needs the window itself.

import { hasUnplain } from "../shown-text.mjs";

/** Why a call has no command. The list is fixed: a new reason is a decision, not an entry. */
export const REASONS = {
  window: "needs a window", // a file dialog, the clipboard, a folder opened in the file manager, a notification, a microphone
  "window's own": "the window's own", // what only the window uses to draw itself: a pane, a preview, a thumbnail
  "phone's own": "a phone's own", // what only a paired phone uses: its notifications, the screen it is shown, its uploads
  // A new reason is a decision (test/terminal-coverage.test.mjs). This one is for the password managers and what is like them. The owner agreed to this on 2026-11-21: "nothing that reaches a saved secret runs from the command line, so unlocking a password manager and using a saved credential by reference stay in the window and on the phone."
  person: "needs a person at the app: the window, or a phone with its owner check", // a call that reaches a secret which a caller of the socket cannot read by itself, or sends one somewhere: the socket cannot know that a person is there
};

const cmd = (command) => ({ command });
const no = (reason) => ({ reason });
const each = (names, entry) => Object.fromEntries(names.split(/\s+/).filter(Boolean).map((name) => [name, entry]));

/** The app's own calls: every key of `runtime.handlers`. */
export const WORKSPACE = {
  // ── Bots ──
  addBot: cmd("bots add"),
  updateBot: cmd("bots edit"),
  deleteBot: cmd("bots remove"),
  duplicateBot: cmd("bots duplicate"),
  reloadBotTools: cmd("bots reload-tools"),
  reorderBots: cmd("bots order"),
  makePrimary: cmd("bots primary"),
  setBotFlags: cmd("bots flags"),
  setBotProactive: cmd("bots proactive"),
  proactiveAct: cmd("bots alert"),
  ...each("botMemory setBotMemory", cmd("bots memory")),
  ...each("addSection", cmd("bots sections add")),
  renameSection: cmd("bots sections rename"),
  deleteSection: cmd("bots sections remove"),
  orderSections: cmd("bots sections move"),
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
  harnesses: cmd("preferences harnesses"), // the programs that can run a turn (Pi and OMP) and which choice of the preference `harness` is set
  setProviderEnabled: cmd("providers enable"),
  providerConfigure: cmd("providers set"),
  providerServices: cmd("providers services"),
  ...each("providerSignInStart providerSignInRead providerSignInInput providerSignInCancel", cmd("providers login")),
  models: cmd("models"),
  setModel: cmd("models"),
  // `auth` says whether a provider is signed in and as whom: `providers list` shows that for each provider.
  auth: cmd("providers list"),
  // `providers login` is the sign-in of a provider from a terminal: its own sign-in, a pasted token (`--token`, from a hidden question or standard input),
  // and an OpenCode model service's key or sign-in with its code (`--service`, `--method`). Ctrl-C ends one that is open.
  ...each("signIn cancelSignIn providerUseToken connectProviderService finishProviderService cancelProviderService", cmd("providers login")),
  signOut: cmd("providers logout"),
  installProvider: cmd("providers install"),
  disconnectProviderService: cmd("providers disconnect"),
  providerUsage: cmd("providers usage"),
  // ── Chats ──
  ...each("createChat send stop respond", cmd("chat")),
  // One helper or background command of a turn, stopped alone: `chats stop-helper` lists them and stops one.
  stopHelper: cmd("chats stop-helper"),
  // (A side question is a person's act in a chat, which the phone has as /btw: it gets a command with the chat commands.)
  mainChat: cmd("chat"),
  changeMainFork: cmd("chats switch-fork"),
  setProactiveChatMode: cmd("preferences set"),
  renameChat: cmd("chats rename"),
  regenerateChatTitle: cmd("chats regenerate-title"),
  deleteChat: cmd("chats delete"),
  reactToMessage: cmd("chats react"),
  "chat.cardAction": cmd("chats card"),
  forkChat: cmd("chats fork"),
  compact: cmd("chats compact"),
  setChatFlags: cmd("chats flags"),
  markChatsRead: cmd("chats read"),
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
  // ── Workflows ──
  workflowsList: cmd("workflows list"),
  workflowCreate: cmd("workflows add"),
  workflowUpdate: cmd("workflows edit"),
  workflowDelete: cmd("workflows remove"),
  workflowPause: cmd("workflows pause"),
  workflowResume: cmd("workflows resume"),
  workflowRun: cmd("workflows run"),
  workflowRetryRun: cmd("workflows retry"),
  workflowRespondApproval: cmd("workflows approve"),
  workflowCancelRun: cmd("workflows cancel"),
  workflowExportText: cmd("workflows export"),
  workflowImportText: cmd("workflows import"),
  workflowExport: no("window"), // native save file dialog; `workflows export <id>` prints JSON
  workflowImport: no("window"), // native open file dialog; `workflows import <file>` reads a path
  workflowRotateWebhookSecret: no("person"), // returns a newly generated webhook secret; stays in the window or owner phone
  workflowGithubStatus: no("person"), // checks local gh CLI sign-in state for the Workflow trigger UI; terminal users run `gh auth status`
  workflowGithubSignInStart: no("person"), // interactive browser device-code flow for `gh auth login --web`; terminal users run `gh auth login`
  workflowGithubSignInCancel: no("person"), // cancels an in-progress `gh auth login --web` started from the window or owner phone
  // ── Channel Hooks ──
  channelsList: cmd("channels list"),
  channelAdd: cmd("channels add"),
  channelUpdate: cmd("channels add"),
  channelRemove: cmd("channels remove"),
  channelBind: cmd("channels bind"),
  channelSetPolicy: cmd("channels policy"),
  channelPause: cmd("channels pause"),
  channelResume: cmd("channels resume"),
  channelPairList: cmd("channels pair list"),
  channelPairApprove: cmd("channels pair approve"),
  channelPairDeny: cmd("channels pair deny"),
  channelTest: cmd("channels test"),
  channelLogs: cmd("channels logs"),
  // ── Plugins ──
  "skills.upload": cmd("skills upload"),
  // A script command (desktop/script-commands.mjs): `skills add-script` shows the whole script and needs a yes; `skills show` prints it.
  "skills.saveScript": cmd("skills add-script"),
  "skills.readScript": cmd("skills show"),
  "skillsCatalog.search": cmd("skills search"),
  "skillsCatalog.preview": cmd("skills preview"),
  "skillsCatalog.install": cmd("skills install"),
  // The featured shelf: upstream skills pinned to a commit, installed with `skills preview` and `skills install`.
  "skillsCatalog.featured": cmd("skills featured"),
  // ── Marketplace format version 2 (desktop/catalog-v2.mjs): catalog skills, packs and version 3 templates ──
  "market.catalog": cmd("marketplace list"),
  "market.skillImage": no("window's own"),
  "market.skillPreview": cmd("marketplace show"),
  "market.skillInstall": cmd("marketplace install"),
  "market.packPreview": cmd("marketplace show"),
  "market.packInstall": cmd("marketplace install"),
  "market.templatePreview": cmd("marketplace show"),
  "market.templateInstall": cmd("marketplace install"),
  // ── The direct apps catalog (desktop/mcp-catalog.mjs) ──
  "mcpCatalog.list": cmd("tools catalog"),
  // A key comes from a hidden question or --secrets; a program's line is shown and needs a yes.
  "mcpCatalog.add": cmd("tools connect"),
  "piPackages.browse": cmd("pi browse"),
  "piPackages.preview": cmd("pi show"),
  "piPackages.list": cmd("pi list"),
  "piPackages.install": cmd("pi install"),
  "piPackages.setEnabled": cmd("pi enable"),
  "piPackages.remove": cmd("pi remove"),
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
  "plugins.refresh": cmd("plugins refresh"),
  // ── Agent templates in the marketplaces ("agent-templates-v1") ──
  "agents.browse": cmd("templates browse"),
  "agents.template": cmd("templates show"),
  // ── Marketplace › Apps: the person's Composio apps through this computer's Composio tool ──
  "composio.catalog": cmd("apps list"),
  "composio.connected": cmd("apps connected"),
  "composio.accounts": cmd("apps accounts"),
  "composio.connect": cmd("apps connect"),
  "composio.removeAccount": cmd("apps remove"),
  // A chat's Connect card: `apps connect <app> --chat <chat>` presses Connect on that chat's card and waits for it.
  ...each("composio.cardOpen composio.cardCheck", cmd("apps connect")),
  // An MCP App's view in a chat: what it shows and what it asks of its own server, while the window or a phone shows it.
  ...each("mcpApps.view mcpApps.callTool mcpApps.readResource", no("window's own")),
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
  editProjectFolder: cmd("projects folder"),
  chatProjectFolder: cmd("chats show"),
  setChatFolder: cmd("chats project"),
  cloneProjectRepository: cmd("projects clone"),
  updateProject: cmd("projects edit"),
  removeProject: cmd("projects remove"),
  addProjectArtifact: cmd("projects add-artifact"),
  removeProjectArtifact: cmd("projects remove-artifact"),
  projectArtifacts: cmd("projects artifacts"),
  projectChanges: cmd("projects changes"),
  projectDiff: cmd("projects diff"),
  projectCommit: cmd("projects commit"),
  startProjectChat: cmd("projects chat"),
  projectJobSetup: cmd("jobs setup"),
  approveJobSetup: cmd("jobs allow-setup"),
  startProjectJob: cmd("jobs start"),
  projectJobStatus: cmd("jobs status"),
  bringInJob: cmd("jobs bring-in"),
  catchUpJob: cmd("jobs catch-up"),
  removeJobWorktree: cmd("jobs remove"),
  startJobTurn: cmd("jobs start-anyway"),
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
  // Claude artifacts (Settings › General › Claude artifacts): standing bot approvals and status are managed by the owner in the app/phone UI.
  ...each("claudeArtifacts.status claudeArtifacts.setModel claudeArtifacts.setBotApproval claudeArtifacts.revokeBotApproval", no("person")),
  // ── Preferences, credentials, usage, voice ──
  setPreferences: cmd("preferences set"),
  // No command shows a value: a list has names, kinds and where each is read from. A new value comes from a hidden question or standard input.
  credentials: cmd("vault list"),
  removeCredential: cmd("vault remove"),
  resetVault: cmd("vault reset"),
  savedCredentials: cmd("credentials list"),
  saveSavedCredential: cmd("credentials save"), // `credentials edit` changes one
  checkSavedCredential: no("person"), // it reads a linked field through the password manager's tool, so it reaches a saved secret
  removeSavedCredential: cmd("credentials remove"),
  // These five need a person at the app. After an unlock, a password manager's session stays in the
  // service's memory, so every later caller of the socket could list the person's logins. And a
  // field that is linked under a name that the caller chose is a secret that the person's own
  // picker then hands over. (`passwordManagers` and `lockPasswordManager` have commands.)
  ...each("unlockPasswordManager passwordManagerVaults passwordManagerItems passwordManagerItem linkPasswordManagerField copyPasswordManagerField setCredentialGrant", no("person")),
  credentialGrants: cmd("credentials grants"),
  revokeCredentialGrant: cmd("credentials revoke"),
  credentialAudit: cmd("credentials audit"),
  passwordManagers: cmd("password-managers list"),
  ...each("protonPassInstallPlan protonPassInstall", cmd("password-managers install")),
  ...each("protonPassSignInStart protonPassSignInRead protonPassSignInInput protonPassSignInCancel", cmd("password-managers sign-in")),
  protonPassDisconnect: cmd("password-managers disconnect"),
  lockPasswordManager: cmd("password-managers lock"),
  usage: cmd("usage show"),
  exportUsageText: cmd("usage export"),
  cacheInfo: cmd("cache show"),
  clearCache: cmd("cache clear"),
  voiceSettings: cmd("voice show"),
  voiceOptions: cmd("voice options"),
  setVoice: cmd("voice set"),
  setVoiceKey: cmd("voice key"),
  macToolsStatus: cmd("mac-tools status"),
  setMacTool: cmd("mac-tools set"),
  // ── Panels and the team ──
  changePanel: cmd("panels hide"), // and `panels unhide`, `panels size`, `panels order`, `panels remove`: each is one action of this call
  refreshPanel: cmd("panels refresh"),
  routine: cmd("panels routine set"), // and `panels routine pause`, `resume` and `remove`
  boardAct: cmd("cards act"),
  // Spaces ("spaces-v1"): the app's twelve calls, and the link's own for sharing, order and "Notify me", as the owner's window makes them.
  "spaces.read": cmd("spaces show"), // and `spaces list`
  "spaces.create": cmd("spaces add"),
  "spaces.rename": cmd("spaces rename"),
  "spaces.remove": cmd("spaces remove"),
  "spaces.setProject": cmd("spaces project"),
  "spaces.setPanelProject": cmd("panels project"),
  "spaces.newPanel": cmd("panels new"),
  "spaces.ask": cmd("spaces ask"), // and `panels ask`
  "spaces.movePanel": cmd("panels move"),
  "spaces.patchState": cmd("panels set-state"),
  "spaces.note": cmd("panels note"),
  "spaces.removeNote": cmd("panels remove-note"),
  // Sharing a space (control-sharing.mjs). `seen` and `here` say that a person opened a space on a device, or looks at it now: the window sends them on its own as a space comes into view, and a terminal is no device.
  "link.spaces.share": cmd("sharing set"), // (a link is made by `sharing link`, which uses this call too)
  "link.spaces.newLink": cmd("sharing link"),
  "link.spaces.arrange": cmd("sharing order"), // and `sharing pin`
  "link.spaces.notify": cmd("sharing notify"),
  ...each("link.spaces.seen link.spaces.here link.chat.typing", no("window's own")),
  "link.team.setLinkSharing": cmd("sharing links"),
  // The team (control-team.mjs): kept by the phone link, reached through the app's own calls.
  team: cmd("team show"),
  renameTeam: cmd("team rename"),
  renameTeamMember: cmd("team members rename"),
  // The owner's own picture ("people-avatars-v1"); `botkins profile picture clear` takes it away.
  setMyAvatar: cmd("profile picture set"),
  saveTeamRole: cmd("team roles save"),
  deleteTeamRole: cmd("team roles remove"),
  saveTeamGroup: cmd("team groups save"),
  deleteTeamGroup: cmd("team groups remove"),
  createTeamInvite: cmd("team invite"),
  revokeTeamInvite: cmd("team invites revoke"),
  approveTeamRequest: cmd("team requests approve"),
  denyTeamRequest: cmd("team requests deny"),
  moveTeamMember: cmd("team members move"),
  removeTeamMember: cmd("team members remove"),
  chatPeople: cmd("team chat list"),
  inviteToChat: cmd("team chat invite"),
  removeFromChat: cmd("team chat remove"),
  // ── This computer: updates, phones, the relay ──
  ...each("appUpdateStatus checkAppUpdate installAppUpdate", cmd("update")),
  setAppUpdateAuto: cmd("config set"),
  ...each("snapshot appInfo phoneLink", cmd("status")),
  sendFeedback: cmd("feedback"),
  ...each("startPhonePairing cancelPhonePairing", cmd("pair")),
  setPhoneLink: cmd("config set"),
  renamePhoneLinkComputer: cmd("config set"),
  renamePhone: cmd("devices rename"),
  setPhonePerson: cmd("devices set-person"),
  removePhone: cmd("devices remove"),
  configureGadget: cmd("gadgets set"),
  gadgetWifi: cmd("gadgets wifi"),
  restartGadget: cmd("gadgets restart"),
  setPhoneRelay: cmd("relay on"),
  resetPhoneRelay: cmd("relay reset"),
  // ── Node host (control-node.mjs) ──
  nodeStatus: cmd("node status"),
  nodeSetup: cmd("node setup"),
  nodeRename: cmd("node rename"),
  nodePause: cmd("node pause"),
  nodeSetWholeComputer: cmd("node whole-computer"),
  nodeSetExecMode: cmd("node policy"),
  nodeAddAllowlistRule: cmd("node allowlist"),
  nodeRemoveAllowlistRule: cmd("node allowlist"),
  nodeAuditLog: cmd("node audit"),
  nodeShareProject: cmd("node share"),
  nodeRevokeGrant: cmd("node revoke"),
  nodeDisconnect: cmd("node disconnect"),
  nodeConvertInspect: cmd("node convert"),
  nodeConvertPlan: cmd("node convert"),
  nodeConvertRun: cmd("node convert"),
  nodeConvertStatus: cmd("node convert"),
  nodeConvertUndo: cmd("node convert"),
  nodeRemoteStatus: cmd("node remote"),
  nodeRemoteControl: cmd("node remote"),
  // ── What needs a window ──
  ...each("chooseFiles chooseProjectFolder pickPluginFolder pickSkillUpload addSkillFolder", no("window")), // a file or folder dialog (a path is given to the command instead)
  ...each("revealProject revealSkill revealWiki revealWikiExport openChatPath openLink openAppRelease", no("window")), // opens a folder, a file or a link on the computer's screen
  ...each("copyText copyReply", no("window")), // the clipboard
  ...each("exportTemplate importTemplate exportUsage exportWiki", no("window")), // a save or open dialog; the text forms have commands
  ...each("startDictation startLiveVoice endLiveVoice liveVoiceTool liveVoiceTranscript recordVoiceLine transcribe speak", no("window")), // the window's microphone and speaker
  ...each("testNotification requestScreenPermission allowLocalNetwork grantMacTool setPhoneScreen computerUseStatus requestComputerUsePermission", no("window")), // a notification or a permission the system asks for on the screen
  // ── What only the window uses to draw itself ──
  ...each("sidePane frameAnswer frameOpenLink linkPreview previewChatPath thumbnailChatPath inspectChatPaths artifacts.thumbnail warmChat", no("window's own")),
};

/** The phone link's own calls: every `link.*` name of `LinkHost` (desktop/link/server.mjs). */
export const LINK = {
  "link.feedback.send": cmd("feedback"),
  "link.devices.list": cmd("devices list"),
  "link.devices.rename": cmd("devices rename"),
  "link.devices.setPerson": cmd("devices set-person"),
  "link.devices.remove": cmd("devices remove"),
  // Gadgets (desktop/link/gadget.mjs). A person names one from a cable; the rest are a gadget's own calls,
  // which only a paired gadget makes, as a phone makes its own.
  "link.gadgets.add": cmd("gadgets add"),
  "link.gadgets.configure": cmd("gadgets set"),
  "link.gadgets.wifi": cmd("gadgets wifi"),
  "link.gadgets.restart": cmd("gadgets restart"),
  ...each("link.gadget.hello link.gadget.set link.gadget.say link.gadget.hear link.gadget.speak link.gadget.face", no("phone's own")),
  // The team, as the link names the same calls (control-team.mjs).
  "link.team.get": cmd("team show"),
  "link.team.rename": cmd("team rename"),
  "link.team.renameMember": cmd("team members rename"),
  "link.team.saveRole": cmd("team roles save"),
  "link.team.deleteRole": cmd("team roles remove"),
  "link.team.saveGroup": cmd("team groups save"),
  "link.team.deleteGroup": cmd("team groups remove"),
  "link.team.createInvite": cmd("team invite"),
  "link.team.revokeInvite": cmd("team invites revoke"),
  "link.team.approve": cmd("team requests approve"),
  "link.team.deny": cmd("team requests deny"),
  "link.team.moveMember": cmd("team members move"),
  "link.team.removeMember": cmd("team members remove"),
  "link.team.inviteToChat": cmd("team chat invite"),
  "link.team.removeFromChat": cmd("team chat remove"),
  // Sharing a space (control-sharing.mjs). The phone's own calls for what a person opened or looks at now: the phone sends them as a space comes into view.
  "link.spaces.share": cmd("sharing set"),
  "link.spaces.newLink": cmd("sharing link"),
  "link.spaces.arrange": cmd("sharing order"),
  "link.spaces.notify": cmd("sharing notify"),
  ...each("link.spaces.seen link.spaces.here link.chat.typing", no("phone's own")),
  "link.team.setLinkSharing": cmd("sharing links"),
  // Sections on the Chats screen ("chat-sections-v1"): a person's own way to group their chats.
  "link.chats.addSection": cmd("chats sections add"),
  "link.chats.renameSection": cmd("chats sections rename"),
  "link.chats.deleteSection": cmd("chats sections delete"),
  "link.chats.orderSections": cmd("chats sections order"),
  "link.chats.setSection": cmd("chats sections set"),
  // Admin mode is each owner device's own way of looking: the command line shows everything, as an owner with it on.
  "link.team.setAdminMode": no("phone's own"),
  // A phone's way to the computer's saved credentials and password managers. The owner at the terminal has the commands of the app's own calls for what a command covers; the rest needs a person at the app.
  ...each("link.credentials.audit link.credentials.check link.credentials.copy link.credentials.grants link.credentials.item link.credentials.items link.credentials.link link.credentials.lock link.credentials.managers link.credentials.remove link.credentials.revokeGrant link.credentials.save link.credentials.setGrant link.credentials.unlock link.credentials.vaults", no("phone's own")),
  ...each("link.credentials.protonPassInstallPlan link.credentials.protonPassInstall", cmd("password-managers install")),
  ...each("link.credentials.protonPassSignInStart link.credentials.protonPassSignInRead link.credentials.protonPassSignInInput link.credentials.protonPassSignInCancel", cmd("password-managers sign-in")),
  "link.credentials.protonPassDisconnect": cmd("password-managers disconnect"),
  ...each("link.device.answer link.device.file link.device.sources link.browser.answer link.browser.state link.upload link.pullRequests", no("phone's own")),
  ...each("link.push.activity link.push.prefs link.push.presence link.push.register link.push.test link.push.unregister", no("phone's own")),
  ...each("link.screen.frame link.screen.grant.begin link.screen.grant.confirm link.screen.info link.screen.input link.screen.revoke link.screen.stop link.screen.video.open link.screen.video.read link.screen.video.close", no("phone's own")),
  ...each("link.pullRequest link.pullRequestDiff", no("window's own")),
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
  // A report sent as a public issue: its number. Never its title or text.
  "feedback.send": (args, value) => (Number.isSafeInteger(value?.number) ? "issue " + value.number : null),
  "pair.start": null,
  "pair.cancel": null,
  "devices.rename": 0,
  "devices.setPerson": 0,
  "devices.remove": 0,
  // A gadget set up over a cable: its name as the computer keeps it. Never the Wi-Fi network or its password.
  "gadgets.add": (args, value) => value?.name,
  // A gadget's settings, a network for it, a restart: the gadget's name, never a network's name or a password.
  "gadgets.set": (args, value) => value?.name,
  "gadgets.wifi": (args, value) => value?.name,
  "gadgets.restart": (args, value) => value?.name,
  // An answer to a request that waits in a chat: the chat's id, the kind of the request (one of four fixed words) and yes or no. Never the request's text or the answer's, never a value.
  "chat.respond": (args, value) => (value?.chatId && ["permission", "secure", "question", "form"].includes(value.kind) && ["yes", "no"].includes(value.answered) ? value.chatId + " " + value.kind + " " + value.answered : (value?.chatId ?? null)),
  "bots.add": (args) => args?.[0]?.name,
  "bots.edit": 0,
  "bots.remove": 0,
  "providers.enable": 0,
  "providers.login": 0,
  "providers.logout": 0,
  "providers.set": 0,
  "models.default": null,
  "models.speed": ([scope, id]) => id ?? scope,
  "models.routines": null,
  "models.chat": 0,
  "chat.main": (args, value) => value?.chatId,
  "routines.run": 0,
  "routines.pause": 0,
  "routines.resume": 0,
  "plugins.addMarketplace": null,
  "plugins.removeMarketplace": 0,
  "skills.upload": (_, result) => result?.added?.join(", "),
  "skillsCatalog.install": (_, result) => result?.added?.[0],
  "market.skillInstall": (_, result) => result?.added?.[0],
  "market.packInstall": (_, result) => result?.added?.join(", "),
  "market.templateInstall": (_, result) => result?.botId,
  // By the catalog entry's id, never a key.
  "mcpCatalog.add": 0,
  "piPackages.install": 0,
  "piPackages.setEnabled": 0,
  "piPackages.remove": 0,
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
  "tools.forgetApprovals": (args) => args?.[0] ?? "every chat",
  "skills.save": (args) => args?.[0]?.name,
  // By the command's name, never its script.
  "skills.saveScript": (args) => args?.[0]?.name,
  "skills.remove": 0,
  "skills.enable": 0,
  "skills.addFolder": 0,
  "skills.removeFolder": (args, value) => value?.path ?? args?.[0],
  "bots.tools.set": 0,
  "bots.access.set": 0,
  // ── More of a bot, and templates (control-bots.mjs) ──
  // (By the name of the bot, the section or the template, as the answer has it. The text of a memory, an agent's instructions and a template's words are never in a line.)
  "bots.duplicate": (args, value) => value?.name ?? args?.[0],
  "bots.reloadTools": (args, value) => value?.name ?? args?.[0],
  "bots.order": null,
  "bots.primary": (args, value) => value?.name ?? args?.[0],
  "bots.flags.set": (args, value) => value?.name ?? args?.[0],
  // The bot's name only: not its rules, and not who it looks out for.
  "bots.proactive.set": (args, value) => value?.name ?? args?.[0],
  // The bot's name only: not the alert's words, and not what was offered.
  "bots.proactive.act": (args, value) => value?.name ?? args?.[0],
  "bots.memory.set": (args, value) => value?.name ?? args?.[0],
  "bots.sections.add": (args, value) => value?.name ?? args?.[0],
  "bots.sections.rename": (args, value) => value?.name ?? args?.[0],
  "bots.sections.move": (args) => args?.[0],
  "bots.sections.remove": (args, value) => value?.name ?? args?.[0],
  "bots.import": (args, value) => some(value?.added?.map((bot) => bot.name)),
  "templates.save": (args, value) => value?.name ?? args?.[0],
  "templates.rename": (args, value) => value?.name ?? args?.[0],
  "templates.remove": (args, value) => value?.name ?? args?.[0],
  // An export also keeps a copy of the file among the bot's files: it is a change, by the file's name.
  "templates.export": (args, value) => value?.name,
  "templates.import": (args, value) => value?.name,
  "templates.use": (args, value) => value?.name,
  // ── Chats (control-chats.mjs) ──
  // A chat is named by its id: a title is a text that a person (or a model) wrote, so it is not in the log. A section is by its id too, and a new one by its name.
  "chats.rename": (args, value) => value?.id,
  "chats.regenerateTitle": (args, value) => value?.id,
  "chats.delete": (args, value) => value?.id,
  "chats.react": (_args, value) => value?.id,
  "chats.card": (_args, value) => value?.id,
  "chats.reset": (args, value) => value?.id,
  "chats.switchFork": (args, value) => value?.id,
  "chats.fork": (args, value) => value?.from,
  "chats.compact": (args, value) => value?.id,
  "chats.flags": (args, value) => value?.id,
  "chats.read": (_args, value) => some(value?.ids),
  // By the chat's id and the mode that it has now ("<id> (yolo)"), so that a log line shows a chat that was given yolo.
  "chats.project": (args, value) => (value?.id ? value.id + " (" + (value.mode ?? "default") + ")" : null),
  "chats.group": (args, value) => value?.id,
  "chats.retry": (args, value) => value?.id,
  "chats.unqueue": (args, value) => value?.id,
  "chats.sendNow": (args, value) => value?.id,
  "chats.stopHelper": (args, value) => value?.id,
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
  // A chat's own schedule (a prompt it set with /every or /after): the chat's title, and what was done (pause, resume or delete).
  "routines.schedule": (args, value) => (["pause", "resume", "delete"].includes(value?.action) ? levelOf(value.chat ?? args?.[0], value.action) : (value?.chat ?? args?.[0])),
  "workflows.add": (args, value) => value?.name ?? args?.[0]?.name,
  "workflows.edit": (args, value) => value?.name ?? args?.[0],
  "workflows.remove": (args, value) => value?.name ?? args?.[0],
  "workflows.pause": (args, value) => value?.name ?? args?.[0],
  "workflows.resume": (args, value) => value?.name ?? args?.[0],
  "workflows.run": (args, value) => value?.workflowId ?? args?.[0],
  "workflows.retry": (args, value) => value?.id ?? args?.[0],
  "workflows.approve": (args, value) => value?.id ?? args?.[0],
  "workflows.cancel": (args, value) => value?.id ?? args?.[0],
  "workflows.import": (args, value) => value?.workflow?.name ?? "imported",
  // ── Projects, to-dos, tasks and artifacts (control-projects.mjs) ──
  // The project's name (the answer has it, whether the caller gave its name or its id). Never a folder, a message, a to-do's words or a diff.
  "projects.add": (args, value) => value?.name ?? args?.[0]?.name,
  "projects.rename": (args, value) => value?.name ?? args?.[0],
  "projects.folder": (args, value) => value?.id ?? args?.[0],
  "projects.clone": (_args, value) => value?.id,
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
  // A job is in the log by its project (setup, start) or by its chat's id: never its prompt, its setup's commands or a branch.
  "jobs.allowSetup": (args, value) => value?.project?.name ?? args?.[0],
  "jobs.start": (args, value) => value?.project?.name ?? args?.[0],
  "jobs.bringIn": (_args, value) => value?.job?.id,
  "jobs.catchUp": (_args, value) => value?.job?.id,
  "jobs.remove": (_args, value) => value?.job?.id,
  "jobs.startAnyway": (_args, value) => value?.job?.id,
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
  // The key (a name in the list of preferences), never its value. The one exception is a switch that gives bots more room (`FIXED_WORDS`):
  // its new value is one of a few fixed words, so its line has it ("approval to all", "teamwork to on"). A failure has the key only.
  "preferences.set": (args, value) => fixedWord(value?.key, value?.value) ?? value?.key ?? (typeof args?.[0] === "string" && /^[A-Za-z][A-Za-z.]{0,39}$/.test(args[0]) ? args[0] : null),
  "cache.clear": null,
  // The tool, and the level that it has now (off, read or interact: a Mac tool's level says what bots may do on this computer). A failure has the tool only.
  "macTools.set": (args, value) => (["imessage", "mail"].includes(value?.tool) && ["off", "read", "interact"].includes(value.levels?.[value.tool]) ? value.tool + " to " + value.levels[value.tool] : value?.tool ?? (["imessage", "mail"].includes(args?.[0]) ? args[0] : null)),
  // ── Credentials, the vault, password managers and the rest of a provider (control-credentials.mjs) ──
  // A saved credential or a vault entry by its name (the answer has it, whether the caller gave its name or its id). Never a value, a user name or a note.
  "credentials.save": (args, value) => value?.name ?? args?.[0]?.name,
  "credentials.edit": (args, value) => value?.name ?? args?.[0],
  "credentials.remove": (args, value) => value?.name ?? args?.[0],
  "credentials.revokeGrant": (args, value) => value?.revoked ?? args?.[0],
  "credentials.vaultRemove": (args, value) => value?.name ?? args?.[0],
  // The line says that the vault was reset, and only when it was: a refused reset is a "Tried" line that does not say so.
  "credentials.vaultReset": (args, value) => (value?.reset === true ? "the vault was reset" : null),
  "credentials.managerLock": (args, value) => value?.id ?? args?.[0],
  "protonPass.install": () => "Proton Pass",
  "protonPass.disconnect": () => "Proton Pass",
  // The provider as the caller named it; the command that runs is the provider's own and is never in the line.
  "providers.install": 0,
  // The provider and the model service: `opencode/anthropic`.
  "providers.disconnectService": (args, value) => value?.provider && value?.service ? value.provider + "/" + value.service : typeof args?.[0] === "string" && typeof args?.[1] === "string" ? args[0] + "/" + args[1] : null,
  // ── Voice (control-voice.mjs) ──
  // The sections that were in the change (stt, tts, live), and the provider of an address that changed (`openai address`). Never a choice, a value or an address: an address can carry a token in its path.
  "voice.set": (args, value) => {
    const patch = args?.[0] && typeof args[0] === "object" ? args[0] : {};
    const providers = patch.providers && typeof patch.providers === "object" ? Object.keys(patch.providers) : [];
    return some(value ? [...(value.changed ?? []), ...(value.addressChanged ?? []).map((name) => name + " address")] : [...Object.keys(patch).filter((name) => ["stt", "tts", "live"].includes(name)), ...providers.filter((name) => ["openai", "azure", "custom"].includes(name)).map((name) => name + " address")]);
  },
  // The provider's name only. The key is the second argument and is never read here; on a failure only a known name is used.
  "voice.key": (args, value) => value?.provider ?? (["openai", "azure", "elevenlabs", "gemini", "custom"].includes(args?.[0]) ? args[0] : null),
  // ── Spaces and panels (control-spaces.mjs) ──
  // (A space is named by its name, which the answer has: a person's own name for it. A panel and a card are by their ids, never by a title: that is a bot's text. Never a note, a state value, a routine's prompt or a message.)
  "space.add": (args, value) => value?.name ?? args?.[0],
  "space.rename": (args, value) => value?.name ?? args?.[0],
  "space.remove": (args, value) => value?.name ?? args?.[0],
  "space.project": (args, value) => value?.name ?? args?.[0],
  // A question to a bot starts a turn: by the space.
  "space.ask": (args, value) => value?.space?.name ?? args?.[0],
  "panel.new": (args, value) => value?.space?.name ?? args?.[0]?.space,
  "panel.ask": (args, value) => value?.panel?.id,
  "panel.change": (args, value) => (value?.id ? value.id + " (" + value.action + ")" : null),
  "panel.remove": (args, value) => value?.removed,
  "panel.move": (args, value) => value?.id,
  "panel.project": (args, value) => value?.id,
  "panel.refresh": (args, value) => value?.id,
  // A routine that runs often says so, as a bot's routine does: `<id> (each 5 minutes)`.
  "panel.routine.set": (args, value) => (value?.id ? value.id + (value.routine?.fastMinutes ? " (each " + (value.routine.fastMinutes === 1 ? "minute" : value.routine.fastMinutes + " minutes") + ")" : "") : null),
  "panel.routine.pause": (args, value) => value?.id,
  "panel.routine.resume": (args, value) => (value?.id ? value.id + (value.routine?.fastMinutes ? " (each " + (value.routine.fastMinutes === 1 ? "minute" : value.routine.fastMinutes + " minutes") + ")" : "") : null),
  "panel.routine.remove": (args, value) => value?.id,
  "panel.state": (args, value) => value?.panel?.id,
  "panel.note": (args, value) => value?.panel?.id,
  "panel.noteRemove": (args, value) => value?.panel?.id,
  "card.act": (args, value) => (value?.card?.id ? value.card.id + " (" + value.action + ")" : null),
  // ── Sharing a space (control-sharing.mjs) ──
  // By the space's name and the level it got: `Launch (link)`, `Launch (all members)`. A name that cannot be in a line leaves the level alone. Never the link, a person's name or a note.
  "sharing.set": (args, value) => levelOf(value?.name ?? args?.[0], { private: "private", members: "picked people", team: "all members" }[value?.access ?? args?.[1]?.access]),
  "sharing.link": (args, value) => levelOf(value?.name ?? args?.[0], "link"),
  "sharing.setLinks": (args) => (args?.[0] === true ? "on" : args?.[0] === false ? "off" : null),
  "sharing.order": null,
  "sharing.pin": (args, value) => value?.name ?? args?.[0],
  "sharing.notify": (args, value) => value?.name ?? args?.[0],
  // ── The team (control-team.mjs) ──
  // By the id of the role, group, member, invite or request: never a name (a member's name is what a stranger typed), and never an invite's code or link.
  "team.rename": null,
  "team.saveRole": (args, value) => value?.id,
  "team.removeRole": (args, value) => value?.id,
  "team.saveGroup": (args, value) => value?.id,
  "team.removeGroup": (args, value) => value?.id,
  "team.invite": (args, value) => value?.id,
  "team.revokeInvite": (args, value) => value?.id,
  "team.approve": (args, value) => value?.member?.id ?? value?.id,
  "team.deny": (args, value) => value?.id,
  "team.moveMember": (args, value) => value?.id,
  "team.renameMember": (args, value) => value?.id,
  "team.removeMember": (args, value) => value?.id,
  "team.inviteToChat": (args, value) => (value ? value.chat.id + " (" + value.person.id + ")" : null),
  "team.removeFromChat": (args, value) => (value ? value.chat.id + " (" + value.person.id + ")" : null),
  // ── Marketplace › Apps (control-apps.mjs) ──
  // By the app's slug: never the page to sign in on, an account's id or its email.
  "apps.connect": (args, value) => (value?.chat ? value.slug + " (chat " + value.chat + ")" : (value?.slug ?? args?.[0])),
  "apps.remove": (args, value) => value?.slug ?? args?.[0],
  // Profile state never includes the bearer token or browser verifier. These calls still log as
  // account changes because finishing/binding can update the hosted computer directory.
  "profile.start": null,
  "profile.finish": null,
  "profile.refresh": null,
  "profile.optOut": null,
  "profile.signOut": null,
  "profile.approve": 0,
  "profile.revoke": 0,
  "profile.connect": 0,
  "profile.update": null,
  "profile.disconnect": null,
  "profile.reconnect": null,
  "profile.deleteAccount": null,
  "profile.markMigrationPrompted": null,
  // The owner's own picture: set or cleared, never the picture.
  "profile.picture": (args) => (args?.[0] ? "set" : "cleared"),
  // ── Node host (control-node.mjs) ──
  // Logs the node name, policy mode, project name, grant id, or pause state — never local folder paths, command args, or vault secrets.
  "node.setup": (args, value) => value?.name ?? args?.[0],
  "node.rename": (args, value) => value?.name ?? args?.[0],
  "node.pause": (args, value) => (value?.paused === true || args?.[0] === true ? "paused" : "online"),
  "node.wholeComputer": (args, value) => (value?.wholeComputer === true || args?.[0] === true ? "on" : "off"),
  "node.execMode": (args, value) =>
    value?.execPolicy?.mode ??
    (["deny", "allowlist", "ask", "full"].includes(String(args?.[0] ?? "").toLowerCase()) ? String(args[0]).toLowerCase() : null),
  "node.allowlist.add": (args) => (typeof args?.[1] === "string" && args[1].trim() ? args[1].trim() : "*"),
  "node.allowlist.remove": (args, value) => value?.removed ?? args?.[0] ?? "all",
  "node.share": (args, value) => levelOf(value?.project?.name ?? args?.[0], (value?.project?.shared ?? args?.[1] !== false) ? "shared" : "unshared"),
  "node.revoke": (args, value) => value?.revoked ?? args?.[0] ?? "all",
  "node.disconnect": null,
  "node.convert.run": (args, value) => levelOf(value?.job?.nodeName ?? args?.[0]?.nodeName, value?.job?.status ?? "run"),
  "node.convert.undo": (args, value) => value?.snapshotId ?? args?.[0] ?? "latest",
  "node.remote.control": (args, value) => levelOf(value?.hostName ?? args?.[0], args?.[1]),
  // ── Connected computers & unified multi-host view (control-hosts.mjs) ──
  "hosts.unified": (args) => (args?.[0] === true ? "on" : "off"),
  "hosts.include": (args) => levelOf(args?.[0], args?.[1] === true ? "included" : "excluded"),
  "hosts.focus": (args) => args?.[0] || "local",
  // Channel Hooks: log connection label/id only, never tokens or message bodies.
  "channels.add": (args, value) => value?.label ?? args?.[0]?.label ?? args?.[0]?.kind,
  "channels.update": (args, value) => value?.label ?? args?.[0],
  "channels.remove": (args, value) => value?.id ?? args?.[0],
  "channels.bind": (args, value) => value?.label ?? args?.[0],
  "channels.policy": (args, value) => value?.label ?? args?.[0],
  "channels.pause": (args, value) => value?.label ?? args?.[0],
  "channels.resume": (args, value) => value?.label ?? args?.[0],
  "channels.pair.approve": (args, value) => value?.connectionId ?? args?.[1] ?? "pair",
  "channels.pair.deny": (args, value) => value?.connectionId ?? args?.[1] ?? "pair",
};
/** The service's own calls that only read, wait or talk in a chat: no line. Every call is in this list, in CHANGES or in LOGS_ITSELF. */
export const READS = ["interactions.list", "skills.review", "chat.scriptCommand", "skillsCatalog.search", "skillsCatalog.preview", "skillsCatalog.featured", "market.catalog", "market.skillImage", "market.skillPreview", "market.packPreview", "market.templatePreview", "mcpCatalog.list", "piPackages.browse", "piPackages.preview", "piPackages.list", "status", "logs.read", "doctor", "events.wait", "pair.status", "devices.list", "bots.list", "bots.get", "providers.list", "providers.services", "providers.login.read", "providers.login.input", "providers.login.cancel", "models", "chat.open", "chat.list", "chat.send", "chat.read", "chat.stop", "runs.list", "routines.list", "plugins.list", "plugins.marketplaces", "plugins.refresh", "plugins.browse", "plugins.preview", "config.get", "config.describe", "relay.status", "update.status", "update.check", "methods", "plugins.get", "tools.list", "tools.get", "tools.import.preview", "tools.signIn.read", "tools.signIn.input", "tools.signIn.cancel", "skills.list", "skills.get", "bots.tools", "bots.access", "bots.menu", "folders.list", "gadgets.get", "profile.status", "profile.home"];
// The reads of the rest of the workspace, one line for each area (each area's builder writes only its own line).
export const MORE_READS = {
  bots: ["bots.flags", "bots.proactive", "bots.memory", "bots.sections", "bots.sections.get", "bots.importable", "bots.import.preview", "templates.list", "templates.get", "templates.import.preview", "templates.browse", "templates.market"],
  chats: ["chats.list", "chats.get", "chats.search", "chats.queue", "chats.helpers", "chats.mentions", "chats.aside", "chats.sections", "chats.projectLook", "chats.messages"], // (`chats.aside` asks the chat's model a question that the chat does not keep.)
  routines: ["routines.get", "routines.runs", "routines.review", "routines.when", "routines.schedules", "workflows.list", "workflows.export"],
  projects: ["projects.list", "projects.get", "projects.artifacts", "projects.changes", "projects.diff", "jobs.list", "jobs.setup", "jobs.status", "todos.list", "todos.get", "tasks.list", "tasks.get", "artifacts.list", "artifacts.read", "artifacts.resolve"],
  wiki: ["wiki.tree", "wiki.find", "wiki.page", "wiki.search", "wiki.history", "wiki.version", "wiki.exportPlan"],
  prefs: ["preferences.get", "preferences.harnesses", "usage.report", "usage.export", "cache.info", "macTools.status"],
  credentials: ["credentials.list", "credentials.grants", "credentials.audit", "credentials.vault", "credentials.managers", "protonPass.installPlan", "protonPass.signInRead", "providers.usage", "providers.installPlan", "providers.install.read", "providers.install.input", "providers.install.cancel"],
  voice: ["voice.get", "voice.options"], // (`voice.options` can make the service ask a provider for its lists, with the saved key, at the address that the app saved: the call cannot choose it.)
  // (Spaces and panels)
  spaces: ["space.list", "space.get", "panel.list", "panel.get", "panel.routine.review", "card.list", "card.get"],
  // (Sharing a space)
  sharing: ["sharing.list", "sharing.get", "sharing.preview", "sharing.getLinks"], // (`sharing.preview` changes nothing: it says who a change would add.)
  // (The team)
  team: ["team.get", "team.roles", "team.role", "team.groups", "team.invites", "team.requests", "team.members", "team.chatPeople", "team.look"],
  // (Marketplace › Apps: the person's Composio apps, control-apps.mjs)
  apps: ["apps.list", "apps.connected", "apps.accounts", "apps.card"], // (`apps.card` looks at a chat's Connect card again; when the app is connected, the chat goes on as it would for the window.)
  // (Node host, control-node.mjs)
  node: ["node.status", "node.approvals", "node.audit", "node.convert.inspect", "node.convert.plan", "node.convert.status", "node.remote.status"],
  // (Connected computers & unified view, control-hosts.mjs)
  hosts: ["hosts.status"],
  // (Channel Hooks, control-channels.mjs)
  channels: ["channels.list", "channels.pair.list", "channels.test", "channels.logs"],
};
READS.push(...Object.values(MORE_READS).flat());

/**
 * The calls of a tool's sign-in. They are in neither list above: the dispatcher writes no line for them, not when they start,
 * not when an address is turned away, not for a cancel and not for a time-out. The sign-in writes its own line once, when it
 * is done (`startToolSignIn` in control-tools.mjs): "Changed from the command line: tools.signIn <name> (signed in)", or
 * "(signed in again)" when it replaces one. The name is the service's own record of the tool, never a word the caller typed
 * (so a code in the place of a name is nowhere in the log), and the page, the pasted address and its code are never there.
 */
export const LOGS_ITSELF = ["tools.signIn", "tools.signIn.answer", "tools.signIn.end", "plugins.signIn", "plugins.signIn.answer", "plugins.signIn.end",
  "protonPass.signInStart", "protonPass.signInInput", "protonPass.signInCancel"];

/** A few names for one line of the log: the first ones, then how many more. */
const some = (names) => (Array.isArray(names) && names.length ? names.slice(0, 4).join(", ").slice(0, 60) + (names.length > 4 ? " and " + (names.length - 4) + " more" : "") : null);

/** A short name that is safe to write in a log: an id or a name, one line, no more than 80 characters. Anything else is left out. It uses the short list (shown-text.mjs): a bot named with a flag or a family emoji is still in its line, and a name with a control character or a mark that turns text around is not. */
export const thingForLog = (value) => (typeof value === "string" && value.length >= 1 && value.length <= 80 && !hasUnplain(value) ? value : null);
/** The preference switches that give bots more room, and the new value as one of a few fixed words (null for any other value). */
const onOff = (value) => (typeof value === "boolean" ? (value ? "on" : "off") : null);
const FIXED_WORDS = {
  approval: (value) => (["ask", "read", "assisted", "all"].includes(value) ? value : null),
  "access.allBots": onOff,
  teamwork: onOff,
  // A login item on this computer: the person sees afterwards that a bot made Botkins start at login.
  "background.runAtStartup": onOff,
  // An unattended bot that reads the person's sources: the log says when it was turned on.
  "proactive.enabled": onOff,
};
const fixedWord = (key, value) => {
  const word = typeof key === "string" && Object.hasOwn(FIXED_WORDS, key) ? FIXED_WORDS[key](value) : null;
  return word ? key + " to " + word : null;
};
/** A space's name with the level it was given, for one line: `Launch (link)`. A name that cannot be in a line leaves the level alone. */
const levelOf = (name, level) => (level ? (thingForLog(name) && name.length <= 80 - level.length - 3 ? name + " (" + level + ")" : "(" + level + ")") : thingForLog(name) ? name : null);
/** A routine's name with how often it runs, for a routine that runs often: `Check (each 5 minutes)`. */
const withRate = (name, minutes) => {
  const rate = "(each " + (minutes === 1 ? "minute" : minutes + " minutes") + ")";
  return thingForLog(name) && name.length <= 80 - rate.length - 1 ? name + " " + rate : rate;
};
