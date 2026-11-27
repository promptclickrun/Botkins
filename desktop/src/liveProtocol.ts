/** Provider wire messages shared by live voice and its protocol tests. */
export type LiveInputMode = "conversation" | "push";

export interface LiveSocketLike {
  readonly readyState: number;
  send(data: string): void;
}

const SOCKET_OPEN = 1;

/**
 * Whether a provider speaks OpenAI Realtime GA client events on `oai-events` / WebSocket.
 * Codex Realtime v3 runs its session over app-server's sidechannel and rejects GA client commands
 * (`session.update` with `session.type`, `response.cancel`, `output_audio_buffer.clear`,
 * `input_audio_buffer.*`) with a fatal `invalid_request_error`.
 */
export function usesOpenAiRealtimeClientEvents(provider: string): boolean {
  return provider === "openai" || provider === "azure";
}

export function openAiManualTurn(turnMs: number): Record<string, unknown>[] {
  return turnMs >= 250
    ? [{ type: "input_audio_buffer.commit" }, { type: "response.create" }]
    : [{ type: "input_audio_buffer.clear" }];
}

export function geminiManualTurn(action: "start" | "end"): Record<string, unknown> {
  return { realtimeInput: action === "start" ? { activityStart: {} } : { activityEnd: {} } };
}

/** Disables Gemini's automatic voice activity detection for push-to-talk sessions. */
export function geminiSetupForInput(session: Record<string, unknown>, mode: LiveInputMode): Record<string, unknown> {
  if (mode !== "push") return session;
  const inner = session.setup && typeof session.setup === "object" ? (session.setup as Record<string, unknown>) : session;
  const config = inner.realtimeInputConfig && typeof inner.realtimeInputConfig === "object" ? (inner.realtimeInputConfig as Record<string, unknown>) : {};
  return {
    ...session,
    setup: {
      ...inner,
      realtimeInputConfig: { ...config, automaticActivityDetection: { disabled: true } },
    },
  };
}

/** Turns a Gemini close reason into text the person can act on. */
export function formatGeminiCloseError(reason: string | undefined, beforeSetup = false): string {
  const text = (reason ?? "").trim();
  if (/precondition/i.test(text)) {
    return "Gemini rejected a voice turn (precondition failed). Restart the call, or switch voice input mode in Settings.";
  }
  const suffix = text ? ": " + text.slice(0, 200).replace(/\.?$/, ".") : ".";
  if (beforeSetup) return text ? "Gemini refused the call" + suffix : "Gemini closed the connection.";
  return text ? "Gemini ended the call" + suffix : "The live voice ended.";
}

/** Enforces Gemini Live's setup and manual activity sequencing on one WebSocket session. */
export class GeminiLiveSession {
  setupComplete = false;
  activityOpen = false;
  readonly mode: LiveInputMode;
  private readonly setup: Record<string, unknown>;
  private readonly mimeType: string;

  constructor(mode: LiveInputMode, setup: Record<string, unknown>, inputRate: number) {
    this.mode = mode;
    this.setup = setup;
    this.mimeType = "audio/pcm;rate=" + inputRate;
  }

  private send(socket: LiveSocketLike | null, message: Record<string, unknown>): boolean {
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  onOpen(socket: LiveSocketLike | null): boolean {
    return this.send(socket, geminiSetupForInput(this.setup, this.mode));
  }

  onSetupComplete() {
    this.setupComplete = true;
  }

  press(socket: LiveSocketLike | null): boolean {
    if (this.mode !== "push" || !this.setupComplete) return false;
    if (this.activityOpen) return true;
    if (!this.send(socket, geminiManualTurn("start"))) return false;
    this.activityOpen = true;
    return true;
  }

  release(socket: LiveSocketLike | null): boolean {
    if (this.mode !== "push" || !this.setupComplete || !this.activityOpen) return false;
    this.activityOpen = false;
    return this.send(socket, geminiManualTurn("end"));
  }

  sendAudio(socket: LiveSocketLike | null, data: string): boolean {
    if (!this.setupComplete) return false;
    if (this.mode === "push" && !this.activityOpen) return false;
    return this.send(socket, { realtimeInput: { audio: { data, mimeType: this.mimeType } } });
  }

  mute(socket: LiveSocketLike | null, muted: boolean): boolean {
    if (!muted || !this.setupComplete || this.mode !== "conversation") return false;
    return this.send(socket, { realtimeInput: { audioStreamEnd: true } });
  }

  reset() {
    this.setupComplete = false;
    this.activityOpen = false;
  }
}
