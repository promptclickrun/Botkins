// The turn a bot is working on now, drawn in parts in the order things happened (turn.ts), whatever
// Steps says: each part's steps and thinking is a `WorkPart`, and the newest part is the `LiveTurn`
// at the bottom. Its reply's text arrives in complete updates (through the relay). Failed only and
// Hidden narrow the steps. The work is drawn the way T3 Code draws it, with the bot
// leading: its face (held still, for battery) and what it is doing beside it ("Coding · …", its
// latest thought), and the steps under it as quiet rows on the chat, with no card (WorkRows.tsx).
// While the turn runs, its status is the glass capsule over the message box (StatusCapsule.tsx), and
// its line under the text keeps the fold line's place (FoldRow.tsx). A turn that will fold once it
// ends keeps room under its text for the reply's row. The work keeps away from the screen's edge
// (`workWidth`). Thinking and interim texts are `Aside`s. Requests and errors are shown elsewhere.
import { router } from "expo-router";
import { View } from "react-native";
import type { Bot, Step } from "@/link/types";
import { type ChatPrefs, useChatPrefs } from "@/state/chatPrefs";
import { activityLabel, type AvatarState, useChatActivity } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BotAvatar, Markdown, space, T, Tap } from "@/ui";
import { Aside } from "./Aside";
import { workWidth } from "./bits";
import { WorkLine } from "./Messages";
import { type Item, segmentThinking } from "./turn";
import { FACE_INDENT, StepRow } from "./WorkRows";

const SHOWN_STEPS = 4;
/** The height of the row under a reply that holds Read aloud (MessageRow). */
const READ_ALOUD_ROW = 28;

/** A part of the turn under way's steps, under the face: the last few (failed ones only, on "Failed only"). A tap opens the turn's activity. */
function Steps({ chatId, runId, all, mode }: { chatId: string; runId?: string; all: Step[]; mode: ChatPrefs["steps"] }) {
  if (all.length === 0 || mode === "hide") return null;
  const steps = mode === "failed" ? all.filter((step) => step.status === "Failed") : all;
  if (steps.length === 0) return null;
  const open = () => runId && router.push({ pathname: "/chat/activity", params: { chatId, runId } });
  const count = all.length === 1 ? "1 step" : all.length + " steps";

  const hidden = Math.max(0, steps.length - SHOWN_STEPS);
  return (
    <Tap
      onPress={open}
      feel="select"
      sink={0.99}
      accessibilityLabel={(mode === "failed" ? steps.length + " failed of " : "Working, ") + count + ", show activity"}
      style={{ ...workWidth, paddingLeft: FACE_INDENT }}
    >
      {hidden > 0 && (
        <T variant="footnote" color="faint" style={{ paddingLeft: 26, paddingVertical: 2 }}>
          {"+" + hidden + " earlier"}
        </T>
      )}
      {steps.slice(-SHOWN_STEPS).map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
    </Tap>
  );
}

/** What the bot is doing, as the line beside its face says it ("Coding"), and the pose its face holds. */
function useDoing(chatId: string): { label: string; state: AvatarState } {
  const state = useChatActivity(chatId);
  return { label: activityLabel(state) || "Working", state: state === "idle" ? "thinking" : state };
}

/** A part of a turn before a steer, an answer or more text: its thinking and steps while it runs, a work line once it ended. */
export function WorkPart({ chatId, bot, item }: { chatId: string; bot?: Bot; item: Extract<Item, { kind: "work" }> }) {
  const stepsMode = useChatPrefs((prefs) => prefs.steps);
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const thinking = useApp((state) => {
    const run = state.running[chatId];
    return item.reasoningIds && run?.id === item.run.id ? segmentThinking(item.reasoningIds, run) : item.thinking;
  });
  if (!item.live) return <WorkLine chatId={chatId} runId={item.run.id} label={item.label} steps={item.steps} failed={stepsMode === "failed"} />;
  return (
    <View style={{ gap: space.xs }}>
      {thinkingMode !== "hide" && !!thinking && (
        <View style={workWidth}>
          <Aside kind="thinking" text={thinking} bot={bot} />
        </View>
      )}
      <Steps chatId={chatId} runId={item.run.id} all={item.steps} mode={stepsMode} />
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
  const stepsMode = useChatPrefs((prefs) => prefs.steps);
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const doing = useDoing(chatId);
  const speaker = (speakerId ? bots.get(speakerId) : undefined) ?? bot;
  // Relay chunks are received text, not a typewriter animation. Markdown keeps completed blocks
  // cached while reparsing the active tail; the finished MessageRow performs the exact final parse.
  const stream = item.text;
  const thinking = thinkingMode !== "hide" ? item.thinking : "";
  const steps = stepsMode === "hide" ? [] : stepsMode === "failed" ? item.steps.filter((step) => step.status === "Failed") : item.steps;
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
          <Steps chatId={chatId} runId={item.run?.id} all={item.steps} mode={stepsMode} />
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
        !item.run &&
        !lead && (
          <View style={workWidth} accessibilityLiveRegion="polite">
            <Aside kind="thinking" text={intent ?? ""} bot={speaker} state="thinking" label="Thinking" live />
          </View>
        )
      )}
    </View>
  );
}
