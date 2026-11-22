// The turn a bot is working on now, drawn in parts in the order things happened (turn.ts), whatever
// Steps says: each part's steps and thinking is a `WorkPart`, and the newest part is the `LiveTurn`
// at the bottom. Its reply's text in chunks (through the relay) is painted word by word (paint.ts). Failed only and Hidden narrow the steps. Under it, in every mode, the turn's status
// line: the bot's face and its typing dots (FoldRow.tsx). A turn that will fold once it ends keeps
// room under its text for the reply's row. The work keeps away from the screen's edge (`workWidth`).
// Thinking and interim texts are `Aside`s. Requests and errors are shown elsewhere and always show.
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import type { Bot, Step } from "@/link/types";
import { type ChatPrefs, useChatPrefs } from "@/state/chatPrefs";
import { useTextMode } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BotAvatar, Markdown, radius, space, T, Tap, useTheme } from "@/ui";
import { Aside } from "./Aside";
import { StepMark, TypingDots, workWidth } from "./bits";
import { WorkLine } from "./Messages";
import { usePainted } from "./paint";
import { type Item, stepLabel } from "./turn";

const SHOWN_STEPS = 4;
/** The height of the row under a reply that holds Read aloud (MessageRow). */
const READ_ALOUD_ROW = 28;

/** The bot typing, for a turn whose run hasn't come yet; otherwise its status line under the turn is its face (FoldRow.tsx). */
function Typing({ bot, intent }: { bot?: Bot; intent?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 36 }} accessibilityLabel={(bot?.name ?? "The bot") + " is thinking" + (intent ? ", " + intent : "")} accessibilityLiveRegion="polite">
      <BotAvatar bot={bot} size={32} state="thinking" />
      <TypingDots />
      {!!intent && (
        <T variant="subhead" color="muted" numberOfLines={1} style={{ flex: 1 }}>
          {intent}
        </T>
      )}
    </View>
  );
}

/** A part of the turn under way's steps: the last few (failed ones only, on "Failed only"). A tap opens the turn's activity. */
function Steps({ chatId, runId, all, mode }: { chatId: string; runId?: string; all: Step[]; mode: ChatPrefs["steps"] }) {
  const { colors } = useTheme();
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
      style={{ ...workWidth, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 }}
    >
      {hidden > 0 && (
        <T variant="caption" color="faint" style={{ paddingLeft: 28, paddingVertical: 2 }}>
          {"+" + hidden + " earlier"}
        </T>
      )}
      {steps.slice(-SHOWN_STEPS).map((step) => (
        <View key={step.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 28 }}>
          <StepMark status={step.status} size={15} />
          <T variant="subhead" color={step.status === "Running" ? "ink" : step.status === "Failed" ? "danger" : "muted"} numberOfLines={1} style={{ flex: 1 }}>
            {stepLabel(step)}
          </T>
        </View>
      ))}
    </Tap>
  );
}

/** A part of a turn before a steer, an answer or more text: its steps and thinking while it runs, a work line once it ended. */
export function WorkPart({ chatId, item }: { chatId: string; item: Extract<Item, { kind: "work" }> }) {
  const stepsMode = useChatPrefs((prefs) => prefs.steps);
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  if (!item.live) return <WorkLine chatId={chatId} runId={item.run.id} label={item.label} failed={stepsMode === "failed"} />;
  return (
    <View style={{ gap: space.md }}>
      <Steps chatId={chatId} runId={item.run.id} all={item.steps} mode={stepsMode} />
      {thinkingMode !== "hide" && !!item.thinking && (
        <View style={workWidth}>
          <Aside kind="thinking" text={item.thinking} />
        </View>
      )}
    </View>
  );
}

/** Text the bot wrote before it moved on (an interim message, or a piece noted from an older computer): one of its updates. */
export function TurnText({ item }: { item: Extract<Item, { kind: "text" }> }) {
  return (
    <View style={workWidth}>
      <Aside kind="update" text={item.text} />
    </View>
  );
}

/** The newest part of the turn under way: its steps and thinking, and the reply as it streams in. Rendered only while a reply is under way. */
export function LiveTurn({ chatId, bot, group, bots, item }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot>; item: Extract<Item, { kind: "live" }> }) {
  const intent = useApp((state) => state.parts.live?.intents[chatId]);
  const speakerId = useApp((state) => state.parts.live?.speakers[chatId]);
  const stepsMode = useChatPrefs((prefs) => prefs.steps);
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const speaker = (speakerId ? bots.get(speakerId) : undefined) ?? bot;
  // Through the relay the text comes in chunks: it is painted word by word between them (paint.ts).
  const still = useReducedMotion();
  const stream = usePainted(chatId, item.text, useTextMode() === "chunks" && !still);
  const thinking = thinkingMode !== "hide" && !!item.thinking;
  return (
    <View style={{ gap: space.md }}>
      {group && !!stream && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <BotAvatar bot={speaker} size={22} state="talking" />
          <T variant="footnote" weight="700" color="ink2" numberOfLines={1}>
            {speaker?.name ?? "Bot"}
          </T>
        </View>
      )}
      <Steps chatId={chatId} runId={item.run?.id} all={item.steps} mode={stepsMode} />
      {thinking && (
        <View style={workWidth}>
          <Aside kind="thinking" text={item.thinking} live />
        </View>
      )}
      {stream && item.reserve ? (
        // Laid out as the reply will be (MessageRow): the empty row is where Read aloud will be, so
        // the text stays where it is when it becomes the reply and the status line becomes the fold line.
        <View style={{ gap: space.sm }}>
          <Markdown text={stream} plain={!markdown} />
          <View style={{ height: READ_ALOUD_ROW }} />
        </View>
      ) : stream ? (
        <Markdown text={stream} plain={!markdown} />
      ) : (
        !item.run && <Typing bot={speaker} intent={intent} />
      )}
    </View>
  );
}
