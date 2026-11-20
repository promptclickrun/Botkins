import { AlertCircle, CheckCircle2, Info } from "lucide-react-native";
import { useEffect } from "react";
import { AccessibilityInfo, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@/state/store";
import { T } from "./Text";
import { lift, radius, space, useTheme } from "./theme";

/** The one place short messages appear: something worked, or it didn't and why. */
export function ToastHost() {
  const theme = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const toast = useApp((state) => state.toast);
  useEffect(() => {
    if (toast) AccessibilityInfo.announceForAccessibility(toast.text);
  }, [toast]);
  if (!toast) return null;
  const Icon = toast.tone === "error" ? AlertCircle : toast.tone === "success" ? CheckCircle2 : Info;
  const color = toast.tone === "error" ? colors.danger : toast.tone === "success" ? colors.success : colors.info;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: insets.top + space.sm, alignItems: "center", paddingHorizontal: space.xl, zIndex: 100 }}>
      <Animated.View
        key={toast.id}
        entering={FadeInUp.springify().damping(18)}
        exiting={FadeOutUp.duration(160)}
        style={[{ flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: 420, paddingVertical: 12, paddingHorizontal: space.lg, borderRadius: radius.lg, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.line }, lift(theme, 2)]}
      >
        <Icon size={18} color={color} strokeWidth={2.3} />
        <T variant="subhead" weight="500" style={{ flexShrink: 1 }} numberOfLines={3}>
          {toast.text}
        </T>
      </Animated.View>
    </View>
  );
}
