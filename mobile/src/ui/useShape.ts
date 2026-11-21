// The screen's shape for the app's layout (see shape.ts): the side rail, the room for the tab bar,
// whether there is room for two panes, and the fold on a partly open iPhone Duo.
import { useMemo } from "react";
import { I18nManager, Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";
import { Fold } from "../../modules/botkins-fold";
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
  return useMemo(
    () => shapeOf({ width, height, insets, tabBar: TAB_BAR_ROOM, native, rtl: I18nManager.isRTL }),
    [width, height, insets, native],
  );
}
