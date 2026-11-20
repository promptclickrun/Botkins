import { type MenuAction, MenuView } from "@react-native-menu/menu";
import { type Href, router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Ellipsis, ExternalLink, MessageCircle, Plus, ThumbsDown, ThumbsUp } from "lucide-react-native";
import { type ComponentRef, createContext, type ReactNode, type RefObject, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Dimensions, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { actOnIdea, discussBoardItem } from "@/features/chat/open";
import type { BoardItem, Bot, Panel } from "@/link/types";
import { cronLabel } from "@/features/work/cron";
import { useBots, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { ago, upcoming } from "@/state/time";
import { Blocks, BotAvatar, Button, EmptyState, Group, IconButton, Label, lift, Loading, Markdown, Mascot, Page, radius, Row, Segmented, space, T, Tap, useTheme } from "@/ui";

type Segment = "feed" | "idea" | "goal" | "panels";
const SEGMENTS: { value: Segment; label: string }[] = [
  { value: "feed", label: "Feed" },
  { value: "idea", label: "Ideas" },
  { value: "goal", label: "Goals" },
  { value: "panels", label: "Panels" },
];
const EMPTY: Record<Segment, string> = { feed: "Nothing new today", idea: "No ideas right now", goal: "No goals yet", panels: "Build your first panel" };
/** What "Ask <bot>" on an empty Feed, Ideas or Goals puts in a new chat's message box (the computer's own words). */
const ASK: Record<BoardItem["kind"], string> = {
  feed: "Post a few things to my Today feed that you think I'd find useful right now. Use board_post.",
  idea: "Suggest a few ideas on my Today board for things I could do this week. Use board_post with kind idea.",
  goal: "Help me set two or three goals and add them to my Today board with board_post and kind goal. Ask me what matters first.",
};
/** Why a person wants less like an item, as the computer offers. */
const REASONS = ["Not relevant", "Too frequent", "Already knew", "Wrong timing"];
const SIZES: { value: Panel["size"]; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "wide", label: "Wide" },
  { value: "tall", label: "Tall" },
];
// These routes are new; their types are generated the next time Metro starts.
const openNewPanel = () => router.push("/today/new" as Href);
const openPanelRoutine = (id: string) => router.push({ pathname: "/today/routine", params: { id } } as unknown as Href);
const openChat = (id: string) => router.push({ pathname: "/chat/[id]", params: { id } });

/** Starts a chat with a bot with text waiting in its message box. */
async function askBot(botId: string, text: string) {
  const id = await attempt(api.createChat(botId));
  if (id) router.push({ pathname: "/chat/[id]", params: { id, draft: text } });
}
const BODY_CLIP = 84; // About four lines of small Markdown.

// Each item is marked read once, the first time it is on screen.
const markedRead = new Set<string>();

/**
 * On a long page (Home) a card is drawn before it is seen. The page passes one of these and calls
 * `scrolled()` as it moves, so a card can check whether it has come into view. Without one, a card
 * counts as seen as soon as it is drawn (the Today page, where the list is the whole screen).
 */
export type SeenSignal = { scrolled: () => void; subscribe: (check: () => void) => () => void };
export function makeSeenSignal(): SeenSignal {
  const checks = new Set<() => void>();
  return {
    scrolled: () => checks.forEach((check) => check()),
    subscribe: (check) => {
      checks.add(check);
      return () => void checks.delete(check);
    },
  };
}
const Seen = createContext<SeenSignal | null>(null);
/** Room the tab bar takes at the bottom of a tab's page. */
const UNDER_TAB_BAR = 90;

function Card({ children, inner }: { children: ReactNode; inner?: RefObject<ComponentRef<typeof View> | null> }) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <View ref={inner} collapsable={false} style={[{ padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }, lift(theme)]}>
      {children}
    </View>
  );
}

function Byline({ bot, time, unread, note }: { bot?: Bot; time: number; unread?: boolean; note?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <BotAvatar bot={bot} size={26} badge={false} />
      <T variant="footnote" weight="600" color="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>
        {bot?.name ?? "A bot"}
      </T>
      <T variant="footnote" color="faint" numberOfLines={1} style={{ flexShrink: 1 }}>
        {"· " + ago(time) + (note ? " · " + note : "")}
      </T>
      {unread && <T variant="caption" color="accentText">New</T>}
    </View>
  );
}

