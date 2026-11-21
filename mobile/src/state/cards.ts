// One Live Activity per Botkin while the app is open ("activity-bots-v1"; docs/live-cards.md).
//
// The computer draws the cards while the app is closed (link-host/push.mjs). While it is open, the
// phone draws them from what it knows, with the same rules (link-host/cards.mjs), so a card looks
// the same whichever side drew it. The phone has a turn's steps and thinking only for the chat it
// follows (the one on screen); for the others a card shows the chat's title and what it is doing.
// No React Native imports: tests/cards.test.ts runs it.
import { botCard, type Card, type CardWorld } from "../../link-host/cards.mjs";
import type { ChatSummary, Run, RunSummary } from "@/link/types";
import type { PhoneParts } from "./store";

/** The most Botkins with a card at once. The computer keeps as many addresses for a phone. */
export const MAX_CARDS = 4;

type Known = {
  parts: Partial<Pick<PhoneParts, "bots" | "chats" | "runs" | "live" | "settings">>;
  /** The turn's detail for each chat the phone follows. */
  running: Record<string, Run | null | undefined>;
  /** The reply and thinking so far for each chat the phone follows. */
  texts: Record<string, { stream: string; thinking: string } | undefined>;
};

/** What the phone knows, in the shape the card rules read. */
export function cardWorld({ parts, running, texts }: Known): CardWorld {
  const runs: (RunSummary | Run)[] = (parts.runs ?? []).map((run) => (running[run.chatId]?.id === run.id ? running[run.chatId]! : run));
  for (const run of Object.values(running)) if (run && !runs.some((item) => item.id === run.id)) runs.push(run);
  const thinking: Record<string, string> = {};
  for (const [chatId, text] of Object.entries(texts)) if (text?.thinking) thinking[chatId] = text.thinking;
  const live = parts.live;
  return {
    bots: parts.bots,
    chats: parts.chats as CardWorld["chats"],
    runs: runs as CardWorld["runs"],
    requests: live?.requests,
    streams: live?.streams,
    thinking,
    intents: live?.intents,
    settings: parts.settings as CardWorld["settings"],
  };
}

/** A turn's reply as the phone knows it: the chat's newest message, when the bot wrote it after the turn began. */
function replyOf(chat: ChatSummary, run: RunSummary) {
  const last = chat.last;
  if (!last || last.role === "user" || (last.time !== undefined && last.time < run.time)) return undefined;
  return last.text;
}

/** A Botkin's card as the phone would draw it now, or null when it has no chat to show. */
export function phoneCard(known: Known, botId: string, previews: boolean, now = Date.now()): Card | null {
  return botCard(cardWorld(known), botId, { previews, now, reply: replyOf as never });
}

/**
 * The Botkins that should have a card now: each with a chat at work or waiting for the person, in
 * the order the person ordered them, at most MAX_CARDS. A card is not started for chats that only ended.
 */
export function botsWithWork(known: Known, now = Date.now()): string[] {
  const world = cardWorld(known);
  const wanted: string[] = [];
  for (const bot of known.parts.bots ?? []) {
    const card = botCard(world, bot.id, { previews: false, now });
    if (card && card.state.chats.some((chat) => chat.phase !== "done" && chat.phase !== "failed")) wanted.push(bot.id);
    if (wanted.length === MAX_CARDS) break;
  }
  return wanted;
}
