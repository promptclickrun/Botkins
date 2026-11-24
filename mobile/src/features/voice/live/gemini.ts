// Gemini Live over its WebSocket, with the single-use token in the address. The computer made the
// whole first message (`setup`). Message shapes are from the Live API pages and its reference,
// read 2026-11-19: audio in as `realtimeInput.audio`, sound out in `serverContent.modelTurn`.
// While the bot's sound plays (and for its echo after) the microphone is not sent (input.ts). Push
// to talk turns Gemini's own activity detection off and marks the person's turn with `activityStart`
// and `activityEnd` (the Live API capabilities page, "Disabling automatic VAD").
import { type InputMode, MicGate, pcmMs, RELEASE_TAIL_MS } from "./input";
import { type Connect, type DuplexLike, LiveBase, obj, OPEN, OutputLevel, parseJson, type SocketLike, str, type ToolRunner } from "./types";

export type GeminiSession = { url: string; setup: Record<string, unknown>; input: { sampleRate: number }; output: { sampleRate: number } };

/** The computer's setup, with Gemini's activity detection off for push to talk. */
export function withActivity(setup: Record<string, unknown>, mode: InputMode): Record<string, unknown> {
  if (mode !== "push") return setup;
  const inner = obj(setup.setup);
  const config = obj(inner.realtimeInputConfig);
  return { ...setup, setup: { ...inner, realtimeInputConfig: { ...config, automaticActivityDetection: { ...obj(config.automaticActivityDetection), disabled: true } } } };
}

