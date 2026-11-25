import { LinearGradient } from "expo-linear-gradient";
import type { LucideIcon } from "lucide-react-native";
import { ActivityIndicator, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { usePrefs } from "@/state/prefs";
import { Glass, hasGlass } from "./Glass";
import { Tap } from "./Tap";
import { T } from "./Text";
import { radius, slopFor, useTheme } from "./theme";

export type ButtonProps = {
  title: string;
  onPress?: () => void;
  /** primary: the one main action. secondary: a quiet fill (glass when active). glass: translucent Liquid Glass pill. ghost: text only. danger: removes something. accent: coral. */
  variant?: "primary" | "secondary" | "glass" | "ghost" | "danger" | "accent";
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
  const { colors, dark, control } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const height = control.button[size];
  const corner = size === "sm" ? radius.sm : radius.md;
  const padX = size === "sm" ? 14 : 20;
  const useGlass = variant === "glass" || (variant === "secondary" && (hasBackdrop || hasGlass()));
  const look = {
    primary: { bg: colors.primary, fg: colors.onPrimary },
    accent: { bg: colors.accent, fg: colors.onAccent },
    secondary: { bg: colors.sunken, fg: colors.ink },
    glass: { bg: "transparent", fg: colors.ink },
    ghost: { bg: "transparent", fg: colors.accentText },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
  }[variant];
  const text = size === "sm" ? "subhead" : "headline";
  const content = (
    <>
      {loading ? <ActivityIndicator color={look.fg} /> : Icon ? <Icon size={size === "sm" ? 16 : 19} color={look.fg} strokeWidth={2.2} /> : null}
      {!loading && (
        <T variant={text} weight="600" color={look.fg} numberOfLines={1}>
          {title}
        </T>
      )}
      {loading && <View style={{ position: "absolute" }} accessibilityElementsHidden />}
    </>
  );

  if (useGlass) {
    return (
      <Tap
        onPress={onPress}
        disabled={disabled || loading}
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityState={{ disabled: !!disabled, busy: !!loading }}
        hitSlop={slopFor(height)}
        style={[wide ? { alignSelf: "stretch" } : { alignSelf: "flex-start" }, style]}
      >
        <Glass
          interactive
          glassEffectStyle={variant === "glass" ? "clear" : "regular"}
          style={{
            minHeight: height,
            paddingHorizontal: padX,
            borderRadius: corner,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            overflow: "hidden",
          }}
        >
          {content}
        </Glass>
      </Tap>
    );
  }

  const filledSheen = variant === "primary" || variant === "accent";
  return (
    <Tap
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      hitSlop={slopFor(height)}
      style={[
        {
          minHeight: height,
          paddingHorizontal: padX,
          borderRadius: corner,
          backgroundColor: look.bg,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          overflow: filledSheen ? "hidden" : undefined,
          ...(filledSheen && {
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: dark ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.34)",
          }),
        },
        wide ? { alignSelf: "stretch" } : { alignSelf: "flex-start" },
        style,
      ]}
    >
      {filledSheen && (
        <LinearGradient
          pointerEvents="none"
          colors={["rgba(255,255,255,0.20)", "rgba(255,255,255,0)"]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: "52%" }}
        />
      )}
      {content}
    </Tap>
  );
}

export type IconButtonProps = {
  icon: LucideIcon;
  onPress?: () => void;
  label: string;
  /** plain: just the icon. soft: on a quiet circle (glass when active). glass: Liquid Glass circle. accent: on coral. primary: on ink. */
  variant?: "plain" | "soft" | "glass" | "accent" | "primary";
  /** The diameter. Follows the control size setting when not given. */
  size?: number;
  color?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** A round button that is only an icon. `label` is what a screen reader says. */
export function IconButton({ icon: Icon, onPress, label, variant = "plain", size: given, color, disabled, style }: IconButtonProps) {
  const { colors, control } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const size = given ?? control.icon;
  const useGlass = variant === "glass" || (variant === "soft" && (hasBackdrop || hasGlass()));
  const bg = variant === "soft" ? colors.sunken : variant === "accent" ? colors.accent : variant === "primary" ? colors.primary : "transparent";
  const fg = color ?? (variant === "accent" ? colors.onAccent : variant === "primary" ? colors.onPrimary : colors.ink);
  const icon = <Icon size={Math.round(size * 0.5)} color={fg} strokeWidth={2.2} />;

  if (useGlass) {
    return (
      <Tap onPress={onPress} disabled={disabled} accessibilityLabel={label} sink={0.9} hitSlop={slopFor(size)} style={style}>
        <Glass
          interactive
          glassEffectStyle={variant === "glass" ? "clear" : "regular"}
          style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" }}
        >
          {icon}
        </Glass>
      </Tap>
    );
  }

  return (
    <Tap onPress={onPress} disabled={disabled} accessibilityLabel={label} sink={0.9} hitSlop={slopFor(size)} style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center" }, style]}>
      {icon}
    </Tap>
  );
}
