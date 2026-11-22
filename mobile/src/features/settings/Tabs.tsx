// Settings › Appearance › Tabs: the order of the tabs in the bar. Hold a tab, then move, to put it
// in its place; VoiceOver has Move up and Move down. The bar is the phone's own and takes no drag,
// so its order is set here. The choice is this phone's (`prefs.tabOrder`).
import { GripHorizontal, House, Layers, LayoutGrid, type LucideIcon, MessagesSquare, Zap } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedRef, useSharedValue } from "react-native-reanimated";
import type { BoardScroll } from "@/features/home/BotBoard";
import { SortArea, SortCell, SortHandle, type SortItem, useSorter } from "@/features/spaces/sortable";
import { setPrefs, usePrefs } from "@/state/prefs";
import { type TabId, TABS, USUAL_TABS, withTabAt, withTabMoved } from "@/state/tabs";
import { Button, Page, radius, space, T, useTheme } from "@/ui";

const ICONS: Record<TabId, LucideIcon> = { index: House, chats: MessagesSquare, spaces: Layers, work: Zap, market: LayoutGrid };
const LABELS = Object.fromEntries(TABS.map((tab) => [tab.id, tab.label])) as Record<TabId, string>;
// The list has one group. Its heading is only where the list starts, so a tab can be dropped first.
const START: SortItem = { key: "head", kind: "head", zone: "tabs" };

export default function Tabs() {
  const { colors, control } = useTheme();
  const order = usePrefs((prefs) => prefs.tabOrder);
  // The page does not scroll, so nothing scrolls under a dragged tab: the list's edges are never reached.
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: -1e6, bottom: 1e6 }) };
  const { sorter, items } = useSorter({
    build: () => [START, ...order.map((id): SortItem => ({ key: id, kind: "row", zone: "tabs" }))],
    scroll,
    onDrop: (key, _zone, index) => setPrefs({ tabOrder: withTabAt(order, key as TabId, index) }),
  });
  const usual = order.join() === USUAL_TABS.join();
  return (
    <Page title="Tabs" scroll={false} quietLink>
      <SortArea sorter={sorter}>
        <View style={{ borderRadius: radius.lg, backgroundColor: colors.surface }}>
          {items.map((item, at) => {
            if (item.kind !== "row") return <SortCell key={item.key} item={item} />;
            const id = item.key as TabId;
            const Icon = ICONS[id];
            const up = withTabMoved(order, id, -1);
            const down = withTabMoved(order, id, 1);
            return (
              <SortCell key={item.key} item={item}>
                {at > 1 && <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: space.lg + 22 + space.md }} />}
                <SortHandle itemKey={item.key}>
                  <View
                    accessible
                    accessibilityLabel={LABELS[id] + ", place " + at + " of " + order.length}
                    accessibilityHint="Hold, then move, to put it in order"
                    accessibilityActions={[...(up ? [{ name: "up", label: "Move up" }] : []), ...(down ? [{ name: "down", label: "Move down" }] : [])]}
                    onAccessibilityAction={(event) => {
                      const next = event.nativeEvent.actionName === "up" ? up : down;
                      if (next) setPrefs({ tabOrder: next });
                    }}
                    style={{ minHeight: control.row + 8, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", gap: space.md }}
                  >
                    <Icon size={22} color={colors.ink} strokeWidth={2} />
                    <T variant="callout" numberOfLines={1} style={{ flex: 1 }}>
                      {LABELS[id]}
                    </T>
                    <GripHorizontal size={20} color={colors.muted} strokeWidth={2} />
                  </View>
                </SortHandle>
              </SortCell>
            );
          })}
        </View>
      </SortArea>
      <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
        Hold a tab, then move it.
      </T>
      <Button title="Usual order" variant="secondary" wide disabled={usual} onPress={() => setPrefs({ tabOrder: USUAL_TABS })} />
    </Page>
  );
}
