// The people in a chat ("team-people-v1"): who started it and who was invited. Plain logic for the
// chat's "Invite" and the sheet "People in this chat" (no React Native imports; tested by
// tests/team-people.test.ts). The rules themselves are the computer's (link-host/team.mjs).
import type { ChatSummary, Message, Parts, Person, RunSummary } from "@/link/types";

export const OWNER = "owner";

/** The person this phone belongs to: "owner", or the member's id. */
export const myself = (meta: Parts["meta"] | undefined): string => (meta?.you?.kind === "member" ? meta.you.memberId : OWNER);

/** Who started a chat: the member named on it, else the owner. */
export const starterOf = (chat: Pick<ChatSummary, "createdBy">): string => chat.createdBy || OWNER;

export type PersonRow = {
  id: string;
  /** The person's name, or "You" for this phone's own person. */
  name: string;
  /** "starter" started the chat, "invited" was invited, "out" is on the team and not in the chat. */
  place: "starter" | "invited" | "out";
  /** This phone's own person. */
  self: boolean;
  /** The line under the name, in the desktop app's words. */
  note: string;
};
const NOTES = { starter: "Started this chat", invited: "Invited", out: "Not in this chat" } as const;

/**
 * Who may change a chat's people from this phone: its starter and the owner invite and remove
 * anyone; someone invited may only leave; anyone else sees no list at all.
 */
export function myPlace(chat: Pick<ChatSummary, "createdBy" | "invited">, me: string): "manages" | "invited" | "out" {
  if (me === OWNER || starterOf(chat) === me) return "manages";
  return chat.invited?.includes(me) ? "invited" : "out";
}

/** The rows of "People in this chat": the starter first, then those invited, then everyone else on the team. */
export function peopleRows(people: Person[], chat: Pick<ChatSummary, "createdBy" | "invited">, me: string): PersonRow[] {
  const starter = starterOf(chat);
  const invited = new Set(chat.invited ?? []);
  const order = { starter: 0, invited: 1, out: 2 };
  return people
    .map((person): PersonRow => {
      const place = person.id === starter ? "starter" : invited.has(person.id) ? "invited" : "out";
      const self = person.id === me;
      return { id: person.id, name: self ? "You" : person.name, place, self, note: NOTES[place] };
    })
    .sort((a, b) => order[a.place] - order[b.place]);
}

/** "Shared with Ana and Ben", for a chat's menu and lists; empty when nobody was invited. */
export function sharedLine(people: Person[], chat: Pick<ChatSummary, "invited">): string {
  const names = (chat.invited ?? []).map((id) => people.find((person) => person.id === id)?.name).filter((name): name is string => !!name);
  if (!names.length) return "";
  return "Shared with " + (names.length === 1 ? names[0] : names.length === 2 ? names.join(" and ") : names[0] + " and " + (names.length - 1) + " others");
}

/**
 * The small name over someone else's message in a chat several people write in, as the desktop app
 * shows it; "" in a chat of one, for this phone's own person, and for a message nobody typed (a
 * routine's or a panel refresh's). A message with no `author` is the owner's. Reads tolerantly: a
 * name the computer left out falls back to the team list, then to "Owner".
 */
export function speakerLabel(
  message: Pick<Message, "role" | "author">,
  run: Pick<RunSummary, "scheduleId" | "panelId"> | undefined,
  chat: Pick<ChatSummary, "createdBy" | "invited"> | undefined,
  people: Person[] | undefined,
  me: string,
): string {
  if (message.role !== "user" || !chat || run?.scheduleId != null || run?.panelId) return "";
  if (new Set([starterOf(chat), ...(chat.invited ?? [])]).size < 2) return "";
  const id = message.author?.memberId || OWNER;
  if (id === me) return "";
  const named = typeof message.author?.name === "string" ? message.author.name.trim() : "";
  return named || people?.find((person) => person.id === id)?.name || (id === OWNER ? "Owner" : "");
}
