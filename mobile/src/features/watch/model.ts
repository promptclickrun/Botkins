// The small, versioned state sent from iPhone to the companion Watch app. Pure logic keeps it easy
// to prove that one bot, one host and bounded chat text cross the device boundary.
import type { Bot, BotkinLook, ChatSummary, Message } from "@/link/types";
import { lookOf } from "@/data/botLook";
import { chatForTap } from "@/features/chat/habits";
import { activityLabel, chatActivity } from "@/state/sessionActivity";
import type { AppState, ChatView } from "@/state/store";

export const WATCH_PROTOCOL = 1;
export const WATCH_SNAPSHOT_BYTES = 32 * 1024;
export const WATCH_MESSAGE_LIMIT = 8;
export const WATCH_TEXT_LIMIT = 1_500;

export type WatchVoiceStatus = "idle" | "connecting" | "listening" | "thinking" | "talking" | "ended" | "error";
export type WatchVoice = {
  status: WatchVoiceStatus;
  sessionId?: string;
  chatId?: string;
  muted: boolean;
  push: boolean;
  problem?: string;
  level: number;
};
export type WatchBot = {
  id: string;
  name: string;
  role: string;
  look: BotkinLook;
};
export type WatchMessage = { id: string; who: "you" | "bot"; text: string; at?: number; final: boolean };
export type WatchChat = {
  id: string;
  title: string;
  updatedAt: number;
  activity: string;
  messages: WatchMessage[];
};
export type WatchSnapshot = {
  protocol: typeof WATCH_PROTOCOL;
  revision: number;
  at: number;
  computer: { id: string; name: string; online: boolean } | null;
  bot: WatchBot | null;
  chat: WatchChat | null;
  voice: WatchVoice;
};

export type WatchSnapshotInput = {
  state: Pick<AppState, "pairing" | "link" | "parts" | "chats" | "texts">;
  revision: number;
  voice?: Partial<WatchVoice>;
  /** Keep the active voice conversation visible even if a newer chat is opened on iPhone. */
  chatId?: string;
};

const clip = (text: unknown, max = WATCH_TEXT_LIMIT) => {
  if (typeof text !== "string") return "";
  const clean = text.replace(/\u0000/g, "").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
};

function watchBot(bot: Bot): WatchBot {
  return {
    id: bot.id,
    name: clip(bot.name, 120),
    role: clip(bot.role, 300),
    look: lookOf(bot),
  };
}

function messageId(message: Message, index: number) {
  return message.clientMessageId ?? message.voiceId ?? `${message.role}:${message.time ?? 0}:${index}`;
}

function messageWho(role: Message["role"]): WatchMessage["who"] {
  return role === "user" ? "you" : "bot";
}

function visibleMessages(view: ChatView | undefined, chat: ChatSummary): WatchMessage[] {
  const messages = (view?.messages ?? [])
    .filter((message) => message.role !== "command" && !message.answer)
    .slice(-WATCH_MESSAGE_LIMIT)
    .map((message, index) => ({
      id: messageId(message, view ? view.from + index : index),
      who: messageWho(message.role),
      text: clip(message.text),
      ...(message.time !== undefined && { at: message.time }),
      final: !message.voicePartial && !message.interim,
    }));
  if (messages.length || !chat.last || chat.last.role === "command") return messages;
  return [{
    id: `${chat.id}:last:${chat.last.time ?? chat.time}`,
    who: messageWho(chat.last.role),
    text: clip(chat.last.text),
    at: chat.last.time,
    final: true,
  }];
}

/** One bounded Watch view, with no pairing fields or unrelated bot/host data. */
export function watchSnapshotOf({ state, revision, voice = {}, chatId }: WatchSnapshotInput): WatchSnapshot {
  const pairing = state.pairing;
  const bots = state.parts.bots ?? [];
  const primary = bots.find((bot) => !bot.hidden);
  const selectedId = chatId ?? (primary ? chatForTap(state.parts.chats ?? [], primary.id, "latest")?.id : undefined);
  const summary = state.parts.chats?.find((chat) =>
    chat.id === selectedId &&
    !!primary &&
    chat.botId === primary.id &&
    !chat.botIds &&
    !chat.panelId &&
    !chat.schedules?.some((schedule) => schedule.routine),
  );
  const view = summary ? state.chats[summary.id] : undefined;
  const chat: WatchChat | null = primary && summary ? {
    id: summary.id,
    title: clip(summary.title, 300) || primary.name,
    updatedAt: summary.time,
    activity: activityLabel(chatActivity(state.parts.live, summary.id)),
    messages: visibleMessages(view, summary),
  } : null;
  const stream = summary ? state.texts[summary.id]?.stream : undefined;
  if (stream && chat && !chat.messages.some((message) => !message.final && message.who === "bot")) {
    chat.messages = [...chat.messages, {
      id: `${summary!.id}:stream`,
      who: "bot" as const,
      text: clip(stream),
      final: false,
    }].slice(-WATCH_MESSAGE_LIMIT);
  }
  return {
    protocol: WATCH_PROTOCOL,
    revision,
    at: Date.now(),
    computer: pairing ? { id: pairing.serverId, name: clip(pairing.name, 160), online: state.link === "online" } : null,
    bot: primary ? watchBot(primary) : null,
    chat,
    voice: {
      status: voice.status ?? "idle",
      ...(voice.sessionId && { sessionId: voice.sessionId }),
      ...(voice.chatId && { chatId: voice.chatId }),
      muted: voice.muted ?? false,
      push: voice.push ?? false,
      ...(voice.problem && { problem: clip(voice.problem, 500) }),
      level: Math.max(0, Math.min(voice.level ?? 0, 1)),
    },
  };
}

/** A JSON snapshot that always remains within the Watch application-context budget. */
export function encodeWatchSnapshot(snapshot: WatchSnapshot): string {
  let value = snapshot;
  let json = JSON.stringify(value);
  while (utf8Bytes(json) > WATCH_SNAPSHOT_BYTES && value.chat?.messages.length) {
    value = { ...value, chat: value.chat && { ...value.chat, messages: value.chat.messages.slice(1) } };
    json = JSON.stringify(value);
  }
  return json;
}

function utf8Bytes(value: string) {
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export type WatchCommand =
  | { command: "startVoice" }
  | { command: "mute"; value: boolean }
  | { command: "interrupt" }
  | { command: "press" }
  | { command: "release" }
  | { command: "endVoice" }
  | { command: "refresh" }
  | { command: "openOnPhone"; chatId?: string };

/** Only known controls with bounded IDs enter application code. */
export function parseWatchCommand(value: unknown): WatchCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const command = input.command;
  if (command === "mute") return typeof input.value === "boolean" ? { command, value: input.value } : null;
  if (command === "openOnPhone") {
    const chatId = typeof input.chatId === "string" && input.chatId.length <= 200 ? input.chatId : undefined;
    return { command, ...(chatId && { chatId }) };
  }
  if (command === "startVoice" || command === "interrupt" || command === "press" || command === "release" || command === "endVoice" || command === "refresh") {
    return { command };
  }
  return null;
}
