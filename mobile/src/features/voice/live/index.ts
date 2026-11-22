// Picks the transport a live session needs and builds it with what this build has.
import type { LiveProvider, LiveSession } from "@/link/types";
import { ElevenLabsTransport } from "./elevenlabs";
import { GeminiTransport } from "./gemini";
import { OpenAISocketTransport } from "./openai";
import type { Connect, DuplexLike, LiveTransport, ToolRunner } from "./types";
import { type Negotiate, WebRTCTransport } from "./webrtc";

export type { Line, LiveStatus, LiveTransport } from "./types";
export { chatTools, type ChatAccess, type ChatSnapshot } from "./askBot";

type WebRTC = typeof import("react-native-webrtc");

export type Kit = { webrtc: WebRTC | null; duplex: DuplexLike | null; connect: Connect; route: (speaker: boolean) => Promise<void> };

/** Whether this build can talk to a provider, and how: with an offer (WebRTC) or without one (a socket). */
export function planFor(provider: LiveProvider, kit: Pick<Kit, "webrtc" | "duplex">): "offer" | "socket" | null {
  if (provider === "codex") return kit.webrtc ? "offer" : null;
  if (provider === "openai") return kit.webrtc ? "offer" : kit.duplex ? "socket" : null;
  return kit.duplex ? "socket" : null;
}

export function webrtcTransport(kit: Kit, negotiate: Negotiate, tools: ToolRunner, language?: string): WebRTCTransport {
  return new WebRTCTransport(kit.webrtc!, negotiate, tools, kit.route, language);
}

/** The socket transport for a session the computer set up without an offer. */
export function socketTransport(session: LiveSession, kit: Kit, tools: ToolRunner): LiveTransport | null {
  if (!kit.duplex) return null;
  switch (session.kind) {
    case "openai-ws":
      return new OpenAISocketTransport(session, kit.duplex, kit.connect, tools);
    case "gemini-ws":
      return new GeminiTransport(session, kit.duplex, kit.connect, tools);
    case "elevenlabs-ws":
      return new ElevenLabsTransport(session, kit.duplex, kit.connect, tools);
    default:
      return null;
  }
}
