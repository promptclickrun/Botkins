// Small taps under the finger. Off when the person turns haptics off in Appearance.
import * as Haptics from "expo-haptics";
import { usePrefs } from "@/state/prefs";

const on = () => usePrefs.getState().haptics;
export const haptic = {
  tap: () => on() && void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}),
  select: () => on() && void Haptics.selectionAsync().catch(() => {}),
  success: () => on() && void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
  warn: () => on() && void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}),
};
