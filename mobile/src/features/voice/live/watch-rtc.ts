// Codex's live voice is WebRTC-only. This transport keeps the protocol, tools and transcript in
// JavaScript while the iPhone native peer uses the Watch as its custom RTCAudioDevice.
import type { LiveProvider } from "@/link/types";
import { MicGate, MIN_TURN_MS, RELEASE_TAIL_MS } from "./input";
import { OpenAIRealtime, transcription, turnsByHand } from "./openai";
import type { Negotiate } from "./webrtc";
import { LiveBase, type ToolRunner, type WatchRtcLike } from "./types";

export class WatchRTCTransport extends LiveBase {
  sessionId: string | null = null;
  private subscriptions: { remove(): void }[] = [];
  private protocol: OpenAIRealtime;
  private muted = false;
  private responding = false;
  private sounding = false;
  private manual = false;
  private reopen: ReturnType<typeof setTimeout> | null = null;
  private sending: ReturnType<typeof setTimeout> | null = null;
  private turnMs = 0;

  constructor(
    private readonly rtc: WatchRtcLike,
    private readonly negotiate: Negotiate,
    runTool: ToolRunner,
    private readonly language?: string,
    private readonly provider: LiveProvider = "openai",
  ) {
    super(runTool);
    this.protocol = new OpenAIRealtime({
      send: (event) => {
        if (!this.codex) this.send(event);
      },
      status: (status) => this.setStatus(status),
      inputItem: (id) => this.emit("inputItem", id),
      line: (id, who, text, options) => this.line(id, who, text, options),
      tool: (name, args) => this.tool(name, args),
      error: (message) => (this.codex ? this.fail(message) : this.emit("error", message)),
      responding: (on) => (this.responding = on),
      playing: (on) => {
        this.sounding = on;
        this.gate.playing(on);
        this.apply();
      },
      session: (session) => (this.manual = turnsByHand(session)),
    });
  }

  private get codex() {
    return this.provider === "codex";
  }

  private send(event: Record<string, unknown>) {
    try {
      this.rtc.send(JSON.stringify(event));
    } catch {
      // The data channel is not open yet; startup events are sent by the open callback.
    }
  }

  private apply() {
    if (this.reopen) clearTimeout(this.reopen);
    this.reopen = null;
    const enabled = !this.muted && !this.ended && this.gate.open();
    this.rtc.input(enabled);
    const wait = this.gate.wait();
    if (wait !== null && !this.ended) this.reopen = setTimeout(() => this.apply(), wait + 5);
  }

  async start() {
    this.subscriptions.push(
      this.rtc.onMessage((message) => this.protocol.handle(message)),
      this.rtc.onState((state) => {
        if (state === "open") {
          this.apply();
          if (!this.codex) {
            const input = {
              transcription: transcription(this.language),
              ...(this.input === "push" && { turn_detection: null }),
            };
            this.send({ type: "session.update", session: { type: "realtime", audio: { input } } });
          }
          this.setStatus("listening");
        } else if (state === "failed" || state === "closed") {
          if (!this.ended) this.fail(state === "failed" ? "The Watch voice connection failed." : "The call ended.");
        }
      }),
      this.rtc.onLevel(({ mic, output }) => {
        this.hears({ mic: this.muted ? 0 : mic, out: output });
        this.gate.level(output);
      }),
      this.rtc.onInterrupted((failed, problem) => {
        if (this.ended) return;
        if (failed) this.fail(problem ?? "The Watch and iPhone lost their connection.");
        else if (!this.muted) this.interrupt();
      }),
    );
    const offer = await this.rtc.start();
    this.apply();
    const session = await this.negotiate(offer);
    this.sessionId = session.id;
    if (this.ended) return;
    await this.rtc.answer(session.sdp);
  }

  mute(muted: boolean) {
    this.muted = muted;
    this.apply();
  }

  setSpeaker(_on: boolean) {
    // The custom audio device always plays on the Watch.
  }

  interrupt() {
    if (this.ended) return;
    if (!this.codex) {
      if (this.responding) this.send({ type: "response.cancel" });
      if (this.sounding) this.send({ type: "output_audio_buffer.clear" });
    }
    this.rtc.flush();
    this.responding = false;
    this.sounding = false;
    this.gate.cut();
    this.apply();
    this.setStatus("listening");
  }

  press() {
    if (this.input !== "push" || this.ended || this.gate.holding) return;
    if (this.sending) {
      clearTimeout(this.sending);
      this.sending = null;
    } else {
      this.turnMs = 0;
      this.startTurn();
      if (this.responding || this.sounding) this.interrupt();
      if (!this.codex) this.send({ type: "input_audio_buffer.clear" });
    }
    this.gate.press();
    this.apply();
    this.setStatus("listening");
  }

  release() {
    if (!this.gate.holding) return;
    this.turnMs += this.gate.release();
    const held = this.turnMs;
    this.apply();
    this.sending = setTimeout(() => {
      this.sending = null;
      this.apply();
      if (this.ended || this.codex || !this.manual) return;
      if (held < MIN_TURN_MS || this.quietTurn) {
        this.send({ type: "input_audio_buffer.clear" });
        return;
      }
      this.send({ type: "input_audio_buffer.commit" });
      this.send({ type: "response.create" });
      this.setStatus("thinking");
    }, RELEASE_TAIL_MS + 10);
  }

  protected close() {
    if (this.reopen) clearTimeout(this.reopen);
    if (this.sending) clearTimeout(this.sending);
    this.reopen = null;
    this.sending = null;
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions = [];
    void this.rtc.end().catch(() => {});
  }
}
