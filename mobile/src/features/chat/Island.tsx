// The island: Steps and Thinking set to Open (islandModel.ts has the rules and the words). While a turn
// runs it is one small card under the turn's newest text: the bot's face in a working ring, "<Bot> is
// working" (or the heading of the thought it is on) with the shimmer, the time and step count, and a
// window of the newest 4 lines whose oldest fades out at the top. With Thinking Open alone, the
// window is the last 3 lines of the reasoning. A tap on the header lists every line in the card,
// scrolling and held at the newest; a tap on a row opens that step in the turn's activity sheet.
// While a step waits for the person the card turns amber ("<Bot> needs you"), stops shimmering and
// its clock pauses; the request itself stays docked above the message box. Once the turn ends, the
// island folds into its receipt under the answer ("✓ Worked 42s · 9 steps ›"), which opens the same
// list in place.
//
// Battery: the only timer is the shared 1-second clock (useElapsedClock), and only while the card is
// in view, the chat on screen and the app in front. The shimmer is the header's alone (Shimmer.tsx,
// native driver); the running row is drawn in ink, still. New lines rise in with Reanimated layout
// animations on the UI thread, which follow the phone's Reduce Motion.
import { router } from "expo-router";
import { Brain, Check, ChevronDown, ChevronRight, ChevronUp, Hand, X } from "lucide-react-native";
import { type ComponentRef, memo, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { FadeInDown, LayoutAnimationConfig, LinearTransition, ReduceMotion } from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { create } from "zustand";
import type { Bot, Run, Step } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { useApp } from "@/state/store";
import { duration } from "@/state/time";
import { BotAvatar, T, Tap, tint, useTheme } from "@/ui";
import { Shimmer } from "@/ui/Shimmer";
import type { FoldHold } from "./FoldRow";
import { type IslandLine, islandFacts, islandLabel, islandLines, islandWindow, reasoningTail, REASONING_LINES, thinkingHeading, thoughtParts } from "./islandModel";
import type { Item } from "./turn";
import { stepLabel } from "./turn";
import { useElapsedClock } from "./useElapsedClock";
import { stepIcon } from "./WorkRows";

// The mockup's measures (board.css, .island).
const RADIUS = 22;
const PAD = 10;
const HEAD = 44;
const ROW = 28;
const LIST_ROW = 40;
const FACE = 22;
/** The expanded list's height at most (the mockup's 352 points), and never more than this share of the screen. */
const LIST_MAX = 352;
const LIST_SHARE = 0.45;

const rise = FadeInDown.duration(220).reduceMotion(ReduceMotion.System);
const slide = LinearTransition.duration(200).reduceMotion(ReduceMotion.System);

/** The islands a person opened, by chat, turn and whether it ran: a live list closes when its turn folds into the receipt. */
const useOpenIslands = create<Record<string, true>>(() => ({}));
function flip(key: string) {
  const open = useOpenIslands.getState();
  if (!open[key]) return useOpenIslands.setState({ [key]: true });
  const rest = { ...open };
  delete rest[key];
  useOpenIslands.setState(rest, true);
}

type Wait = { kind: "wait"; key: string; text: string };
type Line = IslandLine | Wait;

const openStep = (chatId: string, runId: string, stepId?: string) => router.push({ pathname: "/chat/activity", params: stepId ? { chatId, runId, stepId } : { chatId, runId } });

/** The top of a clipped window fades into the card: the oldest line goes out there. */
function TopFade({ color, height }: { color: string; height: number }) {
  const id = "island-fade-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height }}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0.86} />
            <Stop offset="0.5" stopColor={color} stopOpacity={0.45} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/** The bot's face, still, inside a soft working ring; while it waits on the person, a hand. */
function Face({ bot, waiting, done }: { bot?: Bot; waiting: boolean; done: boolean }) {
  const { colors } = useTheme();
  if (done)
    return (
      <View style={{ width: FACE, height: FACE, borderRadius: FACE / 2, backgroundColor: colors.successSoft, alignItems: "center", justifyContent: "center" }}>
        <Check size={13} color={colors.success} strokeWidth={3} />
      </View>
    );
  if (waiting)
    return (
      <View style={{ width: FACE, height: FACE, borderRadius: FACE / 2, backgroundColor: colors.warningSoft, alignItems: "center", justifyContent: "center" }}>
        <Hand size={13} color={colors.warning} strokeWidth={2.4} />
      </View>
    );
  return (
    <View style={{ width: FACE, height: FACE, marginHorizontal: 2 }}>
      <BotAvatar bot={bot} size={FACE} state="thinking" animated={false} />
      <View
        pointerEvents="none"
        style={{ position: "absolute", top: -3, left: -3, right: -3, bottom: -3, borderRadius: (FACE + 6) / 2, borderWidth: 2, borderColor: colors.accentSoft, borderTopColor: colors.accent, borderRightColor: colors.accent, transform: [{ rotate: "-20deg" }] }}
      />
    </View>
  );
}

/** One line: a step (icon and label; the running one in ink with "…"; the one waiting on the person in amber) or a thought (heading, then a fainter snippet). */
const LineRow = memo(function LineRow({ line, waitingStepId, list, helperName }: { line: Line; waitingStepId?: string; list: boolean; helperName?: string }) {
  const { colors } = useTheme();
  const height = list ? LIST_ROW : ROW;
  if (line.kind === "wait")
    return (
      <View accessible accessibilityLabel={"Waiting for you: " + line.text} style={{ height, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: FACE, alignItems: "center" }}>
          <Hand size={14} color={colors.warning} strokeWidth={2.2} />
        </View>
        <T variant="subhead" weight="500" color="warning" numberOfLines={1} style={{ flex: 1 }}>
          {"Waiting for you: " + line.text}
        </T>
      </View>
    );
  if (line.kind === "thought")
    return (
      <View accessible accessibilityLabel={"Thought: " + line.heading + (line.snippet ? ". " + line.snippet : "")} style={{ height, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: FACE, alignItems: "center" }}>
          <Brain size={14} color={colors.muted} strokeWidth={2.2} />
        </View>
        <T variant="subhead" color="muted" numberOfLines={1} style={{ flex: 1 }}>
          {line.heading}
          {!!line.snippet && <T variant="subhead" color="faint">{" · " + line.snippet}</T>}
        </T>
        {list && <ChevronRight size={12} color={colors.faint} strokeWidth={2.6} />}
      </View>
    );
  const step = line.step;
  const Icon = stepIcon(step);
  const running = step.status === "Running";
  const failed = step.status === "Failed";
  const waits = running && step.id === waitingStepId;
  const label = (helperName ? helperName + ": " : "") + stepLabel(step);
  const took = list && step.finished ? duration(step.finished - step.started) : undefined;
  const ink = waits ? "warning" : running ? "ink" : "muted";
  return (
    <View accessible accessibilityLabel={(waits ? "Waiting for you: " : "") + label + ", " + step.status.toLowerCase()} style={{ height, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: FACE, alignItems: "center" }}>
        {waits ? <Hand size={14} color={colors.warning} strokeWidth={2.2} /> : <Icon size={14} color={failed ? colors.danger : running ? colors.ink : colors.muted} strokeWidth={2.2} />}
      </View>
      <T variant="subhead" weight={running ? "500" : undefined} color={ink} numberOfLines={1} style={{ flex: 1 }}>
        {(waits ? "Waiting for you: " : "") + label + (running && !waits ? "…" : "")}
      </T>
      {failed && <X size={12} color={colors.danger} strokeWidth={2.6} />}
      {!!took && (
        <T variant="caption" weight="400" color="faint" style={{ fontVariant: ["tabular-nums"] }}>
          {took}
        </T>
      )}
      {list && <ChevronRight size={12} color={colors.faint} strokeWidth={2.6} />}
    </View>
  );
});

/** Every line of the turn, scrolling, held at the newest unless the person scrolled up; then "Show less". */
function FullList({ chatId, run, lines, waitingStepId, onLess }: { chatId: string; run: Run; lines: Line[]; waitingStepId?: string; onLess: () => void }) {
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const pinned = useRef(true);
  const helpers = useMemo(() => new Map(run.agents?.map((agent) => [agent.id, agent.name])), [run.agents]);
  const most = Math.min(LIST_MAX, height * LIST_SHARE);
  // Longer than the card: the list scrolls, and its top edge fades (the mockup's .list::before).
  const [scrolls, setScrolls] = useState(false);
  const onScroll = ({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }: NativeSyntheticEvent<NativeScrollEvent>) => {
    pinned.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - LIST_ROW / 2;
  };
  return (
    <View style={{ marginHorizontal: -PAD, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
      <ScrollView
        ref={scroller}
        style={{ maxHeight: most }}
        contentContainerStyle={{ paddingVertical: 4, paddingLeft: PAD, paddingRight: PAD + 4 }}
        onContentSizeChange={(_w, contentHeight) => {
          setScrolls(contentHeight > most);
          if (pinned.current) scroller.current?.scrollToEnd({ animated: false });
        }}
        onScroll={onScroll}
        scrollEventThrottle={100}
        nestedScrollEnabled
        accessibilityLabel="Every step"
      >
        {lines.map((line) => (
          <Tap
            key={line.key}
            onPress={() => openStep(chatId, run.id, line.kind === "step" ? line.step.id : undefined)}
            feel="select"
            sink={0.99}
            hitSlop={0}
            accessibilityHint="Opens its details"
          >
            <LineRow line={line} waitingStepId={waitingStepId} list helperName={line.kind === "step" && line.step.agentId ? helpers.get(line.step.agentId) : undefined} />
          </Tap>
        ))}
      </ScrollView>
      {scrolls && <TopFade color={colors.surface} height={28} />}
      <Tap onPress={onLess} feel="select" sink={0.99} hitSlop={0} accessibilityLabel="Show less" style={{ height: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
        <ChevronUp size={14} color={colors.muted} strokeWidth={2.4} />
        <T variant="footnote" weight="600" color="muted">
          Show less
        </T>
      </Tap>
    </View>
  );
}

/** The card itself: header, then the window or the full list. */
function Card({ children, waiting, header }: { children?: ReactNode; waiting: boolean; header: ReactNode }) {
  const { colors, dark } = useTheme();
  return (
    <View
      style={{
        maxWidth: 600,
        backgroundColor: colors.surface,
        borderRadius: RADIUS,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: waiting ? tint(colors.warning, 0.4) : colors.line,
        paddingHorizontal: PAD,
        // Light: a soft shadow. Dark: one step lighter than the page with a hairline, and no shadow.
        ...(!dark && { shadowColor: colors.shadow, shadowOpacity: 0.12, shadowRadius: 11, shadowOffset: { width: 0, height: 6 } }),
      }}
    >
      {header}
      {children}
    </View>
  );
}

function Header({ label, facts, open, onPress, face, shimmer, tone, hint }: { label: string; facts: string; open: boolean; onPress: () => void; face: ReactNode; shimmer: boolean; tone: "warning" | "muted" | "ink"; hint: string }) {
  const { colors } = useTheme();
  const Chevron = open ? ChevronDown : ChevronRight;
  const words = (color: string) => (
    <T variant="subhead" weight="600" color={color} numberOfLines={1}>
      {label}
    </T>
  );
  return (
    <Tap onPress={onPress} feel="select" sink={0.99} hitSlop={0} accessibilityLabel={label + (facts ? ", " + facts : "")} accessibilityHint={hint} accessibilityState={{ expanded: open }} style={{ minHeight: HEAD, flexDirection: "row", alignItems: "center", gap: 8 }}>
      {face}
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Shimmer on={shimmer} lit={words("ink")}>
          {words(shimmer ? "faint" : tone)}
        </Shimmer>
      </View>
      <T variant="footnote" color="faint" numberOfLines={1} style={{ marginLeft: "auto", paddingLeft: 8, fontVariant: ["tabular-nums"] }}>
        {facts}
      </T>
      <Chevron size={14} color={colors.faint} strokeWidth={2.4} />
    </Tap>
  );
}

/** Keep the header where it was tapped when the card opens or closes (FoldRow's way). */
function useHold(hold: FoldHold | undefined, open: boolean) {
  const head = useRef<ComponentRef<typeof View>>(null);
  const whole = useRef<ComponentRef<typeof View>>(null);
  const was = useRef<number | null>(null);
  useLayoutEffect(() => {
    const before = was.current;
    if (before === null || !hold) return;
    was.current = null;
    head.current?.measureInWindow((_x, top) => whole.current?.measureInWindow((_x2, y, _w, height) => hold({ was: before, top, bottom: y + height })));
  }, [open, hold]);
  const toggle = (key: string) => {
    const at = head.current;
    if (!at || !hold) return flip(key);
    at.measureInWindow((_x, y) => {
      was.current = y;
      flip(key);
    });
  };
  return { head, whole, toggle };
}

/** Only the header needs to read the clock while this turn is on screen. */
function LiveHeader({ bot, label, time, count, inView, waiting, open, onPress }: {
  bot?: Bot; label: string; time: number; count: number; inView: boolean; waiting: boolean; open: boolean; onPress: () => void;
}) {
  const [pausedAt, setPausedAt] = useState<number>();
  useEffect(() => {
    if (waiting && pausedAt === undefined) setPausedAt(Date.now());
    if (!waiting && pausedAt !== undefined) setPausedAt(undefined);
  }, [waiting, pausedAt]);
  const now = useElapsedClock(inView && !waiting);
  const facts = islandFacts((waiting ? pausedAt ?? now : now) - time, count);
  return <Header label={label} facts={facts} open={open} onPress={onPress} face={<Face bot={bot} waiting={waiting} done={false} />} shimmer={!waiting && inView} tone={waiting ? "warning" : "ink"} hint={open ? "Shows less" : "Shows every step"} />;
}

/** The island while its turn runs. */
function LiveIsland({ chatId, bot, group, run, inView, hold, onHeight }: { chatId: string; bot?: Bot; group: boolean; run: Run; inView: boolean; hold?: FoldHold; onHeight?: (height: number) => void }) {
  const { colors, type } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stepsOpen = useChatPrefs((prefs) => prefs.steps === "show");
  const thinking = useChatPrefs((prefs) => prefs.thinking);
  const thinkingOpen = thinking === "show";
  const key = chatId + ":" + run.id + ":live";
  const open = useOpenIslands((state) => !!state[key]);
  const { head, whole, toggle } = useHold(hold, open);
  // A request of this chat waits on the person: amber, still, the clock paused.
  const request = useApp((state) => state.parts.live?.requests?.find((entry) => entry.chatId === chatId)?.title);
  const waiting = request !== undefined;
  const steps = run.steps;
  const reasoning = run.reasoning;
  const waitingStepId = waiting ? steps?.findLast((step) => step.status === "Running")?.id : undefined;
  const wait: Wait | undefined = waiting && !waitingStepId ? { kind: "wait", key: "wait", text: request || "an answer" } : undefined;
  // Build only the list or preview the person opened.
  const shown = useMemo(() => {
    if (open || (!stepsOpen && thinkingOpen)) return undefined;
    const lines: Line[] = islandLines({ steps, reasoning }, { steps: stepsOpen, thoughts: thinkingOpen });
    return islandWindow(wait ? [...lines, wait] : lines);
  }, [open, steps, reasoning, stepsOpen, thinkingOpen, wait?.text]);
  const every = useMemo(() => {
    if (!open) return [];
    const lines: Line[] = islandLines({ steps, reasoning }, { steps: true, thoughts: thinking !== "hide" });
    return wait ? [...lines, wait] : lines;
  }, [open, steps, reasoning, thinking, wait?.text]);
  const tail = useMemo(() => (!open && !stepsOpen && thinkingOpen ? reasoningTail(reasoning) : undefined), [open, stepsOpen, thinkingOpen, reasoning]);
  const label = islandLabel({ name: group ? undefined : bot?.name, waiting, heading: thinkingOpen ? thinkingHeading({ steps, reasoning }) : undefined });
  const helpers = useMemo(() => new Map(run.agents?.map((agent) => [agent.id, agent.name])), [run.agents]);
  const lineHeight = Math.round(type.footnote.lineHeight * Math.min(fontScale, 1.35));

  return (
    <View ref={whole} collapsable={false} accessibilityLiveRegion="polite" onLayout={onHeight && ((event) => onHeight(event.nativeEvent.layout.height))}>
      <Card
        waiting={waiting}
        header={
          <View ref={head} collapsable={false}>
            <LiveHeader bot={bot} label={label} time={run.time} count={steps?.length ?? 0} inView={inView} waiting={waiting} open={open} onPress={() => toggle(key)} />
          </View>
        }
      >
        {open ? (
          <FullList chatId={chatId} run={run} lines={every} waitingStepId={waitingStepId} onLess={() => toggle(key)} />
        ) : tail ? (
          !!tail.text && (
            // The text hangs from the bottom of a 3-line box, so its last lines show and older ones go out at the top.
            // (Laid out in the flow, iOS would measure it to the box's height and cut the newest line instead.)
            <View style={{ height: lineHeight * REASONING_LINES, overflow: "hidden", marginBottom: 8 }}>
              <Text maxFontSizeMultiplier={1.35} style={[type.footnote, { color: colors.muted, position: "absolute", left: FACE + 8, right: 6, bottom: 0 }]} accessibilityLabel={"Thinking: " + tail.text}>
                {tail.text}
                {!waiting && <Text style={{ color: colors.accent }}>{" ●"}</Text>}
              </Text>
              {tail.clipped && <TopFade color={colors.surface} height={lineHeight + 6} />}
            </View>
          )
        ) : (
          shown && shown.lines.length > 0 && (
            <View style={{ paddingBottom: 8 }}>
              <LayoutAnimationConfig skipEntering>
                {shown.lines.map((line) => (
                  <Animated.View key={line.key} entering={rise} layout={slide}>
                    <LineRow line={line} waitingStepId={waitingStepId} list={false} helperName={line.kind === "step" && line.step.agentId ? helpers.get(line.step.agentId) : undefined} />
                  </Animated.View>
                ))}
              </LayoutAnimationConfig>
              {shown.clipped && <TopFade color={colors.surface} height={ROW + 6} />}
            </View>
          )
        )}
      </Card>
    </View>
  );
}

/** A finished turn: the receipt under its answer, which opens the full list in place. */
function Receipt({ chatId, run, line, entries, hold }: { chatId: string; run: Run; line: string; entries: Extract<Item, { kind: "fold" }>["entries"]; hold?: FoldHold }) {
  const { colors } = useTheme();
  const key = chatId + ":" + run.id + ":done";
  const open = useOpenIslands((state) => !!state[key]);
  const { head, whole, toggle } = useHold(hold, open);
  const lines = useMemo(
    () => open ? entries.flatMap((entry): Line[] =>
        entry.kind === "step"
          ? [{ kind: "step", key: entry.key, step: entry.step as Step }]
          : entry.kind === "thought"
            ? [{ kind: "thought", key: entry.key, id: entry.key, ...thoughtParts(entry.text) }]
            : [],
      ) : [],
    [open, entries],
  );
  if (!open)
    return (
      <View ref={whole} collapsable={false} style={{ marginTop: -8 }}>
        <Tap onPress={() => toggle(key)} feel="select" sink={0.97} accessibilityLabel={line} accessibilityHint="Shows every step" accessibilityState={{ expanded: false }} style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center" }}>
          <View ref={head} collapsable={false} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingLeft: 8, paddingRight: 10, borderRadius: 14, backgroundColor: colors.sunken }}>
            <Check size={13} color={colors.success} strokeWidth={3} />
            <T variant="footnote" color="muted" numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
              {line}
            </T>
            <ChevronRight size={12} color={colors.faint} strokeWidth={2.8} />
          </View>
        </Tap>
      </View>
    );
  return (
    <View ref={whole} collapsable={false}>
      <Card
        waiting={false}
        header={
          <View ref={head} collapsable={false}>
            <Header label={line} facts="" open onPress={() => toggle(key)} face={<Face waiting={false} done />} shimmer={false} tone="muted" hint="Shows less" />
          </View>
        }
      >
        <FullList chatId={chatId} run={run} lines={lines} onLess={() => toggle(key)} />
      </Card>
    </View>
  );
}

/**
 * The fold row's place with the island on (TurnPrefs.island): the island while the turn runs, its
 * receipt once it ended. `inView`: the row is on screen, so its clock may tick.
 */
export const Island = memo(function Island({ chatId, bot, group, item, inView, hold, onHeight }: { chatId: string; bot?: Bot; group: boolean; item: Extract<Item, { kind: "fold" }>; inView: boolean; hold?: FoldHold; /** The live island reports its height, so the screen knows when it is under the message box. */ onHeight?: (height: number) => void }) {
  // The turn under way as it is now (steps and growing thoughts); the row's own copy can be a moment old.
  const latest = useApp((state) => (item.live && state.running[chatId]?.id === item.run.id ? state.running[chatId] : undefined));
  if (item.live) return <LiveIsland chatId={chatId} bot={bot} group={group} run={latest ?? item.run} inView={inView} hold={hold} onHeight={onHeight} />;
  return <Receipt chatId={chatId} run={item.run} line={item.line} entries={item.entries} hold={hold} />;
});
