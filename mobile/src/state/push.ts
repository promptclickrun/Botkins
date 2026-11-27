// Notifications and Live Activities on this phone.
//
// The computer sends them (link-host/push.mjs) through the relay's push route. This file is the
// phone's half: it asks iOS for permission and for the address Apple delivers to, tells the
// computer, keeps the key the notification extension opens sealed alerts with, says when the app
// is in front (so the computer stays quiet about the chat on screen), opens the right chat when a
// notification is tapped, and runs the Live Activities while the app is open: one for all Botkins on
// a computer that names "activity-all-v1", one per Botkin on one that names only "activity-bots-v1"
// (src/state/cards.ts, docs/live-cards.md), else one per chat. When a push wakes the app in the background, it answers what bots asked the phone
// (src/state/device.ts) and sends answers given on a card or a notification (src/state/answers.ts).
import * as Application from "expo-application";
import { type Href, router } from "expo-router";
import { spaceRoute } from "@/features/spaces/logic";
import { keep, readKept } from "@/state/keep";
import { AppState, Platform } from "react-native";
import { create } from "zustand";
import { Activities } from "../../modules/botkins-activity";
import { lookOf } from "@/data/botLook";
import { type Pairing, pushKeyOf } from "@/link/client";
import type { ActivityState, PushPrefs, RunSummary } from "@/link/types";
import { activityView, LINGER_MS } from "./activity";
import { ACTIVITY_MIN_INTERVAL_MS, ACTIVITY_QUIET_MS, createCoalescedPacer } from "./activityPace";
import { sendAnswers, startAnswers } from "./answers";
import { ALL_CARD, cardOver } from "../../link-host/cards.mjs";
import { botsWithWork, hasWork, MAX_CARDS, phoneCard } from "./cards";
import { answerPendingAsks } from "./device";
import { api, attempt, callHost, chatOnScreen, isUnifiedActive, onChatOnScreen, pooledEntries, restIfAway, switchComputer, syncForPush, tellOthers } from "./link";
import { hostOfId, idForHost, unscopeId } from "./unified";
import { useApp } from "./store";
import { createRegistrar } from "./pushRegistrar";

const KEY = "botkins.push.v1";
const TASK = "botkins-push";

type Notifications = typeof import("expo-notifications");
type TaskManager = typeof import("expo-task-manager");
/** The native halves, or null in a build made before they were added. */
function load(): { Notifications: Notifications; TaskManager: TaskManager } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return { Notifications: require("expo-notifications") as Notifications, TaskManager: require("expo-task-manager") as TaskManager };
  } catch {
    return null;
  }
}
const native = Platform.OS === "ios" ? load() : null;

export type PushStatus = "off" | "on" | "denied" | "unsupported";
type PushStore = {
  /** The person turned notifications on for this phone. Kept on the phone, so a new pairing sets them up again. */
  wanted: boolean;
  status: PushStatus;
  /** One plain sentence when setting up failed. */
  problem: string | null;
};
export const usePush = create<PushStore>(() => ({ wanted: false, status: native ? "off" : "unsupported", problem: null }));

export const pushDefaults: PushPrefs = { replies: true, requests: true, routines: true, previews: true, activities: true, updates: true, spaces: true };
/** This phone's choices as the computer holds them, or null while notifications are off there. */
export function usePushPrefs(): PushPrefs | null {
  return useApp((state) => (state.pairing ? (state.parts.phones?.[state.pairing.deviceId]?.push ?? null) : null));
}

const canPush = () => !!useApp.getState().parts.meta?.capabilities.includes("push-v1");
/**
 * Which cards this phone asks for: one for all Botkins ("activity-all-v1"), one per Botkin
 * ("activity-bots-v1"), or null for one per chat. Each needs the computer to name it and this build to draw it.
 */
function cardMode(): "all" | "bots" | null {
  const capabilities = useApp.getState().parts.meta?.capabilities ?? [];
  if (capabilities.includes("activity-all-v1") && typeof Activities?.startAllCard === "function") return "all";
  if (capabilities.includes("activity-bots-v1") && typeof Activities?.startCard === "function") return "bots";
  return null;
}
/** How long a card whose chats have all ended stays on the Lock Screen, in seconds (the computer's end push says the same). */
const OVER_SECONDS = 240;
const base64 = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

