// A soft band of ink that sweeps across a muted line while the bot is on it, the way T3 Code marks
// the live row of a turn (ShimmeringWorkContent in apps/mobile/src/features/threads/thread-work-log.tsx).
//
// The line is drawn twice: `children` (muted) and `lit` (in ink) inside a window with soft edges
// (a gradient mask) that slides across with a native transform, while the copy inside slides back
// the same distance so it stays over the first. The value is native from creation and stepped on
// timers (shimmerSteps.ts): about four updates a second during a sweep, none in the rest between, and
// no React render for any of them. React Native's Animated with the native driver, not Reanimated
// (Design rule 9). It runs only while the screen is in view, the app is in front and the person
// has not asked for less motion; otherwise `lit` is drawn still, as the line was before.
import MaskedViewClass from "@react-native-masked-view/masked-view";
import { useIsFocused } from "expo-router";
import { type ComponentType, type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { AccessibilityInfo, Animated, StyleSheet, useAnimatedValue, View, type ViewProps, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useAppActive } from "@/state/useAppActive";
import { startShimmerSteps } from "./shimmerSteps";

// The package's types build its class from React Native's old `NativeMethods` mixin, which React
// Native 0.88's types no longer fit. Its props are these. (It ships natively already: expo-router
// depends on it, and SDK 58 links a dependency's native code too.)
const MaskedView = MaskedViewClass as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>;

/** The band's width, in points. */
const BAND = 72;

/** The phone's answer, kept for every line after the first, so a new line starts in the right state. */
let reducedKnown: boolean | undefined;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedKnown ?? true);
  useEffect(() => {
    let first = true;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      first = false;
      reducedKnown = value;
      setReduced(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      reducedKnown = value;
      if (first) setReduced(value);
    }, () => {});
    return () => subscription.remove();
  }, []);
  return reduced;
}

/**
 * `on`: the bot is on this line now. `children`: the line, drawn muted. `lit`: the same line in
 * ink, laid out exactly as `children`. Off, only `children` is drawn.
 */
export function Shimmer({ on, children, lit, style }: { on: boolean; children: ReactNode; lit: ReactNode; style?: ViewStyle }) {
  const reduced = useReducedMotion();
  const focused = useIsFocused();
  const front = useAppActive(on && focused && !reduced);
  const [room, setRoom] = useState(0);
  const [width, setWidth] = useState(0);
  const progress = useAnimatedValue(0, { useNativeDriver: true });
  const mask = "shimmer-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const running = on && !reduced && front && focused && width > 0;

  useEffect(() => {
    progress.setValue(0);
    if (!running) return;
    return startShimmerSteps(progress);
  }, [running, progress]);

  if (!on) return <View style={style}>{children}</View>;
  // Less motion: the line in ink, still, as it was drawn before the shimmer.
  if (reduced) return <View style={style}>{lit}</View>;

  const sweep = progress.interpolate({ inputRange: [0, 1], outputRange: [-BAND, width] });
  const back = progress.interpolate({ inputRange: [0, 1], outputRange: [BAND, -width] });
  return (
    <View style={[{ overflow: "hidden", minWidth: 0 }, style]} onLayout={(event) => setRoom(event.nativeEvent.layout.width)}>
      <View style={{ alignSelf: "flex-start", maxWidth: "100%" }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {children}
      </View>
      {running && (
        <Animated.View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: BAND, overflow: "hidden", transform: [{ translateX: sweep }] }}
        >
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id={mask} x1="0%" x2="100%" y1="0%" y2="0%">
                    <Stop offset="0" stopColor="white" stopOpacity={0} />
                    <Stop offset="0.15" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="0.35" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.5" stopColor="white" stopOpacity={1} />
                    <Stop offset="0.65" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.85" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="1" stopColor="white" stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill={`url(#${mask})`} />
              </Svg>
            }
          >
            <Animated.View style={{ width: room, transform: [{ translateX: back }] }}>
              <View style={{ alignSelf: "flex-start", maxWidth: "100%" }}>{lit}</View>
            </Animated.View>
          </MaskedView>
        </Animated.View>
      )}
    </View>
  );
}
