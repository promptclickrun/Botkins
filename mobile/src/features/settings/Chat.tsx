// How chats show a bot's work and replies on this phone, and the two choices kept on the computer.
import { MenuView } from "@react-native-menu/menu";
import { ChevronsUpDown } from "lucide-react-native";
import { View } from "react-native";
import { useOnline, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { type ChatPrefs, setChatPrefs, useChatPrefs } from "@/state/chatPrefs";
import { Group, Label, Page, Row, useTheme } from "@/ui";

const STEPS: { value: ChatPrefs["steps"]; label: string; subtitle: string }[] = [
  { value: "folded", label: "Folded", subtitle: "Every step while it works; one line when it's done" },
  { value: "show", label: "Every step", subtitle: "Each step, thought and update in order" },
  { value: "failed", label: "Failed only", subtitle: "Only steps that went wrong" },
  { value: "hide", label: "Hidden", subtitle: "Approvals and errors still show" },
];
const THINKING: { value: ChatPrefs["thinking"]; label: string; subtitle: string }[] = [
  { value: "show", label: "Open", subtitle: "All of it, as it comes" },
  { value: "folded", label: "Folded", subtitle: "The last few lines; tap for more" },
  { value: "hide", label: "Hidden", subtitle: "Not in the chat; the activity has it" },
];

/** A row whose value opens a short list of choices. */
function ChoiceMenu<V extends string>({ title, subtitle, value, options, onChange }: { title: string; subtitle?: string; value: V; options: { value: V; label: string; subtitle: string }[]; onChange: (value: V) => void }) {
  const { colors } = useTheme();
  const current = options.find((option) => option.value === value) ?? options[0];
  return (
    <MenuView
      title={title}
      actions={options.map((option) => ({ id: option.value, title: option.label, subtitle: option.subtitle, state: option.value === value ? "on" : "off" }))}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event as V)}
      isAnchoredToRight
    >
      <View accessible accessibilityRole="button" accessibilityLabel={title + ", " + current.label} accessibilityHint="Opens the choices">
        <Row title={title} subtitle={subtitle} value={current.label} trailing={<ChevronsUpDown size={16} color={colors.faint} strokeWidth={2.2} />} />
      </View>
    </MenuView>
  );
}

export default function Chat() {
  const prefs = useChatPrefs();
  const settings = useSettings();
  const online = useOnline();
  return (
    <Page title="Chat">
      <View>
        <Label>What a reply shows</Label>
        <Group>
          <ChoiceMenu title="Steps" subtitle="A bot's work in a turn" value={prefs.steps} options={STEPS} onChange={(steps) => setChatPrefs({ steps })} />
          <ChoiceMenu title="Thinking and updates" subtitle="Its reasoning and notes while it works" value={prefs.thinking} options={THINKING} onChange={(thinking) => setChatPrefs({ thinking })} />
          <Row title="Rich cards" subtitle="Charts, tables and suggested replies" toggled={prefs.richCards} onToggle={(richCards) => setChatPrefs({ richCards })} />
          <Row title="Timestamps" toggled={prefs.timestamps} onToggle={(timestamps) => setChatPrefs({ timestamps })} />
        </Group>
      </View>

      <View>
        <Label>Text</Label>
        <Group>
          <Row title="Markdown" subtitle="Off shows replies as plain text" toggled={prefs.markdown} onToggle={(markdown) => setChatPrefs({ markdown })} />
          <Row title="Color code" toggled={prefs.highlight} onToggle={(highlight) => setChatPrefs({ highlight })} disabled={!prefs.markdown} />
          <Row title="Wrap code" subtitle="Off scrolls long lines sideways" toggled={prefs.wrapCode} onToggle={(wrapCode) => setChatPrefs({ wrapCode })} disabled={!prefs.markdown} />
        </Group>
      </View>

      <View>
        <Label>Typing</Label>
        <Group>
          <Row title="Return sends" subtitle="Off makes Return a new line" toggled={prefs.enterSends} onToggle={(enterSends) => setChatPrefs({ enterSends })} />
        </Group>
      </View>

      <View>
        <Label>Sound</Label>
        <Group>
          <Row title="Read replies aloud" subtitle="In the chat that is open" toggled={prefs.readAloud} onToggle={(readAloud) => setChatPrefs({ readAloud })} />
        </Group>
      </View>

      <View>
        <Label>On your computer too</Label>
        <Group>
          <Row
            title="Show thinking"
            subtitle="In its app; here, the row above decides"
            toggled={settings?.showThinking ?? true}
            disabled={!settings || !online}
            onToggle={(showThinking) => void attempt(api.setPreferences({ showThinking }))}
          />
          <Row
            title="Fold finished steps"
            subtitle="In its app; here, Steps above decides"
            toggled={settings?.foldTools ?? true}
            disabled={!settings || !online}
            onToggle={(foldTools) => void attempt(api.setPreferences({ foldTools }))}
          />
        </Group>
      </View>
    </Page>
  );
}