/** `work`, or a failure with `message` when it has not settled in `ms`. Apple's registration can stay silent with no network. */
function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let startToken: string | undefined;

/**
 * Tells the computer where Apple delivers for this phone. Quiet when nothing changed. A token that
 * arrives through the push token listener is passed in as `given`: asking iOS for it again would
 * fire that listener again (src/state/pushRegistrar.ts has why).
 */
const registrar = createRegistrar({
  async prepare() {
    const { pairing, pairings, link, parts } = useApp.getState();
    // A computer that still holds this phone's address after notifications were turned off (the phone
    // was using another computer then) is told now.
    if (native && pairing && link === "online" && canPush() && !usePush.getState().wanted && parts.phones?.[pairing.deviceId]?.push) {
      void api["link.push.unregister"]().catch(() => {});
      return false;
    }
    if (!native || !pairing || link !== "online" || !usePush.getState().wanted || !canPush()) return false;
    const permission = await native.Notifications.getPermissionsAsync();
    if (!permission.granted) {
      usePush.setState({ status: permission.canAskAgain ? "off" : "denied" });
      return false;
    }
    // The notification extension opens sealed alerts with these keys, one for each paired computer,
    // so an alert from a computer the phone is not using now opens too. Each is derived from its
    // pairing and never leaves the phone.
    await saveKeys(pairings);
    return true;
  },
  async osToken() {
    const token = await within(native!.Notifications.getDevicePushTokenAsync(), 15_000, "Apple didn't give this phone an address for notifications. Check the connection and try again.");
    return token.type === "ios" && typeof token.data === "string" ? token.data : null;
  },
  async said(token) {
    const { pairing } = useApp.getState();
    const pooled = isUnifiedActive()
      ? pooledEntries()
          .filter((e) => e.link === "online" && e.parts.meta?.capabilities.includes("push-v1"))
          .map((e) => e.pairing.serverId)
          .sort()
          .join(",")
      : "";
    return [pairing?.serverId, pairing?.deviceId, pooled, token, await pushEnv(), startToken ?? "", cardMode()].join();
  },
  async send(token) {
    const cards = cardMode();
    const payload = { token, env: await pushEnv(), ...(startToken && { start: startToken }), ...(cards && { cards }) };
    if (isUnifiedActive()) {
      const online = pooledEntries().filter((e) => e.link === "online" && e.parts.meta?.capabilities.includes("push-v1"));
      await Promise.all(online.map((e) => callHost(e.pairing.serverId, "link.push.register", payload)));
      return;
    }
    await api["link.push.register"](payload);
  },
  sent() {
    usePush.setState({ status: "on", problem: null });
    tellPresence();
  },
  failed(error) {
    usePush.setState({ problem: error instanceof Error ? error.message : "Notifications could not be set up." });
  },
});

// Only a development build can say it is on Apple's test service: its signing profile says
// "development". A build from TestFlight or the App Store carries no profile to read (the answer
// is null) and is always on production.
async function pushEnv(): Promise<"sandbox" | "production"> {
  return (await Application.getIosPushNotificationServiceEnvironmentAsync()) === "development" ? "sandbox" : "production";
}

function register(force = false, given?: string) {
  return registrar.register(force, given);
}

/** Turns notifications on: asks iOS when it has to, then tells the computer. Resolves to how it went. */
export async function enablePush(): Promise<PushStatus> {
  if (!native) return "unsupported";
  let permission = await native.Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await native.Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
  if (!permission.granted) {
    usePush.setState({ status: "denied" });
    return "denied";
  }
  usePush.setState({ wanted: true, problem: null });
  void keep(KEY, JSON.stringify({ wanted: true })).catch(() => {});
  await register(true);
  return usePush.getState().status;
}

export async function disablePush() {
  usePush.setState({ wanted: false, status: native ? "off" : "unsupported", problem: null });
  registrar.reset();
  void keep(KEY, JSON.stringify({ wanted: false })).catch(() => {});
  await saveKeys([]).catch(() => {});
  if (useApp.getState().link === "online") await api["link.push.unregister"]().catch(() => {});
  // Every other paired computer has this phone's address too.
  void tellOthers("link.push.unregister");
}

