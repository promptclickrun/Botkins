// OpenAI Realtime over WebRTC (OpenAI, and the ChatGPT sign-in through Codex). The phone makes the
// offer; the computer takes it to the provider and hands back the answer, so no secret reaches the
// phone. The bot's sound plays by itself from the remote track; events go both ways as JSON on the
// `oai-events` data channel.
//
// The phone has no level of its own for either sound here, only the provider's events; the sound
// strip's level is read from the connection's statistics a few times a second. While the provider
// sends the bot's sound (`output_audio_buffer.started` to `.stopped`) and for its echo after, the
// microphone track is off, so the bot can't hear itself; the person stops it with a tap. Push to
// talk turns turn detection off and the track is on only while the button is held.
import type { LiveSession } from "@/link/types";
import { MIN_TURN_MS, RELEASE_TAIL_MS } from "./input";
import { OpenAIRealtime, transcription, turnsByHand } from "./openai";
import { LiveBase, obj, type ToolRunner } from "./types";

type WebRTC = typeof import("react-native-webrtc");
type Peer = InstanceType<WebRTC["RTCPeerConnection"]>;
type Channel = ReturnType<Peer["createDataChannel"]>;
type Stream = Awaited<ReturnType<WebRTC["mediaDevices"]["getUserMedia"]>>;

/** How often the connection is asked for its sound levels. */
const METER_MS = 150;

export type Negotiate = (sdp: string) => Promise<Extract<LiveSession, { kind: "webrtc" }>>;

export class WebRTCTransport extends LiveBase {
  /** The session's id, once the computer answered. */
  sessionId: string | null = null;
  private peer: Peer | null = null;
  private channel: Channel | null = null;
  private stream: Stream | null = null;
  private protocol: OpenAIRealtime;
  private muted = false;
  /** A response is under way, so there is one to cancel. */
  private responding = false;
  /** The provider is sending the bot's sound, so there is some to clear. */
  private sounding = false;
  /** The provider confirmed turn detection is off: a release commits the turn and asks for the answer. */
  private manual = false;
  private meter: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private reopen: ReturnType<typeof setTimeout> | null = null;
  private sending: ReturnType<typeof setTimeout> | null = null;
  /** How long the button has been held in this turn (a quick press again goes on with it). */
  private turnMs = 0;

  constructor(
    private readonly webrtc: WebRTC,
    private readonly negotiate: Negotiate,
    runTool: ToolRunner,
    private readonly route: (speaker: boolean) => Promise<void>,
    /** The person's language, a hint for their transcript. */
    private readonly language?: string,
  ) {
    super(runTool);
    this.protocol = new OpenAIRealtime({
      send: (event) => this.send(event),
      status: (status) => this.setStatus(status),
      inputItem: id => this.emit("inputItem", id),
      line: (id, who, text, options) => this.line(id, who, text, options),
      tool: (name, args) => this.tool(name, args),
      error: (message) => this.emit("error", message),
      // The provider cuts the bot's unplayed sound itself when the person talks over it.
      responding: (on) => (this.responding = on),
      playing: (on) => {
        this.sounding = on;
        this.gate.playing(on);
        this.apply();
      },
      session: (session) => (this.manual = turnsByHand(session)),
    });
  }

  /** Turns the microphone track on or off for what the gate says now, and again when that changes by itself. */
  private apply() {
    if (this.reopen) clearTimeout(this.reopen);
    this.reopen = null;
    const on = !this.muted && !this.ended && this.gate.open();
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = on;
    const wait = this.gate.wait();
    if (wait !== null && !this.ended) this.reopen = setTimeout(() => this.apply(), wait + 5);
  }

  /**
   * How loud the bot's sound and the microphone are, from the connection's own statistics
   * (`audioLevel` of the incoming sound and of the microphone's source). A build that gives no
   * such numbers reports nothing, and the dock's sound strip then keeps its still shapes.
   */
  private async readLevels() {
    const peer = this.peer;
    if (!peer || this.reading) return;
    this.reading = true;
    try {
      const stats: unknown = await peer.getStats();
      const sound: { mic?: number; out?: number } = {};
      for (const report of stats instanceof Map ? stats.values() : []) {
        const { type, kind, audioLevel } = obj(report);
        if (kind !== "audio" || typeof audioLevel !== "number") continue;
        if (type === "inbound-rtp") sound.out = audioLevel;
        else if (type === "media-source") sound.mic = this.muted ? 0 : audioLevel;
      }
      if (this.peer === peer && (sound.mic !== undefined || sound.out !== undefined)) this.hears(sound);
    } catch {
      // No statistics from this build: the strip goes without a level.
      if (this.meter) clearInterval(this.meter);
      this.meter = null;
    } finally {
      this.reading = false;
    }
  }

