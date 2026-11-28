// Project subpage: Chats (search, Active / This week / Earlier groups, 20-item paging,
// hold menu & swipe left to remove from project, + header button to add existing chats).
import { router, Stack, useLocalSearchParams } from "expo-router";
import { MessagesSquare, Plus } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { openChat } from "@/features/chat/navigate";
import type { Bot, ChatSummary, Project } from "@/link/types";
import { useBots, useChats, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { ago } from "@/state/time";
import {
  Badge,
  BotAvatar,
  Button,
  EmptyState,
  Field,
  Group,
  HoldMenu,
  IconButton,
  Label,
  Loading,
  Page,
  radius,
  Row,
  space,
  T,
} from "@/ui";
import { chatActiveStatus, groupProjectChats, PAGE_SIZE, projectChats } from "./logic";

function SwipeableProjectChatRow({
  chat,
  bot,
  project,
  status,
  revealed,
  onReveal,
  onRemove,
}: {
  chat: ChatSummary;
  bot?: Bot;
  project: Project;
  status: "needs-you" | "working" | null;
  revealed: boolean;
  onReveal: (open: boolean) => void;
  onRemove: () => void;
}) {
  const translateX = useSharedValue(0);
  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    onUpdate: (event) => {
      translateX.value = Math.max(-72, Math.min(0, event.translationX));
    },
    onDeactivate: (event) => {
      if (event.translationX < -36) onReveal(!revealed);
      translateX.value = withSpring(0, { damping: 20, stiffness: 280 });
    },
    onFinalize: () => {
      translateX.value = withSpring(0, { damping: 20, stiffness: 280 });
    },
  });
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const subtitle = [bot?.name, ago(chat.time)].filter(Boolean).join(" · ");
  const badge =
    status === "needs-you" ? (
      <Badge label="Needs you" tone="warning" />
    ) : status === "working" ? (
      <Badge label="Working" tone="accent" />
    ) : undefined;

  return (
    <HoldMenu
      actions={[{ id: "remove", title: "Remove from project", image: "folder.badge.minus" }]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "remove") onRemove();
      }}
    >
      <GestureDetector gesture={pan}>
        <Animated.View style={animatedStyle}>
          <Row
            leading={<BotAvatar bot={bot ?? { id: chat.botId }} size={36} badge={false} />}
            title={chat.title || bot?.name || "Chat"}
            subtitle={subtitle}
            trailing={
              revealed ? (
                <Button
                  title="Remove"
                  variant="danger"
                  size="sm"
                  style={{ borderRadius: radius.pill }}
                  onPress={onRemove}
                />
              ) : (
                badge
              )
            }
            chevron={!revealed}
            onPress={() => {
              if (revealed) {
                onReveal(false);
                return;
              }
              openChat(chat.id);
            }}
          />
        </Animated.View>
      </GestureDetector>
    </HoldMenu>
  );
}

export function ProjectChatsContent({ project }: { project: Project }) {
  const chats = useChats();
  const live = usePart("live");
  const allBots = useBots();
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [revealedId, setRevealedId] = useState<string | null>(null);

  const mine = useMemo(() => projectChats(chats, project.id), [chats, project.id]);
  const grouped = useMemo(
    () =>
      groupProjectChats(mine, live, {
        query,
        botName: (botId) => bots.get(botId)?.name,
        limit,
      }),
    [mine, live, query, bots, limit],
  );

  const openAdd = () => router.push({ pathname: "/projects/add-chats", params: { id: project.id } });

  const confirmRemoveChat = (chat: ChatSummary) => {
    const label = chat.title || bots.get(chat.botId)?.name || "this chat";
    Alert.alert(
      "Remove from " + project.name + "?",
      label + " stays in Chats, outside this project.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setRevealedId(null);
            void attempt(api.setChatProject(chat.id, null), "Removed from " + project.name);
          },
        },
      ],
    );
  };

  const caption =
    mine.length === 0
      ? "None in this project"
      : mine.length === 1
        ? "1 in this project"
        : `${mine.length} in this project`;

  return (
    <Page title="Chats" caption={caption} keyboard>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              icon={Plus}
              label="Add a chat"
              variant={hasBackdrop ? "glass" : "soft"}
              onPress={openAdd}
            />
          ),
        }}
      />

      {mine.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No chats in this project"
          text="Add an existing chat or start a new one with a bot."
          action="Add a chat"
          onAction={openAdd}
        />
      ) : (
        <View style={{ gap: space.lg }}>
          <Field
            placeholder="Search chats"
            accessibilityLabel="Search chats"
            value={query}
            onChangeText={(next) => {
              setQuery(next);
              setLimit(PAGE_SIZE);
            }}
            autoCorrect={false}
            returnKeyType="search"
          />

          {grouped.groups.length === 0 ? (
            <T variant="callout" color="muted" center style={{ paddingVertical: space.xl }}>
              No chats match.
            </T>
          ) : (
            grouped.groups.map((bucket) => (
              <View key={bucket.key}>
                <Label>{bucket.title}</Label>
                <Group inset={space.lg + 36 + space.md}>
                  {bucket.chats.map((chat) => (
                    <SwipeableProjectChatRow
                      key={chat.id}
                      chat={chat}
                      bot={bots.get(chat.botId)}
                      project={project}
                      status={chatActiveStatus(live, chat.id)}
                      revealed={revealedId === chat.id}
                      onReveal={(open) => setRevealedId(open ? chat.id : null)}
                      onRemove={() => confirmRemoveChat(chat)}
                    />
                  ))}
                </Group>
              </View>
            ))
          )}

          {grouped.older > 0 && (
            <Button
              title={`Show ${grouped.older} older`}
              variant="ghost"
              wide
              onPress={() => setLimit((prev) => prev + PAGE_SIZE)}
            />
          )}
        </View>
      )}

    </Page>
  );
}

export default function ProjectChatsPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useApp((state) => state.parts.projects?.find((item) => item.id === id));
  const synced = useApp((state) => state.synced);
  if (!project) {
    return (
      <Page>
        {synced ? <EmptyState title="This project is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}
      </Page>
    );
  }
  return <ProjectChatsContent project={project} />;
}
