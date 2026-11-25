import { randomUUID } from "expo-crypto";
import { MenuView } from "@react-native-menu/menu";
import { type Href, router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { LinearGradient } from "expo-linear-gradient";
import { ChevronRight, Ellipsis, PanelLeft, Repeat, X } from "lucide-react-native";
import { type ComponentRef, type ReactNode, type RefObject, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, FlatList, Platform, ScrollView, type TextInput, useWindowDimensions, View } from "react-native";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { useStore } from "zustand";
import { ScrollViewMarker } from "react-native-screens/experimental";
import { useShallow } from "zustand/react/shallow";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Bot, ChatSummary, Message, Preferences, Project, QueuedMessage, Run } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { activityLabel, type AvatarState, useBot, useBots, useCan, useCapability, useChat, useChatActivity, useModels, usePart, useSettings, useWatchedChat } from "@/state/hooks";
import { api, attempt, loadEarlier, reactToMessage } from "@/state/link";
import { effectiveModel, effortLabel, findModel, modelName } from "@/state/models";
import { type ChatView, pendingSends, showToast, useApp } from "@/state/store";
import { usePrefs } from "@/state/prefs";
import { useTurnMarks } from "@/state/turnMarks";
import { AvatarMotion, BackdropLayer, backdropBaseColor, BotAvatar, Button, Chip, EmptyState, Glass, hasGlass, IconButton, LinkBanner, Loading, radius, space, T, Tap, tint, useOnShow, useShape, useTextPrompt, useTheme } from "@/ui";
import { speakText, stopSpeech } from "@/features/voice/tts";
import { endTalk, TalkBar, useTalk } from "../voice/api";
import { useLiveCall } from "../voice/liveCall";
import { VoiceDock } from "../voice/VoiceDock";
import { completions } from "./completion";
import { useChatScreenState } from "./useChatScreenState";
import { createChatViewport, HIDE_AT, showsAt } from "./scroll";
import { ScrollToLatest } from "./ScrollToLatest";
import { GroupFace, workWidth } from "./bits";
import { arrived, composeSlashPrompt, type DraftMention, MAX_MENTIONS, waitingCopies, withBoardQuote } from "./compose";
import { archivesWhenLeft } from "./habits";
import { formatTypingLabel, myPlace, myself } from "./people";
import { ChatPeopleLook } from "./ChatPeopleLook";
import { continuingKeys } from "./chatSides";
import { regenerateTitle, regenerateTitleAction, useCanRegenerateTitle } from "./titleActions";
import { Composer, type ModelPill, type SendOptions } from "./Composer";
import { ChangesView } from "./Changes";
import { ContextMeter } from "./ContextMeter";
import { drafts, keepDraft, useChatSplit } from "./split";
import { closed, sessionTodos, todoLabel, TRANSFER_TODOS } from "../../../link-host/session-todos";
import { TodoList } from "./TodoList";
import { latestTurn } from "./helpers";
import { HelperRail, railShown } from "./HelperRail";
import { CrewCard } from "./CrewCard";
import { LiveTurn, TurnText, WorkPart } from "./LiveTurn";
import { CAPSULE, StatusCapsule } from "./StatusCapsule";
import { EndedNote, KeptNote, OpenNote, type MessageActions, MessageRow, UserBubble, WorkLine } from "./Messages";
import { type FoldHold, FoldRow } from "./FoldRow";
import { Island } from "./Island";
import { capsuleShown, islandOn } from "./islandModel";
import { Aside } from "./Aside";
import { chatTimeline, createTimelineRunSelector, indexMessageOwnership, liveRowVisible, type Item, reuseItems, TIMELINE_V1, underWay } from "./turn";
import { ProjectPill, projectActions, runProjectChoice, type Side, SideAnswer } from "./ChatProject";
import { quoteOf, sideQuestionOf } from "./side";
import { useWatchedReasoning } from "./useWatchedReasoning";
import { endSelecting, selectionEnds } from "./selecting";
import { MessageLink, openLink } from "@/ui/LinkHold";
import { pullRequestUrl } from "../../../link-host/pr-url.mjs";
import { usePane } from "../pane/usePane";
import { ReactionPicker } from "./ReactionPicker";
import { ScreenCard } from "../pane/ScreenCard";
import { RequestPanel } from "./RequestPanel";

const EMPTY_CHAT: ChatView = { from: 0, total: 0, messages: [], runs: {} };
const STARTERS = ["What can you do?", "Plan my day", "Summarize my week"];

function TypingDot({ delay, color, reduced }: { delay: number; color: string; reduced: boolean }) {
  const pulse = useSharedValue(reduced ? 0.65 : 0.4);
  useEffect(() => {
    if (reduced) {
      pulse.value = 0.65;
      return;
    }
    pulse.value = withDelay(
      delay,
      withSequence(
        withRepeat(
          withSequence(withTiming(1, { duration: 420 }), withTiming(0.4, { duration: 420 })),
          3,
          false,
        ),
        withTiming(0.65, { duration: 240 }),
      ),
    );
  }, [delay, pulse, reduced]);
  const style = useAnimatedStyle(() => ({
    opacity: pulse.value,
    transform: [{ translateY: reduced ? 0 : (pulse.value - 0.4) * -3 }],
  }));
  return <Animated.View style={[{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: color }, style]} />;
}

function TypingRow({ label }: { label: string }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  return (
    <View
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
        <TypingDot delay={0} color={colors.muted} reduced={reduced} />
        <TypingDot delay={150} color={colors.muted} reduced={reduced} />
        <TypingDot delay={300} color={colors.muted} reduced={reduced} />
      </View>
      <T variant="caption" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}…
      </T>
    </View>
  );
}

function ChatTitle({ chat, bot, bots, state, model, room, docked }: { chat: ChatSummary; bot?: Bot; bots: Map<string, Bot>; state: AvatarState; model: string; room: number; /** The bot is on the voice dock: the title leaves its face out, so it shows once. */ docked?: boolean }) {
  const { width } = useWindowDimensions();
  const group = !!chat.botIds && chat.botIds.length > 1;
  const name = group ? chat.title || "Group chat" : (bot?.name ?? chat.title);
  const status = activityLabel(state) || [chat.main && "Main chat", model].filter(Boolean).join(" · ");
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, maxWidth: width - room }}>
      {/* The face of the agent you're with moves (avatarMotion.tsx); the rest of the chat holds still. */}
      {group ? <GroupFace bots={chat.botIds!.slice(0, 2).map((id) => bots.get(id))} size={30} state={state} animated /> : docked ? null : <BotAvatar bot={bot} size={30} state={state} animated />}
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