export class GeminiTransport extends LiveBase {
  private socket: SocketLike | null = null;
  private subscriptions: { remove(): void }[] = [];
  private talking = new OutputLevel((on) => this.setStatus(on ? "talking" : "listening"));
  private turn = 0;
  private youOpen = false;
  private confirmedInput = "";
  private botOpen = false;
  private botLine = 0;
  private cancelled = new Set<string>();
  private speaker = false;
  private muted = false;
  private ready: (() => void) | null = null;
  /** Gemini is still sending the bot's turn. */
  private generating = false;
  /** The person cut the bot off: the rest of that turn is dropped until Gemini says it stopped. */
  private cutting = false;
  private sending: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly session: GeminiSession,
    private readonly audio: DuplexLike,
    private readonly connect: Connect,
    runTool: ToolRunner,
    now: () => number = Date.now,
  ) {
    super(runTool);
    this.gate = new MicGate("conversation", now);
    this.clock = now;
  }

  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const socket = this.connect(this.session.url);
      this.socket = socket;
      const timer = setTimeout(() => {
        this.ready = null;
        reject(new Error("Gemini didn't answer."));
        this.end();
      }, 15000);
      // Sound starts once Gemini says the setup took.
      this.ready = () => {
        clearTimeout(timer);
        this.ready = null;
        void this.startAudio().then(resolve, (error: unknown) => {
          reject(error);
          this.fail(error instanceof Error ? error.message : "The microphone could not start.");
        });
      };
      socket.onopen = () => {
        opened = true;
        this.send(withActivity(this.session.setup, this.input));
      };
      socket.onmessage = (event) => this.handle(event.data);
      socket.onerror = () => {
        if (!opened) {
          clearTimeout(timer);
          reject(new Error("Couldn't reach Gemini."));
        }
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        if (this.ready) {
          this.ready = null;
          reject(new Error(event.reason ? "Gemini refused the call: " + event.reason : "Gemini closed the connection."));
        } else if (!this.ended) this.fail(event.reason ? "Gemini ended the call: " + event.reason : "The call ended.");
      };
    });
  }

  private async startAudio() {
    const mimeType = "audio/pcm;rate=" + this.session.input.sampleRate;
    this.subscriptions.push(
      this.audio.addListener("frame", (frame) => {
        this.hears({ mic: this.muted ? 0 : frame.level });
        if (this.muted) return;
        const { send, barge } = this.gate.frame(frame.data, frame.level);
        // The person talked clearly over the bot: it stops here, and Gemini hears them and stops too.
        if (barge) this.interrupt();
        for (const data of send) this.send({ realtimeInput: { audio: { data, mimeType } } });
      }),
      this.audio.addListener("output", (event) => {
        this.hears({ out: event.level });
        this.gate.level(event.level);
        this.talking.level(event.level);
      }),
      // The phone could not keep the sound going (the microphone or the speaker was taken away for good).
      this.audio.addListener("interrupted", (event) => {
        if (event.failed && !this.ended) this.fail(event.problem ?? "The phone's sound stopped. End the call and try again.");
      }),
    );
    await this.audio.start({ inputRate: this.session.input.sampleRate, outputRate: this.session.output.sampleRate, speaker: this.speaker });
    this.setStatus("listening");
  }

  /** One message from Gemini. Public for the tests. */
  handle(data: unknown) {
    const message = parseJson(data);
    if (!message) return;
    if ("setupComplete" in message) {
      this.ready?.();
      return;
    }
    const content = obj(message.serverContent);
    if (message.serverContent) {
      const input = str(obj(content.inputTranscription).text);
      const tentative = str(obj(content.interimInputTranscription).text);
      if (input || tentative) {
        if (!this.youOpen) {
          this.turn += 1;
          this.youOpen = true;
        }
        this.confirmedInput += input;
        this.line("you-" + this.turn, "you", this.confirmedInput + tentative);
      }
      if (obj(content.inputTranscription).finished === true) this.closeYou();
      const parts = Array.isArray(obj(content.modelTurn).parts) ? (obj(content.modelTurn).parts as unknown[]).map(obj) : [];
      for (const part of parts) {
        const sound = str(obj(part.inlineData).data);
        if (!sound) continue;
        this.generating = true;
        if (this.cutting) continue;
        this.gate.queued(pcmMs(sound, this.session.output.sampleRate));
        this.audio.play(sound);
      }
      const output = str(obj(content.outputTranscription).text);
      if (output) {
        if (!this.botOpen) this.botLine++;
        this.botOpen = true;
        this.line("bot-" + this.botLine, "bot", output, { append: true });
      }
      if (obj(content.outputTranscription).finished === true) this.closeBot();
      // Gemini heard the person (only what the phone sent: never the bot's own sound).
      if (content.interrupted === true) {
        this.generating = false;
        this.cutting = false;
        this.audio.flush();
        this.gate.cut();
        this.closeBot();
        this.setStatus("listening");
      }
      if (content.turnComplete === true) {
        this.generating = false;
        this.cutting = false;
        this.closeYou();
        this.closeBot();
      }
    }
    if (message.toolCall) void this.runCalls(obj(message.toolCall));
    if (message.toolCallCancellation) for (const id of (obj(message.toolCallCancellation).ids as unknown[] | undefined) ?? []) this.cancelled.add(str(id));
  }

  private closeYou() {
    if (this.youOpen) this.line("you-" + this.turn, "you", "", { append: true, final: true });
    this.youOpen = false;
    this.confirmedInput = "";
  }
  private closeBot() {
    if (this.botOpen) this.line("bot-" + this.botLine, "bot", "", { append: true, final: true });
    this.botOpen = false;
  }

  private async runCalls(toolCall: Record<string, unknown>) {
    const calls = (Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : []).map(obj);
    const responses: Record<string, unknown>[] = [];
    for (const call of calls) {
      const id = str(call.id);
      const name = str(call.name);
      const result = await this.tool(name, obj(call.args));
      if (this.cancelled.has(id)) continue;
      responses.push({ id, name, response: result.error ? { error: result.output } : { result: result.output } });
    }
    if (responses.length) this.send({ toolResponse: { functionResponses: responses } });
  }

  mute(muted: boolean) {
    this.muted = muted;
    this.audio.setMuted(muted);
    // Tells Gemini the microphone went quiet, so it doesn't wait for more. Only with its own
    // activity detection on; in push to talk the turn's end is `activityEnd`.
    if (muted && this.input === "conversation") this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  interrupt() {
    if (this.ended) return;
    // Gemini has no call to stop a turn; what is left of it is dropped here until it says it stopped.
    this.cutting = this.generating;
    this.audio.flush();
    this.gate.cut();
    this.talking.stop();
    this.closeBot();
    this.setStatus("listening");
  }

  press() {
    if (this.input !== "push" || this.ended || this.gate.holding) return;
    if (this.sending) {
      // Pressed again before the last turn was sent: it goes on as the same turn.
      clearTimeout(this.sending);
      this.sending = null;
    } else {
      if (this.generating || this.gate.botSounding()) this.interrupt();
      // The start of the person's turn interrupts the bot on Gemini's side too (activityHandling's default).
      this.send({ realtimeInput: { activityStart: {} } });
    }
    this.gate.press();
    this.setStatus("listening");
  }

  release() {
    if (!this.gate.holding) return;
    this.gate.release();
    // The last pieces of sound are still on their way; the turn ends after them.
    this.sending = setTimeout(() => {
      this.sending = null;
      this.send({ realtimeInput: { activityEnd: {} } });
    }, RELEASE_TAIL_MS);
  }

  setSpeaker(on: boolean) {
    if (on === this.speaker) return;
    this.speaker = on;
    // The sound module moves the route itself, without stopping the call.
    if (!this.ended) this.audio.setSpeaker(on);
  }

  protected close() {
    this.ready = null;
    if (this.sending) clearTimeout(this.sending);
    this.sending = null;
    this.talking.stop();
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions = [];
    void this.audio.stop().catch(() => {});
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close(1000);
    }
  }
}
