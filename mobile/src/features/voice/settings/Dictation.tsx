// Settings › Voice › Dictation: who turns speech into text, with which model and language.
// The choices are the computer's, shared by every phone. Without voice-v1 it is always this phone.
import { View } from "react-native";
import type { SttProvider } from "@/link/types";
import { useOnline } from "@/state/hooks";
import { Group, Loading, Page } from "@/ui";
import { LANGUAGES, OTHER_MODEL, providerName, STT_PROVIDERS, missing } from "../choices";
import { useVoiceOptions } from "../options";
import { UPDATE_COMPUTER, useVoiceSettings, useVoiceSupported } from "../state";
import { Choice, Note, providerOptions, save, SetupRow, TypedChoice, useProviderSheet, withDefault } from "./shared";

export default function Dictation() {
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  const online = useOnline();
  const [openSheet, sheet] = useProviderSheet(voice);
  const provider: SttProvider = voice?.stt.provider ?? "device";
  const options = useVoiceOptions("stt", provider, voice);
  const lack = voice ? missing("stt", provider, voice) : null;
  return (
    <Page title="Dictation">
      <View>
        <Group>
          <Choice
            title="Provider"
            subtitle={lack ?? undefined}
            value={provider}
            options={voice ? providerOptions("stt", STT_PROVIDERS, voice) : [{ value: "device", label: providerName("device") }]}
            onChange={(next) => save({ stt: { provider: next as SttProvider } })}
            disabled={!voice}
          />
          {/* Azure's model may be typed: a model it has that the list doesn't, or the deployment of Azure OpenAI audio. */}
          {provider === "azure" ? (
            <TypedChoice title="Model" value={voice?.stt.model ?? ""} items={withDefault(options?.models ?? [])} typing={OTHER_MODEL} onChange={(model) => save({ stt: { model } })} />
          ) : (
            !!options?.models.length && <Choice title="Model" value={voice?.stt.model ?? ""} options={withDefault(options.models)} onChange={(model) => save({ stt: { model: model || undefined } })} />
          )}
          {!!voice && <Choice title="Language" value={voice.stt.language ?? ""} options={LANGUAGES} onChange={(language) => save({ stt: { language: language || undefined } })} />}
        </Group>
        {!supported && <Note>{UPDATE_COMPUTER + " for other providers."}</Note>}
      </View>
      <SetupRow kind="stt" provider={provider} voice={voice} onOpen={openSheet} />
      {supported && !voice && online && <Loading />}
      {sheet}
    </Page>
  );
}
