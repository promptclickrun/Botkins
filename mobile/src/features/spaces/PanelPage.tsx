// A panel, opened: its app gets the whole width and works by touch. The bar pins it to Home and
// has its menu; below it sit the notes people wrote, and the field that asks its bot to change it. Over that
// field float the things its bot said are worth asking next, as chips: a tap opens the field with
// the chip's words in it, and sends nothing. A panel that is only an app fills the screen down to
// the bottom edge, under the floating field: its page scrolls by itself, and its notes open from the bar.
import { MenuView } from "@react-native-menu/menu";
import { type Href, router, Stack, useLocalSearchParams } from "expo-router";
import { Ellipsis, Pin, PinOff, StickyNote } from "lucide-react-native";
import { useEffect } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { openChat } from "@/features/chat/navigate";
import { myself } from "@/features/chat/people";
import { cronLabel } from "@/features/work/cron";
import type { PanelView, SpaceSummary } from "@/link/types";
import { useBots, useCan, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { ago, upcoming } from "@/state/time";
import { Blocks, BotAvatar, EmptyState, Glass, IconButton, Loading, Page, radius, slopFor, space as gap, T, Tap, useTheme } from "@/ui";
import { markItemSeen, panelState, setPanelPinned, usePanelPinned, useSpace, useSpaceContent } from "./data";
import { askRoom, asksOf, isApp, lastLine, noteBadge, panelLayout } from "./logic";
import { Notes } from "./Notes";

const SIZES: { value: PanelView["size"]; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "wide", label: "Wide" },
  { value: "tall", label: "Tall" },
];

/** The panel's menu: refresh, size, order, hide, its chat, remove. What a person may do follows their role and what they may do in the space. */
function PanelMenu({ panel, space, first, last }: { panel: PanelView; space: SpaceSummary; first: boolean; last: boolean }) {
  const { colors } = useTheme();
  const canUse = useCan("today", "use");
  const canManage = useCan("today", "manage");
  const canDelete = useCan("today", "delete");
  const acts = space.can === "own" || space.can === "edit";
  const off = (disabled: boolean) => (disabled ? { attributes: { disabled: true } } : {});
  const actions = [
    ...(canUse && acts ? [{ id: "refresh", title: "Refresh", image: "arrow.clockwise" }] : []),
    ...(canManage && acts
      ? [
          { id: "size", title: "Panel size", subtitle: SIZES.find((size) => size.value === panel.size)?.label, image: "rectangle.expand.vertical", subactions: SIZES.map((size) => ({ id: "size:" + size.value, title: size.label, state: panel.size === size.value ? ("on" as const) : ("off" as const) })) },
          { id: "earlier", title: "Earlier", image: "arrow.up", ...off(first) },
          { id: "later", title: "Later", image: "arrow.down", ...off(last) },
          { id: "hide", title: panel.hidden ? "Show" : "Hide", image: panel.hidden ? "eye" : "eye.slash" },
        ]
      : []),
    ...(panel.chatId ? [{ id: "chat", title: "Open original chat", image: "bubble.left" }] : []),
    ...(panel.refreshChatId ? [{ id: "history", title: "Open refresh history", image: "clock.arrow.circlepath" }] : []),
    ...(canDelete && acts ? [{ id: "delete", title: "Remove panel", image: "trash", attributes: { destructive: true } }] : []),
  ];
  if (!actions.length) return null;
  const remove = () =>
    Alert.alert("Remove " + panel.title + "?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove panel", style: "destructive", onPress: () => void attempt(api.changePanel(panel.id, "delete").then(() => true), "Panel removed").then((done) => done && router.canGoBack() && router.back()) },
    ]);
  return (
    <MenuView
      title={panel.title}
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (action === "refresh") void attempt(api.refreshPanel(panel.id), "Refreshing");
        else if (action.startsWith("size:")) void attempt(api.changePanel(panel.id, action.slice(5) as PanelView["size"]));
        else if (action === "earlier" || action === "later") void attempt(api.changePanel(panel.id, action));
        else if (action === "hide") void attempt(api.changePanel(panel.id, panel.hidden ? "show" : "hide"), panel.hidden ? "Shown" : "Hidden");
        else if (action === "chat" && panel.chatId) openChat(panel.chatId);
        else if (action === "history" && panel.refreshChatId) openChat(panel.refreshChatId);
        else if (action === "delete") remove();
      }}
    >
      <View accessible accessibilityRole="button" accessibilityLabel={"Options for " + panel.title} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Ellipsis size={20} color={colors.ink} strokeWidth={2.2} />
      </View>
    </MenuView>
  );
}

