// Home: the computer it talks to, what needs the person (an ordinary approval answered right here),
// the pinned bots up top as big avatars with what each is doing, then every other bot as a flat list:
// the primary bot, each section, then the rest. A pinned bot shows only up top, never in the list too.
// The list's one menu ("Edit") shows pinned or hidden bots. Under "All" a bot can be dragged to
// another place or group (BotBoard.tsx), into Pinned to pin it; a still hold opens its menu.
import { type Href, router, useScrollToTop } from "expo-router";
import { MenuView } from "@react-native-menu/menu";
import { ChevronDown, ChevronUp, Plus, Settings, Sunrise } from "lucide-react-native";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { openChat } from "@/features/chat/navigate";
import { openBotChat } from "@/features/chat/open";
import { looksDangerous } from "@/features/chat/request/logic";
import { isUnreadChat } from "@/features/chat/unread";
import { useSpacesOn } from "@/features/spaces/data";
import { HomePins } from "@/features/spaces/HomePins";
import { makeSeenSignal, TodayContent } from "@/features/today/Today";
import { addable } from "@/features/bots/agents";
import { STARTERS } from "../../../link-host/starters.mjs";
import type { AgentRequest, Bot, ChatSummary } from "@/link/types";
import { activityLabel, isConversation, useBotActivity, useBots, useCan, useChats, usePart, useCanArrange } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { setPrefs, usePrefs } from "@/state/prefs";
import { isNodeJobRequest, routeForPendingRequest } from "@/state/pushRouting";
import { useApp } from "@/state/store";
import { useProfileHosts } from "@/state/profile";
import { BackdropLayer, badgeColors, BotAvatar, Button, Dot, EmptyState, Group, HoldMenu, IconButton, IconTile, Label, LinkBanner, Loading, Mascot, Row, space, T, Tap, useFrozenWhenHidden, useShape, useTheme } from "@/ui";
import { computerActions } from "@/state/computers";
import { answerInline, arrangeBots, type BotFilter, filterBots, filterLabels, todayRow } from "./arrange";
import { AVATAR, BotBoard, type BoardScroll, BotMenu, BotRow } from "./BotBoard";
import { runComputerChoice } from "./computers";
import { applyPlan, DRAG, dropPlan, type Zone } from "./drag";
import { ServerLinkStatus } from "./ServerLinkStatus";

/** The big avatars at the top: every pinned bot, four to a row, and bigger when there are three or fewer. */
const TOP = { perRow: 4, width: "25%", size: 80, fewSize: 96 } as const;

/** A big bare avatar with its name under it, for the row at the top. */
function TopBot({ bot, size, width }: { bot: Bot; size: number; width?: `${number}%` }) {
  const state = useBotActivity(bot.id);
  const unified = useApp((s) => s.unified);
  const status = activityLabel(state);
  const canChat = useCan("agents", "chat");
  return (
    <View style={width ? { width, alignItems: "center" } : { flex: 1, alignItems: "center" }}>
      <BotMenu bot={bot}>
        <Tap onPress={() => canChat ? void openBotChat(bot.id) : router.push({ pathname: "/bot/[id]", params: { id: bot.id } })} sink={0.94} accessibilityLabel={bot.name + (unified && bot.hostName ? " on " + bot.hostName : "") + (status ? ", " + status : "")} style={{ alignItems: "center", gap: 4, paddingHorizontal: space.xs }}>
          {/* Home holds still: the agent you're with moves, on its page and in its chat. */}
          <BotAvatar bot={bot} state={state} size={size} />
          <T variant="footnote" weight="600" color="ink2" numberOfLines={1} center>
            {bot.name}
          </T>
          {unified && !!bot.hostName && (
            <T variant="caption" color="muted" numberOfLines={1} center>
              {bot.hostName}
            </T>
          )}
          {/* What it is doing, in words beside the still avatar: Home holds still (see "Where avatars move"). */}
          {!!status && (
            <T variant="caption" color={state === "waiting" ? "warning" : "muted"} numberOfLines={1} center style={{ marginTop: -4 }}>
              {status}
            </T>
          )}
        </Tap>
      </BotMenu>
    </View>
  );
}

function NeedsYou({ request, bot }: { request: AgentRequest; bot?: Bot }) {
  const unified = useApp((s) => s.unified);
  const host = unified ? request.hostName || bot?.hostName : undefined;
  const isNode = isNodeJobRequest(request);
  const [busy, setBusy] = useState<"deny" | "approve" | null>(null);
  // An ordinary approval is answered right here, as on a notification; anything risky, a script to
  // read, a node job, a question or a form opens where it can be read whole.
  const inline = !isNode && answerInline(request, looksDangerous(request));
  const answer = async (action: "deny" | "approve") => {
    if (busy) return;
    setBusy(action);
    await attempt(api.respond(request.id, { action }));
    setBusy(null);
  };
  const subtitle = isNode
    ? (request.sourceBotName && request.sourceHostName
        ? `${request.sourceBotName} on ${request.sourceHostName}`
        : request.sourceBotName || "Node host") + " needs approval"
    : (bot?.name ?? "A bot") + (host ? " · " + host : "") + " needs you";
  return (
    <Row
      leading={bot ? <BotAvatar bot={bot} state="waiting" size={40} /> : undefined}
      title={request.title}
      subtitle={subtitle}
      trailing={
        inline ? (
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="Deny" variant="secondary" size="sm" loading={busy === "deny"} disabled={!!busy} onPress={() => void answer("deny")} accessibilityLabel={"Deny " + request.title} />
            <Button title="Allow" size="sm" loading={busy === "approve"} disabled={!!busy} onPress={() => void answer("approve")} accessibilityLabel={"Allow " + request.title} />
          </View>
        ) : (
          <Dot tone="warning" />
        )
      }
      chevron={!inline}
      onPress={() => {
        const target = routeForPendingRequest(request);
        if (typeof target === "object" && target.pathname === "/chat/[id]") openChat(target.params.id);
        else router.push(target as unknown as Href);
      }}
    />
  );
}

