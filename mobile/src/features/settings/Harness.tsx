import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Download, ExternalLink } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { SIGNIN_CAPABILITY } from "@/features/models/signin";
import type { HarnessStatus } from "@/link/types";
import { useCapability, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Button, EmptyState, Group, Label, Loading, Page, Row, T, useOnShow } from "@/ui";
import { harnessChoices, programAction } from "./harnessChoices";
import { ChoiceRow, useHeld } from "./shared";

export { HARNESSES, harnessName } from "./harnessChoices";

/** Settings › Harness: what runs a bot's turn around the model. The choice is the computer's. */
export default function HarnessSettings() {
  const settings = useSettings();
  const shown = useOnShow();
  const revision = useApp((state) => state.parts.revs?.providers);
  const capable = useCapability(SIGNIN_CAPABILITY);
  const [cache, holdCache] = useHeld(settings && { longPromptCache: settings.longPromptCache });
  const [programs, setPrograms] = useState<HarnessStatus[]>([]);
  // Asked again when the screen shows, after an install, and when the computer's providers change.
  useEffect(() => {
    if (!shown) return;
    let live = true;
    api
      .harnesses()
      .then((list) => live && setPrograms(list))
      .catch(() => live && setPrograms([]));
    return () => {
      live = false;
    };
  }, [shown, revision]);
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
  const programOf = (id: string) => programs.find((program) => program.id === id);
  const selectedProgram = settings.harness ? programOf(settings.harness) : undefined;
  return (
    <Page title="Harness">
      <View>
        <Label>What runs your bots</Label>
        <Group>
          {harnessChoices(settings.harness, programs).map((harness) => (
            <ChoiceRow
              key={harness.value}
              title={harness.title}
              subtitle={programOf(harness.value) && !programOf(harness.value)?.installed ? "Not installed on your computer" : harness.subtitle}
              selected={settings.harness === harness.value}
              warning={settings.harness === harness.value && !!selectedProgram && !selectedProgram.installed}
              onPress={() => settings.harness !== harness.value && void attempt(api.setPreferences({ harness: harness.value }))}
            />
          ))}
        </Group>
        <T variant="footnote" color="muted" style={{ marginTop: 8, paddingHorizontal: 4 }}>
          A chat keeps its conversation when you switch. Its next reply starts on the other harness.
        </T>
      </View>
      <View>
        <Group>
          <Row
            title="Keep prompt cache longer"
            toggled={cache?.longPromptCache ?? true}
            onToggle={(longPromptCache) => void holdCache({ longPromptCache }, () => api.setPreferences({ longPromptCache }))}
          />
        </Group>
        <T variant="footnote" color="muted" style={{ marginTop: 8, paddingHorizontal: 4 }}>
          With Pi or OMP, keeps a chat's prompt cache for about an hour instead of five minutes where the provider supports it (GitHub Copilot's models do), so a chat you come back to after a break still starts from cache. A plan isn't billed by the token, so this costs nothing extra.
        </T>
      </View>
      {programs.map((program) => {
        const action = programAction(program, capable);
        return (
          <View key={program.id}>
            <Label>{program.name}</Label>
            {program.installed ? (
              <Group>
                <Row title="Installed on your computer" value={program.version} />
              </Group>
            ) : (
              <View style={{ gap: 8 }}>
                <T variant="footnote" color="muted" style={{ paddingHorizontal: 4 }}>
                  {program.message || program.name + " isn't on your computer yet."}
                </T>
                {action === "install" && (
                  <Button
                    title={"Install " + program.name + " on your computer"}
                    icon={Download}
                    size="lg"
                    wide
                    onPress={() => router.push({ pathname: "/models/signin", params: { id: program.id, mode: "install", label: program.name } })}
                  />
                )}
                {action === "guide" && (
                  <Button title="Install guide" icon={ExternalLink} variant="secondary" size="sm" onPress={() => void WebBrowser.openBrowserAsync(program.install!.url)} />
                )}
              </View>
            )}
          </View>
        );
      })}
    </Page>
  );
}
