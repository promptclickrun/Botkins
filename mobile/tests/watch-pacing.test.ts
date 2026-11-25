// Exercise the production Watch coordinator with a fake native companion and clock.
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { test } from "node:test";

const load = createRequire(__filename);
load.extensions[".webp"] = (module, file) => { module.exports = file; };
function standIn(path: string, exports: unknown) {
  const id = load.resolve(path);
  const replacement = new Module(id);
  replacement.exports = exports;
  replacement.loaded = true;
  load.cache[id] = replacement;
}

test("Watch ignores other chats, paces its selected stream by reachability, and publishes attention changes immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updates: any[] = [];
  const progress: number[] = [];
  let reach: (event: unknown) => void = () => {};
  standIn("../modules/botkins-watch", { WatchCompanion: {
    start: async () => {},
    update: async (json: string) => { updates.push(JSON.parse(json)); },
    updateProgress: async (json: string) => { updates.push(JSON.parse(json)); progress.push(updates.length); },
    clear: async () => {},
    addListener(event: string, callback: typeof reach) {
      if (event === "reachability") reach = callback;
      return { remove() {} };
    },
  } });
  standIn("../src/features/open/opening", {});
  standIn("../src/features/watch/voice", {
    watchVoiceState: () => ({ status: "idle", muted: false, push: false, level: 0 }),
    subscribeWatchVoice: () => () => {},
    endWatchVoice() {},
  });
  let reads = 0;
  standIn("../src/state/link", { api: { "link.messages": async () => { reads++; return null; } } });
  const { useApp } = load("../src/state/store");
  const bot = { id: "b", name: "B", role: "", look: { head: "sprig", palette: "original" } };
  const chat = { id: "c", botId: "b", title: "Chat", count: 0, time: 1 };
  const live = { active: [], streams: { c: true }, thinking: {}, speakers: {}, intents: {}, requests: [], queued: {} };
  useApp.setState({ pairing: {serverId: "host", name: "Desktop"}, parts: { bots: [bot], chats: [chat], live },
    link: "online", chats: { c: { from: 0, total: 0, messages: [], runs: {} } } });
  const watch = load("../src/state/watch");
  await watch.startWatchCompanion();
  t.after(() => watch.stopWatchCompanion());
  reach({ paired: true, installed: true, reachable: true });
  assert.equal(updates.length, 1);
  const publishText = (id: string, text: string) => useApp.setState((s: any) =>
    ({ texts: { ...s.texts, [id]: { stream: text, thinking: "" } } }));
  publishText("other", "other thread");
  t.mock.timers.tick(20_000);
  assert.equal(updates.length, 1);
  for (let i = 0; i < 100; i++) publishText("c", String(i));
  t.mock.timers.tick(999);
  assert.equal(updates.length, 1);
  t.mock.timers.tick(1);
  assert.equal(updates.length, 2);
  assert.equal(updates.at(-1).chat.messages.at(-1).text, "99");
  reach({ paired: true, installed: true, reachable: false });
  publishText("c", "Latest part");
  t.mock.timers.tick(14_999);
  assert.equal(updates.length, 2);
  t.mock.timers.tick(1);
  assert.equal(updates.length, 3);
  useApp.setState((s: any) => ({ parts: { ...s.parts, live: { ...live, requests: [{chatId:"c"}] } } }));
  assert.equal(updates.at(-1).chat.activity, "Needs you");
  assert.deepEqual(progress, [2, 3], "initial state and attention use the durable bridge");
  assert.equal(reads, 0, "the complete local page needs no Watch-only RPC");
});
