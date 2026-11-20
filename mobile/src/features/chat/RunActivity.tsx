import { useLocalSearchParams } from "expo-router";
import { Ban, Brain, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, CircleX, MessageCircle } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Run, Step, TeamAsk, Todo } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { useBots, useModels, useWatchedChat } from "@/state/hooks";
import { modelName } from "@/state/models";
import { useApp } from "@/state/store";
import { compactNumber, duration } from "@/state/time";
import { Badge, Button, EmptyState, Group, Label, radius, Row, Sheet, space, T, Tap, type Tone, useTheme } from "@/ui";
import { StepMark } from "./bits";

const STATUS_TONE: Record<string, Tone> = { Working: "accent", Completed: "success", "Needs you": "danger", Stopped: "neutral", Interrupted: "warning" };

function Mono({ label, text }: { label: string; text: string }) {
  const { colors, type } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <T variant="caption" color="muted">
        {label}
      </T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: colors.sunken, borderRadius: radius.sm }} contentContainerStyle={{ padding: space.md }}>
        <Text selectable maxFontSizeMultiplier={1.3} style={[type.mono, { color: colors.ink }]}>
          {text.length > 6000 ? text.slice(0, 6000) + "\n…" : text}
        </Text>
      </ScrollView>
    </View>
  );
}

function StepRow({ step }: { step: Step }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const more = !!step.input || !!step.output;
  const took = step.finished ? duration(step.finished - step.started) : undefined;
  const head = (
    <View style={{ minHeight: 52, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
      <StepMark status={step.status} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="callout" weight="500" numberOfLines={open ? undefined : 2}>
          {step.label || step.name}
        </T>
        {!!step.progress && step.status === "Running" && (
          <T variant="footnote" color="muted" numberOfLines={1}>
            {step.progress}
          </T>
        )}
      </View>
      {!!took && (
        <T variant="footnote" color="faint">
          {took}
        </T>
      )}
      {more && (open ? <ChevronDown size={16} color={colors.faint} strokeWidth={2.4} /> : <ChevronRight size={16} color={colors.faint} strokeWidth={2.4} />)}
    </View>
  );
  if (!more) return head;
  return (
    <View>
      <Tap onPress={() => setOpen(!open)} sink={1} feel="select" hitSlop={0} accessibilityLabel={(step.label || step.name) + ", " + step.status} accessibilityState={{ expanded: open }}>
        {head}
      </Tap>
      {open && (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md }}>
          {!!step.input && <Mono label="Input" text={step.input} />}
          {!!step.output && <Mono label="Output" text={step.output} />}
        </View>
      )}
    </View>
  );
}

