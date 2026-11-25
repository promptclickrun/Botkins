// The app's one link to the computer in use: pairing, the saved pairings, calls, and the watched
// chats. A phone can be paired with several computers (src/state/computers.ts has the list's logic);
// it follows one at a time, and the others stay paired.
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { fetch as expoFetch } from "expo/fetch";
import { forget, keep, readKept } from "@/state/keep";
import * as Network from "expo-network";
import { AppState, Platform } from "react-native";
import { checkJoin, findHost, findInvite, type FetchLike, type JoinAttempt, type JoinTarget, LinkClient, LinkError, pair, type PairDevice, type Pairing, startJoin } from "@/link/client";
import { setRandomSource } from "@/link/crypto";
import type { PairTarget } from "@/link/pairing";
import type { ProfileHost } from "@/link/profile";
import { relayFetch } from "@/link/relay";
import type { Calls, ChatDetail, ScreenFrame, ScreenInput } from "@/link/types";
import { textMode, useChatPrefs } from "./chatPrefs";
import { loadPrefs } from "./prefs";
import { newPresenceKey, removePresenceKey } from "./presence";
import { currentOf, hasRoom, indexOf, type Kept, NO_COMPUTERS, pairingKey, readKeptComputers, savedIds, tidy, TOO_MANY, using, withDetails, withPairing, without } from "./computers";
import { applyParts, forgetComputer, mergeChat, onComputerChange, showToast, useApp } from "./store";
import { createPartsBatcher } from "./partsBatch";
import { canBrowse, NearbyPace } from "./reconnect";
import { findNearby } from "./nearby";

// One pairing, as versions before several computers saved it. It is read once and moved to the list.
const LEGACY_KEY = "botkins.pairing.v1";
// The list: the computers' ids and the one in use. Each pairing has an entry of its own (pairingKey).
const INDEX_KEY = "botkins.computers.v1";
let kept: Kept = NO_COMPUTERS;
const saveIndex = () => keep(INDEX_KEY, indexOf(kept));
const savePairing = (pairing: Pairing) => keep(pairingKey(pairing.serverId), JSON.stringify(pairing));
// Requests for the computer's relay entry go over a relay socket; everything else is a plain fetch.
const fetcher = relayFetch(expoFetch as unknown as FetchLike);

setRandomSource((length) => Crypto.getRandomBytes(length));

let client: LinkClient | null = null;
type FrameHandle = { raf: number } | { timeout: ReturnType<typeof setTimeout> };
// Text-only ticks wait for the next frame. The display link stops in the background (a push can
// wake the app to sync), so there they wait on a short timer instead.
const partsBatcher = createPartsBatcher(applyParts, {
  schedule: (fn): FrameHandle =>
    AppState.currentState === "active" && typeof requestAnimationFrame === "function" ? { raf: requestAnimationFrame(() => fn()) } : { timeout: setTimeout(fn, 16) },
  cancel: (handle) => {
    const held = handle as FrameHandle;
    if ("raf" in held) cancelAnimationFrame(held.raf);
    else clearTimeout(held.timeout);
  },
});
onComputerChange(() => partsBatcher.clear());
let savedStorageLocked = false;
let savedStorageRetry: ReturnType<typeof AppState.addEventListener> | null = null;
// A profile pairing is a separate trust path from the phone's manual pairings. While one is in
// use it may temporarily be the active link, but it never replaces the local pairing in `kept`.
let activeProfilePairing: Pairing | null = null;
useChatPrefs.subscribe((prefs, before) => prefs.textStreaming !== before.textStreaming && client?.textStreamingChanged());
/** Who waits for the next sync to come back (`freshSync`). */
const syncWaiters = new Set<() => void>();

