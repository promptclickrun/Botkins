import { createContext, type ReactNode, useContext } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { haptic } from "./haptics";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type TapProps = Omit<PressableProps, "style" | "children"> & {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** How far the surface sinks when pressed. 1 keeps it still. */
  sink?: number;
  /** The tap felt on press. */
  feel?: "tap" | "select" | "none";
};

/** True inside a menu that opens on a hold (HoldMenu). */
export const InHoldMenu = createContext(false);
const nothing = () => {};
/** A little sooner than iOS opens a held menu, so the hold is already "not a tap" when the menu shows. */
export const HOLD_MS = 350;

/** Anything pressable: it sinks a little under the finger and gives a light tap. */
export function Tap({ children, style, sink = 0.97, feel = "tap", onPress, disabled, ...props }: TapProps) {
  const pressed = useSharedValue(0);
  // Inside a held menu, a hold opens the menu and must not also count as a tap when the finger
  // lifts. A press with a long-press handler doesn't fire `onPress` after the hold, so it gets one.
  const inMenu = useContext(InHoldMenu);
  const hold = inMenu && !props.onLongPress ? { onLongPress: nothing, delayLongPress: HOLD_MS } : null;
  // A disabled control is dimmed here, in the animated style: a plain `opacity` beside it would be overridden.
  const dim = disabled ? 0.45 : 1;
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: 1 - pressed.value * (1 - sink) }], opacity: dim * (1 - pressed.value * 0.12) }), [dim, sink]);
  return (
    <AnimatedPressable
      accessibilityRole="button"
      hitSlop={6}
      {...props}
      {...hold}
      disabled={disabled}
      onPressIn={(event) => {
        pressed.value = withTiming(1, { duration: 80 });
        props.onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withSpring(0, { damping: 18, stiffness: 320 });
        props.onPressOut?.(event);
      }}
      onPress={(event) => {
        if (feel === "tap") haptic.tap();
        else if (feel === "select") haptic.select();
        onPress?.(event);
      }}
      style={[style, animated]}
    >
      {children}
    </AnimatedPressable>
  );
}
