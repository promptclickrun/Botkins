// A 3×3 Brady Bunch grid of tiny Botkin faces that glance toward each other, blink, wink, tilt,
// and bounce on independent rhythms on the UI thread (Reanimated), so it keeps moving even while JS
// is busy rendering deferred content. Shown only after `delay` ms (default 120ms) so fast switches
// never flash a loader.
import { useEffect, useState } from "react";
import { AccessibilityInfo, type StyleProp, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { usePrefs } from "@/state/prefs";
import { tint, useTheme } from "./theme";

/** Wait this long before revealing the grid so fast switches stay flicker-free. */
export const LOADING_GRID_DELAY_MS = 120;

const COLS = 3;
/** Master clock length in seconds; every tile period divides 60 evenly so loops wrap seamlessly. */
const CYCLE_S = 60;

type EyeKind = "oval" | "round" | "arc" | "sleepy";
type TileMotion = "bobA" | "bobB" | "tiltCurious" | "tiltLeft" | "nodRight" | "heroHop" | "cozy";
type BlinkKind = "none" | "quick" | "double" | "winkRight" | "curiousLeft";

type BotTileSpec = {
  key: number;
  eyeKind: EyeKind;
  motion: TileMotion;
  motionPeriod: number;
  motionPhase: number;
  /** Target glance offset in normalized cell-fraction units (multiplied by cellSize). */
  lookX: number;
  lookY: number;
  /** Glance pattern: "point" holds (lookX, lookY), "lr" scans left/right, "around" orbits the grid. */
  lookMode: "point" | "lr" | "around";
  lookPeriod: number;
  lookPhase: number;
  blink: BlinkKind;
  blinkPeriod: number;
  blinkPhase: number;
};

const TILES: readonly BotTileSpec[] = [
  // 0: Top-left — glances down-right at center, double-blink
  { key: 0, eyeKind: "oval", motion: "bobA", motionPeriod: 2.4, motionPhase: 0.0, lookX: 0.08, lookY: 0.07, lookMode: "point", lookPeriod: 3.0, lookPhase: 0.1, blink: "double", blinkPeriod: 3.75, blinkPhase: 0.0 },
  // 1: Top-center — curious head tilt + peeks left & right
  { key: 1, eyeKind: "round", motion: "tiltCurious", motionPeriod: 3.0, motionPhase: 0.2, lookX: 0.09, lookY: 0.02, lookMode: "lr", lookPeriod: 2.5, lookPhase: 0.0, blink: "quick", blinkPeriod: 4.0, blinkPhase: 0.35 },
  // 2: Top-right — glances down-left, cheeky wink
  { key: 2, eyeKind: "oval", motion: "bobB", motionPeriod: 2.5, motionPhase: 0.3, lookX: -0.08, lookY: 0.07, lookMode: "point", lookPeriod: 3.75, lookPhase: 0.2, blink: "winkRight", blinkPeriod: 3.75, blinkPhase: 0.1 },
  // 3: Mid-left — looks right at center with bouncy nod
  { key: 3, eyeKind: "oval", motion: "nodRight", motionPeriod: 2.0, motionPhase: 0.15, lookX: 0.09, lookY: 0, lookMode: "point", lookPeriod: 3.0, lookPhase: 0.45, blink: "quick", blinkPeriod: 4.0, blinkPhase: 0.7 },
  // 4: Center hero — happy hop + glances around the Brady grid
  { key: 4, eyeKind: "oval", motion: "heroHop", motionPeriod: 2.0, motionPhase: 0.0, lookX: 0.08, lookY: 0.06, lookMode: "around", lookPeriod: 4.0, lookPhase: 0.0, blink: "quick", blinkPeriod: 3.0, blinkPhase: 0.25 },
  // 5: Mid-right — looks left at center, curious brow squint
  { key: 5, eyeKind: "oval", motion: "tiltLeft", motionPeriod: 2.5, motionPhase: 0.5, lookX: -0.09, lookY: 0, lookMode: "point", lookPeriod: 3.0, lookPhase: 0.7, blink: "curiousLeft", blinkPeriod: 2.5, blinkPhase: 0.0 },
  // 6: Bottom-left — peeks up-right, happy smile eyes
  { key: 6, eyeKind: "arc", motion: "bobA", motionPeriod: 2.5, motionPhase: 0.75, lookX: 0.08, lookY: -0.07, lookMode: "point", lookPeriod: 3.75, lookPhase: 0.5, blink: "none", blinkPeriod: 4.0, blinkPhase: 0.0 },
  // 7: Bottom-center — looks straight up at center, slow blink
  { key: 7, eyeKind: "round", motion: "bobB", motionPeriod: 2.4, motionPhase: 0.55, lookX: 0, lookY: -0.08, lookMode: "point", lookPeriod: 3.0, lookPhase: 0.3, blink: "quick", blinkPeriod: 5.0, blinkPhase: 0.4 },
  // 8: Bottom-right — looks up-left, sleepy/cozy breathe
  { key: 8, eyeKind: "sleepy", motion: "cozy", motionPeriod: 3.0, motionPhase: 0.4, lookX: -0.07, lookY: -0.06, lookMode: "point", lookPeriod: 3.75, lookPhase: 0.8, blink: "none", blinkPeriod: 4.0, blinkPhase: 0.0 },
];

let reducedKnown: boolean | undefined;
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedKnown ?? false);
  useEffect(() => {
    let active = true;
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      reducedKnown = value;
      if (active) setReduced(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      reducedKnown = value;
      if (active) setReduced(value);
    }, () => {});
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/** Smooth 0..1..0 pulse for a given window `[start, end]` inside a 0..1 normalized cycle. */
function pulseWindow(p: number, start: number, end: number): number {
  "worklet";
  if (p <= start || p >= end) return 0;
  const u = (p - start) / (end - start);
  return 0.5 - 0.5 * Math.cos(u * Math.PI * 2);
}

/** One Botkin face tile inside the 3×3 grid. */
function BotTile({
  spec,
  clock,
  size,
  tileColor,
  eyeColor,
  reduced,
}: {
  spec: BotTileSpec;
  clock: SharedValue<number>;
  size: number;
  tileColor: string;
  eyeColor: string;
  reduced: boolean;
}) {
  const radius = Math.max(3, Math.round(size * 0.3 * 10) / 10);
  const eyeGap = Math.max(1.5, size * 0.16);
  const eyeW = Math.max(2, size * (spec.eyeKind === "arc" || spec.eyeKind === "sleepy" ? 0.22 : 0.16));
  const eyeH = Math.max(2, size * (spec.eyeKind === "oval" ? 0.28 : spec.eyeKind === "round" ? 0.19 : 0.13));
  const arcStroke = Math.max(1.4, size * 0.095);

  const tileStyle = useAnimatedStyle(() => {
    "worklet";
    if (reduced) {
      return { opacity: 0.92, transform: [{ translateX: 0 }, { translateY: 0 }, { rotate: "0deg" }, { scale: 1 }] };
    }
    const p = ((clock.value / spec.motionPeriod) + spec.motionPhase) % 1;
    const wave = 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
    const signed = Math.sin(p * Math.PI * 2);
    let tx = 0;
    let ty = 0;
    let rot = 0;
    let sc = 1;
    let op = 0.96;

    if (spec.motion === "bobA") {
      ty = -1.5 * wave;
      sc = 1 + 0.04 * wave;
      op = 0.9 + 0.1 * wave;
    } else if (spec.motion === "bobB") {
      ty = -1.5 * wave;
      rot = 3 * signed;
      op = 0.88 + 0.12 * wave;
    } else if (spec.motion === "tiltCurious") {
      ty = -1 * wave;
      rot = -6.5 * signed;
    } else if (spec.motion === "tiltLeft") {
      tx = -0.8 * wave;
      rot = -6 * wave;
    } else if (spec.motion === "nodRight") {
      tx = 0.9 * wave;
      rot = 5 * wave;
    } else if (spec.motion === "heroHop") {
      ty = -2 * wave;
      sc = 1 + 0.07 * wave;
      op = 1;
    } else if (spec.motion === "cozy") {
      sc = 0.95 + 0.07 * wave;
      op = 0.72 + 0.23 * wave;
    }
    return {
      opacity: op,
      transform: [{ translateX: tx }, { translateY: ty }, { rotate: `${rot}deg` }, { scale: sc }],
    };
  }, [spec, reduced]);

  const eyesStyle = useAnimatedStyle(() => {
    "worklet";
    if (reduced) return { transform: [{ translateX: 0 }, { translateY: 0 }] };
    const p = ((clock.value / spec.lookPeriod) + spec.lookPhase) % 1;
    let gx = 0;
    let gy = 0;
    if (spec.lookMode === "point") {
      const hold = pulseWindow(p, 0.2, 0.82);
      gx = spec.lookX * size * hold;
      gy = spec.lookY * size * hold;
    } else if (spec.lookMode === "lr") {
      gx = Math.sin(p * Math.PI * 2) * spec.lookX * size;
      gy = spec.lookY * size * 0.5;
    } else {
      // Center hero glances gently around the grid.
      gx = Math.cos(p * Math.PI * 2) * spec.lookX * size;
      gy = Math.sin(p * Math.PI * 2) * spec.lookY * size;
    }
    return { transform: [{ translateX: gx }, { translateY: gy }] };
  }, [spec, size, reduced]);

  const leftEyeStyle = useAnimatedStyle(() => {
    "worklet";
    if (reduced || spec.blink === "none" || spec.blink === "winkRight") {
      return { transform: [{ scaleY: 1 }] };
    }
    const p = ((clock.value / spec.blinkPeriod) + spec.blinkPhase) % 1;
    if (spec.blink === "curiousLeft") {
      const squint = pulseWindow(p, 0.15, 0.75);
      return { transform: [{ scaleY: 1 - 0.38 * squint }] };
    }
    const shut =
      spec.blink === "double"
        ? Math.max(pulseWindow(p, 0.76, 0.86), pulseWindow(p, 0.88, 0.98))
        : pulseWindow(p, 0.88, 0.98);
    return { transform: [{ scaleY: 1 - 0.88 * shut }] };
  }, [spec, reduced]);

  const rightEyeStyle = useAnimatedStyle(() => {
    "worklet";
    if (reduced || spec.blink === "none" || spec.blink === "curiousLeft") {
      return { transform: [{ scaleY: 1 }] };
    }
    const p = ((clock.value / spec.blinkPeriod) + spec.blinkPhase) % 1;
    const shut =
      spec.blink === "winkRight"
        ? pulseWindow(p, 0.62, 0.88)
        : spec.blink === "double"
          ? Math.max(pulseWindow(p, 0.76, 0.86), pulseWindow(p, 0.88, 0.98))
          : pulseWindow(p, 0.88, 0.98);
    return { transform: [{ scaleY: 1 - 0.88 * shut }] };
  }, [spec, reduced]);

  const baseEyeStyle: ViewStyle =
    spec.eyeKind === "arc"
      ? {
          width: eyeW,
          height: eyeH,
          borderTopWidth: arcStroke,
          borderLeftWidth: arcStroke * 0.45,
          borderRightWidth: arcStroke * 0.45,
          borderColor: eyeColor,
          borderTopLeftRadius: 99,
          borderTopRightRadius: 99,
          marginTop: size * 0.04,
        }
      : spec.eyeKind === "sleepy"
        ? {
            width: eyeW,
            height: eyeH,
            borderBottomWidth: arcStroke,
            borderLeftWidth: arcStroke * 0.45,
            borderRightWidth: arcStroke * 0.45,
            borderColor: eyeColor,
            borderBottomLeftRadius: 99,
            borderBottomRightRadius: 99,
          }
        : {
            width: eyeW,
            height: eyeH,
            borderRadius: 99,
            backgroundColor: eyeColor,
          };

  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: tileColor,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        },
        tileStyle,
      ]}
    >
      <Animated.View style={[{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: eyeGap }, eyesStyle]}>
        <Animated.View style={[baseEyeStyle, leftEyeStyle]} />
        <Animated.View style={[baseEyeStyle, rightEyeStyle]} />
      </Animated.View>
    </Animated.View>
  );
}

