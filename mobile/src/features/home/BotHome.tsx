// The first tab, where the app opens: the chat with the person's bot. It starts on the primary bot
// (the first in the computer's order) and stays with the one last chosen here (`prefs.homeBot`).
// The top of the tab is the row of bots: the one on show large in the middle with its name and
// what it is for under it, the others small beside it. A tap on another bot, or a swipe of the row,
// brings that bot to the middle and its chat below. The row's first button opens Home, the board of
// all bots; its last is the chat's own menu. The chat is the bot's Main chat where the computer
// keeps one for each bot and person, otherwise its latest chat. A computer with no bots yet, or a
// person who may not chat, gets Home here. A hold on a face opens that bot's page; a hold and then
// a slide carries the face to a new place in the row. The plain logic is homeBot.ts, strip.ts and
// rowDrag.ts.
import { router } from "expo-router";
import { LayoutList } from "lucide-react-native";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { GestureDetector, GestureStateManager, usePanGesture } from "react-native-gesture-handler";
import Animated, { scrollTo, type SharedValue, useAnimatedReaction, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue, useFrameCallback, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { openPlace } from "@/features/all/open";
import { ChatPane } from "@/features/chat/ChatScreen";
import { openChat } from "@/features/chat/navigate";
import { unreadBotIds } from "@/features/chat/unread";
import type { Bot } from "@/link/types";
import { activityLabel, useBotActivity, useBots, useCan, useCanArrange, useCapability, useChats, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { setPrefs, usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { BackdropLayer, BotAvatar, Dot, EmptyState, Glass, haptic, IconButton, LinkBanner, Loading, radius, space, T, Tap, useShape, useTheme } from "@/ui";
import Home from "./Home";
import { homeBots, homeChat, pickHomeBot } from "./homeBot";
import { DRAG } from "./drag";
import { centreFor, driftSpeed, landingSlot, placeOf, ROW_DRAG, rowPlan, slotAfterMove } from "./rowDrag";
import { edgeRoom, faceScale, faceShown, indexAt, offsetOf, pillWords, STRIP } from "./strip";
import { useHeldOrder } from "./useHeldOrder";

const stay = () => {};
/** How long a tapped bot takes to reach the middle before its chat opens, if the row doesn't say it has stopped. */
const SETTLE_MS = 280;

/**
 * What the row's faces are placed from, all of it on the UI thread: each bot's slot, the row's
 * scroll, and a bot being carried. A face reads its place from these and from nothing a render
 * hands it, so a new order arrives in one step with the faces already where it puts them.
 */
type RowDrag = {
  /** Each bot's slot in the row, by id. */
  slots: SharedValue<Record<string, number>>;
  /** The row's middle, in slots (a fraction while it moves). */
  centre: SharedValue<number>;
  /** The row's scroll offset. */
  x: SharedValue<number>;
  /** The bot being carried ("" for none), the slot it came from and the slot it would land in. */
  carried: SharedValue<string>;
  from: SharedValue<number>;
  to: SharedValue<number>;
  /** Where the carried face is, as its own translation, and how far it is lifted (0 to 1). */
  dx: SharedValue<number>;
  lifted: SharedValue<number>;
  /** How far from the middle (slots) the carried face rests when it is not lifted: where it was picked up, then where it lands. */
  restAway: SharedValue<number>;
  begin: (id: string, fingerX: number) => void;
  move: (id: string, fingerX: number) => void;
  end: (id: string) => void;
};

/**
 * One bot in the row. Every face is drawn at the large size and scaled, and placed by how far its
 * slot is from the middle as the row scrolls: the one in the middle is large and whole, the ones
 * beside it stand aside, small and dimmed. Only the bot on show moves (it is the agent the person
 * is with); the others hold still, with a dot when they have something unread. A hold opens the
 * bot's page; a hold and then a slide carries the face along the row to a new place (rowDrag.ts).
 */
function RowBot({ bot, index, drag, edge, on, unread, movable, onPick, onPage, onStep }: { bot: Bot; index: number; drag: RowDrag; /** Where the first slot starts in the row's content. */ edge: number; on: boolean; unread: boolean; /** Whether this face can be carried to a new place. */ movable: boolean; onPick: () => void; /** A hold on the face: the bot's page. */ onPage: () => void; /** One place left or right (VoiceOver). */ onStep: (by: -1 | 1) => void }) {
  const state = useBotActivity(bot.id);
  const status = activityLabel(state);
  const id = bot.id;
  // The slot this face stands in: its own, or one over while another face is carried past it.
  const slot = useSharedValue(index);
  useAnimatedReaction(
    () => slotAfterMove(drag.slots.value[id] ?? index, drag.from.value, drag.to.value),
    (now, before) => {
      if (now === before) return;
      slot.value = before !== null && drag.from.value >= 0 ? withTiming(now, { duration: ROW_DRAG.SETTLE_MS }) : now;
    },
  );
  // Every face starts at the first slot and is moved to its place: where it stands is one number, not a place in a list.
  const place = useAnimatedStyle(() => {
    if (drag.carried.value === id) return { zIndex: 2, transform: [{ translateX: drag.dx.value }] };
    return { zIndex: 0, transform: [{ translateX: placeOf(slot.value, drag.centre.value) + drag.x.value }] };
  });
  const face = useAnimatedStyle(() => {
    if (drag.carried.value === id) {
      const up = drag.lifted.value;
      const rest = drag.restAway.value;
      const scale = faceScale(rest) * (1 - up) + (STRIP.small / STRIP.face) * ROW_DRAG.LIFT * up;
      return { opacity: faceShown(rest) * (1 - up) + up, transform: [{ scale }] };
    }
    const away = slot.value - drag.centre.value;
    return { opacity: faceShown(away), transform: [{ scale: faceScale(away) }] };
  });
  // The same hold-then-move as a bot on Home's board: a move at once is a swipe, and the row scrolls.
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
      if (!touch || drag.carried.value === id) return;
      // Another face is already carried: this finger does nothing.
      if (drag.carried.value) return GestureStateManager.fail(event.handlerTag);
      const moved = Math.hypot(touch.absoluteX - down.value.x, touch.absoluteY - down.value.y);
      const rested = Date.now() - down.value.t >= DRAG.HOLD_MS;
      if (!rested && moved > DRAG.SWIPE_SLOP) GestureStateManager.fail(event.handlerTag);
      else if (rested && moved >= DRAG.START_PT) GestureStateManager.activate(event.handlerTag);
    },
    onActivate: (event) => {
      "worklet";
      drag.begin(id, event.absoluteX);
    },
    onUpdate: (event) => {
      "worklet";
      drag.move(id, event.absoluteX);
    },
    onFinalize: () => {
      "worklet";
      drag.end(id);
    },
  });
  const tap = (
    <Tap
      onPress={onPick}
      // A hold on any face opens that bot's page, as its name tag does: the tag can be switched off.
      onLongPress={onPage}
      feel="select"
      hitSlop={0}
      accessibilityLabel={bot.name + (status ? ", " + status : "") + (unread && !on ? ", unread" : "")}
      accessibilityHint={(on ? "Hold for this bot's page" : "Shows the chat with this bot. Hold for its page") + (movable ? ". Hold and slide to move it" : "")}
      accessibilityState={{ selected: on }}
      accessibilityActions={[{ name: "longpress", label: "Bot page" }, ...(movable ? [{ name: "left", label: "Move left" }, { name: "right", label: "Move right" }] : [])]}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        if (name === "longpress") onPage();
        else if (name === "left" || name === "right") onStep(name === "left" ? -1 : 1);
      }}
      style={{ width: STRIP.slot, height: STRIP.face, alignItems: "center", justifyContent: "center" }}
    >
      {/* The large face is wider than its slot: it is drawn over the space the others left for it. */}
      <Animated.View style={[{ width: STRIP.face, height: STRIP.face }, face]}>
        <BotAvatar bot={bot} state={state} size={STRIP.face} animated={on} />
      </Animated.View>
      {unread && !on && (
        <View pointerEvents="none" style={{ position: "absolute", top: (STRIP.face - STRIP.small) / 2 - 3, right: (STRIP.slot - STRIP.small) / 2 - 3 }}>
          <Dot size={9} />
        </View>
      )}
    </Tap>
  );
  return (
    <Animated.View style={[{ position: "absolute", left: edge, top: 0, width: STRIP.slot, height: STRIP.face }, place]}>
      {movable ? (
        <GestureDetector gesture={pan}>
          <View collapsable={false}>{tap}</View>
        </GestureDetector>
      ) : (
        tap
      )}
    </Animated.View>
  );
}

