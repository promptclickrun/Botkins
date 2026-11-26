import assert from "node:assert/strict";
import { test } from "node:test";
import { WatchRTCTransport } from "../src/features/voice/live/watch-rtc";
import type { WatchRtcLike } from "../src/features/voice/live/types";
import { planFor } from "../src/features/voice/live";

class FakeWatchRTC implements WatchRtcLike {
  readonly sessionId = "watch-local";
  answerValue = "";
  sent: Record<string, unknown>[] = [];
  inputs: boolean[] = [];
  flushed = 0;
  ended = false;
  private messages = new Set<(message: string) => void>();
  private states = new Set<(state: "open" | "connected" | "failed" | "closed") => void>();
  private levels = new Set<(level: { mic: number; output: number }) => void>();
  private interruptions = new Set<(failed: boolean, problem?: string) => void>();

  async start() {
    queueMicrotask(() => this.state("open"));
    return "v=0 watch-offer";
  }
  async answer(sdp: string) { this.answerValue = sdp; }
  send(message: string) { this.sent.push(JSON.parse(message)); }
  input(enabled: boolean) { this.inputs.push(enabled); }
  flush() { this.flushed += 1; }
  async end() { this.ended = true; this.state("closed"); }
  onMessage(listener: (message: string) => void) { this.messages.add(listener); return { remove: () => this.messages.delete(listener) }; }
  onState(listener: (state: "open" | "connected" | "failed" | "closed") => void) { this.states.add(listener); return { remove: () => this.states.delete(listener) }; }
  onLevel(listener: (level: { mic: number; output: number }) => void) { this.levels.add(listener); return { remove: () => this.levels.delete(listener) }; }
  onInterrupted(listener: (failed: boolean, problem?: string) => void) { this.interruptions.add(listener); return { remove: () => this.interruptions.delete(listener) }; }
  state(value: "open" | "connected" | "failed" | "closed") { for (const listener of this.states) listener(value); }
  message(value: Record<string, unknown>) { for (const listener of this.messages) listener(JSON.stringify(value)); }
  level(mic: number, output: number) { for (const listener of this.levels) listener({ mic, output }); }
  interrupt(failed = false, problem?: string) { for (const listener of this.interruptions) listener(failed, problem); }
}

test("Watch WebRTC sends provider events while feeding the Watch as the peer audio device", async () => {
  const rtc = new FakeWatchRTC();
  const offered: string[] = [];
  const transport = new WatchRTCTransport(
    rtc,
    async (sdp) => {
      offered.push(sdp);
      return { id: "codex-1", kind: "webrtc", sdp: "v=0 codex-answer" };
    },
    async () => "tool result",
  );
  const statuses: string[] = [];
  transport.on("status", (status) => statuses.push(status));
  await transport.start();
  assert.deepEqual(offered, ["v=0 watch-offer"]);
  assert.equal(rtc.answerValue, "v=0 codex-answer");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rtc.sent[0]?.type, "session.update");
  assert.ok(statuses.includes("listening"));

  rtc.message({ type: "output_audio_buffer.started" });
  assert.ok(rtc.inputs.at(-1) === false, "Watch mic closes while the Botkin speaks");
  rtc.level(0.1, 0.5);
  rtc.interrupt();
  assert.equal(rtc.flushed, 1);
  assert.ok(rtc.inputs.at(-1) === true, "Watch mic opens after interruption");

  transport.mute(true);
  assert.equal(rtc.inputs.at(-1), false);
  transport.end();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rtc.ended, true);
});

test("Codex selects the Watch native WebRTC endpoint without needing the iPhone microphone", () => {
  const rtc = new FakeWatchRTC();
  assert.equal(planFor("codex", { webrtc: null, duplex: null, watchRtc: rtc }), "offer");
  assert.equal(planFor("codex", { webrtc: null, duplex: null, watchRtc: null }), null);
});

