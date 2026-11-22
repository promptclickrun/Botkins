import { useEffect } from "react";
import { Keyboard, Mic, MicOff, PhoneOff, Volume2, VolumeX, X } from "lucide-react";
import { BotAvatar, type AvatarState, type BotAvatarProps } from "./Avatar";
import { closeLive, endLive, interruptLive, muteLive, pressLive, releaseLive, speakerLive, useLive, type LiveState } from "./voice";
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

const WAVE = [4, 8, 14, 22, 16, 10, 18, 26, 20, 12, 6, 16, 24, 28, 18, 8, 12, 20, 14, 6, 4];

/** The dock's sound strip: a row of bars that take the voice's shape, as tall as the sound is loud. */
function SoundStrip({ level, who, bars = WAVE.length }: { level: number; who: LiveState["speaking"]; bars?: number }) {
  const loud = Math.min(1, level * 2.5);
  return (
    <span className={"voice-wave" + (who === "you" ? " you" : "")} aria-hidden="true">
      {WAVE.slice(0, bars).map((height, i) => (
        <i key={i} className={level > 0.04 ? "on" : undefined} style={{ height: Math.max(4, Math.round(height * loud)) }} />
      ))}
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

function face(state: LiveState): AvatarState {
  if (state.status === "error") return "error";
  if (state.status === "connecting") return "pending";
  if (state.speaking === "bot") return "talking";
  return state.working ? "working" : "listening";
}

/** Hands-free: stops the bot while it speaks. Push to talk: holds the microphone open. */
function holdToTalk() {
  return {
    onPointerDown: (event: React.PointerEvent) => {
      event.preventDefault();
      pressLive();
    },
    onPointerUp: (event: React.PointerEvent) => {
      event.preventDefault();
      releaseLive();
    },
    onPointerCancel: releaseLive,
    onPointerLeave: releaseLive,
  };
}

/**
 * Live voice in the composer. In the call's own chat it is the voice dock, drawn in place of the
 * message box: the bot stands on its top edge, large, then who is speaking, the sound strip, Mute,
 * Sound, the keyboard (back to typing, the call goes on) and End. While the person types, or in
 * another chat, it is one line above the message box.
 */
export default function LiveVoice({ chatId, bot, botName, typing, setTyping }: { chatId?: string; bot?: BotAvatarProps["bot"]; botName: string; typing: boolean; setTyping: (typing: boolean) => void }) {
  const state = useLive();
  const elsewhere = !!chatId && !!state && state.chatId !== chatId;
  const push = !!state && state.inputMode === "push" && !elsewhere;
  const speaking = !!state && state.status === "live" && state.speaking === "bot" && !elsewhere;
  useEffect(() => {
    if (!push) return;
    const key = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      pressLive();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      releaseLive();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", up, true);
    // A held Space key does not produce keyup when the window loses focus. Releasing here keeps
    // the microphone closed and sends the provider's end-of-turn message immediately.
    window.addEventListener("blur", releaseLive, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", releaseLive, true);
      releaseLive();
    };
  }, [push]);
  // Hands-free, Escape stops the bot while it speaks. A dialog or menu that took the key keeps it.
  const escapes = speaking && !push;
  useEffect(() => {
    if (!escapes) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      interruptLive();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [escapes]);
  if (!state) return null;
  const name = botName || "The bot";
  const by = PROVIDERS[state.provider] ?? state.provider;
  const failed = state.status === "error";
  const level = state.status === "live" ? state.level : 0;
  const end = (
    <button type="button" className="set-button voice-end" aria-label={failed ? "Close" : "End live voice"} onClick={failed ? closeLive : endLive}>
      {failed ? <X size={14} aria-hidden="true" /> : <PhoneOff size={14} aria-hidden="true" />}
      {failed ? "Close" : "End"}
    </button>
  );

  // One line above the message box: the call is in another chat, or the person is typing in this one.
  if (elsewhere || typing)
    return (
      <div className={"voice-strip" + (failed ? " error" : "")} role="region" aria-label="Live voice">
        <Meter level={level} who={state.speaking} />
        <span role="status">{elsewhere && !failed ? "Live voice is on in another chat" : failed ? state.error || "Live voice stopped" : title(state, name)}</span>
        <span className="voice-actions">
          {!elsewhere && (
            <button type="button" className="set-button" onClick={() => setTyping(false)}>
              Show the call
            </button>
          )}
          {end}
        </span>
      </div>
    );

  const hint = failed ? "" : push ? "Hold the bar or the Space key to talk" : speaking ? "Click " + name + " or press Esc to interrupt" : "Live voice by " + by;
  return (
    <div className="voice-dock" role="region" aria-label="Live voice">
      <button type="button" className="voice-dock-face" aria-label={"Interrupt " + name} disabled={!speaking || push} onClick={interruptLive}>
        <BotAvatar bot={bot} state={face(state)} size={108} badge />
      </button>
      <div className="voice-dock-who">
        <strong role="status">{title(state, name)}</strong>
        {failed ? (
          <small className="live-error" role="alert">
            {state.error}
          </small>
        ) : (
          <small>{hint}</small>
        )}
      </div>
      {failed ? (
        <span className="voice-dock-sound" />
      ) : push ? (
        <button type="button" className="voice-hold" aria-label="Hold to talk" disabled={state.status !== "live"} {...holdToTalk()}>
          <SoundStrip level={level} who={state.speaking} bars={9} />
          Hold to talk
        </button>
      ) : (
        <span className="voice-dock-sound">
          <SoundStrip level={level} who={state.speaking} />
        </span>
      )}
      <div className="voice-dock-buttons">
        {!failed && !push && (
          <button type="button" className="voice-round" aria-pressed={state.muted} aria-label={state.muted ? "Unmute" : "Mute"} title={state.muted ? "Unmute" : "Mute"} onClick={() => muteLive(!state.muted)}>
            {state.muted ? <MicOff size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
          </button>
        )}
        {!failed && (
          <button type="button" className="voice-round" aria-pressed={!state.speaker} aria-label={state.speaker ? "Turn the sound off" : "Turn the sound on"} title={state.speaker ? "Turn the sound off" : "Turn the sound on"} onClick={() => speakerLive(!state.speaker)}>
            {state.speaker ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}
          </button>
        )}
        <button type="button" className="voice-round" aria-label="Type a message" title="Type a message" onClick={() => setTyping(true)}>
          <Keyboard size={17} aria-hidden="true" />
        </button>
        {end}
      </div>
    </div>
  );
}