/** Markdown that folds to about four lines, with "More" when there is more. */
function Body({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const long = height > BODY_CLIP + 8;
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ maxHeight: open || !long ? undefined : BODY_CLIP, overflow: "hidden" }}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <Markdown text={text} size="small" />
        </View>
      </View>
      {long && (
        <Tap onPress={() => setOpen(!open)} feel="select" sink={1} style={{ alignSelf: "flex-start", minHeight: 32, justifyContent: "center" }} accessibilityLabel={open ? "Show less" : "Show more"}>
          <T variant="subhead" weight="600" color="accentText">
            {open ? "Less" : "More"}
          </T>
        </Tap>
      )}
    </View>
  );
}

/** The kinds of goal the computer keeps (its GOAL_CATEGORIES), in the words a person reads. */
const GOAL_KINDS = [
  { id: "health", name: "Health" },
  { id: "relationships", name: "Relationships" },
  { id: "finance", name: "Finance" },
  { id: "career", name: "Career" },
  { id: "interests", name: "Interests" },
  { id: "productivity", name: "Productivity" },
  { id: "other", name: "Other" },
];

/** "More like this" rates an item up (again: not any more). "Less like this" asks why first, as the computer does. */
function Rate({ item, value }: { item: BoardItem; value: "up" | "down" }) {
  const { colors } = useTheme();
  const on = item.rating === value;
  const Icon = value === "up" ? ThumbsUp : ThumbsDown;
  const label = value === "up" ? "More like this" : "Less like this";
  const look = { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.accentSoft : "transparent" } as const;
  const icon = <Icon size={19} color={on ? colors.accentText : colors.muted} fill={on ? colors.accentText : "none"} strokeWidth={2.1} />;
  if (value === "up")
    return (
      <Tap onPress={() => void attempt(api.boardAct(item.id, "up"))} feel="select" sink={0.9} accessibilityLabel={label} accessibilityState={{ selected: on }} style={look}>
        {icon}
      </Tap>
    );
  return (
    <MenuView title="Less like this because…" actions={REASONS.map((reason) => ({ id: reason, title: reason }))} onPressAction={({ nativeEvent }) => void attempt(api.boardAct(item.id, "down", nativeEvent.event))}>
      <View accessible accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }} style={look}>
        {icon}
      </View>
    </MenuView>
  );
}

/** What the person already did with an item, for its byline: "Career", "Said yes", "Done". */
function noteOf(item: BoardItem) {
  const parts: string[] = [];
  if (item.kind === "goal" && item.category) parts.push(GOAL_KINDS.find((kind) => kind.id === item.category)?.name ?? item.category);
  if (item.answer === "yes") parts.push("Said yes");
  else if (item.answer === "goal") parts.push("Became a goal");
  if (item.status === "done" && item.kind === "goal") parts.push("Done");
  return parts.join(" · ") || undefined;
}

