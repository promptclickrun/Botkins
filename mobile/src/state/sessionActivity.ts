import type { PhoneParts, QuietLive } from "./store";
import type { BotkinState } from "@/data/botkinMotion";
import type { ChatSummary } from "@/link/types";

/**
 * What a bot is doing, as its avatar acts it out. Most are the design kit's own states. Three are
 * the app's words: "waiting" is a bot waiting for the person (the kit's Needs input), "talking" is
 * a reply being written, and "pending" is the kit's Waiting (something outside is pending).
 */
export type AvatarState = Exclude<BotkinState, "waiting"> | "waiting" | "pending" | "talking" | "happy" | "sleeping";

/** What a bot at work is busy with, read from its own one-line note about it ("Searching the wiki"). */
function busyWith(intent: string | undefined): AvatarState {
  const text = (intent ?? "").toLowerCase();
  if (/\b(search|brows|look(ing)? (up|for)|fetch|web|navigat|read(ing)? (the )?(page|site|docs?|wiki))/.test(text)) return "browsing";
  if (/\b(cod(e|ing)|edit|patch|run(ning)? |command|shell|test|build|debug|commit|refactor|install|writ\w* (the )?(file|code|script))/.test(text)) return "coding";
  if (/\b(plan|outlin|organi[sz]|to-?do|schedul|break(ing)? .* down)/.test(text)) return "planning";
  if (!text || /\b(think|consider|reason|ponder)/.test(text)) return "thinking";
  return "working";
}

/** What a chat's bot is doing: waiting for the person, writing a reply, some kind of work, or nothing. */
export function chatActivity(live: QuietLive | undefined, chatId: string): AvatarState {
  if (!live) return "idle";
  if (live.requests.some((request) => request.chatId === chatId)) return "waiting";
  if (!(chatId in live.streams)) return "idle";
  return live.streams[chatId] ? "talking" : busyWith(live.intents[chatId]);
}
/** The same across all of a bot's chats. */
export function botActivity(live: QuietLive | undefined, chats: ChatSummary[], botId: string): AvatarState {
  if (!live) return "idle";
  if (live.requests.some((request) => request.botId === botId)) return "waiting";
  let busy: AvatarState = "idle";
  for (const chatId of Object.keys(live.streams)) {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat || (chat.botId !== botId && !chat.botIds?.includes(botId))) continue;
    if (chat.botIds && live.speakers[chatId] && live.speakers[chatId] !== botId) continue;
    if (live.streams[chatId]) return "talking";
    busy = busyWith(live.intents[chatId]);
  }
  return busy;
}
/** A few words for what a bot is doing, or "" when it is idle. */
export function activityLabel(state: AvatarState): string {
  switch (state) {
    case "waiting":
    case "needs-input":
      return "Needs you";
    case "talking":
      return "Replying…";
    case "thinking":
      return "Thinking…";
    case "planning":
      return "Planning…";
    case "browsing":
      return "Looking things up…";
    case "coding":
      return "Coding…";
    case "working":
      return "Working…";
    case "retrying":
      return "Trying again…";
    case "pending":
      return "Waiting…";
    default:
      return "";
  }
}

export function needsYou(parts: Partial<PhoneParts>) {
  return (parts.live?.requests.length ?? 0) + (parts.tasks?.filter((task) => task.status === "blocked" || (task.status === "review" && !task.reviewerBotId)).length ?? 0);
}

export function panelRefreshing(streams: QuietLive["streams"] | undefined, chatId: string | undefined) {
  return !!chatId && !!streams && chatId in streams;
}