function ChatMenu({ chat, bot, bots, started, projects, settings, onDelete, panes = 0, onPane, onOpen }: { /** How many tabs the chat's side pane has, and opening it. */ panes?: number; onPane?: () => void; /** Opens another chat in the same place (beside the list); else it replaces this page. */ onOpen?: (id: string) => void; chat: ChatSummary; bot?: Bot; bots: Map<string, Bot>; /** The chat has messages: its project and mode are settled. */ started: boolean; projects?: Project[]; settings?: Preferences; onDelete: () => void }) {
  const { colors } = useTheme();
  const canManage = useCan("agents", "manage");
  const project = projects?.find((p) => p.id === chat.projectId);
  // The people in a chat ("team-people-v1"). Someone invited takes part; renaming, compacting,
  // deleting and the chat's model, project and people are its starter's (and the owner's).
  const multiple = useCapability("project-folders-v1");
  const savesMode = useCapability("project-mode-v1");
  const canShare = useCapability("team-people-v1") && !chat.hostDispatch;
  const teamSize = usePart("team")?.people?.length ?? 0;
  const person = myself(usePart("meta"));
  const ownMain = chat.main && (chat.createdBy ?? "owner") === person;
  const place = myPlace(chat, person);
  const mine = place === "manages";
  const canRegenerate = useCanRegenerateTitle(chat, mine);
  const prompt = useTextPrompt();
  const rename = () => prompt.ask({ title: "Rename chat", value: chat.title, onSubmit: (title) => void attempt(api.renameChat(chat.id, title)) });
  const actions = [
    ...(bot && !chat.botIds ? [{ id: "new", title: "New chat with " + bot.name, image: "square.and.pencil" }] : []),
    ...(!chat.main && canShare && (mine ? teamSize > 1 : place === "invited") ? [{ id: "people", title: mine ? "Invite" : "People in this chat", image: mine ? "person.badge.plus" : "person.2" }] : []),
    ...(canManage && mine ? [{ id: "model", title: "Model…", image: "cpu" }] : []),
    // Before the first message the chat can still change its project and mode.
    ...(started || !mine ? [] : projectActions({ chat, projects, settings, bots }, multiple)),
    ...(project?.folder ? [{ id: "changes", title: "Changes", image: "plus.forwardslash.minus" }] : []),
    ...(panes > 0 ? [{ id: "pane", title: "Side pane", image: "sidebar.right" }] : []),
    { id: "pin", title: chat.pinned ? "Unpin" : "Pin", image: chat.pinned ? "pin.slash" : "pin" },
    ...(mine && !chat.main ? [{ id: "rename", title: "Rename", image: "pencil" }] : []),
    ...(canRegenerate && !chat.main ? [regenerateTitleAction] : []),
    ...(mine ? [{ id: "compact", title: "Compact", image: "arrow.down.right.and.arrow.up.left" }] : []),
    ...(ownMain ? [
      ...(chat.forks ?? []).map(f => ({ id: "fork:" + f.id, title: f.name, state: f.id === chat.activeFork ? "on" as const : "off" as const })),
      { id: "reset", title: "Reset context", image: "arrow.counterclockwise" },
    ] : mine && !chat.main ? [{ id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } }] : []),
  ];
  return (
    <>
    {prompt.node}
    <MenuView
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (runProjectChoice(chat, action, savesMode)) return;
        if (action === "pane") return void onPane?.();
        if (action === "people") return void router.push({ pathname: "/chat/people", params: { id: chat.id } });
        if (action === "changes" && project) router.push(("/chat/changes?id=" + encodeURIComponent(project.id) + "&chatId=" + encodeURIComponent(chat.id)) as Href);
        else if (action === "new" && bot)
          void attempt(api.createChat(bot.id)).then((id) => id && (onOpen ? onOpen(id) : router.replace({ pathname: "/chat/[id]", params: { id } })));
        else if (action === "model") router.push({ pathname: "/chat/model", params: { scope: "chat", id: chat.id } });
        else if (action === "pin") void attempt(api.setChatFlags(chat.id, { pinned: !chat.pinned }), chat.pinned ? "Unpinned" : "Pinned");
        else if (action === "rename") rename();
        else if (action === regenerateTitleAction.id) regenerateTitle(chat.id);
        else if (action === "reset") void attempt(api.changeMainFork(chat.id, "reset", undefined, chat.activeFork));
        else if (action.startsWith("fork:")) void attempt(api.changeMainFork(chat.id, "switch", action.slice(5), chat.activeFork));
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
    </>
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
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm }}>
      {items.map((item) => {
        const inner = (
          <>
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
          </>
        );
        if (hasBackdrop) {
          return (
            <Glass key={item.id} style={{ height: 40, maxWidth: 300, flexDirection: "row", alignItems: "center", paddingLeft: space.md, borderRadius: radius.pill, overflow: "hidden" }}>
              {inner}
            </Glass>
          );
        }
        return (
          <View key={item.id} style={{ height: 40, maxWidth: 300, flexDirection: "row", alignItems: "center", paddingLeft: space.md, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }}>
            {inner}
          </View>
        );
      })}
    </ScrollView>
  );
}

function Hello({ chat, bot, bots, projects, settings, onPick }: { chat: ChatSummary; bot?: Bot; bots: Map<string, Bot>; projects?: Project[]; settings?: Preferences; onPick: (text: string) => void }) {
  const group = !!chat.botIds && chat.botIds.length > 1;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: space.xl, gap: space.md }}>
      <Animated.View entering={FadeIn.duration(260)} style={{ alignItems: "center", gap: space.md }}>
        <BotAvatar bot={bot} size={96} state="idle" />
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

/** How long the list must stay unchanged after a reply finishes before it is shown from its beginning. */
const SETTLE_MS = 350;
type ChatPosition = "latest" | "completion" | "history";
const HOLD_POSITION = { minIndexForVisible: 0 };
const FOLLOW_LATEST = { minIndexForVisible: 0, autoscrollToTopThreshold: 80 };
const VIEWABILITY = { viewAreaCoveragePercentThreshold: 0 };

type RowProps = {
  chatId: string;
  group: boolean;
  bot?: Bot;
  bots: Map<string, Bot>;
  sendText: (text: string) => void;
  draftText: (text: string) => void;
  messageActions: MessageActions;
  openPanel: (id: string) => void;
};