/** Keeps one key for each paired computer where the notification extension can read them (none removes them all). */
async function saveKeys(pairings: Pairing[]) {
  if (!Activities) return;
  if (typeof Activities.setPushKeys === "function") await Activities.setPushKeys(pairings.map((pairing) => ({ host: pairing.serverId, key: base64(pushKeyOf(pairing)) })));
  // A build from before several computers keeps one key: the one of the computer in use.
  else await Activities.setPushKey(pairings.length ? base64(pushKeyOf(useApp.getState().pairing ?? pairings[0]!)) : null);
}

// ── Presence: the computer says nothing about a chat that is on screen ──────────────────────────

let presence = "";
function tellPresence() {
  if (useApp.getState().link !== "online" || !usePush.getState().wanted || !canPush()) return;
  const active = AppState.currentState === "active";
  const chatId = active ? chatOnScreen() : undefined;
  if (isUnifiedActive()) {
    const primaryId = useApp.getState().pairing?.serverId ?? null;
    const online = pooledEntries().filter((e) => e.link === "online" && e.parts.meta?.capabilities.includes("push-v1"));
    const now = active + ":" + (chatId ?? "") + ":" + online.map((e) => e.pairing.serverId).join(",");
    if (now === presence) return;
    presence = now;
    const chatHost = chatId ? hostOfId(chatId, primaryId) : null;
    for (const entry of online) {
      const rawChat = chatId && chatHost === entry.pairing.serverId ? unscopeId(chatId) : undefined;
      void callHost(entry.pairing.serverId, "link.push.presence", active, rawChat).catch(() => {
        presence = "";
      });
    }
    return;
  }
  const now = active + ":" + (chatId ?? "");
  if (now === presence) return;
  presence = now;
  void api["link.push.presence"](active, chatId).catch(() => {
    presence = "";
  });
}

// ── Opening the chat a notification is about ────────────────────────────────────────────────────

function chatOf(response: import("expo-notifications").NotificationResponse): string | undefined {
  const request = response.notification.request;
  const payload = request.trigger && "payload" in request.trigger ? (request.trigger.payload as Record<string, unknown> | undefined) : undefined;
  const id = payload?.chatId ?? (request.content.data as Record<string, unknown> | undefined)?.chatId;
  return typeof id === "string" && id ? id : undefined;
}
/** The computer an alert came from, as the notification extension found out by which key opened it. */
function hostOf(response: import("expo-notifications").NotificationResponse): string | undefined {
  const request = response.notification.request;
  const payload = request.trigger && "payload" in request.trigger ? (request.trigger.payload as Record<string, unknown> | undefined) : undefined;
  const host = payload?.host ?? (request.content.data as Record<string, unknown> | undefined)?.host;
  return typeof host === "string" && host ? host : undefined;
}
/** The space an alert is about ("space-alerts-v1"), and the panel when it is about one. */
function spaceOf(response: import("expo-notifications").NotificationResponse): { spaceId?: string; panelId?: string } {
  const request = response.notification.request;
  const payload = request.trigger && "payload" in request.trigger ? (request.trigger.payload as Record<string, unknown> | undefined) : undefined;
  const data = request.content.data as Record<string, unknown> | undefined;
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return { spaceId: text(payload?.spaceId ?? data?.spaceId), panelId: text(payload?.panelId ?? data?.panelId) };
}
function kindOf(response: import("expo-notifications").NotificationResponse): string | undefined {
  const request = response.notification.request;
  const payload = request.trigger && "payload" in request.trigger ? (request.trigger.payload as Record<string, unknown> | undefined) : undefined;
  const kind = payload?.kind ?? (request.content.data as Record<string, unknown> | undefined)?.kind;
  if (typeof kind === "string" && kind) return kind;
  return request.content.categoryIdentifier === "botkins_team" ? "team" : undefined;
}
/** A proactive alert that offers something ("proactive-team-v1"): the bot and the run its notification names, for "Take care of it". */
function alertOf(response: import("expo-notifications").NotificationResponse): { bot: string; run: string } | undefined {
  const request = response.notification.request;
  const payload = request.trigger && "payload" in request.trigger ? (request.trigger.payload as Record<string, unknown> | undefined) : undefined;
  const data = request.content.data as Record<string, unknown> | undefined;
  const bot = payload?.alertBot ?? data?.alertBot;
  const run = payload?.alertRun ?? data?.alertRun;
  return typeof bot === "string" && bot && typeof run === "string" && run ? { bot, run } : undefined;
}
/**
 * "Take care of it" on an alert's notification: the computer is asked once the link is up. The chat opens
 * meanwhile, and the new work chat opens when the computer accepts.
 */
