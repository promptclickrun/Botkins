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
// A Live Activity can't be sealed (Apple hands its state straight to the Lock Screen), so its state
// is small and plain: a phase, a step count, and a short label that is the step's name only when the
// phone has previews on.
//
// Nothing here throws into the caller. A failed send is logged and forgotten: a notification that
// is late is worse than one that is missing.
import { b64u, hkdf, random, seal } from "./crypto.mjs";
import { signWithRelayKey } from "./relay.mjs";
import { Failure } from "./tools.mjs";

export const PUSH_INFO = "botkins/push/v1";
export const PUSH_AAD = "botkins-push-v1";
/** `updates`: a newer Botkins for this computer is out ("app-update-v1"). A phone registered before it existed counts as wanting it. */
export const DEFAULT_PREFS = { replies: true, requests: true, routines: true, previews: true, activities: true, updates: true };
/** A version the computer may name in an update notice ("0.16.5", "1.0.0-beta.2"). */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
/** The Swift type the phone's Live Activity is declared with. Apple matches a push to it by this name. */
export const ACTIVITY_TYPE = "BotkinActivityAttributes";

const TOKEN = /^[0-9a-f]{64,200}$/;
const PRESENT_MS = 45_000; // a phone that said it is in front, and was heard from this recently, is looking at the app
const ACTIVITY_GAP_MS = 2_500; // the least time between two updates of one Live Activity
const ACTIVITY_STALE_S = 15 * 60;
// A finished turn's card stays on the phone, marked done, this long, unless a new turn in the chat
// takes it over first. Then it is ended. (The phone has the same time: LINGER_MS in src/state/activity.ts.)
export const ACTIVITY_LINGER_MS = 30 * 60_000;
const MAX_ACTIVITIES = 4; // Live Activity tokens kept for one phone
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
  return { token, env, ...(start && { start }) };
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
    this.store.setPush(deviceId, { ...clean, prefs: cleanPrefs(prefs, before?.prefs), activities: before?.activities ?? {}, ...(before?.updateSeen && { updateSeen: before.updateSeen }) });
    this.changed();
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
    // A turn may have moved on, or ended, while the phone was getting its token.
    if (token != null) this.catchUp(deviceId, chatId);
  }
  setPresence(deviceId, active, chatId) {
    this.front.set(deviceId, { active: active === true, chatId: typeof chatId === "string" ? chatId : undefined });
    this.seen.set(deviceId, this.now());
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
    const sends = [];

    if (!first && targets.length) {
      const chats = new Map((state.chats ?? []).map((chat) => [chat.id, chat]));
      const bots = new Map((state.bots ?? []).map((bot) => [bot.id, bot]));
      for (const request of requests) if (!this.asked.has(request.id)) this.onRequest(sends, targets, request, chats, bots);
      for (const run of runs) {
        const working = run.status === "Working";
        const was = before.get(run.id);
        if (working && was === undefined) this.onStart(sends, targets, state, run, chats, bots);
        else if (!working && was !== false) this.onFinish(sends, targets, state, run, chats, bots);
        // Turns still under way: their Live Activities follow along.
        else if (working) this.onProgress(sends, targets, state, run);
      }
    }
    this.working = known;
    this.asked = new Set(requests.map((request) => request.id));
    if (sends.length) void this.send(sends);
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
    if (!chat) return !device.memberId;
    const person = device.memberId ?? "owner";
    // Without the link's list of who was invited, a chat is its starter's alone.
    return this.people ? this.people(chat, person) : (chat.createdBy || "owner") === person;
  }

  onRequest(sends, targets, request, chats, bots) {
    const chat = chats.get(request.chatId);
    const bot = bots.get(request.botId ?? chat?.botId);
    const name = bot?.name ?? "A bot";
    // A secure input ("secure-input-v1") is named as what it is: its answer is typed into a prompt of
    // its own, never into the chat.
    const title = request.kind === "permission" ? name + " needs your approval" : request.kind === "secure" ? name + " needs a secure input" : name + " has a question";
    for (const device of targets) {
      // A request only the owner can answer (an approval, a secure input) goes to the owner's devices
      // whoever's chat it is: nobody else can unblock the bot. Any other goes to the chat's people.
      const ownerOnly = request.kind === "permission" || request.kind === "secure";
      if (ownerOnly ? !!device.memberId : !this.maySeeChat(device, chat)) continue;
      if (!this.wants(device, "requests") || this.present(device.id, request.chatId)) continue;
      const record = this.store.push(device.id);
      const text = record.prefs.previews ? firstLine(request.title) || "Open Botkins to answer." : "Open Botkins to answer.";
      sends.push(this.alert(device.id, record, { t: title, m: text, c: request.chatId, k: "request", r: request.id }, { urgent: true, expiration: 300 }));
    }
  }

  /** Whether a run that finished is worth a notification, and of which kind (the desktop's own rules). */
  kindOf(run, chat) {
    if (!chat || chat.temporary || run.status === "Stopped") return null;
    // A run that published nothing (a routine set to "No output", or one that reached the end with
    // no result to deliver) has nothing to tell: a notification would show an earlier run's words.
    // One that failed is still worth a look.
    if (run.status === "Completed" && run.noOutput === true) return null;
    const scheduled = run.scheduleId != null || run.trigger === "scheduled";
    const failed = run.status !== "Completed";
    if (run.panelId) return scheduled && failed ? "routines" : null;
    if (scheduled) {
      const entry = (chat.schedules ?? []).find((schedule) => schedule.id === run.scheduleId);
      // A routine the person made quiet says nothing, here or on the computer.
      return entry?.notify === false ? null : "routines";
    }
    return "replies";
  }

  onFinish(sends, targets, state, run, chats, bots) {
    const chat = chats.get(run.chatId);
    const kind = this.kindOf(run, chat);
    // Text written on the way ("turn-timeline-v1": `interim`) is not the reply.
    const reply = [...(chat?.messages ?? [])].reverse().find((message) => message.runId === run.id && message.role !== "user" && !message.interim);
    const bot = bots.get(reply?.botId ?? chat?.botId);
    const name = bot?.name ?? "Botkins";
    const failed = run.status !== "Completed";
    const watching = this.attention?.();
    for (const device of targets) {
      if (!this.maySeeChat(device, chat)) continue;
      const record = this.store.push(device.id);
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
      if (!kind || !this.wants(device, kind) || this.present(device.id, run.delivery?.chatId ?? run.chatId)) continue;
      // An alert opens the chat a result was delivered to: it goes only to someone who is in that chat.
      if (run.delivery?.chatId && run.delivery.chatId !== run.chatId && !this.maySeeChat(device, chats.get(run.delivery.chatId))) continue;
      // The person is reading this chat on the computer itself: a reply there needs no second ping.
      if (kind === "replies" && watching?.focused && (watching.chatId === undefined || watching.chatId === run.chatId)) continue;
      const title = kind === "routines" ? run.title || name : chat?.title && !/^new chat$/i.test(chat.title) ? name + " · " + chat.title : name;
      const said = failed ? (run.status === "Failed" ? "Failed" : run.status) + (run.detail ? ": " + firstLine(run.detail) : "") : firstLine(reply?.text) || "Finished.";
      const text = record.prefs.previews ? said : failed ? "A run needs a look." : "New message";
      // A routine that sends its result to a chat is opened there, where the person reads it.
      sends.push(this.alert(device.id, record, { t: title.slice(0, 80), m: text, c: run.delivery?.chatId ?? run.chatId, k: kind === "routines" ? "routine" : "reply" }, { expiration: 900 }));
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
      const urgent = next.phase === "needs-you" || last?.over === true;
      // The phone shows the app's own state while it is in front; Apple also limits how often an activity may change.
      if (!urgent && (this.present(device.id) || this.now() - (last?.at ?? 0) < ACTIVITY_GAP_MS)) continue;
      this.sent.set(key, { at: this.now(), text });
      sends.push(this.activity(record, token, "update", next, { urgent }));
    }
  }

  // ── Building what is sent ───────────────────────────────────────────────────────────────────

  /** Seals `content` for one phone. Null when the phone is gone. */
  seal(deviceId, content) {
    const deviceKey = this.deviceKey(deviceId);
    if (!deviceKey) return null;
    const key = hkdf(deviceKey, Buffer.from(deviceId, "utf8"), PUSH_INFO);
    const nonce = random(12);
    return Buffer.concat([nonce, seal(key, nonce, Buffer.from(JSON.stringify(content), "utf8"), PUSH_AAD)]).toString("base64");
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
          alert: { title: "Botkins", body: content.k === "request" ? "A bot needs you" : content.k === "update" ? "An update is available" : "New message" },
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
  activity(record, token, event, state, { urgent = false, dismissIn, staleIn } = {}) {
    // Apple applies a card's pushes by their timestamp and drops one that isn't newer than the last.
    // Two pushes in the same second (the last "writing" and the "done") would lose the second one.
    const seconds = Math.max(Math.floor(this.now() / 1000), (this.stamps.get(token) ?? 0) + 1);
    this.stamps.delete(token);
    if (event !== "end") this.stamps.set(token, seconds);
    // The newest tokens are kept; a phone shows a few cards at most.
    for (const old of [...this.stamps.keys()].slice(0, -64)) this.stamps.delete(old);
    return {
      token,
      env: record.env,
      type: "liveactivity",
      priority: urgent ? 10 : 5,
      expiration: staleIn || event === "end" ? 3600 : 120,
      payload: {
        aps: {
          timestamp: seconds,
          event,
          "content-state": state,
          ...(event === "end" ? { "dismissal-date": seconds + (dismissIn ?? 240) } : { "stale-date": seconds + (staleIn ?? ACTIVITY_STALE_S) }),
        },
      },
    };
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
