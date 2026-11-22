// Home's bot list under the "All" filter, with dragging: hold a bot, then move, and it lifts and
// follows the finger; the other rows make room, the group it will land in is shaded, and the page
// scrolls near the top or bottom edge. Hold still and the bot's menu opens, as before.
//
// How the two are told apart: iOS opens the menu (HoldMenu, a native context menu) at about half a
// second, and that menu can't be opened from code or hand its touch to a drag. So each row also has
// a pan gesture that activates by hand (`manualActivation`): only once the finger has rested
// DRAG.HOLD_MS and then moved DRAG.START_PT. A move sooner is a swipe: the gesture fails and the
// page scrolls. A finger held still never activates it, and iOS opens the menu. The numbers are in
// drag.ts, with where a drop lands and what the computer is told.
import { router } from "expo-router";
import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react-native";
import { MenuView } from "@react-native-menu/menu";
import { createContext, type ReactNode, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { GestureDetector, GestureStateManager, usePanGesture } from "react-native-gesture-handler";
import Animated, { type AnimatedRef, type FrameCallback, scrollTo, type SharedValue, useAnimatedReaction, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { plainPreview } from "@/features/chat/bits";
import { newBotChat, openBotChat } from "@/features/chat/open";
import { hideAction, moveToSection, runSectionAction, runSectionChoice, SECTION_ACTIONS, toggleHidden } from "@/features/bots/menus";
import type { Bot, ChatSummary, Section } from "@/link/types";
import { activityLabel, useBotActivity, useBots, useCan, useIsPrimaryBot, usePart, useCanArrange, useMember } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { ago } from "@/state/time";
import { BotAvatar, Dot, haptic, HoldMenu, radius, space, T, Tap, useTextPrompt, useTheme } from "@/ui";
import { arrangeBots } from "./arrange";
import { type BoardItem, boardItems, DRAG, pickSlot, restingTop, sectionIdOf, shiftOf, stepSlot, type Zone, zoneOfSection } from "./drag";

export const AVATAR = 48;
const INSET = space.lg + AVATAR + space.md;

/** Long-press on a bot: the desktop's bot menu (New chat, Bot page, Pin, Move to section, Make primary, Duplicate, Hide, Delete). */
export function BotMenu({ bot, children }: { bot: Bot; children: ReactNode }) {
  const bots = useBots();
  const sections = usePart("sections");
  const primary = bots[0]?.id === bot.id;
  const canChat = useCan("agents", "chat");
  const canCreate = useCan("agents", "create");
  const canManage = useCan("agents", "manage");
  const canArrange = useCanArrange();
  const member = useMember();
  const canDelete = useCan("agents", "delete");
  const prompt = useTextPrompt();
  return (
    <>
    <HoldMenu
      actions={[
        ...(canChat ? [{ id: "new", title: "New chat", image: "square.and.pencil" }] : []),
        { id: "page", title: "Bot page", image: "person.crop.circle" },
        // Pinning and hiding are a person's own view; sections and the primary bot are the owner's arrangement.
        ...(canArrange ? [{ id: "pin", title: bot.pinned ? "Unpin" : "Pin", image: bot.pinned ? "pin.slash" : "pin" }] : []),
        ...(canManage && !member ? [moveToSection(bot, sections), { id: "primary", title: "Make primary", image: "star", attributes: { disabled: primary } }] : []),
        ...(canCreate ? [{ id: "duplicate", title: "Duplicate", image: "doc.on.doc" }] : []),
        ...(canArrange ? [hideAction(bot, primary && !member)] : []),
        ...(canDelete ? [{ id: "delete", title: "Delete", image: "trash", attributes: { destructive: true, disabled: bots.length < 2 } }] : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        const event = nativeEvent.event;
        if (runSectionChoice(bot, event, prompt.ask)) return;
        if (event === "new") void newBotChat(bot.id);
        else if (event === "page") router.push({ pathname: "/bot/[id]", params: { id: bot.id } });
        else if (event === "pin") void attempt(api.setBotFlags(bot.id, { pinned: !bot.pinned }));
        else if (event === "primary") void attempt(api.makePrimary(bot.id), bot.name + " is first now");
        else if (event === "duplicate") void attempt(api.duplicateBot(bot.id), "Bot duplicated");
        else if (event === "hide") toggleHidden(bot);
        else if (event === "delete")
          Alert.alert("Delete " + bot.name + "?", "Its chats and history are deleted too.", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => void attempt(api.deleteBot(bot.id)) },
          ]);
      }}
    >
      {children}
    </HoldMenu>
    {prompt.node}
    </>
  );
}

/** What VoiceOver offers on a bot row in place of dragging. */
type RowActions = { list: { name: string; label: string }[]; run: (name: string) => void };

/** One bot in the list: its face, its name, one line, and when it last spoke. */
export function BotRow({ bot, chat, unread, actions }: { bot: Bot; chat?: ChatSummary; unread: boolean; actions?: RowActions }) {
  const state = useBotActivity(bot.id);
  const canChat = useCan("agents", "chat");
  const status = activityLabel(state);
  const last = chat?.last ? plainPreview(chat.last.text) : undefined;
  const line = status || last || bot.role || "Bot";
  const busy = !!status;
  // Only the primary bot moves on Home (battery); the others hold their state's pose.
  const primary = useIsPrimaryBot(bot.id);
  return (
    <BotMenu bot={bot}>
      <Tap
        onPress={() => canChat ? void openBotChat(bot.id) : router.push({ pathname: "/bot/[id]", params: { id: bot.id } })}
        feel="select"
        sink={0.98}
        hitSlop={0}
        accessibilityLabel={bot.name + ", " + line + (unread ? ", unread" : "")}
        accessibilityActions={actions?.list}
        onAccessibilityAction={actions ? (event) => actions.run(event.nativeEvent.actionName) : undefined}
        style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 10 }}
      >
        <BotAvatar bot={bot} state={state} size={AVATAR} animated={primary} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
            <T variant="name" numberOfLines={1} style={{ flex: 1 }}>
              {bot.name}
            </T>
            {!!chat && (
              <T variant="footnote" color="muted">
                {ago(chat.time)}
              </T>
            )}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <T variant="subhead" color={state === "waiting" ? "warning" : busy ? "accentText" : "muted"} numberOfLines={1} style={{ flex: 1 }}>
              {line}
            </T>
            {unread && <Dot />}
          </View>
        </View>
      </Tap>
    </BotMenu>
  );
}

