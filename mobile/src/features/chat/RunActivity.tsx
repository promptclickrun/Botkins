// A turn's activity (route /chat/activity, a sheet), as a story: its header, its tasks, then "How
// it went" in chapters (activityStory.ts): each thought a heading on a quiet rail, the work it led
// to as one line that opens to its steps, and the bot's updates where they came. A chapter with a
// failed step, the one still running and the one holding a step tapped in the chat start open.
// Then the turn's crew (its helpers and background commands, each opening its own sheet) and its
// teamwork. Settings › Chat decides whether thoughts and updates show.
import { router, useLocalSearchParams } from "expo-router";
import { ChevronDown, ChevronRight, CircleDashed, MessageCircle } from "lucide-react-native";
import { memo, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import type { Step, StepDetail, TeamAsk } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { useBots, useModels, useWatchedChat } from "@/state/hooks";
import { api } from "@/state/link";
import { useWatchedReasoning } from "./useWatchedReasoning";
import { modelName } from "@/state/models";
import { useApp } from "@/state/store";
import { compactNumber, duration } from "@/state/time";
import { Badge, EmptyState, Group, Label, Markdown, Row, Sheet, space, T, Tap, type Tone, useTheme } from "@/ui";
import { CommandCard, DiffCard, KindIcon, StepDetailView } from "./ActivityWidgets";
import { isCodingKind, parseStepInput, stepHeadline, summarizeSteps, visibleSteps } from "./activityModel";
import { type Chapter, crewOf, isLive, storyChapters, type StoryUpdate } from "./activityStory";
import { clockOffset, countWords, failedTail, openChapters } from "./crew";
import { TodoList } from "./TodoList";
import { StepMark } from "./bits";
import { commandSheet, helperSheet } from "./HelperRail";

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

const TEAM_TONE: Record<TeamAsk["status"], Tone> = { waiting: "neutral", working: "accent", answered: "success", failed: "danger", stopped: "neutral" };

/** What the bot wrote before it moved on, where it came: quiet text in a thin frame. */
function UpdateText({ text, markdown }: { text: string; markdown: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.line, borderRadius: 12, paddingHorizontal: space.md, paddingVertical: space.sm }}>
      <Markdown text={text} size="small" plain={!markdown} color={colors.ink2} />
    </View>
  );
}

/** A chapter's work in one line: an icon and a count for each kind ("3 files · 2 searches · 1 web"). */
function CountLine({ chapter }: { chapter: Chapter<Step> }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: space.md, rowGap: 2 }}>
      {chapter.counts.map((count) => (
        <View key={count.kind} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <KindIcon kind={count.kind} size={14} color={colors.muted} />
          <T variant="footnote" color="muted">
            {countWords(count)}
          </T>
        </View>
      ))}
      {chapter.failed > 0 && (
        <T variant="footnote" weight="600" color="danger">
          {chapter.failed + " failed"}
        </T>
      )}
    </View>
  );
}

/**
 * One chapter on the rail: its heading and when it began, the thought's first words (a tap shows
 * the whole thought), and its work as one line that opens to its steps. Updates show either way.
 */
