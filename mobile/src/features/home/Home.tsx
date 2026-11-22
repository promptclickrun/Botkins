// Home: the computer it talks to, the pinned bots up top as big avatars, then every other bot as a
// flat list: the primary bot, each section, then the rest. A pinned bot shows only up top, never in
// the list too. Filters show pinned or hidden bots. Under "All" a bot can be dragged to another place
// or group (BotBoard.tsx), into Pinned to pin it; a still hold opens its menu.
import { type Href, router, useScrollToTop } from "expo-router";
import { ChevronDown, ChevronUp, Plus, Settings, Sunrise } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { openBotChat } from "@/features/chat/open";
import { useSpacesOn } from "@/features/spaces/data";
import { HomePins } from "@/features/spaces/HomePins";
import { makeSeenSignal, TodayContent } from "@/features/today/Today";
import { addable } from "@/features/bots/agents";
import type { AgentRequest, Bot, ChatSummary } from "@/link/types";
import { activityLabel, isConversation, useBotActivity, useBots, useCan, useIsPrimaryBot, useChats, usePart, useCanArrange } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { setPrefs, usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { badgeColors, BotAvatar, Button, Chip, Dot, EmptyState, Group, HoldMenu, IconButton, IconTile, LinkBanner, Mascot, Row, space, T, Tap, useShape, useTheme } from "@/ui";
import { computerActions } from "@/state/computers";
import { arrangeBots, type BotFilter, filterBots, filterLabels, todayRow } from "./arrange";
import { AVATAR, BotBoard, type BoardScroll, BotMenu, BotRow } from "./BotBoard";
import { runComputerChoice } from "./computers";
import { applyPlan, DRAG, dropPlan, type Zone } from "./drag";

/** The big avatars at the top: every pinned bot, four to a row, and bigger when there are three or fewer. */
const TOP = { perRow: 4, width: "25%", size: 80, fewSize: 96 } as const;

/** A big bare avatar with its name under it, for the row at the top. */
function TopBot({ bot, size, width }: { bot: Bot; size: number; width?: `${number}%` }) {
  const state = useBotActivity(bot.id);
  const status = activityLabel(state);
  const canChat = useCan("agents", "chat");
  // Only the primary bot moves on Home (battery); the others hold their state's pose.
  const primary = useIsPrimaryBot(bot.id);
  return (
    <View style={width ? { width, alignItems: "center" } : { flex: 1, alignItems: "center" }}>
      <BotMenu bot={bot}>
        <Tap onPress={() => canChat ? void openBotChat(bot.id) : router.push({ pathname: "/bot/[id]", params: { id: bot.id } })} sink={0.94} accessibilityLabel={bot.name + (status ? ", " + status : "")} style={{ alignItems: "center", gap: 6, paddingHorizontal: space.xs }}>
          <BotAvatar bot={bot} state={state} size={size} animated={primary} />
          <T variant="footnote" weight="600" color="ink2" numberOfLines={1} center>
            {bot.name}
          </T>
        </Tap>
      </BotMenu>
    </View>
  );
}

function NeedsYou({ request, bot }: { request: AgentRequest; bot?: Bot }) {
  return (
    <Row
      leading={bot ? <BotAvatar bot={bot} state="waiting" size={40} /> : undefined}
      title={request.title}
      subtitle={(bot?.name ?? "A bot") + " needs you"}
      trailing={<Dot tone="warning" />}
      chevron
      onPress={() => router.push({ pathname: "/chat/[id]", params: { id: request.chatId } })}
    />
  );
}

/** Gray rows while the first state is on its way. */
function Placeholder() {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space.xl, paddingTop: space.sm }} accessibilityLabel="Loading">
      {[0, 1, 2, 3].map((index) => (
        <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <View style={{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: colors.sunken }} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ width: "40%", height: 12, borderRadius: 6, backgroundColor: colors.sunken }} />
            <View style={{ width: "75%", height: 10, borderRadius: 5, backgroundColor: colors.sunken }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A computer with no bots yet. When the person already has agents in a provider's own tool, bringing
 * them in comes first, as in the app on the computer; otherwise, or if they prefer, a new bot.
 */
function FirstBot() {
  const online = useApp((state) => state.link === "online");
  const canCreate = useCan("agents", "create");
  const [found, setFound] = useState(0);
  useEffect(() => {
    if (!online || !canCreate) return;
    let live = true;
    api.importableAgents().then(
      (list) => live && setFound(addable(list).length),
      () => live && setFound(0),
    );
    return () => {
      live = false;
    };
  }, [online, canCreate]);
  if (!canCreate) return <EmptyState art={<Mascot size={104} state="waiting" />} title="No bots are available yet" text="Your team role doesn't give you a bot to use." />;
  if (!found) return <EmptyState art={<Mascot size={104} state="completed" />} title="Make your first bot" action="Create a bot" onAction={() => router.push("/bot/new")} />;
  return (
    <View>
      <EmptyState
        art={<Mascot size={104} state="completed" />}
        title="Bring in your agents"
        text={found === 1 ? "Botkins found an agent you already use." : "Botkins found " + found + " agents you already use."}
        action="Choose agents"
        onAction={() => router.push("/bot/agents" as Href)}
        style={{ paddingBottom: space.sm }}
      />
      <Button title="Create a new bot instead" variant="ghost" onPress={() => router.push("/bot/new")} style={{ alignSelf: "center" }} />
    </View>
  );
}

/** Settings, which is no tab: a button at the end of Home's top row. It carries the count of people asking to join the team. */
function SettingsButton() {
  const theme = useTheme();
  const badge = badgeColors(theme);
  const asking = useApp((state) => {
    const team = state.parts.team;
    return state.parts.meta?.you?.kind !== "member" && team && "requests" in team ? team.requests.length : 0;
  });
  return (
    <View>
      <IconButton icon={Settings} label={asking > 0 ? "Settings, " + asking + (asking === 1 ? " request" : " requests") : "Settings"} variant="soft" size={44} onPress={() => router.push("/settings")} />
      {asking > 0 && (
        <View pointerEvents="none" style={{ position: "absolute", top: -3, right: -3, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: badge.background }}>
          <T variant="caption" color={badge.text} maxFontSizeMultiplier={1}>
            {String(asking)}
          </T>
        </View>
      )}
    </View>
  );
}

/**
 * Page's frame for a tab's root, with a scroll view Home can scroll itself: a dragged bot near the
 * top or bottom edge scrolls the page (Page has no handle on its scroll view). Keep it like Page's.
 */
function HomeFrame({ children, scroll, scrollEnabled, onScrolled }: { children: ReactNode; scroll: BoardScroll; scrollEnabled: boolean; onScrolled: () => void }) {
  useScrollToTop(scroll.ref);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // Beside the side rail on iPhone Duo, and with no room for a tab bar that is in the rail.
  const shape = useShape();
  const { height } = useWindowDimensions();
  const view = useSharedValue(0);
  const content = useSharedValue(0);
  const told = useSharedValue(0);
  const { edges, offset, max } = scroll;
  useEffect(() => {
    edges.value = { top: insets.top, bottom: height - shape.tabRoom - insets.bottom };
  }, [edges, insets.top, insets.bottom, height, shape.tabRoom]);
  // The offset on the UI thread for the drag; Today hears of a scroll a few times a second at most.
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.value = event.contentOffset.y;
      const now = Date.now();
      if (now - told.value < 200) return;
      told.value = now;
      scheduleOnRN(onScrolled);
    },
    onMomentumEnd: () => scheduleOnRN(onScrolled),
  });
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Animated.ScrollView
        ref={scroll.ref}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingLeft: space.xl + shape.left, paddingRight: space.xl + shape.right, paddingTop: insets.top + space.md, paddingBottom: shape.tabRoom + insets.bottom + space.xxl, gap: space.xl }}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
        scrollEnabled={scrollEnabled}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={(event) => {
          view.value = event.nativeEvent.layout.height;
          max.value = Math.max(0, content.value - view.value);
        }}
        onContentSizeChange={(_, h) => {
          content.value = h;
          max.value = Math.max(0, content.value - view.value);
        }}
      >
        <LinkBanner />
        {children}
      </Animated.ScrollView>
    </View>
  );
}