function ItemCard({ item, bot }: { item: BoardItem; bot?: Bot }) {
  const { colors } = useTheme();
  const seen = useContext(Seen);
  const card = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (item.read || markedRead.has(item.id)) return;
    const mark = () => {
      markedRead.add(item.id);
      // Quietly: a failed read mark isn't worth a toast.
      api.boardAct(item.id, "read").catch(() => markedRead.delete(item.id));
    };
    if (!seen) return mark();
    // Seen once its title is on screen, above the tab bar.
    const check = () =>
      card.current?.measureInWindow((_x, y, _width, height) => {
        if (markedRead.has(item.id) || !height) return;
        if (y >= 0 && y + Math.min(height, 110) <= Dimensions.get("window").height - UNDER_TAB_BAR) mark();
      });
    const stop = seen.subscribe(check);
    const first = setTimeout(check, 600);
    return () => {
      stop();
      clearTimeout(first);
    };
  }, [item.id, item.read, seen]);
  const act = (action: "clear" | "goal" | "notToday" | "done" | "reopen" | "delete", done?: string, value?: string) => void attempt(api.boardAct(item.id, action, value), done);
  const remove = () =>
    Alert.alert("Delete " + item.title + "?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => act("delete", "Deleted") },
    ]);
  const finished = item.status !== "open";
  // Discuss starts a chat with the bot with this item pinned to it, so the bot knows what it is about.
  const discuss = <Button title="Discuss" icon={MessageCircle} variant="ghost" size="sm" onPress={() => void discussBoardItem(item)} accessibilityLabel={"Discuss with " + (bot?.name ?? "the bot")} />;
  return (
    <Card inner={card}>
      <Byline bot={bot} time={item.createdAt} unread={!item.read} note={noteOf(item)} />
      <View style={{ gap: space.sm }}>
        <T variant="headline" accessibilityRole="header">
          {item.title}
        </T>
        {!!item.body.trim() && <Body text={item.body} />}
      </View>
      {!!item.links?.length && (
        <View style={{ gap: space.xs }}>
          {item.links.map((link) => (
            <Tap
              key={link.url}
              onPress={() => void WebBrowser.openBrowserAsync(link.url)}
              feel="select"
              sink={0.98}
              accessibilityRole="link"
              accessibilityLabel={link.title || link.url}
              style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }}
            >
              <T variant="subhead" weight="600" color="accentText" numberOfLines={1} style={{ flex: 1 }}>
                {link.title || link.url}
              </T>
              <ExternalLink size={15} color={colors.accentText} strokeWidth={2.3} />
            </Tap>
          ))}
        </View>
      )}
      {finished ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
          <Button title="Reopen" variant="secondary" size="sm" onPress={() => act("reopen", "Reopened")} />
          <Button title="Delete" variant="ghost" size="sm" onPress={remove} />
        </View>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
          {item.kind === "feed" && <Button title="Clear" variant="secondary" size="sm" onPress={() => act("clear")} />}
          {item.kind === "idea" && (
            <>
              {/* The bot is told to go ahead, in a chat of its own, and the idea is marked as taken up. */}
              <Button title="Let's do it" size="sm" onPress={() => void actOnIdea(item)} />
              <MenuView title="What kind of goal?" actions={GOAL_KINDS.map((kind) => ({ id: kind.id, title: kind.name }))} onPressAction={({ nativeEvent }) => act("goal", "Added to goals", nativeEvent.event)}>
                <Button title="Make it a goal" variant="secondary" size="sm" onPress={() => {}} />
              </MenuView>
              <Button title="Not now" variant="ghost" size="sm" onPress={() => act("clear")} />
            </>
          )}
          {item.kind === "goal" && (
            <>
              <Button title="Mark done" size="sm" onPress={() => act("done", "Goal done")} />
              <Button title="Not today" variant="ghost" size="sm" onPress={() => act("notToday", "Back tomorrow")} />
            </>
          )}
          <Rate item={item} value="up" />
          <Rate item={item} value="down" />
          <View style={{ flex: 1 }} />
          {discuss}
        </View>
      )}
    </Card>
  );
}