function takeAlert(alert: { bot: string; run: string }, serverId?: string) {
  const send = async () => {
    const answer = await attempt(api.proactiveAct(alert.bot, alert.run, "take"));
    if (answer?.chatId && serverId === useApp.getState().pairing?.serverId && chatOnScreen() !== answer.chatId)
      router.push({ pathname: "/chat/[id]", params: { id: answer.chatId } });
  };
  const ready = (state: ReturnType<typeof useApp.getState>) => state.link === "online" && state.pairing?.serverId === serverId;
  if (ready(useApp.getState())) return void send();
  const timer = setTimeout(() => stop(), 20_000);
  const stop = useApp.subscribe((state) => {
    if (!ready(state)) return;
    stop();
    clearTimeout(timer);
    void send();
  });
}
/** A notification's actions that answer a bot where they are (the native side queues them; src/state/answers.ts sends them). */
const ANSWERED_THERE = /^(approve|remember|deny|reply|choice\.\d)$/;
function openFrom(response: import("expo-notifications").NotificationResponse | null) {
  if (!response || !native) return;
  const chatId = chatOf(response);
  const host = hostOf(response);
  const kind = kindOf(response);
  native.Notifications.clearLastNotificationResponse();
  if (ANSWERED_THERE.test(response.actionIdentifier)) return;
  // "Allow once" on a risky approval opens the app: it asks for Face ID before it answers.
  if (response.actionIdentifier === "approve.risky") {
    const request = (response.notification.request.content.data as Record<string, unknown> | undefined)?.requestId;
    if (typeof request === "string" && chatId) router.push({ pathname: "/open/answer", params: { request, chat: chatId, ...(host && { host }) } });
    return;
  }
  const about = spaceOf(response);
  if (!chatId && kind !== "team" && kind !== "update" && kind !== "space") return;
  // The app may still be starting: the chat opens once the pairing is read. An alert from another
  // paired computer makes the phone use that computer first.
  const go = () => {
    const state = useApp.getState();
    const primaryId = state.pairing?.serverId ?? null;
    const inUnifiedPool = !!state.unified && !!host && state.unifiedHosts.some((h) => h.id === host && h.included);
    const other = !inUnifiedPool && !!host && host !== primaryId && state.pairings.some((pairing) => pairing.serverId === host);
    if (other) void switchComputer(host);
    const scope = (raw: string) => (inUnifiedPool && host ? idForHost(host, raw, primaryId) : raw);
    if (kind === "team") {
      router.push({ pathname: "/settings/team", params: { section: "requests" } });
      return;
    }
    // "A newer Botkins is out" ("app-update-v1"): the computer's page, where it is installed.
    if (kind === "update") {
      router.push("/settings/desktop");
      return;
    }
    // A note or a change in a space: the panel it is about, else the space, else (several spaces changed) the list.
    if (kind === "space") {
      router.push(spaceRoute(about.spaceId ? scope(about.spaceId) : undefined, about.panelId ? scope(about.panelId) : undefined) as unknown as Href);
      return;
    }
    if (!chatId) return;
    const targetChatId = scope(chatId);
    // The button on a proactive alert: the bot starts on what it offered, in the chat that opens.
    const offered = response.actionIdentifier === "alert.take" ? alertOf(response) : undefined;
    if (offered) {
      takeAlert(
        inUnifiedPool && host ? { bot: scope(offered.bot), run: scope(offered.run) } : offered,
        inUnifiedPool ? primaryId ?? undefined : other ? host : primaryId ?? undefined,
      );
    }
    if (chatOnScreen() === targetChatId) return;
    router.push({ pathname: "/chat/[id]", params: { id: targetChatId } });
  };
  if (useApp.getState().booted && useApp.getState().pairing) go();
  else {
    const stop = useApp.subscribe((state) => {
      if (!state.booted) return;
      stop();
      if (state.pairing) go();
    });
  }
}

// ── Live Activities while the app is open ───────────────────────────────────────────────────────

