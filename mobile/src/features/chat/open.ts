import { router } from "expo-router";
import type { BoardItem } from "@/link/types";
import { api, attempt, boundApi } from "@/state/link";
import { useChatPrefs } from "@/state/chatPrefs";
import { showToast, useApp } from "@/state/store";
import { boardMessage } from "./compose";
import { chatForTap } from "./habits";
import { allUnreadChats, botUnreadChats, chatsPageUnreadChats, MARK_CHATS_READ_CAPABILITY, runMarkChatsRead } from "./unread";

async function clearChats(ids: string[], { quiet = false }: { quiet?: boolean } = {}) {
  if (ids.length === 0) return;
  const { api: bound, isCurrent } = boundApi();
  const hasBatch = useApp.getState().parts.meta?.capabilities.includes(MARK_CHATS_READ_CAPABILITY) ?? false;
  const result = await runMarkChatsRead(ids, {
    hasBatch,
    isCurrent,
    markChatsRead: (list) => bound.markChatsRead(list),
    setChatFlags: (id, flags) => bound.setChatFlags(id, flags),
  });
  if (!result.ok && !quiet && isCurrent()) {
    showToast(result.error instanceof Error && result.error.message ? result.error.message : "Couldn't mark as read.", "error");
  }
}

/** Marks every unread chat that lights this bot's dot on Home as read. */
export async function markBotRead(botId: string, options?: { quiet?: boolean }) {
  const chats = useApp.getState().parts.chats ?? [];
  const ids = botUnreadChats(chats, botId).map((chat) => chat.id);
  await clearChats(ids, options);
}

/** Marks every non-archived, non-panel unread chat across bots as read (matches Home bot dots / desktop side menu). */
export async function markAllChatsRead() {
  const chats = useApp.getState().parts.chats ?? [];
  const ids = allUnreadChats(chats).map((chat) => chat.id);
  await clearChats(ids);
}

/** Marks every unread chat on the Chats page as read (matches desktop Chats page, including panel and routine chats). */
export async function markChatsPageRead() {
  const chats = useApp.getState().parts.chats ?? [];
  const ids = chatsPageUnreadChats(chats).map((chat) => chat.id);
  await clearChats(ids);
}

/**
 * Selecting a bot: opens its latest one-to-one chat, or starts a new one each time, as the person
 * chose in Settings › Chat ("When you select a bot"; chatForTap in habits.ts has the rule).
 */
export async function openBotChat(botId: string) {
  const chats = useApp.getState().parts.chats ?? [];
  const held = chatForTap(chats, botId, useChatPrefs.getState().botTap);
  // An empty chat that was archived when it was left is used again.
  if (held?.archived) api.setChatFlags(held.id, { archived: false }).catch(() => {});
  void markBotRead(botId, { quiet: true });
  const id = held?.id ?? (await attempt(api.createChat(botId)));
  if (id) router.push({ pathname: "/chat/[id]", params: { id } });
}

/** Starts a fresh chat with a bot. */
export async function newBotChat(botId: string) {
  const id = await attempt(api.createChat(botId));
  if (id) router.push({ pathname: "/chat/[id]", params: { id } });
}

/**
 * Discuss on a Today card: starts a new chat with the card's bot, as the desktop does, and opens it
 * with the card pinned above the field. The card goes with the person's first message.
 */
export async function discussBoardItem(item: BoardItem) {
  const id = await attempt(api.createChat(item.botId));
  if (id) router.push({ pathname: "/chat/[id]", params: { id, board: item.id } });
}

/**
 * "Let's do it" on an idea, as on the desktop (src/Board.tsx): a new chat with the idea's bot opens,
 * "Let's do it! **title**" and the body are sent there, and then the idea is marked as said yes.
 */
export async function actOnIdea(item: BoardItem) {
  const id = await attempt(api.createChat(item.botId));
  if (!id) return;
  router.push({ pathname: "/chat/[id]", params: { id } });
  await attempt(api.send(id, boardMessage(item, "Let's do it!")).then(() => api.boardAct(item.id, "yes")));
}
