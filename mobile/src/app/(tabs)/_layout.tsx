import { needsYou } from "@/state/sessionActivity";
import { type Href, router, useSegments } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { type ReactElement, useEffect, useMemo } from "react";
import { isChatsPageUnread } from "@/features/chat/unread";
import { homeBots, pickHomeBot } from "@/features/home/homeBot";
import { useSpacesOn } from "@/features/spaces/data";
import { useCan, usePart } from "@/state/hooks";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { botTabLabel, PINNABLE, type TabId } from "@/state/tabs";
import { badgeColors, useTheme } from "@/ui";

export default function TabsLayout() {
  const theme = useTheme();
  const { colors } = theme;
  const badge = badgeColors(theme);
  // Compute badge counts via memoized Zustand selectors (cached by reference) so unrelated store
  // updates like streaming texts never rescan chats/tasks, and TabsLayout only re-renders when a
  // badge count actually changes.
  const selectUnread = useMemo(() => {
    let lastChats: ReturnType<typeof useApp.getState>["parts"]["chats"];
    let lastCount = 0;
    return (state: ReturnType<typeof useApp.getState>) => {
      const list = state.parts.chats;
      if (list !== lastChats) {
        lastChats = list;
        let count = 0;
        if (list) for (let i = 0; i < list.length; i++) if (isChatsPageUnread(list[i]!)) count++;
        lastCount = count;
      }
      return lastCount;
    };
  }, []);
  const selectWaiting = useMemo(() => {
    let lastTasks: ReturnType<typeof useApp.getState>["parts"]["tasks"];
    let lastTaskCount = 0;
    return (state: ReturnType<typeof useApp.getState>) => {
      const tasks = state.parts.tasks;
      if (tasks !== lastTasks) {
        lastTasks = tasks;
        lastTaskCount = needsYou({ tasks });
      }
      return (state.parts.live?.requests.length ?? 0) + lastTaskCount;
    };
  }, []);
  const unread = useApp(selectUnread);
  const waiting = useApp(selectWaiting);
  // A computer without spaces, or a member who may not see them, has no Spaces tab.
  const spacesOn = useSpacesOn();
  const spaces = useCan("today", "view") && spacesOn;
  // The tabs the person keeps between their bot and All (All, or Settings › Tabs).
  const bar = usePrefs((prefs) => prefs.bar);
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  // The first tab is named for the bot it shows, when that is one short word (botTabLabel).
  const homeBot = usePrefs((prefs) => prefs.homeBot);
  const bots = usePart("bots");
  const label = useMemo(() => botTabLabel(pickHomeBot(homeBots(bots ?? []), homeBot)?.name), [bots, homeBot]);
  const on = (id: TabId) => bar.includes(id as (typeof PINNABLE)[number]);
  // A tab taken off the bar while it was the one on show (in Settings › Tabs, over it) can't stay
  // the tab on show: the bar no longer has it. The person lands on their bot.
  const segments: string[] = useSegments();
  const shown = segments[0] === "(tabs)" ? segments[1] : undefined;
  const gone = !!shown && PINNABLE.includes(shown as (typeof PINNABLE)[number]) && !on(shown as TabId);
  useEffect(() => {
    if (gone) router.navigate("/" as Href);
  }, [gone]);
  // What waits in a tab that is not on the bar is counted on All, where that tab is a tile.
  const elsewhere = (on("chats") ? 0 : unread) + (on("work") ? 0 : waiting);
  // Each tab scrolls its own vertical view when reselected. Settings is a button on Home and on All, not a tab.
  // A tab that is not on the bar is hidden: it can't be shown as a tab then, and opens as a page from All.
  const tabs: Record<TabId, ReactElement> = {
    index: (
      <NativeTabs.Trigger key="index" name="index" disableScrollToTop>
        <NativeTabs.Trigger.Label>{label}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "face.smiling", selected: "face.smiling.inverse" }} md="mood" />
      </NativeTabs.Trigger>
    ),
    home: (
      <NativeTabs.Trigger key="home" name="home" hidden={!on("home")} disableScrollToTop>
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
      </NativeTabs.Trigger>
    ),
    chats: (
      <NativeTabs.Trigger key="chats" name="chats" hidden={!on("chats")} disableScrollToTop>
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="forum" />
        {unread > 0 && <NativeTabs.Trigger.Badge>{String(unread)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
    ),
    spaces: (
      <NativeTabs.Trigger key="spaces" name="spaces" hidden={!spaces || !on("spaces")} disableScrollToTop>
        <NativeTabs.Trigger.Label>Spaces</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "square.stack.3d.up", selected: "square.stack.3d.up.fill" }} md="layers" />
      </NativeTabs.Trigger>
    ),
    work: (
      <NativeTabs.Trigger key="work" name="work" hidden={!on("work")} disableScrollToTop>
        <NativeTabs.Trigger.Label>Work</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bolt", selected: "bolt.fill" }} md="bolt" />
        {waiting > 0 && <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
    ),
    market: (
      <NativeTabs.Trigger key="market" name="market" hidden={!on("market")} disableScrollToTop>
        {/* Short on purpose: a long label widens its tab and the selected bubble next to it runs into it. */}
        <NativeTabs.Trigger.Label>Market</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bag", selected: "bag.fill" }} md="storefront" />
      </NativeTabs.Trigger>
    ),
    all: (
      <NativeTabs.Trigger key="all" name="all" disableScrollToTop>
        <NativeTabs.Trigger.Label>All</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }} md="apps" />
        {elsewhere > 0 && <NativeTabs.Trigger.Badge>{String(elsewhere)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
    ),
  };
  // The bot first, the person's own tabs in their order, All last; then the tabs that are off the bar.
  // The bar is built again when the choice changes. Omitting opaque backgroundColor when a backdrop is
  // active lets the iOS Liquid Glass tab bar refract it.
  const order: TabId[] = ["index", ...bar, "all", ...PINNABLE.filter((id) => !bar.includes(id))];
  return (
    <NativeTabs key={bar.join()} tintColor={colors.accent} backgroundColor={hasBackdrop ? undefined : colors.canvas} badgeBackgroundColor={badge.background} badgeTextColor={badge.text}>
      {order.map((id) => tabs[id])}
    </NativeTabs>
  );
}
