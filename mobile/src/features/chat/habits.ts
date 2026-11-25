// Two habits of chats, as plain logic (no React Native imports; tests/chat-habits.test.ts runs it):
// what selecting a bot opens (Settings › Chat, "When you select a bot"), and when a chat that was
// left without a message is archived. The desktop app has the same two, with the same words.
import type { ChatSummary } from "@/link/types";

/** What selecting a bot does: its Main chat (the default), its latest chat, or a new one each time. */
export type BotTap = "main" | "latest" | "new";
export const BOT_TAPS: { value: BotTap; label: string; subtitle: string }[] = [
  { value: "main", label: "Open Main chat", subtitle: "Your private chat with this bot" },
  { value: "latest", label: "Open the latest chat", subtitle: "Pick up where you left off" },
  { value: "new", label: "Start a new chat", subtitle: "A fresh chat each time" },
];
export const botTapOf = (value: unknown): BotTap => (value === "new" || value === "latest" ? value : "main");

/**
 * The chat that selecting `botId` opens, or null when one has to be made. "latest" is the bot's
 * newest one-to-one chat. "new" makes a chat each time, except that a chat of the bot's that nobody
 * wrote in is opened instead of making another: also one that was archived when it was left
 * (`archived` says so, and it is taken out of the archive), so empty chats don't pile up there.
 */
export function chatForTap(chats: ChatSummary[], botId: string, tap: BotTap, person = "owner"): { id: string; archived?: true } | null {
  const mine = chats.filter((chat) => chat.botId === botId && !chat.botIds && !chat.panelId && !chat.schedules?.some((schedule) => schedule.routine)).sort((a, b) => b.time - a.time);
  if (tap === "main") {
    const main = mine.find(chat => chat.main && (chat.createdBy ?? "owner") === person);
    return main ? { id: main.id } : null;
  }
  if (tap === "latest") {
    const latest = mine.find((chat) => !chat.archived);
    return latest ? { id: latest.id } : null;
  }
  // Not a chat that was started in a project: reusing it would put the new chat into that project.
  const empty = mine.filter((chat) => !chat.main && (chat.createdBy ?? "owner") === person && chat.count === 0 && !chat.schedules?.length && !chat.pinned && !chat.projectId);
  const open = empty.find((chat) => !chat.archived) ?? empty[0];
  return open ? { id: open.id, ...(open.archived && { archived: true as const }) } : null;
}

/**
 * Whether a chat that is being left is archived: nobody wrote in it and nothing is going on.
 * Kept: a pinned chat, a chat with a schedule, a panel's chat, one with typed text that wasn't
 * sent, one whose bot is working or that has a message waiting.
 */
export function archivesWhenLeft(chat: ChatSummary | undefined, now: { messages: number; working: boolean; waiting: number; draft: string }): boolean {
  if (!chat || chat.main || chat.archived || chat.pinned || chat.panelId || chat.schedules?.length) return false;
  if (chat.count > 0 || now.messages > 0) return false;
  return !now.working && now.waiting === 0 && !now.draft.trim();
}
