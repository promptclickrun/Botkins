// A new chat nobody wrote in is archived when the person leaves it, so the lists keep only
// conversations. The phone app follows the same rule for its own navigation.
import type { Chat, State } from "./types";

type Busy = Pick<State, "streams" | "queued">;

/** A chat nobody wrote in and nothing is set on: no message, not working, nothing queued, not pinned, no schedule, not a panel's. */
const blank = (chat: Chat, state: Busy) =>
  !chat.pinned &&
  !chat.panelId &&
  !chat.schedules?.length &&
  !chat.messages.length &&
  !chat.count &&
  state.streams[chat.id] === undefined &&
  !state.queued?.[chat.id]?.length;

/**
 * Whether leaving this chat should archive it: an ordinary conversation (not a routine's or a
 * panel's chat) with no message from the person or a bot, that is not working and has nothing
 * queued. A chat the person pinned, gave a schedule or left typed text in is kept as it is.
 */
export function leftEmpty(chat: Chat | undefined, state: Busy, draft = "") {
  return !!chat && !chat.archived && blank(chat, state) && !draft.trim();
}

/**
 * For "Start a new chat" when a bot is selected: the bot's new chat nobody wrote in, if it has
 * one, so that a second is not made. One still in the lists comes first; else the newest that was
 * archived when it was left, which the caller takes out of the archive. Without this each
 * select-and-leave would leave one more archived empty chat. A group's chat and a chat started in
 * a project are not the bot's plain new chat, so they are never reused.
 */
export function newChatToReuse(chats: Chat[], botId: string, state: Busy) {
  const mine = chats.filter((chat) => chat.botId === botId && !chat.botIds && !chat.projectId && blank(chat, state));
  return mine.find((chat) => !chat.archived) ?? mine.filter((chat) => chat.archived).sort((a, b) => b.time - a.time)[0];
}
