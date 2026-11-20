import { MenuView } from "@react-native-menu/menu";
import { type Href, router, Stack, useLocalSearchParams } from "expo-router";
import { ChevronRight, Ellipsis, Repeat, X } from "lucide-react-native";
import { type ComponentRef, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Platform, ScrollView, type TextInput, useWindowDimensions, View } from "react-native";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { FadeIn, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Bot, ChatSummary, Preferences, Project, QueuedMessage } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { activityLabel, type AvatarState, useBot, useBots, useCan, useCapability, useChat, useChatActivity, useModels, usePart, useSettings, useWatchedChat } from "@/state/hooks";
import { api, attempt, loadEarlier } from "@/state/link";
import { effectiveModel, effortLabel, findModel, modelName } from "@/state/models";
import { showToast, useApp } from "@/state/store";
import { useTurnMarks } from "@/state/turnMarks";
import { BotAvatar, Chip, EmptyState, LinkBanner, Loading, radius, space, T, Tap, useTheme } from "@/ui";
import { speakText, stopSpeech } from "@/features/voice/tts";
import { endTalk, TalkBar, useTalk } from "../voice/api";
import { showsAt } from "./scroll";
import { ScrollToLatest } from "./ScrollToLatest";
import { GroupFace, workWidth } from "./bits";
import { MAX_MENTIONS, withBoardQuote } from "./compose";
import { Composer, type ModelPill, type SendOptions } from "./Composer";
import { ContextMeter } from "./ContextMeter";
import { latestTurn } from "./helpers";
import { HelperRail } from "./HelperRail";
import { LiveTurn, TurnText, WorkPart } from "./LiveTurn";
import { EndedNote, type MessageActions, MessageRow } from "./Messages";
import { type FoldHold, FoldRow } from "./FoldRow";
import { Aside } from "./Aside";
import { chatTimeline, type Item, reuseItems, TIMELINE_V1, underWay } from "./turn";
import { ProjectPill, projectActions, runProjectChoice, type Side, SideAnswer } from "./ChatProject";
import { quoteOf, sideQuestionOf } from "./side";
import { endSelecting, selectionEnds } from "./selecting";
import { usePane } from "../pane/usePane";
import { ScreenCard } from "../pane/ScreenCard";
import { RequestPanel } from "./RequestPanel";

const STARTERS = ["What can you do?", "Plan my day", "Summarize my week"];
// The rows each open chat drew last, by key: a row that didn't change stays the same object (turn.ts, reuseItems).
const drawn = new Map<string, Map<string, Item>>();
function steady(chatId: string, items: Item[]): Item[] {
  const kept = reuseItems(drawn.get(chatId), items);
  drawn.set(chatId, kept.byKey);
  return kept.items;
}
const forgetDrawn = (chatId: string) => void drawn.delete(chatId);

function ChatTitle({ chat, bot, bots, state, model, room }: { chat: ChatSummary; bot?: Bot; bots: Map<string, Bot>; state: AvatarState; model: string; room: number }) {
  const { width } = useWindowDimensions();
  const group = !!chat.botIds && chat.botIds.length > 1;
  const name = group ? chat.title || "Group chat" : (bot?.name ?? chat.title);
  const status = activityLabel(state) || model;
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: width - room }}>
      {group ? <GroupFace bots={chat.botIds!.slice(0, 2).map((id) => bots.get(id))} size={30} state={state} /> : <BotAvatar bot={bot} size={30} state={state} />}
      <View style={{ flexShrink: 1 }}>
        <T variant="name" numberOfLines={1}>
          {name}
        </T>
        <T variant="caption" color={state === "waiting" ? "warning" : state === "idle" ? "muted" : "accentText"} numberOfLines={1}>
          {status}
        </T>
      </View>
    </View>
  );
  if (group || !bot) return body;
  return (
    <Tap onPress={() => router.push({ pathname: "/bot/[id]", params: { id: bot.id } })} feel="select" sink={0.98} accessibilityLabel={name + ", " + status + ", bot page"}>
      {body}
    </Tap>
  );
}

