import { router } from "expo-router";
import { Archive, Search, SquarePen, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { Bot, ChatSummary } from "@/link/types";
import { activityLabel, isConversation, useBots, useCan, useChatActivity, useChats } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { ago, dayBucket } from "@/state/time";
import { BotAvatar, Chip, Dot, EmptyState, HoldMenu, IconButton, Label, Mascot, Page, radius, space, T, Tap, useTheme } from "@/ui";
import { GroupFace, plainPreview } from "./bits";

const isArchivedConversation = (chat: ChatSummary) => !!chat.archived && !chat.panelId && !chat.schedules?.some((schedule) => schedule.routine);

function remove(chat: ChatSummary) {
  Alert.alert("Delete this chat?", chat.title, [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: () => void attempt(api.deleteChat(chat.id)) },
  ]);
}

function rename(chat: ChatSummary) {
  Alert.prompt(
    "Rename chat",
    undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Rename",
        onPress: (value?: string) => {
          const title = value?.trim().slice(0, 120);
          if (title && title !== chat.title) void attempt(api.renameChat(chat.id, title));
        },
      },
    ],
    "plain-text",
    chat.title,
  );
}

function ChatRow({ chat, bots }: { chat: ChatSummary; bots: Map<string, Bot> }) {
  const state = useChatActivity(chat.id);
  const bot = bots.get(chat.botId);
  const live = activityLabel(state);
  const group = chat.botIds && chat.botIds.length > 1;
  const canChat = useCan("agents", "chat");
  const speaker = chat.last?.role === "user" ? "You" : group && chat.last?.botId ? bots.get(chat.last.botId)?.name : undefined;
  const preview = chat.last ? (speaker ? speaker + ": " : "") + plainPreview(chat.last.text) : "No messages yet";
  const title = chat.title || bot?.name || "Chat";
  const actions = chat.archived
    ? [
        { id: "restore", title: "Restore", image: "tray.and.arrow.up" },
        { id: "rename", title: "Rename…", image: "pencil" },
        { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
      ]
    : [
        { id: "pin", title: chat.pinned ? "Unpin" : "Pin", image: chat.pinned ? "pin.slash" : "pin" },
        { id: "unread", title: chat.unread ? "Mark as read" : "Mark as unread", image: chat.unread ? "envelope.open" : "envelope.badge" },
        { id: "rename", title: "Rename…", image: "pencil" },
        { id: "archive", title: "Archive", image: "archivebox" },
        { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
      ];
  return (
    <HoldMenu
      actions={canChat ? actions : []}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (action === "pin") void attempt(api.setChatFlags(chat.id, { pinned: !chat.pinned }));
        else if (action === "unread") void attempt(api.setChatFlags(chat.id, { unread: !chat.unread }));
        else if (action === "archive") void attempt(api.setChatFlags(chat.id, { archived: true }), "Archived");
        else if (action === "restore") void attempt(api.setChatFlags(chat.id, { archived: false }), "Restored");
        else if (action === "rename") rename(chat);
        else if (action === "delete") remove(chat);
      }}
    >
      <Tap
        onPress={() => router.push({ pathname: "/chat/[id]", params: { id: chat.id } })}
        sink={1}
        feel="select"
        hitSlop={0}
        accessibilityLabel={title + ", " + (live || preview) + (chat.unread ? ", unread" : "")}
        accessibilityHint="Long press for more"
      >
        <View style={{ minHeight: 72, paddingVertical: space.md, flexDirection: "row", alignItems: "center", gap: space.md }}>
          {group ? (
            <GroupFace bots={chat.botIds!.slice(0, 2).map((id) => bots.get(id))} size={48} state={state} />
          ) : (
            <BotAvatar bot={bot} size={48} state={state} />
          )}
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <T variant="callout" weight={chat.unread ? "700" : "600"} numberOfLines={1} style={{ flex: 1 }}>
                {title}
              </T>
              <T variant="footnote" color={chat.unread ? "accentText" : "faint"} weight={chat.unread ? "600" : "400"}>
                {ago(chat.time)}
              </T>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              {live ? (
                <T variant="subhead" weight="600" color={state === "waiting" ? "warning" : "accentText"} numberOfLines={1} style={{ flex: 1 }}>
                  {live}
                </T>
              ) : (
                <T variant="subhead" color={chat.unread ? "ink2" : "muted"} numberOfLines={1} style={{ flex: 1 }}>
                  {preview}
                </T>
              )}
              {chat.unread && <Dot size={9} />}
            </View>
          </View>
        </View>
      </Tap>
    </HoldMenu>
  );
}

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

type Section = { title: string; chats: ChatSummary[] };

export default function ChatList() {
  const { colors } = useTheme();
  const chats = useChats();
  const allBots = useBots();
  const synced = useApp((state) => state.synced);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const canChat = useCan("agents", "chat");

  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const conversations = useMemo(() => chats.filter(isConversation), [chats]);
  const archived = useMemo(() => chats.filter(isArchivedConversation), [chats]);

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (chat: ChatSummary) => {
      if (!needle) return true;
      const names = (chat.botIds ?? [chat.botId]).map((id) => bots.get(id)?.name ?? "").join(" ");
      return (chat.title + " " + names + " " + (chat.last?.text ?? "")).toLowerCase().includes(needle);
    };
    const newest = (list: ChatSummary[]) => list.filter(matches).sort((a, b) => b.time - a.time);
    const out: Section[] = [];
    const shown = newest(conversations);
    const pinned = shown.filter((chat) => chat.pinned);
    if (pinned.length) out.push({ title: "Pinned", chats: pinned });
    for (const bucket of ["Today", "Yesterday", "Earlier"] as const) {
      const list = shown.filter((chat) => !chat.pinned && dayBucket(chat.time) === bucket);
      if (list.length) out.push({ title: bucket, chats: list });
    }
    if (showArchived) {
      const list = newest(archived);
      if (list.length) out.push({ title: "Archived", chats: list });
    }
    return out;
  }, [conversations, archived, bots, query, showArchived]);

  const empty = synced && conversations.length === 0 && archived.length === 0;

  return (
    <Page tab title="Chats" actions={canChat ? <IconButton icon={SquarePen} label="New chat" variant="accent" size={44} onPress={() => router.push("/chat/new")} /> : undefined}>
      {!synced ? (
        <Skeleton />
      ) : empty ? (
        <EmptyState art={<Mascot size={104} />} title="No chats yet" action={canChat ? "New chat" : undefined} onAction={canChat ? () => router.push("/chat/new") : undefined} />
      ) : (
        <Animated.View entering={FadeIn.duration(220)} style={{ gap: space.xl }}>
          <View style={{ gap: space.md }}>
            <SearchField value={query} onChange={setQuery} />
            {archived.length > 0 && (
              <View style={{ flexDirection: "row" }}>
                <Chip label={showArchived ? "Hide archived" : "Show archived"} icon={Archive} selected={showArchived} onPress={() => setShowArchived(!showArchived)} />
              </View>
            )}
          </View>
          {sections.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: space.huge, gap: space.sm }}>
              <Search size={26} color={colors.faint} strokeWidth={2} />
              <T variant="callout" color="muted">
                {query.trim() ? "No matches" : "No chats"}
              </T>
            </View>
          ) : (
            sections.map((section) => (
              <View key={section.title}>
                <Label style={{ marginBottom: 0 }}>{section.title}</Label>
                {section.chats.map((chat) => (
                  <ChatRow key={chat.id} chat={chat} bots={bots} />
                ))}
              </View>
            ))
          )}
        </Animated.View>
      )}
    </Page>
  );
}
