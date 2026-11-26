// The Chats list, with the person's sections and dragging: hold a chat, then move, and it lifts and
// follows the finger; the group it is over is shaded, and the page scrolls near the top or bottom
// edge. Dropped on a section it goes there; on a day's group it leaves its section; on Pinned it is
// pinned. Hold still and the chat's menu opens, as before. The hold-then-move rule and its numbers
// are Home's (src/features/home/BotBoard.tsx, DRAG in drag.ts); where a drop lands is in sections.ts.
import { MenuView } from "@react-native-menu/menu";
import { router } from "expo-router";
import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react-native";
import { createContext, type ReactNode, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, type LayoutChangeEvent, View } from "react-native";
import { GestureDetector, GestureStateManager, usePanGesture } from "react-native-gesture-handler";
import Animated, { type FrameCallback, scrollTo, type SharedValue, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { BoardScroll } from "@/features/home/BotBoard";
import { DRAG } from "@/features/home/drag";
import type { Bot, ChatSummary, Section } from "@/link/types";
import { activityLabel, useCan, useChatActivity, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { isRoutineChat } from "../../../link-host/routine-chat.mjs";
import { useApp } from "@/state/store";
import { ago } from "@/state/time";
import { openFromList, useChatSplit } from "./split";
import { BotAvatar, Dot, haptic, HoldMenu, radius, space, T, Tap, type TextPromptOptions, useTextPrompt, useTheme } from "@/ui";
import { GroupFace, plainPreview } from "./bits";
import { myPlace, myself } from "./people";
import { moveToSection, runSectionAction, runSectionChoice, sectionActions } from "./sectionMenus";
import { arrangeChats, arrangeChatsFlat, chatDropPlan, type ChatGroup, groupAt, type ListItem, listItems, sectionOfChat } from "./sections";
import { regenerateTitle, regenerateTitleAction, useCanRegenerateTitle } from "./titleActions";

function remove(chat: ChatSummary) {
  Alert.alert("Delete this chat?", chat.title, [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: () => void attempt(api.deleteChat(chat.id)) },
  ]);
}

function rename(chat: ChatSummary, ask: (options: TextPromptOptions) => void) {
  ask({
    title: "Rename chat",
    value: chat.title,
    confirm: "Rename",
    onSubmit: (value) => {
      const title = value.slice(0, 120);
      if (title !== chat.title) void attempt(api.renameChat(chat.id, title));
    },
  });
}

/** What VoiceOver offers on a chat in place of dragging. */
type RowActions = { list: { name: string; label: string }[]; run: (name: string) => void };

/** One chat: its bot's face, its title, its last line, and when. `sections` is undefined on a computer without them. */
function ChatRow({ chat, bots, sections, actions }: { chat: ChatSummary; bots: Map<string, Bot>; sections: Section[] | undefined; actions?: RowActions }) {
  const state = useChatActivity(chat.id);
  const bot = bots.get(chat.botId);
  const live = activityLabel(state);
  const group = chat.botIds && chat.botIds.length > 1;
  const canView = useCan("agents", "view");
  const canChat = useCan("agents", "chat");
  const me = myself(usePart("meta"));
  const speaker = chat.last?.role === "user" ? "You" : group && chat.last?.botId ? bots.get(chat.last.botId)?.name : undefined;
  const preview = chat.last ? (speaker ? speaker + ": " : "") + plainPreview(chat.last.text) : "No messages yet";
  const title = chat.title || bot?.name || "Chat";
  // With the chat open beside the list (two panes), its row is marked.
  const picked = useChatSplit((split) => split.active && split.id === chat.id);
  const { colors } = useTheme();
  const prompt = useTextPrompt();
  // Renaming and deleting a chat are its starter's (and the owner's); someone invited to it has their own marks only.
  const mine = myPlace(chat, me) === "manages";
  const canRegenerate = useCanRegenerateTitle(chat, mine);
  const starters = mine && !chat.main ? [{ id: "rename", title: "Rename…", image: "pencil" }, ...(canRegenerate ? [regenerateTitleAction] : [])] : [];
  const ends = mine && !chat.main ? [{ id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } }] : [];
  // A section is the person's own way to group their chats, like a pin.
  const filing = sections ? [moveToSection(chat, sections)] : [];
  const menu = chat.archived
    ? [{ id: "restore", title: "Restore", image: "tray.and.arrow.up" }, ...starters, ...ends]
    : [
        { id: "pin", title: chat.pinned ? "Unpin" : "Pin", image: chat.pinned ? "pin.slash" : "pin" },
        ...filing,
        ...(!isRoutineChat(chat) ? [{ id: "unread", title: chat.unread ? "Mark as read" : "Mark as unread", image: chat.unread ? "envelope.open" : "envelope.badge" }] : []),
        ...starters,
        ...(chat.main ? [] : [{ id: "archive", title: "Archive", image: "archivebox" }]),
        ...ends,
      ];
  const viewOnlyMenu = canView && !chat.archived && chat.unread ? [{ id: "unread", title: "Mark as read", image: "envelope.open" }] : [];
  return (
    <>
    <HoldMenu
      actions={canChat ? menu : viewOnlyMenu}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (runSectionChoice(chat, action, prompt.ask)) return;
        if (action === "pin") void attempt(api.setChatFlags(chat.id, { pinned: !chat.pinned }));
        else if (action === "unread") void attempt(api.setChatFlags(chat.id, { unread: canChat ? !chat.unread : false }));
        else if (action === "archive") void attempt(api.setChatFlags(chat.id, { archived: true }), "Archived");
        else if (action === "restore") void attempt(api.setChatFlags(chat.id, { archived: false }), "Restored");
        else if (action === "rename") rename(chat, prompt.ask);
        else if (action === regenerateTitleAction.id) regenerateTitle(chat.id);
        else if (action === "delete") remove(chat);
      }}
    >
      <Tap
        onPress={() => openFromList(chat.id)}
        sink={1}
        feel="select"
        hitSlop={0}
        accessibilityLabel={title + ", " + (live || preview) + (chat.unread ? ", unread" : "")}
        accessibilityHint="Long press for more"
        accessibilityActions={canRegenerate ? [...(actions?.list ?? []), { name: regenerateTitleAction.id, label: regenerateTitleAction.title }] : actions?.list}
        onAccessibilityAction={actions || canRegenerate ? (event) => {
          const action = event.nativeEvent.actionName;
          if (canRegenerate && action === regenerateTitleAction.id) regenerateTitle(chat.id);
          else actions?.run(action);
        } : undefined}
      >
        <View style={[{ minHeight: 72, paddingVertical: space.md, flexDirection: "row", alignItems: "center", gap: space.md }, picked && { backgroundColor: colors.sunken, borderRadius: radius.lg, marginHorizontal: -space.sm, paddingHorizontal: space.sm }]} accessibilityState={picked ? { selected: true } : undefined}>
          {group ? <GroupFace bots={chat.botIds!.slice(0, 2).map((id) => bots.get(id))} size={48} state={state} /> : <BotAvatar bot={bot} size={48} state={state} />}
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <T variant="callout" weight={chat.unread && !isRoutineChat(chat) ? "700" : "600"} numberOfLines={1} style={{ flex: 1 }}>
                {title}
              </T>
              <T variant="footnote" color={chat.unread && !isRoutineChat(chat) ? "accentText" : "faint"} weight={chat.unread && !isRoutineChat(chat) ? "600" : "400"}>
                {chat.time ? ago(chat.time) : ""}
              </T>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              {live ? (
                <T variant="subhead" weight="600" color={state === "waiting" ? "warning" : "accentText"} numberOfLines={1} style={{ flex: 1 }}>
                  {live}
                </T>
              ) : (
                <T variant="subhead" color={chat.unread && !isRoutineChat(chat) ? "ink2" : "muted"} numberOfLines={1} style={{ flex: 1 }}>
                  {preview}
                </T>
              )}
              {chat.unread && !isRoutineChat(chat) && <Dot size={9} />}
            </View>
          </View>
        </View>
      </Tap>
    </HoldMenu>
    {prompt.node}
    </>
  );
}

