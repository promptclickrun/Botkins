// The team: the commands (cli/commands/index.mjs adds them).
// `teamCommands` maps a top-level word to a group `{ summary, commands }`: `botkins team`.
//
// What these hold to (desktop/AGENTS.md):
//  - The team is kept by the phone link. A member is a person who joined with an invite and was approved. A group
//    has one role, and a member is in one group. A role says which rights its members have, and which bots they see.
//  - An invite's code is like a secret that is made to be handed on. `team invite` prints it once, in its answer.
//    No other command prints the code or the link of an invite, and the log names an invite by its id only.
//  - What gives people more room is shown first, and asks: a role with more rights or more bots, a group that
//    moves to a role with more, a member that moves to such a group, and an approval. So does what cannot be
//    taken back: a remove, a revoke and a deny. With no terminal each needs --yes. The block goes to standard
//    error with --yes and with --json too.
//  - What a person wrote (a member's name, a request's name, a role's name) is made safe before it is printed
//    to a person. `--json` and a pipe get it as it is.
import { readFileSync } from "node:fs";
import { SCOPE_ACTIONS, SCOPES } from "../../desktop/link/team.mjs";
import { shownText } from "../../desktop/shown-text.mjs";
import { ago, CliError, EXIT, table, usage } from "../output.mjs";
import { confirm, readAll } from "./input.mjs";
import { shellWord } from "./tools.mjs";

// No short form: the same as in the commands of tools.
const YES = { yes: { type: "boolean", about: "Do not ask first" } };
const safe = shownText;
/** What must be seen is written to standard error whatever --json is: a caller that reads JSON still shows its person. */
const show = (context, text) => void context.stderr.write(text + "\n");
const count = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);
const word = (name, placeholder) => shellWord(name, placeholder);
const call = (context, method, ...args) => context.client.call(method, ...args);
const RIGHTS_HELP = SCOPES.map((scope) => scope + " (" + SCOPE_ACTIONS[scope].join(", ") + ")").join("; ");

const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const two = (context, what) => {
  if (context.args.length !== 2) throw usage(what);
  return context.args;
};
/** The text of a JSON file, or of standard input for "-". */
async function jsonFrom(context, path) {
  let source;
  if (path === "-") source = await readAll(context.stdin);
  else {
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      throw new CliError("The file " + path + " cannot be read: " + error.message);
    }
  }
  try {
    const value = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("It is not an object.");
    return value;
  } catch (error) {
    throw usage("The file " + path + " is not a JSON object: " + error.message);
  }
}

// ── How the team's parts are shown ──
const botsText = (bots) => (bots === "all" ? "all bots" : bots.length ? bots.map((entry) => safe(entry.name ?? entry.id)).join(", ") : "no bots");
const rightsLines = (rights) => SCOPES.map((scope) => "  " + scope.padEnd(9) + (rights[scope]?.length ? rights[scope].join(", ") : "none"));
const rightsShort = (rights) => SCOPES.filter((scope) => rights[scope]?.length).map((scope) => scope + ": " + rights[scope].join(" ")).join("; ") || "none";
const roleText = (role) =>
  [
    safe(role.name) + "   " + role.id + (role.builtin ? "   (built in)" : ""),
    ...rightsLines(role.rights),
    "Bots: " + botsText(role.bots),
    role.groups.length ? "Groups: " + role.groups.map((entry) => safe(entry.name)).join(", ") + ". Members: " + role.members + "." : "No group has this role.",
  ].join("\n");
