// A folded turn's work in one line under its reply ("Worked for 52s · 4 steps ›"). A tap opens the
// fold in place: the bot's interim texts and thinking (as Thinking and updates says), its steps and
// where the person steered or answered, in the order they happened (turn.ts builds it, fold.ts has
// the words). A tap on a step opens it in the turn's activity sheet. While a turn runs (in every
// Steps mode) the same row is its status line under the text: the bot's face in its live state, its
// typing dots, and what it says it is doing or "Working…"; a tap opens the activity, as the work
// itself is in the chat then. Both rows end in the same pill with the step count ("7 steps") and
// are one height, so one becomes the other in place. Neither has a chevron: the row is the button. The open folds are kept by turn, so a row drawn again keeps its state.
import { router } from "expo-router";
import { CornerDownRight } from "lucide-react-native";
import { type ComponentRef, memo, useLayoutEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { create } from "zustand";
import type { Bot, Step } from "@/link/types";
import { useChatActivity } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BotAvatar, radius, space, T, Tap, tint, useTheme } from "@/ui";
import { Aside } from "./Aside";
import { StepMark, TypingDots, workWidth } from "./bits";
import { type FoldEntry, statusLead } from "./fold";
import { type Item, stepLabel } from "./turn";

/** The folds a person opened, by chat and turn. */
const useOpenFolds = create<Record<string, true>>(() => ({}));
function flipFold(key: string) {
  const open = useOpenFolds.getState();
  if (!open[key]) return useOpenFolds.setState({ [key]: true });
  const rest = { ...open };
  delete rest[key];
  useOpenFolds.setState(rest, true);
}

/**
 * Where a fold's line was before it opened or closed, and where its line and its end are now, in
 * the window's points. The chat scrolls by this so the line stays where it was tapped, as far as
 * the fold's end stays in view.
 */
export type FoldHold = (where: { was: number; top: number; bottom: number }) => void;

/** The height of the fold line and of the status line it grows from, so neither moves the reply. */
const ROW = 36;

const activity = (chatId: string, runId: string, stepId?: string) => router.push({ pathname: "/chat/activity", params: stepId ? { chatId, runId, stepId } : { chatId, runId } });

function StepLine({ chatId, runId, step }: { chatId: string; runId: string; step: Step }) {
  const label = stepLabel(step);
  return (
    <Tap onPress={() => activity(chatId, runId, step.id)} feel="select" sink={0.99} hitSlop={0} accessibilityLabel={label + ", " + step.status + ", show in activity"} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 }}>
      <StepMark status={step.status} size={14} />
      <T variant="footnote" color={step.status === "Running" ? "ink" : step.status === "Failed" ? "danger" : "muted"} numberOfLines={1} style={{ flex: 1 }}>
        {label}
      </T>
    </Tap>
  );
}

/** The fold's contents, in order. Steps next to each other sit together as compact rows. */
function Body({ chatId, runId, entries }: { chatId: string; runId: string; entries: FoldEntry[] }) {
  const { colors } = useTheme();
  const groups: FoldEntry[][] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (entry.kind === "step" && last?.[0].kind === "step") last.push(entry);
    else groups.push([entry]);
  }
  return (
    <Animated.View entering={FadeIn.duration(160)} style={{ gap: space.sm, marginTop: space.xs, paddingLeft: space.md, borderLeftWidth: 2, borderLeftColor: colors.lineStrong }}>
      {groups.map((group) => {
        const first = group[0];
        if (first.kind === "step")
          return (
            <View key={first.key}>
              {group.map((entry) => entry.kind === "step" && <StepLine key={entry.key} chatId={chatId} runId={runId} step={entry.step} />)}
            </View>
          );
        if (first.kind === "thought") return <Aside key={first.key} kind="thinking" text={first.text} />;
        if (first.kind === "person")
          return (
            <View key={first.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }} accessible accessibilityLabel={"You: " + first.text}>
              <CornerDownRight size={13} color={colors.faint} strokeWidth={2.2} />
              <T variant="footnote" color="muted" numberOfLines={2} style={{ flexShrink: 1 }}>
                {first.text}
              </T>
            </View>
          );
        return <Aside key={first.key} kind="update" text={first.text} />;
      })}
      <Tap onPress={() => activity(chatId, runId)} feel="select" hitSlop={0} accessibilityLabel="Details, show activity" style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center" }}>
        <T variant="footnote" weight="600" color="accentText">
          Details
        </T>
      </Tap>
    </Animated.View>
  );
}