/** A section's heading: its name and count fold it; its menu renames or deletes it. */
function SectionHead({ section, count, open, onToggle, note }: { section: Section; count: number; open: boolean; onToggle: () => void; note?: string }) {
  const { colors } = useTheme();
  const canManage = useCan("agents", "manage");
  const prompt = useTextPrompt();
  const Fold = open ? ChevronDown : ChevronRight;
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: note ? 0 : -space.sm }}>
        <Tap
          onPress={onToggle}
          feel="select"
          accessibilityLabel={section.name + ", " + count + (count === 1 ? " bot" : " bots")}
          accessibilityState={{ expanded: open }}
          style={{ flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs }}
        >
          <T variant="label" color="muted" numberOfLines={1} style={{ textTransform: "uppercase", flexShrink: 1 }} accessibilityRole="header">
            {section.name}
          </T>
          <T variant="label" color="faint">
            {String(count)}
          </T>
          <Fold size={14} color={colors.faint} strokeWidth={2.4} />
        </Tap>
        {canManage && (
          <MenuView title={section.name} actions={SECTION_ACTIONS} onPressAction={({ nativeEvent }) => runSectionAction(section, nativeEvent.event, prompt.ask)}>
            <View accessible accessibilityRole="button" accessibilityLabel={"Options for section " + section.name} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Ellipsis size={18} color={colors.muted} strokeWidth={2.2} />
            </View>
          </MenuView>
        )}
      </View>
      {prompt.node}
      {!!note && (
        <T variant="footnote" color="faint" style={{ paddingHorizontal: space.xs, paddingBottom: space.sm }}>
          {note}
        </T>
      )}
    </View>
  );
}

/** A plain heading in the list ("Pinned", "Other bots"). */
export function ListHead({ title }: { title: string }) {
  return (
    <View style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: space.xs, marginBottom: -space.sm }}>
      <T variant="label" color="muted" style={{ textTransform: "uppercase" }} accessibilityRole="header">
        {title}
      </T>
    </View>
  );
}

/** The list as the UI thread sees it: the items, and each one's top and height in the list. */
type Model = { items: BoardItem[]; ys: number[]; hs: number[] };
const indexOf = (items: readonly BoardItem[], key: string) => {
  "worklet";
  for (let i = 0; i < items.length; i++) if (items[i].key === key) return i;
  return -1;
};

type Board = {
  model: SharedValue<Model>;
  /** The dragged item's key, "" when nothing is dragged. */
  active: SharedValue<string>;
  /** The key of the item the dragged bot would land under, and the group and place it would land in. */
  after: SharedValue<string>;
  zone: SharedValue<string>;
  index: SharedValue<number>;
  /** The dragged bot's top in the list, as the finger and the page have moved it. */
  top: SharedValue<number>;
  lifted: SharedValue<number>;
  begin: (key: string, fingerY: number) => void;
  move: (fingerY: number) => void;
  end: (key: string) => void;
  measure: (key: string, event: LayoutChangeEvent) => void;
};
const BoardContext = createContext<Board | null>(null);

