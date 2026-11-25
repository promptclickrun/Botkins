// Who is looking at a chat's people, and what they may do (the link's capability "team-people-v1").
// The sheet itself is in ChatPeople.tsx; this part has no window in it, so a test can read it.
import type { ChatPerson } from "./PersonBadge";
import type { Chat, State, TeamPerson } from "./types";

export const OWNER = "owner";

/**
 * How this window stands to a chat's people, or null when the computer in use keeps no chat people
 * (an older Botkins, or a team of one): who is on the team, who is looking, and what they may do.
 */
export function chatPeopleView(state: State, chat: Chat) {
  const team = state.team;
  const people: TeamPerson[] | undefined = team && "people" in team ? team.people : undefined;
  if (chat.hostDispatch || !people || people.length < 2) return null;
  // On its own computer the window is the owner's. Using another computer it is whoever was paired: the owner, or a member.
  const me = team && "me" in team ? team.me.memberId : OWNER;
  const createdBy = chat.createdBy ?? OWNER;
  const mayInvite = me === OWNER || me === createdBy;
  return { people, me, createdBy, mayInvite };
}

/**
 * The name above a member's message: the name the team has for them now, so a rename reaches the
 * messages they wrote before it. The name saved with the message is for a team that does not say.
 */
export function authorName(state: State, author: { memberId: string; name: string }) {
  const people = state.team && "people" in state.team ? state.team.people : undefined;
  return people?.find((person) => person.id === author.memberId)?.name ?? author.name;
}

/** Who is looking: "owner" on the computer's own window, or the person paired on the computer in use. */
export const viewerOf = (state: State) => (state.team && "me" in state.team ? state.team.me.memberId : OWNER);

/**
 * The people of a chat as their badges and tags draw them: who started it and who was invited, the
 * viewer too, each with their own picture. The owner with no picture here shows their profile's
 * emoji, when this window is on the owner's own computer. A team of one is the owner alone.
 */
export function chatPersons(state: State, chat: Chat): ChatPerson[] {
  const team = state.team;
  const people: TeamPerson[] = (team && "people" in team ? team.people : undefined) ?? [];
  const ids = new Set([chat.createdBy ?? OWNER, ...(chat.invited ?? []), viewerOf(state)]);
  // A message keeps its author when they leave the chat, so everyone on the team is known by id.
  for (const message of chat.messages) if (message.author) ids.add(message.author.memberId);
  const emoji = !state.remote?.using ? state.profile?.profile?.avatar : undefined;
  const out: ChatPerson[] = [];
  for (const id of ids) {
    const person = people.find((item) => item.id === id);
    const name = person?.name || (id === OWNER ? state.profile?.profile?.name : undefined);
    if (!name) continue;
    out.push({ id, name, ...(person?.avatar && { avatar: person.avatar }), ...(id === OWNER && !person?.avatar && emoji && { emoji }) });
  }
  return out;
}

/** Whether whoever is looking may leave the chat: they were invited into it, and did not start it. */
export const canLeave = (view: { me: string; createdBy: string }, invited: string[]) => view.me !== view.createdBy && invited.includes(view.me);

export type ChatMentionPerson = { id: string; name: string; hint?: string };

/** Other people participating in this chat who can be @mentioned, excluding whoever is looking. */
export function chatMentionPeople(state: State, chat: Chat): ChatMentionPerson[] {
  const view = chatPeopleView(state, chat);
  if (!view) return [];
  const ids = [...new Set([view.createdBy, ...(chat.invited ?? [])])].filter((id) => id !== view.me);
  const out: ChatMentionPerson[] = [];
  for (const id of ids) {
    const person = view.people.find((item) => item.id === id);
    if (!person?.name) continue;
    out.push({ id, name: person.name, hint: id === OWNER ? "Owner" : "Member" });
  }
  return out;
}

/** Formats the human typing indicator for one chat, excluding `me` and deduplicating by person id. */
export function formatTypingLabel(typers: { id: string; name: string }[] | undefined, me?: string): string | null {
  if (!typers?.length) return null;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const person of typers) {
    if (!person?.id || person.id === me || seen.has(person.id)) continue;
    const name = person.name?.trim();
    if (!name) continue;
    seen.add(person.id);
    names.push(name);
  }
  if (!names.length) return null;
  if (names.length === 1) return names[0] + " is typing";
  if (names.length === 2) return names[0] + " and " + names[1] + " are typing";
  const rest = names.length - 2;
  return names[0] + ", " + names[1] + ", and " + rest + (rest === 1 ? " other" : " others") + " are typing";
}
