// The picture of the computer's screen, the pointer drawn over it, and the touch surface.
import { type ReactNode, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector, useManualGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { chrome } from "./chrome";
import { type Fit, fitPicture, type GestureValues, NO_FIT, type ScreenGestures } from "./gestures";
import { PictureSlots } from "./Picture";
import type { Pictures, SlotName } from "./useFeed";

const ARROW = 24;

export function Stage({
  pictures,
  size,
  display,
  gestures,
  values,
  showPointer,
  drawn,
  children,
}: {
  pictures: Pictures;
  /** The picture's size in pixels. */
  size: { width: number; height: number } | null;
  /** The display's size, for scrolling distances. */
  display: { width: number; height: number } | null;
  gestures: ScreenGestures;
  values: GestureValues;
  showPointer: boolean;
  drawn: (slot: SlotName, id: number, promote?: boolean) => void;
  children?: ReactNode;
}) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const fit = fitPicture(box, size);
  const fitValue = useSharedValue<Fit>(NO_FIT);

  const displayWidth = display?.width ?? size?.width ?? 1;
  const displayHeight = display?.height ?? size?.height ?? 1;
  useEffect(() => {
    gestures.layout(fit, { width: displayWidth, height: displayHeight });
    fitValue.value = fit;
  }, [gestures, fitValue, fit, displayWidth, displayHeight]);

  const gesture = useManualGesture({
    disableReanimated: true,
    onTouchesDown: (event) => gestures.down(event),
    onTouchesMove: (event) => gestures.move(event),
    onTouchesUp: (event) => gestures.up(event),
    onTouchesCancel: () => gestures.cancel(),
  });

  const zoomed = useAnimatedStyle(() => ({
    transform: [{ translateX: values.x.value }, { translateY: values.y.value }, { scale: values.scale.value }],
  }));
  const pointer = useAnimatedStyle(() => {
    const f = fitValue.value;
    const cx = f.width / 2;
    const cy = f.height / 2;
    const s = values.scale.value;
    const x = cx + values.x.value + s * (f.left + values.pointerX.value * f.imageWidth - cx);
    const y = cy + values.y.value + s * (f.top + values.pointerY.value * f.imageHeight - cy);
    return { opacity: f.imageWidth > 0 ? 1 : 0, transform: [{ translateX: x - 2 }, { translateY: y - 2 }] };
  });

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        style={styles.fill}
        onLayout={({ nativeEvent }) => setBox({ width: nativeEvent.layout.width, height: nativeEvent.layout.height })}
        accessibilityLabel="Your computer's screen"
        accessibilityHint="Use one finger to move the pointer and tap to click."
      >
        {fit.imageWidth > 0 && (
          <Animated.View style={[{ position: "absolute", left: fit.left, top: fit.top, width: fit.imageWidth, height: fit.imageHeight }, zoomed]} pointerEvents="none">
            <PictureSlots pictures={pictures} drawn={drawn} />
          </Animated.View>
        )}
        {showPointer && (
          <Animated.View style={[styles.pointer, pointer]} pointerEvents="none">
            <Svg width={ARROW} height={ARROW} viewBox="0 0 24 24">
              <Path d="M2 2 L2 19.5 L6.6 15.2 L9.9 22.4 L13 21 L9.8 13.9 L16.2 13.9 Z" fill={chrome.ink} stroke={chrome.inkOn} strokeWidth={1.4} strokeLinejoin="round" />
            </Svg>
          </Animated.View>
        )}
        {children}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: "hidden" },
  pointer: { position: "absolute", left: 0, top: 0, width: ARROW, height: ARROW },
});