  private send(event: Record<string, unknown>) {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
  }

  async start() {
    const { RTCPeerConnection, mediaDevices } = this.webrtc;
    let stream: Stream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error("Allow the microphone for Botkins in the phone's Settings.");
    }
    if (this.ended) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    // In push to talk nothing goes until the button is held.
    this.apply();
    const peer = new RTCPeerConnection({});
    this.peer = peer;
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    // The channel is made before the offer, so the offer carries it.
    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.addEventListener("open", () => {
      // The person's words are written down only when the session asks for it. Push to talk turns
      // the provider's turn detection off (the Realtime conversations guide, "push-to-talk").
      const input = { transcription: transcription(this.language), ...(this.input === "push" && { turn_detection: null }) };
      this.send({ type: "session.update", session: { type: "realtime", audio: { input } } });
      this.setStatus("listening");
      this.meter ??= setInterval(() => void this.readLevels(), METER_MS);
    });
    channel.addEventListener("message", (event: { data: unknown }) => this.protocol.handle(event.data));
    // The other end closed the session's channel (the computer ended the call): this end closes too.
    // The sound's own connection can go on saying "connected" for a long time after that.
    channel.addEventListener("close", () => {
      if (!this.ended) this.fail("The call ended.");
    });
    peer.addEventListener("connectionstatechange", () => {
      const state = peer.connectionState;
      if ((state === "failed" || state === "closed" || state === "disconnected") && !this.ended) this.fail(state === "failed" ? "The call's connection failed." : "The call ended.");
    });
    const offer = (await peer.createOffer({})) as { sdp: string; type: string };
    await peer.setLocalDescription(offer as never);
    const session = await this.negotiate(offer.sdp);
    this.sessionId = session.id;
    if (this.ended) return;
    await peer.setRemoteDescription({ type: "answer", sdp: session.sdp } as never);
  }

  mute(muted: boolean) {
    this.muted = muted;
    this.apply();
  }

  interrupt() {
    if (this.ended) return;
    // Over WebRTC the provider plays the sound: clearing its buffer stops it and cuts the item there.
    if (this.responding) this.send({ type: "response.cancel" });
    if (this.sounding) this.send({ type: "output_audio_buffer.clear" });
    this.responding = false;
    this.sounding = false;
    this.gate.cut();
    this.apply();
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
      if (this.responding || this.sounding) this.interrupt();
      this.send({ type: "input_audio_buffer.clear" });
    }
    this.gate.press();
    this.apply();
    this.setStatus("listening");
  }

  release() {
    if (!this.gate.holding) return;
    this.turnMs += this.gate.release();
    const held = this.turnMs;
    // The track stays on a moment (apply's timer turns it off), so the last word gets there first.
    this.apply();
    this.sending = setTimeout(() => {
      this.sending = null;
      this.apply();
      // Where the provider kept its own turn detection, it hears the silence and answers by itself.
      if (this.ended || !this.manual) return;
      if (held < MIN_TURN_MS || this.quietTurn) {
        this.send({ type: "input_audio_buffer.clear" });
        return;
      }
      this.send({ type: "input_audio_buffer.commit" });
      this.send({ type: "response.create" });
      this.setStatus("thinking");
    }, RELEASE_TAIL_MS + 10);
  }

  setSpeaker(on: boolean) {
    return this.route(on);
  }

  protected close() {
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
    if (this.reopen) clearTimeout(this.reopen);
    if (this.sending) clearTimeout(this.sending);
    this.reopen = null;
    this.sending = null;
    try {
      this.channel?.close();
    } catch {
      // Already closed.
    }
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream?.release();
    this.stream = null;
  }
}
