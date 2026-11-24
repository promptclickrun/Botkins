// A small piece of glass for a control that floats over content. On a phone that has Apple's
// Liquid Glass it is the real material; on an older one it is a blur with the theme's surface
// over it and a hairline edge, which reads the same in light and dark. When Reduce Transparency
// is enabled in accessibility settings (or `opaque` is passed), it renders an opaque theme
// surface so GPU backdrop compositing is skipped.
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { type ReactNode, useSyncExternalStore } from "react";
import { AccessibilityInfo, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { usePrefs } from "@/state/prefs";
import { resolveGlassMode } from "./glassMode";
import { useTheme } from "./theme";

// Asked once: it does not change while the app runs.
let real: boolean | undefined;
/** The phone draws Apple's Liquid Glass (iOS 26 and later). A chat's bar is see-through only then. */
export const hasGlass = () => (real ??= (() => {
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
})());

// Shared Reduce Transparency subscription across all Glass surfaces.
let reduceTransparency = false;
let reduceTransparencySub: { remove?: () => void } | null = null;
const reduceTransparencyListeners = new Set<() => void>();

function ensureReduceTransparencyListener() {
  if (reduceTransparencySub) return;
  try {
    void AccessibilityInfo.isReduceTransparencyEnabled?.().then((enabled) => {
      if (enabled === reduceTransparency) return;
      reduceTransparency = !!enabled;
      for (const listener of reduceTransparencyListeners) listener();
    });
    reduceTransparencySub = AccessibilityInfo.addEventListener?.("reduceTransparencyChanged", (enabled) => {
      const next = !!enabled;
      if (next === reduceTransparency) return;
      reduceTransparency = next;
      for (const listener of reduceTransparencyListeners) listener();
    }) ?? {};
  } catch {
    reduceTransparencySub = {};
  }
}

function useReduceTransparency(): boolean {
  return useSyncExternalStore(
    (listener) => {
      ensureReduceTransparencyListener();
      reduceTransparencyListeners.add(listener);
      return () => {
        reduceTransparencyListeners.delete(listener);
      };
    },
    () => reduceTransparency,
    () => false,
  );
}

export type GlassProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** It reacts to touch as Apple's own glass controls do. */
  interactive?: boolean;
  /** Force an opaque surface instead of backdrop blur/glass. */
  opaque?: boolean;
  /** Liquid Glass material density on iOS 26+. Defaults to "regular". */
  glassEffectStyle?: "regular" | "clear";
  /** Optional tint color passed to Liquid Glass or blended into the blur fallback. */
  tintColor?: string;
  /** Specular hairline rim highlight around the glass edge. Defaults to true. */
  rim?: boolean;
};

export function Glass({ children, style, interactive, opaque, glassEffectStyle = "regular", tintColor, rim = true }: GlassProps) {
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const reduced = useReduceTransparency();
  const mode = resolveGlassMode({ liquidAvailable: hasGlass(), reduceTransparency: reduced, opaque });
  const rimColor = dark
    ? hasBackdrop
      ? "rgba(255,255,255,0.22)"
      : "rgba(255,255,255,0.14)"
    : hasBackdrop
      ? "rgba(255,255,255,0.68)"
      : colors.lineStrong;

  if (mode === "opaque") {
    return (
      <View style={[{ overflow: "hidden", backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong }, style]}>
        {children}
      </View>
    );
  }
  if (mode === "liquid")
    return (
      <GlassView
        glassEffectStyle={glassEffectStyle}
        tintColor={tintColor}
        isInteractive={interactive}
        colorScheme={dark ? "dark" : "light"}
        style={[rim && { borderWidth: StyleSheet.hairlineWidth, borderColor: rimColor }, style]}
      >
        {children}
      </GlassView>
    );
  const fillOpacity = hasBackdrop ? (glassEffectStyle === "clear" ? (dark ? 0.24 : 0.34) : dark ? 0.44 : 0.58) : 0.72;
  return (
    <View style={[{ overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: rim ? rimColor : colors.lineStrong }, style]}>
      <BlurView tint={dark ? "dark" : "light"} intensity={hasBackdrop ? 55 : 40} style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tintColor ?? colors.surface, opacity: fillOpacity }]} />
      {rim && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: StyleSheet.hairlineWidth * 2,
            backgroundColor: dark ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.78)",
          }}
        />
      )}
      {children}
    </View>
  );
}
