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
import { harnessChoices, piAction } from "./harnessChoices";
import { ChoiceRow } from "./shared";

export { HARNESSES, harnessName } from "./harnessChoices";

/** Settings › Harness: what runs a bot's turn around the model. The choice is the computer's. */
export default function HarnessSettings() {
  const settings = useSettings();
  const shown = useOnShow();
  const revision = useApp((state) => state.parts.revs?.providers);
  const capable = useCapability(SIGNIN_CAPABILITY);
  const [pi, setPi] = useState<HarnessStatus>();
  // Asked again when the screen shows, after an install, and when the computer's providers change.
  useEffect(() => {
    if (!shown) return;
    let live = true;
    api
      .harnesses()
      .then((list) => live && setPi(list.find((item) => item.id === "pi")))
      .catch(() => live && setPi(undefined));
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
  const action = piAction(pi, capable);
  return (
    <Page title="Harness">
      <View>
        <Label>What runs your bots</Label>
        <Group>
          {harnessChoices(settings.harness, pi).map((harness) => (
            <ChoiceRow
              key={harness.value}
              title={harness.title}
              subtitle={harness.value === "pi" && pi && !pi.installed ? "Not installed on your computer" : harness.subtitle}
              selected={settings.harness === harness.value}
              warning={harness.value === "pi" && settings.harness === "pi" && !!pi && !pi.installed}
              onPress={() => settings.harness !== harness.value && void attempt(api.setPreferences({ harness: harness.value }))}
            />
          ))}
        </Group>
        <T variant="footnote" color="muted" style={{ marginTop: 8, paddingHorizontal: 4 }}>
          A chat keeps its conversation when you switch. Its next reply starts on the other harness.
        </T>
      </View>
      {pi && (
        <View>
          <Label>Pi</Label>
          {pi.installed ? (
            <Group>
              <Row title="Installed on your computer" value={pi.version} />
            </Group>
          ) : (
            <View style={{ gap: 8 }}>
              <T variant="footnote" color="muted" style={{ paddingHorizontal: 4 }}>
                {pi.message || "Pi isn't on your computer yet."}
              </T>
              {action === "install" && (
                <Button
                  title="Install Pi on your computer"
                  icon={Download}
                  size="lg"
                  wide
                  onPress={() => router.push({ pathname: "/models/signin", params: { id: pi.id, mode: "install", label: pi.name } })}
                />
              )}
              {action === "guide" && <Button title="Install guide" icon={ExternalLink} variant="secondary" size="sm" onPress={() => void WebBrowser.openBrowserAsync(pi.install!.url)} />}
            </View>
          )}
        </View>
      )}
    </Page>
  );
}
