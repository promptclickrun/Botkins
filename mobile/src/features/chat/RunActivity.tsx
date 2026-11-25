import { router, useIsFocused, useLocalSearchParams } from "expo-router";
import { Brain, ChevronDown, ChevronRight, CircleDashed, MessageCircle } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { Run, Step, StepDetail, TeamAsk } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { useBots, useCapability, useModels, useWatchedChat } from "@/state/hooks";
import { api, watchReasoning } from "@/state/link";
import { useAppActive } from "@/state/useAppActive";
import { modelName } from "@/state/models";
import { useApp } from "@/state/store";
import { compactNumber, duration } from "@/state/time";
import { Badge, EmptyState, Group, Label, Markdown, Row, Sheet, space, T, Tap, type Tone, useTheme } from "@/ui";
import { activitySteps } from "../../../link-host/activity-steps.mjs";
import { CommandCard, DiffCard, KindIcon, StepDetailView } from "./ActivityWidgets";
import { isCodingKind, parseStepInput, stepHeadline } from "./activityModel";
import { TodoList } from "./TodoList";
import { StepMark } from "./bits";
import { helperSheet } from "./HelperRail";

const STATUS_TONE: Record<string, Tone> = { Working: "accent", Completed: "success", "Needs you": "danger", Stopped: "neutral", Interrupted: "warning" };

/**
 * One step: its state, its label and how long it took. A tap shows its input and output. A step
 * that came without them (`more`, "step-details-v1") reads them from the computer when it opens,
 * and again when it finishes; `chatId` and `runId` say which step that is.
 */
