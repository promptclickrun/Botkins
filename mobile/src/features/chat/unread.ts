// Pure unread/changed helpers shared by Home's bot dots, BotMenu, Chats, and Spaces
// (no React Native imports; tests/unread.test.ts runs it). Mirrors desktop/src/unread.ts.
import type { ChatSummary, SpaceSummary } from "@/link/types";

/** Whether a chat is an active, unread conversation (excludes archived, panel, and routine chats). */
export function isUnreadConversation(chat: Pick<ChatSummary, "archived" | "panelId" | "schedules" | "unread">): boolean {
  return !chat.archived && !chat.panelId && !chat.schedules?.some((schedule) => schedule.routine) && !!chat.unread;
}

/** The one-to-one unread chats that light a bot's unread dot on Home. */
export function botUnreadChats<T extends Pick<ChatSummary, "id" | "botId" | "botIds" | "archived" | "panelId" | "schedules" | "unread">>(
  chats: readonly T[],
  botId: string,
): T[] {
  return chats.filter((chat) => !chat.botIds && chat.botId === botId && isUnreadConversation(chat));
}

/** Every unread conversation across all bots. */
export function allUnreadChats<T extends Pick<ChatSummary, "id" | "archived" | "panelId" | "schedules" | "unread">>(
  chats: readonly T[],
): T[] {
  return chats.filter(isUnreadConversation);
}

/** Spaces that currently show a changed dot. */
export function changedSpaces<T extends Pick<SpaceSummary, "id" | "changed">>(
  spaces: readonly T[],
): T[] {
  return spaces.filter((space) => space.changed > 0);
}