type BotRowProps = {
  bots: Bot[];
  chosen: string;
  unread: Set<string>;
  onPick: (id: string) => void;
  /** The row's own width, kept by the tab so the row is in place at once when a chat's bar is drawn again. */
  width: number;
  onWidth: (width: number) => void;
  /** The chat's menu, when there is a chat under the row: a round button with the chat's context ring as its edge. */
  menu?: ReactNode;
  /** A bot was carried to place `to` in the row. True when that changes the order. Not given: the bots can't be moved (a role that may not, or no link). */
  onMove?: (id: string, to: number) => boolean;
};

/** The row of bots, the name of the one on show, and where it is among the others. */
function BotRow({ bots, chosen, unread, onPick, width, onWidth, menu, onMove }: BotRowProps) {
  const { colors } = useTheme();
  const index = Math.max(0, bots.findIndex((bot) => bot.id === chosen));
  // The bot in the middle. It runs ahead of `chosen` while a tapped bot slides in or the row is swiped.
  const [at, setAt] = useState(index);
  const scroller = useAnimatedRef<Animated.ScrollView>();
  // Where the row is scrolled to. Every face is sized and placed from it, on the UI thread.
  const x = useSharedValue(offsetOf(index));
  const count = bots.length;
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(settleTimer.current), []);
  const shown = bots[at] ?? bots[index];

  // The bot in the middle becomes the one on show: its chat opens below.
  const commit = (to: number) => {
    clearTimeout(settleTimer.current);
    const id = bots[to]?.id;
    if (id && id !== chosen) onPick(id);
  };
  // The name tag. On (the usual), it stays. Off (Settings › Appearance), it shows while the person
  // changes bots, by a tap or a swipe, and fades a moment after a bot is on show. The row is drawn
  // again for each bot's chat, so a bot just landed on starts here: shown, then fading.
  const keepTag = usePrefs((prefs) => prefs.nameTag);
  const tag = useSharedValue(1);
  const rest = () => {
    tag.value = keepTag ? 1 : withDelay(STRIP.tagStaysMs, withTiming(0, { duration: STRIP.tagFadeMs }));
  };
  const wake = () => {
    tag.value = withTiming(1, { duration: 120 });
  };
  useEffect(rest, [keepTag, chosen]);
  const tagStyle = useAnimatedStyle(() => ({ opacity: tag.value }));
  const page = (id: string) => router.push({ pathname: "/bot/[id]", params: { id } });

  // Carrying a bot to a new place (rowDrag.ts). Everything a face is placed from is kept here, on the UI thread.
  const slots = useSharedValue<Record<string, number>>(Object.fromEntries(bots.map((bot, i) => [bot.id, i])));
  const carried = useSharedValue("");
  const from = useSharedValue(-1);
  const to = useSharedValue(-1);
  const dx = useSharedValue(0);
  const lifted = useSharedValue(0);
  const restAway = useSharedValue(0);
  const dropping = useSharedValue(false);
  const grab = useSharedValue({ dx: 0, finger: 0 });
  // The row's size, read where a gesture may still hold the worklets of an earlier render.
  const size = useSharedValue({ count, width });
  // The row drifting under a face held near its end, and the hold over a jump of the row's scroll, in points.
  const shift = useSharedValue(0);
  // The slot of the bot on show, and where it stands while another is carried past it.
  const mine = useSharedValue(index);
  const stood = useSharedValue(index);
  useAnimatedReaction(
    () => (from.value === mine.value ? mine.value : slotAfterMove(mine.value, from.value, to.value)),
    (now, before) => {
      if (now === before) return;
      stood.value = before !== null && from.value >= 0 ? withTiming(now, { duration: ROW_DRAG.SETTLE_MS }) : now;
    },
  );
  const centre = useDerivedValue(() => (x.value + shift.value) / STRIP.slot + (stood.value - mine.value));
  const [dragging, setDragging] = useState(false);
  // A finger that carried a face must not also count as a tap or a hold on it.
  const moving = useRef(false);
  const unmoving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(unmoving.current), []);

  const onScroll = useAnimatedScrollHandler((event) => {
    x.value = event.contentOffset.x;
    // The row's scroll has caught up with a new order: the hold over the jump is let go in the same step.
    if (from.value < 0 && shift.value !== 0) shift.value = 0;
  });
  // The name and the dots follow the bot in the middle as the row moves.
  useAnimatedReaction(
    () => indexAt(x.value, count),
    (now, before) => {
      if (before !== null && now !== before) scheduleOnRN(setAt, now);
    },
  );

  // The order as the faces stand in it, and the bot on show's slot, handed over in one step. The
  // faces are already where a move left them, so nothing is seen to change; the row's own scroll
  // then goes to the bot on show, and `shift` holds the picture still until it has.
  const settle = (map: Record<string, number>, slotOfChosen: number) => {
    "worklet";
    slots.value = map;
    carried.value = "";
    from.value = -1;
    to.value = -1;
    dropping.value = false;
    lifted.value = 0;
    mine.value = slotOfChosen;
    stood.value = slotOfChosen;
    const target = offsetOf(slotOfChosen);
    shift.value = target - x.value;
    if (shift.value !== 0) scrollTo(scroller, target, 0, false);
  };
  const order = bots.map((bot) => bot.id).join("\n");
  const slotsOf = (ids: string) => Object.fromEntries(ids.split("\n").map((id, i) => [id, i]));
  const drawn = useRef(order + "\n\n" + index);
  useLayoutEffect(() => {
    size.value = { count, width };
    const now = order + "\n\n" + index;
    if (drawn.current === now) return;
    drawn.current = now;
    setAt(index);
    scheduleOnUI(settle, slotsOf(order), index);
  }, [order, index, count, width]);
  // A gesture may keep the worklets of an earlier render; what a drop does reads the latest of these when it runs.
  const latest = useRef({ onMove, order, index });
  useLayoutEffect(() => {
    latest.current = { onMove, order, index };
  });

  /** Where the carried face would land. Runs on the UI thread. */
  const track = () => {
    "worklet";
    const next = landingSlot(dx.value - x.value, from.value, mine.value, (x.value + shift.value) / STRIP.slot, size.value.count);
    if (next === to.value) return;
    to.value = next;
    scheduleOnRN(haptic.select);
  };
  // Near either end the row moves under the carried face, faster nearer the end, so any place can be reached.
  const drift = useFrameCallback(() => {
    "worklet";
    if (from.value < 0 || dropping.value) return;
    const speed = driftSpeed(dx.value - x.value, size.value.width);
    if (speed === 0) return;
    shift.value = Math.max(-x.value, Math.min(offsetOf(size.value.count - 1) - x.value, shift.value + speed));
    track();
  }, false);
  useEffect(() => () => drift.setActive(false), [drift]);
  const started = () => {
    haptic.tap();
    moving.current = true;
    clearTimeout(unmoving.current);
    clearTimeout(settleTimer.current);
    setDragging(true);
    drift.setActive(true);
    wake();
  };
  const dropped = (id: string, place: number) => {
    drift.setActive(false);
    setDragging(false);
    unmoving.current = setTimeout(() => (moving.current = false), 120);
    haptic.select();
    // No change, or one the computer can't be asked for: the faces go back as they were.
    const now = latest.current;
    if (!now.onMove?.(id, place)) scheduleOnUI(settle, slotsOf(now.order), now.index);
    rest();
  };
  const begin = (id: string, fingerX: number) => {
    "worklet";
    const home = slots.value[id];
    // The first bot is the primary one: it stays first.
    if (home === undefined || home <= 0 || carried.value || dropping.value) return;
    grab.value = { dx: placeOf(home, centre.value) + x.value, finger: fingerX };
    dx.value = grab.value.dx;
    restAway.value = home - centre.value;
    from.value = home;
    to.value = home;
    carried.value = id;
    lifted.value = withTiming(1, { duration: ROW_DRAG.SETTLE_MS });
    scheduleOnRN(started);
  };
  const move = (id: string, fingerX: number) => {
    "worklet";
    if (carried.value !== id || dropping.value) return;
    dx.value = grab.value.dx + fingerX - grab.value.finger;
    track();
  };
  const end = (id: string) => {
    "worklet";
    if (carried.value !== id || dropping.value) return;
    dropping.value = true;
    const place = to.value;
    // The row comes to rest on the bot on show: where it was, or where that bot was dropped.
    const own = from.value === mine.value;
    const middle = own ? place : centreFor(x.value / STRIP.slot, mine.value, from.value, place);
    shift.value = withTiming(own ? offsetOf(place) - x.value : 0, { duration: ROW_DRAG.SETTLE_MS });
    restAway.value = place - middle;
    lifted.value = withTiming(0, { duration: ROW_DRAG.SETTLE_MS });
    dx.value = withTiming(placeOf(place, middle) + x.value, { duration: ROW_DRAG.SETTLE_MS }, () => {
      "worklet";
      scheduleOnRN(dropped, id, place);
    });
  };
  const drag: RowDrag = { slots, centre, x, carried, from, to, dx, lifted, restAway, begin, move, end };
  const movable = !!onMove && count > 2;

  const pick = (to: number) => {
    if (moving.current || (to === index && to === at)) return;
    wake();
    setAt(to);
    scroller.current?.scrollTo({ x: offsetOf(to), animated: true });
    // The row says when it has stopped; this is for a row that never does.
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => commit(to), SETTLE_MS);
  };
  const landed = (offset: number) => {
    const to = indexAt(offset, bots.length);
    setAt(to);
    // Back on the bot that was on show: the tag's wait starts over. Another bot: its chat's bar starts it.
    if (bots[to]?.id === chosen) rest();
    commit(to);
  };
  const words = shown ? pillWords(shown) : undefined;

  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm }}>
        <View style={{ width: STRIP.side, alignItems: "flex-start" }}>
          <IconButton icon={LayoutList} label="All bots" variant="soft" size={STRIP.button} onPress={() => openPlace("home")} />
        </View>
        <View onLayout={(event) => onWidth(Math.round(event.nativeEvent.layout.width))} style={{ flex: 1, height: STRIP.face }}>
          {width > 0 && (
            <Animated.ScrollView
              ref={scroller}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              // Slot by slot: the row always rests with one bot in the middle.
              snapToInterval={STRIP.slot}
              decelerationRate="fast"
              contentOffset={{ x: offsetOf(index), y: 0 }}
              // Wide enough for every bot to reach the middle. The faces are placed in it by the row's own numbers (RowBot).
              contentContainerStyle={{ width: 2 * edgeRoom(width) + count * STRIP.slot, height: STRIP.face }}
              // A face is being carried: the row keeps still under the finger.
              scrollEnabled={!dragging}
              scrollEventThrottle={16}
              onScroll={onScroll}
              onScrollBeginDrag={() => {
                clearTimeout(settleTimer.current);
                wake();
              }}
              onScrollEndDrag={(event) => {
                if (!event.nativeEvent.velocity?.x) landed(event.nativeEvent.contentOffset.x);
              }}
              onMomentumScrollEnd={(event) => landed(event.nativeEvent.contentOffset.x)}
            >
              {bots.map((bot, i) => (
                <RowBot
                  key={bot.id}
                  bot={bot}
                  index={i}
                  drag={drag}
                  edge={edgeRoom(width)}
                  on={i === at}
                  unread={unread.has(bot.id)}
                  // The primary bot stays first.
                  movable={movable && i > 0}
                  onPick={() => pick(i)}
                  onPage={() => {
                    if (moving.current) return;
                    haptic.select();
                    page(bot.id);
                  }}
                  onStep={(by) => void onMove?.(bot.id, i + by)}
                />
              ))}
            </Animated.ScrollView>
          )}
        </View>
        <View style={{ width: STRIP.side, alignItems: "flex-end" }}>{menu}</View>
      </View>
      {/* The name of the bot on show, in the middle, tucked over the foot of its face. */}
      <Animated.View pointerEvents={keepTag ? "auto" : "none"} style={[{ minHeight: 32, marginTop: -STRIP.tuck, alignItems: "center", justifyContent: "center", paddingHorizontal: space.sm + STRIP.side }, tagStyle]}>
        {shown && words && (
          <Tap onPress={() => page(shown.id)} feel="select" sink={0.97} accessibilityLabel={words.name + (words.role ? ", " + words.role : "") + ", bot page"} style={{ maxWidth: "100%" }}>
            {/* Glass, like the app's other floating controls: the page shows through the bar, so the name stands on its own ground. */}
            <Glass style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill, overflow: "hidden" }}>
              <T variant="headline" numberOfLines={1} style={{ flexShrink: 0, maxWidth: "100%" }}>
                {words.name}
              </T>
              {!!words.role && (
                <T variant="subhead" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {words.role}
                </T>
              )}
            </Glass>
          </Tap>
        )}
      </Animated.View>
      {bots.length > 1 && bots.length <= STRIP.dots && (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", justifyContent: "center", gap: 6, paddingTop: space.sm, paddingBottom: 2 }}>
          {bots.map((bot, i) => (
            <View key={bot.id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === at ? colors.ink : colors.lineStrong }} />
          ))}
        </View>
      )}
    </View>
  );
}

