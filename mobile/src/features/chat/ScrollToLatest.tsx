// The round button that floats over the bottom of a chat when the newest message is out of view.
// A tap goes back to it. The chat is drawn newest-first from the bottom (an inverted list), so
// "how far from the newest" is simply the list's scroll offset (scroll.ts has when it shows).
import { ArrowDown } from "lucide-react-native";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { slopFor, Tap, useTheme } from "@/ui";

const SIZE = 40;

/** `bottom`: how far over the chat's bottom it floats, clear of the message box that floats there too. */
export function ScrollToLatest({ shown, onPress, bottom = 10 }: { shown: boolean; onPress: () => void; bottom?: number }) {
  const { colors } = useTheme();
  const there = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    there.value = withTiming(shown ? 1 : 0, { duration: shown ? 180 : 140 });
  }, [shown, there]);
  const style = useAnimatedStyle(() => ({ opacity: there.value, transform: [{ scale: 0.8 + there.value * 0.2 }] }));
  return (
    <Animated.View pointerEvents={shown ? "box-none" : "none"} style={[{ position: "absolute", left: 0, right: 0, bottom, alignItems: "center" }, style]} accessibilityElementsHidden={!shown} importantForAccessibility={shown ? "auto" : "no-hide-descendants"}>
      <Tap onPress={onPress} disabled={!shown} sink={0.92} hitSlop={slopFor(SIZE)} accessibilityLabel="Scroll to latest message">
        {/* Opaque surface button: avoids an extra backdrop-blur layer over the streaming transcript. */}
        <View
          pointerEvents="none"
          style={{
            width: SIZE,
            height: SIZE,
            borderRadius: SIZE / 2,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.lineStrong,
          }}
        >
          <ArrowDown size={19} color={colors.ink} strokeWidth={2.4} />
        </View>
      </Tap>
    </Animated.View>
  );
}
