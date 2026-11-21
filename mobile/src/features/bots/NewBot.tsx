import { type Href, router, useLocalSearchParams } from "expo-router";
import { Bot as BotIcon, FileUp, Palette, Shuffle } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { type BotkinLook, cleanLook, lookOf, needsLooksV2, randomLook } from "@/data/botLook";
import { STARTERS } from "@/data/templates";
import { fromLine } from "@/features/market/agents/logic";
import type { BotInput, BotTemplate, ImportableAgent, MarketAgentTemplate } from "@/link/types";
import { pickTextFile, shareFrom } from "@/state/files";
import { useCan, useCapability, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { BotAvatar, Button, Chip, EmptyState, Field, HoldMenu, Label, Sheet, space, T } from "@/ui";
import { LookEditor, useLooksV2 } from "./LookEditor";
import { LookStage } from "./LookStage";
import { addable } from "./agents";
import { counter, LIMITS } from "./limits";

type Start = { key: string; name: string; role: string; instructions: string; summary?: string; look?: BotkinLook; face: string; avatar?: BotInput["avatar"]; /** An agent the person already has: the bot is made from it. */ agent?: ImportableAgent };

const starterStart = (starter: (typeof STARTERS)[number]): Start => ({ key: "starter:" + starter.name, name: starter.name, role: starter.role, instructions: starter.instructions, look: starter.look, face: starter.face, avatar: starter.avatar });
const savedStart = (template: BotTemplate): Start => ({
  key: "saved:" + template.id,
  name: template.name,
  role: template.role,
  instructions: template.instructions,
  summary: template.summary || undefined,
  look: lookOf(template),
  face: "idle",
  avatar: template.avatar,
});
/** A template from Marketplace › Agents (docs/agent-templates.md). */
const marketStart = (template: MarketAgentTemplate): Start => ({
  key: "market:" + template.id,
  name: template.name,
  role: template.role,
  instructions: template.instructions,
  summary: template.summary || undefined,
  look: template.look ? cleanLook(lookOf({ id: template.id, look: template.look })) : undefined,
  face: "idle",
});
const agentStart = (agent: ImportableAgent): Start => ({ key: "agent:" + agent.key, name: agent.name, role: agent.role, instructions: agent.instructions, summary: agent.summary || undefined, face: "idle", agent });

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

function renameTemplate(template: BotTemplate) {
  Alert.prompt(
    "Rename template",
    undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Rename",
        onPress: (value?: string) => {
          const name = value?.trim().slice(0, LIMITS.name);
          if (name && name !== template.name) void attempt(api.renameTemplate(template.id, name));
        },
      },
    ],
    "plain-text",
    template.name,
  );
}

/** Makes a bot: a look, a name, a role, a line about it and what it should do. */
export default function NewBot() {
  if (!useCan("agents", "create")) return <Sheet title="New bot"><EmptyState title="Your team role can't create bots" /></Sheet>;
  return <NewBotEditor />;
}

