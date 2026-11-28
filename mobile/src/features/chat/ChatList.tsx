// The Chats tab: search, chips for every chat, the unread ones or one of the person's sections, the
// pinned chats as a row of faces, then one list of the rest, newest first ("Recent"), and the
// archived ones behind a row at the end. A held chat can still be dragged onto Pinned or a section,
// which show above the list while it moves (ChatBoard, `arrangeChatsFlat` in sections.ts).
import { MenuView } from "@react-native-menu/menu";
import { router, useIsFocused, useScrollToTop } from "expo-router";
import { Archive, ChevronDown, ChevronUp, Ellipsis, FolderPlus, Search, SquarePen, X } from "lucide-react-native";
import { memo, type ReactNode, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BoardScroll } from "@/features/home/BotBoard";
import type { Bot, ChatSummary } from "@/link/types";
import { activityLabel, isConversation, useBots, useCan, useCapability, useChatActivity, useChats, useOnline, usePart, useSettings } from "@/state/hooks";
import { isRoutineChat } from "../../../link-host/routine-chat.mjs";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { BackdropLayer, BotAvatar, Chip, EmptyState, foldGap, Glass, Group, HoldMenu, IconButton, IconTile, LinkBanner, listWidth, Loading, LoadingGrid, Mascot, radius, Row, space, T, Tap, tint, useFrozenWhenHidden, useShape, useTabReady, useTextPrompt, useTheme } from "@/ui";
import { GroupFace } from "./bits";
import { ChatBoard } from "./ChatBoard";
import { ChatPane } from "./ChatScreen";
import { openChat } from "./navigate";
import { markChatsPageRead } from "./open";
import { openFromList, useChatSplit } from "./split";
import { newSection } from "./sectionMenus";
import { ChatChips } from "./ChatChips";
import { chatChips, type ChatFilter, chatsForFilter, runningChatIds } from "./sections";
import { chatsPageUnreadChats, isChatsPageArchived, isChatsPageChat } from "./unread";

function SearchField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const { colors, dark, type, control } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const inner = (
    <>
      <Search size={17} color={colors.muted} strokeWidth={2.3} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search"
        placeholderTextColor={colors.faint}
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="never"
        maxFontSizeMultiplier={1.3}
        accessibilityLabel="Search chats"
        style={[type.callout, { flex: 1, color: colors.ink, paddingVertical: 0, height: control.field }]}
      />
      {!!value && (
        <Tap onPress={() => onChange("")} accessibilityLabel="Clear search" feel="select" sink={0.9} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: colors.faint, alignItems: "center", justifyContent: "center" }}>
            <X size={12} color={colors.sunken} strokeWidth={3} />
          </View>
        </Tap>
      )}
    </>
  );
  if (hasBackdrop) {
    return (
      <Glass
        tintColor={tint(colors.surface, dark ? 0.28 : 0.42)}
        style={{ height: control.field, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, borderRadius: radius.md, overflow: "hidden" }}
      >
        {inner}
      </Glass>
    );
  }
  return (
    <View style={{ height: control.field, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }}>
      {inner}
    </View>
  );
}

/** A pinned chat as a face and its name, three to a row above the list. A hold unpins it. */
const PinnedChat = memo(function PinnedChat({ chat, bots }: { chat: ChatSummary; bots: Map<string, Bot> }) {
  const state = useChatActivity(chat.id);
  const canChat = useCan("agents", "chat");
  const bot = bots.get(chat.botId);
  const group = chat.botIds && chat.botIds.length > 1;
  const live = activityLabel(state);
  const title = chat.title || bot?.name || "Chat";
  return (
    <View style={{ width: "33.33%", alignItems: "center" }}>
      <HoldMenu
        actions={canChat ? [{ id: "unpin", title: "Unpin", image: "pin.slash" }] : []}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "unpin") void attempt(api.setChatFlags(chat.id, { pinned: false }));
        }}
      >
        <Tap onPress={() => openFromList(chat.id)} feel="select" sink={0.94} accessibilityLabel={title + (live ? ", " + live : "") + (chat.unread && !isRoutineChat(chat) ? ", unread" : "") + ", pinned"} accessibilityHint={canChat ? "Long press to unpin" : undefined} style={{ alignItems: "center", gap: 6, paddingHorizontal: space.xs, maxWidth: "100%" }}>
          {group ? <GroupFace bots={chat.botIds!.slice(0, 2).map((id) => bots.get(id))} size={56} state={state} /> : <BotAvatar bot={bot} size={56} state={state} animated={false} />}
          <T variant="footnote" weight={chat.unread && !isRoutineChat(chat) ? "700" : "600"} color="ink2" numberOfLines={1} center>
            {title}
          </T>
        </Tap>
      </HoldMenu>
    </View>
  );
});

