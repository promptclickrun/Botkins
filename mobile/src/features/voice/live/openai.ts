// OpenAI Realtime: the events both ways, shared by WebRTC (the `oai-events` data channel) and the
// WebSocket. Names are from the Realtime guides and the event reference, read 2026-11-19.
import { type InputMode, MicGate, MIN_TURN_MS, pcmMs, RELEASE_TAIL_MS } from "./input";
import { argsOf, type Connect, type DuplexLike, LiveBase, type LiveStatus, type Line, obj, OPEN, OutputLevel, parseJson, type SocketLike, str, type ToolRunner } from "./types";

type Hooks = {
  send(event: Record<string, unknown>): void;
  status(status: LiveStatus): void;
  inputItem?(id: string): void;
  line(id: string, who: Line["who"], text: string, options?: { append?: boolean; final?: boolean }): void;
  tool(name: string, args: Record<string, unknown>): Promise<{ output: string; error: boolean }>;
  error(message: string): void;
  /** WebSocket only: sound to play. */
  audio?(base64: string, itemId: string): void;
  /** The person started talking over the bot. */
  interrupted?(): void;
  /** A response started (true) or ended (false). */
  responding?(on: boolean): void;
  /** WebRTC only: the provider started (true) or stopped (false) sending the bot's sound. */
  playing?(on: boolean): void;
  /** The session as the provider has it now (`session.updated`). */
  session?(session: Record<string, unknown>): void;
};

export const TRANSCRIBE_MODEL = "gpt-transcribe";

/** The transcript request: the model, and the person's language (primary subtag) so silence can't be read as another one. */
export const transcription = (language?: string) => ({ model: TRANSCRIBE_MODEL, ...(language && { language: language.split("-")[0]!.toLowerCase() }) });

/** Turns on the person's transcript, which is off unless the session asks for it. */
export function withTranscription(session: Record<string, unknown>, language?: string): Record<string, unknown> {
  const inner = obj(session.session);
  const audio = obj(inner.audio);
  const input = obj(audio.input);
  if (input.transcription !== undefined) return session;
  return { ...session, session: { ...inner, audio: { ...audio, input: { ...input, transcription: transcription(language) } } } };
}

/**
 * Push to talk turns OpenAI's turn detection off (`turn_detection: null`): the phone then clears the
 * input on press, and commits it and asks for a response on release (the Realtime conversations
 * guide, "push-to-talk"). Hands-free keeps the session's own turn detection.
 */
export function withTurns(session: Record<string, unknown>, mode: InputMode): Record<string, unknown> {
  if (mode !== "push") return session;
  const inner = obj(session.session);
  const audio = obj(inner.audio);
  return { ...session, session: { ...inner, audio: { ...audio, input: { ...obj(audio.input), turn_detection: null } } } };
}

/** Whether a session (from `session.updated`) has its turn detection off. */
export const turnsByHand = (session: Record<string, unknown>) => obj(obj(session.audio).input).turn_detection === null;

/** What the phone reads from the provider's events. */
export class OpenAIRealtime {
  private ran = new Set<string>();
  private pending = new Map<string, { name: string; args: string }>();
  constructor(private readonly hooks: Hooks) {}

  handle(data: unknown) {
    const event = parseJson(data);
    if (!event) return;
    const type = str(event.type);
    const itemId = str(event.item_id);
    switch (type) {
      case "session.created":
      case "session.updated":
        this.hooks.session?.(obj(event.session));
        this.hooks.status("listening");
        return;
      case "response.created":
        this.hooks.responding?.(true);
        return;
      case "input_audio_buffer.committed":
        if (itemId) this.hooks.inputItem?.(itemId);
        return;
      case "input_audio_buffer.speech_started":
        if (itemId) this.hooks.inputItem?.(itemId);
        this.hooks.interrupted?.();
        this.hooks.status("listening");
        return;
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.hooks.audio?.(str(event.delta), itemId);
        this.hooks.status("talking");
        return;
      case "output_audio_buffer.started":
        this.hooks.playing?.(true);
        this.hooks.status("talking");
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.hooks.playing?.(false);
        this.hooks.status("listening");
        return;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        this.hooks.line(itemId, "bot", str(event.delta), { append: true });
        return;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        this.hooks.line(itemId, "bot", str(event.transcript), { final: true });
        return;
      case "conversation.item.input_audio_transcription.delta":
        this.hooks.line(itemId, "you", str(event.delta), { append: true });
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.hooks.line(itemId, "you", str(event.transcript), { final: true });
        return;
      case "response.function_call_arguments.done": {
        const callId = str(event.call_id);
        if (callId) this.pending.set(callId, { name: str(event.name), args: str(event.arguments) });
        return;
      }
      case "response.done":
        this.hooks.responding?.(false);
        void this.done(obj(event.response));
        return;
      case "error": {
        const error = obj(event.error);
        this.hooks.error(str(error.message) || "The voice ran into a problem.");
        return;
      }
      default:
        return;
    }
  }

