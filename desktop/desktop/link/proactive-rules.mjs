// Who may change what of a bot's Proactive agent ("proactive-team-v1"). No imports: the app on the computer
// (desktop/proactive.mjs) and the demo computer (mock-backend.mjs) both check a change with this, so the
// rule is written once. A hidden control is not the rule: this is.
//
// A bot looks out for several people. What they share (how often it checks, the cap, what it watches, its
// rules, look-around, `setUp`, the bot's switch) is the bot's. `people` holds each person's own entry:
// `{ on, notify }`.
//
// - The owner changes anything, and adds or takes out anyone whose role sees the bot.
// - A member changes only their own entry. They add themselves only when their role manages the bot.
// - A member whose role manages the bot may also finish the setup steps and change what the people share,
//   but never look-around (it reads the computer's own accounts), the tasks watch (tasks are the owner's),
//   or the bot's switch to off.
// - A member whose role doesn't see the bot may do nothing.
//
// Nobody is told of another person's alerts: an entry has no field for that, and the app refuses one.

export const OWNER = "owner";
/** What a bot's people share, as a patch may name it. */
export const SHARED_FIELDS = ["enabled", "setUp", "every", "sweepHours", "maxPerDay", "deliver", "watch", "instructions"];

const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const roleOf = (team, memberId) => {
  const member = team?.members?.find((item) => item.id === memberId);
  const group = team?.groups?.find((item) => item.id === member?.groupId);
  return member ? team?.roles?.find((item) => item.id === group?.roleId) : undefined;
};
const may = (role, scope, action) => Array.isArray(role?.perms?.[scope]) && role.perms[scope].includes(action);

/** Whether a bot may look out for a person: the owner always, a member while their role sees the bot. */
export function proactiveSees(team, person, botId) {
  if (person === OWNER) return true;
  const bots = roleOf(team, person)?.bots;
  return bots === "all" || (Array.isArray(bots) && bots.includes(botId));
}
/** Whether a person may set a bot's agent up and change what its people share: the owner, or a member whose role manages the bot. */
export function proactiveManages(team, person, botId) {
  return person === OWNER || (may(roleOf(team, person), "agents", "manage") && proactiveSees(team, person, botId));
}
/** Whether a person may take an alert's offer: it starts a turn with the bot, which is chatting. */
export function proactiveChats(team, person) {
  return person === OWNER || may(roleOf(team, person), "agents", "chat");
}
/** The people a bot may look out for, for a checklist: the owner first, then each member whose role sees the bot. */
export function proactiveEligible(team, botId, ownerName = "") {
  const owner = team?.people?.find((person) => person?.id === OWNER)?.name || ownerName;
  return [{ id: OWNER, name: owner || "Owner" }, ...(team?.members ?? []).filter((member) => proactiveSees(team, member.id, botId)).map((member) => ({ id: member.id, name: member.name }))];
}

/**
 * Checks a change to a bot's Proactive agent for the person who makes it, and answers the change to apply.
 * `by` is "owner" or a member's id, `start` the bot's entry as it is (or as it would start), `team` the team.
 * Throws with the words the person is shown. The answer is a copy: a member's `watch` keeps the tasks watch
 * as the owner set it.
 */
export function proactivePatch({ patch, start, by, team, botId }) {
  if (!plain(patch)) throw new Error("Invalid Proactive agent setting");
  const member = by !== OWNER;
  if (member && !proactiveSees(team, by, botId)) throw new Error("Your team role can't see this bot.");
  const { people, ...shared } = patch;
  const named = people === undefined ? undefined : plain(people) ? people : null;
  if (named === null) throw new Error("Choose who this bot looks out for.");
  const had = plain(start?.people) ? start.people : {};
  if (member) {
    const manages = proactiveManages(team, by, botId);
    if (Object.keys(shared).length) {
      if (!manages) throw new Error("Your team role can't change this bot's Proactive settings. You can turn your own alerts on or off.");
      if (shared.enabled === false || shared.setUp === false) throw new Error("Only the owner can turn this bot's Proactive agent off. Turn your own alerts off instead.");
      if (shared.sweepHours !== undefined && shared.sweepHours !== (start?.sweepHours ?? 0)) throw new Error("Only the owner can turn on look-around: it reads the computer's own tools and accounts.");
      if (Array.isArray(shared.watch)) shared.watch = [...shared.watch.filter((watch) => watch !== "tasks"), ...(start?.watch?.includes("tasks") ? ["tasks"] : [])];
      if (shared.deliver === "feed" && !may(roleOf(team, by), "today", "view")) throw new Error("Your team role doesn't include Today, so alerts can't go to your Feed.");
    }
    for (const [id, entry] of Object.entries(named ?? {})) {
      if (id !== by) throw new Error("You can change only your own alerts.");
      if (entry !== null && !had[by] && !manages) throw new Error("Your team role can't add you. Ask the owner to add you.");
    }
  } else {
    for (const [id, entry] of Object.entries(named ?? {})) {
      if (id === OWNER || entry === null) continue;
      const who = team?.members?.find((item) => item.id === id);
      if (!who) throw new Error("That person is not on the team.");
      if (!proactiveSees(team, id, botId)) throw new Error((String(who.name ?? "").trim() || "That person") + "'s team role can't see this bot. Change their role in Team settings first.");
    }
  }
  return { ...shared, ...(named && { people: named }) };
}

/** The settings a bot starts from when `by` is the first to change it: one a member sets up never looks around, and tasks are the owner's. */
export function proactiveStart(usual, by) {
  return by === OWNER ? { ...usual } : { ...usual, sweepHours: 0, watch: usual.watch.filter((watch) => watch !== "tasks") };
}
