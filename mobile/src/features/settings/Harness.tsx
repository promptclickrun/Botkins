import { View } from "react-native";
import type { Preferences } from "@/link/types";
import { useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { EmptyState, Group, Label, Loading, Page, T } from "@/ui";
import { ChoiceRow } from "./shared";

type Harness = NonNullable<Preferences["harness"]>;

// The same two choices, names and words as Settings › General › Harness on the computer.
export const HARNESSES: { value: Harness; title: string; subtitle: string }[] = [
  { value: "copilot", title: "Copilot SDK", subtitle: "One harness for every model and plan" },
  { value: "provider", title: "Provider default", subtitle: "Codex for ChatGPT, Claude Code for Claude" },
];
export const harnessName = (value: Preferences["harness"]) => HARNESSES.find((harness) => harness.value === value)?.title;

/** Settings › Harness: what runs a bot's turn around the model. The choice is the computer's. */
export default function HarnessSettings() {
  const settings = useSettings();
  if (!settings)
    return (
      <Page title="Harness">
        <Loading />
      </Page>
    );
  if (!settings.harness)
    return (
      <Page title="Harness">
        <EmptyState title="Not on this computer yet" text="Update the app on your computer." />
      </Page>
    );
  return (
    <Page title="Harness">
      <View>
        <Label>What runs your bots</Label>
        <Group>
          {HARNESSES.map((harness) => (
            <ChoiceRow
              key={harness.value}
              title={harness.title}
              subtitle={harness.subtitle}
              selected={settings.harness === harness.value}
              onPress={() => settings.harness !== harness.value && void attempt(api.setPreferences({ harness: harness.value }))}
            />
          ))}
        </Group>
        <T variant="footnote" color="muted" style={{ marginTop: 8, paddingHorizontal: 4 }}>
          A chat keeps its conversation when you switch. Its next reply starts on the other harness.
        </T>
      </View>
    </Page>
  );
}
