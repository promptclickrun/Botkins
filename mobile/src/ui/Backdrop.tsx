// Full-bleed backdrop layer rendered behind screens (and inside Appearance preview cards)
// using expo-linear-gradient and react-native-svg so Liquid Glass surfaces refract rich color
// and geometry at 60fps without CSS filter: blur().
import { LinearGradient } from "expo-linear-gradient";
import { memo, useId } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, Ellipse, G, Path, Pattern, RadialGradient, Rect, Stop } from "react-native-svg";
import { usePrefs } from "@/state/prefs";
import { backdropBaseColor, type BackdropId } from "./backdrops";
import { useTheme } from "./theme";

// Precomputed horizontal band paths rotated -35deg in SVG so CoreGraphics renders crisp,
// seamless diagonal sheen stripes (avoiding iOS react-native-svg patternTransform clipping artifacts).
function buildStripePath(cx: number, cy: number, radius: number, period: number, band: number): string {
  const parts: string[] = [];
  const x = cx - radius;
  const w = radius * 2;
  for (let y = cy - radius; y < cy + radius; y += period) {
    parts.push(`M${x} ${y}h${w}v${band}h${-w}Z`);
  }
  return parts.join("");
}

// Narrow bands (a third of each period) read as a soft sheen; half-period bands at full strength
// crossed the blobs as a diamond texture on iOS.
const FULL_STRIPE_PATH = buildStripePath(215, 466, 620, 36, 12);
const PREVIEW_STRIPE_PATH = buildStripePath(90, 48, 150, 14, 5);

export type BackdropLayerProps = {
  /** Explicit backdrop id (used by Appearance preview cards). Defaults to the saved preference. */
  backdrop?: BackdropId;
  /** Compact geometry for miniature preview cards. */
  preview?: boolean;
  /** Optional dark-mode override; defaults to the active theme. */
  dark?: boolean;
};