function Placeholder() {
  return <Loading />;
}

/**
 * A computer with no bots yet. When the person already has agents in a provider's own tool, bringing
 * them in comes first, as in the app on the computer; otherwise the three starters
 * (link-host/starters.mjs), each opening New bot filled in, or a bot of the person's own.
 */
export function FirstBot() {
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
  if (!found) return <Starters />;
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

/** The three starters: one opens New bot filled in, and the person changes what they like there. */
function Starters() {
  return (
    <View>
      <EmptyState art={<Mascot size={104} state="completed" />} title="Make your first bot" text="Start with one of these, or make your own." style={{ paddingBottom: space.sm }} />
      <Group flat inset={space.lg + 40 + space.md}>
        {STARTERS.map((starter) => (
          <Row
            key={starter.id}
            title={starter.name}
            subtitle={starter.summary}
            subtitleLines={2}
            chevron
            leading={<BotAvatar look={{ ...starter.look }} size={40} badge={false} />}
            onPress={() => router.push({ pathname: "/bot/new", params: { starter: starter.id } })}
          />
        ))}
      </Group>
      <Button title="Make your own" variant="ghost" onPress={() => router.push("/bot/new")} style={{ alignSelf: "center" }} />
    </View>
  );
}

/** Settings, which is no tab: a button at the end of Home's top row. It carries the count of people asking to join the team. */
export function SettingsButton() {
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
function HomeFrame({ children, scroll, scrollEnabled, onScrolled, quietLink }: { children: ReactNode; scroll: BoardScroll; scrollEnabled: boolean; onScrolled: () => void; /** The status beside the computer pill says the link is down, so only a revoked link keeps the banner. */ quietLink?: boolean }) {
  useScrollToTop(scroll.ref);
  const { colors } = useTheme();
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
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
    <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      <Animated.ScrollView
        ref={scroll.ref}
        style={{ flex: 1, backgroundColor: "transparent" }}
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
        {!quietLink && <LinkBanner />}
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

const HomeBody = memo(function HomeBody({
  bots,
  chats,
  synced,
  requests,
  board,
  panels,
  sections,
  onDrop,
  scroll,
  setDragging,
  seen,
}: {
  bots: Bot[];
  chats: ChatSummary[];
  synced: boolean;
  requests: AgentRequest[] | undefined;
  board: ReturnType<typeof usePart<"board">>;
  panels: ReturnType<typeof usePart<"panels">>;
  sections: ReturnType<typeof usePart<"sections">>;
  onDrop: (id: string, zone: Zone, index: number) => void;
  scroll: BoardScroll;
  setDragging: (on: boolean) => void;
  seen: ReturnType<typeof makeSeenSignal>;
}) {
  const { colors } = useTheme();
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
  // Each bot's latest one-to-one chat for preview, and whether any of its chats lights its unread dot.
  const latest = useMemo(() => {
    const out = new Map<string, { chat?: ChatSummary; unread: boolean }>();
    for (const chat of chats) {
      const unread = isUnreadChat(chat);
      const oneToOne = !chat.botIds && isConversation(chat);
      if (!unread && !oneToOne) continue;
      const entry = out.get(chat.botId) ?? { unread: false };
      if (oneToOne && (!entry.chat || chat.time > entry.chat.time)) entry.chat = chat;
      if (unread) entry.unread = true;
      out.set(chat.botId, entry);
    }
    return out;
  }, [chats]);
  // The list: in the computer's order, or one filter's bots. Sections fold while the app is open.
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
  const today = (board?.filter((item) => item.status === "open").length ?? 0) + (panels?.filter((panel) => !panel.hidden).length ?? 0);
  // Today sits open under the bots until the person folds it; the choice is kept.
  const todayOpen = usePrefs((prefs) => prefs.todayOpen);
  const spacesOn = useSpacesOn();
  const Fold = todayOpen ? ChevronUp : ChevronDown;
  const waiting = requests ?? [];

  return (
    <>
      {waiting.length > 0 && (
        <View>
          <Label>{"Needs you · " + waiting.length}</Label>
          <Group inset={space.lg + 40 + space.md}>
            {waiting.slice(0, 3).map((request) => (
              <NeedsYou key={request.id} request={request} bot={bots.find((bot) => bot.id === request.botId)} />
            ))}
          </Group>
        </View>
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
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: -space.sm }}>
              <Label style={{ marginBottom: 0 }}>{filter === "All" ? "Bots" : filter + " bots"}</Label>
              <MenuView
                title="Show"
                actions={filterLabels(bots).map((option) => ({ id: option.value, title: option.value === "All" ? "All bots" : option.label, state: filter === option.value ? ("on" as const) : ("off" as const) }))}
                onPressAction={({ nativeEvent }) => setFilter(nativeEvent.event as BotFilter)}
              >
                <View accessible accessibilityRole="button" accessibilityLabel={"Edit, showing " + (filter === "All" ? "all bots" : filter.toLowerCase() + " bots")} style={{ minWidth: 44, height: 44, alignItems: "flex-end", justifyContent: "center" }}>
                  <T variant="subhead" weight="600" color="ink2">
                    Edit
                  </T>
                </View>
              </MenuView>
            </View>
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
              onDrop={onDrop}
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
    </>
  );
});

export default function Home() {
  const { colors } = useTheme();
  // The computer's bots, or a drop's new order while the computer catches up.
  const order = useDropOrder(useBots());
  const rawChats = useChats();
  const rawSynced = useApp((state) => state.synced);
  const link = useApp((state) => state.link);
  const online = link === "online";
  const unified = useApp((state) => state.unified);
  const unifiedHosts = useApp((state) => state.unifiedHosts);
  const includedHosts = unifiedHosts.filter((h) => h.included);
  const onlineHosts = includedHosts.filter((h) => h.state === "online").length;
  // Every hook runs on every render: a hook inside the ternary crashed the app when unified view was turned off.
  const pairingName = useApp((state) => state.pairing?.name);
  const computer = unified
    ? onlineHosts === includedHosts.length
      ? "All computers"
      : onlineHosts + "/" + includedHosts.length + " computers"
    : (pairingName ?? "Computer");
  const pillOnline = unified ? onlineHosts === includedHosts.length && includedHosts.length > 0 : online;
  const adminOn = useApp((state) => state.parts.meta?.you?.kind === "owner" && state.parts.meta.you.admin === true);
  const computerOrder = usePrefs(prefs => prefs.computerOrder);
  const computers = useApp((state) => state.pairings);
  const directoryHosts = useProfileHosts();
  const inUse = useApp((state) => state.pairing?.serverId);
  const rawRequests = useApp((state) => state.parts.live?.requests);
  const rawBoard = usePart("board");
  const rawPanels = usePart("panels");
  const rawSections = usePart("sections");
  const canCreate = useCan("agents", "create");
  // Freeze heavy body inputs while another tab is active so background chat/board updates don't
  // re-render the hidden Home tab.
  const frozen = useFrozenWhenHidden({
    bots: order.shown,
    chats: rawChats,
    synced: rawSynced,
    requests: rawRequests,
    board: rawBoard,
    panels: rawPanels,
    sections: rawSections,
  });

  // The page, for scrolling it under a dragged bot; and whether a drag is under way, which stops its own scrolling.
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useSharedValue(0);
  const scrollMax = useSharedValue(0);
  const scrollEdges = useSharedValue({ top: 0, bottom: 0 });
  const scroll = useMemo<BoardScroll>(
    () => ({ ref: scrollRef, offset: scrollOffset, max: scrollMax, edges: scrollEdges }),
    [scrollRef, scrollOffset, scrollMax, scrollEdges],
  );
  const [dragging, setDragging] = useState(false);
  const [seen] = useState(makeSeenSignal);

  return (
    <HomeFrame scroll={scroll} scrollEnabled={!dragging} onScrolled={seen.scrolled} quietLink={link !== "revoked"}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {/* A tap opens the computer's page; a hold opens the switcher. */}
          <HoldMenu title="Computers" actions={computerActions(computers, inUse, directoryHosts, computerOrder, unified)} onPressAction={({ nativeEvent }) => runComputerChoice(nativeEvent.event)} style={{ flexShrink: 1 }}>
            <Tap
              onPress={() => router.push(unified ? "/settings/computers" : "/settings/desktop")}
              feel="select"
              accessibilityLabel={computer + (pillOnline ? ", connected" : ", not connected") + (adminOn ? ", Admin mode" : "")}
              accessibilityHint="Hold to switch computers"
              style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 7, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.surface }}
            >
              <Dot tone={pillOnline ? "success" : "warning"} size={7} />
              <T variant="footnote" weight="600" color="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>
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
          <ServerLinkStatus />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {canCreate && <IconButton icon={Plus} label="New bot" variant="soft" size={44} onPress={() => router.push("/bot/new")} />}
          <SettingsButton />
        </View>
      </View>

      <HomeBody
        bots={frozen.bots}
        chats={frozen.chats}
        synced={frozen.synced}
        requests={frozen.requests}
        board={frozen.board}
        panels={frozen.panels}
        sections={frozen.sections}
        onDrop={order.drop}
        scroll={scroll}
        setDragging={setDragging}
        seen={seen}
      />
    </HomeFrame>
  );
}