/** The panel's Manage menu: refresh, size, order, its own routine, its chats, hide and remove (the computer's Manage dialog). */
function PanelMenu({ panel, first, last }: { panel: Panel; first: boolean; last: boolean }) {
  const { colors } = useTheme();
  const refreshing = useRefreshing(panel);
  const routine = panel.routine;
  const off = (disabled: boolean) => (disabled ? { attributes: { disabled: true } } : {});
  const actions: MenuAction[] = [
    { id: "refresh", title: "Refresh", image: "arrow.clockwise", ...off(refreshing) },
    {
      id: "size",
      title: "Panel size",
      subtitle: SIZES.find((size) => size.value === panel.size)?.label,
      image: "rectangle.expand.vertical",
      subactions: SIZES.map((size) => ({ id: "size:" + size.value, title: size.label, state: panel.size === size.value ? ("on" as const) : ("off" as const) })),
    },
    {
      id: "order",
      title: "Order",
      displayInline: true,
      subactions: [
        { id: "earlier", title: "Earlier", image: "arrow.up", ...off(first) },
        { id: "later", title: "Later", image: "arrow.down", ...off(last) },
      ],
    },
    routine
      ? {
          id: "routine",
          title: "Routine",
          subtitle: cronLabel(routine.cron) + " · " + routine.timezone,
          image: "calendar.badge.clock",
          subactions: [
            { id: "routine:edit", title: "Edit routine", image: "pencil" },
            routine.enabled ? { id: "routine:pause", title: "Pause routine", image: "pause" } : { id: "routine:resume", title: "Resume routine", image: "play" },
            { id: "routine:remove", title: "Remove routine", image: "trash", attributes: { destructive: true } },
          ],
        }
      : { id: "routine:edit", title: "Set a routine", image: "calendar.badge.clock" },
    {
      id: "chats",
      title: "Chats",
      displayInline: true,
      subactions: [{ id: "chat", title: "Open original chat", image: "bubble.left" }, ...(panel.refreshChatId ? [{ id: "history", title: "Open refresh history", image: "clock.arrow.circlepath" }] : [])],
    },
    { id: "hide", title: panel.hidden ? "Show on Today" : "Hide from Today", image: panel.hidden ? "eye" : "eye.slash" },
    { id: "delete", title: "Remove panel", image: "trash", attributes: { destructive: true } },
  ];
  const remove = () =>
    Alert.alert(routine ? "Remove " + panel.title + " and its refresh routine?" : "Remove " + panel.title + "?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: routine ? "Remove panel and routine" : "Remove panel", style: "destructive", onPress: () => void attempt(api.changePanel(panel.id, "delete"), "Panel removed") },
    ]);
  return (
    <MenuView
      title={panel.title}
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (action === "refresh") void attempt(api.refreshPanel(panel.id), "Refreshing");
        else if (action.startsWith("size:")) void attempt(api.changePanel(panel.id, action.slice(5) as Panel["size"]));
        else if (action === "earlier" || action === "later") void attempt(api.changePanel(panel.id, action));
        else if (action === "routine:edit") openPanelRoutine(panel.id);
        else if (action === "routine:pause") void attempt(api.routine(panel.id, { action: "pause" }), "Routine paused");
        else if (action === "routine:resume") void attempt(api.routine(panel.id, { action: "resume" }), "Routine resumed");
        else if (action === "routine:remove") void attempt(api.routine(panel.id, { action: "remove" }), "Routine removed");
        else if (action === "chat") openChat(panel.chatId);
        else if (action === "history" && panel.refreshChatId) openChat(panel.refreshChatId);
        else if (action === "hide") void attempt(api.changePanel(panel.id, panel.hidden ? "show" : "hide"), panel.hidden ? "Shown on Today" : "Hidden");
        else if (action === "delete") remove();
      }}
    >
      <View accessible accessibilityRole="button" accessibilityLabel={"Manage " + panel.title} style={{ width: 44, height: 44, marginRight: -space.sm, marginTop: -space.sm, alignItems: "center", justifyContent: "center" }}>
        <Ellipsis size={20} color={colors.muted} strokeWidth={2.2} />
      </View>
    </MenuView>
  );
}

/** Whether the panel is refreshing now: its refresh chat has a turn under way. */
function useRefreshing(panel: Panel) {
  const streams = usePart("live")?.streams;
  return !!panel.refreshChatId && !!streams && panel.refreshChatId in streams;
}

/** "Updated 5m", or "Refreshing…"; then "Next Tomorrow 9:00 AM" or "Routine paused" when it has a routine. */
function panelCaption(panel: Panel, bot: Bot | undefined, refreshing: boolean) {
  const parts = [bot?.name, refreshing ? "Refreshing…" : "Updated " + ago(panel.updatedAt)];
  if (panel.routine) parts.push(panel.routine.enabled && panel.routine.nextAt ? "Next " + upcoming(panel.routine.nextAt) : "Routine paused");
  return parts.filter(Boolean).join(" · ");
}

/** A panel as a card. `order` places it among all the panels, for Earlier and Later; without it the card has no menu. */
export function PanelCard({ panel, bot, order }: { panel: Panel; bot?: Bot; order?: { first: boolean; last: boolean } }) {
  const refreshing = useRefreshing(panel);
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
        <BotAvatar bot={bot} size={36} badge={false} state={refreshing ? "thinking" : undefined} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="headline" numberOfLines={2} accessibilityRole="header">
            {panel.title}
          </T>
          <T variant="footnote" color="muted" numberOfLines={2}>
            {panelCaption(panel, bot, refreshing)}
          </T>
        </View>
        {order && <PanelMenu panel={panel} first={order.first} last={order.last} />}
      </View>
      <Blocks blocks={panel.blocks} title={panel.title} />
    </Card>
  );
}

export default function Today() {
  return (
    <Page title="Today" actions={<IconButton icon={Plus} label="Create panel" variant="accent" size={44} onPress={openNewPanel} />}>
      <TodayContent />
    </Page>
  );
}

