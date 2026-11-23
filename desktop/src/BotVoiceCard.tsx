// A bot's own voice ("bot-voice-v1"): who reads its replies and who talks in live voice with it, when
// that isn't what Settings › Voice says. A choice left on "Same as Settings" follows Settings. The
// choices are saved with the bot; keys stay shared. When the bot reads with "This computer" its
// system voice is kept in this window's own settings, because a system voice isn't portable.
// The phone has the same card (mobile/src/features/bots/BotVoice.tsx), in the same words.
import { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import { botDeviceVoices, botVoiceSummary, effectiveLive, effectiveTts, LIVE_NAMES, providerLack, setBotDeviceVoice, tidyVoice, TTS_NAMES, unpinIfBare, withProvider, withSection } from "./botVoice";
import type { Bot, BotVoice, DeskVoiceSettings, LiveProvider, TtsProvider } from "./types";
import { errorText } from "./SettingsRows";
import { useOptions } from "./VoiceSettings";
import { readAloud, systemVoices, useReading } from "./voice";
import "./voice.css";

const api = window.botkins;
const SAMPLE = "Hello. This is how Botkins reads replies aloud.";
const SAMPLE_KEY = "bot-voice-sample";
const TTS_ORDER = Object.keys(TTS_NAMES) as TtsProvider[];
const LIVE_ORDER = Object.keys(LIVE_NAMES) as LiveProvider[];

type Item = { id: string; name: string };

/** One labelled choice. The empty value says what leaving it alone means. */
function Pick({ label, value, empty, items, change, disabledIds = [] }: { label: string; value: string; empty: string; items: Item[]; change: (id: string) => void; disabledIds?: string[] }) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => change(e.target.value)}>
        <option value="">{empty}</option>
        {value && !items.some((item) => item.id === value) && <option value={value}>{value}</option>}
        {items.map((item) => (
          <option key={item.id} value={item.id} disabled={disabledIds.includes(item.id) && item.id !== value}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The bot page's Voice card. */
export default function BotVoiceCard({ bot }: { bot: Bot }) {
  const [shared, setShared] = useState<DeskVoiceSettings>();
  const [error, setError] = useState("");
  const [systems, setSystems] = useState<Item[]>([]);
  // This computer's own voice for the bot, kept in this window.
  const [local, setLocal] = useState(() => botDeviceVoices()[bot.id]);
  useEffect(() => setLocal(botDeviceVoices()[bot.id]), [bot.id]);
  useEffect(() => {
    let live = true;
    api.voiceSettings().then((next) => live && setShared(next), (e) => live && setError(errorText(e)));
    void systemVoices().then((list) => live && setSystems(list.map((v) => ({ id: v.voiceURI, name: v.name + (v.lang ? " (" + v.lang + ")" : "") }))));
    return () => {
      live = false;
    };
  }, [bot.id]);
  const reading = useReading();
  const own = bot.voice;
  const tts = shared ? effectiveTts(shared.tts, own?.tts) : undefined;
  const live = shared ? effectiveLive(shared.live, own?.live) : undefined;
  const stamp = JSON.stringify(shared?.providers ?? null);
  const ttsOptions = useOptions("tts", tts?.provider ?? null, stamp, tts?.model ?? "");
  const liveOptions = useOptions("live", live?.provider ?? null, stamp);
  const [speed, setSpeed] = useState(1);
  // The speed is saved a moment after the slider stops: into the bot's voice as it is then, so a
  // provider or voice picked meanwhile is not undone.
  const latest = useRef({ own, provider: tts?.provider });
  latest.current = { own, provider: tts?.provider };
  const shown = tts?.provider === "device" ? (local?.speed ?? 1) : (tts?.speed ?? 1);
  useEffect(() => setSpeed(shown), [shown, bot.id]);
  useEffect(() => {
    if (!shared || speed === shown) return;
    const timer = setTimeout(() => {
      if (latest.current.provider === "device") {
        setBotDeviceVoice(bot.id, { speed });
        setLocal(botDeviceVoices()[bot.id]);
      } else save(withSection(latest.current.own, "tts", { speed }));
    }, 350);
    return () => clearTimeout(timer);
  }, [speed]);
  /** Saves the bot's voice with the bot. A voice with nothing set clears it. */
  function save(next: BotVoice | null) {
    setError("");
    void api.updateBot(bot.id, { voice: tidyVoice(next ?? undefined) }).catch((e) => setError(errorText(e)));
  }
  if (!shared || !tts || !live)
    return (
      <section className="profile-card bot-voice" aria-labelledby="bot-voice-title">
        <h2 id="bot-voice-title">Voice</h2>
        <p className="muted">{error ? "Couldn't read the voice settings. " + error : "Reading the voice settings…"}</p>
      </section>
    );
  const onComputer = tts.provider === "device";
  const none = (same: boolean) => (same ? "Same as Settings" : "Default");
  const ttsItems = TTS_ORDER.map((id) => {
    const lack = providerLack("tts", id, shared);
    return { id, name: TTS_NAMES[id] + (lack ? " (" + lack + ")" : "") };
  });
  const liveItems = LIVE_ORDER.map((id) => {
    const lack = providerLack("live", id, shared);
    return { id, name: LIVE_NAMES[id] + (lack ? " (" + lack + ")" : "") };
  });
  const lackOf = (kind: "tts" | "live", provider: string | null) => (provider ? providerLack(kind, provider, shared) : null);
  const playing = reading.key === SAMPLE_KEY;
  return (
    <section className="profile-card bot-voice" aria-labelledby="bot-voice-title">
      <h2 id="bot-voice-title">Voice</h2>
      <p className="muted">{botVoiceSummary(own, shared)}</p>
      <fieldset>
        <legend>Reading aloud</legend>
        <Pick
          label="Provider"
          value={own?.tts?.provider ?? ""}
          empty={"Same as Settings (" + TTS_NAMES[shared.tts.provider] + ")"}
          items={ttsItems}
          disabledIds={TTS_ORDER.filter((id) => lackOf("tts", id))}
          change={(provider) => save(withProvider(own, "tts", provider || undefined))}
        />
        {lackOf("tts", tts.provider) && <small className="muted">This provider {lackOf("tts", tts.provider)}. Set it up in Settings › Voice.</small>}
        {!onComputer && ttsOptions.options.models.length > 0 && (
          <Pick label="Model" value={own?.tts?.model ?? ""} empty={none(tts.provider === shared.tts.provider)} items={ttsOptions.options.models.filter((item) => item.id)} change={(model) => save(unpinIfBare(withSection(own, "tts", { ...(model ? { provider: own?.tts?.provider ?? tts.provider ?? undefined } : {}), model: model || undefined }), "tts", shared.tts.provider))} />
        )}
        {(onComputer ? systems : ttsOptions.options.voices).length > 0 && (
          <Pick
            label="Voice"
            value={onComputer ? (local?.voice ?? "") : (own?.tts?.voice ?? "")}
            empty={onComputer ? "Default" : none(tts.provider === shared.tts.provider)}
            items={onComputer ? systems : ttsOptions.options.voices}
            change={(voice) => {
              if (onComputer) {
                setBotDeviceVoice(bot.id, { voice: voice || undefined });
                setLocal(botDeviceVoices()[bot.id]);
              } else save(unpinIfBare(withSection(own, "tts", { ...(voice ? { provider: own?.tts?.provider ?? tts.provider ?? undefined } : {}), voice: voice || undefined }), "tts", shared.tts.provider));
            }}
          />
        )}
        {tts.provider !== "gemini" && (
          <label>
            Speed
            <span className="voice-speed">
              <input type="range" min={0.5} max={2} step={0.05} value={speed} aria-valuetext={speed.toFixed(2) + " times"} onChange={(e) => setSpeed(Number(e.target.value))} />
              <output>{speed.toFixed(2).replace(/0$/, "")}×</output>
            </span>
          </label>
        )}
        {onComputer ? <small className="muted">Voice and speed are saved on this computer.</small> : tts.provider === "gemini" ? <small className="muted">Gemini reads at its own speed.</small> : null}
        <div className="bot-voice-actions">
          <button type="button" className="secondary" aria-label={playing ? "Stop the sample" : "Play a sample"} onClick={() => void readAloud(SAMPLE_KEY, SAMPLE, bot.id)}>
            {playing ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
            {playing ? "Stop" : "Play sample"}
          </button>
        </div>
        {reading.error && reading.key === null && <small className="error-text" role="alert">{reading.error}</small>}
      </fieldset>
      <fieldset>
        <legend>Live voice</legend>
        <Pick
          label="Provider"
          value={own?.live?.provider ?? ""}
          empty={"Same as Settings (" + (shared.live.provider ? LIVE_NAMES[shared.live.provider] : "Off") + ")"}
          items={liveItems}
          disabledIds={LIVE_ORDER.filter((id) => lackOf("live", id))}
          change={(provider) => save(withProvider(own, "live", provider || undefined))}
        />
        {lackOf("live", live.provider) && <small className="muted">This provider {lackOf("live", live.provider)}. Set it up in Settings › Voice.</small>}
        {!!live.provider && liveOptions.options.models.length > 0 && (
          <Pick label="Model" value={own?.live?.model ?? ""} empty={none(live.provider === shared.live.provider)} items={liveOptions.options.models} change={(model) => save(unpinIfBare(withSection(own, "live", { ...(model ? { provider: own?.live?.provider ?? live.provider ?? undefined } : {}), model: model || undefined }), "live", shared.live.provider))} />
        )}
        {!!live.provider && liveOptions.options.voices.length > 0 && (
          <Pick label="Voice" value={own?.live?.voice ?? ""} empty={none(live.provider === shared.live.provider)} items={liveOptions.options.voices} change={(voice) => save(unpinIfBare(withSection(own, "live", { ...(voice ? { provider: own?.live?.provider ?? live.provider ?? undefined } : {}), voice: voice || undefined }), "live", shared.live.provider))} />
        )}
        <small className="muted">Keys and sign-ins are set in Settings › Voice.</small>
      </fieldset>
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  );
}
