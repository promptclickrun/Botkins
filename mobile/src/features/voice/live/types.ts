// What every live voice transport shares: its interface, its events, and the small base class that
// keeps the transcript and runs tools. Pure (no React Native), so the tests run the transports
// against a fake socket and a fake sound module. A transport never logs audio or a token.
import { type InputMode, MicGate, SPEECH_LEVEL } from "./input";

export type { InputMode } from "./input";
export type LiveStatus = "connecting" | "listening" | "thinking" | "talking" | "ended";
export type Line = { id: string; who: "you" | "bot"; text: string; final: boolean };

/** Runs a tool the voice called and answers with what the voice should hear (a string). */
export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<string>;

/** `level`: how loud whoever has the sound is, 0 to 1 (the bot while its sound plays, else the microphone). */
type Events = { status: LiveStatus; inputItem: string; line: Line; error: string; level: number };
/** The least time between two `level` events: the dock's sound strip needs no more. */
export const LEVEL_EVERY_MS = 100;

/** The part of a WebSocket a transport uses. React Native's and the tests' fake both fit. */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
};
export type Connect = (url: string, protocols?: string[], headers?: Record<string, string>) => SocketLike;

/** The part of `DuplexAudio` (modules/botkins-audio) a transport uses. */
export type AudioFrame = { data: string; level: number };
export type DuplexLike = {
  start(options: { inputRate: number; outputRate: number; speaker?: boolean }): Promise<void>;
  play(base64: string): void;
  flush(): void;
  setMuted(muted: boolean): void;
  setSpeaker(on: boolean): void;
  stop(): Promise<void>;
  addListener(name: "frame", listener: (frame: AudioFrame) => void): { remove(): void };
  addListener(name: "output", listener: (event: { level: number }) => void): { remove(): void };
  addListener(name: "interrupted", listener: (event: { began: boolean; failed?: boolean }) => void): { remove(): void };
};

/** The iPhone's custom WebRTC audio device for a WebRTC-only Watch session. */
export type WatchRtcLike = {
  readonly sessionId: string;
  start(): Promise<string>;
  answer(sdp: string): Promise<void>;
  send(event: string): void;
  input(enabled: boolean): void;
  flush(): void;
  end(): Promise<void>;
  onMessage(listener: (message: string) => void): { remove(): void };
  onState(listener: (state: "open" | "connected" | "failed" | "closed") => void): { remove(): void };
  onLevel(listener: (level: { mic: number; output: number }) => void): { remove(): void };
  onInterrupted(listener: (failed: boolean) => void): { remove(): void };
};

export interface LiveTransport {
  /** How the microphone is used: hands-free, or only while the talk button is held. Set before `start`. */
  setInput(mode: InputMode): void;
  readonly input: InputMode;
  /** Connects and starts both ways. Rejects with a plain sentence. */
  start(): Promise<void>;
  mute(muted: boolean): void;
  /** The speaker (true) or the earpiece. */
  setSpeaker(on: boolean): void | Promise<void>;
  /** Stops the bot's sound and its response at once; the phone listens. */
  interrupt(): void;
  /** Push to talk: the talk button went down (the bot stops first) and came up (the turn is sent). */
  press(): void;
  release(): void;
  /** Ends at once. Safe to call more than once. */
  end(): void;
  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void;
  readonly status: LiveStatus;
}

export const OPEN = 1;

/** Reads a socket message as text: a string, or UTF-8 bytes (some servers send JSON in binary frames). */
export function textOf(data: unknown): string | null {
  if (typeof data === "string") return data;
  let bytes: Uint8Array | null = null;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (!bytes) return null;
  return utf8(bytes);
}

