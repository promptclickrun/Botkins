// How screens read the computer's state.
import { useEffect, useMemo } from "react";
import type { BotkinState } from "@/data/botkinMotion";
import type { Bot, ChatSchedule, ChatSummary, Live, ModelInfo, Parts, ProviderStatus, SkillInfo } from "@/link/types";
import { api, watchChat } from "./link";
import { type ChatView, useApp } from "./store";

const NONE: never[] = [];

export function usePart<K extends keyof Parts>(key: K): Parts[K] | undefined {
  return useApp((state) => state.parts[key]);
}
export const useBots = (): Bot[] => usePart("bots") ?? NONE;
export const useBot = (id: string | undefined) => useApp((state) => state.parts.bots?.find((bot) => bot.id === id));
export const useChats = (): ChatSummary[] => usePart("chats") ?? NONE;
export const useChat = (id: string | undefined) => useApp((state) => state.parts.chats?.find((chat) => chat.id === id));
export const useSettings = () => usePart("settings");
export const useOnline = () => useApp((state) => state.link === "online");
/** Whether the computer's app names a capability (`meta.capabilities`). False until the computer has answered. */
export const useCapability = (name: string) => useApp((state) => state.parts.meta?.capabilities.includes(name) ?? false);

/**
 * What a bot is doing, as its avatar acts it out. Most are the design kit's own states. Three are
 * the app's words: "waiting" is a bot waiting for the person (the kit's Needs input), "talking" is
 * a reply being written, and "pending" is the kit's Waiting (something outside is pending).
 */
export type AvatarState = Exclude<BotkinState, "waiting"> | "waiting" | "pending" | "talking" | "happy" | "sleeping";

/** What a bot at work is busy with, read from its own one-line note about it ("Searching the wiki"). */
function busyWith(intent: string | undefined): AvatarState {
  const text = (intent ?? "").toLowerCase();
  if (/\b(search|brows|look(ing)? (up|for)|fetch|web|navigat|read(ing)? (the )?(page|site|docs?|wiki))/.test(text)) return "browsing";
  if (/\b(cod(e|ing)|edit|patch|run(ning)? |command|shell|test|build|debug|commit|refactor|install|writ\w* (the )?(file|code|script))/.test(text)) return "coding";
  if (/\b(plan|outlin|organi[sz]|to-?do|schedul|break(ing)? .* down)/.test(text)) return "planning";
  if (!text || /\b(think|consider|reason|ponder)/.test(text)) return "thinking";
  return "working";
}

/** What a chat's bot is doing: waiting for the person, writing a reply, some kind of work, or nothing. */
export function chatActivity(live: Live | undefined, chatId: string): AvatarState {
  if (!live) return "idle";
  if (live.requests.some((request) => request.chatId === chatId)) return "waiting";
  if (!(chatId in live.streams)) return "idle";
  return live.streams[chatId] ? "talking" : busyWith(live.intents[chatId]);
}
/** The same across all of a bot's chats. */
export function botActivity(live: Live | undefined, chats: ChatSummary[], botId: string): AvatarState {
  if (!live) return "idle";
  if (live.requests.some((request) => request.botId === botId)) return "waiting";
  let busy: AvatarState = "idle";
  for (const chatId of Object.keys(live.streams)) {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat || (chat.botId !== botId && !chat.botIds?.includes(botId))) continue;
    if (chat.botIds && live.speakers[chatId] && live.speakers[chatId] !== botId) continue;
    if (live.streams[chatId]) return "talking";
    busy = busyWith(live.intents[chatId]);
  }
  return busy;
}
/** A few words for what a bot is doing, or "" when it is idle. */
export function activityLabel(state: AvatarState): string {
  switch (state) {
    case "waiting":
    case "needs-input":
      return "Needs you";
    case "talking":
      return "Replying…";
    case "thinking":
      return "Thinking…";
    case "planning":
      return "Planning…";
    case "browsing":
      return "Looking things up…";
    case "coding":
      return "Coding…";
    case "working":
      return "Working…";
    case "retrying":
      return "Trying again…";
    case "pending":
      return "Waiting…";
    default:
      return "";
  }
}
export function useBotActivity(botId: string): AvatarState {
  return useApp((state) => botActivity(state.parts.live, state.parts.chats ?? NONE, botId));
}
export const useChatActivity = (chatId: string): AvatarState => useApp((state) => chatActivity(state.parts.live, chatId));

/** Keeps a chat's messages and running turn in step while the calling screen is shown. */
export function useWatchedChat(chatId: string | undefined): ChatView | undefined {
  useEffect(() => (chatId ? watchChat(chatId) : undefined), [chatId]);
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
