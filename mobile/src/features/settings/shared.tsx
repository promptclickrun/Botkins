// Small pieces the settings pages share: the link's status in words, a radio row, a labeled value.
import { Check, type LucideIcon } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import type { LinkRoute, LinkState } from "@/link/client";
import type { AvatarState } from "@/state/hooks";
import { attempt } from "@/state/link";
import { radius, space, T, Tap, type Tone, useTheme } from "@/ui";

export const LINK_STATUS: Record<LinkState, { label: string; tone: Tone; mascot: AvatarState }> = {
  online: { label: "Connected", tone: "success", mascot: "idle" },
  connecting: { label: "Connecting…", tone: "info", mascot: "pending" },
  offline: { label: "Can't be reached", tone: "warning", mascot: "sad" },
  revoked: { label: "Removed from this computer", tone: "danger", mascot: "sad" },
};

/** The link's status in words; "Connected" says when it is through the relay. */
export const linkLabel = (link: LinkState, route: LinkRoute | null) => (link === "online" && route === "relay" ? "Connected, away from your network" : LINK_STATUS[link].label);

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One choice of several, with a round check on the chosen one. */
export function ChoiceRow({ title, subtitle, selected, onPress, warning, icon: Icon }: { title: string; subtitle?: string; selected: boolean; onPress: () => void; warning?: boolean; icon?: LucideIcon }) {
  const { colors } = useTheme();
  return (
    <Tap
      onPress={onPress}
      sink={1}
      feel="select"
      hitSlop={0}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={subtitle ? title + ", " + subtitle : title}
      style={{ minHeight: 60, paddingHorizontal: space.lg, paddingVertical: 11, flexDirection: "row", alignItems: "center", gap: space.md }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" weight={selected ? "600" : "500"} numberOfLines={1}>
          {title}
        </T>
        {!!subtitle && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            {Icon && <Icon size={13} color={warning ? colors.warning : colors.muted} strokeWidth={2.4} />}
            <T variant="footnote" color={warning ? "warning" : "muted"} weight={warning ? "600" : undefined} numberOfLines={1} style={{ flexShrink: 1 }}>
              {subtitle}
            </T>
          </View>
        )}
      </View>
      <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: selected ? 0 : 1.5, borderColor: colors.lineStrong, backgroundColor: selected ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
        {selected && <Check size={15} color={colors.onAccent} strokeWidth={3} />}
      </View>
    </Tap>
  );
}

/** A label on the left and a value under or beside it, for facts that are read, not tapped. */
export function InfoRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ minHeight: 54, paddingHorizontal: space.lg, paddingVertical: 12, gap: 3 }} accessible>
      <T variant="footnote" color="muted">
        {title}
      </T>
      {children}
    </View>
  );
}

/** A soft card, for a metric or a preview. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return <View style={[{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.md }, style]}>{children}</View>;
}

/**
 * A choice the computer keeps, shown at its new place while the call is under way. When the call
 * ends, what shows is what the computer sent back: a choice it refused goes back by itself.
 */
export function useHeld<V extends object>(saved: V | undefined) {
  const [held, setHeld] = useState<Partial<V>>({});
  const shown = saved && { ...saved, ...held };
  const hold = async (patch: Partial<V>, work: () => Promise<unknown>, done?: string) => {
    setHeld((was) => ({ ...was, ...patch }));
    await attempt(work(), done);
    setHeld((was) => {
      const rest = { ...was };
      for (const key of Object.keys(patch) as (keyof V)[]) delete rest[key];
      return rest;
    });
  };
  return [shown, hold] as const;
}
