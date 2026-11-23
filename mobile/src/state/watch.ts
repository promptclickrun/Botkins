// Keeps the native companion Watch in step with the selected computer and primary Botkin. It reads
// only one bounded chat page and never registers that page as a visible iPhone chat.
import { WatchCompanion } from "../../modules/botkins-watch";
import { chatForTap } from "@/features/chat/habits";
import { showChat } from "@/features/open/opening";
import { encodeWatchSnapshot, parseWatchCommand, watchSnapshotOf } from "@/features/watch/model";
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
import { mergeChat, type ChatView, useApp } from "./store";

let begun = false;
let publishing: ReturnType<typeof setTimeout> | null = null;
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

function selectedChat() {
  const state = useApp.getState();
  const bot = state.parts.bots?.find((item) => !item.hidden);
  if (!bot) return null;
  const voiceChat = watchVoiceState().chatId;
  if (voiceChat && state.parts.chats?.some((chat) => chat.id === voiceChat && chat.botId === bot.id)) {
    return state.parts.chats.find((chat) => chat.id === voiceChat) ?? null;
  }
  const selected = chatForTap(state.parts.chats ?? [], bot.id, "latest");
  if (!selected) return null;
  return state.parts.chats?.find((chat) => chat.id === selected.id) ?? null;
}

function publish() {
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
      chats: { ...state.chats, ...pages },
      texts: state.texts,
    },
    revision: revision + 1,
    voice,
    chatId: voice.chatId,
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
  void WatchCompanion.update(json).catch(() => {});
}

function publishSoon() {
  if (!installed || publishing) return;
  publishing = setTimeout(publish, 120);
}

async function refreshPage(force = false) {
  if (!installed) return;
  const state = useApp.getState();
  const chat = selectedChat();
  if (!chat || state.link !== "online") return;
  if (fetching) return;
  if (!force && pageChat === chat.id && pageCount === chat.count && pages[chat.id]) return;
  fetching = true;
  pageChat = chat.id;
  pageCount = chat.count;
  try {
    const detail = await api["link.messages"](chat.id, chat.count, 8);
    if (!detail || useApp.getState().pairing?.serverId !== state.pairing?.serverId) return;
    pages = { [chat.id]: mergeChat(undefined, detail) };
    pageCount = chat.count;
    publishSoon();
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
  else void refreshPage(true);
  publishSoon();
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
      void refreshPage(true);
      publishSoon();
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
      installed = event.paired && event.installed;
      reachable = event.reachable;
      if (reachable) {
        if (disconnected) clearTimeout(disconnected);
        disconnected = null;
        sentSignature = "";
        void refreshPage();
      } else disconnectSoon();
      publishSoon();
    }),
  );
  stops.push(
    subscribeWatchVoice(() => {
      const chat = selectedChat();
      if (chat && (chat.id !== pageChat || chat.count !== pageCount)) void refreshPage();
      publishSoon();
    }),
    useApp.subscribe((state, before) => {
      if (state.pairing?.serverId !== before.pairing?.serverId) hostChanged();
      if (
        state.parts.chats !== before.parts.chats ||
        state.parts.bots !== before.parts.bots ||
        state.parts.live !== before.parts.live ||
        state.texts !== before.texts ||
        state.chats !== before.chats ||
        state.link !== before.link
      ) {
        void refreshPage();
        publishSoon();
      }
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
  begun = false;
}
