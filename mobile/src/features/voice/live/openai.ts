// OpenAI Realtime: the events both ways, shared by WebRTC (the `oai-events` data channel) and the
// WebSocket. Names are from the Realtime guides and the event reference, read 2026-11-19.
import { argsOf, type Connect, type DuplexLike, LiveBase, type LiveStatus, type Line, obj, OPEN, OutputLevel, parseJson, type SocketLike, str, type ToolRunner } from "./types";

type Hooks = {
  send(event: Record<string, unknown>): void;
  status(status: LiveStatus): void;
  line(id: string, who: Line["who"], text: string, options?: { append?: boolean; final?: boolean }): void;
  tool(name: string, args: Record<string, unknown>): Promise<{ output: string; error: boolean }>;
  error(message: string): void;
  /** WebSocket only: sound to play. */
  audio?(base64: string, itemId: string): void;
  /** The person started talking over the bot. */
  interrupted?(): void;
};

/** Turns on the person's transcript, which is off unless the session asks for it. */
export const TRANSCRIBE_MODEL = "gpt-transcribe";
export function withTranscription(session: Record<string, unknown>): Record<string, unknown> {
  const inner = obj(session.session);
  const audio = obj(inner.audio);
  const input = obj(audio.input);
  if (input.transcription !== undefined) return session;
  return { ...session, session: { ...inner, audio: { ...audio, input: { ...input, transcription: { model: TRANSCRIBE_MODEL } } } } };
}

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
        this.hooks.status("listening");
        return;
      case "input_audio_buffer.speech_started":
        this.hooks.interrupted?.();
        this.hooks.status("listening");
        return;
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.hooks.audio?.(str(event.delta), itemId);
        this.hooks.status("talking");
        return;
      case "output_audio_buffer.started":
        this.hooks.status("talking");
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
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
 * 24 kHz PCM16. When the person talks over the bot, playing stops and the bot's item is cut where
 * the person heard it end (`conversation.item.truncate`).
 */
export class OpenAISocketTransport extends LiveBase {
  static readonly RATE = 24000;
  private socket: SocketLike | null = null;
  private subscriptions: { remove(): void }[] = [];
  private protocol: OpenAIRealtime;
  private talking = new OutputLevel((on) => this.setStatus(on ? "talking" : "listening"));
  /** The bot's item being played: when its sound started arriving, and how much has arrived. */
  private playing: { itemId: string; startedAt: number; samples: number } | null = null;
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
    this.protocol = new OpenAIRealtime({
      send: (event) => this.send(event),
      status: (status) => (status === "talking" ? undefined : this.setStatus(status)),
      line: (id, who, text, options) => this.line(id, who, text, options),
      tool: (name, args) => this.tool(name, args),
      error: (message) => this.emit("error", message),
      audio: (base64, itemId) => this.play(base64, itemId),
      interrupted: () => this.interrupt(),
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
        this.send(withTranscription(this.session.session));
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
        if (!this.muted) this.send({ type: "input_audio_buffer.append", audio: frame.data });
      }),
      this.audio.addListener("output", (event) => this.talking.level(event.level)),
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
    this.audio.play(base64);
  }

  private interrupt() {
    const playing = this.playing;
    this.playing = null;
    this.audio.flush();
    if (!playing) return;
    const arrived = Math.floor((playing.samples / OpenAISocketTransport.RATE) * 1000);
    const heard = Math.max(0, Math.min(arrived, this.now() - playing.startedAt));
    if (heard < arrived) this.send({ type: "conversation.item.truncate", item_id: playing.itemId, content_index: 0, audio_end_ms: heard });
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
