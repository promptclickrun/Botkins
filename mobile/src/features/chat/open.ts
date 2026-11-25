import { router } from "expo-router";
import type { BoardItem } from "@/link/types";
import { api, attempt } from "@/state/link";
import { useChatPrefs } from "@/state/chatPrefs";
import { useApp } from "@/state/store";
import { boardMessage } from "./compose";
import { chatForTap } from "./habits";

/**
 * Selecting a bot opens Main chat by default. It can open the latest chat or a new one, as the person
 * chose in Settings › Chat ("When you select a bot"; chatForTap in habits.ts has the rule).
 */
export async function openBotChat(botId: string, tap = useChatPrefs.getState().botTap) {
  const { chats = [], meta } = useApp.getState().parts;
  const main = meta?.capabilities.includes("main-chat-v1");
  const held = chatForTap(chats, botId, tap === "main" && !main ? "latest" : tap, meta?.you?.kind === "member" ? meta.you.memberId : "owner");
  // An empty chat that was archived when it was left is used again.
  if (held?.archived) api.setChatFlags(held.id, { archived: false }).catch(() => {});
  const id = held?.id ?? (await attempt(tap === "main" && main ? api.mainChat(botId) : api.createChat(botId)));
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
