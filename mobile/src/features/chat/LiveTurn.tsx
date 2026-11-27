// The turn a bot is working on now, drawn in parts in the order things happened (turn.ts), whatever
// Steps says: each part's steps and thinking is a `WorkPart`, and the newest part is the `LiveTurn`
// at the bottom. Its reply's text arrives in complete word chunks. Failed only narrows the canvas steps. The work is drawn the way T3 Code draws it, with the bot
// leading: its face (held still, for battery) and what it is doing beside it ("Coding · …", its
// latest thought), and the steps under it as quiet rows on the chat, with no card (WorkRows.tsx).
// While the turn runs, its status is the glass capsule over the message box (StatusCapsule.tsx), and
// its line under the text keeps the fold line's place (FoldRow.tsx). A turn that will fold once it
// ends keeps room under its text for the reply's row. The work keeps away from the screen's edge
// (`workWidth`). Thinking and interim updates are controlled independently (Settings › Chat) and
// drawn as `Aside`s. Requests and errors are shown elsewhere.
// The turn's live line shimmers while the bot is on it and nothing waits for the person: the running
// step, or "Coding" beside the face while no step runs (T3 Code's look, the owner's pick 2026-11-23).
import { memo } from "react";
import { View } from "react-native";
import type { Bot, Run, Step } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { activityLabel, type AvatarState, useChatActivity } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BotAvatar, Markdown, space, T } from "@/ui";
import { Aside } from "./Aside";
import { workWidth } from "./bits";
import { islandOn } from "./islandModel";
import { liveTurnDisplay } from "./liveDisplay";
import { type Item, resolveLiveBody, segmentThinking } from "./turn";
import { FACE_INDENT, StepLine } from "./WorkRows";

/** The height of the row under a reply that holds Read aloud (MessageRow). */
const READ_ALOUD_ROW = 28;

/** Canvas steps arrive pre-filtered by the timeline. A tap opens the complete activity rail. */
const Steps = memo(function Steps({ chatId, run, steps, label, live = false }: { chatId: string; run?: Run; steps: Step[]; label?: string; /** The bot is on it: a running step shimmers. */ live?: boolean }) {
  if (!run || !steps.length) return null;
  const helpers = new Map(run.agents?.map((agent) => [agent.id, agent.name]));
  return (
    <View style={{ ...workWidth, paddingLeft: FACE_INDENT }} accessibilityLabel={label}>
      {steps.map((step) => <StepLine key={step.id} chatId={chatId} runId={run.id} step={step} helperName={step.agentId ? helpers.get(step.agentId) : undefined} live={live} />)}
    </View>
  );
});

/** The bot is on its turn now: nothing it asked waits for the person. */
function useOnIt(chatId: string): boolean {
  return useApp((state) => !state.parts.live?.requests?.some((request) => request.chatId === chatId));
}

/** What the bot is doing, as the line beside its face says it ("Coding"), and the pose its face holds. */
function useDoing(chatId: string): { label: string; state: AvatarState } {
  const state = useChatActivity(chatId);
  return { label: activityLabel(state) || "Working", state: state === "idle" ? "thinking" : state };
}

/** A part of a turn before a steer, an answer or more text: its thinking and steps while it runs, a work line once it ended. */
export function WorkPart({ chatId, bot, item }: { chatId: string; bot?: Bot; item: Extract<Item, { kind: "work" }> }) {
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const thinking = useApp((state) => {
    const run = state.running[chatId];
    return item.reasoningIds && run?.id === item.run.id ? segmentThinking(item.reasoningIds, run) : item.thinking;
  });
  const onIt = useOnIt(chatId);
  if (!item.live) return <Steps chatId={chatId} run={item.run} steps={item.steps} label={item.label} />;
  return (
    <View style={{ gap: space.xs }}>
      {thinkingMode === "show" && !!thinking && (
        <View style={workWidth}>
          <Aside kind="thinking" text={thinking} bot={bot} />
        </View>
      )}
      <Steps chatId={chatId} run={item.run} steps={item.steps} live={onIt} />
    </View>
  );
}

