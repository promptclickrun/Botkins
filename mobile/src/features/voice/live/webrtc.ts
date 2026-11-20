// OpenAI Realtime over WebRTC (OpenAI, and the ChatGPT sign-in through Codex). The phone makes the
// offer; the computer takes it to the provider and hands back the answer, so no secret reaches the
// phone. The bot's sound plays by itself from the remote track; events go both ways as JSON on the
// `oai-events` data channel.
import type { LiveSession } from "@/link/types";
import { OpenAIRealtime, TRANSCRIBE_MODEL } from "./openai";
import { LiveBase, type ToolRunner } from "./types";

type WebRTC = typeof import("react-native-webrtc");
type Peer = InstanceType<WebRTC["RTCPeerConnection"]>;
type Channel = ReturnType<Peer["createDataChannel"]>;
type Stream = Awaited<ReturnType<WebRTC["mediaDevices"]["getUserMedia"]>>;

export type Negotiate = (sdp: string) => Promise<Extract<LiveSession, { kind: "webrtc" }>>;

export class WebRTCTransport extends LiveBase {
  /** The session's id, once the computer answered. */
  sessionId: string | null = null;
  private peer: Peer | null = null;
  private channel: Channel | null = null;
  private stream: Stream | null = null;
  private protocol: OpenAIRealtime;

  constructor(
    private readonly webrtc: WebRTC,
    private readonly negotiate: Negotiate,
    runTool: ToolRunner,
    private readonly route: (speaker: boolean) => Promise<void>,
  ) {
    super(runTool);
    this.protocol = new OpenAIRealtime({
      send: (event) => this.send(event),
      status: (status) => this.setStatus(status),
      line: (id, who, text, options) => this.line(id, who, text, options),
      tool: (name, args) => this.tool(name, args),
      error: (message) => this.emit("error", message),
      // The provider cuts the bot's unplayed sound itself when the person talks over it.
    });
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
    const peer = new RTCPeerConnection({});
    this.peer = peer;
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    // The channel is made before the offer, so the offer carries it.
    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.addEventListener("open", () => {
      // The person's words are written down only when the session asks for it.
      this.send({ type: "session.update", session: { type: "realtime", audio: { input: { transcription: { model: TRANSCRIBE_MODEL } } } } });
      this.setStatus("listening");
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
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  setSpeaker(on: boolean) {
    return this.route(on);
  }

  protected close() {
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
