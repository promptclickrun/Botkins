import { AppState } from "react-native";
import { lastOrNewChat, showChat, whenSynced } from "@/features/open/opening";
import { api, attempt, switchComputer } from "@/state/link";
import { useApp } from "@/state/store";

export type ShortcutChatDestination = "latest" | "new";

/** Opens the selected Botkin's latest chat, or makes one new chat, after the selected host is ready. */
export async function startOpenShortcut(
  host: string | undefined,
  bot: string | undefined,
  destination: ShortcutChatDestination,
  signal: AbortSignal,
  botHost?: string,
) {
  const initial = useApp.getState();
  const target = host ?? initial.pairing?.serverId;
  if (!target || !initial.pairings.some((item) => item.serverId === target)) {
    throw new Error("Open Botkins and pair with this computer first.");
  }
  if (botHost && botHost !== target) throw new Error("Choose an agent from the selected computer.");
  signal.throwIfAborted();
  if (target !== initial.pairing?.serverId) await switchComputer(target);
  if (!(await whenSynced(15_000))) throw new Error("Your computer could not be reached.");
  signal.throwIfAborted();
  if (AppState.currentState !== "active") throw new Error("Open Botkins to choose a chat.");
  if (useApp.getState().pairing?.serverId !== target) throw new Error("The active computer changed. Run the shortcut again.");

  const state = useApp.getState();
  const agent = bot ? state.parts.bots?.find((item) => item.id === bot && !item.hidden) : state.parts.bots?.find((item) => !item.hidden);
  if (!agent) throw new Error("Choose an available bot in Botkins.");

  let chat: string | undefined;
  if (destination === "latest") {
    chat = await lastOrNewChat(agent.id);
  } else {
    chat = await attempt(api.createChat(agent.id));
  }
  signal.throwIfAborted();
  if (!chat) throw new Error("The chat could not be opened.");
  if (useApp.getState().pairing?.serverId !== target) throw new Error("The active computer changed. Run the shortcut again.");
  showChat(chat);
}
