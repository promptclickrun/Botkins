// The workspace as one running thing: the model providers, the workspace itself, the calls the
// app's window and a paired phone make (`handlers`), and the phone link. Nothing here knows what
// program it runs in. Whatever needs a window, a dialog, the keychain or the screen is asked of
// `host` (desktop/host/index.mjs): Electron's in the desktop app (desktop/main.mjs builds it), a
// headless one in the terminal host (`botkins serve`). A host without something says so with
// `unavailable`, and the call fails with that sentence instead of a crash.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { Providers } from "./providers/index.mjs";
import { CopilotProvider } from "./providers/copilot/index.mjs";
import { CodexProvider } from "./providers/codex/index.mjs";
import { ClaudeProvider } from "./providers/claude/index.mjs";
import { OpenCodeProvider } from "./providers/opencode/index.mjs";
import { AcpProvider } from "./providers/acp/index.mjs";
import { PiProvider } from "./providers/pi/index.mjs";
import { ACP_AGENTS } from "./providers/acp/agents.mjs";
import { ToolBridge } from "./providers/toolbridge.mjs";
import { tickChatSchedules } from "./schedules.mjs";
import { Notifier } from "./notify.mjs";
import { usageCsv, usageReport } from "./usage.mjs";
import { PROVIDER_USAGE, ProviderUsage } from "./providerusage.mjs";
import { ARTIFACTS, SIDE_PANE } from "./sidepane.mjs";
import { PROJECT_ARTIFACTS, PROJECT_ARTIFACT_CALLS } from "./projects.mjs";
import { REMOTE_METHODS } from "./link/methods.mjs";
import { chunk, fileDetails, openChatPath, publicFile, thumbnail } from "./artifact-files.mjs";
import { REMOTE_HOSTS } from "./remotehosts.mjs";
import { FILES, usageFile, wikiExportName, wikiFile } from "./phonefiles.mjs";
import { FOLDERS, Folders } from "./folders.mjs";
import { deviceCall } from "./device-call.mjs";
import { PLUGINS, PLUGIN_STARTS, pluginHandlers } from "./plugins.mjs";
import { AGENT_TEMPLATES } from "./plugin-catalog.mjs";
import { COMPOSIO_APPS, composioHandlers } from "./composio.mjs";
import { performSecureUse } from "./secure-input.mjs";
import { releasePage } from "./updates.mjs";
import { Workspace } from "./workspace.mjs";
import { liveContextFor } from "./live-context.mjs";
import { PHONE_PATIENCE_MS, SignIns } from "./terminal/signin.mjs";
import { validateAttachments } from "./canvas.mjs";
import { wikiPath } from "./wiki.mjs";
import { zip } from "./zip.mjs";
import { LinkPreviews } from "./linkpreview.mjs";
// Phone access: the Botkins link, copied unchanged from the Botkins repo (desktop/link/README.md).
import { LinkHost, PROTOCOL, qrPath } from "./link/index.mjs";
import { DEFAULT_RELAY_URL } from "./link/relay.mjs";
import { env } from "./home.mjs";
import { phonePage } from "./phonepage.mjs";
import { LOOKS_CAPABILITY } from "./looks.mjs";
import { ROUTINE_DELIVERY, ROUTINE_OWNER } from "./routines.mjs";
import { SPACES } from "./spaces.mjs";
import { HeldCut, teamFromCut } from "./headless/team-cut.mjs";
import { spaceEventQueue } from "./headless/space-events.mjs";
import { BOARD_MENTIONS } from "./mentions.mjs";
import { computerName, nearby } from "./nearby.mjs";
// Voice in the app's window (Settings › Voice, dictation, reading aloud, Live Voice): desktop/voicedesk.mjs.
import { VoiceDesk } from "./voicedesk.mjs";
import { CodexVoice } from "./codexvoice.mjs";
// Settings › Credentials: the link's saved credentials and password managers, for the app's window.
import { SavedCredentials, trialToolDirs } from "./savedcredentials.mjs";
import { forgetChatPeople, teamHandlers } from "./team-ipc.mjs";
import { chatSectionHandlers, withOwnerChatSections } from "./chat-sections-ipc.mjs";

/**
 * How a trial run's Copilot runtime signs in to GitHub without the keychain: with the token in
 * BOTKINS_COPILOT_TOKEN, else the one the GitHub CLI hands out (`gh auth token`, which reads only
 * the GitHub CLI's own entry, as the GitHub CLI), else not at all.
 */
