// A DuplexLike implementation backed by WatchConnectivity. Socket transports see ordinary PCM
// frames; they do not know whether the microphone and speaker belong to iPhone or Watch.
import { WatchCompanion, type WatchAudioFrame } from "../../../modules/botkins-watch";
import type { DuplexLike, AudioFrame, WatchRtcLike } from "@/features/voice/live/types";

type EventName = "frame" | "output" | "interrupted";
type WatchEvents = {
  frame: AudioFrame;
  output: { level: number };
  interrupted: { began: boolean; failed?: boolean };
};
type Listener = { [Key in EventName]: Set<(event: WatchEvents[Key]) => void> };

export class WatchAudioEndpoint implements DuplexLike {
  private listeners: Listener = { frame: new Set(), output: new Set(), interrupted: new Set() };
  private native: { remove(): void }[] = [];
  private running = false;
  private stopped = false;
  private muted = false;
  readonly rtc: WatchRtcLike | null;

  constructor(readonly sessionId: string) {
    if (!WatchCompanion) {
      this.rtc = null;
      return;
    }
    const native = WatchCompanion;
    this.rtc = {
      sessionId,
      start: async () => {
        if (this.stopped) throw new Error("The Watch call ended.");
        const sdp = await native.rtcStart(sessionId);
        if (this.stopped) {
          await native.rtcEnd(sessionId);
          throw new Error("The Watch call ended.");
        }
        this.running = true;
        return sdp;
      },
      answer: (sdp) => native.rtcAnswer(sessionId, sdp),
      send: (message) => native.rtcSend(sessionId, message),
      input: (enabled) => native.rtcInput(sessionId, enabled),
      flush: () => native.rtcFlush(sessionId),
      end: async () => {
        try {
          await native.rtcEnd(sessionId);
        } finally {
          await this.stop();
        }
      },
      onMessage: (listener) =>
        native.addListener("rtcMessage", (event) => {
          if (event.sessionId === sessionId) listener(event.message);
        }),
      onState: (listener) =>
        native.addListener("rtcState", (event) => {
          if (event.sessionId === sessionId) listener(event.state);
        }),
      onLevel: (listener) =>
        native.addListener("rtcLevel", (event) => {
          if (event.sessionId === sessionId) listener({ mic: event.mic, output: event.output });
        }),
      onInterrupted: (listener) =>
        native.addListener("rtcInterrupted", (event) => {
          if (event.sessionId === sessionId) listener(!!event.failed);
        }),
    };
    this.native.push(
      native.addListener("frame", (event: WatchAudioFrame) => {
        if (!this.running || this.muted || event.sessionId !== this.sessionId) return;
        for (const listener of this.listeners.frame) listener({ data: event.data, level: event.level });
      }),
      native.addListener("output", (event) => {
        if (this.running && event.sessionId === this.sessionId) {
          for (const listener of this.listeners.output) listener({ level: event.level });
        }
      }),
      native.addListener("interrupted", (event) => {
        if (event.sessionId === this.sessionId) {
          for (const listener of this.listeners.interrupted) listener({ began: event.began, failed: event.failed });
        }
      }),
    );
  }

  async start(options: { inputRate: number; outputRate: number; speaker?: boolean }) {
    if (!WatchCompanion) throw new Error("This Botkins build has no Watch companion.");
    if (this.stopped) throw new Error("The Watch call ended.");
    await WatchCompanion.voiceStarted(this.sessionId, options.inputRate, options.outputRate);
    if (this.stopped) {
      await WatchCompanion.voiceEnded(this.sessionId, null);
      throw new Error("The Watch call ended.");
    }
    this.running = true;
  }

  play(base64: string) {
    if (!WatchCompanion || !this.running) return;
    WatchCompanion.play(this.sessionId, base64);
  }

  flush() {
    if (WatchCompanion && this.running) WatchCompanion.flush(this.sessionId);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  setSpeaker(_on: boolean) {
    // A Watch-owned session always uses the Watch's current audio route.
  }

  async stop() {
    this.stopped = true;
    const started = this.running;
    this.running = false;
    for (const subscription of this.native.splice(0)) subscription.remove();
    if (started && WatchCompanion) await WatchCompanion.voiceEnded(this.sessionId, null);
  }

  addListener<Key extends EventName>(name: Key, listener: (event: WatchEvents[Key]) => void): { remove(): void } {
    const set = this.listeners[name] as Set<(event: WatchEvents[Key]) => void>;
    set.add(listener);
    return { remove: () => set.delete(listener) };
  }
}
