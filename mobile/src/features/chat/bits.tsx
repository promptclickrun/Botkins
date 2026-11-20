// Small pieces the chat screens share: step status marks, group avatars, a quiet preview of a
// message, the bot's typing dots, and how far the bot's work keeps from the screen's edge.
import { Ban, Check, Circle, X } from "lucide-react-native";
import { useLayoutEffect } from "react";
import { ActivityIndicator, Animated, Easing, useAnimatedValue, View, type ViewStyle } from "react-native";
import type { Bot, Step } from "@/link/types";
import type { AvatarState } from "@/state/hooks";
import { BotAvatar, space, useOnShow, useTheme } from "@/ui";
import { useReducedMotion } from "@/ui/BotAvatar";

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
  const phase = useAnimatedValue(0);
  useLayoutEffect(() => {
    phase.setValue(0);
    if (still) return;
    const legMs = 320;
    const duration = 2 * legMs + 260;
    const ease = Easing.inOut(Easing.quad);
    const bounce = Animated.loop(Animated.timing(phase, {
      delay, duration, toValue: 2, useNativeDriver: true, isInteraction: false,
      // Phase 0 to 1 rises, 1 to 2 falls, then phase 2 holds until the next iteration.
      easing: (t) => {
        const leg = t * duration / legMs;
        if (leg < 1) return ease(leg) / 2;
        return (1 + ease(Math.min(leg - 1, 1))) / 2;
      },
    }));
    bounce.start();
    return () => bounce.stop();
  }, [delay, phase, still]);
  const inputRange = [0, 1, 2];
  const style = {
    opacity: phase.interpolate({ inputRange, outputRange: [0.35, 1, 0.35] }),
    transform: [{ translateY: phase.interpolate({ inputRange, outputRange: [0, -2.5, 0] }) }],
  };
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