/** One item of the list: it makes room, shades with its group, and, when it is a bot that can move, lifts and follows the finger. */
function Cell({ item, line, children }: { item: BoardItem; line: boolean; children: ReactNode }) {
  const theme = useTheme();
  const { colors } = theme;
  const board = use(BoardContext)!;
  const key = item.key;
  const zone = item.kind === "primary" ? "" : item.zone;
  const shift = useSharedValue(0);
  // How far this item moves to make room, as the dragged bot hovers. Back to 0 at once when the drag is over.
  useAnimatedReaction(
    () => {
      const m = board.model.value;
      const active = board.active.value;
      if (!active || active === key) return 0;
      const dragged = indexOf(m.items, active);
      return shiftOf(indexOf(m.items, key), dragged, indexOf(m.items, board.after.value), m.hs[dragged] ?? 0);
    },
    (next, previous) => {
      if (next === previous) return;
      shift.value = board.active.value ? withTiming(next, { duration: DRAG.SETTLE_MS }) : next;
    },
  );
  const style = useAnimatedStyle(() => {
    const active = board.active.value;
    if (active && active === key) {
      const m = board.model.value;
      const lifted = board.lifted.value;
      return {
        transform: [{ translateY: board.top.value - (m.ys[indexOf(m.items, key)] ?? 0) }, { scale: 1 + (DRAG.LIFT_SCALE - 1) * lifted }],
        zIndex: 10,
        borderRadius: radius.md * lifted,
        backgroundColor: colors.raised,
        shadowOpacity: lifted * (theme.dark ? 0.3 : 0.14),
      };
    }
    return {
      transform: [{ translateY: shift.value }, { scale: 1 }],
      zIndex: 0,
      borderRadius: 0,
      backgroundColor: active && zone && board.zone.value === zone ? colors.surface : "transparent",
      shadowOpacity: 0,
    };
  });
  return (
    <Animated.View onLayout={(event) => board.measure(key, event)} style={[{ shadowColor: colors.shadow, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }, item.kind === "head" && { marginTop: space.lg, paddingHorizontal: space.lg }, style]}>
      {line && <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: INSET }} />}
      {children}
    </Animated.View>
  );
}

/** A bot that can be dragged: the pan that waits for a rest and then a move (see the top of this file). */
function DragHandle({ itemKey, children, disabled }: { itemKey: string; children: ReactNode; disabled?: boolean }) {
  const board = use(BoardContext)!;
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
      if (!touch || board.active.value === itemKey) return;
      // Another bot is already being dragged: this finger does nothing.
      if (board.active.value) return GestureStateManager.fail(event.handlerTag);
      const moved = Math.hypot(touch.absoluteX - down.value.x, touch.absoluteY - down.value.y);
      const rested = Date.now() - down.value.t >= DRAG.HOLD_MS;
      if (!rested && moved > DRAG.SWIPE_SLOP) GestureStateManager.fail(event.handlerTag);
      else if (rested && moved >= DRAG.START_PT) GestureStateManager.activate(event.handlerTag);
    },
    onActivate: (event) => {
      "worklet";
      board.begin(itemKey, event.absoluteY);
    },
    onUpdate: (event) => {
      "worklet";
      board.move(event.absoluteY);
    },
    onFinalize: () => {
      "worklet";
      board.end(itemKey);
    },
  });
  if (disabled) return <View>{children}</View>;
  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}

/** The page Home scrolls in, for scrolling it near an edge while a bot is dragged. */
export type BoardScroll = {
  ref: AnimatedRef<Animated.ScrollView>;
  /** How far the page has scrolled, and how far it can. */
  offset: SharedValue<number>;
  max: SharedValue<number>;
  /** The screen's top and bottom edges a finger can reach the content between (under the status bar, over the tab bar). */
  edges: SharedValue<{ top: number; bottom: number }>;
};

export type BotBoardProps = {
  bots: Bot[];
  sections: Section[] | undefined;
  latest: Map<string, { chat?: ChatSummary; unread: boolean }>;
  folded: string[];
  onFold: (id: string) => void;
  scroll: BoardScroll;
  /** A bot was dropped into `zone` at `index` among its other bots (or moved there by VoiceOver). */
  onDrop: (id: string, zone: Zone, index: number) => void;
  /** A drag started or ended: Home stops the page's own scrolling while one is under way. */
  onDragging: (on: boolean) => void;
  manageable: boolean;
};

