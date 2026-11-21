import { router, useLocalSearchParams } from "expo-router";
import { Ban, Brain, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, CircleX, MessageCircle } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { Run, Step, StepDetail, TeamAsk, Todo } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { useBots, useModels, useWatchedChat } from "@/state/hooks";
import { api } from "@/state/link";
import { modelName } from "@/state/models";
import { useApp } from "@/state/store";
import { compactNumber, duration } from "@/state/time";
import { Badge, Button, EmptyState, Group, Label, Markdown, radius, Row, Sheet, space, T, Tap, type Tone, useTheme } from "@/ui";
import { StepMark } from "./bits";
import { helperSheet } from "./HelperRail";
import { stepLabel } from "./turn";

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

/**
 * One step: its state, its label and how long it took. A tap shows its input and output. A step
 * that came without them (`more`, "step-details-v1") reads them from the computer when it opens,
 * and again when it finishes; `chatId` and `runId` say which step that is.
 */
export function StepRow({ step, chatId, runId, startOpen = false }: { step: Step; chatId?: string; runId?: string; /** The step a person tapped in a chat's fold. */ startOpen?: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(startOpen);
  const [detail, setDetail] = useState<StepDetail | "failed">();
  const fetches = open && !!step.more && !!chatId && !!runId;
  const stepId = step.id;
  const finished = step.finished;
  useEffect(() => {
    if (!fetches || !chatId || !runId) return;
    let live = true;
    api["link.step"](chatId, runId, stepId).then(
      (value) => live && setDetail(value ?? {}),
      () => live && setDetail((held) => held ?? "failed"),
    );
    return () => {
      live = false;
    };
  }, [fetches, chatId, runId, stepId, finished]);
  const read = typeof detail === "object" ? detail : undefined;
  const input = read?.input ?? step.input;
  const output = read?.output ?? step.output;
  const more = !!step.input || !!step.output || !!step.more;
  const took = step.finished ? duration(step.finished - step.started) : undefined;
  const head = (
    <View style={{ minHeight: 52, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
      <StepMark status={step.status} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="callout" weight="500" numberOfLines={open ? undefined : 2}>
          {stepLabel(step)}
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
      <Tap onPress={() => setOpen(!open)} sink={1} feel="select" hitSlop={0} accessibilityLabel={stepLabel(step) + ", " + step.status} accessibilityState={{ expanded: open }}>
        {head}
      </Tap>
      {open && (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md }}>
          {!!input && <Mono label="Input" text={input} />}
          {!!output && <Mono label="Output" text={output} />}
          {fetches && !detail && <ActivityIndicator color={colors.muted} style={{ alignSelf: "flex-start" }} />}
          {fetches && detail === "failed" && (
            <T variant="footnote" color="muted">
              Couldn't read this step from your computer.
            </T>
          )}
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
  // `stepId`: the step a person tapped in the chat's fold; it opens, and "Failed only" doesn't hide it.
  const { chatId, runId, stepId } = useLocalSearchParams<{ chatId: string; runId: string; stepId?: string }>();
  const chat = useWatchedChat(chatId);
  const saved = useApp((state) => state.chats[chatId]?.runs[runId]);
  const running = useApp((state) => state.running[chatId]);
  const run = running?.id === runId ? running : saved;
  const allBots = useBots();
  const models = useModels();
  const stepsMode = useChatPrefs((prefs) => prefs.steps);
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  // What the bot wrote before it moved on (interim messages, "turn-timeline-v1").
  const updates = (chat?.messages ?? []).filter((message) => message.interim && message.runId === runId && message.text.trim());
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
  // A helper's own steps are listed in its own activity (Helpers, at the top).
  const everyStep = (run.steps ?? []).filter((step) => !step.agentId);
  // "Failed only" narrows the list to what went wrong; the rest is a tap away.
  const picked = stepId ? everyStep.find((step) => step.id === stepId) : undefined;
  const onlyFailed = stepsMode === "failed" && !allSteps && picked?.status !== "Done" && everyStep.some((step) => step.status === "Failed") && (!picked || picked.status === "Failed");
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

      {/* The owner's order (2026-11-20): helpers first, then the to-do list, then the steps and everything else. */}
      {!!run.agents?.length && (
        <View>
          <Label>Helpers</Label>
          <Group>
            {run.agents.map((agent) => (
              <Tap key={agent.id} onPress={() => router.push(helperSheet(chatId, run.id, agent.id))} sink={1} feel="select" hitSlop={0} accessibilityLabel={agent.name + ", " + agent.status + ", show activity"}>
                <View style={{ minHeight: 52, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
                  <StepMark status={agent.status} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T variant="callout" weight="500" numberOfLines={1}>
                      {agent.name}
                    </T>
                    {!!(agent.intent || agent.detail || agent.description) && (
                      <T variant="footnote" color="muted" numberOfLines={2}>
                        {(agent.status === "Running" && agent.intent) || agent.detail || agent.description}
                      </T>
                    )}
                  </View>
                  <ChevronRight size={16} color={colors.faint} strokeWidth={2.4} />
                </View>
              </Tap>
            ))}
          </Group>
        </View>
      )}

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

      {steps.length > 0 && (
        <View>
          <Label>{onlyFailed ? (steps.length === 1 ? "1 failed step" : steps.length + " failed steps") : steps.length === 1 ? "1 step" : steps.length + " steps"}</Label>
          <Group>
            {steps.map((step) => (
              <StepRow key={step.id} step={step} chatId={chatId} runId={runId} startOpen={step.id === stepId} />
            ))}
          </Group>
          {onlyFailed && <Button title={"Show all " + everyStep.length + " steps"} variant="ghost" size="sm" wide onPress={() => setAllSteps(true)} style={{ marginTop: space.xs }} />}
        </View>
      )}

      {/* Thinking and updates on Hidden keeps both out of the chat; this sheet still has them. */}
      <Reasoning run={run} startOpen={thinkingMode === "show"} />

      {updates.length > 0 && (
        <View>
          <Label>{updates.length === 1 ? "1 update" : updates.length + " updates"}</Label>
          <Group>
            {updates.map((message, i) => (
              <View key={(message.time ?? 0) + ":" + i} style={{ paddingHorizontal: space.lg, paddingVertical: space.md }}>
                <Markdown text={message.text} size="small" plain={!markdown} />
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
    </Sheet>
  );
}
