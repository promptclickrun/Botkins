import { useMemo } from "react";
import { FlatList, View } from "react-native";
import { useChatPrefs } from "@/state/chatPrefs";
import { loadEarlier } from "@/state/link";
import type { ChatView } from "@/state/store";
import { Markdown, space } from "@/ui";
import { UserBubble } from "../chat/Messages";
import { selectionEnds } from "../chat/selecting";
import { type SpokenLine, voiceCanvas } from "./live/history";

export function VoiceCanvas({ chatId, chat, spoken }: { chatId: string; chat?: ChatView; spoken: SpokenLine[] }) {
  const timestamps = useChatPrefs(state => state.timestamps);
  const markdown = useChatPrefs(state => state.markdown);
  const rows = useMemo(() => voiceCanvas(chat?.messages ?? [], chat?.from ?? 0, spoken), [chat, spoken]);
  return (
    <View style={{ flex: 1 }} {...selectionEnds}>
      <FlatList
        accessibilityLabel="Chat history"
        inverted
        data={rows}
        keyExtractor={row => row.key}
        renderItem={({ item }) => item.message.role === "user" ? (
          <UserBubble id={chatId + ":" + item.key} index={item.index} message={item.message} timestamps={timestamps} media={[]} />
        ) : (
          <Markdown text={item.message.text} plain={!markdown || item.message.role === "command"} />
        )}
        contentContainerStyle={{ paddingVertical: space.md, gap: space.md }}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
        onEndReached={() => { if (chat?.from && !chat.loadingEarlier) void loadEarlier(chatId); }}
      />
    </View>
  );
}