function ChatMenu({ chat, bot, bots, started, projects, settings, onDelete, panes = 0, onPane }: { /** How many tabs the chat's side pane has, and opening it. */ panes?: number; onPane?: () => void; chat: ChatSummary; bot?: Bot; bots: Map<string, Bot>; /** The chat has messages: its project and mode are settled. */ started: boolean; projects?: Project[]; settings?: Preferences; onDelete: () => void }) {
  const { colors } = useTheme();
  const canManage = useCan("agents", "manage");
  const project = projects?.find((p) => p.id === chat.projectId);
  const rename = () =>
    Alert.prompt(
      "Rename chat",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Save", onPress: (value?: string) => void (value?.trim() && attempt(api.renameChat(chat.id, value.trim()))) },
      ],
      "plain-text",
      chat.title,
    );
  const actions = [
    ...(bot && !chat.botIds ? [{ id: "new", title: "New chat with " + bot.name, image: "square.and.pencil" }] : []),
    ...(canManage ? [{ id: "model", title: "Model…", image: "cpu" }] : []),
    // Before the first message the chat can still change its project and mode.
    ...(started ? [] : projectActions({ chat, projects, settings, bots })),
    ...(project?.folder ? [{ id: "changes", title: "Changes", image: "plus.forwardslash.minus" }] : []),
    ...(panes > 0 ? [{ id: "pane", title: "Side pane", image: "sidebar.right" }] : []),
    { id: "pin", title: chat.pinned ? "Unpin" : "Pin", image: chat.pinned ? "pin.slash" : "pin" },
    ...(Platform.OS === "ios" ? [{ id: "rename", title: "Rename", image: "pencil" }] : []),
    { id: "compact", title: "Compact", image: "arrow.down.right.and.arrow.up.left" },
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
  return (
    <MenuView
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (runProjectChoice(chat, action)) return;
        if (action === "pane") return void onPane?.();
        if (action === "changes" && project) router.push(("/chat/changes?id=" + encodeURIComponent(project.id)) as Href);
        else if (action === "new" && bot)
          void attempt(api.createChat(bot.id)).then((id) => id && router.replace({ pathname: "/chat/[id]", params: { id } }));
        else if (action === "model") router.push({ pathname: "/chat/model", params: { scope: "chat", id: chat.id } });
        else if (action === "pin") void attempt(api.setChatFlags(chat.id, { pinned: !chat.pinned }), chat.pinned ? "Unpinned" : "Pinned");
        else if (action === "rename") rename();
        else if (action === "compact") void attempt(api.compact(chat.id), "Compacting");
        else if (action === "delete")
          Alert.alert("Delete this chat?", "Its messages are deleted too.", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: onDelete },
          ]);
      }}
    >
      <View accessible accessibilityRole="button" accessibilityLabel="Chat options" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Ellipsis size={22} color={colors.ink} strokeWidth={2.2} />
      </View>
    </MenuView>
  );
}

function RoutineBanner({ chat }: { chat: ChatSummary }) {
  const { colors } = useTheme();
  const routine = chat.schedules?.find((schedule) => schedule.routine);
  if (!routine) return null;
  return (
    <Tap
      onPress={() => router.push({ pathname: "/routine/[id]", params: { id: chat.id } })}
      feel="select"
      sink={0.98}
      accessibilityLabel={"Routine, " + (routine.name ?? chat.title)}
      style={{ marginHorizontal: space.lg, marginBottom: space.sm, minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.infoSoft }}
    >
      <Repeat size={16} color={colors.info} strokeWidth={2.4} />
      <T variant="subhead" weight="600" color="info" numberOfLines={1} style={{ flex: 1 }}>
        {routine.name ?? "Routine"}
      </T>
      <ChevronRight size={16} color={colors.info} strokeWidth={2.4} />
    </Tap>
  );
}