function follow(pairing: Pairing) {
  client?.stop();
  partsBatcher.clear();
  client = new LinkClient(pairing, {
    fetch: fetcher,
    streamAppends: true,
    lightSteps: true,
    textStreaming: (route) => textMode(useChatPrefs.getState().textStreaming, route),
    onParts: partsBatcher.push,
    onState: (link) => {
      useApp.setState({ link });
      if (link === "online") nearbyPace.reset();
    },
    onUnreachable: () => void lookNearby(pairing.serverId),
    onRoute: (route) => useApp.setState({ route }),
    onSync: () => {
      // Whoever waits for this sync (a wake task) reads the store next: give it the buffered text too.
      if (syncWaiters.size) partsBatcher.flush();
      for (const done of [...syncWaiters]) done();
    },
    check: () => fetcher.check(),
    onHosts: (hosts) => {
      const next = { ...pairing, hosts };
      if (activeProfilePairing?.serverId === next.serverId) {
        activeProfilePairing = next;
        useApp.setState({ pairing: next });
        void import("@/state/profile").then((profile) => profile.onProfilePairingHosts(next)).catch(() => {});
        return;
      }
      // A computer that was unpaired in the meantime is not brought back.
      if (!kept.list.some((item) => item.serverId === next.serverId)) return;
      kept = withDetails(kept, next);
      useApp.setState(kept.current === next.serverId ? { pairing: next, pairings: kept.list } : { pairings: kept.list });
      void savePairing(next).catch(() => {});
    },
  });
  client.watch([...watched.keys()]);
  client.watchReasoning([...reasoningWatchers.keys()]);
  client.start();
}

// A computer whose address changed (a new one from the router, another network at home) is found
// again by its announcement, so a new address never needs a new pairing.
let looking = false;
const nearbyPace = new NearbyPace();
async function lookNearby(serverId: string) {
  if (looking || !nearbyPace.allowed(Date.now()) || AppState.currentState !== "active") return;
  looking = true;
  const current = client;
  try {
    const network = await Network.getNetworkStateAsync().catch(() => undefined);
    if (!canBrowse(network) || AppState.currentState !== "active" || current !== client || current?.state !== "offline") return;
    nearbyPace.started(Date.now());
    const host = await findNearby(serverId).catch(() => null);
    if (!host) nearbyPace.missed(Date.now());
    else if (current === client) {
      nearbyPace.reset();
      current.learn(host);
    }
  } finally {
    looking = false;
  }
}

const EMPTY = { route: null, synced: false, parts: {}, texts: {}, chats: {}, running: {}, models: undefined, providers: undefined, skills: undefined } as const;

/**
 * Starts over on the computer in use, or on none: the link to the last one is closed, and nothing
 * of it stays in the store or in a cache.
 */
function startOver() {
  nearbyPace.reset();
  activeProfilePairing = null;
  const pairing = currentOf(kept);
  client?.stop();
  client = null;
  forgetComputer();
  useApp.setState({ pairing, pairings: kept.list, link: "connecting", ...EMPTY });
  if (pairing) follow(pairing);
}

/** Everything saved about the paired computers, read from the keychain. It throws when the keychain can't be read yet. */
async function readSaved(): Promise<{ kept: Kept; fromOldVersion: boolean }> {
  const index = await readKept(INDEX_KEY);
  const texts = new Map<string, string | null>();
  for (const id of savedIds(index)) texts.set(id, await readKept(pairingKey(id)));
  const single = index ? null : await readKept(LEGACY_KEY);
  const read = readKeptComputers(index, (id) => texts.get(id) ?? null, single);
  return { kept: read, fromOldVersion: !index && read.list.length > 0 };
}

async function retrySavedStorage() {
  if (!savedStorageLocked) return;
  try {
    const saved = await readSaved();
    savedStorageLocked = false;
    savedStorageRetry?.remove();
    savedStorageRetry = null;
    // Do not overwrite a pairing made while protected storage was locked. It will be persisted by
    // that flow once storage is available; the next launch can read the complete index.
    if (kept.list.length || useApp.getState().pairings.length) return;
    kept = saved.kept;
    useApp.setState({ pairing: currentOf(kept), pairings: kept.list, link: "connecting" });
    const pairing = currentOf(kept);
    if (pairing) follow(pairing);
  } catch {
    // The phone remains usable with whatever was already in memory until the next foreground.
  }
}

function retrySavedStorageOnActive() {
  savedStorageRetry ??= AppState.addEventListener("change", (next) => {
    if (next === "active") void retrySavedStorage();
  });
}