/** Text the bot wrote before it moved on (an interim message, or a piece noted from an older computer): one of its updates. */
export function TurnText({ chatId, item }: { chatId?: string; item: Extract<Item, { kind: "text" }> }) {
  const showUpdates = useChatPrefs((prefs) => prefs.updates);
  if (!showUpdates) return null;
  return <Aside kind="update" text={item.text} chatId={chatId} />;
}

/** The newest part of the turn under way: the bot and what it is doing, its steps, and the reply as it streams in. Rendered only while a reply is under way. */
export function LiveTurn({ chatId, bot, group, bots, item }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot>; item: Extract<Item, { kind: "live" }> }) {
  const intent = useApp((state) => state.parts.live?.intents[chatId]);
  const speakerId = useApp((state) => state.parts.live?.speakers[chatId]);
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const showUpdates = useChatPrefs((prefs) => prefs.updates);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const doing = useDoing(chatId);
  const onIt = useOnIt(chatId);
  const speaker = (speakerId ? bots.get(speakerId) : undefined) ?? bot;
  // Only this row needs new words. Markdown reuses completed blocks and formats the growing tail when a chunk arrives.
  const body = useApp((state) => state.texts[chatId]);
  const latestRun = useApp((state) => state.running[chatId]);
  const resolved = resolveLiveBody(item, body, latestRun);
  const visible = liveTurnDisplay({ stream: resolved.text, thinking: resolved.thinking, intent, thinkingMode, showUpdates });
  const stream = visible.stream;
  // Once the computer has started the run, Open's thinking is in the island under this row (Island.tsx).
  const inIsland = useChatPrefs(islandOn) && !!item.run;
  const thinking = thinkingMode === "show" && !inIsland ? visible.thinking ?? "" : "";
  // Timeline rows are already filtered for Folded/Open/Failed; keep the renderer structural.
  const steps = item.steps;
  // The face leads the work: what the bot is doing and its latest thought. A reply with no work has none.
  const lead = !!thinking || steps.length > 0;
  // One live line at a time: a running step shown below, or else what the bot is doing. The island's header has it when there is one.
  const leadShimmers = onIt && !inIsland && !steps.some((step) => step.status === "Running");
  return (
    <View style={{ gap: space.sm + 2 }}>
      {group && !!stream && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <BotAvatar bot={speaker} size={22} state="talking" animated={false} />
          <T variant="footnote" weight="700" color="ink2" numberOfLines={1}>
            {speaker?.name ?? "Bot"}
          </T>
        </View>
      )}
      {lead && (
        <View style={{ gap: space.xs }}>
          <View style={workWidth}>
            <Aside kind="thinking" text={thinking} bot={speaker} state={doing.state} label={doing.label} live shimmer={leadShimmers} />
          </View>
          <Steps chatId={chatId} run={item.run} steps={item.steps} live={onIt} />
        </View>
      )}
      {stream && item.reserve ? (
        // Laid out as the reply will be (MessageRow): the empty row is where Read aloud will be, so
        // the text stays where it is when it becomes the reply and the status line becomes the fold line.
        <View style={{ gap: space.sm }}>
          <Markdown text={stream} plain={!markdown} streaming />
          <View style={{ height: READ_ALOUD_ROW }} />
        </View>
      ) : stream ? (
        <Markdown text={stream} plain={!markdown} streaming />
      ) : (
        !item.run && (thinkingMode === "show" || (showUpdates && !!visible.intent)) &&
        !lead && (
          <View style={workWidth} accessibilityLiveRegion="polite">
            <Aside kind="thinking" text={visible.intent ?? ""} bot={speaker} state="thinking" label="Thinking" live shimmer={onIt} />
          </View>
        )
      )}
    </View>
  );
}
