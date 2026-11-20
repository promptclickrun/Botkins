// Text a custom view in the side pane hands to its chat's message box. The pane is a sheet over
// the chat, so the text waits here until the chat's screen takes it.
import { create } from "zustand";

export const usePaneInbox = create<{ chatId: string | null; text: string; seq: number }>(() => ({ chatId: null, text: "", seq: 0 }));
export const handToChat = (chatId: string, text: string) => usePaneInbox.setState((state) => ({ chatId, text, seq: state.seq + 1 }));