/** A group's heading. A section's folds it with a tap and has the section's menu; the others are plain. */
function GroupHead({ group, sections, open, onToggle, note }: { group: ChatGroup; sections: Section[]; open: boolean; onToggle: () => void; note?: string }) {
  const { colors } = useTheme();
  const prompt = useTextPrompt();
  const section = group.section;
  if (!section)
    return (
      <View style={{ minHeight: 36, justifyContent: "flex-end", paddingBottom: space.xs }}>
        <T variant="label" color="muted" style={{ textTransform: "uppercase" }} accessibilityRole="header">
          {group.title}
        </T>
      </View>
    );
  const count = group.chats.length;
  const Fold = open ? ChevronDown : ChevronRight;
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Tap
          onPress={onToggle}
          feel="select"
          accessibilityLabel={section.name + ", " + count + (count === 1 ? " chat" : " chats")}
          accessibilityState={{ expanded: open }}
          style={{ flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm }}
        >
          <T variant="label" color="muted" numberOfLines={1} style={{ textTransform: "uppercase", flexShrink: 1 }} accessibilityRole="header">
            {section.name}
          </T>
          <T variant="label" color="faint">
            {String(count)}
          </T>
          <Fold size={14} color={colors.faint} strokeWidth={2.4} />
        </Tap>
        <MenuView title={section.name} actions={sectionActions(sections, section)} onPressAction={({ nativeEvent }) => runSectionAction(sections, section, nativeEvent.event, prompt.ask)}>
          <View accessible accessibilityRole="button" accessibilityLabel={"Options for section " + section.name} style={{ width: 44, height: 44, marginRight: -space.md, alignItems: "center", justifyContent: "center" }}>
            <Ellipsis size={18} color={colors.muted} strokeWidth={2.2} />
          </View>
        </MenuView>
      </View>
      {prompt.node}
      {!!note && (
        <T variant="footnote" color="faint" style={{ paddingBottom: space.sm }}>
          {note}
        </T>
      )}
    </View>
  );
}

