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
import type { A2uiActionPayload, A2uiFunctionRpcPayload, Calls, ChatDetail, Parts, ScreenFrame, ScreenInput } from "@/link/types";
import { textMode, useChatPrefs } from "./chatPrefs";
import { loadPrefs, setPrefs, usePrefs } from "./prefs";
import { newPresenceKey, removePresenceKey } from "./presence";
import { currentOf, hasRoom, indexOf, type Kept, NO_COMPUTERS, pairingKey, readKeptComputers, savedIds, startupComputers, tidy, TOO_MANY, using, withDetails, withPairing, without } from "./computers";
import { applyParts, forgetComputer, mergeChat, onComputerChange, showToast, useApp } from "./store";
import {
  buildUnifiedHostsStatus,
  combineMergedSpaceContent,
  hostOfId,
  mergeUnifiedParts,
  parseMergedBuiltinSpaceId,
  parseScopedId,
  rescopeMobileResult,
  resolveMergedSpaceTarget,
  routeMobileCall,
  scopePartsForHost,
  unscopeId,
} from "./unified";
import { createFollowing } from "./following";
import { createPartsBatcher } from "./partsBatch";
import { canBrowse, NearbyPace } from "./reconnect";
import { findNearby } from "./nearby";
import { type BackgroundReason, createBackgroundController } from "./backgroundRelay";

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
type PooledHost = {
  pairing: Pairing;
  client: LinkClient;
  link: import("@/link/client").LinkState;
  synced: boolean;
  parts: Partial<Parts>;
};
const pool = new Map<string, PooledHost>();
const allClients = (): LinkClient[] => (pool.size > 0 ? [...pool.values()].map((entry) => entry.client) : client ? [client] : []);
const stopPool = () => {
  for (const entry of pool.values()) entry.client.stop();
  pool.clear();
};
function includedPairings(): Pairing[] {
  const excluded = new Set(usePrefs.getState().excludedUnifiedHosts);
  return kept.list.filter((pairing) => pairing.serverId === kept.current || !excluded.has(pairing.serverId));
}
function shouldUseUnified(): boolean {
  return !activeProfilePairing && usePrefs.getState().unifiedHosts && includedPairings().length > 1;
}
function overallPoolLink(): import("@/link/client").LinkState {
  let anyConnecting = false;
  let anyRevoked = false;
  for (const entry of pool.values()) {
    if (entry.link === "online") return "online";
    if (entry.link === "connecting") anyConnecting = true;
    if (entry.link === "revoked") anyRevoked = true;
  }
  if (anyConnecting) return "connecting";
  return anyRevoked ? "revoked" : "offline";
}
function refreshUnifiedStatus() {
  if (!pool.size) return;
  const primaryId = currentOf(kept)?.serverId ?? null;
  useApp.setState({
    link: overallPoolLink(),
    unified: true,
    unifiedHosts: buildUnifiedHostsStatus(kept.list, primaryId, usePrefs.getState().excludedUnifiedHosts, pool),
  });
}
function pushMergedUnifiedParts(extra?: Record<string, unknown>) {
  if (!pool.size) return;
  const primaryId = currentOf(kept)?.serverId ?? null;
  const snapshots = [...pool.values()].map((entry) => ({
    pairing: entry.pairing,
    link: entry.link,
    synced: entry.synced,
    parts: entry.parts,
    chats: {},
    running: {},
    texts: {},
  }));
  const merged = mergeUnifiedParts(snapshots, primaryId, usePrefs.getState().settingsHost) as Record<string, unknown>;
  partsBatcher.push(extra ? { ...merged, ...extra } : merged);
}
/** Read-only snapshot of pooled hosts for widgets, push registration, and device tools. */
export function pooledEntries(): { pairing: Pairing; link: import("@/link/client").LinkState; synced: boolean; parts: Partial<Parts> }[] {
  return [...pool.values()].map(({ pairing, link, synced, parts }) => ({ pairing, link, synced, parts }));
}
export function isUnifiedActive(): boolean {
  return pool.size > 1;
}
/** Sends one RPC call directly to a specific connected host in the pool (or active single host). */
export function callHost<T = unknown>(serverId: string, method: string, ...args: unknown[]): Promise<T> {
  const pooled = pool.get(serverId);
  if (pooled) return pooled.client.call<T>(method, ...args);
  if (client && useApp.getState().pairing?.serverId === serverId) return client.call<T>(method, ...args);
  return Promise.reject(new LinkError("offline", "That computer is not connected."));
}
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
// A profile pairing is a separate trust path from the phone's manual pairings. While one is in
// use it may temporarily be the active link, but it never replaces the local pairing in `kept`.
let activeProfilePairing: Pairing | null = null;
useChatPrefs.subscribe((prefs, before) => {
  if (prefs.textStreaming !== before.textStreaming) {
    for (const c of allClients()) c.textStreamingChanged();
  }
});
/** Who waits for the next sync to come back (`freshSync`). */
const syncWaiters = new Set<() => void>();