/** The ⋯ beside New chat: Mark all as read, Show routine chats, and New section. Nothing when none applies. */
function MoreMenu({ unread, filing, showRoutines, onToggleRoutines, onNewSection }: { unread: boolean; filing: boolean; showRoutines?: boolean; onToggleRoutines?: () => void; onNewSection: () => void }) {
  const { colors, dark } = useTheme();
  const actions = [
    ...(unread ? [{ id: "read", title: "Mark all as read", image: "envelope.open" }] : []),
    ...(onToggleRoutines ? [{ id: "routines", title: "Show routine chats", image: "repeat", state: showRoutines ? ("on" as const) : ("off" as const) }] : []),
    ...(filing ? [{ id: "section", title: "New section…", image: "folder.badge.plus" }] : []),
  ];
  if (!actions.length) return null;
  return (
    <MenuView
      title="Chats"
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "read") void markChatsPageRead();
        else if (nativeEvent.event === "routines") onToggleRoutines?.();
        else onNewSection();
      }}
    >
      <View accessible accessibilityRole="button" accessibilityLabel="More" style={{ width: 44, height: 44 }}>
        <Glass interactive tintColor={tint(colors.surface, dark ? 0.28 : 0.42)} style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" }}>
          <Ellipsis size={20} color={colors.ink} strokeWidth={2.2} />
        </Glass>
      </View>
    </MenuView>
  );
}

/** The deferred results area under the search bar and chips. Memoized so chip/search commits skip it until the deferred value arrives. */
const ChatListResults = memo(function ChatListResults({
  conversations,
  archived,
  bots,
  needle,
  picked,
  sections,
  unreadIds,
  runningIds,
  showArchived,
  setShowArchived,
  showRoutineChats,
  hasRoutineChats,
  scroll,
  onDragging,
}: {
  conversations: ChatSummary[];
  archived: ChatSummary[];
  bots: Map<string, Bot>;
  needle: string;
  picked: ChatFilter;
  sections: ReturnType<typeof usePart<"chatSections">>;
  unreadIds: ReadonlySet<string>;
  runningIds: ReadonlySet<string>;
  showArchived: boolean;
  setShowArchived: (next: boolean) => void;
  showRoutineChats: boolean;
  hasRoutineChats: boolean;
  scroll: BoardScroll;
  onDragging: (on: boolean) => void;
}) {
  const { colors } = useTheme();
  const { shown, old } = useMemo(() => {
    const matches = (chat: ChatSummary) => {
      if (!needle) return true;
      const names = (chat.botIds ?? [chat.botId]).map((id) => bots.get(id)?.name ?? "").join(" ");
      return (chat.title + " " + names + " " + (chat.last?.text ?? "")).toLowerCase().includes(needle);
    };
    return {
      shown: chatsForFilter(conversations, picked, sections, unreadIds, runningIds).filter(matches),
      old: showArchived ? archived.filter(matches) : [],
    };
  }, [conversations, archived, bots, needle, showArchived, picked, sections, unreadIds, runningIds]);
  const pinned = useMemo(() => shown.filter((chat) => chat.pinned).sort((a, b) => b.time - a.time), [shown]);
  const nothing = shown.length === 0 && old.length === 0;
  return (
    <>
      {pinned.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: space.lg, marginHorizontal: -space.xs, paddingTop: space.xs }}>
          {pinned.map((chat) => (
            <PinnedChat key={chat.id} chat={chat} bots={bots} />
          ))}
        </View>
      )}
      {nothing ? (
        <View style={{ alignItems: "center", paddingVertical: space.huge, gap: space.sm }}>
          <Search size={26} color={colors.faint} strokeWidth={2} />
          <T variant="callout" color="muted">
            {needle ? "No matches" : picked === "unread" ? "No unread chats" : picked === "running" ? "No chats running right now" : picked === "all" && !showRoutineChats && hasRoutineChats ? "Routine chats are hidden" : picked === "all" ? "No chats" : "No chats here yet"}
          </T>
        </View>
      ) : (
        <ChatBoard chats={shown} archived={old} sections={sections} bots={bots} searching={!!needle} scroll={scroll} onDragging={onDragging} flat />
      )}
      {archived.length > 0 && (
        <Group>
          <Row
            leading={<IconTile icon={Archive} />}
            title="Archived"
            value={String(archived.length)}
            trailing={showArchived ? <ChevronUp size={18} color={colors.faint} strokeWidth={2.2} /> : <ChevronDown size={18} color={colors.faint} strokeWidth={2.2} />}
            onPress={() => setShowArchived(!showArchived)}
          />
        </Group>
      )}
    </>
  );
});

