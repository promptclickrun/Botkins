// A slider over whole steps: drag the thumb or tap the track. VoiceOver adjusts it a step at a time.
import { type ReactNode, useRef, useState } from "react";
import { type LayoutChangeEvent, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { GestureDetector, useCompetingGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { usePrefs } from "@/state/prefs";
import { Glass, hasGlass } from "./Glass";
import { haptic } from "./haptics";
import { useTheme } from "./theme";

const THUMB_W = 34;
const THUMB_H = 24;
/** The least room a step's dot needs, so the dots read as steps and stay on the track. */
const TICK_ROOM = 6;

export type SliderProps = {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** Called once when the person lets go (a drag ends, a tap, a VoiceOver step), with the value then. For a change that is sent somewhere once. */
  onEnd?: (value: number) => void;
  /** What a screen reader calls it. */
  label: string;
  /** Shown at the left and right ends of the track. */
  start?: ReactNode;
  end?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Slider({ value, min, max, step = 1, onChange, onEnd, label, start, end, style }: SliderProps) {
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const [width, setWidth] = useState(0);
  // The value last picked, for onEnd: the gesture's end can come before the screen has drawn it.
  const last = useRef(value);
  const thumbScale = useSharedValue(1);
  const steps = Math.round((max - min) / step);
  const part = steps > 0 ? (value - min) / (max - min) : 0;
  // A dot for each step, only where they fit apart: a 0 to 100 slider in a row would draw them past its end.
  const ticks = width > 0 && (steps + 1) * TICK_ROOM <= width - THUMB_W;

  const liftThumb = (up: boolean) => {
    thumbScale.value = withSpring(up ? 1.15 : 1, { damping: 16, stiffness: 320 });
  };
  const thumbAnim = useAnimatedStyle(() => ({
    transform: [{ scale: thumbScale.value }],
  }));

  const pick = (x: number) => {
    if (width <= 0) return;
    const at = Math.max(0, Math.min(1, (x - THUMB_W / 2) / Math.max(1, width - THUMB_W)));
    const next = min + Math.round(at * steps) * step;
    last.current = next;
    if (next !== value) {
      haptic.select();
      onChange(next);
    }
  };
  const pan = usePanGesture({
    runOnJS: true,
    onBegin: () => {
      last.current = value;
      liftThumb(true);
    },
    activeOffsetX: [-4, 4],
    failOffsetY: [-12, 12],
    onActivate: (event) => pick(event.x),
    onUpdate: (event) => pick(event.x),
    onDeactivate: () => {
      liftThumb(false);
      onEnd?.(last.current);
    },
    onFinalize: () => liftThumb(false),
  });
  const tap = useTapGesture({
    runOnJS: true,
    onActivate: (event) => {
      last.current = value;
      pick(event.x);
      onEnd?.(last.current);
    },
  });
  const gesture = useCompetingGestures(pan, tap);

  const nudge = (by: number) => {
    const next = Math.max(min, Math.min(max, value + by * step));
    if (next !== value) {
      onChange(next);
      onEnd?.(next);
    }
  };

  const trackBg = hasBackdrop ? (dark ? "rgba(255,255,255,0.18)" : "rgba(15,23,42,0.14)") : colors.lineStrong;
  const useGlassThumb = hasBackdrop || hasGlass();

  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 12 }, style]}>
      {start}
      <GestureDetector gesture={gesture}>
        <View
          onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityValue={{ min, max, now: value, text: String(value) }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) => nudge(event.nativeEvent.actionName === "increment" ? 1 : -1)}
          style={{ flex: 1, height: 44, justifyContent: "center" }}
        >
          <View style={{ height: 6, marginHorizontal: THUMB_W / 2, borderRadius: 3, backgroundColor: trackBg, overflow: "hidden" }}>
            <View style={{ width: `${part * 100}%`, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
          </View>
          {ticks && (
            <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, height: 44, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: THUMB_W / 2 - 1 }}>
              {Array.from({ length: steps + 1 }, (_, index) => (
                <View key={index} style={{ width: 2, height: 2, borderRadius: 1, backgroundColor: colors.faint }} />
              ))}
            </View>
          )}
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                left: `${part * 100}%`,
                marginLeft: -part * THUMB_W,
                width: THUMB_W,
                height: THUMB_H,
                borderRadius: THUMB_H / 2,
                shadowColor: "#000",
                shadowOpacity: dark ? 0.34 : 0.18,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 2 },
                elevation: 3,
              },
              thumbAnim,
            ]}
          >
            {useGlassThumb ? (
              <Glass
                glassEffectStyle="clear"
                tintColor={dark ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.88)"}
                style={{
                  width: THUMB_W,
                  height: THUMB_H,
                  borderRadius: THUMB_H / 2,
                  overflow: "hidden",
                }}
              />
            ) : (
              <View
                style={{
                  width: THUMB_W,
                  height: THUMB_H,
                  borderRadius: THUMB_H / 2,
                  backgroundColor: colors.raised,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.lineStrong,
                }}
              />
            )}
          </Animated.View>
        </View>
      </GestureDetector>
      {end}
    </View>
  );
}
