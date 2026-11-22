// What a chat's page shows, as plain logic (no React Native imports; tests/chat-screen-state.test.ts
// runs it). "This chat is gone" is only for a chat the computer said it no longer has: a chat that
// isn't in the phone's list yet (just made, or opened from a notification before the list caught up)
// is unknown, not gone.
import type { ChatSummary } from "@/link/types";

/** chat: draw it. loading: not known yet. gone: deleted. blank: the page is being left, draw nothing. */
export type ChatScreenState = "chat" | "loading" | "gone" | "blank";

/**
 * `chats` is the phone's list (undefined before it first arrives). `deletedIds` holds the ids the
 * computer answered for with "no such chat" (see useChatScreenState). `leaving` is a page on its way
 * out: going back, replaced by another chat, or being deleted.
 */
export function chatScreenState({ id, chats, synced, deletedIds, leaving }: { id: string | undefined; chats: ChatSummary[] | undefined; synced: boolean; deletedIds: ReadonlySet<string>; leaving: boolean }): ChatScreenState {
  if (leaving) return "blank";
  if (!id) return "loading";
  if (chats?.some((chat) => chat.id === id)) return "chat";
  return synced && deletedIds.has(id) ? "gone" : "loading";
}
