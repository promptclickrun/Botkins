// A color picker: a saturation and brightness square, a hue slider, a hex field and swatches.
// Dragging runs on the UI thread: the thumbs and the preview dot follow the finger every frame,
// and `onChange` hears about it at most every CHANGE_MS (and once more when the finger lifts), so a
// heavy preview elsewhere never slows the drag. Every color it gives is a valid "#rrggbb".
import { LinearGradient } from "expo-linear-gradient";
import { Check } from "lucide-react-native";
import { type ComponentProps, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { type Hsv, hexToHsv, hsvToHex, isHex, parseHex } from "@/data/lookTemplates";
import { Field } from "./Field";
import { Tap } from "./Tap";
import { radius, space, useTheme } from "./theme";

const CHANGE_MS = 50;
const THUMB = 28;
const HUE_BAR = 28;
const SWATCH = 32;
const HUES = ["#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ff0000"] as const;

export type ColorPickerProps = {
  value: string;
  /** While dragging (throttled) and after every other change. */
  onChange: (hex: string) => void;
  /** Once a color is settled on: the finger lifted, a swatch tapped, a hex entered. */
  onCommit?: (hex: string) => void;
  /** Swatches to offer, most useful first. */
  swatches?: readonly string[];
  /** Told when a drag starts and ends, so a scroll view around it can hold still. */
  onDragging?: (dragging: boolean) => void;
  /** What the color is for, for screen readers: "Shell". */
  label: string;
};

const percent = (unit: number) => Math.round(unit * 100) + "%";

export function ColorPicker({ value, onChange, onCommit, swatches = [], onDragging, label }: ColorPickerProps) {
  const { colors, control } = useTheme();
  const start = hexToHsv(isHex(value) ? value : "#000000");
  const h = useSharedValue(start.h);
  const s = useSharedValue(start.s);
  const v = useSharedValue(start.v);
  const width = useSharedValue(0);
  const hueWidth = useSharedValue(0);
  const last = useSharedValue(0);
  const [height, setHeight] = useState(0);
  // The last color this picker gave out. A `value` that differs came from elsewhere (a swatch, a
  // template, the hex field) and moves the thumbs; one that matches is our own echo.
  const said = useRef(value);
  const [hsv, setHsv] = useState<Hsv>(start);
  // The UI thread calls back into the handlers of the render it was made in, so it reads the
  // newest ones from here.
  const handlers = useRef({ onChange, onCommit, onDragging });
  useLayoutEffect(() => {
    handlers.current = { onChange, onCommit, onDragging };
  });

  useEffect(() => {
    if (!isHex(value) || value === said.current) return;
    said.current = value;
    const next = hexToHsv(value, { h: h.value, s: s.value });
    h.value = next.h;
    s.value = next.s;
    v.value = next.v;
    setHsv(next);
  }, [value, h, s, v]);

  const emit = (hex: string, done: boolean) => {
    said.current = hex;
    setHsv({ h: h.value, s: s.value, v: v.value });
    handlers.current.onChange(hex);
    if (done) handlers.current.onCommit?.(hex);
  };
  const dragging = (on: boolean) => handlers.current.onDragging?.(on);

  /** Runs on the UI thread: tells the JS side, at most every CHANGE_MS unless `done`. */
  const tell = (done: boolean) => {
    "worklet";
    const now = Date.now();
    if (!done && now - last.value < CHANGE_MS) return;
    last.value = now;
    scheduleOnRN(emit, hsvToHex({ h: h.value, s: s.value, v: v.value }), done);
  };

  const square = usePanGesture({
    minDistance: 0,
    onBegin: (event) => {
      "worklet";
      if (width.value <= 0) return;
      s.value = Math.min(1, Math.max(0, event.x / width.value));
      v.value = 1 - Math.min(1, Math.max(0, event.y / Math.max(1, squareHeight(width.value))));
      scheduleOnRN(dragging, true);
      tell(false);
    },
    onUpdate: (event) => {
      "worklet";
      if (width.value <= 0) return;
      s.value = Math.min(1, Math.max(0, event.x / width.value));
      v.value = 1 - Math.min(1, Math.max(0, event.y / Math.max(1, squareHeight(width.value))));
      tell(false);
    },
    onFinalize: () => {
      "worklet";
      scheduleOnRN(dragging, false);
      tell(true);
    },
  });

  const hue = usePanGesture({
    minDistance: 0,
    onBegin: (event) => {
      "worklet";
      if (hueWidth.value <= THUMB) return;
      h.value = hueAt(event.x, hueWidth.value);
      scheduleOnRN(dragging, true);
      tell(false);
    },
    onUpdate: (event) => {
      "worklet";
      if (hueWidth.value <= THUMB) return;
      h.value = hueAt(event.x, hueWidth.value);
      tell(false);
    },
    onFinalize: () => {
      "worklet";
      scheduleOnRN(dragging, false);
      tell(true);
    },
  });

  const pure = useAnimatedStyle(() => ({ backgroundColor: hsvToHex({ h: h.value, s: 1, v: 1 }) }));
  const current = useAnimatedStyle(() => ({ backgroundColor: hsvToHex({ h: h.value, s: s.value, v: v.value }) }));
  const squareThumb = useAnimatedStyle(() => ({ transform: [{ translateX: s.value * width.value - THUMB / 2 }, { translateY: (1 - v.value) * squareHeight(width.value) - THUMB / 2 }] }));
  const hueThumb = useAnimatedStyle(() => ({ transform: [{ translateX: (h.value / 360) * Math.max(0, hueWidth.value - THUMB) }] }));
  const hueColor = useAnimatedStyle(() => ({ backgroundColor: hsvToHex({ h: h.value, s: 1, v: 1 }) }));

  /** A color from outside the drag: a swatch, the hex field, an accessibility action. */
  const choose = (hex: string) => {
    const next = hexToHsv(hex, { h: h.value, s: s.value });
    h.value = next.h;
    s.value = next.s;
    v.value = next.v;
    emit(hex, true);
  };
  const nudge = (change: Partial<Hsv>) => {
    const next = { h: (h.value + (change.h ?? 0) + 360) % 360, s: Math.min(1, Math.max(0, s.value + (change.s ?? 0))), v: Math.min(1, Math.max(0, v.value + (change.v ?? 0))) };
    h.value = next.h;
    s.value = next.s;
    v.value = next.v;
    emit(hsvToHex(next), true);
  };

  const onSquareLayout = (event: LayoutChangeEvent) => {
    width.value = event.nativeEvent.layout.width;
    setHeight(squareHeight(event.nativeEvent.layout.width));
  };

  const shown = [...new Set(swatches.filter(isHex))].slice(0, 12);

  return (
    <View style={{ gap: space.lg }}>
      <GestureDetector gesture={square}>
        <View
          onLayout={onSquareLayout}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label + " saturation and brightness"}
          accessibilityValue={{ text: percent(hsv.s) + " saturation, " + percent(hsv.v) + " brightness" }}
          accessibilityActions={[{ name: "increment", label: "Brighter" }, { name: "decrement", label: "Darker" }, { name: "more", label: "More saturated" }, { name: "less", label: "Less saturated" }]}
          onAccessibilityAction={(event) => {
            const name = event.nativeEvent.actionName;
            nudge(name === "increment" ? { v: 0.05 } : name === "decrement" ? { v: -0.05 } : name === "more" ? { s: 0.05 } : { s: -0.05 });
          }}
          style={{ height: Math.max(1, height), borderRadius: radius.md }}
        >
          <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: radius.md, overflow: "hidden" }, pure]}>
            <LinearGradient colors={["#ffffff", "rgba(255,255,255,0)"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
            <LinearGradient colors={["rgba(0,0,0,0)", "#000000"]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
          </Animated.View>
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong }]} />
          <Thumb style={[squareThumb, current]} />
        </View>
      </GestureDetector>

      <GestureDetector gesture={hue}>
        <View
          onLayout={(event) => {
            hueWidth.value = event.nativeEvent.layout.width;
          }}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label + " hue"}
          accessibilityValue={{ min: 0, max: 360, now: Math.round(hsv.h), text: Math.round(hsv.h) + " degrees" }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) => nudge({ h: event.nativeEvent.actionName === "increment" ? 10 : -10 })}
          style={{ height: 44, justifyContent: "center" }}
        >
          <LinearGradient colors={HUES} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ height: HUE_BAR, borderRadius: HUE_BAR / 2, marginHorizontal: THUMB / 2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong }} />
          <Thumb style={[{ position: "absolute", left: 0, top: (44 - THUMB) / 2 }, hueThumb, hueColor]} />
        </View>
      </GestureDetector>

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Animated.View style={[{ width: control.field, height: control.field, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong }, current]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        <HexField value={value} onEnter={choose} label={label} />
      </View>

      {shown.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", marginHorizontal: -(44 - SWATCH) / 2 }}>
          {shown.map((swatch) => {
            const selected = swatch === value;
            return (
              <Tap key={swatch} onPress={() => choose(swatch)} feel="select" sink={0.9} accessibilityLabel={"Color " + swatch.slice(1).toUpperCase()} accessibilityState={{ selected }} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
                <View style={{ width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2, backgroundColor: swatch, borderWidth: selected ? 2.5 : StyleSheet.hairlineWidth, borderColor: selected ? colors.accent : colors.lineStrong, alignItems: "center", justifyContent: "center" }}>
                  {selected && (
                    <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" }}>
                      <Check size={10} color={colors.onAccent} strokeWidth={3.4} />
                    </View>
                  )}
                </View>
              </Tap>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** The square is wide and a little short, so the hue and the hex stay in view under it. */
function squareHeight(width: number) {
  "worklet";
  return Math.round(Math.min(220, Math.max(120, width * 0.6)));
}

function hueAt(x: number, width: number) {
  "worklet";
  const at = Math.min(1, Math.max(0, (x - THUMB / 2) / Math.max(1, width - THUMB)));
  return Math.min(359.99, at * 360);
}

/** A thumb that reads on any color: a white ring with a dark edge and a soft shadow. */
function Thumb({ style }: { style: ComponentStyle }) {
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", left: 0, top: 0, width: THUMB, height: THUMB, borderRadius: THUMB / 2, borderWidth: 3, borderColor: "#ffffff", shadowColor: "#000000", shadowOpacity: 0.35, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3 },
        style,
      ]}
    />
  );
}
type ComponentStyle = ComponentProps<typeof Animated.View>["style"];

/** The hex field: shows the color as it changes, and takes a typed one once it is whole. */
function HexField({ value, onEnter, label }: { value: string; onEnter: (hex: string) => void; label: string }) {
  const shown = value.toUpperCase();
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(shown);
  }, [shown, editing]);

  // Six digits take effect as they are typed; three ("C5E") only when the person is done.
  const take = (typed: string, final: boolean) => {
    const raw = typed.replace(/[^0-9a-f]/gi, "").slice(0, 6);
    setText("#" + raw.toUpperCase());
    const hex = raw.length === 6 || final ? parseHex(raw) : null;
    if (hex && hex !== value) onEnter(hex);
  };
  const finish = () => {
    take(text, true);
    setEditing(false);
  };

  return (
    <Field
      value={text}
      onChangeText={(typed) => take(typed, false)}
      onFocus={() => setEditing(true)}
      onBlur={finish}
      onSubmitEditing={finish}
      autoCapitalize="characters"
      autoCorrect={false}
      spellCheck={false}
      maxLength={7}
      returnKeyType="done"
      mono
      accessibilityLabel={label + " hex color"}
      accessibilityHint="Six digits, like C75E35"
      containerStyle={{ flex: 1 }}
    />
  );
}
