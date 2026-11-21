// What the `botkins` command line can ask the running service: one function for each call, by
// the name that goes over the control socket (desktop/terminal/socket.mjs).
//
// Whoever reaches the socket is the owner (the socket's own permissions decide that), so these
// calls do what the desktop app's own window can do. A few are the terminal host's own (status,
// logs, config, pairing); the rest are thin: they look a bot or a routine up by the name a person
// typed and hand the work to the workspace's own calls (`runtime.handlers`), which a paired phone
// uses too. "call" reaches the ones that have no command of its own yet, by name, and keeps the
// rules that the commands hold (see `callRule`).
//
// Every value is plain JSON: `--json` prints it as it is.
import { qrText } from "../link/qr.mjs";
import { changed as changedSettings, read as readSetting, SETTINGS, validate, withSetting, parseValue } from "./config.mjs";
import { ControlError } from "./socket.mjs";
import { DESKTOP_ONLY } from "../host/headless.mjs";
import { CHANGES, thingForLog, WORKSPACE } from "./coverage.mjs";
import { toolsApi } from "./control-tools.mjs";
import { pluginsApi } from "./control-plugins.mjs";
import { botsApi } from "./control-bots.mjs";
import { chatsApi } from "./control-chats.mjs";
import { routinesApi } from "./control-routines.mjs";
import { projectsApi } from "./control-projects.mjs";
import { wikiApi } from "./control-wiki.mjs";
import { prefsApi } from "./control-prefs.mjs";
import { credentialsApi } from "./control-credentials.mjs";
import { voiceApi } from "./control-voice.mjs";

const WAIT_MS = 25_000;
export const CREDENTIAL_REFERENCES_ON_THE_SOCKET = false; // The owner's choice (asked 2026-11-21, not answered yet): false = a caller on the socket gives values that it has, and cannot use a saved credential by reference. true = references are taken as the window and a phone take them.
/**
 * A reference to a saved credential, { "$credential": id }, is resolved by the app to the saved
 * secret. A caller on the socket cannot read a saved credential, but it could send one to an
 * address that it chose (a plugin it wrote, a secure request that a bot made). So, while the
 * owner has not chosen, these calls refuse a reference anywhere in what they are given.
 */
const WITHOUT_REFERENCES = ["plugins.install", "plugins.configure", "chat.respond", "respond"];
// The sentence names what the call at hand has: only a plugin's install and configure take --settings.
const CHOSEN_IN_THE_APP = "A saved credential is chosen in the app's window or on a paired phone. From the command line, give the value itself";
const NO_REFERENCES = (name) => CHOSEN_IN_THE_APP + (name.startsWith("plugins.") ? " (`--settings`, or the hidden question)." : ".");
const holdsReference = (value, depth = 0) => depth <= 8 && value !== null && typeof value === "object" && (Object.hasOwn(value, "$credential") || Object.values(value).some((inner) => holdsReference(inner, depth + 1)));
/** Refuses the arguments of a call that may not hold a reference to a saved credential (see above). */
const refuseReferences = (name, args) => {
  if (!CREDENTIAL_REFERENCES_ON_THE_SOCKET && WITHOUT_REFERENCES.includes(name) && holdsReference(args)) throw new ControlError(NO_REFERENCES(name), "BAD_ARGUMENT");
};
/**
 * What `call` may not reach, by the table of desktop/terminal/coverage.mjs. A call that a command
 * covers is done by that command: it shows what it changes and leaves a line in the log. A call
 * with a reason is done where that reason says. Only the calls that are still owed run through
 * `call`, and some of those are held below until their command is written.
 *
 * The rule for secrets: a call that reaches a secret which the caller cannot read by itself, or that
 * sends such a secret somewhere, is not for the socket. It stays where a person is known to be
 * there: the window, or a phone with its owner check. Everything else the window can do, the
 * socket does, with what it starts shown and a line in the log.
 * (Decided on 2026-11-21 in the thread 'Keep Headless and Desktop in Sync', as the safe side, until
 * the owner says otherwise. The owner has the choice in front of him.)
 */