/** Reads what the phone saved and starts following the computer in use, when there is one. */
export async function boot() {
  // The keychain can't be read before the phone was unlocked for the first time since it was turned
  // on, and the app can be started in the background then. That is not "no pairing": the read is
  // tried again until it works. Only when the person has the app in front and it still fails is
  // the pairing given up.
  let saved: { kept: Kept; fromOldVersion: boolean } | undefined;
  for (let failed = 0; ; ) {
    try {
      saved = await readSaved();
      kept = saved.kept;
      // The one pairing an older version saved becomes the list. The old entry goes only once the new ones are written.
      if (saved.fromOldVersion && kept.list[0]) {
        const moved = kept.list[0];
        void savePairing(moved)
          .then(saveIndex)
          .then(() => forget(LEGACY_KEY))
          .catch(() => {});
      }
      break;
    } catch {
      if (AppState.currentState === "active" && ++failed >= 3) {
        savedStorageLocked = true;
        retrySavedStorageOnActive();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await loadPrefs();
  const held = useApp.getState();
  const pairing = savedStorageLocked ? held.pairing : currentOf(kept);
  useApp.setState(savedStorageLocked ? { booted: true, pairing, pairings: held.pairings, link: held.link } : { booted: true, pairing, pairings: kept.list, link: "connecting" });
  if (pairing) follow(pairing);
  // Notifications, and the tools bots can run on this phone. Loaded here, not at the top, because
  // both use this file.
  void import("./push").then((push) => push.startPush()).catch(() => {});
  // The Home Screen and Lock Screen widgets read what the app last saw (src/state/widgets.ts).
  void import("./widgets").then((widgets) => widgets.startWidgets()).catch(() => {});
  void import("./device").then((device) => device.startDeviceAnswers()).catch(() => {});
  void import("./watch").then((watch) => watch.startWatchCompanion()).catch(() => {});
  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      nearbyPace.reset();
      client?.wake();
    } else if (state === "background") {
      partsBatcher.flush();
      client?.rest();
      fetcher.rest();
    }
  });
  // Leaving Wi-Fi, or coming back to it, changes how the computer is reached: look again at once.
  try {
    // Only a real change counts (the kind of network, or whether it is up), and a burst of them is one.
    let last = "";
    let soon: ReturnType<typeof setTimeout> | undefined;
    Network.addNetworkStateListener((state) => {
      const now = [state.type, state.isConnected, state.isInternetReachable].join();
      if (now === last) return;
      last = now;
      nearbyPace.reset();
      clearTimeout(soon);
      soon = setTimeout(() => AppState.currentState === "active" && client?.wake("network"), 1500);
    });
  } catch {
    // A build without the network module still follows the app coming to the front.
  }
}

/**
 * What the computer calls this phone: its model ("iPhone 17 Pro"). Since iOS 16 the phone's own name
 * is the bare word "iPhone" without an entitlement, so the person's name goes apart, in `person`.
 */
export const deviceName = () => Device.modelName || Device.deviceName || (Platform.OS === "ios" ? "iPhone" : "Android phone");

/**
 * Pairs with the computer a code was scanned or typed for, and starts using it. The computers the
 * phone already has stay paired; pairing again with one of them replaces only that pairing.
 * `person` is the name the person gave ("Your name"), sent beside the phone's model.
 */
export async function pairWith(target: PairTarget, person?: string) {
  if (!hasRoom(kept, target.serverId)) throw new LinkError("closed", TOO_MANY);
  // A key that proves a person is holding this phone, made for this pairing. A computer with no
  // window of its own asks for its signature before a phone may turn its screen on, and keeps the
  // public half only from a pairing that reaches it directly. A phone that can't keep one pairs without.
  const presence = await newPresenceKey();
  let pairing: Pairing;
  try {
    pairing = await pair(fetcher, target, { name: deviceName(), platform: Platform.OS, ...(person && { person }), ...(presence && { presenceKey: presence.publicKey }) });
    // A typed address names its computer only now.
    if (!hasRoom(kept, pairing.serverId)) throw new LinkError("closed", TOO_MANY);
  } catch (error) {
    removePresenceKey(presence?.tag);
    throw error;
  }
  if (presence) pairing = { ...pairing, presenceTag: presence.tag };
  // Pairing again with a computer the phone has: the key of the pairing before goes with it.
  removePresenceKey(kept.list.find((item) => item.serverId === pairing.serverId)?.presenceTag);
  const next = withPairing(kept, pairing);
  await savePairing(pairing);
  kept = next;
  await saveIndex();
  startOver();
  void import("@/state/profile").then((profile) => profile.onLocalPairing(pairing)).catch(() => {});
  return pairing;
}

