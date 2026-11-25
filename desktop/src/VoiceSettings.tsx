import { useEffect, useState } from "react";
import { ArrowLeft, AudioLines, Check, KeyRound, Mic, Play, Square, Volume2, type LucideIcon } from "lucide-react";
import { Slider } from "glisse";
import type { DeskVoiceSettings, LiveProvider, SttProvider, State, TtsProvider, VoiceKeyProvider, VoiceOptions, VoicePatch } from "./types";
import { Group, Row, SwitchRow, errorText } from "./SettingsRows";
import { stopCancel } from "./SkillsSettings";
import { Choices } from "./Preferences";
import { readAloud, systemVoices, useReading } from "./voice";
import "./voice.css";

const api = window.botkins;

const STT: { id: SttProvider; name: string }[] = [
  { id: "device", name: "This computer" },
  { id: "openai", name: "OpenAI" },
  { id: "azure", name: "Azure" },
  { id: "elevenlabs", name: "ElevenLabs" },
  { id: "custom", name: "Your own server" },
  { id: "local", name: "This computer's own models" },
];
const TTS: { id: TtsProvider; name: string }[] = [
  { id: "device", name: "This computer" },
  { id: "openai", name: "OpenAI" },
  { id: "azure", name: "Azure" },
  { id: "elevenlabs", name: "ElevenLabs" },
  { id: "gemini", name: "Gemini" },
  { id: "custom", name: "Your own server" },
  { id: "local", name: "This computer's own models" },
];
const LIVE: { id: LiveProvider | ""; name: string }[] = [
  { id: "", name: "None chosen yet" },
  { id: "codex", name: "ChatGPT sign-in" },
  { id: "openai", name: "OpenAI key" },
  { id: "azure", name: "Azure key" },
  { id: "gemini", name: "Gemini key" },
  { id: "elevenlabs", name: "ElevenLabs key" },
];
const NAMES: Record<VoiceKeyProvider, string> = { openai: "OpenAI", azure: "Azure", elevenlabs: "ElevenLabs", gemini: "Gemini", custom: "Your own server" };
const SAMPLE = "Hello. This is how Botkins reads replies aloud.";
const LOCAL_NOTE = "Not available yet. A speech server on this computer (one that runs Whisper or Piper, for example) works through Your own server.";
type VoicePage = "overview" | "dictation" | "reading" | "live" | "keys";
type LiveInput = "live" | "ptt";
const LIVE_INPUT_KEY = "botkins.liveInput";
const LIVE_INPUTS: { id: LiveInput; name: string }[] = [
  { id: "live", name: "Live conversation" },
  { id: "ptt", name: "Push to talk" },
];

function readLiveInput(): LiveInput {
  try {
    return localStorage.getItem(LIVE_INPUT_KEY) === "ptt" ? "ptt" : "live";
  } catch {
    return "live";
  }
}

function saveLiveInput(value: LiveInput) {
  try {
    localStorage.setItem(LIVE_INPUT_KEY, value);
  } catch {
    // A private browsing profile can refuse local storage. Live voice uses the default.
  }
}

function VoiceFeatureRow({ icon: Icon, title, value, subtitle, onClick }: { icon: LucideIcon; title: string; value: string; subtitle: string; onClick: () => void }) {
  return (
    <button type="button" className="voice-feature-row" onClick={onClick}>
      <span className="voice-feature-icon" aria-hidden="true"><Icon size={17} /></span>
      <span className="voice-feature-copy"><strong>{title}</strong><small>{subtitle}</small></span>
      <span className="voice-feature-value">{value}</span>
      <span className="voice-feature-chevron" aria-hidden="true">›</span>
    </button>
  );
}

function SetupButton({ provider, onClick }: { provider: string; onClick: () => void }) {
  return <button type="button" className="set-link voice-setup" onClick={onClick}>Set up {provider}</button>;
}

