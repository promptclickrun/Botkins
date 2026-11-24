import type { Chat } from "./types";

/** Whether a chat counts toward its bot's unread dot in the side menu. */
export function isUnreadChat(chat: Pick<Chat, "panelId" | "archived" | "unread">): boolean {
  return !chat.panelId && !chat.archived && !!chat.unread;
}

/** The chats that make a bot's unread dot in the side menu. */
export function botUnreadChats<T extends Pick<Chat, "id" | "botId" | "panelId" | "archived" | "unread">>(
  chats: readonly T[],
  botId: string,
): T[] {
  return chats.filter((chat) => chat.botId === botId && isUnreadChat(chat));
}

/** Bot IDs that currently have an unread dot in the side menu. */
export function unreadBotIds(
  chats: readonly Pick<Chat, "botId" | "panelId" | "archived" | "unread">[],
): Set<string> {
  const out = new Set<string>();
  for (const chat of chats) {
    if (isUnreadChat(chat)) out.add(chat.botId);
  }
  return out;
}

/** Every non-archived, non-panel unread chat across all bots. */
export function allUnreadChats<T extends Pick<Chat, "id" | "panelId" | "archived" | "unread">>(
  chats: readonly T[],
): T[] {
  return chats.filter(isUnreadChat);
}

/** Spaces that currently show a changed marker in the side menu. */
export function changedSpaces<T extends { id: string; changed: number }>(
  spaces?: readonly T[],
): T[] {
  return (spaces ?? []).filter((space) => space.changed > 0);
}