/** Finds a team invite from its relay card and checks that the host still supports joins. */
export async function findTeamInvite(code: string, expectedServerKey?: string) {
  let target: Awaited<ReturnType<typeof findInvite>>;
  try {
    target = await findInvite(fetcher, code, { serverKey: expectedServerKey });
  } catch (error) {
    if (!__DEV__) throw error;
    const demo = await findHost(fetcher, ["127.0.0.1:47620"], expectedServerKey ? { serverKey: expectedServerKey } : undefined).catch(() => {
      throw error;
    });
    target = {
      code,
      serverId: demo.hello.serverId,
      serverKey: demo.hello.publicKey,
      name: demo.hello.name || "Demo team",
      hosts: [demo.host],
      room: "",
      relayBase: "",
    };
  }
  const { hello } = await findHost(fetcher, target.hosts, { serverId: target.serverId, serverKey: target.serverKey }).catch((error: unknown) => {
    if (error instanceof LinkError && error.code === "not-found") throw new LinkError("offline", "Can't reach " + target.name + " right now. Try again when the owner's computer is on.");
    throw error;
  });
  if (hello.join !== true) throw new LinkError("protocol", "Update Botkins on the owner's computer");
  return { target, computerName: hello.name };
}

/** Starts a join request for this phone, keeping the same encrypted client key for later checks. `person` names the member. */
export function startTeamJoin(target: JoinTarget, person?: string) {
  if (!hasRoom(kept, target.serverId)) return Promise.reject(new LinkError("closed", TOO_MANY));
  return startJoin(fetcher, target, { name: deviceName(), platform: Platform.OS, kind: "phone", ...(person && { person }) });
}

export function checkTeamJoin(attempt: JoinAttempt) {
  return checkJoin(fetcher, attempt);
}

/** Adds an approved member pairing and makes that computer the one in use. */
export async function joinWithPairing(pairing: Pairing) {
  if (!hasRoom(kept, pairing.serverId)) throw new LinkError("closed", TOO_MANY);
  removePresenceKey(kept.list.find((item) => item.serverId === pairing.serverId)?.presenceTag);
  const next = withPairing(kept, pairing);
  await savePairing(pairing);
  kept = next;
  await saveIndex();
  startOver();
  void import("@/state/profile").then((profile) => profile.onLocalPairing(pairing)).catch(() => {});
  return pairing;
}

/** Connects to a host from the profile directory without changing the phone's local pairing list. */
export async function connectProfileHost(
  target: ProfileHost,
  issueTicket: (publicKey: string) => Promise<string>,
  person?: string,
): Promise<Pairing> {
  const link = await import("@/link/client") as unknown as {
    profileConnect?: (fetcher: FetchLike, target: ProfileHost, device: PairDevice, issueTicket: (publicKey: string) => Promise<string>) => Promise<Pairing>;
  };
  if (!link.profileConnect) throw new LinkError("protocol", "This version of Botkins cannot connect to a profile host.");
  return link.profileConnect(fetcher, target, { name: deviceName(), platform: Platform.OS, kind: "phone", ...(person && { person }) }, issueTicket);
}

/** Binds an already-authorized local pairing to a profile without changing the active computer. */
export async function bindProfileHost(pairing: Pairing, issueTicket: () => Promise<string>): Promise<ProfileHost> {
  const ticket = await issueTicket();
  const temporary = new LinkClient(pairing, { fetch: fetcher, onParts() {}, onState() {} });
  try {
    return await temporary.call<ProfileHost>("link.profile.bind", ticket);
  } finally {
    temporary.stop();
  }
}

/** Removes this profile's trust from a locally reachable host before its directory entry is deleted. */
export async function unbindProfileHost(pairing: Pairing, profileId: string): Promise<void> {
  const temporary = new LinkClient(pairing, { fetch: fetcher, onParts() {}, onState() {} });
  try {
    await temporary.call("link.profile.unbind", profileId);
  } finally {
    temporary.stop();
  }
}

/** Removes local keys that were upgraded to profile trust; unbound manual pairings remain. */
export async function dropProfileBoundPairings(serverIds: ReadonlyArray<string>) {
  if (!serverIds.length) return;
  const remove = new Set(serverIds);
  if (activeProfilePairing && remove.has(activeProfilePairing.serverId)) activeProfilePairing = null;
  const removed = kept.list.filter((pairing) => remove.has(pairing.serverId));
  if (!removed.length) return;
  for (const pairing of removed) {
    removePresenceKey(pairing.presenceTag);
    await forget(pairingKey(pairing.serverId)).catch(() => {});
  }
  kept = tidy(kept.list.filter((pairing) => !remove.has(pairing.serverId)), kept.current);
  await saveIndex().catch(() => {});
  startOver();
}