function Reasoning({ run, startOpen }: { run: Run; startOpen: boolean }) {
  const { colors, type } = useTheme();
  const [open, setOpen] = useState(startOpen);
  const text = (run.reasoning ?? []).map((part) => part.text.trim()).filter(Boolean).join("\n\n");
  if (!text) return null;
  return (
    <Group>
      <Tap onPress={() => setOpen(!open)} sink={1} feel="select" hitSlop={0} accessibilityLabel={open ? "Hide thinking" : "Show thinking"} accessibilityState={{ expanded: open }}>
        <View style={{ minHeight: 52, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Brain size={18} color={colors.muted} strokeWidth={2.2} />
          <T variant="callout" weight="500" style={{ flex: 1 }}>
            Thinking
          </T>
          {open ? <ChevronDown size={16} color={colors.faint} strokeWidth={2.4} /> : <ChevronRight size={16} color={colors.faint} strokeWidth={2.4} />}
        </View>
      </Tap>
      {open && (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}>
          <Text selectable maxFontSizeMultiplier={1.35} style={[type.subhead, { color: colors.muted, fontStyle: "italic" }]}>
            {text}
          </Text>
        </View>
      )}
    </Group>
  );
}

function TodoMark({ status }: { status: Todo["status"] }) {
  const { colors } = useTheme();
  if (status === "done") return <CircleCheck size={20} color={colors.success} strokeWidth={2.2} />;
  if (status === "in_progress") return <CircleDashed size={20} color={colors.accent} strokeWidth={2.2} />;
  if (status === "blocked") return <CircleX size={20} color={colors.warning} strokeWidth={2.2} />;
  if (status === "cancelled") return <Ban size={20} color={colors.faint} strokeWidth={2.2} />;
  return <Circle size={20} color={colors.faint} strokeWidth={2.2} />;
}

const TEAM_TONE: Record<TeamAsk["status"], Tone> = { waiting: "neutral", working: "accent", answered: "success", failed: "danger", stopped: "neutral" };

export default function RunActivity() {
  const { colors } = useTheme();
  const { chatId, runId } = useLocalSearchParams<{ chatId: string; runId: string }>();
  useWatchedChat(chatId);
  const saved = useApp((state) => state.chats[chatId]?.runs[runId]);
  const running = useApp((state) => state.running[chatId]);
  const run = running?.id === runId ? running : saved;
  const allBots = useBots();
  const models = useModels();
  const stepsMode = useChatPrefs((prefs) => prefs.steps);
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const [allSteps, setAllSteps] = useState(false);

  if (!run)
    return (
      <Sheet title="Activity">
        <EmptyState icon={CircleDashed} title="Nothing to show" />
      </Sheet>
    );

  const botName = (id: string) => allBots.find((bot) => bot.id === id)?.name ?? "a bot";
  const took = run.finished ? duration(run.finished - run.time) : run.usage?.durationMs ? duration(run.usage.durationMs) : undefined;
  const model = run.usage?.model ?? (run.model ? modelName(run.model, models) : undefined);
  const facts = [took, model, run.usage ? compactNumber(run.usage.input) + " in · " + compactNumber(run.usage.output) + " out" : undefined].filter(Boolean).join(" · ");
  const everyStep = run.steps ?? [];
  // "Failed only" narrows the list to what went wrong; the rest is a tap away.
  const onlyFailed = stepsMode === "failed" && !allSteps && everyStep.some((step) => step.status === "Failed");
  const steps = onlyFailed ? everyStep.filter((step) => step.status === "Failed") : everyStep;

  return (
    <Sheet title="Activity">
      <View style={{ gap: space.sm }}>
        <T variant="title3" numberOfLines={3}>
          {run.title}
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={run.status} tone={STATUS_TONE[run.status] ?? "neutral"} />
          {!!facts && (
            <T variant="footnote" color="muted" numberOfLines={2} style={{ flexShrink: 1 }}>
              {facts}
            </T>
          )}
        </View>
        {run.status === "Needs you" && !!run.detail && (
          <T variant="footnote" color="danger">
            {run.detail}
          </T>
        )}
      </View>

      {steps.length > 0 && (
        <View>
          <Label>{onlyFailed ? (steps.length === 1 ? "1 failed step" : steps.length + " failed steps") : steps.length === 1 ? "1 step" : steps.length + " steps"}</Label>
          <Group>
            {steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </Group>
          {onlyFailed && <Button title={"Show all " + everyStep.length + " steps"} variant="ghost" size="sm" wide onPress={() => setAllSteps(true)} style={{ marginTop: space.xs }} />}
        </View>
      )}

      {thinkingMode !== "hide" && <Reasoning run={run} startOpen={thinkingMode === "show"} />}

      {!!run.todos?.length && (
        <View>
          <Label>To do</Label>
          <Group>
            {run.todos.map((todo) => (
              <View key={todo.id} style={{ minHeight: 48, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }} accessibilityLabel={todo.title + ", " + todo.status.replace("_", " ")}>
                <TodoMark status={todo.status} />
                <T variant="callout" color={todo.status === "done" || todo.status === "cancelled" ? "muted" : "ink"} style={{ flex: 1, textDecorationLine: todo.status === "cancelled" ? "line-through" : "none" }}>
                  {todo.title}
                </T>
              </View>
            ))}
          </Group>
        </View>
      )}

      {!!run.teamwork?.length && (
        <View>
          <Label>Teamwork</Label>
          <Group>
            {run.teamwork.map((ask) => (
              <Row
                key={ask.id}
                leading={<MessageCircle size={18} color={colors.muted} strokeWidth={2.2} />}
                title={"Asked " + botName(ask.botId) + ": " + ask.message}
                subtitle={ask.reply ?? ask.error ?? ask.intent}
                subtitleLines={2}
                trailing={<Badge label={ask.status} tone={TEAM_TONE[ask.status]} />}
              />
            ))}
          </Group>
        </View>
      )}

      {!!run.agents?.length && (
        <View>
          <Label>Helpers</Label>
          <Group>
            {run.agents.map((agent) => (
              <View key={agent.id} style={{ minHeight: 52, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
                <StepMark status={agent.status} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T variant="callout" weight="500" numberOfLines={1}>
                    {agent.name}
                  </T>
                  {!!(agent.detail || agent.description) && (
                    <T variant="footnote" color="muted" numberOfLines={2}>
                      {agent.detail || agent.description}
                    </T>
                  )}
                </View>
              </View>
            ))}
          </Group>
        </View>
      )}
    </Sheet>
  );
}
