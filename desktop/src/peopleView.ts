// Who is looking at a chat's people, and what they may do (the link's capability "team-people-v1").
// The sheet itself is in ChatPeople.tsx; this part has no window in it, so a test can read it.
import type { Chat, State, TeamPerson } from "./types";

export const OWNER = "owner";

/**
 * How this window stands to a chat's people, or null when the computer in use keeps no chat people
 * (an older Botkins, or a team of one): who is on the team, who is looking, and what they may do.
 */
export function chatPeopleView(state: State, chat: Chat) {
  const team = state.team;
  const people: TeamPerson[] | undefined = team && "people" in team ? team.people : undefined;
  if (!people || people.length < 2) return null;
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

/** Whether whoever is looking may leave the chat: they were invited into it, and did not start it. */
export const canLeave = (view: { me: string; createdBy: string }, invited: string[]) => view.me !== view.createdBy && invited.includes(view.me);