/** What a chat's activity shows, from what the phone knows (src/state/activity.ts has the rules). */
export function activityStateOf(chatId: string, previews: boolean, previous?: ActivityState): ActivityState {
  const { parts, running } = useApp.getState();
  const summary = parts.runs?.filter((run) => run.chatId === chatId).reduce<RunSummary | undefined>((latest, run) => (!latest || run.time > latest.time ? run : latest), undefined);
  return activityView({
    run: running[chatId],
    summary,
    active: !!parts.live?.active.includes(chatId),
    asked: !!parts.live?.requests.some((request) => request.chatId === chatId),
    streaming: !!parts.live?.streams[chatId],
    previews,
    previous,
    now: Date.now(),
  });
}

const shown = new Map<string, ActivityState | null>(); // chat id → what its card last showed (null: a card this app didn't draw yet)
const over = new Map<string, number>(); // chat id → when its turn was seen to be over; the card stays a while
// Apple delivers a card's updates to an address of its own. The computer needs it to change the
// card while the app is closed, so it is passed on, and passed on again until the computer has it.
const addresses = new Map<string, string>(); // chat id → the card's address
const told = new Map<string, string>(); // chat id → the address the computer was last told

function tellAddresses() {
  if (useApp.getState().link !== "online") return;
  for (const [chatId, token] of addresses) {
    if (told.get(chatId) === token) continue;
    told.set(chatId, token);
    // A call that fails is tried again the next time the computer is reached.
    void api["link.push.activity"](chatId, token).catch(() => told.get(chatId) === token && told.delete(chatId));
  }
}

/**
 * Asks the phone which cards it has: a push may have started one while the app was closed, and an
 * address may have come when nothing was listening. Their addresses go to the computer.
 */
async function syncActivities() {
  if (!Activities) return;
  try {
    // A card that ended by itself (Apple ends one after hours) would otherwise stay on the Lock
    // Screen. Only with the app in front: a card that just ended keeps its final state a few minutes,
    // and this also runs when a push wakes the app in the background.
    if (AppState.currentState === "active") await Activities.dismissEnded?.();
    for (const { chatId, token } of await Activities.tokens()) addresses.set(chatId, token);
    for (const chatId of await Activities.running()) if (!shown.has(chatId)) shown.set(chatId, null);
  } catch {
    // An older build of the native part: the events still bring the addresses.
  }
  tellAddresses();
  void followActivities();
}

function forgetActivity(chatId: string) {
  shown.delete(chatId);
  drawn.delete(chatId);
  over.delete(chatId);
  addresses.delete(chatId);
  told.delete(chatId);
  if (useApp.getState().link === "online") void api["link.push.activity"](chatId, null).catch(() => {});
}

const same = (a: ActivityState | null | undefined, b: ActivityState) => !!a && a.phase === b.phase && a.label === b.label && a.steps === b.steps && a.startedAt === b.startedAt && a.finishedAt === b.finishedAt;

async function followActivities() {
  if (!Activities || !usePush.getState().wanted) return;
  const { parts, running, pairing } = useApp.getState();
  const prefs = pairing ? parts.phones?.[pairing.deviceId]?.push : undefined;
  // Before the computer has said what is going on, nothing is known: a card is left as it is.
  if (!prefs?.activities || !parts.live || !useApp.getState().synced) return;
  const mode = cardMode();
  if (mode) return followCards(prefs.previews, mode);
  const active = new Set(parts.live.active ?? []);
  const front = AppState.currentState === "active";
  // A turn in the chat on screen gets a card; it goes on when the person leaves the app.
  const onScreen = chatOnScreen();
  if (front && onScreen && active.has(onScreen) && !shown.has(onScreen) && Activities.enabled()) {
    const chat = parts.chats?.find((item) => item.id === onScreen);
    const bot = parts.bots?.find((item) => item.id === chat?.botId);
    const run = running[onScreen];
    if (chat && bot && !chat.botIds && run?.status === "Working") {
      const look = lookOf(bot);
      const state = activityStateOf(onScreen, prefs.previews);
      shown.set(onScreen, state);
      try {
        await Activities.start({ chatId: onScreen, botId: bot.id, botName: bot.name, head: look.head, palette: look.palette, eyes: look.eyes ?? "oval", colors: look.colors ?? [] }, state);
      } catch {
        shown.delete(onScreen);
      }
    }
  }
  for (const chatId of [...shown.keys()]) {
    const state = activityStateOf(chatId, prefs.previews, shown.get(chatId) ?? undefined);
    if (!active.has(chatId)) {
      // The turn is over. The card says so (done, and how long it took) and stays: a new turn in
      // the chat takes it over, and after a while without one it goes.
      const since = over.get(chatId);
      if (since === undefined) over.set(chatId, Date.now());
      else if (Date.now() - since > LINGER_MS) {
        void Activities.end(chatId, null, 0).catch(() => {});
        forgetActivity(chatId);
        continue;
      }
    } else over.delete(chatId);
    if (same(shown.get(chatId), state)) continue;
    shown.set(chatId, state);
    void Activities.update(chatId, state).catch(() => {});
  }
}

