// ElevenLabs Agents over its signed WebSocket. The computer made the agent and the first message
// (`init`). Shapes are from the Agents WebSocket guide and its AsyncAPI reference, read 2026-11-19.
// The real sound formats come in the server's first message; the session's rates are the fallback.
//
// ElevenLabs takes turns by itself and has no client event that ends a turn (its client-to-server
// events are `contextual_update`, `user_message` and `user_activity`). So the phone always sends a
// steady stream: the microphone when it is open, and silence of the same length while the agent's
// sound plays (and for its echo after) or, in push to talk, while the button is up. Its own turn
// taking then hears the person stop and answers.
import { MicGate, pcmMs } from "./input";
import { type Connect, type DuplexLike, LiveBase, obj, OPEN, OutputLevel, parseJson, type SocketLike, str, type ToolRunner } from "./types";

export type ElevenLabsSession = { url: string; init: Record<string, unknown>; input: { sampleRate: number }; output: { sampleRate: number } };

/** "pcm_16000" to 16000. Other formats (μ-law) can't be played or sent: null. */
export function pcmRate(format: unknown): number | null {
  const match = /^pcm_(\d{4,6})$/.exec(str(format));
  return match ? Number(match[1]) : null;
}

export class ElevenLabsTransport extends LiveBase {
  private socket: SocketLike | null = null;
  private subscriptions: { remove(): void }[] = [];
  private talking = new OutputLevel((on) => this.setStatus(on ? "talking" : "listening"));
  private rates: { input: number; output: number };
  private count = 0;
  private lastBot = "";
  private userLine = "";
  private lastUserEvent?: number;
  /** Sound from before the last interruption is dropped. */
  private cutAt = -1;
  /** The person cut the agent off: its sound is dropped until ElevenLabs takes their turn. */
  private cutting = false;
  private speaker = true;
  private muted = false;
  private ready: ((rates?: { input: number; output: number } | Error) => void) | null = null;

