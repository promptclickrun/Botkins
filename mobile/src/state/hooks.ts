import { useOnShow } from "@/ui/useOnShow";
import { useAppActive } from "./useAppActive";
// How screens read the computer's state.
import { useEffect, useMemo } from "react";
import { botActivity, chatActivity, type AvatarState } from "./sessionActivity";
import type { Bot, ChatSchedule, ChatSummary, ModelInfo, ProviderStatus, Scope, SkillInfo } from "@/link/types";
import { api, watchChat } from "./link";
import { type ChatView, type PhoneParts, useApp } from "./store";
import { can } from "./team";

const NONE: never[] = [];

export function usePart<K extends keyof PhoneParts>(key: K): PhoneParts[K] | undefined {
  return useApp((state) => state.parts[key]);
}
export const useBots = (): Bot[] => usePart("bots") ?? NONE;
export const useBot = (id: string | undefined) => useApp((state) => state.parts.bots?.find((bot) => bot.id === id));
export const useChats = (): ChatSummary[] => usePart("chats") ?? NONE;
export const useChat = (id: string | undefined) => useApp((state) => state.parts.chats?.find((chat) => chat.id === id));
export const useSettings = () => usePart("settings");
export const useOnline = () => useApp((state) => state.link === "online");
export const useCan = (scope: Scope, action: string) => useApp((state) => can(state.parts, scope, action));
export const useMember = () => useApp((state) => state.parts.meta?.you?.kind === "member");
/**
 * Whether the person may arrange their own view of the bots: pin, hide and order them. With
 * "team-people-v1" a member's arrangement is their own (the computer keeps it for them), so seeing
 * the bots is enough; on an older computer it changes everyone's, and needs "manage".
 */
export const useCanArrange = () =>
  useApp((state) => {
    const member = state.parts.meta?.you?.kind === "member";
    if (member && state.parts.meta?.capabilities.includes("team-people-v1")) return can(state.parts, "agents", "view");
    return can(state.parts, "agents", "manage");
  });
/** Whether the computer's app names a capability (`meta.capabilities`). False until the computer has answered. */
export const useCapability = (name: string) => useApp((state) => state.parts.meta?.capabilities.includes(name) ?? false);

export { activityLabel, botActivity, chatActivity, type AvatarState } from "./sessionActivity";
export function useBotActivity(botId: string): AvatarState {
  return useApp((state) => botActivity(state.parts.live, state.parts.chats ?? NONE, botId));
}
export const useChatActivity = (chatId: string): AvatarState => useApp((state) => chatActivity(state.parts.live, chatId));

/** Keeps a chat's messages and running turn in step while the calling screen is shown. */
export function useWatchedChat(chatId: string | undefined): ChatView | undefined {
  const visible = useAppActive(useOnShow(!!chatId));
  useEffect(() => (chatId && visible ? watchChat(chatId) : undefined), [chatId, visible]);
  return useApp((state) => (chatId ? state.chats[chatId] : undefined));
}

// Lists the computer is asked for. One request per list and revision, however many screens ask.
const inFlight = new Map<string, Promise<void>>();
function useAsked<T>(name: "models" | "providers" | "skills", revision: unknown, load: () => Promise<T>): T | undefined {
  const value = useApp((state) => state[name]) as T | undefined;
  const online = useOnline();
  useEffect(() => {
    if (!online) return;
    const key = name + ":" + JSON.stringify(revision);
    if (inFlight.has(key)) return;
    inFlight.set(
      key,
      load()
        .then((result) => useApp.setState({ [name]: result }))
        .catch(() => {})
        .finally(() => setTimeout(() => inFlight.delete(key), 1500)),
    );
  }, [online, name, revision, load]);
  return value;
}
const loadModels = () => api.models();
const loadProviders = () => api.providers();
const loadSkills = () => api.skills().then((result) => result.skills);

export function useModels(): ModelInfo[] | undefined {
  const revision = useApp((state) => state.parts.revs?.providers);
  return useAsked("models", revision, loadModels);
}
export function useProviders(): ProviderStatus[] | undefined {
  const revision = useApp((state) => state.parts.revs?.providers);
  return useAsked("providers", revision, loadProviders);
}
export function useSkills(): SkillInfo[] | undefined {
  const revision = usePart("skills");
  return useAsked("skills", revision, loadSkills);
}
/** Asks the computer again for a list after the phone changed something behind it. */
export async function refresh(name: "models" | "providers" | "skills") {
  try {
    if (name === "models") useApp.setState({ models: await loadModels() });
    else if (name === "providers") useApp.setState({ providers: await loadProviders(), models: await loadModels() });
    else useApp.setState({ skills: await loadSkills() });
  } catch {
    // The list on screen stays as it was.
  }
}

export type RoutineEntry = { id: string; chat: ChatSummary; entry: ChatSchedule; bot?: Bot };
/** Routines live in their own chats; this lists them, soonest next run first. */
export function useRoutines(): RoutineEntry[] {
  const chats = useChats();
  const bots = useBots();
  return useMemo(() => {
    const out: RoutineEntry[] = [];
    for (const chat of chats) {
      const entry = chat.schedules?.find((schedule) => schedule.routine);
      if (entry) out.push({ id: chat.id, chat, entry, bot: bots.find((bot) => bot.id === chat.botId) });
    }
    const rank = (routine: RoutineEntry) => (routine.entry.enabled === false || routine.entry.nextAt == null ? Number.MAX_SAFE_INTEGER : routine.entry.nextAt);
    return out.sort((a, b) => rank(a) - rank(b) || (b.entry.createdAt ?? 0) - (a.entry.createdAt ?? 0));
  }, [chats, bots]);
}

/** Conversations a person opens: not archived, and not the chats that hold a routine's or panel's runs. */
export function isConversation(chat: ChatSummary) {
  return !chat.archived && !chat.panelId && !chat.schedules?.some((schedule) => schedule.routine);
}
