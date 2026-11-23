// The turn a bot is working on now, drawn in parts in the order things happened (turn.ts), whatever
// Steps says: each part's steps and thinking is a `WorkPart`, and the newest part is the `LiveTurn`
// at the bottom. Its reply's text arrives in complete updates (through the relay). Failed only narrows the canvas steps. The work is drawn the way T3 Code draws it, with the bot
// leading: its face (held still, for battery) and what it is doing beside it ("Coding · …", its
// latest thought), and the steps under it as quiet rows on the chat, with no card (WorkRows.tsx).
// While the turn runs, its status is the glass capsule over the message box (StatusCapsule.tsx), and
// its line under the text keeps the fold line's place (FoldRow.tsx). A turn that will fold once it
// ends keeps room under its text for the reply's row. The work keeps away from the screen's edge
// (`workWidth`). Thinking and interim texts are `Aside`s. Requests and errors are shown elsewhere.
import { memo } from "react";
import { View } from "react-native";
import type { Bot, Run, Step } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { activityLabel, type AvatarState, useChatActivity } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BotAvatar, Markdown, space, T } from "@/ui";
import { Aside } from "./Aside";
import { workWidth } from "./bits";
import { type Item, segmentThinking } from "./turn";
import { FACE_INDENT, StepLine } from "./WorkRows";

/** The height of the row under a reply that holds Read aloud (MessageRow). */
const READ_ALOUD_ROW = 28;

/** Canvas steps arrive pre-filtered by the timeline. A tap opens the complete activity rail. */
const Steps = memo(function Steps({ chatId, run, steps, label }: { chatId: string; run?: Run; steps: Step[]; label?: string }) {
  if (!run || !steps.length) return null;
  const helpers = new Map(run.agents?.map((agent) => [agent.id, agent.name]));
  return (
    <View style={{ ...workWidth, paddingLeft: FACE_INDENT }} accessibilityLabel={label}>
      {steps.map((step) => <StepLine key={step.id} chatId={chatId} runId={run.id} step={step} helperName={step.agentId ? helpers.get(step.agentId) : undefined} />)}
    </View>
  );
});

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
  if (!item.live) return <Steps chatId={chatId} run={item.run} steps={item.steps} label={item.label} />;
  return (
    <View style={{ gap: space.xs }}>
      {thinkingMode === "show" && !!thinking && (
        <View style={workWidth}>
          <Aside kind="thinking" text={thinking} bot={bot} />
        </View>
      )}
      <Steps chatId={chatId} run={item.run} steps={item.steps} />
    </View>
  );
}

/** Text the bot wrote before it moved on (an interim message, or a piece noted from an older computer): one of its updates. */
export function TurnText({ item }: { item: Extract<Item, { kind: "text" }> }) {
  return <Aside kind="update" text={item.text} />;
}

/** The newest part of the turn under way: the bot and what it is doing, its steps, and the reply as it streams in. Rendered only while a reply is under way. */
export function LiveTurn({ chatId, bot, group, bots, item }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot>; item: Extract<Item, { kind: "live" }> }) {
  const intent = useApp((state) => state.parts.live?.intents[chatId]);
  const speakerId = useApp((state) => state.parts.live?.speakers[chatId]);
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const doing = useDoing(chatId);
  const speaker = (speakerId ? bots.get(speakerId) : undefined) ?? bot;
  // Relay chunks are received text, not a typewriter animation. Markdown keeps completed blocks
  // cached while reparsing the active tail; the finished MessageRow performs the exact final parse.
  const stream = item.text;
  const thinking = thinkingMode === "show" ? item.thinking : "";
  // Timeline rows are already filtered for Folded/Open/Failed; keep the renderer structural.
  const steps = item.steps;
  // The face leads the work: what the bot is doing and its latest thought. A reply with no work has none.
  const lead = !!thinking || steps.length > 0;
  return (
    <View style={{ gap: space.md }}>
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
            <Aside kind="thinking" text={thinking} bot={speaker} state={doing.state} label={doing.label} live />
          </View>
          <Steps chatId={chatId} run={item.run} steps={item.steps} />
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
        !item.run && thinkingMode === "show" &&
        !lead && (
          <View style={workWidth} accessibilityLiveRegion="polite">
            <Aside kind="thinking" text={intent ?? ""} bot={speaker} state="thinking" label="Thinking" live />
          </View>
        )
      )}
    </View>
  );
}