const ChapterView = memo(function ChapterView({ chapter, start, startOpen, stepId, chatId, runId, thinking, markdown, last }: {
  chapter: Chapter<Step>;
  start: number;
  startOpen: boolean;
  stepId?: string;
  chatId: string;
  runId: string;
  /** Settings › Chat › Thinking isn't Hide. */
  thinking: boolean;
  markdown: boolean;
  last: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(startOpen);
  const [whole, setWhole] = useState(false);
  // With thinking hidden, a chapter a thought opened is named by its steps instead.
  const heading = chapter.thought && !thinking ? summarizeSteps(chapter.steps, { running: chapter.running }) || "Working" : chapter.heading;
  const thought = thinking ? chapter.thought : undefined;
  const updates = chapter.items.flatMap((item) => (item.kind === "update" ? [item.update] : []));
  const dot = chapter.failed ? colors.danger : chapter.running ? colors.accent : colors.lineStrong;
  return (
    <View style={{ flexDirection: "row", gap: space.md }}>
      <View style={{ width: 12, alignItems: "center" }}>
        <View style={{ width: 9, height: 9, borderRadius: 5, marginTop: 7, backgroundColor: dot }} />
        {!last && <View style={{ flex: 1, width: 2, marginTop: 4, borderRadius: 1, backgroundColor: colors.line }} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : space.lg, gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
          <T variant="callout" weight="600" numberOfLines={2} style={{ flex: 1 }}>
            {heading}
          </T>
          <T variant="footnote" color="faint" style={{ fontVariant: ["tabular-nums"], paddingTop: 2 }}>
            {clockOffset(chapter.at - start)}
          </T>
        </View>
        {!!thought?.snippet &&
          (whole ? (
            <Tap onPress={() => setWhole(false)} feel="select" hitSlop={0} accessibilityLabel="Show less of this thought" accessibilityState={{ expanded: true }}>
              <Markdown text={thought.text} size="small" plain={!markdown} color={colors.ink2} />
            </Tap>
          ) : (
            <Tap onPress={() => setWhole(true)} feel="select" hitSlop={0} accessibilityLabel={"Thought: " + thought.snippet + ". Show the whole thought"} accessibilityState={{ expanded: false }}>
              <T variant="footnote" color="muted" numberOfLines={2}>
                {thought.snippet}
              </T>
            </Tap>
          ))}
        {chapter.steps.length > 0 && (
          <Tap onPress={() => setOpen(!open)} feel="select" hitSlop={0} accessibilityLabel={chapter.counts.map(countWords).join(", ") + (chapter.failed ? ", " + chapter.failed + " failed" : "") + (open ? ", hide steps" : ", show steps")} accessibilityState={{ expanded: open }}>
            <View style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm }}>
              {chapter.running && <StepMark status="Running" size={14} />}
              <CountLine chapter={chapter} />
              {open ? <ChevronDown size={16} color={colors.faint} strokeWidth={2.4} /> : <ChevronRight size={16} color={colors.faint} strokeWidth={2.4} />}
            </View>
          </Tap>
        )}
        {open ? (
          <ChapterItems chapter={chapter} stepId={stepId} chatId={chatId} runId={runId} markdown={markdown} />
        ) : (
          updates.map((update) => <UpdateText key={update.key} text={update.text} markdown={markdown} />)
        )}
      </View>
    </View>
  );
});

/** An open chapter: its steps in groups, and its updates between them where they came. */
function ChapterItems({ chapter, stepId, chatId, runId, markdown }: { chapter: Chapter<Step>; stepId?: string; chatId: string; runId: string; markdown: boolean }) {
  // Steps in a row share one group; an update between them splits it.
  const runs: ({ kind: "steps"; key: string; steps: Step[] } | { kind: "update"; key: string; text: string })[] = [];
  for (const item of chapter.items) {
    if (item.kind === "update") runs.push({ kind: "update", key: item.key, text: item.update.text });
    else {
      const held = runs.at(-1);
      if (held?.kind === "steps") held.steps.push(item.step);
      else runs.push({ kind: "steps", key: item.key, steps: [item.step] });
    }
  }
  return (
    <View style={{ gap: space.sm }}>
      {runs.map((part) =>
        part.kind === "update" ? (
          <UpdateText key={part.key} text={part.text} markdown={markdown} />
        ) : (
          <Group key={part.key}>
            {part.steps.map((step) => (
              <View key={step.id}>
                <StepRow step={step} chatId={chatId} runId={runId} startOpen={step.id === stepId} />
                {step.status === "Failed" && <FailedTail step={step} />}
              </View>
            ))}
          </Group>
        ),
      )}
    </View>
  );
}

