// Settings › Voice: who takes dictation, who reads aloud, who talks in live voice, and the keys and
// addresses those providers need. The choices are the computer's, shared by every phone; keys stay
// on the computer. "This phone" choices (its voice and speed) are kept on the phone.
import { MenuView } from "@react-native-menu/menu";
import { ChevronsUpDown, Cpu, Play, Server, Smartphone, Square } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { LiveProvider, SttProvider, TtsProvider, VoicePatch, VoiceSettings as Settings } from "@/link/types";
import { setChatPrefs, useChatPrefs } from "@/state/chatPrefs";
import { useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, Group, IconTile, Label, Loading, Page, ProviderIcon, Row, Slider, space, T, useTheme } from "@/ui";
import { KEY_PROVIDERS, LANGUAGES, LIVE_PROVIDERS, markOf, missing, providerName, providerState, STT_PROVIDERS, TTS_PROVIDERS } from "./choices";
import { planFor } from "./live/index";
import { duplexAudio, webrtcModule } from "./native";
import { useVoiceOptions } from "./options";
import { setPhoneVoice, usePhoneVoice } from "./prefs";
import { ProviderSheet, type SheetProvider } from "./ProviderSheet";
import { UPDATE_COMPUTER, useVoiceSettings, useVoiceSupported } from "./state";
import { type PhoneVoice, phoneLanguage, phoneVoices, speakText, stopSpeech, useSpeakingNow } from "./tts";

const SAMPLE = "Hi, I'm your Botkin. This is how I sound.";
const SAMPLE_ID = "voice-sample";

type Option = { value: string; label: string; subtitle?: string };

/** A row whose value opens a short list of choices. */
function Choice({ title, subtitle, value, options, onChange, disabled }: { title: string; subtitle?: string; value: string; options: Option[]; onChange: (value: string) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const current = options.find((option) => option.value === value);
  return (
    <MenuView
      title={title}
      actions={options.map((option) => ({ id: option.value || "-", title: option.label, subtitle: option.subtitle, state: option.value === value ? "on" : "off" }))}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event === "-" ? "" : nativeEvent.event)}
      isAnchoredToRight
    >
      <View accessible accessibilityRole="button" accessibilityLabel={title + ", " + (current?.label ?? "Default")} accessibilityHint="Opens the choices" accessibilityState={{ disabled }}>
        <Row title={title} subtitle={subtitle} value={current?.label ?? (value || "Default")} disabled={disabled} trailing={<ChevronsUpDown size={16} color={colors.faint} strokeWidth={2.2} />} />
      </View>
    </MenuView>
  );
}

const save = (patch: VoicePatch) => void attempt(api["link.voice.set"](patch));

/** Speed changes save a moment after the slider stops. */
function useSpeed(value: number, commit: (value: number) => void) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const change = (next: number) => {
    const rounded = Math.round(next * 20) / 20;
    setDraft(rounded);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(rounded), 400);
  };
  return [draft, change] as const;
}

const speedLabel = (speed: number) => (Math.round(speed * 100) / 100).toString() + "×";

function ProviderMark({ provider }: { provider: string }) {
  const { colors } = useTheme();
  if (provider === "device") return <IconTile icon={Smartphone} color={colors.ink2} />;
  if (provider === "local") return <IconTile icon={Cpu} color={colors.ink2} />;
  if (provider === "custom") return <IconTile icon={Server} color={colors.ink2} />;
  return <ProviderIcon provider={markOf(provider)} name={providerName(provider)} size={32} tile />;
}

function providerOptions(kind: "stt" | "tts" | "live", list: string[], voice: Settings | undefined): Option[] {
  return list.map((provider) => ({ value: provider, label: providerName(provider), subtitle: voice ? (missing(kind, provider, voice) ?? undefined) : undefined }));
}