// ── One card for all Botkins ("activity-all-v1"), or one per Botkin ("activity-bots-v1") ──────────

const drawn = new Map<string, string>(); // card key → what it last showed, as JSON

/**
 * While the app is in front, the phone draws the cards itself (the computer holds back then, and
 * takes over the moment the app leaves: the phone knows a turn's steps only for the chat on screen).
 * With one card for all Botkins it starts that card while something is at work; with one per
 * Botkin, a card for each Botkin at work. It brings each up to date, and ends a card with nothing
 * left on it. A card whose chats have all ended is left to the computer, which shows it done for a
 * minute and then ends it; one found already over when the app opens (left from before) is ended at
 * once. Any other card (a chat's, or a Botkin's from before the card for all) is ended once its
 * turn is over, or at once when there is a card for all.
 */
async function followCards(previews: boolean, mode: "all" | "bots") {
  if (!Activities?.updateCard || !Activities.endCard || AppState.currentState !== "active") return;
  const state = useApp.getState();
  const known = { parts: state.parts, running: state.running, texts: state.texts };
  const host = state.pairing?.serverId ?? null;
  const active = new Set(state.parts.live?.active ?? []);
  const look = (botId: string) => {
    const bot = state.parts.bots?.find((item) => item.id === botId);
    return bot ? lookOf(bot) : undefined;
  };
  const cardOf = (key: string) => phoneCard(known, key === ALL_CARD ? null : key.slice(4), previews, Date.now(), key === ALL_CARD ? look : undefined);
  if (AppState.currentState === "active" && Activities.enabled()) {
    if (mode === "all") {
      const card = !shown.has(ALL_CARD) && hasWork(known) ? cardOf(ALL_CARD) : null;
      if (card && Activities.startAllCard) {
        shown.set(ALL_CARD, null);
        drawn.set(ALL_CARD, JSON.stringify([card.state, card.detail]));
        try {
          await Activities.startAllCard(JSON.stringify(card.state), card.detail && JSON.stringify(card.detail), host, card.relevance);
        } catch {
          shown.delete(ALL_CARD);
          drawn.delete(ALL_CARD);
        }
      }
    } else {
      for (const botId of botsWithWork(known)) {
        const key = "bot:" + botId;
        if (shown.has(key) || [...shown.keys()].filter((item) => item.startsWith("bot:")).length >= MAX_CARDS) continue;
        const bot = state.parts.bots?.find((item) => item.id === botId);
        const card = bot && phoneCard(known, botId, previews);
        if (!bot || !card || !Activities.startCard) continue;
        const face = lookOf(bot);
        shown.set(key, null);
        drawn.set(key, JSON.stringify([card.state, card.detail]));
        try {
          await Activities.startCard({ botId, botName: bot.name, head: face.head, palette: face.palette, eyes: face.eyes ?? "oval", colors: face.colors ?? [] }, JSON.stringify(card.state), card.detail && JSON.stringify(card.detail), host, card.relevance);
        } catch {
          shown.delete(key);
          drawn.delete(key);
        }
      }
    }
  }
  for (const key of [...shown.keys()]) {
    const ours = mode === "all" ? key === ALL_CARD : key.startsWith("bot:");
    if (!ours) {
      if (key.startsWith("bot:") || key === ALL_CARD) {
        void Activities.endCard(key, 0).catch(() => {});
        forgetActivity(key);
      } else if (!active.has(key) || mode === "all") {
        void Activities.end(key, null, 0).catch(() => {});
        forgetActivity(key);
      }
      continue;
    }
    const card = cardOf(key);
    if (!card) {
      void Activities.endCard(key, 0).catch(() => {});
      forgetActivity(key);
      continue;
    }
    const text = JSON.stringify([card.state, card.detail]);
    // A card this app never drew (it was there when the app opened) whose chats have all ended.
    if (!drawn.has(key) && cardOver(card.state)) {
      void Activities.endCard(key, OVER_SECONDS).catch(() => {});
      forgetActivity(key);
      continue;
    }
    if (drawn.get(key) === text) continue;
    drawn.set(key, text);
    await Activities.updateCard(key, JSON.stringify(card.state), card.detail && JSON.stringify(card.detail), host, card.relevance).catch(() => {});
  }
}

