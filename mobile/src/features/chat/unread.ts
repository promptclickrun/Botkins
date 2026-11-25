// Pure unread/changed helpers shared by Home's bot dots, BotMenu, Chats, and Spaces
// (no React Native imports; tests/unread.test.ts runs it). Mirrors desktop/src/unread.ts.
import type { ChatSummary, SpaceSummary } from "@/link/types";

export const MARK_CHATS_READ_CAPABILITY = "mark-chats-read-v1";
/** Protocol limit per `markChatsRead` RPC (matches `MAX_MARK_CHATS_READ` in `link/methods.mjs`). */
export const MAX_MARK_CHATS_READ = 2000;

/** Whether a chat counts toward its bot's unread dot (matches desktop/src/unread.ts: excludes archived and panel chats). */
export function isUnreadChat(chat: Pick<ChatSummary, "archived" | "panelId" | "unread">): boolean {
  return !chat.panelId && !chat.archived && !!chat.unread;
}

/** Whether a chat is listed on the Chats page (matches desktop/src/chatSections.ts: all non-archived chats, including panel and routine chats). */
export function isChatsPageChat(chat: Pick<ChatSummary, "archived">): boolean {
  return !chat.archived;
}

/** Whether a chat is listed under Archived on the Chats page (matches desktop/src/chatSections.ts). */
export function isChatsPageArchived(chat: Pick<ChatSummary, "archived">): boolean {
  return !!chat.archived;
}

/** Whether a chat counts as unread on the Chats page (matches desktop/src/chatSections.ts `isChatsPageUnread`). */
export function isChatsPageUnread(chat: Pick<ChatSummary, "archived" | "unread">): boolean {
  return !chat.archived && !!chat.unread;
}

/** Every unread chat on the Chats page: what it lists under Unread, counts, and clears with "Mark all as read". */
export function chatsPageUnreadChats<T extends Pick<ChatSummary, "id" | "archived" | "unread">>(
  chats: readonly T[],
): T[] {
  return chats.filter(isChatsPageUnread);
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
  /** Returns false once the person switches away from the computer this operation started on. */
  isCurrent?: () => boolean;
};

export type MarkReadResult = { ok: true } | { ok: false; failed: number; error: unknown };

const UNKNOWN_BATCH_RE = /unknown method|not supported|not allowed|unsupported|not a function|not found|can't be done from a phone/i;
const MISSING_CHAT_RE = /^unknown chat\b(?!\s+flag\b)|\bchat\b.*\b(?:no longer (?:exists|available)|not found|gone)\b/i;
const UNAVAILABLE_MEMBER_CHAT = "That chat belongs to the owner or another member.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/** Per-chat `setChatFlags` fallback errors that mean the chat is gone or not visible to this member. */
export function isSkippedMarkReadError(error: unknown): boolean {
  const text = errorMessage(error).trim();
  return text === UNAVAILABLE_MEMBER_CHAT || MISSING_CHAT_RE.test(text);
}

/**
 * Marks a list of chats read using chunked batch RPCs when the computer supports "mark-chats-read-v1",
 * falling back to sequential per-chat `setChatFlags` on older computers. Stops immediately if the
 * active computer changes, skips missing chats in fallback, and combines remaining failures into one error.
 */
export async function runMarkChatsRead(ids: readonly string[], client: MarkReadClient): Promise<MarkReadResult> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true };
  const isCurrent = client.isCurrent ?? (() => true);
  let useFallback = !client.hasBatch;
  if (!useFallback) {
    for (let i = 0; i < unique.length; i += MAX_MARK_CHATS_READ) {
      if (!isCurrent()) return { ok: true };
      const chunk = unique.slice(i, i + MAX_MARK_CHATS_READ);
      try {
        await client.markChatsRead(chunk);
      } catch (error) {
        if (!isCurrent()) return { ok: true };
        if (i === 0 && UNKNOWN_BATCH_RE.test(errorMessage(error))) {
          useFallback = true;
          break;
        }
        return { ok: false, failed: unique.length - i, error };
      }
    }
    if (!useFallback) return { ok: true };
  }
  const errors: unknown[] = [];
  for (const id of unique) {
    if (!isCurrent()) return { ok: true };
    try {
      await client.setChatFlags(id, { unread: false });
    } catch (error) {
      if (!isCurrent()) return { ok: true };
      if (isSkippedMarkReadError(error)) continue;
      errors.push(error);
    }
  }
  if (errors.length === 1) return { ok: false, failed: 1, error: errors[0] };
  if (errors.length > 1) {
    const messages = [...new Set(errors.map((e) => errorMessage(e) || "Couldn't mark as read."))];
    return {
      ok: false,
      failed: errors.length,
      error: new Error(`Couldn't mark ${errors.length} chats as read: ${messages.slice(0, 3).join("; ")}`),
    };
  }
  return { ok: true };
}

export type MarkSpacesResult = { succeeded: string[]; marks: Record<string, number>; failed: number; error?: unknown };

export type MarkSpacesOptions = {
  /** Snapshot the visible timestamp for a space before its request is sent. */
  snapshotUpTo?: (id: string) => number;
  /** Returns false if the person switched computers before the requests settled. */
  isCurrent?: () => boolean;
  /** Receives only the pre-send timestamps of spaces that succeeded while still on the same computer. */
  applyMarks?: (marks: Record<string, number>) => void;
};

/**
 * Marks a list of spaces seen while capturing each space's visible timestamp before sending, so an
 * update that lands while another space's request is still in flight stays unread.
 */
export async function runMarkSpacesRead(
  ids: readonly string[],
  markOne: (id: string) => Promise<unknown>,
  options: MarkSpacesOptions = {},
): Promise<MarkSpacesResult> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { succeeded: [], marks: {}, failed: 0 };
  const isCurrent = options.isCurrent ?? (() => true);
  const captured: Record<string, number> = {};
  if (options.snapshotUpTo) {
    for (const id of unique) {
      const upTo = options.snapshotUpTo(id);
      if (upTo > 0) captured[id] = upTo;
    }
  }
  const results = await Promise.allSettled(unique.map((id) => markOne(id)));
  if (!isCurrent()) return { succeeded: [], marks: {}, failed: 0 };
  const succeeded: string[] = [];
  const marks: Record<string, number> = {};
  let failed = 0;
  let error: unknown;
  results.forEach((entry, index) => {
    if (entry.status === "fulfilled") {
      const id = unique[index];
      succeeded.push(id);
      if (captured[id]) marks[id] = captured[id];
    } else {
      if (failed === 0) error = entry.reason;
      failed += 1;
    }
  });
  if (Object.keys(marks).length > 0) options.applyMarks?.(marks);
  return failed > 0 ? { succeeded, marks, failed, error } : { succeeded, marks, failed: 0 };
}
