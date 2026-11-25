// The team: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"<word>.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// The team is kept by the phone link (desktop/link/team.mjs, desktop/link/TEAMS.md): roles, groups, members,
// invites and requests to join. The app's own calls reach it (`handlers.team`, `saveTeamRole`, …), and these
// calls use those. Each call finds a role, a group, a member, an invite or a request by the name or id a person
// typed, and hands the work to the app's call, which checks what it is given. The rules that are here:
//  - An invite's code is made to be handed on, and it is like a secret. `team.invite` answers with the code and the
//    link once. No read here has the code or the link of an invite that exists: the lists say the id, the group, the
//    uses and the time. The log names an invite by its id.
//  - A switch that gives people more room, and a change that cannot be taken back, needs the mark `agreed: true`:
//    a role that gets more rights or more bots, a group that moves to a role with more, a member that moves to
//    such a group, an approval, and each remove, revoke and deny. The command shows the change first and asks.
//  - What a person wrote (a member's name, a request's name) is data: it is never in the log.
import { BUILTIN_ROLES, cleanRole, formatCode, newInviteCode, SCOPE_ACTIONS, SCOPES } from "../link/team.mjs";
import { ControlError } from "./socket.mjs";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const shortList = (entries, label) => entries.slice(0, 5).map((entry) => label(entry) + " (" + entry.id + ")").join(", ") + (entries.length > 5 ? " and " + (entries.length - 5) + " more" : "");
/**
 * One of a list by its id, or by its label: the exact label first, then the start of a label, then the start of an id (6 characters
 * at least). With `exact` (a remove, a revoke, a deny) only an id or a whole label counts.
 */
