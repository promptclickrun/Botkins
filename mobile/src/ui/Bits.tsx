// Small pieces: chips, segmented control, badges, empty states, the connection pill.
import type { LucideIcon } from "lucide-react-native";
import { type ReactNode, useEffect } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Button } from "./Button";
import { Tap } from "./Tap";
import { T } from "./Text";
import { type Colors, radius, slopFor, space, useTheme } from "./theme";

/** A pill a person picks: a filter, a choice. */
export function Chip({ label, selected, onPress, icon: Icon, leading }: { label: string; selected?: boolean; onPress?: () => void; icon?: LucideIcon; leading?: ReactNode }) {
  const { colors, control } = useTheme();
  const fg = selected ? colors.onPrimary : colors.ink;
  return (
    <Tap
      onPress={onPress}
      feel="select"
      accessibilityState={{ selected: !!selected }}
      hitSlop={slopFor(control.chip)}
      style={{ minHeight: control.chip, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: selected ? colors.primary : colors.surface, borderWidth: 1, borderColor: selected ? colors.primary : colors.line, flexDirection: "row", alignItems: "center", gap: 6 }}
    >
      {leading}
      {Icon && <Icon size={15} color={fg} strokeWidth={2.2} />}
      <T variant="subhead" weight="600" color={fg} numberOfLines={1}>
        {label}
      </T>
    </Tap>
  );
}

/** Two to four choices side by side; the thumb slides to the chosen one. */
export function Segmented<V extends string>({ options, value, onChange, style }: { options: { value: V; label: string }[]; value: V; onChange: (value: V) => void; style?: StyleProp<ViewStyle> }) {
  const { colors, control } = useTheme();
  const slop = slopFor(control.segmented);
  const width = useSharedValue(0);
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const position = useSharedValue(index);
  useEffect(() => {
    position.value = withSpring(index, { damping: 22, stiffness: 260 });
  }, [index, position]);
  const thumb = useAnimatedStyle(() => ({ width: width.value / options.length - 6, transform: [{ translateX: position.value * (width.value / options.length) + 3 }] }));
  return (
    <View
      onLayout={(event) => (width.value = event.nativeEvent.layout.width)}
      style={[{ minHeight: control.segmented, borderRadius: radius.md, backgroundColor: colors.sunken, flexDirection: "row", alignItems: "center" }, style]}
      accessibilityRole="tablist"
    >
      <Animated.View style={[{ position: "absolute", top: 3, bottom: 3, borderRadius: radius.md - 3, backgroundColor: colors.surface, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 }, thumb]} />
      {options.map((option) => (
        <Tap key={option.value} onPress={() => onChange(option.value)} feel="select" sink={1} hitSlop={{ top: slop, bottom: slop }} accessibilityRole="tab" accessibilityState={{ selected: option.value === value }} style={{ flex: 1, alignSelf: "stretch", paddingVertical: 6, alignItems: "center", justifyContent: "center" }}>
          <T variant="subhead" weight="600" color={option.value === value ? "ink" : "muted"} numberOfLines={1}>
            {option.label}
          </T>
        </Tap>
      ))}
    </View>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
function toneColors(colors: Colors, tone: Tone) {
  return {
    neutral: [colors.sunken, colors.ink2],
    accent: [colors.accentSoft, colors.accentText],
    success: [colors.successSoft, colors.success],
    warning: [colors.warningSoft, colors.warning],
    danger: [colors.dangerSoft, colors.danger],
    info: [colors.infoSoft, colors.info],
  }[tone];
}

/** A tiny status label. */
export function Badge({ label, tone = "neutral", icon: Icon }: { label: string; tone?: Tone; icon?: LucideIcon }) {
  const { colors } = useTheme();
  const [bg, fg] = toneColors(colors, tone);
  return (
    <View style={{ alignSelf: "flex-start", minHeight: 22, paddingHorizontal: 8, borderRadius: 7, backgroundColor: bg, flexDirection: "row", alignItems: "center", gap: 4 }}>
      {Icon && <Icon size={12} color={fg} strokeWidth={2.4} />}
      <T variant="caption" weight="600" color={fg} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

/** A colored dot, for an unread chat or a live state. */
export function Dot({ tone = "accent", size = 8 }: { tone?: Tone; size?: number }) {
  const { colors } = useTheme();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: toneColors(colors, tone)[1] }} />;
}

/** What a screen shows when it has nothing yet: one line and one thing to do. */
export function EmptyState({ icon: Icon, art, title, text, action, onAction, style }: { icon?: LucideIcon; art?: ReactNode; title: string; text?: string; action?: string; onAction?: () => void; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <View style={[{ alignItems: "center", paddingHorizontal: space.huge, paddingVertical: 48, gap: space.md }, style]}>
      {art}
      {Icon && !art && (
        <View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: colors.sunken, alignItems: "center", justifyContent: "center", marginBottom: space.xs }}>
          <Icon size={28} color={colors.muted} strokeWidth={1.9} />
        </View>
      )}
      <T variant="title3" center>
        {title}
      </T>
      {!!text && (
        <T variant="subhead" color="muted" center>
          {text}
        </T>
      )}
      {!!action && <Button title={action} onPress={onAction} style={{ alignSelf: "center", marginTop: space.sm }} />}
    </View>
  );
}

/** A thin line between two parts of a screen. */
export function Divider({ inset = 0 }: { inset?: number }) {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.line, marginLeft: inset }} />;
}
