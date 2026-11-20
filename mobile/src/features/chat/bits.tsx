// Small pieces the chat screens share: step status marks, group avatars, a quiet preview of a message.
import { Check, Circle, X } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";
import type { Bot, Step } from "@/link/types";
import type { AvatarState } from "@/state/hooks";
import { BotAvatar, useTheme } from "@/ui";

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