const TimelineRow = memo(function TimelineRow({ item, chatId, group, bot, bots, sendText, draftText, messageActions, openPanel, holdFold, viewport, active, replyRef, continues }: RowProps & {
  item: Item;
  continues?: boolean;
  holdFold: FoldHold;
  viewport: ReturnType<typeof createChatViewport>;
  active: boolean;
  replyRef?: RefObject<ComponentRef<typeof View> | null>;
}) {
  const inView = useStore(viewport.rows, (rows) => active && rows.has(item.key));
  const row = item.kind === "message" ? (
    <MessageRow replyRef={replyRef} item={item} chatId={chatId} group={group} bots={bots} onSend={sendText} onDraft={draftText} actions={messageActions} continues={continues} />
  ) : item.kind === "work" ? (
    <WorkPart chatId={chatId} bot={bot} item={item} />
  ) : item.kind === "text" ? (
    <TurnText item={item} />
  ) : item.kind === "screen" ? (
    <ScreenCard chatId={chatId} panel={item.panel} inView={inView} onOpen={() => openPanel(item.panel.id)} />
  ) : item.kind === "crew" ? (
    <CrewCard chatId={chatId} item={item} rows={viewport.rows} />
  ) : item.kind === "activity" ? (
    <WorkLine chatId={chatId} runId={item.runId} label="Turn activity" />
  ) : item.kind === "ended" ? (
    <EndedNote run={item.run} ending={item.ending} retry={item.retry} />
  ) : item.kind === "kept" ? (
    <KeptNote line={item.line} />
  ) : item.kind === "open" ? (
    <OpenNote line={item.line} again={item.again} onSend={sendText} />
  ) : item.kind === "fold" && item.island ? (
    <Island chatId={chatId} bot={group ? bots.get(item.run.speakers?.at(-1) ?? "") : bot} group={group} item={item} inView={inView} hold={holdFold} onHeight={item.live ? viewport.islandHeight : undefined} />
  ) : item.kind === "fold" ? (
    <FoldRow chatId={chatId} bot={group ? bots.get(item.run.speakers?.at(-1) ?? "") : bot} group={group} item={item} hold={holdFold} />
  ) : item.kind === "thought" ? (
    <View style={workWidth}>
      <Aside kind="thinking" text={item.text} bot={bot} />
    </View>
  ) : (
    <LiveTurn chatId={chatId} bot={bot} group={group} bots={bots} item={item} />
  );
  return row;
});

