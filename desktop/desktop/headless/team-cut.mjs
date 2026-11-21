// What the workspace container is told about the team, on the two-container host.
//
// The team lives in the link container's data: who is on it, each role, who a chat and a space
// are shared with. The workspace container runs the bots, and a bot's turn for a team member must
// be held to that member's role there. So the link container tells the workspace a cut of the
// team, through the socket that already joins them. The rules:
//
//  - One way. The link sends, the workspace takes. The workspace never sends team data back.
//  - The cut holds the team's name, the roles and what each allows, the groups, each member's id,
//    name and group, each person's name by id, and the people of each chat and each space by id.
//    Nothing else about a person: no device, no key, no token, no invite, no address. A space's
//    sharing is cut to who may open it; the key of its public link stays with the link.
//  - The workspace keeps the cut in memory only. Bots' tools can read and write the workspace's
//    files, so a copy on disk would be a copy a bot can change.
//  - Closed when in doubt. The cut has a revision, which is a digest of what it says, and the
//    link names its revision with every call and every look. A workspace that does not hold
//    that revision drops what it holds, and so does one that has not heard from the link for a
//    while. With no cut a team member gets the narrowest limits. A cut that cannot be read is
//    refused whole: none of it is taken.
//  - The whole cut each time, never a change to it.
//  - The link stays the judge of what a member may call. The workspace uses the cut only for a
//    turn's limits, for whom a member may mention, and for reading spaces.
import { createHash } from "node:crypto";
import { chatPeople, inChat, spaceCan } from "../link/team.mjs";

/** How long the workspace trusts a cut without hearing its revision from the link again. The link looks every 750 ms. */
export const FRESH_MS = 15_000;
const MAX_BYTES = 4 * 1024 * 1024;
const REFUSED = "The team as this computer's link sent it can't be read. Update both Botkins containers.";

