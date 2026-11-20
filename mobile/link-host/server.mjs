// The Botkins link: lets a paired phone use the desktop app over the local network or a tailnet.
//
// Plain HTTP carries it, and the link encrypts every message itself, so it needs no certificate:
//   GET  /botkins/v1/hello    who this computer is (public)
//   POST /botkins/v1/pair     a phone that knows the pairing code becomes a device
//   POST /botkins/v1/session  a device opens a session (fresh keys each time)
//   POST /botkins/v1/rpc      one sealed call, answered sealed. "link.sync" waits for changes.
//
// Keys: both sides hold an X25519 key. The pairing code salts the first shared key, so only a
// phone that saw the code (and, from the QR code, this computer's real key) can pair. A session
// mixes a one-time key exchange into the device key, and every message in it is
// ChaCha20-Poly1305 under a numbered nonce that is accepted once.
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Credentials, scrub } from "./credentials.mjs";
import { agree, b64u, box, cleanCode, hkdf, INFO, newCode, newKeyPair, open, random, seal, seqNonce, unb64u, unbox } from "./crypto.mjs";
import { DeviceTools } from "./device.mjs";
import { cleanPresenceKey, GRANT_CAPABILITY, ScreenGrants } from "./grant.mjs";
import { REMOTE_METHODS, remoteArgs } from "./methods.mjs";
import { isNear, reachable } from "./net.mjs";
import { baseParts, CHAT_PAGE, chatPart, runPart, runsByChat } from "./parts.mjs";
import { PullRequests } from "./prs.mjs";
import { Push } from "./push.mjs";
import { cleanRelayUrl, RelayLink, roomOf } from "./relay.mjs";
import { Screen } from "./screen.mjs";
import { cleanLook, LinkStore, SCREEN_MODES } from "./store.mjs";
import { Failure, searchDirs } from "./tools.mjs";
import { Voice } from "./voice.mjs";
import { Uploads } from "./uploads.mjs";

export const PROTOCOL = 1;
const PREFIX = "/botkins/v1/";
// A sealed call may carry a file part (4 MB, as base64 and sealed); the pairing steps are tiny.
const MAX_RPC_BODY = 6 * 1024 * 1024;
const MAX_BODY = 64 * 1024;
const PAIR_TTL = 5 * 60_000;
// Wrong pairing codes: a source gets 8 tries for one open code, and the code is withdrawn only after 200
// wrong tries from everyone together (it has 60 bits, so that stays safe). Per-source tables stay small.
const PAIR_TRIES_PER_SOURCE = 8;
const PAIR_TRIES_IN_ALL = 200;
const FAIL_WINDOW = 10_000;
const FAIL_PER_SOURCE = 20; // failed attempts in the window before that source is refused
const FAIL_BACKSTOP = { http: 200, relay: 400 }; // the same for a whole way in, so many sources can't burn CPU without limit
const MAX_SOURCES = 256;
const MAX_NONCES = 64; // session nonces remembered for each phone, to refuse a recorded session request
const SESSION_IDLE = 12 * 60 * 60_000;
const MAX_SESSIONS = 48;
const MAX_SESSIONS_PER_DEVICE = 6;
const MAX_PER_ADDRESS = 24; // connections one address may hold open
const WINDOW = 4096;
const MAX_WAIT = 30_000;
const PUMP_MS = 60;
const MAX_WATCH = 4;
/** What a phone can ask this computer for beyond the app's own calls (Meta.capabilities). */
// "maintenance-v1": this copy lets a phone clear the cache and send the computer's own test notification.
const CAPABILITIES = ["credentials-v1", "screen-v1", "prs-v1", "uploads-v1", "relay-v1", "push-v1", "device-v1", "voice-v1", "devices-v1", "maintenance-v1"];
/** A custom view (an html block): the page a bot wrote and its data, at the sizes the desktop app keeps them to. */
const MAX_FRAME_HTML = 300_000;
const MAX_FRAME_DATA = 200_000;
const FRAME_ID = /^[0-9a-f-]{36}$/;
const MAX_VOICE_AUDIO = 5 * 1024 * 1024; // what one call can carry, well under the size of a sealed call
/** The one tool a live voice has: the voice only talks; the bot does the work. The phone runs it by sending the message to the chat. */
const ASK_BOT = {
  name: "ask_bot",
  description: "Hands the person's request to the bot, which can use its tools, files and memory, and returns the bot's answer. Use it for anything beyond small talk: questions about their work, anything to look up, do, remember or change.",
  parameters: { type: "object", properties: { message: { type: "string", description: "The request, in the person's own words." } }, required: ["message"], additionalProperties: false },
};
const MAX_WAITERS = 2; // "link.sync" calls a session may have waiting at once
const SYSTEM_ERROR = "That didn't work on your computer.";

/**
 * Failed pairing and session attempts in the last 10 seconds for one way in (HTTP, or the relay): all
 * together, and for each source (an address, or a relay `from`). Only failures are recorded, so a
 * success costs nothing and never trips anything. The table of sources is bounded.
 */
class Failures {
  constructor(backstop) {
    this.backstop = backstop;
    this.all = [];
    this.by = new Map();
  }
  recent(list, now = Date.now()) {
    while (list.length && now - list[0] >= FAIL_WINDOW) list.shift();
    return list;
  }
  /** This source has failed too often lately. */
  blocked(source) {
    return this.recent(this.by.get(source) ?? []).length >= FAIL_PER_SOURCE;
  }
  /** The whole way in has. */
  tripped() {
    return this.recent(this.all).length >= this.backstop;
  }
  add(source) {
    const now = Date.now();
    this.all.push(now);
    const mine = this.recent(this.by.get(source) ?? [], now);
    mine.push(now);
    this.by.delete(source);
    this.by.set(source, mine);
    // Sources that went quiet are forgotten, oldest first.
    for (const [name, times] of this.by) {
      if (this.by.size <= MAX_SOURCES && this.recent(times, now).length) break;
      this.by.delete(name);
    }
  }
}

class Refused extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}
/**
 * An error as a phone is told of it. This code's own sentences (Failure, Refused) and the desktop's own
 * messages, which are written for people, pass as they are. A system error (a file that is missing, a
 * refused connection) names paths and internals, so it becomes one plain sentence.
 */