const rolesTable = (roles) => (roles.length ? table(["NAME", "BOTS", "GROUPS", "MEMBERS", "ID"], roles.map((role) => [safe(role.name), role.bots === "all" ? "all" : role.bots.length, role.groups.map((entry) => safe(entry.name)).join(", "), role.members, role.id])) : "No roles.");
const groupsTable = (groups) => (groups.length ? table(["NAME", "ROLE", "MEMBERS", "OPEN INVITES", "ID"], groups.map((group) => [safe(group.name), group.role ? safe(group.role) : "", group.members, group.invites, group.id])) : "No groups.");
const membersTable = (members) => (members.length ? table(["NAME", "GROUP", "ROLE", "DEVICES", "JOINED", "ID"], members.map((entry) => [safe(entry.name), entry.group ? safe(entry.group) : "", entry.role ? safe(entry.role) : "", entry.devices.length, entry.joinedAt ? ago(entry.joinedAt) : "", entry.id])) : "No members yet. Make an invite with `botkins team invite`.");
const invitesTable = (invites) => (invites.length ? table(["ID", "GROUP", "ROLE", "STATUS", "USES", "ENDS", "WAITING"], invites.map((entry) => [entry.id, entry.group ? safe(entry.group) : "", entry.role ? safe(entry.role) : "", entry.status, entry.uses + " of " + entry.maxUses, entry.status === "open" ? ago(entry.expiresAt) : "", entry.requests])) : "No invites. Make one with `botkins team invite`.");
const requestsTable = (requests) => (requests.length ? table(["NAME", "DEVICE", "GROUP", "WHEN", "ID"], requests.map((entry) => [safe(entry.person ? entry.person + " (" + entry.name + ")" : entry.name), safe(entry.platform || entry.kind), entry.group ? safe(entry.group) : "", ago(entry.at), entry.id])) : "No one waits to join.");
const teamText = (team) =>
  [
    safe(team.name),
    "Roles: " + team.roles.length + ". Groups: " + team.groups.length + ". Members: " + team.members.length + ". Open invites: " + team.invites.filter((entry) => entry.status === "open").length + ". Requests waiting: " + team.requests.length + ".",
    "",
    "Roles",
    rolesTable(team.roles),
    "",
    "Groups",
    groupsTable(team.groups),
    "",
    "Members",
    membersTable(team.members),
    "",
    "Invites",
    invitesTable(team.invites),
    "",
    "Requests to join",
    requestsTable(team.requests),
  ].join("\n");

/** What a change adds and takes away, in a line each. */
const changeLines = (look) => [look.added.length ? "Adds: " + look.added.join(", ") + "." : null, look.removed.length ? "Takes away: " + look.removed.join(", ") + "." : null, look.bots.widens ? "Bots: more can be seen (" + botsText(look.bots.after === "all" ? "all" : look.bots.after.map((id) => ({ id }))) + ")." : null].filter(Boolean);
const MORE_ROOM = "This gives people more room, so it needs a yes.";