/** Uses an enrolled profile pairing while leaving any manual pairing for the same computer intact. */
export function activateProfilePairing(pairing: Pairing) {
  if (activeProfilePairing?.serverId === pairing.serverId && activeProfilePairing.secretKey === pairing.secretKey) return;
  client?.stop();
  activeProfilePairing = pairing;
  useApp.setState({ pairing, link: "connecting", route: null, synced: false, parts: {}, texts: {}, chats: {}, running: {}, models: undefined, providers: undefined, skills: undefined });
  follow(pairing);
}

/** Returns to the currently selected manual pairing after profile sign-out or host removal. */
export function deactivateProfilePairing() {
  if (!activeProfilePairing) return;
  activeProfilePairing = null;
  startOver();
}

/** Starts using another computer this phone is paired with. The one in use until now stays paired. */
export async function switchComputer(serverId: string) {
  if (activeProfilePairing) {
    activeProfilePairing = null;
    startOver();
  }
  const next = using(kept, serverId);
  if (next === kept || next.current === kept.current) return;
  kept = next;
  startOver();
  await saveIndex().catch(() => {});
}

/** The Shortcuts computer picker can open before the foreground app has booted. */
export async function shortcutHosts() {
  const { kept } = await readSaved();
  return kept.list.slice().sort((a, b) => Number(b.serverId === kept.current) - Number(a.serverId === kept.current))
    .map(({ serverId, name }) => ({ id: serverId, name }));
}

/** An App Intent may run before a scene exists. Read its pairing without starting the UI or changing its computer. */
export async function shortcutLink(host?: string) {
  const { kept: saved } = await readSaved();
  const pairing = host ? saved.list.find(item => item.serverId === host) : currentOf(saved);
  if (!pairing) throw new Error(host ? "This computer is no longer paired." : "Open Botkins and pair with your computer first.");
  return { host: pairing.serverId, name: pairing.name, link: new LinkClient(pairing, { fetch: fetcher, onState() {}, onParts() {} }) };
}

/**
 * Makes one call to every paired computer that is not the one in use, each over a link of its own
 * that is closed again. For what all of them have to hear (notifications were turned off). A
 * computer that can't be reached now is skipped; it hears it the next time the phone uses it.
 */
export async function tellOthers(method: string, ...args: unknown[]) {
  const others = kept.list.filter((pairing) => pairing.serverId !== kept.current);
  await Promise.all(
    others.map(async (pairing) => {
      const other = new LinkClient(pairing, { fetch: fetcher, onParts() {}, onState() {} });
      try {
        await Promise.race([other.call(method, ...args), new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 12_000))]);
      } catch {
        // Not reachable, or it refused: nothing more to do from here.
      } finally {
        other.stop();
      }
    }),
  );
}

/** Forgets the computer in use. It is told first, when it can be reached. The phone goes on with another computer when it has one. */
export async function unpair() {
  const pairing = currentOf(kept);
  const old = client;
  if (old && useApp.getState().link === "online") await old.call("link.unpair").catch(() => {});
  if (pairing) {
    removePresenceKey(pairing.presenceTag);
    kept = without(kept, pairing.serverId);
    await forget(pairingKey(pairing.serverId)).catch(() => {});
    await saveIndex().catch(() => {});
    await forget(LEGACY_KEY).catch(() => {});
  }
  startOver();
}

type Api = { [K in keyof Calls]: (...args: Parameters<Calls[K]>) => Promise<ReturnType<Calls[K]>> };
/** The computer's calls, by name: `await api.addBot({...})`. Each rejects with a LinkError. */
export const api = new Proxy({} as Api, {
  get: (_target, method: string) => (...args: unknown[]) => {
    if (!client) return Promise.reject(new LinkError("offline", "Pair with your computer first."));
    return client.call(method, ...args);
  },
});

/** The frame request belongs to the viewer and the computer on which it opened. */
export async function readScreenFrame(computer: string, options: Parameters<Calls["link.screen.frame"]>[0], signal: AbortSignal) {
  if (!client || useApp.getState().pairing?.serverId !== computer) throw new LinkError("offline", "The computer changed.");
  return client.callWithSignal<ScreenFrame>("link.screen.frame", signal, options);
}

