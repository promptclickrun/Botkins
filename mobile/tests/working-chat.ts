// The visible working island and chat header avatar with the phone's actual timer and animation
// effects. Native layout and native animation execution are supplied by the fixture.
import { createElement as el, Fragment, useState } from "react";
import { phoneModule } from "./render-phone";

const animation = { start() {}, stop() {} };
const native = {
  Text: "Text", View: "View", StyleSheet: {},
  Animated: { View: "AnimatedView", timing: () => animation, loop: () => animation, sequence: () => animation },
  Easing: { ease: (t) => t, inOut: (ease) => ease },
  AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
  useAnimatedValue: () => useState(() => ({ setValue() {}, interpolate: () => 0 }))[0],
  useWindowDimensions: () => ({ fontScale: 1, height: 800 }),
};
const svg = { __esModule: true, default: "Svg", Defs: "Defs", LinearGradient: "Gradient", Rect: "Rect", Stop: "Stop", G: "G", Circle: "Circle", Ellipse: "Ellipse", Path: "Path" };
const foreground = { useAppActive: (on) => on };
const router = { useIsFocused: () => true };
const look = { head: { name: "Blue", left: 85, right: 158, y: 121, tx: 0, ty: 0, scale: 1 }, eyes: "oval", ink: "black" };
export const { BotAvatar } = phoneModule("../src/ui/BotAvatar", {
  "react-native": native, "react-native-svg": svg, "expo-image": { Image: "Image" }, "@/state/useAppActive": foreground,
  "@/data/botLook": { lookOf: () => ({}), resolveLook: () => look },
  "@/state/prefs": { usePrefs: (select) => select({ avatarAnimations: true }) },
  "./useOnShow": { useOnShow: (on) => on }, "./avatarMotion": { useAvatarMotion: () => false },
});
const { Shimmer } = phoneModule("../src/ui/Shimmer", {
  "react-native": native, "expo-router": router, "react-native-svg": svg,
  "@react-native-masked-view/masked-view": "Mask", "@/state/useAppActive": foreground,
});
const elapsed = phoneModule("../src/features/chat/useElapsedClock", { "expo-router": router, "@/state/useAppActive": foreground });
const motion = { duration() { return this; }, reduceMotion() { return this; } };
const { Island } = phoneModule("../src/features/chat/Island", {
  "react-native": native, "react-native-svg": svg, "lucide-react-native": { ChevronRight: "Chevron" }, "expo-router": router,
  "react-native-reanimated": { __esModule: true, default: { View: "View" }, FadeInDown: motion, LinearTransition: motion, ReduceMotion: {}, LayoutAnimationConfig: "Layout" },
  "@/state/chatPrefs": { useChatPrefs: (select) => select({ steps: "show", thinking: "show" }) },
  "@/ui": { BotAvatar, useTheme: () => ({ colors: {}, type: { footnote: { lineHeight: 16 } } }), T: "T", Tap: "Tap" },
  "@/ui/Shimmer": { Shimmer }, "./WorkRows": {}, "./useElapsedClock": elapsed,
});

export function WorkingChat({ chatId, item, inView = true }) {
  return el(Fragment, null, el(BotAvatar, { state: "talking", animated: true, size: 30 }),
    el(Island, { chatId, item, group: false, inView }));
}