export function trialGitHub() {
  let token = env("COPILOT_TOKEN");
  if (!token) {
    for (const gh of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
      try {
        token = execFileSync(gh, ["auth", "token"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (token) break;
      } catch {
        // Not installed there, or not signed in.
      }
    }
  }
  return token ? { token } : { useLoggedInUser: false };
}
/** The host a request goes to, or "" for an address that isn't one. */
const hostOf = (url) => {
  try {
    return new URL(String(url?.url ?? url)).hostname;
  } catch {
    return "";
  }
};
// What this app supports that a phone has to ask about by name (the link adds them to its own):
// model details in the catalog, a Botkin's eyes and own colors, where a routine's result goes and
// whether it notifies, and a Today item carried by a message.
/** How long a restart for an update waits after the call that asked for it was answered. */
const REPLY_MS = 1500;
/** A paired phone can read how up to date this computer is, look for a release and start its install. */
export const APP_UPDATE = "app-update-v1";
/** A model provider signed in, and its tool installed, from a phone, with no browser here (desktop/terminal/signin.mjs). */
export const PROVIDER_SIGNIN = "provider-signin-v1";
/** A bot may have a voice of its own (`bot.voice`): reading aloud and live voice, over Settings › Voice. */
export const BOT_VOICE = "bot-voice-v1";
export const CAPABILITIES = ["voice-history-v1", "quiet-replies-v1", "models-v2", LOOKS_CAPABILITY, BOT_VOICE, ROUTINE_DELIVERY, "routine-no-output-v1", ROUTINE_OWNER, BOARD_MENTIONS, PROVIDER_USAGE, SIDE_PANE, REMOTE_HOSTS, FILES, FOLDERS, ARTIFACTS, PROJECT_ARTIFACTS, "secure-input-v1", "turn-timeline-v1", PLUGINS, PLUGIN_STARTS, PROVIDER_SIGNIN, SPACES, AGENT_TEMPLATES, COMPOSIO_APPS];
/**
 * What a paired device is told this app supports. A feature whose calls the link does not carry
 * (desktop/link/methods.mjs) is left out, so a device never asks for what it cannot reach.
 */
export const linkCapabilities = (methods = REMOTE_METHODS) =>
  CAPABILITIES.filter((name) => (name !== "voice-history-v1" || methods.has("recordVoiceLine")) && (name !== PROJECT_ARTIFACTS || PROJECT_ARTIFACT_CALLS.every((call) => methods.has(call))) && (name !== SPACES || SPACE_CALLS.every((call) => methods.has(call))));
/** The calls of spaces (docs/spaces.md). The capability is named to a device only when the link carries them all. */
export const SPACE_CALLS = ["read", "create", "rename", "remove", "setProject", "setPanelProject", "newPanel", "ask", "movePanel", "patchState", "note", "removeNote"].map((name) => "spaces." + name);

/**
 * Builds the workspace, its calls and the phone link on `host`.
 * @param options.host     What this program can do (desktop/host/index.mjs).
 * @param options.dataDir  Where the workspace keeps its files (<data folder>/data in the desktop app).
 * @param options.trial    A run on a folder of its own (the tests, a development copy): it never
 *   asks the keychain, browses a folder of its own, sends no notifications through the relay and
 *   stays quiet on the local network, unless an environment variable asks for one of those.
 * @param options.pushed   Called when the app's own view of things is out of date (the desktop
 *   app tells its window). Calls may come in bursts: the listener coalesces them.
 * @param options.link     For a host that sets the link up itself: { port?, extraHosts?, announce? }.
 * @param options.copilot  { github? }: () → { token } | undefined, for a host that keeps the
 *   GitHub sign-in of the Copilot runtime itself (the terminal host, for a pasted token).
 * @returns What the program around it uses: `handlers`, `workspace`, `providers`, `link`, `phone`,
 *   `listening` (settles when the link's first start is over), and `begin()` / `stop()`.
 */
/**
 * Whether this process is the workspace container of the two-container host: Linux, with the
 * socket that the link's container reaches it through. Only then is the team a cut that the link
 * tells (desktop/headless/team-cut.mjs). Everywhere else (the desktop app, `botkins serve`) the
 * link is in this process and is asked itself.
 */
export const isSplitHost = (platform = process.platform, env = process.env) => platform === "linux" && !!env.BOTKINS_WORKSPACE_SOCKET;

export async function createRuntime({ host, dataDir, trial = false, pushed = () => {}, link: linkOptions = {}, copilot: copilotOptions = {} }) {
  // The two-container host: this process is the workspace, and the public link is another container.
  const splitHost = isSplitHost();
  let workspace,
    // Signing a provider in without a browser here, and installing its tool: from a phone, or the
    // terminal host's command line (desktop/terminal/signin.mjs). A token pasted there is kept in the vault.
    signIns,
    // The model providers (desktop/providers). To add one, construct it here and list it below.
    providers,
    providerUsage,
    // The folders a window without the system's chooser may browse and pick (desktop/folders.mjs).
    folders,
    // Botkins' tools as a local MCP server, for the providers built on command-line tools.
    bridge,
    // Phone access (desktop/link): one LinkHost, made once the handlers exist.
    link,
    timer;
  let stopAnnouncing = () => {};
  let nearbyState = () => "off";
  let retryAnnouncing = () => {};
  // Who wants to hear that the workspace changed, besides the app's own view: the phone link, which
  // also needs it while the window is closed to the tray.
  const changeListeners = new Set();
  // Goes up when a phone pairs, goes away or connects, so Settings › Phone asks phoneLink() again.
  let phoneRevision = 0;
  // Frames of html blocks: when each last sent an answer, and whether a link question is open.
  const frameAnswers = new Map();
  const frameQuiet = new Map();
  let askingLink = false;
  let lastExport = null;
  const linkPreviews = new LinkPreviews();
  const push = () => pushed();
  function notify() {
    // Every time: the link coalesces by itself.
    for (const listener of changeListeners) listener();
    push();
  }
  /**
   * Saves a wiki export where the person chooses. Returns the saved file's path, or null when they cancel.
   *   { format: "zip", paths, title, everything? }   Markdown files in a .zip
   *   { format: "html" | "pdf", html, title }        one document the app's page laid out
   */
  async function exportWiki({ format, paths, title, everything, html }) {
    const name = wikiExportName(title);
    const kinds = { zip: ["Zip archive", "zip"], html: ["Web page", "html"], pdf: ["PDF", "pdf"] };
    if (!kinds[format]) throw new Error("Choose a format to export.");
    let data;
    if (format === "zip") data = zip(workspace.wiki.exportFiles({ paths, title, everything }).map((file) => ({ ...file, path: name + "/" + file.path })));
    else {
      if (typeof html !== "string" || !html.trim() || html.length > 40_000_000) throw new Error("There is nothing to export.");
      data = format === "html" ? Buffer.from(html, "utf8") : await host.pdf(html);
    }
    const filePath = await host.dialogs.save({
      title: "Export wiki",
      defaultPath: join(host.paths.documents(), name + "." + kinds[format][1]),
      filters: [{ name: kinds[format][0], extensions: [kinds[format][1]] }],
    });
    if (!filePath) return null;
    await writeFile(filePath, data);
    recordExport(filePath);
    lastExport = filePath;
    return filePath;
  }

  function recordExport(path, owner) {
    const chat = workspace.state.chats.find((item) => item.id === host.window.viewing());
    const botId = owner || chat?.botId || workspace.state.bots[0]?.id;
    if (botId) workspace.artifacts.record(path, { botId, ...(chat?.botId === botId && { chatId: chat.id }), source: "export" });
    workspace.notify();
  }
  // A trial run (a data folder of its own: the tests, a development copy) never reads or writes
  // anything of the person's in the system keychain, so it can never put a keychain question on
  // their screen. Two things would: the Copilot sign-in, and the key that guards the vault and
  // the phone link. A deliberate check can ask for either: BOTKINS_COPILOT_SIGNIN=keychain, and
  // BOTKINS_KEYCHAIN=1 (a packaged build only, on a copy of real data).
  const copilot = new CopilotProvider({
    // Botkins keeps its own Copilot state, so sessions open without loading everything in ~/.copilot.
    baseDirectory: join(dataDir, "copilot"),
    // The person's Copilot sign-in is in the keychain. A trial run is given a token instead
    // (BOTKINS_COPILOT_TOKEN, else the GitHub CLI's), or runs signed out.
    // A Copilot token pasted on a phone or at the command line wins over that (signIns.copilotGitHub()).
    github: copilotOptions.github ?? (() => signIns?.copilotGitHub() ?? (trial && env("COPILOT_SIGNIN") !== "keychain" ? trialGitHub() : undefined)),
    userHome: process.env.COPILOT_HOME || join(homedir(), ".copilot"),
    workingDirectory: dataDir,
    // A chat's session stays open for half an hour after its last use, so follow-ups start at once
    // and sessions are rarely closed (see desktop/providers/copilot/index.mjs).
    keepWarmMs: 30 * 60 * 1000,
    maxWarm: 8,
  });
  // ChatGPT (through Codex), Claude (through Claude Code), OpenCode and the ACP agents run the tool
  // the person installed, with the sign-in that tool keeps. Each stores which conversation is whose in its
  // own folder. The first provider is the default for model choices saved without one.
  bridge = new ToolBridge({ version: host.version });
  const every = [
    copilot,
    new CodexProvider({ dataDir: join(dataDir, "codex"), bridge, version: host.version }),
    new ClaudeProvider({ dataDir: join(dataDir, "claude"), bridge }),
    new OpenCodeProvider({ dataDir: join(dataDir, "opencode"), bridge }),
    // Agents that speak the Agent Client Protocol (desktop/providers/acp). Off until the person adds one.
    ...ACP_AGENTS.map((agent) => new AcpProvider({ ...agent, dataDir: join(dataDir, agent.id), bridge, version: host.version })),
    // Pi, a harness for the ChatGPT and Claude plans (Settings › Harness), not a model provider.
    new PiProvider({ dataDir: join(dataDir, "pi"), bridge }),
  ];
  // BOTKINS_PROVIDERS=copilot,claude keeps only those (in that list's order here), for tests
  // that must not depend on which tools this computer happens to have.
  const only = (env("PROVIDERS") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const chosen = every.filter((provider) => only.includes(provider.id));
  providers = new Providers(chosen.length ? chosen : every);
  // Each connected provider's plan and what is left of its limits (desktop/providerusage.mjs).
  // The window hears when a read nobody waited for has come in, and asks again.
  providerUsage = new ProviderUsage({
    providers,
    file: join(dataDir, "provider-usage.json"),
    changed: () => host.window.send("provider-usage"),
  });
  // A trial run browses a folder of its own (BOTKINS_FOLDERS_HOME, or an empty one in its data
  // folder), so a test never reads the names of the person's folders.
  folders = trial ? new Folders({ home: env("FOLDERS_HOME") || join(dataDir, "folders-home"), volumes: [] }) : new Folders();
  if (trial && !env("FOLDERS_HOME")) mkdirSync(join(dataDir, "folders-home"), { recursive: true });
  // Credentials live in Botkins' vault (desktop/vault.mjs), and the vault's key is wrapped by
  // whatever the host guards secrets with: the system keychain in the installed desktop app, the
  // terminal host's key store on a server. A host with none (a development or trial run) answers
  // null, and the key is kept in a file in the run's own data folder.
  const keys = await host.keys({ dataDir, trial });
  const updates = host.updates();
  /** The update service, for a call that needs one. A copy that can't look for updates says so. */
  const updating = () => {
    if (!updates) throw new Error("This copy of Botkins doesn't look for updates.");
    return updates;
  };
  // On the two-container host the team is in the link's container, and this process is told a cut
  // of it through the socket (desktop/headless/team-cut.mjs). It is kept in memory only, and what
  // the workspace asks about the team is answered from it. Everywhere else the link is here.
  const heldTeam = splitHost ? new HeldCut() : null;
  const spaceEvents = splitHost ? spaceEventQueue() : null;
  const told = heldTeam && teamFromCut(heldTeam, (chatId) => workspace.state.chats.find((chat) => chat.id === chatId));
  workspace = new Workspace(dataDir, providers, notify, {
    updates,
    team: told ? told.team : () => link?.team(),
    // A chat's people and whether its alerts are the owner's: the link keeps invites (capability
    // "team-people-v1"). A link without them answers nothing, and a chat has its creator only.
    people: told ? told.people : (chatId) => link?.chatPeople?.(chatId),
    // What a person may do with a space: the link keeps who each one is shared with. A link from
    // before spaces answers nothing, and the app's own rules hold (desktop/spaces.mjs).
    spaceCan: told ? told.spaceCan : (space, person) => link?.spaceCan?.(space, person),
    // A person wrote a note or changed an app panel: the link picks who is told, and how often.
    // On the two-container host the link is in the other container: the event waits for its next look (headless/space-events.mjs).
    spaceEvent: spaceEvents ? spaceEvents.add : (event) => link?.spaceEvent?.(event),
    notifiesOwner: told ? told.notifiesOwner : (chatId) => link?.notifiesOwner?.(chatId),
    secureUse: (plan, values, { signal }) => performSecureUse(plan, values, { signal, fillPage: () => host.window.fillSecurePage(plan, values, signal) }),
    ...(keys && {
      vaultKey: keys,
      // Keys an earlier version encrypted into the workspace file are read once, to move them into the vault.
      secrets: { open: keys.unwrap },
    }),
    // An MCP server's sign-in opens in the person's browser and uses the system's network settings.
    openExternal: (url) => host.shell.openExternal(url),
    fetch: (url, init) => host.fetch(url, init),
    // For the one harness (desktop/harness): the tool server lists the runtime's tools to Claude Code.
    bridge,
    version: host.version,
    // iMessage and Mail tools need the desktop app on a Mac, where macOS can ask the person for
    // each permission. A host with no window says they aren't there, as any computer but a Mac does.
    ...(host.headless && { macTools: { platform: "headless" } }),
    // Tools a bot runs on a paired phone (desktop/phonetools.mjs). The link is made further down.
    phoneTools: () => (link ? { tools: () => link.deviceTools(), call: (name, args, options) => link.callDeviceTool(name, args, options) } : null),
  });
  // Conversations from builds that shared ~/.copilot keep their history.
  copilot.adoptSessions(workspace.sessionIds());
  host.theme.set(workspace.state.settings.appearance.theme);
  // Routines and notifications (desktop/routines.mjs, desktop/notify.mjs)
  const notifier = new Notifier(workspace, {
    Notification: host.notifications,
    focused: () => host.window.focused(),
    open: (chatId) => host.window.openChat(chatId),
    openSettings: (tab) => host.window.openSettings(tab),
  });
  // A sign-in page a provider asks for opens in the person's browser, and only a web page does.
  signIns = new SignIns({ providers: () => providers, vault: () => workspace.vault, changed: (id) => workspace.providerChanged(id) });
  // Tokens kept from an earlier start go where the tools read them.
  signIns.restore();
  const openSignIn = (url) => {
    if (new URL(url).protocol !== "https:") throw new Error("That sign-in page can't be opened.");
    return host.shell.openExternal(url);
  };
  const routines = workspace.panels.routines;
  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const savedCredentials = new SavedCredentials({ get: () => link?.credentials ?? null });
  // A folder a person adds for its skills. A plugin folder goes the plugins' way instead, which
  // copies it, shows what it starts and adds it switched off: a plugin has no other way in.
  const addFolderOrPlugin = async (path, options) => {
    try {
      return workspace.integrations.addFromFolder(path);
    } catch (error) {
      if (error?.code !== "PLUGIN_FOLDER" || options?.plugins === false) throw error;
      const added = await workspace.plugins.addFolder(error.folder);
      return { kind: "plugin", name: added.name, id: added.id, enabled: false };
    }
  };
  const handlers = {
    ...pluginHandlers(workspace.plugins, savedCredentials),
    // Agent templates in the marketplaces ("agent-templates-v1", docs/agent-templates.md in the phone's code): reads only.
    "agents.browse": (query) => workspace.plugins.catalog.agents(query),
    "agents.template": (id) => workspace.plugins.catalog.agentTemplate(id),
    // Marketplace › Apps: the person's Composio apps through this computer's Composio tool (desktop/composio.mjs).
    ...composioHandlers(workspace),
    ...teamHandlers(() => link),
    ...chatSectionHandlers(() => link),
    pickPluginFolder: async () => {
      const paths = await host.dialogs.open({ title: "Choose a plugin folder", properties: ["openDirectory"] });
      return paths ? paths[0] ?? null : null;
    },
    createRoutine: (data) => routines.create(data),
    updateRoutine: (id, data) => routines.update(id, data),
    setRoutineEnabled: (id, enabled) => routines.setEnabled(id, null, enabled),
    deleteRoutine: (id) => routines.remove(id),
    runRoutine: (id) => {
      routines
        .run(id)
        .catch((err) => console.error("Routine run:", err.message));
    },
    duplicateRoutine: (id, botId) => routines.duplicate(id, botId),
    previewCadence: (cadence, timezone) => routines.preview(cadence, timezone),
    changeSchedule: (chatId, id, action) =>
      action === "delete"
        ? routines.removeSchedule(chatId, id)
        : void routines.setEnabled(chatId, id, action === "resume"),
    testNotification: () => notifier.test(),
    usage: (days) => usageReport(workspace.state, { days, timeZone: zone() }),
    // What the person did with a chat's side pane: chose a tab, closed or pinned a panel, closed or opened the pane (docs/SIDE_PANE.md).
    sidePane: (chatId, action, panelId) => workspace.sidepane.act(String(chatId), String(action), panelId == null ? null : String(panelId)),
    "artifacts.list": (query) => workspace.artifacts.list(query),
    "artifacts.read": (id, options) => workspace.artifacts.read(id, options),
    "artifacts.resolve": (query) => workspace.artifacts.resolve(query),
    "artifacts.thumbnail": (id, options) => workspace.artifacts.thumbnail(id, options, host.images),
    inspectChatPaths: (paths) => {
      if (!Array.isArray(paths) || paths.length > 20) throw new Error("Check up to 20 paths.");
      return paths.map((path) => { const info = fileDetails(path); return info && publicFile(info); });
    },
    openChatPath: (path, action) => openChatPath(host.shell, path, action),
    thumbnailChatPath: (path, size) => {
      const info = fileDetails(path);
      return info ? thumbnail(info, size ?? 160, host.images) : null;
    },
    previewChatPath: (path, options) => {
      const info = fileDetails(path);
      if (!info) throw new Error("This file or folder is unavailable.");
      return chunk(info, { ...publicFile(info), id: info.path, botId: "", source: "tool", time: 0 }, options);
    },
    // Plans and limits, for the Usage page, the model picker and a paired phone (docs/PROVIDER_USAGE.md).
    providerUsage: (options) => providerUsage.list({ refresh: options?.refresh === true }),
    exportUsageText: (days) => workspace.artifacts.exported(usageFile(days, (range) => usageCsv(workspace.state, { days: range, timeZone: zone() }))),
    exportUsage: async (days) => {
      const csv = usageCsv(workspace.state, { days, timeZone: zone() });
      const filePath = await host.dialogs.save({
        title: "Export usage",
        defaultPath: "botkins-usage-" + days + "d.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!filePath) return false;
      await writeFile(filePath, csv, "utf8");
      recordExport(filePath);
      return true;
    },
    models: () => workspace.models(),
    setModel: (scope, id, value) => workspace.setModel(scope, id, value),
    setPreferences: (patch) => {
      const before = workspace.state.settings.background;
      workspace.setPreferences(patch);
      host.theme.set(workspace.state.settings.appearance.theme);
      try {
        host.background.apply(workspace.state.settings.background);
      } catch (error) {
        // The system refused "Run at startup": the setting goes back, so it never says more than is true.
        workspace.setPreferences({ background: before });
        host.background.refresh();
        throw new Error("This computer wouldn't change what starts with it. " + (error?.message ?? ""));
      }
    },
    sideQuestion: (id, question) => workspace.sideQuestion(id, question),
    // An answer may name a saved credential ({ $credential: id }) instead of holding text: its value
    // is read here, on this computer, and goes to the bot without passing the page. A phone's
    // answer arrives here with its values already in (the link resolves it the same way).
    respond: async (...args) => {
      const [id, answer] = await savedCredentials.respondArgs(args);
      return workspace.interactions.respond(id, answer);
    },
    clearApprovals: (id) => workspace.clearApprovals(id),
    copyReply: (id) => {
      const reply = workspace
        .chat(id)
        .messages.findLast((m) => m.role === "assistant" && !m.interim && m.text);
      if (!reply) throw new Error("This chat has no reply to copy.");
      host.clipboard.writeText(reply.text);
    },
    snapshot: () => snapshot(),
    // A frame (an html block) hands text to its chat's message box, where the person reviews and sends it.
    frameAnswer: (id, text) => {
      if (typeof text !== "string" || !text.trim()) throw new Error("Send a non-empty answer.");
      // Answers become ordinary message text: never a command. A page can't keep pulling the
      // person into its chat: one answer every five seconds from a frame, six a minute in all.
      if (/^\s*\//.test(text)) throw new Error("An answer can't start with a slash command.");
      const now = Date.now();
      const recent = [...frameAnswers.values()].filter((time) => now - time < 60000).length;
      if (now - (frameAnswers.get(id) ?? 0) < 5000 || recent >= 6) throw new Error("Wait a moment before sending another answer.");
      // A view in a panel: the text goes to the box of an ask about that panel, which is the
      // asker's own chat. It never goes to the chat the panel was made in, which may be another person's.
      const panel = workspace.frames.panelOf(id);
      const chatId = workspace.frames.chatFor(id);
      if (!panel && !chatId) throw new Error("This view's chat no longer exists.");
      frameAnswers.set(id, now);
      // This window is the owner's. The chat a panel was made in is named too when it is still
      // there and is the owner's own: a window that knows nothing of spaces puts the text there, as before.
      const own = panel && chatId && !workspace.state.chats.find((chat) => chat.id === chatId)?.createdBy;
      host.window.send("prefill", panel ? { panelId: panel.id, spaceId: panel.spaceId, ...(own && { chatId }), text: text.slice(0, 32000) } : { chatId, text: text.slice(0, 32000) });
    },
    // A frame asks to open a web page: the person decides, one question at a time.
    frameOpenLink: async (id, url) => {
      const frame = workspace.frames.get(id);
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Only web links can be opened.");
      // What is shown is exactly what is opened.
      const target = new URL(url).href;
      // After a No, the same view stays quiet for a minute, so it can't hold the window with questions.
      if (askingLink || Date.now() < (frameQuiet.get(id) ?? 0)) return false;
      askingLink = true;
      try {
        const bot = workspace.state.bots.find((b) => b.id === frame.botId);
        const response = await host.dialogs.ask({
          type: "question",
          buttons: ["Open in browser", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: "A view from " + (bot?.name ?? "a bot") + " wants to open a web page.",
          detail: target.length > 600 ? target.slice(0, 600) + "… (" + target.length + " characters)" : target,
        });
        if (response === 0) await host.shell.openExternal(target);
        else frameQuiet.set(id, Date.now() + 60000);
        return response === 0;
      } finally {
        askingLink = false;
      }
    },
    openLink: (url) => {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol))
        throw new Error("Unsupported link");
      return host.shell.openExternal(parsed.href);
    },
    updateBot: (id, data) => workspace.updateBot(id, data),
    // Skills and MCP servers for every bot (desktop/integrations.mjs)
    saveMcpServer: (data) => workspace.integrations.saveServer(data),
    setMcpServerEnabled: (id, enabled) => workspace.integrations.setServerEnabled(id, enabled),
    removeMcpServer: (id) => workspace.integrations.removeServer(id),
    testMcpServer: (id) => workspace.integrations.testServer(id),
    // Sign-in for a remote server (OAuth), and the vault that holds every credential.
    signInMcpServer: (id) => typeof id === "string" && id.startsWith("plugin-") ? workspace.plugins.signIn(id) : workspace.integrations.signIn(id),
    cancelMcpSignIn: (id) => typeof id === "string" && id.startsWith("plugin-") ? workspace.plugins.cancelSignIn(id) : workspace.integrations.cancelSignIn(id),
    signOutMcpServer: (id) => typeof id === "string" && id.startsWith("plugin-") ? workspace.plugins.signOut(id) : workspace.integrations.signOut(id),
    credentials: () => workspace.integrations.credentials(),
    resetVault: () => workspace.integrations.resetVault(),
    removeCredential: (id) => workspace.integrations.removeCredential(id),
    // Settings › Credentials, the saved credentials and password managers (desktop/savedcredentials.mjs).
    // Only this window calls these: none is in REMOTE_METHODS. None returns a value.
    savedCredentials: () => savedCredentials.list(),
    saveSavedCredential: (input) => savedCredentials.save(input),
    removeSavedCredential: (id) => savedCredentials.remove(id),
    checkSavedCredential: (id) => savedCredentials.check(id),
    passwordManagers: (refresh) => savedCredentials.managers(refresh === true),
    unlockPasswordManager: (manager, password) => savedCredentials.unlock(manager, password),
    lockPasswordManager: (manager) => savedCredentials.lock(manager),
    passwordManagerVaults: (manager) => savedCredentials.vaults(manager),
    passwordManagerItems: (manager, vaultId, query) => savedCredentials.items(manager, vaultId, query),
    passwordManagerItem: (manager, vaultId, itemId) => savedCredentials.item(manager, vaultId, itemId),
    linkPasswordManagerField: (input) => savedCredentials.link(input),
    importMcpServers: (json) => workspace.integrations.importServers(String(json ?? "").slice(0, 1_000_000)),
    importMcpServerFile: async () => {
      const paths = await host.dialogs.open({
        title: "Import MCP servers",
        properties: ["openFile"],
        filters: [{ name: "MCP configuration", extensions: ["json"] }],
      });
      return paths ? workspace.integrations.importServerFile(paths[0]) : null;
    },
    skills: () => ({ skills: workspace.integrations.skills(), ...workspace.integrations.folders() }),
    readSkill: (name) => workspace.integrations.readSkill(name),
    saveSkill: (data) => workspace.integrations.saveSkill(data ?? {}),
    removeSkill: (name) => workspace.integrations.removeSkill(name),
    setSkillEnabled: (name, enabled) => workspace.integrations.setSkillEnabled(name, enabled === true),
    addSkillFolder: async () => {
      const paths = await host.dialogs.open({
        title: "Add a skill, a folder of skills or a plugin",
        buttonLabel: "Add",
        properties: ["openDirectory"],
      });
      return paths ? addFolderOrPlugin(paths[0]) : null;
    },
    removeSkillFolder: (id) => workspace.integrations.removeFolder(id),
    revealSkill: (name) => {
      const skill = workspace.integrations.skills().find((s) => s.name === name);
      if (!skill) throw new Error("This skill no longer exists.");
      host.shell.showItemInFolder(join(skill.path, "SKILL.md"));
    },
    setBotIntegrations: (botId, patch) => workspace.integrations.setBotIntegrations(botId, patch ?? {}),
    // Each bot's memory (desktop/memory.mjs)
    botMemory: (botId) => workspace.memory.read(botId),
    setBotMemory: (botId, text) => workspace.memory.write(botId, text),
    // What "@" and "#" can mention in a chat (desktop/mentions.mjs)
    mentionables: (chatId, botId) => workspace.mentions.candidates(chatId, botId),
    // Agent management (desktop/agents.mjs)
    setBotFlags: (id, patch) => workspace.agents.setBotFlags(id, patch),
    makePrimary: (id) => workspace.agents.makePrimary(id),
    reorderBots: (ids) => workspace.agents.reorderBots(ids),
    duplicateBot: (id) => workspace.agents.duplicateBot(id),
    // Bot templates (desktop/templates.mjs)
    saveTemplate: (botId, name) => workspace.templates.saveFromBot(botId, name),
    renameTemplate: (id, name) => workspace.templates.rename(id, name),
    deleteTemplate: (id) => workspace.templates.remove(id),
    // The same without a dialog, for a window that has none (desktop/phonefiles.mjs): the file itself.
    exportTemplateText: (target) => workspace.artifacts.exported(workspace.templates.exportText(target ?? {}), target?.botId),
    importTemplateText: (file) => workspace.templates.importText(file ?? {}),
    exportTemplate: async (target) => {
      const name = target?.templateId ? workspace.templates.get(target.templateId).name : workspace.bot(target?.botId).name;
      const filePath = await host.dialogs.save({
        title: "Export bot template",
        defaultPath: name.replace(/[\\/:*?"<>|]+/g, " ").trim() + ".json",
        filters: [{ name: "Bot template", extensions: ["json"] }],
      });
      if (!filePath) return false;
      workspace.templates.exportTo(filePath, target);
      recordExport(filePath, target?.botId);
      return true;
    },
    importTemplate: async () => {
      const paths = await host.dialogs.open({
        title: "Import a bot template",
        properties: ["openFile"],
        filters: [{ name: "Bot template", extensions: ["json"] }],
      });
      return paths ? workspace.templates.importFrom(paths[0]) : null;
    },
    deleteBot: (id) => workspace.agents.deleteBot(id),
    addSection: (name) => workspace.agents.addSection(name),
    renameSection: (id, name) => workspace.agents.renameSection(id, name),
    deleteSection: (id) => workspace.agents.deleteSection(id),
    setChatFlags: (id, patch) => workspace.agents.setChatFlags(id, patch),
    renameChat: (id, title) => workspace.agents.renameChat(id, title),
    deleteChat: async (id) => {
      const result = await workspace.agents.deleteChat(id);
      // The link keeps who was invited into a chat; a chat that is gone has no people.
      forgetChatPeople(() => link, id);
      return result;
    },
    boardAct: (id, action, value, person = "owner") => {
      workspace.spaces.need(workspace.spaces.of(workspace.board.item(id)), person, "change");
      return workspace.board.act(id, action, value, person);
    },
    // Spaces (desktop/spaces.mjs; the contract is docs/spaces.md). The last argument is the person.
    // A device's call arrives with its person (desktop/device-call.mjs), and the link then does
    // its own part for that person. The owner's window names no one and has no device, so the
    // link's part is done here: when the owner last opened the space, a new space pinned for
    // its maker, and a deleted space's sharing dropped.
    "spaces.read": (id, person) => {
      const answer = workspace.spaces.read(id, person);
      return person === undefined && typeof link?.spaceContent === "function" ? link.spaceContent({ kind: "owner" }, answer, workspace.snapshot()) : answer;
    },
    "spaces.create": (data, person) => {
      const id = workspace.spaces.create(data, person);
      if (person === undefined && typeof link?.spacesFor === "function") {
        // The owner's own order, without the members' spaces: those are not the owner's to arrange by this.
        const mine = link.spacesFor("owner", { admin: false }) ?? [];
        link.arrangeSpaces("owner", { order: mine.map((space) => space.id), pinned: [...mine.filter((space) => space.pinned).map((space) => space.id), id] });
      }
      return id;
    },
    "spaces.rename": (id, name, person) => workspace.spaces.rename(id, name, person),
    "spaces.remove": async (id, person) => {
      await workspace.spaces.remove(id, person);
      if (person === undefined) link?.spaceRemoved?.(id);
    },
    "spaces.setProject": (id, projectId, person) => workspace.spaces.setProject(id, projectId, person),
    "spaces.setPanelProject": (panelId, projectId, person) => workspace.spaces.setPanelProject(panelId, projectId, person),
    "spaces.newPanel": (data, person) => workspace.spaces.newPanel(data, person),
    "spaces.ask": (data, person) => workspace.spaces.ask(data, person),
    "spaces.movePanel": (panelId, where, person) => workspace.spaces.movePanel(panelId, where, person),
    "spaces.patchState": (panelId, patch, label, person = "owner") => workspace.spaces.patchState(panelId, patch, label, person),
    "spaces.note": (panelId, text, person = "owner") => workspace.spaces.note(panelId, text, person),
    "spaces.removeNote": (panelId, noteId, person = "owner") => workspace.spaces.removeNote(panelId, noteId, person),
    // What the link keeps about a space (who it is shared with, each person's order and pins,
    // who is looking): the owner's own window has no device, so it asks the link as the owner,
    // by the names a phone uses (desktop/link/SPACES.md, "For the app on the host").
    ...Object.fromEntries(
      Object.entries({
        "link.spaces.share": (id, input) => link.shareSpace("owner", id, input),
        "link.spaces.newLink": (id) => link.newSpaceLink("owner", id),
        "link.spaces.arrange": (input) => link.arrangeSpaces("owner", input),
        "link.spaces.seen": (id, itemId) => link.seenSpace("owner", id, itemId),
        "link.spaces.notify": (id, mode) => link.notifySpace("owner", id, mode),
        "link.spaces.here": (id, panelId) => link.hereInSpace("owner", id, panelId),
        "link.team.setLinkSharing": (on) => link.setLinkSharing(on),
      }).map(([name, ask]) => [
        name,
        (...args) => {
          if (typeof link?.spacesFor !== "function") throw new Error("Sharing a space needs a newer phone link than this copy of Botkins has.");
          return ask(...args);
        },
      ]),
    ),
    linkPreview: (url) => (workspace.state.settings.linkPreviews ? linkPreviews.preview(String(url)) : null),
    // Tasks board (desktop/tasks.mjs)
    saveTask: (data) => workspace.tasks.save(data),
    moveTask: (id, status) => workspace.tasks.move(id, status),
    startTask: (id) => workspace.tasks.start(id),
    deleteTask: (id) => workspace.tasks.remove(id),
    // Projects and Project Changes (desktop/projects.mjs)
    // Folders for a window that can't show the system's chooser (desktop/folders.mjs). A folder
    // is taken only when the browser could have shown it.
    listFolders: (path) => folders.list(path),
    addProjectFolder: async (path) => workspace.projects.add((await folders.allowed(path)).path),
    // (`options.plugins: false` refuses a plugin folder: for a caller that shows nothing before it links.)
    addSkillFolderAt: async (path, options) => addFolderOrPlugin((await folders.allowed(path)).path, options),
    addProject: async () => {
      const paths = await host.dialogs.open({ title: "Choose a project folder", properties: ["openDirectory", "createDirectory"] });
      return paths ? workspace.projects.add(paths[0]) : null;
    },
    renameProject: (id, name) => workspace.projects.rename(id, name),
    removeProject: (id) => workspace.projects.remove(id),
    setChatProject: (chatId, projectId, mode) => workspace.projects.setChatProject(chatId, projectId, mode),
    projectChanges: (id) => workspace.projects.changes(id),
    projectDiff: (id, file) => workspace.projects.diff(id, file),
    projectCommit: (id, message) => workspace.projects.commit(id, message),
    revealProject: (id) => {
      const folder = workspace.projects.folderOf(id);
      // Opening a folder that is an app (or another bundle) would start it: such a folder is shown in its place.
      if (extname(folder) && existsSync(join(folder, "Contents"))) return void host.shell.showItemInFolder(folder);
      return host.shell.openPath(folder);
    },
    // Project workspaces, to-dos and agent access (desktop/projects.mjs, access.mjs)
    createProject: (data) => workspace.projects.create(data),
    updateProject: (id, patch) => workspace.projects.update(id, patch),
    chooseProjectFolder: async (id) => {
      const paths = await host.dialogs.open({ title: "Choose a folder for this project", properties: ["openDirectory", "createDirectory"] });
      if (!paths) return null;
      workspace.projects.update(id, { folder: paths[0] });
      return paths[0];
    },
    startProjectChat: (botIds, projectId, mode) => workspace.projects.startChat(botIds, projectId, mode),
    // Artifacts a person attached to a project (capability "project-artifacts-v1").
    addProjectArtifact: (projectId, artifactId) => workspace.projects.addArtifact(projectId, artifactId),
    removeProjectArtifact: (projectId, artifactId) => workspace.projects.removeArtifact(projectId, artifactId),
    projectArtifacts: (projectId) => workspace.projects.artifacts(projectId),
    addTodo: (projectId, text) => workspace.projects.addTodo(projectId, text).id,
    updateTodo: (projectId, todoId, patch) => void workspace.projects.updateTodo(projectId, todoId, patch),
    deleteTodo: (projectId, todoId) => workspace.projects.deleteTodo(projectId, todoId),
    moveTodo: (projectId, todoId, delta) => workspace.projects.moveTodo(projectId, todoId, delta),
    setBotAccess: (botId, access) => workspace.access.setBotAccess(botId, access),
    catalog: (botId, chatId, refresh) =>
      workspace.catalog(botId, chatId, refresh),
    // A panel's calls are for a person ("owner" for this window; a paired device's is handed in
    // by desktop/device-call.mjs), who has to be able to change the panel's space.
    changePanel: (id, action, person = "owner") => {
      workspace.spaces.need(workspace.spaces.of(workspace.panels.get(id)), person, "change");
      workspace.panels.change(id, action);
    },
    routine: (id, data, person = "owner") => {
      workspace.spaces.need(workspace.spaces.of(workspace.panels.get(id)), person, "change");
      return workspace.panels.routine(id, data, person);
    },
    refreshPanel: (id, person = "owner") => {
      workspace.spaces.need(workspace.spaces.of(workspace.panels.get(id)), person, "change");
      workspace.panels
        .refresh(id, "manual", Date.now(), person)
        .catch((err) => host.dialogs.error("Panel refresh", err.message));
    },
    cacheInfo: async () => ({
      bytes: await host.cache.size(),
      catalogs: workspace.catalogs.size,
    }),
    clearCache: async () => {
      // Menus are rebuilt on next use. Open sessions stay open: closing them would only make
      // the next messages slow to start.
      workspace.clearCatalogs();
      await host.cache.clear();
    },
    // The wiki (desktop/wiki.mjs). Changes made here are the person's own.
    wikiTree: () => workspace.wiki.tree(),
    wikiPage: (path) => workspace.wiki.page(path),
    saveWikiPage: (path, content, base) => {
      workspace.wiki.write(path, content, { base: typeof base === "string" ? base : undefined });
      return workspace.wiki.page(path);
    },
    createWikiPage: (input) => workspace.wiki.create(input ?? {}),
    createWikiPageFor: (record) => workspace.wiki.createFor(record ?? {}),
    createWikiFolder: (input) => workspace.wiki.createFolder(input ?? {}),
    moveWiki: (from, to) => workspace.wiki.move(from, to),
    deleteWiki: (path) => workspace.wiki.remove(path),
    searchWiki: (query) => workspace.wiki.search(query, { limit: 30 }),
    wikiHistory: (path) => workspace.wiki.history(path),
    wikiVersion: (path, id) => workspace.wiki.version(path, id),
    restoreWikiVersion: (path, id) => workspace.wiki.restore(path, id),
    // Exporting the wiki: what a scope would hold, the pages' text for the app's page to lay out,
    // and saving the result where the person chooses.
    wikiExportPlan: (request) => workspace.wiki.exportPlan(request ?? {}),
    wikiExportPages: (paths) => workspace.wiki.exportPages(paths),
    exportWiki: (request) => exportWiki(request ?? {}),
    // The export as a file in the answer; the document is laid out here, by the window's own code compiled for this process.
    exportWikiFile: async (request) => workspace.artifacts.exported(await wikiFile(request ?? {}, { wiki: workspace.wiki, zip, pdf: (html) => host.pdf(html), layout: () => import("./generated/wiki-export-doc.mjs") })),
    // Shows the file the last export saved, in Finder or Explorer.
    revealWikiExport: () => {
      if (lastExport) host.shell.showItemInFolder(lastExport);
    },
    revealWiki: async (path) => {
      // Shows the wiki folder (or one page's file) in Finder or Explorer.
      const target = typeof path === "string" && path ? workspace.wiki.file(wikiPath(path)) : workspace.wiki.root;
      if (target === workspace.wiki.root) await host.shell.openPath(target);
      else host.shell.showItemInFolder(target);
    },
    addBot: (data) => workspace.agents.create(data),
    // The person's existing agents (for Copilot, ~/.copilot/agents) and making bots of them.
    importableAgents: () => workspace.agents.importable(),
    importAgents: (keys) => workspace.agents.importAgents(keys),
    createChat: (id) => workspace.createChat(id),
    createGroupChat: (botIds, title) => workspace.createGroupChat(botIds, title),
    recordVoiceLine: (chatId, id, text, final, author) => workspace.recordVoiceLine(chatId, id, text, final, author),
    send: (id, text, options) => {
      // The desktop steers by default. Queue is an explicit composer action.
      const turn = workspace.submit(id, text, {
        delivery: options?.delivery === "steer" ? "steer" : "queue",
        attachments: options?.attachments,
        quote: options?.quote,
        mentions: options?.mentions,
        author: options?.author,
        voiceId: options?.voiceId,
        ...(options?.notify === false && { notify: false }),
      });
      turn?.catch((err) => console.error("Workspace turn:", err.message));
    },
    stop: (id) => workspace.stop(id),
    // Opening a chat readies its session, so the next message starts at once.
    warmChat: (id) => void workspace.prewarm(id),
    // Chat canvas (desktop/canvas.mjs)
    chooseFiles: async () => {
      const paths = await host.dialogs.open({
        title: "Attach files",
        properties: ["openFile", "multiSelections"],
      });
      return paths ? validateAttachments(paths.slice(0, 10)) : [];
    },
    unqueue: (id, itemId) => workspace.unqueue(id, itemId),
    sendNow: (id, itemId) => workspace.sendNow(id, itemId),
    forkChat: (id, index) => workspace.forkChat(id, index),
    retry: (runId) => {
      workspace.retry(runId)?.catch((err) => console.error("Retry:", err.message));
    },
    compact: (id) => {
      workspace.compact(id)?.catch((err) => console.error("Compact:", err.message));
    },
    copyText: (text) => {
      if (typeof text !== "string" || text.length > 200000)
        throw new Error("Nothing to copy.");
      host.clipboard.writeText(text);
    },
    // The account behind a model provider. Without an id these act on the default provider.
    auth: (providerId) => providers.get(providerId).auth(),
    signIn: async (providerId) => {
      const provider = providers.get(providerId);
      try {
        await provider.signIn({ open: openSignIn });
      } finally {
        // Also after a failure: a sign-in the person finished elsewhere still counts.
        await workspace.providerChanged(provider.id);
      }
    },
    cancelSignIn: (providerId) => providers.get(providerId).cancelSignIn(),
    // A token kept for the provider goes too (signIns.signOut), then the provider's own sign-in.
    signOut: async (providerId) => {
      await signIns.signOut(providers.get(providerId).id);
    },
    // Every model provider with its status, and how a phone can sign each in (signInWays), and
    // switching one on or off (Settings › Model providers).
    providers: async (refresh) => {
      const statuses = await workspace.providerStatuses(refresh === true);
      return statuses.map((status) => {
        const provider = providers.byId.get(status.id);
        if (!provider || !status.installed) return status;
        return { ...status, signInWays: signIns.ways(provider), signOut: status.signOut || signIns.hasToken(provider.id) };
      });
    },
    // The harnesses that are programs of their own (Pi), and whether each is installed, for Settings › Harness.
    harnesses: () => providers.harnessStatuses(),
    // Signing in and installing from a phone ("provider-signin-v1"). The phone names the provider;
    // the sign-in or the install command is this computer's own (desktop/terminal/signin.mjs).
    providerSignInStart: (id, options) =>
      signIns.start(String(id), { service: typeof options?.service === "string" ? options.service : undefined, method: typeof options?.method === "string" ? options.method : undefined, abandonedMs: PHONE_PATIENCE_MS }),
    providerSignInRead: (session, after) => signIns.read(String(session), { after: Number(after) || 0, ms: 10_000 }),
    providerSignInInput: (session, text) => void signIns.input(String(session), text),
    providerSignInCancel: (session) => signIns.cancel(String(session)),
    providerUseToken: (id, token, options) => signIns.useToken(String(id), token, { service: typeof options?.service === "string" ? options.service : undefined }),
    installProvider: (id) => signIns.install(String(id), { abandonedMs: PHONE_PATIENCE_MS }),
    setProviderEnabled: (id, enabled) => workspace.setProviderEnabled(id, enabled),
    // A provider that holds several model services (OpenCode): look one up, connect it, remove it.
    providerServices: (id, query) => providers.require(id).services(typeof query === "string" ? query.slice(0, 100) : ""),
    connectProviderService: async (id, serviceId, options) => {
      const provider = providers.require(id);
      const result = await provider.connectService(String(serviceId), {
        ...(typeof options?.key === "string" && { key: options.key }),
        ...(typeof options?.method === "string" && { method: options.method }),
        open: openSignIn,
      });
      if (result?.done) await workspace.providerChanged(provider.id);
      return result;
    },
    finishProviderService: async (id, serviceId, attempt, code) => {
      const provider = providers.require(id);
      const result = await provider.finishService(String(serviceId), String(attempt), code);
      await workspace.providerChanged(provider.id);
      return result;
    },
    cancelProviderService: (id, serviceId) => providers.require(id).cancelService(String(serviceId)),
    disconnectProviderService: async (id, serviceId) => {
      const provider = providers.require(id);
      await provider.disconnectService(String(serviceId));
      await workspace.providerChanged(provider.id);
    },
    // Updates, for the window and for the owner's phones ("app-update-v1"). None takes a version,
    // an address or a channel: what is installed is the latest signed release, and nothing else.
    appUpdateStatus: () => updating().status(),
    checkAppUpdate: async () => {
      await updating().check();
      return updates.status();
    },
    installAppUpdate: async () => {
      // The restart waits a moment, so this answer is on its way to the window or the phone that
      // asked before the app goes down. (A phone also copes with an answer that never comes.)
      await updating().install(new Promise((resolve) => setTimeout(resolve, REPLY_MS)));
      return updates.status();
    },
    // Installing by itself, on a host that has the choice. Refused where it has none.
    setAppUpdateAuto: (on) => updating().setAuto(on),
    openAppRelease: () => host.shell.openExternal(releasePage),
    appInfo: () => host.info(),
    // Phone access (Settings › Phone, desktop/phonepage.mjs). Only this window may call these:
    // none is in REMOTE_METHODS (desktop/link/methods.mjs), so a phone can't pair other phones,
    // change what phones may do with this screen, or turn "away from home" on.
    phoneLink: () => phone.phoneLink(),
    setPhoneLink: (enabled) => phone.setPhoneLink(enabled),
    startPhonePairing: () => phone.startPhonePairing(),
    cancelPhonePairing: () => phone.cancelPhonePairing(),
    removePhone: (id) => phone.removePhone(id),
    renamePhone: (id, name) => phone.renamePhone(id, name),
    setPhonePerson: (id, person) => phone.setPhonePerson(id, person),
    renamePhoneLinkComputer: (name) => phone.renamePhoneLinkComputer(name),
    setPhoneScreen: (mode) => phone.setPhoneScreen(mode),
    setPhoneRelay: (enabled) => phone.setPhoneRelay(enabled),
    resetPhoneRelay: () => phone.resetPhoneRelay(),
    requestScreenPermission: (kind) => phone.requestScreenPermission(kind),
    allowLocalNetwork: () => phone.allowLocalNetwork(),
    // iMessage and Mail for bots (Settings › MCP servers › On this Mac, desktop/mactools.mjs). Only this
    // window may call these: none is in REMOTE_METHODS, so a phone can't switch them on or check them.
    // The permission check runs only when the page asks, never at start-up.
    macToolsStatus: () => workspace.mac.status(),
    setMacTool: (tool, level) => workspace.mac.set(tool, level),
    grantMacTool: (permission) => workspace.mac.grant(permission),
    // Voice (Settings › Voice, desktop/voicedesk.mjs). Only this window may call these: none is in
    // REMOTE_METHODS (a phone reaches voice through the link's own calls). No key ever comes back.
    voiceSettings: () => voiceDesk.settings(),
    setVoice: (patch) => voiceDesk.set(patch),
    setVoiceKey: (provider, key) => voiceDesk.setKey(provider, key),
    voiceOptions: (kind, provider) => voiceDesk.options(kind, provider),
    transcribe: (bytes, format, language) => voiceDesk.transcribe(bytes, format, language),
    speak: (text, options) => voiceDesk.speak(text, options ?? {}),
    startDictation: () => voiceDesk.startDictation(),
    startLiveVoice: async (chatId, options) => {
      // A WebRTC session needs UDP to the provider: this window allows it only while one is open.
      if (options?.prepare) return void host.window.peerToPeer(true);
      try {
        return await voiceDesk.startLive(chatId, options ?? {});
      } catch (error) {
        host.window.peerToPeer(false);
        throw error;
      }
    },
    liveVoiceTranscript: (id, text, final, options) => {
      if (voiceDesk.isOwn(id)) voiceDesk.heardUser(id, text, final, options);
    },
    liveVoiceTool: (sessionId, name, args) => voiceDesk.liveTool(sessionId, name, args),
    endLiveVoice: (sessionId) => {
      host.window.peerToPeer(false);
      voiceDesk.endLive(sessionId);
    },
  };
  // Pictures of the screen for a phone that may watch it (desktop/screenshare.mjs in the desktop
  // app; a host with no screen says so).
  const screens = host.screen;
  // Whether a phone can find this computer by itself on the network (desktop/nearby.mjs), and the
  // way to the page of System Settings where macOS lets Botkins use the local network.
  const workspaceSocket = splitHost && process.env.BOTKINS_WORKSPACE_SOCKET;
  const phone = phonePage({
    managed: !!workspaceSocket,
    link: () => link,
    qrPath,
    screens,
    nearby: () => nearbyState(),
    allowLocalNetwork: async () => {
      await host.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork");
      retryAnnouncing();
    },
  });
  // A trial run (a data folder of its own: the tests, a development copy) sends no notifications
  // out through the relay unless it asks to (BOTKINS_PUSH=1), and can listen on a port of its
  // choice (BOTKINS_LINK_PORT) so it never takes the installed app's.
  // Voice: the link's Voice (link.voice) holds the choices and keys for this window and for phones.
  // Live voice on the ChatGPT sign-in runs through Codex (desktop/codexvoice.mjs), when Codex is one
  // of this app's providers; it asks Codex whether it is signed in only while Codex is switched on.
  const codexProvider = providers.byId?.get("codex");
  const codexVoice =
    codexProvider &&
    new CodexVoice({
      provider: { locate: () => codexProvider.locate(), status: () => (providers.enabled().includes(codexProvider) ? codexProvider.status() : { installed: false, connected: false }) },
      onTool: (sessionId, name, args) => voiceDesk.liveTool(sessionId, name, args),
      // A session the link started for a phone says which chat it is for, so its tool calls run there.
      onSession: (sessionId, about) => void voiceDesk.noteSession(sessionId, about),
      onEvent: (sessionId, event) => {
        // Only this window's own session is shown here and decides its peer-to-peer rule: a
        // phone's session, which the link started, is the phone's to show.
        const own = voiceDesk.isOwn(sessionId);
        // BOTKINS_VOICE_LOG=1 prints what a session's voice and the person said, for a check by hand.
        if (env("VOICE_LOG") === "1" && event.type === "transcript" && event.final) console.log("voice " + sessionId.slice(0, 14) + " " + event.role + ": " + event.text);
        if (event.type === "transcript" && event.role === "user") voiceDesk.heardUser(sessionId, event.text, event.final);
        if (event.type === "ended") {
          if (own) host.window.peerToPeer(false);
          voiceDesk.forget(sessionId);
        }
        if (own) host.window.send("live-voice", { sessionId, ...event });
      },
      botName: () => voiceDesk.startingBot ?? "",
      log: (line) => console.log(line),
    });
  const voiceDesk = new VoiceDesk({
    voice: () => link?.voice ?? null,
    workspace: () => workspace,
    liveContext: ({ chatId, botId }) => liveContextFor(workspace, { chatId, botId }),
    // The system's own dictation, into the focused field (macOS: Edit › Start Dictation).
    dictate: () => host.window.dictate(),
    refresh: () => codexVoice?.refresh(),
    // Words for a live voice to say outside a tool call (the bot's answer to a request that
    // outlasted its call). A Codex session, this window's or a phone's, is told through Codex;
    // this window's other sessions are told through the page, which holds their connection.
    say: async (sessionId, text) => {
      if (await codexVoice?.say(sessionId, text)) return true;
      if (!voiceDesk.isOwn(sessionId)) return false;
      return host.window.send("live-voice", { sessionId, type: "say", text });
    },
    log: (line) => console.log(line),
  });
  const linkBackend = {
    // The phone shows this computer's app by this name.
    info: () => ({ app: "botkins", version: host.version, platform: process.platform }),
    // A host with no window of its own (a server): a phone may then set the screen's level, and is
    // told whether there is a display to show at all (desktop/link/server.mjs, headless()).
    ...(host.headless && { headless: true, displayStatus: () => host.displayStatus() }),
    // What this app supports beyond the link's own calls, by the names the phone looks for.
    capabilities: updates ? [...linkCapabilities(), APP_UPDATE] : linkCapabilities(),
    // The person is looking at this window, and at that chat: a reply there needs no ping on a phone.
    attention: () => {
      const focused = host.window.focused();
      const viewing = host.window.viewing();
      return { focused, ...(focused && viewing && { chatId: viewing }) };
    },
    snapshot: () => workspace.snapshot(),
    // Optional context for a live voice: bounded bot profile files and the person's chosen name;
    // no location is read on the desktop without a separate permissioned source. The link says
    // when a team member is asking (`memberId`): they get nothing from the owner's notes.
    liveContext: ({ chatId, botId, memberId }) => liveContextFor(workspace, { chatId, botId, memberId }),
    // LinkHost only passes names in REMOTE_METHODS. What a paired device sends is checked and,
    // for a team member, marked as theirs on its way to the handlers (desktop/device-call.mjs).
    call: deviceCall({ workspace, handlers, folders }),
    subscribe: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    // A bot's Botkin is kept on the bot (desktop/looks.mjs), so the link stores no looks of its own
    // and sends each bot's `look` as it is. A phone changes one through here.
    setLook: (botId, look) => workspace.updateBot(String(botId), { look }),
    // Custom views (html blocks) for a phone: the page as the bot wrote it and its data, and the chat
    // an answer from a view in a Today panel goes to. The link checks ids and sizes before it answers.
    frames: {
      page: (id) => ({ html: workspace.frames.html(id), data: workspace.frames.data(id) }),
      chatFor: (id) => workspace.frames.chatFor(id),
    },
    // Spaces, for the link itself and never for a device: a person's four built-in spaces, the
    // copy of a space that a link opens, and (`release`) what stays to do when a member leaves the team.
    // The cut of the team that the link's container tells this one (the two-container host only).
    ...(heldTeam && { teamCut: heldTeam }),
    // What people did in a space since the link's last look (the two-container host only).
    ...(spaceEvents && { takeSpaceEvents: spaceEvents.take }),
    spaces: {
      ensure: (person) => Object.fromEntries(Object.entries(workspace.spaces.ensure(person)).map(([builtin, space]) => [builtin, space.id])),
      // A space that is gone has no copy: null, and the link takes its copy back.
      snapshot: (id, options) => (workspace.spaces.all.some((space) => space.id === id) ? workspace.spaces.snapshot(id, options ?? undefined) : null),
      release: (memberId) => workspace.spaces.memberRemoved(memberId),
    },
    // A phone that signed in to an MCP server hands the computer its sign-in (reached as "link.adoptMcpSignIn").
    extras: { adoptMcpSignIn: (serverId, grant) => workspace.integrations.adoptSignIn(serverId, grant) },
    screen: screens,
    // The app's own speech helpers for voice.mjs (desktop/link/VOICE.md). No local engine yet.
    voice: { ...(codexVoice && { codex: codexVoice }) },
  };
  // The port the link listens on instead of its saved one: the host's own choice (0 is any free
  // port, which tests use), else BOTKINS_LINK_PORT, so a trial run never takes the installed app's.
  const validPort = (port, least) => Number.isInteger(port) && port >= least && port < 65536;
  const linkPort = validPort(linkOptions.port, 0) ? linkOptions.port : validPort(Number(env("LINK_PORT")), 1) ? Number(env("LINK_PORT")) : undefined;
  link = new LinkHost({
    dir: join(dataDir, "link"),
    // A trial run finds the password managers' tools only in the folders BOTKINS_TOOL_PATH names
    // (a test's stand-ins), and none without it, so it never starts the person's own.
    ...(trial && { managerSearchPath: trialToolDirs(env("TOOL_PATH")) }),
    ...(linkPort !== undefined && { port: linkPort }),
    ...(linkOptions.extraHosts?.length && { extraHosts: linkOptions.extraHosts }),
    // (Only the relay is refused: the same fetch carries the voice providers' requests.)
    ...(trial && env("PUSH") !== "1" && { fetch: (url, init) => (hostOf(url) === hostOf(DEFAULT_RELAY_URL) ? Promise.reject(new Error("A trial run sends no notifications.")) : fetch(url, init)) }),
    backend: linkBackend,
    // The link's private key is wrapped by the host's key store, like the vault's.
    ...(keys && {
      protect: keys.wrap,
      reveal: (data) => {
        const text = keys.unwrap(data);
        // The link treats a key it can't open as locked, and leaves its file alone.
        if (text == null) throw new Error("locked");
        return text;
      },
    }),
    log: (message) => console.log(message),
  });
  // A phone that starts watching this screen is always announced, whatever the notification settings.
  // The link's key was opened with the earlier keychain entry: saved now, it is under Botkins' own,
  // and the next start needs no help. (A link that is locked saves nothing.)
  if (keys?.adopted) link.store?.save?.();
  link.on("screen", ({ device, started }) => {
    if (!started) return;
    const name = link.status().devices.find((d) => d.id === device)?.name ?? "A phone";
    notifier.show({ title: name + " is viewing this screen", body: "Stop it in Settings › Phone." });
  });
  link.on("joinRequest", (request) => notifier.consider({ type: "joinRequest", request }));
  // A newer Botkins is out: the owner's phones are told, once for each version (the link keeps
  // count for each phone, and a phone that switched these off hears nothing).
  updates?.onAvailable?.((version) => void link.push.updateAvailable?.(version));
  // Until the person names this computer for their phones, it goes by the system's own name for
  // it (on a Mac the one in Sharing), not by a network host name such as a tailnet's.
  if (!link.store.data.locked && !link.store.data.name) {
    const name = computerName();
    if (name) link.setName(name);
  }
  // While phone access is on, the computer says so on the local network, so a phone finds it
  // without an address (desktop/nearby.mjs). A trial run on a folder of its own stays quiet
  // unless it asks to be heard (BOTKINS_NEARBY=1).
  const heard = linkOptions.announce ?? (!trial || env("NEARBY") === "1");
  const announcer = nearby({
    log: (message) => console.log(message),
    // Announced, or refused by macOS: Settings › Phone says which, so it asks again.
    changed: () => {
      phoneRevision++;
      push();
    },
  });
  nearbyState = () => (heard ? announcer.state : "off");
  retryAnnouncing = () => announcer.retry?.();
  const announce = () => {
    const status = link.status();
    announcer.update({ on: heard && status.listening && !status.locked, name: status.name, port: status.port, id: status.serverId, protocol: PROTOCOL });
  };
  stopAnnouncing = () => announcer.stop();
  link.on("status", () => {
    phoneRevision++;
    announce();
    push();
  });
  // A phone switched a source on or off: the next turn's tools are read anew, and Settings looks again.
  link.on("tools", () => {
    phoneRevision++;
    push();
  });
  // A new network or a wake from sleep changes this computer's addresses, and the person may
  // have allowed the local network meanwhile: look again now and then.
  host.power.onResume(announce);
  const announcing = setInterval(announce, 30_000);
  announcing.unref();
  // Listens only when the person turned phone access on. A busy port must not stop the app.
  let closeWorkspaceSocket;
  let listening = Promise.resolve();
  if (workspaceSocket) {
    const { serveWorkspace } = await import("./headless/workspace.mjs");
    closeWorkspaceSocket = await serveWorkspace(workspaceSocket, linkBackend);
  } else listening = link.start().then(announce, (error) => console.error("Phone link:", error.message));
  /** What the app's own view shows of this computer: the workspace, the team, the owner's chat sections, and a number that goes up when a phone changes. */
  // `spaces` is the owner's own list, as the link makes one for every person. A link from before
  // spaces makes none, and the window then has no `spaces`, which is how it knows.
  // (This one is for a caller with no window: the terminal host's own status and its command
  // line, which show everything, as an owner with Admin mode on. The desktop app's window gets
  // its snapshot from desktop/main.mjs, cut by the window's own Admin mode: desktop/admin-view.mjs.)
  const snapshot = () => ({ ...withOwnerChatSections(workspace.snapshot(), link), spaces: link?.spacesFor?.("owner"), ...(link ? { team: link.team() } : {}), phones: { revision: phoneRevision } });
  const tick = () => {
    tickChatSchedules(workspace);
    try {
      workspace.tasks.tick();
    } catch (error) {
      console.error("Task dispatcher:", error.message);
    }
    return workspace.panels
      .tick()
      .catch((error) => console.error("Panel scheduler:", error.message));
  };
  let checking = [];
  return {
    workspace,
    providers,
    signIns,
    providerUsage,
    folders,
    bridge,
    link,
    linkBackend,
    listening,
    handlers,
    phone,
    notifier,
    updates,
    snapshot,
    /** The number that goes up when a phone pairs, goes away or connects. */
    phoneRevision: () => phoneRevision,
    /** Says the workspace changed to everyone who listens (the link, the app's own view). */
    notify,
    /** fn() on every change of the workspace; returns a function that stops it. */
    subscribe: linkBackend.subscribe,
    /** Asks the local network announcement to look again (addresses change; macOS may have allowed it since). */
    announce,
    /**
     * Takes up the work that was waiting: turns a restart interrupted, then routines, schedules
     * and tasks every five seconds, and (an installed copy on its own data) a look for updates
     * now and then. Called once the program around this is ready to show what happens.
     */
    begin() {
      for (const turn of workspace.resumeActive()) turn.catch((error) => console.error("Resume chat:", error.message));
      timer = setInterval(tick, 5000);
      host.power.onResume(tick);
      tick();
      if (host.packaged && !trial && updates) {
        const check = () => updates.check().catch(() => {});
        checking = [setTimeout(check, 12000), setInterval(check, 6 * 60 * 60 * 1000)];
        for (const timer of checking) timer.unref();
      }
    },
    /** Stops for good (the program is quitting). Resolves when the providers, the tools and the link have closed. */
    stop() {
      stopAnnouncing();
      workspace.closing = true;
      closeWorkspaceSocket?.();
      workspace.interactions.cancel();
      clearInterval(timer);
      clearInterval(announcing);
      for (const timer of checking) clearTimeout(timer);
      voiceDesk.close();
      return Promise.allSettled([signIns.close(), providers.stop(), workspace.harness.stop(), bridge.stop(), link.stop(), codexVoice?.close()]);
    },
  };
}
