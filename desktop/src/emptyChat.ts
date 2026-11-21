// A new chat nobody wrote in is archived when the person leaves it, so the lists keep only
// conversations. The phone app follows the same rule for its own navigation.
import type { Chat, State } from "./types";

/**
 * Whether leaving this chat should archive it: an ordinary conversation (not a routine's or a
 * panel's chat) with no message from the person or a bot, that is not working and has nothing
 * queued. A chat the person pinned, gave a schedule or left typed text in is kept as it is.
 */
export function leftEmpty(chat: Chat | undefined, state: Pick<State, "streams" | "queued">, draft = "") {
  if (!chat || chat.archived || chat.pinned || chat.panelId || chat.schedules?.length) return false;
  if (chat.messages.length || chat.count) return false;
  if (state.streams[chat.id] !== undefined || state.queued?.[chat.id]?.length) return false;
  return !draft.trim();
}