/** Which key a provider needs, and whether it is saved. */
function keyNote(s: DeskVoiceSettings, provider: string, kind?: "stt" | "tts" | "live") {
  if (provider === "device" || provider === "local" || provider === "codex") return "";
  const p = s.providers[provider as VoiceKeyProvider] as { hasKey: boolean } | undefined;
  if (provider === "custom") return s.providers.custom.baseUrl ? "" : "Add your server's address under Keys and servers.";
  if (!p?.hasKey) return "Add " + (provider === "gemini" ? "a" : "an") + " " + NAMES[provider as VoiceKeyProvider] + " key under Keys and servers.";
  // Live voice is on the resource's own address, whichever service dictation and reading use.
  if (provider === "azure" && kind === "live" && !s.providers.azure.endpoint) return "Add your Azure resource endpoint under Keys and servers.";
  return "";
}

/** The models and voices a provider offers, read when the choice changes. */
export function useOptions(kind: "stt" | "tts" | "live", provider: string | null, stamp: string, model?: string) {
  const [options, setOptions] = useState<VoiceOptions>({ models: [], voices: [] });
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setOptions({ models: [], voices: [] });
    setError("");
    // Codex lists live voices (through the computer's app), as the phone shows them; it has nothing for speech in or out.
    if (!provider || provider === "device" || (provider === "codex" && kind !== "live")) return;
    // Azure's voices belong to a model ("" is the standard ones), so they are read again when the model changes.
    (provider === "azure" && kind === "tts" && model !== undefined ? api.voiceOptions(kind, provider, model) : api.voiceOptions(kind, provider))
      .then((o) => live && setOptions(o))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [kind, provider, stamp, provider === "azure" && kind === "tts" ? model : undefined]);
  return { options, error };
}

/** A text setting saved when the field is left (or Enter is pressed), not on every key. */
function TextRow({ label, help, value, placeholder, save, wide }: { label: string; help?: string; value: string; placeholder?: string; save: (value: string) => Promise<void>; wide?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() !== value) void save(text.trim()).catch(() => setText(value));
  };
  return (
    <Row label={label} help={help}>
      {(id, describedBy) => (
        <input
          id={id}
          className={wide ? "voice-wide" : undefined}
          aria-describedby={describedBy}
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
      )}
    </Row>
  );
}

/** A provider's key: once saved it shows only as Saved, with Replace and Remove. Its text never comes back. */
/** The providers that hold a key. */
const KEYED: VoiceKeyProvider[] = ["openai", "azure", "elevenlabs", "gemini", "custom"];

