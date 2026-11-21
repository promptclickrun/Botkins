// The Chats tab with room for two panes (iPhone Duo opened, an iPad): the list on one side and the
// chosen chat beside it, the Mail pattern. Closed again, the chosen chat is pushed on its own, so
// folding never drops a person back on the list; and its draft goes with it (`drafts`).
import { router } from "expo-router";
import { create } from "zustand";
import type { DraftMention } from "./compose";
import type { Attachment } from "./uploads";

type Split = {
  /** Whether the Chats tab is showing two panes now. */
  active: boolean;
  /** The chat shown beside the list. */
  id: string | null;
  /** A chat that went on its own page from the list: unfolding brings it back beside the list. */
  pushed?: string | null;
};

// Named like a hook so the React Compiler treats it as one (see AGENTS.md).
export const useChatSplit = create<Split>(() => ({ active: false, id: null }));

/** A chat chosen in the Chats list: beside it when there is room, otherwise on its own page. */
export function openFromList(id: string) {
  if (useChatSplit.getState().active) useChatSplit.setState({ id });
  else {
    useChatSplit.setState({ pushed: id });
    router.push({ pathname: "/chat/[id]", params: { id } });
  }
}

/**
 * What a person wrote and did not send, kept while a chat moves between the pane and its own page
 * (folding or unfolding the phone remounts it): the text, a reply's quote, the records mentioned and
 * the files already uploaded (one still going up is not carried). Only in memory, until it is sent.
 */
export type Draft = { text?: string; quote?: string; mentions?: DraftMention[]; files?: Attachment[] };
export const drafts = new Map<string, Draft>();

/** Changes one chat's kept draft; an empty one is dropped. */
export function keepDraft(chatId: string, patch: Draft) {
  const next = { ...drafts.get(chatId), ...patch };
  const empty = !next.text && !next.quote && !next.mentions?.length && !next.files?.length;
  if (empty) drafts.delete(chatId);
  else drafts.set(chatId, next);
}
