import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { test } from "node:test";

const load = createRequire(__filename);
function standIn(path: string, exports: unknown) {
  const id = load.resolve(path);
  const replacement = new Module(id);
  replacement.exports = exports;
  replacement.loaded = true;
  load.cache[id] = replacement;
}

const listeners = new Set<(state: string) => void>();
const appState = { currentState: "background", addEventListener: (_: string, callback: (state: string) => void) => {
  listeners.add(callback);
  return { remove: () => listeners.delete(callback) };
} };
/** The app's state changes, and everything that listens hears of it, the link first. */
function become(state: string) {
  appState.currentState = state;
  for (const listener of listeners) listener(state);
}
/** Every set of chats the link was told to follow. */
const watches: string[][] = [];

test("locked background boot parks storage recovery, and a later push restores the link for one sync", async () => {
  standIn("react-native", { AppState: appState, Platform: { OS: "ios" } });
  standIn("expo-device", {});
  standIn("expo-network", {});
  standIn("expo-crypto", {});
  standIn("expo/fetch", { fetch: async () => { throw new Error("unexpected network call"); } });
  standIn("../src/state/nearby", {});
  standIn("../src/state/presence", {});
  standIn("../src/state/prefs", { usePrefs: { getState: () => ({ primaryHost: null }) }, loadPrefs: async () => {} });
  standIn("../src/state/chatPrefs", { useChatPrefs: { subscribe() {} } });
  const pairing = { serverId: "host", secretKey: "s", serverKey: "k", name: "Desktop", deviceId: "phone", hosts: ["localhost"] };
  let locked = true;
  let reads = 0;
  standIn("../src/state/keep", { readKept: async (key: string) => {
    if (key !== "botkins.computers.v1" && key !== "botkins.computer.host") return null;
    reads++;
    if (locked) throw new Error("Device locked");
    return JSON.stringify(key === "botkins.computers.v1" ? { current: "host", ids: ["host"] } : pairing);
  } });
  let starts = 0;
  let wakes = 0;
  let rests = 0;
  standIn("../src/link/client", { LinkClient: class {
    constructor(_: unknown, readonly options: { onSync(): void }) {}
    watch(ids: string[]) { watches.push(ids); }
    watchReasoning() {}
    start(options: { resting: boolean }) { assert.equal(options.resting, true); starts++; }
    wake() { wakes++; this.options.onSync(); }
    rest() { rests++; }
  } });
  const { boot, syncForPush, restIfAway } = load("../src/state/link");
  await Promise.all([boot(), boot()]);
  assert.deepEqual([reads, starts, wakes], [1, 0, 0]);
  assert.equal(await syncForPush(100), false);
  assert.deepEqual([reads, starts, wakes], [2, 0, 0]);
  locked = false;
  assert.equal(await syncForPush(100), true);
  restIfAway();
  assert.deepEqual([reads, starts, wakes, rests], [4, 1, 1, 1]);
  become("active");
  assert.deepEqual([reads, starts, wakes], [4, 1, 2]);
});

test("a chat on screen is still followed after a moment away, and a push's sync lets it go", async () => {
  const { watchChat, chatOnScreen, syncForPush } = load("../src/state/link");
  watches.length = 0;
  let stop = watchChat("chat");
  assert.deepEqual(watches, [["chat"]]);
  assert.equal(chatOnScreen(), "chat");
  // Another app for a moment: the chat's screen stops watching as the app goes to the background.
  become("background");
  stop();
  assert.equal(chatOnScreen(), undefined, "no chat is on screen, so its notifications arrive");
  // Back in front: the link wakes first, then the screen watches again. The link is told nothing,
  // so the wake's quick check is not cut short and the chat is not loaded again.
  become("active");
  stop = watchChat("chat");
  assert.deepEqual(watches, [["chat"]]);
  assert.equal(chatOnScreen(), "chat");
  // Away again, and a push wakes the app: that sync follows no chat.
  become("background");
  stop();
  assert.equal(await syncForPush(100), true);
  assert.deepEqual(watches, [["chat"], []]);
  become("active");
});
