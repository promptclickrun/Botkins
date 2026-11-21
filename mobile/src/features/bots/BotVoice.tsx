// A bot's own voice ("bot-voice-v1"): who reads its replies and who talks in live voice with it, when
// that isn't what Settings › Voice says. A choice left on "Same as Settings" follows Settings. The
// computer keeps the choices with the bot; keys stay shared. When the bot reads with "This phone"
// its system voice is kept on this phone, because a system voice isn't portable.
import { router, useLocalSearchParams } from "expo-router";
import { Play, Square } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { Bot, LiveProvider, TtsProvider, VoiceSettings } from "@/link/types";
import { effectiveLive, effectiveTts, tidyVoice, withProvider, withSection } from "@/features/voice/botVoice";
import { LIVE_PROVIDERS, missing, providerName, TTS_PROVIDERS } from "@/features/voice/choices";
import { useVoiceOptions } from "@/features/voice/options";
import { setBotDeviceVoice, usePhoneVoice } from "@/features/voice/prefs";
import { Choice, Note, type Option, speedLabel, useSpeed } from "@/features/voice/settings/shared";
import { builtFor } from "@/features/voice/settings/LiveVoice";
import { useBotVoiceSupported, useVoiceSettings } from "@/features/voice/state";
import { type PhoneVoice, phoneLanguage, phoneVoices, speakText, stopSpeech, useSpeakingNow } from "@/features/voice/tts";
import { useBot, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Button, EmptyState, Group, Label, Loading, Row, Sheet, Slider, space, T } from "@/ui";

const SAMPLE = "Hi, I'm your Botkin. This is how I sound.";
const QUALITY = { premium: "Premium", enhanced: "Enhanced", default: undefined };
const UPDATE_APP_ON_COMPUTER = "Update the app on your computer";

/** The shared choice, named, as the first row of a list. */
const same = (subtitle?: string): Option => ({ value: "", label: "Same as Settings", subtitle });
/** What a provider lists, under a first row that says what an empty choice means. */
const listed = (first: string, items: { id: string; name: string; subtitle?: string }[]): Option[] => [{ value: "", label: first }, ...items.map((item) => ({ value: item.id, label: item.name, subtitle: item.subtitle }))];

export default function BotVoice() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  const synced = useApp((state) => state.synced);
  const supported = useBotVoiceSupported();
  const voice = useVoiceSettings();
  const online = useOnline();
  if (!bot) return <Sheet title="Voice">{synced ? <EmptyState title="This bot is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}</Sheet>;
  if (!supported)
    return (
      <Sheet title="Voice">
        <Group>
          <Row title="Voice" subtitle={UPDATE_APP_ON_COMPUTER} disabled />
        </Group>
      </Sheet>
    );
  if (!voice) return <Sheet title="Voice">{online ? <Loading /> : <EmptyState title="Your computer isn't reachable" />}</Sheet>;
  return (
    <Sheet title="Voice">
      <Reading bot={bot} voice={voice} />
      <Live bot={bot} voice={voice} />
    </Sheet>
  );
}

/** Saves the bot's voice on the computer. A voice with nothing set is cleared. */
const saveVoice = (bot: Bot, voice: Bot["voice"] | null) => void attempt(api.updateBot(bot.id, { voice: tidyVoice(voice ?? undefined) }));

