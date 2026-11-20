// Gemini Live over its WebSocket, with the single-use token in the address. The computer made the
// whole first message (`setup`). Message shapes are from the Live API pages and its reference,
// read 2026-11-19: audio in as `realtimeInput.audio`, sound out in `serverContent.modelTurn`.
import { type Connect, type DuplexLike, LiveBase, obj, OPEN, OutputLevel, parseJson, type SocketLike, str, type ToolRunner } from "./types";

export type GeminiSession = { url: string; setup: Record<string, unknown>; input: { sampleRate: number }; output: { sampleRate: number } };

export class GeminiTransport extends LiveBase {
  private socket: SocketLike | null = null;
  private subscriptions: { remove(): void }[] = [];
  private talking = new OutputLevel((on) => this.setStatus(on ? "talking" : "listening"));
  private turn = 0;
  private youOpen = false;
  private botOpen = false;
  private cancelled = new Set<string>();
  private speaker = true;
  private muted = false;
  private ready: (() => void) | null = null;

  constructor(
    private readonly session: GeminiSession,
    private readonly audio: DuplexLike,
    private readonly connect: Connect,
    runTool: ToolRunner,
  ) {
    super(runTool);
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
          this.end();
        });
      };
      socket.onopen = () => {
        opened = true;
        this.send(this.session.setup);
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
        if (!this.muted) this.send({ realtimeInput: { audio: { data: frame.data, mimeType } } });
      }),
      this.audio.addListener("output", (event) => this.talking.level(event.level)),
      // The phone could not keep the sound going (the microphone or the speaker was taken away for good).
      this.audio.addListener("interrupted", (event) => {
        if (event.failed && !this.ended) this.fail("The phone's sound stopped. End the call and try again.");
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
      if (input) {
        if (!this.youOpen) {
          this.turn += 1;
          this.youOpen = true;
        }
        this.line("you-" + this.turn, "you", input, { append: true });
      }
      const parts = Array.isArray(obj(content.modelTurn).parts) ? (obj(content.modelTurn).parts as unknown[]).map(obj) : [];
      for (const part of parts) {
        const sound = str(obj(part.inlineData).data);
        if (sound) this.audio.play(sound);
      }
      const output = str(obj(content.outputTranscription).text);
      if (output) {
        this.closeYou();
        this.botOpen = true;
        this.line("bot-" + this.turn, "bot", output, { append: true });
      }
      if (content.interrupted === true) {
        this.audio.flush();
        this.closeBot();
        this.setStatus("listening");
      }
      if (content.turnComplete === true) {
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
  }
  private closeBot() {
    if (this.botOpen) this.line("bot-" + this.turn, "bot", "", { append: true, final: true });
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
    // Tells Gemini the microphone went quiet, so it doesn't wait for more.
    if (muted) this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  setSpeaker(on: boolean) {
    if (on === this.speaker) return;
    this.speaker = on;
    // The sound module moves the route itself, without stopping the call.
    if (!this.ended) this.audio.setSpeaker(on);
  }

  protected close() {
    this.ready = null;
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
