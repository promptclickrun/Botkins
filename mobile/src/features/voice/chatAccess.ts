// A chat as the voice features see it: a way to send it a message, and what the phone's store
// (which the computer keeps in step) says about it. Live voice's `ask_bot` and the talk mode use it.
import { api } from "@/state/link";
import { useApp } from "@/state/store";
import type { ChatAccess } from "./live/index";

/** The chat as `ask_bot` sees it: from the phone's store, which the computer keeps in step. */
export function chatAccess(chatId: string): ChatAccess {
  return {
    send: (text) => api.send(chatId, text),
    snapshot: () => {
      const state = useApp.getState();
      const live = state.parts.live;
      const view = state.chats[chatId];
      const summary = state.parts.chats?.find((chat) => chat.id === chatId);
      return {
        busy: !!live && (live.active.includes(chatId) || chatId in live.streams || (live.queued[chatId]?.length ?? 0) > 0),
        asking: !!live?.requests.some((request) => request.chatId === chatId),
        total: view?.total ?? summary?.count ?? 0,
        after: (from) => (view ? view.messages.slice(Math.max(0, from - view.from)) : []),
      };
    },
    subscribe: (listener) => useApp.subscribe((state, before) => {
      if (state.parts.live !== before.parts.live || state.parts.chats !== before.parts.chats || state.chats !== before.chats) listener();
    }),
  };
}