function Dictation({ voice, supported }: { voice: Settings | undefined; supported: boolean }) {
  const provider: SttProvider = voice?.stt.provider ?? "device";
  const options = useVoiceOptions("stt", provider, voice);
  const lack = voice ? missing("stt", provider, voice) : null;
  return (
    <View>
      <Label>Dictation</Label>
      <Group>
        <Choice
          title="Provider"
          subtitle={lack ?? undefined}
          value={provider}
          options={voice ? providerOptions("stt", STT_PROVIDERS, voice) : [{ value: "device", label: providerName("device") }]}
          onChange={(next) => save({ stt: { provider: next as SttProvider } })}
          disabled={!voice}
        />
        {!!options?.models.length && (
          <Choice title="Model" value={voice?.stt.model ?? ""} options={[{ value: "", label: "Default" }, ...options.models.map((model) => ({ value: model.id, label: model.name }))]} onChange={(model) => save({ stt: { model: model || undefined } })} />
        )}
        {!!voice && <Choice title="Language" value={voice.stt.language ?? ""} options={LANGUAGES} onChange={(language) => save({ stt: { language: language || undefined } })} />}
      </Group>
      {!supported && <Note text={UPDATE_COMPUTER + " for other providers."} />}
    </View>
  );
}

function Note({ text }: { text: string }) {
  return (
    <T variant="footnote" color="muted" style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
      {text}
    </T>
  );
}

function SampleButton({ onPlay }: { onPlay: () => void }) {
  const playing = useSpeakingNow((state) => state.id === SAMPLE_ID);
  return <Button title={playing ? "Stop" : "Play sample"} icon={playing ? Square : Play} variant="secondary" size="sm" onPress={playing ? stopSpeech : onPlay} />;
}

function ReadingAloud({ voice }: { voice: Settings | undefined }) {
  const provider: TtsProvider = voice?.tts.provider ?? "device";
  const onPhone = provider === "device";
  const options = useVoiceOptions("tts", provider, voice);
  const lack = voice ? missing("tts", provider, voice) : null;
  const phone = usePhoneVoice();
  const readAloud = useChatPrefs((prefs) => prefs.readAloud);
  const [voices, setVoices] = useState<PhoneVoice[] | undefined>();
  const language = voice?.stt.language || phoneLanguage();
  useEffect(() => {
    if (!onPhone) return;
    let live = true;
    void phoneVoices(language).then((found) => live && setVoices(found));
    return () => {
      live = false;
    };
  }, [onPhone, language]);
  const [speed, setSpeed] = useSpeed(onPhone ? phone.speed : (voice?.tts.speed ?? 1), (next) => (onPhone ? setPhoneVoice({ speed: next }) : save({ tts: { speed: next } })));
  const quality = { premium: "Premium", enhanced: "Enhanced", default: undefined };
  const voiceOptions: Option[] = onPhone
    ? [{ value: "", label: "Default" }, ...(voices ?? []).map((item) => ({ value: item.id, label: item.name, subtitle: quality[item.quality] }))]
    : [{ value: "", label: "Default" }, ...(options?.voices ?? []).map((item) => ({ value: item.id, label: item.name, subtitle: item.language }))];
  const chosenVoice = onPhone ? (phone.voice ?? "") : (voice?.tts.voice ?? "");
  // Gemini's speech has no speed.
  const hasSpeed = provider !== "gemini";
  const play = () => speakText(SAMPLE_ID, SAMPLE, onPhone ? { provider: "device", voice: phone.voice, speed } : { provider, voice: voice?.tts.voice, speed: hasSpeed ? speed : undefined });
  return (
    <View>
      <Label>Reading aloud</Label>
      <Group>
        <Choice
          title="Provider"
          subtitle={lack ?? undefined}
          value={provider}
          options={voice ? providerOptions("tts", TTS_PROVIDERS, voice) : [{ value: "device", label: providerName("device") }]}
          onChange={(next) => save({ tts: { provider: next as TtsProvider } })}
          disabled={!voice}
        />
        {!onPhone && !!options?.models.length && (
          <Choice title="Model" value={voice?.tts.model ?? ""} options={[{ value: "", label: "Default" }, ...options.models.map((model) => ({ value: model.id, label: model.name }))]} onChange={(model) => save({ tts: { model: model || undefined } })} />
        )}
        {(onPhone ? voices === undefined : options === undefined) ? (
          <Row title="Voice" value="Loading…" disabled />
        ) : (
          voiceOptions.length > 1 && <Choice title="Voice" value={chosenVoice} options={voiceOptions} onChange={(next) => (onPhone ? setPhoneVoice({ voice: next || undefined }) : save({ tts: { voice: next || undefined } }))} />
        )}
        {hasSpeed && (
          <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <T variant="body">Speed</T>
              <T variant="body" color="muted">
                {speedLabel(speed)}
              </T>
            </View>
            <Slider value={speed} min={0.5} max={2} step={0.05} onChange={setSpeed} label="Speed" />
          </View>
        )}
        <Row
          title="Read replies aloud"
          subtitle="In the chat that is open"
          toggled={readAloud}
          onToggle={(on) => {
            setChatPrefs({ readAloud: on });
            if (voice) save({ tts: { auto: on } });
          }}
        />
      </Group>
      <View style={{ paddingTop: space.md, alignItems: "flex-start", paddingHorizontal: space.sm }}>
        <SampleButton onPlay={play} />
      </View>
    </View>
  );
}