/**
 * Page's frame for a tab's root, with a scroll view the list can scroll itself: a dragged chat near
 * the top or bottom edge scrolls the page (Page has no handle on its scroll view). Keep it like
 * Page's, and like Home's own frame.
 */
/** `inner`: the list is the first of two panes, so its right side meets the chat, not the rail. */
function ChatsFrame({ children, scroll, scrollEnabled, actions, inner }: { children: ReactNode; scroll: BoardScroll; scrollEnabled: boolean; actions?: ReactNode; inner?: boolean }) {
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
  const { edges, offset, max } = scroll;
  useEffect(() => {
    edges.value = { top: insets.top, bottom: height - shape.tabRoom - insets.bottom };
  }, [edges, insets.top, insets.bottom, height, shape.tabRoom]);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.value = event.contentOffset.y;
    },
  });
  return (
    <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      <Animated.ScrollView
        ref={scroll.ref}
        style={{ flex: 1, backgroundColor: "transparent" }}
        contentContainerStyle={{ paddingLeft: space.xl + shape.left, paddingRight: inner ? space.lg : space.xl + shape.right, paddingTop: insets.top + space.md, paddingBottom: shape.tabRoom + insets.bottom + space.xxl, gap: space.xl }}
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
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.md, marginBottom: space.xs }}>
          <View style={{ flex: 1 }}>
            <T variant="display" accessibilityRole="header" numberOfLines={2}>
              Chats
            </T>
          </View>
          {!!actions && <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingBottom: 3 }}>{actions}</View>}
        </View>
        <LinkBanner />
        {children}
      </Animated.ScrollView>
    </View>
  );
}

