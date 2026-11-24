// One provider session with one audio endpoint. React UI and the Watch companion both use this
// controller, so transcript/history, tools and turn control cannot drift between devices.
import type { LiveProvider } from "@/link/types";
import { loadDevicePrefs, useDevicePrefs } from "@/state/devicePrefs";
import { api } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { VoiceTurns } from "../../../../link-host/voice-history.mjs";
import { CallOutput } from "./routing";
import { callRoutes } from "../../../../modules/botkins-audio";
import { VoiceHistoryWriter } from "./history";
import { liveContext } from "./context";
import { chatTools, type Kit, type Line, type LiveStatus, type LiveTransport, planFor, socketTransport, watchRtcTransport, webrtcTransport } from "./index";
import type { Connect, InputMode, WatchRtcLike } from "./types";
import { chatAccess } from "../chatAccess";
import { readLocation } from "../location";
import { duplexAudio, webrtcModule } from "../native";
import { loadPhoneVoice, usePhoneVoice } from "../prefs";
import { effectiveLive } from "../botVoice";
import { botVoiceOf, voiceSettings } from "../state";
import { stopSpeech } from "../tts";

const UPDATE_APP = "Update the app to use this live voice.";

export type LiveAudioEndpoint = NonNullable<Kit["duplex"]>;
export type LiveSessionState = {
  status: LiveStatus;
  problem: string | null;
  started: boolean;
  muted: boolean;
  speaker: boolean;
  input: InputMode;
  holding: boolean;
  level: number;
  metered: boolean;
  savesTurns: boolean;
  savesHistory: boolean;
};
type Listener = (state: LiveSessionState) => void;

export type LiveSessionOptions = {
  chatId: string;
  botId: string;
  computer: string;
  provider: LiveProvider;
  kit: Kit;
  savesTurns: boolean;
  savesHistory: boolean;
};

const connect: Connect = (url, protocols, headers) => {
  const NativeSocket = WebSocket as unknown as new (url: string, protocols?: string[] | null, options?: { headers: Record<string, string> } | null) => import("./types").SocketLike & { binaryType: string };
  const socket = new NativeSocket(url, protocols ?? null, headers ? { headers } : null);
  socket.binaryType = "arraybuffer";
  return socket;
};

/** The normal iPhone kit. A Watch call replaces `duplex` (and the WebRTC endpoint when needed). */
export function phoneLiveKit(route: (speaker: boolean) => Promise<void>): Kit {
  return { callRoutes, webrtc: webrtcModule(), duplex: duplexAudio(), connect, route };
}

/** A companion endpoint uses the same socket transports, with Watch-owned input/output. */
export function companionLiveKit(duplex: LiveAudioEndpoint, watchRtc: WatchRtcLike | null): Kit {
  return { webrtc: null, duplex, watchRtc, connect, route: async () => {} };
}

export function selectedLiveProvider(botId: string): LiveProvider | null {
  const voice = voiceSettings();
  return voice ? effectiveLive(voice.live, botVoiceOf(botId)?.live).provider : null;
}

export class LiveSessionController {
  private state: LiveSessionState;
  private listeners = new Set<Listener>();
  private transport: LiveTransport | null = null;
  private offs: (() => void)[] = [];
  private sessionId: string | null = null;
  private writer: VoiceHistoryWriter | null = null;
  private ended = false;
  private started = false;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private output = new CallOutput();
  private lastMeter = 0;

  constructor(private readonly options: LiveSessionOptions) {
    this.state = {
      status: "connecting",
      problem: null,
      started: false,
      muted: false,
      speaker: false,
      input: "conversation",
      holding: false,
      level: 0,
      metered: false,
      savesTurns: options.savesTurns,
      savesHistory: options.savesHistory,
    };
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => void this.listeners.delete(listener);
  }

  get current() {
    return this.state;
  }

  get session() {
    return this.sessionId;
  }