/** What the bots put on the board today, and their panels. `seen` is for a page that shows it below other things. */
export function TodayContent({ seen }: { seen?: SeenSignal }) {
  const synced = useApp((state) => state.synced);
  const allBots = useBots();
  const board = usePart("board");
  const panels = usePart("panels");
  const [chosen, setChosen] = useState<Segment>("feed");
  const [finished, setFinished] = useState(false);

  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const primary = allBots[0];
  const items = useMemo(() => {
    const now = Date.now();
    const open = (board ?? []).filter((item) => item.status === "open" && !(item.snoozedUntil && item.snoozedUntil > now));
    return open.sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt - a.createdAt);
  }, [board]);
  const done = useMemo(() => (board ?? []).filter((item) => item.status !== "open").sort((a, b) => b.updatedAt - a.updatedAt), [board]);
  const shownPanels = useMemo(() => (panels ?? []).filter((panel) => !panel.hidden), [panels]);
  const hiddenPanels = useMemo(() => (panels ?? []).filter((panel) => panel.hidden), [panels]);
  const all = panels ?? [];

  const count = (segment: Segment) => (segment === "panels" ? (panels?.length ?? 0) : items.filter((item) => item.kind === segment).length);
  const filled = SEGMENTS.filter((segment) => count(segment.value) > 0);
  // Panels stays offered, so a first panel can always be asked for.
  const options = filled.length >= 2 ? SEGMENTS.filter((segment) => segment.value === "panels" || count(segment.value) > 0) : SEGMENTS;
  const segment = options.some((option) => option.value === chosen) ? chosen : options[0].value;
  const showing = segment !== "panels" && finished;
  const list = segment === "panels" ? [] : (showing ? done : items).filter((item) => item.kind === segment).slice(0, 30);

  return (
    <Seen.Provider value={seen ?? null}>
      <Segmented options={options} value={segment} onChange={setChosen} />
      {!synced ? (
        <Loading />
      ) : (
        <Animated.View key={segment} entering={FadeIn.duration(180)} style={{ gap: space.lg }}>
          {segment !== "panels" ? (
            <>
              {list.length === 0 ? (
                showing ? (
                  <EmptyState title="Nothing finished yet" />
                ) : (
                  <EmptyState
                    art={<Mascot size={96} state={segment === "feed" ? "completed" : "idle"} />}
                    title={EMPTY[segment]}
                    action={primary ? "Ask " + primary.name : undefined}
                    onAction={primary ? () => void askBot(primary.id, ASK[segment]) : undefined}
                  />
                )
              ) : (
                list.map((item) => <ItemCard key={item.id} item={item} bot={bots.get(item.botId)} />)
              )}
              <Button title={finished ? "Show open" : "Show finished"} variant="ghost" size="sm" onPress={() => setFinished(!finished)} style={{ alignSelf: "center" }} />
            </>
          ) : (
            <>
              {shownPanels.length === 0 &&
                (hiddenPanels.length ? (
                  <EmptyState art={<Mascot size={96} />} title="All panels are hidden" />
                ) : (
                  <EmptyState art={<Mascot size={96} />} title={EMPTY.panels} action="Ask a bot" onAction={openNewPanel} />
                ))}
              {shownPanels.map((panel) => {
                const index = all.indexOf(panel);
                return <PanelCard key={panel.id} panel={panel} bot={bots.get(panel.botId)} order={{ first: index === 0, last: index === all.length - 1 }} />;
              })}
              {shownPanels.length > 0 && <Button title="Create panel" icon={Plus} variant="secondary" size="sm" onPress={openNewPanel} style={{ alignSelf: "center" }} />}
              {hiddenPanels.length > 0 && (
                <View style={{ marginTop: space.sm }}>
                  <Label>Hidden</Label>
                  <Group>
                    {hiddenPanels.map((panel) => {
                      const bot = bots.get(panel.botId);
                      return (
                        <Row
                          key={panel.id}
                          leading={<BotAvatar bot={bot} size={32} badge={false} />}
                          title={panel.title}
                          subtitle={bot?.name}
                          trailing={<Button title="Show" variant="ghost" size="sm" onPress={() => void attempt(api.changePanel(panel.id, "show"))} accessibilityLabel={"Show " + panel.title} />}
                        />
                      );
                    })}
                  </Group>
                </View>
              )}
            </>
          )}
        </Animated.View>
      )}
    </Seen.Provider>
  );
}
