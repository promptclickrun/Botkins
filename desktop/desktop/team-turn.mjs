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
