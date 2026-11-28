// Settings › Tabs: which tabs are on the bar, and in what order. The bar always starts with the
// person's bot and ends with All; up to three more sit between them. Hold a tab, then move it:
// among the bar's tabs to put them in order, under "On your bar" to pin it, under "More" to take it
// off. VoiceOver has the same moves as actions. All arranges the same bar with its tiles; the bar
// is the phone's own and takes no drag, so its tabs are set in these two places. The choice is this
// phone's (`prefs.bar`).
import { GripHorizontal, House, Layers, type LucideIcon, MessagesSquare, Store, Zap } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedRef, useSharedValue } from "react-native-reanimated";
import type { BoardScroll } from "@/features/home/BotBoard";
import { SortArea, SortCell, SortHandle, type SortItem, useSorter } from "@/features/spaces/sortable";
import { setPrefs, usePrefs } from "@/state/prefs";
import { BAR_MAX, PINNABLE, type PinId, TABS, USUAL_BAR, withoutPin, withPin, withPinMoved } from "@/state/tabs";
import { Button, Label, Page, radius, space, T, useTheme } from "@/ui";

const ICONS: Record<PinId, LucideIcon> = { home: House, chats: MessagesSquare, spaces: Layers, work: Zap, market: Store };
const LABELS = Object.fromEntries(TABS.map((tab) => [tab.id, tab.label])) as Record<PinId, string>;
type Zone = "bar" | "more";
const HEADS: Record<Zone, string> = { bar: "On your bar", more: "More" };

export default function Tabs() {
  const { colors, control } = useTheme();
  const bar = usePrefs((prefs) => prefs.bar);
  const rest = PINNABLE.filter((id) => !bar.includes(id));
  // The page does not scroll, so nothing scrolls under a dragged tab: the list's edges are never reached.
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: -1e6, bottom: 1e6 }) };
  const pin = (id: PinId, index: number) => setPrefs({ bar: withPin(bar, id, index).bar });
  const unpin = (id: PinId) => setPrefs({ bar: withoutPin(bar, id) });
  const { sorter, items } = useSorter({
    build: () => [
      { key: "head:bar", kind: "head", zone: "bar" } as SortItem,
      ...bar.map((id): SortItem => ({ key: id, kind: "row", zone: "bar" })),
      { key: "head:more", kind: "head", zone: "more" } as SortItem,
      ...rest.map((id): SortItem => ({ key: id, kind: "row", zone: "more" })),
    ],
    scroll,
    // A fourth tab on the bar sends its last one back to More (withPin).
    onDrop: (key, zone, index) => (zone === "bar" ? pin(key as PinId, index) : unpin(key as PinId)),
  });
  const usual = bar.join() === USUAL_BAR.join();
  return (
    <Page title="Tabs" caption="Your bot and All always stay." scroll={false} quietLink>
      <SortArea sorter={sorter}>
        <View>
          {items.map((item, at) => {
            if (item.kind === "head")
              return (
                <SortCell key={item.key} item={item} style={{ paddingTop: item.zone === "more" ? space.lg : 0 }}>
                  <Label>{item.zone === "bar" ? HEADS.bar + " · " + bar.length + " of " + BAR_MAX : HEADS.more}</Label>
                </SortCell>
              );
            if (item.kind !== "row") return null;
            const id = item.key as PinId;
            const pinned = item.zone === "bar";
            const Icon = ICONS[id];
            const up = pinned ? withPinMoved(bar, id, -1) : null;
            const down = pinned ? withPinMoved(bar, id, 1) : null;
            const previous = items[at - 1];
            const actions = [
              ...(up ? [{ name: "up", label: "Move up" }] : []),
              ...(down ? [{ name: "down", label: "Move down" }] : []),
              pinned ? { name: "unpin", label: "Take off bar" } : { name: "pin", label: "Pin to bar" },
            ];
            return (
              <SortCell key={item.key} item={item}>
                {previous?.kind === "row" && <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: space.lg + 22 + space.md }} />}
                <SortHandle itemKey={item.key}>
                  <View
                    accessible
                    accessibilityLabel={LABELS[id] + (pinned ? ", on your bar, place " + (bar.indexOf(id) + 1) + " of " + bar.length : ", not on your bar")}
                    accessibilityHint="Hold, then move, to put it on the bar, in order, or off it"
                    accessibilityActions={actions}
                    onAccessibilityAction={(event) => {
                      const name = event.nativeEvent.actionName;
                      if (name === "up" && up) setPrefs({ bar: up });
                      else if (name === "down" && down) setPrefs({ bar: down });
                      else if (name === "unpin") unpin(id);
                      else if (name === "pin") pin(id, bar.length);
                    }}
                    style={{ minHeight: control.row + 8, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: radius.lg }}
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
        Hold a tab, then move it. Everything else is in All.
      </T>
      <Button title="Usual tabs" variant="secondary" wide disabled={usual} onPress={() => setPrefs({ bar: USUAL_BAR })} />
    </Page>
  );
}
