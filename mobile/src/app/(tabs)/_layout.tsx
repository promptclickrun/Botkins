import { needsYou } from "@/state/sessionActivity";
import { NativeTabs } from "expo-router/native-tabs";
import type { ReactElement } from "react";
import { isChatsPageUnread } from "@/features/chat/unread";
import { useSpacesOn } from "@/features/spaces/data";
import { useCan } from "@/state/hooks";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import type { TabId } from "@/state/tabs";
import { badgeColors, useTheme } from "@/ui";

export default function TabsLayout() {
  const theme = useTheme();
  const { colors } = theme;
  const badge = badgeColors(theme);
  const unread = useApp((state) => state.parts.chats?.filter(isChatsPageUnread).length ?? 0);
  const waiting = useApp((state) => needsYou(state.parts));
  // A computer without spaces, or a member who may not see them, has no Spaces tab.
  const spacesOn = useSpacesOn();
  const spaces = useCan("today", "view") && spacesOn;
  const order = usePrefs((prefs) => prefs.tabOrder);
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  // Each tab scrolls its own vertical view when reselected. Settings is a button on Home, not a tab.
  const tabs: Record<TabId, ReactElement> = {
    index: (
      <NativeTabs.Trigger key="index" name="index" disableScrollToTop>
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
      </NativeTabs.Trigger>
    ),
    chats: (
      <NativeTabs.Trigger key="chats" name="chats" disableScrollToTop>
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="forum" />
        {unread > 0 && <NativeTabs.Trigger.Badge>{String(unread)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
    ),
    spaces: (
      <NativeTabs.Trigger key="spaces" name="spaces" hidden={!spaces} disableScrollToTop>
        <NativeTabs.Trigger.Label>Spaces</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "square.stack.3d.up", selected: "square.stack.3d.up.fill" }} md="layers" />
      </NativeTabs.Trigger>
    ),
    work: (
      <NativeTabs.Trigger key="work" name="work" disableScrollToTop>
        <NativeTabs.Trigger.Label>Work</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bolt", selected: "bolt.fill" }} md="bolt" />
        {waiting > 0 && <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
    ),
    market: (
      <NativeTabs.Trigger key="market" name="market" disableScrollToTop>
        {/* Short on purpose: a long label widens its tab and the selected bubble next to it runs into it. */}
        <NativeTabs.Trigger.Label>Market</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }} md="apps" />
      </NativeTabs.Trigger>
    ),
  };
  // The person's own order (Settings › Appearance › Tabs). The bar is built again when it changes.
  // Omitting opaque backgroundColor when a backdrop is active lets the iOS Liquid Glass tab bar refract it.
  return (
    <NativeTabs key={order.join()} tintColor={colors.accent} backgroundColor={hasBackdrop ? undefined : colors.canvas} badgeBackgroundColor={badge.background} badgeTextColor={badge.text}>
      {order.map((id) => tabs[id])}
    </NativeTabs>
  );
}
