// A small piece of glass for a control that floats over content. On a phone that has Apple's
// Liquid Glass it is the real material; on an older one it is a blur with the theme's surface
// over it and a hairline edge, which reads the same in light and dark.
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "./theme";

// Asked once: it does not change while the app runs.
let real: boolean | undefined;
const hasGlass = () => (real ??= (() => {
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
})());

export function Glass({ children, style, interactive }: { children?: ReactNode; style?: StyleProp<ViewStyle>; /** It reacts to touch as Apple's own glass controls do. */ interactive?: boolean }) {
  const { colors, dark } = useTheme();
  if (hasGlass())
    return (
      <GlassView glassEffectStyle="regular" isInteractive={interactive} colorScheme={dark ? "dark" : "light"} style={style}>
        {children}
      </GlassView>
    );
  return (
    <View style={[{ overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong }, style]}>
      <BlurView tint={dark ? "dark" : "light"} intensity={40} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface, opacity: 0.72 }]} />
      {children}
    </View>
  );
}
