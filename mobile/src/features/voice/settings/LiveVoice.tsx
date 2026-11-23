// Settings › Voice › Live voice: who talks back, with which model and voice (the computer's,
// shared by every phone), and how this phone listens: a live conversation or push to talk (kept on
// this phone, prefs.ts).
import { View } from "react-native";
import type { LiveProvider } from "@/link/types";
import { useOnline } from "@/state/hooks";
import { Group, Label, Loading, Page, Row, Segmented } from "@/ui";
import { LIVE_PROVIDERS, missing, OTHER_MODEL, providerName } from "../choices";
import { planFor } from "../live/index";
import { duplexAudio, webrtcModule } from "../native";
import { useVoiceOptions } from "../options";
import { setPhoneVoice, usePhoneVoice } from "../prefs";
import { UPDATE_COMPUTER, useVoiceSettings, useVoiceSupported } from "../state";
import { Choice, Note, type Option, save, SetupRow, TypedChoice, useProviderSheet, withDefault } from "./shared";
import { LIVE_INPUTS, liveInputLine, UNBUILT } from "./summary";

/** Whether this build has what a live provider needs. */
export const builtFor = (provider: LiveProvider) => !!planFor(provider, { webrtc: webrtcModule(), duplex: duplexAudio() });

export default function LiveVoice() {
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  const online = useOnline();
  const input = usePhoneVoice((prefs) => prefs.liveInput);
  const [openSheet, sheet] = useProviderSheet(voice);
  const provider = voice?.live.provider ?? null;
  const options = useVoiceOptions("live", provider, voice);

  if (!supported)
    return (
      <Page title="Live voice">
        <Group>
          <Row title="Live voice" subtitle={UPDATE_COMPUTER} disabled />
        </Group>
      </Page>
    );
  if (!voice) return <Page title="Live voice">{online && <Loading />}</Page>;

  const lack = provider ? (missing("live", provider, voice) ?? (builtFor(provider) ? null : UNBUILT)) : null;
  const choices: Option[] = [{ value: "", label: "Off" }, ...LIVE_PROVIDERS.map((item) => ({ value: item, label: providerName(item), subtitle: missing("live", item, voice) ?? (builtFor(item) ? undefined : UNBUILT) }))];
  return (
    <Page title="Live voice">
      <Group>
        <Choice title="Provider" subtitle={lack ?? undefined} value={provider ?? ""} options={choices} onChange={(next) => save({ live: { provider: (next || null) as LiveProvider | null } })} />
        {/* On Azure the model is the realtime deployment's name, so it may be typed. */}
        {provider === "azure" ? (
          <TypedChoice title="Model" value={voice.live.model ?? ""} items={withDefault(options?.models ?? [])} typing={OTHER_MODEL} onChange={(model) => save({ live: { model } })} />
        ) : (
          !!provider && !!options?.models.length && <Choice title="Model" value={voice.live.model ?? ""} options={withDefault(options.models)} onChange={(model) => save({ live: { model: model || undefined } })} />
        )}
        {!!provider && !!options?.voices.length && <Choice title="Voice" value={voice.live.voice ?? ""} options={withDefault(options.voices)} onChange={(next) => save({ live: { voice: next || undefined } })} />}
      </Group>
      <SetupRow kind="live" provider={provider} voice={voice} onOpen={openSheet} />
      {!!provider && (
        <View>
          <Label>How you talk</Label>
          <Segmented options={LIVE_INPUTS} value={input} onChange={(liveInput) => setPhoneVoice({ liveInput })} />
          <Note>{liveInputLine(input) + " Saved on this phone."}</Note>
        </View>
      )}
      {sheet}
    </Page>
  );
}
