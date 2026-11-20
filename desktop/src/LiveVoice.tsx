import { useEffect, useRef } from "react";
import { Mic, MicOff, PhoneOff, X } from "lucide-react";
import { closeLive, endLive, muteLive, useLive, type LiveState } from "./voice";
import "./voice.css";

const PROVIDERS: Record<string, string> = { codex: "ChatGPT", openai: "OpenAI", gemini: "Gemini", elevenlabs: "ElevenLabs" };

/** Five bars that rise with the sound. */
export function Meter({ level, who }: { level: number; who?: "you" | "bot" | null }) {
  const shape = [0.55, 0.8, 1, 0.8, 0.55];
  return (
    <span className={"voice-meter" + (who === "you" ? " you" : "")} aria-hidden="true">
      {shape.map((k, i) => {
        const h = Math.max(3, Math.round(level * k * 26));
        return <i key={i} className={level > 0.04 ? "on" : undefined} style={{ height: h }} />;
      })}
    </span>
  );
}

function title(state: LiveState, bot: string) {
  if (state.status === "error") return "Live voice stopped";
  if (state.status === "connecting") return "Connecting to " + bot + "…";
  if (state.working && state.speaking !== "bot") return bot + " is working on it…";
  if (state.speaking === "bot") return bot + " is speaking";
  if (state.speaking === "you") return "You're speaking";
  return state.muted ? "Muted" : "Listening";
}

/** The live voice panel over the composer: who is speaking, the meter, what was said, Mute and End. */
export default function LivePanel({ chatId, botName }: { chatId?: string; botName: string }) {
  const state = useLive();
  const lines = useRef<HTMLDivElement>(null);
  useEffect(() => {
    lines.current?.scrollTo({ top: lines.current.scrollHeight });
  }, [state?.transcript]);
  if (!state) return null;
  const elsewhere = !!chatId && state.chatId !== chatId;
  const bot = elsewhere ? "another chat" : botName || "The bot";
  const by = PROVIDERS[state.provider] ?? state.provider;
  return (
    <div className="live-panel" role="region" aria-label="Live voice">
      <div className="live-head">
        <Meter level={state.status === "live" ? state.level : 0} who={state.speaking} />
        <div className="live-who">
          <strong role="status">{elsewhere && state.status !== "error" ? "Live voice is on in another chat" : title(state, bot)}</strong>
          <small>Live voice by {by}</small>
        </div>
        <div className="live-buttons">
          {state.status === "error" ? (
            <button type="button" className="set-button" onClick={closeLive}>
              <X size={14} aria-hidden="true" />
              Close
            </button>
          ) : (
            <>
              <button type="button" className="set-button" aria-pressed={state.muted} aria-label={state.muted ? "Unmute" : "Mute"} onClick={() => muteLive(!state.muted)}>
                {state.muted ? <MicOff size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
                {state.muted ? "Unmute" : "Mute"}
              </button>
              <button type="button" className="set-button primary" aria-label="End live voice" onClick={endLive}>
                <PhoneOff size={14} aria-hidden="true" />
                End
              </button>
            </>
          )}
        </div>
      </div>
      {state.transcript.length > 0 && !elsewhere && (
        <div className="live-transcript" ref={lines} aria-live="polite" aria-label="What was said">
          {state.transcript.map((line, i) => (
            <p key={i} className={line.final ? undefined : "partial"}>
              <b>{line.role === "user" ? "You" : bot}</b>
              {line.text}
            </p>
          ))}
        </div>
      )}
      {state.error && (
        <p className="live-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}
