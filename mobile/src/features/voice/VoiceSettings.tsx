// Settings › Voice: what dictation, reading aloud and live voice are set to, one row each, and a
// row for the providers' keys. Each row opens its own page (src/features/voice/settings/). The
// choices are the computer's, shared by every phone; keys stay on the computer. "This phone"
// choices (its voice and speed, how live voice listens) are kept on the phone.
import { type Href, router } from "expo-router";
import { AudioLines, KeyRound, type LucideIcon, Mic, Volume2 } from "lucide-react-native";
import { View } from "react-native";
import { useChatPrefs } from "@/state/chatPrefs";
import { useOnline } from "@/state/hooks";
import { Group, IconTile, Loading, Page, Row, useTheme } from "@/ui";
import { usePhoneVoice } from "./prefs";
import { builtFor } from "./settings/LiveVoice";
import { Note } from "./settings/shared";
import { dictationSummary, keysSummary, liveSummary, readingSummary, type Summary } from "./settings/summary";
import { UPDATE_COMPUTER, useVoiceSettings, useVoiceSupported } from "./state";

function Feature({ icon, title, summary, path }: { icon: LucideIcon; title: string; summary?: Summary; path: string }) {
  const { colors } = useTheme();
  return (
    <Row
      leading={<IconTile icon={icon} color={summary?.needs ? colors.warning : colors.ink2} />}
      title={title}
      subtitle={summary?.subtitle}
      value={summary?.value}
      chevron
      onPress={() => router.push(path as unknown as Href)}
    />
  );
}

export default function VoiceSettings() {
  const { colors } = useTheme();
  const supported = useVoiceSupported();
  const voice = useVoiceSettings();
  const online = useOnline();
  const readAloud = useChatPrefs((prefs) => prefs.readAloud);
  const input = usePhoneVoice((prefs) => prefs.liveInput);
  // With voice-v1 the computer's settings decide; until they arrive, nothing is guessed.
  const known = !supported || !!voice;
  return (
    <Page title="Voice">
      <View>
        <Group>
          <Feature icon={Mic} title="Dictation" summary={known ? dictationSummary(voice) : undefined} path="/settings/voice/dictation" />
          <Feature icon={Volume2} title="Reading aloud" summary={known ? readingSummary(voice, readAloud) : undefined} path="/settings/voice/reading" />
          {supported ? (
            <Feature icon={AudioLines} title="Live voice" summary={voice ? liveSummary(voice, input, builtFor) : undefined} path="/settings/voice/live" />
          ) : (
            <Row leading={<IconTile icon={AudioLines} color={colors.ink2} />} title="Live voice" subtitle={UPDATE_COMPUTER} disabled />
          )}
        </Group>
        <Note>{supported ? "Saved on your computer, for every phone." : UPDATE_COMPUTER + " for more providers."}</Note>
      </View>
      {supported && !!voice && (
        <Group>
          <Row leading={<IconTile icon={KeyRound} color={colors.ink2} />} title="Keys and servers" subtitle={keysSummary(voice)} chevron onPress={() => router.push("/settings/voice/keys" as unknown as Href)} />
        </Group>
      )}
      {supported && !voice && online && <Loading />}
    </Page>
  );
}