export function BotBoard({ bots, sections, latest, folded, onFold, scroll, onDrop, onDragging, manageable }: BotBoardProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const arranged = useMemo(() => arrangeBots(bots, sections), [bots, sections]);
  const items = useMemo(() => boardItems(arranged, folded, !!dragging), [arranged, folded, dragging]);
  // Every group's heading shows during a drag; "Move up" and "Move down" step through that same list.
  const steps = useMemo(() => boardItems(arranged, folded, true), [arranged, folded]);
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  const model = useSharedValue<Model>({ items: [], ys: [], hs: [] });
  const active = useSharedValue("");
  const after = useSharedValue("");
  const zone = useSharedValue("");
  const index = useSharedValue(0);
  const top = useSharedValue(0);
  const lifted = useSharedValue(0);
  const start = useSharedValue({ top: 0, finger: 0, offset: 0 });
  const finger = useSharedValue(0);
  const dropping = useSharedValue(false);

  // Each item's place in the list, measured as it lays out, handed to the UI thread with the items.
  const frames = useRef(new Map<string, { y: number; h: number }>());
  const sync = (list: BoardItem[]) => {
    model.value = { items: list, ys: list.map((item) => frames.current.get(item.key)?.y ?? 0), hs: list.map((item) => frames.current.get(item.key)?.h ?? 0) };
  };
  useLayoutEffect(() => sync(items));
  const measure = (key: string, event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    frames.current.set(key, { y, h: height });
    sync(items);
  };

  // The gesture may keep the worklets of an earlier render; these read the latest props when they run.
  const handlers = useRef({ onDrop, onDragging });
  useLayoutEffect(() => {
    handlers.current = { onDrop, onDragging };
  });
  // The drag's start and end on the JS side: the headings that show during it, the page's own scrolling, a tap under the finger.
  const started = (key: string) => {
    haptic.tap();
    setDragging(key);
    handlers.current.onDragging(true);
    autoScroll.setActive(true);
  };
  const dropped = (key: string, at: string, place: number) => {
    autoScroll.setActive(false);
    if (at) {
      haptic.select();
      handlers.current.onDrop(key.slice("bot:".length), at as Zone, place);
    }
    setDragging(null);
    handlers.current.onDragging(false);
  };
  // Once the list is drawn in its new order, the moved rows go back to their own places.
  useLayoutEffect(() => {
    if (dragging) return;
    active.value = "";
    after.value = "";
    zone.value = "";
    dropping.value = false;
    lifted.value = 0;
  }, [dragging, active, after, zone, dropping, lifted]);

  /** Where the dragged bot is, and so where it would land. Runs on the UI thread. */
  const track = () => {
    "worklet";
    const m = model.value;
    const dragged = indexOf(m.items, active.value);
    if (dragged < 0 || dropping.value) return;
    top.value = start.value.top + (finger.value - start.value.finger) + (scroll.offset.value - start.value.offset);
    const slot = pickSlot(m.items, m.ys, m.hs, dragged, top.value + (m.hs[dragged] ?? 0) / 2);
    if (!slot) return;
    after.value = m.items[slot.after].key;
    index.value = slot.index;
    if (zone.value !== slot.zone) {
      if (zone.value) scheduleOnRN(haptic.select);
      zone.value = slot.zone;
    }
  };
  const begin = (key: string, fingerY: number) => {
    "worklet";
    const m = model.value;
    const dragged = indexOf(m.items, key);
    const item = m.items[dragged];
    if (!item || item.kind !== "row" || active.value) return;
    start.value = { top: m.ys[dragged] ?? 0, finger: fingerY, offset: scroll.offset.value };
    finger.value = fingerY;
    top.value = m.ys[dragged] ?? 0;
    dropping.value = false;
    active.value = key;
    after.value = dragged > 0 ? m.items[dragged - 1].key : "";
    zone.value = item.zone;
    index.value = 0;
    lifted.value = withTiming(1, { duration: DRAG.SETTLE_MS });
    track();
    scheduleOnRN(started, key);
  };
  const move = (fingerY: number) => {
    "worklet";
    finger.value = fingerY;
    track();
  };
  const end = (key: string) => {
    "worklet";
    if (active.value !== key || dropping.value) return;
    dropping.value = true;
    const m = model.value;
    const dragged = indexOf(m.items, key);
    const at = zone.value;
    const place = index.value;
    lifted.value = withTiming(0, { duration: DRAG.SETTLE_MS });
    top.value = withTiming(restingTop(m.ys, m.hs, dragged, indexOf(m.items, after.value)), { duration: DRAG.SETTLE_MS }, () => {
      "worklet";
      scheduleOnRN(dropped, key, at, place);
    });
  };

  // Near the top or bottom edge the page scrolls under the dragged bot, faster nearer the edge.
  const autoScroll: FrameCallback = useFrameCallback(() => {
    "worklet";
    if (!active.value || dropping.value) return;
    const { top: high, bottom: low } = scroll.edges.value;
    const y = finger.value;
    let speed = 0;
    if (y < high + DRAG.EDGE) speed = -DRAG.SCROLL_MAX * Math.min(1, (high + DRAG.EDGE - y) / DRAG.EDGE);
    else if (y > low - DRAG.EDGE) speed = DRAG.SCROLL_MAX * Math.min(1, (y - (low - DRAG.EDGE)) / DRAG.EDGE);
    if (!speed) return;
    const next = Math.max(0, Math.min(scroll.max.value, scroll.offset.value + speed));
    if (next === scroll.offset.value) return;
    scroll.offset.value = next;
    scrollTo(scroll.ref, 0, next, false);
    track();
  }, false);
  useEffect(() => () => autoScroll.setActive(false), [autoScroll]);

  const board: Board = { model, active, after, zone, index, top, lifted, begin, move, end, measure };

  const count = (z: Zone) => (z === "pinned" ? arranged.pinned.length : z === "rest" ? arranged.rest.length : (arranged.sections.find((entry) => "section:" + entry.section.id === z)?.bots.length ?? 0));
  // VoiceOver can't drag: each bot has Move up, Move down, Pin or Unpin, and Move to each other group.
  const actionsFor = (bot: Bot, from: Zone): RowActions => {
    const up = stepSlot(steps, bot.id, -1);
    const down = stepSlot(steps, bot.id, 1);
    const list = manageable ? [
      ...(up ? [{ name: "up", label: "Move up" }] : []),
      ...(down ? [{ name: "down", label: "Move down" }] : []),
      { name: "pin", label: bot.pinned ? "Unpin" : "Pin" },
      ...arranged.sections.filter(({ section }) => from !== "section:" + section.id).map(({ section }) => ({ name: "section:" + section.id, label: "Move to " + section.name })),
      ...(from !== "rest" && arranged.sections.length > 0 ? [{ name: "section:none", label: "Move to Other bots" }] : []),
    ] : [];
    return {
      list,
      run: (name) => {
        const slot = name === "up" ? up : name === "down" ? down : undefined;
        if (slot) onDrop(bot.id, slot.zone, slot.index);
        else if (name === "pin") void attempt(api.setBotFlags(bot.id, { pinned: !bot.pinned }));
        // To the end of that group, unpinned, as a drop there would.
        else if (name.startsWith("section:")) {
          const to: Zone = name === "section:none" ? "rest" : zoneOfSection(name.slice("section:".length));
          onDrop(bot.id, to, count(to));
        }
      },
    };
  };

  return (
    <BoardContext value={board}>
      <View style={{ marginHorizontal: -space.lg }}>
        {items.map((item, at) => {
          const previous = items[at - 1];
          if (item.kind === "head") {
            const id = sectionIdOf(item.zone);
            const section = id ? arranged.sections.find((entry) => entry.section.id === id)?.section : undefined;
            const open = !!section && !folded.includes(section.id);
            const empty = count(item.zone) === 0;
            const note = !section || !open || !empty || dragging ? undefined : bots.some((bot) => bot.sectionId === section.id && !bot.hidden) ? "Its bots are pinned above." : "No bots here yet.";
            return (
              <Cell key={item.key} item={item} line={false}>
                {section ? <SectionHead section={section} count={count(item.zone)} open={open} onToggle={() => onFold(section.id)} note={note} /> : <ListHead title={item.zone === "pinned" ? "Pinned" : "Other bots"} />}
              </Cell>
            );
          }
          const bot = byId.get(item.botId);
          if (!bot) return null;
          const entry = latest.get(bot.id);
          const line = previous?.kind === "row" || previous?.kind === "primary";
          if (item.kind === "primary")
            return (
              <Cell key={item.key} item={item} line={false}>
                <BotRow bot={bot} chat={entry?.chat} unread={!!entry?.unread} />
              </Cell>
            );
          return (
            <Cell key={item.key} item={item} line={line}>
              <DragHandle itemKey={item.key} disabled={!manageable}>
                <BotRow bot={bot} chat={entry?.chat} unread={!!entry?.unread} actions={actionsFor(bot, item.zone)} />
              </DragHandle>
            </Cell>
          );
        })}
      </View>
    </BoardContext>
  );
}
