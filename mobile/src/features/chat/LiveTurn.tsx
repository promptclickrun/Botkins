// The turn a bot is working on now: its steps, its thinking, and the reply as it streams in.
// What shows follows the chat settings (Settings › Chat): steps and thinking can be summarized,
// narrowed or hidden. Requests and errors are shown elsewhere and always show.
import { router } from "expo-router";
import { Brain, ChevronDown, ChevronRight } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import type { Bot } from "@/link/types";
import { type ChatPrefs, useChatPrefs } from "@/state/chatPrefs";
import { useApp } from "@/state/store";
import { BotAvatar, Markdown, radius, space, T, Tap, useOnShow, useTheme } from "@/ui";
import { StepMark } from "./bits";

const SHOWN_STEPS = 4;

function Dot({ delay }: { delay: number }) {
  const { colors } = useTheme();
  const seen = useOnShow();
  const still = useReducedMotion() || !seen;
  const lift = useSharedValue(0);
  useEffect(() => {
    if (still) {
      cancelAnimation(lift);
      lift.value = 0;
      return;
    }
    lift.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 320 }), withTiming(0, { duration: 320 }), withTiming(0, { duration: 260 })), -1));
    return () => cancelAnimation(lift);
  }, [delay, lift, still]);
  const style = useAnimatedStyle(() => ({ opacity: 0.35 + lift.value * 0.65, transform: [{ translateY: -lift.value * 2.5 }] }));
  return <Animated.View style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.muted }, style]} />;
}

function Typing({ bot, intent }: { bot?: Bot; intent?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 36 }} accessibilityLabel={(bot?.name ?? "The bot") + " is thinking" + (intent ? ", " + intent : "")} accessibilityLiveRegion="polite">
      <BotAvatar bot={bot} size={32} state="thinking" />
      <View style={{ flexDirection: "row", gap: 4, paddingTop: 2 }}>
        <Dot delay={0} />
        <Dot delay={150} />
        <Dot delay={300} />
      </View>
      {!!intent && (
        <T variant="subhead" color="muted" numberOfLines={1} style={{ flex: 1 }}>
          {intent}
        </T>
      )}
    </View>
  );
}

function Thinking({ text, startOpen }: { text: string; startOpen: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(startOpen);
  const tail = text.length > 260 ? "…" + text.slice(-260).trimStart() : text;
  return (
    <Tap onPress={() => setOpen(!open)} feel="select" sink={0.99} accessibilityLabel={open ? "Hide thinking" : "Show thinking"} accessibilityState={{ expanded: open }} style={{ gap: 6, paddingLeft: space.md, borderLeftWidth: 2, borderLeftColor: colors.lineStrong }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Brain size={14} color={colors.muted} strokeWidth={2.2} />
        <T variant="footnote" weight="600" color="muted">
          Thinking…
        </T>
        {open ? <ChevronDown size={14} color={colors.faint} strokeWidth={2.4} /> : <ChevronRight size={14} color={colors.faint} strokeWidth={2.4} />}
      </View>
      <T variant="footnote" color="muted" numberOfLines={open ? undefined : 3} ellipsizeMode="head" style={{ fontStyle: "italic" }}>
        {open ? text : tail}
      </T>
    </Tap>
  );
}

function Steps({ chatId, mode }: { chatId: string; mode: ChatPrefs["steps"] }) {
  const { colors } = useTheme();
  const run = useApp((state) => state.running[chatId]);
  const all = run?.steps ?? [];
  if (!run || all.length === 0 || mode === "hide") return null;
  const steps = mode === "failed" ? all.filter((step) => step.status === "Failed") : all;
  if (steps.length === 0) return null;
  const open = () => router.push({ pathname: "/chat/activity", params: { chatId, runId: run.id } });
  const count = all.length === 1 ? "1 step" : all.length + " steps";

  if (mode === "summary") {
    const current = [...all].reverse().find((step) => step.status === "Running") ?? all[all.length - 1];
    return (
      <Tap onPress={open} feel="select" sink={0.99} accessibilityLabel={"Working, " + count + ", show activity"} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
        <StepMark status={current.status} size={14} />
        <T variant="footnote" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
          {(current.label || current.name) + " · " + count}
        </T>
        <ChevronRight size={14} color={colors.faint} strokeWidth={2.4} />
      </Tap>
    );
  }

  const hidden = Math.max(0, steps.length - SHOWN_STEPS);
  return (
    <Tap
      onPress={open}
      feel="select"
      sink={0.99}
      accessibilityLabel={(mode === "failed" ? steps.length + " failed of " : "Working, ") + count + ", show activity"}
      style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 }}
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
            {step.label || step.name}
          </T>
        </View>
      ))}
    </Tap>
  );
}

/** Everything the bot is doing in this chat right now. Rendered only while a reply is under way. */
export function LiveTurn({ chatId, bot, group, bots }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot> }) {
  const stream = useApp((state) => state.parts.live?.streams[chatId]) ?? "";
  const thinking = useApp((state) => state.parts.live?.thinking[chatId]);
  const intent = useApp((state) => state.parts.live?.intents[chatId]);
  const speakerId = useApp((state) => state.parts.live?.speakers[chatId]);
  const stepsMode = useChatPrefs((prefs) => prefs.steps);
  const thinkingMode = useChatPrefs((prefs) => prefs.thinking);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const speaker = (speakerId ? bots.get(speakerId) : undefined) ?? bot;
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
      <Steps chatId={chatId} mode={stepsMode} />
      {thinkingMode !== "hide" && !!thinking && <Thinking text={thinking} startOpen={thinkingMode === "show"} />}
      {stream ? <Markdown text={stream} plain={!markdown} /> : <Typing bot={speaker} intent={intent} />}
    </View>
  );
}