/** The step count in a thin outline over an almost clear fill, in the theme's ink: the same while the turn runs and after. */
function CountPill({ count }: { count: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexShrink: 0, paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: tint(colors.ink, 0.22), backgroundColor: tint(colors.ink, 0.03) }}>
      <T variant="footnote" color="muted" numberOfLines={1}>
        {count}
      </T>
    </View>
  );
}

/** While a turn runs: the bot's face (the one speaking now, in a group chat), its typing dots and what it is doing. */
function Status({ chatId, bot, group, bots }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot> }) {
  const state = useChatActivity(chatId);
  const intent = useApp((s) => s.parts.live?.intents[chatId]);
  const speakerId = useApp((s) => s.parts.live?.speakers[chatId]);
  const face = (group && speakerId ? bots.get(speakerId) : undefined) ?? bot;
  return (
    <>
      <BotAvatar bot={face} size={32} state={state} />
      <TypingDots status={intent || state} />
      <T variant="footnote" color="muted" numberOfLines={1} style={{ flexShrink: 1, marginLeft: space.xs }}>
        {statusLead(intent)}
      </T>
    </>
  );
}

export const FoldRow = memo(function FoldRow({ chatId, bot, group, bots, item, hold }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot>; item: Extract<Item, { kind: "fold" }>; hold?: FoldHold }) {
  const key = chatId + ":" + item.run.id;
  const open = useOpenFolds((state) => !!state[key]);
  const line = useRef<ComponentRef<typeof View>>(null);
  const whole = useRef<ComponentRef<typeof View>>(null);
  const was = useRef<number | null>(null);

  const toggle = () => {
    // While the turn runs its work is in the chat: the line opens the activity instead.
    if (item.live) return activity(chatId, item.run.id);
    const at = line.current;
    if (!at || !hold) return flipFold(key);
    at.measureInWindow((_x, y) => {
      was.current = y;
      flipFold(key);
    });
  };
  // Once the fold has opened or closed, the chat is told where its line went, before it is painted.
  useLayoutEffect(() => {
    const before = was.current;
    if (before === null || !hold) return;
    was.current = null;
    line.current?.measureInWindow((_x, top) => whole.current?.measureInWindow((_x2, y, _w, height) => hold({ was: before, top, bottom: y + height })));
  }, [open, hold]);

  const opened = open && !item.live;
  return (
    <View ref={whole} collapsable={false} style={workWidth}>
      <Tap
        onPress={toggle}
        feel="select"
        sink={0.99}
        hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
        accessibilityLabel={item.live ? (bot && !group ? bot.name + " is working, " : "Working, ") + (item.count || "no steps yet") + ", show activity" : item.line + (opened ? ", hide work" : ", show work")}
        accessibilityState={item.live ? undefined : { expanded: opened }}
        style={{ alignSelf: "flex-start", maxWidth: "100%" }}
      >
        <View ref={line} collapsable={false} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: ROW }}>
          {item.live ? (
            <Status chatId={chatId} bot={bot} group={group} bots={bots} />
          ) : (
            !!item.lead && (
              <T variant="footnote" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {item.lead}
              </T>
            )
          )}
          {!!item.count && <CountPill count={item.count} />}
        </View>
      </Tap>
      {opened && <Body chatId={chatId} runId={item.run.id} entries={item.entries} />}
    </View>
  );
});