export const teamCommands = {
  team: {
    summary: "The team: the people who use this computer's Botkins, and what each may do",
    details:
      "A person joins with an invite and the owner approves them. A member is in one group. A group has one role. A role says which rights its members have (" +
      RIGHTS_HELP +
      ") and which bots they see. An invite is for a group. `botkins team invite` makes one and prints its code once: whoever has the code can ask to join, and each request still waits for your approval (`botkins team requests approve`). The commands that give people more room, and the ones that cannot be taken back, show the change first and ask; with no terminal they need --yes.",
    commands: {
      show: {
        summary: "Show the team: its name, roles, groups, members, open invites and requests",
        usage: "botkins team show",
        details: "An invite's code is not shown here. The command that makes an invite prints it once.",
        async run(context) {
          context.print(await call(context, "team.get"), teamText);
        },
      },
      rename: {
        summary: "Give the team another name",
        usage: "botkins team rename <name>",
        arguments: [{ name: "name", required: true, many: true }],
        details: "The name is up to 60 characters. People who ask to join see it.",
        async run(context) {
          if (!context.args.length) throw usage("Give the team a name.");
          context.print(await call(context, "team.rename", context.args.join(" ")), (done) => "The team is called " + safe(done.name) + " now.");
        },
      },

      roles: {
        summary: "Roles: which rights a group's members have, and which bots they see",
        details: "The rights are " + RIGHTS_HELP + ". Each right except the first of its scope needs the first, so the first comes with it.",
        commands: {
          list: {
            summary: "List the roles, or show one role's rights",
            usage: "botkins team roles list [<role>]",
            arguments: [{ name: "role", required: false }],
            async run(context) {
              if (context.args.length > 1) throw usage("Name one role, or none.");
              if (context.args.length) return context.print(await call(context, "team.role", context.args[0]), roleText);
              context.print(await call(context, "team.roles"), rolesTable);
            },
          },
          save: {
            summary: "Make a role, or change one: its name, its rights and its bots",
            usage: "botkins team roles save [<role>] [--name <text>] [--from <role>] [--allow <right>…] [--deny <right>…] [--all-bots] [--bot <bot>…] [--no-bots] [--file <path>] [--yes]",
            options: {
              name: { type: "string", value: "text", about: "The role's name (40 characters at most). A new role needs one" },
              from: { type: "string", value: "role", about: "A new role starts with the rights and bots of this role" },
              allow: { type: "string", multiple: true, value: "right", about: "Give a right: <scope>.<action>, <scope>.all or all" },
              deny: { type: "string", multiple: true, value: "right", about: "Take a right away. The first right of a scope takes the whole scope" },
              "all-bots": { type: "boolean", about: "Members see every bot" },
              bot: { type: "string", multiple: true, value: "bot", about: "Members see only these bots (name or id). Give it more than once for more bots" },
              "no-bots": { type: "boolean", about: "Members see no bot" },
              file: { type: "string", value: "path", about: "The change as JSON: { name?, from?, perms?, allow?, deny?, bots? } (\"-\" reads standard input)" },
              ...YES,
            },
            details:
              "With a role named, the command changes it: it starts from the rights the role has. Without one, it makes a new role from nothing, or from --from. The rights are " +
              RIGHTS_HELP +
              ". Name one as <scope>.<action>, for example agents.chat. <scope>.all gives every right of a scope, and all gives every right. --file takes a JSON object: perms is { scope: [actions] } and replaces each scope it names; allow and deny are lists of rights; bots is \"all\" or a list of bots. Flags are added to what the file says. The command shows the role as it will be, and what changes against the role as it is, on standard error. A role that gets more rights or more bots, and a new role that has any, gives its members more room: that asks, and with no terminal it needs --yes. A change that only takes away asks nothing.",
            async run(context) {
              if (context.args.length > 1) throw usage("Name the role to change (its name or id), or none for a new role.");
              const o = context.options;
              if ([o["all-bots"], o["no-bots"], o.bot?.length].filter(Boolean).length > 1) throw usage("Give --all-bots, --bot or --no-bots, only one of them.");
              const change = o.file !== undefined ? await jsonFrom(context, o.file) : {};
              if (o.name !== undefined) change.name = o.name;
              if (o.from !== undefined) change.from = o.from;
              if (o.allow?.length) change.allow = [].concat(change.allow ?? [], o.allow);
              if (o.deny?.length) change.deny = [].concat(change.deny ?? [], o.deny);
              if (o["all-bots"]) change.bots = "all";
              if (o["no-bots"]) change.bots = [];
              if (o.bot?.length) change.bots = o.bot;
              if (!Object.keys(change).length) throw usage("Give what the role has: --name, --allow, --deny, --all-bots, --bot or --no-bots (or --file).");
              const ref = context.args[0] ?? null;
              const look = await call(context, "team.look", "role", ref, change);
              show(context, [look.isNew ? "A new role" + (look.from ? ", from " + safe(look.from.name) : "") + ", as it will be:" : "The role " + safe(look.before.name) + " (" + look.before.id + "), as it will be:", "  " + safe(look.after.name), ...rightsLines(look.after.rights), "  Bots: " + botsText(look.after.bots), ...(look.before ? [look.before.groups.length ? "Groups that have it: " + look.before.groups.map((entry) => safe(entry.name)).join(", ") + ". Members: " + look.before.members + "." : "No group has this role yet."] : []), ...(look.isNew ? [] : changeLines(look).length ? ["What changes:", ...changeLines(look).map((line) => "  " + line)] : ["No right or bot changes."]), ...(look.widens ? [MORE_ROOM] : [])].join("\n"));
              if (look.widens && !(await confirm(context, "Save the role?"))) return EXIT.failed;
              const saved = await call(context, "team.saveRole", ref, change, look.widens ? { agreed: true } : undefined);
              context.print(saved, (done) => (done.created ? "Made the role " : "Saved the role ") + safe(done.name) + " (" + done.id + ").");
            },
          },
          remove: {
            summary: "Remove a role",
            usage: "botkins team roles remove <role> [--yes]",
            options: YES,
            details: "A role that a group has cannot be removed: move the groups off it first (`botkins team groups save`). Removing a role cannot be undone; you can make it again. It takes a whole name or an id, not the start of one. It asks first; with no terminal it needs --yes.",
            async run(context) {
              const found = await call(context, "team.look", "removeRole", one(context, "Name the role (its name or id)."));
              if (found.groups.length) throw new CliError("Move every group off the role " + safe(found.name) + " before you remove it: " + found.groups.map((entry) => safe(entry.name)).join(", ") + " (`botkins team groups save`).");
              show(context, "This removes the role " + safe(found.name) + " (" + found.id + "). It has " + rightsShort(found.rights) + ". No group has it. You can make a role again with `botkins team roles save`.");
              if (!(await confirm(context, "Remove the role?"))) return EXIT.failed;
              context.print(await call(context, "team.removeRole", found.id, { agreed: true }), (gone) => "Removed the role " + safe(gone.name) + ".");
            },
          },
        },
      },

      groups: {
        summary: "Groups: a set of members with one role",
        details: "A member is in one group, and the group's role decides what the member may do. The group Everyone is always there. A new person joins the group of the invite they used.",
        commands: {
          list: {
            summary: "List the groups",
            usage: "botkins team groups list",
            async run(context) {
              context.print(await call(context, "team.groups"), groupsTable);
            },
          },
          save: {
            summary: "Make a group, or change a group's name or role",
            usage: "botkins team groups save [<group>] [--name <text>] [--role <role>] [--yes]",
            options: { name: { type: "string", value: "text", about: "The group's name (40 characters at most). A new group needs one" }, role: { type: "string", value: "role", about: "The group's role (name or id). A new group needs one" }, ...YES },
            details: "Without a group, it makes a new one. With one, it changes what you name. A group that moves to a role with more rights or more bots gives its members more room: the command shows what is added and asks; with no terminal it needs --yes. A move to a role with less asks nothing.",
            async run(context) {
              if (context.args.length > 1) throw usage("Name the group to change (its name or id), or none for a new group.");
              const o = context.options;
              const change = { ...(o.name !== undefined && { name: o.name }), ...(o.role !== undefined && { role: o.role }) };
              if (!Object.keys(change).length) throw usage("Give --name or --role.");
              const ref = context.args[0] ?? null;
              const look = await call(context, "team.look", "group", ref, change);
              show(context, [(look.isNew ? "A new group " : "The group ") + safe(look.name) + (look.isNew ? "" : " (" + look.id + ")") + " will have the role " + safe(look.role.name) + (look.was && look.was.id !== look.role.id ? ", not " + safe(look.was.name) + " as now" : "") + ".", ...(look.isNew ? [] : [count(look.members, "member") + " and " + count(look.invites, "open invite") + " are in this group."]), ...changeLines(look), ...(look.widens ? [MORE_ROOM] : [])].join("\n"));
              if (look.widens && !(await confirm(context, "Save the group?"))) return EXIT.failed;
              context.print(await call(context, "team.saveGroup", ref, change, look.widens ? { agreed: true } : undefined), (done) => (done.created ? "Made the group " : "Saved the group ") + safe(done.name) + " (" + done.id + ").");
            },
          },
          remove: {
            summary: "Remove a group",
            usage: "botkins team groups remove <group> [--move-to <group>] [--yes]",
            options: { "move-to": { type: "string", value: "group", about: "Where the members, the open invites and the requests of this group go. Needed when it has any" }, ...YES },
            details: "The group Everyone cannot be removed. It takes a whole name or an id, not the start of one. The members, the open invites and the requests to join of the group move to the group named with --move-to. When that group's role has more rights, the move gives people more room: the command shows what is added and asks; with no terminal it needs --yes.",
            async run(context) {
              const ref = one(context, "Name the group (its name or id).");
              const look = await call(context, "team.look", "removeGroup", ref, context.options["move-to"]);
              if (look.moves && !look.to) throw usage("The group " + safe(look.name) + " has " + count(look.members, "member") + ", " + count(look.invites, "open invite") + " and " + count(look.requests, "request") + ". Choose a group to move them to with --move-to.");
              show(context, ["This removes the group " + safe(look.name) + " (" + look.id + ").", look.moves ? "Its " + count(look.members, "member") + ", " + count(look.invites, "open invite") + " and " + count(look.requests, "request") + " move to the group " + safe(look.to.name) + " (role " + safe(look.to.role ?? "none") + ")." : "No member, invite or request is in it.", ...(look.moves ? changeLines(look) : []), ...(look.moves && look.widens ? [MORE_ROOM] : [])].join("\n"));
              const asks = look.moves > 0 && look.widens;
              if (asks && !(await confirm(context, "Remove the group?"))) return EXIT.failed;
              context.print(await call(context, "team.removeGroup", look.id, look.to?.id, asks ? { agreed: true } : undefined), (gone) => "Removed the group " + safe(gone.name) + "." + (gone.moved ? " " + count(gone.moved, "member, invite or request", "members, invites and requests") + " moved to " + safe(gone.to.name) + "." : ""));
            },
          },
        },
      },

      invite: {
        summary: "Make an invite for a group, and print its code and link",
        usage: "botkins team invite [--group <group>] [--days <1|7|30>] [--uses <1|5|25>]",
        options: { group: { type: "string", value: "group", about: "The group the person joins (name or id). The default is Everyone" }, days: { type: "string", value: "days", about: "How long the invite lasts: 1, 7 (the default) or 30" }, uses: { type: "string", value: "uses", about: "How many people can join with it: 1 (the default), 5 or 25" } },
        details:
          "This prints the invite's code and its link once: handing them on is the point. Whoever has the code can ask to join. Nobody joins until you approve the request (`botkins team requests list`, then `approve`). No other command shows the code again, and the log names the invite by its id only. To end an invite, use `botkins team invites revoke`. A typed code finds this computer through the relay; with the relay off (`botkins relay status`) only the link works, and only where this computer can be reached.",
        async run(context) {
          if (context.args.length) throw usage("This command takes no word. Name the group with --group.");
          const o = context.options;
          const number = (value, name) => {
            if (value === undefined) return undefined;
            if (!/^[0-9]+$/.test(value)) throw usage("--" + name + " is a number.");
            return Number(value);
          };
          const options = { ...(o.group !== undefined && { group: o.group }), ...(o.days !== undefined && { days: number(o.days, "days") }), ...(o.uses !== undefined && { uses: number(o.uses, "uses") }) };
          const made = await call(context, "team.invite", options);
          context.print(made, (invite) =>
            [
              "Made an invite for the group " + safe(invite.group) + (invite.role ? " (role " + safe(invite.role) + ")" : "") + ". It ends " + ago(invite.expiresAt) + " and takes " + count(invite.maxUses, "person", "people") + ". Its id is " + invite.id + ".",
              "Code: " + invite.code,
              "Link: " + invite.link,
              "Whoever has the code can ask to join. You still approve each request: `botkins team requests list`, then `botkins team requests approve <request>`.",
              "This is the only time a command shows the code.",
              ...(invite.relay ? [] : ["The relay is off, so a typed code cannot find this computer by itself. The link works only where this computer can be reached (`botkins relay on`)."]),
            ].join("\n"),
          );
        },
      },
      invites: {
        summary: "Invites: list them, or end one",
        details: "These commands never show an invite's code or link.",
        commands: {
          list: {
            summary: "List the invites: group, status, uses and when they end",
            usage: "botkins team invites list",
            details: "The status is open, used up, expired or revoked. WAITING counts the requests to join that came with the invite and still wait. The code is not shown: `botkins team invite` prints it once, when the invite is made.",
            async run(context) {
              context.print(await call(context, "team.invites"), invitesTable);
            },
          },
          revoke: {
            summary: "End an invite, so that its code does not work any more",
            usage: "botkins team invites revoke <invite> [--yes]",
            options: YES,
            arguments: [{ name: "invite", required: true }],
            details: "The invite is its id (`botkins team invites list`). A request that came with it before still waits for you: approve or deny it. Revoking cannot be undone. It asks first; with no terminal it needs --yes.",
            async run(context) {
              const found = await call(context, "team.look", "revokeInvite", one(context, "Name the invite (its id)."));
              if (found.status === "revoked") throw new CliError("That invite is revoked already.");
              show(context, "This ends the invite " + found.id + " for the group " + safe(found.group ?? found.groupId) + ". Its code does not work any more." + (found.requests ? " " + count(found.requests, "request") + " that came with it still wait for you." : ""));
              if (!(await confirm(context, "Revoke the invite?"))) return EXIT.failed;
              context.print(await call(context, "team.revokeInvite", found.id, { agreed: true }), (done) => "Revoked the invite " + done.id + ".");
            },
          },
        },
      },

      requests: {
        summary: "Requests to join: people who used an invite and wait for you",
        commands: {
          list: {
            summary: "List the people who wait to join",
            usage: "botkins team requests list",
            async run(context) {
              context.print(await call(context, "team.requests"), requestsTable);
            },
          },
          approve: {
            summary: "Let a person into the team",
            usage: "botkins team requests approve <request> [--group <group>] [--yes]",
            options: { group: { type: "string", value: "group", about: "Put the person in this group, not the invite's group" }, ...YES },
            arguments: [{ name: "request", required: true }],
            details: "The request is the person's name or its id (`botkins team requests list`). The person joins the group of the invite, or the group named with --group, and has that group's role. The command shows who asks, the group and the role's rights, and asks; with no terminal it needs --yes. The bots keep their own tools when they work for a member: the role trims what they may use.",
            async run(context) {
              const ref = one(context, "Name the request (the person's name or its id).");
              const look = await call(context, "team.look", "approve", ref, context.options.group);
              const asked = look.request;
              show(context, ["This lets " + safe(asked.person ? asked.person + " (" + asked.name + ")" : asked.name) + " into the team, on " + (safe(asked.platform || asked.kind) || "a device") + ", " + ago(asked.at) + ".", look.group ? "Group: " + safe(look.group.name) + (look.role ? ", role " + safe(look.role.name) : "") + "." : "Group: the one of its invite.", ...(look.role ? ["Rights:", ...rightsLines(look.role.rights), "Bots they see: " + botsText(look.role.bots)] : []), "They can then use this computer's bots within those rights."].join("\n"));
              if (!(await confirm(context, "Let this person in?"))) return EXIT.failed;
              context.print(await call(context, "team.approve", asked.id, { ...(look.group && context.options.group !== undefined && { group: look.group.id }), agreed: true }), (done) => "Approved. " + (done.member ? safe(done.member.name) + " is a member (" + done.member.id + ")." : "The person is a member now."));
            },
          },
          deny: {
            summary: "Turn a request away",
            usage: "botkins team requests deny <request> [--yes]",
            options: YES,
            arguments: [{ name: "request", required: true }],
            details: "The person is told that the owner did not approve. For 24 hours the same device gets that answer, and cannot ask again. It takes the person's whole name or the id. It asks first; with no terminal it needs --yes.",
            async run(context) {
              const found = await call(context, "team.look", "deny", one(context, "Name the request (the person's name or its id)."));
              show(context, "This turns away " + safe(found.person ? found.person + " (" + found.name + ")" : found.name) + ". The person is told that the owner did not approve, and cannot ask again for 24 hours.");
              if (!(await confirm(context, "Deny the request?"))) return EXIT.failed;
              context.print(await call(context, "team.deny", found.id, { agreed: true }), (done) => "Denied the request " + done.denied + ".");
            },
          },
        },
      },

      members: {
        summary: "Members: the people who joined",
        commands: {
          list: {
            summary: "List the members, with their group, role and devices",
            usage: "botkins team members list",
            async run(context) {
              context.print(await call(context, "team.members"), membersTable);
            },
          },
          move: {
            summary: "Put a member in another group",
            usage: "botkins team members move <member> <group> [--yes]",
            options: YES,
            arguments: [{ name: "member", required: true }, { name: "group", required: true }],
            details: "The member has the role of the new group. When that role has more rights or more bots, the move gives the member more room: the command shows what is added and asks; with no terminal it needs --yes. A move to a role with less asks nothing.",
            async run(context) {
              const [who, to] = two(context, "Name the member, then the group.");
              const look = await call(context, "team.look", "move", who, to);
              if (look.same) return context.print({ ...look, moved: false }, "The member " + safe(look.member.name) + " is in the group " + safe(look.to.name) + " already.");
              show(context, ["This moves " + safe(look.member.name) + " (" + look.member.id + ") from the group " + safe(look.from.name ?? look.from.id) + " (role " + safe(look.from.role ?? "none") + ") to " + safe(look.to.name) + " (role " + safe(look.to.role ?? "none") + ").", ...changeLines(look), ...(look.widens ? [MORE_ROOM] : [])].join("\n"));
              if (look.widens && !(await confirm(context, "Move the member?"))) return EXIT.failed;
              context.print(await call(context, "team.moveMember", look.member.id, look.to.id, look.widens ? { agreed: true } : undefined), (done) => safe(done.name) + " is in the group " + safe(done.group ?? "") + " now.");
            },
          },
          rename: {
            summary: "Give a member another name",
            usage: "botkins team members rename <member> <name>",
            arguments: [{ name: "member", required: true }, { name: "name", required: true, many: true }],
            details: "The name is up to 60 characters. It is the member's name everywhere: in the team, in chats and on their devices. It asks nothing, because it changes what the member may do in no way. The words after the member make the name, so `rename Sam Sam Lee` and `rename Sam \"Sam Lee\"` do the same.",
            async run(context) {
              if (context.args.length < 2) throw usage("Name the member, then the new name.");
              const [who, ...name] = context.args;
              context.print(await call(context, "team.renameMember", who, name.join(" ")), (done) => safe(done.previous ?? who) + " is called " + safe(done.name) + " now.");
            },
          },
          remove: {
            summary: "Take a member out of the team",
            usage: "botkins team members remove <member> [--yes]",
            options: YES,
            arguments: [{ name: "member", required: true }],
            details: "The member's devices are removed and their sessions end at once. They lose their place in the chats they were invited to. The chats they started stay. The spaces they made pass to you and become private, and what they were given in spaces ends. They need a new invite and your approval to come back. The command shows this and asks; with no terminal it needs --yes. It takes a whole name or an id, not the start of one.",
            async run(context) {
              const look = await call(context, "team.look", "removeMember", one(context, "Name the member (its name or id)."));
              show(context, ["This takes " + safe(look.member.name) + " (" + look.member.id + ") out of the team. The member is in the group " + safe(look.group ?? "none") + " (role " + safe(look.role ?? "none") + ").", look.devices.length ? "Their " + count(look.devices.length, "device") + " go now and their sessions end at once: " + look.devices.map((entry) => safe(entry.name)).join(", ") + "." : "They have no device.", "They lose their place in " + count(look.chatsInvited, "chat") + " they were invited to. The " + count(look.chatsStarted, "chat") + " they started stay.", "The spaces they made pass to you and become private. What they were given in spaces ends.", "This cannot be undone: they need a new invite and your approval to come back."].join("\n"));
              if (!(await confirm(context, "Remove the member?"))) return EXIT.failed;
              context.print(await call(context, "team.removeMember", look.member.id, { agreed: true }), (gone) => "Removed " + safe(gone.name) + " from the team.");
            },
          },
        },
      },

      chat: {
        summary: "The people in a chat: who started it, and who was invited",
        details: "A chat is its id or its title. A person is a member's name or id, or `owner`. A chat holds up to 20 people. The invited see the chat, read it, send and answer in it. An invite does not widen a role: a person whose role cannot use the chat's bot cannot be invited.",
        commands: {
          list: {
            summary: "List the people in a chat",
            usage: "botkins team chat list <chat>",
            async run(context) {
              context.print(await call(context, "team.chatPeople", one(context, "Name the chat (its title or id).")), (found) => table(["NAME", "ID", "IS"], found.people.map((entry) => [entry.name ? safe(entry.name) : "", entry.id, entry.is])));
            },
          },
          invite: {
            summary: "Invite a person into a chat",
            usage: "botkins team chat invite <chat> <person> [--yes]",
            options: YES,
            arguments: [{ name: "chat", required: true }, { name: "person", required: true }],
            details: "The invited person sees the whole chat, with what was said in it before, and can send and answer in it. That makes the chat visible to one more person, so the command shows who and which chat, and asks; with no terminal it needs --yes. The person's role must be able to use the chat's bot.",
            async run(context) {
              const [chat, who] = two(context, "Name the chat, then the person.");
              const found = await call(context, "team.chatPeople", chat);
              show(context, "This lets " + safe(who) + " see the chat " + word(found.chat.title ?? found.chat.id, found.chat.id) + " (" + found.chat.id + "): all of it, with what was said before, and they can send and answer in it. " + count(found.people.length, "person", "people") + " can see it now.");
              if (!(await confirm(context, "Invite the person into the chat?"))) return EXIT.failed;
              context.print(await call(context, "team.inviteToChat", chat, who, { agreed: true }), (done) => safe(done.person.name ?? done.person.id) + " is in the chat " + word(done.chat.title ?? done.chat.id, done.chat.id) + ". " + count(done.people.length, "person", "people") + " in all.");
            },
          },
          remove: {
            summary: "Take a person out of a chat",
            usage: "botkins team chat remove <chat> <person>",
            arguments: [{ name: "chat", required: true }, { name: "person", required: true }],
            details: "The person's place in the chat ends, and so does the chat's card on their phones. The person can be invited again. The one who started the chat stays.",
            async run(context) {
              const [chat, who] = two(context, "Name the chat, then the person.");
              context.print(await call(context, "team.removeFromChat", chat, who), (done) => safe(done.person.name ?? done.person.id) + " is out of the chat " + word(done.chat.title ?? done.chat.id, done.chat.id) + ". " + count(done.people.length, "person", "people") + " left.");
            },
          },
        },
      },
    },
  },
};
