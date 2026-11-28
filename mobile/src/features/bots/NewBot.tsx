import { type Href, router, useLocalSearchParams } from "expo-router";
import { Bot as BotIcon, FileUp, LayoutTemplate, Palette, Shuffle } from "lucide-react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { type BotkinLook, cleanLook, lookForHost, lookOf, randomLook } from "@/data/botLook";
import { MarketTemplates } from "./MarketTemplates";
import { TemplateBundle } from "./TemplateBundle";
import { AGENT_TEMPLATE_BUNDLES, fromLine } from "@/features/market/agents/logic";
import type { BotInput, BotTemplate, ImportableAgent, MarketAgentTemplate } from "@/link/types";
import { pickTextFile, shareFrom } from "@/state/files";
import { useCan, useCapability, usePart } from "@/state/hooks";
import { readAgentTemplate } from "@/features/market/agents/calls";
import { api, attempt } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { BotAvatar, Button, Chip, EmptyState, Field, Group, HoldMenu, Label, Row, Sheet, space, T, type TextPromptOptions, useTextPrompt } from "@/ui";
import { LookEditor, useLookOptions } from "./LookEditor";
import { LookStage } from "./LookStage";
import { addable } from "./agents";
import { counter, LIMITS } from "./limits";
import { type Starter, starterById, STARTERS } from "../../../link-host/starters.mjs";
import { PROACTIVE_TEAM } from "./proactive";

type Start = { key: string; name: string; role: string; instructions: string; summary?: string; look?: BotkinLook; avatar?: BotInput["avatar"]; bundle?: BotInput["bundle"]; note?: string; /** An agent the person already has: the bot is made from it. */ agent?: ImportableAgent; /** One of the three starters (link-host/starters.mjs). */ starter?: string };

/** One of the starters, the same three the computer offers. */
const starterStart = (starter: Starter): Start => ({
  key: "starter:" + starter.id,
  name: starter.name,
  role: starter.role,
  instructions: starter.instructions,
  summary: starter.summary,
  look: { ...starter.look },
  starter: starter.id,
});

const savedStart = (template: BotTemplate): Start => ({
  key: "saved:" + template.id,
  name: template.name,
  role: template.role,
  instructions: template.instructions,
  summary: template.summary || undefined,
  look: lookOf(template),
  avatar: template.avatar,
  bundle: template.bundle,
  note: template.source === "imported" ? "Imported from a file. Someone else wrote these instructions: read them first." : undefined,
});
/** A template from Marketplace › Agents (docs/agent-templates.md). */
const marketStart = (template: MarketAgentTemplate): Start => ({
  key: "market:" + template.id,
  bundle: template.bundle,
  note: fromLine(template),
  name: template.name,
  role: template.role,
  instructions: template.instructions,
  summary: template.summary || undefined,
  look: template.look ? cleanLook(lookOf({ id: template.id, look: template.look })) : undefined,
});
const agentStart = (agent: ImportableAgent): Start => ({ key: "agent:" + agent.key, name: agent.name, role: agent.role, instructions: agent.instructions, summary: agent.summary || undefined, agent });

/** A row of chips under a small heading. */
function StartRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View>
      <Label>{label}</Label>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
        {children}
      </ScrollView>
    </View>
  );
}

function renameTemplate(template: BotTemplate, ask: (options: TextPromptOptions) => void) {
  ask({
    title: "Rename template",
    value: template.name,
    confirm: "Rename",
    onSubmit: (value) => {
      const name = value.slice(0, LIMITS.name);
      if (name !== template.name) void attempt(api.renameTemplate(template.id, name));
    },
  });
}

/** Makes a bot: a look, a name, a role, a line about it and what it should do. */
export default function NewBot() {
  if (!useCan("agents", "create")) return <Sheet title="New bot"><EmptyState title="Your team role can't create bots" /></Sheet>;
  return <NewBotEditor />;
}