const text = (value, limit, what) => {
  if (typeof value !== "string" || value.length > limit) throw new Error("bad " + what);
  return value;
};
const id = (value, what) => {
  if (typeof value !== "string" || !value || value.length > 200) throw new Error("bad " + what);
  return value;
};
const list = (value, limit, what) => {
  if (!Array.isArray(value) || value.length > limit) throw new Error("bad " + what);
  return value;
};
const record = (value, what) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad " + what);
  return value;
};
/** An object with exactly these keys (the optional ones may be absent). Anything more is not a cut this version knows. */
const only = (value, keys, optional, what) => {
  record(value, what);
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) throw new Error("unknown " + what + " field");
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error("missing " + what + " field");
  return value;
};
const byId = (entries) => [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const sortedKeys = (object) => Object.keys(object).sort();

/**
 * A cut in its one written form: only the fields above, each checked, in a fixed order, so that
 * the same team always gives the same text and the same revision. Throws when `value` is not a
 * cut: an unknown field is refused too, because a newer link may mean something by it.
 */
export function normalCut(value) {
  only(value, ["v", "name", "roles", "groups", "members", "people", "chats", "spaces"], [], "team");
  if (value.v !== 1) throw new Error("unknown version");
  const roles = byId(list(value.roles, 500, "roles").map((role) => {
    only(role, ["id", "name", "perms", "bots"], [], "role");
    const perms = record(role.perms, "perms");
    return {
      id: id(role.id, "role id"),
      name: text(role.name, 200, "role name"),
      perms: Object.fromEntries(sortedKeys(perms).map((scope) => [id(scope, "scope"), [...list(perms[scope], 50, "actions").map((action) => id(action, "action"))].sort()])),
      bots: role.bots === "all" ? "all" : [...list(role.bots, 5000, "bots").map((bot) => id(bot, "bot id"))].sort(),
    };
  }));
  const groups = byId(list(value.groups, 500, "groups").map((group) => (only(group, ["id", "name", "roleId"], [], "group"), { id: id(group.id, "group id"), name: text(group.name, 200, "group name"), roleId: id(group.roleId, "role id") })));
  const members = byId(list(value.members, 5000, "members").map((member) => {
    only(member, ["id", "name", "groupId"], [], "member");
    // No member is called "owner": the rules that read a person's id would take them for the owner.
    if (member.id === "owner") throw new Error("bad member id");
    return { id: id(member.id, "member id"), name: text(member.name, 200, "member name"), groupId: id(member.groupId, "group id") };
  }));
  const people = byId(list(value.people, 5001, "people").map((person) => (only(person, ["id", "name"], [], "person"), { id: id(person.id, "person id"), name: text(person.name, 200, "person name") })));
  const chatsIn = record(value.chats, "chats");
  const chats = Object.fromEntries(sortedKeys(chatsIn).map((chatId) => [id(chatId, "chat id"), list(chatsIn[chatId], 100, "chat people").map((person) => id(person, "person id"))]));
  const spacesIn = record(value.spaces, "spaces");
  const spaces = Object.fromEntries(sortedKeys(spacesIn).map((spaceId) => {
    const share = only(spacesIn[spaceId], ["access", "grants", "teamCan"], [], "space");
    if (!["private", "members", "team", "link"].includes(share.access) || !["view", "edit"].includes(share.teamCan)) throw new Error("bad space");
    const grants = list(share.grants, 5001, "grants").map((grant) => {
      only(grant, ["id", "can"], [], "grant");
      if (!["view", "edit"].includes(grant.can)) throw new Error("bad grant");
      return { id: id(grant.id, "person id"), can: grant.can };
    });
    return [id(spaceId, "space id"), { access: share.access, grants, teamCan: share.teamCan }];
  }));
  return { v: 1, name: text(value.name, 200, "team name"), roles, groups, members, people, chats, spaces };
}

/** A cut's revision: a digest of its one written form. Two cuts that say the same have the same revision. */
export const cutRevision = (cut) => createHash("sha256").update(JSON.stringify(cut)).digest("base64url").slice(0, 32);

/**
 * The link's side: the cut of a team as the link stores it (`LinkHost`'s `store.data.team`), with
 * its revision. `people` are each person's id and name, the owner's among them.
 */
export function teamCut(team, people = []) {
  const share = (entry) => ({
    access: ["members", "team", "link"].includes(entry?.access) ? entry.access : "private",
    grants: (Array.isArray(entry?.grants) ? entry.grants : []).filter((grant) => typeof grant?.id === "string" && grant.id).map((grant) => ({ id: grant.id, can: grant.can === "edit" ? "edit" : "view" })),
    teamCan: entry?.teamCan === "edit" ? "edit" : "view",
  });
  const cut = normalCut({
    v: 1,
    name: typeof team?.name === "string" ? team.name.slice(0, 200) : "",
    roles: (team?.roles ?? []).map((role) => ({ id: role.id, name: String(role.name ?? "").slice(0, 200), perms: Object.fromEntries(Object.entries(role.perms ?? {}).filter(([, actions]) => Array.isArray(actions))), bots: role.bots === "all" ? "all" : Array.isArray(role.bots) ? role.bots : [] })),
    groups: (team?.groups ?? []).map((group) => ({ id: group.id, name: String(group.name ?? "").slice(0, 200), roleId: group.roleId })),
    members: (team?.members ?? []).map((member) => ({ id: member.id, name: String(member.name ?? "").slice(0, 200), groupId: member.groupId })),
    people: people.map((person) => ({ id: person.id, name: String(person.name ?? "").slice(0, 200) })),
    chats: Object.fromEntries(Object.entries(team?.chats ?? {}).filter(([, invited]) => Array.isArray(invited)).map(([chatId, invited]) => [chatId, invited.filter((person) => typeof person === "string" && person)])),
    spaces: Object.fromEntries(Object.entries(team?.spaces ?? {}).map(([spaceId, entry]) => [spaceId, share(entry)])),
  });
  return { cut, rev: cutRevision(cut) };
}

/**
 * The workspace's side: the cut it was last told, in memory only.
 * `take` is the link sending one. `heard` is the link naming the revision it has now, with a call
 * or a look. `current` is the cut to use now, or null: closed when in doubt.
 */
export class HeldCut {
  /** `now` is a clock that only goes forward: setting the computer's clock back must not keep a cut in use. */
  constructor({ now = () => performance.now(), freshFor = FRESH_MS } = {}) {
    Object.assign(this, { now, freshFor, cut: null, rev: null, heardAt: 0 });
  }
  /** Takes a whole cut, or refuses it whole. What was held before goes either way: the link has moved on from it. */
  take(value, rev) {
    this.cut = null;
    this.rev = null;
    let cut;
    try {
      if (typeof rev !== "string" || !rev) throw new Error("no revision");
      if (JSON.stringify(value ?? null).length > MAX_BYTES) throw new Error("too large");
      cut = normalCut(value);
      if (cutRevision(cut) !== rev) throw new Error("the revision is not this cut's");
    } catch {
      throw new Error(REFUSED);
    }
    Object.assign(this, { cut, rev, heardAt: this.now() });
    return rev;
  }
  /** The link's revision now. Another one than is held means what is held is old: it is dropped. Answers the revision held, or null. */
  heard(rev) {
    if (this.rev !== null && rev === this.rev) this.heardAt = this.now();
    else {
      this.cut = null;
      this.rev = null;
    }
    return this.rev;
  }
  /** The cut, while the link has confirmed it lately. Otherwise null, and a member gets the narrowest limits. */
  current() {
    return this.cut && this.now() - this.heardAt <= this.freshFor ? this.cut : null;
  }
}

/**
 * What the workspace asks about the team, answered from the cut it holds (`chatOf(id)` is the
 * workspace's own chat). These are the link's own rules, on the link's own shape. With no cut a
 * chat has its creator only, and only the owner opens a space: a member gets nothing more.
 */
export function teamFromCut(held, chatOf) {
  return {
    team: () => held.current(),
    people: (chatId) => {
      const cut = held.current();
      return cut ? chatPeople(cut, chatOf(chatId) ?? { id: chatId }) : undefined;
    },
    notifiesOwner: (chatId) => {
      const cut = held.current();
      const chat = chatOf(chatId);
      return cut && chat ? inChat(cut, chat, "owner") : undefined;
    },
    spaceCan: (space, person) => {
      const cut = held.current();
      if (!cut) return person === "owner" ? "own" : null;
      // A member who is no longer on the team opens nothing, also what they made.
      if (person !== "owner" && !cut.members.some((member) => member.id === person)) return null;
      return spaceCan(cut, space, person);
    },
  };
}
