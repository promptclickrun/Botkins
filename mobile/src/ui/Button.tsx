import type { LucideIcon } from "lucide-react-native";
import { ActivityIndicator, type StyleProp, View, type ViewStyle } from "react-native";
import { Tap } from "./Tap";
import { T } from "./Text";
import { radius, slopFor, useTheme } from "./theme";

export type ButtonProps = {
  title: string;
  onPress?: () => void;
  /** primary: the one main action. secondary: a quiet fill. ghost: text only. danger: removes something. accent: coral. */
  variant?: "primary" | "secondary" | "ghost" | "danger" | "accent";
  size?: "lg" | "md" | "sm";
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  /** Fills the width it is given. */
  wide?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

export function Button({ title, onPress, variant = "primary", size = "md", icon: Icon, loading, disabled, wide, style, accessibilityLabel }: ButtonProps) {
  const { colors, control } = useTheme();
  const height = control.button[size];
  const look = {
    primary: { bg: colors.primary, fg: colors.onPrimary },
    accent: { bg: colors.accent, fg: colors.onAccent },
    secondary: { bg: colors.sunken, fg: colors.ink },
    ghost: { bg: "transparent", fg: colors.accentText },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
  }[variant];
  const text = size === "sm" ? "subhead" : "headline";
  return (
    <Tap
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      hitSlop={slopFor(height)}
      style={[
        { minHeight: height, paddingHorizontal: size === "sm" ? 14 : 20, borderRadius: size === "sm" ? radius.sm : radius.md, backgroundColor: look.bg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
        wide ? { alignSelf: "stretch" } : { alignSelf: "flex-start" },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={look.fg} /> : Icon ? <Icon size={size === "sm" ? 16 : 19} color={look.fg} strokeWidth={2.2} /> : null}
      {!loading && (
        <T variant={text} weight="600" color={look.fg} numberOfLines={1}>
          {title}
        </T>
      )}
      {loading && <View style={{ position: "absolute" }} accessibilityElementsHidden />}
    </Tap>
  );
}

export type IconButtonProps = {
  icon: LucideIcon;
  onPress?: () => void;
  label: string;
  /** plain: just the icon. soft: on a quiet circle. accent: on coral. primary: on ink. */
  variant?: "plain" | "soft" | "accent" | "primary";
  /** The diameter. Follows the control size setting when not given. */
  size?: number;
  color?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A round button that is only an icon. `label` is what a screen reader says. */
export function IconButton({ icon: Icon, onPress, label, variant = "plain", size: given, color, disabled, style }: IconButtonProps) {
  const { colors, control } = useTheme();
  const size = given ?? control.icon;
  const bg = variant === "soft" ? colors.sunken : variant === "accent" ? colors.accent : variant === "primary" ? colors.primary : "transparent";
  const fg = color ?? (variant === "accent" ? colors.onAccent : variant === "primary" ? colors.onPrimary : colors.ink);
  return (
    <Tap onPress={onPress} disabled={disabled} accessibilityLabel={label} sink={0.9} hitSlop={slopFor(size)} style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center" }, style]}>
      <Icon size={Math.round(size * 0.5)} color={fg} strokeWidth={2.2} />
    </Tap>
  );
}