function NewBotEditor() {
  const canManage = useCan("agents", "manage");
  const teams = useCapability(PROACTIVE_TEAM);
  const bundlesSupported = useCapability(AGENT_TEMPLATE_BUNDLES);
  const saved = usePart("templates");
  const unified = useApp((s) => s.unified);
  const unifiedHosts = useApp((s) => s.unifiedHosts);
  const primaryId = useApp((s) => s.pairing?.serverId ?? null);
  const includedHosts = unifiedHosts.filter((h) => h.included);
  const [targetHost, setTargetHost] = useState<string | null>(() => primaryId ?? includedHosts[0]?.id ?? null);
  const [picker, setPicker] = useState<"templates" | "import">();
  const options = useLookOptions();
  const prompt = useTextPrompt();
  const [look, setLook] = useState<BotkinLook>(() => randomLook({ capabilities: options.capabilities }));
  const [customizing, setCustomizing] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [summary, setSummary] = useState("");
  const [instructions, setInstructions] = useState("");
  const [start, setStart] = useState<Start | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // A failed provider lookup still leaves file import available.
  const [agents, setAgents] = useState<ImportableAgent[]>([]);
  useEffect(() => {
    api.importableAgents().then(setAgents, () => {});
  }, []);
  const providers = [...new Set(agents.map((agent) => agent.providerName))];
  // Install on a template in Marketplace › Agents opens this sheet with its id. Until it arrives, the fields stay as they are.
  const { template, starter } = useLocalSearchParams<{ template?: string; /** A starter's id, from Home's first-run list. */ starter?: string }>();
  const selection = useRef(0);
  useEffect(() => {
    if (!template) return;
    let live = true;
    const initial = selection.current;
    void attempt(readAgentTemplate(template, bundlesSupported)).then((found) => {
      if (!live || !found || selection.current !== initial) return;
      pick(marketStart(found));
    });
    return () => {
      live = false;
    };
  }, [template, bundlesSupported]);
  useEffect(() => {
    const chosen = starterById(starter);
    if (chosen) pick(starterStart(chosen));
  }, [starter]);

  const pick = (next: Start) => {
    if (next.agent?.problem) return showToast(next.agent.problem, "error");
    selection.current++;
    // A name the person typed stays; one the last template filled in follows the new one. An agent brings its own.
    if (next.agent || !name.trim() || name === start?.name) setName(next.name);
    setRole(next.role);
    setSummary(next.summary ?? "");
    setInstructions(next.instructions);
    if (next.look) setLook(lookForHost(next.look, next.key, options));
    setStart(next);
    setPicker(undefined);
  };

  // "Import…": a template file someone shared. The computer makes the template; when it arrives it is chosen, as on the computer.
  const canFiles = useCapability("files-v1");
  const importOne = async () => {
    const file = await pickTextFile().catch((error: unknown) => void showToast(error instanceof Error ? error.message : "Couldn't open that.", "error"));
    const id = file && (await attempt(api.importTemplateText(file)));
    if (!id) return;
    // The template comes back through the link a moment after the call answers.
    for (let tries = 0; tries < 30; tries++) {
      const template = useApp.getState().parts.templates?.find((item) => item.id === id);
      if (template) return pick(savedStart(template));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const ready = !!name.trim() && !busy && (!start?.bundle || bundlesSupported);
  const create = async () => {
    if (!ready) return;
    setBusy(true);
    const fields = { name: name.trim(), role: role.trim(), summary: summary.trim(), instructions: instructions.trim() };
    let id: string | undefined;
    const agent = start?.agent;
    if (agent) {
      // The bot is made from the agent, then gets what the person changed here. The agent itself stays as it is.
      id = (await attempt(api.importAgents([agent.key])))?.[0];
      const patch: Partial<typeof fields> = {};
      if (fields.name !== agent.name) patch.name = fields.name;
      if (fields.role !== agent.role) patch.role = fields.role;
      if (fields.summary !== agent.summary.trim()) patch.summary = fields.summary;
      if (fields.instructions !== agent.instructions.trim()) patch.instructions = fields.instructions;
      if (id && canManage && Object.keys(patch).length) await attempt(api.updateBot(id, patch));
    } else {
      const bot: BotInput = {
        name: fields.name,
        role: fields.role,
        instructions: fields.instructions,
        face: "idle",
        ...(fields.summary && { summary: fields.summary }),
        ...(start?.avatar && { avatar: start.avatar }),
        ...(start?.starter && { starter: start.starter }),
        ...(start?.bundle && { bundle: start.bundle }),
        ...(unified && targetHost ? { hostId: targetHost } : {}),
      };
      id = await attempt(api.addBot(bot));
    }
    if (id) {
      const keep = lookForHost(look, id, options);
      if (canManage) await attempt(api["link.setLook"](id, cleanLook(keep)));
      router.replace({ pathname: "/bot/[id]", params: { id } });
      // Chief of Staff and Money manager suggest Proactive: its setup steps open over the new bot's page.
      if (start?.starter && starterById(start.starter)?.suggestProactive && teams && canManage) router.push(("/bot/" + encodeURIComponent(id) + "/proactive-setup") as Href);
    }
    setBusy(false);
  };

  if (picker === "templates") return (
    <Sheet title="Start from template" onClose={() => setPicker(undefined)}>
      {prompt.node}
      <View>
        <Label>Starters</Label>
        <Group>
          {STARTERS.map(starterStart).map((item) => (
            <Row key={item.key} title={item.name} subtitle={item.summary} subtitleLines={2} onPress={() => pick(item)} leading={<BotAvatar look={item.look} size={40} />} />
          ))}
        </Group>
      </View>
      <View>
        <Label>Marketplace</Label>
        <MarketTemplates pick={(template) => pick(marketStart(template))} />
      </View>
      <View>
        <Label>Your templates</Label>
        {saved?.length ? <Group>
          {saved.map((template) => {
            const item = savedStart(template);
            return (
              <HoldMenu
                key={item.key}
                title={template.name}
                actions={[
                  { id: "rename", title: "Rename…", image: "pencil" },
                  ...(canFiles ? [{ id: "export", title: "Export…", image: "square.and.arrow.up" }] : []),
                  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "rename") renameTemplate(template, prompt.ask);
                  else if (nativeEvent.event === "export") void shareFrom(api.exportTemplateText({ templateId: template.id }), "Template exported. Anyone with Botkins can import it.");
                  else if (nativeEvent.event === "delete") {
                    if (start?.key === item.key) setStart(undefined);
                    void attempt(api.deleteTemplate(template.id), "Template deleted");
                  }
                }}
              >
                <Row title={item.name} subtitle={[item.role, item.summary].filter(Boolean).join("\n")} subtitleLines={3} onPress={() => pick(item)} leading={<BotAvatar look={item.look} size={40} />} />
              </HoldMenu>
            );
          })}
        </Group> : <T variant="footnote" color="muted">No saved templates yet.</T>}
      </View>
    </Sheet>
  );
  if (picker === "import") return (
    <Sheet title="Import" onClose={() => setPicker(undefined)}>
      {canFiles && <Button title="Import from file…" icon={FileUp} variant="secondary" onPress={() => void importOne()} />}
      {providers.map((provider) => (
        <StartRow key={provider} label={"Your " + provider + " agents"}>
          {agents
            .filter((item) => item.providerName === provider)
            .map(agentStart)
            .map((item) => (
              <Chip key={item.key} label={item.agent?.added ? item.name + " · Already a bot" : item.name} selected={start?.key === item.key} onPress={() => pick(item)} icon={BotIcon} />
            ))}
          {addable(agents.filter((item) => item.providerName === provider)).length > 1 && <Chip label="Add several…" onPress={() => router.replace("/bot/agents" as Href)} />}
        </StartRow>
      ))}
      {!canFiles && !providers.length && <EmptyState title="No agents found" />}
    </Sheet>
  );

  const agent = start?.agent;
  return (
    <Sheet title="New bot" action="Create" onAction={() => void create()} actionDisabled={!ready} actionLoading={busy}>
      {prompt.node}
      <LookStage look={look} size={120}>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button title="Shuffle" icon={Shuffle} variant="secondary" size="sm" onPress={() => setLook(randomLook(options))} />
          <Button title={customizing ? "Done" : "Customize"} icon={Palette} variant="secondary" size="sm" onPress={() => setCustomizing(!customizing)} accessibilityLabel={customizing ? "Hide look options" : "Customize look"} />
        </View>
      </LookStage>

      {customizing && (
        <Animated.View entering={FadeIn.duration(200)}>
          <LookEditor value={look} onChange={setLook} {...options} />
        </Animated.View>
      )}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <Button title="Start from template" icon={LayoutTemplate} variant="secondary" size="sm" onPress={() => setPicker("templates")} />
        <Button title="Import" icon={FileUp} variant="secondary" size="sm" onPress={() => setPicker("import")} />
      </View>

      {!!start?.note && (
        <T variant="footnote" color="muted">
          {start.note}
        </T>
      )}

      {agent && (
        <T variant="footnote" color="muted">
          {"Copied from your " + agent.providerName + " agent " + agent.agent + ". Changes here don't change that agent." + (agent.missingModel ? " Its model, " + agent.missingModel + ", isn't on your account, so the bot uses your default model." : "")}
        </T>
      )}

      {unified && includedHosts.length > 1 && (
        <StartRow label="Computer">
          {includedHosts.map((host) => (
            <Chip
              key={host.id}
              label={host.name}
              selected={(targetHost ?? primaryId) === host.id}
              onPress={() => setTargetHost(host.id)}
            />
          ))}
        </StartRow>
      )}

      <View style={{ gap: space.lg }}>
        <Field label="Name" placeholder="Mira" value={name} onChangeText={setName} maxLength={LIMITS.name} autoCapitalize="words" returnKeyType="next" />
        <Field label="Role" placeholder="Writing partner" value={role} onChangeText={setRole} maxLength={LIMITS.role} />
        <Field label="About" placeholder="A line about what this bot is for" value={summary} onChangeText={setSummary} maxLength={LIMITS.summary} hint="Optional" />
        <Field label="Instructions" placeholder="What should it do, and how?" value={instructions} onChangeText={setInstructions} maxLength={LIMITS.instructions} area hint={counter(instructions, LIMITS.instructions)} style={{ minHeight: 140 }} />
      </View>
      <TemplateBundle bundle={start?.bundle} supported={bundlesSupported} />
    </Sheet>
  );
}
