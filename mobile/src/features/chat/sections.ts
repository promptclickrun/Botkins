// Sections on the Chats screen ("chat-sections-v1"): the list in order, the choices of a chat's
// "Move to section" menu, and a section's place among the others. A section is the person's own way
// to group their chats; the computer keeps it for them (docs/link-contract.md). No React Native
// imports, so tests/chat-sections.test.ts runs it.
import type { ChatSummary, Section } from "@/link/types";
import { dayBucket } from "@/state/time";

/** The computer takes a section name up to this long. */
export const SECTION_NAME_MAX = 40;
export const sectionName = (value?: string) => value?.trim().slice(0, SECTION_NAME_MAX) ?? "";

/** A group of the list: Pinned, one of the person's sections, or a day ("Today", "Yesterday", "Earlier"). */
export type ChatGroup = { key: string; title: string; chats: ChatSummary[]; section?: Section };

/**
 * The Chats list, top to bottom: pinned chats; each of the person's sections, in their order, with
 * its chats; then the chats in no section, by day. Each group's chats are newest first. A pinned
 * chat shows under Pinned, as a pinned bot does on Home. A section shows also when it is empty, so
 * a chat can be moved into it; while searching, only groups with a match show.
 */
export function arrangeChats(chats: ChatSummary[], sections: Section[] | undefined, now = Date.now(), { searching = false, dragging = false }: { searching?: boolean; dragging?: boolean } = {}): ChatGroup[] {
  const newest = [...chats].sort((a, b) => b.time - a.time);
  const known = new Set((sections ?? []).map((section) => section.id));
  const groups: ChatGroup[] = [];
  const pinned = newest.filter((chat) => chat.pinned);
  // While a chat is dragged, Pinned shows also when empty, so the chat can be dropped there.
  if (pinned.length || dragging) groups.push({ key: "pinned", title: "Pinned", chats: pinned });
  for (const section of sections ?? []) {
    const list = newest.filter((chat) => !chat.pinned && chat.sectionId === section.id);
    if (list.length || !searching) groups.push({ key: "section:" + section.id, title: section.name, chats: list, section });
  }
  let days = 0;
  for (const day of ["Today", "Yesterday", "Earlier"] as const) {
    const list = newest.filter((chat) => !chat.pinned && !(chat.sectionId && known.has(chat.sectionId)) && dayBucket(chat.time, now) === day);
    if (list.length) days = groups.push({ key: "day:" + day, title: day, chats: list });
  }
  // And when every chat is in a section, a place to take one out.
  if (dragging && !days) groups.push({ key: "none", title: "None", chats: [] });
  return groups;
}

/**
 * The Chats list as one list (the phone's layout since the redesign): every chat that isn't pinned,
 * newest first, under "Recent", whatever its section; pinned chats are drawn above it as a row of
 * their own. While a chat is dragged, Pinned and each section show as places to drop it on, above
 * the list. The chips above it choose which chats it holds (`chatsForFilter`).
 */
export function arrangeChatsFlat(chats: ChatSummary[], sections: Section[] | undefined, { dragging = false }: { dragging?: boolean } = {}): ChatGroup[] {
  const recent = [...chats].filter((chat) => !chat.pinned).sort((a, b) => b.time - a.time);
  const groups: ChatGroup[] = [];
  if (dragging) {
    groups.push({ key: "pinned", title: "Pinned", chats: [] });
    for (const section of sections ?? []) groups.push({ key: "section:" + section.id, title: section.name, chats: [], section });
  }
  if (recent.length || dragging) groups.push({ key: "recent", title: "Recent", chats: recent });
  return groups;
}

/** What the chips over the Chats list show: every chat, the unread ones, or one of the person's sections. */
export type ChatFilter = "all" | "unread" | `section:${string}`;

/** The chats a chip shows. A section that is gone shows every chat. */
export function chatsForFilter<T extends Pick<ChatSummary, "id" | "sectionId">>(chats: T[], filter: ChatFilter, sections: Section[] | undefined, unread: ReadonlySet<string>): T[] {
  if (filter === "unread") return chats.filter((chat) => unread.has(chat.id));
  if (filter.startsWith("section:")) {
    const id = filter.slice("section:".length);
    if (!sections?.some((section) => section.id === id)) return chats;
    return chats.filter((chat) => chat.sectionId === id);
  }
  return chats;
}

