// How chats show a bot's work and replies on this phone, and the matching choices kept on the computer.
import { MenuView } from "@react-native-menu/menu";
import { ChevronsUpDown } from "lucide-react-native";
import { View } from "react-native";
import { useCan, useOnline, usePart, useSettings } from "@/state/hooks";
import { COMPLETION_POSITIONS } from "@/features/chat/completion";
import { api, attempt } from "@/state/link";
import { BOT_TAPS } from "@/features/chat/habits";
import { islandOn } from "@/features/chat/islandModel";
import { type ChatPrefs, setChatPrefs, useChatPrefs } from "@/state/chatPrefs";
import { type Href, router } from "expo-router";
import { ShieldCheck } from "lucide-react-native";
import { brand, Group, IconTile, Label, Page, Row, space, T, useTheme } from "@/ui";
import { APPROVAL_SHORT } from "./Settings";

// Open is the island (src/features/chat/islandModel.ts): one live window per running turn. The setting is "Steps", never "Tools".
const STEPS: { value: ChatPrefs["steps"]; label: string; subtitle: string }[] = [
  { value: "folded", label: "Folded", subtitle: "Steps stay in the working rail" },
  { value: "show", label: "Open", subtitle: "A live window of the newest steps" },
  { value: "failed", label: "Failed only", subtitle: "Show only failed steps in the chat" },
];
const THINKING: { value: ChatPrefs["thinking"]; label: string; subtitle: string }[] = [
  { value: "folded", label: "Folded", subtitle: "Chain of thought stays in the working rail" },
  { value: "show", label: "Open", subtitle: "The latest lines of thought, in the same window" },
  { value: "hide", label: "Hidden", subtitle: "Not shown while a bot works" },
];
/** Under the row's title: what the choice made does. */
const choiceLine = (options: { value: string; label: string; subtitle: string }[], value: string, fallback: string) => {
  const option = options.find((entry) => entry.value === value);
  return value === "show" && option ? option.label + ": " + option.subtitle.charAt(0).toLowerCase() + option.subtitle.slice(1) : fallback;
};

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
  const owner = usePart("meta")?.you?.kind !== "member";
  const chatMode = usePart("proactive")?.chatMode;
  const online = useOnline();
  const canManage = useCan("settings", "manage");
  return (
    <Page title="Chat">
      {/* Approvals live here as on the computer, whose Chat settings say when bots ask first. */}
      {owner && (
        <Group>
          <Row leading={<IconTile icon={ShieldCheck} color={brand.fern} />} title="Approvals" subtitle="When bots ask you first" value={settings ? APPROVAL_SHORT[settings.approval] : undefined} chevron onPress={() => router.push("/settings/approvals" as Href)} />
        </Group>
      )}
      <View>
        <Label>What a reply shows</Label>
        <Group>
          <ChoiceMenu title="Steps" subtitle={choiceLine(STEPS, prefs.steps, "A bot's work in a turn")} value={prefs.steps} options={STEPS} onChange={(steps) => setChatPrefs({ steps })} />
          <ChoiceMenu title="Thinking" subtitle={choiceLine(THINKING, prefs.thinking, "Chain of thought while a bot works")} value={prefs.thinking} options={THINKING} onChange={(thinking) => setChatPrefs({ thinking })} />
          <Row title="Updates" subtitle="Interim messages land in the chat" toggled={prefs.updates} onToggle={(updates) => setChatPrefs({ updates })} />
          {/* With Open, a finished turn always folds into the island's receipt, so the switch would do nothing. */}
          {!islandOn(prefs) && <Row title="Fold finished steps" subtitle="One line with elapsed time and step count" subtitleLines={2} toggled={prefs.foldFinishedSteps} onToggle={(foldFinishedSteps) => setChatPrefs({ foldFinishedSteps })} />}
          <Row title="Text streaming" subtitle="See the reply a few words at a time as it writes" toggled={prefs.textStreaming} onToggle={(textStreaming) => setChatPrefs({ textStreaming })} />
          <Row title="Rich cards" subtitle="Charts, tables and suggested replies" toggled={prefs.richCards} onToggle={(richCards) => setChatPrefs({ richCards })} />
          <Row title="Timestamps" toggled={prefs.timestamps} onToggle={(timestamps) => setChatPrefs({ timestamps })} />
        </Group>
      </View>

      <View>
        <Label>Opening</Label>
        <Group>
          <ChoiceMenu title="When you select a bot" value={!chatMode && prefs.botTap === "main" ? "latest" : prefs.botTap} options={chatMode ? BOT_TAPS : BOT_TAPS.filter(t => t.value !== "main")} onChange={(botTap) => setChatPrefs({ botTap })} stacked />
          {chatMode && <ChoiceMenu title="Proactive signals" subtitle="Where your bots send alerts delivered to chat." value={chatMode}
            options={[{ value: "main", label: "Main chat" }, { value: "new", label: "New chat every time" }]}
            onChange={mode => void attempt(api.setProactiveChatMode(mode))} />}
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
            title="Fold thinking"
            subtitle="In its app; off keeps thinking open inline"
            toggled={settings?.foldThinking ?? true}
            disabled={!settings || !online || !canManage || settings.showThinking === false}
            onToggle={(foldThinking) => void attempt(api.setPreferences({ foldThinking }))}
          />
          <Row
            title="Show updates"
            subtitle="In its app; here, Updates above decides"
            toggled={settings?.showUpdates ?? true}
            disabled={!settings || !online || !canManage}
            onToggle={(showUpdates) => void attempt(api.setPreferences({ showUpdates }))}
          />
          <Row
            title="Fold tool calls"
            subtitle="In its app; off keeps work groups open inline"
            toggled={settings?.foldTools ?? true}
            disabled={!settings || !online || !canManage}
            onToggle={(foldTools) => void attempt(api.setPreferences({ foldTools }))}
          />
        </Group>
      </View>
    </Page>
  );
}