/** UTF-8 to a string, without relying on TextDecoder. */
export function utf8(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const a = bytes[i++]!;
    let code = a;
    if (a >= 0xf0) code = ((a & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    else if (a >= 0xe0) code = ((a & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    else if (a >= 0xc0) code = ((a & 0x1f) << 6) | (bytes[i++]! & 0x3f);
    out += String.fromCodePoint(code);
  }
  return out;
}

export function parseJson(data: unknown): Record<string, unknown> | null {
  const text = textOf(data);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
export const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Arguments a model sent as a JSON string, or as an object already. */
export function argsOf(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return obj(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return obj(value);
}

/** The transcript, the status and tool calls, the same for every transport. */
export abstract class LiveBase implements LiveTransport {
  status: LiveStatus = "connecting";
  private listeners: { [K in keyof Events]: Set<(value: Events[K]) => void> } = { status: new Set(), inputItem: new Set(), line: new Set(), error: new Set(), level: new Set() };
  private lines = new Map<string, Line>();
  private toolsRunning = 0;
  protected ended = false;
  /** When the microphone is sent (input.ts). A transport with its own clock or quiet replaces it. */
  protected gate = new MicGate("conversation");
  /** The time, for pacing `level`. A transport given a clock of its own sets it. */
  protected clock: () => number = Date.now;
  private heard = { mic: 0, out: 0, told: 0 };
  /** The loudest the microphone was while it was sent in this push-to-talk turn, and whether this call reports microphone levels at all. */
  private turnPeak = 0;
  private metered = false;

  constructor(protected readonly runTool: ToolRunner) {}

  abstract start(): Promise<void>;
  abstract mute(muted: boolean): void;
  abstract setSpeaker(on: boolean): void | Promise<void>;
  abstract interrupt(): void;
  abstract press(): void;
  abstract release(): void;
  protected abstract close(): void;

  setInput(mode: InputMode) {
    this.gate = this.gate.withMode(mode);
  }
  get input(): InputMode {
    return this.gate.mode;
  }

  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void) {
    const set = this.listeners[event] as Set<(value: Events[K]) => void>;
    set.add(listener);
    return () => void set.delete(listener);
  }
  protected emit<K extends keyof Events>(event: K, value: Events[K]) {
    for (const listener of [...(this.listeners[event] as Set<(value: Events[K]) => void>)]) listener(value);
  }

  /** A transport says how loud the microphone or the bot's sound is now; listeners hear of it at a slow, even pace. */
  protected hears(sound: { mic?: number; out?: number }) {
    if (this.ended) return;
    if (sound.mic !== undefined) {
      this.metered = true;
      if (this.gate.open()) this.turnPeak = Math.max(this.turnPeak, sound.mic);
    }
    Object.assign(this.heard, sound);
    const now = this.clock();
    if (now - this.heard.told < LEVEL_EVERY_MS) return;
    this.heard.told = now;
    this.emit("level", this.heard.out > 0.02 ? this.heard.out : this.heard.mic);
  }

  /** A new push-to-talk turn begins (not a press that goes on with the last turn). */
  protected startTurn() {
    this.turnPeak = 0;
  }

  /** The turn just held had no speech in it. A call that reports no microphone level can't tell, so it never says so. */
  protected get quietTurn(): boolean {
    return this.metered && this.turnPeak < SPEECH_LEVEL;
  }

  protected setStatus(status: LiveStatus) {
    if (this.ended && status !== "ended") return;
    // While a tool runs the bot is thinking, whatever the sound does.
    if (this.toolsRunning > 0 && status !== "thinking" && status !== "ended") return;
    if (status === this.status) return;
    this.status = status;
    this.emit("status", status);
  }

  /** Adds to a line (`append`) or replaces its text. */
  protected line(id: string, who: Line["who"], text: string, options: { append?: boolean; final?: boolean } = {}) {
    if (this.ended || !id) return;
    const held = this.lines.get(id);
    if (held?.final && (who === "you" || !options.final)) return;
    const words = options.append && held ? held.text + text : text;
    const next: Line = { id, who, text: options.final && !words.trim() && held ? held.text : words, final: !!options.final };
    if (!next.text.trim() && !held) return;
    this.lines.set(id, next);
    // Only the last lines matter; old ones are forgotten.
    if (this.lines.size > 40) this.lines.delete(this.lines.keys().next().value!);
    this.emit("line", next);
  }

  protected fail(message: string) {
    if (this.ended) return;
    this.emit("error", message);
    this.end();
  }

  /** Runs a tool and answers with a string, never throwing. */
  protected async tool(name: string, args: Record<string, unknown>): Promise<{ output: string; error: boolean }> {
    this.toolsRunning += 1;
    this.setStatusNow("thinking");
    try {
      return { output: await this.runTool(name, args), error: false };
    } catch (error) {
      return { output: error instanceof Error && error.message ? error.message : "That didn't work.", error: true };
    } finally {
      this.toolsRunning -= 1;
      if (this.toolsRunning === 0) this.setStatus("listening");
    }
  }
  private setStatusNow(status: LiveStatus) {
    if (this.ended || status === this.status) return;
    this.status = status;
    this.emit("status", status);
  }

  end() {
    if (this.ended) return;
    for (const line of this.lines.values()) {
      if (!line.final) this.line(line.id, line.who, line.text, { final: true });
    }
    this.ended = true;
    try {
      this.close();
    } catch {
      // Closing is best effort.
    }
    this.status = "ended";
    this.emit("status", "ended");
  }
}

/**
 * The "talking" state from the level of what plays: talking while sound comes out, listening once
 * it has been quiet for a moment.
 */
export class OutputLevel {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly set: (talking: boolean) => void, private readonly quietMs = 700) {}
  level(value: number) {
    if (value > 0.02) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.set(true);
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.set(false);
      }, this.quietMs);
    }
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
