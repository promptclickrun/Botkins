// The thinking slider: a track with a stop for each level the model has, and the bot's own face as
// the knob. Drag the face or tap the track. The higher the level, the more the bot has on its mind:
// the track fills with thought bubbles behind it, and the face goes from asleep (thinking off) to
// hard at work. Ink only, as everywhere: the bot is the color. The numbers are thinking.ts; the
// drag is the same as the app's plain Slider (src/ui/Slider.tsx).
import { useEffect, useMemo, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { GestureDetector, useCompetingGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import { Zap } from "lucide-react-native";
import Animated, { Easing, type SharedValue, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSpring, withTiming } from "react-native-reanimated";
import type { Bot } from "@/link/types";
import { effortLabel } from "@/state/models";
import { BotAvatar, Glass, haptic, space, T, Tap, useTheme } from "@/ui";
import { type Bubble, bubbles, bubbleShows, heatOf, isOff, moodAt, shortEffort, SLIDER, stopAt, stopX } from "./thinking";

const SPRING = { damping: 18, stiffness: 240, mass: 0.9 };
const DRIFT_MS = 7000;

/** One thought bubble: it comes and goes with the level, and drifts a little while it shows. */
function Thought({ bubble, shows, left, top, drift, color }: { bubble: Bubble; shows: boolean; left: number; top: number; drift: SharedValue<number>; color: string }) {
  const seen = useSharedValue(shows ? 1 : 0);
  useEffect(() => {
    seen.value = withTiming(shows ? 1 : 0, { duration: shows ? 260 : 140 });
  }, [shows, seen]);
  const style = useAnimatedStyle(() => {
    const turn = (drift.value + bubble.phase) * 2 * Math.PI;
    return {
      opacity: seen.value * (bubble.ring ? 0.55 : 0.4),
      transform: [{ translateX: Math.cos(turn) * 1.5 }, { translateY: Math.sin(turn) * 3 }, { scale: 0.6 + 0.4 * seen.value }],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: "absolute", left: left - bubble.size / 2, top: top - bubble.size / 2, width: bubble.size, height: bubble.size, borderRadius: bubble.size / 2 }, bubble.ring ? { borderWidth: 1.5, borderColor: color } : { backgroundColor: color }, style]}
    />
  );
}

export type ThinkingSliderProps = {
  /** The model's levels, lowest first. */
  levels: string[];
  /** The level on show. */
  value: string;
  /** The model's own level, named beside the value when it is the one on show. */
  usual?: string;
  onChange: (level: string) => void;
  /** Whose face the knob is. Without a bot the knob is plain. */
  bot?: Bot;
};

export function ThinkingSlider({ levels, value, usual, onChange, bot }: ThinkingSliderProps) {
  const { colors } = useTheme();
  const still = useReducedMotion();
  const [width, setWidth] = useState(0);
  const count = levels.length;
  const index = Math.max(0, levels.indexOf(value));
  const heat = heatOf(index, count);
  const off = isOff(levels[index]);
  const knobX = stopX(index, count, width);
  const field = useMemo(() => bubbles(), []);

  // The knob slides to its stop. It starts there, with no slide, once the track knows its width.
  const x = useSharedValue(0);
  const placed = useSharedValue(0);
  useEffect(() => {
    if (width <= 0) return;
    x.value = placed.value ? withSpring(knobX, SPRING) : knobX;
    placed.value = 1;
  }, [knobX, width, x, placed]);
  const lift = useSharedValue(1);
  const knob = useAnimatedStyle(() => ({ opacity: placed.value, transform: [{ translateX: x.value - SLIDER.knob / 2 }, { scale: lift.value }] }));
  // One slow turn that every bubble drifts on. Still with Reduce Motion.
  const drift = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    drift.value = withRepeat(withTiming(1, { duration: DRIFT_MS, easing: Easing.linear }), -1, false);
    return () => {
      drift.value = 0;
    };
  }, [still, drift]);

  const pick = (touch: number) => {
    if (width <= 0 || count <= 1) return;
    const next = stopAt(touch, count, width);
    if (next !== index) {
      haptic.select();
      onChange(levels[next]);
    }
  };
  const raise = (up: boolean) => {
    lift.value = withSpring(up ? 1.1 : 1, { damping: 16, stiffness: 320 });
  };
  const pan = usePanGesture({
    runOnJS: true,
    onBegin: () => raise(true),
    activeOffsetX: [-4, 4],
    failOffsetY: [-14, 14],
    onActivate: (event) => pick(event.x),
    onUpdate: (event) => pick(event.x),
    onDeactivate: () => raise(false),
    onFinalize: () => raise(false),
  });
  const tap = useTapGesture({ runOnJS: true, onActivate: (event) => pick(event.x) });
  const gesture = useCompetingGestures(pan, tap);
  const nudge = (by: number) => {
    const next = Math.max(0, Math.min(count - 1, index + by));
    if (next !== index) onChange(levels[next]);
  };

  const name = effortLabel(levels[index] ?? value);
  if (count === 0) return null;
  return (
    <View style={{ gap: space.xs }}>
      <GestureDetector gesture={gesture}>
        <View
          onLayout={(event: LayoutChangeEvent) => setWidth(Math.round(event.nativeEvent.layout.width))}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Thinking"
          accessibilityValue={{ min: 0, max: Math.max(0, count - 1), now: index, text: name + (levels[index] === usual ? ", the model's default" : "") }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) => nudge(event.nativeEvent.actionName === "increment" ? 1 : -1)}
          style={{ height: SLIDER.height }}
        >
          <Glass style={{ height: SLIDER.height, borderRadius: SLIDER.height / 2, overflow: "hidden" }}>
            {width > 0 &&
              field.map((bubble, i) => (
                <Thought
                  key={i}
                  bubble={bubble}
                  shows={bubbleShows(bubble, heat, knobX, width)}
                  left={SLIDER.pad + bubble.u * (width - 2 * SLIDER.pad)}
                  top={bubble.v * SLIDER.height}
                  drift={drift}
                  color={colors.ink}
                />
              ))}
          </Glass>
          <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, top: (SLIDER.height - SLIDER.knob) / 2, width: SLIDER.knob, height: SLIDER.knob, borderRadius: SLIDER.knob / 2, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" }, knob]}>
            {bot ? <BotAvatar bot={bot} state={moodAt(heat, off)} size={SLIDER.face} badge={false} /> : <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: colors.ink }} />}
          </Animated.View>
        </View>
      </GestureDetector>
      {/* Each level's short name under its stop. */}
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 18 }}>
        {width > 0 &&
          levels.map((level, i) => (
            <View key={level} style={{ position: "absolute", left: stopX(i, count, width) - 30, width: 60, alignItems: "center" }}>
              <T variant="caption" color={i === index ? "ink" : "faint"} numberOfLines={1} maxFontSizeMultiplier={1.1} style={count > 6 && { fontSize: 10.5 }}>
                {shortEffort(level)}
              </T>
            </View>
          ))}
      </View>
    </View>
  );
}

