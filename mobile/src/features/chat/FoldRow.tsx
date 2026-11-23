// A folded turn's work in one line under its reply: the bot's face (held still), "Worked for 52s ·
// 4 steps" and a chevron, over a hairline, the way T3 Code folds a turn. A tap opens the fold in
// place: the bot's interim texts and thinking (as Thinking and updates says), its steps and where
// the person steered or answered, in the order they happened (turn.ts builds it, fold.ts has the
// words), as quiet rows with no card or border. A tap on a step opens it in the turn's activity
// sheet. While a turn runs (in every Steps mode) its status is the glass capsule over the message
// box (StatusCapsule.tsx), and this line is empty room of the same height under the text, so the
// reply stays put when the line appears there as the turn ends. The open folds are kept by turn,
// so a row drawn again keeps its state.
import { router } from "expo-router";
import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react-native";
import { type ComponentRef, memo, useLayoutEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { create } from "zustand";
import type { Bot, Run } from "@/link/types";
import { BotAvatar, space, T, Tap, useTheme } from "@/ui";
import { Aside } from "./Aside";
import { workWidth } from "./bits";
import { type FoldEntry } from "./fold";
import { type Item } from "./turn";
import { FACE, FACE_INDENT, StepLine } from "./WorkRows";

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

/** The fold's contents, in order. Steps next to each other sit together, in the work's column under the face. */
function Body({ chatId, run, entries, bot }: { chatId: string; run: Run; entries: FoldEntry[]; bot?: Bot }) {
  const { colors } = useTheme();
  const runId = run.id;
  const helpers = new Map(run.agents?.map((agent) => [agent.id, agent.name]));
  const groups: FoldEntry[][] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (entry.kind === "step" && last?.[0].kind === "step") last.push(entry);
    else groups.push([entry]);
  }
  return (
    <Animated.View entering={FadeIn.duration(160)} style={{ gap: space.sm, marginTop: space.sm }}>
      {groups.map((group) => {
        const first = group[0];
        if (first.kind === "step")
          return (
            <View key={first.key} style={{ paddingLeft: FACE_INDENT }}>
              {group.map((entry) => entry.kind === "step" && <StepLine key={entry.key} chatId={chatId} runId={runId} step={entry.step} helperName={entry.step.agentId ? helpers.get(entry.step.agentId) : undefined} height={36} />)}
            </View>
          );
        if (first.kind === "thought") return <Aside key={first.key} kind="thinking" text={first.text} bot={bot} />;
        if (first.kind === "person")
          return (
            <View key={first.key} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: FACE_INDENT }} accessible accessibilityLabel={"You: " + first.text}>
              <CornerDownRight size={13} color={colors.faint} strokeWidth={2.2} />
              <T variant="footnote" color="muted" numberOfLines={2} style={{ flexShrink: 1 }}>
                {first.text}
              </T>
            </View>
          );
        return <Aside key={first.key} kind="update" text={first.text} />;
      })}
      <Tap onPress={() => activity(chatId, runId)} feel="select" hitSlop={0} accessibilityLabel="Details, show activity" style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center", paddingLeft: FACE_INDENT }}>
        <T variant="footnote" weight="600" color="accentText">
          Details
        </T>
      </Tap>
    </Animated.View>
  );
}

/** `bot`: whose face leads the line; in a group chat, the turn's last speaker. */
export const FoldRow = memo(function FoldRow({ chatId, bot, group, item, hold }: { chatId: string; bot?: Bot; group: boolean; item: Extract<Item, { kind: "fold" }>; hold?: FoldHold }) {
  const { colors } = useTheme();
  const key = chatId + ":" + item.run.id;
  const open = useOpenFolds((state) => !!state[key]);
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

  // While the turn runs, its status is the capsule over the message box: this is the line's room.
  if (item.live) return <View style={{ height: ROW }} />;
  const words = [item.lead, item.count].filter(Boolean).join(" · ");
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View ref={whole} collapsable={false} style={workWidth}>
      <Tap
        onPress={toggle}
        feel="select"
        sink={0.99}
        hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
        accessibilityLabel={item.line + (open ? ", hide work" : ", show work")}
        accessibilityState={{ expanded: open }}
      >
        <View ref={line} collapsable={false} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: ROW, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }}>
          {(!group || bot) && <BotAvatar bot={bot} size={FACE} animated={false} />}
          <T variant="subhead" color="muted" numberOfLines={1} style={{ flexShrink: 1, fontVariant: ["tabular-nums"] }}>
            {words}
          </T>
          <Chevron size={14} color={colors.faint} strokeWidth={2.4} />
        </View>
      </Tap>
      {open && <Body chatId={chatId} run={item.run} entries={item.entries} bot={bot} />}
    </View>
  );
});