/** Messages waiting for the turn under way. Its button is the desktop app's: "Steer now" when the turn takes a steer, else "Send next". */
function Queued({ chatId, items, steerable }: { chatId: string; items: QueuedMessage[]; steerable: boolean }) {
  const { colors } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm }}>
      {items.map((item) => (
        <View key={item.id} style={{ height: 40, maxWidth: 300, flexDirection: "row", alignItems: "center", paddingLeft: space.md, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }}>
          <T variant="subhead" color="ink2" numberOfLines={1} style={{ flexShrink: 1 }} accessibilityLabel={"Queued: " + item.text}>
            {item.text}
          </T>
          <Tap onPress={() => void attempt(api.sendNow(chatId, item.id))} feel="select" hitSlop={{ top: 4, bottom: 4 }} accessibilityLabel={steerable ? "Steer now" : "Send next"} style={{ height: 40, justifyContent: "center", paddingLeft: space.md, paddingRight: space.xs }}>
            <T variant="footnote" weight="700" color="accentText">
              {steerable ? "Steer now" : "Send next"}
            </T>
          </Tap>
          <Tap onPress={() => void attempt(api.unqueue(chatId, item.id))} feel="select" hitSlop={{ top: 4, bottom: 4, right: 4 }} accessibilityLabel="Remove from queue" style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
            <X size={15} color={colors.muted} strokeWidth={2.4} />
          </Tap>
        </View>
      ))}
    </ScrollView>
  );
}

function Hello({ chat, bot, bots, projects, settings, onPick }: { chat: ChatSummary; bot?: Bot; bots: Map<string, Bot>; projects?: Project[]; settings?: Preferences; onPick: (text: string) => void }) {
  const group = !!chat.botIds && chat.botIds.length > 1;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: space.xl, gap: space.md }}>
      <Animated.View entering={FadeIn.duration(260)} style={{ alignItems: "center", gap: space.md }}>
        <BotAvatar bot={bot} size={96} state="listening" />
        <View style={{ alignItems: "center", gap: 2 }}>
          <T variant="title2" center>
            {group ? chat.title || "Group chat" : (bot?.name ?? chat.title)}
          </T>
          {!group && !!bot?.role && (
            <T variant="subhead" color="muted" center numberOfLines={2}>
              {bot.role}
            </T>
          )}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.sm, marginTop: space.md }}>
          {STARTERS.map((starter) => (
            <Chip key={starter} label={starter} onPress={() => onPick(starter)} />
          ))}
        </View>
        <ProjectPill chat={chat} projects={projects} settings={settings} bots={bots} />
      </Animated.View>
    </ScrollView>
  );
}

