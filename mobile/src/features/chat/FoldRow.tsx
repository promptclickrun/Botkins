// A folded turn's work in one line under its reply ("Worked for 52s · 4 steps ›"), or, while the
// turn runs, the bot's live face and what it is doing now. A tap opens the fold in place: the bot's
// interim texts, its thinking, its steps and where the person steered or answered, in the order
// they happened (turn.ts builds it, fold.ts has the words). A tap on a step opens it in the
// turn's activity sheet. The open folds are kept by turn, so a row drawn again keeps its state.
import { router } from "expo-router";
import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react-native";
import { type ComponentRef, memo, useLayoutEffect, useRef } from "react";
import { View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { create } from "zustand";
import type { Bot, Step } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { useChatActivity } from "@/state/hooks";
import { useApp } from "@/state/store";
import { BotAvatar, Markdown, space, T, Tap, useTheme } from "@/ui";
import { StepMark } from "./bits";
import type { FoldEntry } from "./fold";
import { Thinking } from "./LiveTurn";
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
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const thinking = useChatPrefs((prefs) => prefs.thinking);
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
        if (first.kind === "thought") return <Thinking key={first.key} text={first.text} startOpen={thinking === "show"} />;
        if (first.kind === "person")
          return (
            <View key={first.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }} accessible accessibilityLabel={"You: " + first.text}>
              <CornerDownRight size={13} color={colors.faint} strokeWidth={2.2} />
              <T variant="footnote" color="muted" numberOfLines={2} style={{ flexShrink: 1 }}>
                {first.text}
              </T>
            </View>
          );
        return <Markdown key={first.key} text={first.text} size="small" color={colors.ink2} plain={!markdown} />;
      })}
      <Tap onPress={() => activity(chatId, runId)} feel="select" hitSlop={0} accessibilityLabel="Details, show activity" style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center" }}>
        <T variant="footnote" weight="600" color="accentText">
          Details
        </T>
      </Tap>
    </Animated.View>
  );
}

export const FoldRow = memo(function FoldRow({ chatId, bot, group, bots, item, hold }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot>; item: Extract<Item, { kind: "fold" }>; hold?: FoldHold }) {
  const { colors } = useTheme();
  const key = chatId + ":" + item.run.id;
  const open = useOpenFolds((state) => !!state[key]);
  // "Failed only" says so in the danger color, as its work line did.
  const failedOnly = useChatPrefs((prefs) => prefs.steps === "failed");
  const failed = failedOnly && !item.live && item.entries.some((entry) => entry.kind === "step" && entry.step.status === "Failed");
  const state = useChatActivity(chatId);
  const speakerId = useApp((s) => s.parts.live?.speakers[chatId]);
  const face = (group && speakerId ? bots.get(speakerId) : undefined) ?? bot;
  const line = useRef<ComponentRef<typeof View>>(null);
  const whole = useRef<ComponentRef<typeof View>>(null);
  const was = useRef<number | null>(null);

  const toggle = () => {
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

  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View ref={whole} collapsable={false}>
      <Tap
        onPress={toggle}
        feel="select"
        sink={0.99}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel={item.line + (open ? ", hide work" : ", show work")}
        accessibilityState={{ expanded: open }}
        style={{ alignSelf: "flex-start", maxWidth: "100%" }}
      >
        <View ref={line} collapsable={false} style={{ flexDirection: "row", alignItems: "center", gap: item.live ? space.sm : 2, minHeight: 32 }}>
          {item.live && <BotAvatar bot={face} size={22} state={state} />}
          <T variant="footnote" color={failed ? "danger" : "muted"} numberOfLines={1} style={{ flexShrink: 1 }}>
            {item.line}
          </T>
          <Chevron size={14} color={colors.faint} strokeWidth={2.4} />
        </View>
      </Tap>
      {open && <Body chatId={chatId} runId={item.run.id} entries={item.entries} />}
    </View>
  );
});