export function StepRow({ step, chatId, runId, startOpen = false, helperName, follow = false }: { step: Step; chatId?: string; runId?: string; /** The step a person tapped in a chat's fold. */ startOpen?: boolean; helperName?: string; follow?: boolean }) {
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
  const effectiveStep: Step = read ? { ...step, input: read.input ?? step.input, output: read.output ?? step.output } : step;
  const parsed = parseStepInput(effectiveStep);
  const coding = isCodingKind(parsed.kind);
  const headline = (helperName ? helperName + ": " : "") + stepHeadline(effectiveStep, parsed);
  const more = follow || !!effectiveStep.input || !!effectiveStep.output || !!step.more || !!parsed.command || !!parsed.filePath;
  const took = step.finished ? duration(step.finished - step.started) : undefined;
  const head = (
    <View style={{ minHeight: 52, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
      {step.status === "Running" || step.status === "Failed" ? (
        <StepMark status={step.status} />
      ) : (
        <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center" }}>
          <KindIcon kind={parsed.kind} size={17} color={colors.muted} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="callout" weight="500" color={step.status === "Failed" ? "danger" : "ink"} numberOfLines={open ? undefined : 2}>
          {headline}
        </T>
        {!open && !!step.progress && step.status === "Running" && (
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
      <Tap onPress={() => setOpen(!open)} sink={1} feel="select" hitSlop={0} accessibilityLabel={headline + ", " + step.status} accessibilityState={{ expanded: open }}>
        {head}
      </Tap>
      {open && (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md }}>
          {fetches && !detail ? (
            <ActivityIndicator color={colors.muted} style={{ alignSelf: "flex-start" }} />
          ) : fetches && detail === "failed" ? (
            <T variant="footnote" color="muted">
              Couldn't read this step from your computer.
            </T>
          ) : follow && !effectiveStep.input && !effectiveStep.progress && !effectiveStep.output && !parsed.command && !parsed.filePath ? (
            <T variant="footnote" color="muted">{step.status === "Running" ? "Waiting for progress…" : "No additional details."}</T>
          ) : coding ? (
            parsed.kind === "command" ? (
              <CommandCard step={effectiveStep} parsed={parsed} live={step.status === "Running"} />
            ) : (
              <DiffCard step={effectiveStep} parsed={parsed} live={step.status === "Running"} />
            )
          ) : (
            <StepDetailView step={effectiveStep} />
          )}
        </View>
      )}
    </View>
  );
}

function Reasoning({ chatId, run, live, available, startOpen }: { chatId: string; run: Run; live: boolean; available: boolean; startOpen: boolean }) {
  const { colors, type } = useTheme();
  const [open, setOpen] = useState(startOpen);
  const inFront = useAppActive(useIsFocused());
  useEffect(() => live && inFront && open ? watchReasoning(chatId) : undefined, [live, inFront, open, chatId]);
  if (!available && !run.reasoning?.some((part) => /\S/.test(part.text))) return null;
  const text = open && inFront ? (run.reasoning ?? []).map((part) => part.text.trim()).filter(Boolean).join("\n\n") : "";
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
          <Text selectable maxFontSizeMultiplier={1.35} style={[type.subhead, { color: colors.ink2, lineHeight: 22 }]}>
            {text || (live ? "Waiting for thinking…" : "")}
          </Text>
        </View>
      )}
    </Group>
  );
}

const TEAM_TONE: Record<TeamAsk["status"], Tone> = { waiting: "neutral", working: "accent", answered: "success", failed: "danger", stopped: "neutral" };

export default function RunActivity() {
  const { colors } = useTheme();
  // Open the step the person tapped in the canvas or its fold.
  const { chatId, runId, stepId } = useLocalSearchParams<{ chatId: string; runId: string; stepId?: string }>();
  const chat = useWatchedChat(chatId);
  const saved = useApp((state) => state.chats[chatId]?.runs[runId]);
  const running = useApp((state) => state.running[chatId]);
  const run = running?.id === runId ? running : saved;
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const showUpdates = useChatPrefs((prefs) => prefs.updates);
  // Earlier hosts don't advertise retained thoughts on their compact run. Keep the
  // disclosure available there so opening it can fetch whatever they already hold.
  const reportsThinking = useCapability("separate-thinking-v1");
  const live = running?.id === runId && running?.status === "Working";
  const allBots = useBots();
  const models = useModels();
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  // What the bot wrote before it moved on (interim messages, "turn-timeline-v1").
  const updates = (chat?.messages ?? []).filter((message) => message.interim && message.runId === runId && message.text.trim());

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
  // Tasks, then subagents and background work (a helper opens its own activity sheet), then this
  // turn's own tool calls, newest first. Failed only narrows the conversation, never this sheet.
  const { tools: steps, background, byAgent } = activitySteps(run.steps, run.agents);
  const selectedHelperStep = stepId ? byAgent.get(stepId)?.find((step) => step.id === stepId) : undefined;

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

      {!!run.todos?.length && (
        <View>
          <Label>Tasks</Label>
          <TodoList todos={run.todos} />
        </View>
      )}

      {(!!run.agents?.length || background.length > 0) && (
        <View>
          <Label>Subagents</Label>
          <Group>
            {run.agents?.map((agent) => (
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
            {selectedHelperStep && <StepRow step={selectedHelperStep} chatId={chatId} runId={runId} startOpen />}
            {background.map((step) => (
              <StepRow key={step.id} step={step} chatId={chatId} runId={runId} startOpen={step.id === stepId} follow />
            ))}
          </Group>
        </View>
      )}

      {steps.length > 0 && (
        <View>
          <Label>{steps.length === 1 ? "1 tool call" : steps.length + " tool calls"}</Label>
          <Group>
            {steps.map((step) => (
              <StepRow key={step.id} step={step} chatId={chatId} runId={runId} startOpen={step.id === stepId} helperName={run.agents?.find((agent) => agent.id === step.agentId)?.name} />
            ))}
          </Group>
        </View>
      )}

      {/* Hidden omits notes from this rail; Folded and Open retain their complete text here. */}
      {thinkingMode !== "hide" && <Reasoning key={run.id + thinkingMode} chatId={chatId} run={run} live={live} available={live && (!!run.hasReasoning || !reportsThinking)} startOpen={thinkingMode === "show"} />}

      {showUpdates && updates.length > 0 && (
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
                title={"Asked " + (ask.remote ? ask.remote.botName + " on " + ask.remote.hostName : botName(ask.botId)) + ": " + ask.message}
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
