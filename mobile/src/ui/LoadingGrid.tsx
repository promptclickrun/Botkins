// A quiet animated 3×3 grid of rounded squares that pulse in a diagonal wave on the UI thread
// (Reanimated), so it keeps moving even while JS is busy rendering deferred content. Shown only
// after `delay` ms (default 120ms) so fast switches never flash a loader.
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
const ROWS = 3;
const PERIOD_MS = 1100;
const CELLS = Array.from({ length: COLS * ROWS }, (_, index) => {
  const row = Math.floor(index / COLS);
  const col = index % COLS;
  // Diagonal wave phase (0..1) from top-left to bottom-right.
  return { key: index, phase: (row + col) / ((ROWS - 1) + (COLS - 1) + 1) };
});

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

/** One square in the grid. Computes its own pulse from the shared clock on the UI thread. */
function GridCell({
  clock,
  phase,
  size,
  color,
  reduced,
}: {
  clock: SharedValue<number>;
  phase: number;
  size: number;
  color: string;
  reduced: boolean;
}) {
  const radius = Math.max(2, Math.round(size * 0.34));
  const animated = useAnimatedStyle(() => {
    "worklet";
    if (reduced) {
      const rest = 0.35 + (1 - phase) * 0.45;
      return { opacity: rest, transform: [{ scale: 0.92 }] };
    }
    // Smooth cosine wave shifted by this cell's diagonal phase.
    const t = (clock.value - phase + 1) % 1;
    const wave = 0.5 + 0.5 * Math.cos(t * Math.PI * 2);
    return {
      opacity: 0.22 + wave * 0.78,
      transform: [{ scale: 0.76 + wave * 0.24 }],
    };
  }, [phase, reduced]);
  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: color,
        },
        animated,
      ]}
    />
  );
}

export type LoadingGridProps = {
  /** Milliseconds to wait before showing the grid. Set to 0 to show immediately. Defaults to 120ms. */
  delay?: number;
  /** Size of each cell in points. Defaults to 7 (a 29pt grid). */
  cellSize?: number;
  /** Gap between cells in points. Defaults to 4. */
  gap?: number;
  /** Accessibility label for the loading region. Defaults to "Loading". */
  label?: string;
  /** Optional custom cell color. Defaults to a theme color tuned for light, dark and glass backdrops. */
  color?: string;
  style?: StyleProp<ViewStyle>;
};

export function LoadingGrid({
  delay = LOADING_GRID_DELAY_MS,
  cellSize = 7,
  gap = 4,
  label = "Loading",
  color,
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
      withTiming(1, { duration: PERIOD_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(clock);
  }, [shown, reduced, clock]);

  if (!shown) return null;

  // On glass backdrops, lean into ink with subtle alpha so the wave reads cleanly over blurred color;
  // on clean light/dark canvases use accentText / ink2 so both colorful and Ink themes look sharp.
  const cellColor =
    color ??
    (hasBackdrop
      ? tint(colors.ink, dark ? 0.82 : 0.72)
      : tint(colors.accent, dark ? 0.9 : 0.82));
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
        {CELLS.map((cell) => (
          <GridCell
            key={cell.key}
            clock={clock}
            phase={cell.phase}
            size={cellSize}
            color={cellColor}
            reduced={reduced}
          />
        ))}
      </View>
    </View>
  );
}