function plain(error) {
  if (error instanceof Failure || error instanceof Refused) return error.message;
  const code = error?.code;
  if (typeof error?.errno === "number" || typeof error?.syscall === "string" || (typeof code === "string" && /^(E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/.test(code))) return SYSTEM_ERROR;
  return String(error?.message ?? error);
}
/** A reply that is already JSON text, so a large part isn't serialized twice. */
class Json {
  constructor(text) {
    this.text = text;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Refused(413, "too_large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export class LinkHost extends EventEmitter {
  /**
   * @param options.dir      Folder for link.json (the identity and the paired phones).
   * @param options.backend  The desktop app:
   *   info()            → { app, version, platform }
   *   snapshot()        → the workspace state
   *   call(name, args)  → runs one of the app's own calls
   *   subscribe(fn)     → fn() on every change; returns a function that stops it
   *   extras?           → { name: fn } more calls, reached as "link.<name>"
   *   capabilities?     → more names for Meta.capabilities, for what the app supports itself ("looks-v2")
   *   voice?            → the app's own speech helpers, for voice.mjs: { local?, codex? } (see VOICE.md)
   *   frames?           → { page(id) → { html, data }, chatFor?(id) → chat id or null }: the custom views
   *                        (html blocks) of panels and cards, as their bots wrote them, so a phone can
   *                        draw one. With it the link has "frames-v1" and answers "link.frame.*".
   *   attention?()      → { focused, chatId? }: the person is looking at the app's own window (and at
   *                        that chat), so a reply there needs no notification on a phone
   *   setLook?(id, look) → saves a bot's Botkin ({ head, palette }) on the bot itself. An app that
   *                        has this keeps `look` on each bot in its state, and the link stores no looks.
   *   screen?           → { displays(), capture({ display, maxWidth, quality }), permissions?() }: how
   *                        to take pictures of the screen (see screen.mjs). Without it macOS uses its
   *                        own tools and other systems can't show the screen.
   * @param options.port     Listen here instead of the saved port (tests use 0).
   * @param options.protect / options.reveal  Wraps the private key and the credential vault's key at rest (a keychain).
   * @param options.extraHosts  More addresses to offer phones, such as "127.0.0.1" for a simulator.
   * @param options.searchPath  Folders to find command-line tools in (password managers, gh, xdotool). Tests pass their own.
   * @param options.managerSearchPath  Folders to find only the password managers' tools in, when they
   *                                   differ from `searchPath` (a trial run that must not start the person's own).
   * @param options.screenInput  Replaces how clicks and typing are posted. Tests pass one, so nothing is really clicked.
   * @param options.fetch  Replaces the fetch notifications are sent with (tests pass one, so nothing leaves the machine).
   * @param options.relay  `false` keeps the relay off for this instance, whatever is saved (tests and the demo
   *   computer). An object { url?, WebSocket?, timers? } overrides the saved address, the socket class and the
   *   clock. Without it the saved settings apply (see setRelay and relay.mjs).
   */
  constructor({ dir, backend, port, protect, reveal, extraHosts = [], searchPath, managerSearchPath, screenInput, relay, fetch, log = () => {} }) {
    super();
    Object.assign(this, { backend, log, portOverride: port, extraHosts });
    this.relayOptions = relay === false ? null : relay && typeof relay === "object" ? relay : {};
    this.relayLink = null;
    this.store = new LinkStore(dir, { protect, reveal });
    this.credentials = new Credentials({ dir, protect, reveal, searchPath: managerSearchPath ?? searchPath, onChange: () => this.changed() });
    this.uploads = new Uploads({ dir, log: (line) => this.log(line) });
    this.prs = new PullRequests({ backend, searchPath });
    this.screen = new Screen({
      adapter: () => this.backend.screen,
      mode: () => this.store.data.screen,
      paired: (deviceId) => !!this.store.device(deviceId),
      log: (line) => this.log(line),
      inject: screenInput,
      dirs: searchDirs(searchPath),
      emit: (device, started) => {
        // The desktop's page can show who is watching.
        this.emit("screen", { device, started });
        this.emit("status");
      },
    });
    // Speech through this computer's providers, for the app itself and for phones (voice.mjs).
    this.voice = new Voice({ dir, protect, reveal, adapter: () => this.backend.voice, onChange: () => this.changed(), log: (line) => this.log(line), ...(fetch && { fetch }) });
    // Notifications for phones, and the tools bots can run on one (push.mjs, device.mjs).
    this.push = new Push({
      store: this.store,
      deviceKey: (id) => {
        const device = this.store.device(id);
        return device ? this.deviceKey(device) : null;
      },
      relayUrl: () => this.relayUrl(),
      snapshot: () => this.backend.snapshot(),
      attention: () => this.attention(),
      changed: () => this.changed(),
      log: (line) => this.log(line),
      ...(fetch && { fetch }),
    });
    this.device = new DeviceTools({
      store: this.store,
      push: this.push,
      uploads: this.uploads,
      changed: () => this.changed(),
      onTools: () => this.emit("tools"),
      botName: (id) => (this.backend.snapshot().bots ?? []).find((bot) => bot.id === id)?.name,
      log: (line) => this.log(line),
    });
    // The "link.*" calls the link answers itself, by name. Each is called with (session, args, gone).
    this.calls = {
      "link.push.register": async (session, a) => this.push.register(session.deviceId, a[0], a[1]),
      "link.push.prefs": async (session, a) => this.push.setPrefs(session.deviceId, a[0]),
      "link.push.unregister": async (session) => this.push.unregister(session.deviceId),
      "link.push.presence": async (session, a) => this.push.setPresence(session.deviceId, a[0], a[1]),
      "link.push.activity": async (session, a) => this.push.setActivity(session.deviceId, a[0], a[1]),
      "link.push.test": (session) => this.push.test(session.deviceId),
      "link.voice.set": async (_session, a) => this.voice.set(a[0]),
      // A key may be typed on the phone or be a saved credential; either way it is kept here and never sent back.
      "link.voice.key": async (_session, a) => {
        const { args } = await this.credentials.resolve("link.voice.key", a);
        if (args[1] !== null && (typeof args[1] !== "string" || !args[1] || args[1].length > 4000)) throw new Failure("That isn't a key.");
        this.voice.setKey(args[0], args[1]);
      },
      "link.voice.options": (_session, a) => this.voice.options(a[0], a[1]),
      "link.voice.transcribe": async (_session, a) => {
        const audio = Buffer.from(String(a[0]?.audio ?? ""), "base64");
        if (!audio.length) throw new Failure("There was nothing to hear.");
        if (audio.length > MAX_VOICE_AUDIO) throw new Failure("That recording is too long. Send it in shorter parts.");
        return this.voice.transcribe({ audio, format: a[0].format, language: a[0].language });
      },
      "link.voice.speak": async (_session, a) => {
        const spoken = await this.voice.speak({ text: a[0]?.text, voice: a[0]?.voice, speed: a[0]?.speed });
        return { audio: spoken.audio.toString("base64"), format: spoken.format };
      },
      "link.voice.live": (_session, a) => this.liveVoice(a[0]),
      "link.voice.endLive": async (_session, a) => this.voice.endLive(a[0]),
      "link.device.sources": async (session, a) => this.device.setSources(session.deviceId, a[0]),
      "link.device.answer": async (session, a) => this.device.answer(session.deviceId, a[0], a[1]),
      "link.device.file": async (session, a) => this.device.file(session.deviceId, a[0]),
      // The devices paired with this computer (docs/link-contract.md): any paired device may read
      // the list, rename one and remove one, as the person can in the app on this computer.
      "link.devices.list": async (session) => this.devices(session.deviceId),
      "link.devices.rename": async (session, a) => this.renameDevice(a[0], a[1], session.deviceId),
      "link.devices.remove": async (session, a) => this.revokeDevice(a[0], session.deviceId),
      "link.frame.page": async (_session, a) => this.framePage(a[0]),
      "link.frame.chat": async (_session, a) => this.frameChat(a[0]),
      "link.upload": (session, a) => this.uploads.put(session.deviceId, a[0]),
      "link.pullRequests": (_session, a) => this.prs.lookup(a[0], a[1]),
      "link.credentials.save": (_session, a) => this.credentials.save(a[0]),
      "link.credentials.remove": async (_session, a) => this.credentials.remove(a[0]),
      "link.credentials.check": (_session, a) => this.credentials.check(a[0]),
      "link.credentials.managers": (_session, a) => this.credentials.managers(a[0] === true),
      "link.credentials.unlock": (_session, a) => this.credentials.unlock(a[0], a[1]),
      "link.credentials.lock": (_session, a) => this.credentials.lock(a[0]),
      "link.credentials.vaults": (_session, a) => this.credentials.vaults(a[0]),
      "link.credentials.items": (_session, a) => this.credentials.items(a[0], a[1], a[2]),
      "link.credentials.item": (_session, a) => this.credentials.item(a[0], a[1], a[2]),
      "link.credentials.link": (_session, a) => this.credentials.link(a[0]),
      "link.screen.info": () => this.screen.info(),
      "link.screen.frame": (session, a, gone) => this.screen.frame(session.deviceId, a[0], gone),
      "link.screen.input": (session, a) => this.screen.input(session.deviceId, a[0], a[1]),
      "link.screen.stop": async (session) => this.screen.stop(session.deviceId),
      // Setting the level from a phone, on a headless host only (grant.mjs). `via` is how the call arrived.
      "link.screen.grant.begin": async (session, a, _gone, via) => this.grants.begin(session, via, a[0]),
      "link.screen.grant.confirm": async (session, a, _gone, via) => this.grants.confirm(session, via, a[0], a[1]),
      "link.screen.revoke": async (session, _a, _gone, via) => this.grants.revoke(session, via),
    };
    this.grants = new ScreenGrants({
      serverId: this.store.data.serverId,
      device: (id) => this.store.device(id),
      headless: () => this.headless(),
      apply: (level, by) => this.applyScreen(level, by),
    });
    this.epoch = b64u(random(6));
    this.sessions = new Map();
    this.deviceKeys = new Map();
    this.waiters = new Set();
    this.parts = new Map(); // name → { json, v }
    this.version = 0;
    this.dirty = true;
    this.pairing = null;
    this.server = null;
    this.port = 0;
    this.failures = { http: new Failures(FAIL_BACKSTOP.http), relay: new Failures(FAIL_BACKSTOP.relay) };
    this.nonces = new Map(); // device id → the last session nonces seen
    this.unsubscribe = backend.subscribe(() => {
      this.changed();
      this.push.soon();
    });
    // The first look only notes what is going on, so nothing old is announced.
    this.push.start();
  }

  // ── Live voice ──────────────────────────────────────────────────────────────────────────────

  /**
   * Sets up a live voice session for a chat with a bot. The voice is told who it speaks for and is
   * given one tool, `ask_bot`; the phone runs that tool by sending the message to the chat.
   */
  async liveVoice({ chatId, botId, provider, sdp } = {}) {
    const state = this.backend.snapshot();
    const chat = (state.chats ?? []).find((item) => item.id === chatId);
    const bot = (state.bots ?? []).find((item) => item.id === botId);
    if (!chat || !bot) throw new Failure("That chat is gone.");
    const about = [bot.role, String(bot.instructions ?? "").slice(0, 1500)].filter(Boolean).join("\n\n");
    const instructions = [
      "You are the voice of " + bot.name + ", a bot the person works with. Speak as " + bot.name + ", in the first person, warmly and briefly: this is a spoken conversation, so no lists, no Markdown, and one or two sentences unless asked for more.",
      "You only do the talking. For anything beyond small talk (a question about their work, anything to look up, do, remember or change), call the ask_bot tool once with the request in the person's own words, say a few words such as \"One moment\" while it works, and then tell them what it answered in your own words. Never make up what the bot would say.",
      about && "About " + bot.name + ":\n" + about,
    ]
      .filter(Boolean)
      .join("\n\n");
    const session = await this.voice.live({ provider, sdp, instructions, tools: [ASK_BOT], about: { chatId: chat.id, botId: bot.id, botName: bot.name } });
    return { ...session, tools: [ASK_BOT] };
  }

  // ── Tools that run on a phone (for the app's bots) ──────────────────────────────────────────

  /**
   * The tools some paired phone allows now: [{ name, description, parameters, readOnly, source }],
   * `parameters` a JSON Schema. The list changes when a phone changes a switch or is removed; the
   * "tools" event says so.
   */
  deviceTools() {
    return this.device.tools();
  }
  /** Runs one on the phone. Resolves with its result (JSON); rejects with an Error whose message a bot can read. */
  callDeviceTool(name, args, options) {
    return this.device.call(name, args, options);
  }

  // ── Switching on and off ────────────────────────────────────────────────────────────────────

  get enabled() {
    return this.store.data.enabled && !this.store.data.locked;
  }
  /** Starts listening when the person has phone access switched on. */
  async start() {
    if (this.enabled) await this.listen();
  }
  async setEnabled(on) {
    if (this.store.data.locked) throw new Error("This computer's phone link can't be opened here.");
    if (on) {
      // Listening comes first: phone access is only saved as on once it works.
      await this.listen();
      this.store.set({ enabled: true });
    } else {
      this.store.set({ enabled: false });
      this.cancelPairing();
      await this.close();
    }
    this.emit("status");
  }
  async listen() {
    if (this.server) return;
    // A peer that connects and says nothing is dropped after 10 seconds, and one address can hold
    // only so many connections, so a single device on the network can't keep every phone out.
    const server = createServer({ connectionsCheckingInterval: 5_000, headersTimeout: 10_000, requestTimeout: 120_000 }, (req, res) => this.handle(req, res));
    server.on("clientError", (_error, socket) => socket.destroy());
    server.maxConnections = 256;
    const open = new Map();
    server.on("connection", (socket) => {
      const from = socket.remoteAddress ?? "";
      const count = (open.get(from) ?? 0) + 1;
      if (count > MAX_PER_ADDRESS) return socket.destroy();
      open.set(from, count);
      socket.once("close", () => {
        const left = (open.get(from) ?? 1) - 1;
        if (left > 0) open.set(from, left);
        else open.delete(from);
      });
    });
    const bind = (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => {
          server.off("error", reject);
          resolve();
        });
      });
    const wanted = this.portOverride ?? this.store.data.port;
    try {
      await bind(wanted);
    } catch (error) {
      if (error.code !== "EADDRINUSE" || this.portOverride !== undefined) throw error;
      // Something else holds the usual port: take a free one and keep it, so phones find it again.
      await bind(0);
    }
    this.server = server;
    this.port = server.address().port;
    if (this.portOverride === undefined && this.port !== this.store.data.port) this.store.set({ port: this.port });
    this.log("link listening on " + this.port);
    this.applyRelay();
  }
  async close() {
    this.relayLink?.stop();
    this.relayLink = null;
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const waiter of [...this.waiters]) waiter.end();
    this.sessions.clear();
    this.screen.stopAll();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  /** Stops for good (the app is quitting). */
  async stop() {
    this.unsubscribe?.();
    this.cancelPairing();
    clearTimeout(this.pumping);
    this.push.dispose();
    this.device.dispose();
    this.voice.close?.();
    this.screen.dispose();
    this.uploads.dispose();
    await this.close();
  }

  // ── What the desktop's own page shows ───────────────────────────────────────────────────────

  /** Where a phone can try: this computer's addresses, then (when the relay is on) "relay!<room>@<relay's host>". */
  hosts() {
    const found = [...reachable().map((entry) => entry.address), ...this.extraHosts].map((address) => address + ":" + this.port);
    const relay = this.relayEntry();
    if (relay) found.push(relay);
    return found;
  }
  /** The relay's entry in hosts() ("relay!<room>@<host>"), or null when the relay is off. */
  relayEntry() {
    const relay = this.relaySettings();
    return relay ? "relay!" + roomOf(this.store.relayKey().publicKey) + "@" + new URL(relay.url).host : null;
  }
  /**
   * Ends every session, and what each has waiting. A phone learns the relay's entry only from a session reply's
   * `hosts`, so when the entry appears, goes or changes, connected phones are made to open a new session and
   * learn it at once.
   */
  endSessions() {
    for (const session of [...this.sessions.values()]) this.dropSession(session);
  }

  // ── The relay ───────────────────────────────────────────────────────────────────────────────

  /** The relay as it applies now ({ url } with a good origin), or null when it is off, switched off or its address is bad. */
  relaySettings() {
    if (!this.relayOptions || !this.store.data.relay.enabled || this.store.data.locked) return null;
    try {
      return { url: cleanRelayUrl(this.relayOptions.url ?? this.store.data.relay.url) };
    } catch {
      return null;
    }
  }
  /** The relay address to show: the one in use, or the saved one as it stands. */
  relayUrl() {
    const url = this.relayOptions?.url ?? this.store.data.relay.url;
    try {
      return cleanRelayUrl(url);
    } catch {
      return String(url);
    }
  }
  /** Starts, restarts or stops the relay link so it matches the settings and whether phone access is on. */
  applyRelay() {
    const wanted = this.server ? this.relaySettings() : null;
    const link = this.relayLink;
    // A link that gave up the seat (taken) is replaced, so turning things off and on, or changing a setting, tries again.
    if (link && (!wanted || link.url !== wanted.url || link.publicKey !== this.store.data.relay.key?.publicKey || link.taken)) {
      link.stop();
      this.relayLink = null;
    }
    if (!wanted || this.relayLink) return;
    const next = new RelayLink({
      url: wanted.url,
      key: this.store.relayKey(),
      serve: (request) => this.serve({ ...request, via: "relay" }),
      onChange: () => this.emit("status"),
      onTaken: () => this.emit("status"),
      log: (line) => this.log(line),
      WebSocket: this.relayOptions.WebSocket,
      timers: this.relayOptions.timers,
    });
    next.url = wanted.url;
    this.relayLink = next;
    next.start();
  }
  /**
   * Changes the relay settings, saves them and applies them at once. `enabled` turns it on or off; `url` is
   * the relay's address (https only, or http for this computer itself). Throws for an address that isn't valid.
   */
  setRelay({ enabled, url } = {}) {
    const before = this.relayEntry();
    const next = { ...this.store.data.relay };
    if (enabled !== undefined) next.enabled = enabled === true;
    if (url !== undefined) next.url = cleanRelayUrl(url);
    this.store.set({ relay: next });
    this.applyRelay();
    if (this.relayEntry() !== before) this.endSessions();
    this.dirty = true;
    this.changed();
    this.emit("status");
  }
  /** A new relay key, and so a new room. The old socket closes, the new entry is in hosts() at once, and the key is saved. */
  resetRelay() {
    this.store.resetRelayKey();
    this.applyRelay();
    this.endSessions();
    this.dirty = true;
    this.changed();
    this.emit("status");
    return roomOf(this.store.data.relay.key.publicKey);
  }
  status() {
    const live = this.liveDevices();
    const pairing = this.activePairing();
    return {
      enabled: this.enabled,
      ...(this.store.data.locked && { locked: true }),
      listening: !!this.server,
      port: this.port,
      name: this.store.name,
      serverId: this.store.data.serverId,
      addresses: this.server ? reachable() : [],
      devices: this.store.data.devices.map(({ publicKey: _key, ...device }) => ({ ...device, connected: live.has(device.id) })),
      pairing: pairing ? { code: pairing.code, expiresAt: pairing.expiresAt, url: this.pairingUrl(pairing.code) } : null,
      relay: { enabled: !!this.relaySettings(), connected: !!this.relayLink?.connected, url: this.relayUrl(), ...(this.relayLink?.taken && { problem: "taken" }) },
      // The phones that get notifications, and what each allows bots to use.
      push: this.push.status(),
      sources: Object.fromEntries(this.store.data.devices.map((device) => [device.id, this.store.sources(device.id)])),
      screen: { mode: this.store.data.screen, ...(this.store.data.screenSetBy && { setBy: this.store.data.screenSetBy }), viewers: this.screen.viewers().map(({ deviceId, since }) => ({ deviceId, name: this.store.device(deviceId)?.name ?? "Phone", since })) },
    };
  }
  /**
   * What phones may do with the screen: "off", "view" or "control". The desktop's page offers the
   * choice. Set here, on the computer itself, it carries no phone's name.
   */
  setScreenMode(mode) {
    if (!SCREEN_MODES.includes(mode)) throw new Error("The screen can be off, view or control.");
    this.applyScreen(mode, null);
  }
  /** Sets the level and who set it (`by`: a phone, on a headless host; null: this computer). Every open ticket ends. */
  applyScreen(mode, by) {
    this.store.set({ screen: mode, screenSetBy: by });
    this.grants.clear();
    this.screen.modeChanged();
    this.dirty = true;
    this.changed();
    this.emit("status");
  }
  /** Whether the app says this computer has no window of its own (a server). Only then may a phone set the screen's level. */
  headless() {
    return this.backend.headless === true;
  }
  /** Whether a headless host has a display now, as the app says it: { available, kind?, note? }. */
  display() {
    let said;
    try {
      said = this.backend.displayStatus?.();
    } catch {
      said = null;
    }
    return { available: said?.available === true, ...(typeof said?.kind === "string" && said.kind && { kind: said.kind.slice(0, 24) }), ...(typeof said?.note === "string" && said.note && { note: said.note.slice(0, 200) }) };
  }
  setName(name) {
    this.store.set({ name: String(name ?? "").trim().slice(0, 60) });
    this.dirty = true;
    this.changed();
    this.emit("status");
  }
  activePairing() {
    if (this.pairing && this.pairing.expiresAt <= Date.now()) this.cancelPairing();
    return this.pairing;
  }
  /** Opens a pairing code for a few minutes. Only one is open at a time. */
  startPairing(ttl = PAIR_TTL) {
    if (!this.server) throw new Error("Turn on phone access first.");
    this.cancelPairing();
    const pairing = { code: newCode(), expiresAt: Date.now() + ttl, tries: 0, by: new Map() };
    pairing.timer = setTimeout(() => this.pairing === pairing && this.cancelPairing(), ttl);
    pairing.timer.unref?.();
    this.pairing = pairing;
    this.emit("status");
    return { code: pairing.code, expiresAt: pairing.expiresAt, url: this.pairingUrl(pairing.code) };
  }
  cancelPairing() {
    if (!this.pairing) return;
    clearTimeout(this.pairing.timer);
    this.pairing = null;
    this.emit("status");
  }
  /** What the QR code holds: this computer's key and addresses, and the code. */
  pairingUrl(code) {
    const query = new URLSearchParams({
      v: String(PROTOCOL),
      s: this.store.data.serverId,
      k: b64u(this.store.data.keys.publicKey),
      c: code,
      h: this.hosts().join(","),
      n: this.store.name,
    });
    return "botkins://pair?" + query;
  }
  /** Which devices have a session that was used in the last minute and a half. */
  liveDevices() {
    const now = Date.now();
    const live = new Set();
    for (const session of this.sessions.values()) if (now - session.used < 90_000) live.add(session.deviceId);
    return live;
  }
  /**
   * The paired devices as a client is told of them: never a key or a notification address.
   * `current` marks the one that asks.
   */
  devices(asking) {
    const live = this.liveDevices();
    return this.store.data.devices.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      kind: device.kind,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      connected: live.has(device.id),
      ...(device.id === asking && { current: true }),
    }));
  }
  renameDevice(id, name, asking) {
    if (typeof id !== "string" || !this.store.device(id)) throw new Failure("That device is no longer paired.");
    if (typeof name !== "string" || !name.trim() || name.length > 200) throw new Failure("Give the device a name.");
    this.store.renameDevice(id, name);
    this.dirty = true;
    this.changed();
    this.emit("status");
    return this.devices(asking);
  }
  /** A client removes a paired device: another one, or itself (the same as unpairing). The others are not touched. */
  revokeDevice(id, asking) {
    if (typeof id !== "string" || !this.store.device(id)) throw new Failure("That device is no longer paired.");
    // The answer is made first: a device that removes itself has no session to be answered on afterwards.
    const left = this.devices(asking).filter((device) => device.id !== id);
    this.removeDevice(id);
    this.dirty = true;
    this.changed();
    return left;
  }
  /**
   * Where the person is looking, for notifications: the app's own window, or another computer that
   * uses this one and says its window is in front (a paired device of kind "desktop"). A reply in
   * the chat on that screen needs no ping on a phone.
   */
  attention() {
    const own = this.backend.attention?.();
    if (own?.focused) return own;
    for (const device of this.store.data.devices) {
      if (device.kind !== "desktop") continue;
      const front = this.push.frontOf(device.id);
      if (front) return { focused: true, ...(front.chatId && { chatId: front.chatId }) };
    }
    return own;
  }
  removeDevice(id) {
    const removed = this.store.removeDevice(id);
    this.deviceKeys.delete(id);
    this.nonces.delete(id);
    this.screen.stop(id);
    this.uploads.forget(id);
    this.push.forget(id);
    this.device.forget(id);
    this.grants.forget(id);
    for (const [sid, session] of this.sessions) if (session.deviceId === id) this.sessions.delete(sid);
    for (const waiter of [...this.waiters]) if (waiter.session.deviceId === id) waiter.end();
    if (removed) this.emit("status");
    return removed;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────────────────────

  send(res, status, body, isJson = !Buffer.isBuffer(body)) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "content-type": isJson ? "application/json" : "application/octet-stream",
      "content-length": bytes.length,
      "cache-control": "no-store",
    });
    res.end(bytes);
  }
  /** What a call needs before any of its body is read: a session this computer knows. Throws Refused(401) otherwise. */
  knownSession(id) {
    const session = this.sessions.get(String(id ?? ""));
    if (!session || !this.store.device(session.deviceId)) throw new Refused(401, "session");
    return session;
  }
  async handle(req, res) {
    try {
      // Only this computer, the local network and a tailnet may call, and never a web page.
      if (!isNear(req.socket.remoteAddress)) throw new Refused(403, "far");
      if (req.headers.origin) throw new Refused(403, "origin");
      const path = new URL(req.url ?? "/", "http://link").pathname;
      if (!path.startsWith(PREFIX)) throw new Refused(404, "not_found");
      const route = path.slice(PREFIX.length);
      const from = req.socket.remoteAddress ?? "";
      const answer = (done) => {
        if (!res.destroyed) this.send(res, done.status, done.body, done.json);
      };
      if (route === "hello" && req.method === "GET") return answer(await this.serve({ route, from }));
      if (req.method !== "POST") throw new Refused(405, "method");
      if (route !== "rpc" && route !== "pair" && route !== "session") throw new Refused(404, "not_found");
      // A call needs a known session and a body that fits before any of the body is read.
      const sessionId = String(req.headers["x-botkins-session"] ?? "");
      if (route === "rpc") this.knownSession(sessionId);
      const limit = route === "rpc" ? MAX_RPC_BODY : MAX_BODY;
      if (Number(req.headers["content-length"]) > limit) throw new Refused(413, "too_large");
      const body = await readBody(req, limit);
      const gone = new Promise((resolve) => res.on("close", resolve));
      answer(await this.serve({ route, session: sessionId, body, from, gone }));
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (!(error instanceof Refused)) this.log("link: " + (error?.message ?? error));
      this.send(res, error instanceof Refused ? error.status : 500, { error: error instanceof Refused ? error.message : "failed" });
    }
  }
  /**
   * One request of the link, whichever way it came: the HTTP handler above or the relay (relay.mjs).
   * `route` is "hello", "pair", "session" or "rpc"; `session` is the rpc call's session id; `body` is
   * what the phone posted (a Buffer); `from` stands for the caller's address (a socket address over HTTP,
   * an opaque tag from the relay); `via` is "http" or "relay"; `gone` resolves when the caller has left,
   * so a long "link.sync" stops waiting. Never throws. Returns { status, body, json }: `body` is a Buffer,
   * and `json` says it is JSON text (an rpc answer is sealed bytes).
   * Over the relay a hello says less, attempts are limited per relay `from`, and the checks that only
   * make sense for a socket (the caller's network, an Origin header) don't apply: they are HTTP's own.
   */
  async serve({ route, session: sessionId = "", body = Buffer.alloc(0), from = "", via = "http", gone = new Promise(() => {}) }) {
    const json = (status, value) => ({ status, body: Buffer.from(JSON.stringify(value), "utf8"), json: true });
    try {
      if (route === "hello") return json(200, this.hello(via));
      if (route !== "rpc" && route !== "pair" && route !== "session") throw new Refused(404, "not_found");
      const limit = route === "rpc" ? MAX_RPC_BODY : MAX_BODY;
      if (route === "rpc") {
        // The phone may have been removed while its call was on the way.
        const session = this.knownSession(sessionId);
        if (body.length > limit) throw new Refused(413, "too_large");
        return { status: 200, body: await this.rpc(session, body, gone, via), json: false };
      }
      // Each way in has its own failure counts: the relay can never use up HTTP's allowance, or the other way round.
      const failures = this.failures[via === "relay" ? "relay" : "http"];
      // A source over its limit is told to wait. Pairing says "pair_wait" so a phone can say "too many tries".
      // A session isn't held back up front: one that proves itself is served, so a stranger who shares a
      // source with a real phone (a carrier's NAT, a café) can't keep it out. Only a failing one is held back.
      if (route === "pair" && failures.blocked(from)) throw new Refused(429, "pair_wait");
      const gate = { blocked: () => failures.blocked(from), tripped: () => failures.tripped() };
      const bad = (status, code) => {
        throw new Refused(route === "session" && gate.blocked() ? 429 : status, route === "session" && gate.blocked() ? "slow_down" : code);
      };
      try {
        if (body.length > limit) bad(413, "too_large");
        let message;
        try {
          message = JSON.parse(body.toString("utf8"));
        } catch {
          bad(400, "bad_json");
        }
        if (route === "pair") {
          // Pairing (and a session for a device this computer doesn't know) is what a flood from many sources aims at.
          if (failures.tripped()) throw new Refused(429, "slow_down");
          return json(200, this.pair(message, via + ":" + from, via === "http"));
        }
        return json(200, this.session(message, gate));
      } catch (error) {
        // Only a failure counts, and a source that is refused already isn't counted again.
        if (error instanceof Refused && error.status !== 429) failures.add(from);
        throw error;
      }
    } catch (error) {
      if (!(error instanceof Refused)) this.log("link: " + (error?.message ?? error));
      return json(error instanceof Refused ? error.status : 500, { error: error instanceof Refused ? error.message : "failed" });
    }
  }
  hello(via = "http") {
    // Through the relay anyone who knows the room can knock, so a hello says only what pairing needs.
    // It doesn't even say whether a code is open: that would let a stranger watch for one.
    if (via === "relay") return { botkins: PROTOCOL, serverId: this.store.data.serverId, publicKey: b64u(this.store.data.keys.publicKey) };
    const info = this.backend.info();
    return {
      botkins: PROTOCOL,
      serverId: this.store.data.serverId,
      publicKey: b64u(this.store.data.keys.publicKey),
      name: this.store.name,
      app: info.app,
      version: info.version,
      pairing: !!this.activePairing(),
    };
  }
  /** `direct`: the request came straight over HTTP, not through the relay. Only then is a phone's presence key kept. */
  pair(message, source = "", direct = false) {
    const pairing = this.activePairing();
    if (!pairing) throw new Refused(403, "pair_closed");
    // A source that has used its tries for this code is told to wait, even with the right code (429 "pair_wait", so
    // a phone can say "too many tries" rather than "that code isn't right").
    if ((pairing.by.get(source) ?? 0) >= PAIR_TRIES_PER_SOURCE) throw new Refused(429, "pair_wait");
    const { serverId, keys } = this.store.data;
    let theirs, shared;
    try {
      theirs = unb64u(message?.publicKey);
      shared = agree(keys, theirs);
    } catch {
      throw new Refused(400, "bad_key");
    }
    const key = hkdf(shared, Buffer.from(cleanCode(pairing.code), "utf8"), INFO.pair);
    let hello;
    try {
      hello = unbox(key, message.box, "pair:" + serverId);
    } catch {
      // A wrong code is counted for its source. Only a great many of them, from everyone together, withdraw the code.
      const used = (pairing.by.get(source) ?? 0) + 1;
      pairing.by.delete(source);
      pairing.by.set(source, used);
      for (const name of pairing.by.keys()) if (pairing.by.size > MAX_SOURCES) pairing.by.delete(name);
      if (++pairing.tries >= PAIR_TRIES_IN_ALL) this.cancelPairing();
      throw new Refused(403, "pair_failed");
    }
    // A phone that pairs again replaces its earlier entry.
    for (const old of this.store.data.devices.filter((d) => d.publicKey === b64u(theirs))) this.removeDevice(old.id);
    const device = this.store.addDevice({ name: hello?.name, platform: hello?.platform, kind: hello?.kind, publicKey: theirs, presenceKey: direct ? cleanPresenceKey(hello?.presenceKey) : null });
    this.cancelPairing();
    // The list of paired devices is part of what phones are sent: it has one more now.
    this.dirty = true;
    this.changed();
    this.emit("paired", device);
    this.emit("status");
    return { box: box(key, { device: device.id, serverId, name: this.store.name, hosts: this.hosts() }, "paired:" + serverId) };
  }
  deviceKey(device) {
    let key = this.deviceKeys.get(device.id);
    if (!key) {
      key = hkdf(agree(this.store.data.keys, unb64u(device.publicKey)), Buffer.from(device.id, "utf8"), INFO.device);
      this.deviceKeys.set(device.id, key);
    }
    return key;
  }
  /**
   * Opens a session. The cheap checks come first: a device this computer knows, and a box that opens with
   * that device's key. A session that passes them is served whatever the source's failures or the way in's
   * backstop (`gate.blocked()`, `gate.tripped()`), so strangers can't lock real phones out. A request that
   * fails, or is for an unknown device, meets the gates.
   */
  session(message, gate = { blocked: () => false, tripped: () => false }) {
    const device = this.store.device(String(message?.device ?? ""));
    if (!device) {
      if (gate.blocked() || gate.tripped()) throw new Refused(429, "slow_down");
      throw new Refused(403, "unknown_device");
    }
    const { serverId } = this.store.data;
    const key = this.deviceKey(device);
    let hello, shared, mine;
    try {
      hello = unbox(key, message.box, "session:" + serverId);
      if (hello.eph !== message.eph) throw new Error("mismatch");
      // A recorded request played again would take another of the phone's few session slots.
      const seen = this.nonces.get(device.id) ?? new Set();
      if (typeof hello.nonce !== "string" || hello.nonce.length > 64 || seen.has(hello.nonce)) throw new Error("replay");
      seen.add(hello.nonce);
      if (seen.size > MAX_NONCES) seen.delete(seen.values().next().value);
      this.nonces.set(device.id, seen);
      mine = newKeyPair();
      shared = agree(mine, unb64u(hello.eph));
    } catch {
      if (gate.blocked()) throw new Refused(429, "slow_down");
      throw new Refused(403, "bad_session");
    }
    const serverNonce = random(16);
    const salt = Buffer.concat([unb64u(hello.nonce), serverNonce]);
    const master = hkdf(Buffer.concat([shared, key]), salt, "botkins/session/v1");
    const session = {
      id: b64u(random(12)),
      deviceId: device.id,
      toHost: hkdf(master, salt, INFO.toHost),
      toPhone: hkdf(master, salt, INFO.toPhone),
      max: 0,
      seen: new Set(),
      used: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.prune();
    this.store.touch(device.id);
    this.emit("status");
    return { box: box(key, { session: session.id, eph: b64u(mine.publicKey), nonce: b64u(serverNonce), epoch: this.epoch, hosts: this.hosts() }, "session-ok:" + serverId) };
  }
  prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (now - session.used > SESSION_IDLE) this.sessions.delete(id);
    // A phone keeps a few sessions; its oldest go first, so it can't push other phones out.
    const mine = new Map();
    for (const session of this.sessions.values()) mine.set(session.deviceId, [...(mine.get(session.deviceId) ?? []), session]);
    for (const list of mine.values()) {
      list.sort((a, b) => b.used - a.used);
      for (const extra of list.slice(MAX_SESSIONS_PER_DEVICE)) this.dropSession(extra);
    }
    while (this.sessions.size > MAX_SESSIONS) {
      let oldest = null;
      for (const session of this.sessions.values()) if (!oldest || session.used < oldest.used) oldest = session;
      this.dropSession(oldest);
    }
  }
  /** Ends a session and whatever it has waiting. */
  dropSession(session) {
    this.sessions.delete(session.id);
    this.grants.dropSession(session.id);
    for (const waiter of [...this.waiters]) if (waiter.session === session) waiter.end();
  }
  async rpc(session, body, gone, via = "http") {
    if (body.length < 24) throw new Refused(400, "short");
    const seq = Number(body.readBigUInt64BE(0));
    // Each number is taken once, so a recorded message can't be played again.
    if (!Number.isSafeInteger(seq) || seq < 1 || seq <= session.max - WINDOW || session.seen.has(seq)) throw new Refused(400, "replay");
    let message;
    try {
      message = JSON.parse(open(session.toHost, seqNonce(seq), body.subarray(8), "rpc:" + session.id).toString("utf8"));
    } catch {
      throw new Refused(400, "sealed");
    }
    session.seen.add(seq);
    if (seq > session.max) session.max = seq;
    if (session.seen.size > WINDOW * 2) for (const old of session.seen) if (old <= session.max - WINDOW) session.seen.delete(old);
    session.used = Date.now();
    this.store.touch(session.deviceId);
    this.push.heard(session.deviceId);

    let text;
    try {
      const result = await this.dispatch(session, message, gone, via);
      text = result instanceof Json ? '{"r":' + result.text + "}" : JSON.stringify({ r: result ?? null });
    } catch (error) {
      text = JSON.stringify({ e: { message: plain(error).slice(0, 600) } });
    }
    return seal(session.toPhone, seqNonce(seq), Buffer.from(text, "utf8"), "ok:" + session.id);
  }

  // ── Calls ───────────────────────────────────────────────────────────────────────────────────

  /** `via` is how the call arrived: "http" straight to this computer, or "relay". */
  async dispatch(session, message, gone, via = "http") {
    const method = String(message?.m ?? "");
    const args = Array.isArray(message?.a) ? message.a : [];
    if (method === "link.sync") return this.sync(session, args[0] ?? {}, gone);
    if (method === "link.messages") {
      const limit = Math.max(1, Math.min(Number(args[2]) || CHAT_PAGE, 200));
      return chatPart(this.backend.snapshot(), String(args[0]), undefined, { before: Number(args[1]), limit });
    }
    if (method === "link.setLook") {
      const bots = this.backend.snapshot().bots ?? [];
      if (!bots.some((bot) => bot.id === args[0])) throw new Error("This bot no longer exists.");
      // An app that keeps looks on its bots saves it there; otherwise the link keeps it.
      if (typeof this.backend.setLook === "function") await this.backend.setLook(args[0], cleanLook(args[1]));
      else this.store.setLook(args[0], args[1]);
      this.changed();
      return null;
    }
    if (method === "link.unpair") {
      // Answered first; the phone is forgotten right after.
      setImmediate(() => {
        try {
          this.removeDevice(session.deviceId);
        } catch (error) {
          this.log("link: " + (error?.message ?? error));
        }
      });
      return true;
    }
    if (Object.hasOwn(this.calls, method)) {
      try {
        return await this.calls[method](session, args, gone, via);
      } catch (error) {
        // What the link answers itself is either a plain sentence of its own or "didn't work".
        if (error instanceof Failure) throw error;
        this.log("link: " + (error?.message ?? error));
        throw new Failure(SYSTEM_ERROR);
      }
    }
    if (method.startsWith("link.")) {
      const name = method.slice(5);
      // Own names only, so "link.constructor" or "link.__proto__" reach nothing.
      const extra = this.backend.extras && Object.hasOwn(this.backend.extras, name) ? this.backend.extras[name] : null;
      if (typeof extra !== "function") throw new Error("This computer's app doesn't support that yet.");
      return extra(...(await this.credentials.resolve(method, args)).args);
    }
    if (!REMOTE_METHODS.has(method)) throw new Error("That can't be done from a phone.");
    // A credential reference is filled in at a few fixed places of three calls, and refused everywhere else.
    const { args: callArgs, secrets } = await this.credentials.resolve(method, remoteArgs(method, args, { deviceId: session.deviceId, uploads: this.uploads }));
    if (!secrets.length) return this.backend.call(method, callArgs);
    // The desktop may echo what it was given. Nothing of a value goes back to a phone.
    try {
      return scrub(await this.backend.call(method, callArgs), secrets);
    } catch (error) {
      throw new Failure(plain(error) === SYSTEM_ERROR ? SYSTEM_ERROR : scrub(plain(error), secrets));
    }
  }

  // ── Custom views ────────────────────────────────────────────────────────────────────────────

  /** The app's store of custom views, or a sentence a person can read. */
  frames(id) {
    const frames = this.backend.frames;
    if (typeof frames?.page !== "function") throw new Failure("Update the app on your computer to see this view.");
    if (typeof id !== "string" || !FRAME_ID.test(id)) throw new Failure("This view no longer exists.");
    return frames;
  }
  /**
   * A custom view's page as its bot wrote it, and its data. The phone draws the page itself, in a
   * web view that has no network and can't leave its page. Nothing of the computer goes with it.
   */
  async framePage(id) {
    const frames = this.frames(id);
    let page;
    try {
      page = await frames.page(id);
    } catch {
      throw new Failure("This view no longer exists.");
    }
    const html = page?.html;
    if (typeof html !== "string" || !html.trim()) throw new Failure("This view no longer exists.");
    const json = JSON.stringify(page.data ?? null) ?? "null";
    if (html.length > MAX_FRAME_HTML || json.length > MAX_FRAME_DATA) throw new Failure("This view is too large for a phone.");
    return { html, data: JSON.parse(json) };
  }
  /** The chat a view's answer goes to: its card's chat, or the chat its panel was made in. */
  async frameChat(id) {
    const frames = this.frames(id);
    if (typeof frames.chatFor !== "function") return { chatId: null };
    let chatId;
    try {
      chatId = await frames.chatFor(id);
    } catch {
      throw new Failure("This view no longer exists.");
    }
    return { chatId: typeof chatId === "string" && chatId ? chatId : null };
  }

  // ── Keeping phones in step ──────────────────────────────────────────────────────────────────

  meta() {
    return {
      ...this.backend.info(),
      name: this.store.name,
      serverId: this.store.data.serverId,
      protocol: PROTOCOL,
      // The app names what it supports itself (`backend.capabilities`); a look with eyes and its own
      // colors is one of those when the app keeps looks on its bots, and the link's own otherwise.
      capabilities: [...new Set([...Object.keys(this.backend.extras ?? {}), ...(Array.isArray(this.backend.capabilities) ? this.backend.capabilities : []), ...CAPABILITIES, ...(this.headless() ? [GRANT_CAPABILITY] : []), ...(typeof this.backend.frames?.page === "function" ? ["frames-v1"] : []), ...(typeof this.backend.setLook === "function" ? [] : ["looks-v2"])])],
    };
  }
  /** The desktop changed: wake the phones that are waiting, at most once per PUMP_MS. */
  changed() {
    this.dirty = true;
    if (!this.waiters.size || this.pumping) return;
    this.pumping = setTimeout(() => {
      this.pumping = null;
      try {
        if (!this.waiters.size) return;
        this.refresh([]);
        for (const waiter of [...this.waiters]) {
          const news = this.news(waiter.known, waiter.watching);
          if (news) waiter.end(news);
        }
      } catch (error) {
        this.log("link: " + (error?.message ?? error));
      }
    }, PUMP_MS);
    this.pumping.unref?.();
  }
  /** Rebuilds the parts when something changed, or when a chat is watched for the first time. */
  refresh(watching) {
    if (!this.dirty && watching.every((id) => this.parts.has("chat:" + id))) return;
    const state = this.backend.snapshot();
    const ownLooks = typeof this.backend.setLook === "function";
    if (!ownLooks) this.store.syncLooks((state.bots ?? []).map((bot) => bot.id));
    const next = baseParts(state, this.meta(), ownLooks ? {} : this.store.data.looks, { credentials: this.credentials.list(), screen: this.store.data.screen, relay: !!this.relaySettings(), ...(this.headless() && { headless: true, display: this.display() }), screenSetBy: this.store.data.screenSetBy });
    // What each phone set up (never a token), and what bots are asking phones for right now.
    next.phones = Object.fromEntries(this.store.data.devices.map((device) => [device.id, { name: device.name, kind: device.kind, platform: device.platform, ...(device.presenceKey && { presence: true }), ...(this.push.view(device.id) && { push: this.push.view(device.id) }), sources: this.store.sources(device.id) }]));
    next.asks = this.device.asks();
    next.voice = this.voice.settings();
    const ids = new Set(watching);
    for (const waiter of this.waiters) for (const id of waiter.watching) ids.add(id);
    const runs = runsByChat(state, [...ids]);
    for (const id of ids) {
      next["chat:" + id] = chatPart(state, id, runs.get(id));
      next["run:" + id] = runPart(state, id, runs.get(id));
    }
    for (const [name, value] of Object.entries(next)) {
      const json = JSON.stringify(value ?? null);
      if (this.parts.get(name)?.json !== json) this.parts.set(name, { json, v: ++this.version });
    }
    // Chats nobody watches any more are dropped.
    for (const name of [...this.parts.keys()]) if (!(name in next)) this.parts.delete(name);
    this.dirty = false;
  }
  names(watching) {
    const names = [];
    for (const name of this.parts.keys()) if (!name.startsWith("chat:") && !name.startsWith("run:")) names.push(name);
    for (const id of watching) names.push("chat:" + id, "run:" + id);
    return names;
  }
  /** The parts a phone doesn't have yet, as JSON text, or null when it has them all. */
  news(known, watching) {
    const parts = [];
    const versions = {};
    for (const name of this.names(watching)) {
      const part = this.parts.get(name);
      if (!part) continue;
      versions[name] = part.v;
      if (known[name] !== part.v) parts.push(JSON.stringify(name) + ":" + part.json);
    }
    if (!parts.length) return null;
    return new Json('{"epoch":' + JSON.stringify(this.epoch) + ',"v":' + JSON.stringify(versions) + ',"parts":{' + parts.join(",") + "}}");
  }
  sync(session, { epoch, have, watch, wait }, gone) {
    const watching = (Array.isArray(watch) ? watch : []).filter((id) => typeof id === "string").slice(0, MAX_WATCH);
    const known = epoch === this.epoch && have && typeof have === "object" ? have : {};
    this.refresh(watching);
    const now = this.news(known, watching);
    const quiet = () => ({ epoch: this.epoch, v: null, parts: {} });
    if (now || !(Number(wait) > 0)) return now ?? quiet();
    // A phone has a couple of waits open at most; a newer one ends the oldest.
    const mine = [...this.waiters].filter((w) => w.session === session);
    for (const old of mine.slice(0, Math.max(0, mine.length - (MAX_WAITERS - 1)))) old.end();
    return new Promise((resolve) => {
      const waiter = {
        session,
        known,
        watching,
        end: (news) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(news ?? quiet());
        },
      };
      const timer = setTimeout(() => waiter.end(), Math.min(Number(wait), MAX_WAIT));
      timer.unref?.();
      this.waiters.add(waiter);
      gone.then(() => waiter.end());
    });
  }
}