export const REFUSED_BY_REASON = {
  window: (name) => "`" + name + "` needs the app's window (a dialog, the clipboard, a notification, a microphone or a permission on the screen). It is done there, not from a terminal.",
  "window's own": (name) => "`" + name + "` is what the app's window uses to draw itself (a pane, a preview or a thumbnail). The window makes it, and a terminal has no use for it.",
  "phone's own": (name) => "`" + name + "` belongs to a paired phone (its notifications, its screen or its uploads). The phone makes it.",
  person: (name) => "`" + name + "` needs a person at the app: the window, or a phone with its owner check. The terminal host cannot know that a person is there.",
};
export const COVERED_BY_COMMAND = (name, command) => "`" + name + "` is done by `botkins " + command + "`. Run that command: it shows what it changes and leaves a line in the log.";

const IN_THE_APP = "Do it in the app's window or on a paired phone. A command for it comes.";
const takesSecret = (name) => "`" + name + "` takes a secret as an argument, and a secret is never a word on the command line. " + IN_THE_APP;
const removesSecrets = (name) => "`" + name + "` removes saved secrets with no question. Do it in the app's window or on a paired phone, where a person is asked. A command for it comes, and it asks first.";
const givesYes = (name) => "`" + name + "` with the mode yolo gives each request of the chat a yes, with no question. Set it in the app's window or on a paired phone. A command for it comes, and it shows this and asks.";
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Every field of the voice settings that is a provider's web address (desktop/link/voice.mjs `merge`).
const VOICE_ADDRESSES = [["openai", "baseUrl"], ["azure", "endpoint"], ["azure", "region"], ["custom", "baseUrl"]];
const setsVoiceAddress = (patch) => isPlain(patch) && isPlain(patch.providers) && VOICE_ADDRESSES.some(([provider, field]) => isPlain(patch.providers[provider]) && patch.providers[provider][field] !== undefined);

/**
 * The calls that are owed a command (coverage.mjs) and that `call` still holds, until their command
 * is merged: name → (arguments) → the sentence that refuses them, or nothing when they may run.
 * Each entry goes when its command is merged: the table then says `cmd(...)`, and `callRule` refuses
 * the call by that. Nothing here may be left when nothing is owed.
 * Each rule looks at an argument by its place. The places were read from the handlers (desktop/runtime.mjs) on
 * 2026-11-21: a handler that takes the same thing in another shape needs its rule here changed with it.
 */
export const HELD = {
  // A secret as an argument (the arguments of `call` are on the command line).
  setVoiceKey: (args, name) => takesSecret(name),
  providerUseToken: (args, name) => takesSecret(name),
  saveSavedCredential: (args, name) => takesSecret(name),
  // A key for a service of a provider, or the code that finishes a sign-in.
  connectProviderService: (args, name) => (typeof args[2]?.key === "string" ? takesSecret(name) : null),
  finishProviderService: (args, name) => takesSecret(name),
  // Saved secrets removed with no question.
  resetVault: (args, name) => removesSecrets(name),
  removeCredential: (args, name) => removesSecrets(name),
  removeSavedCredential: (args, name) => removesSecrets(name),
  // A provider's address is where its key goes. (The app drops a saved key when its address is set or changed, #137.
  // A key that the person gives later goes to the address that is set then, so the address is set where it is shown.)
  // Choices that are no address run.
  setVoice: (args, name) => (setsVoiceAddress(args[0]) ? "`" + name + "` with a provider's web address says where that provider's key goes. Set an address in the app's window or on a paired phone, where it is shown. A command for it comes. Choices that are no address run here." : null),
  // The mode yolo gives each request of a chat a yes with no question. The others run.
  setChatProject: (args, name) => (args[2] === "yolo" ? givesYes(name) : null),
  startProjectChat: (args, name) => (args[2] === "yolo" ? givesYes(name) : null),
  // The level of approval: telling a looser one needs the present value, so any change is held.
  setPreferences: (args, name) => (isPlain(args[0]) && (Object.hasOwn(args[0], "approval") || Object.hasOwn(args[0], "access")) ? "`" + name + "` with an approval level or an access changes what the bots may do without a question. Set it in the app's window or on a paired phone. A command for it comes, and it shows this and asks." : null),
  // A Mac tool that is switched on lets the bots read or use an app of this Mac. Switching one off runs.
  setMacTool: (args, name) => (args[1] !== "off" ? "`" + name + "` gives the bots a tool of this Mac. Switch it on in the app's window, where it is shown. A command for it comes, and it shows this and asks. Switching a tool off runs here." : null),
};