/** A failed step's last useful lines of output, under its row. */
function FailedTail({ step }: { step: Step }) {
  const tail = failedTail(step.output);
  if (!tail) return null;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md, marginTop: -4 }}>
      <T variant="mono" color="danger" numberOfLines={3} selectable>
        {tail}
      </T>
    </View>
  );
}

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
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const live = running?.id === runId && running?.status === "Working";
  const thinking = thinkingMode !== "hide";
  // A turn under way sends its thoughts' text only to a screen that watches them.
  useWatchedReasoning(chatId, live && thinking);
  const allBots = useBots();
  const models = useModels();
  const messages = chat?.messages;
  // What the bot wrote before it moved on (interim messages, "turn-timeline-v1").
  const updates = useMemo(
    (): StoryUpdate[] =>
      !showUpdates || !run
        ? []
        : (messages ?? []).flatMap((message, i) => (message.interim && message.runId === runId && message.text.trim() ? [{ key: (message.time ?? 0) + ":" + i, at: message.time ?? run.time, text: message.text.trim() }] : [])),
    [messages, runId, showUpdates, run],
  );
  const chapters = useMemo(() => (run ? storyChapters(run, updates) : []), [run, updates]);
  const crew = useMemo(() => (run ? crewOf(run) : null), [run]);

  if (!run)
    return (
      <Sheet title="Activity">
        <EmptyState icon={CircleDashed} title="Nothing to show" />
      </Sheet>
    );

  const botName = (id: string) => allBots.find((bot) => bot.id === id)?.name ?? "a bot";
  const took = run.finished ? duration(run.finished - run.time) : run.usage?.durationMs ? duration(run.usage.durationMs) : undefined;
  const model = run.usage?.model ?? (run.model ? modelName(run.model, models) : undefined);
  const counted = visibleSteps(run.steps);
  const failed = counted.filter((step) => step.status === "Failed").length;
  const facts = [took, counted.length ? (counted.length === 1 ? "1 step" : counted.length + " steps") : undefined, model, run.usage ? compactNumber(run.usage.input) + " in · " + compactNumber(run.usage.output) + " out" : undefined].filter(Boolean).join(" · ");
  // Which chapters start open: each reads it once, when it first shows.
  const opened = openChapters(chapters, stepId);
  // A step tapped elsewhere that belongs to a helper or the background: it opens at the top of Crew.
  const outside = stepId && !chapters.some((chapter) => chapter.steps.some((step) => step.id === stepId)) ? run.steps?.find((step) => step.id === stepId) : undefined;

  return (
    <Sheet title="Activity">
      <View style={{ gap: space.sm }}>
        <T variant="title3" numberOfLines={3}>
          {run.title}
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={run.status} tone={STATUS_TONE[run.status] ?? "neutral"} />
          {failed > 0 && <Badge label={failed + " failed"} tone="danger" />}
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

      {chapters.length > 0 && (
        <View>
          <Label>How it went</Label>
          <View style={{ paddingTop: space.xs }}>
            {chapters.map((chapter, i) => (
              <ChapterView key={chapter.key} chapter={chapter} start={run.time} startOpen={opened.has(chapter.key)} stepId={stepId} chatId={chatId} runId={runId} thinking={thinking} markdown={markdown} last={i === chapters.length - 1} />
            ))}
          </View>
        </View>
      )}

      {(!!crew || !!outside) && (
        <View>
          <Label>Crew</Label>
          <Group>
            {outside && <StepRow step={outside} chatId={chatId} runId={runId} startOpen helperName={run.agents?.find((agent) => agent.id === outside.agentId)?.name} />}
            {crew?.members.map((member) => {
              const line = isLive(member.status) ? member.doing : member.kind === "helper" ? member.done : member.doing;
              return (
                <Row
                  key={member.id}
                  leading={<StepMark status={member.status} />}
                  title={member.name}
                  subtitle={[line, member.kind === "helper" && member.steps ? (member.steps === 1 ? "1 step" : member.steps + " steps") : ""].filter(Boolean).join(" · ") || member.status}
                  chevron
                  onPress={() => router.push(member.kind === "helper" ? helperSheet(chatId, run.id, member.id) : commandSheet(chatId, run.id, member.id))}
                />
              );
            })}
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