function KeyRow({ provider, has, busy, save, optional, dropped }: { provider: VoiceKeyProvider; has: boolean; busy: boolean; save: (key: string | null) => Promise<boolean>; optional?: boolean; dropped?: boolean }) {
  const name = provider === "custom" ? "Server key" : NAMES[provider] + " key";
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const submit = async () => {
    if (!text.trim()) return;
    if (await save(text)) {
      setText("");
      setEditing(false);
    }
  };
  if (has && !editing)
    return (
      <div className="set-row" data-voice-provider={provider}>
        <div className="set-label">
          <span className="set-name">{name}</span>
          <small>Kept on this computer. Botkins never shows it again.</small>
        </div>
        <div className="set-control">
          <span className="voice-saved" role="status" aria-label={name + " is saved"}>
            <Check size={14} aria-hidden="true" />
            Saved
          </span>
          <button type="button" className="set-button" disabled={busy} aria-label={"Replace " + name} onClick={() => setEditing(true)}>
            Replace
          </button>
          <button type="button" className="set-button danger" disabled={busy} aria-label={"Remove " + name} onClick={() => void save(null)}>
            Remove
          </button>
        </div>
      </div>
    );
  return (
    <div data-voice-provider={provider}>
      <Row
        label={name}
        // A key belongs to the address it was given for: a different address needs its key again.
        help={dropped ? "The saved key was removed because the address changed. Enter the key for the new address." : optional ? "Only if your server asks for one." : undefined}
      >
        {(id, describedBy) => (
          <form
            className="voice-key"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input id={id} type="password" aria-describedby={describedBy} value={text} autoComplete="off" spellCheck={false} placeholder="Paste the key" onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="set-button" disabled={busy || !text.trim()} aria-label={"Save " + name}>
              Save
            </button>
            {editing && (
              <button
                type="button"
                className="set-button"
                onClick={() => {
                  setText("");
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            )}
          </form>
        )}
      </Row>
    </div>
  );
}

/** A choice from a list. An empty value is the provider's own default. */
function Pick({ label, help, value, options, change, empty = "Default", disabledIds = [] }: { label: string; help?: string; value: string; options: { id: string; name: string }[]; change: (id: string) => void; empty?: string | null; disabledIds?: string[] }) {
  return (
    <Row label={label} help={help}>
      {(id, describedBy) => (
        <select id={id} aria-describedby={describedBy} value={value} onChange={(e) => change(e.target.value)}>
          {empty !== null && <option value="">{empty}</option>}
          {value && !options.some((o) => o.id === value) && <option value={value}>{value}</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id} disabled={disabledIds.includes(o.id)}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </Row>
  );
}

const OTHER = "__other__";
/** The words of typing a model or a voice that isn't listed (the phone says the same). */
const OTHER_MODEL = { choice: "Other model…", title: "Other model", message: "Type the model's name, such as MAI-Transcribe-2. For Azure OpenAI audio, type the deployment's name." };
const OTHER_VOICE = { choice: "Other voice…", title: "Other voice", message: "Type the voice's name, such as en-US-Harper:MAI-Voice-2.1." };

/**
 * A choice that also lets the person type what isn't listed. A provider that names its own default
 * (a choice with no id, such as Azure's standard voices) is not given a second one.
 */
function TypedPick({ label, help, value, options, change, typing }: { label: string; help?: string; value: string; options: { id: string; name: string }[]; change: (id: string) => Promise<void>; typing: { choice: string; title: string; message: string } }) {
  const [typed, setTyped] = useState(false);
  return (
    <>
      <Pick
        label={label}
        help={help}
        value={value}
        options={[...options, { id: OTHER, name: typing.choice }]}
        empty={options.some((o) => !o.id) ? null : "Default"}
        change={(id) => {
          if (id === OTHER) setTyped(true);
          else {
            setTyped(false);
            void change(id).catch(() => {});
          }
        }}
      />
      {typed && <TextRow label={typing.title} help={typing.message} value="" wide save={(text) => (text ? change(text).then(() => setTyped(false)) : Promise.resolve())} />}
    </>
  );
}

/** Settings › Voice: dictation, reading aloud, live voice, and the keys and servers they use. */
export default function VoiceSettings({ state }: { state: State }) {
  const [s, setS] = useState<DeskVoiceSettings>();
  const [page, setPage] = useState<VoicePage>("overview");
  const [keysFocus, setKeysFocus] = useState<VoiceKeyProvider | null>(null);
  const [liveInput, setLiveInput] = useState<LiveInput>(readLiveInput);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState("");
  const [deviceVoices, setDeviceVoices] = useState<{ id: string; name: string }[]>([]);
  const reading = useReading();
  const load = () =>
    api
      .voiceSettings()
      .then((next) => {
        setS(next);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
    void api.appInfo().then((info) => setPlatform(info.platform), () => {});
    void systemVoices().then((list) => setDeviceVoices(list.map((v) => ({ id: v.voiceURI, name: v.name + (v.lang ? " (" + v.lang + ")" : "") }))));
  }, []);
  // Lists of models and voices are read again after a key or address changes.
  const stamp = JSON.stringify(s?.providers ?? null);
  const stt = useOptions("stt", s?.stt.provider ?? null, stamp);
  const tts = useOptions("tts", s?.tts.provider ?? null, stamp, s?.tts.model ?? "");
  const liveOptions = useOptions("live", s?.live.provider ?? null, stamp);
  // The providers whose saved key went with a change of address (the link keeps a key with the
  // address it was given for), until a key is saved for the new one.
  const [dropped, setDropped] = useState<VoiceKeyProvider[]>([]);
  async function run(fn: () => Promise<DeskVoiceSettings>, saved?: VoiceKeyProvider) {
    setBusy(true);
    setError("");
    try {
      const next = await fn();
      const before = s;
      const gone = KEYED.filter((p) => before?.providers[p].hasKey && !next.providers[p].hasKey && p !== saved);
      setDropped((list) => [...new Set([...list, ...gone])].filter((p) => !next.providers[p].hasKey && p !== saved));
      setS(next);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  /** Saves or removes a provider's key. Either way the note about a removed key no longer applies. */
  const saveKey = (provider: VoiceKeyProvider) => (key: string | null) => run(() => api.setVoiceKey(provider, key), provider);
  const change = (patch: VoicePatch) => run(() => api.setVoice(patch)).then((ok) => (ok ? undefined : Promise.reject(new Error("not saved"))));
  const [speed, setSpeed] = useState(1);
  useEffect(() => setSpeed(s?.tts.speed ?? 1), [s?.tts.speed]);
  useEffect(() => {
    if (!s || speed === (s.tts.speed ?? 1)) return;
    const timer = setTimeout(() => void change({ tts: { speed } }).catch(() => {}), 350);
    return () => clearTimeout(timer);
  }, [speed]);
  useEffect(() => {
    if (page !== "keys" || !keysFocus) return;
    document.querySelector<HTMLElement>(`[data-voice-provider="${keysFocus}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [page, keysFocus]);

  if (!s)
    return error ? (
      <p className="set-status error-text" role="alert">
        Couldn't read the voice settings. {error}{" "}
        <button type="button" className="set-link" onClick={() => void load()}>
          Try again
        </button>
      </p>
    ) : (
      <p className="set-status" role="status">
        Reading the voice settings…
      </p>
    );
  const mac = platform === "darwin";
  const dictationHelp =
    s.stt.provider === "device"
      ? s.device.stt
        ? "Uses the Mac's own dictation. If nothing happens, switch Dictation on in System Settings › Keyboard."
        : platform === "win32"
          ? "Windows has no dictation that Botkins can start. Press Windows key + H to dictate into any text field, or choose a speech service here."
          : "This computer has no dictation that Botkins can start. Choose a speech service here to dictate in Botkins."
      : s.stt.provider === "local"
        ? LOCAL_NOTE
        : keyNote(s, s.stt.provider, "stt") || "Your recording goes to " + (STT.find((p) => p.id === s.stt.provider)?.name ?? "it") + " to be written out.";
  const readingHelp =
    s.tts.provider === "device"
      ? "Uses the voices that come with this computer."
      : s.tts.provider === "local"
        ? LOCAL_NOTE
        : keyNote(s, s.tts.provider, "tts") || "The text goes to " + (TTS.find((p) => p.id === s.tts.provider)?.name ?? "it") + " to be read.";
  const codex = s.providers.codex;
  const liveHelp = !s.live.provider
    ? "Choose who does the talking. Live voice then answers out loud as you speak, and your bot does the work."
    : s.live.provider === "codex"
      ? !codex.available
        ? "ChatGPT isn't one of this app's model providers right now."
        : codex.signedIn
          ? "Uses your ChatGPT plan through the Codex app. This is an early Codex feature and may stop working after a Codex update."
          : "Sign in with ChatGPT in Settings › Model providers first."
      : keyNote(s, s.live.provider, "live") || "Your voice goes straight to " + (LIVE.find((p) => p.id === s.live.provider)?.name.replace(/ key$/, "") ?? "it") + " while live voice is on.";
  const azure = s.providers.azure;
  const sttName = STT.find((provider) => provider.id === s.stt.provider)?.name ?? s.stt.provider;
  const ttsName = TTS.find((provider) => provider.id === s.tts.provider)?.name ?? s.tts.provider;
  const liveName = LIVE.find((provider) => provider.id === (s.live.provider ?? ""))?.name ?? "Off";
  const keyCount = KEYED.filter((provider) => s.providers[provider].hasKey).length;
  const dictationSummary = keyNote(s, s.stt.provider, "stt") || (s.stt.provider === "device" ? "Uses this computer's dictation" : s.stt.language ? "Language " + s.stt.language : "Ready to transcribe");
  const readingSummary = keyNote(s, s.tts.provider, "tts") || (state.settings.readAloud ? "Reads replies aloud" : "Set up, when you need it");
  const liveSummary = !s.live.provider
    ? "Choose a provider to begin"
    : s.live.provider === "codex" && !codex.signedIn
      ? "Sign in under Model providers"
      : keyNote(s, s.live.provider, "live") || (liveInput === "ptt" ? "Push to talk" : "Live conversation");
  const goKeys = (provider: VoiceKeyProvider) => {
    setKeysFocus(provider);
    setPage("keys");
  };
  if (page === "overview")
    return (
      <div className="int-section voice-settings voice-overview" {...stopCancel}>
        {!s.ready && <p className="set-status error-text" role="alert">{s.problem || "Voice settings can't be changed right now."}</p>}
        {error && <p className="set-status error-text" role="alert">{error}</p>}
        <Group>
          <VoiceFeatureRow icon={Mic} title="Dictation" value={sttName} subtitle={dictationSummary} onClick={() => setPage("dictation")} />
          <VoiceFeatureRow icon={Volume2} title="Reading aloud" value={ttsName} subtitle={readingSummary} onClick={() => setPage("reading")} />
          <VoiceFeatureRow icon={AudioLines} title="Live voice" value={s.live.provider ? liveName.replace(/ key$/, "") : "Off"} subtitle={liveSummary} onClick={() => setPage("live")} />
        </Group>
        <p className="set-foot voice-note">Saved on this computer, for every phone.</p>
        <Group>
          <VoiceFeatureRow icon={KeyRound} title="Keys and servers" value={keyCount === 0 ? "None" : keyCount + (keyCount === 1 ? " key" : " keys")} subtitle="Kept on this computer" onClick={() => setPage("keys")} />
        </Group>
      </div>
    );
  return (
    <div className="int-section voice-settings" {...stopCancel}>
      {!s.ready && (
        <p className="set-status error-text" role="alert">
          {s.problem || "Voice settings can't be changed right now."}
        </p>
      )}
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
      <div className="voice-detail-head">
        <button type="button" className="set-link voice-back" onClick={() => setPage("overview")}><ArrowLeft size={15} aria-hidden="true" /> Voice</button>
        <h2>{page === "dictation" ? "Dictation" : page === "reading" ? "Reading aloud" : page === "live" ? "Live voice" : "Keys and servers"}</h2>
      </div>
      {page === "dictation" && (
      <Group title="Dictation" footer="The microphone button beside the message box turns speech into text. Nothing is sent until you send it.">
        <Pick
          label="Speech to text"
          help={dictationHelp}
          value={s.stt.provider}
          options={STT.map((p) => (p.id === "local" ? { ...p, name: p.name + " (not available yet)" } : p))}
          disabledIds={s.providers.local.available ? [] : ["local"]}
          empty={null}
          change={(provider) => void change({ stt: { provider: provider as SttProvider } }).catch(() => {})}
        />
        {keyNote(s, s.stt.provider, "stt") && KEYED.includes(s.stt.provider as VoiceKeyProvider) && <SetupButton provider={NAMES[s.stt.provider as VoiceKeyProvider]} onClick={() => goKeys(s.stt.provider as VoiceKeyProvider)} />}
        {s.stt.provider === "azure" ? (
          <TypedPick label="Model" value={s.stt.model ?? ""} options={stt.options.models} typing={OTHER_MODEL} change={(model) => change({ stt: { model } })} />
        ) : (
          stt.options.models.length > 0 && <Pick label="Model" value={s.stt.model ?? ""} options={stt.options.models} change={(model) => void change({ stt: { model } }).catch(() => {})} />
        )}
        {s.stt.provider !== "device" && (
          <TextRow label="Language" help="Such as en or en-US. Leave it empty to let the service tell." value={s.stt.language ?? ""} placeholder="Automatic" save={(language) => change({ stt: { language } })} />
        )}
        {stt.error && <p className="set-status error-text voice-inline">{stt.error}</p>}
      </Group>
      )}

      {page === "reading" && (
      <Group
        title="Reading aloud"
        actions={
          <button type="button" className="set-button" aria-label={reading.key === "voice-sample" ? "Stop the sample" : "Play a sample"} onClick={() => void readAloud("voice-sample", SAMPLE)}>
            {reading.key === "voice-sample" ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
            {reading.key === "voice-sample" ? "Stop" : "Play a sample"}
          </button>
        }
        footer={reading.error ? <span className="error-text" role="alert">{reading.error}</span> : undefined}
      >
        <Pick
          label="Text to speech"
          help={readingHelp}
          value={s.tts.provider}
          options={TTS.map((p) => (p.id === "local" ? { ...p, name: p.name + " (not available yet)" } : p))}
          disabledIds={s.providers.local.available ? [] : ["local"]}
          empty={null}
          change={(provider) => void change({ tts: { provider: provider as TtsProvider } }).catch(() => {})}
        />
        {keyNote(s, s.tts.provider, "tts") && KEYED.includes(s.tts.provider as VoiceKeyProvider) && <SetupButton provider={NAMES[s.tts.provider as VoiceKeyProvider]} onClick={() => goKeys(s.tts.provider as VoiceKeyProvider)} />}
        {/* Azure's voices belong to its model, so a new model clears the voice and the voices below are read again for it. */}
        {s.tts.provider === "azure" ? (
          <>
            <TypedPick label="Model" value={s.tts.model ?? ""} options={tts.options.models} typing={OTHER_MODEL} change={(model) => change({ tts: { model, voice: "" } })} />
            <TypedPick label="Voice" value={s.tts.voice ?? ""} options={tts.options.voices} typing={OTHER_VOICE} change={(voice) => change({ tts: { voice } })} />
          </>
        ) : (
          <>
            {tts.options.models.length > 0 && <Pick label="Model" value={s.tts.model ?? ""} options={tts.options.models} change={(model) => void change({ tts: { model } }).catch(() => {})} />}
            {(s.tts.provider === "device" ? deviceVoices : tts.options.voices).length > 0 && (
              <Pick label="Voice" value={s.tts.voice ?? ""} options={s.tts.provider === "device" ? deviceVoices : tts.options.voices} change={(voice) => void change({ tts: { voice } }).catch(() => {})} />
            )}
          </>
        )}
        {tts.error && <p className="set-status error-text voice-inline">{tts.error}</p>}
        <Row label="Speed" help={s.tts.provider === "gemini" ? "Gemini reads at its own speed." : undefined}>
          {(id, describedBy) => (
            <span className="voice-speed">
              <Slider id={id} min={0.5} max={2} step={0.05} value={speed} aria-describedby={describedBy} aria-valuetext={speed.toFixed(2) + " times"} onValueChange={setSpeed} />
              <output htmlFor={id}>{speed.toFixed(2).replace(/0$/, "")}×</output>
            </span>
          )}
        </Row>
        <SwitchRow
          label="Read replies aloud"
          help="Each new reply in the chat you have open is read as soon as it is finished."
          checked={!!state.settings.readAloud}
          onChange={(on) => void api.setPreferences({ readAloud: on }).catch((e) => setError(errorText(e)))}
        />
      </Group>
      )}

      {page === "live" && (
      <Group title="Live voice" footer="Press the Live Voice button where Send is when the message box is empty. Talk, and the bot answers out loud.">
        <Pick
          label="Live voice by"
          help={liveHelp}
          value={s.live.provider ?? ""}
          options={LIVE.filter((p) => p.id)}
          empty="None chosen yet"
          disabledIds={codex.available ? [] : ["codex"]}
          change={(provider) => void change({ live: { provider: (provider || null) as LiveProvider | null } }).catch(() => {})}
        />
        {!!s.live.provider && keyNote(s, s.live.provider, "live") && KEYED.includes(s.live.provider as VoiceKeyProvider) && <SetupButton provider={NAMES[s.live.provider as VoiceKeyProvider]} onClick={() => goKeys(s.live.provider as VoiceKeyProvider)} />}
        {/* On Azure the model is the realtime deployment's name, so it may be typed. */}
        {s.live.provider === "azure" ? (
          <TypedPick label="Model" value={s.live.model ?? ""} options={liveOptions.options.models} typing={OTHER_MODEL} change={(model) => change({ live: { model } })} />
        ) : (
          liveOptions.options.models.length > 0 && <Pick label="Model" value={s.live.model ?? ""} options={liveOptions.options.models} change={(model) => void change({ live: { model } }).catch(() => {})} />
        )}
        {liveOptions.options.voices.length > 0 && <Pick label="Voice" value={s.live.voice ?? ""} options={liveOptions.options.voices} change={(voice) => void change({ live: { voice } }).catch(() => {})} />}
        {liveOptions.error && <p className="set-status error-text voice-inline">{liveOptions.error}</p>}
        <div className="set-row">
          <div className="set-label"><span className="set-name">How you talk</span><small>{liveInput === "ptt" ? "Hold the key while you talk. Let go and it answers." : "Talk freely. It listens while you speak and answers when you pause."}</small></div>
          <div className="set-control"><Choices label="How you talk" value={liveInput} options={LIVE_INPUTS} onChange={(next) => { setLiveInput(next); saveLiveInput(next); }} /></div>
        </div>
      </Group>
      )}

      {page === "keys" && (
      <Group title="Keys and servers" footer="Keys are kept on this computer, locked by the system's keychain, and shared with your paired phones' voice. They are never shown again.">
        <div className="voice-sub">OpenAI</div>
        {/* The address comes before the key: a key is kept with the address it was given for. */}
        <TextRow label="Address" help="Change it only for a service that works like OpenAI's. A saved key is removed when the address changes." value={s.providers.openai.baseUrl} wide save={(baseUrl) => change({ providers: { openai: { baseUrl } } })} />
        <KeyRow provider="openai" has={s.providers.openai.hasKey} busy={busy} dropped={dropped.includes("openai")} save={saveKey("openai")} />

        <div className="voice-sub">Azure</div>
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">Service</span>
          </div>
          <div className="set-control">
            <Choices
              label="Azure service"
              value={azure.kind}
              options={[
                { id: "openai", name: "Azure OpenAI" },
                { id: "speech", name: "Azure Speech" },
              ]}
              onChange={(kind) => void change({ providers: { azure: { kind } } }).catch(() => {})}
            />
          </div>
        </div>
        <TextRow label="Endpoint" help={azure.kind === "speech" ? "Your resource's address, or leave it empty and give the region. Live voice needs the address." : "Such as https://your-name.openai.azure.com"} value={azure.endpoint ?? ""} wide save={(endpoint) => change({ providers: { azure: { endpoint } } })} />
        {azure.kind === "speech" && <TextRow label="Region" help="Such as eastus." value={azure.region ?? ""} save={(region) => change({ providers: { azure: { region } } })} />}
        {azure.kind === "openai" && (
          <>
            <TextRow label="Dictation deployment" help="The name of your speech-to-text deployment." value={azure.sttDeployment ?? ""} save={(sttDeployment) => change({ providers: { azure: { sttDeployment } } })} />
            <TextRow label="Reading deployment" help="The name of your text-to-speech deployment." value={azure.ttsDeployment ?? ""} save={(ttsDeployment) => change({ providers: { azure: { ttsDeployment } } })} />
          </>
        )}
        <KeyRow provider="azure" has={azure.hasKey} busy={busy} dropped={dropped.includes("azure")} save={saveKey("azure")} />

        <div className="voice-sub">ElevenLabs</div>
        <KeyRow provider="elevenlabs" has={s.providers.elevenlabs.hasKey} busy={busy} dropped={dropped.includes("elevenlabs")} save={saveKey("elevenlabs")} />
        <TextRow label="Agent ID" help="For live voice. Leave it empty and Botkins makes an agent for you." value={s.providers.elevenlabs.agentId ?? ""} save={(agentId) => change({ providers: { elevenlabs: { agentId } } })} />

        <div className="voice-sub">Gemini</div>
        <KeyRow provider="gemini" has={s.providers.gemini.hasKey} busy={busy} dropped={dropped.includes("gemini")} save={saveKey("gemini")} />

        <div className="voice-sub">Your own server</div>
        <TextRow
          label="Address"
          help="Any speech server that works like OpenAI's, such as one running local models on this computer (for example http://localhost:8000/v1)."
          value={s.providers.custom.baseUrl ?? ""}
          placeholder="http://localhost:8000/v1"
          wide
          save={(baseUrl) => change({ providers: { custom: { baseUrl } } })}
        />
        <KeyRow provider="custom" has={s.providers.custom.hasKey} busy={busy} optional dropped={dropped.includes("custom")} save={saveKey("custom")} />
      </Group>
      )}
      <p className="set-foot voice-note">
        {mac ? "macOS asks whether Botkins may use the microphone the first time you dictate with a speech service or start live voice." : "Botkins uses the microphone only while you dictate with a speech service or live voice is on."}
      </p>
    </div>
  );
}
