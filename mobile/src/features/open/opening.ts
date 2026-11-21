// The links widgets, Live Activities and notifications open (botkins://open/…). Each names the
// computer it is about (`host`) when the phone is paired with several: the phone uses that computer
// first, as a tap on its notification does.
import { router } from "expo-router";
import { chatForTap } from "@/features/chat/habits";
import { api, attempt, switchComputer } from "@/state/link";
import { useApp } from "@/state/store";

/** Uses computer `host` when it is paired and not the one in use. */
export async function switchToHost(host: string | undefined) {
  const { pairing, pairings } = useApp.getState();
  if (host && host !== pairing?.serverId && pairings.some((item) => item.serverId === host)) await switchComputer(host);
}

/** Resolves once the computer in use has said what it has (chats, bots), or after `ms`. */
export function whenSynced(ms = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    if (useApp.getState().synced) return resolve(true);
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, ms);
    const stop = useApp.subscribe((state) => {
      if (!state.synced) return;
      clearTimeout(timer);
      stop();
      resolve(true);
    });
  });
}

/** What a widget's tap opens for a Botkin (its Edit Widget choice). */
export type BotOpens = "last" | "new" | "talk";

/** The Botkin's newest one-to-one chat, or a new one. Undefined when a new one couldn't be made. */
export async function lastOrNewChat(botId: string): Promise<string | undefined> {
  const held = chatForTap(useApp.getState().parts.chats ?? [], botId, "latest");
  return held?.id ?? (await attempt(api.createChat(botId)));
}

/** Replaces the opening screen with a chat, over Home, so Back goes Home. */
export function showChat(id: string) {
  router.replace("/");
  router.push({ pathname: "/chat/[id]", params: { id } });
}
