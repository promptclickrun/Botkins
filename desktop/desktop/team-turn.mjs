const oneLine = (value, limit) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit)
    : "";

/** Text only the model sees when a team member sent the message. */
export function memberPrompt(text, author, team) {
  const name = oneLine(author?.name, 60);
  const teamName = oneLine(team?.name, 60);
  if (!author?.memberId || !name || !teamName) return text;
  return `[From ${name}, a member of ${teamName}'s team, not the owner]\n${text}`;
}

/** Optional tools available to the author of this turn. */
export function turnAccess(author, team) {
  if (!author?.memberId) return { member: false, skills: true, mcp: true, plugins: true };
  const member = team?.members?.find((item) => item.id === author.memberId);
  const group = team?.groups?.find((item) => item.id === member?.groupId);
  const role = team?.roles?.find((item) => item.id === group?.roleId);
  const can = (scope) => Array.isArray(role?.perms?.[scope]) && role.perms[scope].includes("use");
  return { member: true, skills: can("skills"), mcp: can("mcp"), plugins: can("plugins") };
}

/**
 * Whether a member's role lets them do something with spaces ("view", "use", "create", "manage",
 * "delete"; the scope is still named `today` so that saved roles keep working). A member who is
 * no longer on the team may do nothing.
 */
export function memberCanSpaces(memberId, team, action) {
  const member = team?.members?.find((item) => item.id === memberId);
  const group = team?.groups?.find((item) => item.id === member?.groupId);
  const perms = team?.roles?.find((item) => item.id === group?.roleId)?.perms;
  return Array.isArray(perms?.today) && perms.today.includes(action);
}
/** The limits of a turn that two people's limits apply to: a tool is there only when both may use it. */
export const narrower = (a, b) => ({ member: a.member || b.member, skills: a.skills && b.skills, mcp: a.mcp && b.mcp, plugins: a.plugins && b.plugins });

/** Whether a member's role lets them see a bot. Someone who is no longer a member sees none. */
export function memberSeesBot(memberId, team, botId) {
  const member = team?.members?.find((item) => item.id === memberId);
  const group = team?.groups?.find((item) => item.id === member?.groupId);
  const bots = team?.roles?.find((item) => item.id === group?.roleId)?.bots;
  return bots === "all" || (Array.isArray(bots) && bots.includes(botId));
}
