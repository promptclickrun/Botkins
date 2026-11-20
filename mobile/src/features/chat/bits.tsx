// Small pieces the chat screens share: step status marks, group avatars, a quiet preview of a
// message, the bot's typing dots, and how far the bot's work keeps from the screen's edge.
import { Ban, Check, Circle, X } from "lucide-react-native";
import { useEffect } from "react";
import { ActivityIndicator, View, type ViewStyle } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import type { Bot, Step } from "@/link/types";
import type { AvatarState } from "@/state/hooks";
import { BotAvatar, space, useOnShow, useTheme } from "@/ui";

/**
 * The bot's work (steps, thinking, updates, fold and status lines) keeps away from the trailing
 * edge as the person's bubbles keep away from the leading one, and never stretches past 600 points
 * on a wide screen. Its leading edge stays with the reply's text; the reply itself keeps the full width.
 */
export const workWidth: ViewStyle = { maxWidth: 600, marginRight: space.huge + space.lg };

function Dot({ delay }: { delay: number }) {
  const { colors } = useTheme();
  // Only a dot that can be seen moves (useOnShow), and Reduce Motion stills it.
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

/** Three dots that bounce in turn while the bot works. */
export function TypingDots() {
  return (
    <View style={{ flexDirection: "row", gap: 4, paddingTop: 2 }}>
      <Dot delay={0} />
      <Dot delay={150} />
      <Dot delay={300} />
    </View>
  );
}

/** Markdown symbols out of a one-line preview: "**Done.** See `x`" → "Done. See x". */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A step's state as a small mark: a spinner while running, a check when done, a cross when it failed. */
export function StepMark({ status, size = 16 }: { status: Step["status"]; size?: number }) {
  const { colors } = useTheme();
  const box = { width: size + 4, height: size + 4, alignItems: "center", justifyContent: "center" } as const;
  if (status === "Running")
    return (
      <View style={box} accessibilityLabel="Running">
        <ActivityIndicator size="small" color={colors.muted} style={{ transform: [{ scale: size / 20 }] }} />
      </View>
    );
  if (status === "Done")
    return (
      <View style={box} accessibilityLabel="Done">
        <Check size={size} color={colors.success} strokeWidth={2.6} />
      </View>
    );
  if (status === "Failed")
    return (
      <View style={box} accessibilityLabel="Failed">
        <X size={size} color={colors.danger} strokeWidth={2.6} />
      </View>
    );
  if (status === "Stopped")
    return (
      <View style={box} accessibilityLabel="Stopped">
        <Ban size={size} color={colors.muted} strokeWidth={2.4} />
      </View>
    );
  return (
    <View style={box} accessibilityLabel={status}>
      <Circle size={size - 4} color={colors.faint} strokeWidth={2.4} />
    </View>
  );
}

/** Two bots, the second just behind the first: a group chat's face. Bare figures, no tiles. */
export function GroupFace({ bots, size, state = "idle" }: { bots: (Bot | undefined)[]; size: number; state?: AvatarState }) {
  const small = Math.round(size * 0.7);
  const [first, second] = bots;
  return (
    <View style={{ width: size, height: size }}>
      <BotAvatar bot={second} size={small} style={{ position: "absolute", right: 0, top: 0 }} />
      <BotAvatar bot={first} size={small} state={state} style={{ position: "absolute", left: 0, bottom: 0 }} />
    </View>
  );
}
