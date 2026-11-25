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
import { createHash } from "node:crypto";
import { Credentials, scrub } from "./credentials.mjs";
import { PROTON_SETUP } from "./proton-setup.mjs";
import { agree, b64u, box, cleanCode, hkdf, INFO, newCode, newKeyPair, open, random, seal, pushNonce, seqNonce, unb64u, unbox } from "./crypto.mjs";
import { DeviceTools } from "./device.mjs";
import { botkinRenderer } from "./botkin-svg.mjs";
import { GADGET_CAPABILITY, GADGET_DEFAULTS, GADGET_SETTINGS_CAPABILITY, Gadgets } from "./gadget.mjs";
import { cleanPresenceKey, GRANT_CAPABILITY, GRANT_RELAY_CAPABILITY, ScreenGrants } from "./grant.mjs";
import { REMOTE_METHODS, remoteArgs } from "./methods.mjs";
import { isNear, reachable } from "./net.mjs";
import { baseParts, CHAT_PAGE, CHUNK_HOLD_MAX_MS, CHUNK_LIVE_MS, CHUNK_MS, chatPart, chunkDelta, compactWorkingRun, lightPart, quietLive, reasoningDelta, runPart, runsByChat, stepDetail, textDelta } from "./parts.mjs";
import { runRowsFor } from "./run-step-delta.mjs";
import { jsonFragments, sameFragments } from "./json-cache.mjs";
import { reasoningPreview } from "./reasoning-preview.mjs";
import { PullRequests } from "./prs.mjs";
import { Push } from "./push.mjs";
import { cleanRelayUrl, RelayHost, roomOf, signWithRelayKey, validRelayKey } from "./relay.mjs";
import { Screen } from "./screen.mjs";
import { ChatSections } from "./chat-sections.mjs";
import { SpaceLinks } from "./space-links.mjs";
import { SpaceAlerts } from "./space-alerts.mjs";
import { Spaces } from "./spaces.mjs";
import { ChatTyping } from "./typing.mjs";
import { headCapabilities, cleanLook, deviceKind, LinkStore, personName, SCREEN_MODES } from "./store.mjs";
import { chatSectionsOf, withChatSections, authorize, chatPeople, cleanGroup, cleanRole, filterParts, ownerParts, inChat, panelOfFrame, panelView, spaceCan, inviteLink, inviteLookup, MAX_CHAT_PEOPLE, newInviteCode, normalizeCode, OWNER, personOf, sharedBotFlags, teamPeople, viewOf, visible, withBotFlags, withChatFlags, hasAction, roleOfMember, seenItemsOf, spacesViewOf } from "./team.mjs";
import { avatarOf, cleanAvatar, ownerApprovalChats, privateProactiveChat, withoutProactiveAlerts } from "./team.mjs";
import { Failure, searchDirs } from "./tools.mjs";
import { ASK_BOT_DESCRIPTION, cleanBotVoice, liveContextOf, liveInstructions, Voice } from "./voice.mjs";
import { Uploads } from "./uploads.mjs";

export const PROTOCOL = 1;
const PREFIX = "/botkins/v1/";
// A sealed call may carry a file part (4 MB, as base64 and sealed); the pairing steps are tiny.
const MAX_RPC_BODY = 6 * 1024 * 1024;
const MAX_BODY = 64 * 1024;
const MAX_TEAMWORK_BODY = 160 * 1024;
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
const MAX_MEMBER_SESSIONS = 32;
const MAX_SESSIONS_PER_DEVICE = 6;
const MAX_PER_ADDRESS = 24; // connections one address may hold open
const WINDOW = 4096;
const MAX_WAIT = 30_000;
const PUMP_MS = 60;
const RELAY_POLL_MS = 250;
const FOLLOW_PUMP_MS = 100;
const FOLLOW_QUIET_MS = 25_000;
const FOLLOW_LIFE_MS = 4 * 60_000;
const SUMMARY_PUMP_MS = 1000;
const TEXT_PUMP_MS = 200; // Tuning value for text-only updates to a following phone.
const MAX_WATCH = 4;
const PROFILE_ORIGIN = "https://profile.botkins.app";
const PROFILE_STATUS_CACHE_MS = 60_000;
const PROFILE_MAX_CACHE = 64;
const PROFILE_KEY_INFO = "botkins/profile/v1";
const PROFILE_MAX_TEXT = 1024;
const PROFILE_REQUEST_TIMEOUT = 10_000;
/** What a phone can ask this computer for beyond the app's own calls (Meta.capabilities). */
// "maintenance-v1": this copy lets a phone clear the cache and send the computer's own test notification.
/** The link tells people of notes and changes in their spaces (space-alerts.mjs). Named only while the app has spaces. */
const SPACE_ALERTS_CAPABILITY = "space-alerts-v1";
const CAPABILITIES = ["sync-push-v1", "credentials-v1", "screen-v1", "prs-v1", "uploads-v1", "relay-v1", "push-v1", "device-v1", "voice-v1", "devices-v1", "device-person-v1", "maintenance-v1", "teams-v1", "stream-appends-v1", "reasoning-appends-v1", "separate-thinking-v1", "text-streaming-off-v1", "text-chunks-v1", "text-watch-v1", "step-details-v1", "run-step-deltas-v1", "run-summary-deltas-v1", "team-people-v1", "chat-sections-v1", "chat-typing-v1", "activity-bots-v1", "activity-all-v1", "member-rename-v1", "profile-v1", "people-avatars-v1", GADGET_CAPABILITY, GADGET_SETTINGS_CAPABILITY, "pr-panel-v1"];
/** A custom view (an html block): the page a bot wrote and its data, at the sizes the desktop app keeps them to. */
/** Calls that make a chat and answer its id. */
const MAKES_CHAT = new Set(["createChat", "createGroupChat", "forkChat", "startProjectChat"]);
const MAX_FRAME_HTML = 300_000;
const MAX_FRAME_DATA = 200_000;
const FRAME_ID = /^[0-9a-f-]{36}$/;
const MAX_VOICE_AUDIO = 5 * 1024 * 1024; // what one call can carry, well under the size of a sealed call
/** The one tool a live voice has: the voice only talks; the bot does the work. The phone runs it by sending the message to the chat. */
const ASK_BOT = {
  name: "ask_bot",
  description: ASK_BOT_DESCRIPTION,
  parameters: { type: "object", properties: { message: { type: "string", description: "The request, in the person's own words." } }, required: ["message"], additionalProperties: false },
};
const MAX_WAITERS = 2; // "link.sync" calls a session may have waiting at once
const LIVE_NOTES_MS = 2000; // the longest a live call waits for the app's notes (backend.liveContext)
const DENIED_REQUEST_MS = 24 * 60 * 60_000;
const JOIN_PENDING_MAX = 50;
const JOIN_TRIES_PER_SOURCE = 8;
const INVITE_CARD_TIMEOUT = 15_000;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function validCursors(value, watching) {
  if (!isPlainObject(value) || watching.some((id) => !id.length || id.length > 128)) return false;
  const entries = Object.entries(value);
  const offset = (n) => Number.isSafeInteger(n) && n >= 0;
  return entries.length <= MAX_WATCH && entries.every(([chat, cursor]) =>
    watching.includes(chat) && isPlainObject(cursor) &&
    typeof cursor.id === "string" && cursor.id.length > 0 && cursor.id.length <= 128 &&
    offset(cursor.stream) && offset(cursor.thinking));
}
function validReasoningWatch(value) {
  return Array.isArray(value) && value.length <= MAX_WATCH && value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128);
}

function profileText(value, limit = PROFILE_MAX_TEXT) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function profileProof(value) {
  if (!isPlainObject(value)) throw new Failure("The profile service returned an invalid answer.");
  const profileId = profileText(value.profileId);
  const deviceId = profileText(value.deviceId);
  const name = profileText(value.name, 60);
  const statusKey = profileText(value.statusKey, PROFILE_MAX_TEXT);
  if (!profileId || !deviceId || !name || !statusKey) throw new Failure("The profile service returned an invalid answer.");
  return { profileId, deviceId, name, statusKey };
}

