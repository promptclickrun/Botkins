// Microphone gating for live voice. Botkins never sends microphone frames while the bot is
// speaking, or during the short room-echo tail afterwards. Push to talk uses the same gate and
// only opens while the talk key is held.

export type InputMode = "conversation" | "push";

export const ECHO_TAIL_MS = 400;
export const CUT_SETTLE_MS = 250;
export const RELEASE_TAIL_MS = 250;
export const MIN_TURN_MS = 250;
export const BARGE_IN = { min: 0.2, ratio: 3, frames: 5 };
export const SOUND_LEVEL = 0.02;

export type FrameDecision = { send: string[]; barge: boolean };

export function silenceLike(data: string) {
  return data.replace(/[^=]/g, "A");
}

/**
 * Decides which microphone frames can leave the app. The `silence` mode is for providers such as
 * ElevenLabs that need a continuous stream to detect the end of a turn.
 */
export class MicGate {
  readonly mode: InputMode;
  private readonly now: () => number;
  private readonly quiet: "drop" | "silence";
  private until = -Infinity;
  private cutAt = -Infinity;
  private sounding = false;
  private held = false;
  private pressedAt = 0;
  private releasedAt = -Infinity;
  private echo = 0;
  private loud: string[] = [];

  constructor(
    mode: InputMode,
    now: () => number = Date.now,
    quiet: "drop" | "silence" = "drop",
  ) {
    this.mode = mode;
    this.now = now;
    this.quiet = quiet;
  }

  queued(ms: number) {
    if (!(ms > 0)) return;
    const now = this.now();
    this.until = Math.max(this.until, now) + ms;
  }

  level(value: number) {
    const now = this.now();
    if (value > SOUND_LEVEL && now - this.cutAt >= CUT_SETTLE_MS) this.until = Math.max(this.until, now);
  }

  playing(on: boolean) {
    if (on === this.sounding) return;
    this.sounding = on;
    if (!on) this.until = Math.max(this.until, this.now());
  }

  cut() {
    this.sounding = false;
    this.until = -Infinity;
    this.cutAt = this.now();
    this.loud = [];
  }

  botSounding() {
    return this.sounding || this.now() < this.until + ECHO_TAIL_MS;
  }

  get holding() {
    return this.held;
  }

  press() {
    this.held = true;
    this.pressedAt = this.now();
    this.loud = [];
  }

  release() {
    if (!this.held) return 0;
    this.held = false;
    this.releasedAt = this.now();
    return this.releasedAt - this.pressedAt;
  }

  open() {
    if (this.mode === "push") return this.held || this.now() < this.releasedAt + RELEASE_TAIL_MS;
    return !this.botSounding();
  }

  wait(): number | null {
    const now = this.now();
    if (this.mode === "push") return !this.held && now < this.releasedAt + RELEASE_TAIL_MS ? this.releasedAt + RELEASE_TAIL_MS - now : null;
    if (this.sounding) return null;
    return now < this.until + ECHO_TAIL_MS ? this.until + ECHO_TAIL_MS - now : null;
  }

  frame(data: string, level: number): FrameDecision {
    if (this.open()) {
      const send = this.loud.length ? [...this.loud.map((held) => this.closed(held)), data] : [data];
      this.loud = [];
      return { send: send.filter(Boolean), barge: false };
    }
    if (this.mode === "push") return { send: this.quietOf(data), barge: false };
    if (level >= Math.max(BARGE_IN.min, this.echo * BARGE_IN.ratio)) {
      this.loud.push(data);
      if (this.loud.length < BARGE_IN.frames) return { send: [], barge: false };
      const send = this.loud;
      this.loud = [];
      return { send, barge: true };
    }
    this.echo = this.echo === 0 ? level : this.echo * 0.9 + level * 0.1;
    const send = [...this.loud.flatMap((held) => this.quietOf(held)), ...this.quietOf(data)];
    this.loud = [];
    return { send, barge: false };
  }

  private quietOf(data: string) {
    return this.quiet === "silence" ? [silenceLike(data)] : [];
  }

  private closed(data: string) {
    return this.quiet === "silence" ? silenceLike(data) : "";
  }
}

/** The preference is deliberately local to this computer. It is not a provider setting. */
export function liveInputMode(): InputMode {
  try {
    return window.localStorage.getItem("botkins.liveInput") === "ptt" ? "push" : "conversation";
  } catch {
    return "conversation";
  }
}

export function setLiveInputMode(mode: InputMode) {
  try {
    window.localStorage.setItem("botkins.liveInput", mode === "push" ? "ptt" : "live");
  } catch {
    // Settings can still be used for this call when storage is unavailable.
  }
}