// ── Answering on a notification ─────────────────────────────────────────────────────────────────

/**
 * The buttons a request's notification can have (docs/live-cards.md, section 6). The notification
 * extension picks the category from what it opened; the content extension (targets/notify-ui) adds
 * a question's choices. Each answer needs the phone unlocked; a risky approval opens the app.
 */
async function setCategories() {
  if (!native) return;
  const { Notifications } = native;
  const answer = { opensAppToForeground: false, isAuthenticationRequired: true };
  const open = { opensAppToForeground: true };
  const reply = { identifier: "reply", buttonTitle: "Reply…", textInput: { submitButtonTitle: "Send", placeholder: "Your answer" }, options: answer };
  try {
    await Promise.all([
      Notifications.setNotificationCategoryAsync("botkins_approve", [
        { identifier: "approve", buttonTitle: "Allow once", options: answer },
        { identifier: "remember", buttonTitle: "Allow for this chat", options: answer },
        { identifier: "deny", buttonTitle: "Deny", options: { ...answer, isDestructive: true } },
      ]),
      Notifications.setNotificationCategoryAsync("botkins_approve_once", [
        { identifier: "approve", buttonTitle: "Allow once", options: answer },
        { identifier: "deny", buttonTitle: "Deny", options: { ...answer, isDestructive: true } },
      ]),
      Notifications.setNotificationCategoryAsync("botkins_approve_risky", [
        { identifier: "approve.risky", buttonTitle: "Allow once", options: { ...open, isAuthenticationRequired: true } },
        { identifier: "deny", buttonTitle: "Deny", options: { ...answer, isDestructive: true } },
      ]),
      Notifications.setNotificationCategoryAsync("botkins_question", [reply, { identifier: "open", buttonTitle: "Open chat", options: open }]),
      Notifications.setNotificationCategoryAsync("botkins_open", [{ identifier: "open", buttonTitle: "Open to answer", options: open }]),
      // A proactive alert that offers to take care of something ("proactive-team-v1"). The button opens the app, which asks the
      // computer; "Not now" is on the alert itself. A tap on the notification opens the alert.
      Notifications.setNotificationCategoryAsync("botkins_alert", [{ identifier: "alert.take", buttonTitle: "Take care of it", options: { ...open, isAuthenticationRequired: true } }]),
    ]);
  } catch {
    // Notifications still arrive; they only open the app.
  }
}

// ── Starting up ─────────────────────────────────────────────────────────────────────────────────

if (native) {
  // A push that wakes the app without showing anything: a bot asked this phone something.
  try {
    native.TaskManager.defineTask(TASK, async () => {
      // Woken in the background, the link is at rest (or the app was just started): follow until one
      // sync has come back, so what follows reads the computer's state now, not what was held before.
      try {
        await syncForPush(20_000);
        // The same wake brings a chat's card up to date (a turn ended while the app was closed) and
        // tells the computer the card's address, so it can change the card itself from then on.
        await syncActivities().catch(() => {});
        await sendAnswers();
        const answered = await answerPendingAsks().catch(() => 0);
        return answered > 0 ? native.Notifications.BackgroundNotificationTaskResult.NewData : native.Notifications.BackgroundNotificationTaskResult.NoData;
      } finally {
        // Back to rest: a phone in the background does no work for the link.
        restIfAway();
      }
    });
  } catch {
    // A task can be defined once; a reload defines it again.
  }
}

