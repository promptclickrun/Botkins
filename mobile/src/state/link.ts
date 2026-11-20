// The app's one link to the computer in use: pairing, the saved pairings, calls, and the watched
// chats. A phone can be paired with several computers (src/state/computers.ts has the list's logic);
// it follows one at a time, and the others stay paired.
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { fetch as expoFetch } from "expo/fetch";
import { forget, keep, readKept } from "@/state/keep";
import * as Network from "expo-network";
import { AppState, Platform } from "react-native";
import { type FetchLike, LinkClient, LinkError, pair, type Pairing } from "@/link/client";
import { setRandomSource } from "@/link/crypto";
import type { PairTarget } from "@/link/pairing";
import { relayFetch } from "@/link/relay";
import type { Calls, ChatDetail } from "@/link/types";
import { loadPrefs } from "./prefs";
import { currentOf, hasRoom, indexOf, type Kept, NO_COMPUTERS, pairingKey, readKeptComputers, savedIds, TOO_MANY, using, withDetails, withPairing, without } from "./computers";
import { applyParts, forgetComputer, mergeChat, showToast, useApp } from "./store";
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

function follow(pairing: Pairing) {
  client?.stop();
  client = new LinkClient(pairing, {
    fetch: fetcher,
    onParts: applyParts,
    onState: (link) => {
      useApp.setState({ link });
      if (link === "offline") void lookNearby(pairing.serverId);
    },
    onRoute: (route) => useApp.setState({ route }),
    check: () => fetcher.check(),
    onHosts: (hosts) => {
      const next = { ...pairing, hosts };
      // A computer that was unpaired in the meantime is not brought back.
      if (!kept.list.some((item) => item.serverId === next.serverId)) return;
      kept = withDetails(kept, next);
      useApp.setState(kept.current === next.serverId ? { pairing: next, pairings: kept.list } : { pairings: kept.list });
      void savePairing(next).catch(() => {});
    },
  });
  client.watch([...watched.keys()]);
  client.start();
}

// A computer whose address changed (a new one from the router, another network at home) is found
// again by its announcement, so a new address never needs a new pairing.
let looking = false;
let lookedAt = 0;
async function lookNearby(serverId: string) {
  if (looking || Date.now() - lookedAt < 20_000 || AppState.currentState !== "active") return;
  looking = true;
  lookedAt = Date.now();
  try {
    const host = await findNearby(serverId);
    if (host && useApp.getState().pairing?.serverId === serverId) client?.learn(host);
  } finally {
    looking = false;
  }
}

const EMPTY = { route: null, synced: false, parts: {}, chats: {}, running: {}, models: undefined, providers: undefined, skills: undefined } as const;

/**
 * Starts over on the computer in use, or on none: the link to the last one is closed, and nothing
 * of it stays in the store or in a cache.
 */
function startOver() {
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

/** Reads what the phone saved and starts following the computer in use, when there is one. */
export async function boot() {
  // The keychain can't be read before the phone was unlocked for the first time since it was turned
  // on, and the app can be started in the background then. That is not "no pairing": the read is
  // tried again until it works. Only when the person has the app in front and it still fails is
  // the pairing given up.
  for (let failed = 0; ; ) {
    try {
      const saved = await readSaved();
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
      if (AppState.currentState === "active" && ++failed >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await loadPrefs();
  const pairing = currentOf(kept);
  useApp.setState({ booted: true, pairing, pairings: kept.list, link: "connecting" });
  if (pairing) follow(pairing);
  // Notifications, and the tools bots can run on this phone. Loaded here, not at the top, because
  // both use this file.
  void import("./push").then((push) => push.startPush()).catch(() => {});
  void import("./device").then((device) => device.startDeviceAnswers()).catch(() => {});
  AppState.addEventListener("change", (state) => state === "active" && client?.wake());
  // Leaving Wi-Fi, or coming back to it, changes how the computer is reached: look again at once.
  try {
    // Only a real change counts (the kind of network, or whether it is up), and a burst of them is one.
    let last = "";
    let soon: ReturnType<typeof setTimeout> | undefined;
    Network.addNetworkStateListener((state) => {
      const now = [state.type, state.isConnected, state.isInternetReachable].join();
      if (now === last) return;
      last = now;
      clearTimeout(soon);
      soon = setTimeout(() => AppState.currentState === "active" && client?.wake("network"), 1500);
    });
  } catch {
    // A build without the network module still follows the app coming to the front.
  }
}

export const deviceName = () => Device.deviceName || Device.modelName || (Platform.OS === "ios" ? "iPhone" : "Android phone");

/**
 * Pairs with the computer a code was scanned or typed for, and starts using it. The computers the
 * phone already has stay paired; pairing again with one of them replaces only that pairing.
 */
export async function pairWith(target: PairTarget) {
  if (!hasRoom(kept, target.serverId)) throw new LinkError("closed", TOO_MANY);
  const pairing = await pair(fetcher, target, { name: deviceName(), platform: Platform.OS });
  // A typed address names its computer only now.
  if (!hasRoom(kept, pairing.serverId)) throw new LinkError("closed", TOO_MANY);
  const next = withPairing(kept, pairing);
  await savePairing(pairing);
  kept = next;
  await saveIndex();
  startOver();
  return pairing;
}

/** Starts using another computer this phone is paired with. The one in use until now stays paired. */
export async function switchComputer(serverId: string) {
  const next = using(kept, serverId);
  if (next === kept || next.current === kept.current) return;
  kept = next;
  startOver();
  await saveIndex().catch(() => {});
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
      other.start();
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
const watchers = new Set<() => void>();
/** The chat on screen now (the last one opened), if any. */
export const chatOnScreen = () => [...watched.keys()].at(-1);
/** Calls `listener` when the chat on screen changes. Returns a function that stops it. */
export function onChatOnScreen(listener: () => void) {
  watchers.add(listener);
  return () => void watchers.delete(listener);
}
export function watchChat(id: string) {
  watched.set(id, (watched.get(id) ?? 0) + 1);
  client?.watch([...watched.keys()]);
  for (const tell of watchers) tell();
  return () => {
    const left = (watched.get(id) ?? 1) - 1;
    if (left > 0) watched.set(id, left);
    else watched.delete(id);
    client?.watch([...watched.keys()]);
    for (const tell of watchers) tell();
  };
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
      if (!held || !page || page.from + page.messages.length !== held.from) return {};
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
  client?.wake();
}
export { mergeChat };
