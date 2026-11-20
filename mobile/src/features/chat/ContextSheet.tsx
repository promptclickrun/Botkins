// The chat's context window, opened from the meter in the chat's header: how full it is and what
// fills it, the replies' tokens, the model's window, what is loaded for the chat, and Compact. It
// shows what the desktop's panel shows (src/ContextDetails.tsx), plus what the phone also knows.
import { router, useLocalSearchParams } from "expo-router";
import { CircleHelp } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { Catalog } from "@/link/types";
import { useBot, useChat, useModels, usePart, useProviders, useSettings, useWatchedChat } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { effectiveModel, findModel, modelName } from "@/state/models";
import { useApp } from "@/state/store";
import { ago } from "@/state/time";
import { Button, EmptyState, Group, Label, Loading, ProviderIcon, radius, Row, Sheet, space, T, useTheme } from "@/ui";
import { defaultProviderOf } from "../models/shared";
import { chatRuns, contextParts, contextPercent, contextTone, type ContextPart, tokens, usageSummary } from "./contextMath";

type Tone = "info" | "warning" | "accent" | "faint";
const PART_TONE: Record<ContextPart["key"], Tone> = { system: "info", tools: "warning", conversation: "accent", other: "faint" };

/** What is loaded for the chat: its tools, skills and commands, and each tool server. */
function useLoaded(botId: string | undefined, chatId: string) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!botId) return;
    let live = true;
    api
      .catalog(botId, chatId)
      .then((value) => live && setCatalog(value))
      .catch((reason: unknown) => live && setError(reason instanceof Error ? reason.message : "Couldn't load what's in use."));
    return () => {
      live = false;
    };
  }, [botId, chatId]);
  return { catalog, error };
}

