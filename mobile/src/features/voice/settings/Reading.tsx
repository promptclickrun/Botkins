// Settings › Voice › Reading aloud: who reads replies, in which voice and at what speed, a sample,
// and whether replies are read by themselves. The computer's choices are shared by every phone;
// "This phone" reads in a voice and at a speed kept on this phone (prefs.ts).
import { Play, Square } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { TtsProvider } from "@/link/types";
import { setChatPrefs, useChatPrefs } from "@/state/chatPrefs";
import { useOnline } from "@/state/hooks";
import { Button, Group, Loading, Page, Row, Slider, space, T } from "@/ui";
import { missing, providerName, TTS_PROVIDERS } from "../choices";
import { useVoiceOptions } from "../options";
import { setPhoneVoice, usePhoneVoice } from "../prefs";
import { useVoiceSettings, useVoiceSupported } from "../state";
import { type PhoneVoice, phoneLanguage, phoneVoices, speakText, stopSpeech, useSpeakingNow } from "../tts";
import { Choice, Note, type Option, providerOptions, save, SetupRow, speedLabel, useProviderSheet, useSpeed, withDefault } from "./shared";

const SAMPLE = "Hi, I'm your Botkin. This is how I sound.";
const SAMPLE_ID = "voice-sample";
const QUALITY = { premium: "Premium", enhanced: "Enhanced", default: undefined };

function SampleButton({ onPlay }: { onPlay: () => void }) {
  const playing = useSpeakingNow((state) => state.id === SAMPLE_ID);
  return <Button title={playing ? "Stop" : "Play sample"} icon={playing ? Square : Play} variant="secondary" size="sm" onPress={playing ? stopSpeech : onPlay} />;
}

export default function Reading() {
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  const online = useOnline();
  const [openSheet, sheet] = useProviderSheet(voice);
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
  const voiceOptions: Option[] = onPhone
    ? withDefault((voices ?? []).map((item) => ({ id: item.id, name: item.name, subtitle: QUALITY[item.quality] })))
    : withDefault((options?.voices ?? []).map((item) => ({ id: item.id, name: item.name, subtitle: item.language })));
  const chosenVoice = onPhone ? (phone.voice ?? "") : (voice?.tts.voice ?? "");
  // Gemini's speech has no speed.
  const hasSpeed = provider !== "gemini";
  const loadingVoices = onPhone ? voices === undefined : options === undefined;
  const play = () => speakText(SAMPLE_ID, SAMPLE, onPhone ? { provider: "device", voice: phone.voice, speed } : { provider, voice: voice?.tts.voice, speed: hasSpeed ? speed : undefined });
  return (
    <Page title="Reading aloud">
      <View>
        <Group>
          <Choice
            title="Provider"
            subtitle={lack ?? undefined}
            value={provider}
            options={voice ? providerOptions("tts", TTS_PROVIDERS, voice) : [{ value: "device", label: providerName("device") }]}
            onChange={(next) => save({ tts: { provider: next as TtsProvider } })}
            disabled={!voice}
          />
          {!onPhone && !!options?.models.length && <Choice title="Model" value={voice?.tts.model ?? ""} options={withDefault(options.models)} onChange={(model) => save({ tts: { model: model || undefined } })} />}
          {loadingVoices ? (
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
        </Group>
        {onPhone ? <Note>Voice and speed are saved on this phone.</Note> : !hasSpeed ? <Note>Gemini reads at its own speed.</Note> : null}
      </View>
      <View style={{ alignItems: "flex-start" }}>
        <SampleButton onPlay={play} />
      </View>
      <SetupRow kind="tts" provider={provider} voice={voice} onOpen={openSheet} />
      <Group>
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
      {supported && !voice && online && <Loading />}
      {sheet}
    </Page>
  );
}