let started = false;
/** Called once when the app starts, after the saved pairing is read. */
export async function startPush() {
  if (started || !native) return;
  started = true;
  const { Notifications } = native;
  try {
    const saved = await readKept(KEY);
    if (saved && (JSON.parse(saved) as { wanted?: boolean }).wanted) usePush.setState({ wanted: true });
  } catch {
    // Unreadable: notifications stay off until the person turns them on.
  }

  // In front, the banner shows for other chats; the chat on screen already shows what arrived.
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const request = notification.request;
      const payload = request.trigger && "payload" in request.trigger ? (request.trigger.payload as Record<string, unknown> | undefined) : undefined;
      const state = useApp.getState();
      const primaryId = state.pairing?.serverId ?? null;
      const host = typeof payload?.host === "string" ? payload.host : undefined;
      const rawChat = typeof payload?.chatId === "string" ? payload.chatId : undefined;
      const screen = chatOnScreen();
      // In unified mode a remote computer's chat may be the one currently open on screen.
      const here =
        !!rawChat &&
        !!screen &&
        (state.unified && host
          ? idForHost(host, rawChat, primaryId) === screen
          : (!host || host === primaryId) && rawChat === screen);
      return { shouldShowBanner: !here, shouldShowList: !here, shouldPlaySound: !here, shouldSetBadge: false };
    },
  });
  Notifications.addNotificationResponseReceivedListener(openFrom);
  openFrom(Notifications.getLastNotificationResponse());
  void setCategories();
  startAnswers();
  // iOS hands over the token here, also as the answer to our own request for it. It is used as
  // given; asking for it again from here would fire this listener again, in a loop.
  Notifications.addPushTokenListener((token) => {
    if (token.type === "ios" && typeof token.data === "string") void register(false, token.data);
  });
  void Notifications.registerTaskAsync(TASK).catch(() => {});

  Activities?.addListener("token", ({ chatId, token }) => {
    addresses.set(chatId, token);
    if (!shown.has(chatId)) shown.set(chatId, null);
    tellAddresses();
  });
  Activities?.addListener("startToken", ({ token }) => {
    startToken = token;
    void register(true);
  });
  Activities?.addListener("ended", ({ chatId }) => forgetActivity(chatId));
  void syncActivities();

  const activityPacer = createCoalescedPacer({
    quietMs: ACTIVITY_QUIET_MS,
    minIntervalMs: ACTIVITY_MIN_INTERVAL_MS,
    // The first change after a quiet spell (a turn starting) goes at once, so the card starts
    // before the person can lock the phone; the updates that follow are paced.
    leading: true,
    run: () => void followActivities(),
  });

  let link = useApp.getState().link;
  let meta = useApp.getState().parts.meta;
  let pairings = useApp.getState().pairings;
  let unifiedSig = "";
  useApp.subscribe((state, before) => {
    if (state.parts === before.parts && state.texts !== before.texts && state.running === before.running && state.chats === before.chats && state.unifiedHosts === before.unifiedHosts) return;
    // A computer was paired or unpaired: the keys follow, so an unpaired computer's key is gone at once.
    if (state.pairings !== pairings) {
      pairings = state.pairings;
      if (usePush.getState().wanted) void saveKeys(pairings).catch(() => {});
    }
    const nextUnifiedSig = state.unified
      ? state.unifiedHosts
          .filter((h) => h.included)
          .map((h) => h.id + ":" + h.state)
          .join(",")
      : "";
    // The computer says what it can do in its first answer, a moment after the link is up.
    if (state.link !== link || state.parts.meta !== meta || nextUnifiedSig !== unifiedSig) {
      const came = state.link === "online" && link !== "online";
      const poolChanged = nextUnifiedSig !== unifiedSig;
      link = state.link;
      meta = state.parts.meta;
      unifiedSig = nextUnifiedSig;
      if (link === "online") {
        if (came || poolChanged) {
          presence = "";
          if (came) {
            // The computer may have restarted, or never got an address: every card's is passed on again.
            told.clear();
            void syncActivities();
            void sendAnswers();
          }
          if (poolChanged && usePush.getState().wanted) void register(false);
        }
        void register();
        tellPresence();
      }
    }
    // In the background (a push woke the app to sync) no foreground comes to run it: follow now.
    if (AppState.currentState === "active") activityPacer.schedule();
    else activityPacer.flushNow();
  });
  AppState.addEventListener("change", (next) => {
    tellPresence();
    if (next === "active") {
      void syncActivities();
      void sendAnswers();
    } else {
      activityPacer.flushNow();
    }
  });
  onChatOnScreen(() => {
    tellPresence();
    activityPacer.flushNow();
  });
  void register();
}