export default function ContextSheet() {
  const { id: chatId = "" } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const chat = useChat(chatId);
  const bot = useBot(chat?.botId);
  const view = useWatchedChat(chatId);
  const recent = usePart("runs");
  const live = usePart("live");
  // The chat's run part is also its newest turn when that ended without a reply: only a working one is running.
  const running = useApp((state) => state.running[chatId]?.status === "Working");
  const settings = useSettings();
  const models = useModels();
  const providers = useProviders();
  const loaded = useLoaded(chat?.botId, chatId);
  const [compacting, setCompacting] = useState(false);

  if (!chat)
    return (
      <Sheet title="Context">
        <EmptyState icon={CircleHelp} title="This chat is gone" action="Back" onAction={() => router.back()} />
      </Sheet>
    );

  const working = running || (!!live && chatId in live.streams);
  const context = chat.context && chat.context.limit > 0 ? chat.context : undefined;
  const choice = effectiveModel(settings, bot, chat);
  const model = models ? findModel(models, choice, defaultProviderOf(providers)) : undefined;
  const runs = chatRuns(chatId, recent, view?.runs);
  const usage = usageSummary(runs);
  const replyModel = usage.latest?.model ? (models?.find((m) => m.id === usage.latest!.model)?.name ?? usage.latest.model) : undefined;
  const colorOf = (tone: Tone) => (tone === "faint" ? colors.lineStrong : colors[tone]);

  const compact = async () => {
    setCompacting(true);
    const done = await attempt(api.compact(chatId).then(() => true), "Compacting");
    setCompacting(false);
    if (done) router.back();
  };

  const percent = context ? contextPercent(context) : 0;
  const { parts, free, known } = context ? contextParts(context) : { parts: [], free: 0, known: false };
  const tone = contextTone(percent);
  const choices = loaded.catalog?.choices ?? [];
  const count = (kind: "Tool" | "Skill" | "Command") => choices.filter((choice) => choice.kind === kind).length;

  return (
    <Sheet title="Context">
      {context ? (
        <View style={{ gap: space.md }}>
          <View style={{ gap: 2 }}>
            <T variant="display" color={tone === "success" ? "ink" : tone} accessibilityLabel={"Context " + percent + "% used"}>
              {percent + "%"}
            </T>
            <T variant="subhead" color="muted">
              {tokens(context.current) + " of " + tokens(context.limit) + " tokens" + (context.updatedAt ? " · measured " + (ago(context.updatedAt) === "now" ? "just now" : ago(context.updatedAt)) : "")}
            </T>
          </View>
          {/* The window as one bar: each known part, then what's free. */}
          <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ height: 12, borderRadius: radius.pill, backgroundColor: colors.sunken, overflow: "hidden", flexDirection: "row" }}>
            {known ? (
              parts.map((part) => <View key={part.key} style={{ width: (Math.min(part.value, context.limit) / context.limit) * 100 + "%", backgroundColor: colorOf(PART_TONE[part.key]) }} />)
            ) : (
              <View style={{ width: percent + "%", backgroundColor: colors[tone] }} />
            )}
          </View>
          <Group>
            {known ? (
              parts.map((part) => <Row key={part.key} title={part.label} value={tokens(part.value)} leading={<Swatch color={colorOf(PART_TONE[part.key])} />} />)
            ) : (
              <Row title="In use" value={tokens(context.current)} leading={<Swatch color={colors[tone]} />} />
            )}
            <Row title="Free" value={tokens(free)} leading={<Swatch color={colors.sunken} outline={colors.lineStrong} />} />
            {context.messages !== undefined && <Row title="Messages in context" value={String(context.messages)} />}
          </Group>
        </View>
      ) : (
        <T variant="subhead" color="muted">
          Not measured yet. It's measured after the next reply.
        </T>
      )}

      {model && (
        <View>
          <Label>Model</Label>
          <Group>
            <Row
              title={model.name}
              subtitle={model.providerName}
              leading={<ProviderIcon provider={model.provider} name={model.providerName} size={32} tile />}
              value={model.contextWindow ? tokens(model.contextWindow) + " window" : undefined}
              chevron
              onPress={() => router.push({ pathname: "/chat/model-info", params: { model: model.id, provider: model.provider ?? "" } })}
            />
          </Group>
        </View>
      )}
      {!model && !!choice && (
        <View>
          <Label>Model</Label>
          <Group>
            <Row title={modelName(choice, models)} leading={<ProviderIcon provider={choice.provider} size={32} tile />} />
          </Group>
        </View>
      )}

      {usage.latest && (
        <View>
          <Label>{"Latest reply" + (replyModel ? " · " + replyModel : "")}</Label>
          <Group>
            <Row title="Input" value={tokens(usage.latest.input)} />
            {usage.latest.cacheRead !== undefined && <Row title="Cached input" value={tokens(usage.latest.cacheRead)} />}
            <Row title="Output" value={tokens(usage.latest.output)} />
          </Group>
        </View>
      )}
      {usage.replies > 0 && (
        <View>
          <Label>{"This chat · " + usage.replies + (usage.replies === 1 ? " reply" : " replies")}</Label>
          <Group>
            <Row title="Input" value={tokens(usage.input)} />
            <Row title="Output" value={tokens(usage.output)} />
            {usage.cost > 0 && <Row title="Premium requests" value={usage.cost.toLocaleString(undefined, { maximumFractionDigits: 2 })} />}
          </Group>
        </View>
      )}

      {!!chat.botId && (
        <View>
          <Label>Loaded for this chat</Label>
          {loaded.catalog ? (
            <Group>
              <Row title="Tools" value={String(count("Tool"))} />
              <Row title="Skills" value={String(count("Skill"))} />
              <Row title="Commands" value={String(count("Command"))} />
              {loaded.catalog.servers.map((server) => (
                <Row key={server.name} title={server.name} subtitle="Tool server (MCP)" value={server.status} />
              ))}
            </Group>
          ) : loaded.error ? (
            <T variant="subhead" color="muted">
              {loaded.error}
            </T>
          ) : (
            <Loading />
          )}
        </View>
      )}

      <View style={{ gap: space.sm }}>
        <T variant="footnote" color="muted">
          Compact summarizes earlier turns to free room. The chat stays.
        </T>
        <Button title={working ? "Compact after this turn" : "Compact"} onPress={() => void compact()} loading={compacting} disabled={working || compacting} wide />
      </View>
    </Sheet>
  );
}

function Swatch({ color, outline }: { color: string; outline?: string }) {
  return <View style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: color, borderWidth: outline ? 1 : 0, borderColor: outline }} />;
}
