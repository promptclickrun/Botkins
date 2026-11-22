// Putting a list in order by hand: the spaces of the Spaces tab and the tabs of Settings ›
// Appearance › Tabs (rows, top to bottom). Hold one, then move, and it lifts and follows the finger;
// the others make room, and the page scrolls near an edge. A list can also run side by side
// (`across`, chips), which nothing uses now that Home has no row of spaces. Hold still and whatever a hold did
// before still happens. The hold-then-move rule, its numbers and the slot math are Home's
// (src/features/home/BotBoard.tsx has why; DRAG, pickSlot, shiftOf and restingTop are in drag.ts).
import { createContext, type ReactNode, use, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type LayoutChangeEvent, type StyleProp, View, type ViewStyle } from "react-native";
import { GestureDetector, GestureStateManager, usePanGesture } from "react-native-gesture-handler";
import Animated, { type FrameCallback, scrollTo, type SharedValue, useAnimatedReaction, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { BoardScroll } from "@/features/home/BotBoard";
import { DRAG, pickSlot, restingTop, shiftOf } from "@/features/home/drag";
import { haptic, radius, useTheme } from "@/ui";

/** One item of a list that can be put in order: a heading opens a group, a row is a place in it, and a fixed item neither moves nor takes a drop. */
export type SortItem = { key: string; kind: "head" | "row"; zone: string } | { key: string; kind: "fixed" };

/** The list as the UI thread sees it: the items, and each one's start and size along the list. */
type Model = { items: SortItem[]; at: number[]; size: number[] };
const indexOf = (items: readonly SortItem[], key: string) => {
  "worklet";
  for (let i = 0; i < items.length; i++) if (items[i].key === key) return i;
  return -1;
};

type Sorter = {
  /** Side by side (a row of chips) and not top to bottom. */
  across: boolean;
  model: SharedValue<Model>;
  /** The dragged item's key, "" when nothing is dragged. */
  active: SharedValue<string>;
  /** The key of the item the dragged one would land after, and the group it would land in. */
  after: SharedValue<string>;
  zone: SharedValue<string>;
  /** The dragged item's start along the list, as the finger and the scrolling have moved it. */
  place: SharedValue<number>;
  lifted: SharedValue<number>;
  begin: (key: string, finger: number) => void;
  move: (finger: number) => void;
  end: (key: string) => void;
  measure: (key: string, event: LayoutChangeEvent) => void;
};
const SorterContext = createContext<Sorter | null>(null);

export function SortArea({ sorter, children }: { sorter: Sorter; children: ReactNode }) {
  return <SorterContext value={sorter}>{children}</SorterContext>;
}

/**
 * One item of the list: it makes room while another hovers, and, when it is the dragged one, lifts
 * and follows the finger. A "row" also shades with its group and lifts as a card; a "chip" keeps
 * its own shape.
 */
export function SortCell({ item, look = "row", style, children }: { item: SortItem; look?: "row" | "chip"; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const theme = useTheme();
  const { colors } = theme;
  const sorter = use(SorterContext)!;
  const key = item.key;
  const zone = item.kind === "fixed" ? "" : item.zone;
  const across = sorter.across;
  const card = look === "row";
  const shift = useSharedValue(0);
  // How far this item moves to make room, as the dragged one hovers. Back to 0 at once when the drag is over.
  useAnimatedReaction(
    () => {
      const m = sorter.model.value;
      const active = sorter.active.value;
      if (!active || active === key) return 0;
      const dragged = indexOf(m.items, active);
      return shiftOf(indexOf(m.items, key), dragged, indexOf(m.items, sorter.after.value), m.size[dragged] ?? 0);
    },
    (next, previous) => {
      if (next === previous) return;
      shift.value = sorter.active.value ? withTiming(next, { duration: DRAG.SETTLE_MS }) : next;
    },
  );
  const moving = useAnimatedStyle(() => {
    const active = sorter.active.value;
    if (active && active === key) {
      const m = sorter.model.value;
      const lifted = sorter.lifted.value;
      const by = sorter.place.value - (m.at[indexOf(m.items, key)] ?? 0);
      return {
        transform: [{ translateX: across ? by : 0 }, { translateY: across ? 0 : by }, { scale: 1 + (DRAG.LIFT_SCALE - 1) * lifted }],
        zIndex: 10,
        borderRadius: card ? radius.md * lifted : radius.pill,
        backgroundColor: card ? colors.raised : "transparent",
        shadowOpacity: lifted * (theme.dark ? 0.3 : 0.14),
      };
    }
    return {
      transform: [{ translateX: across ? shift.value : 0 }, { translateY: across ? 0 : shift.value }, { scale: 1 }],
      zIndex: 0,
      borderRadius: card ? 0 : radius.pill,
      backgroundColor: card && active && zone && sorter.zone.value === zone ? colors.surface : "transparent",
      shadowOpacity: 0,
    };
  });
  return (
    <Animated.View onLayout={(event) => sorter.measure(key, event)} style={[{ shadowColor: colors.shadow, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }, style, moving]}>
      {children}
    </Animated.View>
  );
}

/** What can be dragged: the pan that waits for a rest and then a move (see the top of BotBoard.tsx). */
export function SortHandle({ itemKey, disabled, children }: { itemKey: string; disabled?: boolean; children: ReactNode }) {
  const sorter = use(SorterContext)!;
  const across = sorter.across;
  const down = useSharedValue({ t: 0, x: 0, y: 0 });
  const pan = usePanGesture({
    manualActivation: true,
    onTouchesDown: (event) => {
      "worklet";
      const touch = event.allTouches[0];
      if (touch) down.value = { t: Date.now(), x: touch.absoluteX, y: touch.absoluteY };
    },
    onTouchesMove: (event) => {
      "worklet";
      const touch = event.allTouches[0];
      if (!touch || sorter.active.value === itemKey) return;
      // Another one is already being dragged: this finger does nothing.
      if (sorter.active.value) return GestureStateManager.fail(event.handlerTag);
      const moved = Math.hypot(touch.absoluteX - down.value.x, touch.absoluteY - down.value.y);
      const rested = Date.now() - down.value.t >= DRAG.HOLD_MS;
      if (!rested && moved > DRAG.SWIPE_SLOP) GestureStateManager.fail(event.handlerTag);
      else if (rested && moved >= DRAG.START_PT) GestureStateManager.activate(event.handlerTag);
    },
    onActivate: (event) => {
      "worklet";
      sorter.begin(itemKey, across ? event.absoluteX : event.absoluteY);
    },
    onUpdate: (event) => {
      "worklet";
      sorter.move(across ? event.absoluteX : event.absoluteY);
    },
    onFinalize: () => {
      "worklet";
      sorter.end(itemKey);
    },
  });
  if (disabled) return <View>{children}</View>;
  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}

/**
 * The drag of one list. `build` makes the list's items, and is told when one is being dragged so
 * it can show a group that is empty. `scroll` is what scrolls along the list (its `edges` are the
 * screen's two ends a finger can reach, as `top` and `bottom` also for a row that runs across).
 * `onDrop` gets the dragged item's key, the group it landed in, and its place among that group's
 * other rows.
 */
export function useSorter<I extends SortItem>({ build, across = false, scroll, onDrop, onDragging }: { build: (dragging: boolean) => I[]; across?: boolean; scroll: BoardScroll; onDrop: (key: string, zone: string, index: number) => void; onDragging?: (on: boolean) => void }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const items = build(!!dragging);

  const model = useSharedValue<Model>({ items: [], at: [], size: [] });
  const active = useSharedValue("");
  const after = useSharedValue("");
  const zone = useSharedValue("");
  const index = useSharedValue(0);
  const place = useSharedValue(0);
  const lifted = useSharedValue(0);
  const start = useSharedValue({ place: 0, finger: 0, offset: 0 });
  const finger = useSharedValue(0);
  const dropping = useSharedValue(false);

  // Each item's place along the list, measured as it lays out, handed to the UI thread with the items.
  const frames = useRef(new Map<string, { at: number; size: number }>());
  const sync = (list: SortItem[]) => {
    model.value = { items: list, at: list.map((item) => frames.current.get(item.key)?.at ?? 0), size: list.map((item) => frames.current.get(item.key)?.size ?? 0) };
  };
  useLayoutEffect(() => sync(items));
  const measure = (key: string, event: LayoutChangeEvent) => {
    const { x, y, width, height } = event.nativeEvent.layout;
    frames.current.set(key, across ? { at: x, size: width } : { at: y, size: height });
    sync(items);
  };

  // The gesture may keep the worklets of an earlier render; these read the latest props when they run.
  const handlers = useRef({ onDrop, onDragging });
  useLayoutEffect(() => {
    handlers.current = { onDrop, onDragging };
  });
  const started = (key: string) => {
    haptic.tap();
    setDragging(key);
    handlers.current.onDragging?.(true);
    autoScroll.setActive(true);
  };
  const dropped = (key: string, at: string, where: number) => {
    autoScroll.setActive(false);
    if (at) {
      haptic.select();
      handlers.current.onDrop(key, at, where);
    }
    setDragging(null);
    handlers.current.onDragging?.(false);
  };
  // Once the list is drawn in its new order, the moved items go back to their own places.
  useLayoutEffect(() => {
    if (dragging) return;
    active.value = "";
    after.value = "";
    zone.value = "";
    dropping.value = false;
    lifted.value = 0;
  }, [dragging, active, after, zone, dropping, lifted]);

  /** Where the dragged item is, and so where it would land. Runs on the UI thread. */
  const track = () => {
    "worklet";
    const m = model.value;
    const dragged = indexOf(m.items, active.value);
    if (dragged < 0 || dropping.value) return;
    place.value = start.value.place + (finger.value - start.value.finger) + (scroll.offset.value - start.value.offset);
    const slot = pickSlot(m.items, m.at, m.size, dragged, place.value + (m.size[dragged] ?? 0) / 2);
    if (!slot) return;
    after.value = m.items[slot.after].key;
    index.value = slot.index;
    if (zone.value !== slot.zone) {
      if (zone.value) scheduleOnRN(haptic.select);
      zone.value = slot.zone;
    }
  };
  const begin = (key: string, fingerAt: number) => {
    "worklet";
    const m = model.value;
    const dragged = indexOf(m.items, key);
    const item = m.items[dragged];
    if (!item || item.kind !== "row" || active.value) return;
    start.value = { place: m.at[dragged] ?? 0, finger: fingerAt, offset: scroll.offset.value };
    finger.value = fingerAt;
    place.value = m.at[dragged] ?? 0;
    dropping.value = false;
    active.value = key;
    after.value = dragged > 0 ? m.items[dragged - 1].key : "";
    zone.value = item.zone;
    index.value = 0;
    lifted.value = withTiming(1, { duration: DRAG.SETTLE_MS });
    track();
    scheduleOnRN(started, key);
  };
  const move = (fingerAt: number) => {
    "worklet";
    finger.value = fingerAt;
    track();
  };
  const end = (key: string) => {
    "worklet";
    if (active.value !== key || dropping.value) return;
    dropping.value = true;
    const m = model.value;
    const dragged = indexOf(m.items, key);
    const at = zone.value;
    const where = index.value;
    lifted.value = withTiming(0, { duration: DRAG.SETTLE_MS });
    place.value = withTiming(restingTop(m.at, m.size, dragged, indexOf(m.items, after.value)), { duration: DRAG.SETTLE_MS }, () => {
      "worklet";
      scheduleOnRN(dropped, key, at, where);
    });
  };

  // Near either end the list scrolls under the dragged item, faster nearer the end.
  const autoScroll: FrameCallback = useFrameCallback(() => {
    "worklet";
    if (!active.value || dropping.value) return;
    const { top: low, bottom: high } = scroll.edges.value;
    const at = finger.value;
    let speed = 0;
    if (at < low + DRAG.EDGE) speed = -DRAG.SCROLL_MAX * Math.min(1, (low + DRAG.EDGE - at) / DRAG.EDGE);
    else if (at > high - DRAG.EDGE) speed = DRAG.SCROLL_MAX * Math.min(1, (at - (high - DRAG.EDGE)) / DRAG.EDGE);
    if (!speed) return;
    const next = Math.max(0, Math.min(scroll.max.value, scroll.offset.value + speed));
    if (next === scroll.offset.value) return;
    scroll.offset.value = next;
    scrollTo(scroll.ref, across ? next : 0, across ? 0 : next, false);
    track();
  }, false);
  useEffect(() => () => autoScroll.setActive(false), [autoScroll]);

  const sorter: Sorter = { across, model, active, after, zone, place, lifted, begin, move, end, measure };
  return { sorter, items, dragging: !!dragging };
}
