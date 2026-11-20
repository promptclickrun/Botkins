import { CircleHelp, GitPullRequestArrow, History, ListChecks, TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import type { Preferences } from "@/link/types";
import { useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { brand, Button, Field, Group, IconTile, Label, Loading, Page, Row, space, useTheme } from "@/ui";
import { ChoiceRow } from "./shared";

const MODES: { value: Preferences["approval"]; title: string; subtitle: string }[] = [
  { value: "ask", title: "Ask every time", subtitle: "Bots check with you before they act" },
  { value: "read", title: "Allow reading", subtitle: "Reading is fine, changes need a yes" },
  { value: "assisted", title: "Let the model decide", subtitle: "It asks when something looks risky" },
  { value: "all", title: "Allow everything", subtitle: "Bots never ask. Use with care" },
];

const CLARIFY = [
  { value: "missing", title: "Something is missing", icon: CircleHelp },
  { value: "choices", title: "There are choices", icon: ListChecks },
  { value: "changes", title: "It would change things", icon: GitPullRequestArrow },
] as const;

const MAX_INSTRUCTIONS = 4000;

/** Chats and approvals › Custom question instructions: added for every bot, saved with its own button. */
function QuestionInstructions({ saved }: { saved: string }) {
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    await attempt(api.setPreferences({ clarificationInstructions: draft }), "Question instructions saved");
    setSaving(false);
  };
  return (
    <View style={{ gap: space.md }}>
      <Field
        label="Custom question instructions"
        hint="Added for every bot. Each bot can add its own."
        placeholder="Ask about the audience before drafting a report."
        value={draft}
        onChangeText={setDraft}
        maxLength={MAX_INSTRUCTIONS}
        area
      />
      <Button title="Save instructions" variant="secondary" loading={saving} disabled={draft === saved} onPress={() => void save()} />
    </View>
  );
}

/** What bots may do without asking, and when they ask before they start. */
export default function Approvals() {
  const { colors } = useTheme();
  const settings = useSettings();
  if (!settings)
    return (
      <Page title="Approvals">
        <Loading />
      </Page>
    );

  const clarify = settings.clarify;
  const toggle = (value: string, on: boolean) => {
    const next = on ? [...clarify.filter((item) => item !== value), value] : clarify.filter((item) => item !== value);
    void attempt(api.setPreferences({ clarify: next }));
  };
  const forget = () =>
    Alert.alert("Forget remembered approvals?", "Bots will ask again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => void attempt(api.clearApprovals(), "Forgotten") },
    ]);

  return (
    <Page title="Approvals" keyboard>
      <View>
        <Label>When a bot wants to act</Label>
        <Group>
          {MODES.map((mode) => (
            <ChoiceRow
              key={mode.value}
              title={mode.title}
              subtitle={mode.subtitle}
              warning={mode.value === "all"}
              icon={mode.value === "all" ? TriangleAlert : undefined}
              selected={settings.approval === mode.value}
              onPress={() => settings.approval !== mode.value && void attempt(api.setPreferences({ approval: mode.value }))}
            />
          ))}
        </Group>
      </View>

      <View>
        <Label>Ask me first when</Label>
        <Group>
          {CLARIFY.map((item) => (
            <Row key={item.value} leading={<IconTile icon={item.icon} color={brand.fern} />} title={item.title} toggled={clarify.includes(item.value)} onToggle={(on) => toggle(item.value, on)} />
          ))}
        </Group>
      </View>

      <QuestionInstructions key={settings.clarificationInstructions} saved={settings.clarificationInstructions ?? ""} />

      <Group>
        <Row leading={<IconTile icon={History} color={colors.ink2} />} title="Forget remembered approvals" onPress={forget} />
      </Group>
    </Page>
  );
}
