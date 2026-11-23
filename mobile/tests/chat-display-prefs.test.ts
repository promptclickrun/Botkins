// Round-trip the phone's settings with the same stored JSON and startup path used on device.
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

test("old display choices migrate once and finished folding stays independent after restart", async () => {
  let stored = "";
  standIn("react-native", { Platform: { OS: "ios", isPad: false } });
  standIn("../src/state/keep", {
    readKept: async () => stored || null,
    keep: async (_key: string, json: string) => { stored = json; },
  });
  async function restart() {
    const path = load.resolve("../src/state/chatPrefs");
    delete load.cache[path];
    const prefs = load(path) as typeof import("../src/state/chatPrefs");
    await prefs.loadChatPrefs();
    return prefs;
  }
  const defaults = (await restart()).useChatPrefs.getState();
  assert.equal(defaults.foldFinishedSteps, true);
  assert.equal(defaults.steps, "folded");
  assert.equal(defaults.thinking, "folded");

  const fresh = await restart();
  fresh.setChatPrefs({ steps: "show" });
  await Promise.resolve();
  const picked = (await restart()).useChatPrefs.getState();
  assert.deepEqual([picked.steps, picked.foldFinishedSteps], ["show", true]);

  stored = JSON.stringify({ steps: "show", stepsPicked: true, thinking: "hide" });
  const prefs = await restart();
  assert.equal(prefs.useChatPrefs.getState().foldFinishedSteps, false);
  assert.equal(prefs.useChatPrefs.getState().thinking, "hide");
  prefs.setChatPrefs({ foldFinishedSteps: true });
  prefs.setChatPrefs({ steps: "show" });
  await Promise.resolve();
  assert.equal((await restart()).useChatPrefs.getState().foldFinishedSteps, true);

  stored = JSON.stringify({ steps: "hide", stepsPicked: true, thinking: "unexpected" });
  const oldHidden = (await restart()).useChatPrefs.getState();
  assert.deepEqual([oldHidden.steps, oldHidden.thinking, oldHidden.foldFinishedSteps], ["folded", "folded", true]);
  stored = JSON.stringify({ steps: "show", foldFinishedSteps: "no" });
  assert.equal((await restart()).useChatPrefs.getState().foldFinishedSteps, true);
});
