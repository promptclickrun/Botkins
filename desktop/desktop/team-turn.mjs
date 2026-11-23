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

/** A person's name as the model is shown it: one line, no brackets (they frame a message's speaker). */
const nameText = (value) => oneLine(value, 60).replace(/[[\]]/g, "");

/**
 * What Botkins calls a person, by id ("owner" or a member's id): the owner's name from the team's
 * people, a member's from the members. "" when unknown, and for an owner nobody named ("Owner" is
 * the team list's placeholder). Never the computer's account or an email.
 */
export function personName(team, id) {
  if (id === "owner") {
    const name = nameText(team?.people?.find((person) => person?.id === "owner")?.name);
    return name === "Owner" ? "" : name;
  }
  return nameText(team?.members?.find((member) => member?.id === id)?.name);
}

/**
 * Who a turn's text is from, for the model: `{ line, label }`. `line` is one short line for the
 * start of the turn ("" when nobody can be named), `label` is how each of this speaker's messages
 * starts in a chat of several people ("" in a chat of one). `humans` are the chat's people by id;
 * `author` is the message's member (none for the owner); `automatic` is a routine, task or panel
 * refresh, which no person wrote. `helping` words the line for a teammate asked by another bot.
 * Pure: the same inputs always give the same text.
 */
export function speakerContext({ team, humans = [], author, automatic = false, helping = false }) {
  const id = author?.memberId ?? "owner";
  const name = personName(team, id) || (author?.memberId ? nameText(author.name) || "A member" : "");
  const who = name ? name + " (person id " + id + ")" : "";
  if (automatic) {
    // A turn that runs for a member already says so (`memberPrompt`). Where no person is named at
    // all (an owner nobody named, alone), there is nothing to say it is not.
    if (author?.memberId || (!personName(team, "owner") && new Set(humans).size < 2)) return { line: "", label: "" };
    return { line: "[Botkins: this turn started on its own (a routine, task or panel refresh); no person is writing to you.]", label: "" };
  }
  const people = [...new Set([...humans, id])];
  if (people.length < 2) {
    const verb = helping ? "you are helping with a request from " : "you are talking with ";
    return { line: who ? "[Botkins: " + verb + who + ".]" : "", label: "" };
  }
  const named = people.map((person) => ({ person, name: personName(team, person) || (person === "owner" ? "Owner" : "A member") }));
  // Two people with one name are told apart by id.
  const label = (entry) => (named.filter((other) => other.name === entry.name).length > 1 ? entry.name + " · " + entry.person : entry.name);
  const me = named.find((entry) => entry.person === id);
  const list = named.map((entry) => label(entry) + " (" + (entry.person === "owner" ? "owner" : "member") + ", id " + entry.person + ")").join(", ");
  const from = helping ? "The request is from " : "Each message starts with its speaker's name in brackets; the latest is from ";
  return { line: "[Botkins: this chat has several people: " + list + ". " + from + label(me) + ".]", label: label(me) };
}

/**
 * A turn's text for the model, with who it is from: the turn's line, then the text. In a chat of
 * several people the text starts with its speaker's name. In a chat of one it is as it always
 * was: a member's text still says it is not the owner's. `labelled` text already names its
 * speakers (a group chat's catch-up); `line: false` leaves the line out (a message added to a turn
 * under way). A `/command` is left as typed.
 */
export function speakerPrompt(text, { team, author, labelled = false, line = true, ...rest }) {
  // A command or skill the harness runs as typed (`/name args`) must still start with its slash.
  if (text.startsWith("/")) return memberPrompt(text, author, team);
  const context = speakerContext({ team, author, ...rest });
  const body = context.label && !labelled ? "[" + context.label + "] " + text : memberPrompt(text, author, team);
  return line && context.line ? context.line + "\n" + body : body;
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

/** Whether a member's role lets them manage bots and see this one. Someone who is no longer a member may not. */
export function memberManagesBot(memberId, team, botId) {
  const member = team?.members?.find((item) => item.id === memberId);
  const group = team?.groups?.find((item) => item.id === member?.groupId);
  const perms = team?.roles?.find((item) => item.id === group?.roleId)?.perms;
  return Array.isArray(perms?.agents) && perms.agents.includes("manage") && memberSeesBot(memberId, team, botId);
}
