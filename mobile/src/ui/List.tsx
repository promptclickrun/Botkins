// Grouped rows, the backbone of every settings-like screen.
import { ChevronRight, type LucideIcon } from "lucide-react-native";
import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { type StyleProp, StyleSheet, Switch, View, type ViewStyle } from "react-native";
import { haptic } from "./haptics";
import { Tap } from "./Tap";
import { T } from "./Text";
import { radius, space, tint, useTheme } from "./theme";
import { type Colors, contrast } from "./themes";

/** A small caption above a group. */
export function Label({ children, style }: { children: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ paddingHorizontal: space.xs, marginBottom: space.sm }, style]}>
      <T variant="label" color="muted" style={{ textTransform: "uppercase" }} accessibilityRole="header">
        {children}
      </T>
    </View>
  );
}

export type GroupProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** No lines between rows. */
  flush?: boolean;
  /**
   * No card at all: rows sit on the page, with the faintest line between them. For lists of bots
   * and chats. The rows' own padding lines their content up with the rest of the page.
   */
  flat?: boolean;
  /** Where the line between rows starts, from the left edge. Set it to where the rows' text starts. */
  inset?: number;
};

/** Rows that belong together: on a quiet card, or flat on the page. */
export function Group({ children, style, flush, flat, inset = space.lg }: GroupProps) {
  const { colors } = useTheme();
  const items = Children.toArray(children).filter(isValidElement);
  const card = flat ? { marginHorizontal: -space.lg } : { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: "hidden" as const };
  return (
    <View style={[card, style]}>
      {items.map((child, index) => (
        <Fragment key={child.key ?? index}>
          {index > 0 && !flush && <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: inset }} />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

/** An icon on a soft square of its own color. */
/** A switch's colors. Where the action color is too light for the white knob (Ink at night), the knob turns dark while it is on. */
export function switchColors(colors: Colors, on: boolean | undefined) {
  return { trackColor: { true: colors.accent, false: colors.lineStrong }, ...(on && contrast(colors.accent, "#FFFFFF") < 1.6 && { thumbColor: colors.onAccent }) };
}

export function IconTile({ icon: Icon, color, size = 32 }: { icon: LucideIcon; color?: string; size?: number }) {
  const theme = useTheme();
  // A theme without color (Ink) draws every tile in ink; only a status color still shows.
  const { success, warning, danger, info } = theme.colors;
  const plain = theme.mono && !(color && [success, warning, danger, info].includes(color));
  const main = plain ? theme.colors.ink : (color ?? theme.colors.accent);
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: plain ? theme.colors.sunken : tint(main, theme.dark ? 0.24 : 0.14), alignItems: "center", justifyContent: "center" }}>
      <Icon size={Math.round(size * 0.56)} color={main} strokeWidth={2.2} />
    </View>
  );
}

export type RowProps = {
  title: string;
  subtitle?: string;
  /** Shown at the left: an IconTile, an avatar, a logo. */
  leading?: ReactNode;
  /** A short value at the right, before the chevron. */
  value?: string;
  trailing?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  /** Makes the row a switch. */
  toggled?: boolean;
  onToggle?: (next: boolean) => void;
  /** Tints the title: an action row such as "Remove". */
  tone?: "accent" | "danger";
  disabled?: boolean;
  subtitleLines?: number;
  /** A title that can't be shortened without losing its meaning may take two lines. */
  titleLines?: number;
};

export function Row({ title, subtitle, leading, value, trailing, chevron, onPress, toggled, onToggle, tone, disabled, subtitleLines = 1, titleLines = 1 }: RowProps) {
  const { colors, control } = useTheme();
  const isSwitch = toggled !== undefined;
  const content = (
    <View style={{ minHeight: control.row, paddingHorizontal: space.lg, paddingVertical: control.size === "compact" ? 6 : control.size === "large" ? 12 : 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="callout" weight="500" color={tone === "danger" ? "danger" : tone === "accent" ? "accentText" : "ink"} numberOfLines={titleLines}>
          {title}
        </T>
        {!!subtitle && (
          <T variant="footnote" color="muted" numberOfLines={subtitleLines}>
            {subtitle}
          </T>
        )}
      </View>
      {!!value && (
        <T variant="subhead" color="muted" numberOfLines={1} style={{ maxWidth: "45%" }}>
          {value}
        </T>
      )}
      {trailing}
      {isSwitch && (
        <Switch
          value={toggled}
          disabled={disabled}
          onValueChange={(next) => {
            haptic.select();
            onToggle?.(next);
          }}
          {...switchColors(colors, toggled)}
          style={{ alignSelf: "center" }}
          accessibilityLabel={title}
        />
      )}
      {chevron && <ChevronRight size={18} color={colors.faint} strokeWidth={2.2} />}
    </View>
  );
  if (!onPress) return <View style={disabled ? { opacity: 0.5 } : undefined}>{content}</View>;
  return (
    <Tap onPress={onPress} disabled={disabled} sink={1} feel="select" hitSlop={0} accessibilityLabel={subtitle ? title + ", " + subtitle : title}>
      {content}
    </Tap>
  );
}
