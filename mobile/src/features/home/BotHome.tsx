// The first tab, where the app opens: the chat with the person's bot. It starts on the primary bot
// (the first in the computer's order) and stays with the one last chosen here (`prefs.homeBot`).
// Every other bot is one tap away in a row over the chat's title, each with what it is doing; the
// row's last button opens Home, the board of all of them. The chat is the bot's Main chat where the
// computer keeps one for each bot and person, otherwise its latest chat. A computer with no bots
// yet, or a person who may not chat, gets Home here. The plain logic is homeBot.ts.
import { LayoutList } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { openPlace } from "@/features/all/open";
import { ChatPane } from "@/features/chat/ChatScreen";
import { openChat } from "@/features/chat/navigate";
import { unreadBotIds } from "@/features/chat/unread";
import type { Bot } from "@/link/types";
import { activityLabel, useBotActivity, useBots, useCan, useCapability, useChats, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { setPrefs, usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { BackdropLayer, BotAvatar, Dot, EmptyState, IconButton, LinkBanner, Loading, space, Tap, useShape, useTheme } from "@/ui";
import Home from "./Home";
import { homeBots, homeChat, pickHomeBot } from "./homeBot";

const FACE = 36;
const stay = () => {};

/** One bot in the row: its face, still, with a ring when it is the one on show and a dot when it has something unread. */
function StripBot({ bot, chosen, unread, onPick }: { bot: Bot; chosen: boolean; unread: boolean; onPick: (id: string) => void }) {
  const { colors } = useTheme();
  const state = useBotActivity(bot.id);
  const status = activityLabel(state);
  return (
    <Tap
      onPress={() => onPick(bot.id)}
      feel="select"
      hitSlop={0}
      accessibilityLabel={bot.name + (status ? ", " + status : "") + (unread && !chosen ? ", unread" : "")}
      accessibilityState={{ selected: chosen }}
      style={{ width: FACE + 14, height: FACE + 14, alignItems: "center", justifyContent: "center" }}
    >
      {/* A chosen avatar gets a ring, not a fill. The row holds still: the chat's own header face is the one that moves. */}
      <View style={{ padding: 3, borderRadius: (FACE + 10) / 2, borderWidth: 2, borderColor: chosen ? colors.ink : "transparent" }}>
        <BotAvatar bot={bot} state={state} size={FACE} />
      </View>
      {unread && !chosen && (
        <View pointerEvents="none" style={{ position: "absolute", top: 3, right: 3 }}>
          <Dot size={8} />
        </View>
      )}
    </Tap>
  );
}

/** The bots, side by side, and the way to all of them. */
function BotStrip({ bots, chosen, unread, onPick }: { bots: Bot[]; chosen: string; unread: Set<string>; onPick: (id: string) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: space.md, gap: space.xs, alignItems: "center" }}>
      {bots.map((bot) => (
        <StripBot key={bot.id} bot={bot} chosen={bot.id === chosen} unread={unread.has(bot.id)} onPick={onPick} />
      ))}
      <IconButton icon={LayoutList} label="All bots" variant="soft" size={40} onPress={() => openPlace("home")} style={{ marginLeft: space.xs }} />
    </ScrollView>
  );
}

/** The tab's frame while there is no chat to show yet: beside the side rail, under the status bar, with the row of bots on top. */
function Waiting({ strip, children }: { strip?: ReactNode; children: ReactNode }) {
  const { colors } = useTheme();
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
  const insets = useSafeAreaInsets();
  const shape = useShape();
  return (
    <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas, paddingLeft: shape.left, paddingRight: shape.right, paddingTop: insets.top + space.xs }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      {strip}
      <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
        <LinkBanner />
      </View>
      <View style={{ flex: 1, justifyContent: "center", paddingBottom: shape.tabRoom }}>{children}</View>
    </View>
  );
}

export default function BotHome() {
  const { colors } = useTheme();
  const shape = useShape();
  const synced = useApp((state) => state.synced);
  const bots = useBots();
  const chats = useChats();
  const canChat = useCan("agents", "chat");
  const online = useOnline();
  const main = useCapability("main-chat-v1");
  const person = useApp((state) => (state.parts.meta?.you?.kind === "member" ? state.parts.meta.you.memberId : "owner"));
  const saved = usePrefs((prefs) => prefs.homeBot);
  const shown = useMemo(() => homeBots(bots), [bots]);
  const unread = useMemo(() => unreadBotIds(chats), [chats]);
  const bot = pickHomeBot(shown, saved);
  const botId = bot?.id;
  const want = botId && canChat ? homeChat(chats, botId, main, person) : undefined;
  const chatId = want && "id" in want ? want.id : undefined;
  const make = want && "make" in want ? want.make : undefined;

  // A Main chat that isn't there yet is the computer's to make, once for each bot; it arrives by itself.
  const asked = useRef(new Set<string>());
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!botId || make !== "main" || !online || asked.current.has(botId)) return;
    asked.current.add(botId);
    api.mainChat(botId).catch(() => {
      asked.current.delete(botId);
      setFailed(botId);
    });
  }, [botId, make, online]);

  if (!synced)
    return (
      <Waiting>
        <Loading />
      </Waiting>
    );
  // No bots yet, or a role that may not chat: Home has the first steps and the bots' pages.
  if (!bot || !canChat) return <Home />;

  const strip = shown.length > 1 ? <BotStrip bots={shown} chosen={bot.id} unread={unread} onPick={(id) => setPrefs({ homeBot: id })} /> : undefined;
  if (chatId)
    return (
      <View style={{ flex: 1, paddingLeft: shape.left, paddingRight: shape.right, backgroundColor: colors.canvas }}>
        <ChatPane id={chatId} onLeave={stay} above={strip} onOpen={openChat} />
      </View>
    );
  if (make === "ask")
    return (
      <Waiting strip={strip}>
        <EmptyState art={<BotAvatar bot={bot} size={96} />} title={bot.name} text="No chat yet." action="Start a chat" onAction={() => void attempt(api.createChat(bot.id))} />
      </Waiting>
    );
  if (failed === bot.id)
    return (
      <Waiting strip={strip}>
        <EmptyState
          art={<BotAvatar bot={bot} size={96} />}
          title={bot.name}
          text="Couldn't open this chat."
          action="Try again"
          onAction={() => {
            setFailed(null);
            asked.current.delete(bot.id);
            void attempt(api.mainChat(bot.id));
          }}
        />
      </Waiting>
    );
  return (
    <Waiting strip={strip}>
      <Loading />
    </Waiting>
  );
}