/**
 * What `call` does with the app's call `name` given `args`, from the table: the sentence that
 * refuses it, or null when it may run (it is owed a command, and it is not held). A pure function.
 */
export function callRule(name, args = []) {
  const entry = Object.hasOwn(WORKSPACE, name) ? WORKSPACE[name] : null;
  if (!entry) return null;
  if ("command" in entry) return COVERED_BY_COMMAND(name, entry.command);
  if ("reason" in entry) return REFUSED_BY_REASON[entry.reason](name);
  return Object.hasOwn(HELD, name) ? HELD[name](args, name) : null;
}
const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};

/**
 * @param service  What desktop/terminal/serve.mjs built: { runtime, config(), setConfig(next),
 *   log, signIns, paths, version, started, keys(), stop(reason), revision(), waitForChange() }.
 * @returns { [method]: (args, { signal }) → value }
 */
export function controlApi(service) {
  const { runtime, log, signIns } = service;
  const { workspace, handlers, link, phone, providers } = runtime;
  const state = () => workspace.state;

  /** A bot by its id, or by its name when exactly one bot has it. */
  const bot = (ref) => {
    const wanted = text(ref, 200, "a bot's name or id");
    const bots = state().bots;
    const found = bots.find((entry) => entry.id === wanted) ?? (() => {
      const named = bots.filter((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
      if (named.length > 1) throw new ControlError("More than one bot is called " + wanted + ". Use its id (see `botkins bots list`).", "AMBIGUOUS");
      return named[0];
    })();
    if (!found) throw new ControlError("There is no bot called " + wanted + ". See `botkins bots list`.", "NOT_FOUND");
    return found;
  };
  const botView = (entry) => ({
    id: entry.id,
    name: entry.name,
    role: entry.role,
    instructions: entry.instructions,
    ...(entry.model && { model: entry.model }),
    ...(entry.primary && { primary: true }),
    chats: state().chats.filter((chat) => chat.botId === entry.id && !chat.temporary).length,
    working: state().chats.some((chat) => chat.botId === entry.id && workspace.active.has(chat.id)),
  });
  /** A model as `provider/id`, looked up in the catalog. */
  const selection = async (ref) => {
    const wanted = text(ref, 300, "a model, as provider/model (see `botkins models`)");
    const catalog = await workspace.models();
    const slash = wanted.indexOf("/");
    const found = catalog.find((model) => model.provider + "/" + model.id === wanted) ?? catalog.find((model) => model.id === wanted) ?? (slash > 0 ? catalog.find((model) => model.provider === wanted.slice(0, slash) && model.name.toLowerCase() === wanted.slice(slash + 1).toLowerCase()) : null);
    if (!found) throw new ControlError("No connected provider offers " + wanted + ". See `botkins models`.", "NOT_FOUND");
    return { model: found.id, provider: found.provider, ...(found.source && { source: found.source }) };
  };
  const device = (ref) => {
    const wanted = text(ref, 200, "a device's name or id");
    const devices = link.status().devices;
    const found = devices.find((entry) => entry.id === wanted) ?? (() => {
      const named = devices.filter((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
      if (named.length > 1) throw new ControlError("More than one device is called " + wanted + ". Use its id (see `botkins devices list`).", "AMBIGUOUS");
      return named[0];
    })();
    if (!found) throw new ControlError("No paired device is called " + wanted + ". See `botkins devices list`.", "NOT_FOUND");
    return found;
  };
  const deviceView = (entry) => ({
    id: entry.id,
    name: entry.name,
    ...(typeof entry.person === "string" && entry.person && { person: entry.person }),
    kind: entry.kind,
    platform: entry.platform,
    connected: entry.connected === true,
    ...(entry.memberId && { memberId: entry.memberId }),
    pairedAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : null,
    lastSeenAt: entry.lastSeenAt ? new Date(entry.lastSeenAt).toISOString() : null,
  });
  const routines = () => workspace.panels.routines;
  const routine = (ref) => {
    const wanted = text(ref, 200, "a routine's name or id");
    const all = routines().list();
    const found = all.find(({ chat }) => chat.id === wanted) ?? (() => {
      const named = all.filter(({ entry }) => String(entry.name ?? "").toLowerCase() === wanted.toLowerCase());
      if (named.length > 1) throw new ControlError("More than one routine is called " + wanted + ". Use its id (see `botkins routines list`).", "AMBIGUOUS");
      return named[0];
    })();
    if (!found) throw new ControlError("There is no routine called " + wanted + ". See `botkins routines list`.", "NOT_FOUND");
    return found;
  };
  const routineView = ({ chat, entry }) => ({
    ...routines().view(chat, entry),
    bot: state().bots.find((entry) => entry.id === chat.botId)?.name ?? null,
    botId: chat.botId,
    running: workspace.active.has(chat.id),
    // Runs are kept newest first.
    lastRun: state().runs.find((run) => run.chatId === chat.id)?.status ?? null,
  });
  const relayView = () => {
    const { relay } = link.status();
    return { enabled: relay.enabled === true, connected: relay.connected === true, url: relay.url, ...(relay.problem && { problem: relay.problem }) };
  };
  const pairingView = (pairing) => (pairing ? { code: pairing.code, url: pairing.url, expiresAt: new Date(pairing.expiresAt).toISOString(), qr: qrText(pairing.url) } : null);
  const chatView = (chat, after = 0) => {
    const task = workspace.active.get(chat.id);
    const messages = chat.messages.map((message, index) => ({ index, role: message.role, text: message.text ?? "", ...(message.interim && { interim: true }) })).filter((message) => message.index >= after && !message.interim);
    const request = workspace.interactions.snapshot().find((entry) => entry.chatId === chat.id);
    return {
      chatId: chat.id,
      working: !!task,
      stream: task?.stream ?? "",
      ...(task?.intent && { intent: task.intent }),
      messages,
      count: chat.messages.length,
      ...(request && { request: { id: request.id, kind: request.kind, title: request.title } }),
      run: state().runs.find((run) => run.chatId === chat.id) ?? null,
    };
  };
  /** Applies a whole config: saves it, makes the running service agree, and says what waits for a restart. */
  const applyConfig = async (next) => {
    const before = service.config();
    const { config, problems } = validate(next);
    if (problems.length) throw Object.assign(new ControlError(problems.join("\n"), "INVALID_CONFIG"), { problems });
    const keys = changedSettings(before, config);
    await service.setConfig(config);
    return { changed: keys, restart: keys.filter((key) => SETTINGS[key].restart) };
  };

  const api = {
    // ── The service ──────────────────────────────────────────────────────────────────────────
    async status() {
      const status = link.status();
      const memory = process.memoryUsage();
      const keys = service.keys();
      return {
        running: true,
        version: service.version,
        pid: process.pid,
        startedAt: new Date(service.started).toISOString(),
        uptimeSeconds: Math.round((Date.now() - service.started) / 1000),
        node: process.versions.node,
        platform: process.platform + "/" + process.arch,
        dataDir: service.paths.root,
        socket: service.paths.socket,
        memory: { rssMb: Math.round((memory.rss / 1048576) * 10) / 10, heapUsedMb: Math.round((memory.heapUsed / 1048576) * 10) / 10 },
        link: {
          enabled: status.enabled,
          ...(status.locked && { locked: true }),
          listening: status.listening,
          port: status.port,
          name: status.name,
          // Every address a pairing code offers: this computer's own, and the ones the settings add.
          addresses: status.listening ? link.hosts().filter((host) => !host.startsWith("relay!")) : [],
          pairing: !!status.pairing,
          devices: status.devices.length,
          connected: status.devices.filter((entry) => entry.connected).length,
        },
        relay: relayView(),
        workspace: {
          bots: state().bots.length,
          chats: state().chats.filter((chat) => !chat.temporary).length,
          routines: routines().list().length,
          working: workspace.active.size,
          waiting: workspace.interactions.snapshot().length,
        },
        secrets: keys ? { source: keys.source, where: keys.where } : { source: "file", where: "key files in the data folder (a trial run)" },
        vault: { locked: workspace.vault.locked === true, entries: workspace.vault.list().length },
        update: runtime.updates?.status() ?? { status: "unavailable" },
      };
    },
    "logs.read": ([options = {}], { signal }) => {
      const after = Number.isInteger(options.after) ? options.after : 0;
      if (options.wait) return log.wait({ after, ms: WAIT_MS, signal });
      return log.read({ after, ...(Number.isInteger(options.tail) && { tail: options.tail }) });
    },
    /** What `botkins doctor` can only learn from the running service. */
    async doctor() {
      const statuses = await workspace.providerStatuses(true);
      const status = link.status();
      return {
        version: service.version,
        node: process.versions.node,
        user: process.getuid?.() ?? null,
        link: { enabled: status.enabled, listening: status.listening, port: status.port, locked: status.locked === true },
        relay: relayView(),
        vault: { locked: workspace.vault.locked === true, ...(workspace.vault.reason && { reason: workspace.vault.reason }) },
        secrets: service.keys() ?? { source: "file", where: "key files in the data folder (a trial run)" },
        providers: statuses.map((entry) => ({ id: entry.id, name: entry.name, enabled: entry.enabled, installed: entry.installed !== false, connected: entry.connected === true, ...(entry.account && { account: entry.account }), ...(entry.plan && { plan: entry.plan }), ...(entry.message && { message: entry.message }), ...(entry.error && { error: entry.error }) })),
        desktopOnly: DESKTOP_ONLY,
      };
    },
    /** Stops the service, as its service manager would. For a `botkins serve` started by hand. */
    stop() {
      setImmediate(() => service.stop("asked to stop"));
      return { stopping: true };
    },
    /** Resolves when something changed (the workspace, a phone, the log), or after a while. For the dashboard. */
    "events.wait": ([after = 0], { signal }) => service.waitForChange({ after: Number(after) || 0, ms: WAIT_MS, signal }),

    // ── Pairing and devices ──────────────────────────────────────────────────────────────────
    /** Opens a pairing code: for the link's own few minutes, or for `minutes` (1 to 1440) when the code is handed on. */
    async "pair.start"([{ minutes } = {}] = []) {
      if (!link.status().enabled) throw new ControlError("Phone access is off. Turn it on with `botkins config set link.enabled true`.", "LINK_OFF");
      if (minutes === undefined) return pairingView(link.startPairing());
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw new ControlError("A pairing code stays open for 1 to 1440 minutes.", "BAD_ARGUMENT");
      return pairingView(link.startPairing(minutes * 60_000));
    },
    "pair.status": () => {
      const status = link.status();
      return { pairing: pairingView(status.pairing), devices: status.devices.map(deviceView) };
    },
    "pair.cancel": () => void link.cancelPairing(),
    "devices.list": () => link.status().devices.map(deviceView),
    "devices.rename": ([ref, name]) => {
      const found = device(ref);
      phone.renamePhone(found.id, text(name, 60, "the device a name"));
      return deviceView(device(found.id));
    },
    "devices.setPerson": ([ref, person]) => {
      const found = device(ref);
      // The person behind a device is the link's own to keep (desktop/link/server.mjs).
      if (typeof link.setDevicePerson !== "function") throw new ControlError("This version of Botkins doesn't keep a person's name for a device yet.", "UNSUPPORTED");
      link.setDevicePerson(found.id, typeof person === "string" ? person : "");
      return deviceView(device(found.id));
    },
    "devices.remove": ([ref]) => {
      const found = device(ref);
      phone.removePhone(found.id);
      return { removed: found.id, name: found.name };
    },

    // ── Bots ─────────────────────────────────────────────────────────────────────────────────
    "bots.list": () => state().bots.map(botView),
    "bots.get": ([ref]) => botView(bot(ref)),
    async "bots.add"([data = {}]) {
      const name = text(data.name, 48, "the bot a name");
      // The model is looked up first, so a bot is never left behind half made.
      const model = data.model ? await selection(data.model) : null;
      const id = await handlers.addBot({
        name,
        role: typeof data.role === "string" && data.role.trim() ? data.role : "Assistant",
        instructions: typeof data.instructions === "string" && data.instructions.trim() ? data.instructions : "Help with what you are asked, clearly and briefly.",
      });
      if (model) await workspace.setModel("bot", id, model);
      return botView(bot(id));
    },
    async "bots.edit"([ref, patch = {}]) {
      const found = bot(ref);
      const fields = {};
      for (const key of ["name", "role", "instructions"]) if (patch[key] !== undefined) fields[key] = patch[key];
      if (Object.keys(fields).length) handlers.updateBot(found.id, fields);
      if (patch.model !== undefined) await workspace.setModel("bot", found.id, patch.model === null || patch.model === "" ? null : await selection(patch.model));
      return botView(bot(found.id));
    },
    async "bots.remove"([ref]) {
      const found = bot(ref);
      await handlers.deleteBot(found.id);
      return { removed: found.id, name: found.name };
    },

    // ── Model providers and models ───────────────────────────────────────────────────────────
    "providers.list": async ([refresh]) =>
      (await workspace.providerStatuses(refresh === true)).map((entry) => ({
        id: entry.id,
        name: entry.name,
        enabled: entry.enabled,
        installed: entry.installed !== false,
        connected: entry.connected === true,
        ...(entry.account && { account: entry.account }),
        ...(entry.plan && { plan: entry.plan }),
        ...(entry.version && { version: entry.version }),
        ...(entry.message && { message: entry.message }),
        ...(entry.error && { error: entry.error }),
        ...(entry.install && { install: entry.install }),
        ...(entry.default && { default: true }),
        ...(signIns.token(entry.id) && { token: "kept by Botkins" }),
      })),
    "providers.enable": async ([id, on]) => void (await workspace.setProviderEnabled(String(id), on === true)),
    "providers.services": ([id, query]) => providers.require(String(id)).services(typeof query === "string" ? query.slice(0, 100) : ""),
    "providers.login": async ([id, options = {}]) => {
      if (typeof options.token === "string") return signIns.useToken(String(id), options.token, { service: options.service });
      return signIns.start(String(id), { service: options.service, method: options.method });
    },
    "providers.login.read": ([session, after], { signal }) => signIns.read(String(session), { after: Number(after) || 0, signal }),
    "providers.login.input": ([session, line]) => void signIns.input(String(session), line),
    "providers.login.cancel": ([session]) => signIns.cancel(String(session)),
    "providers.logout": ([id]) => signIns.signOut(String(id)),
    models: async () => (await workspace.models()).map((model) => ({ ref: model.provider + "/" + model.id, name: model.name, provider: model.provider, providerName: model.providerName, ...(model.group && { group: model.group }), available: model.available !== false, ...(model.recommended && { recommended: true }), efforts: model.efforts ?? [] })),
    "models.default": async ([ref]) => {
      if (ref !== undefined) await workspace.setModel("global", null, await selection(ref));
      return state().settings.model ?? null;
    },

    // ── Chat ─────────────────────────────────────────────────────────────────────────────────
    "chat.open": ([ref]) => {
      const found = bot(ref);
      return { chatId: handlers.createChat(found.id), bot: { id: found.id, name: found.name } };
    },
    "chat.list": ([ref]) => {
      const only = ref ? bot(ref).id : null;
      return state().chats.filter((chat) => !chat.temporary && (!only || chat.botId === only)).map((chat) => ({ id: chat.id, title: chat.title, botId: chat.botId, bot: state().bots.find((entry) => entry.id === chat.botId)?.name ?? null, messages: chat.messages.length, working: workspace.active.has(chat.id) }));
    },
    "chat.send": ([chatId, message]) => {
      const chat = workspace.chat(String(chatId));
      const before = chat.messages.length;
      handlers.send(chat.id, text(message, 200_000, "a message"), { delivery: "queue" });
      return { chatId: chat.id, after: before };
    },
    /** A chat as it stands. With `wait`, answers when it differs from what the caller has (`seen`: stream length, message count, working), or after a while. */
    async "chat.read"([chatId, options = {}], { signal }) {
      const chat = workspace.chat(String(chatId));
      const mark = (view) => view.stream.length + ":" + view.count + ":" + view.working + ":" + (view.request?.id ?? "");
      let view = chatView(chat, options.after);
      if (options.wait && typeof options.seen === "string") {
        const until = Date.now() + WAIT_MS;
        let revision = service.revision();
        while (mark(view) === options.seen && Date.now() < until && !signal?.aborted) {
          ({ revision } = await service.waitForChange({ after: revision, ms: Math.max(1, until - Date.now()), signal }));
          view = chatView(chat, options.after);
        }
      }
      return { ...view, seen: mark(view) };
    },
    "chat.stop": ([chatId]) => void handlers.stop(String(chatId)),
    /** The latest runs (a turn of a chat, a routine's run), newest first. */
    "runs.list": ([limit = 20]) =>
      state()
        .runs.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)))
        .map((run) => {
          const chat = state().chats.find((entry) => entry.id === run.chatId);
          return { id: run.id, chatId: run.chatId, title: run.title, status: run.status, ...(run.detail && { detail: String(run.detail).slice(0, 300) }), time: run.time ? new Date(run.time).toISOString() : null, bot: state().bots.find((entry) => entry.id === chat?.botId)?.name ?? null, ...(run.scheduleId != null && { routine: true }) };
        }),
    "chat.respond": ([requestId, answer]) => handlers.respond(String(requestId), answer),

    // ── Routines ─────────────────────────────────────────────────────────────────────────────
    "routines.list": ([ref]) => routines().list(ref ? bot(ref).id : undefined).map(routineView),
    "routines.run": ([ref]) => {
      const found = routine(ref);
      routines().run(found.chat.id).catch((error) => log.error("Routine run:", error.message));
      return routineView(routine(found.chat.id));
    },
    "routines.pause": ([ref]) => {
      const found = routine(ref);
      routines().setEnabled(found.chat.id, null, false);
      return routineView(routine(found.chat.id));
    },
    "routines.resume": ([ref]) => {
      const found = routine(ref);
      routines().setEnabled(found.chat.id, null, true);
      return routineView(routine(found.chat.id));
    },

    // ── Plugins ──────────────────────────────────────────────────────────────────────────────

    // ── Settings of the host ─────────────────────────────────────────────────────────────────
    "config.get": ([key]) => {
      const config = service.config();
      if (key === undefined || key === null) return config;
      if (!Object.hasOwn(SETTINGS, key)) throw new ControlError(key + " is not a setting. Run `botkins config get` to see them all.", "NOT_FOUND");
      return readSetting(config, key);
    },
    "config.describe": () => Object.entries(SETTINGS).map(([key, setting]) => ({ key, value: readSetting(service.config(), key), default: setting.default, about: setting.about, restart: setting.restart === true })),
    "config.set": async ([key, value]) => {
      let next;
      try {
        next = withSetting(service.config(), String(key), parseValue(String(key), value));
      } catch (error) {
        throw new ControlError(error.message, "INVALID_CONFIG");
      }
      return applyConfig(next);
    },
    "config.replace": ([next]) => applyConfig(next),
    "relay.status": () => relayView(),
    "relay.set": async ([on]) => {
      if (on === true && !service.config().link.enabled) throw new ControlError("Phone access is off, and the relay only runs with it. Turn it on with `botkins config set link.enabled true`.", "LINK_OFF");
      await applyConfig(withSetting(service.config(), "relay.enabled", on === true));
      return relayView();
    },
    "relay.reset": () => {
      phone.resetPhoneRelay();
      return relayView();
    },

    // ── Updates ──────────────────────────────────────────────────────────────────────────────
    "update.status": () => runtime.updates?.status() ?? { status: "unavailable", message: "This copy of Botkins doesn't update itself." },
    "update.check": async () => {
      if (!runtime.updates) throw new ControlError("This copy of Botkins doesn't update itself. Install the new release the way this one was installed.", "UNSUPPORTED");
      await runtime.updates.check();
      return runtime.updates.status();
    },
    "update.install": async () => {
      if (!runtime.updates) throw new ControlError("This copy of Botkins doesn't update itself. Install the new release the way this one was installed.", "UNSUPPORTED");
      await runtime.updates.install();
      return runtime.updates.status();
    },

    // ── Everything else the workspace can do ─────────────────────────────────────────────────
    /** One of the workspace's own calls, by name (the ones the desktop app's window makes). */
    call([name, args = []], context) {
      if (typeof name !== "string" || !Object.hasOwn(handlers, name)) throw new ControlError("The workspace has no call named " + name + ".", "UNKNOWN_METHOD");
      if (!Array.isArray(args)) throw new ControlError("A call's arguments are a list.", "BAD_ARGUMENT");
      // A call with a dotted name that this service has its own version of as well ("plugins.setEnabled", …)
      // runs that one, not the app's raw call. The rules are in the service's call: the revision that was
      // looked at, and the log line. So `call` cannot be a way round them. (Only a dotted name: "stop" and
      // "models" are other things here than in the app, and `call stop` must never stop the service.)
      if (name.includes(".") && Object.hasOwn(api, name)) return api[name](args, context);
      // The rest is by the table: a call that a command covers, or that has a reason, is not made here,
      // and a call that is held is not either (see `callRule`). What is left runs raw.
      const refusal = callRule(name, args);
      if (refusal) throw new ControlError(refusal, "NOT_FOR_CALL");
      refuseReferences(name, args);
      return handlers[name](...args);
    },
    methods: () => ({ control: Object.keys(api).sort(), workspace: Object.keys(handlers).sort() }),
  };
  // Tools (MCP servers), skills, and a bot's tools, skills and access (desktop/terminal/control-tools.mjs).
  Object.assign(api, toolsApi({ workspace, handlers, bot }));
  // A plugin by its name, bots by their names, and what of a plugin runs here (desktop/terminal/control-plugins.mjs).
  Object.assign(api, pluginsApi({ workspace, handlers, bot }));
  // The rest of the workspace, one file for each area (desktop/terminal/control-<area>.mjs). A name that is there already is not replaced.
  for (const area of [botsApi, chatsApi, routinesApi, projectsApi, wikiApi, prefsApi, credentialsApi, voiceApi]) {
    for (const [name, call] of Object.entries(area({ workspace, handlers, bot }))) {
      if (Object.hasOwn(api, name)) throw new Error("Two control calls have the name " + name + ".");
      api[name] = call;
    }
  }
  // The other plugin calls go by their own names ("plugins.browse", …), as a phone makes them.
  for (const name of Object.keys(handlers)) if (name.startsWith("plugins.") && !Object.hasOwn(api, name)) api[name] = (args) => handlers[name](...args);
  // A reference to a saved credential is refused by the named call too, before its own work starts.
  for (const name of WITHOUT_REFERENCES) {
    if (!Object.hasOwn(api, name)) continue;
    const own = api[name];
    api[name] = (args, context) => {
      refuseReferences(name, args);
      return own(args, context);
    };
  }
  return api;
}

/**
 * (method, args, context) → the value, for desktop/terminal/socket.mjs.
 *
 * A call that changes something leaves one line in the log once it is done: which call and which
 * thing (a bot, a device, a setting's name), never a value. `call` reaches the app's own calls by
 * name, so its line names that call and nothing of what it was given. So when a bot changed its
 * own tools from its shell, a person can see it afterwards.
 */
export function dispatcher(api, { log } = {}) {
  const said = (method, args, value) => {
    // Only the name of a call that the app has: what else was typed there is not written down.
    if (method === "call") return "call " + (typeof args?.[0] === "string" && Object.hasOwn(WORKSPACE, args[0]) ? (thingForLog(args[0]) ?? "") : "");
    if (!Object.hasOwn(CHANGES, method)) return null;
    const where = CHANGES[method];
    const thing = where === null ? null : thingForLog(typeof where === "function" ? where(args, value) : args?.[where]);
    return method + (thing ? " " + thing : "");
  };
  return async (method, args, context) => {
    if (!Object.hasOwn(api, method)) throw new ControlError("The service has no call named " + method + ". Is the command line newer than the service? Run `botkins status`.", "UNKNOWN_METHOD");
    let value;
    try {
      value = await api[method](args, context);
    } catch (error) {
      // A change that fails can still have done a part of its work (a plugin's files written, then
      // an error). So it leaves a line too, with other first words: no value, and no error text.
      const tried = log && said(method, args, undefined);
      if (tried) log("Tried from the command line: " + tried.trim() + " (it failed)");
      throw error;
    }
    const line = log && said(method, args, value);
    if (line) log("Changed from the command line: " + line.trim());
    return value;
  };
}
