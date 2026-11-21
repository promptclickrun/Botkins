// Sections on the Chats page ("chat-sections-v1"): a person's own way to group their chats. This
// is the list's order, the same as on the phone: Pinned, then each section in the person's order,
// then the chats in no section by day. The link keeps the sections; this only arranges them.
import type { Chat, Section, State } from "./types";

export type ChatFilter = "All" | "Unread" | "Archived";
export type DayLabel = "Today" | "Yesterday" | "Earlier";

export type ChatGroup =
  | { kind: "pinned"; key: string; label: "Pinned"; chats: Chat[] }
  | { kind: "section"; key: string; label: string; section: Section; chats: Chat[] }
  | { kind: "day"; key: string; label: DayLabel; chats: Chat[] };

/** Whether the computer in use keeps chat sections: this one says so by sending them, another by its capability. */
export function hasChatSections(state: Pick<State, "chatSections" | "remote">) {
  return Array.isArray(state.chatSections) || !!state.remote?.using?.capabilities?.includes("chat-sections-v1");
}

/** Today, Yesterday or Earlier, from the start of today. */
function dayOf(time: number, today: number): DayLabel {
  return time >= today ? "Today" : time >= today - 86400000 ? "Yesterday" : "Earlier";
}

/** The chats by day, newest first; a day with no chat is left out. */
function byDay(chats: Chat[], today: number): ChatGroup[] {
  return (["Today", "Yesterday", "Earlier"] as const)
    .map((label) => ({ kind: "day" as const, key: "day:" + label, label, chats: chats.filter((chat) => dayOf(chat.time, today) === label) }))
    .filter((group) => group.chats.length);
}

/**
 * The groups the Chats page draws. `sections` is undefined when the computer has none, and the
 * list is then as it always was. A pinned chat shows under Pinned even when it is in a section. A
 * section shows also when it is empty, except while searching or showing only unread chats, when
 * only groups with a match show. Archived chats are listed by day, without Pinned or sections.
 */
export function chatGroups(input: {
  chats: Chat[];
  sections?: Section[];
  query?: string;
  filter?: ChatFilter;
  /** A chat's bot's name, which a search also matches. */
  botName?: (chat: Chat) => string | undefined;
  /** The start of today; the default is now's. */
  today?: number;
}): ChatGroup[] {
  const { sections, filter = "All", botName = () => undefined } = input;
  const q = (input.query ?? "").toLowerCase();
  let today = input.today;
  if (today === undefined) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    today = start.getTime();
  }
  const matches = [...input.chats]
    .sort((a, b) => b.time - a.time)
    .filter(
      (chat) =>
        (filter === "Archived" ? chat.archived : !chat.archived && (filter === "All" || chat.unread)) &&
        (!q || (chat.title + " " + (botName(chat) ?? "")).toLowerCase().includes(q)),
    );
  if (filter === "Archived") return byDay(matches, today);
  const groups: ChatGroup[] = [];
  const pinned = matches.filter((chat) => chat.pinned);
  if (pinned.length) groups.push({ kind: "pinned", key: "pinned", label: "Pinned", chats: pinned });
  const loose = matches.filter((chat) => !chat.pinned);
  const known = new Set((sections ?? []).map((section) => section.id));
  const showEmpty = !q && filter === "All";
  for (const section of sections ?? []) {
    const chats = loose.filter((chat) => chat.sectionId === section.id);
    if (chats.length || showEmpty) groups.push({ kind: "section", key: "section:" + section.id, label: section.name, section, chats });
  }
  return [...groups, ...byDay(loose.filter((chat) => !(chat.sectionId && known.has(chat.sectionId))), today)];
}

/** The person's section order with one section moved up (-1) or down (1), or null when it is already at that end. */
export function movedSection(sections: Section[], id: string, by: -1 | 1): string[] | null {
  const ids = sections.map((section) => section.id);
  const at = ids.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= ids.length) return null;
  [ids[at], ids[to]] = [ids[to], ids[at]];
  return ids;
}
