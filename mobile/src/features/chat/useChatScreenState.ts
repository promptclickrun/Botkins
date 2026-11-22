import { useEffect, useState } from "react";
import { api } from "@/state/link";
import { useOnline } from "@/state/hooks";
import { useApp } from "@/state/store";
import { chatScreenState, type ChatScreenState } from "./chatScreenState";

/**
 * What the page for chat `id` shows (chatScreenState has the rules). A chat missing from the list
 * is asked for once the phone is in step with the computer: only its "no such chat" (`link.messages`
 * answers null) makes it gone. Any other answer, or none (offline), leaves it loading. A chat made
 * or opened before the list has it is found by the same question, and the list then has it.
 */
export function useChatScreenState(id: string | undefined, leaving: boolean): ChatScreenState {
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(new Set());
  const online = useOnline();
  const synced = useApp((state) => state.synced);
  const listed = useApp((state) => !!id && !!state.parts.chats?.some((chat) => chat.id === id));
  useEffect(() => {
    if (!id || listed || !synced || !online) return;
    let current = true;
    api["link.messages"](id, 0, 1).then(
      (page) => current && !page && setDeletedIds((held) => new Set(held).add(id)),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [id, listed, synced, online]);
  return useApp((state) => chatScreenState({ id, chats: state.parts.chats, synced, deletedIds, leaving }));
}
