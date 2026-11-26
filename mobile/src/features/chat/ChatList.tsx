// The Chats tab: search, chips for every chat, the unread ones or one of the person's sections, the
// pinned chats as a row of faces, then one list of the rest, newest first ("Recent"), and the
// archived ones behind a row at the end. A held chat can still be dragged onto Pinned or a section,
// which show above the list while it moves (ChatBoard, `arrangeChatsFlat` in sections.ts).
import { MenuView } from "@react-native-menu/menu";
import { router, useIsFocused, useScrollToTop } from "expo-router";
import { Archive, ChevronDown, ChevronUp, Ellipsis, FolderPlus, Search, SquarePen, X } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BoardScroll } from "@/features/home/BotBoard";
import type { Bot, ChatSummary } from "@/link/types";
import { activityLabel, isConversation, useBots, useCan, useCapability, useChatActivity, useChats, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { BackdropLayer, BotAvatar, Chip, EmptyState, foldGap, Glass, Group, HoldMenu, IconButton, IconTile, LinkBanner, listWidth, Mascot, radius, Row, space, T, Tap, tint, useShape, useTextPrompt, useTheme } from "@/ui";
import { GroupFace } from "./bits";
import { ChatBoard } from "./ChatBoard";
import { ChatPane } from "./ChatScreen";
import { openChat } from "./navigate";
import { markChatsPageRead } from "./open";
import { openFromList, useChatSplit } from "./split";
import { newSection } from "./sectionMenus";
import { chatChips, type ChatFilter, chatsForFilter } from "./sections";
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
function PinnedChat({ chat, bots }: { chat: ChatSummary; bots: Map<string, Bot> }) {
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
        <Tap onPress={() => openFromList(chat.id)} feel="select" sink={0.94} accessibilityLabel={title + (live ? ", " + live : "") + (chat.unread ? ", unread" : "") + ", pinned"} accessibilityHint={canChat ? "Long press to unpin" : undefined} style={{ alignItems: "center", gap: 6, paddingHorizontal: space.xs, maxWidth: "100%" }}>
          {group ? <GroupFace bots={chat.botIds!.slice(0, 2).map((id) => bots.get(id))} size={56} state={state} /> : <BotAvatar bot={bot} size={56} state={state} />}
          <T variant="footnote" weight={chat.unread ? "700" : "600"} color="ink2" numberOfLines={1} center>
            {title}
          </T>
        </Tap>
      </HoldMenu>
    </View>
  );
}

/** The ⋯ beside New chat: Mark all as read, and New section. Nothing when neither applies. */
function MoreMenu({ unread, filing, onNewSection }: { unread: boolean; filing: boolean; onNewSection: () => void }) {
  const { colors, dark } = useTheme();
  const actions = [
    ...(unread ? [{ id: "read", title: "Mark all as read", image: "envelope.open" }] : []),
    ...(filing ? [{ id: "section", title: "New section…", image: "folder.badge.plus" }] : []),
  ];
  if (!actions.length) return null;
  return (
    <MenuView title="Chats" actions={actions} onPressAction={({ nativeEvent }) => (nativeEvent.event === "read" ? void markChatsPageRead() : onNewSection())}>
      <View accessible accessibilityRole="button" accessibilityLabel="More" style={{ width: 44, height: 44 }}>
        <Glass interactive tintColor={tint(colors.surface, dark ? 0.28 : 0.42)} style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" }}>
          <Ellipsis size={20} color={colors.ink} strokeWidth={2.2} />
        </Glass>
      </View>
    </MenuView>
  );
}

function Skeleton() {
  const { colors } = useTheme();
  return (
    <View accessibilityLabel="Loading chats">
      {[0, 1, 2, 3, 4].map((row) => (
        <View key={row} style={{ height: 72, flexDirection: "row", alignItems: "center", gap: space.md }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.sunken }} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ width: "45%", height: 13, borderRadius: 6, backgroundColor: colors.sunken }} />
            <View style={{ width: "75%", height: 11, borderRadius: 6, backgroundColor: colors.sunken }} />
          </View>
        </View>
      ))}
    </View>
  );
}

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

