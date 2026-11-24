// Display choices belong to this phone. Automatic chat titles are configured on the computer.
import { MenuView } from "@react-native-menu/menu";
import { ChevronsUpDown } from "lucide-react-native";
import { View } from "react-native";
import { useCan, useOnline, useSettings } from "@/state/hooks";
import { COMPLETION_POSITIONS } from "@/features/chat/completion";
import { api, attempt } from "@/state/link";
import { BOT_TAPS } from "@/features/chat/habits";
import { type ChatPrefs, setChatPrefs, useChatPrefs } from "@/state/chatPrefs";
import { Group, Label, Page, Row, space, T, useTheme } from "@/ui";

const STEPS: { value: ChatPrefs["steps"]; label: string; subtitle: string }[] = [
  { value: "folded", label: "Folded", subtitle: "Tool calls stay in the working rail" },
  { value: "show", label: "Open", subtitle: "Show every tool call in the chat as it happens" },
  { value: "failed", label: "Failed only", subtitle: "Show only failed tool calls in the chat" },
];
const THINKING: { value: ChatPrefs["thinking"]; label: string; subtitle: string }[] = [
  { value: "folded", label: "Folded", subtitle: "Thinking and updates stay in the working rail" },
  { value: "show", label: "Open", subtitle: "Show thinking and updates in the chat as they arrive" },
  { value: "hide", label: "Hidden", subtitle: "Hide thinking and updates in the chat and working rail" },
];

/** Auto-summarize: off, or every 5 to 30 turns (the computer's desktop/summaries.mjs). */
const SUMMARY_TURNS = [0, ...Array.from({ length: 26 }, (_, i) => i + 5)].map((turns) => ({
  value: String(turns),
  label: turns ? "Every " + turns + " turns" : "Off",
  subtitle: turns ? undefined : "Chats keep your first message as their title",
}));

/** A row whose value opens a short list of choices. `stacked` puts a long choice under the title instead of beside it. */
export function ChoiceMenu<V extends string>({ title, subtitle, value, options, onChange, stacked, subtitleLines = 2 }: { title: string; subtitle?: string; value: V; options: { value: V; label: string; subtitle?: string }[]; onChange: (value: V) => void; stacked?: boolean; /** Lines the subtitle may take before it is cut (default 2). */ subtitleLines?: number }) {
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
        <Row title={title} subtitle={stacked ? current.label : subtitle} subtitleLines={subtitleLines} value={stacked ? undefined : current.label} trailing={<ChevronsUpDown size={16} color={colors.faint} strokeWidth={2.2} />} />
      </View>
    </MenuView>
  );
}

export default function Chat() {
  const prefs = useChatPrefs();
  const settings = useSettings();
  const online = useOnline();
  const canManage = useCan("settings", "manage");
  return (
    <Page title="Chat">
      <View>
        <Label>What a reply shows</Label>
        <Group>
          <ChoiceMenu title="Steps" subtitle="A bot's work in a turn" value={prefs.steps} options={STEPS} onChange={(steps) => setChatPrefs({ steps })} />
          <ChoiceMenu title="Thinking and updates" subtitle="Its reasoning and notes while it works" value={prefs.thinking} options={THINKING} onChange={(thinking) => setChatPrefs({ thinking })} />
          <Row title="Fold finished steps" subtitle="One line with elapsed time and step count" subtitleLines={2} toggled={prefs.foldFinishedSteps} onToggle={(foldFinishedSteps) => setChatPrefs({ foldFinishedSteps })} />
          <Row title="Text streaming" subtitle="See the reply a few words at a time as it writes" toggled={prefs.textStreaming} onToggle={(textStreaming) => setChatPrefs({ textStreaming })} />
          <Row title="Rich cards" subtitle="Charts, tables and suggested replies" toggled={prefs.richCards} onToggle={(richCards) => setChatPrefs({ richCards })} />
          <Row title="Timestamps" toggled={prefs.timestamps} onToggle={(timestamps) => setChatPrefs({ timestamps })} />
        </Group>
      </View>

      <View>
        <Label>Opening</Label>
        <Group>
          <ChoiceMenu title="When you select a bot" value={prefs.botTap} options={BOT_TAPS} onChange={(botTap) => setChatPrefs({ botTap })} stacked />
        </Group>
      </View>

      <View>
        <Label>Scrolling</Label>
        <Group>
          <ChoiceMenu
            title="Position after response completes"
            value={prefs.completionPosition}
            options={COMPLETION_POSITIONS}
            onChange={(completionPosition) => setChatPrefs({ completionPosition })}
            stacked
          />
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

      {settings?.autoSummarize !== undefined && (
        <View>
          <Label>Chat titles</Label>
          <Group>
            {canManage && online ? (
              <ChoiceMenu
                title="Auto-summarize"
                subtitle="Names a chat from what it's about"
                value={String(settings.autoSummarize)}
                options={SUMMARY_TURNS}
                onChange={(turns) => void attempt(api.setPreferences({ autoSummarize: Number(turns) }))}
              />
            ) : (
              <Row title="Auto-summarize" subtitle={canManage ? "Change it when your computer is back" : "The computer's owner changes it"} value={SUMMARY_TURNS.find((option) => option.value === String(settings.autoSummarize))?.label} />
            )}
          </Group>
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, paddingTop: space.sm }}>
            A new chat is named from your first message, then renamed every few turns. It uses the Default routines model. A chat you rename keeps your title.
          </T>
        </View>
      )}

      <View>
        <Label>On your computer too</Label>
        <Group>
          <Row
            title="Show thinking"
            subtitle="In its app; here, the row above decides"
            toggled={settings?.showThinking ?? true}
            disabled={!settings || !online || !canManage}
            onToggle={(showThinking) => void attempt(api.setPreferences({ showThinking }))}
          />
          <Row
            title="Fold finished steps"
            subtitle="In its app; here, Steps above decides"
            toggled={settings?.foldTools ?? true}
            disabled={!settings || !online || !canManage}
            onToggle={(foldTools) => void attempt(api.setPreferences({ foldTools }))}
          />
        </Group>
      </View>
    </Page>
  );
}
