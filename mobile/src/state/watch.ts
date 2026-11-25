// Keeps the native companion Watch in step with the selected computer and primary Botkin. It reads
// only one bounded chat page and never registers that page as a visible iPhone chat.
import { WatchCompanion } from "../../modules/botkins-watch";
import { chatForTap } from "@/features/chat/habits";
import { chatActivity } from "./sessionActivity";
import type { ChatSummary } from "@/link/types";
import { showChat } from "@/features/open/opening";
import { encodeWatchSnapshot, parseWatchCommand, WATCH_MESSAGE_LIMIT, watchSnapshotOf, type WatchVoice } from "@/features/watch/model";
import {
  endWatchVoice,
  interruptWatchVoice,
  muteWatchVoice,
  pressWatchVoice,
  releaseWatchVoice,
  startWatchVoice,
  subscribeWatchVoice,
  watchVoiceState,
} from "@/features/watch/voice";
import { api } from "./link";
import { mergeChat, type ChatView, type PhoneParts, useApp } from "./store";

let begun = false;
let publishing: ReturnType<typeof setTimeout> | null = null;
const WATCH_PROGRESS_MS = 1_000;
const WATCH_AWAY_PROGRESS_MS = 15_000;
let disconnected: ReturnType<typeof setTimeout> | null = null;
let revision = Date.now();
let sentSignature = "";
let reachable = false;
let installed = false;
let selectedHost = "";
let pageChat = "";
let pageCount = -1;
let fetching = false;
let cleared = false;
let pages: Record<string, ChatView | undefined> = {};
const subs: { remove(): void }[] = [];
const stops: (() => void)[] = [];

let selection: {
  bots?: PhoneParts["bots"];
  chats?: PhoneParts["chats"];
  voiceChat?: string;
  chat: ChatSummary | null;
} | undefined;

function selectedChat(): ChatSummary | null {
  const { bots, chats } = useApp.getState().parts;
  const voiceChat = watchVoiceState().chatId;
  if (selection && selection.bots === bots && selection.chats === chats && selection.voiceChat === voiceChat) return selection.chat;
  const bot = bots?.find((item) => !item.hidden);
  let chat: ChatSummary | undefined;
  if (bot && chats) {
    if (voiceChat) chat = chats.find((item) => item.id === voiceChat && item.botId === bot.id);
    if (!chat) {
      const latest = chatForTap(chats, bot.id, "latest");
      if (latest) chat = chats.find((item) => item.id === latest.id);
    }
  }
  selection = { bots, chats, voiceChat, chat: chat ?? null };
  return selection.chat;
}

function hasWatchPage(local: ChatView | undefined, count: number) {
  return !!local && local.total === count && local.from <= Math.max(0, count - WATCH_MESSAGE_LIMIT) && local.from + local.messages.length === count;
}

function publish(durable = true) {
  if (publishing) clearTimeout(publishing);
  publishing = null;
  if (!WatchCompanion || !installed) return;
  const state = useApp.getState();
  const voice = watchVoiceState();
  const pending = watchSnapshotOf({
    state: {
      pairing: state.pairing,
      link: state.link,
      parts: state.parts,
      chats: hasWatchPage(state.chats[pageChat], pageCount) ? state.chats : { ...state.chats, ...pages },
      texts: state.texts,
    },
    revision: revision + 1,
    voice,
    chatId: voice.chatId ?? selectedChat()?.id,
  });
  if (!state.pairing) {
    if (!cleared) {
      cleared = true;
      sentSignature = "";
      void WatchCompanion.clear().catch(() => {});
    }
    return;
  }
  cleared = false;
  const signature = JSON.stringify({
    ...pending,
    revision: 0,
    at: 0,
    voice: { ...pending.voice, level: 0 },
  });
  if (signature === sentSignature) return;
  revision += 1;
  const snapshot = { ...pending, revision };
  const json = encodeWatchSnapshot(snapshot);
  sentSignature = signature;
  const delivery = !durable && WatchCompanion.updateProgress ? WatchCompanion.updateProgress(json) : WatchCompanion.update(json);
  void delivery.catch(() => {});
}

function publishSoon(immediate = false) {
  if (!installed) return;
  if (immediate) {
    publish();
  } else if (!publishing) {
    publishing = setTimeout(() => publish(false), reachable ? WATCH_PROGRESS_MS : WATCH_AWAY_PROGRESS_MS);
  }
}

async function refreshPage(force = false, immediate = false) {
  if (!installed) return;
  const state = useApp.getState();
  const chat = selectedChat();
  if (!chat || state.link !== "online") return;
  if (fetching) return;
  if (hasWatchPage(state.chats[chat.id], chat.count)) {
    pageChat = chat.id;
    pageCount = chat.count;
    pages = {};
    return;
  }
  if (!force && pageChat === chat.id && pageCount === chat.count && pages[chat.id]) return;
  fetching = true;
  pageChat = chat.id;
  pageCount = chat.count;
  try {
    const detail = await api["link.messages"](chat.id, chat.count, WATCH_MESSAGE_LIMIT);
    if (!detail || useApp.getState().pairing?.serverId !== state.pairing?.serverId) return;
    pages = { [chat.id]: mergeChat(undefined, detail) };
    pageCount = chat.count;
    publishSoon(immediate);
  } catch {
    // The bounded summary snapshot remains useful while the full page is offline.
  } finally {
    fetching = false;
    const current = selectedChat();
    if (current && (current.id !== pageChat || current.count !== pageCount)) void refreshPage(true);
  }
}