test("a lost Watch connection fails the WebRTC transport instead of quietly switching audio", async () => {
  const rtc = new FakeWatchRTC();
  const transport = new WatchRTCTransport(
    rtc,
    async () => ({ id: "codex-2", kind: "webrtc", sdp: "v=0 answer" }),
    async () => "",
  );
  const errors: string[] = [];
  transport.on("error", (error) => errors.push(error));
  await transport.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  rtc.interrupt(true);
  assert.equal(transport.status, "ended");
  assert.match(errors[0] ?? "", /lost their connection/i);
});

test("Watch WebRTC reports the Watch audio recovery error when resuming fails", async () => {
  const rtc = new FakeWatchRTC();
  const transport = new WatchRTCTransport(rtc, async () => ({ id: "voice", kind: "webrtc", sdp: "answer" }), async () => "");
  const errors: string[] = [];
  transport.on("error", (error) => errors.push(error));
  await transport.start();
  const problem = "Watch audio could not resume. The microphone is unavailable.";
  rtc.interrupt(true, problem);
  assert.deepEqual(errors, [problem]);
  assert.equal(transport.status, "ended");
});

test("startWatchVoice acquires watch hold and syncs a sleeping/offline link before starting live voice", async () => {
  const Module = (await import("node:module")).default;
  const { createRequire } = await import("node:module");
  const load = createRequire(__filename);
  load.extensions[".webp"] = (mod: any, file: string) => { mod.exports = file; };
  const standIn = (path: string, exports: unknown) => {
    const id = load.resolve(path);
    const replacement = new Module(id);
    replacement.exports = exports;
    replacement.loaded = true;
    load.cache[id] = replacement;
  };

  const events: string[] = [];
  const bot = { id: "bot-1", name: "Gordie", role: "Assistant", look: { head: "sprig", palette: "original" } };
  const chat = { id: "chat-1", botId: "bot-1", title: "Chat", count: 0, time: 1 };
  const { useApp } = load("../src/state/store");
  useApp.setState({
    booted: true,
    pairing: { serverId: "host-1", name: "Mac" },
    link: "connecting",
    parts: { bots: [], chats: [] },
  });

  standIn("../src/state/link", {
    holdBackgroundLink: (reason: string) => {
      events.push(`hold:${reason}`);
      return () => { events.push(`release:${reason}`); };
    },
    syncForPush: async () => {
      events.push("syncForPush");
      useApp.setState({ link: "online", parts: { bots: [bot], chats: [chat] } });
      return true;
    },
    api: {},
  });
  standIn("../src/features/open/opening", {
    lastOrNewChat: async (botId: string) => {
      events.push(`lastOrNewChat:${botId}`);
      return chat.id;
    },
  });
  standIn("../src/features/voice/liveCall", {
    useLiveCall: {
      subscribe: () => () => {},
      getState: () => ({ call: null }),
    },
  });
  standIn("../src/features/watch/audio", {
    WatchAudioEndpoint: class {
      rtc = null;
      constructor(readonly sessionId: string) {}
    },
  });
  standIn("../src/features/voice/live/session", {
    companionLiveKit: (duplex: unknown, watchRtc: unknown) => ({ webrtc: null, duplex, watchRtc }),
    selectedLiveProvider: (botId: string) => {
      events.push(`selectedLiveProvider:${botId}`);
      return "gemini";
    },
    LiveSessionController: class {
      current = { status: "listening", muted: false, input: "vad", level: 0, problem: null };
      private listeners = new Set<(state: any) => void>();
      subscribe(fn: (state: any) => void) { this.listeners.add(fn); }
      async start() {
        events.push("controller.start");
        for (const fn of this.listeners) fn(this.current);
      }
      end() {
        events.push("controller.end");
      }
    },
  });

  delete load.cache[load.resolve("../src/features/watch/voice")];
  const { startWatchVoice, endWatchVoice, watchVoiceState } = load("../src/features/watch/voice");
  await startWatchVoice();
  assert.equal(watchVoiceState().status, "listening");
  assert.deepEqual(events, [
    "hold:watch",
    "syncForPush",
    "selectedLiveProvider:bot-1",
    "lastOrNewChat:bot-1",
    "controller.start",
    "release:watch",
  ]);
  endWatchVoice();
});
