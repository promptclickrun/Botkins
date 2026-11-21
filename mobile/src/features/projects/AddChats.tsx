// "Add a chat…" on a project's page (the sheet "Add chats"): pick chats that are not in the project yet. A chat in
// another project says so and moves when it is added. The words are the desktop app's.
import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useBots, useChats, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { BotAvatar, Button, EmptyState, Field, Group, Row, Sheet, space, T } from "@/ui";
import { addableChats } from "./logic";

export default function AddChats() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projects = usePart("projects");
  const project = projects?.find((item) => item.id === id);
  const chats = useChats();
  const allBots = useBots();
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const all = useMemo(() => (project ? addableChats(chats, project, projects ?? []) : []), [chats, project, projects]);
  const shown = useMemo(() => (project ? addableChats(chats, project, projects ?? [], query, (botId) => bots.get(botId)?.name) : []), [chats, project, projects, query, bots]);

  if (!project)
    return (
      <Sheet title="Add chats">
        <EmptyState title="This project is gone" />
      </Sheet>
    );
  const add = async (chatId: string) => {
    if (adding) return;
    setAdding(chatId);
    // The computer says why when a chat can't move (it started in another folder, or its bot has no access).
    await attempt(api.setChatProject(chatId, project.id, "default"), "Added to " + project.name);
    setAdding(null);
  };
  return (
    <Sheet title="Add chats">
      {all.length === 0 ? (
        <EmptyState title="There are no other chats to add." />
      ) : (
        <View style={{ gap: space.lg }}>
          <Field placeholder="Search chats" accessibilityLabel="Search chats" value={query} onChangeText={setQuery} autoCorrect={false} returnKeyType="search" />
          {shown.length === 0 ? (
            <T variant="callout" color="muted" center style={{ paddingVertical: space.xl }}>
              No chats match.
            </T>
          ) : (
            <Group>
              {shown.map(({ chat, inProject }) => {
                const bot = bots.get(chat.botId);
                return (
                  <Row
                    key={chat.id}
                    leading={<BotAvatar bot={bot ?? { id: chat.botId }} size={36} badge={false} />}
                    title={chat.title || bot?.name || "Chat"}
                    subtitle={inProject ? "In " + inProject : bot?.name}
                    trailing={<Button title="Add" size="sm" variant="secondary" loading={adding === chat.id} disabled={!!adding && adding !== chat.id} onPress={() => void add(chat.id)} />}
                  />
                );
              })}
            </Group>
          )}
        </View>
      )}
    </Sheet>
  );
}
