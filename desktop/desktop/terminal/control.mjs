// What the `botkins` command line can ask the running service: one function for each call, by
// the name that goes over the control socket (desktop/terminal/socket.mjs).
//
// Whoever reaches the socket is the owner (the socket's own permissions decide that), so these
// calls do what the desktop app's own window can do. A few are the terminal host's own (status,
// logs, config, pairing); the rest are thin: they look a bot or a routine up by the name a person
// typed and hand the work to the workspace's own calls (`runtime.handlers`), which a paired phone
// uses too. There is no call that reaches the app's calls by name: each one has a command, or a
// reason that it has none (desktop/terminal/coverage.mjs).
//
// Every value is plain JSON: `--json` prints it as it is.
import { introduce, serialLines } from "../link/gadget-setup.mjs";
import { Failure } from "../link/tools.mjs";
import { isSilentMessage, visibleStream } from "../link/silent-reply.mjs";
import { withoutProactiveAlerts } from "../link/team.mjs";
import { qrText } from "../link/qr.mjs";
import { changed as changedSettings, read as readSetting, SETTINGS, validate, withSetting, parseValue } from "./config.mjs";
import { ControlError } from "./socket.mjs";
import { DESKTOP_ONLY } from "../host/headless.mjs";
import { CHANGES, thingForLog } from "./coverage.mjs";
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
import { spacesApi } from "./control-spaces.mjs";
import { sharingApi } from "./control-sharing.mjs";
import { teamApi } from "./control-team.mjs";
import { appsApi } from "./control-apps.mjs";
import { profileApi } from "./control-profile.mjs";
import { nodeApi } from "./control-node.mjs";
import { checkReach } from "./reach.mjs";
import { normaliseConfig } from "../providers/keyed/config.mjs";

const WAIT_MS = 25_000;
// false = a caller on the socket gives values that it has, and cannot use a saved credential by reference. true = references are taken as the window and a phone take them.
// The owner agreed to this on 2026-11-21: "nothing that reaches a saved secret runs from the command line, so unlocking a password manager and using a saved credential by reference stay in the window and on the phone."
export const CREDENTIAL_REFERENCES_ON_THE_SOCKET = false;
/**
 * A reference to a saved credential, { "$credential": id }, is resolved by the app to the saved
 * secret. A caller on the socket cannot read a saved credential, but it could send one to an
 * address that it chose (a plugin it wrote, a secure request that a bot made). So these calls
 * refuse a reference anywhere in what they are given.
 */
const WITHOUT_REFERENCES = ["plugins.install", "plugins.configure", "chat.respond"];
// The sentence names what the call at hand has: only a plugin's install and configure take --settings.
const CHOSEN_IN_THE_APP = "A saved credential is chosen in the app's window or on a paired phone. From the command line, give the value itself";
const NO_REFERENCES = (name) => CHOSEN_IN_THE_APP + (name.startsWith("plugins.") ? " (`--settings`, or the hidden question)." : ".");
const holdsReference = (value, depth = 0) => depth <= 8 && value !== null && typeof value === "object" && (Object.hasOwn(value, "$credential") || Object.values(value).some((inner) => holdsReference(inner, depth + 1)));
/** Refuses the arguments of a call that may not hold a reference to a saved credential (see above). */
const refuseReferences = (name, args) => {
  if (!CREDENTIAL_REFERENCES_ON_THE_SOCKET && WITHOUT_REFERENCES.includes(name) && holdsReference(args)) throw new ControlError(NO_REFERENCES(name), "BAD_ARGUMENT");
};
const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};

/**
 * A bot's voice of its own with a change put into it (`botkins bots edit --reading-voice …`). A field
 * that is named changes; "" or null takes it back to Settings › Voice; the rest stays. Another
 * provider for a part drops the model and voice it had, which wouldn't fit it (the speed stays).
 * The app checks the result (desktop/link/voice.mjs, botVoiceField).
 */