/** Keep text and legacy turn marks at the list that orders them with messages and steps. */
function ChatTimelineList({ chatId, view, pending, runPart, streaming, group, bot, bots, at, list, position, setPosition, followLatest, sendText, draftText, messageActions, openPanel, emptyView, room, viewport }: RowProps & {
  /** Which rows are on screen: the screen reads it too, to show the capsule only while the island is away. */
  viewport: ReturnType<typeof createChatViewport>;
  view: ChatView;
  pending: (Message & { clientMessageId: string })[];
  runPart?: Run | null;
  streaming: boolean;
  at?: string;
  list: RefObject<FlatList<Item> | null>;
  position: ChatPosition;
  setPosition: (position: ChatPosition) => void;
  followLatest: (animated?: boolean) => void;
  emptyView?: ReactNode;
  /**
   * What floats over the list's ends: the see-through bar and banners at the top, the message box at
   * the bottom. `bottom` includes the capsule when it is visible.
   */
  room: { top: number; dock: number; bottom: number };
}) {
  const { colors } = useTheme();
  // The newest message is out of view: the button that goes back to it shows.
  const away = useRef(false);
  const [awayNow, setAway] = useState(false);
  // Where a message being scrolled to sits once it is there: 0.5 is the middle; 1 its top at the top (the list is inverted).
  const viewPosition = useRef(0.5);
  // How far from the list's edge it sits: a reply shown from its beginning clears the bar and banners over the list (room.top).
  const viewOffset = useRef(0);
  const edges = useRef(room);
  useEffect(() => {
    edges.current = room;
  });
  // Where the list is scrolled to, and where it sits in the window: a fold that opens or closes keeps its line in place (holdFold).
  const scrolled = useRef(0);
  const latestReply = useRef<ComponentRef<typeof View>>(null);
  const listBox = useRef<ComponentRef<typeof View>>(null);
  const frame = useRef({ top: 0, height: 0 });
  const measureList = () => listBox.current?.measureInWindow((_x, top, _w, height) => (frame.current = { top, height }));
  // The list is inverted: a larger offset shows older rows, so content moves down by as much.
  const holdFold = useCallback<FoldHold>(({ was, top, bottom }) => {
    const { top: over, bottom: under } = edges.current;
    const box = { top: frame.current.top + over, height: frame.current.height - over - under };
    if (box.height <= 0 || !Number.isFinite(was + top + bottom)) return;
    // Keep the line where it was tapped, as long as the fold's end stays in view; never push the line out of the top.
    let shift = was - top;
    shift = Math.min(shift, box.top + box.height - bottom);
    shift = Math.max(shift, box.top - top);
    if (Math.abs(shift) < 1) return;
    list.current?.scrollToOffset({ offset: Math.max(0, scrolled.current + shift), animated: false });
  }, [list]);

  // The chat in the order things happened (turn.ts): steps, thinking and text in place, a steer or
  // an answer where it came, and how a turn ended when it didn't finish. Newest first for the inverted list.
  const timeline = useCapability(TIMELINE_V1);
  const panesOn = useCapability("side-pane-v1");
  const markPositions = useTurnMarks(useShallow((all) => Object.fromEntries(
    Object.entries(all).filter(([id]) => id === runPart?.id || Object.hasOwn(view.runs, id)).map(([id, held]) => [id, held.marks]),
  )));
  const timestamps = useChatPrefs(prefs => prefs.timestamps);
  const stepsPref = useChatPrefs((prefs) => prefs.steps);
  const thinkingPref = useChatPrefs((prefs) => prefs.thinking);
  const updatesPref = useChatPrefs((prefs) => prefs.updates);
  const foldFinishedSteps = useChatPrefs((prefs) => prefs.foldFinishedSteps);
  const streamOpen = useApp((state) => streaming && typeof state.texts[chatId]?.stream === "string");
  const ownership = useMemo(() => indexMessageOwnership(view.messages), [view.messages]);
  const prefs = useMemo(() => {
    const choices = { steps: stepsPref, thinking: thinkingPref, updates: updatesPref, foldFinishedSteps };
    return { ...choices, island: islandOn(choices) };
  }, [stepsPref, thinkingPref, updatesPref, foldFinishedSteps]);
  // A new step, steer, or page seals the current text into history using the latest snapshot.
  // Body-only changes reach the active row directly and leave this list untouched.
  const structural = useMemo(() => {
    const state = useApp.getState();
    const body = state.texts[chatId];
    const marks = Object.fromEntries(Object.entries(markPositions).map(([id, positions]) => [id, { marks: positions, text: useTurnMarks.getState()[id]?.text ?? "" }]));
    return chatTimeline({
      messages: view.messages,
      from: view.from,
      runs: view.runs,
      running: state.running[chatId] ?? runPart,
      live: { stream: streamOpen ? body?.stream : undefined, thinking: body?.thinking },
      marks, timeline, group, prefs, ownership,
      screens: panesOn ? view.pane?.panels?.filter((panel) => panel.kind === "screen") : undefined,
      // Whole-reply mode can receive reasoning before it receives any reply text.
      livePlaceholder: streamOpen || (!!underWay(runPart) && prefs.thinking === "show" && !prefs.island),
    });
  }, [chatId, view, runPart, markPositions, timeline, group, panesOn, prefs, ownership, streamOpen]);
  // A person's message right after another of theirs shows no name or badge again (chatSides.ts).
  const me = myself(usePart("meta"));
  const continuing = useMemo(() => continuingKeys(structural, me), [structural, me]);
  const liveItem = useMemo(() => structural.find((item) => item.kind === "live"), [structural]);
  const showLive = useApp((state) => !liveItem || liveRowVisible(liveItem, state.texts[chatId], state.running[chatId], prefs));
  const previous = useMemo(() => ({ byKey: new Map<string, Item>() }), [chatId]);
  const data = useMemo(() => {
    const items = showLive ? structural : structural.filter((item) => item !== liveItem);
    const kept = reuseItems(previous.byKey, items);
    previous.byKey = kept.byKey;
    return kept.items.reverse();
  }, [previous, structural, liveItem, showLive]);
  // Going to one message: earlier pages are loaded until it is there, then the list scrolls to it.
  const target = at !== undefined && /^\d{1,7}$/.test(at) ? Number(at) : undefined;
  const loads = useRef(0);
  const scrollTries = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(retry.current), []);
  const from = view.from;
  const loadingEarlier = !!view.loadingEarlier;
  useEffect(() => {
    if (target === undefined || loadingEarlier) return;
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
      clearTimeout(retry.current);
      setPosition("history");
      viewPosition.current = 0.5;
      viewOffset.current = 0;
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
      router.setParams({ at: undefined });
    }, 300);
    return () => clearTimeout(timer);
  }, [target, from, loadingEarlier, data, chatId, list, setPosition]);

  // "Show beginning of completed response": once a reply this phone saw under way has finished and
  // is drawn, the list scrolls once so the reply's top is at the top of the view (completion.ts has
  // the rules). Each change waits a moment again, so a refresh right after the reply lands first.
  const completionPosition = useChatPrefs((prefs) => prefs.completionPosition);
  const onShow = useOnShow();
  const still = useReducedMotion();
  const turnLive = streaming || !!underWay(runPart);
  const inFront = useWatchedReasoning(chatId, onShow && turnLive && thinkingPref === "show");
  useLayoutEffect(() => {
    if (position === "latest") clearTimeout(retry.current);
    if (turnLive && position === "completion") followLatest();
  }, [turnLive, position, followLatest]);
  useEffect(() => {
    const step = completions.check(chatId, {
      mode: completionPosition,
      running: runPart,
      messages: view.messages,
      from: view.from,
      runs: view.runs,
      visible: onShow && inFront,
      // Read while the reply streams (completion.ts keeps it with the run): a reply that lands all at once moves the list too.
      following: position !== "history",
      drawn: !turnLive && !data.some((item) => item.kind === "live"),
    });
    if (step.kind !== "jump") return;
    if (position === "history" || pending.length) {
      completions.done(chatId, step.runId);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const index = data.findIndex((item) => item.kind === "message" && item.index === step.index);
      if (index < 0) return;
      const land = (replyTop?: number) => {
        if (cancelled) return;
        completions.done(chatId, step.runId);
        clearTimeout(retry.current);
        // At the latest position, a short reply and the activity beneath it can fit together.
        // Scrolling to that reply alone would put its activity under the composer.
        if (replyTop !== undefined && frame.current.height > 0 &&
            replyTop - scrolled.current >= frame.current.top + edges.current.top) {
          followLatest();
          return;
        }
        setPosition("completion");
        scrollTries.current = 0;
        viewPosition.current = 1;
        viewOffset.current = -edges.current.top;
        list.current?.scrollToIndex({ index, viewPosition: 1, viewOffset: viewOffset.current, animated: !still });
      };
      if (step.index === view.from + view.messages.length - 1 && latestReply.current) {
        latestReply.current.measureInWindow((_x, top, _width, height) => land(height > 0 ? top : undefined));
      } else land();
    }, SETTLE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [view, runPart, data, completionPosition, onShow, inFront, position, turnLive, pending.length, chatId, still, list, setPosition, followLatest]);

  // A trailing live fold already reserves the capsule's place. All other tails, including
  // optimistic messages and steps that arrive before the stream, need that room in the inset.
  const hasStatusRow = !pending.length && data[0]?.kind === "fold" && data[0].live;
  const listBottom = hasStatusRow ? room.dock : room.bottom;
  // The live island as the newest row: the screen shows the capsule once it is scrolled under the message box.
  const islandNewest = hasStatusRow && data[0]?.kind === "fold" && !!data[0].island;
  useEffect(() => viewport.trackIsland(islandNewest), [viewport, islandNewest]);
  const finishDrag = (offset: number) => {
    if (position === "history" && offset <= HIDE_AT) followLatest();
  };
  if (emptyView) return emptyView;
  return (
    <View ref={listBox} collapsable={false} onLayout={measureList} style={{ flex: 1 }} {...selectionEnds}>
      <EdgeFree>
        <FlatList
          ref={list}
          inverted
          viewabilityConfig={VIEWABILITY}
          onViewableItemsChanged={viewport.onViewableItemsChanged}
          // How far the newest message is out of view. While a reply is written and the person has
          // scrolled up to read, the list stays where they are (maintainVisibleContentPosition
          // below), and the button offers the way back.
          onScroll={(event) => {
            scrolled.current = event.nativeEvent.contentOffset.y;
            viewport.scrolled(event.nativeEvent.contentOffset.y);
            const next = showsAt(event.nativeEvent.contentOffset.y, away.current);
            if (next !== away.current) {
              away.current = next;
              setAway(next);
            }
          }}
          scrollEventThrottle={64}
          onScrollBeginDrag={() => {
            clearTimeout(retry.current);
            setPosition("history");
          }}
          onScrollEndDrag={({ nativeEvent }) => {
            if (nativeEvent.targetContentOffset) finishDrag(nativeEvent.targetContentOffset.y);
            else if (!nativeEvent.velocity?.y) finishDrag(nativeEvent.contentOffset.y);
          }}
          onMomentumScrollEnd={({ nativeEvent }) => finishDrag(nativeEvent.contentOffset.y)}
          data={data}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => (
            <TimelineRow item={item} chatId={chatId} group={group} bot={bot} bots={bots} sendText={sendText}
              draftText={draftText} messageActions={messageActions} openPanel={openPanel} holdFold={holdFold} viewport={viewport} continues={continuing.has(item.key)}
              replyRef={item.kind === "message" && item.latest && item.message.role === "assistant" ? latestReply : undefined}
              active={onShow && inFront && (item.kind === "screen" || item.kind === "live" || (item.kind === "fold" && !!item.live))} />
          )}
          style={{ flex: 1 }}
          // Inverted: the content's top is the screen's bottom, under the message box.
          contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: space.lg + listBottom, paddingBottom: space.lg + room.top }}
          ItemSeparatorComponent={Gap}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          // The room for the bar and the message box is the content's own padding (room): the system
          // adding the bar's height again would land at the wrong end of the inverted list.
          contentInsetAdjustmentBehavior="never"
          showsVerticalScrollIndicator={false}
          maintainVisibleContentPosition={position === "latest" ? FOLLOW_LATEST : HOLD_POSITION}
          onEndReached={() => view.from > 0 && void loadEarlier(chatId)}
          // A message not drawn yet: go near it by the rows' average height, then to it.
          onScrollToIndexFailed={(info) => {
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            clearTimeout(retry.current);
            if (scrollTries.current++ < 4) retry.current = setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: viewPosition.current, viewOffset: viewOffset.current, animated: !still }), 160);
          }}
          onEndReachedThreshold={0.6}
          ListHeaderComponent={pending.length ? (
            <View style={{ gap: space.xl, marginTop: data.length ? space.xl : 0 }}>
              {pending.map(message => <UserBubble key={message.clientMessageId} id={message.clientMessageId}
                message={message} index={-1} timestamps={timestamps} media={[]} />)}
            </View>
          ) : undefined}
          ListFooterComponent={view.loadingEarlier ? <ActivityIndicator color={colors.muted} style={{ paddingVertical: space.lg }} /> : undefined}
          initialNumToRender={12}
          windowSize={11}
        />
      </EdgeFree>
      <ScrollToLatest
        bottom={room.bottom + space.sm}
        shown={awayNow}
        onPress={() => {
          followLatest(!still);
          away.current = false;
          setAway(false);
        }}
      />
    </View>
  );
}