  /** A response ended: run the tools it called (only when it wasn't cut off), then ask for the next. */
  private async done(response: Record<string, unknown>) {
    const status = str(response.status);
    const output = Array.isArray(response.output) ? response.output.map(obj) : [];
    const calls = output.filter((item) => item.type === "function_call").map((item) => ({ callId: str(item.call_id), name: str(item.name), args: str(item.arguments) }));
    // The arguments events cover a response.done without its output.
    for (const [callId, call] of this.pending) if (!calls.some((item) => item.callId === callId)) calls.push({ callId, ...call });
    this.pending.clear();
    if (status !== "completed" || !calls.length) return;
    let answered = 0;
    for (const call of calls) {
      if (!call.callId || this.ran.has(call.callId)) continue;
      this.ran.add(call.callId);
      const result = await this.hooks.tool(call.name, argsOf(call.args));
      this.hooks.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(result.error ? { error: result.output } : { result: result.output }) } });
      answered += 1;
    }
    if (answered) this.hooks.send({ type: "response.create" });
  }
}

export type OpenAISocketSession = { url: string; token: string; session: Record<string, unknown> };

/**
 * The OpenAI Realtime WebSocket with a short-lived token: sound both ways through DuplexAudio at
 * 24 kHz PCM16. While the bot's sound plays (and for its echo after) the microphone is not sent, so
 * the bot can't hear itself (input.ts). When the person stops the bot (talking clearly over it, a tap
 * or the talk button), playing stops, the response is cancelled and the bot's item is cut where the
 * person heard it end (`conversation.item.truncate`).
 */
export class OpenAISocketTransport extends LiveBase {
  static readonly RATE = 24000;
  private socket: SocketLike | null = null;
  private subscriptions: { remove(): void }[] = [];
  private protocol: OpenAIRealtime;
  private talking = new OutputLevel((on) => this.setStatus(on ? "talking" : "listening"));
  /** The bot's item being played: when its sound started arriving, and how much has arrived. */
  private playing: { itemId: string; startedAt: number; samples: number } | null = null;
  /** A response is under way, so there is one to cancel. */
  private responding = false;
  private sending: ReturnType<typeof setTimeout> | null = null;
  /** How long the button has been held in this turn (a quick press again goes on with it). */
  private turnMs = 0;
  private speaker = true;
  private muted = false;

  constructor(
    private readonly session: OpenAISocketSession,
    private readonly audio: DuplexLike,
    private readonly connect: Connect,
    runTool: ToolRunner,
    private readonly now: () => number = Date.now,
  ) {
    super(runTool);
    this.gate = new MicGate("conversation", now);
    this.clock = now;
    this.protocol = new OpenAIRealtime({
      send: (event) => this.send(event),
      status: (status) => (status === "talking" ? undefined : this.setStatus(status)),
      inputItem: id => this.emit("inputItem", id),
      line: (id, who, text, options) => this.line(id, who, text, options),
      tool: (name, args) => this.tool(name, args),
      error: (message) => this.emit("error", message),
      audio: (base64, itemId) => this.play(base64, itemId),
      // OpenAI heard the person (only what the phone sent: never the bot's own sound).
      interrupted: () => this.stopPlaying(),
      responding: (on) => (this.responding = on),
    });
  }

