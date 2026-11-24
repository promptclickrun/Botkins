// A template's page: a wash from its look with its Botkin, name, role and summary and Add (which opens
// New bot filled in from it, docs/agent-templates.md), then what you get, what works on day one, what
// it asks first, a suggested pairing, and the instructions as they will be given.
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { Bot } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { MarketAgentTemplate } from "@/link/types";
import { useCan, useCapability, useOnline } from "@/state/hooks";
import { api } from "@/state/link";
import { BotAvatar, Button, EmptyState, Group, Label, Loading, Page, radius, Row, space, T } from "@/ui";
import { useBotWash } from "../art";
import { AGENTS_CAPABILITY, pageLine, pairingTitle, tooLong } from "./logic";
import { sentence } from "../catalog";

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

  return <Template template={template} online={online} />;
}

/** The big art band: how tall it is and how big its Botkin. */
const HERO = { avatar: 120, padding: space.xl } as const;
/** How many lines of the instructions show before "Show all". */
const INSTRUCTION_LINES = 4;

function Template({ template, online }: { template: MarketAgentTemplate; online: boolean }) {
  const stops = useBotWash(template.look, template.id);
  const [open, setOpen] = useState(false);
  const line = pageLine(template);
  const long = tooLong(template.instructions ?? "", INSTRUCTION_LINES);
  return (
    <Page>
      <LinearGradient colors={stops} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: radius.xl, padding: HERO.padding, alignItems: "center", gap: space.sm }}>
        <BotAvatar bot={{ id: template.id, look: template.look }} size={HERO.avatar} />
        <T variant="title1" center accessibilityRole="header">
          {template.name}
        </T>
        {!!template.role && template.role.trim().toLowerCase() !== template.name.trim().toLowerCase() && (
          <T variant="callout" weight="600" color="ink2" center>
            {template.role}
          </T>
        )}
        {!!template.summary && (
          <T variant="subhead" color="ink2" center>
            {template.summary}
          </T>
        )}
        {!!line && (
          <T variant="footnote" color="muted" center>
            {line}
          </T>
        )}
        <Button title="Add" wide disabled={!online} accessibilityLabel={"Add " + template.name} onPress={() => router.push({ pathname: "/bot/new", params: { template: template.id } })} style={{ marginTop: space.sm }} />
      </LinearGradient>
      {(!!template.deliverable || !!template.dayOne || !!template.approval) && (
        <Group>
          {!!template.deliverable && <Row title="What you get" subtitle={sentence(template.deliverable)} subtitleLines={4} />}
          {!!template.dayOne && <Row title="Works on day one" subtitle={template.dayOne} subtitleLines={6} />}
          {!!template.approval && <Row title="Asks first" subtitle={template.approval} subtitleLines={6} />}
        </Group>
      )}
      {!!template.pairing && (
        <View>
          <Label>Suggested pairing</Label>
          <Group>
            <Row title={pairingTitle(template.pairing)} subtitle={template.pairing.note || undefined} subtitleLines={6} />
          </Group>
        </View>
      )}
      {!!template.instructions && (
        <View>
          <Label>Instructions</Label>
          <Group>
            <T variant="subhead" color="ink2" selectable numberOfLines={open ? undefined : INSTRUCTION_LINES} style={{ padding: space.lg, paddingBottom: long ? space.sm : space.lg }}>
              {template.instructions}
            </T>
            {long && <Row title={open ? "Show less" : "Show all"} tone="accent" onPress={() => setOpen((was) => !was)} />}
          </Group>
        </View>
      )}
    </Page>
  );
}