export default function ChatScreen() {
  const { colors } = useTheme();
  // `board` pins a Today card to the composer, for the first message (discussBoardItem in open.ts).
  // `at` lands on one message (its place in the whole chat, from 0): Open chat on an artifact.
  const { id: chatId, draft, board, at } = useLocalSearchParams<{ id: string; draft?: string; board?: string; at?: string }>();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  // A bot's request leaves room for the bar above it and the composer below it, also over the keyboard.
  const keyboardUp = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const requestRoom = Math.max(200, Math.min(screenHeight * 0.6, screenHeight - (keyboardUp ? keyboardHeight : insets.bottom) - insets.top - 168));
  const chat = useChat(chatId);
  const chatsLoaded = useApp((state) => !!state.parts.chats);
  const view = useWatchedChat(chatId);
  const bot = useBot(chat?.botId);
  const allBots = useBots();
  const bots = useMemo(() => new Map(allBots.map((b) => [b.id, b])), [allBots]);
  const settings = useSettings();
  const models = useModels();
  const state = useChatActivity(chatId);
  const live = usePart("live");
  const streaming = !!live && chatId in live.streams;
  // The chat's run part: the turn under way, or its newest turn when that ended without a reply.
  const runPart = useApp((s) => s.running[chatId]);
  const turnRun = underWay(runPart);
  const requests = useMemo(() => live?.requests.filter((request) => request.chatId === chatId) ?? [], [live, chatId]);
  const queued = live?.queued[chatId];
  const working = streaming || !!turnRun;
  const group = !!chat?.botIds && chat.botIds.length > 1;
  const canChat = useCan("agents", "chat");

  const [text, setText] = useState(draft ?? "");
  const [pinnedId, setPinnedId] = useState(board);
  const pinned = usePart("board")?.find((item) => item.id === pinnedId);
  const boardMentions = !!usePart("meta")?.capabilities.includes("board-mentions-v1");
  const unpin = () => {
    setPinnedId(undefined);
    if (board) router.setParams({ board: undefined });
  };
  const [leaving, setLeaving] = useState(false);
  // A message being replied to (Reply in its menu): it goes with the next message as a quote.
  const [quote, setQuote] = useState("");
  // The latest side question (/btw, /ask) and its answer, shown beside the chat and never in it.
  const [side, setSide] = useState<Side | null>(null);
  const projects = usePart("projects");
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const list = useRef<FlatList<Item>>(null);
  // The newest message is out of view: the button that goes back to it shows.
  const away = useRef(false);
  const [awayNow, setAway] = useState(false);
  // Where the list is scrolled to, and where it sits in the window: a fold that opens or closes keeps its line in place (holdFold).
  const scrolled = useRef(0);
  const listBox = useRef<ComponentRef<typeof View>>(null);
  const frame = useRef({ top: 0, height: 0 });
  const measureList = () => listBox.current?.measureInWindow((_x, top, _w, height) => (frame.current = { top, height }));
  // The list is inverted: a larger offset shows older rows, so content moves down by as much.
  const holdFold: FoldHold = ({ was, top, bottom }) => {
    const box = frame.current;
    if (!box.height || !Number.isFinite(was + top + bottom)) return;
    // Keep the line where it was tapped, as long as the fold's end stays in view; never push the line out of the top.
    let shift = was - top;
    shift = Math.min(shift, box.top + box.height - bottom);
    shift = Math.max(shift, box.top - top);
    if (Math.abs(shift) < 1) return;
    list.current?.scrollToOffset({ offset: Math.max(0, scrolled.current + shift), animated: false });
  };

  // Opening a chat wakes its bot up and marks it read.
  useEffect(() => {
    if (chatId) api.warmChat(chatId).catch(() => {});
  }, [chatId]);
  const unread = !!chat?.unread;
  useEffect(() => {
    if (chatId && unread) api.setChatFlags(chatId, { unread: false }).catch(() => {});
  }, [chatId, unread]);

  const choice = effectiveModel(settings, bot, chat);
  const info = models ? findModel(models, choice) : undefined;
  const model: ModelPill = {
    provider: choice?.provider ?? info?.provider,
    name: modelName(choice, models),
    effort: choice?.reasoningEffort ? effortLabel(choice.reasoningEffort) : undefined,
  };

  // The chat in the order things happened (turn.ts): steps, thinking and text in place, a steer or
  // an answer where it came, and how a turn ended when it didn't finish. Newest first for the inverted list.
  const timeline = useCapability(TIMELINE_V1);
  const panesOn = useCapability("side-pane-v1");
  const marks = useTurnMarks();
  const stepsPref = useChatPrefs((prefs) => prefs.steps);
  const thinkingPref = useChatPrefs((prefs) => prefs.thinking);
  const stream = streaming ? live?.streams[chatId] : undefined;
  const liveThinking = live?.thinking[chatId];
  const panels = view?.pane?.panels;
  const data = useMemo(() => {
    if (!view) return [];
    const screens = panesOn ? panels?.filter((panel) => panel.kind === "screen") : undefined;
    const items = chatTimeline({
      messages: view.messages,
      from: view.from,
      runs: view.runs,
      running: runPart,
      live: { stream, thinking: liveThinking },
      marks,
      timeline,
      group,
      screens,
      prefs: { steps: stepsPref, thinking: thinkingPref },
    });
    return steady(chatId, items).reverse();
  }, [view, runPart, stream, liveThinking, marks, timeline, group, panesOn, panels, stepsPref, thinkingPref, chatId]);
  useEffect(() => () => forgetDrawn(chatId), [chatId]);
  // The helpers of the chat's newest turn, above the composer.
  const newest = view ? latestTurn(runPart, view.messages, view.runs) : undefined;

  // Going to one message: earlier pages are loaded until it is there, then the list scrolls to it.
  const target = at !== undefined && /^\d{1,7}$/.test(at) ? Number(at) : undefined;
  const loads = useRef(0);
  const scrollTries = useRef(0);
  const from = view?.from;
  const loadingEarlier = !!view?.loadingEarlier;
  useEffect(() => {
    if (target === undefined || from === undefined || loadingEarlier) return;
    if (from > target) {
      // Each page is 60 messages; a page that fails to load is tried again, a few times at most.
      if (loads.current++ < 40) void loadEarlier(chatId);
      else router.setParams({ at: undefined });
      return;
    }
    const index = data.findIndex((item) => item.kind === "message" && item.index === target);
    if (index < 0) {
      // Not in this chat (any more): the chat opens as it is.
      router.setParams({ at: undefined });
      return;
    }
    const timer = setTimeout(() => {
      scrollTries.current = 0;
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
      router.setParams({ at: undefined });
    }, 300);
    return () => clearTimeout(timer);
  }, [target, from, loadingEarlier, data, chatId]);

  const askSide = (command: string, question: string) => {
    if (!question) {
      showToast("Enter a side question after /" + command + ".", "error");
      return false;
    }
    if (side && !side.answer && !side.error) {
      showToast("Your previous side question is still running.", "error");
      return false;
    }
    setText("");
    setSide({ question });
    const finish = (result: Omit<Side, "question">) => setSide((current) => (current?.question === question ? { question, ...result } : current));
    api.sideQuestion(chatId, question).then(
      (answer) => finish({ answer }),
      (error: unknown) => finish({ error: error instanceof Error ? error.message : "Couldn't answer that." }),
    );
    return true;
  };
  /** `fromComposer`: what the person wrote, so a pinned card and a quote go with it. A reply's own buttons send plain text. */
  const send = (value: string, options?: SendOptions, fromComposer = true): Promise<boolean> => {
    // "/btw" and "/ask" are answered beside the chat, also while the bot works.
    const asked = fromComposer && chatId ? sideQuestionOf(value) : null;
    if (asked) return Promise.resolve(askSide(asked.command, asked.question));
    const card = fromComposer ? pinned : undefined;
    const quoted = fromComposer ? quote : "";
    const typed = value.trim();
    const files = options?.attachments?.length ?? 0;
    if ((!typed && !files && !card) || !chatId) return Promise.resolve(false);
    // The computer wants some words with a file, so files sent alone get a plain line.
    let message = typed || (files === 1 ? "See the attached file." : files ? "See the attached files." : "");
    let sent = options;
    // A pinned Today card goes with the first message: as a mention where the computer takes one,
    // else as a quote at the top of the text, so the bot always gets it and the chat shows it.
    if (card) {
      if (boardMentions) {
        message ||= "Let's talk about this.";
        sent = { ...options, mentions: [{ kind: "board" as const, id: card.id }, ...(options?.mentions ?? [])].slice(0, MAX_MENTIONS) };
      } else message = withBoardQuote(card, message);
      unpin();
    }
    if (quoted) {
      sent = { ...sent, quote: quoted };
      setQuote("");
    }
    setText("");
    list.current?.scrollToOffset({ offset: 0, animated: true });
    // While the chat works, the message steers the turn where the provider takes one, as on the desktop app.
    return api.send(chatId, message, working ? { ...sent, delivery: "steer" } : sent).then(
      () => true,
      (error: unknown) => {
        if (card) setPinnedId(card.id);
        if (quoted) setQuote((current) => current || quoted);
        setText((current) => current || typed);
        showToast(error instanceof Error ? error.message : "Couldn't send that.", "error");
        return false;
      },
    );
  };
  // A reply's own buttons send plain text; a pinned card waits for the person's message.
  const sendText = (value: string) => void send(value, undefined, false);
  // A custom view hands over text: it goes after what is already written, for the person to read and send.
  const draftText = (value: string) => setText((current) => (current.trim() ? current.replace(/\s+$/, "") + "\n" + value : value));
  // The side pane a bot opened beside this chat: its sheet opens when a bot asks, and text a view in it hands over lands in the message box.
  const pane = usePane(chatId, draftText);
  // Reply and Fork from here, in each message's menu. A group chat can't be forked.
  const messageActions: MessageActions = {
    onReply: (value) => {
      setQuote(quoteOf(value));
      input.current?.focus();
    },
    onFork: group
      ? undefined
      : (index) =>
          void attempt(api.forkChat(chatId, index)).then((id) => {
            if (id) router.push({ pathname: "/chat/[id]", params: { id } });
          }),
    busy: working,
  };
  const pick = (starter: string) => {
    setText(starter);
    input.current?.focus();
  };
  const remove = async () => {
    setLeaving(true);
    const done = await attempt(api.deleteChat(chatId).then(() => true));
    if (done) router.back();
    else setLeaving(false);
  };

  // With "Read replies aloud" on, each reply that arrives while the chat is open is read, in order.
  const readAloud = useChatPrefs((prefs) => prefs.readAloud);
  const heard = useRef<string | null>(null);
  const lastMessage = view?.messages[view.messages.length - 1];
  const lastKey = view && lastMessage ? "m" + (view.from + view.messages.length - 1) : "";
  useEffect(() => {
    if (!view) return;
    const before = heard.current;
    heard.current = lastKey;
    // What was already there when the chat opened isn't read.
    if (before === null || before === lastKey) return;
    // A talk by turns reads its replies itself (voice/talk.ts), so they aren't read twice.
    if (useTalk.getState().chatId === chatId) return;
    if (readAloud && lastMessage?.role === "assistant" && lastMessage.text) speakText(chatId + ":" + lastKey, lastMessage.text, { queue: true, quiet: true });
  }, [view, lastKey, lastMessage, readAloud, chatId]);
  // Leaving the chat ends what is being read, and a talk in this chat.
  useEffect(
    () => () => {
      if (useTalk.getState().chatId === chatId) endTalk();
      stopSpeech();
      endSelecting();
    },
    [chatId],
  );

  // The composer rides the keyboard; with the keyboard down it clears the home indicator.
  const keyboard = useReanimatedKeyboardAnimation();
  const bottomInset = insets.bottom;
  const spacer = useAnimatedStyle(() => ({ height: Math.max(Math.abs(keyboard.height.value), bottomInset) }));

  if (leaving) return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;
  if (!chat)
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas, justifyContent: "center" }}>
        {chatsLoaded ? <EmptyState icon={X} title="This chat is gone" action="Back" onAction={() => router.back()} /> : <Loading />}
      </View>
    );

  const empty = !!view && view.messages.length === 0 && !streaming;
  const measured = chat.context && chat.context.limit > 0 ? chat.context : undefined;
  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => <ChatTitle chat={chat} bot={bot} bots={bots} state={state} model={model.name} room={measured ? 206 : 150} />,
        headerRight: () => (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {measured && <ContextMeter chatId={chat.id} context={measured} />}
            <ChatMenu chat={chat} bot={bot} bots={bots} started={!!view && view.messages.length > 0} projects={projects} settings={settings} onDelete={() => void remove()} panes={pane.tabs} onPane={() => pane.show()} />
          </View>
        ),
      }}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      {header}
      <RoutineBanner chat={chat} />
      <View style={{ paddingHorizontal: space.lg }}>
        <LinkBanner />
      </View>
      {!view ? (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Loading />
        </View>
      ) : empty ? (
        <View style={{ flex: 1 }}>
          <Hello chat={chat} bot={bot} bots={bots} projects={projects} settings={settings} onPick={pick} />
        </View>
      ) : (
        <View ref={listBox} collapsable={false} onLayout={measureList} style={{ flex: 1 }} {...selectionEnds}>
        <FlatList
          ref={list}
          inverted
          // How far the newest message is out of view. While a reply is written and the person has
          // scrolled up to read, the list stays where they are (maintainVisibleContentPosition
          // below), and the button offers the way back.
          onScroll={(event) => {
            scrolled.current = event.nativeEvent.contentOffset.y;
            const next = showsAt(event.nativeEvent.contentOffset.y, away.current);
            if (next !== away.current) {
              away.current = next;
              setAway(next);
            }
          }}
          scrollEventThrottle={64}
          data={data}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) =>
            item.kind === "message" ? (
              <MessageRow item={item} chatId={chatId} group={group} bots={bots} onSend={sendText} onDraft={draftText} actions={messageActions} />
            ) : item.kind === "work" ? (
              <WorkPart chatId={chatId} item={item} />
            ) : item.kind === "text" ? (
              <TurnText item={item} />
            ) : item.kind === "screen" ? (
              <ScreenCard chatId={chatId} panel={item.panel} onOpen={() => pane.show(item.panel.id)} />
            ) : item.kind === "ended" ? (
              <EndedNote run={item.run} ending={item.ending} retry={item.retry} />
            ) : item.kind === "fold" ? (
              <FoldRow chatId={chatId} bot={bot} group={group} bots={bots} item={item} hold={holdFold} />
            ) : item.kind === "thought" ? (
              <View style={workWidth}>
                <Aside kind="thinking" text={item.text} />
              </View>
            ) : (
              <LiveTurn chatId={chatId} bot={bot} group={group} bots={bots} item={item} />
            )
          }
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: space.xl, paddingVertical: space.lg }}
          ItemSeparatorComponent={Gap}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
          maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
          onEndReached={() => view.from > 0 && void loadEarlier(chatId)}
          // A message not drawn yet: go near it by the rows' average height, then to it.
          onScrollToIndexFailed={(info) => {
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            if (scrollTries.current++ < 4) setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), 160);
          }}
          onEndReachedThreshold={0.6}
          ListFooterComponent={view.loadingEarlier ? <ActivityIndicator color={colors.muted} style={{ paddingVertical: space.lg }} /> : undefined}
          initialNumToRender={12}
          windowSize={11}
        />
        <ScrollToLatest
          shown={awayNow}
          onPress={() => {
            list.current?.scrollToOffset({ offset: 0, animated: true });
            away.current = false;
            setAway(false);
          }}
        />
        </View>
      )}
      {/* A touch on the message box or anything beside it ends a text selection in the chat. */}
      <View style={{ paddingTop: space.xs, paddingBottom: space.sm, gap: space.sm }} onTouchStart={endSelecting}>
        {!!newest?.agents?.length && <HelperRail chatId={chatId} run={newest} />}
        {canChat && requests.length > 0 && (
          <View style={{ paddingHorizontal: space.md }}>
            <RequestPanel key={requests[0].id} request={requests[0]} bot={bots.get(requests[0].botId) ?? bot} maxHeight={requestRoom} count={requests.length} />
          </View>
        )}
        {side && (
          <View style={{ paddingHorizontal: space.md }}>
            <SideAnswer side={side} onDismiss={() => setSide(null)} />
          </View>
        )}
        {canChat && !!queued?.length && <Queued chatId={chatId} items={queued} steerable={!!live?.steerable?.[chatId]} />}
        {canChat ? (
          <View style={{ paddingHorizontal: space.md, gap: space.sm }}>
            <TalkBar chatId={chatId} />
            <Composer
              chatId={chatId}
              botId={chat.botId}
              group={group}
              members={chat.botIds}
              bots={bots}
              pinned={pinned}
              onUnpin={unpin}
              quote={quote}
              onUnquote={() => setQuote("")}
              value={text}
              onChange={setText}
              onSend={(options) => send(text, options)}
              onStop={() => void attempt(api.stop(chatId))}
              working={working}
              placeholder={"Message " + (group ? chat.title || "the group" : (bot?.name ?? "your bot"))}
              model={model}
              inputRef={input}
            />
          </View>
        ) : (
          <T variant="footnote" color="muted" center style={{ paddingVertical: space.md }}>
            You can view, not chat
          </T>
        )}
      </View>
      <Animated.View style={spacer} />
    </View>
  );
}

function Gap() {
  return <View style={{ height: space.xl }} />;
}
