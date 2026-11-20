// Settings › Voice › Keys and servers: each provider's key and address, opened in ProviderSheet.
// A key is typed only there and kept on the computer; this page shows only whether one is saved.
import { View } from "react-native";
import { useOnline } from "@/state/hooks";
import { Group, Loading, Page, Row } from "@/ui";
import { KEY_PROVIDERS, providerName, providerState } from "../choices";
import { UPDATE_COMPUTER, useVoiceSettings, useVoiceSupported } from "../state";
import { Note, ProviderMark, useProviderSheet } from "./shared";
import type { SheetProvider } from "./summary";

const ROWS: SheetProvider[] = [...KEY_PROVIDERS, "local"];

export default function Keys() {
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  const online = useOnline();
  const [openSheet, sheet] = useProviderSheet(voice);
  if (!supported)
    return (
      <Page title="Keys and servers">
        <Group>
          <Row title="Keys and servers" subtitle={UPDATE_COMPUTER} disabled />
        </Group>
      </Page>
    );
  if (!voice) return <Page title="Keys and servers">{online && <Loading />}</Page>;
  return (
    <Page title="Keys and servers">
      <View>
        <Group>
          {ROWS.map((provider) => (
            <Row key={provider} leading={<ProviderMark provider={provider} />} title={providerName(provider)} subtitle={providerState(provider, voice)} chevron onPress={() => openSheet(provider)} />
          ))}
          <Row leading={<ProviderMark provider="codex" />} title={providerName("codex")} subtitle={providerState("codex", voice)} />
        </Group>
        <Note>Keys are kept on your computer, never on this phone.</Note>
      </View>
      {sheet}
    </Page>
  );
}
