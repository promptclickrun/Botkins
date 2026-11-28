// The first tab, where the app opens: the chat with the person's bot. It starts on the primary bot
// (the first in the computer's order) and stays with the one last chosen here (`prefs.homeBot`).
// The top of the tab is the row of bots: the one on show large in the middle with its name and
// what it is for under it, the others small beside it. A tap on another bot, or a swipe of the row,
// brings that bot to the middle and its chat below. The row's first button opens Home, the board of
// all bots; its last is the chat's own menu. The chat is the bot's Main chat where the computer
// keeps one for each bot and person, otherwise its latest chat. A computer with no bots yet, or a
// person who may not chat, gets Home here. The plain logic is homeBot.ts and strip.ts.
import { router } from "expo-router";
import { LayoutList } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import Animated, { type SharedValue, useAnimatedReaction, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { openPlace } from "@/features/all/open";
import { ChatPane } from "@/features/chat/ChatScreen";
import { openChat } from "@/features/chat/navigate";
import { unreadBotIds } from "@/features/chat/unread";
import type { Bot } from "@/link/types";
import { activityLabel, useBotActivity, useBots, useCan, useCapability, useChats, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { setPrefs, usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { BackdropLayer, BotAvatar, Dot, EmptyState, Glass, IconButton, LinkBanner, Loading, radius, space, T, Tap, useShape, useTheme } from "@/ui";
import Home from "./Home";
import { homeBots, homeChat, pickHomeBot } from "./homeBot";
import { edgeRoom, faceScale, faceShown, indexAt, offsetOf, pillWords, pushOf, slotsAway, STRIP } from "./strip";

const stay = () => {};
/** How long a tapped bot takes to reach the middle before its chat opens, if the row doesn't say it has stopped. */
const SETTLE_MS = 280;

/**
 * One bot in the row. Every face is drawn at the large size and scaled, and placed by how far its
 * slot is from the middle as the row scrolls: the one in the middle is large and whole, the ones
 * beside it stand aside, small and dimmed. Only the bot on show moves (it is the agent the person
 * is with); the others hold still, with a dot when they have something unread.
 */
function RowBot({ bot, index, x, on, unread, onPick }: { bot: Bot; index: number; /** The row's scroll offset. */ x: SharedValue<number>; on: boolean; unread: boolean; onPick: () => void }) {
  const state = useBotActivity(bot.id);
  const status = activityLabel(state);
  const place = useAnimatedStyle(() => ({ transform: [{ translateX: pushOf(slotsAway(index, x.value)) }] }));
  const face = useAnimatedStyle(() => {
    const away = slotsAway(index, x.value);
    return { opacity: faceShown(away), transform: [{ scale: faceScale(away) }] };
  });
  return (
    <Animated.View style={[{ width: STRIP.slot, height: STRIP.face }, place]}>
      <Tap
        onPress={onPick}
        feel="select"
        hitSlop={0}
        accessibilityLabel={bot.name + (status ? ", " + status : "") + (unread && !on ? ", unread" : "")}
        accessibilityHint={on ? "Opens this bot's page" : "Shows the chat with this bot"}
        accessibilityState={{ selected: on }}
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
};

/** The row of bots, the name of the one on show, and where it is among the others. */
function BotRow({ bots, chosen, unread, onPick, width, onWidth, menu }: BotRowProps) {
  const { colors } = useTheme();
  const index = Math.max(0, bots.findIndex((bot) => bot.id === chosen));
  // The bot in the middle. It runs ahead of `chosen` while a tapped bot slides in or the row is swiped.
  const [at, setAt] = useState(index);
  const scroller = useAnimatedRef<Animated.ScrollView>();
  // Where the row is scrolled to. Every face is sized and placed from it, on the UI thread.
  const x = useSharedValue(offsetOf(index));
  const count = bots.length;
  const onScroll = useAnimatedScrollHandler((event) => {
    x.value = event.contentOffset.x;
  });
  // The name and the dots follow the bot in the middle as the row moves.
  useAnimatedReaction(
    () => indexAt(x.value, count),
    (now, before) => {
      if (before !== null && now !== before) scheduleOnRN(setAt, now);
    },
  );
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(settle.current), []);
  const shown = bots[at] ?? bots[index];

  // The bot in the middle becomes the one on show: its chat opens below.
  const commit = (to: number) => {
    clearTimeout(settle.current);
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

  const pick = (to: number) => {
    // The bot on show is tapped again: its page, as from its name tag (which may be off).
    if (to === index && to === at) return page(bots[to].id);
    wake();
    setAt(to);
    scroller.current?.scrollTo({ x: offsetOf(to), animated: true });
    // The row says when it has stopped; this is for a row that never does.
    clearTimeout(settle.current);
    settle.current = setTimeout(() => commit(to), SETTLE_MS);
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
              contentContainerStyle={{ paddingHorizontal: edgeRoom(width), alignItems: "center" }}
              scrollEventThrottle={16}
              onScroll={onScroll}
              onScrollBeginDrag={() => {
                clearTimeout(settle.current);
                wake();
              }}
              onScrollEndDrag={(event) => {
                if (!event.nativeEvent.velocity?.x) landed(event.nativeEvent.contentOffset.x);
              }}
              onMomentumScrollEnd={(event) => landed(event.nativeEvent.contentOffset.x)}
            >
              {bots.map((bot, i) => (
                <RowBot key={bot.id} bot={bot} index={i} x={x} on={i === at} unread={unread.has(bot.id)} onPick={() => pick(i)} />
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
  const shown = useMemo(() => homeBots(bots), [bots]);
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

  const row = (parts?: { menu: ReactNode }) => (
    <BotRow bots={shown} chosen={bot.id} unread={unread} onPick={(id) => setPrefs({ homeBot: id })} width={rowWidth} onWidth={setRowWidth} menu={parts?.menu} />
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