function mergeVoice(current, change) {
  if (change === null || typeof change !== "object" || Array.isArray(change)) throw new ControlError("Give the bot's voice as reading and live choices.", "BAD_ARGUMENT");
  const next = {};
  for (const section of ["tts", "live"]) {
    const had = current?.[section] ?? {};
    const given = change[section];
    if (given === undefined) {
      if (Object.keys(had).length) next[section] = { ...had };
      continue;
    }
    if (given === null || typeof given !== "object" || Array.isArray(given)) throw new ControlError("Give the bot's voice as reading and live choices.", "BAD_ARGUMENT");
    const moved = given.provider !== undefined && (given.provider || undefined) !== had.provider;
    const part = moved ? { ...(section === "tts" && had.speed !== undefined && { speed: had.speed }) } : { ...had };
    for (const [key, value] of Object.entries(given)) {
      if (value === "" || value === null) delete part[key];
      else part[key] = value;
    }
    if (Object.keys(part).length) next[section] = part;
  }
  return Object.keys(next).length ? next : null;
}

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
    ...(entry.voice && { voice: entry.voice }),
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
  /** A paired device that is a gadget, by name or id. */
  const gadget = (ref) => {
    const found = device(ref);
    if (found.kind !== "gadget") throw new ControlError(found.name + " isn't a gadget. See `botkins devices list`.", "NOT_FOUND");
    if (typeof link.configureGadget !== "function") throw new ControlError("This version of Botkins has no gadget settings yet.", "UNSUPPORTED");
    return found;
  };
  const gadgetView = (id) => {
    const listed = link.devices().find((entry) => entry.id === id);
    return { id, name: listed?.name, connected: listed?.connected === true, ...listed?.gadget };
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
    if (!workspace.inChat(chat.id, "owner")) chat = withoutProactiveAlerts(chat);
    const messages = chat.messages.map((message, index) => ({ index, role: message.role, text: message.text ?? "", ...(message.interim && { interim: true }) })).filter((message) => message.index >= after && !message.interim && !isSilentMessage(message));
    const request = workspace.interactions.snapshot().find((entry) => entry.chatId === chat.id);
    return {
      chatId: chat.id,
      working: !!task,
      stream: visibleStream(task?.stream),
      ...(task?.intent && { intent: task.intent }),
      messages,
      count: chat.messages.length,
      ...(request && { request: { id: request.id, kind: request.kind, title: request.title, ...(request.dispatch && { dispatch: true }), ...((request.dispatch || request.review) && { detail: request.detail, label: request.label }) } }),
      run: state().runs.find((run) => run.chatId === chat.id && (!chat.main || run.forkId === chat.activeFork)) ?? null,
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
        nodeHost: workspace.nodeHost.view(),
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
        // What a bot's shell finds: asked of this process, with its own environment (desktop/terminal/reach.mjs).
        botShell: await checkReach(),
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
      // (The app's socket has no `config set`: the app's own Settings turn phone access on.)
      if (!link.status().enabled) throw new ControlError("Phone access is off. " + (service.inApp ? "Turn it on in the app's Settings, under Phone." : "Turn it on with `botkins config set link.enabled true`."), "LINK_OFF");
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
    /**
     * Sets a gadget up over a USB port of this computer (gadget/docs/contract.md): reads its key,
     * pairs it by introduction and hands it the Wi-Fi network. The password goes to the gadget and nowhere else.
     */
    /** A paired gadget, by name or id, with its settings and Wi-Fi as the device list shows them. */
    "gadgets.get": ([ref]) => gadgetView(gadget(ref).id),
    /** Volume, microphone, mute, brightness, the screen's timers, and the bot (desktop/link/gadget.mjs checks each). */
    "gadgets.set": ([ref, patch = {}]) => {
      const found = gadget(ref);
      const { bot: botRef, ...settings } = patch && typeof patch === "object" ? patch : {};
      try {
        link.configureGadget(found.id, { ...settings, ...(botRef !== undefined && { botId: bot(botRef).id }) });
      } catch (error) {
        throw new ControlError(error.message, "BAD_ARGUMENT");
      }
      return gadgetView(found.id);
    },
    /** A Wi-Fi network for a gadget: `{ add: { ssid, password } }` or `{ forget: ssid }`. The password is in no log line. */
    "gadgets.wifi": ([ref, change]) => {
      const found = gadget(ref);
      try {
        link.gadgetWifi(found.id, change);
      } catch (error) {
        throw new ControlError(error.message, "BAD_ARGUMENT");
      }
      return { ...gadgetView(found.id), queued: true };
    },
    "gadgets.restart": ([ref]) => {
      const found = gadget(ref);
      link.restartGadget(found.id);
      return gadgetView(found.id);
    },
    async "gadgets.add"([{ port, name, bot: botRef, wifi } = {}] = []) {
      if (!link.status().enabled) throw new ControlError("Phone access is off, so a gadget couldn't reach this computer. " + (service.inApp ? "Turn it on in the app's Settings, under Phone." : "Turn it on with `botkins config set link.enabled true`."), "LINK_OFF");
      if (typeof link.addGadget !== "function") throw new ControlError("This version of Botkins has no gadgets yet.", "UNSUPPORTED");
      const path = text(port, 200, "the gadget's serial port");
      const botId = botRef === undefined ? undefined : bot(botRef).id;
      if (wifi !== undefined && (typeof wifi?.ssid !== "string" || !wifi.ssid || wifi.ssid.length > 32 || typeof wifi.password !== "string" || wifi.password.length > 64)) throw new ControlError("Give the Wi-Fi network's name and its password.", "BAD_ARGUMENT");
      let io;
      try {
        io = serialLines(path);
        const done = await introduce({ io, add: (input) => link.addGadget(input), ...(wifi && { wifi }), ...(name !== undefined && { name: text(name, 60, "the gadget a name") }), ...(botId && { botId }) });
        return { ...deviceView(device(done.deviceId)), board: done.board, firmware: done.firmware, mac: done.mac };
      } catch (error) {
        // The introducer's sentences are for a person (a cable, a password, a network); anything else is this computer's own trouble.
        if (error instanceof ControlError) throw error;
        throw new ControlError(error instanceof Failure ? error.message : "That didn't work on this computer.", "GADGET_SETUP");
      } finally {
        io?.close();
      }
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
      // A voice of its own: what is named changes and the rest stays; "" goes back to Settings › Voice; null clears it all.
      if (patch.voice !== undefined) fields.voice = patch.voice === null ? null : mergeVoice(found.voice, patch.voice);
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
        // A provider that answers on a key: what it takes, whether it has one, and what it is still missing. Never the key.
        ...(entry.keyed && { keyed: { hasKey: entry.keyed.hasKey, keyOptional: entry.keyed.keyOptional, fields: entry.keyed.fields, config: entry.keyed.config, needs: entry.keyed.needs, ...(entry.keyed.keyUrl && { keyUrl: entry.keyed.keyUrl }) } }),
      })),
    // The settings of OpenRouter, Azure Foundry or an OpenAI endpoint. What is given replaces that setting and the rest stay; `clearModels` empties the list.
    // A key goes to the address that is set, so a new address while a key is kept needs the mark `{ agreed: true }` as the last argument (a caller that showed the person where the key will go and got a yes).
    "providers.set": async ([id, patch = {}, mark]) => {
      const provider = providers.require(String(id));
      if (typeof provider.configure !== "function") throw new ControlError(provider.name + " has no settings.", "BAD_ARGUMENT");
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new ControlError("Give the settings as an object.", "BAD_ARGUMENT");
      const { clearModels, ...given } = patch;
      const before = provider.config();
      const next = { ...before, ...given, ...(clearModels === true && { models: [] }) };
      let after;
      try {
        after = normaliseConfig(provider.id, next);
      } catch (error) {
        throw new ControlError(error.message, "BAD_ARGUMENT");
      }
      const to = after.endpoint ?? after.baseUrl;
      if (to && to !== (before.endpoint ?? before.baseUrl) && signIns.hasToken(provider.id) && mark?.agreed !== true)
        throw new ControlError("The key that Botkins keeps for " + provider.name + " is sent to the address that is set, and this changes it to " + new URL(to).host + ". That needs a yes. Show that to the person, and give `{ \"agreed\": true }` as the last argument (on the command line, `botkins providers set " + provider.id + " … --yes`).", "NEEDS_YES");
      const status = await handlers.providerConfigure(provider.id, next).catch((error) => {
        throw error?.code === "BAD_CONFIG" ? new ControlError(error.message, "BAD_ARGUMENT") : error;
      });
      return { id: provider.id, name: provider.name, enabled: status.enabled, connected: status.connected === true, hasKey: status.keyed?.hasKey === true, needs: status.keyed?.needs ?? null, config: status.keyed?.config ?? {} };
    },
    "providers.enable": async ([id, on]) => void (await workspace.setProviderEnabled(String(id), on === true)),
    "providers.services": ([id, query]) => providers.require(String(id)).services(typeof query === "string" ? query.slice(0, 100) : ""),
    // A token that replaces the one Botkins keeps loses the old one: that needs the mark `{ agreed: true }` as the last argument. A first token loses nothing.
    "providers.login": async ([id, options = {}, mark]) => {
      if (typeof options.token === "string") {
        if (signIns.hasToken(String(id)) && !(mark?.agreed === true)) throw new ControlError("A new token for " + String(id) + " replaces the token that Botkins keeps for it, and the old token is lost. That needs a yes. Show that to the person, and give `{ \"agreed\": true }` as the last argument (on the command line, `botkins providers login " + String(id) + " --token --yes`).", "NEEDS_YES");
        return signIns.useToken(String(id), options.token, { service: options.service });
      }
      // A provider that answers on a key has no sign-in to run: the caller gives the key, as a token.
      if (typeof providers.require(String(id)).configure === "function") throw new ControlError(providers.require(String(id)).name + " takes a key, not a sign-in page. Give it as a token.", "NEEDS_KEY");
      return signIns.start(String(id), { service: options.service, method: options.method });
    },
    "providers.login.read": ([session, after], { signal }) => signIns.read(String(session), { after: Number(after) || 0, signal }),
    "providers.login.input": ([session, line]) => void signIns.input(String(session), line),
    "providers.login.cancel": ([session]) => signIns.cancel(String(session)),
    "providers.logout": ([id, mark]) => {
      if (mark?.agreed !== true) throw new ControlError("Signing " + String(id) + " out removes the token that Botkins keeps for it and the provider's own sign-in, and neither can be got back. That needs a yes. Show that to the person, and give `{ \"agreed\": true }` as the last argument (on the command line, `botkins providers logout " + String(id) + " --yes`).", "NEEDS_YES");
      return signIns.signOut(String(id));
    },
    models: async () => (await workspace.models()).map((model) => ({ ref: model.provider + "/" + model.id, name: model.name, provider: model.provider, providerName: model.providerName, ...(model.group && { group: model.group }), available: model.available !== false, ...(model.recommended && { recommended: true }), ...(model.fastModes && { fastModes: Object.keys(model.fastModes) }), efforts: model.efforts ?? [] })),
    "models.speed": async ([scope, ref, speed]) => {
      if (!["chat", "bot", "global"].includes(scope) || !["inherit", "off", "fast", "ultrafast"].includes(speed) || (scope === "global" && speed === "inherit"))
        throw new ControlError("Choose a valid scope and fast mode.", "BAD_ARGUMENT");
      const id = scope === "bot" ? bot(ref).id : ref;
      await workspace.setModel(scope, id, undefined, speed === "inherit" ? null : speed);
      return { scope, id, speed };
    },
    "models.default": async ([ref]) => {
      if (ref !== undefined) await workspace.setModel("global", null, await selection(ref));
      return state().settings.model ?? null;
    },
    /** The Default routines model: `ref` sets it (with a thinking level, `effort`), null clears it, nothing reads it. */
    "models.chat": async ([id, ref, effort]) => {
      const chat = workspace.chat(String(id));
      const model = ref === "inherit" ? null : { ...(await selection(ref)), ...(effort && { reasoningEffort: String(effort) }) };
      await workspace.setModel("chat", chat.id, model);
      return workspace.effectiveModel(chat);
    },
    "models.routines": async ([ref, effort]) => {
      if (ref === null || ref === "") await workspace.setModel("routines", null, null);
      else if (ref !== undefined) await workspace.setModel("routines", null, { ...(await selection(ref)), ...(effort && { reasoningEffort: String(effort) }) });
      return state().settings.routineModel ?? null;
    },

    // ── Chat ─────────────────────────────────────────────────────────────────────────────────
    "chat.main": ([ref]) => {
      const found = bot(ref);
      return { chatId: handlers.mainChat(found.id), bot: { id: found.id, name: found.name } };
    },
    "chat.open": ([ref]) => {
      const found = bot(ref);
      return { chatId: handlers.createChat(found.id), bot: { id: found.id, name: found.name } };
    },
    "chat.list": ([ref]) => {
      const only = ref ? bot(ref).id : null;
      return state().chats.filter((chat) => !chat.temporary && (!only || chat.botId === only)).map((chat) => ({ id: chat.id, title: chat.title, botId: chat.botId, bot: state().bots.find((entry) => entry.id === chat.botId)?.name ?? null, messages: chat.messages.length, working: workspace.active.has(chat.id) }));
    },
    /** The script command that a message would run or set up, { name, args, via? }, or null. The command line shows it to the person before it sends one. */
    "chat.scriptCommand": ([chatId, message]) => {
      workspace.chat(String(chatId));
      return typeof message === "string" ? workspace.scriptCommandIn(message) : null;
    },
    /**
     * A message that is a script command runs a script on this computer with the words after the name, which a bot's shell
     * could choose; one that sets up a schedule of it (`/every 1m /name`) arms it. So it is sent as a script command only with
     * `{ agreed: true }` as the last argument: the caller showed the person the command and its words and got a yes (the command
     * line asks at a terminal, or takes --yes). Without it the call is refused. Any other message is plain text and needs no mark.
     */
    "chat.send": ([chatId, message, mark]) => {
      const chat = workspace.chat(String(chatId));
      const before = chat.messages.length;
      const script = typeof message === "string" ? workspace.scriptCommandIn(message) : null;
      const agreed = mark !== null && typeof mark === "object" && !Array.isArray(mark) && mark.agreed === true;
      if (script && !agreed)
        throw new ControlError("/" + script.name + " is a script command" + (script.via ? ", and /" + script.via + " would run it again and again" : "") + ": it runs a script on this computer with the words after its name. Show the person the command and its words, and give `{ \"agreed\": true }` as the last argument (on the command line, `botkins chat` asks at a terminal, or takes --yes).", "NEEDS_YES");
      handlers.send(chat.id, text(message, 200_000, "a message"), { delivery: "queue", ...(script && { allowScript: true }) });
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
    // The answer says which chat and which kind of request (never its text or the answer's), for the log line (coverage.mjs). The request is gone once it is answered, so it is read first.
    // A yes to a request (`approve`, `today` or `remember`) needs the mark `{ agreed: true }` as the last argument: a bot's shell must not approve its own request by a quiet call. A no, a cancel and an answer to a question need none.
    "chat.respond": async ([requestId, answer, mark]) => {
      if (["approve", "today", "remember"].includes(answer?.action) && !(mark !== null && typeof mark === "object" && !Array.isArray(mark) && mark.agreed === true))
        throw new ControlError("A yes to a request that waits in a chat needs a yes of the person. Show the request to the person, and give `{ \"agreed\": true }` as the last argument (on the command line, `botkins chat` asks the person at a terminal; no flag gives it).", "NEEDS_YES");
      const asked = workspace.interactions.snapshot().find((entry) => entry.id === String(requestId));
      await handlers.respond(String(requestId), answer);
      return { chatId: asked?.chatId ?? null, kind: asked?.kind ?? null, answered: answer?.action === "deny" || answer?.action === "cancel" ? "no" : "yes" };
    },

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

    methods: () => ({ control: Object.keys(api).sort(), workspace: Object.keys(handlers).sort() }),
  };
  // Tools (MCP servers), skills, and a bot's tools, skills and access (desktop/terminal/control-tools.mjs).
  Object.assign(api, toolsApi({ workspace, handlers, bot, signIns, log: (line) => log?.info?.(line) }));
  // A plugin by its name, bots by their names, and what of a plugin runs here (desktop/terminal/control-plugins.mjs).
  Object.assign(api, pluginsApi({ workspace, handlers, bot, signIns, log: (line) => log?.info?.(line) }));
  // The rest of the workspace, one file for each area (desktop/terminal/control-<area>.mjs). A name that is there already is not replaced.
  for (const area of [botsApi, chatsApi, routinesApi, projectsApi, wikiApi, prefsApi, credentialsApi, voiceApi, spacesApi, sharingApi, teamApi, appsApi, nodeApi]) {
    for (const [name, call] of Object.entries(area({ workspace, handlers, bot, signIns, selection }))) {
      if (Object.hasOwn(api, name)) throw new Error("Two control calls have the name " + name + ".");
      api[name] = call;
    }
  }
  for (const [name, call] of Object.entries(profileApi({ profile: service.profile }))) {
    if (Object.hasOwn(api, name)) throw new Error("Two control calls have the name " + name + ".");
    api[name] = call;
  }
  // The other plugin calls go by their own names ("plugins.browse", …), as a phone makes them.
  for (const name of Object.keys(handlers)) if ((name.startsWith("plugins.") || name.startsWith("piPackages.") || name.startsWith("skillsCatalog.") || name.startsWith("mcpCatalog.") || name === "skills.upload") && !Object.hasOwn(api, name)) api[name] = (args) => handlers[name](...args);
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
 * thing (a bot, a device, a setting's name), never a value. So when a bot changed its own tools
 * from its shell, a person can see it afterwards.
 */
export function dispatcher(api, { log } = {}) {
  const said = (method, args, value) => {
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
