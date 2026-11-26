// Notifications and Live Activities for paired phones.
//
// The computer watches its own state (a reply finished, a bot needs an answer, a turn is under
// way) and tells the phones that asked to be told. It can't reach Apple itself, so it sends through
// the relay's push route (relay/README.md), signed with the relay key this computer already has:
//
//   POST <relay>/v1/push
//   { v: 1, key: <public key>, time: <seconds>, sig, sends: "<JSON text of the items>" }
//   sig = Ed25519 over "botkins-push-v1:" + time + ":" + sends
//
// What a notification says never crosses the relay in the clear. The payload Apple carries shows
// "New message"; the real title and text are sealed with a key only this computer and that phone
// have (derived from the pairing), and the phone's notification extension opens it:
//
//   key    = HKDF-SHA256(device key, salt = device id, info = "botkins/push/v1")
//   b      = base64(nonce(12) + ChaCha20-Poly1305(key, nonce, JSON, aad "botkins-push-v1"))
//   JSON   = { t: title, m: text, c: chat id, k: kind, r?: request id }
//
// A Live Activity's state goes to the Lock Screen as Apple delivers it, so what it says in the clear
// is small: phases, counts, times and the provider. A phone that asked for one card for all Botkins
// ("activity-all-v1") or one per Botkin ("activity-bots-v1", docs/live-cards.md) also gets the chats'
// titles, steps, thinking and requests, sealed like an alert (with its own AAD, "botkins-card-v1");
// the widget extension opens them on the phone. A phone with one card per chat gets a short label
// that is the step's name only when it has previews on, as before.
//
// The card for all Botkins is started only by the phone, while the app is in front (a start from
// afar needs the app to say the card's address later, and often it never does). This computer keeps
// it up to date whenever the app is not in front. While it runs, a bot's request is told by the
// card's own update, which opens the Dynamic Island and makes the sound; without the card it is a
// notification, as before. When every chat on it has ended, its last update does the same, the
// finished turn's notification comes without a second sound, and the card is ended a minute later.
//
// Nothing here throws into the caller. A failed send is logged and forgotten: a notification that
// is late is worse than one that is missing.
import { ALL_CARD, askDetail, botCard, CARD_AAD, cardOver } from "./cards.mjs";
import { b64u, hkdf, random, seal } from "./crypto.mjs";
import { proactiveSees } from "./proactive-rules.mjs";
import { resolveRoutineTargets } from "./notify-targets.mjs";
import { signWithRelayKey } from "./relay.mjs";
import { Failure } from "./tools.mjs";

export const PUSH_INFO = "botkins/push/v1";
export const PUSH_AAD = "botkins-push-v1";
/** `updates`: a newer Botkins for this computer is out ("app-update-v1"). A phone registered before it existed counts as wanting it. */
// `spaces`: notes and changes in a person's spaces ("space-alerts-v1", space-alerts.mjs).
export const DEFAULT_PREFS = { replies: true, requests: true, routines: true, previews: true, activities: true, updates: true, spaces: true };
/** A version the computer may name in an update notice ("0.16.5", "1.0.0-beta.2"). */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
/** The Swift type the phone's Live Activity is declared with. Apple matches a push to it by this name. */
export const ACTIVITY_TYPE = "BotkinActivityAttributes";

const TOKEN = /^[0-9a-f]{64,200}$/;
const PRESENT_MS = 45_000; // a phone that said it is in front, and was heard from this recently, is looking at the app
const ACTIVITY_GAP_MS = 15_000; // ordinary Lock Screen progress only; milestones go immediately
const ACTIVITY_STALE_S = 15 * 60;
// A finished turn's card stays on the phone, marked done, this long, unless a new turn in the chat
// takes it over first. Then it is ended. (The phone has the same time: LINGER_MS in src/state/activity.ts.)
export const ACTIVITY_LINGER_MS = 30 * 60_000;
const MAX_ACTIVITIES = 4; // Live Activity tokens kept for one phone
// A card whose chats have all ended shows so (in the Dynamic Island too) this long before it is
// ended; a new turn in that while takes it over. Its final state then stays on the Lock Screen a few minutes.
export const OVER_HOLD_MS = 60_000;
const SEND_TIMEOUT_MS = 15_000;
const TEXT = 180;

