// While a turn runs, one quiet status line sits directly above the message box: a small pulsing
// accent dot, what the bot is doing (activityLabel or the island's thinking heading), and
// right-aligned tabular time and step count ("34:24 · 328 steps"). A tap opens the turn's activity.
// The clock ticks once a second only while the chat is on screen and the app is in front.
import { router } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, { FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import type { Bot, Run } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { activityLabel, useChatActivity } from "@/state/hooks";
import { useApp } from "@/state/store";
import { space, T, Tap, useOnShow, useTheme } from "@/ui";
import { stepCount } from "./fold";
import { thinkingHeading } from "./islandModel";
import { useElapsedClock } from "./useElapsedClock";

/** Height reserved for the quiet status line directly above the message box while a turn runs. */
export const CAPSULE = 32;

/** "0:42", "12:05", "1:02:09". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? hours + ":" + String(minutes).padStart(2, "0") + ":" + seconds : minutes + ":" + seconds;
}

function StatusDot({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const visible = useOnShow();
  const opacity = useSharedValue(reduced ? 0.9 : 0.45);
  useEffect(() => {
    if (reduced || !visible) {
      opacity.value = 0.9;
      return;
    }
    opacity.value = withRepeat(
      withSequence(withTiming(1, { duration: 750 }), withTiming(0.35, { duration: 750 })),
      -1,
      false,
    );
  }, [reduced, visible, opacity]);
  const anim = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: color }, anim]} />;
}

export function StatusCapsule({ chatId, bot, group, bots, run }: { chatId: string; bot?: Bot; group: boolean; bots: Map<string, Bot>; /** The turn under way, once the computer has started it. */ run?: Run }) {
  const { colors } = useTheme();
  const state = useChatActivity(chatId);
  const thinkingOpen = useChatPrefs((prefs) => prefs.thinking === "show");
  const speakerId = useApp((s) => s.parts.live?.speakers[chatId]);
  const now = useElapsedClock(!!run);
  const face = (group && speakerId ? bots.get(speakerId) : undefined) ?? bot;
  const heading = thinkingOpen ? thinkingHeading(run) : undefined;
  const doing = heading || activityLabel(state) || "Working…";
  const own = run?.steps ?? [];
  const count = stepCount(own.length);
  const facts = [run ? clock(now - run.time) : "", count].filter(Boolean).join(" · ");
  const cleanDoing = doing.replace(/…$/, "");
  const name = face?.name && !group ? face.name + ": " + cleanDoing : cleanDoing;
  return (
    <Animated.View entering={FadeIn.duration(160)} style={{ width: "100%" }}>
      <Tap
        onPress={run ? () => router.push({ pathname: "/chat/activity", params: { chatId, runId: run.id } }) : undefined}
        disabled={!run}
        feel="select"
        sink={0.99}
        accessibilityRole="button"
        accessibilityLabel={name + (facts ? ", " + facts : "") + (run ? ", show activity" : "")}
        style={{ height: CAPSULE, paddingHorizontal: space.md, flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <StatusDot color={state === "waiting" ? colors.warning : colors.accent} />
        <T variant="footnote" color="muted" numberOfLines={1} style={{ flex: 1 }}>
          {doing}
        </T>
        {!!facts && (
          <T variant="caption" color="faint" numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
            {facts}
          </T>
        )}
      </Tap>
    </Animated.View>
  );
}