export type LoadingGridProps = {
  /** Milliseconds to wait before showing the grid. Set to 0 to show immediately. Defaults to 120ms. */
  delay?: number;
  /** Size of each Botkin tile in points. Defaults to 15 (a 53pt grid). */
  cellSize?: number;
  /** Gap between tiles in points. Defaults to 4. */
  gap?: number;
  /** Accessibility label for the loading region. Defaults to "Loading". */
  label?: string;
  /** Optional custom tile color. Defaults to a theme color tuned for light, dark and glass backdrops. */
  color?: string;
  /** Optional custom eye color. Defaults to contrasting foreground for the tile color. */
  eyeColor?: string;
  style?: StyleProp<ViewStyle>;
};

export function LoadingGrid({
  delay = LOADING_GRID_DELAY_MS,
  cellSize = 15,
  gap = 4,
  label = "Loading",
  color,
  eyeColor,
  style,
}: LoadingGridProps) {
  const [shown, setShown] = useState(delay <= 0);
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const reduced = useReducedMotion();
  const clock = useSharedValue(0);

  useEffect(() => {
    if (delay <= 0) {
      setShown(true);
      return;
    }
    setShown(false);
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  useEffect(() => {
    if (!shown || reduced) {
      cancelAnimation(clock);
      clock.value = 0;
      return;
    }
    clock.value = 0;
    clock.value = withRepeat(
      withTiming(CYCLE_S, { duration: CYCLE_S * 1000, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(clock);
  }, [shown, reduced, clock]);

  if (!shown) return null;

  // On glass backdrops, use high-contrast ink tiles with crisp light/dark eyes so the tiny faces
  // stay sharp over blurred color; on clean light/dark surfaces use the theme's accent & onAccent.
  const tileColor =
    color ??
    (hasBackdrop
      ? tint(colors.ink, dark ? 0.86 : 0.78)
      : colors.accent);
  const resolvedEyeColor =
    eyeColor ??
    (hasBackdrop
      ? (dark ? "#1B1714" : "#FFFFFF")
      : colors.onAccent);
  const side = COLS * cellSize + (COLS - 1) * gap;

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={[{ alignItems: "center", justifyContent: "center" }, style]}
    >
      <View
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: side,
          height: side,
          flexDirection: "row",
          flexWrap: "wrap",
          gap,
        }}
      >
        {TILES.map((spec) => (
          <BotTile
            key={spec.key}
            spec={spec}
            clock={clock}
            size={cellSize}
            tileColor={tileColor}
            eyeColor={resolvedEyeColor}
            reduced={reduced}
          />
        ))}
      </View>
    </View>
  );
}