/** The Fast switch beside the slider: one round button, filled when fast mode is on. */
export function FastSwitch({ on, onChange, disabled, name }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; name: string }) {
  const { colors } = useTheme();
  const fill = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    fill.value = withTiming(on ? 1 : 0, { duration: 180 });
  }, [on, fill]);
  const filled = useAnimatedStyle(() => ({ opacity: fill.value, transform: [{ scale: 0.7 + 0.3 * fill.value }] }));
  return (
    <View style={{ width: SLIDER.height, alignItems: "center", gap: space.xs, opacity: disabled ? 0.4 : 1 }}>
      <Tap
        onPress={() => {
          haptic.select();
          onChange(!on);
        }}
        disabled={disabled}
        sink={0.92}
        accessibilityRole="switch"
        accessibilityLabel="Fast mode"
        accessibilityState={{ checked: on, disabled: !!disabled }}
        accessibilityValue={{ text: on ? name : "Off" }}
        accessibilityHint={disabled ? "This model has no fast mode" : undefined}
      >
        <Glass style={{ width: SLIDER.height, height: SLIDER.height, borderRadius: SLIDER.height / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderRadius: SLIDER.height / 2, backgroundColor: colors.ink }, filled]} />
          <Zap size={22} color={on ? colors.canvas : colors.muted} fill={on ? colors.canvas : "transparent"} strokeWidth={2.2} />
        </Glass>
      </Tap>
      <View style={{ height: 18, justifyContent: "center" }}>
        <T variant="caption" color={on ? "ink" : "faint"} numberOfLines={1} maxFontSizeMultiplier={1.1}>
          {on ? "On" : "Off"}
        </T>
      </View>
    </View>
  );
}
