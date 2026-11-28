// The screen's shape for the app's layout (see shape.ts): the side rail, the room for the tab bar,
// whether there is room for two panes, and the fold on a partly open iPhone Duo.
import { useMemo } from "react";
import { I18nManager, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";
import { Fold } from "../../modules/botkins-fold";
import { usePageRoot } from "./pageRoot";
import { type NativeFoldState, shapeOf } from "./shape";

/** The room a bottom tab bar takes. */
export const TAB_BAR_ROOM = Platform.select({ ios: 64, default: 96 });

// Named like a hook so the React Compiler treats it as one (see AGENTS.md).
const useFoldState = create<{ native: NativeFoldState | null }>(() => ({ native: null }));
let following = false;
function follow() {
  if (following || !Fold) return;
  following = true;
  try {
    if (!Fold.available()) return;
  } catch {
    return;
  }
  Fold.addListener("changed", (native) => useFoldState.setState({ native }));
  void Fold.state().then((native) => useFoldState.setState({ native }), () => {});
}

follow();

export function useShape() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const native = useFoldState((state) => state.native);
  // A tab's root shown as a pushed page has no tab bar to clear (see pageRoot.tsx).
  const page = usePageRoot();
  return useMemo(() => {
    const shape = shapeOf({ width, height, insets, tabBar: TAB_BAR_ROOM, native, rtl: I18nManager.isRTL, ios: Platform.OS === "ios" && !Platform.isPad });
    return page ? { ...shape, rail: null, left: 0, right: 0, tabRoom: 0 } : shape;
  }, [width, height, insets, native, page]);
}