/** The tab's frame while there is no chat to show yet: beside the side rail, under the status bar, with the row of bots on top. */
function Waiting({ strip, children }: { strip?: ReactNode; children: ReactNode }) {
  const { colors } = useTheme();
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
  const insets = useSafeAreaInsets();
  const shape = useShape();
  return (
    <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas, paddingLeft: shape.left, paddingRight: shape.right, paddingTop: insets.top + space.xs }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      {strip}
      <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
        <LinkBanner />
      </View>
      <View style={{ flex: 1, justifyContent: "center", paddingBottom: shape.tabRoom }}>{children}</View>
    </View>
  );
}

export default function BotHome() {
  const { colors } = useTheme();
  const shape = useShape();
  const synced = useApp((state) => state.synced);
  const bots = useBots();
  const chats = useChats();
  const canChat = useCan("agents", "chat");
  const online = useOnline();
  const main = useCapability("main-chat-v1");
  const person = useApp((state) => (state.parts.meta?.you?.kind === "member" ? state.parts.meta.you.memberId : "owner"));
  const saved = usePrefs((prefs) => prefs.homeBot);
  // A bot moved in the row shows in its new place at once, while the computer is asked for it.
  const held = useHeldOrder(bots);
  const canArrange = useCanArrange();
  const shown = useMemo(() => homeBots(held.shown), [held.shown]);
  const unread = useMemo(() => unreadBotIds(chats), [chats]);
  const bot = pickHomeBot(shown, saved);
  const botId = bot?.id;
  const want = botId && canChat ? homeChat(chats, botId, main, person) : undefined;
  const chatId = want && "id" in want ? want.id : undefined;
  const make = want && "make" in want ? want.make : undefined;

  // A Main chat that isn't there yet is the computer's to make, once for each bot; it arrives by itself.
  const asked = useRef(new Set<string>());
  const [failed, setFailed] = useState<string | null>(null);
  // The row's width outlives the chat under it: a chat's bar is drawn again for each bot.
  const [rowWidth, setRowWidth] = useState(0);
  useEffect(() => {
    if (!botId || make !== "main" || !online || asked.current.has(botId)) return;
    asked.current.add(botId);
    api.mainChat(botId).catch(() => {
      asked.current.delete(botId);
      setFailed(botId);
    });
  }, [botId, make, online]);

  if (!synced)
    return (
      <Waiting>
        <Loading />
      </Waiting>
    );
  // No bots yet, or a role that may not chat: Home has the first steps and the bots' pages.
  if (!bot || !canChat) return <Home />;

  const move = (id: string, to: number) => {
    const plan = rowPlan(held.shown, id, to);
    if (plan) held.carry(id, plan);
    return !!plan;
  };
  const row = (parts?: { menu: ReactNode }) => (
    <BotRow bots={shown} chosen={bot.id} unread={unread} onPick={(id) => setPrefs({ homeBot: id })} width={rowWidth} onWidth={setRowWidth} menu={parts?.menu} onMove={canArrange && online ? move : undefined} />
  );
  const strip = row();
  if (chatId)
    return (
      <View style={{ flex: 1, paddingLeft: shape.left, paddingRight: shape.right, backgroundColor: colors.canvas }}>
        <ChatPane id={chatId} onLeave={stay} bar={row} onOpen={openChat} />
      </View>
    );
  if (make === "ask")
    return (
      <Waiting strip={strip}>
        <EmptyState art={<BotAvatar bot={bot} size={96} />} title={bot.name} text="No chat yet." action="Start a chat" onAction={() => void attempt(api.createChat(bot.id))} />
      </Waiting>
    );
  if (failed === bot.id)
    return (
      <Waiting strip={strip}>
        <EmptyState
          art={<BotAvatar bot={bot} size={96} />}
          title={bot.name}
          text="Couldn't open this chat."
          action="Try again"
          onAction={() => {
            setFailed(null);
            asked.current.delete(bot.id);
            void attempt(api.mainChat(bot.id));
          }}
        />
      </Waiting>
    );
  return (
    <Waiting strip={strip}>
      <Loading />
    </Waiting>
  );
}