  private send(event: Record<string, unknown>) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(event));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      // A browser-style client passes the token as a subprotocol; the header is the server-side way.
      const socket = this.connect(this.session.url, ["realtime", "openai-insecure-api-key." + this.session.token], { Authorization: "Bearer " + this.session.token });
      this.socket = socket;
      socket.onopen = () => {
        opened = true;
        this.send(withTurns(withTranscription(this.session.session), this.input));
        void this.startAudio().then(resolve, (error: unknown) => {
          reject(error);
          this.end();
        });
      };
      socket.onmessage = (event) => this.protocol.handle(event.data);
      socket.onerror = () => {
        if (!opened) reject(new Error("Couldn't reach OpenAI."));
      };
      socket.onclose = (event) => {
        if (!opened) reject(new Error("OpenAI closed the connection."));
        else if (!this.ended) this.fail(event.reason ? "OpenAI ended the call: " + event.reason : "The call ended.");
      };
    });
  }

  private async startAudio() {
    this.subscriptions.push(
      this.audio.addListener("frame", (frame) => {
        this.hears({ mic: this.muted ? 0 : frame.level });
        if (this.muted) return;
        const { send, barge } = this.gate.frame(frame.data, frame.level);
        // The person talked clearly over the bot: it stops before their words go.
        if (barge) this.interrupt();
        for (const data of send) this.send({ type: "input_audio_buffer.append", audio: data });
      }),
      this.audio.addListener("output", (event) => {
        this.hears({ out: event.level });
        this.gate.level(event.level);
        this.talking.level(event.level);
      }),
      // The phone could not keep the sound going (the microphone or the speaker was taken away for good).
      this.audio.addListener("interrupted", (event) => {
        if (event.failed && !this.ended) this.fail("The phone's sound stopped. End the call and try again.");
      }),
    );
    await this.audio.start({ inputRate: OpenAISocketTransport.RATE, outputRate: OpenAISocketTransport.RATE, speaker: this.speaker });
    this.setStatus("listening");
  }

  private play(base64: string, itemId: string) {
    if (!base64) return;
    if (!this.playing || this.playing.itemId !== itemId) this.playing = { itemId, startedAt: this.now(), samples: 0 };
    // Base64 of 16-bit samples: 4 characters are 3 bytes.
    this.playing.samples += Math.floor((base64.length * 3) / 4 / 2);
    this.gate.queued(pcmMs(base64, OpenAISocketTransport.RATE));
    this.audio.play(base64);
  }

  /** Stops what plays and cuts the bot's item where the person heard it end. */
  private stopPlaying() {
    const playing = this.playing;
    this.playing = null;
    this.audio.flush();
    this.gate.cut();
    if (!playing) return;
    const arrived = Math.floor((playing.samples / OpenAISocketTransport.RATE) * 1000);
    const heard = Math.max(0, Math.min(arrived, this.now() - playing.startedAt));
    if (heard < arrived) this.send({ type: "conversation.item.truncate", item_id: playing.itemId, content_index: 0, audio_end_ms: heard });
  }

  interrupt() {
    if (this.ended) return;
    // `response.cancel` with nothing under way is an error, so only a running response is cancelled.
    if (this.responding) this.send({ type: "response.cancel" });
    this.responding = false;
    this.stopPlaying();
    this.talking.stop();
    this.setStatus("listening");
  }

  press() {
    if (this.input !== "push" || this.ended || this.gate.holding) return;
    if (this.sending) {
      // Pressed again before the last turn was sent: it goes on as the same turn.
      clearTimeout(this.sending);
      this.sending = null;
    } else {
      this.turnMs = 0;
      this.startTurn();
      if (this.responding || this.gate.botSounding()) this.interrupt();
      this.send({ type: "input_audio_buffer.clear" });
    }
    this.gate.press();
    this.setStatus("listening");
  }

  release() {
    if (!this.gate.holding) return;
    this.turnMs += this.gate.release();
    const held = this.turnMs;
    // The last pieces of sound are still on their way; the turn is sent after them.
    this.sending = setTimeout(() => {
      this.sending = null;
      if (this.ended) return;
      if (held < MIN_TURN_MS || this.quietTurn) {
        this.send({ type: "input_audio_buffer.clear" });
        return;
      }
      this.send({ type: "input_audio_buffer.commit" });
      this.send({ type: "response.create" });
      this.setStatus("thinking");
    }, RELEASE_TAIL_MS);
  }

  mute(muted: boolean) {
    this.muted = muted;
    this.audio.setMuted(muted);
  }

  setSpeaker(on: boolean) {
    if (on === this.speaker) return;
    this.speaker = on;
    // The sound module moves the route itself, without stopping the call.
    if (!this.ended) this.audio.setSpeaker(on);
  }

  protected close() {
    this.talking.stop();
    if (this.sending) clearTimeout(this.sending);
    this.sending = null;
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