const openAsk = (spaceId: string, panelId: string, ask?: number) => router.push(("/space/ask?spaceId=" + encodeURIComponent(spaceId) + "&panelId=" + encodeURIComponent(panelId) + (ask === undefined ? "" : "&ask=" + ask)) as unknown as Href);
const openNotes = (spaceId: string, panelId: string) => router.push(("/space/notes?spaceId=" + encodeURIComponent(spaceId) + "&panelId=" + encodeURIComponent(panelId)) as unknown as Href);

/** The bar's notes button, for an app on the whole screen: a note with how many there are. */
function NotesButton({ count, onPress }: { count: number; onPress: () => void }) {
  const { colors } = useTheme();
  const badge = noteBadge(count);
  return (
    <Tap onPress={onPress} sink={0.9} accessibilityLabel={count ? "Notes, " + count : "Notes"} accessibilityHint="Opens the panel's notes" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
      <StickyNote size={20} color={colors.ink} strokeWidth={2.2} />
      {!!badge && (
        <View pointerEvents="none" style={{ position: "absolute", top: 5, right: 3, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" }}>
          <T variant="caption" weight="700" color="onAccent" numberOfLines={1} maxFontSizeMultiplier={1}>
            {badge}
          </T>
        </View>
      )}
    </Tap>
  );
}

/** The bot's asks as a row of glass chips, in its words. The row scrolls sideways when they do not fit. */
function AskChips({ asks, onPick }: { asks: string[]; onPick: (index: number) => void }) {
  const { control } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ marginHorizontal: -gap.lg, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: gap.lg, gap: gap.sm, paddingVertical: slopFor(control.chip) }}>
      {asks.map((ask, index) => (
        <Tap key={index + ":" + ask} onPress={() => onPick(index)} feel="select" sink={0.97} hitSlop={slopFor(control.chip)} accessibilityLabel={ask} accessibilityHint="Puts these words in the ask field">
          {/* The glass only draws: the press belongs to the chip around it. */}
          <View pointerEvents="none">
            <Glass style={{ minHeight: control.chip, paddingHorizontal: 14, borderRadius: radius.pill, justifyContent: "center", overflow: "hidden" }}>
              <T variant="subhead" weight="600" numberOfLines={1}>
                {ask}
              </T>
            </Glass>
          </View>
        </Tap>
      ))}
    </ScrollView>
  );
}

/** The bar: the panel's notes when they open as a sheet, its pin to Home, then its menu. */
function BarButtons({ panel, space, first, last, notes }: { panel: PanelView; space: SpaceSummary; first: boolean; last: boolean; notes: boolean }) {
  const pinned = usePanelPinned(space.id, panel.id);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: gap.xs }}>
      {notes && <NotesButton count={panel.notes?.length ?? 0} onPress={() => openNotes(space.id, panel.id)} />}
      <IconButton icon={pinned ? PinOff : Pin} label={pinned ? "Take off Home" : "Pin to Home"} onPress={() => setPanelPinned({ spaceId: space.id, panelId: panel.id }, !pinned)} />
      <PanelMenu panel={panel} space={space} first={first} last={last} />
    </View>
  );
}

