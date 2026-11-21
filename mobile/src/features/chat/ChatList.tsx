import { router } from "expo-router";
import { Archive, FolderPlus, Search, SquarePen, X } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { TextInput, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BoardScroll } from "@/features/home/BotBoard";
import type { ChatSummary } from "@/link/types";
import { isConversation, useBots, useCan, useCapability, useChats, usePart } from "@/state/hooks";
import { useApp } from "@/state/store";
import { Chip, EmptyState, IconButton, LinkBanner, Mascot, radius, space, T, TAB_BAR_ROOM, Tap, useTheme } from "@/ui";
import { ChatBoard } from "./ChatBoard";
import { newSection } from "./sectionMenus";

const isArchivedConversation = (chat: ChatSummary) => !!chat.archived && !chat.panelId && !chat.schedules?.some((schedule) => schedule.routine);

function SearchField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const { colors, dark, type, control } = useTheme();
  return (
    <View style={{ height: control.field, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }}>
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
    </View>
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
function ChatsFrame({ children, scroll, scrollEnabled, actions }: { children: ReactNode; scroll: BoardScroll; scrollEnabled: boolean; actions?: ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const view = useSharedValue(0);
  const content = useSharedValue(0);
  const { edges, offset, max } = scroll;
  useEffect(() => {
    edges.value = { top: insets.top, bottom: height - TAB_BAR_ROOM - insets.bottom };
  }, [edges, insets.top, insets.bottom, height]);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.value = event.contentOffset.y;
    },
  });
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Animated.ScrollView
        ref={scroll.ref}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: insets.top + space.md, paddingBottom: TAB_BAR_ROOM + insets.bottom + space.xxl, gap: space.xl }}
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

export default function ChatList() {
  const { colors } = useTheme();
  const chats = useChats();
  const allBots = useBots();
  const synced = useApp((state) => state.synced);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const canChat = useCan("agents", "chat");
  // The person's own sections ("chat-sections-v1"). Without them the list is as it always was.
  const filing = useCapability("chat-sections-v1");
  const held = usePart("chatSections");
  const sections = filing ? (held ?? []) : undefined;

  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const conversations = useMemo(() => chats.filter(isConversation), [chats]);
  const archived = useMemo(() => chats.filter(isArchivedConversation), [chats]);
  const needle = query.trim().toLowerCase();
  const { shown, old } = useMemo(() => {
    const matches = (chat: ChatSummary) => {
      if (!needle) return true;
      const names = (chat.botIds ?? [chat.botId]).map((id) => bots.get(id)?.name ?? "").join(" ");
      return (chat.title + " " + names + " " + (chat.last?.text ?? "")).toLowerCase().includes(needle);
    };
    return { shown: conversations.filter(matches), old: showArchived ? archived.filter(matches) : [] };
  }, [conversations, archived, bots, needle, showArchived]);

  // The page, for scrolling it under a dragged chat; and whether a drag is under way, which stops its own scrolling.
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: 0, bottom: 0 }) };
  const [dragging, setDragging] = useState(false);
  const empty = synced && conversations.length === 0 && archived.length === 0;
  const nothing = shown.length === 0 && old.length === 0 && (!!needle || !sections?.length);

  return (
    <ChatsFrame scroll={scroll} scrollEnabled={!dragging} actions={canChat ? <IconButton icon={SquarePen} label="New chat" variant="accent" size={44} onPress={() => router.push("/chat/new")} /> : undefined}>
      {!synced ? (
        <Skeleton />
      ) : empty ? (
        <EmptyState art={<Mascot size={104} />} title="No chats yet" action={canChat ? "New chat" : undefined} onAction={canChat ? () => router.push("/chat/new") : undefined} />
      ) : (
        <Animated.View entering={FadeIn.duration(220)} style={{ gap: space.md }}>
          <View style={{ gap: space.md }}>
            <SearchField value={query} onChange={setQuery} />
            {(archived.length > 0 || (sections && canChat)) && (
              <View style={{ flexDirection: "row", gap: space.sm }}>
                {sections && canChat && <Chip label="New section" icon={FolderPlus} onPress={() => newSection()} />}
                {archived.length > 0 && <Chip label={showArchived ? "Hide archived" : "Show archived"} icon={Archive} selected={showArchived} onPress={() => setShowArchived(!showArchived)} />}
              </View>
            )}
          </View>
          {nothing ? (
            <View style={{ alignItems: "center", paddingVertical: space.huge, gap: space.sm }}>
              <Search size={26} color={colors.faint} strokeWidth={2} />
              <T variant="callout" color="muted">
                {needle ? "No matches" : "No chats"}
              </T>
            </View>
          ) : (
            <ChatBoard chats={shown} archived={old} sections={sections} bots={bots} searching={!!needle} scroll={scroll} onDragging={setDragging} />
          )}
        </Animated.View>
      )}
    </ChatsFrame>
  );
}