function ChatListScreen({ ready }: { ready: boolean }) {
  const { colors } = useTheme();
  const prompt = useTextPrompt();
  const rawChats = useChats();
  const rawBots = useBots();
  const rawSynced = useApp((state) => state.synced);
  const rawLive = usePart("live");
  const rawSettings = useSettings();
  const rawHeld = usePart("chatSections");
  const rawProjects = usePart("projects");
  // Freeze store snapshots while another tab is in front so background chat/live updates
  // don't re-render the hidden Chats tab.
  const frozen = useFrozenWhenHidden({
    chats: rawChats,
    allBots: rawBots,
    synced: rawSynced,
    live: rawLive,
    settings: rawSettings,
    held: rawHeld,
    projects: rawProjects,
  });
  const { chats, allBots, synced, live, settings, held, projects } = frozen;

  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // Null until the person taps a chip: the screen opens on the leftmost one.
  const [filter, setFilter] = useState<ChatFilter | null>(null);
  const chipOrder = usePrefs((prefs) => prefs.chatChipOrder);
  const canView = useCan("agents", "view");
  const canChat = useCan("agents", "chat");
  const online = useOnline();
  const showRoutineChats = !!settings?.showRoutineChats;
  const hasRoutineChats = useMemo(() => chats.some((chat) => isRoutineChat(chat)), [chats]);
  const toggleRoutineChats = useCallback(() => void attempt(api.setPreferences({ showRoutineChats: !showRoutineChats })), [showRoutineChats]);
  // The person's own sections ("chat-sections-v1"). Without them the list is as it always was.
  const filing = useCapability("chat-sections-v1");
  const sections = filing ? (held ?? []) : undefined;

  const shape = useShape();
  const { width } = useWindowDimensions();
  const split = shape.wide;
  const pickedId = useChatSplit((state) => state.id);

  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const needle = query.trim().toLowerCase();
  const deferredNeedle = useDeferredValue(needle);
  const listOptions = useMemo(() => ({ showRoutineChats, selectedChatId: pickedId, query: deferredNeedle }), [showRoutineChats, pickedId, deferredNeedle]);
  const conversations = useMemo(() => chats.filter((chat) => isChatsPageChat(chat, listOptions)), [chats, listOptions]);
  const archived = useMemo(() => chats.filter((chat) => isChatsPageArchived(chat, listOptions)), [chats, listOptions]);
  const unreadIds = useMemo(() => new Set(chatsPageUnreadChats(chats).map((chat) => chat.id)), [chats]);
  const unreadCount = unreadIds.size;
  const runningIds = useMemo(() => runningChatIds(live), [live?.active, live?.streams]);
  const runningCount = useMemo(() => conversations.filter((chat) => runningIds.has(chat.id)).length, [conversations, runningIds]);
  const chips = useMemo(() => chatChips(sections, unreadCount, canView, runningCount, chipOrder), [sections, unreadCount, canView, runningCount, chipOrder]);
  // A chip that is gone (a deleted section, or Unread for someone who can't read) goes back to the first one.
  const picked: ChatFilter = filter && chips.some((chip) => chip.value === filter) ? filter : (chips[0]?.value ?? "all");
  // Defer filter and search updates for the heavy list so the chip's selected state commits on the
  // press frame and the list re-renders in a subsequent low-priority commit.
  const deferredPicked = useDeferredValue(picked);
  const deferredShowArchived = useDeferredValue(showArchived);
  const listPending = deferredPicked !== picked || deferredNeedle !== needle || deferredShowArchived !== showArchived;
  const onPickFilter = useCallback((next: ChatFilter) => {
    setFilter(next);
  }, []);
  const onToggleArchived = useCallback((next: boolean) => {
    startTransition(() => setShowArchived(next));
  }, []);

  // The page, for scrolling it under a dragged chat; and whether a drag is under way, which stops its own scrolling.
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useSharedValue(0);
  const scrollMax = useSharedValue(0);
  const scrollEdges = useSharedValue({ top: 0, bottom: 0 });
  const scroll = useMemo<BoardScroll>(
    () => ({ ref: scrollRef, offset: scrollOffset, max: scrollMax, edges: scrollEdges }),
    [scrollRef, scrollOffset, scrollMax, scrollEdges],
  );
  const [dragging, setDragging] = useState(false);
  const empty = synced && chats.length === 0;
  // In book pose the list can be asked back; picking a chat in it gives the pages to that chat again.
  const [listShown, setListShown] = useState(false);
  const taps = useChatSplit((state) => state.taps);
  useEffect(() => {
    setListShown(false);
  }, [pickedId, taps, shape.pose]);
  // A chat just made or forked beside the list stays picked while the list catches up with it.
  const firstShownId = useMemo(() => {
    if (!split || pickedId) return null;
    const filtered = chatsForFilter(conversations, deferredPicked, sections, unreadIds, runningIds);
    return filtered[0]?.id ?? null;
  }, [split, pickedId, conversations, deferredPicked, sections, unreadIds, runningIds]);
  const paneId = pickedId ?? firstShownId;
  const focused = useIsFocused();
  useEffect(() => {
    useChatSplit.setState({ active: split });
  }, [split]);
  // The newest chat is open beside the list until the person picks another (its row is marked).
  useEffect(() => {
    if (split && paneId && !pickedId) useChatSplit.setState({ id: paneId });
  }, [split, paneId, pickedId]);
  // A picked chat that the list had and lost (deleted elsewhere) is let go.
  const had = useRef<string | null>(null);
  useEffect(() => {
    if (!pickedId) return;
    if (chats.some((chat) => chat.id === pickedId)) had.current = pickedId;
    else if (had.current === pickedId) useChatSplit.setState({ id: null });
  }, [chats, pickedId]);
  // Folding with a chat open beside the list: it goes on its own page, so the person stays in it.
  // Only while the list is the screen in front; under another tab or page nothing moves.
  const before = useRef(split);
  useEffect(() => {
    const was = before.current;
    before.current = split;
    if (was && !split && pickedId && focused) {
      useChatSplit.setState({ id: null, pushed: pickedId });
      openChat(pickedId);
    }
  }, [split, pickedId, focused]);

  const frame = (
    <ChatsFrame
      scroll={scroll}
      scrollEnabled={!dragging}
      inner={split}
      actions={
        <>
          <MoreMenu
            unread={unreadCount > 0 && canView}
            filing={!!sections && canChat}
            showRoutines={showRoutineChats}
            onToggleRoutines={online && canView && (hasRoutineChats || showRoutineChats) ? toggleRoutineChats : undefined}
            onNewSection={() => newSection(prompt.ask)}
          />
          {canChat && <IconButton icon={SquarePen} label="New chat" variant="accent" size={44} onPress={() => router.push("/chat/new")} />}
        </>
      }
    >
      {!ready || !synced ? (
        <Loading />
      ) : empty ? (
        <EmptyState art={<Mascot size={104} />} title="No chats yet" action={canChat ? "New chat" : undefined} onAction={canChat ? () => router.push("/chat/new") : undefined} />
      ) : (
        <Animated.View entering={FadeIn.duration(220)} style={{ gap: space.md }}>
          <View style={{ gap: space.md }}>
            <SearchField value={query} onChange={setQuery} />
            {(chips.length > 1 || (sections && canChat) || (online && canView && (hasRoutineChats || showRoutineChats))) && (
              <ChatChips
                chips={chips}
                picked={picked}
                onPick={onPickFilter}
                trailing={
                  <View style={{ flexDirection: "row", gap: space.sm, paddingRight: space.sm }}>
                    {online && canView && (hasRoutineChats || showRoutineChats) && <Chip label="Show routine chats" selected={showRoutineChats} onPress={toggleRoutineChats} />}
                    {sections && canChat && <Chip label="New section" icon={FolderPlus} onPress={() => newSection(prompt.ask)} />}
                  </View>
                }
              />
            )}
            {prompt.node}
          </View>
          {listPending ? (
            <View style={{ paddingVertical: 48, alignItems: "center" }}>
              <LoadingGrid label="Loading" />
            </View>
          ) : (
            <ChatListResults
              conversations={conversations}
              archived={archived}
              bots={bots}
              needle={deferredNeedle}
              picked={deferredPicked}
              sections={sections}
              unreadIds={unreadIds}
              runningIds={runningIds}
              showArchived={deferredShowArchived}
              setShowArchived={onToggleArchived}
              showRoutineChats={showRoutineChats}
              hasRoutineChats={hasRoutineChats}
              scroll={scroll}
              onDragging={setDragging}
            />
          )}
        </Animated.View>
      )}
    </ChatsFrame>
  );
  if (!split) return frame;
  // Half folded like a book, a chat in a project takes both pages (the chat, then its changes): the
  // list steps aside, as it does when the phone is closed.
  const paneChat = paneId ? chats.find((chat) => chat.id === paneId) : undefined;
  const bookChat = shape.pose === "book" && !listShown && !!paneChat?.projectId && !!projects?.find((project) => project.id === paneChat.projectId)?.folder;
  if (bookChat && paneId)
    return (
      <View style={{ flex: 1, paddingLeft: shape.left, paddingRight: shape.right, backgroundColor: colors.canvas }}>
        <ChatPane id={paneId} onLeave={() => useChatSplit.setState({ id: null })} onList={() => setListShown(true)} />
      </View>
    );
  const gap = foldGap(shape);
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.canvas }}>
      <View style={{ width: shape.left + listWidth(shape, width) }}>{frame}</View>
      {/* In book pose the fold is the gap between the pages; flat, a hairline. */}
      <View style={{ width: gap || StyleSheet.hairlineWidth, backgroundColor: gap ? colors.canvas : colors.line }} />
      <View style={{ flex: 1, paddingRight: shape.right }}>
        {paneId ? (
          <ChatPane id={paneId} onLeave={() => useChatSplit.setState({ id: null })} />
        ) : (
          <EmptyState art={<Mascot size={88} />} title="No chat open" />
        )}
      </View>
    </View>
  );
}

/** The Chats list holds its avatars still, in their state's pose (see `AvatarMotion`). */
export default function ChatList() {
  const ready = useTabReady();
  return <ChatListScreen ready={ready} />;
}
