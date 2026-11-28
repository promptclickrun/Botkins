// The first tab's bot: the one the person was last with there, or their primary bot (the first in
// the computer's order). No React Native imports, so tests/home-bot.test.ts runs it.
import type { Bot, ChatSummary } from "@/link/types";
import { chatForTap } from "@/features/chat/habits";

type Listed = Pick<Bot, "id" | "hidden" | "pinned">;

/**
 * The bots the first tab offers, in order: the primary bot, the pinned ones, then the rest as the
 * computer keeps them. Hidden bots are left out, so a hidden primary hands over to the next bot.
 */
export function homeBots<B extends Listed>(bots: readonly B[]): B[] {
  const [primary, ...others] = bots.filter((bot) => !bot.hidden);
  if (!primary) return [];
  return [primary, ...others.filter((bot) => bot.pinned), ...others.filter((bot) => !bot.pinned)];
}

/** The bot the tab shows: the saved one while it is still offered, otherwise the first. */
export function pickHomeBot<B extends Listed>(shown: readonly B[], saved: string | null | undefined): B | undefined {
  return shown.find((bot) => bot.id === saved) ?? shown[0];
}

/**
 * The chat the tab shows for a bot: its Main chat where the computer has one for each bot and
 * person, otherwise its latest chat. `make` says what to do when there is none yet: a Main chat is
 * the computer's to make without a word from the person; an ordinary chat waits for a tap.
 */
export function homeChat(chats: ChatSummary[], botId: string, main: boolean, person = "owner"): { id: string } | { make: "main" | "ask" } {
  const held = chatForTap(chats, botId, main ? "main" : "latest", person);
  return held ? { id: held.id } : { make: main ? "main" : "ask" };
}