export const BackdropLayer = memo(function BackdropLayer({ backdrop: given, preview = false, dark: darkOverride }: BackdropLayerProps) {
  const saved = usePrefs((prefs) => prefs.backdrop);
  const theme = useTheme();
  const backdrop = given ?? saved;
  const dark = darkOverride ?? theme.dark;
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9]/g, "");

  if (backdrop === "clean") return null;

  const base = backdropBaseColor(backdrop, dark, theme.colors.canvas);

  if (backdrop === "grid") {
    const cell = preview ? 12 : 28;
    const patternId = `grid-${uid}`;
    return (
      <View
        pointerEvents="none"
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={[StyleSheet.absoluteFill, { backgroundColor: base }]}
      >
        <LinearGradient
          colors={dark ? ["rgba(255,255,255,0.03)", "rgba(0,0,0,0)", "rgba(0,0,0,0.14)"] : ["rgba(255,255,255,0.5)", "rgba(255,255,255,0)", "rgba(15,23,42,0.04)"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            <Pattern id={patternId} patternUnits="userSpaceOnUse" width={cell} height={cell}>
              <Path d={`M ${cell} 0 L 0 0 0 ${cell}`} fill="none" stroke="rgba(120, 130, 155, 0.28)" strokeWidth={1} />
            </Pattern>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${patternId})`} />
        </Svg>
      </View>
    );
  }

  if (backdrop === "mesh") {
    const redId = `mesh-red-${uid}`;
    const blueId = `mesh-blue-${uid}`;
    const greenId = `mesh-green-${uid}`;
    const redOp = dark ? 0.72 : 0.62;
    const blueOp = dark ? 0.75 : 0.65;
    const greenOp = dark ? 0.70 : 0.60;
    // Kept faint: the sheen should only catch the light, never draw a pattern over the color.
    const stripeFill = dark ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.10)";
    const stripeViewBox = preview ? "0 0 180 96" : "0 0 430 932";
    const stripeTransform = preview ? "rotate(-35, 90, 48)" : "rotate(-35, 215, 466)";
    const stripePath = preview ? PREVIEW_STRIPE_PATH : FULL_STRIPE_PATH;

    return (
      <View
        pointerEvents="none"
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={[StyleSheet.absoluteFill, { backgroundColor: base }]}
      >
        <LinearGradient
          colors={dark ? ["#0b0d12", "#121622", "#0b0d12"] : ["#eef1f6", "#f5f7fc", "#e8edf6"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
          <Defs>
            <RadialGradient id={redId} cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor="#ff3b30" stopOpacity={redOp} />
              <Stop offset="36%" stopColor="#ff3b30" stopOpacity={redOp * 0.66} />
              <Stop offset="70%" stopColor="#ff3b30" stopOpacity={redOp * 0.18} />
              <Stop offset="100%" stopColor="#ff3b30" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id={blueId} cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor="#007aff" stopOpacity={blueOp} />
              <Stop offset="36%" stopColor="#007aff" stopOpacity={blueOp * 0.66} />
              <Stop offset="70%" stopColor="#007aff" stopOpacity={blueOp * 0.18} />
              <Stop offset="100%" stopColor="#007aff" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id={greenId} cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor="#34c759" stopOpacity={greenOp} />
              <Stop offset="36%" stopColor="#34c759" stopOpacity={greenOp * 0.66} />
              <Stop offset="70%" stopColor="#34c759" stopOpacity={greenOp * 0.18} />
              <Stop offset="100%" stopColor="#34c759" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse cx={18} cy={18} rx={58} ry={46} fill={`url(#${redId})`} />
          <Ellipse cx={86} cy={46} rx={56} ry={48} fill={`url(#${blueId})`} />
          <Ellipse cx={24} cy={84} rx={60} ry={46} fill={`url(#${greenId})`} />
        </Svg>
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox={stripeViewBox} preserveAspectRatio="xMidYMid slice">
          <G transform={stripeTransform}>
            <Path d={stripePath} fill={stripeFill} />
          </G>
        </Svg>
      </View>
    );
  }

  // "botkins" — Ambient indigo, pink & teal orbs
  const indigoId = `botkins-indigo-${uid}`;
  const pinkId = `botkins-pink-${uid}`;
  const tealId = `botkins-teal-${uid}`;
  const orbOp = dark ? 0.72 : 0.52;

  return (
    <View
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { backgroundColor: base }]}
    >
      <LinearGradient
        colors={dark ? ["#0b0d12", "#0f1322", "#0b0d12"] : ["#eef1f6", "#f3f5fb", "#eaeef7"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
        <Defs>
          <RadialGradient id={indigoId} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#3b82f6" stopOpacity={orbOp} />
            <Stop offset="42%" stopColor="#6366f1" stopOpacity={orbOp * 0.62} />
            <Stop offset="74%" stopColor="#6366f1" stopOpacity={orbOp * 0.16} />
            <Stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={pinkId} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#ec4899" stopOpacity={orbOp * 0.96} />
            <Stop offset="44%" stopColor="#8b5cf6" stopOpacity={orbOp * 0.58} />
            <Stop offset="76%" stopColor="#8b5cf6" stopOpacity={orbOp * 0.14} />
            <Stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={tealId} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#14b8a6" stopOpacity={orbOp} />
            <Stop offset="44%" stopColor="#0ea5e9" stopOpacity={orbOp * 0.56} />
            <Stop offset="76%" stopColor="#0ea5e9" stopOpacity={orbOp * 0.14} />
            <Stop offset="100%" stopColor="#0ea5e9" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx={18} cy={16} rx={62} ry={50} fill={`url(#${indigoId})`} />
        <Ellipse cx={86} cy={48} rx={60} ry={50} fill={`url(#${pinkId})`} />
        <Ellipse cx={22} cy={86} rx={62} ry={48} fill={`url(#${tealId})`} />
      </Svg>
    </View>
  );
});