/** The chips, in order: All, Unread (with its count, only for someone who may read chats), then each section. */
export function chatChips(sections: Section[] | undefined, unreadCount: number, canView: boolean): { value: ChatFilter; label: string; count?: number }[] {
  return [
    { value: "all", label: "All" },
    ...(canView ? [{ value: "unread" as const, label: "Unread", ...(unreadCount ? { count: unreadCount } : {}) }] : []),
    ...(sections ?? []).map((section) => ({ value: ("section:" + section.id) as ChatFilter, label: section.name })),
  ];
}

/** The list as a flat run of items: each group's heading, then its chats unless the section is folded. */
export type ListItem = { key: string; kind: "head"; group: string } | { key: string; kind: "row"; group: string; chatId: string };
export function listItems(groups: ChatGroup[], folded: readonly string[]): ListItem[] {
  const items: ListItem[] = [];
  for (const group of groups) {
    items.push({ key: "head:" + group.key, kind: "head", group: group.key });
    if (group.section && folded.includes(group.section.id)) continue;
    for (const chat of group.chats) items.push({ key: "chat:" + chat.id, kind: "row", group: group.key, chatId: chat.id });
  }
  return items;
}

/**
 * The group a dragged chat is over: the one whose heading and rows span `center` (the list's own
 * coordinates), else the nearest. `ys` and `hs` are each item's top and height. Archived chats are
 * no place to drop. Runs on the UI thread.
 */
export function groupAt(items: readonly ListItem[], ys: readonly number[], hs: readonly number[], center: number): string {
  "worklet";
  let best = "";
  let bestDistance = Infinity;
  let start = -1;
  for (let i = 0; i <= items.length; i++) {
    if (i < items.length && items[i]!.kind !== "head") continue;
    if (start >= 0 && items[start]!.group !== "archived") {
      const top = ys[start] ?? 0;
      const bottom = (ys[i - 1] ?? 0) + (hs[i - 1] ?? 0);
      const distance = center < top ? top - center : center > bottom ? center - bottom : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = items[start]!.group;
      }
    }
    start = i;
  }
  return best;
}

/**
 * What dropping a chat on a group asks of the computer: Pinned pins it; a section puts it there and
 * unpins it, so it shows there; a day's group (or "No section") takes it out of its section.
 * Undefined when nothing changes.
 */
export function chatDropPlan(chat: Pick<ChatSummary, "pinned" | "sectionId">, sections: Section[] | undefined, group: string): { pinned?: boolean; sectionId?: string | null } | undefined {
  const own = sectionOfChat(chat, sections)?.id;
  const plan: { pinned?: boolean; sectionId?: string | null } = {};
  if (group === "pinned") {
    if (!chat.pinned) plan.pinned = true;
  } else if (group.startsWith("section:")) {
    const id = group.slice("section:".length);
    if (!sections?.some((section) => section.id === id)) return undefined;
    if (chat.pinned) plan.pinned = false;
    if (own !== id) plan.sectionId = id;
  } else if (group === "recent") {
    // The one list under the chips holds every chat, in a section or not: a drop there only unpins.
    if (chat.pinned) plan.pinned = false;
  } else if (group === "none" || group.startsWith("day:")) {
    if (chat.pinned) plan.pinned = false;
    if (own) plan.sectionId = null;
  } else return undefined;
  return Object.keys(plan).length ? plan : undefined;
}

/** The section a chat is in, or undefined when it is in none (or in one that is gone). */
export const sectionOfChat = (chat: Pick<ChatSummary, "sectionId">, sections: Section[] | undefined) => (chat.sectionId ? sections?.find((section) => section.id === chat.sectionId) : undefined);

/** "Move to section": each section (the chat's own marked), "None", then "New section…". The bots' menu on Home has the same words. */
export function moveChoices(chat: Pick<ChatSummary, "sectionId">, sections: Section[] | undefined): { id: string; title: string; on: boolean }[] {
  const list = sections ?? [];
  const own = sectionOfChat(chat, list);
  return [
    ...list.map((section) => ({ id: "section:" + section.id, title: section.name, on: own?.id === section.id })),
    { id: "section:none", title: "None", on: !own },
    { id: "section:new", title: "New section…", on: false },
  ];
}

/** The order to send for "Move up" and "Move down" on a section, or null when it is first or last. */
export function sectionMoves(sections: Section[], id: string): { up: string[] | null; down: string[] | null } {
  const ids = sections.map((section) => section.id);
  const at = ids.indexOf(id);
  const swap = (other: number) => {
    if (at < 0 || other < 0 || other >= ids.length) return null;
    const next = [...ids];
    [next[at], next[other]] = [next[other]!, next[at]!];
    return next;
  };
  return { up: swap(at - 1), down: swap(at + 1) };
}