/** Whether two reasoning snapshots (`{ run, items }`, or null) hold the same items and text. */
function sameReasoning(a, b) {
  if (a === b) return true;
  if (!a || !b || a.run !== b.run || a.items.length !== b.items.length) return false;
  return a.items.every((item, i) => {
    const other = b.items[i];
    return item.id === other.id && item.text === other.text && item.started === other.started && item.finished === other.finished && item.botId === other.botId;
  });
}

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
   * @param options.botkins  How a bot's Botkin is drawn for a gadget (botkin-svg.mjs): the design kit found beside the
   *   link when not given, `null` for none (a gadget then shows its own default Botkin).
   * @param options.relay  `false` keeps the relay off for this instance, whatever is saved (tests and the demo
   *   computer). An object { url?, WebSocket?, timers? } overrides the saved address, the socket class and the
   *   clock. Without it the saved settings apply (see setRelay and relay.mjs). `own: true` says the relay at
   *   that address is this server's own and the only way phones reach it: a headless host then keeps a phone's
   *   presence key from a pairing through it and takes the screen grant calls through it (grant.mjs).
   */
  constructor({ dir, backend, port, protect, reveal, extraHosts = [], searchPath, managerSearchPath, screenInput, relay, fetch, profileFetch, botkins, demoSpaceLinks = false, spaceLinkTiming, chunkTiming, log = () => {} }) {
    super();
    Object.assign(this, { backend, log, portOverride: port, extraHosts, fetch: fetch ?? globalThis.fetch, profileFetch: profileFetch ?? fetch ?? globalThis.fetch });
    this.botkins = botkins === undefined ? botkinRenderer() : botkins;
    // How often a phone that asked for text in chunks gets thinking and sentences (`every`) and the reply's own text (`live`), and how long text may wait for a sentence's end (tests set shorter ones).
    this.chunkTiming = { every: CHUNK_MS, live: CHUNK_LIVE_MS, holdMax: CHUNK_HOLD_MAX_MS, ...chunkTiming };
    this.relayOptions = relay === false ? null : relay && typeof relay === "object" ? relay : {};
    this.relayLink = null;
    this.store = new LinkStore(dir, { protect, reveal });
    this.credentials = new Credentials({ dir, protect, reveal, searchPath: managerSearchPath ?? searchPath, onChange: () => this.changed(), protonDemo: backend.protonDemo,
      onProtonFinished: (action, outcome) => this.log("Proton Pass setup: " + action + " (" + outcome + ")") });
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
      snapshot: () => this.lastState(),
      attention: () => this.attention(),
      // A chat's alerts go to its people only: who started it, and who was invited.
      people: (chat, person) => inChat(this.store.data.team, chat, person),
      changed: () => this.changed(),
      log: (line) => this.log(line),
      ...(fetch && { fetch }),
    });
    this.gadgets = new Gadgets(this);
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
      "link.voice.options": (_session, a) => this.voice.options(a[0], a[1], a[2]),
      "link.voice.transcribe": async (_session, a) => {
        const audio = Buffer.from(String(a[0]?.audio ?? ""), "base64");
        if (!audio.length) throw new Failure("There was nothing to hear.");
        if (audio.length > MAX_VOICE_AUDIO) throw new Failure("That recording is too long. Send it in shorter parts.");
        return this.voice.transcribe({ audio, format: a[0].format, language: a[0].language });
      },
      "link.voice.speak": async (_session, a) => {
        // `botId` ("bot-voice-v1"): the bot's own reading voice over the shared one. A voice or speed named here still wins.
        const spoken = await this.voice.speak({ text: a[0]?.text, voice: a[0]?.voice, speed: a[0]?.speed, override: this.botVoice(a[0]?.botId)?.tts });
        return { audio: spoken.audio.toString("base64"), format: spoken.format };
      },
      "link.voice.live": (session, a) => this.liveVoice(a[0], session.principal, session.deviceId),
      "link.voice.endLive": async (_session, a) => this.voice.endLive(a[0]),
      // Gadgets (gadget.mjs; the contract is gadget/docs/contract.md). An owner device names a gadget by its
      // key ("link.gadgets.add"); the rest are a gadget's own calls.
      "link.gadgets.add": async (_session, a) => this.gadgets.add(a[0]),
      "link.gadget.hello": async (session, a) => this.gadgets.hello(this.gadgets.of(session), a[0]),
      "link.gadget.set": async (session, a) => this.gadgets.set(this.gadgets.of(session), a[0]),
      "link.gadget.say": (session, a) => this.gadgets.say(this.gadgets.of(session), a[0]?.text, session.principal),
      "link.gadget.hear": (session, a) => this.gadgets.hear(this.gadgets.of(session), a[0], session.principal),
      "link.gadget.speak": (session, a) => this.gadgets.speak(this.gadgets.of(session), a[0]),
      "link.gadget.face": async (session, a) => this.gadgets.face(this.gadgets.of(session), a[0]),
      // The owner's: a gadget's settings and bot, a Wi-Fi network for it, and a restart. Each answers the device list, as rename does.
      "link.gadgets.configure": async (session, a) => (this.gadgets.configure(a[0], a[1]), this.devices(session.deviceId)),
      "link.gadgets.wifi": async (_session, a) => this.gadgets.queueWifi(a[0], a[1]),
      "link.gadgets.restart": async (_session, a) => this.gadgets.restart(a[0]),
      "link.device.sources": async (session, a) => this.device.setSources(session.deviceId, a[0]),
      "link.device.answer": async (session, a) => this.device.answer(session.deviceId, a[0], a[1]),
      "link.device.file": async (session, a) => this.device.file(session.deviceId, a[0]),
      // The devices paired with this computer (docs/link-contract.md): any paired device may read
      // the list, rename one and remove one, as the person can in the app on this computer.
      "link.devices.list": async (session) => this.devices(session.deviceId),
      "link.devices.rename": async (session, a) => this.renameDevice(a[0], a[1], session.deviceId),
      "link.devices.setPerson": async (session, a) => this.setDevicePerson(a[0], a[1], session.deviceId),
      "link.devices.remove": async (session, a) => this.revokeDevice(a[0], session.deviceId),
      "link.frame.page": async (_session, a) => this.framePage(a[0]),
      "link.frame.chat": async (_session, a) => this.frameChat(a[0]),
      "link.upload": (session, a) => this.uploads.put(session.deviceId, a[0]),
      "link.pullRequest": (_session, a) => this.prs.panel(a[0]),
      "link.pullRequestDiff": (_session, a) => this.prs.panel(a[0], true),
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
      "link.credentials.protonPassInstallPlan": () => this.protonPass("protonPassInstallPlan"),
      "link.credentials.protonPassInstall": (_session, a) => this.protonPass("protonPassInstall", a[0]),
      "link.credentials.protonPassSignInStart": (_session, a) => this.protonPass("protonPassSignInStart", a[0]),
      "link.credentials.protonPassSignInRead": (_session, a) => this.protonPass("protonPassSignInRead", a[0]),
      "link.credentials.protonPassSignInInput": (_session, a) => this.protonPass("protonPassSignInInput", a[0]),
      "link.credentials.protonPassSignInCancel": (_session, a) => this.protonPass("protonPassSignInCancel", a[0]),
      "link.credentials.protonPassDisconnect": (_session, a) => this.protonPass("protonPassDisconnect", a[0]),
      "link.screen.info": () => this.screen.info(),
      "link.screen.frame": (session, a, gone) => this.screen.frame(session.deviceId, a[0], gone),
      "link.screen.input": (session, a) => this.screen.input(session.deviceId, a[0], a[1]),
      "link.screen.stop": async (session) => this.screen.stop(session.deviceId),
      // Setting the level from a phone, on a headless host only (grant.mjs). `via` is how the call arrived.
      "link.screen.grant.begin": async (session, a, _gone, via) => this.grants.begin(session, via, a[0]),
      "link.screen.grant.confirm": async (session, a, _gone, via) => this.grants.confirm(session, via, a[0], a[1]),
      "link.screen.revoke": async (session, _a, _gone, via) => this.grants.revoke(session, via),
      "link.team.get": () => this.team(),
      "link.team.saveRole": async (_session, a) => this.saveRole(a[0]),
      "link.team.deleteRole": async (_session, a) => this.deleteRole(a[0]),
      "link.team.saveGroup": async (_session, a) => this.saveGroup(a[0]),
      "link.team.deleteGroup": async (_session, a) => this.deleteGroup(a[0], a[1]),
      "link.team.createInvite": async (_session, a) => this.createInvite(a[0]),
      "link.team.revokeInvite": async (_session, a) => this.revokeInvite(a[0]),
      "link.team.approve": async (_session, a) => this.approve(a[0], a[1]),
      "link.team.deny": async (_session, a) => this.deny(a[0]),
      "link.team.moveMember": async (_session, a) => this.moveMember(a[0], a[1]),
      "link.team.removeMember": async (_session, a) => this.removeMember(a[0]),
      "link.team.rename": async (_session, a) => this.renameTeam(a[0]),
      "link.team.renameMember": async (_session, a) => this.renameMember(a[0], a[1]),
      "link.team.inviteToChat": async (_session, a) => this.inviteToChat(a[0], a[1]),
      "link.team.removeFromChat": async (_session, a) => this.removeFromChat(a[0], a[1]),
      // Spaces: sharing, and the caller's own view of the list. The caller is the person.
      "link.spaces.share": async (session, a) => this.spaces.share(personOf(session.principal), a[0], a[1]),
      "link.spaces.newLink": async (session, a) => this.spaces.newLink(personOf(session.principal), a[0]),
      "link.spaces.arrange": async (session, a) => this.spaces.arrange(personOf(session.principal), a[0]),
      "link.spaces.seen": async (session, a) => this.spaces.seen(personOf(session.principal), a[0], a[1]),
      "link.spaces.notify": async (session, a) => this.spaces.notify(personOf(session.principal), a[0], a[1]),
      "link.spaces.here": async (session, a) => this.spaces.lookingAt(personOf(session.principal), a[0], a[1]),
      "link.team.setLinkSharing": async (_session, a) => this.spaces.setLinkSharing(a[0]),
      "link.team.setAdminMode": async (session, a) => this.setAdminMode(session.deviceId, a[0]),
      // Sections on the Chats screen: the caller's own.
      "link.chats.addSection": async (session, a) => this.chatSections.add(personOf(session.principal), a[0]),
      "link.chats.renameSection": async (session, a) => this.chatSections.rename(personOf(session.principal), a[0], a[1]),
      "link.chats.deleteSection": async (session, a) => this.chatSections.remove(personOf(session.principal), a[0]),
      "link.chats.orderSections": async (session, a) => this.chatSections.order(personOf(session.principal), a[0]),
      "link.chats.setSection": async (session, a) => this.chatSections.set(personOf(session.principal), a[0], a[1]),
      // Live typing state in a shared chat ("chat-typing-v1").
      "link.chat.typing": async (session, a) => this.setTyping(personOf(session.principal), session.deviceId, a[0], a[1]),
    };
    // Live typing state per (chatId, sourceId), purely in memory ("chat-typing-v1").
    this.typing = new ChatTyping({ changed: () => { this.changed(); this.emit("typing"); } });
    // Each person's sections for their chats ("chat-sections-v1", chat-sections.mjs).
    this.chatSections = new ChatSections({ team: () => this.store.data.team, setTeam: (team) => this.setTeam(team), chats: () => this.backend.snapshot().chats });
    // Spaces ("spaces-v1"): how each is shared and each person's view of the list (spaces.mjs).
    this.spaces = new Spaces({
      records: () => {
        const spaces = this.refreshState().spaces;
        return Array.isArray(spaces) ? spaces : null;
      },
      team: () => this.store.data.team,
      setTeam: (team) => this.setTeam(team),
      names: () => new Map(teamPeople(this.store.data.team, this.ownerName()).map((person) => [person.id, person.name])),
      relay: () => ({ on: !!this.relaySettings(), base: this.relayUrl(), publicKey: this.store.relayKey().publicKey }),
      changed: () => this.changed(),
      app: () => this.backend.spaces,
      demoLinks: demoSpaceLinks === true,
    });
    // A space shared by link: its sealed copy on the relay, kept fresh and taken back (space-links.mjs).
    this.spaceLinks = new SpaceLinks({
      team: () => this.store.data.team,
      setTeam: (team) => this.setTeam(team),
      records: () => {
        const spaces = this.refreshState().spaces;
        return Array.isArray(spaces) ? spaces : null;
      },
      relay: () => ({ on: !!this.relaySettings(), base: this.relayUrl(), key: this.relaySettings() ? this.store.relayKey() : this.store.data.relay.key }),
      snapshot: (id) => this.backend.spaces?.snapshot?.(id),
      newShare: () => this.spaces.newShare(),
      fetch: (...args) => this.fetch(...args),
      log: (line) => this.log(line),
      timing: spaceLinkTiming,
    });
    // Alerts about spaces: a note, a change, and once a day what changed (space-alerts.mjs).
    this.spaceAlerts = new SpaceAlerts({
      spaces: this.spaces,
      team: () => this.store.data.team,
      setTeam: (team) => this.setTeam(team),
      devices: () => this.store.data.devices,
      // An owner device with Admin mode off is shown only what the owner is part of.
      shown: (device) => this.spaces.for(device.memberId ?? OWNER, { partOnly: !device.memberId && device.admin !== true }),
      context: (person) => this.spaces.context(person),
      records: () => {
        const spaces = this.refreshState().spaces;
        return Array.isArray(spaces) ? spaces : null;
      },
      titles: () => {
        const state = this.refreshState();
        const titles = new Map([...(state.panels ?? []), ...(state.board ?? [])].map((item) => [item.id, item.title]));
        return (id) => titles.get(id);
      },
      names: () => new Map(teamPeople(this.store.data.team, this.ownerName()).map((person) => [person.id, person.name])),
      wants: (device) => this.push.wants(device, "spaces"),
      previews: (device) => this.store.push(device.id)?.prefs?.previews !== false,
      send: (device, content, options) => this.push.notify(device.id, content, options),
    });
    this.spaces.onShare = () => this.spaceLinks.sync();
    this.spaces.leaving = () => this.spaceLinks.leaving();
    this.spaceLinkMark = "";
    this.grants = new ScreenGrants({
      serverId: this.store.data.serverId,
      device: (id) => this.store.device(id),
      headless: () => this.headless(),
      apply: (level, by) => this.applyScreen(level, by),
      overRelay: () => this.ownRelay(),
    });
    this.epoch = b64u(random(6));
    this.sessions = new Map();
    this.deviceKeys = new Map();
    this.waiters = new Set();
    this.shared = null; // the app's state as the last refresh built it (see refreshState, lastState)
    this.refreshing = false;
    this.parts = new Map(); // name → { json, v }
    this.partViews = new Map(); // principal id → name → { json, v }
    this.partsRev = 0; // goes up when a part changes
    this.liveRev = 0; // goes up when the full live part changed: growing text changes only that, never its indicators
    this.teamRev = 0; // goes up when the team, or anyone's view, changes
    this.texts = new Map();
    this.reasoningParts = new Map();
    this.version = 0;
    this.dirty = true;
    this.pairing = null;
    this.joinTries = new Map();
    this.inviteTimers = new Map();
    this.server = null;
    this.port = 0;
    this.failures = { http: new Failures(FAIL_BACKSTOP.http), relay: new Failures(FAIL_BACKSTOP.relay) };
    this.nonces = new Map(); // device id → the last session nonces seen
    this.profileStatus = new Map(); // status key → { active, checkedAt }; 60s positive cache, 64 entries, checked on use and never polled
    this.profileStatusPending = new Map(); // status key → one in-flight check, so active traffic coalesces
    this.unsubscribe = backend.subscribe(() => {
      this.changed();
      this.push.soon();
    });
    // The first look only notes what is going on, so nothing old is announced.
    this.push.start();
    this.spaceAlerts.start();
  }

  // ── Live voice ──────────────────────────────────────────────────────────────────────────────

  /** A bot's own voice (`bot.voice`, as the app saved it), or null: the bot is unknown or uses the shared settings. */
  botVoice(botId) {
    if (typeof botId !== "string" || !botId) return null;
    const bot = (this.backend.snapshot().bots ?? []).find((item) => item.id === botId);
    return cleanBotVoice(bot?.voice);
  }

  /**
   * Sets up a live voice session for a chat with a bot. The voice is told who it speaks for, the
   * chat so far, what the app knows of the bot and the person (`backend.liveContext`), and roughly
   * where the person is when the phone sent it (`context.location`, never logged). It is given one
   * tool, `ask_bot`; the phone runs that tool by sending the message to the chat.
   */
  async liveVoice({ chatId, botId, provider, sdp, context } = {}, principal, deviceId) {
    const { location } = liveContextOf(context);
    const state = this.backend.snapshot();
    const chat = (state.chats ?? []).find((item) => item.id === chatId);
    const bot = (state.bots ?? []).find((item) => item.id === botId);
    if (!chat || !bot) throw new Failure("That chat is gone.");
    // The voice speaks for a bot of this chat, with that bot's voice: never another bot's against this chat.
    if (chat.botId !== bot.id && !(chat.botIds ?? []).includes(bot.id)) throw new Failure("That bot isn't in this chat.");
    // A member's call says so: the app leaves the owner's own notes out of what it hands over.
    const notes = await this.liveNotes(chat.id, bot.id, principal?.kind === "member" ? principal.memberId : undefined);
    const instructions = liveInstructions({ bot, messages: chat.messages ?? [], bots: state.bots ?? [], notes, location });
    const author = principal?.kind === "member" ? { memberId: principal.memberId, name: principal.name } : undefined;
    const session = await this.voice.live({ provider, sdp, instructions, tools: [ASK_BOT], about: { chatId: chat.id, botId: bot.id, botName: bot.name, ...(deviceId && { deviceId }), ...(author && { author }) }, override: cleanBotVoice(bot.voice)?.live });
    return { ...session, tools: [ASK_BOT] };
  }

  /**
   * What the app knows that a live voice may use: `backend.liveContext({ chatId, botId })`, which
   * returns (or resolves to) `{ userName?, identity?, user? }` as strings. Optional: without it, or
   * when it fails or takes over two seconds, the voice goes without.
   */
  async liveNotes(chatId, botId, memberId) {
    if (typeof this.backend.liveContext !== "function") return {};
    let timer;
    try {
      const notes = await Promise.race([Promise.resolve(this.backend.liveContext({ chatId, botId, ...(memberId && { memberId }) })), new Promise((resolve) => (timer = setTimeout(() => resolve(null), LIVE_NOTES_MS)))]);
      if (!isPlainObject(notes)) return {};
      return Object.fromEntries(["userName", "identity", "user"].filter((key) => typeof notes[key] === "string").map((key) => [key, notes[key]]));
    } catch {
      this.log("voice: the app's notes for a live call could not be read");
      return {};
    } finally {
      clearTimeout(timer);
    }
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
    void this.syncInvites();
    this.spaceLinks.sync();
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
    this.spaceAlerts.stop();
    this.spaces.dispose();
    this.typing.dispose();
    this.spaceLinks.stop();
    for (const timer of this.inviteTimers.values()) clearTimeout(timer);
    this.inviteTimers.clear();
    this.device.dispose();
    this.voice.close?.();
    this.screen.dispose();
    this.uploads.dispose();
    await this.credentials.proton.stop();
    await this.close();
  }

  protonPass(method, input) {
    if (this.backend.protonDemo) return this.backend.protonDemo.call(method, input);
    if (this.backend.protonSetup === false) throw new Failure("This computer doesn't support Proton Pass setup yet.");
    return this.credentials.protonPass(method, input);
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
  /** Whether the relay in use is this server's own (`relay.own`), so reaching the host through it counts as reaching the host. */
  ownRelay() {
    return this.relayOptions?.own === true && !!this.relaySettings();
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
    const next = new RelayHost({
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
    void this.syncInvites();
    // Switched off: the copies of spaces shared by link leave the relay. Back on: they are put out again.
    this.spaceLinks.sync();
    if (this.relayEntry() !== before) this.endSessions();
    this.dirty = true;
    this.changed();
    this.emit("status");
  }
  /** A new relay key, and so a new room. The old socket closes, the new entry is in hosts() at once, and the key is saved. */
  resetRelay() {
    const old = this.store.data.relay.key;
    this.store.resetRelayKey();
    this.applyRelay();
    void this.syncInvites();
    // A link's id belongs to the key: every link is a new one, and the old copies are taken back with the old key.
    this.spaceLinks.rekey(old);
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
      // Profile proofs and status keys are host-private; device lists are public Link state.
      devices: this.store.data.devices.map(({ publicKey: _key, profile: _profile, ...device }) => ({ ...device, connected: live.has(device.id), canNotify: device.kind !== "gadget" && this.push.view(device.id)?.routines === true })),
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
  /** The public descriptor shared by a bound owner/member profile and its Link enrollment. */
  profileDescriptor(principal) {
    const binding = this.profileBinding(principal);
    if (!binding || binding.revoked) throw new Failure("Bind this computer to your Botkins profile first.");
    return {
      serverId: this.store.data.serverId,
      serverKey: b64u(this.store.data.keys.publicKey),
      name: this.store.name,
      hosts: this.hosts(),
      ...(principal.kind === "member" && { member: true }),
    };
  }
  profileBinding(principal) {
    if (principal?.kind === "member") return this.store.data.profiles?.members?.[principal.memberId] ?? null;
    return this.store.data.profiles?.owner ?? null;
  }
  /** Calls the profile service, keeping its opaque ticket and status key on this host only. */
  async profileRequest(path, body) {
    let response;
    try {
      response = await this.profileFetch(PROFILE_ORIGIN + "/v1/" + path, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROFILE_REQUEST_TIMEOUT),
      });
    } catch {
      throw new Failure("The profile service can't be reached right now.");
    }
    let value = {};
    try { value = await response.json(); } catch {}
    if (!response.ok) throw new Failure("The profile service refused this request.");
    return value;
  }
  async redeemProfile(ticket, purpose, publicKey) {
    if (!profileText(ticket, PROFILE_MAX_TEXT)) throw new Failure("That profile ticket is invalid.");
    const body = { ticket, purpose, serverId: this.store.data.serverId, serverKey: b64u(this.store.data.keys.publicKey), ...(purpose === "connect" && { publicKey }) };
    return profileProof(await this.profileRequest("proofs/redeem", body));
  }
  async profileActive(statusKey) {
    if (!profileText(statusKey, PROFILE_MAX_TEXT)) return false;
    const now = Date.now();
    const cached = this.profileStatus.get(statusKey);
    if (cached && now - cached.checkedAt < PROFILE_STATUS_CACHE_MS) return cached.active;
    let pending = this.profileStatusPending.get(statusKey);
    if (!pending) {
      // Do not let a burst of distinct revoked/forged keys grow in-flight state without bound.
      if (this.profileStatusPending.size >= PROFILE_MAX_CACHE) return false;
      pending = (async () => {
        const value = await this.profileRequest("devices/status", { statusKey });
        const active = value?.active === true;
        this.profileStatus.delete(statusKey);
        this.profileStatus.set(statusKey, { active, checkedAt: Date.now() });
        while (this.profileStatus.size > PROFILE_MAX_CACHE) this.profileStatus.delete(this.profileStatus.keys().next().value);
        return active;
      })();
      this.profileStatusPending.set(statusKey, pending);
    }
    try { return await pending; } finally {
      if (this.profileStatusPending.get(statusKey) === pending) this.profileStatusPending.delete(statusKey);
    }
  }
  /** Binds a cloud profile to the principal already authenticated by this Link session. */
  async bindProfile(principal, proof, callerDeviceId) {
    if (!(await this.profileActive(proof.statusKey))) throw new Failure("That Botkins profile device is no longer active.");
    // The profile-service round trip is asynchronous: membership and the existing binding are
    // checked again immediately before the synchronous write, so a removed member cannot retain
    // their principal by racing a bind request.
    if (principal.kind === "member" && !this.store.data.team.members.some((member) => member.id === principal.memberId)) throw new Failure("That team membership is no longer available.");
    const current = this.profileBinding(principal);
    const all = [this.store.data.profiles?.owner, ...Object.values(this.store.data.profiles?.members ?? {})].filter(Boolean);
    const conflict = all.find((binding) => binding.profileId === proof.profileId && binding !== current);
    if (conflict) throw new Failure("That Botkins profile is already bound to another person on this computer.");
    if (current?.revoked) throw new Failure("This profile binding was revoked on this computer.");
    if (current && current.profileId !== proof.profileId) throw new Failure("This person already has a different Botkins profile bound.");
    if (callerDeviceId !== undefined) {
      const caller = this.store.device(callerDeviceId);
      const still = this.principal(callerDeviceId);
      if (!caller || !still || still.kind !== principal.kind || (still.kind === "member" && still.memberId !== principal.memberId)) throw new Failure("This device is no longer on the team.");
      // An explicitly bound legacy connection becomes subject to the same profile status key;
      // untouched QR/team pairings remain legacy-trusted until this call is made.
      caller.profile = { ...proof };
    }
    const binding = { ...proof, ...(current?.profileId === proof.profileId && current.revokedDeviceIds?.length && { revokedDeviceIds: [...current.revokedDeviceIds] }) };
    if (principal.kind === "member") {
      // The account's verified name is the member's host-facing display name. The stable
      // member id (and therefore its chats, views and permissions) remains unchanged.
      this.store.nameMember(principal.memberId, proof.name);
      const members = { ...(this.store.data.profiles?.members ?? {}), [principal.memberId]: binding };
      this.store.set({ profiles: { owner: this.store.data.profiles?.owner ?? null, members } });
    } else {
      this.store.set({ profiles: { owner: binding, members: { ...(this.store.data.profiles?.members ?? {}) } } });
    }
    this.changed();
    this.emit("status");
    return this.profileDescriptor(principal);
  }
  /** Local desktop/CLI owner binding; no Link session is involved. */
  async bindOwnerProfile(ticket) {
    return this.bindProfile({ kind: "owner" }, await this.redeemProfile(ticket, "bind"));
  }
  /** Removes one principal's current host grant and only its profile-backed devices/sessions. */
  unbindProfile(principal, expectedProfileId) {
    if (!profileText(expectedProfileId, PROFILE_MAX_TEXT)) throw new Failure("That profile id is invalid.");
    const current = this.profileBinding(principal);
    if (!current || current.profileId !== expectedProfileId) throw new Failure("That profile is not bound to this person on this computer.");
    const profiles = this.store.data.profiles ?? { owner: null, members: {} };
    if (principal.kind === "member") {
      const { [principal.memberId]: _gone, ...members } = profiles.members ?? {};
      this.store.set({ profiles: { owner: profiles.owner ?? null, members } });
    } else {
      this.store.set({ profiles: { owner: null, members: { ...(profiles.members ?? {}) } } });
    }
    const roleMatches = (device) => principal.kind === "member" ? device.memberId === principal.memberId : !device.memberId;
    for (const device of this.store.data.devices.filter((device) => roleMatches(device) && device.profile?.profileId === expectedProfileId)) {
      this.removeDevice(device.id, { keepProfileBinding: true });
    }
    this.changed();
    this.emit("status");
    return { unbound: true, profileId: expectedProfileId };
  }
  /** Local desktop/CLI owner unbind; an expected id prevents clearing a newer grant by race. */
  unbindOwnerProfile(expectedProfileId) {
    return this.unbindProfile({ kind: "owner" }, expectedProfileId);
  }
  /** Decrypts one profile enrollment and gives it the already-bound host role. */
  async profile(message) {
    let theirs;
    try { theirs = unb64u(message?.publicKey); } catch { throw new Refused(400, "bad_key"); }
    if (theirs.length !== 32 || typeof message?.box !== "string") throw new Refused(400, "bad_profile");
    let request;
    const key = hkdf(agree(this.store.data.keys, theirs), Buffer.from(this.store.data.serverId, "utf8"), PROFILE_KEY_INFO);
    try { request = unbox(key, message.box, "profile:" + this.store.data.serverId); } catch { throw new Refused(403, "profile_denied"); }
    if (!isPlainObject(request) || request.publicKey !== message.publicKey || !profileText(request.ticket, PROFILE_MAX_TEXT) || !isPlainObject(request.device)) throw new Refused(403, "profile_denied");
    const proof = await this.redeemProfile(request.ticket, "connect", message.publicKey);
    const owner = this.store.data.profiles?.owner;
    const memberEntries = Object.entries(this.store.data.profiles?.members ?? {});
    const entry = owner?.profileId === proof.profileId ? { binding: owner, memberId: null } : memberEntries.map(([memberId, binding]) => ({ binding, memberId })).find(({ binding }) => binding.profileId === proof.profileId) ?? null;
    // The bind proof's status key proves the account device at bind time. It is not the
    // authority for later enrollments: a profile may revoke that seed device while another
    // active profile device continues to enroll against this host binding.
    if (!entry || entry.binding.revoked) throw new Refused(403, "profile_denied");
    if (entry.memberId && !this.store.data.team.members.some((member) => member.id === entry.memberId)) throw new Refused(403, "profile_denied");
    let active = false;
    try { active = await this.profileActive(proof.statusKey); } catch { /* fail closed: no cloud status, no enrollment */ }
    if (!active) throw new Refused(403, "profile_denied");
    // The cloud device proof and role are rechecked after the status request: binding or
    // membership changes may have raced the network round trip.
    const current = this.profileBinding(entry.memberId ? { kind: "member", memberId: entry.memberId } : { kind: "owner" });
    if (!current || current.revoked || current.profileId !== proof.profileId || current.revokedDeviceIds?.includes(proof.deviceId) || (entry.memberId && !this.store.data.team.members.some((member) => member.id === entry.memberId))) throw new Refused(403, "profile_denied");
    // Re-enrolling the same account device replaces only that cloud device's local install.
    // A different account device on this host must remain connected.
    const old = this.store.data.devices.filter((device) => device.profile?.profileId === proof.profileId && device.profile?.deviceId === proof.deviceId && (device.memberId ?? null) === entry.memberId);
    for (const device of old) this.removeDevice(device.id, { keepProfileBinding: true });
    const supplied = request.device;
    const kind = supplied.kind === "desktop" ? "desktop" : "phone";
    const device = this.store.addDevice({
      name: supplied.name,
      platform: supplied.platform,
      kind,
      publicKey: theirs,
      ...(entry.memberId && { memberId: entry.memberId }),
      profile: { ...proof },
    });
    this.changed();
    const { publicKey: _publicKey, profile: _profile, ...visible } = device;
    this.emit("paired", visible);
    this.emit("status");
    return box(key, { serverId: this.store.data.serverId, serverKey: b64u(this.store.data.keys.publicKey), device: device.id, name: this.store.name, hosts: this.hosts(), ...(entry.memberId && { member: true }) }, "profile-ok:" + this.store.data.serverId);
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
  principal(deviceId) {
    const device = this.store.device(deviceId);
    if (!device) return null;
    // Admin mode is each owner device's own: it changes what the device is shown, never what it may do.
    if (!device.memberId) return { kind: "owner", ...(device.admin === true && { admin: true }) };
    const member = this.store.data.team.members.find((item) => item.id === device.memberId);
    if (!member) return null;
    return { kind: "member", memberId: member.id, name: member.name, groupId: member.groupId };
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
      ...(device.person && { person: device.person }),
      platform: device.platform,
      kind: device.kind,
      // A gadget's board and firmware, as it said them, and the bot it talks with.
      ...(device.kind === "gadget" && { gadget: this.gadgetView(device) }),
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      connected: live.has(device.id),
      canNotify: device.kind !== "gadget" && this.push.view(device.id)?.routines === true,
      ...(device.id === asking && { current: true }),
    }));
  }
  /**
   * Pairs a gadget by introduction, for the app on this computer (its Gadgets page, `botkins gadgets
   * add`): `{ publicKey, name?, board?, botId? }`, the key as the gadget gave it over a cable.
   * Answers `{ deviceId, serverId, serverKey, name, hosts }`, which the app hands to the gadget.
   */
  addGadget(input) {
    return this.gadgets.add(input);
  }
  /** A gadget as the device list shows it: its board, firmware and bot, its settings, and its Wi-Fi (names only). */
  gadgetView(device) {
    const { board, firmware, botId, settings, wifi } = device.gadget ?? {};
    return {
      ...(board && { board }),
      ...(firmware && { firmware }),
      ...(botId && { botId }),
      settings: { ...GADGET_DEFAULTS, ...settings },
      ...(wifi && { wifi }),
      ...(this.gadgets.pendingWifi(device.id).length > 0 && { wifiWaiting: this.gadgets.pendingWifi(device.id).map((change) => (change.add ? { add: change.add.ssid } : { forget: change.forget })) }),
      ...(this.gadgets.restarts.has(device.id) && { restarting: true }),
    };
  }
  /** For the app on this computer (its page for a gadget, `botkins gadgets`): the same as the owner's calls from a phone. */
  configureGadget(id, patch) {
    this.gadgets.configure(id, patch);
    return this.devices().find((device) => device.id === id);
  }
  gadgetWifi(id, change) {
    return this.gadgets.queueWifi(id, change);
  }
  restartGadget(id) {
    return this.gadgets.restart(id);
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
  /** Names the person a paired device belongs to ("Jordan"); its `name` stays the device's. A member's device names the member. */
  setDevicePerson(id, person, asking) {
    const device = typeof id === "string" ? this.store.device(id) : null;
    if (!device) throw new Failure("That device is no longer paired.");
    if (typeof person !== "string" || !personName(person) || person.length > 200) throw new Failure("Give the person a name.");
    this.store.setPerson(id, person);
    this.dirty = true;
    this.changed();
    if (device.memberId) this.teamChanged();
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
      if (device.memberId) continue;
      if (device.kind !== "desktop") continue;
      const front = this.push.frontOf(device.id);
      if (front) return { focused: true, ...(front.chatId && { chatId: front.chatId }) };
    }
    return own;
  }
  /** Context for routine notification target discovery, validation, and resolution ("routine-notify-targets-v1"). */
  notifyTargetsContext() {
    return {
      team: this.team(),
      devices: this.store.data.devices.map((device) => ({
        id: device.id,
        name: device.name,
        kind: device.kind,
        platform: device.platform,
        ...(device.memberId && { memberId: device.memberId }),
        canNotify: device.kind !== "gadget" && this.push.view(device.id)?.routines === true,
      })),
      host: {
        name: this.store.name || "This computer",
        platform: process.platform,
        headless: this.headless(),
        profileLinked: Boolean(this.store.data.profiles?.owner),
      },
      profiles: this.store.data.profiles ?? null,
      ownerName: this.ownerName(),
    };
  }
  /** The non-gadget paired devices belonging to one member, for their `team.me.devices` sync view. */
  memberDevices(memberId) {
    const live = this.liveDevices();
    return this.store.data.devices
      .filter((device) => device.memberId === memberId && device.kind !== "gadget")
      .map((device) => ({
        id: device.id,
        name: device.name,
        kind: device.kind,
        platform: device.platform,
        connected: live.has(device.id),
        canNotify: this.push.view(device.id)?.routines === true,
      }));
  }
  // ── Teams and invites ───────────────────────────────────────────────────────────────

  team() {
    this.pruneTeamRequests();
    const live = this.liveDevices();
    const team = this.store.data.team;
    const serverKey = b64u(this.store.data.keys.publicKey);
    return {
      people: teamPeople(team, this.ownerName()),
      name: team.name,
      // "Members may share by link" ("spaces-v1"), as the owner's Team settings and `botkins sharing links` show it.
      linkSharing: team.linkSharing === true,
      roles: structuredClone(team.roles),
      groups: structuredClone(team.groups),
      members: team.members.map((member) => ({
        ...structuredClone(member),
        devices: this.store.data.devices.filter((device) => device.memberId === member.id).map((device) => ({
          id: device.id,
          name: device.name,
          ...(device.person && { person: device.person }),
          kind: device.kind,
          platform: device.platform,
          connected: live.has(device.id),
          canNotify: device.kind !== "gadget" && this.push.view(device.id)?.routines === true,
        })),
      })),
      invites: team.invites.map((invite) => ({ ...structuredClone(invite), link: inviteLink(invite.code, serverKey, this.relayUrl()) })),
      requests: team.requests.filter((request) => request.status === "pending").map((request) => ({
        id: request.id,
        name: request.name,
        ...(request.person && { person: request.person }),
        platform: request.platform,
        kind: request.kind,
        at: request.at,
        inviteId: request.inviteId,
      })),
    };
  }
  teamChanged() {
    this.dirty = true;
    this.teamRev++;
    for (const session of this.sessions.values()) session.principal = this.principal(session.deviceId);
    this.changed();
    this.emit("status");
  }
  setTeam(team) {
    this.store.set({ team });
    this.teamChanged();
  }
  /**
   * Sets or clears one person's own picture ("people-avatars-v1"): "owner" or a member's id, as the caller is.
   * The picture is checked here (cleanAvatar) whoever sends it. Answers `{ avatar }`, or `{}` when there is none.
   */
  setAvatar(person, image) {
    let avatar;
    try {
      avatar = cleanAvatar(image);
    } catch (error) {
      throw new Failure(error.message);
    }
    const team = this.store.data.team;
    if (person !== OWNER && !team.members.some((member) => member.id === person)) throw new Failure("That team membership is no longer available.");
    const { [person]: before, ...avatars } = team.avatars ?? {};
    if (avatar) avatars[person] = avatar;
    // An unchanged picture is not saved or sent again.
    if ((before ?? null) !== avatar) this.setTeam({ ...team, avatars });
    return avatar ? { avatar } : {};
  }
  saveRole(role) {
    const clean = cleanRole(role);
    const roles = this.store.data.team.roles.filter((item) => item.id !== clean.id);
    roles.push(clean);
    this.setTeam({ ...this.store.data.team, roles });
    return this.team();
  }
  deleteRole(id) {
    const team = this.store.data.team;
    if (!team.roles.some((role) => role.id === id)) throw new Failure("That role no longer exists.");
    if (team.groups.some((group) => group.roleId === id)) throw new Failure("Move every group off this role before deleting it.");
    this.setTeam({ ...team, roles: team.roles.filter((role) => role.id !== id) });
    return this.team();
  }
  saveGroup(group) {
    const clean = cleanGroup(group);
    if (!this.store.data.team.roles.some((role) => role.id === clean.roleId)) throw new Failure("Choose a role that still exists.");
    const groups = this.store.data.team.groups.filter((item) => item.id !== clean.id);
    groups.push(clean);
    this.setTeam({ ...this.store.data.team, groups });
    return this.team();
  }
  deleteGroup(id, moveTo) {
    const team = this.store.data.team;
    const group = team.groups.find((item) => item.id === id);
    if (!group || id === "g_everyone") throw new Failure("That group can't be deleted.");
    const moving = team.members.filter((member) => member.groupId === id);
    const invited = team.invites.filter((invite) => invite.groupId === id);
    const requests = team.requests.filter((request) => request.groupId === id && request.status === "pending");
    if (moving.length || invited.length || requests.length) {
      if (!team.groups.some((item) => item.id === moveTo && item.id !== id)) throw new Failure("Choose a group to move these members to.");
      for (const member of moving) member.groupId = moveTo;
      for (const invite of invited) invite.groupId = moveTo;
      for (const request of requests) request.groupId = moveTo;
    }
    this.setTeam({ ...team, groups: team.groups.filter((item) => item.id !== id) });
    return this.team();
  }
  async createInvite({ groupId = "g_everyone", days = 7, maxUses = 1 } = {}) {
    if (![1, 7, 30].includes(days) || ![1, 5, 25].includes(maxUses)) throw new Failure("Choose 1, 7 or 30 days and 1, 5 or 25 uses.");
    if (!this.store.data.team.groups.some((group) => group.id === groupId)) throw new Failure("Choose a group that still exists.");
    let code;
    do code = newInviteCode(); while (this.store.data.team.invites.some((invite) => invite.code === code));
    const now = Date.now();
    const invite = { id: "i_" + newInviteCode(), code, groupId, createdAt: now, expiresAt: now + days * 24 * 60 * 60_000, maxUses, uses: 0, published: false };
    this.store.set({ team: { ...this.store.data.team, invites: [...this.store.data.team.invites, invite] } });
    this.scheduleInvite(invite);
    this.dirty = true;
    this.changed();
    await this.publishInvite(invite);
    this.emit("status");
    return { ...invite, link: inviteLink(invite.code, b64u(this.store.data.keys.publicKey), this.relayUrl()) };
  }
  liveInvite(invite) {
    return !!invite && !invite.revoked && invite.expiresAt > Date.now() && invite.uses < invite.maxUses;
  }
  findInvite(value) {
    const code = normalizeCode(value);
    return this.store.data.team.invites.find((invite) => invite.code === code && this.liveInvite(invite));
  }
  async revokeInvite(id) {
    const invite = this.store.data.team.invites.find((item) => item.id === id);
    if (!invite) throw new Failure("That invite no longer exists.");
    const published = invite.published === true;
    invite.revoked = true;
    invite.published = false;
    clearTimeout(this.inviteTimers.get(id));
    this.inviteTimers.delete(id);
    this.store.save();
    if (published) await this.deleteInviteCard(invite).catch(() => {});
    this.teamChanged();
    return this.team();
  }
  async publishInvite(invite) {
    if (!this.liveInvite(invite) || !this.relaySettings()) {
      invite.published = false;
      this.store.save();
      return false;
    }
    const relayKey = this.store.relayKey();
    const room = roomOf(relayKey.publicKey);
    const lookup = inviteLookup(invite.code);
    const cardKey = hkdf(Buffer.from(invite.code, "utf8"), Buffer.from("botkins-invite-card-v1", "utf8"), lookup);
    const cardValue = Buffer.from(JSON.stringify({ v: 1, serverId: this.store.data.serverId, serverKey: b64u(this.store.data.keys.publicKey), name: this.store.data.team.name, room, hosts: this.hosts() }), "utf8");
    const nonce = random(12);
    const card = b64u(Buffer.concat([nonce, seal(cardKey, nonce, cardValue, "")]));
    const cardHash = createHash("sha256").update(card, "utf8").digest("base64url");
    const time = Math.floor(Date.now() / 1000);
    const signature = signWithRelayKey(relayKey, `botkins-relay-invite-v1:${room}:${lookup}:${invite.expiresAt}:${cardHash}:${time}`);
    try {
      const response = await this.fetch(String(this.relayUrl()).replace(/\/+$/, "") + "/v1/invites/" + lookup, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-botkins-key": relayKey.publicKey, "x-botkins-time": String(time), "x-botkins-sig": signature },
        body: JSON.stringify({ card, expiresAt: invite.expiresAt }),
        signal: AbortSignal.timeout(INVITE_CARD_TIMEOUT),
      });
      invite.published = response?.status === 204;
    } catch {
      invite.published = false;
    }
    this.store.save();
    this.dirty = true;
    this.changed();
    return invite.published;
  }
  async deleteInviteCard(invite) {
    const relayKey = this.store.data.relay.key;
    if (!relayKey || !validRelayKey(relayKey)) return false;
    const room = roomOf(relayKey.publicKey);
    const lookup = inviteLookup(invite.code);
    const time = Math.floor(Date.now() / 1000);
    try {
      const response = await this.fetch(String(this.relayUrl()).replace(/\/+$/, "") + "/v1/invites/" + lookup, {
        method: "DELETE",
        headers: { "x-botkins-key": relayKey.publicKey, "x-botkins-time": String(time), "x-botkins-sig": signWithRelayKey(relayKey, `botkins-relay-invite-del-v1:${room}:${lookup}:${time}`) },
        signal: AbortSignal.timeout(INVITE_CARD_TIMEOUT),
      });
      return response?.status === 204;
    } catch {
      return false;
    }
  }
  scheduleInvite(invite) {
    clearTimeout(this.inviteTimers.get(invite.id));
    if (!this.liveInvite(invite)) return;
    const left = Math.max(0, invite.expiresAt - Date.now());
    const timer = setTimeout(async () => {
      if (invite.expiresAt > Date.now()) return this.scheduleInvite(invite);
      this.inviteTimers.delete(invite.id);
      invite.published = false;
      this.store.save();
      await this.deleteInviteCard(invite);
      this.teamChanged();
    }, Math.min(left, 2_147_000_000));
    timer.unref?.();
    this.inviteTimers.set(invite.id, timer);
  }
  async syncInvites() {
    for (const invite of this.store.data.team.invites) {
      this.scheduleInvite(invite);
      if (this.liveInvite(invite) && this.relaySettings()) await this.publishInvite(invite);
      else if (invite.published) {
        const published = invite.published;
        invite.published = false;
        if (published) await this.deleteInviteCard(invite);
      }
    }
    this.store.save();
  }
  pruneTeamRequests() {
    const before = this.store.data.team.requests.length;
    const now = Date.now();
    const kept = this.store.data.team.requests.filter((request) => request.status === "pending" || (request.status === "denied" && now - request.deniedAt < DENIED_REQUEST_MS) || (request.status === "approved" && now - request.approvedAt < DENIED_REQUEST_MS));
    if (kept.length !== before) this.store.set({ team: { ...this.store.data.team, requests: kept } });
  }
  join(message, source = "", direct = false) {
    this.pruneTeamRequests();
    const { serverId, keys } = this.store.data;
    let theirs;
    try {
      theirs = unb64u(message?.key);
      if (theirs.length !== 32) throw new Error("Bad key");
    } catch {
      throw new Refused(400, "bad_key");
    }
    const publicKey = b64u(theirs);
    const owner = this.store.data.devices.find((device) => !device.memberId && device.publicKey === publicKey);
    if (owner) throw new Refused(409, "join_owner");
    let shared;
    try {
      shared = agree(keys, theirs);
    } catch {
      throw new Refused(400, "bad_key");
    }
    const existing = this.store.data.team.requests.find((request) => request.publicKey === publicKey);
    let request = existing;
    let invite = existing ? this.store.data.team.invites.find((item) => item.id === existing.inviteId) : null;
    let key;
    let hello;
    if (existing) {
      key = hkdf(shared, Buffer.from(existing.code, "utf8"), "botkins-join-v1");
      try {
        hello = unbox(key, message.box, "join:" + serverId);
      } catch {
        throw new Refused(403, "join_closed");
      }
    } else {
      if ((this.joinTries.get(source) ?? 0) >= JOIN_TRIES_PER_SOURCE) throw new Refused(429, "join_wait");
      for (const candidate of this.store.data.team.invites) {
        if (!this.liveInvite(candidate)) continue;
        const candidateKey = hkdf(shared, Buffer.from(candidate.code, "utf8"), "botkins-join-v1");
        try {
          hello = unbox(candidateKey, message.box, "join:" + serverId);
          invite = candidate;
          key = candidateKey;
          break;
        } catch {}
      }
      if (!hello || !invite) {
        const used = (this.joinTries.get(source) ?? 0) + 1;
        this.joinTries.set(source, used);
        if (this.joinTries.size > MAX_SOURCES) this.joinTries.delete(this.joinTries.keys().next().value);
        throw new Refused(used >= JOIN_TRIES_PER_SOURCE ? 429 : 403, used >= JOIN_TRIES_PER_SOURCE ? "join_wait" : "join_closed");
      }
      if (this.store.data.team.requests.filter((item) => item.status === "pending").length >= JOIN_PENDING_MAX) throw new Refused(429, "join_wait");
      const at = Date.now();
      request = {
        id: "q_" + newInviteCode(),
        status: "pending",
        publicKey,
        code: invite.code,
        name: String(hello?.name || "Team member").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) || "Team member",
        ...(personName(hello?.person) && { person: personName(hello?.person) }),
        platform: String(hello?.platform || "").slice(0, 20),
        kind: deviceKind(hello?.kind, hello?.platform),
        presenceKey: direct ? cleanPresenceKey(hello?.presenceKey) : null,
        groupId: invite.groupId,
        inviteId: invite.id,
        at,
      };
      this.store.set({ team: { ...this.store.data.team, requests: [...this.store.data.team.requests, request] } });
      this.joinTries.delete(source);
      this.teamChanged();
      this.emit("joinRequest", { id: request.id, name: request.name, ...(request.person && { person: request.person }), platform: request.platform, kind: request.kind, at, inviteId: invite.id });
      this.push.teamJoin?.(request);
    }
    if (request.status === "denied") return { box: box(key, { status: "denied" }, "joined:" + serverId) };
    if (request.status === "approved") {
      return { box: box(key, { status: "approved", device: request.deviceId, serverId, name: this.store.name, hosts: this.hosts() }, "joined:" + serverId) };
    }
    return { box: box(key, { status: "pending", requestId: request.id, team: { name: this.store.data.team.name } }, "joined:" + serverId) };
  }
  async approve(requestId, groupId) {
    const team = this.store.data.team;
    const request = team.requests.find((item) => item.id === requestId && item.status === "pending");
    if (!request) throw new Failure("That join request is no longer pending.");
    const chosen = groupId ?? request.groupId;
    const group = team.groups.find((item) => item.id === chosen);
    if (!group) throw new Failure("Choose a group that still exists.");
    const invite = team.invites.find((item) => item.id === request.inviteId);
    if (invite && invite.uses >= invite.maxUses) throw new Failure("That invite has already been used up.");
    const memberId = "m_" + newInviteCode();
    const member = { id: memberId, name: request.person || request.name, groupId: chosen, joinedAt: Date.now(), deviceIds: [] };
    const device = this.store.addDevice({ name: request.name, platform: request.platform, kind: request.kind, publicKey: unb64u(request.publicKey), presenceKey: request.presenceKey, memberId, person: request.person });
    member.deviceIds.push(device.id);
    team.members.push(member);
    Object.assign(request, { status: "approved", approvedAt: Date.now(), memberId, deviceId: device.id });
    if (invite) {
      invite.uses++;
      if (invite.uses >= invite.maxUses) {
        const published = invite.published === true;
        invite.published = false;
        if (published) await this.deleteInviteCard(invite);
        clearTimeout(this.inviteTimers.get(invite.id));
        this.inviteTimers.delete(invite.id);
      }
    }
    this.store.save();
    this.teamChanged();
    return this.team();
  }
  deny(requestId) {
    const request = this.store.data.team.requests.find((item) => item.id === requestId && item.status === "pending");
    if (!request) throw new Failure("That join request is no longer pending.");
    request.status = "denied";
    request.deniedAt = Date.now();
    this.store.save();
    this.teamChanged();
    return this.team();
  }
  moveMember(memberId, groupId) {
    const team = this.store.data.team;
    const member = team.members.find((item) => item.id === memberId);
    if (!member) throw new Failure("That member is no longer on the team.");
    if (!team.groups.some((item) => item.id === groupId)) throw new Failure("Choose a group that still exists.");
    member.groupId = groupId;
    this.store.save();
    this.teamChanged();
    return this.team();
  }
  /**
   * The owner renames a member ("member-rename-v1"). The member and each of their devices take the
   * name, as when a member's device sets its person, and every session is told at once. The name
   * has the rules of the team's: trimmed, up to 60 characters, no control characters.
   */
  renameMember(memberId, name) {
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean || clean.length > 60 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Failure("Give the member a name of up to 60 characters.");
    if (!this.store.renameMember(memberId, clean)) throw new Failure("That member is no longer on the team.");
    this.dirty = true;
    this.teamChanged();
    return this.team();
  }
  removeMember(memberId) {
    const team = this.store.data.team;
    const member = team.members.find((item) => item.id === memberId);
    if (!member) throw new Failure("That member is no longer on the team.");
    for (const device of this.store.data.devices.filter((item) => item.memberId === memberId)) this.removeDevice(device.id);
    const profiles = this.store.data.profiles ?? { owner: null, members: {} };
    if (profiles.members?.[memberId]) {
      const { [memberId]: _profileGone, ...members } = profiles.members;
      this.store.set({ profiles: { owner: profiles.owner ?? null, members } });
    }
    // Their invitations and their own view go with them.
    const chats = Object.fromEntries(Object.entries(team.chats ?? {}).map(([id, invited]) => [id, invited.filter((person) => person !== memberId)]).filter(([, invited]) => invited.length));
    const { [memberId]: _gone, ...views } = team.views ?? {};
    const { [memberId]: _picture, ...avatars } = team.avatars ?? {};
    // Their grants on spaces go; the spaces they made pass to the owner and become private.
    this.typing.forgetPerson(memberId);
    this.setTeam({ ...this.spaces.withoutMember(team, memberId), members: team.members.filter((item) => item.id !== memberId), chats, views, avatars });
    this.spaceLinks.sync();
    return this.team();
  }

  // ── People in a chat, and each member's own view ("team-people-v1") ─────────────────

  /** Admin mode for one owner device. Answers what it is now. */
  setAdminMode(deviceId, on) {
    if (!this.store.setAdmin(deviceId, on === true)) throw new Failure("Only the owner's own devices have Admin mode.");
    this.teamChanged();
    return on === true;
  }
  /**
   * For the app on the host, whose window has no device: its own snapshot's lists as an owner
   * without Admin mode is shown them. `parts` holds any of `chats`, `live`, `runs`, `bots`, `panels`, `board`.
   */
  ownerParts(parts) {
    const records = this.backend.snapshot().spaces;
    return ownerParts(parts, this.store.data.team, Array.isArray(records) ? { spaces: records, ...this.spaces.context(OWNER) } : {});
  }
  // ── Spaces, for the app on the host (the person first: "owner" for its own window) ──
  /**
   * The app says what a person did in a space, so the others who want to hear of it are told
   * (docs/spaces.md, "Notifications"): `{ spaceId, panelId?, by, kind: "note" | "change", text?, label? }`.
   * `by` is the person ("owner" or a member's id); `text` is a note's words, `label` a change's
   * ("Ticked Press kit"). The link picks who is told. Answers how many alerts it sent.
   */
  spaceEvent(event) {
    return this.spaceAlerts.event(event);
  }
  /** `admin: false` answers what the owner is part of (Admin mode off); the default is every space, as for an owner with it on. */
  spacesFor(person, { admin = true } = {}) {
    return this.spaces.for(person, { partOnly: person === OWNER && !admin });
  }
  /** "own", "edit", "view" or null. `space` is a space's id, or the app's own record of it (`SpaceRecord`). */
  spaceCan(space, person) {
    return this.spaces.can(space, person);
  }
  shareSpace(person, id, input) {
    return this.spaces.share(person, id, input);
  }
  newSpaceLink(person, id) {
    return this.spaces.newLink(person, id);
  }
  arrangeSpaces(person, input) {
    return this.spaces.arrange(person, input);
  }
  seenSpace(person, id, itemId) {
    return this.spaces.seen(person, id, itemId);
  }
  notifySpace(person, id, mode) {
    return this.spaces.notify(person, id, mode);
  }
  hereInSpace(person, id, panelId) {
    return this.spaces.lookingAt(person, id, panelId);
  }
  setLinkSharing(on) {
    return this.spaces.setLinkSharing(on);
  }
  // ── Sections on the Chats screen, for the app on the host (the person first: "owner" for its own window) ──
  /** `{ list, of }`: the person's sections in their order, and chat id → section id for their chats. */
  chatSectionsFor(person) {
    return this.chatSections.for(person);
  }
  addChatSection(person, name) {
    return this.chatSections.add(person, name);
  }
  renameChatSection(person, id, name) {
    return this.chatSections.rename(person, id, name);
  }
  deleteChatSection(person, id) {
    return this.chatSections.remove(person, id);
  }
  orderChatSections(person, ids) {
    return this.chatSections.order(person, ids);
  }
  setChatSection(person, chatId, sectionId) {
    return this.chatSections.set(person, chatId, sectionId);
  }
  /**
   * The team as the app may know it, for an app that runs apart from the link (the server host's
   * workspace container): enough for `spaceCan`, `chatPeople`, `inChat` and a role check, and
   * nothing more. Never a link's key, an invite's code, a device or a person's own view.
   */
  teamForApp() {
    const team = this.store.data.team;
    return {
      name: team.name,
      owner: this.ownerName(),
      roles: team.roles ?? [],
      groups: team.groups ?? [],
      members: (team.members ?? []).map((member) => ({ id: member.id, name: member.name, groupId: member.groupId })),
      chats: team.chats ?? {},
      spaces: Object.fromEntries(Object.entries(team.spaces ?? {}).map(([id, entry]) => [id, { access: entry?.access, grants: entry?.grants ?? [], teamCan: entry?.teamCan }])),
    };
  }
  /** The app deleted a space from its own window: its sharing goes, and its link's copy leaves the relay. */
  spaceRemoved(id) {
    this.spaces.removed(String(id));
  }
  /**
   * `spaces.read`'s answer for one person: panels as `PanelView`, and for a member only the panels
   * and cards of bots their role sees. `seenAt` is when they last opened the space before this read.
   */
  spaceContent(principal, answer, state) {
    if (!answer || typeof answer !== "object") return answer;
    const team = this.store.data.team;
    const person = personOf(principal);
    const member = principal.kind === "member";
    const role = member ? roleOfMember(team, person) : null;
    const sees = (botId) => !member || role?.bots === "all" || (Array.isArray(role?.bots) && role.bots.includes(botId));
    const space = (state.spaces ?? []).find((item) => item.id === answer.id);
    const can = spaceCan(team, space, person);
    const mayChange = (can === "own" || can === "edit") && (!member || hasAction(role?.perms, "today", "manage"));
    const chats = new Map((state.chats ?? []).map((chat) => [chat.id, chat]));
    const cut = (panel) => panelView(panel, { member, inChat: (chatId) => inChat(team, chats.get(chatId), person), mayChange });
    return {
      ...answer,
      seenAt: Number(spacesViewOf(team, person).seen[answer.id]) || 0,
      seenItems: seenItemsOf(spacesViewOf(team, person), answer),
      panels: (answer.panels ?? []).filter((panel) => sees(panel.botId)).map(cut),
      cards: (answer.cards ?? []).filter((card) => sees(card.botId)),
    };
  }
  /** What the owner is called as a person: the name on one of the owner's devices ("Your name"), else the computer's. */
  ownerName() {
    return this.store.data.profiles?.owner?.name || this.store.data.devices.find((device) => !device.memberId && device.person)?.person || this.store.name || "";
  }
  /** A member as the link's rules see them, by id. */
  principalOfMember(memberId) {
    const member = this.store.data.team.members.find((item) => item.id === memberId);
    return { kind: "member", memberId, name: member?.name ?? "", groupId: member?.groupId };
  }
  chatOf(chatId) {
    return (this.backend.snapshot().chats ?? []).find((chat) => chat.id === chatId);
  }
  /** Only an existing private owner chat may discover entry labels for one exact HTTPS origin. */
  loginNames(chatId, origin) {
    const chat = this.chatOf(chatId);
    if (!chat) return [];
    const { createdBy, invited } = chatPeople(this.store.data.team, chat);
    if (createdBy !== OWNER || invited.length || typeof origin !== "string" || !origin.startsWith("https://")) return [];
    return this.credentials.list().filter(entry => {
      if (!entry.website) return false;
      try {
        const site = new URL(entry.website.includes("://") ? entry.website : "https://" + entry.website);
        return site.origin === origin;
      } catch { return false; }
    }).map(({ name, kind }) => ({ name, kind }));
  }
  /** Who started a chat and who was invited. An unknown chat is the owner's, with nobody invited. */
  chatPeople(chatId) {
    return chatPeople(this.store.data.team, this.chatOf(chatId) ?? { id: chatId });
  }
  /** Map of chatId -> invited person ids, for the local desktop window's snapshot. */
  chatInvites() {
    return Object.fromEntries(Object.entries(this.store.data.team.chats ?? {}).filter(([, list]) => Array.isArray(list) && list.length).map(([id, list]) => [id, [...list]]));
  }
  /** Current map of chatId -> people typing right now, with display names. */
  typingSnapshot() {
    const names = new Map(teamPeople(this.store.data.team, this.ownerName()).map((person) => [person.id, person.name]));
    return this.typing.snapshot(names);
  }
  /** Update typing state for one person/source in a chat ("chat-typing-v1"). */
  setTyping(person, sourceId, chatId, active) {
    if (typeof chatId !== "string" || !chatId) return null;
    if (active === true) {
      const chat = this.chatOf(chatId);
      if (!chat || !inChat(this.store.data.team, chat, person)) return null;
    }
    this.typing.set({ chatId, personId: person, sourceId: String(sourceId || person), typing: active === true });
    return null;
  }
  /** Clear typing for one person in one chat (e.g. immediately after sending a message). */
  clearTyping(chatId, person) {
    if (typeof chatId !== "string" || !chatId) return;
    this.typing.clearPerson(chatId, person);
  }
  /** Whether a person ("owner" or a member's id) is in a chat. */
  inChat(chatId, person) {
    const chat = this.chatOf(chatId);
    return chat ? inChat(this.store.data.team, chat, person) : person === OWNER;
  }
  /** Whether a chat's replies and questions are the owner's to hear of: the owner started it or was invited. */
  notifiesOwner(chatId) {
    return this.inChat(chatId, OWNER);
  }
  inviteToChat(chatId, person) {
    const team = this.store.data.team;
    const state = this.backend.snapshot();
    const chat = (state.chats ?? []).find((item) => item.id === chatId);
    if (!chat) throw new Failure("That chat is no longer available.");
    if (chat.hostDispatch) throw new Failure("A cross-host Teamwork chat is private to the owner.");
    if (chat.main) throw new Failure("Main chat stays private. Invite people to a new chat instead.");
    if (privateProactiveChat(chat)) throw new Failure("This chat holds one person's alerts and can't be shared.");
    if (person !== OWNER && !team.members.some((member) => member.id === person)) throw new Failure("That person is no longer on the team.");
    const people = chatPeople(team, chat);
    if (people.createdBy === person || people.invited.includes(person)) return people.invited;
    // An invite never widens a role: the person's role has to allow the chat's bot.
    if (person !== OWNER && authorize(this.principalOfMember(person), team, "link.messages", [chatId, 0], { chat: () => ({ ...chat, createdBy: person }), bot: (id) => (state.bots ?? []).find((bot) => bot.id === id) })) throw new Failure("That person's role can't use this chat's bot. Change their role in Team settings first.");
    if (people.invited.length + 1 >= MAX_CHAT_PEOPLE) throw new Failure("A chat holds up to " + MAX_CHAT_PEOPLE + " people.");
    // Chats that are gone leave the list when it is next changed.
    const known = new Set((state.chats ?? []).map((item) => item.id));
    const chats = Object.fromEntries(Object.entries(team.chats ?? {}).filter(([id]) => known.has(id)));
    chats[chatId] = [...people.invited, person];
    this.setTeam({ ...team, chats });
    return chats[chatId];
  }
  removeFromChat(chatId, person) {
    this.typing.clearPerson(chatId, person);
    const team = this.store.data.team;
    const invited = (team.chats?.[chatId] ?? []).filter((held) => held !== person);
    const { [chatId]: _was, ...rest } = team.chats ?? {};
    this.setTeam({ ...team, chats: invited.length ? { ...rest, [chatId]: invited } : rest });
    // The chat's card on their phones ends with their place in it.
    for (const device of this.store.data.devices) {
      if ((device.memberId ?? OWNER) === person && this.store.push(device.id)?.activities?.[chatId]) this.push.endActivity(device.id, chatId);
    }
    return invited;
  }
  removeChatPeople(chatId) {
    this.typing.clearChat(chatId);
    const team = this.store.data.team;
    const { [chatId]: _was, ...chats } = team.chats ?? {};
    const views = Object.fromEntries(Object.entries(team.views ?? {}).map(([memberId, held]) => {
      let view = held;
      // The section a person put it in goes with it.
      if (view?.chatSections?.of && Object.hasOwn(view.chatSections.of, chatId)) {
        const { [chatId]: _section, ...of } = view.chatSections.of;
        view = { ...view, chatSections: { ...view.chatSections, of } };
      }
      if (!view?.chats || !Object.hasOwn(view.chats, chatId)) return [memberId, view];
      const { [chatId]: _mark, ...rest } = view.chats;
      return [memberId, { ...view, chats: rest }];
    }));
    this.store.set({ team: { ...team, chats, views } });
  }
  /** A member's own view is kept by the link and never reaches the app: their bots' marks and order, their chats' flags. */
  memberView(principal, method, args, state) {
    const team = this.store.data.team;
    let view = viewOf(team, principal.memberId);
    if (method === "setChatFlags" && args[1]?.archived && state.chats?.some(c => c.id === args[0] && c.main)) throw new Failure("Main chat stays in your chats.");
    if (method === "setBotFlags") view = withBotFlags(view, String(args[0]), args[1]);
    else if (method === "reorderBots") view = { ...view, order: (Array.isArray(args[0]) ? args[0] : []).filter((id) => typeof id === "string").slice(0, 500) };
    else if (method === "setChatFlags") view = withChatFlags(view, String(args[0]), args[1], (state.chats ?? []).find((chat) => chat.id === args[0])?.time);
    else if (method === "markChatsRead") {
      const [ids] = remoteArgs("markChatsRead", args);
      const role = roleOfMember(team, principal.memberId);
      const byId = new Map((state.chats ?? []).map((chat) => [chat.id, chat]));
      let changed = false;
      for (const id of ids) {
        const chat = byId.get(id);
        if (!chat || !inChat(team, chat, principal.memberId) || !visible(role, chat.botId)) continue;
        const time = Number.isFinite(chat.time) ? chat.time : 0;
        const prev = view.chats[chat.id];
        if (!prev?.unread && prev?.seen === time) continue;
        view = withChatFlags(view, chat.id, { unread: false }, chat.time);
        changed = true;
      }
      if (!changed) return null;
    }
    this.setTeam({ ...team, views: { ...(team.views ?? {}), [principal.memberId]: view } });
    return null;
  }
  renameTeam(name) {
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean || clean.length > 60 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Failure("Give the team a name of up to 60 characters.");
    this.setTeam({ ...this.store.data.team, name: clean });
    void this.syncInvites();
    return this.team();
  }
  removeDevice(id, { keepProfileBinding = false } = {}) {
    const existing = this.store.device(id);
    if (existing?.profile && !keepProfileBinding) this.tombstoneProfileDevice(existing);
    const removed = this.store.removeDevice(id);
    this.deviceKeys.delete(id);
    this.nonces.delete(id);
    this.screen.stop(id);
    this.uploads.forget(id);
    this.push.forget(id);
    this.device.forget(id);
    this.gadgets.forget(id);
    this.grants.forget(id);
    this.typing.forgetSource(id);
    for (const [sid, session] of this.sessions) if (session.deviceId === id) this.sessions.delete(sid);
    for (const waiter of [...this.waiters]) if (waiter.session.deviceId === id) waiter.end();
    if (removed) this.emit("status");
    return removed;
  }
  /** Explicit local removal revokes only this cloud device id for its bound role. */
  tombstoneProfileDevice(device) {
    const principal = device?.memberId ? { kind: "member", memberId: device.memberId } : { kind: "owner" };
    const binding = this.profileBinding(principal);
    const profile = device?.profile;
    if (!binding || !profile || binding.profileId !== profile.profileId) return;
    const revokedDeviceIds = [...new Set([...(binding.revokedDeviceIds ?? []), profile.deviceId])].slice(-64);
    const profiles = this.store.data.profiles ?? { owner: null, members: {} };
    const next = { ...binding, revokedDeviceIds };
    if (principal.kind === "member") profiles.members = { ...(profiles.members ?? {}), [principal.memberId]: next };
    else profiles.owner = next;
    this.store.set({ profiles });
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
    if (!session || !this.store.device(session.deviceId) || !this.principal(session.deviceId)) throw new Refused(401, "session");
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
      if (route !== "rpc" && route !== "pair" && route !== "join" && route !== "session" && route !== "profile") throw new Refused(404, "not_found");
      // A call needs a known session and a body that fits before any of the body is read.
      const sessionId = String(req.headers["x-botkins-session"] ?? "");
      if (route === "rpc") this.knownSession(sessionId);
      const limit = route === "rpc" ? MAX_RPC_BODY : route === "profile" ? MAX_TEAMWORK_BODY : MAX_BODY;
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
  async serve({ route, push, session: sessionId = "", body = Buffer.alloc(0), from = "", via = "http", gone = new Promise(() => {}) }) {
    const json = (status, value) => ({ status, body: Buffer.from(JSON.stringify(value), "utf8"), json: true });
    try {
      if (route === "hello") return json(200, { ...this.hello(via), ...(this.teamworkPeer && { teamworkBoot: this.teamworkPeer.boot }) });
      if (route !== "rpc" && route !== "pair" && route !== "join" && route !== "session" && route !== "profile") throw new Refused(404, "not_found");
      if (route === "profile") {
        if (body.length > MAX_TEAMWORK_BODY) throw new Refused(413, "too_large");
        let message;
        try { message = JSON.parse(body.toString("utf8")); } catch { throw new Refused(400, "bad_json"); }
        if (message?.teamwork === 1) {
          try {
            if (!this.teamworkPeer) throw new Error();
            return json(200, await this.teamworkPeer.receive(message));
          } catch (error) {
            throw new Refused(error?.code === "TEAMWORK_OFFLINE" ? 503 : 403, "teamwork_unavailable");
          }
        }
        if (body.length > MAX_BODY) throw new Refused(413, "too_large");
        return json(200, { box: await this.profile(message) });
      }
      const limit = route === "rpc" ? MAX_RPC_BODY : MAX_BODY;
      if (route === "rpc") {
        // The phone may have been removed while its call was on the way.
        const session = this.knownSession(sessionId);
        if (body.length > limit) throw new Refused(413, "too_large");
        return { status: 200, body: await this.rpc(session, body, gone, via, push), json: false };
      }
      // Each way in has its own failure counts: the relay can never use up HTTP's allowance, or the other way round.
      const failures = this.failures[via === "relay" ? "relay" : "http"];
      // A source over its limit is told to wait. Pairing says "pair_wait" so a phone can say "too many tries".
      // A session isn't held back up front: one that proves itself is served, so a stranger who shares a
      // source with a real phone (a carrier's NAT, a café) can't keep it out. Only a failing one is held back.
      if (route === "pair" && failures.blocked(from)) throw new Refused(429, "pair_wait");
      if (route === "join" && failures.blocked(from)) throw new Refused(429, "join_wait");
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
        if (route === "pair" || route === "join") {
          // Pairing (and a session for a device this computer doesn't know) is what a flood from many sources aims at.
          if (failures.tripped()) throw new Refused(429, "slow_down");
          // A presence key is kept from a request that came straight here, or through this server's own relay.
          const direct = via === "http" || (via === "relay" && this.ownRelay());
          return json(200, route === "pair" ? this.pair(message, via + ":" + from, direct) : this.join(message, via + ":" + from, direct));
        }
        return json(200, await this.session(message, gate));
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
    const join = this.store.data.team.invites.some((invite) => this.liveInvite(invite));
    if (via === "relay") return { botkins: PROTOCOL, serverId: this.store.data.serverId, publicKey: b64u(this.store.data.keys.publicKey), ...(join && { join: true }) };
    const info = this.backend.info();
    return {
      botkins: PROTOCOL,
      serverId: this.store.data.serverId,
      publicKey: b64u(this.store.data.keys.publicKey),
      name: this.store.name,
      app: info.app,
      version: info.version,
      pairing: !!this.activePairing(),
      ...(join && { join: true }),
    };
  }
  /** `direct`: the request came straight over HTTP, or through this server's own relay. Only then is a phone's presence key kept. */
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
    const device = this.store.addDevice({ name: hello?.name, platform: hello?.platform, kind: hello?.kind, publicKey: theirs, presenceKey: direct ? cleanPresenceKey(hello?.presenceKey) : null, person: hello?.person });
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
  async profileDeviceAllowed(device) {
    if (!device?.profile) return true;
    let active = false;
    try { active = await this.profileActive(device.profile.statusKey); } catch { /* fail closed on an unavailable status service */ }
    if (!active) {
      this.removeDevice(device.id, { keepProfileBinding: true });
      return false;
    }
    return true;
  }
  async session(message, gate = { blocked: () => false, tripped: () => false }) {
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
    if (!(await this.profileDeviceAllowed(device))) throw new Refused(403, "profile_revoked");
    const serverNonce = random(16);
    const salt = Buffer.concat([unb64u(hello.nonce), serverNonce]);
    const master = hkdf(Buffer.concat([shared, key]), salt, "botkins/session/v1");
    const session = {
      id: b64u(random(12)),
      deviceId: device.id,
      principal: this.principal(device.id),
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
    for (const session of this.sessions.values()) if (now - session.used > SESSION_IDLE) this.dropSession(session);
    // A phone keeps a few sessions; its oldest go first, so it can't push other phones out.
    const mine = new Map();
    for (const session of this.sessions.values()) mine.set(session.deviceId, [...(mine.get(session.deviceId) ?? []), session]);
    for (const list of mine.values()) {
      list.sort((a, b) => b.used - a.used);
      for (const extra of list.slice(MAX_SESSIONS_PER_DEVICE)) this.dropSession(extra);
    }
    const oldestOf = (member) => {
      let oldest = null;
      for (const session of this.sessions.values()) if (!!session.principal && (session.principal.kind === "member") === member && (!oldest || session.used < oldest.used)) oldest = session;
      return oldest;
    };
    while ([...this.sessions.values()].filter((session) => session.principal?.kind === "member").length > MAX_MEMBER_SESSIONS) this.dropSession(oldestOf(true));
    while ([...this.sessions.values()].filter((session) => session.principal?.kind !== "member").length > MAX_SESSIONS) this.dropSession(oldestOf(false));
  }
  /** Ends a session and whatever it has waiting. */
  dropSession(session) {
    this.sessions.delete(session.id);
    this.grants.dropSession(session.id);
    for (const waiter of [...this.waiters]) if (waiter.session === session) waiter.end();
  }
  async rpc(session, body, gone, via = "http", push) {
    if (session.deviceId !== undefined && !(await this.profileDeviceAllowed(this.store.device(session.deviceId)))) {
      this.dropSession(session);
      throw new Refused(403, "profile_revoked");
    }
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
      const result = await this.dispatch(session, message, gone, via, push, seq);
      text = result instanceof Json ? '{"r":' + result.text + "}" : JSON.stringify({ r: result ?? null });
    } catch (error) {
      text = JSON.stringify({ e: { message: plain(error).slice(0, 600) } });
    }
    return seal(session.toPhone, seqNonce(seq), Buffer.from(text, "utf8"), "ok:" + session.id);
  }

  // ── Calls ───────────────────────────────────────────────────────────────────────────────────

  /** `via` is how the call arrived: "http" straight to this computer, or "relay". */
  async dispatch(session, message, gone, via = "http", push, seq) {
    const method = String(message?.m ?? "");
    const args = Array.isArray(message?.a) ? message.a : [];
    // Only the host's own calls come without a device. A device whose member record is gone gets
    // nothing, never the owner's rights.
    const principal = session.deviceId === undefined ? { kind: "owner" } : this.principal(session.deviceId);
    if (!principal) throw new Failure("This device is no longer on the team.");
    session.principal = principal;
    const state = this.backend.snapshot();
    const isFollow = method === "link.follow";
    const cancel = method === "link.unfollow";
    const refusal = authorize(principal, this.store.data.team, isFollow || cancel ? "link.sync" : method, args, {
      bot: (id) => (state.bots ?? []).find((bot) => bot.id === id),
      chat: (id) => (state.chats ?? []).find((chat) => chat.id === id),
      gadget: this.store.device(session.deviceId)?.kind === "gadget",
      request: (id) => (state.requests ?? []).find((request) => request.id === id),
      // A script command that Botkins keeps: a member may not remove, turn off or replace it (team.mjs).
      scriptCommand: (name) => Object.hasOwn(state.skills?.scripts ?? {}, name),
      run: (id) => (state.runs ?? []).find((run) => run.id === id),
      // The app says who made each routine once it names "routine-owner-v1".
      routineOwners: Array.isArray(this.backend.capabilities) && this.backend.capabilities.includes("routine-owner-v1"),
      // With spaces, a call also needs the space of the panel or card it names.
      ...(Array.isArray(state.spaces) && {
        space: (id) => state.spaces.find((space) => space.id === id),
        panel: (id) => (state.panels ?? []).find((panel) => panel.id === id),
        card: (id) => (state.board ?? []).find((item) => item.id === id),
      }),
    });
    if (refusal) throw new Failure(refusal);
    if (method === "link.profile.bind") {
      if (this.store.device(session.deviceId)?.kind === "gadget") throw new Failure("A gadget cannot bind a profile.");
      if (args.length !== 1 || typeof args[0] !== "string") throw new Failure("That profile ticket is invalid.");
      return this.bindProfile(principal, await this.redeemProfile(args[0], "bind"), session.deviceId);
    }
    // A person's own picture: the caller's, whoever the arguments name. A gadget has none.
    if (method === "setMyAvatar") {
      if (this.store.device(session.deviceId)?.kind === "gadget") throw new Failure("A gadget has no picture of its own.");
      if (args.length > 1) throw new Failure("Choose one picture.");
      return this.setAvatar(personOf(principal), args[0] ?? null);
    }
    if (method === "link.profile.unbind") {
      if (this.store.device(session.deviceId)?.kind === "gadget") throw new Failure("A gadget cannot unbind a profile.");
      if (args.length !== 1 || typeof args[0] !== "string") throw new Failure("That profile id is invalid.");
      return this.unbindProfile(principal, args[0]);
    }
    let forApp = args;
    // Only the phone running this voice session can caption its bot in this chat.
    if (method === "recordVoiceLine" && args[4] != null) {
      const { sessionId, role, afterVoiceId } = args[4];
      const live = this.voice.sessions.get(sessionId);
      const belongs = id => typeof id === "string" && id.startsWith(sessionId + ":");
      if (!live || live.provider === "codex" || live.chatId !== args[0] || live.deviceId !== session.deviceId ||
          live.memberId !== (principal.kind === "member" ? principal.memberId : undefined) ||
          role !== "assistant" || !belongs(args[1]) || (afterVoiceId !== undefined && !belongs(afterVoiceId))) {
        throw new Failure("This transcript doesn't belong to this voice session.");
      }
      forApp = [...args.slice(0, 4), { role, afterVoiceId }];
    }
    if (principal.kind === "member") {
      // A member's own view: kept here, not in the workspace, so it is nobody else's.
      if (method === "setChatFlags" || method === "markChatsRead" || method === "reorderBots") return this.memberView(principal, method, args, state);
      if (method === "setBotFlags") {
        this.memberView(principal, method, args, state);
        const shared = sharedBotFlags(args[1]);
        if (!Object.keys(shared).length) return null;
        forApp = [args[0], shared];
      }
      // A custom view in a chat is that chat's people's.
      if (method === "link.frame.page" || method === "link.frame.chat") {
        // A view on a panel follows its panel: the member's role must see the panel's bot, and with
        // spaces they must be able to open its space. The panel is found by its blocks, never by
        // searching what people wrote. Any other view is a chat's, and its people's.
        const id = typeof args[0] === "string" ? args[0] : "";
        const panel = id ? panelOfFrame(state.panels, id) : undefined;
        if (panel) {
          const shown = filterParts({ panels: [panel], bots: state.bots ?? [] }, principal, this.store.data.team).panels.length > 0;
          const opens = !Array.isArray(state.spaces) || !!spaceCan(this.store.data.team, state.spaces.find((space) => space.id === panel.spaceId), principal.memberId);
          if (!shown || !opens) throw new Failure("This view no longer exists.");
        } else {
          const from = await this.frameChat(args[0]).catch(() => ({ chatId: null }));
          const chat = from.chatId ? (state.chats ?? []).find((item) => item.id === from.chatId) : null;
          if (from.chatId && !(chat && inChat(this.store.data.team, chat, principal.memberId))) throw new Failure("This view no longer exists.");
        }
      }
    }
    if (method === "link.sync" || isFollow || cancel) {
      if (isFollow && (via !== "relay" || !push)) throw new Failure("A follow needs a relay socket.");
      // A delayed request must never reclaim a follow that a newer RPC already replaced.
      // Ordinary concurrent polls keep their existing two-waiter behavior.
      const superseded = () => seq < (isFollow || cancel ? session.syncSeq : session.lastFollowSeq);
      if (superseded()) return { epoch: this.epoch, v: null, parts: {} };
      if (isFollow || cancel) session.lastFollowSeq = seq;
      if (seq) session.syncSeq = Math.max(seq, session.syncSeq ?? 0);
      session.follow?.end();
      if (isFollow) for (const waiter of this.waiters) if (waiter.session === session) waiter.end();
      if (cancel) return null;
      // A person's four built-in spaces exist before their device is first sent its parts.
      if (this.spaces.on) {
        this.spaces.moveOnce();
        await this.spaces.ensure(personOf(principal));
      }
      if (superseded() || (seq && !this.sessions.has(session.id))) {
        return { epoch: this.epoch, v: null, parts: {} };
      }
      return this.sync(session, args[0] ?? {}, gone, via, isFollow ? push : undefined);
    }
    if (method === "link.messages") {
      const limit = Math.max(1, Math.min(Number(args[2]) || CHAT_PAGE, 200));
      const id = String(args[0]);
      const chat = (state.chats ?? []).find((item) => item.id === id);
      const redact = chat && session.deviceId !== undefined && principal.kind === "owner" && !principal.admin && !inChat(this.store.data.team, chat, OWNER);
      const page = chatPart(redact ? { ...state, chats: [withoutProactiveAlerts(chat)] } : state, id, undefined, { before: Number(args[1]), limit });
      // A session that follows with light steps gets its earlier pages the same way.
      return session.light ? lightPart(page) : page;
    }
    if (method === "link.step") return stepDetail(this.backend.snapshot(), String(args[0]), String(args[1]), String(args[2]));
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
          const memberId = this.store.device(session.deviceId)?.memberId;
          this.removeDevice(session.deviceId);
          // A member who leaves from their last device leaves the team.
          if (memberId && !this.store.data.devices.some((device) => device.memberId === memberId) && this.store.data.team.members.some((member) => member.id === memberId)) this.removeMember(memberId);
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
    const { args: callArgs, secrets } = await this.credentials.resolve(method, remoteArgs(method, forApp, { deviceId: session.deviceId, uploads: this.uploads }));
    if (!secrets.length) {
      const answer = await this.backend.call(method, callArgs, { principal });
      // A space a person makes starts pinned for them (the pins are theirs, kept here).
      if (method === "spaces.create" && typeof answer === "string" && answer) {
        const person = personOf(principal);
        const mine = this.spaces.for(person);
        this.spaces.arrange(person, { order: mine.map((space) => space.id), pinned: [...mine.filter((space) => space.pinned).map((space) => space.id), answer] });
      }
      // A space that was deleted takes its sharing along; its link's copy leaves the relay.
      if (method === "spaces.remove") this.spaces.removed(String(args[0]));
      // A space's content as this person is sent it, with when they last opened it.
      if (method === "spaces.read") return this.spaceContent(principal, answer, state);
      // A chat that was deleted takes its invitations and everyone's marks on it along.
      if (method === "deleteChat") this.removeChatPeople(String(args[0]));
      if (method === "send") this.typing.clearPerson(String(args[0]), personOf(principal));
      // A chat a member starts is read by them from the start: their unread is theirs, not the workspace's.
      else if (principal.kind === "member" && MAKES_CHAT.has(method) && typeof answer === "string" && answer) this.memberView(principal, "setChatFlags", [answer, { unread: false }], { chats: [{ id: answer, time: Date.now() }] });
      return answer;
    }
    // The desktop may echo what it was given. Nothing of a value goes back to a phone.
    try {
      return scrub(await this.backend.call(method, callArgs, { principal }), secrets);
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
      capabilities: [...new Set([...Object.keys(this.backend.extras ?? {}), ...(Array.isArray(this.backend.capabilities) ? this.backend.capabilities : []), ...CAPABILITIES.filter((c) => (c !== "stream-appends-v1" && c !== "reasoning-appends-v1") || this.backend.streamAppends !== false), ...(this.backend.protonSetup === false ? [] : [PROTON_SETUP]), ...(this.headless() ? [GRANT_CAPABILITY, ...(this.ownRelay() ? [GRANT_RELAY_CAPABILITY] : [])] : []), ...(typeof this.backend.frames?.page === "function" ? ["frames-v1"] : []), ...(typeof this.backend.setLook === "function" ? [] : ["looks-v2", ...headCapabilities]), ...(this.spaces.on ? [SPACE_ALERTS_CAPABILITY] : [])])],
    };
  }
  /**
   * The app's state while `refresh` rebuilds the parts: the one build it made (a build for the parts, for
   * the spaces and for each view was two to four a pump). Any other time, a fresh one.
   */
  refreshState() {
    return this.refreshing && this.shared ? this.shared : this.backend.snapshot();
  }
  /** The app's state as the last refresh built it, for as long as nothing has changed since; a fresh one after. */
  lastState() {
    return !this.dirty && this.shared ? this.shared : this.backend.snapshot();
  }
  /** The desktop changed: wake the phones that are waiting, at most once per PUMP_MS. */
  changed() {
    this.dirty = true;
    this.schedulePump(PUMP_MS);
  }
  schedulePump(delay) {
    const due = Date.now() + delay;
    if (!this.waiters.size || (this.pumping && this.pumpDue <= due)) return;
    clearTimeout(this.pumping);
    this.pumpDue = due;
    this.pumping = setTimeout(() => {
      this.pumping = null;
      try {
        if (!this.waiters.size) return;
        this.refresh([]);
        for (const waiter of [...this.waiters]) {
          const news = waiter.news();
          if (news instanceof Json) waiter.end(news);
          else if (typeof news === "number") this.schedulePump(news);
        }
      } catch (error) {
        this.log("link: " + (error?.message ?? error));
      }
    }, delay);
    this.pumping.unref?.();
  }
  /** Rebuilds the parts when something changed, or when a chat is watched for the first time. */
  refresh(watching, reasoningWatch = []) {
    if (!this.dirty && watching.every((id) => this.parts.has("run:" + id)) && reasoningWatch.every((id) => this.reasoningParts.has(id))) return;
    this.refreshing = true;
    try {
      this.rebuild(watching, reasoningWatch);
    } finally {
      this.refreshing = false;
    }
  }
  rebuild(watching, reasoningWatch) {
    // One build of the app's state for everything this refresh and the views made from it ask.
    const state = this.backend.snapshot();
    this.shared = state;
    const ownLooks = typeof this.backend.setLook === "function";
    if (!ownLooks) this.store.syncLooks((state.bots ?? []).map((bot) => bot.id));
    // A full live version must be newer than its indicators: an older phone's acknowledged
    // version then tells us whether it has already seen the latest non-text change.
    const next = { quietLive: null, ...baseParts(state, this.meta(), ownLooks ? {} : this.store.data.looks, { credentials: this.credentials.list(), screen: this.store.data.screen, relay: !!this.relaySettings(), typing: this.typingSnapshot(), ...(this.headless() && { headless: true, display: this.display() }), screenSetBy: this.store.data.screenSetBy }) };
    next.quietLive = quietLive(next.live);
    // These are the parts of an owner device with Admin mode on; one with it off gets a cut of them (viewParts).
    const ownAvatar = avatarOf(this.store.data.team, OWNER);
    next.meta.you = { kind: "owner", admin: true, ...(ownAvatar && { avatar: ownAvatar }) };
    next.team = this.team();
    // Spaces: the app's own list is never sent. The owner's devices get the owner's view of it;
    // `panels` and `board` stay for an app that doesn't know spaces (every Today's panels).
    if (Array.isArray(state.spaces)) {
      const kinds = new Map(state.spaces.map((space) => [space.id, space.builtin]));
      next.spaces = this.spaces.for(OWNER);
      // A panel or card the app has put in no space yet is still the owner's to see, never a member's.
      // Every panel that has a project, wherever it is: an owner's app draws a project's "Spaces and panels" from it
      // (`panels` holds only the Todays'). Projects are the owner's, so no member is sent this part.
      next.projectPanels = (next.panels ?? []).filter((panel) => panel.projectId).map((panel) => panelView(panel));
      next.panels = (next.panels ?? []).filter((panel) => !panel.spaceId || kinds.get(panel.spaceId) === "today").map((panel) => panelView(panel));
      next.board = (next.board ?? []).filter((item) => !item.spaceId || kinds.get(item.spaceId));
      // A space shared by link changed: its copy on the relay follows (not from inside this refresh).
      const shared = Object.entries(this.store.data.team.spaces ?? {}).filter(([, entry]) => entry?.access === "link");
      const mark = shared.length ? shared.map(([id]) => id + ":" + (state.spaces.find((space) => space.id === id)?.rev ?? "")).join(",") : "";
      if (mark !== this.spaceLinkMark) {
        this.spaceLinkMark = mark;
        const timer = setTimeout(() => this.spaceLinks.sync(), 0);
        timer.unref?.();
      }
    } else delete next.spaces;
    // Who was invited to each chat, for the owner's lists; a member's are added with their own cut (filterParts).
    const invites = this.store.data.team.chats ?? {};
    next.chats = (next.chats ?? []).map((chat) => (!chat.main && invites[chat.id]?.length ? { ...chat, invited: [...invites[chat.id]] } : chat));
    // The owner's own sections for their chats; a member's are added with their own cut (filterParts).
    const sections = chatSectionsOf(this.store.data.team, OWNER);
    next.chatSections = sections.list;
    next.chats = withChatSections(next.chats, sections);
    // What each phone set up (never a token), and what bots are asking phones for right now.
    next.phones = Object.fromEntries(this.store.data.devices.map((device) => [device.id, { name: device.name, kind: device.kind, platform: device.platform, ...(device.presenceKey && { presence: true }), ...(this.push.view(device.id) && { push: this.push.view(device.id) }), sources: this.store.sources(device.id) }]));
    next.asks = this.device.asks();
    next.voice = this.voice.settings();
    const ids = new Set([...watching, ...reasoningWatch]);
    const wantedReasoning = new Set(reasoningWatch);
    const keptPages = new Set();
    // A following phone is briefly between polls while its answer is in flight. Another phone
    // opening a different chat must not discard its versions or force a text replay.
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.watchUntil > now) {
        for (const id of session.watching) ids.add(id);
        if (session.keepPage) keptPages.add(session.keepPage);
        for (const id of session.reasoningWatch ?? []) { ids.add(id); wantedReasoning.add(id); }
      }
    }
    for (const waiter of this.waiters) {
      for (const id of waiter.watching) ids.add(id);
      for (const id of waiter.reasoningWatch ?? []) { ids.add(id); wantedReasoning.add(id); }
    }
    const runs = runsByChat(state, [...ids, ...keptPages]);
    for (const id of keptPages) {
      if (!ids.has(id)) next["chat:" + id] = chatPart(state, id, runs.get(id));
    }
    for (const id of ids) {
      next["chat:" + id] = chatPart(state, id, runs.get(id));
      next["run:" + id] = runPart(state, id, runs.get(id));
    }
    const texts = new Map();
    for (const id of ids) {
      const runPartValue = next["run:" + id];
      if (wantedReasoning.has(id)) {
        const current = runPartValue?.status === "Working" && runPartValue.id && Array.isArray(runPartValue.reasoning)
          ? { run: runPartValue.id, items: runPartValue.reasoning.map(({ id: itemId, text, started, finished, botId }) => ({ id: itemId, text, started, ...(finished !== undefined && { finished }), ...(botId && { botId }) })) }
          : null;
        const previous = this.reasoningParts.get(id);
        if (!previous || !sameReasoning(previous.snapshot, current)) this.reasoningParts.set(id, { version: ++this.version, snapshot: current });
      }
      if (!Object.hasOwn(next.live.streams, id) && !Object.hasOwn(next.live.thinking, id)) continue;
      const stream = next.live.streams[id] ?? "";
      const thinking = next.live.thinking[id] ?? "";
      const run = next["run:" + id]?.id;
      const detail = next["chat:" + id];
      const interim = detail?.messages.findLastIndex((message) => message.interim);
      const boundary = interim >= 0 ? detail.from + interim : -1;
      const prev = this.texts.get(id);
      const continues = prev && prev.run === run && prev.boundary === boundary &&
        stream.startsWith(prev.stream) && thinking.startsWith(prev.thinking);
      const text = { id: continues ? prev.id : this.epoch + "." + ++this.version, stream, thinking, run, boundary };
      // The reply has its own cursor when this client doesn't display thoughts. A rotating
      // thought preview must never reset the reply or wake the phone for reasoning alone.
      const lastReply = prev?.reply;
      const sameReply = lastReply && prev.run === run && prev.boundary === boundary && stream.startsWith(lastReply.stream);
      text.reply = { id: sameReply ? lastReply.id : this.epoch + "." + ++this.version, stream, thinking: "" };
      const items = wantedReasoning.has(id) && this.reasoningParts.get(id)?.snapshot?.items;
      if (items?.length) {
        const speaker = next.live.speakers[id];
        const botId = speaker && items.some((item) => item.botId === speaker) ? speaker : undefined;
        if (reasoningPreview(items, botId) === thinking) {
          // The phone can draw this exact preview from its reasoning. Its reply cursor then
          // lives independently of the desktop's rolling 4,000-character thinking window.
          const last = prev?.projected;
          const same = last && last.preview.run === run && last.preview.botId === botId &&
            last.boundary === boundary && stream.startsWith(last.stream);
          text.projected = { id: same ? last.id : this.epoch + "." + ++this.version, stream, thinking: "", boundary, preview: { run, ...(botId && { botId }) } };
        }
      }
      texts.set(id, text);
    }
    this.texts = texts;
    for (const id of this.reasoningParts.keys()) if (!wantedReasoning.has(id)) this.reasoningParts.delete(id);
    for (const [name, value] of Object.entries(next)) {
      // A chat's page and its run are most of the bytes: the steps and messages that did not change are not
      // written again, and a part whose fragments are all the same as last time is not joined to be compared.
      const held = this.parts.get(name);
      const frags = name.startsWith("chat:") || name.startsWith("run:") ? jsonFragments(value ?? null) : null;
      if (frags && held?.frags && sameFragments(held.frags, frags)) continue;
      const json = frags ? frags.join("") : JSON.stringify(value ?? null);
      if (held?.json !== json) {
        this.parts.set(name, { json, ...(frags && { frags }), v: ++this.version });
        // A phone that is sent indicators and text by cursor reads `quietLive`, which a reply's growth leaves as it was.
        if (name === "live") this.liveRev++;
        else this.partsRev++;
      } else if (frags) held.frags = frags;
    }
    // Chats nobody watches any more are dropped.
    for (const name of [...this.parts.keys()]) {
      if (name in next) continue;
      this.parts.delete(name);
      this.partsRev++;
    }
    this.dirty = false;
  }
  names(watching) {
    const names = [];
    for (const name of this.parts.keys()) if (name !== "quietLive" && !name.startsWith("chat:") && !name.startsWith("run:")) names.push(name);
    for (const id of watching) names.push("chat:" + id, "run:" + id);
    return names;
  }
  /**
   * The parts one device may see, each with its version: the owner's are the computer's own, a member's are cut
   * to their role. `quiet` says the device is sent indicators, not the full `live` (its text comes by cursor, or not
   * at all), so a reply growing is no reason to make its view again.
   */
  viewParts(session, watching, quiet) {
    // A gadget follows two small parts of its own, made from the owner's (gadget.mjs).
    const device = session.deviceId === undefined ? null : this.store.device(session.deviceId);
    if (device?.kind === "gadget" && !device.memberId) return this.gadgets.view(device, this.parts);
    const principal = this.principal(session.deviceId);
    const admin = principal?.kind === "owner" && principal.admin === true;
    // An owner device with Admin mode on is sent everything; the host's own calls too.
    const hasReasoning = session.reasoningNegotiated === true;
    if (principal?.kind === "owner" && principal.admin && !hasReasoning) return this.parts;
    if (principal?.kind !== "owner" && principal?.kind !== "member") return new Map();
    const key = (admin ? "owner:admin" : principal.kind === "owner" ? "owner" : "member:" + principal.memberId) + (hasReasoning ? ":reasoning" : ":legacy") + (session.light ? ":light" : ":full");
    const previous = this.partViews.get(key) ?? new Map();
    // Nothing changed since this view was made for the same chats: it is still right.
    const stamp = this.partsRev + ":" + this.teamRev + ":" + watching.join(",") + ":" + (session.reasoningWatch ?? []).join(",") + ":" + (session.light ? "light" : "full");
    if (previous.stamp === stamp && (quiet || previous.liveRev === this.liveRev)) return previous;
    // The computer's own indicators name every chat, so they stay out: a view's own are made below
    // from its own `live`, after it was cut to its chats.
    // The owner's pages stay whole unless an approval can expose another person's alert history.
    const live = JSON.parse(this.parts.get("live")?.json ?? "null");
    const waiting = principal.kind === "owner" && !admin ? ownerApprovalChats(live) : null;
    const whole = (name) => principal.kind === "owner" && (name.startsWith("run:") || (name.startsWith("chat:") && !waiting?.has(name.slice(5))));
    const raw = Object.fromEntries([...this.parts].filter(([name]) => name !== "quietLive").map(([name, part]) => [name, name === "live" ? live : whole(name) ? true : JSON.parse(part.json)]));
    const records = this.lastState().spaces;
    const team = this.store.data.team;
    const values =
      admin
        ? raw
        : principal.kind === "owner"
        ? ownerParts(raw, team, Array.isArray(records) ? { spaces: records, ...this.spaces.context(OWNER) } : {})
        : filterParts(raw, principal, team, {
            ...(Array.isArray(records) ? { spaces: records, ...this.spaces.context(principal.memberId) } : {}),
            memberDevices: this.memberDevices(principal.memberId),
          });
    const put = (name, json) => {
      if (previous.get(name)?.json !== json) previous.set(name, { json, v: ++this.version });
    };
    // Before `live`, so a full `live` is always newer than its indicators (see refresh).
    put("quietLive", JSON.stringify(quietLive(values.live) ?? null));
    for (const name of this.names(watching)) {
      if (!(name in values)) continue;
      let json;
      if (whole(name) && values[name] === true) json = hasReasoning && name.startsWith("run:") ? this.compactJson(this.parts.get(name), session.light) : this.parts.get(name).json;
      else if (hasReasoning && name.startsWith("run:")) json = JSON.stringify(compactWorkingRun(values[name], session.light));
      else json = JSON.stringify(values[name] ?? null);
      put(name, json);
    }
    for (const name of previous.keys()) if (!this.parts.has(name)) previous.delete(name);
    previous.stamp = stamp;
    previous.liveRev = this.liveRev;
    this.partViews.set(key, previous);
    return previous;
  }
  /** A run part as a client that follows reasoning is sent it: made once for each version of the part, for every phone. */
  compactJson(part, light) {
    const slot = light ? "compactLight" : "compact";
    return (part[slot] ??= JSON.stringify(compactWorkingRun(JSON.parse(part.json), light)));
  }
  /** Missing parts as JSON, null when caught up, or milliseconds until the next eligible flush. */
  news(known, watching, cursors, session, throttle, interval = 0, advance, runBases) {
    const partWatching = [...new Set([...watching, ...(session.reasoningWatch ?? [])])];
    // A phone that asked for no text streaming ("text-streaming-off-v1") gets the indicators only, and no text:
    // text growing alone wakes nothing. The reply comes whole in its chat's page.
    const quiet = !!cursors || session.noText;
    const values = this.viewParts(session, partWatching, quiet);
    // A phone that asked for chunks ("text-chunks-v1") gets the reply's own text after each whole word, at most
    // once per `live` ms, and the first words of a reply at once; thinking and the rest of the text waits for
    // a sentence's end or a line's, at most once per `every` ms. Both are far fewer relay messages than the
    // 200 ms of a direct phone. Text with no end in sight goes after `holdMax`.
    const chunks = session.textMode === "chunks";
    const now = Date.now();
    const loose = chunks && session.heldSince !== undefined && now - session.heldSince >= this.chunkTiming.holdMax;
    let held = false;
    let textOnly = true;
    let progress = false;
    let wordsIn = Infinity;
    let live = false; // reply text goes out in this answer
    let first = false; // and it is the first of a reply: the phone holds none of it yet
    const parts = [];
    const versions = {};
    // Keep the phone's actual acknowledgement while its page is out of view. If the page
    // changes, the normal authorized view sends the new version when the person returns.
    const kept = "chat:" + session.keepPage;
    if (session.keepPage && Object.hasOwn(known, kept)) versions[kept] = known[kept];
    const deliveredRuns = [];
    const deliveredReasoning = [];
    const deliveredText = [];
    for (const name of values.names ?? this.names(partWatching)) {
      const part = values.get(quiet && name === "live" ? "quietLive" : name);
      if (!part) continue;
      versions[name] = part.v;
      if (known[name] === part.v) continue;
      const legacyTextOnly = name === "live" && !quiet && known.live > (values.get("quietLive")?.v ?? Infinity);
      // A chat's page and its run with light steps ("step-details-v1"), made once for each version.
      const light = session.light && (name.startsWith("chat:") || name.startsWith("run:"));
      const summaries = name === "runs";
      const bases = summaries ? runBases?.summaries : name.startsWith("run:") ? runBases?.steps : null;
      let json;
      if (bases) {
        const delivery = runRowsFor(part, summaries, bases.get(name), known[name]);
        deliveredRuns.push([bases, name, delivery.snapshot]);
        if (summaries) progress = delivery.progress === true && runBases.paceSummaries;
        json = delivery.json;
      } else json = light ? (part.light ??= JSON.stringify(lightPart(JSON.parse(part.json)))) : part.json;
      if (!legacyTextOnly && !(summaries && progress)) textOnly = false;
      parts.push(JSON.stringify(name) + ":" + json);
    }
    for (const chat of partWatching) {
      const shown = values === this.parts || values.texts?.has(chat) || (values.get("chat:" + chat)?.json ?? "null") !== "null";
      const followsReasoning = session.reasoningWatch?.includes(chat);
      if (cursors && watching.includes(chat)) {
        const cursor = Object.hasOwn(cursors, chat) ? cursors[chat] : null;
        const raw = shown && !session.noText && (!session.textWatch || session.textWatch.has(chat)) ? this.texts.get(chat) : undefined;
        const text = session.separateThinking && !followsReasoning ? raw?.reply : (followsReasoning && raw?.projected ? raw.projected : raw);
        let delta = textDelta(text, cursor);
        if (chunks && delta) {
          const cut = chunkDelta(text, delta, cursor, loose, true);
          delta = cut.delta;
          held ||= cut.held;
          if (delta?.stream.add) {
            // A structural change can go at once without also repainting a growing paragraph.
            // Leave the cursor where it is until the next words are actually sent.
            const wait = (session.lastWords ?? -Infinity) + this.chunkTiming.live - now;
            if (throttle && delta.stream.from > 0 && wait > 0) {
              wordsIn = wait;
              delta = undefined;
            } else {
              live = true;
              first ||= delta.stream.from === 0;
            }
          }
        }
        if (text?.preview) {
          // Establish the preview source even when the first incomplete reply chunk is held.
          if (!delta && cursor?.id !== text.id) delta = { id: text.id, stream: { from: 0, add: "" }, thinking: { from: 0, add: "" } };
          if (delta) delta.preview = text.preview;
        }
        if (delta !== undefined) {
          parts.push(JSON.stringify("text:" + chat) + ":" + JSON.stringify(delta));
          if (advance) deliveredText.push([chat, delta]);
        }
      }
      if (!followsReasoning) continue;
      const key = "reasoning:" + chat;
      const part = shown ? this.reasoningParts.get(chat) : undefined;
      const sent = session.reasoningSent.get(chat);
      if (!part && !sent && !Object.hasOwn(known, key)) continue;
      const version = part?.version ?? 0;
      versions[key] = version;
      if (sent?.version === version && known[key] === version) continue;
      const snapshot = part?.snapshot ?? null;
      const acknowledged = sent && known[key] === sent.version ? sent.snapshot : undefined;
      // A disconnect can lose the clear itself. Re-send it until the phone acknowledges it.
      const delta = snapshot ? reasoningDelta(snapshot, acknowledged)
        : sent?.snapshot || (known[key] > 0 && known[key] !== version) ? null : undefined;
      if (delta !== undefined) {
        parts.push(JSON.stringify(key) + ":" + JSON.stringify(delta));
        deliveredReasoning.push([chat, { version, snapshot }]);
      }
    }
    if (held) session.heldSince ??= now;
    else if (!Number.isFinite(wordsIn)) delete session.heldSince;
    const pending = Math.min(wordsIn, held ? Math.max(1, session.heldSince + this.chunkTiming.holdMax - now) : Infinity);
    if (!parts.length) return (throttle || advance) && Number.isFinite(pending) ? pending : null;
    // Keep the long poll open for an approval, a send or the watched chat. Only progress on
    // existing runs waits here, and the next change can wake the same waiter before its timer.
    if (progress && parts.length === 1) {
      const remaining = Math.max((session.lastProgress ?? -Infinity) + SUMMARY_PUMP_MS, throttle && interval ? (session.lastNews ?? 0) + interval : 0) - now;
      if (remaining > 0) return Math.min(remaining, pending);
    } else {
      const gap = chunks && textOnly ? (live ? this.chunkTiming.live : this.chunkTiming.every) : interval || TEXT_PUMP_MS;
      const last = chunks && live && textOnly ? session.lastWords : session.lastNews;
      const remaining = (last ?? 0) + gap - now;
      if (throttle && (textOnly || interval) && remaining > 0 && !(first && textOnly)) return Math.min(remaining, pending);
    }
    if (progress) session.lastProgress = now;
    if (live) session.lastWords = now;
    for (const [bases, name, sent] of deliveredRuns) {
      if (sent) bases.set(name, sent);
      else bases.delete(name);
    }
    for (const [chat, sent] of deliveredReasoning) session.reasoningSent.set(chat, sent);
    advance?.(versions, deliveredText);
    session.lastNews = Date.now();
    session.watchUntil = session.lastNews + MAX_WAIT;
    return new Json('{"epoch":' + JSON.stringify(this.epoch) + ',"v":' + JSON.stringify(versions) + ',"parts":{' + parts.join(",") + "}}");
  }
  follow(session, push, read) {
    const quiet = { epoch: this.epoch, v: null, parts: {} };
    if (push.closed.aborted) return quiet;
    const seq = session.syncSeq;
    const started = Date.now();
    let last = null;
    return new Promise((resolve, reject) => {
      const end = () => {
        clearTimeout(timer);
        push.closed.removeEventListener("abort", end);
        this.waiters.delete(waiter);
        if (session.follow === waiter) delete session.follow;
        resolve(quiet);
      };
      const pump = () => {
        try {
          if (!push.ready()) return FOLLOW_PUMP_MS;
          const now = Date.now();
          if (last !== null && now < last + FOLLOW_PUMP_MS) return last + FOLLOW_PUMP_MS - now;
          const news = read(last !== null);
          const heartbeat = (last ?? started) + FOLLOW_QUIET_MS;
          if (!(news instanceof Json) && now < heartbeat) {
            return Math.min(heartbeat - now, typeof news === "number" ? news : Infinity);
          }
          const counter = (session.pushCounter ?? 0) + 1;
          if (!Number.isSafeInteger(counter)) throw new Error("Follow counter exhausted");
          session.pushCounter = counter;
          const nonce = pushNonce(counter);
          const aad = "push:" + session.id + ":" + seq + ":" + (last === null ? "first" : "more");
          const sealed = seal(session.toPhone, nonce, Buffer.from(news instanceof Json ? news.text : JSON.stringify(quiet)), aad);
          push.send(Buffer.concat([nonce.subarray(4), sealed]));
          session.used = last = Date.now();
          this.push.heard(session.deviceId);
          return FOLLOW_PUMP_MS;
        } catch (error) {
          reject(error);
          end();
        }
      };
      const waiter = { session, watching: session.watching, reasoningWatch: session.reasoningWatch, news: pump, end };
      const timer = setTimeout(end, FOLLOW_LIFE_MS);
      timer.unref?.();
      this.waiters.add(waiter);
      session.follow = waiter;
      push.closed.addEventListener("abort", end, { once: true });
      const delay = pump();
      if (delay) this.schedulePump(delay);
    });
  }
  sync(session, request, gone, via = "http", push) {
    const { epoch, have, watch, wait, appends, text } = request;
    // A gadget follows its two parts and its reply's text: no steps, and no reasoning.
    const forGadget = session.deviceId !== undefined && this.store.device(session.deviceId)?.kind === "gadget";
    const steps = forGadget ? undefined : request.steps;
    const reasoningWatch = forGadget ? undefined : request.reasoningWatch;
    const watching = (Array.isArray(watch) ? watch : []).filter((id) => typeof id === "string").slice(0, MAX_WATCH);
    // A hidden chat can keep one page warm without receiving text, reasoning or step updates.
    const keepPage = typeof request.keepPage === "string" &&
      (session.watching?.includes(request.keepPage) || request.keepPage === session.keepPage) ? request.keepPage : undefined;
    if (keepPage !== session.keepPage) this.dirty = true;
    session.keepPage = keepPage;
    session.watching = watching;
    session.textWatch = Array.isArray(request.textWatch) ? new Set(request.textWatch.slice(0, MAX_WATCH)) : null;
    session.noText = text === false;
    session.textMode = text === false ? "whole" : text === "chunks" ? "chunks" : "live";
    const previousReasoningWatch = session.reasoningWatch ?? [];
    const acceptsAppends = this.backend.streamAppends !== false && validCursors(appends, watching);
    session.reasoningNegotiated = this.backend.streamAppends !== false && validReasoningWatch(reasoningWatch) && (appends === undefined || acceptsAppends);
    session.separateThinking = session.reasoningNegotiated && request.separateThinking === true;
    session.reasoningWatch = session.reasoningNegotiated ? [...new Set(reasoningWatch)] : [];
    session.reasoningSent ??= new Map();
    for (const id of previousReasoningWatch) if (!session.reasoningWatch.includes(id)) {
      session.reasoningSent.delete(id);
      this.dirty = true;
    }
    // One form for a session: a client names it on every sync, and the versions it holds are for that form.
    session.light = steps === "light";
    if (!forGadget && session.light && request.runSteps === "delta") {
      session.runStepBases ??= new Map();
      for (const name of session.runStepBases.keys()) {
        const chat = name.slice(4);
        if (!watching.includes(chat) && !session.reasoningWatch.includes(chat)) session.runStepBases.delete(name);
      }
    } else delete session.runStepBases;
    if (!forGadget && request.runSummaries === "delta") session.runSummaryBases ??= new Map();
    else delete session.runSummaryBases;
    // Capture the negotiation for this request. A concurrent full-snapshot reader cannot opt in an older wait.
    const runBases = { steps: session.runStepBases, summaries: session.runSummaryBases, paceSummaries: !!push || Number(wait) > 0 };
    session.watchUntil = Date.now() + MAX_WAIT;
    let known = epoch === this.epoch && have && typeof have === "object" ? have : {};
    this.refresh(watching, session.reasoningWatch);
    const cursors = acceptsAppends ? Object.assign(Object.create(null), epoch === this.epoch ? appends : {}) : null;
    if (push) {
      const advance = (versions, deltas) => {
        known = versions;
        for (const [chat, delta] of deltas) {
          if (!delta) delete cursors[chat];
          else cursors[chat] = {
            id: delta.id, stream: delta.stream.from + delta.stream.add.length, thinking: delta.thinking.from + delta.thinking.add.length,
          };
        }
      };
      return this.follow(session, push, (throttle) => this.news(known, watching, cursors, session, throttle, FOLLOW_PUMP_MS, advance, runBases));
    }
    const interval = via === "relay" ? RELAY_POLL_MS : 0;
    const news = () => this.news(known, watching, cursors, session, Number(wait) > 0 || interval > 0, interval, undefined, runBases);
    const now = news();
    const quiet = () => ({ epoch: this.epoch, v: null, parts: {} });
    if (now instanceof Json) return now;
    // A wake asks only for news already present. If a relay tick is due shortly, include it
    // before the background client marks this sync fresh and goes back to sleep.
    const quick = !(Number(wait) > 0);
    if (quick && !(typeof now === "number" && now <= interval)) return quiet();
    // A phone has a couple of waits open at most; a newer one ends the oldest.
    const mine = [...this.waiters].filter((w) => w.session === session);
    for (const old of mine.slice(0, Math.max(0, mine.length - (MAX_WAITERS - 1)))) old.end();
    return new Promise((resolve) => {
      const waiter = {
        session,
        news,
        watching,
        reasoningWatch: session.reasoningWatch,
        end: (news) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(news ?? quiet());
        },
      };
      const timer = setTimeout(() => {
        const pending = quick ? news() : null;
        waiter.end(pending instanceof Json ? pending : undefined);
      }, quick ? now : Math.min(Number(wait), MAX_WAIT));
      timer.unref?.();
      this.waiters.add(waiter);
      if (typeof now === "number") this.schedulePump(now);
      gone.then(() => waiter.end());
    });
  }
}
