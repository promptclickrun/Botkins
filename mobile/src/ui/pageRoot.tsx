// A tab's root screen shown as a pushed page. A tab's root lays itself out for the bar: under the
// status bar, beside the side rail, over the tab bar. Opened from All while it is not on the bar, the
// same screen is a page with a native bar and a back button, and nothing of the tab bar to clear.
// `PageRoot` tells it so without a change in the screen: the top inset becomes the room the native
// bar needs (none when the bar is solid and the page starts under it), the side insets go (the root
// stack already keeps a pushed page out of the rail), and `useShape().tabRoom` is 0.
import { HeaderHeightContext } from "expo-router/react-navigation";
import { createContext, type ReactNode, use, useMemo } from "react";
import { Platform } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { usePrefs } from "@/state/prefs";

const PageRootContext = createContext(false);

/** True inside a tab's root that is shown as a pushed page. */
export const usePageRoot = () => use(PageRootContext);

export function PageRoot({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const header = use(HeaderHeightContext) ?? 0;
  // Over a backdrop the native bar is see-through on an iPhone and the page runs under it (src/app/_layout.tsx).
  const under = usePrefs((prefs) => prefs.backdrop !== "clean") && Platform.OS === "ios";
  const value = useMemo(() => ({ top: under ? header : 0, bottom: insets.bottom, left: 0, right: 0 }), [under, header, insets.bottom]);
  return (
    <PageRootContext value>
      <SafeAreaInsetsContext.Provider value={value}>{children}</SafeAreaInsetsContext.Provider>
    </PageRootContext>
  );
}
