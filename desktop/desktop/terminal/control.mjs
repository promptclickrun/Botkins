// What the `botkins` command line can ask the running service: one function for each call, by
// the name that goes over the control socket (desktop/terminal/socket.mjs).
//
// Whoever reaches the socket is the owner (the socket's own permissions decide that), so these
// calls do what the desktop app's own window can do. A few are the terminal host's own (status,
// logs, config, pairing); the rest are thin: they look a bot or a routine up by the name a person
// typed and hand the work to the workspace's own calls (`runtime.handlers`), which a paired phone
// uses too. "call" reaches any of those by name, for what has no command of its own yet.
//
// Every value is plain JSON: `--json` prints it as it is.
import { qrText } from "../link/qr.mjs";
import { changed as changedSettings, read as readSetting, SETTINGS, validate, withSetting, parseValue } from "./config.mjs";
import { ControlError } from "./socket.mjs";
import { DESKTOP_ONLY } from "../host/headless.mjs";

const WAIT_MS = 25_000;
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
    "plugins.list": () => workspace.plugins.list(),

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
    call([name, args = []]) {
      if (typeof name !== "string" || !Object.hasOwn(handlers, name)) throw new ControlError("The workspace has no call named " + name + ".", "UNKNOWN_METHOD");
      if (!Array.isArray(args)) throw new ControlError("A call's arguments are a list.", "BAD_ARGUMENT");
      return handlers[name](...args);
    },
    methods: () => ({ control: Object.keys(api).sort(), workspace: Object.keys(handlers).sort() }),
  };
  // The plugin calls go by their own names ("plugins.install", …), as a phone makes them.
  for (const name of Object.keys(handlers)) if (name.startsWith("plugins.") && !Object.hasOwn(api, name)) api[name] = (args) => handlers[name](...args);
  return api;
}

/** (method, args, context) → the value, for desktop/terminal/socket.mjs. */
export function dispatcher(api) {
  return (method, args, context) => {
    if (!Object.hasOwn(api, method)) throw new ControlError("The service has no call named " + method + ". Is the command line newer than the service? Run `botkins status`.", "UNKNOWN_METHOD");
    return api[method](args, context);
  };
}