const firstLine = (text) => {
  const line = String(text ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  // Markdown marks read badly in a banner.
  const plain = (line ?? "").replace(/^#{1,6}\s+/, "").replace(/[*_`~]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return plain.length > TEXT ? plain.slice(0, TEXT - 1) + "…" : plain;
};

/** The token and environment a phone may register, or a plain error. */
export function cleanTarget(target) {
  const token = String(target?.token ?? "").toLowerCase();
  if (!TOKEN.test(token)) throw new Failure("That isn't a notification address.");
  const env = target?.env === "sandbox" ? "sandbox" : "production";
  const start = target?.start == null ? undefined : String(target.start).toLowerCase();
  if (start !== undefined && !TOKEN.test(start)) throw new Failure("That isn't a notification address.");
  // "all": one Live Activity for all Botkins ("activity-all-v1"). "bots": one per Botkin
  // ("activity-bots-v1"). Without either, one per chat.
  const cards = target?.cards === "all" || target?.cards === "bots" ? target.cards : undefined;
  return { token, env, ...(start && { start }), ...(cards && { cards }) };
}

export function cleanPrefs(prefs, base = DEFAULT_PREFS) {
  const next = { ...base };
  for (const name of Object.keys(DEFAULT_PREFS)) if (typeof prefs?.[name] === "boolean") next[name] = prefs[name];
  return next;
}

/** What a chat's Live Activity shows now. `previews` off keeps step names out of it. */
export function activityState(state, chatId, run, previews) {
  const asked = (state.requests ?? []).some((request) => request.chatId === chatId);
  const steps = run?.steps ?? [];
  const current = [...steps].reverse().find((step) => step.status === "Running") ?? steps[steps.length - 1];
  const startedAt = Math.floor((run?.time ?? Date.now()) / 1000);
  const base = { steps: steps.length, startedAt };
  if (!run || run.status !== "Working") {
    const failed = !!run && run.status !== "Completed";
    // When it ended, so the card shows how long it took and stops counting.
    return { ...base, phase: failed ? "failed" : "done", label: failed ? "Stopped" : "Done", finishedAt: Math.max(startedAt, Math.floor((run?.finished ?? Date.now()) / 1000)) };
  }
  if (asked) return { ...base, phase: "needs-you", label: "Needs you" };
  if ((state.streams ?? {})[chatId]) return { ...base, phase: "working", label: "Writing" };
  if (current) return { ...base, phase: "working", label: previews ? firstLine(current.label || current.name).slice(0, 60) || "Working" : "Working" };
  return { ...base, phase: "thinking", label: "Thinking" };
}

export class Push {
  /**
   * @param store      the LinkStore (keeps each phone's tokens and choices, and the relay key)
   * @param deviceKey  (deviceId) => the phone's pairing key, or null when the phone is gone
   * @param relayUrl   () => the relay's address
   * @param snapshot   () => the app's state
   * @param attention  optional () => { focused, chatId? }: the person is looking at the computer's own window
   */
  constructor({ store, deviceKey, relayUrl, snapshot, attention, people, changed = () => {}, fetch = globalThis.fetch, log = () => {}, now = Date.now }) {
    Object.assign(this, { store, deviceKey, relayUrl, snapshot, attention, people, changed, fetch, log, now });
    this.seen = new Map(); // device id → when it last made a call
    this.front = new Map(); // device id → { active, chatId }
    this.lingering = new Map(); // "device:chat" → the timer that ends a finished turn's card
    this.stamps = new Map(); // an activity's token → the timestamp of the last push to it
    this.started = new Set(); // "device:chat" → a card was started by push, and its own address isn't known yet
    this.working = null; // run id → whether it was still working, for every run seen at the last look
    this.asked = new Set(); // request ids seen
    this.sent = new Map(); // "device:chat" → { at, text } of the last Live Activity update
    this.updating = new Set(); // "device version": an update notice on its way, not yet taken by the relay
    this.timer = null;
    this.cardTimer = null; // looks again when a Botkin's card next changes by itself (a chat drops off, a held-back update)
    this.cardAt = 0;
    // device id → Map(chat id → { alert, kind }): a request's or a finished turn's notification, held
    // for the card for all Botkins, which makes the sound in its place when it shows the request or
    // the end of every chat (Push.cards).
    this.chimes = new Map();
    this.overHold = OVER_HOLD_MS;
  }

  // ── What a phone sets ───────────────────────────────────────────────────────────────────────

  register(deviceId, target, prefs) {
    const before = this.store.push(deviceId);
    const clean = cleanTarget(target);
    // An Apple address belongs to one app on one phone. A phone that paired again (or whose old
    // entry was never removed) leaves an entry holding the same address: it would get every alert
    // twice, one sealed with a key the phone no longer has, and a Live Activity start on every send.
    for (const device of this.store.data.devices) {
      if (device.id === deviceId) continue;
      const other = this.store.push(device.id);
      if (other && (other.token === clean.token || (clean.start && other.start === clean.start))) this.store.setPush(device.id, null);
    }
    // The newest version this phone was told about stays: registering again doesn't tell it twice.
    // The same registration again (a phone that asks often) writes nothing and wakes no phone.
    if (this.store.setPush(deviceId, { ...clean, prefs: cleanPrefs(prefs, before?.prefs), activities: before?.activities ?? {}, ...(before?.updateSeen && { updateSeen: before.updateSeen }) })) this.changed();
  }
  setPrefs(deviceId, prefs) {
    const record = this.store.push(deviceId);
    if (!record) throw new Failure("Turn notifications on first.");
    this.store.setPush(deviceId, { ...record, prefs: cleanPrefs(prefs, record.prefs) });
    this.changed();
  }
  unregister(deviceId) {
    this.store.setPush(deviceId, null);
    this.changed();
  }
  /** A Live Activity's own token for a chat, or null when the activity ended. */
  setActivity(deviceId, chatId, token) {
    const record = this.store.push(deviceId);
    if (!record || typeof chatId !== "string" || !chatId || chatId.length > 200) return;
    const activities = { ...record.activities };
    if (token == null) delete activities[chatId];
    else {
      const clean = String(token).toLowerCase();
      if (!TOKEN.test(clean)) throw new Failure("That isn't a notification address.");
      delete activities[chatId];
      activities[chatId] = clean;
      // The oldest go first: a phone shows a few activities at most.
      for (const old of Object.keys(activities).slice(0, -MAX_ACTIVITIES)) delete activities[old];
    }
    this.store.setPush(deviceId, { ...record, activities });
    this.sent.delete(deviceId + ":" + chatId);
    // The card's own address is known now (or the card is gone): no more guessing about it.
    this.started.delete(deviceId + ":" + chatId);
    if (token == null) this.stay(deviceId + ":" + chatId, false);
    // A turn may have moved on, or ended, while the phone was getting its token. A Botkin's card is
    // brought up to date by the next look, which sends it whole now that nothing was sent to it.
    if (token != null) {
      if (chatId.startsWith("bot:") || chatId === ALL_CARD) this.soon();
      else this.catchUp(deviceId, chatId);
    }
  }
  setPresence(deviceId, active, chatId) {
    const was = this.front.get(deviceId)?.active === true;
    this.front.set(deviceId, { active: active === true, chatId: typeof chatId === "string" ? chatId : undefined });
    this.seen.set(deviceId, this.now());
    // The phone drew its own cards while it was in front; from now on this computer does, starting
    // with the whole card again: what the phone drew is not what this computer last sent.
    if (was && active !== true) {
      for (const [key, last] of this.sent) if (key.startsWith(deviceId + ":") && last.text) this.sent.set(key, { ...last, text: "" });
      this.soon();
    }
  }
  /** Any call from a phone shows it is awake. */
  heard(deviceId) {
    this.seen.set(deviceId, this.now());
  }
  forget(deviceId) {
    this.seen.delete(deviceId);
    this.front.delete(deviceId);
    for (const key of [...this.sent.keys()]) if (key.startsWith(deviceId + ":")) this.sent.delete(key);
    for (const key of [...this.lingering.keys()]) if (key.startsWith(deviceId + ":")) this.stay(key, false);
    for (const key of [...this.started]) if (key.startsWith(deviceId + ":")) this.started.delete(key);
    this.chimes.delete(deviceId);
  }
  /** Keeps (or, with false, stops keeping) the time after which a finished turn's card is ended. */
  stay(key, on, end) {
    clearTimeout(this.lingering.get(key));
    this.lingering.delete(key);
    if (!on) return;
    const timer = setTimeout(() => {
      this.lingering.delete(key);
      end();
    }, ACTIVITY_LINGER_MS);
    timer.unref?.();
    this.lingering.set(key, timer);
  }
  /** Ends a chat's card on a phone now, and forgets its address. */
  endActivity(deviceId, chatId) {
    const record = this.store.push(deviceId);
    const token = record?.activities?.[chatId];
    if (!token) return;
    void this.send([this.activity(record, token, "end", this.lastState(deviceId, chatId), { dismissIn: 0 })]);
    this.setActivity(deviceId, chatId, null);
  }
  /** What a chat's card was last told to show, for a push that only ends it. */
  lastState(deviceId, chatId) {
    const last = this.sent.get(deviceId + ":" + chatId);
    if (last?.state) return last.state;
    try {
      if (last?.text) return JSON.parse(last.text);
    } catch {
      // Falls through to a plain "done".
    }
    const now = Math.floor(this.now() / 1000);
    return { steps: 0, startedAt: now, phase: "done", label: "Done", finishedAt: now };
  }
  /** What a device says is on its screen, when it is in front and was heard from lately: { chatId? }, else null. */
  frontOf(deviceId) {
    const front = this.front.get(deviceId);
    if (!front?.active || this.now() - (this.seen.get(deviceId) ?? 0) > PRESENT_MS) return null;
    return { chatId: front.chatId };
  }
  /** The app is open on that phone right now (and, with `chatId`, showing that chat). */
  present(deviceId, chatId) {
    const front = this.front.get(deviceId);
    if (!front?.active || this.now() - (this.seen.get(deviceId) ?? 0) > PRESENT_MS) return false;
    return chatId === undefined || front.chatId === chatId;
  }
  /** What the phones part shows for a phone: its choices, never a token. */
  view(deviceId) {
    const record = this.store.push(deviceId);
    return record ? { ...record.prefs } : undefined;
  }
  /** For the desktop's own page. */
  status() {
    return this.store.data.devices.filter((device) => this.store.push(device.id)).map((device) => ({ deviceId: device.id, name: device.name, prefs: { ...this.store.push(device.id).prefs } }));
  }

  // ── Watching the app ────────────────────────────────────────────────────────────────────────

  /** Notes what is going on now, so nothing that is already there is announced. Called once, when the link starts. */
  start() {
    try {
      this.look();
    } catch (error) {
      this.log("push: " + (error?.message ?? error));
    }
  }
  /** The app's state changed. Looks a moment later, so a burst of changes is one look. */
  soon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.look();
      } catch (error) {
        this.log("push: " + (error?.message ?? error));
      }
    }, 250);
    this.timer.unref?.();
  }
  dispose() {
    clearTimeout(this.timer);
    this.timer = null;
    clearTimeout(this.cardTimer);
    this.cardTimer = null;
  }

  look() {
    const targets = this.store.data.devices.filter((device) => this.store.push(device.id));
    const state = this.snapshot();
    const runs = (state.runs ?? []).slice(0, 300);
    // Every run in view and whether it was still working: a run is told about once when it starts
    // and once when it ends, also when it did both between two looks.
    const known = new Map(runs.map((run) => [run.id, run.status === "Working"]));
    const first = this.working === null;
    const before = this.working ?? new Map();
    const requests = state.requests ?? [];
    // The reminders the app sent in the last few minutes (its desktop/reminders.mjs): each goes once, to the person it is for.
    const reminders = (Array.isArray(state.reminders) ? state.reminders : []).filter((reminder) => reminder && typeof reminder.key === "string" && typeof reminder.person === "string");
    const reminderId = (reminder) => reminder.person + " " + reminder.key;
    // Human @mentions recorded in the last few minutes (desktop/human-mentions.mjs): each goes once to the mentioned person.
    const mentions = (Array.isArray(state.mentions) ? state.mentions : []).filter((mention) => mention && typeof mention.id === "string" && typeof mention.person === "string");
    const mentionedRuns = new Set(mentions.filter((mention) => typeof mention.runId === "string" && mention.runId).map((mention) => mention.runId + ":" + mention.person));
    const sends = [];
    // The chats whose turn ended at this look, for the card for all Botkins: it makes its sound for
    // these. A turn the person stopped themselves ends quietly.
    const ended = new Set();

    if (!first && targets.length) {
      const chats = new Map((state.chats ?? []).map((chat) => [chat.id, chat]));
      const bots = new Map((state.bots ?? []).map((bot) => [bot.id, bot]));
      for (const request of requests) if (!this.asked.has(request.id)) this.onRequest(sends, targets, request, chats, bots);
      for (const reminder of reminders) if (!this.reminded?.has(reminderId(reminder))) this.onReminder(sends, targets, reminder, chats);
      for (const mention of mentions) if (!this.mentioned?.has(mention.id)) this.onMention(sends, targets, mention, chats);
      for (const run of runs) {
        const working = run.status === "Working";
        const was = before.get(run.id);
        if (working && was === undefined) this.onStart(sends, targets, state, run, chats, bots);
        else if (!working && was !== false) {
          this.onFinish(sends, targets, state, run, chats, bots, mentionedRuns);
          if (run.status !== "Stopped" && run.notify !== false) ended.add(run.chatId);
        }
        // Turns still under way: their Live Activities follow along.
        else if (working) this.onProgress(sends, targets, state, run);
      }
    }
    // The cards for all Botkins and for each Botkin, also at the first look: a card left from before
    // this computer started is brought up to date, or ended when nothing is left on it.
    if (targets.length) this.cards(sends, targets, state, ended);
    this.working = known;
    this.asked = new Set(requests.map((request) => request.id));
    this.reminded = new Set(reminders.map(reminderId));
    this.mentioned = new Set(mentions.map((mention) => mention.id));
    if (sends.length) void this.send(sends);
  }

  /**
   * Holds a notification for the card for all Botkins (Push.cards decides at once whether the card
   * makes its sound instead). False when the phone has no such card running.
   */
  hold(deviceId, record, chatId, alert, kind) {
    if (record.cards !== "all" || !record.prefs.activities || !record.activities?.[ALL_CARD]) return false;
    const waiting = this.chimes.get(deviceId) ?? new Map();
    waiting.set(chatId, { alert, kind });
    this.chimes.set(deviceId, waiting);
    return true;
  }

  wants(device, kind) {
    const record = this.store.push(device.id);
    if (!record) return false;
    // A choice a phone never made (one added since it registered) is the default.
    return (record.prefs[kind] ?? DEFAULT_PREFS[kind]) === true;
  }
  /**
   * Whether a chat's alerts go to a device: only to the chat's people ("team-people-v1"), the one
   * who started it and those invited. An owner device no longer hears of a member's chat unless the
   * owner was invited. `people` is the link's own answer (server.mjs, inChat).
   */
  maySeeChat(device, chat) {
    if (chat?.hostDispatch && (device.kind === "gadget" || device.memberId)) return false;
    if (!chat) return !device.memberId;
    const person = device.memberId ?? "owner";
    // Without the link's list of who was invited, a chat is its starter's alone.
    return this.people ? this.people(chat, person) : (chat.createdBy || "owner") === person;
  }

  onRequest(sends, targets, request, chats, bots) {
    const chat = chats.get(request.chatId);
    const bot = bots.get(request.botId ?? chat?.botId);
    const name = request.nodeJob
      ? (request.sourceBotName && request.sourceHostName ? `${request.sourceBotName} on ${request.sourceHostName}` : request.sourceBotName || "Node host")
      : (bot?.name ?? "A bot");
    // A secure input ("secure-input-v1") is named as what it is: its answer is typed into a prompt of
    // its own, never into the chat.
    const title = request.kind === "permission" ? name + " needs your approval" : request.kind === "secure" ? name + " needs a secure input" : name + " has a question";
    for (const device of targets) {
      // A request only the owner can answer (an approval, a secure input) goes to the owner's devices
      // whoever's chat it is: nobody else can unblock the bot. Any other goes to the chat's people.
      if ((request.dispatch || request.review) && device.kind === "gadget") continue;
      const ownerOnly = request.kind === "permission" || request.kind === "secure";
      if (ownerOnly ? !!device.memberId : !this.maySeeChat(device, chat)) continue;
      if (!this.wants(device, "requests") || (!request.nodeJob && this.present(device.id, request.chatId))) continue;
      const record = this.store.push(device.id);
      const text = record.prefs.previews ? firstLine(request.title) || "Open Botkins to answer." : "Open Botkins to answer.";
      // What the notification's buttons are (docs/live-cards.md, section 6). With previews off they
      // would show the bot's words, so the notification only opens the app.
      const alert = this.alert(
        device.id,
        record,
        {
          t: title.slice(0, 80),
          m: text,
          c: request.chatId,
          k: "request",
          r: request.id,
          ...(request.nodeJob && { nj: true }),
          ...(record.prefs.previews && { q: askDetail(request) }),
        },
        { urgent: true, expiration: 300 },
      );
      // A phone with the card for all Botkins running hears of it from the card (Push.cards), which
      // falls back to this notification when the card doesn't show the request.
      if (request.nodeJob || !this.hold(device.id, record, request.chatId, alert, "request")) sends.push(alert);
    }
  }

  /**
   * One plain reminder that something is left waiting on a person (the app decides when: once for each
   * thing, never in quiet hours, a few a day). It goes only to that person's own devices, by their own
   * "A bot needs me" choice, and not to a phone that is showing that chat. Its title is the bot's name and
   * what it waits on; its text is shown only with previews on.
   */
  onReminder(sends, targets, reminder, chats) {
    const chat = chats.get(reminder.chatId);
    for (const device of targets) {
      if (chat?.hostDispatch && device.kind === "gadget") continue;
      if ((device.memberId ?? "owner") !== reminder.person) continue;
      // A request only the owner can answer is the owner's whoever's chat it is. Anything else is for the chat's people.
      if (reminder.ownerOnly ? !!device.memberId : !this.maySeeChat(device, chat)) continue;
      if (!this.wants(device, "requests") || this.present(device.id, reminder.chatId)) continue;
      const record = this.store.push(device.id);
      const text = record.prefs.previews ? firstLine(reminder.body) || "Open Botkins to see it." : "Open Botkins to see it.";
      sends.push(this.alert(device.id, record, { t: String(reminder.title ?? "Botkins").slice(0, 80), m: text, c: reminder.chatId, k: "reminder" }, { expiration: 3600 }));
    }
  }

  /**
   * A direct @mention of a person in a shared chat (from another person or a bot). Sent to that
   * person's devices when they have reply notifications on and aren't actively viewing that chat.
   */
  onMention(sends, targets, mention, chats) {
    const chat = chats.get(mention.chatId);
    const watching = this.attention?.();
    const who = typeof mention.by === "string" && mention.by.trim() ? mention.by.trim() : "Someone";
    const title = (who + " mentioned you in a chat").slice(0, 80);
    for (const device of targets) {
      const person = device.memberId ?? "owner";
      if (person !== mention.person) continue;
      if (!this.maySeeChat(device, chat)) continue;
      if (!this.wants(device, "replies") || this.present(device.id, mention.chatId)) continue;
      if (person === "owner" && watching?.focused && (watching.chatId === undefined || watching.chatId === mention.chatId)) continue;
      const record = this.store.push(device.id);
      const text = record.prefs.previews ? firstLine(mention.preview) || "Open Botkins to see it." : "Open Botkins to see it.";
      sends.push(this.alert(device.id, record, { t: title, m: text, c: mention.chatId, k: "mention" }, { expiration: 900 }));
    }
  }

  /** Whether a run that finished is worth a notification, and of which kind (the desktop's own rules). */
  kindOf(run, chat) {
    if (!chat || chat.temporary || run.status === "Stopped" || run.notify === false) return null;
    // A bot's own check that failed is in its Proactive log, not a notification.
    if (run.proactive && (run.status !== "Completed" || !run.delivery)) return null;
    // A run that published nothing (a routine set to "No output", or one that reached the end with
    // no result to deliver) has nothing to tell: a notification would show an earlier run's words.
    // One that failed is still worth a look.
    if (run.status === "Completed" && run.noOutput === true) return null;
    const scheduled = run.scheduleId != null || run.trigger === "scheduled";
    const failed = run.status !== "Completed";
    if (run.panelId) return scheduled && failed ? "routines" : null;
    if (scheduled) {
      const entry = (chat.schedules ?? []).find((schedule) => schedule.id === run.scheduleId);
      if (entry?.deliver?.to === "none") return null;
      if (run.notifyTargets?.mode === "none") return null;
      if (run.notifyTargets?.mode === "only") return "routines";
      // A routine the person made quiet says nothing, here or on the computer.
      return entry?.notify === false ? null : "routines";
    }
    return "replies";
  }

  onFinish(sends, targets, state, run, chats, bots, mentionedRuns = null) {
    const chat = chats.get(run.chatId);
    const kind = this.kindOf(run, chat);
    const resolved =
      kind === "routines" && !run.panelId && !run.proactive
        ? resolveRoutineTargets({
            run,
            chat,
            team: this.store.data.team,
            devices: this.store.data.devices,
            botId: chat?.botId,
          })
        : null;
    // Text written on the way ("turn-timeline-v1": `interim`) is not the reply.
    const reply = [...(chat?.messages ?? [])].reverse().find((message) => message.runId === run.id && message.role !== "user" && !message.interim);
    const bot = bots.get(reply?.botId ?? chat?.botId);
    const name = bot?.name ?? "Botkins";
    const failed = run.status !== "Completed";
    const watching = this.attention?.();
    const deliveryChat = run.delivery?.chatId ? chats.get(run.delivery.chatId) : null;
    for (const device of targets) {
      const person = device.memberId ?? "owner";
      // A proactive alert is for the one person the bot looked out for, while they may still see that bot.
      if (run.proactive && (!chat || person !== (chat.createdBy ?? "owner") || !proactiveSees(this.store.data.team, person, chat.botId))) continue;
      const canSeeChat = this.maySeeChat(device, chat);
      const record = this.store.push(device.id);
      if (canSeeChat) {
        // The card is brought up to date whatever the notification choices are. It is not ended: it
        // says "done" (or "stopped") with how long the turn took, stays for a while, and a new turn
        // in the chat takes it over. Only after that while without one is it ended.
        const key = device.id + ":" + run.chatId;
        const activity = record.activities?.[run.chatId];
        if (activity) {
          const done = activityState(state, run.chatId, run, record.prefs.previews);
          this.sent.set(key, { at: this.now(), text: JSON.stringify(done), over: true });
          sends.push(this.activity(record, activity, "update", done, { urgent: true, staleIn: ACTIVITY_LINGER_MS / 1000 + 60 }));
          this.stay(key, true, () => this.endActivity(device.id, run.chatId));
        } else if (record.prefs.activities && this.started.has(key)) {
          // A push started this chat's card, and the phone hasn't said where the card's updates go
          // (the app was closed). The app is woken for a moment: it marks its card done itself and
          // tells this computer the card's address for the next time.
          this.started.delete(key);
          sends.push({ token: record.token, env: record.env, type: "background", priority: 5, expiration: 600, payload: { aps: { "content-available": 1 }, w: 1 } });
        }
      }
      if (!kind) continue;
      // If a bot @mentioned this person in this run, they already get "{Bot} mentioned you in a chat".
      if (kind === "replies" && mentionedRuns?.has(run.id + ":" + person)) continue;
      const explicit = resolved?.explicit === true;
      let openChatId;
      if (explicit) {
        if (resolved.silent || !resolved.deviceIds.has(device.id)) continue;
        if (!this.wants(device, kind)) continue;
        if (run.delivery?.chatId && this.maySeeChat(device, deliveryChat)) openChatId = run.delivery.chatId;
        else if (canSeeChat) openChatId = run.chatId;
        if (openChatId && this.present(device.id, openChatId)) continue;
      } else {
        if (!canSeeChat) continue;
        if (!this.wants(device, kind) || this.present(device.id, run.delivery?.chatId ?? run.chatId)) continue;
        // An alert opens the chat a result was delivered to: it goes only to someone who is in that chat.
        if (run.delivery?.chatId && run.delivery.chatId !== run.chatId && !this.maySeeChat(device, deliveryChat)) continue;
        // The person is reading this chat on the computer itself: a reply there needs no second ping.
        if (kind === "replies" && watching?.focused && (watching.chatId === undefined || watching.chatId === run.chatId)) continue;
        openChatId = run.delivery?.chatId ?? run.chatId;
      }
      // A bot that looks out for the person speaks under its own name: never the name of the routine Botkins keeps for it.
      const title = run.proactive ? name : kind === "routines" ? run.title || name : chat?.title && !/^new chat$/i.test(chat.title) ? name + " · " + chat.title : name;
      // What the alert offers ("proactive-team-v1"): the phone's button asks the computer by these, and never holds the offer's words.
      const delivered = run.proactive && run.delivery?.chatId ? (chats.get(run.delivery.chatId)?.messages ?? []).find((message) => message.proactiveRunId === run.id) : run.proactive && run.delivery?.itemId ? (state.board ?? []).find((item) => item.id === run.delivery.itemId) : null;
      const offered = delivered?.alert?.offer && chat?.botId ? { a: { b: chat.botId, r: run.id } } : null;
      const customMessage = !failed ? resolved?.message : null;
      const said = failed ? (run.status === "Failed" ? "Failed" : run.status) + (run.detail ? ": " + firstLine(run.detail) : "") : firstLine(customMessage || reply?.text) || "Finished.";
      const text = record.prefs.previews ? said : failed ? "A run needs a look." : "New message";
      // A routine that sends its result to a chat is opened there, where the person reads it.
      // When an explicit routine target cannot access either chat, omit `c` rather than leaking it.
      const payload = { t: title.slice(0, 80), m: text, ...(openChatId && { c: openChatId }), k: kind === "routines" ? "routine" : "reply", ...offered };
      const alert = this.alert(device.id, record, payload, {
        expiration: 900,
        ...(!openChatId && { group: "routine:" + (run.scheduleId ?? run.id) }),
      });
      if (!canSeeChat || !this.hold(device.id, record, run.chatId, alert, "finish")) sends.push(alert);
    }
  }

  onStart(sends, targets, state, run, chats, bots) {
    const chat = chats.get(run.chatId);
    // A turn the person started is worth a Live Activity; a scheduled one would only be noise.
    if (!chat || chat.temporary || run.panelId || run.scheduleId != null || run.trigger === "scheduled") return;
    const bot = bots.get(chat.botId);
    for (const device of targets) {
      if (!this.maySeeChat(device, chat)) continue;
      const record = this.store.push(device.id);
      // The card for all Botkins is started by the phone alone (see the top of this file).
      if (record.cards === "all") continue;
      if (record.cards === "bots") {
        this.startCard(sends, device, record, state, bot);
        continue;
      }
      // A new turn takes the chat's card over: it is no longer waiting to be ended.
      this.stay(device.id + ":" + run.chatId, false);
      if (!record.prefs.activities || !record.start || record.activities?.[run.chatId] || this.present(device.id)) continue;
      this.started.add(device.id + ":" + run.chatId);
      const look = bot?.look ?? this.store.data.looks?.[bot?.id] ?? {};
      sends.push({
        token: record.start,
        env: record.env,
        type: "liveactivity",
        priority: 10,
        expiration: 120,
        payload: {
          aps: {
            timestamp: Math.floor(this.now() / 1000),
            event: "start",
            "attributes-type": ACTIVITY_TYPE,
            attributes: { chatId: run.chatId, botId: bot?.id ?? "", botName: (bot?.name ?? "Botkins").slice(0, 40), head: look.head ?? "", palette: look.palette ?? "original", eyes: look.eyes ?? "oval", colors: look.colors ?? [] },
            "content-state": activityState(state, run.chatId, run, record.prefs.previews),
            "stale-date": Math.floor(this.now() / 1000) + ACTIVITY_STALE_S,
            alert: { title: bot?.name ?? "Botkins", body: "Working on it" },
          },
        },
      });
    }
  }

  onProgress(sends, targets, state, run) {
    const chat = (state.chats ?? []).find((item) => item.id === run.chatId);
    for (const device of targets) {
      if (!this.maySeeChat(device, chat)) continue;
      const record = this.store.push(device.id);
      const token = record.activities?.[run.chatId];
      if (!token || !record.prefs.activities) continue;
      const next = activityState(state, run.chatId, run, record.prefs.previews);
      const key = device.id + ":" + run.chatId;
      const last = this.sent.get(key);
      const text = JSON.stringify(next);
      if (last?.text === text) continue;
      // A card that said "done" and has a new turn to show changes at once, like one that needs the person.
      const urgent = next.phase === "needs-you" || last?.phase === "needs-you" || last?.over === true;
      // The phone shows the app's own state while it is in front; Apple also limits how often an activity may change.
      const now = this.now();
      if (!urgent) {
        if (this.present(device.id)) continue;
        if (last && now - last.at < ACTIVITY_GAP_MS) {
          this.scheduleCardLook(last.at + ACTIVITY_GAP_MS + 50, now);
          continue;
        }
      }
      this.sent.set(key, { at: now, text, phase: next.phase });
      sends.push(this.activity(record, token, "update", next, { urgent }));
    }
  }

  // ── Building what is sent ───────────────────────────────────────────────────────────────────

  /** Seals `content` for one phone. Null when the phone is gone. */
  seal(deviceId, content, aad = PUSH_AAD) {
    const deviceKey = this.deviceKey(deviceId);
    if (!deviceKey) return null;
    const key = hkdf(deviceKey, Buffer.from(deviceId, "utf8"), PUSH_INFO);
    const nonce = random(12);
    return Buffer.concat([nonce, seal(key, nonce, Buffer.from(JSON.stringify(content), "utf8"), aad)]).toString("base64");
  }

  alert(deviceId, record, content, { urgent = false, expiration = 900, group } = {}) {
    // A chat's alerts share a banner and a thread; `group` gives others one of their own.
    const thread = group ?? content.c ?? "botkins";
    return {
      token: record.token,
      env: record.env,
      type: "alert",
      priority: 10,
      expiration,
      // One banner per chat: a newer one replaces an older one that was not read.
      collapse: b64u(hkdf(Buffer.from(thread, "utf8"), Buffer.from(deviceId, "utf8"), "botkins/push/collapse/v1", 24)),
      payload: {
        aps: {
          alert: { title: "Botkins", body: content.k === "request" || content.k === "reminder" ? "A bot needs you" : content.k === "update" ? "An update is available" : content.k === "space" ? "A space changed" : "New message" },
          sound: "default",
          "mutable-content": 1,
          "thread-id": b64u(hkdf(Buffer.from(thread, "utf8"), Buffer.from(deviceId, "utf8"), "botkins/push/thread/v1", 12)),
          "interruption-level": urgent ? "time-sensitive" : "active",
          category: content.k === "request" ? "botkins_request" : content.k === "team" ? "botkins_team" : "botkins_message",
        },
        b: this.seal(deviceId, content),
      },
    };
  }

  /**
   * A chat's card as it is now, for a phone that has just said where the card's updates go: the
   * turn may have moved on, or ended, while the phone was getting that address.
   */
  catchUp(deviceId, chatId) {
    const record = this.store.push(deviceId);
    const token = record?.activities?.[chatId];
    if (!token || !record.prefs.activities) return;
    let state;
    try {
      state = this.snapshot();
    } catch {
      return this.soon();
    }
    const working = (state?.runs ?? []).find((run) => run.chatId === chatId && run.status === "Working");
    if (working) return this.soon();
    // Nothing is running in the chat: its card is marked done, and ended after the usual while.
    const last = (state?.runs ?? []).filter((run) => run.chatId === chatId).reduce((latest, run) => (!latest || run.time > latest.time ? run : latest), null);
    const done = activityState(state ?? {}, chatId, last && last.status !== "Working" ? last : null, record.prefs.previews);
    const key = deviceId + ":" + chatId;
    this.sent.set(key, { at: this.now(), text: JSON.stringify(done), over: true });
    void this.send([this.activity(record, token, "update", done, { urgent: true, staleIn: ACTIVITY_LINGER_MS / 1000 + 60 })]);
    this.stay(key, true, () => this.endActivity(deviceId, chatId));
  }

  /**
   * One push to a chat's card. `staleIn` (seconds) is for a state that is meant to stay, such as
   * "done": the card isn't shown as out of date before then, and Apple keeps the push for a phone
   * that is out of reach for a while. `dismissIn` (seconds) is how long an ended card stays.
   */
  activity(record, token, event, state, { urgent = false, dismissIn, staleIn, relevance, alert } = {}) {
    // Apple applies a card's pushes by their timestamp and drops one that isn't newer than the last.
    // Two pushes in the same second (the last "writing" and the "done") would lose the second one.
    // What the phone draws itself counts too, at the phone's own time: the second is rounded up, so
    // a push is never older than what the phone drew a moment before it left the app.
    const seconds = Math.max(Math.ceil(this.now() / 1000), (this.stamps.get(token) ?? 0) + 1);
    this.stamps.delete(token);
    if (event !== "end") this.stamps.set(token, seconds);
    // The newest tokens are kept; a phone shows a few cards at most.
    for (const old of [...this.stamps.keys()].slice(0, -64)) this.stamps.delete(old);
    return {
      token,
      env: record.env,
      type: "liveactivity",
      // Apple holds a priority 5 push back: an alert in one would come late.
      priority: urgent || alert ? 10 : 5,
      expiration: staleIn || event === "end" ? 3600 : 120,
      payload: {
        aps: {
          timestamp: seconds,
          event,
          "content-state": state,
          // Which card the Dynamic Island shows when there are several: the one that needs the person.
          ...(relevance !== undefined && { "relevance-score": relevance }),
          ...(event === "end" ? { "dismissal-date": seconds + (dismissIn ?? 240) } : { "stale-date": seconds + (staleIn ?? ACTIVITY_STALE_S) }),
          // Lights the screen and makes the sound, in place of a notification of its own.
          ...(alert && { alert: { ...alert, sound: "default" } }),
        },
      },
    };
  }

  // ── One card per Botkin ("activity-bots-v1") ────────────────────────────────────────────────

  /** Starts a Botkin's card from afar when a turn begins and the phone has none for it (the app is closed). */
  startCard(sends, device, record, state, bot) {
    if (!bot) return;
    const cardKey = "bot:" + bot.id;
    const key = device.id + ":" + cardKey;
    if (!record.prefs.activities || !record.start || record.activities?.[cardKey] || this.started.has(key) || this.present(device.id)) return;
    const card = botCard(state, bot.id, { previews: record.prefs.previews, now: this.now(), visible: (chat) => this.maySeeChat(device, chat) });
    if (!card) return;
    this.started.add(key);
    const look = bot.look ?? this.store.data.looks?.[bot.id] ?? {};
    const sealed = card.detail ? this.seal(device.id, card.detail, CARD_AAD) : null;
    sends.push({
      token: record.start,
      env: record.env,
      type: "liveactivity",
      priority: 10,
      expiration: 120,
      payload: {
        aps: {
          timestamp: Math.floor(this.now() / 1000),
          event: "start",
          "attributes-type": ACTIVITY_TYPE,
          attributes: { chatId: "", botId: bot.id, botName: (bot.name ?? "Botkins").slice(0, 40), head: look.head ?? "", palette: look.palette ?? "original", eyes: look.eyes ?? "oval", colors: look.colors ?? [], card: "bot" },
          "content-state": { ...card.state, ...(sealed && { sealed }) },
          "relevance-score": card.relevance,
          "stale-date": Math.floor(this.now() / 1000) + ACTIVITY_STALE_S,
          alert: { title: bot.name ?? "Botkins", body: "Working on it" },
        },
      },
    });
  }

  /**
   * Brings the cards up to date on the phones that have one for all Botkins or one per Botkin. A
   * change that matters (a chat needs the person, a chat ended, a new turn on a card) goes at once;
   * steps and thinking at most every ACTIVITY_GAP_MS at priority 5, and not while the phone is in front (it draws its own cards then). A card whose
   * chats have all ended says so for `overHold`, then is ended, and its final state stays a few
   * minutes; one with no chat left to show is ended at once. On the card for all Botkins, the first
   * update that shows a new request, or that every chat has ended, carries an alert (the island
   * opens, the sound plays); the request's notification is then not sent, and a finished turn's
   * comes without a sound. Held notifications the card doesn't answer for are sent as they are.
   *
   * The sound for the end is the card's own. It doesn't wait on the turn's notification, which is
   * left out when the person is reading the chat on the computer: `ended` names the chats whose
   * turn ended at this look, and the card stays quiet only when none of them is on it (a card found
   * over), when finished replies are switched off, or when the app is in front on that phone.
   */
  cards(sends, targets, state, ended = new Set()) {
    const now = this.now();
    let next = null;
    const later = (at) => (next = next == null ? at : Math.min(next, at));
    for (const device of targets) {
      const record = this.store.push(device.id);
      const chimes = this.chimes.get(device.id);
      this.chimes.delete(device.id);
      if ((record?.cards !== "bots" && record?.cards !== "all") || !record.prefs.activities) {
        for (const held of chimes?.values() ?? []) sends.push(held.alert);
        continue;
      }
      const visible = (chat) => this.maySeeChat(device, chat);
      const look = (botId) => (state.bots ?? []).find((bot) => bot.id === botId)?.look ?? this.store.data.looks?.[botId];
      const prefix = device.id + ":";
      // A phone that moved to the card for all Botkins has its Botkins' cards ended.
      if (record.cards === "all") for (const key of Object.keys(record.activities ?? {})) if (key.startsWith("bot:")) this.endActivity(device.id, key);
      const ours = (key) => (record.cards === "all" ? key === ALL_CARD : key.startsWith("bot:"));
      const keys = new Set([...Object.keys(record.activities ?? {}), ...[...this.started].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))].filter(ours));
      for (const cardKey of keys) {
        const key = prefix + cardKey;
        const token = record.activities?.[cardKey];
        const card = botCard(state, cardKey === ALL_CARD ? null : cardKey.slice(4), { previews: record.prefs.previews, now, visible, look });
        if (card?.expires != null) later(card.expires + 100);
        if (!token) {
          // A push started this card and the phone hasn't said where its updates go (the app was
          // closed). Once every chat on it has ended, the app is woken for a moment: it brings the
          // card up to date itself and tells this computer the card's address.
          if (this.started.has(key) && (!card || cardOver(card.state))) {
            this.started.delete(key);
            sends.push({ token: record.token, env: record.env, type: "background", priority: 5, expiration: 600, payload: { aps: { "content-available": 1 }, w: 1 } });
          }
          continue;
        }
        if (!card) {
          this.endActivity(device.id, cardKey);
          continue;
        }
        const text = JSON.stringify([card.state, card.detail]);
        const last = this.sent.get(key);
        const over = cardOver(card.state);
        const content = () => {
          const sealed = card.detail ? this.seal(device.id, card.detail, CARD_AAD) : null;
          return { ...card.state, ...(sealed && { sealed }) };
        };
        if (over) {
          const end = () => {
            sends.push(this.activity(record, token, "end", content(), { urgent: true, relevance: card.relevance }));
            this.setActivity(device.id, cardKey, null);
          };
          // Over since this look, or since before this computer knew the card (it just started, or
          // the card's address came after a short turn): it shows so for a while first.
          if (last?.overAt == null) {
            // Every chat on it has just ended: the card for all Botkins says so with its alert, and
            // a finished turn's notification then comes without a second sound.
            const rings = cardKey === ALL_CARD && card.state.chats.some((chat) => ended.has(chat.id)) && this.wants(device, "replies") && !this.present(device.id);
            const finished = cardKey === ALL_CARD ? card.state.chats.filter((chat) => chimes?.get(chat.id)?.kind === "finish") : [];
            for (const chat of finished) {
              const { alert } = chimes.get(chat.id);
              if (rings) delete alert.payload.aps.sound;
              sends.push(alert);
              chimes.delete(chat.id);
            }
            const alert = rings ? { title: "Botkins", body: card.state.chats.some((chat) => chat.phase === "failed") ? "A chat stopped" : "All done" } : undefined;
            const shown = content();
            this.sent.set(key, { at: now, text, state: shown, marks: "", over: true, overAt: now });
            sends.push(this.activity(record, token, "update", shown, { urgent: true, relevance: card.relevance, alert, staleIn: Math.ceil(this.overHold / 1000) + 600 }));
            later(now + this.overHold + 50);
            continue;
          }
          if (now - last.overAt >= this.overHold) {
            end();
            continue;
          }
          later(last.overAt + this.overHold + 50);
          if (last.text === text) continue;
          const shown = content();
          this.sent.set(key, { ...last, at: now, text, state: shown });
          sends.push(this.activity(record, token, "update", shown, { relevance: card.relevance, staleIn: Math.ceil(this.overHold / 1000) + 600 }));
          continue;
        }
        if (last?.text === text) continue;
        const marks = card.state.chats
          .filter((chat) => chat.phase === "needs-you" || chat.phase === "done" || chat.phase === "failed")
          .map((chat) => chat.id + ":" + chat.phase)
          .join();
        // A card that said done and has a new turn to show changes at once.
        // So does one the phone drew while it was in front (setPresence emptied its text).
        const asking = cardKey === ALL_CARD ? card.state.chats.filter((chat) => chat.phase === "needs-you" && chimes?.get(chat.id)?.kind === "request") : [];
        const urgent = !last || marks !== last.marks || last.over === true || last.text === "" || asking.length > 0;
        if (!urgent) {
          if (this.present(device.id)) continue;
          const wait = ACTIVITY_GAP_MS - (now - (last?.at ?? 0));
          if (wait > 0) {
            later(now + wait + 50);
            continue;
          }
        }
        for (const chat of asking) chimes.delete(chat.id);
        const alert = asking.length ? { title: "Botkins", body: asking.length > 1 ? asking.length + " bots need you" : "A bot needs you" } : undefined;
        const shown = content();
        this.sent.set(key, { at: now, text, state: shown, marks, over: false });
        sends.push(this.activity(record, token, "update", shown, { urgent, relevance: card.relevance, alert }));
      }
      // A notification the card didn't make its sound for (a request it has no room for, a turn
      // that ended while others still work) is sent as it is.
      for (const held of chimes?.values() ?? []) sends.push(held.alert);
    }
    // Nothing else may change before then: look again when a chat drops off, or a held-back update is due.
    if (next != null) this.scheduleCardLook(next, now);
  }

  scheduleCardLook(next, now) {
    if (!this.cardTimer || next < this.cardAt) {
      clearTimeout(this.cardTimer);
      this.cardAt = next;
      this.cardTimer = setTimeout(() => {
        this.cardTimer = null;
        this.soon();
      }, Math.max(250, next - now));
      this.cardTimer.unref?.();
    }
  }

  /** A push the phone doesn't show: it wakes the app for a moment, so it can answer a bot's question to the phone. */
  wake(deviceId) {
    const record = this.store.push(deviceId);
    if (!record) return false;
    void this.send([{ token: record.token, env: record.env, type: "background", priority: 5, expiration: 60, payload: { aps: { "content-available": 1 }, w: 1 } }]);
    return true;
  }
  /** One notification, sealed, outside the app's own events (a bot is waiting on the phone, or a test). */
  notify(deviceId, content, options) {
    const record = this.store.push(deviceId);
    if (!record) return false;
    void this.send([this.alert(deviceId, record, content, options)]);
    return true;
  }
  /** A join request is shown only to owner devices, never to member devices. */
  teamJoin(request) {
    const content = { t: (request.person || request.name) + " wants to join your team", m: "Open Botkins to review this request.", k: "team", r: request.id };
    const sends = [];
    for (const device of this.store.data.devices) {
      if (device.memberId || !this.wants(device, "requests")) continue;
      const record = this.store.push(device.id);
      if (record) sends.push(this.alert(device.id, record, content, { urgent: true, expiration: 300 }));
    }
    if (sends.length) void this.send(sends);
  }
  /**
   * A newer Botkins is out for this computer ("app-update-v1"; docs/link-contract.md). The
   * computer's app calls this when it learns of one. Each owner device whose notifications and
   * `updates` choice are on gets one sealed alert for that version, titled with this computer's
   * name; a member device never does. Answers how many alerts it sent now (the relay may still
   * refuse one; that phone is told at a later call).
   */
  updateAvailable(version) {
    const named = String(version ?? "").replace(/^v/, "");
    if (!VERSION.test(named)) return 0;
    const content = { t: this.store.name || "Botkins", m: "Botkins " + named + " is available.", k: "update" };
    let told = 0;
    for (const device of this.store.data.devices) {
      if (device.memberId || !this.wants(device, "updates")) continue;
      const record = this.store.push(device.id);
      const sending = device.id + " " + named;
      if (!record || record.updateSeen === named || this.updating.has(sending)) continue;
      const item = this.alert(device.id, record, content, { expiration: 24 * 60 * 60, group: "update" });
      // Without a sealed body nothing is sent (see `send`), so it isn't counted.
      if (!item.payload.b) continue;
      this.updating.add(sending);
      told++;
      // The version is seen only once the relay has taken the alert for this phone: a send that
      // fails is tried again at the next check. Until then, a second call doesn't send it twice.
      void this.send([item])
        .then((results) => {
          if (results[0]?.status !== 200) return;
          const now = this.store.push(device.id);
          if (now?.token === record.token) this.store.setPush(device.id, { ...now, updateSeen: named });
        })
        .catch((error) => this.log("push: " + (error?.message ?? error)))
        .finally(() => this.updating.delete(sending));
    }
    return told;
  }
  /** Sends one notification and answers with what the relay said, so the phone's settings can show a failure. */
  async test(deviceId) {
    const record = this.store.push(deviceId);
    if (!record) throw new Failure("Turn notifications on first.");
    const results = await this.send([this.alert(deviceId, record, { t: "Botkins", m: "Notifications from " + this.store.name + " work.", k: "test" }, { expiration: 60 })], true);
    const status = results?.[0]?.status;
    if (status === 200) return;
    if (status === 410 || results?.[0]?.reason === "BadDeviceToken") throw new Failure("Apple no longer knows this phone. Turn notifications off and on again.");
    // Apple refused the relay's own key, not this phone: only whoever runs the relay can mend it.
    // (TopicDisallowed: the key may not send to this app. The two "environment" answers: the key is
    // for Apple's other service only. InvalidProviderToken: the key, its id or the team is wrong.)
    const reason = results?.[0]?.reason;
    if (["TopicDisallowed", "BadEnvironmentKeyInToken", "BadEnvironmentKeyIdInToken", "InvalidProviderToken", "ExpiredProviderToken"].includes(reason))
      throw new Failure("The relay's Apple push key can't send to Botkins (" + reason + "). The relay needs a key for this app.");
    throw new Failure("The notification could not be sent" + (reason ? " (" + reason + ")." : "."));
  }

  // ── Sending ─────────────────────────────────────────────────────────────────────────────────

  /** Sends items through the relay, eight at a time. With `loud`, throws what went wrong instead of logging it. */
  async send(items, loud = false) {
    const all = [];
    for (let at = 0; at < items.length; at += 8) {
      const batch = items.slice(at, at + 8).filter((item) => item.type !== "alert" || item.payload.b);
      if (!batch.length) continue;
      try {
        const results = await this.post(batch);
        all.push(...results);
        results.forEach((result, index) => {
          // The relay took it on Apple's other service: the phone named the wrong one. Remember the right one.
          if ((result?.env === "production" || result?.env === "sandbox") && result.env !== batch[index].env) this.fixEnv(batch[index].token, result.env);
          if (result?.status === 410 || (result?.status === 400 && result.reason === "BadDeviceToken")) this.dropToken(batch[index].token);
          else if (result?.status !== 200) this.log("push: Apple answered " + result?.status + (result?.reason ? " " + result.reason : ""));
        });
      } catch (error) {
        if (loud) throw error;
        this.log("push: " + (error?.message ?? error));
      }
    }
    return all;
  }

  async post(batch) {
    const key = this.store.relayKey();
    const time = Math.floor(this.now() / 1000);
    const sends = JSON.stringify(batch);
    const body = JSON.stringify({ v: 1, key: key.publicKey, time, sig: signWithRelayKey(key, "botkins-push-v1:" + time + ":" + sends), sends });
    let response;
    try {
      response = await this.fetch(String(this.relayUrl()).replace(/\/+$/, "") + "/v1/push", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    } catch {
      throw new Failure("The notification service can't be reached.");
    }
    if (response.status === 503) throw new Failure("The notification service isn't set up yet.");
    if (response.status === 429) throw new Failure("Too many notifications just now. Try again in a minute.");
    if (!response.ok) throw new Failure("The notification service refused that (" + response.status + ").");
    const answer = await response.json().catch(() => null);
    return Array.isArray(answer?.results) ? answer.results : [];
  }

  /** The phone that holds `token` is on `env`, whatever it said when it registered. */
  fixEnv(token, env) {
    for (const device of this.store.data.devices) {
      const record = this.store.push(device.id);
      if (!record || record.env === env) continue;
      if (record.token === token || record.start === token || Object.values(record.activities ?? {}).includes(token)) this.store.setPush(device.id, { ...record, env });
    }
  }

  /** Apple no longer delivers to this token: forget it wherever it is kept. */
  dropToken(token) {
    for (const device of this.store.data.devices) {
      const record = this.store.push(device.id);
      if (!record) continue;
      if (record.token === token) this.store.setPush(device.id, null);
      else if (record.start === token) this.store.setPush(device.id, { ...record, start: undefined });
      else {
        const chat = Object.keys(record.activities ?? {}).find((id) => record.activities[id] === token);
        if (chat) {
          const activities = { ...record.activities };
          delete activities[chat];
          this.store.setPush(device.id, { ...record, activities });
        }
      }
    }
    this.changed();
  }
}
