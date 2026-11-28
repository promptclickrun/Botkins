// The first tab, where the app opens: the chat with the person's bot. It starts on the primary bot
// (the first in the computer's order) and stays with the one last chosen here (`prefs.homeBot`).
// Every other bot is one tap away in a row over the chat's title, each with what it is doing; the
// row's last button opens Home, the board of all of them. The chat is the bot's Main chat where the
// computer keeps one for each bot and person, otherwise its latest chat. A computer with no bots
// yet, or a person who may not chat, gets Home here. The plain logic is homeBot.ts.
import { LayoutList } from "lucide-react-native";
import { type ComponentRef, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
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
import { BackdropLayer, BotAvatar, Dot, EmptyState, IconButton, LinkBanner, Loading, space, T, Tap, useShape, useTheme } from "@/ui";
import Home from "./Home";
import { homeBots, homeChat, pickHomeBot } from "./homeBot";

// The chosen bot is large and in the middle; the others sit small on either side, and a swipe or a
// tap brings one to the middle (the agreed mock, 2026-11-28).
const FACE = 34;
const BIG = 64;
const SLOT = 64;
const stay = () => {};

/** One bot in the row: small and quiet at the side, large in the middle when it is the one on show, with a dot when it has something unread. */
function StripBot({ bot, chosen, unread, onPick }: { bot: Bot; chosen: boolean; unread: boolean; onPick: (id: string) => void }) {
  const state = useBotActivity(bot.id);
  const status = activityLabel(state);
  return (
    <Tap
      onPress={() => onPick(bot.id)}
      feel="select"
      hitSlop={0}
      accessibilityLabel={bot.name + (status ? ", " + status : "") + (unread && !chosen ? ", unread" : "")}
      accessibilityState={{ selected: chosen }}
      style={{ width: SLOT, height: BIG + space.xs, alignItems: "center", justifyContent: "center", opacity: chosen ? 1 : 0.7 }}
    >
      <BotAvatar bot={bot} state={chosen ? state : "idle"} size={chosen ? BIG : FACE} />
      {unread && !chosen && (
        <View pointerEvents="none" style={{ position: "absolute", top: (BIG - FACE) / 2, right: (SLOT - FACE) / 2 - 2 }}>
          <Dot size={8} />
        </View>
      )}
    </Tap>
  );
}

/** The bots as a carousel: the chosen one centered, a swipe settles on the bot in the middle, and the way to all of them. */
function BotStrip({ bots, chosen, unread, onPick }: { bots: Bot[]; chosen: string; unread: Set<string>; onPick: (id: string) => void }) {
  const shape = useShape();
  const { width: screen } = useWindowDimensions();
  const width = screen - shape.left - shape.right;
  // Room on each end so the first and the last bot can sit in the middle too.
  const side = Math.max(0, (width - SLOT) / 2);
  const index = Math.max(0, bots.findIndex((bot) => bot.id === chosen));
  const row = useRef<ComponentRef<typeof ScrollView>>(null);
  const laidOut = useRef(false);
  // A new choice (a tap, the bot remembered, a bot added) scrolls the chosen one to the middle.
  useEffect(() => {
    row.current?.scrollTo({ x: index * SLOT, animated: laidOut.current });
  }, [index, width]);
  const settle = (x: number) => {
    const next = bots[Math.min(bots.length - 1, Math.max(0, Math.round(x / SLOT)))];
    if (next && next.id !== chosen) onPick(next.id);
  };
  return (
    <View style={{ height: BIG + space.sm, justifyContent: "center" }}>
      <ScrollView
        ref={row}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        snapToInterval={SLOT}
        decelerationRate="fast"
        onLayout={() => {
          row.current?.scrollTo({ x: index * SLOT, animated: false });
          laidOut.current = true;
        }}
        onMomentumScrollEnd={(event) => settle(event.nativeEvent.contentOffset.x)}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: side, alignItems: "center" }}
      >
        {bots.map((bot) => (
          <StripBot key={bot.id} bot={bot} chosen={bot.id === chosen} unread={unread.has(bot.id)} onPick={onPick} />
        ))}
      </ScrollView>
      <IconButton icon={LayoutList} label="All bots" variant="soft" size={40} onPress={() => openPlace("home")} style={{ position: "absolute", left: space.md }} />
    </View>
  );
}

/** The chosen bot's name and role in a pill under the row, as in the agreed mock. */
function ChosenPill({ bot }: { bot: Bot }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: "center", paddingBottom: space.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: "80%", paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: 999, borderWidth: 1, borderColor: colors.line }}>
        <T variant="headline" numberOfLines={1}>{bot.name}</T>
        {!!bot.role && <T variant="subhead" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{bot.role}</T>}
      </View>
    </View>
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

  const strip = shown.length > 1 ? (
    <>
      <BotStrip bots={shown} chosen={bot.id} unread={unread} onPick={(id) => setPrefs({ homeBot: id })} />
      <ChosenPill bot={bot} />
    </>
  ) : undefined;
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