function ChatListScreen() {
  const { colors } = useTheme();
  const prompt = useTextPrompt();
  const chats = useChats();
  const allBots = useBots();
  const synced = useApp((state) => state.synced);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const canView = useCan("agents", "view");
  const canChat = useCan("agents", "chat");
  // The person's own sections ("chat-sections-v1"). Without them the list is as it always was.
  const filing = useCapability("chat-sections-v1");
  const held = usePart("chatSections");
  const sections = filing ? (held ?? []) : undefined;

  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const conversations = useMemo(() => chats.filter(isChatsPageChat), [chats]);
  const archived = useMemo(() => chats.filter(isChatsPageArchived), [chats]);
  const unreadIds = useMemo(() => new Set(chatsPageUnreadChats(chats).map((chat) => chat.id)), [chats]);
  const unreadCount = unreadIds.size;
  const needle = query.trim().toLowerCase();
  // A chip for a section that is gone goes back to every chat.
  const picked = filter.startsWith("section:") && !sections?.some((section) => "section:" + section.id === filter) ? "all" : filter;
  const { shown, old } = useMemo(() => {
    const matches = (chat: ChatSummary) => {
      if (!needle) return true;
      const names = (chat.botIds ?? [chat.botId]).map((id) => bots.get(id)?.name ?? "").join(" ");
      return (chat.title + " " + names + " " + (chat.last?.text ?? "")).toLowerCase().includes(needle);
    };
    return { shown: chatsForFilter(conversations, picked, sections, unreadIds).filter(matches), old: showArchived ? archived.filter(matches) : [] };
  }, [conversations, archived, bots, needle, showArchived, picked, sections, unreadIds]);
  const pinned = useMemo(() => shown.filter((chat) => chat.pinned).sort((a, b) => b.time - a.time), [shown]);
  const chips = chatChips(sections, unreadCount, canView);

  // The page, for scrolling it under a dragged chat; and whether a drag is under way, which stops its own scrolling.
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: 0, bottom: 0 }) };
  const [dragging, setDragging] = useState(false);
  const empty = synced && conversations.length === 0 && archived.length === 0;
  const nothing = shown.length === 0 && old.length === 0;

  // With room for two panes (iPhone Duo opened, an iPad) the chosen chat opens beside the list.
  const shape = useShape();
  const { width } = useWindowDimensions();
  const split = shape.wide;
  const pickedId = useChatSplit((state) => state.id);
  const projects = usePart("projects");
  // In book pose the list can be asked back; picking a chat in it gives the pages to that chat again.
  const [listShown, setListShown] = useState(false);
  const taps = useChatSplit((state) => state.taps);
  useEffect(() => {
    setListShown(false);
  }, [pickedId, taps, shape.pose]);
  // A chat just made or forked beside the list stays picked while the list catches up with it.
  const paneId = pickedId ?? (split ? (shown[0]?.id ?? null) : null);
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
          <MoreMenu unread={unreadCount > 0 && canView} filing={!!sections && canChat} onNewSection={() => newSection(prompt.ask)} />
          {canChat && <IconButton icon={SquarePen} label="New chat" variant="accent" size={44} onPress={() => router.push("/chat/new")} />}
        </>
      }
    >
      {!synced ? (
        <Skeleton />
      ) : empty ? (
        <EmptyState art={<Mascot size={104} />} title="No chats yet" action={canChat ? "New chat" : undefined} onAction={canChat ? () => router.push("/chat/new") : undefined} />
      ) : (
        <Animated.View entering={FadeIn.duration(220)} style={{ gap: space.md }}>
          <View style={{ gap: space.md }}>
            <SearchField value={query} onChange={setQuery} />
            {(chips.length > 1 || (sections && canChat)) && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
                {chips.map((chip) => (
                  <Chip key={chip.value} label={chip.count ? chip.label + " · " + chip.count : chip.label} selected={picked === chip.value} onPress={() => setFilter(chip.value)} />
                ))}
                {sections && canChat && <Chip label="New section" icon={FolderPlus} onPress={() => newSection(prompt.ask)} />}
              </ScrollView>
            )}
            {prompt.node}
          </View>
          {pinned.length > 0 && <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: space.lg, marginHorizontal: -space.xs, paddingTop: space.xs }}>{pinned.map((chat) => <PinnedChat key={chat.id} chat={chat} bots={bots} />)}</View>}
          {nothing ? (
            <View style={{ alignItems: "center", paddingVertical: space.huge, gap: space.sm }}>
              <Search size={26} color={colors.faint} strokeWidth={2} />
              <T variant="callout" color="muted">
                {needle ? "No matches" : picked === "unread" ? "No unread chats" : picked === "all" ? "No chats" : "No chats here yet"}
              </T>
            </View>
          ) : (
            <ChatBoard chats={shown} archived={old} sections={sections} bots={bots} searching={!!needle} scroll={scroll} onDragging={setDragging} flat />
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
  return <ChatListScreen />;
}
