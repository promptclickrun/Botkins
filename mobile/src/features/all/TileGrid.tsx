// A grid of tiles in groups that a person puts in order by hand: hold a tile, then move, and it
// lifts and follows the finger anywhere on the grid; the others slide to where they would end up,
// a group over its limit hands its last tile on, and the page scrolls near the top or bottom edge.
// Hold still and whatever a hold did before still happens (the tile's menu).
//
// The hold-then-move rule and its numbers are Home's (src/features/home/BotBoard.tsx has why; DRAG
// is in drag.ts), as in sortable.tsx, which orders one line of things. Here a tile moves both ways,
// and no place is measured: grid.ts works every place out from the list's order and the grid's
// width, on the UI thread while a tile is dragged and in React for the drop.
import { createContext, type ReactNode, use, useEffect, useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";
import { GestureDetector, GestureStateManager, usePanGesture } from "react-native-gesture-handler";
import Animated, { type FrameCallback, scrollTo, type SharedValue, useAnimatedReaction, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { BoardScroll } from "@/features/home/BotBoard";
import { DRAG } from "@/features/home/drag";
import { haptic, radius, useTheme } from "@/ui";
import { type GridCap, type GridItem, type GridLayout, type GridMetrics, layoutOf, moved, pickPlace } from "./grid";

const NOWHERE: GridLayout = { keys: [], xs: [], ys: [], ws: [], hs: [], height: 0 };
const indexOf = (keys: readonly string[], key: string) => {
  "worklet";
  for (let i = 0; i < keys.length; i++) if (keys[i] === key) return i;
  return -1;
};

type Grid = {
  /** Where everything sits now: the list's own places, or, while a tile is dragged, the places a drop would give. */
  target: SharedValue<GridLayout>;
  /** The dragged tile's key, "" when nothing is dragged. */
  active: SharedValue<string>;
  /** The group the dragged tile would land in. */
  zone: SharedValue<string>;
  /** The dragged tile's left and top in the grid, as the finger and the page have moved it. */
  atX: SharedValue<number>;
  atY: SharedValue<number>;
  lifted: SharedValue<number>;
  begin: (key: string, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  end: (key: string) => void;
};
const GridContext = createContext<Grid | null>(null);

/** One item, placed by the grid: it slides to its place while another is dragged, and follows the finger when it is the dragged one. */
function Cell({ itemKey, width, height, lifts, children }: { itemKey: string; width: number; height: number; /** A tile: it lifts as a card when dragged, and takes touches. */ lifts: boolean; children?: ReactNode }) {
  const theme = useTheme();
  const { colors } = theme;
  const grid = use(GridContext)!;
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const shown = useSharedValue(0);
  // Its place in the layout on show. During a drag it slides there; otherwise it is simply there.
  useAnimatedReaction(
    () => {
      const layout = grid.target.value;
      const index = indexOf(layout.keys, itemKey);
      return index < 0 ? null : { x: layout.xs[index], y: layout.ys[index] };
    },
    (next, previous) => {
      if (!next) {
        shown.value = 0;
        return;
      }
      if (previous && shown.value === 1 && next.x === previous.x && next.y === previous.y) return;
      const slide = !!grid.active.value && shown.value === 1;
      x.value = slide ? withTiming(next.x, { duration: DRAG.SETTLE_MS }) : next.x;
      y.value = slide ? withTiming(next.y, { duration: DRAG.SETTLE_MS }) : next.y;
      shown.value = 1;
    },
  );
  const style = useAnimatedStyle(() => {
    if (lifts && grid.active.value === itemKey) {
      const lifted = grid.lifted.value;
      return {
        opacity: 1,
        transform: [{ translateX: grid.atX.value }, { translateY: grid.atY.value }, { scale: 1 + (DRAG.LIFT_SCALE - 1) * lifted }],
        zIndex: 10,
        shadowOpacity: lifted * (theme.dark ? 0.3 : 0.14),
      };
    }
    return { opacity: shown.value, transform: [{ translateX: x.value }, { translateY: y.value }, { scale: 1 }], zIndex: 0, shadowOpacity: 0 };
  });
  return (
    <Animated.View pointerEvents={lifts ? "auto" : "none"} style={[{ position: "absolute", left: 0, top: 0, width, height, borderRadius: radius.lg, shadowColor: colors.shadow, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }, style]}>
      {children}
    </Animated.View>
  );
}

/** What can be dragged: the pan that waits for a rest and then a move (see the top of BotBoard.tsx). */
function Handle({ itemKey, disabled, children }: { itemKey: string; disabled?: boolean; children: ReactNode }) {
  const grid = use(GridContext)!;
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
      if (!touch || grid.active.value === itemKey) return;
      // Another tile is already being dragged: this finger does nothing.
      if (grid.active.value) return GestureStateManager.fail(event.handlerTag);
      const far = Math.hypot(touch.absoluteX - down.value.x, touch.absoluteY - down.value.y);
      const rested = Date.now() - down.value.t >= DRAG.HOLD_MS;
      if (!rested && far > DRAG.SWIPE_SLOP) GestureStateManager.fail(event.handlerTag);
      else if (rested && far >= DRAG.START_PT) GestureStateManager.activate(event.handlerTag);
    },
    onActivate: (event) => {
      "worklet";
      grid.begin(itemKey, event.absoluteX, event.absoluteY);
    },
    onUpdate: (event) => {
      "worklet";
      grid.move(event.absoluteX, event.absoluteY);
    },
    onFinalize: () => {
      "worklet";
      grid.end(itemKey);
    },
  });
  if (disabled) return <View>{children}</View>;
  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}