// Background relay socket lifecycle: wait a short grace window after entering background before
// resting the link and closing the relay WebSocket cleanly, unless active background work (uploads,
// voice/call, Watch voice, or a push wake) holds the socket open.
const background = createBackgroundController({
  initialState: AppState.currentState ?? "active",
  onBackground: () => {
    partsBatcher.flush();
  },
  onSleep: () => {
    for (const c of allClients()) c.rest();
    fetcher.rest({ force: true });
  },
  onWake: () => {
    nearbyPace.reset();
    void retrySavedStorage();
    // Give the returning screen time to reclaim its cached page.
    watched.returned();
    for (const c of allClients()) c.wake();
  },
});

/**
 * Keeps the link and relay WebSocket open while genuine background work is in flight
 * (e.g. an active attachment upload, live voice/talk call, Watch voice session, or push wake).
 * Call the returned release function when the work completes or fails.
 */
export function holdBackgroundLink(reason: BackgroundReason): () => void {
  return background.hold(reason);
}

/** Wakes the link immediately (e.g. when a notification or push is tapped before AppState flips). */
export function wakeForNotification() {
  background.wake();
}

function follow(pairing: Pairing) {
  stopPool();
  client?.stop();
  partsBatcher.clear();
  // A chat kept from the computer followed until now is not one of this computer's.
  watched.release();
  client = new LinkClient(pairing, {
    fetch: fetcher,
    streamAppends: true,
    separateThinking: true,
    lightSteps: true,
    runStepDeltas: true,
    runSummaryDeltas: true,
    textStreaming: (route) => textMode(useChatPrefs.getState().textStreaming && AppState.currentState === "active" && replies.shown().length > 0,
      route, useApp.getState().parts.meta?.capabilities),
    onParts: partsBatcher.push,
    onState: (link) => {
      useApp.setState({ link, unified: false, unifiedHosts: [] });
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
  publishWatch();
  publishReasoningWatch();
  client.start({ resting: AppState.currentState !== "active" });
}

function followUnified() {
  stopPool();
  client?.stop();
  client = null;
  partsBatcher.clear();
  watched.release();
  const primary = currentOf(kept);
  if (!primary) return;
  const primaryId = primary.serverId;
  const targets = includedPairings();
  if (targets.length <= 1) {
    follow(primary);
    return;
  }
  const resting = AppState.currentState !== "active";
  for (const pairing of targets) {
    const entry: PooledHost = {
      pairing,
      client: null as unknown as LinkClient,
      link: "connecting",
      synced: false,
      parts: {},
    };
    entry.client = new LinkClient(pairing, {
      fetch: fetcher,
      streamAppends: true,
      separateThinking: true,
      lightSteps: true,
      runStepDeltas: true,
      runSummaryDeltas: true,
      textStreaming: (route) =>
        textMode(
          useChatPrefs.getState().textStreaming &&
            AppState.currentState === "active" &&
            replies.shown().some((id) => hostOfId(id, primaryId) === pairing.serverId),
          route,
          entry.parts.meta?.capabilities,
        ),
      onParts: (incoming) => {
        if (pool.get(pairing.serverId) !== entry) return;
        const name = (incoming.meta as { name?: string } | undefined)?.name || entry.parts.meta?.name || entry.pairing.name || "Computer";
        const scoped = scopePartsForHost(incoming, pairing.serverId, name, primaryId);
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(scoped)) {
          if (k.startsWith("chat:") || k.startsWith("run:") || k.startsWith("reasoning:") || k.startsWith("text:")) {
            extra[k] = v;
          } else {
            (entry.parts as Record<string, unknown>)[k] = v;
          }
        }
        entry.synced = true;
        refreshUnifiedStatus();
        pushMergedUnifiedParts(extra);
      },
      onState: (link) => {
        if (pool.get(pairing.serverId) !== entry) return;
        entry.link = link;
        if (link === "online") nearbyPace.reset();
        refreshUnifiedStatus();
        pushMergedUnifiedParts();
      },
      onUnreachable: () => void lookNearby(pairing.serverId),
      onRoute: (route) => {
        if (pairing.serverId === primaryId) useApp.setState({ route });
      },
      onSync: () => {
        if (syncWaiters.size) partsBatcher.flush();
        for (const done of [...syncWaiters]) done();
      },
      check: () => fetcher.check(),
      onHosts: (hosts) => {
        const next = { ...entry.pairing, hosts };
        entry.pairing = next;
        if (!kept.list.some((item) => item.serverId === next.serverId)) return;
        kept = withDetails(kept, next);
        useApp.setState(kept.current === next.serverId ? { pairing: next, pairings: kept.list } : { pairings: kept.list });
        void savePairing(next).catch(() => {});
      },
    });
    pool.set(pairing.serverId, entry);
    if (pairing.serverId === primaryId) client = entry.client;
  }
  refreshUnifiedStatus();
  publishWatch();
  publishReasoningWatch();
  for (const entry of pool.values()) entry.client.start({ resting });
}

function followActive() {
  const pairing = currentOf(kept);
  if (!pairing) return;
  if (shouldUseUnified()) followUnified();
  else follow(pairing);
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
  stopPool();
  client?.stop();
  client = null;
  forgetComputer();
  useApp.setState({ pairing, pairings: kept.list, unified: false, unifiedHosts: [], link: "connecting", ...EMPTY });
  if (pairing) followActive();
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

let restoring: Promise<void> | undefined;
function retrySavedStorage() {
  if (!savedStorageLocked) return Promise.resolve();
  return restoring ??= restoreSavedStorage().finally(() => { restoring = undefined; });
}

async function restoreSavedStorage() {
  try {
    const saved = await readSaved();
    savedStorageLocked = false;
    // Do not overwrite a pairing made while protected storage was locked. It will be persisted by
    // that flow once storage is available; the next launch can read the complete index.
    await loadPrefs();
    if (kept.list.length || useApp.getState().pairings.length) return;
    kept = startupComputers(saved.kept, usePrefs.getState().primaryHost);
    useApp.setState({ pairing: currentOf(kept), pairings: kept.list, link: "connecting" });
    if (currentOf(kept)) followActive();
  } catch {
    // The phone remains usable with whatever was already in memory until the next foreground.
  }
}

/** Reads what the phone saved and starts following the computer in use, when there is one. */
let booting: Promise<void> | undefined;
export function boot() {
  return booting ??= startApp().catch((error) => {
    booting = undefined;
    throw error;
  });
}

async function startApp() {
  // The keychain can't be read before the phone was unlocked for the first time since it was turned
  // on. Keep any existing pairing and defer locked background reads until the next foreground.
  let lockedWhileAway = false;
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
      if (AppState.currentState !== "active" || ++failed >= 3) {
        savedStorageLocked = true;
        lockedWhileAway = AppState.currentState !== "active";
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await loadPrefs();
  kept = startupComputers(kept, usePrefs.getState().primaryHost);
  const held = useApp.getState();
  const pairing = savedStorageLocked ? held.pairing : currentOf(kept);
  useApp.setState(savedStorageLocked ? { booted: true, pairing, pairings: held.pairings, link: held.link } : { booted: true, pairing, pairings: kept.list, link: "connecting" });
  if (pairing) followActive();
  // Notifications, and the tools bots can run on this phone. Loaded here, not at the top, because
  // both use this file.
  void import("./push").then((push) => push.startPush()).catch(() => {});
  // The Home Screen and Lock Screen widgets read what the app last saw (src/state/widgets.ts).
  void import("./widgets").then((widgets) => widgets.startWidgets()).catch(() => {});
  void import("./device").then((device) => device.startDeviceAnswers()).catch(() => {});
  void import("./watch").then((watch) => watch.startWatchCompanion()).catch(() => {});
  AppState.addEventListener("change", (state) => {
    background.setAppState(state);
  });
  // The foreground transition may have happened while prefs were loading.
  if (lockedWhileAway && AppState.currentState === "active") void retrySavedStorage();
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
      soon = setTimeout(() => {
        if (AppState.currentState === "active") for (const c of allClients()) c.wake("network");
      }, 1500);
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
  if (usePrefs.getState().unifiedHosts) {
    setPrefs({ unifiedHosts: false });
  }
  if (activeProfilePairing) {
    activeProfilePairing = null;
    startOver();
  }
  const next = using(kept, serverId);
  if (next === kept) return;
  const changed = next.current !== kept.current || pool.size > 0;
  kept = next;
  if (changed) startOver();
  await saveIndex().catch(() => {});
}

/** Switches unified multi-host mode on or off across connected computers. */
export function setUnifiedHosts(enabled: boolean) {
  if (usePrefs.getState().unifiedHosts === enabled && (enabled ? pool.size > 1 : pool.size === 0)) return;
  setPrefs({ unifiedHosts: enabled });
  startOver();
}

/** Includes or excludes one paired computer from the unified view. */
export function setUnifiedHostIncluded(serverId: string, included: boolean) {
  const prev = usePrefs.getState().excludedUnifiedHosts;
  const next = included ? prev.filter((id) => id !== serverId) : prev.includes(serverId) ? prev : [...prev, serverId];
  setPrefs({ excludedUnifiedHosts: next });
  if (usePrefs.getState().unifiedHosts) startOver();
}

/** Picks which computer host-scoped Settings apply to while unified mode is active. */
export function setSettingsHost(serverId: string) {
  setPrefs({ settingsHost: serverId });
  if (pool.size > 0) {
    useApp.setState({ models: undefined, providers: undefined, skills: undefined });
    pushMergedUnifiedParts();
  }
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

/** Handles calls targeting a merged virtual built-in space (`unified~builtin~<kind>`) across pooled hosts. */
async function handleMergedSpaceCall(method: string, args: unknown[], primaryId: string): Promise<unknown> {
  const spaces = useApp.getState().parts.spaces ?? [];
  const findMerged = (id: unknown) =>
    typeof id === "string" && parseMergedBuiltinSpaceId(id) ? spaces.find((s) => s.id === id) : undefined;

  // spaces.read(mergedId): fan out to every included online host and combine panels/cards.
  if (method === "spaces.read") {
    const space = findMerged(args[0]);
    if (!space?.merged) return Promise.reject(new LinkError("not-found", "This space no longer exists."));
    const { sources, offlineCount } = space.merged;
    const responses = await Promise.all(
      sources.map(async (src) => {
        const entry = pool.get(src.hostId);
        if (!entry || entry.link !== "online") {
          return { hostId: src.hostId, hostName: src.hostName, failed: true };
        }
        try {
          const raw = await entry.client.call<import("@/link/types").SpaceContent>("spaces.read", src.rawSpaceId);
          const content = rescopeMobileResult("spaces.read", raw, src.hostId, primaryId);
          return { hostId: src.hostId, hostName: src.hostName, content };
        } catch {
          return { hostId: src.hostId, hostName: src.hostName, failed: true };
        }
      }),
    );
    const anySucceeded = responses.some((r) => !r.failed && r.content);
    if (!anySucceeded && sources.length > 0) {
      throw new LinkError("offline", "Couldn't reach any computer for this space.");
    }
    return combineMergedSpaceContent(space.id, space.rev, responses, offlineCount);
  }

  // link.spaces.seen(mergedId, itemId?): route to itemId's host when itemId is given, else fan out to all sources.
  if (method === "link.spaces.seen") {
    const space = findMerged(args[0]);
    if (!space?.merged) return null;
    const itemId = typeof args[1] === "string" ? args[1] : undefined;
    if (itemId) {
      const targetHost = hostOfId(itemId, primaryId);
      const src = space.merged.sources.find((s) => s.hostId === targetHost);
      const entry = src ? pool.get(src.hostId) : undefined;
      if (!src || !entry || entry.link !== "online") return null;
      return entry.client.call("link.spaces.seen", src.rawSpaceId, unscopeId(itemId)).catch(() => null);
    }
    await Promise.all(
      space.merged.sources.map((src) => {
        const entry = pool.get(src.hostId);
        if (!entry || entry.link !== "online") return Promise.resolve();
        return entry.client.call("link.spaces.seen", src.rawSpaceId).catch(() => {});
      }),
    );
    return null;
  }

  // link.spaces.here(mergedId | null, panelId?): fan out presence to sources (or clear on all pooled hosts).
  if (method === "link.spaces.here") {
    const id = args[0];
    const panelId = typeof args[1] === "string" ? args[1] : undefined;
    if (id === null) {
      await Promise.all(
        [...pool.values()].map((entry) =>
          entry.link === "online" ? entry.client.call("link.spaces.here", null).catch(() => {}) : Promise.resolve(),
        ),
      );
      return null;
    }
    const space = findMerged(id);
    if (!space?.merged) return null;
    const panelHost = panelId ? hostOfId(panelId, primaryId) : null;
    await Promise.all(
      space.merged.sources.map((src) => {
        const entry = pool.get(src.hostId);
        if (!entry || entry.link !== "online") return Promise.resolve();
        const rawPanel = panelId && panelHost === src.hostId ? unscopeId(panelId) : undefined;
        return entry.client.call("link.spaces.here", src.rawSpaceId, rawPanel).catch(() => {});
      }),
    );
    return null;
  }

  // link.spaces.notify(mergedId, mode): apply notification mode across all online sources.
  if (method === "link.spaces.notify") {
    const space = findMerged(args[0]);
    if (!space?.merged) return null;
    await Promise.all(
      space.merged.sources.map((src) => {
        const entry = pool.get(src.hostId);
        if (!entry || entry.link !== "online") return Promise.resolve();
        return entry.client.call("link.spaces.notify", src.rawSpaceId, args[1]).catch(() => {});
      }),
    );
    return null;
  }

  // link.spaces.arrange({ order, pinned }): partition per host, expanding any merged virtual id back to each host's own builtin space id.
  if (method === "link.spaces.arrange" && args[0] && typeof args[0] === "object") {
    const input = args[0] as { order?: string[]; pinned?: string[] };
    const mergedById = new Map(spaces.filter((s) => s.merged).map((s) => [s.id, s]));
    const perHost = new Map<string, { order: string[]; pinned: string[] }>();
    const ensure = (hid: string) => {
      let bucket = perHost.get(hid);
      if (!bucket) {
        bucket = { order: [], pinned: [] };
        perHost.set(hid, bucket);
      }
      return bucket;
    };
    const pushList = (ids: string[] | undefined, field: "order" | "pinned") => {
      for (const id of ids ?? []) {
        const m = mergedById.get(id);
        if (m?.merged) {
          for (const src of m.merged.sources) {
            const b = ensure(src.hostId);
            if (!b[field].includes(src.rawSpaceId)) b[field].push(src.rawSpaceId);
          }
        } else {
          const hid = hostOfId(id, primaryId);
          if (!hid) continue;
          const raw = unscopeId(id);
          const b = ensure(hid);
          if (!b[field].includes(raw)) b[field].push(raw);
        }
      }
    };
    pushList(input.order, "order");
    pushList(input.pinned, "pinned");
    await Promise.all(
      [...perHost.entries()].map(([hid, plan]) => {
        const entry = pool.get(hid);
        if (!entry || entry.link !== "online") return Promise.resolve();
        return entry.client.call("link.spaces.arrange", plan).catch(() => {});
      }),
    );
    return null;
  }

  // spaces.newPanel / spaces.ask with a merged spaceId: route to explicit hostId, botId's host, or settingsHost/primary.
  if ((method === "spaces.newPanel" || method === "spaces.ask") && args[0] && typeof args[0] === "object") {
    const input = args[0] as Record<string, unknown>;
    const space = findMerged(input.spaceId);
    if (space?.merged) {
      const explicitHost = typeof input.hostId === "string" && input.hostId ? input.hostId : null;
      const botHost = typeof input.botId === "string" && input.botId ? hostOfId(input.botId, primaryId) : null;
      const panelHost = typeof input.panelId === "string" && input.panelId ? hostOfId(input.panelId, primaryId) : null;
      const desiredHost = explicitHost ?? panelHost ?? botHost ?? usePrefs.getState().settingsHost ?? primaryId;
      const resolved = resolveMergedSpaceTarget(space, desiredHost);
      if (!resolved) throw new LinkError("offline", "No online computer available for this space.");
      const entry = pool.get(resolved.hostId);
      if (!entry || entry.link !== "online") throw new LinkError("offline", "That computer is not connected.");
      const { hostId: _strip, ...rest } = input;
      const nextPayload = {
        ...rest,
        spaceId: resolved.rawSpaceId,
        ...(typeof rest.botId === "string" && { botId: unscopeId(rest.botId) }),
        ...(typeof rest.panelId === "string" && { panelId: unscopeId(rest.panelId) }),
        ...(typeof rest.projectId === "string" && { projectId: unscopeId(rest.projectId) }),
      };
      const result = await entry.client.call(method, nextPayload);
      return rescopeMobileResult(method, result, resolved.hostId, primaryId);
    }
  }

  // spaces.movePanel(panelId, { spaceId, before }): resolve merged destination spaceId to panel's own host.
  if (method === "spaces.movePanel" && typeof args[0] === "string" && args[1] && typeof args[1] === "object") {
    const to = args[1] as { spaceId?: string; before?: string | null };
    const space = findMerged(to.spaceId);
    if (space?.merged) {
      const panelHost = hostOfId(args[0], primaryId);
      const src = space.merged.sources.find((s) => s.hostId === panelHost);
      if (!src) throw new LinkError("remote", "A panel can only move to a space on the same computer.");
      const entry = pool.get(src.hostId);
      if (!entry || entry.link !== "online") throw new LinkError("offline", "That computer is not connected.");
      const nextTo = {
        spaceId: src.rawSpaceId,
        before: to.before && hostOfId(to.before, primaryId) === src.hostId ? unscopeId(to.before) : null,
      };
      return entry.client.call("spaces.movePanel", unscopeId(args[0]), nextTo);
    }
  }

  return undefined;
}

/** The computer's calls, by name: `await api.addBot({...})`. Each rejects with a LinkError. */
export const api = new Proxy({} as Api, {
  get: (_target, method: string) => (...args: unknown[]) => {
    if (pool.size > 0) {
      const primaryId = currentOf(kept)?.serverId;
      if (!primaryId) return Promise.reject(new LinkError("offline", "Pair with your computer first."));
      // Merged built-in spaces (`unified~builtin~*`) and multi-host space calls (`link.spaces.arrange`, `link.spaces.here(null)`).
      if (
        method === "link.spaces.arrange" ||
        (method === "link.spaces.here" && (args[0] === null || parseMergedBuiltinSpaceId(args[0]) !== null)) ||
        ((method === "spaces.read" || method === "link.spaces.seen" || method === "link.spaces.notify") && parseMergedBuiltinSpaceId(args[0]) !== null) ||
        ((method === "spaces.newPanel" || method === "spaces.ask") && args[0] && typeof args[0] === "object" && parseMergedBuiltinSpaceId((args[0] as { spaceId?: unknown }).spaceId) !== null) ||
        (method === "spaces.movePanel" && args[1] && typeof args[1] === "object" && parseMergedBuiltinSpaceId((args[1] as { spaceId?: unknown }).spaceId) !== null)
      ) {
        return handleMergedSpaceCall(method, args, primaryId);
      }
      const route = routeMobileCall(method, args, {
        primaryId,
        settingsHostId: usePrefs.getState().settingsHost,
        poolIds: [...pool.keys()],
      });
      if (route.kind === "fanout") {
        return Promise.all(
          route.calls.map((c) => {
            const entry = pool.get(c.hostId);
            if (!entry) return Promise.reject(new LinkError("offline", "Computer is not connected."));
            return entry.client.call(method, ...c.args);
          }),
        );
      }
      const entry = pool.get(route.hostId);
      if (!entry) return Promise.reject(new LinkError("offline", "Computer is not connected."));
      return entry.client.call(method, ...route.args).then((result) => rescopeMobileResult(method, result, route.hostId, primaryId));
    }
    if (!client) return Promise.reject(new LinkError("offline", "Pair with your computer first."));
    return client.call(method, ...args);
  },
});

/** Binds calls to the computer active right now; if the person switches computers mid-flow, `isCurrent()` turns false and further calls are ignored. */
export function boundApi(): { api: Api; isCurrent: () => boolean } {
  const host = client;
  const wasUnified = pool.size > 0;
  const isCurrent = () => (wasUnified ? pool.size > 0 && client === host : client === host);
  const bound = new Proxy({} as Api, {
    get: (_target, method: string) => (...args: unknown[]) => {
      if (!host) return Promise.reject(new LinkError("offline", "Pair with your computer first."));
      if (!isCurrent()) return Promise.resolve(undefined);
      return (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
    },
  });
  return { api: bound, isCurrent };
}

/** The frame request belongs to the viewer and the computer on which it opened. */
export async function readScreenFrame(computer: string, options: Parameters<Calls["link.screen.frame"]>[0], signal: AbortSignal) {
  const host = pool.get(computer)?.client ?? (useApp.getState().pairing?.serverId === computer ? client : null);
  if (!host) throw new LinkError("offline", "The computer changed.");
  return host.callWithSignal<ScreenFrame>("link.screen.frame", signal, options);
}

/** A decoder session and its cleanup belong to the computer that opened it. */
export function desktopVideoLink(computer: string, id: string, signal: AbortSignal) {
  const host = pool.get(computer)?.client ?? (useApp.getState().pairing?.serverId === computer ? client : null);
  if (!host) throw new LinkError("offline", "The computer changed.");
  const stillHere = () => (pool.size > 0 ? pool.get(computer)?.client === host : client === host);
  return {
    open: (options: Parameters<Calls["link.screen.video.open"]>[1]) =>
      host.callWithSignal<{ mimeType: string }>("link.screen.video.open", signal, id, options),
    read: (seq: number) => host.callWithSignal<string>("link.screen.video.read", signal, id, seq),
    close: () => {
      if (stillHere() && host.state === "online") void host.call("link.screen.video.close", id).catch(() => {});
    },
  };
}

/** A final button-up may follow an in-flight call. Bind it to this computer at viewer creation. */
export function screenInputSender(computer?: string) {
  const host = (computer ? pool.get(computer)?.client : undefined) ?? client;
  return (display: string, events: ScreenInput[]) =>
    host && (pool.size > 0 ? [...pool.values()].some((e) => e.client === host) : host === client) && host.state === "online"
      ? host.call("link.screen.input", display, events)
      : Promise.resolve();
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

/** Dispatches or dismisses a workflow action card and updates loaded chat pages immediately. */
export async function chatCardAction(chatId: string, target: number | string, action: "dispatch" | "dismiss") {
  const host = client;
  const result = await api["chat.cardAction"](chatId, target, action);
  useApp.setState(state => {
    const view = state.chats[chatId];
    if (client !== host || !view) return {};
    const offset =
      typeof target === "number"
        ? target - view.from
        : view.messages.findIndex(m => m.actionCard?.id === target);
    if (offset < 0 || offset >= view.messages.length) return {};
    const messages = view.messages.slice();
    messages[offset] = { ...messages[offset], actionCard: result.card };
    return { chats: { ...state.chats, [chatId]: { ...view, messages } } };
  });
  return result;
}

/** Sends an A2UI v1.0 surface user action to the host and updates the surface in loaded chat pages. */
export async function chatA2uiAction(chatId: string, payload: A2uiActionPayload) {
  const host = client;
  const result = await api["chat.a2uiAction"](chatId, payload);
  useApp.setState(state => {
    const view = state.chats[chatId];
    if (client !== host || !view || !result?.surface) return {};
    const offset = view.messages.findIndex(m => m.a2uiSurfaces?.some(s => s.surfaceId === result.surface.surfaceId));
    if (offset < 0 || offset >= view.messages.length) return {};
    const messages = view.messages.slice();
    const prevList = messages[offset].a2uiSurfaces ?? [];
    messages[offset] = {
      ...messages[offset],
      a2uiSurfaces: prevList.map(s => (s.surfaceId === result.surface.surfaceId ? result.surface : s)),
    };
    return { chats: { ...state.chats, [chatId]: { ...view, messages } } };
  });
  return result;
}

/** Sends a bidirectional A2UI v1.0 function call or rendererFunctionResponse over Link. */
export async function chatA2uiFunction(chatId: string, payload: A2uiFunctionRpcPayload) {
  return api["chat.a2uiFunction"](chatId, payload);
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

// Sheets can need chat details without displaying a reply. Only a focused message view asks for words.
const inBackground = () => AppState.currentState === "background";
function publishWatch() {
  if (pool.size > 0) {
    const primaryId = currentOf(kept)?.serverId ?? null;
    const shown = watched.shown();
    const keptPage = watched.keptPage();
    const replyShown = replies.shown();
    for (const [hostId, entry] of pool) {
      const forHost = (ids: string[]) => ids.filter((id) => hostOfId(id, primaryId) === hostId).map((id) => unscopeId(id));
      const hostKept = keptPage && hostOfId(keptPage, primaryId) === hostId ? unscopeId(keptPage) : undefined;
      entry.client.watch(forHost(shown), hostKept, forHost(replyShown));
    }
    return;
  }
  client?.watch(watched.shown(), watched.keptPage(), replies.shown());
}
function publishReasoningWatch() {
  const ids = reasoningWatchers.shown();
  if (pool.size > 0) {
    const primaryId = currentOf(kept)?.serverId ?? null;
    for (const [hostId, entry] of pool) {
      entry.client.watchReasoning(ids.filter((id) => hostOfId(id, primaryId) === hostId).map((id) => unscopeId(id)));
    }
    return;
  }
  client?.watchReasoning(ids);
}
const watched = createFollowing({ send: publishWatch, away: inBackground });
const replies = createFollowing({ send: publishWatch, away: inBackground, lingerMs: 0 });
const reasoningWatchers = createFollowing({ send: publishReasoningWatch, away: inBackground, lingerMs: 0 });
const watchers = new Set<() => void>();
/** The chat on screen now (the last one opened), if any. A chat that is only kept a little longer is not on screen. */
export const chatOnScreen = () => watched.shown().at(-1);
/** Calls `listener` when the chat on screen changes. Returns a function that stops it. */
export function onChatOnScreen(listener: () => void) {
  watchers.add(listener);
  return () => void watchers.delete(listener);
}
export function watchChat(id: string, showsReply = false) {
  const stop = watched.watch(id);
  const stopReply = showsReply ? replies.watch(id) : undefined;
  for (const tell of watchers) tell();
  return () => {
    stopReply?.();
    stop();
    for (const tell of watchers) tell();
  };
}
/** A visible chat or Activity sheet can follow reasoning even when replies arrive whole. */
export function watchReasoning(id: string) {
  return reasoningWatchers.watch(id);
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
  for (const c of allClients()) c.wake("retry");
}

/**
 * For a wake in the background (a push): follows the computer until one sync has come back, so what
 * the app then reads is current, not what it held when it was suspended. Resolves false when there is
 * no link yet or no answer within `ms`.
 */
export function freshSync(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const clients = allClients();
    if (!clients.length) return resolve(false);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      syncWaiters.delete(hit);
      resolve(ok);
    };
    const hit = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    syncWaiters.add(hit);
    // Nobody is looking: the chat that was kept a little longer is let go, so this sync brings no chat's page.
    if (AppState.currentState !== "active") watched.release();
    for (const c of clients) c.wake();
  });
}

/** A silent push gets one protected-storage attempt and one sync within its execution budget. */
export async function syncForPush(ms: number) {
  const deadline = Date.now() + ms;
  const preparation = useApp.getState().booted ? retrySavedStorage() : boot();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([preparation, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
  const remaining = deadline - Date.now();
  return remaining > 0 && freshSync(remaining);
}

/** Back to rest after a wake in the background, unless the person opened the app meanwhile or a hold is active. */
export function restIfAway() {
  if (AppState.currentState !== "active") {
    if (background.held) return;
    for (const c of allClients()) c.rest();
    fetcher.rest({ force: true });
    background.sleepNowIfAway();
  }
}
export { mergeChat };
