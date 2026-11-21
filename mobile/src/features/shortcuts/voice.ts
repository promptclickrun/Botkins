import { AppState } from "react-native";
import { showChat, whenSynced } from "@/features/open/opening";
import { startChatVoice } from "@/features/voice/api";
import { voiceSettings } from "@/features/voice/state";
import { canTalk } from "@/features/voice/talk";
import { api, switchComputer } from "@/state/link";
import { useApp } from "@/state/store";

/** Called from an authenticated foreground intent after the root navigator has mounted. */
export async function startVoiceShortcut(host: string | undefined, bot: string | undefined, signal: AbortSignal) {
  const initial = useApp.getState();
  const target = host ?? initial.pairing?.serverId;
  if (!target || !initial.pairings.some(item => item.serverId === target)) throw new Error("Open Botkins and pair with this computer first.");
  signal.throwIfAborted();
  if (target !== initial.pairing?.serverId) await switchComputer(target);
  if (!(await whenSynced(15_000))) throw new Error("Your computer could not be reached.");
  function checkHost() {
    signal.throwIfAborted();
    if (AppState.currentState !== "active") throw new Error("Open Botkins to start talking.");
    if (useApp.getState().pairing?.serverId !== target) throw new Error("The active computer changed. Run the shortcut again.");
  }
  checkHost();
  const bots = useApp.getState().parts.bots ?? [];
  const agent = bot ? bots.find(item => item.id === bot && !item.hidden) : bots.find(item => !item.hidden);
  if (!agent) throw new Error("Choose an available bot in Botkins.");
  if (!voiceSettings()?.live.provider && !canTalk()) throw new Error("Choose a live voice or enable dictation in Botkins to start talking.");
  const chat = await api.createChat(agent.id);
  checkHost();
  showChat(chat);
  startChatVoice(chat, agent.id);
}
