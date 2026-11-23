// Exercise the app entry points with stand-ins for iOS, the paired host and the router.
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { test } from "node:test";
import { create } from "zustand";
import type { DeviceLevel } from "../src/link/types";

const load = createRequire(__filename);
function replaceModule(path: string, exports: unknown) {
  const id = load.resolve(path);
  const replacement = new Module(id);
  replacement.exports = exports;
  replacement.loaded = true;
  load.cache[id] = replacement;
}

test("the chat shortcut switches computers, opens latest or new, and rejects stale selections", async () => {
  const state = {
    pairing: { serverId: "home" },
    pairings: [{ serverId: "home" }, { serverId: "work" }],
    parts: { bots: [{ id: "archived", hidden: true }, { id: "primary" }, { id: "other" }] },
  };
  const opened: string[] = [];
  const signal = new AbortController().signal;
  replaceModule("react-native", { AppState: { currentState: "active" } });
  replaceModule("../src/state/store", { useApp: { getState: () => state } });
  replaceModule("../src/state/link", {
    switchComputer: async (id: string) => { state.pairing.serverId = id; },
    api: { createChat: async (bot: string) => "new-" + bot },
    attempt: (result: Promise<string>) => result,
  });
  replaceModule("../src/features/open/opening", {
    whenSynced: async () => true,
    lastOrNewChat: async (bot: string) => "latest-" + bot,
    showChat: (chat: string) => opened.push(state.pairing.serverId + "/" + chat),
  });
  const { startOpenShortcut } = load("../src/features/shortcuts/open") as typeof import("../src/features/shortcuts/open");
  await startOpenShortcut(undefined, undefined, "latest", signal);
  await startOpenShortcut("work", "other", "new", signal, "work");
  await assert.rejects(startOpenShortcut("home", "other", "new", signal, "work"), /selected computer/);
  await assert.rejects(startOpenShortcut("removed", undefined, "new", signal), /pair/);
  await assert.rejects(startOpenShortcut("work", "archived", "latest", signal), /available bot/);
  assert.deepEqual(opened, ["home/latest-primary", "work/new-other"]);
});

test("Apple Music tools enforce the device grant and bound the results of a multi-type search", async () => {
  const prefs = create(() => ({ sources: { music: "off" as DeviceLevel } }));
  let revision = 0;
  const controls: string[] = [];
  replaceModule("../src/state/devicePrefs", { loadDevicePrefs: async () => {}, useDevicePrefs: prefs });
  replaceModule("../modules/botkins-music", { BotkinsMusic: {
    setGrant: (next: number) => { revision = next; },
    authorization: async () => "authorized",
    canPlayCatalog: async () => true,
    search: async () => ["song", "song", "album", "album"].map((type, index) => ({
      type, id: String(index), title: "T".repeat(500), source: "catalog",
    })),
    control: async (action: string, grant: number) => {
      assert.equal(grant, revision);
      controls.push(action);
      return { state: "paused" };
    },
  } });
  const { musicTools } = load("../src/device/music") as typeof import("../src/device/music");
  await assert.rejects(musicTools.phone_music_search({ query: "track" }), /off on this phone/);
  prefs.setState({ sources: { music: "read" } });
  const result = await musicTools.phone_music_search({ query: "track", types: ["song", "album"], limit: 2 });
  assert.deepEqual(result.results.map(item => item.id), ["0", "2"]);
  assert.ok(result.results.every(item => item.title && item.title.length <= 200));
  await assert.rejects(musicTools.phone_music_control({ action: "pause" }), /read only/);
  prefs.setState({ sources: { music: "interact" } });
  await musicTools.phone_music_control({ action: "pause" });
  const allowedRevision = revision;
  prefs.setState({ sources: { music: "off" } });
  assert.ok(revision > allowedRevision);
  await assert.rejects(musicTools.phone_music_control({ action: "pause" }), /off on this phone/);
  assert.deepEqual(controls, ["pause"]);
});

test("a Watch audio endpoint plays the first reply and accepts microphone frames only from its own session", async () => {
  const sent: string[] = [];
  const frames: string[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  replaceModule("../modules/botkins-watch", { WatchCompanion: {
    addListener(name: string, handler: (event: unknown) => void) {
      handlers.set(name, handler);
      return { remove: () => handlers.delete(name) };
    },
    voiceStarted: async () => {},
    voiceEnded: async () => {},
    play: (session: string, pcm: string) => sent.push(session + "/" + pcm),
    flush: (session: string) => sent.push(session + "/flush"),
  } });
  const { WatchAudioEndpoint } = load("../src/features/watch/audio") as typeof import("../src/features/watch/audio");
  const endpoint = new WatchAudioEndpoint("current");
  endpoint.addListener("frame", event => frames.push(event.data));
  await endpoint.start({ inputRate: 16000, outputRate: 24000 });
  endpoint.play("response");
  endpoint.flush();
  handlers.get("frame")?.({ sessionId: "old", data: "stale", level: 1 });
  handlers.get("frame")?.({ sessionId: "current", data: "speech", level: 1 });
  await endpoint.stop();
  endpoint.play("late");
  assert.deepEqual(sent, ["current/response", "current/flush"]);
  assert.deepEqual(frames, ["speech"]);
  assert.equal(handlers.size, 0);
});