/** The list as the UI thread sees it: the items, and each one's top and height in the list. */
type Model = { items: ListItem[]; ys: number[]; hs: number[] };
const indexOf = (items: readonly ListItem[], key: string) => {
  "worklet";
  for (let i = 0; i < items.length; i++) if (items[i].key === key) return i;
  return -1;
};

type Board = {
  model: SharedValue<Model>;
  /** The dragged item's key, "" when nothing is dragged. */
  active: SharedValue<string>;
  /** The group the dragged chat is over. */
  zone: SharedValue<string>;
  /** The dragged chat's top in the list, as the finger and the page have moved it. */
  top: SharedValue<number>;
  lifted: SharedValue<number>;
  begin: (key: string, fingerY: number) => void;
  move: (fingerY: number) => void;
  end: (key: string) => void;
  measure: (key: string, event: LayoutChangeEvent) => void;
};
const BoardContext = createContext<Board | null>(null);

/** One item of the list: it shades with its group while a chat is over it, and, when it is the dragged chat, lifts and follows the finger. */
function Cell({ item, children }: { item: ListItem; children: ReactNode }) {
  const theme = useTheme();
  const { colors } = theme;
  const board = use(BoardContext)!;
  const key = item.key;
  const group = item.group;
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
      transform: [{ translateY: 0 }, { scale: 1 }],
      zIndex: 0,
      borderRadius: 0,
      backgroundColor: active && board.zone.value === group ? colors.surface : "transparent",
      shadowOpacity: 0,
    };
  });
  return (
    <Animated.View onLayout={(event) => board.measure(key, event)} style={[{ paddingHorizontal: space.xl, shadowColor: colors.shadow, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }, item.kind === "head" && { paddingTop: space.md }, style]}>
      {children}
    </Animated.View>
  );
}

/** A chat that can be dragged: the pan that waits for a rest and then a move (see the top of BotBoard.tsx). */
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
      // Another chat is already being dragged: this finger does nothing.
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

type Plan = NonNullable<ReturnType<typeof chatDropPlan>>;
const NO_FOLDS: string[] = [];

/**
 * A drop's change, shown at once until the computer's own state arrives: while its calls are out,
 * then until the chats change once more after they finish (or DRAG.HOLD_ORDER_MS). A failed call
 * shows its toast and the computer's state comes back. (Home holds a dropped bot's order the same way.)
 */