/**
 * A drop's new order, shown at once until the computer's own state arrives: while its calls are out,
 * then until the bots change once more after they finish (or DRAG.HOLD_ORDER_MS). A failed call shows
 * its toast and the computer's order comes back.
 */
function useDropOrder(bots: Bot[]) {
  const sections = usePart("sections");
  const [pending, setPending] = useState<{ bots: Bot[]; done?: Bot[] } | null>(null);
  const stale = !!pending?.done && pending.done !== bots;
  useEffect(() => {
    if (stale) setPending(null);
  }, [stale]);
  useEffect(() => {
    if (!pending?.done) return;
    const timer = setTimeout(() => setPending(null), DRAG.HOLD_ORDER_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  const drop = (id: string, zone: Zone, index: number) => {
    const plan = dropPlan(bots, sections, id, zone, index);
    if (!plan) return;
    const shown = applyPlan(bots, id, plan);
    setPending({ bots: shown });
    void (async () => {
      let ok = true;
      if (plan.flags) ok = !!(await attempt(api.setBotFlags(id, plan.flags).then(() => true)));
      if (ok && plan.order) ok = !!(await attempt(api.reorderBots(plan.order).then(() => true)));
      // Kept until the bots change after this, so the list doesn't flick back to the old order first.
      setPending((now) => (now?.bots === shown ? (ok ? { bots: shown, done: useApp.getState().parts.bots ?? [] } : null) : now));
    })();
  };
  return { shown: pending && !stale ? pending.bots : bots, drop };
}

export default function Home() {
  const { colors } = useTheme();
  // The computer's bots, or a drop's new order while the computer catches up.
  const order = useDropOrder(useBots());
  const bots = order.shown;
  const chats = useChats();
  const synced = useApp((state) => state.synced);
  const online = useApp((state) => state.link === "online");
  const computer = useApp((state) => state.pairing?.name) ?? "Computer";
  const adminOn = useApp((state) => state.parts.meta?.you?.kind === "owner" && state.parts.meta.you.admin === true);
  const computers = useApp((state) => state.pairings);
  const inUse = useApp((state) => state.pairing?.serverId);
  const requests = useApp((state) => state.parts.live?.requests);
  const board = usePart("board");
  const panels = usePart("panels");
  const canCreate = useCan("agents", "create");
  const canArrange = useCanArrange();
  const canSeeToday = useCan("today", "view");

  const shown = useMemo(() => bots.filter((bot) => !bot.hidden).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)), [bots]);
  // Every pinned bot sits up top (the list below leaves them out); with none pinned, the first three.
  const top = useMemo(() => {
    const pinned = shown.filter((bot) => bot.pinned);
    return pinned.length > 0 ? pinned : shown.slice(0, 3);
  }, [shown]);
  const full = top.length >= TOP.perRow;
  // Each bot's latest one-to-one chat, and whether any of its chats is unread.
  const latest = useMemo(() => {
    const out = new Map<string, { chat?: ChatSummary; unread: boolean }>();
    for (const chat of chats) {
      if (chat.botIds || !isConversation(chat)) continue;
      const entry = out.get(chat.botId) ?? { unread: false };
      if (!entry.chat || chat.time > entry.chat.time) entry.chat = chat;
      if (chat.unread) entry.unread = true;
      out.set(chat.botId, entry);
    }
    return out;
  }, [chats]);
  // The list: in the computer's order, or one filter's bots. Sections fold while the app is open.
  const sections = usePart("sections");
  const arranged = useMemo(() => arrangeBots(bots, sections), [bots, sections]);
  const [filter, setFilter] = useState<BotFilter>("All");
  const filtered = useMemo(() => filterBots(bots, filter), [bots, filter]);
  const [folded, setFolded] = useState<string[]>([]);
  const showFilters = bots.length > 3 || arranged.hidden.length > 0 || filter !== "All";
  const rows = (list: Bot[]) => (
    <Group flat inset={space.lg + AVATAR + space.md}>
      {list.map((bot) => {
        const entry = latest.get(bot.id);
        return <BotRow key={bot.id} bot={bot} chat={entry?.chat} unread={!!entry?.unread} />;
      })}
    </Group>
  );
  // The page, for scrolling it under a dragged bot; and whether a drag is under way, which stops its own scrolling.
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: 0, bottom: 0 }) };
  const [dragging, setDragging] = useState(false);
  const today = (board?.filter((item) => item.status === "open").length ?? 0) + (panels?.filter((panel) => !panel.hidden).length ?? 0);
  // Today sits open under the bots until the person folds it; the choice is kept.
  const todayOpen = usePrefs((prefs) => prefs.todayOpen);
  const spacesOn = useSpacesOn();
  const [seen] = useState(makeSeenSignal);
  const Fold = todayOpen ? ChevronUp : ChevronDown;
  const waiting = requests ?? [];

  return (
    <HomeFrame scroll={scroll} scrollEnabled={!dragging} onScrolled={seen.scrolled}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
        {/* A tap opens the computer's page; a hold opens the switcher. */}
        <HoldMenu title="Computers" actions={computerActions(computers, inUse)} onPressAction={({ nativeEvent }) => runComputerChoice(nativeEvent.event)} style={{ flexShrink: 1 }}>
          <Tap
            onPress={() => router.push("/settings/desktop")}
            feel="select"
            accessibilityLabel={computer + (online ? ", connected" : ", not connected") + (adminOn ? ", Admin mode" : "")}
            accessibilityHint="Hold to switch computers"
            style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 7, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.surface }}
          >
            <Dot tone={online ? "success" : "warning"} size={7} />
            <T variant="footnote" weight="600" color="ink2" numberOfLines={1}>
              {computer}
            </T>
            {/* While Admin mode is on, the lists hold every member's things: the tag says so. */}
            {adminOn && (
              <T variant="caption" weight="600" color="accentText" numberOfLines={1}>
                Admin mode
              </T>
            )}
          </Tap>
        </HoldMenu>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {canCreate && <IconButton icon={Plus} label="New bot" variant="soft" size={44} onPress={() => router.push("/bot/new")} />}
          <SettingsButton />
        </View>
      </View>

      {waiting.length > 0 && (
        <Group flat inset={space.lg + 40 + space.md}>
          {waiting.slice(0, 3).map((request) => (
            <NeedsYou key={request.id} request={request} bot={bots.find((bot) => bot.id === request.botId)} />
          ))}
        </Group>
      )}

      {!synced ? (
        <Placeholder />
      ) : bots.length === 0 ? (
        <FirstBot />
      ) : shown.length === 0 ? (
        <EmptyState art={<Mascot size={104} state="completed" />} title={canCreate ? "Make your first bot" : "No bots are available yet"} action={canCreate ? "Create a bot" : undefined} onAction={canCreate ? () => router.push("/bot/new") : undefined} />
      ) : (
        <Animated.View entering={FadeIn.duration(240)} style={{ gap: space.lg }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: full ? "center" : "space-evenly", rowGap: space.lg }}>
            {top.map((bot) => (
              <TopBot key={bot.id} bot={bot} size={full ? TOP.size : TOP.fewSize} width={full ? TOP.width : undefined} />
            ))}
          </View>
          {showFilters && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
              {filterLabels(bots).map((option) => (
                <Chip key={option.value} label={option.label} selected={filter === option.value} onPress={() => setFilter(option.value)} />
              ))}
            </ScrollView>
          )}
          {filter !== "All" ? (
            filtered.length > 0 ? (
              rows(filtered)
            ) : (
              <T variant="subhead" color="muted" center>
                {filter === "Hidden" ? "No hidden bots." : "No pinned bots."}
              </T>
            )
          ) : (
            <BotBoard
              bots={bots}
              sections={sections}
              latest={latest}
              folded={folded}
              onFold={(id) => setFolded(folded.includes(id) ? folded.filter((entry) => entry !== id) : [...folded, id])}
              scroll={scroll}
              onDrop={order.drop}
              onDragging={setDragging}
              manageable={canArrange}
            />
          )}
          {/* A computer with spaces shows what the person pinned here, where Today sat; one without keeps Today. */}
          {canSeeToday && spacesOn && <HomePins />}
          {/* Today is always under the bots, even with nothing open: it has its own empty states. */}
          {canSeeToday && !spacesOn && (
            <View style={{ gap: space.lg }}>
              <Group flat>
                <Row
                  leading={<IconTile icon={Sunrise} />}
                  title="Today"
                  value={todayRow(todayOpen, today).value}
                  trailing={<Fold size={18} color={colors.faint} strokeWidth={2.2} />}
                  onPress={() => setPrefs({ todayOpen: !todayOpen })}
                />
              </Group>
              {todayOpen && <TodayContent seen={seen} />}
            </View>
          )}
        </Animated.View>
      )}
    </HomeFrame>
  );
}