function hostChanged() {
  const next = useApp.getState().pairing?.serverId ?? "";
  if (next === selectedHost) return;
  const hadHost = !!selectedHost;
  selectedHost = next;
  pageChat = "";
  pageCount = -1;
  pages = {};
  sentSignature = "";
  if (hadHost) endWatchVoice("The paired computer changed.");
  if (!next) void WatchCompanion?.clear().catch(() => {});
  else void refreshPage(true, true);
  publishSoon(true);
}

function onCommand(value: unknown, commandRevision?: number, sessionId?: string) {
  const command = parseWatchCommand(value);
  if (!command) return;
  if (command.command !== "refresh" && typeof commandRevision === "number" && commandRevision < revision - 8) return;
  if (["mute", "interrupt", "press", "release", "endVoice"].includes(command.command)) {
    const active = watchVoiceState().sessionId;
    if (sessionId && active && sessionId !== active) return;
  }
  switch (command.command) {
    case "startVoice":
      void startWatchVoice();
      return;
    case "mute":
      muteWatchVoice(command.value);
      return;
    case "interrupt":
      interruptWatchVoice();
      return;
    case "press":
      pressWatchVoice();
      return;
    case "release":
      releaseWatchVoice();
      return;
    case "endVoice":
      endWatchVoice();
      return;
    case "refresh":
      void refreshPage(true, true);
      publishSoon(true);
      return;
    case "openOnPhone": {
      const chatId = command.chatId ?? selectedChat()?.id;
      if (chatId && chatId === selectedChat()?.id) showChat(chatId);
      return;
    }
  }
}

function disconnectSoon() {
  if (disconnected) clearTimeout(disconnected);
  disconnected = setTimeout(() => {
    disconnected = null;
    if (!reachable && watchVoiceState().status !== "idle" && watchVoiceState().status !== "ended") {
      endWatchVoice("The Watch and iPhone lost their connection.");
    }
  }, 3_000);
}

/** Starts once at app boot. Older and Android builds quietly do nothing. */
export async function startWatchCompanion() {
  if (begun || !WatchCompanion) return;
  begun = true;
  subs.push(
    WatchCompanion.addListener("command", (event) => onCommand(event.command, event.revision, event.sessionId)),
    WatchCompanion.addListener("reachability", (event) => {
      const nextInstalled = event.paired && event.installed;
      if (installed === nextInstalled && reachable === event.reachable) return;
      installed = nextInstalled;
      reachable = event.reachable;
      if (publishing) clearTimeout(publishing);
      publishing = null;
      if (reachable) {
        if (disconnected) clearTimeout(disconnected);
        disconnected = null;
        sentSignature = "";
        void refreshPage();
      } else if (watchVoiceState().sessionId) disconnectSoon();
      publishSoon(true);
    }),
  );
  let previousVoice: WatchVoice | undefined;
  let previousChat = selectedChat();
  stops.push(
    subscribeWatchVoice((voice) => {
      if (!installed) return;
      const previous = previousVoice;
      previousVoice = voice;
      if (previous && previous.status === voice.status && previous.sessionId === voice.sessionId &&
          previous.chatId === voice.chatId && previous.muted === voice.muted &&
          previous.push === voice.push && previous.problem === voice.problem) return;
      void refreshPage(false, true);
      publishSoon(true);
    }),
    useApp.subscribe((state, before) => {
      if (state.pairing?.serverId !== before.pairing?.serverId) {
        hostChanged();
        return;
      }
      if (!installed) return;
      const selected = selectedChat();
      const id = selected?.id;
      const beforeSelected = previousChat;
      previousChat = selected;
      const selectionChanged = id !== beforeSelected?.id;
      const oldActivity = id && state.parts.live !== before.parts.live ? chatActivity(before.parts.live, id) : undefined;
      const activity = oldActivity !== undefined && id ? chatActivity(state.parts.live, id) : undefined;
      const activityChanged = oldActivity !== activity;
      const milestone = selectionChanged || state.link !== before.link || (activityChanged &&
        (activity === "waiting" || oldActivity === "waiting" || activity === "idle" || oldActivity === "idle"));
      if (selectionChanged || selected?.count !== beforeSelected?.count || state.link !== before.link) void refreshPage(false, milestone);
      if (milestone || activityChanged || selected !== beforeSelected || state.parts.bots !== before.parts.bots ||
          (id && (state.chats[id] !== before.chats[id] || state.texts[id]?.stream !== before.texts[id]?.stream))) publishSoon(milestone);
    }),
  );
  await WatchCompanion.start();
  hostChanged();
  publish();
}

/** Used by controlled shutdowns and tests; production keeps one coordinator for the app lifetime. */
export function stopWatchCompanion() {
  if (publishing) clearTimeout(publishing);
  publishing = null;
  if (disconnected) clearTimeout(disconnected);
  disconnected = null;
  for (const subscription of subs.splice(0)) subscription.remove();
  for (const stop of stops.splice(0)) stop();
  endWatchVoice();
  installed = false;
  reachable = false;
  selection = undefined;
  begun = false;
}