function useDropHold(chats: ChatSummary[], sections: Section[] | undefined) {
  const [pending, setPending] = useState<{ id: string; plan: Plan; done?: ChatSummary[] } | null>(null);
  const live = useApp((state) => state.parts.chats);
  const stale = !!pending?.done && pending.done !== live;
  useEffect(() => {
    if (stale) setPending(null);
  }, [stale]);
  useEffect(() => {
    if (!pending?.done) return;
    const timer = setTimeout(() => setPending(null), DRAG.HOLD_ORDER_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  const drop = (id: string, group: string) => {
    const chat = chats.find((one) => one.id === id);
    const plan = chat && chatDropPlan(chat, sections, group);
    if (!plan) return;
    const mine = { id, plan };
    setPending(mine);
    void (async () => {
      let ok = true;
      if (plan.pinned !== undefined) ok = !!(await attempt(api.setChatFlags(id, { pinned: plan.pinned }).then(() => true)));
      if (ok && plan.sectionId !== undefined) ok = !!(await attempt(api["link.chats.setSection"](id, plan.sectionId).then(() => true)));
      // Kept until the chats change after this, so the list doesn't flick back first.
      setPending((now) => (now === mine ? (ok ? { ...mine, done: useApp.getState().parts.chats ?? [] } : null) : now));
    })();
  };
  const shown = useMemo(() => {
    if (!pending || stale) return chats;
    return chats.map((chat) => {
      if (chat.id !== pending.id) return chat;
      const { sectionId: _section, ...rest } = chat;
      const sectionId = pending.plan.sectionId === undefined ? chat.sectionId : (pending.plan.sectionId ?? undefined);
      return { ...rest, ...(sectionId ? { sectionId } : {}), pinned: pending.plan.pinned ?? chat.pinned };
    });
  }, [chats, pending, stale]);
  return { shown, drop };
}

export type ChatBoardProps = {
  /** The chats to list, already cut to a search. */
  chats: ChatSummary[];
  /** Archived chats, when they are shown: a group of their own at the end, which nothing is dragged in or out of. */
  archived: ChatSummary[];
  /** The person's sections; undefined on a computer without them (the list is then as it always was). */
  sections: Section[] | undefined;
  bots: Map<string, Bot>;
  searching: boolean;
  scroll: BoardScroll;
  /** A drag started or ended: the screen stops the page's own scrolling while one is under way. */
  onDragging: (on: boolean) => void;
  /** One list ("Recent") with pinned chats left out (the screen draws them as a row), as the Chats screen does since the redesign. */
  flat?: boolean;
};

export function ChatBoard({ chats, archived, sections, bots, searching, scroll, onDragging, flat }: ChatBoardProps) {
  const canChat = useCan("agents", "chat");
  const [dragging, setDragging] = useState<string | null>(null);
  // Sections fold while the app is open, as on Home.
  const [folded, setFolded] = useState<string[]>([]);
  const hold = useDropHold(chats, sections);
  const groups = useMemo(() => {
    const list = flat ? arrangeChatsFlat(hold.shown, sections, { dragging: !!dragging && !!sections }) : arrangeChats(hold.shown, sections, Date.now(), { searching, dragging: !!dragging && !!sections });
    const old = [...archived].sort((a, b) => b.time - a.time);
    return old.length ? [...list, { key: "archived", title: "Archived", chats: old }] : list;
  }, [hold.shown, archived, sections, searching, dragging, flat]);
  // A folded section opens while a search is on, so its matches show.
  const closed = searching ? NO_FOLDS : folded;
  const items = useMemo(() => listItems(groups, closed), [groups, closed]);
  const byId = useMemo(() => new Map([...hold.shown, ...archived].map((chat) => [chat.id, chat])), [hold.shown, archived]);
  const byKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);
  // A chat is filed only on a computer that keeps sections; without them a drag would have nowhere to go.
  const movable = canChat && !!sections;

  const model = useSharedValue<Model>({ items: [], ys: [], hs: [] });
  const active = useSharedValue("");
  const zone = useSharedValue("");
  const top = useSharedValue(0);
  const lifted = useSharedValue(0);
  const start = useSharedValue({ top: 0, finger: 0, offset: 0 });
  const finger = useSharedValue(0);
  const dropping = useSharedValue(false);

  // Each item's place in the list, measured as it lays out, handed to the UI thread with the items.
  const frames = useRef(new Map<string, { y: number; h: number }>());
  const sync = (list: ListItem[]) => {
    model.value = { items: list, ys: list.map((item) => frames.current.get(item.key)?.y ?? 0), hs: list.map((item) => frames.current.get(item.key)?.h ?? 0) };
  };
  useLayoutEffect(() => sync(items));
  const measure = (key: string, event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    frames.current.set(key, { y, h: height });
    sync(items);
  };

  // The gesture may keep the worklets of an earlier render; these read the latest props when they run.
  const handlers = useRef({ onDragging, drop: hold.drop });
  useLayoutEffect(() => {
    handlers.current = { onDragging, drop: hold.drop };
  });
  const started = (key: string) => {
    haptic.tap();
    setDragging(key);
    handlers.current.onDragging(true);
    autoScroll.setActive(true);
  };
  const dropped = (key: string, at: string) => {
    autoScroll.setActive(false);
    if (at) {
      haptic.select();
      handlers.current.drop(key.slice("chat:".length), at);
    }
    setDragging(null);
    handlers.current.onDragging(false);
  };
  // Once the list is drawn again, the dragged row goes back to being a row.
  useLayoutEffect(() => {
    if (dragging) return;
    active.value = "";
    zone.value = "";
    dropping.value = false;
    lifted.value = 0;
  }, [dragging, active, zone, dropping, lifted]);

  /** Where the dragged chat is, and so which group it is over. Runs on the UI thread. */
  const track = () => {
    "worklet";
    const m = model.value;
    const dragged = indexOf(m.items, active.value);
    if (dragged < 0 || dropping.value) return;
    top.value = start.value.top + (finger.value - start.value.finger) + (scroll.offset.value - start.value.offset);
    const over = groupAt(m.items, m.ys, m.hs, top.value + (m.hs[dragged] ?? 0) / 2);
    if (over && zone.value !== over) {
      if (zone.value) scheduleOnRN(haptic.select);
      zone.value = over;
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
    zone.value = item.group;
    lifted.value = withTiming(1, { duration: DRAG.SETTLE_MS });
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
    const at = zone.value;
    // The row settles back in its own place; the list then draws it where it now belongs.
    lifted.value = withTiming(0, { duration: DRAG.SETTLE_MS });
    top.value = withTiming(m.ys[indexOf(m.items, key)] ?? 0, { duration: DRAG.SETTLE_MS }, () => {
      "worklet";
      scheduleOnRN(dropped, key, at);
    });
  };

  // Near the top or bottom edge the page scrolls under the dragged chat, faster nearer the edge.
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

  const board: Board = { model, active, zone, top, lifted, begin, move, end, measure };

  // VoiceOver can't drag: each chat has "Move to" each other section, and out of its own.
  const actionsFor = (chat: ChatSummary): RowActions | undefined => {
    if (!movable || chat.archived) return undefined;
    const own = sectionOfChat(chat, sections)?.id;
    return {
      list: [...(sections ?? []).filter((section) => section.id !== own).map((section) => ({ name: "section:" + section.id, label: "Move to " + section.name })), ...(own ? [{ name: "none", label: "Move out of its section" }] : [])],
      run: (name) => hold.drop(chat.id, name),
    };
  };

  return (
    <BoardContext value={board}>
      <View style={{ marginHorizontal: -space.xl }}>
        {items.map((item) => {
          const group = byKey.get(item.group);
          if (item.kind === "head") {
            if (!group) return null;
            const open = !group.section || !closed.includes(group.section.id);
            const note = group.section && open && !group.chats.length && !dragging ? "No chats here yet." : undefined;
            return (
              <Cell key={item.key} item={item}>
                <GroupHead group={group} sections={sections ?? []} open={open} onToggle={() => group.section && setFolded((now) => (now.includes(group.section!.id) ? now.filter((id) => id !== group.section!.id) : [...now, group.section!.id]))} note={note} />
              </Cell>
            );
          }
          const chat = byId.get(item.chatId);
          if (!chat) return null;
          return (
            <Cell key={item.key} item={item}>
              <DragHandle itemKey={item.key} disabled={!movable || !!chat.archived}>
                <ChatRow chat={chat} bots={bots} sections={sections} actions={actionsFor(chat)} />
              </DragHandle>
            </Cell>
          );
        })}
      </View>
    </BoardContext>
  );
}
