import { Text as NativeText, type TextProps as NativeTextProps } from "react-native";
import { NO_MEDIUM } from "./fonts";
import { BODY_FONT, type Colors, DISPLAY_FONT, type TypeVariant, useTheme } from "./theme";

export type TProps = NativeTextProps & {
  variant?: TypeVariant;
  /** A color token, or any color. */
  color?: keyof Colors | (string & {});
  weight?: "400" | "500" | "600" | "700" | "800";
  center?: boolean;
};

/** Text in the app's type scale, at the person's text size. The phone's text size applies on top, up to a point. */
export function T({ variant = "body", color = "ink", weight, center, style, ...props }: TProps) {
  const { colors, type } = useTheme();
  const resolved = color in colors ? colors[color as keyof Colors] : color;
  // The kit's display face comes in bold only, so a weight never applies to it. Its body face has
  // 400, 600 and 700. Any other font takes the weight as asked and the phone finds the nearest.
  const family = type[variant].fontFamily;
  const heavy =
    family === DISPLAY_FONT ? undefined : family === BODY_FONT ? (weight === "500" ? "600" : weight === "800" ? "700" : weight) : weight === "500" && family && NO_MEDIUM.has(family) ? "400" : weight;
  return <NativeText maxFontSizeMultiplier={1.35} {...props} style={[type[variant], { color: resolved }, heavy && { fontWeight: heavy }, center && { textAlign: "center" }, style]} />;
}