export type TileGridProps = {
  /** The list, as `tidy` leaves it. `build` is told when a tile is being dragged, so it can show a group that is empty. */
  build: (dragging: boolean) => GridItem[];
  metrics: GridMetrics;
  caps?: readonly GridCap[];
  /** The page the grid scrolls in (its `edges` are the screen's top and bottom a finger can reach). */
  scroll: BoardScroll;
  /** A drop: the list in its new order. */
  onDrop: (next: GridItem[]) => void;
  onDragging?: (on: boolean) => void;
  /** No tile can be dragged. */
  locked?: boolean;
  renderHead: (zone: string) => ReactNode;
  renderTile: (key: string, zone: string) => ReactNode;
  /** What stands in a group with no tile. */
  renderEmpty: (zone: string) => ReactNode;
};

export function TileGrid({ build, metrics, caps = [], scroll, onDrop, onDragging, locked, renderHead, renderTile, renderEmpty }: TileGridProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const items = build(!!dragging);
  const rest = width > 0 ? layoutOf(items, width, metrics) : NOWHERE;

  const model = useSharedValue<{ items: GridItem[]; width: number }>({ items: [], width: 0 });
  const target = useSharedValue<GridLayout>(NOWHERE);
  const active = useSharedValue("");
  const zone = useSharedValue("");
  const index = useSharedValue(0);
  const atX = useSharedValue(0);
  const atY = useSharedValue(0);
  const lifted = useSharedValue(0);
  const start = useSharedValue({ x: 0, y: 0, fingerX: 0, fingerY: 0, offset: 0 });
  const finger = useSharedValue({ x: 0, y: 0 });
  const dropping = useSharedValue(false);

  // The list goes to the UI thread as it is drawn. Between drags the places on show are the list's own.
  useLayoutEffect(() => {
    model.value = { items, width };
    if (!dragging) {
      target.value = rest;
      active.value = "";
      zone.value = "";
      dropping.value = false;
      lifted.value = 0;
    }
  });

  // The gesture may keep the worklets of an earlier render; these read the latest props when they run.
  const latest = useRef({ items, caps, onDrop, onDragging });
  useLayoutEffect(() => {
    latest.current = { items, caps, onDrop, onDragging };
  });
  const started = (key: string) => {
    haptic.tap();
    setDragging(key);
    latest.current.onDragging?.(true);
    autoScroll.setActive(true);
  };
  const dropped = (key: string, into: string, where: number) => {
    autoScroll.setActive(false);
    if (into) {
      haptic.select();
      latest.current.onDrop(moved(latest.current.items, key, into, where, latest.current.caps));
    }
    setDragging(null);
    latest.current.onDragging?.(false);
  };

  /**
   * Where the dragged tile is, and so where it would land. Runs on the UI thread. `again` works the
   * places out even when the tile would land where it did before: the list itself changed (a group
   * that shows only during a drag came in).
   */
  const track = (again = false) => {
    "worklet";
    const m = model.value;
    const key = active.value;
    if (!key || dropping.value) return;
    const x = start.value.x + (finger.value.x - start.value.fingerX);
    const y = start.value.y + (finger.value.y - start.value.fingerY) + (scroll.offset.value - start.value.offset);
    atX.value = x;
    atY.value = y;
    const layout = target.value;
    const self = indexOf(layout.keys, key);
    const pick = pickPlace(m.items, m.width, metrics, caps, key, x + (layout.ws[self] ?? 0) / 2, y + (layout.hs[self] ?? 0) / 2);
    if (!pick || (!again && pick.zone === zone.value && pick.index === index.value)) return;
    if (pick.zone !== zone.value) scheduleOnRN(haptic.select);
    zone.value = pick.zone;
    index.value = pick.index;
    target.value = pick.layout;
  };
  // The list drawn again in the middle of a drag: the places on show follow it.
  useAnimatedReaction(
    () => model.value,
    (next, previous) => {
      if (next !== previous && active.value && !dropping.value) track(true);
    },
  );
  const begin = (key: string, fingerX: number, fingerY: number) => {
    "worklet";
    if (active.value) return;
    const m = model.value;
    const layout = layoutOf(m.items, m.width, metrics);
    const self = indexOf(layout.keys, key);
    let item: GridItem | undefined;
    for (let i = 0; i < m.items.length; i++) if (m.items[i].key === key) item = m.items[i];
    if (self < 0 || !item || item.kind !== "tile") return;
    start.value = { x: layout.xs[self], y: layout.ys[self], fingerX, fingerY, offset: scroll.offset.value };
    finger.value = { x: fingerX, y: fingerY };
    atX.value = layout.xs[self];
    atY.value = layout.ys[self];
    dropping.value = false;
    // Where it is now: its own group, at its own place among that group's other tiles.
    let before = 0;
    for (let i = 0; i < m.items.length && m.items[i].key !== key; i++) if (m.items[i].kind === "tile" && m.items[i].zone === item.zone) before++;
    zone.value = item.zone;
    index.value = before;
    active.value = key;
    lifted.value = withTiming(1, { duration: DRAG.SETTLE_MS });
    scheduleOnRN(started, key);
  };
  const move = (fingerX: number, fingerY: number) => {
    "worklet";
    finger.value = { x: fingerX, y: fingerY };
    track();
  };
  const end = (key: string) => {
    "worklet";
    if (active.value !== key || dropping.value) return;
    dropping.value = true;
    const layout = target.value;
    const self = indexOf(layout.keys, key);
    const into = zone.value;
    const where = index.value;
    lifted.value = withTiming(0, { duration: DRAG.SETTLE_MS });
    atX.value = withTiming(layout.xs[self] ?? atX.value, { duration: DRAG.SETTLE_MS });
    atY.value = withTiming(layout.ys[self] ?? atY.value, { duration: DRAG.SETTLE_MS }, () => {
      "worklet";
      scheduleOnRN(dropped, key, into, where);
    });
  };

  // Near the top or bottom the page scrolls under the dragged tile, faster nearer the edge.
  const autoScroll: FrameCallback = useFrameCallback(() => {
    "worklet";
    if (!active.value || dropping.value) return;
    const { top: low, bottom: high } = scroll.edges.value;
    const y = finger.value.y;
    let speed = 0;
    if (y < low + DRAG.EDGE) speed = -DRAG.SCROLL_MAX * Math.min(1, (low + DRAG.EDGE - y) / DRAG.EDGE);
    else if (y > high - DRAG.EDGE) speed = DRAG.SCROLL_MAX * Math.min(1, (y - (high - DRAG.EDGE)) / DRAG.EDGE);
    if (!speed) return;
    const next = Math.max(0, Math.min(scroll.max.value, scroll.offset.value + speed));
    if (next === scroll.offset.value) return;
    scroll.offset.value = next;
    scrollTo(scroll.ref, 0, next, false);
    track();
  }, false);
  useEffect(() => () => autoScroll.setActive(false), [autoScroll]);

  // The grid is as tall as what it shows: taller for a moment when a drag opens another row or group.
  const frame = useAnimatedStyle(() => ({ height: target.value.height }));
  const grid: Grid = { target, active, zone, atX, atY, lifted, begin, move, end };
  const zones = items.filter((item) => item.kind === "head").map((item) => item.zone);
  const tileWidth = rest.ws[items.findIndex((item) => item.kind === "tile")] ?? Math.max(0, (width - metrics.gap * (metrics.columns - 1)) / metrics.columns);
  return (
    <GridContext value={grid}>
      <Animated.View onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))} style={[{ alignSelf: "stretch" }, frame]}>
        {width > 0 && (
          <>
            {zones.map((name) => (
              <Cell key={"head:" + name} itemKey={"head:" + name} width={width} height={metrics.head} lifts={false}>
                {renderHead(name)}
              </Cell>
            ))}
            {/* Every group's empty place is kept drawn, and shows only while its group has no tile. */}
            {zones.map((name) => (
              <Cell key={"empty:" + name} itemKey={"empty:" + name} width={width} height={metrics.tile} lifts={false}>
                {renderEmpty(name)}
              </Cell>
            ))}
            {items.map((item) =>
              item.kind === "tile" ? (
                <Cell key={item.key} itemKey={item.key} width={tileWidth} height={metrics.tile} lifts>
                  <Handle itemKey={item.key} disabled={locked}>
                    {renderTile(item.key, item.zone)}
                  </Handle>
                </Cell>
              ) : null,
            )}
          </>
        )}
      </Animated.View>
    </GridContext>
  );
}
