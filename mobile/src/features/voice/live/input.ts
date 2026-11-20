// When the phone sends its microphone during live voice. Pure (no React Native), so the tests run it.
//
// The bot's own voice must never cut it off. The phone's echo canceller takes most of the bot's
// sound out of the microphone, but not all of it on the loudspeaker, and the providers' voice
// detection hears the rest as the person talking over the bot. So while the bot's sound plays, and
// for a short tail after, the phone sends nothing (hands-free), or only while the talk button is held
// (push to talk). The person can still interrupt on purpose: with a tap, with the talk button, or,
// where the phone has the microphone's level, by talking clearly louder than the echo.

export type InputMode = "conversation" | "push";

/** After the bot's sound stops, the microphone stays closed this long: the room's echo and the speaker's last buffer. */
export const ECHO_TAIL_MS = 400;
/** After a cut, what the sound module still reports playing is its last buffer, not new sound. */
export const CUT_SETTLE_MS = 250;
/** After the talk button is let go, the microphone keeps sending this long, so the last word isn't cut. */
export const RELEASE_TAIL_MS = 250;
/** A press shorter than this is not a turn: nothing is sent for the bot to answer. */
export const MIN_TURN_MS = 250;
/**
 * Talking over the bot by voice: a piece of the microphone counts when its level (0 to 1) is at
 * least `min` and `ratio` times the echo heard so far, and `frames` such pieces in a row (about
 * 40 ms each) interrupt the bot.
 */
export const BARGE_IN = { min: 0.2, ratio: 3, frames: 5 };
/** Above this, what plays counts as sound (the same line as the avatar's `OutputLevel`). */
export const SOUND_LEVEL = 0.02;

/** Milliseconds of 16-bit mono PCM in a base64 string, at `rate` samples a second. */
export function pcmMs(base64: string, rate: number): number {
  if (!base64 || !(rate > 0)) return 0;
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - pad;
  return (Math.floor(bytes / 2) / rate) * 1000;
}

/** Silence as long as a piece of base64 sound: every byte zero. */
export function silenceLike(base64: string): string {
  return base64.replace(/[^=]/g, "A");
}

export type FrameDecision = {
  /** Base64 pieces to send now, in order. */
  send: string[];
  /** The person talked over the bot: stop the bot before sending these. */
  barge: boolean;
};

export class MicGate {
  /** When the bot's queued sound ends (ms). */
  private until = -Infinity;
  private cutAt = -Infinity;
  /** The provider says the bot's sound is playing, for as long as it says (WebRTC). */
  private sounding = false;
  private held = false;
  private pressedAt = 0;
  private releasedAt = -Infinity;
  /** The microphone's level while the bot played and nobody talked over it: the echo. */
  private echo = 0;
  /** Loud pieces in a row while the bot plays, held until they make a barge-in or stop. */
  private loud: string[] = [];

  /**
   * `quiet`: what a closed microphone sends. "drop" sends nothing; "silence" sends silence of the
   * same length, for a provider whose own turn detection needs to hear the person stop.
   */
  constructor(
    readonly mode: InputMode,
    private readonly now: () => number = Date.now,
    private readonly quiet: "drop" | "silence" = "drop",
  ) {}

  /** The same gate for another mode (before a call starts). */
  withMode(mode: InputMode): MicGate {
    return new MicGate(mode, this.now, this.quiet);
  }

  /** `ms` more of the bot's sound was queued to play, after what is queued already. */
  queued(ms: number) {
    if (!(ms > 0)) return;
    const now = this.now();
    this.until = Math.max(this.until, now) + ms;
  }

  /** How loud what plays is now (0 to 1): sound that plays longer than was counted keeps it closed. */
  level(value: number) {
    const now = this.now();
    if (value > SOUND_LEVEL && now - this.cutAt >= CUT_SETTLE_MS) this.until = Math.max(this.until, now);
  }

  /** The provider says the bot's sound started (true) or stopped (false). */
  playing(on: boolean) {
    if (on === this.sounding) return;
    this.sounding = on;
    if (!on) this.until = Math.max(this.until, this.now());
  }

  /** The bot's sound was stopped at once: nothing plays and there is no echo to wait out. */
  cut() {
    this.sounding = false;
    this.until = -Infinity;
    this.cutAt = this.now();
    this.loud = [];
  }

  /** The bot's sound is playing, or its echo may still be in the room. */
  botSounding(): boolean {
    return this.sounding || this.now() < this.until + ECHO_TAIL_MS;
  }

  get holding() {
    return this.held;
  }

  /** The talk button went down. */
  press() {
    this.held = true;
    this.pressedAt = this.now();
    this.loud = [];
  }

  /** The talk button came up: how long it was held (ms). */
  release(): number {
    if (!this.held) return 0;
    this.held = false;
    this.releasedAt = this.now();
    return this.releasedAt - this.pressedAt;
  }

  /** Whether the microphone is sent now. */
  open(): boolean {
    if (this.mode === "push") return this.held || this.now() < this.releasedAt + RELEASE_TAIL_MS;
    return !this.botSounding();
  }

  /** In how many ms `open()` may change by itself; null when only an event changes it. */
  wait(): number | null {
    const now = this.now();
    if (this.mode === "push") return !this.held && now < this.releasedAt + RELEASE_TAIL_MS ? this.releasedAt + RELEASE_TAIL_MS - now : null;
    if (this.sounding) return null;
    return now < this.until + ECHO_TAIL_MS ? this.until + ECHO_TAIL_MS - now : null;
  }

  /** One piece of the microphone and its level: what to send now. */
  frame(data: string, level: number): FrameDecision {
    if (this.open()) {
      const send = this.loud.length ? [...this.loud.map((held) => this.closed(held)), data] : [data];
      this.loud = [];
      return { send: send.filter((piece) => piece !== ""), barge: false };
    }
    if (this.mode === "push") return { send: this.quietOf(data), barge: false };
    // The bot is playing. Only talk clearly louder than its echo, for long enough, interrupts it.
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

  private quietOf(data: string): string[] {
    return this.quiet === "silence" ? [silenceLike(data)] : [];
  }
  private closed(data: string): string {
    return this.quiet === "silence" ? silenceLike(data) : "";
  }
}
