import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AudioLines, Info, Mic, Square } from "lucide-react";
import { Recorder, startLive, useLive, voiceError } from "./voice";
import { effectiveLive } from "./botVoice";
import type { BotAvatarProps } from "./Avatar";
import type { BotVoice } from "./types";
import LiveVoice, { Meter } from "./LiveVoice";
import "./voice.css";

const api = window.botkins;
const openVoiceSettings = () => window.dispatchEvent(new CustomEvent("botkins-open-settings", { detail: "Voice" }));

type Note = { text: string; settings?: boolean; error?: boolean };

/**
 * The composer's voice: the microphone (dictation into the message box, never sent by itself) and
 * the Live Voice button. `strip` goes above the message box; `mic` and `live` are its buttons.
 * While live voice is on in this chat, `strip` holds the voice dock and `docked` tells the composer
 * to leave its message box out, until the person asks to type.
 */
export function useComposerVoice({
  chatId,
  bot,
  botName,
  botVoice,
  draft,
  change,
  input,
  startChat,
}: {
  chatId?: string;
  /** The bot the voice dock shows. */
  bot?: BotAvatarProps["bot"];
  botName?: string;
  /** The bot's voice of its own, if it has one. */
  botVoice?: BotVoice;
  draft: string;
  change: (value: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
  startChat?: () => Promise<string>;
}) {
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [writing, setWriting] = useState(false);
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState<Note | null>(null);
  const language = useRef<string | undefined>(undefined);
  const liveState = useLive();
  // The dock's keyboard button puts the message box back while the call goes on. Each call starts docked.
  const [typing, setTyping] = useState(false);
  const calling = !!liveState;
  useEffect(() => {
    if (!calling) setTyping(false);
  }, [calling]);
  const docked = !!liveState && !!chatId && liveState.chatId === chatId && !typing;
  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing, input]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The meter while recording.
  useEffect(() => {
    if (!recorder) return;
    const timer = setInterval(() => setLevel(Math.round(recorder.level() * 20) / 20), 80);
    return () => clearInterval(timer);
  }, [recorder]);
  // A recording that is left behind (another chat opened) is dropped, never sent anywhere.
  const recording = useRef<Recorder | null>(null);
  recording.current = recorder;
  useEffect(() => () => recording.current?.cancel(), []);
  // A short note goes away by itself.
  useEffect(() => {
    if (!note || note.settings || note.error) return;
    const timer = setTimeout(() => setNote(null), 9000);
    return () => clearTimeout(timer);
  }, [note]);

  /** Puts text into the message box at the cursor, with a space on either side where it needs one. */
  function insert(text: string) {
    const el = input.current;
    const value = draftRef.current;
    const start = Math.min(el?.selectionStart ?? value.length, value.length);
    const end = Math.min(el?.selectionEnd ?? start, value.length);
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const tail = after && !/^\s/.test(after) ? " " : "";
    const next = (before + lead + text + tail + after).slice(0, 32000);
    const at = Math.min(next.length, (before + lead + text).length);
    change(next);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  }

  async function dictate() {
    if (recorder) return finish();
    setNote(null);
    try {
      const settings = await api.voiceSettings();
      if (settings.stt.provider === "device") {
        if (settings.device.stt) {
          input.current?.focus();
          const started = await api.startDictation();
          if (started.started) setNote({ text: "Dictation is on. Speak, then press Done in the Mac's dictation, or Escape. If nothing happens, switch Dictation on in System Settings › Keyboard." });
          return;
        }
        const info = await api.appInfo().catch(() => null);
        setNote({
          text:
            info?.platform === "win32"
              ? "Windows has no dictation Botkins can start. Press Windows key + H to dictate here, or choose a speech service in Settings › Voice."
              : "This computer has no dictation Botkins can start. Choose a speech service in Settings › Voice.",
          settings: true,
        });
        return;
      }
      language.current = settings.stt.language;
      const next = new Recorder();
      await next.start();
      setRecorder(next);
    } catch (e) {
      setNote({ text: voiceError(e), error: true });
    }
  }
  async function finish() {
    const current = recorder;
    if (!current) return;
    setRecorder(null);
    setWriting(true);
    try {
      const { bytes, format } = await current.stop();
      const { text } = await api.transcribe(bytes, format, language.current);
      if (text) insert(text);
      else setNote({ text: "Nothing was heard. Try again, a little closer to the microphone." });
    } catch (e) {
      setNote({ text: voiceError(e), error: true });
    } finally {
      setWriting(false);
    }
  }
  function cancel() {
    recorder?.cancel();
    setRecorder(null);
  }

  async function live() {
    setNote(null);
    try {
      const settings = await api.voiceSettings();
      // This bot's own live voice, when it has one, over the shared choice (the main process applies it to the call).
      const provider = effectiveLive(settings.live, botVoice?.live).provider;
      if (!provider) return setNote({ text: "Live voice needs a voice to talk with. Choose one in Settings › Voice.", settings: true });
      if (!settings.ready) return setNote({ text: settings.problem || "Voice isn't ready yet.", error: true });
      if (provider === "codex" && !settings.providers.codex.signedIn)
        return setNote({ text: "Live voice by ChatGPT needs you signed in with ChatGPT in Settings › Model providers.", settings: true });
      // A key that isn't there yet is asked for here, before a chat is made or the microphone opens.
      const named = { openai: "OpenAI", azure: "Azure", gemini: "Gemini", elevenlabs: "ElevenLabs" } as const;
      if (provider !== "codex" && !settings.providers[provider].hasKey)
        return setNote({ text: "Live voice by " + named[provider] + " needs " + (provider === "gemini" ? "a " : "an ") + named[provider] + " key. Add it in Settings › Voice.", settings: true });
      // Azure's live voice goes to the resource's own address, not a region.
      if (provider === "azure" && !settings.providers.azure.endpoint) return setNote({ text: "Live voice by Azure needs your resource's endpoint. Add it in Settings › Voice.", settings: true });
      const id = chatId ?? (await startChat?.());
      if (!id) return;
      startLive(id, provider);
    } catch (e) {
      setNote({ text: voiceError(e), error: true });
    }
  }

  // Escape stops a recording without writing anything.
  useEffect(() => {
    if (!recorder) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [recorder]);

  let strip: ReactNode = null;
  if (recorder)
    strip = (
      <div className="voice-strip" role="status" aria-label="Recording">
        <span className="voice-dot" aria-hidden="true" />
        <span>Listening… Press Done when you have finished.</span>
        <Meter level={level} who="you" />
        <span className="voice-actions">
          <button type="button" className="set-button primary" onClick={() => void finish()}>
            Done
          </button>
          <button type="button" className="set-button" onClick={cancel}>
            Cancel
          </button>
        </span>
      </div>
    );
  else if (writing)
    strip = (
      <div className="voice-strip" role="status">
        <span>Writing out what you said…</span>
      </div>
    );
  else if (note)
    strip = (
      <div className={"voice-strip note" + (note.error ? " error" : "")} role={note.error ? "alert" : "status"}>
        <Info size={14} aria-hidden="true" />
        <span>{note.text}</span>
        <span className="voice-actions">
          {note.settings && (
            <button
              type="button"
              className="set-button primary"
              onClick={() => {
                setNote(null);
                openVoiceSettings();
              }}
            >
              Choose in Settings › Voice
            </button>
          )}
          <button type="button" className="set-button" aria-label="Close note" onClick={() => setNote(null)}>
            Close
          </button>
        </span>
      </div>
    );
  return {
    docked,
    strip: (
      <>
        {liveState && <LiveVoice chatId={chatId} bot={bot} botName={botName ?? ""} typing={typing} setTyping={setTyping} />}
        {strip}
      </>
    ),
    mic: (
      <button
        type="button"
        className={"composer-model composer-mic" + (recorder ? " recording" : "")}
        aria-label={recorder ? "Stop dictating" : "Dictate"}
        aria-pressed={!!recorder}
        title={recorder ? "Done" : "Dictate"}
        disabled={writing}
        onClick={() => void dictate()}
      >
        {recorder ? <Square size={15} /> : <Mic size={18} />}
      </button>
    ),
    live: (
      <button type="button" className="send live-voice" aria-label="Live voice" title={"Talk with " + (botName || "the bot") + " out loud"} disabled={!!liveState && liveState.status !== "error"} onClick={() => void live()}>
        <AudioLines size={18} />
      </button>
    ),
  };
}
