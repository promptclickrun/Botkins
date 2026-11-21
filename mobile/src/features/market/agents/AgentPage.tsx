// A template's page: its Botkin, name, role and summary, where it is from, the instructions as they
// will be given, and Install, which opens New bot filled in from it (docs/agent-templates.md).
import { router, useLocalSearchParams } from "expo-router";
import { Bot } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { MarketAgentTemplate } from "@/link/types";
import { useCan, useCapability, useOnline } from "@/state/hooks";
import { api } from "@/state/link";
import { BotAvatar, Button, EmptyState, Group, Label, Loading, Page, space, T } from "@/ui";
import { AGENTS_CAPABILITY, pageLine } from "./logic";

type Loaded = { id: string; template?: MarketAgentTemplate; error?: string };

export default function AgentPage() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const ready = useCapability(AGENTS_CAPABILITY);
  const allowed = useCan("agents", "create");
  const online = useOnline();
  const [loaded, setLoaded] = useState<Loaded>();
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!id || !ready || !allowed || !online) return;
    let live = true;
    api["agents.template"](id).then(
      (template) => live && setLoaded({ id, template }),
      (error: unknown) => live && setLoaded({ id, error: error instanceof Error ? error.message : "This template couldn't be read." }),
    );
    return () => {
      live = false;
    };
  }, [id, ready, allowed, online, tries]);

  if (!id || !ready || !allowed) return <Page title="Agent">{!allowed ? <EmptyState icon={Bot} title="Your team role can't create bots" /> : !ready ? <EmptyState icon={Bot} title="Update the app on your computer" /> : <EmptyState icon={Bot} title="This template is gone" />}</Page>;
  const shown = loaded?.id === id ? loaded : undefined;
  const template = shown?.template;
  if (!template)
    return <Page title="Agent">{shown?.error ? <EmptyState icon={Bot} title="This template couldn't be read" text={shown.error} action="Try again" onAction={() => setTries((n) => n + 1)} /> : <Loading />}</Page>;

  const line = pageLine(template);
  return (
    <Page>
      <View style={{ alignItems: "center", gap: space.sm }}>
        <BotAvatar bot={{ id: template.id, look: template.look }} size={128} />
        <T variant="title1" center accessibilityRole="header">
          {template.name}
        </T>
        {!!template.role && (
          <T variant="callout" weight="600" color="ink2" center>
            {template.role}
          </T>
        )}
        {!!template.summary && (
          <T variant="body" center>
            {template.summary}
          </T>
        )}
        {!!line && (
          <T variant="footnote" color="muted" center>
            {line}
          </T>
        )}
      </View>
      <Button title="Install" wide disabled={!online} onPress={() => router.push({ pathname: "/bot/new", params: { template: template.id } })} />
      {!!template.instructions && (
        <View>
          <Label>Instructions</Label>
          <Group>
            <T variant="subhead" color="ink2" selectable style={{ padding: space.lg }}>
              {template.instructions}
            </T>
          </Group>
        </View>
      )}
    </Page>
  );
}
