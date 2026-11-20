import { router } from "expo-router";
import type { BoardItem } from "@/link/types";
import { api, attempt } from "@/state/link";
import { isConversation } from "@/state/hooks";
import { useApp } from "@/state/store";
import { boardMessage } from "./compose";

/** Opens the latest one-to-one chat with a bot, or starts one. */
export async function openBotChat(botId: string) {
  const chats = useApp.getState().parts.chats ?? [];
  const latest = chats.filter((chat) => chat.botId === botId && !chat.botIds && isConversation(chat)).sort((a, b) => b.time - a.time)[0];
  const id = latest?.id ?? (await attempt(api.createChat(botId)));
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
