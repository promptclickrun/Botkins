// "People in this chat" ("team-people-v1"), opened by "Invite" in a chat's menu. A chat's replies
// and questions go only to its people: who started it, and who was invited here. The chat's starter
// and the owner invite and remove; someone invited can leave. The words are the desktop app's.
import { router, useLocalSearchParams } from "expo-router";
import { LogOut, User, UserCheck } from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import { useCapability, useChat, useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, EmptyState, Group, IconTile, Label, Row, Sheet, space, T, useTheme } from "@/ui";
import { myPlace, myself, peopleRows } from "./people";

export default function People() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const chat = useChat(id);
  const capable = useCapability("team-people-v1");
  const online = useOnline();
  const meta = usePart("meta");
  const team = usePart("team");
  const people = team?.people ?? [];
  const [busy, setBusy] = useState<string | null>(null);

  if (!chat || !capable)
    return (
      <Sheet title="People in this chat">
        <EmptyState title={chat ? "Update the app on your computer" : "This chat is gone"} />
      </Sheet>
    );
  const me = myself(meta);
  const place = myPlace(chat, me);
  const rows = peopleRows(people, chat, me);
  const change = async (personId: string, invite: boolean) => {
    if (busy) return;
    setBusy(personId);
    await attempt(invite ? api["link.team.inviteToChat"](chat.id, personId) : api["link.team.removeFromChat"](chat.id, personId));
    setBusy(null);
  };
  const leave = () =>
    Alert.alert("Leave this chat?", "It leaves your chats, and you stop hearing of its replies.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave chat",
        style: "destructive",
        onPress: async () => {
          const left = await attempt(api["link.team.removeFromChat"](chat.id, me).then(() => true));
          if (left) router.dismissTo("/chats");
        },
      },
    ]);
  const inChat = rows.filter((row) => row.place !== "out");
  const others = rows.filter((row) => row.place === "out");
  return (
    <Sheet title="People in this chat">
      <T variant="callout" color="muted">
        Only the people in a chat see it and hear of its replies.
      </T>
      <View>
        <Label>In this chat</Label>
        <Group>
          {inChat.map((row) => (
            <Row
              key={row.id}
              leading={<IconTile icon={UserCheck} color={colors.ink2} />}
              title={row.name}
              subtitle={row.note}
              {...(place === "manages" && row.place === "invited" && { toggled: true, disabled: !online || busy === row.id, onToggle: () => void change(row.id, false) })}
            />
          ))}
        </Group>
      </View>
      {place === "manages" && others.length > 0 && (
        <View>
          <Label>Invite</Label>
          <Group>
            {others.map((row) => (
              <Row key={row.id} leading={<IconTile icon={User} color={colors.ink2} />} title={row.name} subtitle={row.note} toggled={false} disabled={!online || busy === row.id} onToggle={() => void change(row.id, true)} />
            ))}
          </Group>
        </View>
      )}
      {place === "manages" && others.length === 0 && inChat.length <= 1 && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          There is nobody else on the team yet. Invite people in Settings › Team.
        </T>
      )}
      {place === "invited" && <Button title="Leave chat" icon={LogOut} variant="secondary" wide disabled={!online} onPress={leave} />}
    </Sheet>
  );
}