function NewBotEditor() {
  const canManage = useCan("agents", "manage");
  const saved = usePart("templates");
  const advanced = useLooksV2();
  const [look, setLook] = useState<BotkinLook>(() => randomLook());
  const [customizing, setCustomizing] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [summary, setSummary] = useState("");
  const [instructions, setInstructions] = useState("");
  const [start, setStart] = useState<Start | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Agents the person already has in a provider's own tool. The row is simply missing when the lookup fails.
  const [agents, setAgents] = useState<ImportableAgent[]>([]);
  useEffect(() => {
    api.importableAgents().then(setAgents, () => {});
  }, []);
  const providers = [...new Set(agents.map((agent) => agent.providerName))];
  // Install on a template in Marketplace › Agents opens this sheet with its id. Until it arrives, the fields stay as they are.
  const { template } = useLocalSearchParams<{ template?: string }>();
  const [market, setMarket] = useState<MarketAgentTemplate>();
  useEffect(() => {
    if (!template) return;
    let live = true;
    void attempt(api["agents.template"](template)).then((found) => {
      if (!live || !found) return;
      setMarket(found);
      pick(marketStart(found));
    });
    return () => {
      live = false;
    };
  }, [template]);
  const marketNote = market && start?.key === "market:" + market.id ? fromLine(market) : undefined;

  const pick = (next: Start) => {
    if (next.agent?.problem) return showToast(next.agent.problem, "error");
    // A name the person typed stays; one the last template filled in follows the new one. An agent brings its own.
    if (next.agent || !name.trim() || name === start?.name) setName(next.name);
    setRole(next.role);
    setSummary(next.summary ?? "");
    setInstructions(next.instructions);
    if (next.look) setLook(next.look);
    setStart(next);
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

  const ready = !!name.trim() && !busy;
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
      const bot: BotInput = { name: fields.name, role: fields.role, instructions: fields.instructions, face: start?.face ?? "idle", ...(start?.avatar && { avatar: start.avatar }), ...(fields.summary && { summary: fields.summary }) };
      id = await attempt(api.addBot(bot));
    }
    if (id) {
      // An older computer can't save eyes or custom colors; it keeps the character and palette.
      const keep = !advanced && needsLooksV2(look) ? { head: look.head, palette: look.palette === "custom" ? "original" : look.palette } : look;
      if (canManage) await attempt(api["link.setLook"](id, cleanLook(keep)));
      router.replace({ pathname: "/bot/[id]", params: { id } });
    }
    setBusy(false);
  };

  const agent = start?.agent;
  return (
    <Sheet title="New bot" action="Create" onAction={() => void create()} actionDisabled={!ready} actionLoading={busy}>
      <LookStage look={look} size={120}>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button title="Shuffle" icon={Shuffle} variant="secondary" size="sm" onPress={() => setLook(randomLook({ advanced }))} />
          <Button title={customizing ? "Done" : "Customize"} icon={Palette} variant="secondary" size="sm" onPress={() => setCustomizing(!customizing)} accessibilityLabel={customizing ? "Hide look options" : "Customize look"} />
        </View>
      </LookStage>

      {customizing && (
        <Animated.View entering={FadeIn.duration(200)}>
          <LookEditor value={look} onChange={setLook} advanced={advanced} />
        </Animated.View>
      )}

      <StartRow label="Start from">
        {STARTERS.map(starterStart).map((item) => (
          <Chip key={item.key} label={item.name} selected={start?.key === item.key} onPress={() => pick(item)} leading={item.look ? <BotAvatar look={item.look} size={22} /> : undefined} />
        ))}
      </StartRow>

      {(!!saved?.length || canFiles) && (
        <StartRow label="Your templates">
          {(saved ?? []).map((template) => {
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
                  if (nativeEvent.event === "rename") renameTemplate(template);
                  else if (nativeEvent.event === "export") void shareFrom(api.exportTemplateText({ templateId: template.id }), "Template exported. Anyone with Botkins can import it.");
                  else if (nativeEvent.event === "delete") {
                    if (start?.key === item.key) setStart(undefined);
                    void attempt(api.deleteTemplate(template.id), "Template deleted");
                  }
                }}
              >
                <Chip label={item.name} selected={start?.key === item.key} onPress={() => pick(item)} leading={item.look ? <BotAvatar look={item.look} size={22} /> : undefined} />
              </HoldMenu>
            );
          })}
          {canFiles && <Chip label="Import…" icon={FileUp} onPress={() => void importOne()} />}
        </StartRow>
      )}

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

      {!!marketNote && (
        <T variant="footnote" color="muted">
          {marketNote}
        </T>
      )}

      {agent && (
        <T variant="footnote" color="muted">
          {"Copied from your " + agent.providerName + " agent " + agent.agent + ". Changes here don't change that agent." + (agent.missingModel ? " Its model, " + agent.missingModel + ", isn't on your account, so the bot uses your default model." : "")}
        </T>
      )}

      <View style={{ gap: space.lg }}>
        <Field label="Name" placeholder="Mira" value={name} onChangeText={setName} maxLength={LIMITS.name} autoCapitalize="words" returnKeyType="next" />
        <Field label="Role" placeholder="Writing partner" value={role} onChangeText={setRole} maxLength={LIMITS.role} />
        <Field label="About" placeholder="A line about what this bot is for" value={summary} onChangeText={setSummary} maxLength={LIMITS.summary} hint="Optional" />
        <Field label="Instructions" placeholder="What should it do, and how?" value={instructions} onChangeText={setInstructions} maxLength={LIMITS.instructions} area hint={counter(instructions, LIMITS.instructions)} style={{ minHeight: 140 }} />
      </View>
    </Sheet>
  );
}