/** A final button-up may follow an in-flight call. Bind it to this computer at viewer creation. */
export function screenInputSender() {
  const host = client;
  return (display: string, events: ScreenInput[]) =>
    host && host === client && host.state === "online" ? host.call("link.screen.input", display, events) : Promise.resolve();
}

/** Also update an older loaded page, outside the live chat subscription. */
export async function reactToMessage(chatId: string, index: number, time: number | null, emoji: string) {
  const host = client;
  const reactions = await api.reactToMessage(chatId, index, time, emoji);
  useApp.setState(state => {
    const view = state.chats[chatId];
    if (client !== host || !view) return {};
    const offset = index - view.from;
    const message = view.messages[offset];
    if (!message || (message.time ?? null) !== time) return {};
    const messages = view.messages.slice();
    messages[offset] = { ...message, reactions };
    return { chats: { ...state.chats, [chatId]: { ...view, messages } } };
  });
}

/** Runs a call and shows its failure as a toast. Resolves to undefined when it failed. */
export async function attempt<T>(work: Promise<T>, done?: string): Promise<T | undefined> {
  try {
    const result = await work;
    if (done) showToast(done, "success");
    return result;
  } catch (error) {
    showToast(error instanceof Error ? error.message : "That didn't work.", "error");
    return undefined;
  }
}

// Chats on screen are watched; each screen counts once.
const watched = new Map<string, number>();
const reasoningWatchers = new Map<string, number>();
const watchers = new Set<() => void>();
/** The chat on screen now (the last one opened), if any. */
export const chatOnScreen = () => [...watched.keys()].at(-1);
/** Calls `listener` when the chat on screen changes. Returns a function that stops it. */
export function onChatOnScreen(listener: () => void) {
  watchers.add(listener);
  return () => void watchers.delete(listener);
}
function watchId(counts: Map<string, number>, id: string, publish: () => void) {
  counts.set(id, (counts.get(id) ?? 0) + 1);
  publish();
  return () => {
    const left = (counts.get(id) ?? 1) - 1;
    if (left > 0) counts.set(id, left);
    else counts.delete(id);
    publish();
  };
}
export function watchChat(id: string) {
  return watchId(watched, id, () => {
    client?.watch([...watched.keys()]);
    for (const tell of watchers) tell();
  });
}
/** A visible chat or Activity sheet can follow reasoning even when replies arrive whole. */
export function watchReasoning(id: string) {
  return watchId(reasoningWatchers, id, () => client?.watchReasoning([...reasoningWatchers.keys()]));
}

/** Loads the page of messages before the ones a chat holds. */
export async function loadEarlier(chatId: string) {
  const view = useApp.getState().chats[chatId];
  if (!view || view.from === 0 || view.loadingEarlier) return;
  const setLoading = (loadingEarlier: boolean) =>
    useApp.setState((state) => (state.chats[chatId] ? { chats: { ...state.chats, [chatId]: { ...state.chats[chatId]!, loadingEarlier } } } : {}));
  setLoading(true);
  try {
    const page = (await api["link.messages"](chatId, view.from, 60)) as ChatDetail | null;
    useApp.setState((state) => {
      const held = state.chats[chatId];
      if (!held || !page || page.activeFork !== held.activeFork || page.from + page.messages.length !== held.from) return {};
      const runs = { ...held.runs };
      for (const run of page.runs) runs[run.id] = run;
      return { chats: { ...state.chats, [chatId]: { ...held, from: page.from, messages: [...page.messages, ...held.messages], runs, loadingEarlier: false } } };
    });
  } catch {
    // The chat still shows what it has.
  } finally {
    setLoading(false);
  }
}

export function wake() {
  client?.wake("retry");
}

/**
 * For a wake in the background (a push): follows the computer until one sync has come back, so what
 * the app then reads is current, not what it held when it was suspended. Resolves false when there is
 * no link yet or no answer within `ms`.
 */
export function freshSync(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!client) return resolve(false);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      syncWaiters.delete(hit);
      resolve(ok);
    };
    const hit = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    syncWaiters.add(hit);
    client.wake();
  });
}

/** Back to rest after a wake in the background, unless the person opened the app meanwhile. */
export function restIfAway() {
  if (AppState.currentState !== "active") client?.rest();
}
export { mergeChat };