/**
 * `pane` shows the chat beside the Chats list (two panes, see split.ts) instead of on its own page:
 * it draws its own bar, and `onLeave` takes the place of going back.
 */
function ChatScreenScreen({ pane: paneId, onLeave: leavePane, onList }: { pane?: string; onLeave?: () => void; onList?: () => void }) {
  const { colors } = useTheme();
  // `board` pins a Today card to the composer, for the first message (discussBoardItem in open.ts).
  // `at` lands on one message (its place in the whole chat, from 0): Open chat on an artifact.
  const params = useLocalSearchParams<{ id: string; draft?: string; board?: string; at?: string }>();
  const chatId = paneId ?? params.id;
  const { draft, board, at } = paneId ? { draft: undefined, board: undefined, at: undefined } : params;
  const shape = useShape();
  const leave = () => (leavePane ? leavePane() : router.back());
  const openChat = (id: string) => (paneId ? useChatSplit.setState({ id }) : router.push({ pathname: "/chat/[id]", params: { id } }));
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  // A bot's request leaves room for the bar above it and the composer below it, also over the keyboard.
  const keyboardUp = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const requestRoom = Math.max(200, Math.min(screenHeight * 0.6, screenHeight - (keyboardUp ? keyboardHeight : insets.bottom) - insets.top - 168));
  const chat = useChat(chatId);
  const focused = useIsFocused();
  const view = useWatchedChat(chatId, focused);
  const pending = useSyncExternalStore(pendingSends.subscribe, () => pendingSends.rows(chatId));
  const bot = useBot(chat?.botId);
  const allBots = useBots();
  const bots = useMemo(() => new Map(allBots.map((b) => [b.id, b])), [allBots]);
  const settings = useSettings();
  const models = useModels();
  const state = useChatActivity(chatId);
  const streaming = useApp((state) => Object.hasOwn(state.parts.live?.streams ?? {}, chatId));
  // The chat's run part: the turn under way, or its newest turn when that ended without a reply.
  const selectRun = useMemo(createTimelineRunSelector, [chatId]);
  const runPart = useApp((state) => selectRun(state.running[chatId]));
  const turnRun = underWay(runPart);
  const liveRequests = useApp((state) => state.parts.live?.requests);
  const requests = useMemo(() => liveRequests?.filter((request) => request.chatId === chatId) ?? [], [liveRequests, chatId]);
  const queued = useApp((state) => state.parts.live?.queued[chatId]);
  const steerable = useApp((state) => !!state.parts.live?.steerable?.[chatId]);
  const working = streaming || !!turnRun;
  // With the island (Steps or Thinking Open) the capsule shows only while the island is scrolled out of view.
  const [viewport] = useState(createChatViewport);
  const island = useChatPrefs(islandOn);
  // Worked out against the message box while the island is the newest row; else by the list's viewability.
  const islandAbove = useStore(viewport.island);
  const islandRow = useStore(viewport.rows, (rows) => !!turnRun && rows.has("f:" + turnRun.id));
  const islandInView = islandAbove ?? islandRow;
  const showCapsule = capsuleShown({ working, island: island && !!turnRun, islandInView });
  const group = !!chat?.botIds && chat.botIds.length > 1;
  const canChat = useCan("agents", "chat");

  // Unfolding on a chat that came from the Chats list: it goes back beside the list, still chosen.
  // Only while this page is in front: with a sheet over it, going back would close the sheet.
  const splitActive = useChatSplit((split) => split.active);
  useEffect(() => {
    if (paneId || !splitActive || !focused || useChatSplit.getState().pushed !== chatId) return;
    useChatSplit.setState({ id: chatId, pushed: null });
    if (router.canGoBack()) router.back();
  }, [paneId, splitActive, focused, chatId]);
  useEffect(() => {
    if (paneId) return;
    return () => {
      if (useChatSplit.getState().pushed === chatId) useChatSplit.setState({ pushed: null });
    };
  }, [paneId, chatId]);
  // A draft goes with the chat between the pane and its own page (folding or unfolding the phone).
  const [text, setText] = useState(draft ?? drafts.get(chatId)?.text ?? "");
  useEffect(() => {
    keepDraft(chatId, { text });
  }, [chatId, text]);
  const [pinnedId, setPinnedId] = useState(board);
  const pinned = usePart("board")?.find((item) => item.id === pinnedId);
  const meta = usePart("meta");
  const liveTyping = useApp((state) => (chatId ? state.parts.live?.typing?.[chatId] : undefined));
  const typingLabel = formatTypingLabel(liveTyping, myself(meta));
  const boardMentions = !!meta?.capabilities.includes("board-mentions-v1");
  const unpin = () => {
    setPinnedId(undefined);
    if (board) router.setParams({ board: undefined });
  };
  const [leaving, setLeaving] = useState(false);
  // Only while the chat isn't in the list: it is loading until the computer says it's gone, and blank on a page being left.
  const missing = useChatScreenState(chatId, leaving || !focused);
  // A message being replied to (Reply in its menu): it goes with the next message as a quote.
  const [quote, setQuote] = useState(() => drafts.get(chatId)?.quote ?? "");
  useEffect(() => {
    keepDraft(chatId, { quote });
  }, [chatId, quote]);
  // The latest side question (/btw, /ask) and its answer, shown beside the chat and never in it.
  const [side, setSide] = useState<Side | null>(null);
  const projects = usePart("projects");
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const list = useRef<FlatList<Item>>(null);
  // An automatic completion jump lasts one turn. An intentional scroll into history lasts until
  // the person returns to the latest content or sends a message.
  const [position, setPosition] = useState<ChatPosition>("latest");
  const followLatest = useCallback((animated = false) => {
    setPosition("latest");
    list.current?.scrollToOffset({ offset: 0, animated });
  }, []);
  // Opening a chat wakes its bot up and marks it read.
  useEffect(() => {
    if (chatId) api.warmChat(chatId).catch(() => {});
  }, [chatId]);
  // Leaving a chat nobody wrote in archives it (archivesWhenLeft in habits.ts), so chats that were
  // only opened don't pile up. Read when the screen goes away, from the store as it is then.
  const onLeave = useRef({ draft: text, wrote: false });
  useEffect(() => {
    onLeave.current.draft = text;
  });
  useEffect(() => {
    if (!chatId) return;
    const held = onLeave.current;
    return () => {
      if (held.wrote) return;
      const now = useApp.getState();
      const live = now.parts.live;
      const left = {
        messages: now.chats[chatId]?.messages.length ?? 0,
        working: !!underWay(now.running[chatId]) || (!!live && chatId in live.streams),
        waiting: live?.queued[chatId]?.length ?? 0,
        draft: held.draft,
      };
      if (archivesWhenLeft(now.parts.chats?.find((item) => item.id === chatId), left)) api.setChatFlags(chatId, { archived: true }).catch(() => {});
    };
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

  // The helpers of the chat's newest turn, above the composer.
  const newest = runPart ?? (view && latestTurn(undefined, view.messages, view.runs));

  const todos = sessionTodos(newest?.todos, view?.todos);
  const [todoDrawerChat, setTodoDrawerChat] = useState<string>();
  const hasTodos = !!todos?.length;
  const todoOpen = hasTodos && todoDrawerChat === chatId;
  useEffect(() => {
    if (!hasTodos || todoDrawerChat !== chatId) setTodoDrawerChat(undefined);
  }, [chatId, hasTodos, todoDrawerChat]);

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
  const send = (value: string, options?: SendOptions, fromComposer = true, mentions: DraftMention[] = []): Promise<boolean> => {
    const command = fromComposer ? options?.command : undefined;
    const typed = value.trim();
    const composed = command ? composeSlashPrompt(value, command) : typed;
    // "/btw" and "/ask" are answered beside the chat, also while the bot works.
    const asked = fromComposer && chatId ? sideQuestionOf(composed) : null;
    if (asked) return Promise.resolve(askSide(asked.command, asked.question));
    if (chat?.main && fromComposer && composed.toLowerCase() === "/clear") {
      return attempt(api.changeMainFork(chatId, "reset", undefined, chat.activeFork)).then(id => {
        if (id) setText("");
        return !!id;
      });
    }
    const card = fromComposer ? pinned : undefined;
    const quoted = fromComposer ? quote : "";
    const files = options?.attachments?.length ?? 0;
    if ((!composed && !files && !card) || !chatId) return Promise.resolve(false);
    // The computer wants some words with a file, so files sent alone get a plain line.
    let message = composed || (files === 1 ? "See the attached file." : files ? "See the attached files." : "");
    let sent: Omit<SendOptions, "command"> | undefined = options
      ? {
          ...(options.mentions ? { mentions: options.mentions } : {}),
          ...(options.attachments ? { attachments: options.attachments } : {}),
          ...(options.quote ? { quote: options.quote } : {}),
        }
      : undefined;
    // A pinned Today card goes with the first message: as a mention where the computer takes one,
    // else as a quote at the top of the text, so the bot always gets it and the chat shows it.
    if (card) {
      if (boardMentions) {
        message ||= "Let's talk about this.";
        sent = { ...sent, mentions: [{ kind: "board" as const, id: card.id }, ...(sent?.mentions ?? [])].slice(0, MAX_MENTIONS) };
      } else message = withBoardQuote(card, message);
      unpin();
    }
    if (quoted) {
      sent = { ...sent, quote: quoted };
      setQuote("");
    }
    setText("");
    onLeave.current.wrote = true;
    followLatest();
    const clientMessageId = randomUUID();
    const withIds = meta?.capabilities.includes("client-message-id-v1");
    const before = { length: view?.total ?? chat?.count ?? 0, waiting: waitingCopies(message, queued), clientMessageId: withIds ? clientMessageId : undefined };
    const bubble = { role: "user" as const, text: message, clientMessageId, time: Date.now(), attachments: sent?.attachments, quote: quoted,
      mentions: card && boardMentions ? [{ kind: "board" as const, id: card.id, label: card.title, body: card.body, board: card.kind }, ...mentions].slice(0, MAX_MENTIONS) : mentions };
    const legacy = withIds ? undefined : { from: before.length, queued: new Set(queued?.map(q => q.id)) };
    // While the chat works, the message steers the turn where the provider takes one, as on the desktop app.
    return pendingSends.send(chatId, bubble, () => api.send(chatId, message, {
      ...sent, ...(withIds && { clientMessageId }), ...(working && { delivery: "steer" }),
    }), legacy).then(
      () => true,
      (error: unknown) => {
        // The computer can take a message and its answer still be lost on the way back. Then the
        // message is in the chat (or waiting its turn), and putting the draft back would show it twice.
        const now = useApp.getState();
        if (arrived(message, before, now.chats[chatId], now.parts.live?.queued[chatId])) return true;
        if (card) setPinnedId(card.id);
        if (quoted) setQuote((current) => current || quoted);
        setText(current => [typed, current].filter(Boolean).join("\n"));
        // It can also arrive a moment after the failure: the draft is taken out again then (below).
        setUnsure({ text: typed, message, before });
        showToast(error instanceof Error ? error.message : "Couldn't send that.", "error");
        return false;
      },
    );
  };
  // A draft put back after a send that seemed to fail, while it is still as it was put back.
  const [unsure, setUnsure] = useState<{ text: string; message: string; before: { length: number; waiting: number; clientMessageId?: string } } | null>(null);
  const landed = !!unsure && arrived(unsure.message, unsure.before, view, queued);
  useEffect(() => {
    if (!unsure) return;
    if (text !== unsure.text) setUnsure(null);
    else if (landed) {
      setUnsure(null);
      setText("");
    }
  }, [unsure, text, landed]);
  // What every row of the list is handed stays the same function from one render to the next. This
  // screen renders on every keystroke and on every change from the computer, and a row whose props
  // changed is drawn again: with a new function each time, every message in view was.
  const latest = useRef({ send });
  useEffect(() => {
    latest.current = { send };
  });
  // A reply's own buttons send plain text; a pinned card waits for the person's message.
  const sendText = useCallback((value: string) => void latest.current.send(value, undefined, false), []);
  // A custom view hands over text: it goes after what is already written, for the person to read and send.
  const draftText = useCallback((value: string) => setText((current) => (current.trim() ? current.replace(/\s+$/, "") + "\n" + value : value)), []);
  // The side pane a bot opened beside this chat: its sheet opens when a bot asks, and text a view in it hands over lands in the message box.
  const pane = usePane(chatId, draftText);
  const showPulls = meta?.you?.kind !== "member" && meta?.capabilities.includes("pr-panel-v1");
  const openMessageLink = useCallback((url: string) => {
    const target = showPulls && pullRequestUrl(url);
    if (target) router.push({ pathname: "/chat/pane", params: { chatId, pull: target.url } });
    else openLink(url);
  }, [chatId, showPulls]);
  // Reply and Fork from here, in each message's menu. A group chat can't be forked.
  const reactionsOn = useCapability("message-reactions-v1");
  const [reaction, setReaction] = useState<{chatId: string; computer?: string; index: number; time?: number}>();
  const computer = useApp(state => state.pairing?.serverId);
  const messageActions = useMemo<MessageActions>(
    () => ({
      onReact: reactionsOn ? (index, time) => setReaction({ chatId, computer, index, time }) : undefined,
      onReply: (value) => {
        setQuote(quoteOf(value));
        input.current?.focus();
      },
      onFork: group ? undefined : index => void attempt(api.forkChat(chatId, index)).then(id => id && openChat(id)),
      onMainFork: chat?.main && (chat.createdBy ?? "owner") === myself(meta)
        ? index => void attempt(api.changeMainFork(chatId, "fork", index, chat.activeFork)) : undefined,
      busy: working,
    }),
    [group, chat?.main, chat?.activeFork, chat?.createdBy, meta?.you, chatId, working, paneId, computer, reactionsOn],
  );
  const pick = (starter: string) => {
    setText(starter);
    input.current?.focus();
  };
  const remove = async () => {
    setLeaving(true);
    const done = await attempt(api.deleteChat(chatId).then(() => true));
    if (done) leave();
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
    if (readAloud && lastMessage?.role === "assistant" && lastMessage.text) speakText(chatId + ":" + lastKey, lastMessage.text, { queue: true, quiet: true, botId: lastMessage.botId ?? chat?.botId });
  }, [view, lastKey, lastMessage, readAloud, chatId, chat?.botId]);
  // Leaving the chat ends what is being read, and a talk in this chat.
  useEffect(
    () => () => {
      if (useTalk.getState().chatId === chatId) endTalk();
      stopSpeech();
      endSelecting();
    },
    [chatId],
  );

  // Live voice in this chat takes the message box's place as the voice dock, until the person types.
  const docked = useLiveCall((state) => state.call?.chatId === chatId && !state.call.typing);
  // The dock's keyboard button puts the message box back with the keyboard up.
  const typingInCall = useLiveCall((state) => state.call?.chatId === chatId && state.call.typing);
  useEffect(() => {
    if (typingInCall) input.current?.focus();
  }, [typingInCall]);

  // The composer rides the keyboard; with the keyboard down it clears the home indicator.
  const keyboard = useReanimatedKeyboardAnimation();
  // A pane in the Chats tab keeps its composer above a tab bar at the bottom (none when the bar is the side rail).
  const bottomInset = insets.bottom + (paneId ? shape.tabRoom : 0);
  const spacer = useAnimatedStyle(() => ({ height: Math.max(Math.abs(keyboard.height.value), bottomInset) }));
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
  // T3 Code's open chat: on a phone with Liquid Glass (or an active backdrop on iOS) the bar is see-through
  // and the chat scrolls under it, behind a soft fade, and the message box floats over the chat on glass.
  const glassBar = !paneId && (hasGlass() || (hasBackdrop && Platform.OS === "ios"));
  const barHeight = useContext(HeaderHeightContext) ?? 0;
  const [paneBar, setPaneBar] = useState(0);
  const [banners, setBanners] = useState(0);
  const [dock, setDock] = useState(0);
  const topBar = glassBar ? barHeight : paneId ? paneBar : 0;

  if (leaving)
    return (
      <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
        {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      </View>
    );
  if (!chat)
    return (
      <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas, justifyContent: "center" }}>
        {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
        {missing === "gone" && !paneId ? <EmptyState icon={X} title="This chat is gone" action="Back" onAction={leave} /> : missing === "loading" || paneId ? <Loading /> : null}
      </View>
    );

  const empty = !!view && view.messages.length === 0 && !pending.length && !working;
  const measured = chat.context && chat.context.limit > 0 ? chat.context : undefined;
  const barEnd = (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {measured && <ContextMeter chatId={chat.id} context={measured} />}
      <ChatMenu chat={chat} bot={bot} bots={bots} started={!!view && view.messages.length > 0} projects={projects} settings={settings} onDelete={() => void remove()} panes={pane.tabs} onPane={() => pane.show()} onOpen={paneId ? openChat : undefined} />
    </View>
  );
  const header = paneId ? (
    // Beside the list there is no navigation bar: the pane draws the same title and menu itself.
    // It floats over the chat as the see-through bar does, with no line under it.
    <View onLayout={(event) => setPaneBar(Math.round(event.nativeEvent.layout.height))} style={{ position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: onList ? space.sm : space.lg, paddingRight: space.sm, paddingTop: insets.top + space.xs, paddingBottom: space.xs }}>
      {onList && <IconButton icon={PanelLeft} label="Chats" onPress={onList} />}
      <View style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}>
        <ChatTitle chat={chat} bot={bot} bots={bots} state={state} model={model.name} room={260} docked={docked} />
      </View>
      {barEnd}
    </View>
  ) : (
    <Stack.Screen
      options={{
        headerTitle: () => <ChatTitle chat={chat} bot={bot} bots={bots} state={state} model={model.name} room={measured ? 206 : 150} docked={docked} />,
        headerRight: () => barEnd,
        // See-through. The chat's list turns the system's edge effect off (EdgeFree), and the fade under the bar is drawn here (Fade).
        ...(glassBar && { headerTransparent: true, headerStyle: { backgroundColor: "transparent" } }),
      }}
    />
  );

  // Half folded like a book (iPhone Duo), a chat in a project shows what its bot changed on the
  // second page, and the chat keeps to the first, clear of the fold.
  const project = projects?.find((item) => item.id === chat.projectId);
  const book = shape.pose === "book" && shape.fold && project?.folder && (!paneId || !!onList) ? shape.fold : null;
  const todoRoom = canChat && hasTodos ? CAPSULE + space.sm : 0;
  const room = { top: topBar + banners, dock: dock + todoRoom, bottom: dock + (working || hasTodos ? CAPSULE + space.sm : 0) };
  const column = (
    <MessageLink.Provider value={showPulls ? openMessageLink : openLink}>
    <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      {reaction?.chatId === chatId && reaction.computer === computer && <ReactionPicker close={() => setReaction(undefined)} submit={emoji => {
        setReaction(undefined);
        void attempt(reactToMessage(chatId, reaction.index, reaction.time ?? null, emoji));
      }} />}
      {!paneId && header}
      {/* The chat fills this; the bar, the banners and the message box float over it. */}
      <View style={{ flex: 1 }}>
        {!view && !pending.length ? (
          <View style={{ flex: 1, justifyContent: "center" }}>
            <Loading />
          </View>
        ) : (
          <ChatPeopleLook chat={chat} bots={bots}>
            <ChatTimelineList
              chatId={chatId} view={view ?? EMPTY_CHAT} pending={pending} runPart={runPart} streaming={streaming} group={group} bot={bot} bots={bots}
              at={at} list={list} position={position} setPosition={setPosition} followLatest={followLatest} sendText={sendText} draftText={draftText} messageActions={messageActions} openPanel={pane.show}
              room={room} viewport={viewport}
              emptyView={empty && (
                <View style={{ flex: 1, paddingTop: room.top, paddingBottom: room.bottom }}>
                  <Hello chat={chat} bot={bot} bots={bots} projects={projects} settings={settings} onPick={pick} />
                </View>
              )}
            />
          </ChatPeopleLook>
        )}
        {topBar > 0 && <Fade edge="top" cover={topBar} />}
        {paneId && header}
        <View onLayout={(event) => setBanners(Math.round(event.nativeEvent.layout.height))} style={{ position: "absolute", top: topBar, left: 0, right: 0 }}>
          <RoutineBanner chat={chat} />
          <View style={{ paddingHorizontal: space.lg }}>
            <LinkBanner />
          </View>
        </View>
        <Fade edge="bottom" cover={dock} />
        {canChat && (working || hasTodos) && (
          <View pointerEvents="box-none" style={{ position: "absolute", left: space.sm, right: space.sm, bottom: dock + space.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm }}>
            {showCapsule && <StatusCapsule chatId={chatId} bot={bot} group={group} bots={bots} run={turnRun} />}
            {hasTodos && <Chip label={todoLabel(todos)} selected={todoOpen} onPress={() => setTodoDrawerChat(todoOpen ? undefined : chatId)} />}
          </View>
        )}
        {/* A touch on the message box or anything beside it ends a text selection in the chat. */}
        <View onLayout={(event) => setDock(Math.round(event.nativeEvent.layout.height))} style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: space.xs, paddingBottom: space.sm, gap: space.sm }} onTouchStart={endSelecting}>
          {canChat && todoOpen && (
            <ScrollView style={{ maxHeight: Math.min(240, requestRoom / 2), marginHorizontal: space.md }} keyboardShouldPersistTaps="handled">
              <TodoList todos={todos} />
              {!working && todos.some(todo => !closed(todo)) && <Chip label="Transfer and continue todos" onPress={() => sendText(TRANSFER_TODOS)} />}
            </ScrollView>
          )}
          {railShown(newest) && newest && <HelperRail chatId={chatId} run={newest} />}
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
          {canChat && !!queued?.length && <Queued chatId={chatId} items={queued} steerable={steerable} />}
          {canChat && chat.hostDispatch ? (
            working && <View style={{ paddingHorizontal: space.md }}><Button title="Stop request" variant="secondary" onPress={() => void attempt(api.stop(chatId))} /></View>
          ) : canChat ? (
            <View style={{ paddingHorizontal: space.md, gap: space.sm }}>
              <TalkBar chatId={chatId} />
              <VoiceDock chatId={chatId} />
              {!docked && !!typingLabel && <TypingRow label={typingLabel} />}
              {!docked && <Composer
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
                onSend={(options, mentions) => send(text, options, true, mentions)}
                onStop={() => void attempt(api.stop(chatId))}
                working={working}
                placeholder={"Message " + (group ? chat.title || "the group" : (bot?.name ?? "your bot"))}
                model={model}
                inputRef={input}
              />}
            </View>
          ) : (
            <T variant="footnote" color="muted" center style={{ paddingVertical: space.md }}>
              You can view, not chat
            </T>
          )}
        </View>
      </View>
      <Animated.View style={spacer} />
    </View>
    </MessageLink.Provider>
  );
  if (!book || !project) return column;
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      <View style={{ width: Math.max(0, book.x - shape.left) }}>{column}</View>
      <View style={{ width: book.width }} />
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <ChangesView id={project.id} chatId={chat.id} inline />
      </View>
    </View>
  );
}