function LiveVoice({ voice }: { voice: Settings }) {
  const provider = voice.live.provider;
  const options = useVoiceOptions("live", provider, voice);
  const lack = provider ? missing("live", provider, voice) : null;
  const build = { webrtc: webrtcModule(), duplex: duplexAudio() };
  const unbuilt = provider && !planFor(provider, build) ? "Update the app for this one" : null;
  const choices: Option[] = [{ value: "", label: "Off" }, ...LIVE_PROVIDERS.map((item) => ({ value: item, label: providerName(item), subtitle: missing("live", item, voice) ?? (planFor(item, build) ? undefined : "Update the app for this one") }))];
  return (
    <View>
      <Label>Live voice</Label>
      <Group>
        <Choice title="Provider" subtitle={lack ?? unbuilt ?? undefined} value={provider ?? ""} options={choices} onChange={(next) => save({ live: { provider: (next || null) as LiveProvider | null } })} />
        {!!provider && !!options?.models.length && (
          <Choice title="Model" value={voice.live.model ?? ""} options={[{ value: "", label: "Default" }, ...options.models.map((model) => ({ value: model.id, label: model.name }))]} onChange={(model) => save({ live: { model: model || undefined } })} />
        )}
        {!!provider && !!options?.voices.length && (
          <Choice title="Voice" value={voice.live.voice ?? ""} options={[{ value: "", label: "Default" }, ...options.voices.map((item) => ({ value: item.id, label: item.name }))]} onChange={(next) => save({ live: { voice: next || undefined } })} />
        )}
      </Group>
    </View>
  );
}

function Providers({ voice, onOpen }: { voice: Settings; onOpen: (provider: SheetProvider) => void }) {
  const rows: SheetProvider[] = [...KEY_PROVIDERS, "local"];
  return (
    <View>
      <Label>Providers</Label>
      <Group>
        {rows.map((provider) => (
          <Row key={provider} leading={<ProviderMark provider={provider} />} title={providerName(provider)} subtitle={providerState(provider, voice)} chevron onPress={() => onOpen(provider)} />
        ))}
        <Row leading={<ProviderMark provider="codex" />} title={providerName("codex")} subtitle={providerState("codex", voice)} />
      </Group>
    </View>
  );
}

export default function VoiceSettings() {
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  const online = useOnline();
  const [sheet, setSheet] = useState<SheetProvider | null>(null);
  return (
    <Page title="Voice">
      <Dictation voice={voice} supported={supported} />
      <ReadingAloud voice={voice} />
      {supported && !voice && online && <Loading />}
      {supported && !!voice && <LiveVoice voice={voice} />}
      {supported && !!voice && <Providers voice={voice} onOpen={setSheet} />}
      {!supported && (
        <View>
          <Label>Live voice</Label>
          <Group>
            <Row title="Live voice" subtitle={UPDATE_COMPUTER} disabled />
          </Group>
        </View>
      )}
      {!!sheet && !!voice && <ProviderSheet provider={sheet} voice={voice} onClose={() => setSheet(null)} />}
    </Page>
  );
}