function Reading({ bot, voice }: { bot: Bot; voice: VoiceSettings }) {
  const own = bot.voice?.tts;
  const effective = effectiveTts(voice.tts, own);
  const provider: TtsProvider = effective.provider;
  const onPhone = provider === "device";
  const options = useVoiceOptions("tts", provider, voice);
  const local = usePhoneVoice((prefs) => prefs.bots?.[bot.id]);
  const phoneSpeed = usePhoneVoice((prefs) => prefs.speed);
  const [voices, setVoices] = useState<PhoneVoice[] | undefined>();
  const language = voice.stt.language || phoneLanguage();
  useEffect(() => {
    if (!onPhone) return;
    let live = true;
    void phoneVoices(language).then((found) => live && setVoices(found));
    return () => {
      live = false;
    };
  }, [onPhone, language]);
  // The providers that have what they need, and the one chosen even when it lost something.
  const ready = TTS_PROVIDERS.filter((item) => item === own?.provider || !missing("tts", item, voice));
  const providerChoices: Option[] = [same(providerName(voice.tts.provider)), ...ready.map((item) => ({ value: item, label: providerName(item), subtitle: missing("tts", item, voice) ?? undefined }))];
  const lack = missing("tts", provider, voice);
  const fits = provider === voice.tts.provider;
  const none = fits ? "Same as Settings" : "Default";
  const hasSpeed = provider !== "gemini";
  const shown = onPhone ? (local?.speed ?? phoneSpeed) : (effective.speed ?? 1);
  // Saved a moment after the slider stops, into the bot's voice as it is then: a provider or voice
  // picked meanwhile is not undone.
  const [speed, setSpeed] = useSpeed(shown, (next) => {
    const now = useApp.getState().parts.bots?.find((item) => item.id === bot.id) ?? bot;
    if (effectiveTts(useApp.getState().parts.voice?.tts ?? voice.tts, now.voice?.tts).provider === "device") setBotDeviceVoice(bot.id, { speed: next });
    else saveVoice(now, withSection(now.voice, "tts", { speed: next }));
  });
  const voiceOptions: Option[] = onPhone
    ? listed("Default", (voices ?? []).map((item) => ({ id: item.id, name: item.name, subtitle: QUALITY[item.quality] })))
    : listed(none, options?.voices ?? []);
  const loadingVoices = onPhone ? voices === undefined : options === undefined;
  const playing = useSpeakingNow((state) => state.id === "bot-voice-sample");
  return (
    <View>
      <Label>Reading aloud</Label>
      <Group>
        <Choice title="Provider" subtitle={lack ?? undefined} value={own?.provider ?? ""} options={providerChoices} onChange={(next) => saveVoice(bot, withProvider(bot.voice, "tts", next || undefined))} />
        {!onPhone && !!options?.models.length && <Choice title="Model" value={own?.model ?? ""} options={listed(none, options.models)} onChange={(model) => saveVoice(bot, withSection(bot.voice, "tts", { provider: own?.provider ?? provider, model: model || undefined }))} />}
        {loadingVoices ? <Row title="Voice" value="Loading…" disabled /> : voiceOptions.length > 1 && <Choice title="Voice" value={onPhone ? (local?.voice ?? "") : (own?.voice ?? "")} options={voiceOptions} onChange={(next) => (onPhone ? setBotDeviceVoice(bot.id, { voice: next || undefined }) : saveVoice(bot, withSection(bot.voice, "tts", { provider: own?.provider ?? provider, voice: next || undefined })))} />}
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
      <View style={{ alignItems: "flex-start", marginTop: space.md }}>
        <Button title={playing ? "Stop" : "Play sample"} icon={playing ? Square : Play} variant="secondary" size="sm" onPress={playing ? stopSpeech : () => speakText("bot-voice-sample", SAMPLE, { botId: bot.id })} />
      </View>
    </View>
  );
}

function Live({ bot, voice }: { bot: Bot; voice: VoiceSettings }) {
  const own = bot.voice?.live;
  const effective = effectiveLive(voice.live, own);
  const provider: LiveProvider | null = effective.provider;
  const options = useVoiceOptions("live", provider, voice);
  const lackOf = (item: LiveProvider) => missing("live", item, voice) ?? (builtFor(item) ? null : "Update the app for this one");
  const ready = LIVE_PROVIDERS.filter((item) => item === own?.provider || !lackOf(item));
  const providerChoices: Option[] = [same(voice.live.provider ? providerName(voice.live.provider) : "Off"), ...ready.map((item) => ({ value: item, label: providerName(item), subtitle: lackOf(item) ?? undefined }))];
  const none = provider === voice.live.provider ? "Same as Settings" : "Default";
  return (
    <View>
      <Label>Live voice</Label>
      <Group>
        <Choice title="Provider" subtitle={provider ? (lackOf(provider) ?? undefined) : undefined} value={own?.provider ?? ""} options={providerChoices} onChange={(next) => saveVoice(bot, withProvider(bot.voice, "live", next || undefined))} />
        {!!provider && !!options?.models.length && <Choice title="Model" value={own?.model ?? ""} options={listed(none, options.models)} onChange={(model) => saveVoice(bot, withSection(bot.voice, "live", { provider: own?.provider ?? provider ?? undefined, model: model || undefined }))} />}
        {!!provider && !!options?.voices.length && <Choice title="Voice" value={own?.voice ?? ""} options={listed(none, options.voices)} onChange={(next) => saveVoice(bot, withSection(bot.voice, "live", { provider: own?.provider ?? provider ?? undefined, voice: next || undefined }))} />}
      </Group>
      <Note>Keys and sign-ins are set in Settings › Voice.</Note>
    </View>
  );
}