  constructor(
    private readonly session: ElevenLabsSession,
    private readonly audio: DuplexLike,
    private readonly connect: Connect,
    runTool: ToolRunner,
    private readonly waitForFormats = 4000,
    now: () => number = Date.now,
  ) {
    super(runTool);
    this.rates = { input: session.input.sampleRate, output: session.output.sampleRate };
    this.gate = new MicGate("conversation", now, "silence");
  }

  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const socket = this.connect(this.session.url);
      this.socket = socket;
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.ready = (result) => {
        if (timer) clearTimeout(timer);
        this.ready = null;
        if (result instanceof Error) {
          reject(result);
          this.end();
          return;
        }
        if (result) this.rates = result;
        void this.startAudio().then(resolve, (error: unknown) => {
          reject(error);
          this.end();
        });
      };
      socket.onopen = () => {
        opened = true;
        this.send(this.session.init);
        // Without the server's formats in time, the session's rates are used.
        timer = setTimeout(() => this.ready?.(), this.waitForFormats);
      };
      socket.onmessage = (event) => this.handle(event.data);
      socket.onerror = () => {
        if (!opened) this.ready?.(new Error("Couldn't reach ElevenLabs."));
      };
      socket.onclose = (event) => {
        if (this.ready) this.ready(new Error(event.reason ? "ElevenLabs refused the call: " + event.reason : "ElevenLabs closed the connection."));
        else if (!this.ended) this.fail(event.reason ? "ElevenLabs ended the call: " + event.reason : "The call ended.");
      };
    });
  }

  private async startAudio() {
    this.subscriptions.push(
      this.audio.addListener("frame", (frame) => {
        if (this.muted) return;
        const { send, barge } = this.gate.frame(frame.data, frame.level);
        // The person talked clearly over the agent: it stops here, and ElevenLabs hears them.
        if (barge) this.interrupt();
        for (const data of send) this.send({ user_audio_chunk: data });
      }),
      this.audio.addListener("output", (event) => {
        this.gate.level(event.level);
        this.talking.level(event.level);
      }),
      // The phone could not keep the sound going (the microphone or the speaker was taken away for good).
      this.audio.addListener("interrupted", (event) => {
        if (event.failed && !this.ended) this.fail("The phone's sound stopped. End the call and try again.");
      }),
    );
    await this.audio.start({ inputRate: this.rates.input, outputRate: this.rates.output, speaker: this.speaker });
    this.setStatus("listening");
  }

  /** One message from ElevenLabs. Public for the tests. */
  handle(data: unknown) {
    const message = parseJson(data);
    if (!message) return;
    switch (str(message.type)) {
      case "conversation_initiation_metadata": {
        const meta = obj(message.conversation_initiation_metadata_event);
        const output = pcmRate(meta.agent_output_audio_format);
        const input = pcmRate(meta.user_input_audio_format);
        if ((meta.agent_output_audio_format && !output) || (meta.user_input_audio_format && !input)) {
          this.ready?.(new Error("This agent's sound format isn't supported. Set it to PCM 16000 Hz in ElevenLabs."));
          return;
        }
        this.ready?.({ input: input ?? this.rates.input, output: output ?? this.rates.output });
        return;
      }
      case "audio": {
        const event = obj(message.audio_event);
        const id = typeof event.event_id === "number" ? event.event_id : Number.MAX_SAFE_INTEGER;
        if (id <= this.cutAt || this.cutting) return;
        const sound = str(event.audio_base_64);
        if (!sound) return;
        this.gate.queued(pcmMs(sound, this.rates.output));
        this.audio.play(sound);
        return;
      }
      case "interruption": {
        const event = obj(message.interruption_event);
        if (typeof event.event_id === "number") this.cutAt = event.event_id;
        this.cutting = false;
        this.audio.flush();
        this.gate.cut();
        this.setStatus("listening");
        return;
      }
      case "tentative_user_transcript":
      case "user_transcript": {
        const final = message.type === "user_transcript";
        const event = obj(final ? message.user_transcription_event : message.tentative_user_transcription_event);
        const text = str(event.user_transcript);
        if (!text.trim() || (typeof event.event_id === "number" && event.event_id === this.lastUserEvent)) return;
        this.userLine ||= "you-" + ++this.count;
        this.line(this.userLine, "you", text, { final });
        if (final) {
          this.lastUserEvent = typeof event.event_id === "number" ? event.event_id : undefined;
          this.userLine = "";
          this.cutting = false;
        }
        return;
      }
      case "agent_chat_response_part": {
        const part = obj(message.text_response_part);
        if (part.type === "delta" && str(part.response_id) && str(part.text)) {
          this.lastBot = "bot-" + part.response_id;
          this.line(this.lastBot, "bot", str(part.text), { append: true });
        }
        return;
      }
      case "agent_response": {
        const event = obj(message.agent_response_event);
        const text = str(event.agent_response);
        if (text) {
          this.lastBot = "bot-" + (str(event.response_id) || ++this.count);
          this.line(this.lastBot, "bot", text, { final: true });
        }
        return;
      }
      case "agent_response_correction": {
        const event = obj(message.agent_response_correction_event);
        const id = str(event.response_id) ? "bot-" + event.response_id : this.lastBot;
        if (id && str(event.corrected_agent_response)) this.line(id, "bot", str(event.corrected_agent_response), { final: true });
        return;
      }
      case "ping": {
        const event = obj(message.ping_event);
        const wait = typeof event.ping_ms === "number" ? Math.min(event.ping_ms, 5000) : 0;
        setTimeout(() => this.send({ type: "pong", event_id: event.event_id }), wait);
        return;
      }
      case "client_tool_call":
        void this.runCall(obj(message.client_tool_call));
        return;
      case "client_error": {
        const event = obj(message.error_event);
        this.emit("error", str(event.message) || "ElevenLabs ran into a problem.");
        return;
      }
      default:
        return;
    }
  }

  private async runCall(call: Record<string, unknown>) {
    const id = str(call.tool_call_id);
    const result = await this.tool(str(call.tool_name), obj(call.parameters));
    this.send({ type: "client_tool_result", tool_call_id: id, result: result.output, is_error: result.error });
  }

  mute(muted: boolean) {
    this.muted = muted;
    this.audio.setMuted(muted);
  }

  interrupt() {
    if (this.ended) return;
    // ElevenLabs has no call to stop the agent; what is left of its answer is dropped here.
    this.cutting = true;
    this.audio.flush();
    this.gate.cut();
    this.talking.stop();
    this.setStatus("listening");
  }

  press() {
    if (this.input !== "push" || this.ended || this.gate.holding) return;
    if (this.gate.botSounding()) this.interrupt();
    // "User activity events serve as indicators to prevent interrupts from the agent."
    this.send({ type: "user_activity" });
    this.gate.press();
    this.setStatus("listening");
  }

  /** The sound stops (silence goes instead) and ElevenLabs answers once its turn taking hears the pause. */
  release() {
    this.gate.release();
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
