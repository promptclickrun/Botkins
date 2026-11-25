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

test("locked background boot parks storage recovery, and a later push restores the link for one sync", async () => {
  const listeners = new Set<(state: string) => void>();
  const appState = { currentState: "background", addEventListener: (_: string, callback: (state: string) => void) => {
    listeners.add(callback);
    return { remove: () => listeners.delete(callback) };
  } };
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
    watch() {}
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
  appState.currentState = "active";
  for (const listener of listeners) listener("active");
  assert.deepEqual([reads, starts, wakes], [4, 1, 2]);
});