  private update(next: Partial<LiveSessionState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  private sameComputer = () => useApp.getState().pairing?.serverId === this.options.computer;

  private endRemote(id: string) {
    void this.writer?.flush().then(() => {
      if (this.sameComputer()) return api["link.voice.endLive"](id);
    }).catch(() => {});
  }

  private attach(next: LiveTransport, history: {
    heard(line: Line): void;
    inputItem(id: string): void;
  }) {
    this.transport = next;
    const routes = this.options.kit.callRoutes;
    if (routes) {
      const refresh = () => {
        if (this.ended || !this.output.devicesChanged(routes.accessory())) return;
        this.update({ speaker: this.output.speaker });
        void Promise.resolve(next.setSpeaker(this.output.speaker)).catch(() => {});
      };
      const subscription = routes.addListener("devicesChanged", refresh);
      this.offs.push(() => subscription.remove());
      refresh();
    }
    this.offs.push(
      next.on("status", (status) => {
        if (status === "ended") { this.end(this.state.problem ?? undefined); return; }
        this.update({ status });
      }),
      next.on("line", history.heard),
      next.on("level", (level) => {
        const now = Date.now();
        if (now - this.lastMeter < 80) return;
        this.lastMeter = now;
        this.update({ level: Math.max(0, Math.min(level, 1)), metered: true });
      }),
      next.on("inputItem", history.inputItem),
      next.on("error", (problem) => {
        this.update({ problem });
        if (this.errorTimer) clearTimeout(this.errorTimer);
        this.errorTimer = setTimeout(() => {
          if (!this.ended && next.status !== "ended") this.update({ problem: null });
          this.errorTimer = null;
        }, 5_000);
      }),
    );
  }

  async start() {
    if (this.started || this.ended) return;
    this.started = true;
    const { chatId, botId, provider } = this.options;
    const plan = planFor(provider, this.options.kit);
    if (!plan) {
      this.update({ status: "ended", problem: UPDATE_APP });
      void this.options.kit.duplex?.stop().catch(() => {});
      return;
    }
    stopSpeech();
    this.update({ started: true });

    const writer = new VoiceHistoryWriter(
      async (line) => {
        if (!this.sameComputer()) throw new Error("Computer changed.");
        if (line.who === "bot" && this.sessionId) {
          await api.recordVoiceLine(chatId, line.id, line.text, line.final, { role: "assistant", sessionId: this.sessionId, afterVoiceId: line.afterVoiceId });
        } else {
          await api.recordVoiceLine(chatId, line.id, line.text, line.final);
        }
      },
      () => showToast("Couldn't save a voice message to this chat.", "error"),
    );
    this.writer = writer;

    let turns: VoiceTurns | undefined;
    const history = () => turns ??= new VoiceTurns(this.sessionId!);
    let lastSpeech: Line | undefined;
    let claimed: string | undefined;
    const heard = (line: Line) => {
      if (!this.sessionId || (provider === "codex" && (this.options.savesTurns || (line.who === "you" && this.options.savesHistory)))) return;
      if (this.options.savesTurns) {
        const turn = history();
        if (line.who === "you") writer.put({ ...line, id: turn.input("input-" + line.id) });
        else {
          const { afterVoiceId } = turn.output(line.id);
          writer.put({ ...line, id: this.sessionId + ":output-" + line.id, afterVoiceId });
          if (line.final) turn.finishOutput(line.id);
        }
      } else if (line.who === "you" && this.options.savesHistory) {
        lastSpeech = { ...line, id: this.sessionId + ":" + line.id };
        writer.put(lastSpeech);
      }
    };
    const inputItem = (item: string) => {
      if (this.sessionId && this.options.savesTurns && provider !== "codex") history().start("input-" + item);
    };
    const run = chatTools(chatAccess(chatId), undefined, (text) => {
      if (this.options.savesTurns && this.sessionId) return history().claim();
      if (!lastSpeech || lastSpeech.id === claimed || lastSpeech.text.trim() !== text.trim()) return;
      claimed = lastSpeech.id;
      return claimed;
    });
    let held: LiveTransport | null = null;
    try {
      await loadPhoneVoice();
      const mode = usePhoneVoice.getState().liveInput;
      this.update({ input: mode });
      const where = loadDevicePrefs()
        .then(() => liveContext(useDevicePrefs.getState().sources, readLocation))
        .catch(() => undefined);
      if (this.ended || !this.sameComputer()) return;
      if (plan === "offer") {
        const negotiate = async (sdp: string) => {
          const context = await where;
          if (this.ended || !this.sameComputer()) throw new Error("The call has ended.");
          const session = await api["link.voice.live"]({ chatId, botId, provider, sdp, ...(context && { context }) });
          this.sessionId = session.id;
          if (this.ended) this.endRemote(session.id);
          if (session.kind !== "webrtc") throw new Error(UPDATE_APP + ".");
          return session;
        };
        const next = this.options.kit.watchRtc
          ? watchRtcTransport(this.options.kit, negotiate, run, voiceSettings()?.stt.language)
          : webrtcTransport(this.options.kit, negotiate, run, voiceSettings()?.stt.language);
        held = next;
        next.setInput(mode);
        this.attach(next, { heard, inputItem });
        await next.start();
      } else {
        const context = await where;
        if (this.ended || !this.sameComputer()) return;
        const session = await api["link.voice.live"]({ chatId, botId, provider, ...(context && { context }) });
        this.sessionId = session.id;
        if (this.ended) return this.endRemote(session.id);
        const next = socketTransport(session, this.options.kit, run);
        if (!next) throw new Error(UPDATE_APP);
        held = next;
        next.setInput(mode);
        this.attach(next, { heard, inputItem });
        await next.start();
      }
      if (this.ended) held.end();
    } catch (error) {
      if (this.ended) return;
      this.end(error instanceof Error && error.message ? error.message : "Live voice couldn't start.");
    }
  }

  toggleMute() {
    const muted = !this.state.muted;
    this.update({ muted });
    this.transport?.mute(muted);
  }

  toggleSpeaker() {
    this.output.toggle();
    const speaker = this.output.speaker;
    this.update({ speaker });
    void Promise.resolve(this.transport?.setSpeaker(speaker)).catch(() => {});
  }

  interrupt() {
    this.transport?.interrupt();
  }

  press() {
    if (this.state.holding || !this.started || this.ended) return;
    this.update({ holding: true });
    this.transport?.press();
  }

  release() {
    if (!this.state.holding) return;
    this.update({ holding: false });
    this.transport?.release();
  }

  end(reason?: string) {
    if (this.ended) return;
    this.ended = true;
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = null;
    this.transport?.end();
    if (!this.transport) void this.options.kit.duplex?.stop().catch(() => {});
    for (const off of this.offs) off();
    this.offs = [];
    this.options.kit.callRoutes?.endCall?.();
    const id = this.sessionId;
    if (id) this.endRemote(id);
    this.update({ status: "ended", started: false, holding: false, problem: reason ?? this.state.problem });
    this.transport = null;

  }
}
