// A slider over whole steps: drag the thumb or tap the track. VoiceOver adjusts it a step at a time.
import { type ReactNode, useState } from "react";
import { type LayoutChangeEvent, type StyleProp, View, type ViewStyle } from "react-native";
import { GestureDetector, useCompetingGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import { haptic } from "./haptics";
import { useTheme } from "./theme";

const THUMB = 28;

export type SliderProps = {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** What a screen reader calls it. */
  label: string;
  /** Shown at the left and right ends of the track. */
  start?: ReactNode;
  end?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Slider({ value, min, max, step = 1, onChange, label, start, end, style }: SliderProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const steps = Math.round((max - min) / step);
  const part = steps > 0 ? (value - min) / (max - min) : 0;

  const pick = (x: number) => {
    if (width <= 0) return;
    const at = Math.max(0, Math.min(1, (x - THUMB / 2) / Math.max(1, width - THUMB)));
    const next = min + Math.round(at * steps) * step;
    if (next !== value) {
      haptic.select();
      onChange(next);
    }
  };
  const pan = usePanGesture({ runOnJS: true, activeOffsetX: [-4, 4], failOffsetY: [-12, 12], onActivate: (event) => pick(event.x), onUpdate: (event) => pick(event.x) });
  const tap = useTapGesture({ runOnJS: true, onActivate: (event) => pick(event.x) });
  const gesture = useCompetingGestures(pan, tap);

  const nudge = (by: number) => {
    const next = Math.max(min, Math.min(max, value + by * step));
    if (next !== value) onChange(next);
  };

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
          <View style={{ height: 4, marginHorizontal: THUMB / 2, borderRadius: 2, backgroundColor: colors.lineStrong }}>
            <View style={{ width: `${part * 100}%`, height: 4, borderRadius: 2, backgroundColor: colors.accent }} />
          </View>
          <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, height: 44, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: THUMB / 2 - 1 }}>
            {Array.from({ length: steps + 1 }, (_, index) => (
              <View key={index} style={{ width: 2, height: 2, borderRadius: 1, backgroundColor: colors.faint }} />
            ))}
          </View>
          <View
            pointerEvents="none"
            style={{ position: "absolute", left: `${part * 100}%`, marginLeft: -part * THUMB, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: colors.raised, borderWidth: 0.5, borderColor: colors.lineStrong, shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}
          />
        </View>
      </GestureDetector>
      {end}
    </View>
  );
}