function pick(list, ref, what, see, label = (entry) => entry.name, exact = false) {
  const wanted = text(ref, 300, "a " + what + "'s name or id");
  const byId = list.find((entry) => entry.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const matches = [(entry) => String(label(entry) ?? "").toLowerCase() === lower, (entry) => String(label(entry) ?? "").toLowerCase().startsWith(lower), (entry) => wanted.length >= 6 && entry.id.startsWith(wanted)];
  for (const match of exact ? matches.slice(0, 1) : matches) {
    const found = list.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new ControlError("More than one " + what + " matches " + wanted + ": " + shortList(found, label) + ". Use its id" + (see ? " (see `" + see + "`)" : "") + ".", "AMBIGUOUS");
  }
  throw new ControlError("There is no " + what + " called " + wanted + "." + (exact ? " This takes a whole name or an id." : "") + (see ? " See `" + see + "`." : ""), "NOT_FOUND");
}
const BUILTIN_ROLE_IDS = BUILTIN_ROLES.map((role) => role.id);
const needsYes = (what, command) => new ControlError(what + " needs a yes. Show it to the person, and give `agreed: true` (on the command line, `" + command + " --yes`).", "NEEDS_YES");
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Every right as "<scope>.<action>". */
const rightsOf = (role) => SCOPES.flatMap((scope) => (role?.perms?.[scope] ?? []).map((action) => scope + "." + action));
/** Whether a role's bot list lets a person see more bots than another list does. */
const botsWiden = (before, after) => (after === "all" ? before !== "all" : before === "all" ? false : after.some((id) => !before.includes(id)));
/** What a change from one role to another adds and takes away, and whether it gives more room. `before` is null for no role (nothing is held). */
function compare(before, after) {
  const was = new Set(rightsOf(before));
  const now = new Set(rightsOf(after));
  const added = [...now].filter((right) => !was.has(right));
  const removed = [...was].filter((right) => !now.has(right));
  const botsBefore = before ? before.bots : [];
  const botsMore = botsWiden(botsBefore, after.bots);
  return { added, removed, bots: { before: botsBefore, after: after.bots, widens: botsMore }, widens: added.length > 0 || botsMore };
}
const status = (invite, now = Date.now()) => (invite.revoked ? "revoked" : invite.expiresAt <= now ? "expired" : invite.uses >= invite.maxUses ? "used up" : "open");

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 * @param bot        (ref) → a bot, by id or by a name only one bot has (desktop/terminal/control.mjs).
 */
export function teamApi({ workspace, handlers, bot }) {
  const state = () => workspace.state;
  const botName = (id) => state().bots.find((entry) => entry.id === id)?.name ?? null;
  /** The team as the link keeps it (with the invites' codes and links: they stop here). */
  const raw = async () => {
    const team = await handlers.team();
    if (!team || typeof team !== "object") throw new ControlError("The team is not available. Phone access is still opening, or is off.", "UNAVAILABLE");
    return team;
  };

  // ── The shapes that are answered ──
  const roleView = (team, role) => {
    const groups = team.groups.filter((group) => group.roleId === role.id);
    return {
      id: role.id,
      name: role.name,
      builtin: BUILTIN_ROLE_IDS.includes(role.id),
      rights: Object.fromEntries(SCOPES.map((scope) => [scope, [...(role.perms?.[scope] ?? [])]])),
      bots: role.bots === "all" ? "all" : role.bots.map((id) => ({ id, name: botName(id) })),
      groups: groups.map((group) => ({ id: group.id, name: group.name })),
      members: team.members.filter((member) => groups.some((group) => group.id === member.groupId)).length,
    };
  };
  const groupView = (team, group) => ({
    id: group.id,
    name: group.name,
    roleId: group.roleId,
    role: team.roles.find((role) => role.id === group.roleId)?.name ?? null,
    members: team.members.filter((member) => member.groupId === group.id).length,
    invites: team.invites.filter((invite) => invite.groupId === group.id && status(invite) === "open").length,
    fixed: group.id === "g_everyone",
  });
  const memberView = (team, member) => {
    const group = team.groups.find((item) => item.id === member.groupId);
    return {
      id: member.id,
      name: member.name,
      groupId: member.groupId,
      group: group?.name ?? null,
      role: team.roles.find((role) => role.id === group?.roleId)?.name ?? null,
      joinedAt: member.joinedAt ? new Date(member.joinedAt).toISOString() : null,
      devices: (member.devices ?? []).map((device) => ({ id: device.id, name: device.name, kind: device.kind, platform: device.platform, connected: device.connected === true })),
    };
  };
  /** An invite as it is listed: never its code or its link. */
  const inviteView = (team, invite) => {
    const group = team.groups.find((item) => item.id === invite.groupId);
    return {
      id: invite.id,
      groupId: invite.groupId,
      group: group?.name ?? null,
      role: team.roles.find((role) => role.id === group?.roleId)?.name ?? null,
      status: status(invite),
      uses: invite.uses,
      maxUses: invite.maxUses,
      createdAt: new Date(invite.createdAt).toISOString(),
      expiresAt: new Date(invite.expiresAt).toISOString(),
      requests: team.requests.filter((request) => request.inviteId === invite.id).length,
    };
  };
  const requestView = (team, request) => {
    const invite = team.invites.find((item) => item.id === request.inviteId);
    const group = team.groups.find((item) => item.id === invite?.groupId);
    return {
      id: request.id,
      name: request.name,
      ...(request.person && { person: request.person }),
      platform: request.platform,
      kind: request.kind,
      at: new Date(request.at).toISOString(),
      inviteId: request.inviteId,
      groupId: group?.id ?? null,
      group: group?.name ?? null,
      role: team.roles.find((role) => role.id === group?.roleId)?.name ?? null,
    };
  };
  const view = (team) => ({
    name: team.name,
    roles: team.roles.map((role) => roleView(team, role)),
    groups: team.groups.map((group) => groupView(team, group)),
    members: team.members.map((member) => memberView(team, member)),
    invites: team.invites.map((invite) => inviteView(team, invite)),
    requests: team.requests.map((request) => requestView(team, request)),
  });

  // ── Finding things ──
  const role = (team, ref, exact) => pick(team.roles, ref, "role", "botkins team roles list", undefined, exact);
  const group = (team, ref, exact) => pick(team.groups, ref, "group", "botkins team groups list", undefined, exact);
  const member = (team, ref, exact) => pick(team.members, ref, "member", "botkins team members list", undefined, exact);
  const invite = (team, ref) => pick(team.invites, ref, "invite", "botkins team invites list", () => null, true);
  const request = (team, ref, exact) => pick(team.requests, ref, "request to join", "botkins team requests list", undefined, exact);
  const person = (team, ref) => pick(team.people, ref, "person", "botkins team members list");
  const roleOfGroup = (team, groupRecord) => team.roles.find((item) => item.id === groupRecord.roleId);
  const roleOfMember = (team, memberRecord) => roleOfGroup(team, team.groups.find((item) => item.id === memberRecord.groupId) ?? {});
  /** A chat by its id, or by its title (exactly, then the start of it). */
  const chat = (ref) => pick(state().chats.filter((entry) => !entry.temporary), ref, "chat", "botkins chats list", (entry) => entry.title);
  const agreedBy = (options) => isPlain(options) && options.agreed === true;
  const nameTaken = (list, name, exceptId, what) => {
    if (list.some((entry) => entry.id !== exceptId && sameName(entry.name, name))) throw new ControlError("There is a " + what + " called " + name.trim() + " already. Choose another name.", "EXISTS");
  };

  // ── A role's rights ──
  /** "<scope>.<action>", "<scope>.all" or "all", as a list of [scope, action]. */
  const parseRight = (value) => {
    const given = text(value, 80, "a right such as agents.chat").toLowerCase();
    if (given === "all") return SCOPES.flatMap((scope) => SCOPE_ACTIONS[scope].map((action) => [scope, action]));
    const [scope, action, ...more] = given.split(".");
    if (!SCOPES.includes(scope) || !action || more.length) throw new ControlError(JSON.stringify(given) + " is not a right. A right is <scope>.<action>, <scope>.all or all. The scopes are " + SCOPES.join(", ") + ".", "BAD_ARGUMENT");
    if (action === "all") return SCOPE_ACTIONS[scope].map((each) => [scope, each]);
    if (!SCOPE_ACTIONS[scope].includes(action)) throw new ControlError("The scope " + scope + " has the rights " + SCOPE_ACTIONS[scope].join(", ") + ", not " + JSON.stringify(action) + ".", "BAD_ARGUMENT");
    return [[scope, action]];
  };
  /** The role that a change makes, as the link will keep it (its own check cleans it). `base` is the role as it is, or the role to start from, or null. */
  const made = (team, base, change, id) => {
    if (!isPlain(change)) throw new ControlError("Give what the role has: a name and rights.", "BAD_ARGUMENT");
    const perms = Object.fromEntries(SCOPES.map((scope) => [scope, [...(base?.perms?.[scope] ?? [])]]));
    if (change.perms !== undefined) {
      if (!isPlain(change.perms)) throw new ControlError("The rights are an object: each scope with a list of actions.", "BAD_ARGUMENT");
      for (const [scope, actions] of Object.entries(change.perms)) {
        if (!SCOPES.includes(scope)) throw new ControlError("The scopes are " + SCOPES.join(", ") + ", not " + JSON.stringify(scope) + ".", "BAD_ARGUMENT");
        if (!Array.isArray(actions)) throw new ControlError("The rights of " + scope + " are a list of actions: " + SCOPE_ACTIONS[scope].join(", ") + ".", "BAD_ARGUMENT");
        for (const action of actions) if (!SCOPE_ACTIONS[scope].includes(action)) throw new ControlError("The scope " + scope + " has the rights " + SCOPE_ACTIONS[scope].join(", ") + ", not " + JSON.stringify(action) + ".", "BAD_ARGUMENT");
        perms[scope] = [...actions];
      }
    }
    for (const right of [].concat(change.allow ?? [])) for (const [scope, action] of parseRight(right)) if (!perms[scope].includes(action)) perms[scope].push(action);
    for (const right of [].concat(change.deny ?? [])) {
      for (const [scope, action] of parseRight(right)) {
        // The first right of a scope (view, read) comes with every other: taking it away takes the scope.
        perms[scope] = action === SCOPE_ACTIONS[scope][0] ? [] : perms[scope].filter((held) => held !== action);
      }
    }
    let bots = base?.bots ?? [];
    if (change.bots !== undefined) {
      if (change.bots === "all") bots = "all";
      else if (Array.isArray(change.bots)) bots = [...new Set(change.bots.map((ref) => bot(ref).id))];
      else throw new ControlError("The bots are \"all\", or a list of bots.", "BAD_ARGUMENT");
    }
    const name = change.name !== undefined ? change.name : base?.name;
    try {
      return cleanRole({ id, name, perms, bots: bots === "all" ? "all" : [...bots] });
    } catch (error) {
      throw new ControlError(error.message, "BAD_ARGUMENT");
    }
  };
  const FRESH = "r_0000000000";
  /** The role that a save would make, from the role to change (`ref`), or from a new start, with the checks that need no change made. */
  const rolePlan = (team, ref, change) => {
    const found = ref === undefined || ref === null ? null : role(team, ref);
    const from = change?.from === undefined || change?.from === null ? null : role(team, change.from);
    if (found && from) throw new ControlError("Change a role, or start a new one from another. Not both.", "BAD_ARGUMENT");
    if (!found && change?.name === undefined) throw new ControlError("Give the new role a name.", "BAD_ARGUMENT");
    const after = made(team, found ?? from, change, found?.id ?? FRESH);
    nameTaken(team.roles, after.name, found?.id, "role");
    return { found, from, after };
  };
  /** What saving this role would do. `ref` is the role to change, or null for a new one. */
  const roleLook = (team, ref, change) => {
    const { found, from, after } = rolePlan(team, ref, change);
    return { isNew: !found, before: found ? roleView(team, found) : null, after: { ...roleView(team, after), id: found?.id ?? null }, ...compare(found, after), ...(from && { from: { id: from.id, name: from.name } }) };
  };
  const freshId = (taken, prefix, make) => {
    let id;
    do id = prefix + make();
    while (taken.some((entry) => entry.id === id));
    return id;
  };

  // ── A group's role, and what a move gives ──
  const groupLook = (team, ref, change) => {
    if (!isPlain(change)) throw new ControlError("Give the group a name or a role.", "BAD_ARGUMENT");
    const found = ref === undefined || ref === null ? null : group(team, ref);
    const target = change.role === undefined ? (found ? roleOfGroup(team, found) : null) : role(team, change.role);
    if (!found && change.name === undefined) throw new ControlError("Give the new group a name.", "BAD_ARGUMENT");
    if (!target) throw new ControlError("Give the new group a role (see `botkins team roles list`).", "BAD_ARGUMENT");
    const name = change.name !== undefined ? change.name : found.name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw new ControlError("Give the group a name of up to 40 characters.", "BAD_ARGUMENT");
    nameTaken(team.groups, name, found?.id, "group");
    const was = found ? roleOfGroup(team, found) : null;
    const holds = found ? { members: team.members.filter((item) => item.groupId === found.id).length, invites: team.invites.filter((item) => item.groupId === found.id && status(item) === "open").length } : { members: 0, invites: 0 };
    return { isNew: !found, id: found?.id ?? null, name: name.trim(), role: { id: target.id, name: target.name }, was: was ? { id: was.id, name: was.name } : null, ...holds, ...(found && was ? compare(was, target) : { added: [], removed: [], bots: { before: [], after: target.bots, widens: false }, widens: false }) };
  };
  const removeGroupLook = (team, ref, moveTo) => {
    const found = group(team, ref, true);
    if (found.fixed || found.id === "g_everyone") throw new ControlError("The group Everyone is always there. It cannot be removed.", "BAD_ARGUMENT");
    const members = team.members.filter((item) => item.groupId === found.id);
    const invites = team.invites.filter((item) => item.groupId === found.id && status(item) === "open");
    const requests = team.requests.filter((item) => item.inviteId && team.invites.find((one) => one.id === item.inviteId)?.groupId === found.id);
    const target = moveTo === undefined || moveTo === null ? null : group(team, moveTo);
    if (target && target.id === found.id) throw new ControlError("Choose another group to move them to.", "BAD_ARGUMENT");
    const moves = members.length + invites.length + requests.length;
    const was = roleOfGroup(team, found);
    const to = target ? roleOfGroup(team, target) : null;
    return { id: found.id, name: found.name, members: members.length, invites: invites.length, requests: requests.length, moves, to: target ? { id: target.id, name: target.name, role: to?.name ?? null } : null, ...(to && was ? compare(was, to) : { added: [], removed: [], bots: { before: [], after: [], widens: false }, widens: false }) };
  };
  const moveLook = (team, memberRef, groupRef) => {
    const who = member(team, memberRef);
    const to = group(team, groupRef);
    const from = team.groups.find((item) => item.id === who.groupId);
    const was = roleOfMember(team, who);
    const now = roleOfGroup(team, to);
    return { member: { id: who.id, name: who.name }, from: { id: from?.id ?? who.groupId, name: from?.name ?? null, role: was?.name ?? null }, to: { id: to.id, name: to.name, role: now?.name ?? null }, ...(was && now ? compare(was, now) : { added: [], removed: [], bots: { before: [], after: [], widens: false }, widens: false }), same: who.groupId === to.id };
  };
  /** What a member loses when removed: their devices, their place in chats. */
  const removeMemberLook = async (team, ref) => {
    const who = member(team, ref, true);
    let invited = 0;
    let started = 0;
    for (const entry of state().chats) {
      let people;
      try {
        people = await handlers.chatPeople(entry.id);
      } catch {
        continue;
      }
      if (people?.createdBy === who.id) started++;
      else if (people?.invited?.includes(who.id)) invited++;
    }
    const full = memberView(team, who);
    return { member: { id: who.id, name: who.name }, group: full.group, role: full.role, devices: full.devices, chatsInvited: invited, chatsStarted: started };
  };
  const approveLook = (team, ref, groupRef) => {
    const asked = request(team, ref);
    const full = requestView(team, asked);
    const chosen = groupRef === undefined || groupRef === null ? null : group(team, groupRef);
    const target = chosen ?? team.groups.find((item) => item.id === full.groupId) ?? null;
    const rights = target ? roleOfGroup(team, target) : null;
    return { request: full, group: target ? { id: target.id, name: target.name } : null, role: rights ? roleView(team, rights) : null };
  };

  const peopleOf = (team, found, held) => {
    const name = (id) => team.people.find((item) => item.id === id)?.name ?? null;
    const starter = held?.createdBy ?? "owner";
    return { chat: { id: found.id, title: found.title }, people: [{ id: starter, name: name(starter), is: "starter" }, ...(held?.invited ?? []).filter((id) => id !== starter).map((id) => ({ id, name: name(id), is: "invited" }))] };
  };

  return {
    // ── The team, and what it has ──
    /** The team's name, its roles, groups, members, invites and requests. No invite's code or link. */
    "team.get": async () => view(await raw()),
    "team.rename": async ([name]) => {
      await handlers.renameTeam(text(name, 200, "the team a name of up to 60 characters"));
      return { name: (await raw()).name };
    },

    // ── Roles ──
    "team.roles": async () => {
      const team = await raw();
      return team.roles.map((entry) => roleView(team, entry));
    },
    "team.role": async ([ref]) => {
      const team = await raw();
      return roleView(team, role(team, ref));
    },
    /**
     * Saves a role: `ref` is the role to change (a name or id), or null for a new one. `change` holds `name`, `perms`
     * (a scope with its list of actions, which replaces that scope), `allow` and `deny` (lists of "<scope>.<action>",
     * "<scope>.all" or "all"), `bots` ("all", or a list of bots) and, for a new role, `from` (a role to start from).
     * A role that gets more rights or more bots (and a new role that has any) needs `agreed: true` in `options`.
     */
    async "team.saveRole"([ref, change, options]) {
      const team = await raw();
      const plan = rolePlan(team, ref, change);
      const look = compare(plan.found, plan.after);
      if (look.widens && !agreedBy(options)) throw needsYes("A role that has more rights or more bots gives its members more room. This one adds " + (look.added.length ? look.added.join(", ") : "bots") + ". It", "botkins team roles save");
      const id = plan.found?.id ?? freshId(team.roles, "r_", newInviteCode);
      await handlers.saveTeamRole({ ...plan.after, id });
      const now = await raw();
      return { ...roleView(now, now.roles.find((item) => item.id === id) ?? { ...plan.after, id }), created: !plan.found, added: look.added, removed: look.removed };
    },
    /** A role goes. A role that a group has cannot go. */
    async "team.removeRole"([ref, options]) {
      const team = await raw();
      const found = role(team, ref, true);
      const view = roleView(team, found);
      if (view.groups.length) throw new ControlError("Move every group off the role " + found.name + " before you remove it: " + view.groups.map((item) => item.name).join(", ") + " (`botkins team groups save`).", "IN_USE");
      if (!agreedBy(options)) throw needsYes("Removing the role " + found.name + ", which cannot be undone,", "botkins team roles remove");
      await handlers.deleteTeamRole(found.id);
      return { removed: found.id, id: found.id, name: found.name };
    },

    // ── Groups ──
    "team.groups": async () => {
      const team = await raw();
      return team.groups.map((entry) => groupView(team, entry));
    },
    /** Saves a group: `ref` is the group to change, or null for a new one. `change` holds `name` and `role` (a name or id). A group that moves to a role with more rights needs `agreed: true`. */
    async "team.saveGroup"([ref, change, options]) {
      const team = await raw();
      const look = groupLook(team, ref, change);
      if (look.widens && !agreedBy(options)) throw needsYes("A group that moves to a role with more rights gives its members more room. This one adds " + (look.added.length ? look.added.join(", ") : "bots") + ". It", "botkins team groups save");
      const id = look.id ?? freshId(team.groups, "g_", newInviteCode);
      await handlers.saveTeamGroup({ id, name: look.name, roleId: look.role.id });
      const now = await raw();
      return { ...groupView(now, now.groups.find((item) => item.id === id)), created: look.isNew, added: look.added, removed: look.removed };
    },
    /** A group goes. Its members, invites and requests move to the group `moveTo`, which they need when there are any. A move to a role with more rights needs `agreed: true`. */
    async "team.removeGroup"([ref, moveTo, options]) {
      const team = await raw();
      const look = removeGroupLook(team, ref, moveTo);
      if (look.moves && !look.to) throw new ControlError("The group " + look.name + " has " + look.members + " member(s), " + look.invites + " open invite(s) and " + look.requests + " request(s). Choose a group to move them to.", "BAD_ARGUMENT");
      if (look.moves && look.widens && !agreedBy(options)) throw needsYes("Moving them to " + look.to.name + ", a role with more rights, gives them more room. It", "botkins team groups remove");
      await handlers.deleteTeamGroup(look.id, look.to?.id);
      return { removed: look.id, id: look.id, name: look.name, moved: look.moves, to: look.to };
    },

    // ── Invites ──
    /**
     * Makes an invite for a group (the group Everyone when none is named). `options`: { group?, days?: 1 | 7 | 30, uses?: 1 | 5 | 25 }.
     * The answer has the invite's code and its link: the only place that does. Whoever has the code can ask to join; the owner still
     * approves each request (`team.approve`).
     */
    async "team.invite"([options = {}]) {
      if (!isPlain(options)) throw new ControlError("Give the group, the days and the uses, or nothing.", "BAD_ARGUMENT");
      const team = await raw();
      const target = options.group === undefined || options.group === null ? team.groups.find((item) => item.id === "g_everyone") : group(team, options.group);
      if (!target) throw new ControlError("The group Everyone is not there. Name a group.", "NOT_FOUND");
      const days = options.days ?? 7;
      const uses = options.uses ?? 1;
      if (![1, 7, 30].includes(days)) throw new ControlError("An invite lasts 1, 7 or 30 days.", "BAD_ARGUMENT");
      if (![1, 5, 25].includes(uses)) throw new ControlError("An invite can be used 1, 5 or 25 times.", "BAD_ARGUMENT");
      const made = await handlers.createTeamInvite({ groupId: target.id, days, maxUses: uses });
      // Without the relay a code cannot find this computer by itself: the link's address has to be reachable.
      let relay = false;
      try {
        relay = (await handlers.phoneLink())?.relay?.enabled === true;
      } catch {}
      const rights = roleOfGroup(team, target);
      return { id: made.id, groupId: target.id, group: target.name, role: rights?.name ?? null, code: formatCode(made.code), link: made.link, expiresAt: new Date(made.expiresAt).toISOString(), maxUses: made.maxUses, relay };
    },
    "team.invites": async () => {
      const team = await raw();
      return team.invites.map((entry) => inviteView(team, entry));
    },
    /** The invite stops taking new requests. A request that was made with it still waits for the owner. Needs `agreed: true`. */
    async "team.revokeInvite"([ref, options]) {
      const team = await raw();
      const found = invite(team, ref);
      const view = inviteView(team, found);
      if (found.revoked) throw new ControlError("That invite is revoked already.", "BAD_ARGUMENT");
      if (!agreedBy(options)) throw needsYes("Revoking an invite, which cannot be undone,", "botkins team invites revoke");
      await handlers.revokeTeamInvite(found.id);
      return { revoked: found.id, id: found.id, group: view.group, requests: team.requests.filter((item) => item.inviteId === found.id).length };
    },

    // ── Requests to join ──
    "team.requests": async () => {
      const team = await raw();
      return team.requests.map((entry) => requestView(team, entry));
    },
    /** What a change would do, and nothing of it done: the command shows this before it asks. `kind` is role, group, removeGroup, move, removeMember, approve, removeRole, revokeInvite or deny. */
    "team.look": async ([kind, ...args]) => {
      const team = await raw();
      if (kind === "role") return roleLook(team, args[0], args[1]);
      if (kind === "group") return groupLook(team, args[0], args[1]);
      if (kind === "removeGroup") return removeGroupLook(team, args[0], args[1]);
      if (kind === "move") return moveLook(team, args[0], args[1]);
      if (kind === "removeMember") return removeMemberLook(team, args[0]);
      if (kind === "approve") return approveLook(team, args[0], args[1]);
      if (kind === "removeRole") return roleView(team, role(team, args[0], true));
      if (kind === "revokeInvite") return inviteView(team, invite(team, args[0]));
      if (kind === "deny") return requestView(team, request(team, args[0], true));
      throw new ControlError("A look is one of role, group, removeGroup, move, removeMember, approve, removeRole, revokeInvite or deny.", "BAD_ARGUMENT");
    },
    /** Takes a person into the team, in the invite's group or in `options.group`. Gives a new person access, so it needs `agreed: true`. */
    async "team.approve"([ref, options = {}]) {
      const team = await raw();
      const look = approveLook(team, ref, options?.group);
      if (!agreedBy(options)) throw needsYes("Approving a request lets this person into the team, with the rights of the group " + (look.group?.name ?? "of its invite") + ". It", "botkins team requests approve");
      const before = new Set(team.members.map((item) => item.id));
      await handlers.approveTeamRequest(look.request.id, look.group?.id);
      const now = await raw();
      const joined = now.members.find((item) => !before.has(item.id));
      return { request: look.request.id, id: look.request.id, member: joined ? memberView(now, joined) : null };
    },
    /** The person is told that the owner did not approve. Needs `agreed: true`. */
    async "team.deny"([ref, options]) {
      const team = await raw();
      const asked = request(team, ref, true);
      if (!agreedBy(options)) throw needsYes("Denying a request", "botkins team requests deny");
      await handlers.denyTeamRequest(asked.id);
      return { denied: asked.id, id: asked.id };
    },

    // ── Members ──
    "team.members": async () => {
      const team = await raw();
      return team.members.map((entry) => memberView(team, entry));
    },
    /** Puts a member in another group. A group with a role that has more rights needs `agreed: true`. */
    async "team.moveMember"([ref, groupRef, options]) {
      const team = await raw();
      const look = moveLook(team, ref, groupRef);
      if (look.widens && !agreedBy(options)) throw needsYes("A move to a role with more rights gives this member more room. This one adds " + (look.added.length ? look.added.join(", ") : "bots") + ". It", "botkins team members move");
      await handlers.moveTeamMember(look.member.id, look.to.id);
      const now = await raw();
      return { ...memberView(now, now.members.find((item) => item.id === look.member.id)), added: look.added, removed: look.removed };
    },
    /** Gives a member another name, up to 60 characters. The member and their devices take it. It changes nothing a member may do, so it needs no yes. */
    async "team.renameMember"([ref, name]) {
      const who = member(await raw(), ref);
      await handlers.renameTeamMember(who.id, text(name, 200, "the member a name of up to 60 characters"));
      const now = await raw();
      return { ...memberView(now, now.members.find((item) => item.id === who.id)), previous: who.name };
    },
    /** The member leaves the team: their devices go and their sessions end at once. Needs `agreed: true`. */
    async "team.removeMember"([ref, options]) {
      const team = await raw();
      const look = await removeMemberLook(team, ref);
      if (!agreedBy(options)) throw needsYes("Removing a member, which ends their devices' sessions at once and cannot be undone,", "botkins team members remove");
      await handlers.removeTeamMember(look.member.id);
      return { removed: look.member.id, id: look.member.id, name: look.member.name, devices: look.devices.length, chatsInvited: look.chatsInvited, chatsStarted: look.chatsStarted };
    },

    // ── The owner's own picture ──
    /** Sets the owner's picture (a data URL the link checks) or clears it with null. Answers whether one is set, never the picture. */
    async "profile.picture"([image]) {
      if (image !== null && image !== undefined && typeof image !== "string") throw new ControlError("Give a picture, or nothing to clear it.", "BAD_ARGUMENT");
      const answer = await handlers.setMyAvatar(image ?? null);
      return { set: !!answer?.avatar };
    },

    // ── The people in a chat ──
    /** Who started a chat and who was invited into it. */
    async "team.chatPeople"([ref]) {
      const team = await raw();
      const found = chat(ref);
      return peopleOf(team, found, await handlers.chatPeople(found.id));
    },
    /** Invites a person (a member's name or id, or "owner") into a chat. The link checks that the person's role can use the chat's bot. The chat becomes visible to one more person, so it needs `agreed: true`. */
    async "team.inviteToChat"([ref, who, options]) {
      const team = await raw();
      const found = chat(ref);
      const target = person(team, who);
      if (!agreedBy(options)) throw needsYes("Inviting a person into a chat makes the chat visible to one more person, who then sees all of it. It", "botkins team chat invite");
      await handlers.inviteToChat(found.id, target.id);
      return { ...peopleOf(team, found, await handlers.chatPeople(found.id)), person: { id: target.id, name: target.name } };
    },
    async "team.removeFromChat"([ref, who]) {
      const team = await raw();
      const found = chat(ref);
      const target = person(team, who);
      await handlers.removeFromChat(found.id, target.id);
      return { ...peopleOf(team, found, await handlers.chatPeople(found.id)), person: { id: target.id, name: target.name } };
    },
  };
}
