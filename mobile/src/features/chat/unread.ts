// Pure unread/changed helpers shared by Home's bot dots, BotMenu, Chats, and Spaces
// (no React Native imports; tests/unread.test.ts runs it). Mirrors desktop/src/unread.ts.
import type { ChatSummary, SpaceSummary } from "@/link/types";

export const MARK_CHATS_READ_CAPABILITY = "mark-chats-read-v1";

/** Whether a chat counts toward its bot's unread dot (matches desktop/src/unread.ts: excludes archived and panel chats). */
export function isUnreadChat(chat: Pick<ChatSummary, "archived" | "panelId" | "unread">): boolean {
  return !chat.panelId && !chat.archived && !!chat.unread;
}

/** The chats that light a bot's unread dot on Home and clear when marking that bot read. */
export function botUnreadChats<T extends Pick<ChatSummary, "id" | "botId" | "archived" | "panelId" | "unread">>(
  chats: readonly T[],
  botId: string,
): T[] {
  return chats.filter((chat) => chat.botId === botId && isUnreadChat(chat));
}

/** Bot IDs that currently have an unread dot. */
export function unreadBotIds(
  chats: readonly Pick<ChatSummary, "botId" | "archived" | "panelId" | "unread">[],
): Set<string> {
  const out = new Set<string>();
  for (const chat of chats) {
    if (isUnreadChat(chat)) out.add(chat.botId);
  }
  return out;
}

/** Every non-archived, non-panel unread chat across all bots. */
export function allUnreadChats<T extends Pick<ChatSummary, "id" | "archived" | "panelId" | "unread">>(
  chats: readonly T[],
): T[] {
  return chats.filter(isUnreadChat);
}

/** Spaces that currently show a changed dot. */
export function changedSpaces<T extends Pick<SpaceSummary, "id" | "changed">>(
  spaces: readonly T[],
): T[] {
  return spaces.filter((space) => space.changed > 0);
}

export type MarkReadClient = {
  hasBatch: boolean;
  markChatsRead: (ids: string[]) => Promise<unknown>;
  setChatFlags: (id: string, flags: { unread: false }) => Promise<unknown>;
};

export type MarkReadResult = { ok: true } | { ok: false; failed: number; error: unknown };

/**
 * Marks a list of chats read using the batch RPC when the computer supports "mark-chats-read-v1",
 * falling back to per-chat `setChatFlags` on older computers. Never swallows failures: callers decide
 * whether to surface an error toast (explicit actions) or stay quiet (automatic marks on navigation).
 */
export async function runMarkChatsRead(ids: readonly string[], client: MarkReadClient): Promise<MarkReadResult> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true };
  if (client.hasBatch) {
    try {
      await client.markChatsRead(unique);
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error ?? "");
      if (!/unknown method|not supported|not found/i.test(msg)) {
        return { ok: false, failed: unique.length, error };
      }
    }
  }
  const results = await Promise.allSettled(unique.map((id) => client.setChatFlags(id, { unread: false })));
  const rejected = results.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  if (rejected.length > 0) return { ok: false, failed: rejected.length, error: rejected[0].reason };
  return { ok: true };
}

export type MarkSpacesResult = { succeeded: string[]; failed: number; error?: unknown };

/** Marks a list of spaces seen and reports which succeeded plus the first error when any fail. */
export async function runMarkSpacesRead(
  ids: readonly string[],
  markOne: (id: string) => Promise<unknown>,
): Promise<MarkSpacesResult> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { succeeded: [], failed: 0 };
  const results = await Promise.allSettled(unique.map((id) => markOne(id)));
  const succeeded: string[] = [];
  let failed = 0;
  let error: unknown;
  results.forEach((entry, index) => {
    if (entry.status === "fulfilled") succeeded.push(unique[index]);
    else {
      if (failed === 0) error = entry.reason;
      failed += 1;
    }
  });
  return failed > 0 ? { succeeded, failed, error } : { succeeded, failed: 0 };
}
