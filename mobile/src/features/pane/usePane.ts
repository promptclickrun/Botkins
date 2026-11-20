// What a chat's screen does about its side pane: it opens the sheet when a bot asks (and only
// then), closes it when a bot asks for that, and offers the tabs that are there.
import { type Href, router } from "expo-router";
import { useEffect, useRef } from "react";
import { usePart, useWatchedChat } from "@/state/hooks";
import { api } from "@/state/link";
import { useApp } from "@/state/store";
import { usePaneInbox } from "./inbox";
import { paneFront, paneMove } from "./pane";

/** The sheet's route. (Typed routes are made when Metro starts; this one is cast until then.) */
const sheet = (chatId: string, panel: string) => ({ pathname: "/chat/pane", params: { chatId, panel } }) as unknown as Href;
// The pane's sheet that is open now, so a bot's ask to close it can find it.
let open: { chatId: string; byBot?: boolean } | null = null;
export const paneOpened = (chatId: string) => {
  open = { chatId };
};
/** The sheet closed. True when a bot asked for that (the person didn't close it, so nothing is told to the computer). */
export const paneClosed = () => {
  const byBot = !!open?.byBot;
  open = null;
  return byBot;
};

export function usePane(chatId: string, onText: (text: string) => void) {
  const supported = usePart("meta")?.capabilities.includes("side-pane-v1");
  const pane = useWatchedChat(chatId)?.pane;
  const handled = useRef<number | undefined>(undefined);
  const active = usePart("live")?.active;
  useEffect(() => {
    if (!supported || !pane) return;
    // The turn that asked is still under way when this chat has one running.
    const next = paneMove(pane, handled.current, () => !!active?.includes(chatId) || useApp.getState().running[chatId]?.status === "Working");
    handled.current = next.handled;
    if (!next.move) return;
    if ("close" in next.move) {
      if (open?.chatId === chatId) {
        open.byBot = true;
        if (router.canGoBack()) router.back();
      }
    } else if (open?.chatId !== chatId) router.push(sheet(chatId, next.move.open));
    else router.setParams({ panel: next.move.open });
  }, [supported, pane, chatId, active]);

  // Text a view in the pane handed over goes to this chat's message box.
  const inbox = usePaneInbox();
  const taken = useRef(inbox.seq);
  useEffect(() => {
    if (inbox.seq === taken.current) return;
    taken.current = inbox.seq;
    if (inbox.chatId === chatId && inbox.text) onText(inbox.text);
  }, [inbox, chatId, onText]);

  const tabs = supported ? (pane?.panels.length ?? 0) : 0;
  return {
    /** How many tabs the pane has: the chat's header offers them when there are any. */
    tabs,
    /** The person opens the pane themselves. */
    show: () => {
      const front = paneFront(pane);
      if (!front) return;
      void api.sidePane(chatId, "opened").catch(() => {});
      router.push(sheet(chatId, front.id));
    },
  };
}
