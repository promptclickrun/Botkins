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
export function arrangeChats(chats: ChatSummary[], sections: Section[] | undefined, now = Date.now(), { searching = false }: { searching?: boolean } = {}): ChatGroup[] {
  const newest = [...chats].sort((a, b) => b.time - a.time);
  const known = new Set((sections ?? []).map((section) => section.id));
  const groups: ChatGroup[] = [];
  const pinned = newest.filter((chat) => chat.pinned);
  if (pinned.length) groups.push({ key: "pinned", title: "Pinned", chats: pinned });
  for (const section of sections ?? []) {
    const list = newest.filter((chat) => !chat.pinned && chat.sectionId === section.id);
    if (list.length || !searching) groups.push({ key: "section:" + section.id, title: section.name, chats: list, section });
  }
  for (const day of ["Today", "Yesterday", "Earlier"] as const) {
    const list = newest.filter((chat) => !chat.pinned && !(chat.sectionId && known.has(chat.sectionId)) && dayBucket(chat.time, now) === day);
    if (list.length) groups.push({ key: "day:" + day, title: day, chats: list });
  }
  return groups;
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
