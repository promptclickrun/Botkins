const { contextBridge, ipcRenderer, webUtils } = require("electron");
// This script also runs inside each custom view's frame (nodeIntegrationInSubFrames, desktop/main.mjs):
// a page a bot wrote, in a world of its own that the page cannot reach. There it does one thing.
// It tells the app when the person touched, clicked or pressed a key in that view, so that the
// app can let the view save its state only then. An event the page made itself is not trusted,
// and is not told. The frame gets no bridge: see the last lines of this file.
if (process.isMainFrame === false) {
  let told = 0;
  const tell = (event) => {
    if (!event.isTrusted) return;
    // A held key or a fast hand says it a few times a second, not hundreds.
    const now = Date.now();
    if (now - told < 250) return;
    told = now;
    ipcRenderer.send("frame-gesture");
  };
  window.addEventListener("pointerdown", tell, true);
  window.addEventListener("keydown", tell, true);
  // Trusted panel shortcuts (Cmd/Ctrl+Shift+F, Escape) observed in the frame's isolated world for
  // input paths that bypass WebContents `before-input-event` (such as CDP keyboard dispatch).
  // Untrusted events made by the page itself are ignored, and main deduplicates against before-input-event.
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || event.repeat || event.isComposing) return;
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        ipcRenderer.send("frame-panel-key", "escape");
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        ipcRenderer.send("frame-panel-key", "toggle");
      }
    },
    true,
  );
  // A second layer under the guard a view's page starts with (desktop/view-guard.mjs). The ways
  // to open a peer-to-peer connection are taken away in the page's own world from here, before
  // any of its code runs and where it cannot reach to stop it. This also holds in a frame the
  // page makes from markup of its own. It does not run for the empty document that a
  // "javascript:" address runs in, which is why the guard keeps every nested frame out as well.
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate", "RTCRtpSender", "RTCRtpReceiver", "WebTransport"]) {
          try {
            Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false });
          } catch {
            // Already taken away by the page's guard.
          }
        }
      },
    });
  } catch {
    // An Electron without this call: the guard in the page still stands.
  }
}
const api = {};
for (const name of [
  "snapshot",
  "pickPluginFolder",
  "plugins.marketplaces",
  "plugins.addMarketplace",
  "plugins.removeMarketplace",
  "plugins.browse",
  "plugins.preview",
  "plugins.install",
  "plugins.addFolder",
  "plugins.configure",
  "plugins.setBots",
  "plugins.setEnabled",
  "plugins.update",
  "plugins.uninstall",
  "plugins.refresh",
  // Agent templates in the marketplaces ("agent-templates-v1"), and Marketplace › Apps (Composio)
  "pickSkillUpload",
  "skills.upload",
  "skills.saveScript",
  "skills.readScript",
  "skillsCatalog.search",
  "skillsCatalog.preview",
  "skillsCatalog.install",
  "skillsCatalog.featured",
  "market.catalog",
  "market.skillImage",
  "market.skillPreview",
  "market.skillInstall",
  "market.packPreview",
  "market.packInstall",
  "market.templatePreview",
  "market.templateInstall",
  "mcpCatalog.list",
  "mcpCatalog.add",
  "piPackages.browse",
  "piPackages.preview",
  "piPackages.list",
  "piPackages.install",
  "piPackages.setEnabled",
  "piPackages.remove",
  "agents.browse",
  "agents.template",
  "composio.catalog",
  "composio.connected",
  "composio.accounts",
  "composio.connect",
  "composio.removeAccount",
  "composio.cardOpen",
  "composio.cardCheck",
  "mcpApps.view",
  "mcpApps.callTool",
  "mcpApps.readResource",
  // Spaces ("spaces-v1"): the app's calls, then the link's.
  "spaces.read",
  "spaces.create",
  "spaces.rename",
  "spaces.remove",
  "spaces.setProject",
  "spaces.setPanelProject",
  "spaces.newPanel",
  "spaces.ask",
  "spaces.movePanel",
  "spaces.patchState",
  "spaces.note",
  "spaces.removeNote",
  "link.spaces.share",
  "link.spaces.newLink",
  "link.spaces.arrange",
  "link.spaces.seen",
  "link.spaces.notify",
  "link.spaces.here",
  "link.team.setLinkSharing",
  // Admin mode ("link.team.setAdminMode"): this computer keeps its own window's choice.
  "link.team.setAdminMode",
  // Sections on the Chats page ("chat-sections-v1"): the link's calls, made as the owner here.
  "link.chats.addSection",
  "link.chats.renameSection",
  "link.chats.deleteSection",
  "link.chats.orderSections",
  "link.chats.setSection",
  "link.chat.typing",
  "artifacts.list",
  "artifacts.read",
  "artifacts.resolve",
  "artifacts.thumbnail",
  "inspectChatPaths",
  "openChatPath",
  "previewChatPath",
  "artifactMessagePage",
  "thumbnailChatPath",
  "artifactMedia",
  "closeArtifactMedia",
  "models",
  "setModel",
  "setPreferences",
  "sideQuestion",
  "respond",
  "clearApprovals",
  "copyReply",
  "addBot",
  "importableAgents",
  "importAgents",
  "frameAnswer",
  "frameOpenLink",
  "wikiTree",
  "wikiPage",
  "saveWikiPage",
  "createWikiPage",
  "createWikiPageFor",
  "createWikiFolder",
  "moveWiki",
  "deleteWiki",
  "searchWiki",
  "wikiHistory",
  "wikiVersion",
  "restoreWikiVersion",
  "revealWiki",
  "wikiExportPlan",
  "wikiExportPages",
  "exportWiki",
  "revealWikiExport",
  "updateBot",
  "setBotProactive",
  "proactiveAct",
  "setBotFlags",
  "makePrimary",
  "reorderBots",
  "duplicateBot",
  "deleteBot",
  "saveTemplate",
  "renameTemplate",
  "deleteTemplate",
  "exportTemplate",
  "importTemplate",
  "addSection",
  "renameSection",
  "deleteSection",
  "orderSections",
  "setChatFlags",
  "markChatsRead",
  "renameChat",
  "regenerateChatTitle",
  "deleteChat",
  "boardAct",
  "openApp",
  "takePrefill",
  "linkPreview",
  "saveTask",
  "moveTask",
  "startTask",
  "deleteTask",
  "addProject",
  "renameProject",
  "removeProject",
  "setChatProject",
  "projectChanges",
  "projectDiff",
  "projectCommit",
  "revealProject",
  "createProject",
  "updateProject",
  "editProjectFolder",
  "setChatFolder",
  "chatProjectFolder",
  "cloneProjectRepository",
  "chooseProjectFolder",
  "startProjectChat",
  "projectJobSetup",
  "approveJobSetup",
  "startProjectJob",
  "projectJobStatus",
  "bringInJob",
  "catchUpJob",
  "removeJobWorktree",
  "startJobTurn",
  "addProjectArtifact",
  "removeProjectArtifact",
  "projectArtifacts",
  "addTodo",
  "updateTodo",
  "deleteTodo",
  "moveTodo",
  "setBotAccess",
  "openLink",
  "saveMcpServer",
  "setMcpServerEnabled",
  "removeMcpServer",
  "testMcpServer",
  "signInMcpServer",
  "cancelMcpSignIn",
  "signOutMcpServer",
  "credentials",
  "removeCredential",
  "resetVault",
  "savedCredentials",
  "saveSavedCredential",
  "removeSavedCredential",
  "checkSavedCredential",
  "passwordManagers",
  "protonPassInstallPlan",
  "protonPassInstall",
  "protonPassSignInStart",
  "protonPassSignInRead",
  "protonPassSignInInput",
  "protonPassSignInCancel",
  "protonPassDisconnect",
  "unlockPasswordManager",
  "lockPasswordManager",
  "passwordManagerVaults",
  "passwordManagerItems",
  "passwordManagerItem",
  "linkPasswordManagerField",
  "copyPasswordManagerField",
  "credentialGrants",
  "setCredentialGrant",
  "revokeCredentialGrant",
  "credentialAudit",
  "importMcpServers",
  "importMcpServerFile",
  "skills",
  "readSkill",
  "saveSkill",
  "removeSkill",
  "setSkillEnabled",
  "addSkillFolder",
  "removeSkillFolder",
  "revealSkill",
  "setBotIntegrations",
  "botMemory",
  "setBotMemory",
  "mentionables",
  "link.pullRequests",
  "link.pullRequest",
  "link.pullRequestDiff",
  "catalog",
  "routine",
  "createRoutine",
  "updateRoutine",
  "setRoutineEnabled",
  "deleteRoutine",
  "runRoutine",
  "duplicateRoutine",
  "previewCadence",
  "changeSchedule",
  "workflowsList",
  "workflowCreate",
  "workflowUpdate",
  "workflowDelete",
  "workflowPause",
  "workflowResume",
  "workflowRun",
  "workflowRetryRun",
  "workflowRespondApproval",
  "workflowCancelRun",
  "workflowRotateWebhookSecret",
  "workflowGithubStatus",
  "workflowGithubSignInStart",
  "workflowGithubSignInCancel",
  "workflowGithubCatalog",
  "workflowGithubDeliveries",
  "workflowGithubReplayLast",
  "githubAgentStatus",
  "githubAgentInstallUrl",
  "githubAgentRefresh",
  "githubAgentSetRepo",
  "githubAgentUnbind",
  "workflowExport",
  "workflowImport",
  "workflowExportText",
  "workflowImportText",
  "channelsList",
  "channelAdd",
  "channelUpdate",
  "channelRemove",
  "channelBind",
  "channelSetPolicy",
  "channelPause",
  "channelResume",
  "channelPairList",
  "channelPairApprove",
  "channelPairDeny",
  "channelTest",
  "channelLogs",
  "testNotification",
  "viewing",
  "usage",
  "providerUsage",
  "sidePane",
  "remoteScreen",
  "exportTemplateText",
  "importTemplateText",
  "exportUsageText",
  "exportWikiFile",
  "listFolders",
  "addProjectFolder",
  "addSkillFolderAt",
  "remoteHosts",
  "pairRemoteHost",
  "findTeamInvite",
  "startTeamJoin",
  "checkTeamJoin",
  "teamJoins",
  "cancelTeamJoin",
  "takeTeamJoin",
  "team",
  "saveTeamRole",
  "deleteTeamRole",
  "saveTeamGroup",
  "deleteTeamGroup",
  "createTeamInvite",
  "chatPeople",
  "inviteToChat",
  "removeFromChat",
  "revokeTeamInvite",
  "approveTeamRequest",
  "denyTeamRequest",
  "moveTeamMember",
  "removeTeamMember",
  "renameTeam",
  "renameTeamMember",
  "setMyAvatar",
  "useRemoteHost",
  "setUnifiedHosts",
  "setUnifiedHostIncluded",
  "setSettingsHost",
  "forgetRemoteHost",
  "renameRemoteHost",
  // Hosted profile identity and its public directory. Tokens/verifiers never reach this bridge.
  "profileStatus",
  "profileStart",
  "profileOpen",
  "profileFinish",
  "profileRefresh",
  "profileHome",
  "profileUpdate",
  "profileDisconnect",
  "profileReconnect",
  "profileDeleteAccount",
  "profileOptOut",
  "profileSignOut",
  "profileApprove",
  "profileRevoke",
  "profileConnect",
  "profileMarkMigrationPrompted",
  "exportUsage",
  "refreshPanel",
  "changePanel",
  "clearCache",
  "cacheInfo",
  "workspaceStats",
  "workspacePrune",
  "mainChat",
  "changeMainFork",
  "setProactiveChatMode",
  "createChat",
  "createGroupChat",
  "send",
  "stop",
  "stopHelper",
  "stepDetail",
  "warmChat",
  "recordVoiceLine",
  "chooseFiles",
  "unqueue",
  "sendNow",
  "reactToMessage",
  "chat.cardAction",
  "chat.a2uiAction",
  "chat.a2uiFunction",
  "showEmojiPanel",
  "forkChat",
  "retry",
  "compact",
  "copyText",
  "auth",
  "signIn",
  "cancelSignIn",
  "signOut",
  "providers",
  "harnesses",
  "setProviderEnabled",
  "providerConfigure",
  "providerServices",
  "connectProviderService",
  "finishProviderService",
  "cancelProviderService",
  "disconnectProviderService",
  // Signing a provider in and installing its tool without a browser here ("provider-signin-v1";
  // a phone uses these, and the app can too).
  "providerSignInStart",
  "providerSignInRead",
  "providerSignInInput",
  "providerSignInCancel",
  "providerUseToken",
  "installProvider",
  "appInfo",
  "sendFeedback",
  "appUpdateStatus",
  "checkAppUpdate",
  "installAppUpdate",
  "setAppUpdateAuto",
  "openAppRelease",
  "phoneLink",
  "setPhoneLink",
  "startPhonePairing",
  "cancelPhonePairing",
  "removePhone",
  "renamePhone",
  "setPhonePerson",
  "renamePhoneLinkComputer",
  "configureGadget",
  "gadgetWifi",
  "restartGadget",
  "setPhoneScreen",
  "setPhoneRelay",
  "resetPhoneRelay",
  "requestScreenPermission",
  "allowLocalNetwork",
  "nodeStatus",
  "nodeSetup",
  "nodeRename",
  "nodePause",
  "nodeSetWholeComputer",
  "nodeSetExecMode",
  "nodeAddAllowlistRule",
  "nodeRemoveAllowlistRule",
  "nodeAuditLog",
  "nodeShareProject",
  "nodeRevokeGrant",
  "nodeDisconnect",
  "nodeConvertInspect",
  "nodeConvertPlan",
  "nodeConvertRun",
  "nodeConvertStatus",
  "nodeConvertUndo",
  "nodeRemoteStatus",
  "nodeRemoteControl",
  "macToolsStatus",
  "setMacTool",
  "grantMacTool",
  "computerUseStatus",
  "requestComputerUsePermission",
  "voiceSettings",
  "setVoice",
  "setVoiceKey",
  "voiceOptions",
  "transcribe",
  "speak",
  "startDictation",
  "startLiveVoice",
  "liveVoiceTranscript",
  "liveVoiceTool",
  "endLiveVoice",
  "claudeArtifacts.status",
  "claudeArtifacts.setModel",
  "claudeArtifacts.setBotApproval",
  "claudeArtifacts.revokeBotApproval",
])
  api[name] = (...args) => ipcRenderer.invoke(name, ...args);