function Gap() {
  return <View style={{ height: space.xl }} />;
}

const NO_EDGES = { top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" } as const;

/**
 * Turns iOS 26's scroll edge effect off for the list inside. Behind the see-through bar the system
 * blurs the chat's content where it passes under the bar, but the list is inverted (flipped), so
 * the blur covered all of the chat below the bar instead. The fade under the bar is drawn by the
 * screen (Fade). The marker holds exactly one child, and it must be the list itself.
 */
function EdgeFree({ children }: { children: ReactNode & {} }) {
  if (Platform.OS !== "ios") return children;
  return (
    <ScrollViewMarker style={{ flex: 1 }} scrollEdgeEffects={NO_EDGES}>
      {children}
    </ScrollViewMarker>
  );
}

/**
 * The page's color under what floats over the chat: the bar at the top, the message box at the
 * bottom. It is solid under them (`cover`), so the rows never show through the title or the
 * buttons, and fades out over a short soft edge beyond, so there is no hard line where the chat ends.
 */
const FADE_EDGE = 28;
function Fade({ edge, cover }: { edge: "top" | "bottom"; cover: number }) {
  const { colors, dark } = useTheme();
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
  if (cover <= 0) return null;
  const top = edge === "top";
  if (hasBackdrop) {
    // Soft translucent scrim so floating Liquid Glass chrome visibly refracts the backdrop while keeping text legible.
    const base = backdropBaseColor(backdrop, dark, colors.canvas);
    const strong = tint(base, dark ? 0.56 : 0.5);
    const soft = tint(base, dark ? 0.24 : 0.2);
    const clear = tint(base, 0);
    return (
      <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, height: cover + FADE_EDGE, ...(top ? { top: 0 } : { bottom: 0 }) }}>
        <LinearGradient
          colors={top ? [strong, soft, clear] : [clear, soft, strong]}
          locations={top ? [0, 0.72, 1] : [0, 0.28, 1]}
          style={{ flex: 1 }}
        />
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, height: cover + FADE_EDGE, ...(top ? { top: 0 } : { bottom: 0 }) }}>
      {!top && <LinearGradient colors={[tint(colors.canvas, 0), colors.canvas]} style={{ height: FADE_EDGE }} />}
      <View style={{ height: cover, backgroundColor: colors.canvas }} />
      {top && <LinearGradient colors={[colors.canvas, tint(colors.canvas, 0)]} style={{ height: FADE_EDGE }} />}
    </View>
  );
}

/** In a chat only the header face, the working capsule's face and the live voice dock move; message and reply rows hold still. */
export default function ChatScreen(props: { pane?: string; onLeave?: () => void; onList?: () => void }) {
  return (
    <AvatarMotion on={false}>
      <ChatScreenScreen {...props} />
    </AvatarMotion>
  );
}

/** A chat beside the Chats list, when there is room for two panes (see split.ts). */
export function ChatPane({ id, onLeave, onList }: { id: string; onLeave: () => void; /** Shows the list again (book pose hides it). */ onList?: () => void }) {
  return <ChatScreen key={id} pane={id} onLeave={onLeave} onList={onList} />;
}