export default function PanelPage() {
  const { spaceId, id } = useLocalSearchParams<{ spaceId: string; id: string }>();
  const insets = useSafeAreaInsets();
  const { control } = useTheme();
  const space = useSpace(spaceId);
  const { content, loading } = useSpaceContent(spaceId);
  const bots = useBots();
  const canChat = useCan("agents", "chat");
  const canUse = useCan("today", "use");
  const me = myself(usePart("meta"));
  const panels = content?.panels ?? [];
  const panel = panels.find((one) => one.id === id);
  // Opened, so seen: its dot clears in its space, here and on the person's other devices; again when it changes while open.
  const updatedAt = panel?.updatedAt;
  const seenBefore = Math.max(content?.seenAt ?? 0, (id && content?.seenItems?.[id]) || 0);
  useEffect(() => {
    if (spaceId && id && updatedAt !== undefined && updatedAt > seenBefore) markItemSeen(spaceId, id, updatedAt);
  }, [spaceId, id, updatedAt, seenBefore]);
  if (!space || !panel) return <Page title="Panel">{loading && space ? <Loading /> : <EmptyState title="This panel no longer exists." />}</Page>;
  const bot = bots.find((one) => one.id === panel.botId);
  const index = panels.indexOf(panel);
  const routine = panel.routine;
  const caption = [bot?.name, "Updated " + ago(panel.updatedAt), routine ? (routine.enabled && routine.nextAt ? "Next " + upcoming(routine.nextAt) : "Routine paused") : undefined].filter(Boolean).join(" · ");
  const last = lastLine(panel.last, ago);
  const acts = space.can === "own" || space.can === "edit";
  const mayAsk = canChat && acts;
  const layout = panelLayout(panel, acts);
  // Chips only where the field they fill is shown, and only the bot's own.
  const asks = mayAsk ? asksOf(panel) : [];
  // What floats over the bottom of an app on the whole screen: its page keeps this much room under its end.
  const room = askRoom({ bottom: insets.bottom, bar: mayAsk ? 50 : 0, chips: asks.length ? control.chip + 2 * slopFor(control.chip) : 0, gap: gap.sm });
  const bar = <Stack.Screen options={{ headerRight: () => <BarButtons panel={panel} space={space} first={index === 0} last={index === panels.length - 1} notes={layout.notesButton} /> }} />;
  const head = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: gap.md }}>
      <BotAvatar bot={bot} size={40} badge={false} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="title2" numberOfLines={3} accessibilityRole="header">
          {panel.title}
        </T>
        <T variant="footnote" color="muted" numberOfLines={2}>
          {caption}
        </T>
        {layout.fill && !!last && (
          <T variant="footnote" color="faint" numberOfLines={1}>
            {last}
          </T>
        )}
      </View>
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      {layout.fill ? (
        // The app takes the rest of the screen, down under the floating field; nothing sits below it.
        <Page scroll={false} contentStyle={{ paddingBottom: 0, gap: gap.lg }}>
          {bar}
          {head}
          <Blocks blocks={panel.blocks} title={panel.title} fill bottom={room} state={panelState(panel, space, canUse)} />
        </Page>
      ) : (
        <Page contentStyle={{ paddingBottom: asks.length ? 170 : 120 }} keyboard>
          {bar}
          {head}
          <Blocks blocks={panel.blocks} title={panel.title} state={isApp(panel) ? panelState(panel, space, canUse) : undefined} />
          {!!last && (
            <T variant="footnote" color="faint">
              {last}
            </T>
          )}
          {!!routine && (
            <T variant="footnote" color="muted">
              {"Refreshes " + cronLabel(routine.cron).toLowerCase() + " · " + routine.timezone}
            </T>
          )}
          <Notes panel={panel} space={space} me={me} />
        </Page>
      )}
      {mayAsk && (
        <View pointerEvents="box-none" style={{ position: "absolute", left: gap.lg, right: gap.lg, bottom: insets.bottom + gap.sm, gap: gap.xs }}>
          {asks.length > 0 && <AskChips asks={asks} onPick={(index) => openAsk(space.id, panel.id, index)} />}
          <Tap onPress={() => openAsk(space.id, panel.id)} feel="select" sink={0.99} accessibilityLabel={"Ask " + (bot?.name ?? "the bot") + " to change it"}>
            <Glass interactive style={{ height: 50, borderRadius: 25, flexDirection: "row", alignItems: "center", gap: gap.sm, paddingHorizontal: gap.md, overflow: "hidden" }}>
              <BotAvatar bot={bot} size={28} badge={false} />
              <T variant="callout" color="muted" numberOfLines={1} style={{ flex: 1 }}>
                {"Ask " + (bot?.name ?? "the bot") + " to change it"}
              </T>
            </Glass>
          </Tap>
        </View>
      )}
    </View>
  );
}