// A dropped or pasted File's path on disk, or "" for in-memory data.
api.pathForFile = (file) => {
  try {
    return webUtils.getPathForFile(file) || "";
  } catch {
    return "";
  }
};
api.subscribe = (fn) => {
  const listener = (_, state) => fn(state);
  ipcRenderer.on("changed", listener);
  return () => ipcRenderer.removeListener("changed", listener);
};
// The small updates while a bot streams (desktop/window-push.mjs).
api.subscribeHot = (fn) => {
  const listener = (_, message) => fn(message);
  ipcRenderer.on("changed-hot", listener);
  return () => ipcRenderer.removeListener("changed-hot", listener);
};
// A notification click asks the renderer to open its chat.
api.onOpenChat = (fn) => {
  const listener = (_, chatId) => fn(chatId);
  ipcRenderer.on("open-chat", listener);
  return () => ipcRenderer.removeListener("open-chat", listener);
};
api.onOpenSettings = (fn) => {
  const listener = (_, tab) => fn(tab);
  ipcRenderer.on("open-settings", listener);
  return () => ipcRenderer.removeListener("open-settings", listener);
};
api.onTeamJoin = (fn) => {
  const listener = (_, url) => fn(url);
  ipcRenderer.on("open-team-join", listener);
  return () => ipcRenderer.removeListener("open-team-join", listener);
};
// An HTML app's answer, placed in its chat's message box. Nothing is sent until the person sends it.
api.onPrefill = (fn) => {
  const listener = (_, data) => fn(data);
  ipcRenderer.on("prefill", listener);
  return () => ipcRenderer.removeListener("prefill", listener);
};
// A provider's plan limits were read again behind an earlier answer: the page asks for them again.
api.onProviderUsage = (fn) => {
  const listener = () => fn();
  ipcRenderer.on("provider-usage", listener);
  return () => ipcRenderer.removeListener("provider-usage", listener);
};
// A live voice session that runs in the main process (Codex) tells the page what was said, and when it ended.
api.onLiveVoice = (fn) => {
  const listener = (_, event) => fn(event);
  ipcRenderer.on("live-voice", listener);
  return () => ipcRenderer.removeListener("live-voice", listener);
};
// The person touched, clicked or pressed a key inside a custom view: { frame } is that view's id.
// The main process says so only for real input in that frame (desktop/main.mjs, "frame-gesture").
api.onFrameGesture = (fn) => {
  const listener = (_, gesture) => fn(gesture);
  ipcRenderer.on("frame-gesture", listener);
  return () => ipcRenderer.removeListener("frame-gesture", listener);
};
// A real key press caught by the main process while focus is inside a panel iframe.
api.onPanelKey = (fn) => {
  const listener = (_, data) => fn(data);
  ipcRenderer.on("panel-key", listener);
  return () => ipcRenderer.removeListener("panel-key", listener);
};
api.setPanelOpen = (frameIds) =>
  ipcRenderer.send(
    "panel-open",
    Array.isArray(frameIds) ? frameIds.filter((id) => typeof id === "string") : [],
  );
// The window uses the Botkins bridge.
// Only the window's own page gets it. This script runs in the frames of custom views too (see the
// top of this file), and a page a bot wrote must never hold the app's bridge.
if (process.isMainFrame === true) {
  contextBridge.exposeInMainWorld("botkins", api);
}
