// The Botkins themselves, for where the app speaks for itself: empty screens, pairing, About.
// Sprig is the one in the logo. A person's own bots are drawn by BotAvatar too.
import { type StyleProp, View, type ViewStyle } from "react-native";
import type { AvatarState } from "@/state/hooks";
import { BotAvatar } from "./BotAvatar";

export type MascotProps = {
  size?: number;
  /** A character from the kit. Sprig unless said otherwise. */
  head?: string;
  palette?: string;
  state?: AvatarState;
  /** Moves and blinks. Off by default: mascots sit on Home and in empty lists, which hold still (owner, 2026-11-24). */
  alive?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Mascot({ size = 96, head = "sprig", palette = "original", state = "idle", alive = false, style }: MascotProps) {
  return (
    <View style={style} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <BotAvatar look={{ head, palette }} state={state} size={size} animated={alive} badge={false} />
    </View>
  );
}

/** The pair from the logo: the big one with its sprout and a small friend beside it. */
export function MascotPair({ size = 120, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: "row", alignItems: "flex-end" }, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <BotAvatar look={{ head: "sprig", palette: "original" }} size={size} badge={false} />
      <BotAvatar look={{ head: "pip", palette: "honey" }} size={size * 0.66} badge={false} style={{ marginLeft: -size * 0.2 }} />
    </View>
  );
}
