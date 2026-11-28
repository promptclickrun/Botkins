// The team from the command line (cli/commands/team.mjs), against a real service. Two tests:
//  - the main path: roles, groups, an invite, a request that is approved, a member that is moved and removed,
//    and the people in a chat, each as the command line does it;
//  - the rule that matters most: an invite's code is printed once, by `team invite`, and is in no list, no log
//    and no file; a change that gives more room, and each remove, need a yes, at the command and at the socket.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
import { readPersistedWorkspaceText } from "./starter.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
/** A real service, and `botkins(argv, { input, tty })` to run a command against it. */
async function service(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-team-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const botkins = async (argv, { input = "", tty = false } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("Changed from the command line")).map((text) => text.split("Changed from the command line: ")[1]).filter((line) => line.startsWith("team."));
  /** Every text this host keeps in files that the workspace and the log use, and the link's own store. */
  const everything = () => {
    const files = [join(paths.dataDir, "workspace.db"), paths.logFile];
    return files.map((file) => readFileSync(file, "utf8")).join("\n");
  };
  /** A person who asked to join with an invite, as the link would have kept the request. */
  const asks = (inviteId, name, person) => {
    const link = running.runtime.link;
    const team = link.store.data.team;
    const id = "q_" + randomBytes(5).toString("hex").toUpperCase();
    team.requests.push({ id, status: "pending", publicKey: randomBytes(32).toString("base64url"), code: "UNUSED0000", name, ...(person && { person }), platform: "ios", kind: "phone", presenceKey: null, groupId: team.invites.find((invite) => invite.id === inviteId).groupId, inviteId, at: Date.now() });
    link.store.save();
    link.teamChanged();
    return id;
  };
  return { dir, paths, running, client, botkins, changes, everything, asks, workspace: running.runtime.workspace, link: running.runtime.link };
}

test("the team: roles, groups, an invite, an approval, a move, a removal and the people in a chat", { skip }, async (t) => {
  const { botkins, client, changes, asks } = await service(t);
  // A new team: a name, three roles, and the group Everyone.
  const first = (await botkins(["team", "show", "--json"])).json();
  assert.deepEqual([first.name, first.roles.map((role) => role.name).sort(), first.groups.map((group) => group.name), first.members.length], ["My team", ["Admin", "Collaborator", "Guest"], ["Everyone"], 0]);
  assert.match((await botkins(["team", "show"])).out, /^My team\nRoles: 3\. Groups: 1\. Members: 0\./);
  assert.equal((await botkins(["team", "rename", "Launch", "crew"])).out, "The team is called Launch crew now.\n");

  // A new role with rights: the block shows it as it will be, and it asks (no terminal: --yes).
  const asked = await botkins(["team", "roles", "save", "--name", "Reviewer", "--from", "Guest", "--allow", "today.use", "--allow", "skills.create", "--all-bots"]);
  assert.equal(asked.exit, 2, asked.err);
  assert.match(asked.err, /A new role, from Guest, as it will be:/);
  assert.match(asked.err, /today {4}view, use/);
  assert.match(asked.err, /Bots: all bots/);
  assert.match(asked.err, /This gives people more room, so it needs a yes\./);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal((await botkins(["team", "roles", "list", "--json"])).json().length, 3, "nothing is saved without the yes");
  const saved = await botkins(["team", "roles", "save", "--name", "Reviewer", "--from", "Guest", "--allow", "today.use", "--allow", "skills.create", "--all-bots", "--yes", "--json"]);
  assert.equal(saved.exit, 0, saved.err);
  const reviewer = saved.json();
  assert.deepEqual([reviewer.name, reviewer.created, reviewer.rights.skills, reviewer.rights.today, reviewer.bots], ["Reviewer", true, ["read", "use", "create"], ["view", "use"], "all"]);
  assert.match((await botkins(["team", "roles", "list", "Review"])).out, /^Reviewer {3}r_[0-9A-Z]{10}\n {2}agents {3}view, chat\n/);
  // A change that only takes away asks nothing, and shows what it takes.
  const less = await botkins(["team", "roles", "save", "Reviewer", "--deny", "skills.create", "--deny", "plugins.all"]);
  assert.equal(less.exit, 0, less.err);
  assert.match(less.err, /Takes away: skills\.create, plugins\.view, plugins\.use\./);
  assert.match((await botkins(["team", "roles", "save", "Reviewer", "--allow", "agents.chat", "--allow", "agents.nothing"])).err, /The scope agents has the rights view, chat, create, manage, delete, not "nothing"\./);
  assert.match((await botkins(["team", "roles", "save", "--name", "reviewer", "--allow", "agents.view", "--yes"])).err, /There is a role called reviewer already\./);

  // A group with the role; a group that has no member can be removed with no question.
  const group = await botkins(["team", "groups", "save", "--name", "Reviewers", "--role", "Reviewer", "--json"]);
  assert.equal(group.exit, 0, group.err);
  assert.match((await botkins(["team", "groups", "list"])).out, /^NAME +ROLE +MEMBERS +OPEN INVITES +ID\nEveryone +Guest +0 +0 +g_everyone\nReviewers +Reviewer +0 +0 +g_/);
  assert.match((await botkins(["team", "groups", "remove", "Everyone"])).err, /The group Everyone is always there/);
  await botkins(["team", "groups", "save", "--name", "Temporary", "--role", "Guest"]);
  assert.match((await botkins(["team", "groups", "remove", "Temp"])).err, /There is no group called Temp\. This takes a whole name or an id\./);
  assert.match((await botkins(["team", "groups", "remove", "Temporary"])).out, /^Removed the group Temporary\.\n?$/);

  // An invite for the group: the code and the link are printed once, with the words about approval.
  const made = await botkins(["team", "invite", "--group", "Reviewers", "--days", "30", "--uses", "5"]);
  assert.equal(made.exit, 0, made.err);
  assert.match(made.out, /^Made an invite for the group Reviewers \(role Reviewer\)\. It ends in 30 days and takes 5 people\. Its id is i_[0-9A-Z]{10}\.\nCode: [0-9A-Z]{5}-[0-9A-Z]{5}\nLink: https:\/\/.*\/join#c=[0-9A-Z]{10}&k=/);
  assert.match(made.out, /Whoever has the code can ask to join\. You still approve each request/);
  assert.equal((await botkins(["team", "invite", "--days", "3"])).exit, 1);
  assert.equal((await botkins(["team", "invite", "--uses", "many"])).exit, 2);
  const invites = (await botkins(["team", "invites", "list", "--json"])).json();
  assert.deepEqual(invites.map((invite) => [invite.group, invite.role, invite.status, invite.uses, invite.maxUses]), [["Reviewers", "Reviewer", "open", 0, 5]]);

  // A person asks to join. Approving needs a yes and shows who and what they get.
  const request = asks(invites[0].id, "Sam's phone", "Sam");
  assert.match((await botkins(["team", "requests", "list"])).out, new RegExp("^NAME +DEVICE +GROUP +WHEN +ID\\nSam \\(Sam's phone\\) +ios +Reviewers +.*" + request));
  const approve = await botkins(["team", "requests", "approve", "Sam"]);
  assert.equal(approve.exit, 2);
  assert.match(approve.err, /This lets Sam \(Sam's phone\) into the team, on ios, .* ago\.\nGroup: Reviewers, role Reviewer\.\nRights:\n/);
  assert.match(approve.err, /Bots they see: all bots/);
  const approved = await botkins(["team", "requests", "approve", "Sam", "--yes", "--json"]);
  assert.equal(approved.exit, 0, approved.err);
  assert.match(approved.err, /This lets Sam/, "the block is on standard error with --yes and --json too");
  assert.deepEqual([approved.json().member.name, approved.json().member.group, approved.json().member.role, approved.json().member.devices.length], ["Sam", "Reviewers", "Reviewer", 1]);
  assert.equal((await botkins(["team", "requests", "list"])).out, "No one waits to join.\n");
  const member = approved.json().member.id;
  assert.match((await botkins(["team", "invites", "list"])).out, /open +1 of 5/);

  // A move to a role with more rights asks; one with less asks nothing. The member is found by name.
  await botkins(["team", "groups", "save", "--name", "Admins", "--role", "Admin"]);
  const up = await botkins(["team", "members", "move", "Sam", "Admins"]);
  assert.equal(up.exit, 2);
  assert.match(up.err, /This moves Sam \(m_[0-9A-Z]{10}\) from the group Reviewers \(role Reviewer\) to Admins \(role Admin\)\.\nAdds: .*agents\.delete/);
  assert.match((await botkins(["team", "members", "move", "Sam", "Admins", "--yes"])).out, /^Sam is in the group Admins now\.\n?$/);
  assert.match((await botkins(["team", "members", "move", "Sam", "Everyone"])).out, /^Sam is in the group Everyone now\.\n?$/);
  assert.match((await botkins(["team", "members", "move", "Sam", "Everyone"])).out, /is in the group Everyone already/);
  assert.match((await botkins(["team", "members", "list"])).out, new RegExp("^NAME +GROUP +ROLE +DEVICES +JOINED +ID\\nSam +Everyone +Guest +1 +.* ago +" + member));
  // A group that holds a member is removed only with a place to move them to; a move up asks.
  assert.match((await botkins(["team", "groups", "remove", "Everyone"])).err, /always there/);
  await botkins(["team", "members", "move", "Sam", "Reviewers", "--yes"]);
  assert.equal((await botkins(["team", "groups", "remove", "Reviewers"])).exit, 2);
  assert.match((await botkins(["team", "groups", "remove", "Reviewers"])).err, /has 1 member, 1 open invite and 0 requests\. Choose a group to move them to with --move-to\./);
  const moveDown = await botkins(["team", "groups", "remove", "Reviewers", "--move-to", "Everyone"]);
  assert.equal(moveDown.exit, 2, "the move to Everyone adds plugins");
  assert.match(moveDown.err, /Adds: plugins\.view, plugins\.use\./);
  const removeGroup = await botkins(["team", "groups", "remove", "Reviewers", "--move-to", "Everyone", "--yes"]);
  assert.equal(removeGroup.exit, 0, removeGroup.err);
  assert.match(removeGroup.out, /Removed the group Reviewers\. 2 members, invites and requests moved to Everyone\./);

  // The people in a chat: invite, list, remove. The member's role (Guest) cannot use a bot that it cannot see, and the link says so.
  await client.call("bots.add", { name: "Nova" });
  const { chatId } = await client.call("chat.open", "Nova");
  assert.match((await botkins(["team", "chat", "list", chatId])).out, /^NAME +ID +IS\n.* +owner +starter\n$/);
  // An invite makes the chat visible to one more person, so it shows who and which chat, and asks; the call carries the mark.
  const unasked = await botkins(["team", "chat", "invite", chatId, "Sam"]);
  assert.equal(unasked.exit, 2);
  assert.match(unasked.err, /This lets Sam see the chat .*: all of it, with what was said before/);
  assert.match(unasked.err, /This needs a yes\. Run it again with --yes\./);
  await assert.rejects(client.call("team.inviteToChat", chatId, "Sam"), { code: "NEEDS_YES" });
  assert.equal((await client.call("team.chatPeople", chatId)).people.length, 1, "nobody was invited");
  const refused = await botkins(["team", "chat", "invite", chatId, "Sam", "--yes"]);
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /That person's role can't use this chat's bot\. Change their role in Team settings first\./);
  await botkins(["team", "members", "move", "Sam", "Admins", "--yes"]);
  assert.match((await botkins(["team", "chat", "invite", chatId, "Sam", "--yes"])).out, /^Sam is in the chat .* 2 people in all\.\n?$/);
  assert.deepEqual((await botkins(["team", "chat", "list", chatId, "--json"])).json().people.map((entry) => [entry.name, entry.is]), [[(await client.call("team.chatPeople", chatId)).people[0].name, "starter"], ["Sam", "invited"]]);
  assert.match((await botkins(["team", "chat", "remove", chatId, "sam"])).out, /^Sam is out of the chat .* 1 person left\.\n?$/);

  // A removal says what the member loses, and asks; the member's devices go.
  await botkins(["team", "chat", "invite", chatId, "Sam", "--yes"]);
  const gone = await botkins(["team", "members", "remove", "Sam"]);
  assert.equal(gone.exit, 2);
  assert.match(gone.err, /This takes Sam \(m_[0-9A-Z]{10}\) out of the team\. The member is in the group Admins \(role Admin\)\.\nTheir 1 device go now and their sessions end at once: Sam's phone\.\nThey lose their place in 1 chat they were invited to\. The 0 chats they started stay\./);
  assert.match(gone.err, /This cannot be undone: they need a new invite and your approval to come back\./);
  assert.equal((await botkins(["team", "show", "--json"])).json().members.length, 1);
  const yes = await botkins(["team", "members", "remove", "Sam"], { tty: true, input: "y\n" });
  assert.equal(yes.exit, 0, yes.err);
  assert.match(yes.out, /^Removed Sam from the team\.\n?$/);
  assert.equal((await botkins(["team", "show", "--json"])).json().members.length, 0);

  // A role that a group has cannot be removed; one that none has asks first.
  assert.match((await botkins(["team", "roles", "remove", "Admin"])).err, /Move every group off the role Admin before you remove it: Admins/);
  assert.equal((await botkins(["team", "roles", "remove", "Reviewer"])).exit, 2);
  assert.match((await botkins(["team", "roles", "remove", "Reviewer", "--yes"])).out, /^Removed the role Reviewer\.\n?$/);

  // Requests: deny asks. Invites: revoke asks, and says what still waits.
  const again = asks(invites[0].id, "Lee", null);
  assert.equal((await botkins(["team", "requests", "deny", "Lee"])).exit, 2);
  assert.match((await botkins(["team", "requests", "deny", "Lee", "--yes"])).out, new RegExp("^Denied the request " + again + "\\.\\n?$"));
  const revoke = await botkins(["team", "invites", "revoke", invites[0].id]);
  assert.equal(revoke.exit, 2);
  assert.match(revoke.err, /Its code does not work any more\./);
  assert.match((await botkins(["team", "invites", "revoke", invites[0].id, "--yes"])).out, /^Revoked the invite i_/);
  assert.match((await botkins(["team", "invites", "list"])).out, /revoked/);

  // The log names the thing by its id: never a name, never a code.
  const lines = await changes();
  assert.ok(lines.length >= 15, lines.join("\n"));
  assert.ok(lines.every((line) => /^team\.[A-Za-z]+( [A-Za-z0-9_-]+( \([A-Za-z0-9_]+\))?)?$/.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => /^team\.removeMember m_/.test(line)));
});

test("an invite's code is printed once and is in no list, no log and no file; more room and each removal need a yes at the socket too", { skip }, async (t) => {
  const { botkins, client, changes, everything, asks, link } = await service(t);
  const made = await botkins(["team", "invite", "--json"]);
  assert.equal(made.exit, 0, made.err);
  const invite = made.json();
  const code = invite.code.replace("-", "");
  assert.match(invite.code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  assert.ok(invite.link.includes(code));
  assert.equal(invite.relay, false);
  assert.match((await botkins(["team", "invite"])).out, /The relay is off, so a typed code cannot find this computer by itself\./);

  // The code is held by the link (the window shows it); every command and call here leaves it out.
  assert.ok(JSON.stringify(link.team()).includes(code), "the link keeps the code");
  const seen = [];
  for (const argv of [["team", "show"], ["team", "show", "--json"], ["team", "invites", "list"], ["team", "invites", "list", "--json"], ["team", "groups", "list", "--json"], ["team", "members", "list", "--json"], ["team", "requests", "list", "--json"], ["status"], ["status", "--json"]]) {
    const run = await botkins(argv);
    seen.push(run.out + run.err);
  }
  seen.push(JSON.stringify(await client.call("team.get")), JSON.stringify(await client.call("team.invites")), JSON.stringify(await client.call("team.look", "revokeInvite", invite.id)));
  for (const text of seen) assert.ok(!text.includes(code) && !text.includes(invite.code) && !text.includes(invite.link), "the code is not shown again");
  // The app's own calls that carry it cannot be reached by their raw names: the commands cover them, and there is no `call`.
  for (const name of ["call", "team", "createTeamInvite", "snapshot"]) await assert.rejects(client.call(name, []), { code: "UNKNOWN_METHOD" }, name);
  // The log has the invite's id and nothing of the code, the link or the group's name.
  const lines = await changes();
  assert.deepEqual(lines.slice(0, 1), ["team.invite " + invite.id]);
  assert.ok(!everything().includes(code), "the code is in no log line and not in the workspace file");
  assert.ok(!(await client.call("logs.read", { tail: 400 })).entries.some((entry) => entry.text.includes(code)));

  // The socket's own call refuses what needs a yes unless it carries the mark.
  const team = (await botkins(["team", "show", "--json"])).json();
  const refusal = (promise, text) => assert.rejects(promise, { code: "NEEDS_YES", message: text });
  await refusal(client.call("team.saveRole", null, { name: "Wide", allow: ["all"], bots: "all" }), /^A role that has more rights or more bots gives its members more room\./);
  await client.call("team.saveRole", null, { name: "Plain" });
  assert.equal((await client.call("team.roles")).find((role) => role.name === "Plain").bots.length, 0, "a new role with nothing needs no mark");
  await refusal(client.call("team.saveGroup", "Everyone", { role: "Admin" }), /^A group that moves to a role with more rights gives its members more room\./);
  await refusal(client.call("team.revokeInvite", invite.id), /^Revoking an invite/);
  await refusal(client.call("team.removeRole", "Plain"), /^Removing the role Plain/);
  const request = asks(invite.id, "Kim's laptop", null);
  await refusal(client.call("team.approve", request), /^Approving a request lets this person into the team/);
  await refusal(client.call("team.deny", request), /^Denying a request needs a yes/);
  assert.equal((await client.call("team.requests")).length, 1, "nothing was approved or denied");
  assert.equal(team.members.length, 0);
  const member = (await client.call("team.approve", request, { agreed: true })).member;
  await refusal(client.call("team.removeMember", member.id), /^Removing a member/);
  assert.equal((await client.call("team.members")).length, 1, "the member stays without the mark");
  assert.equal((await client.call("team.removeMember", member.id, { agreed: true })).id, member.id);
  // With no terminal a command's question names its flag; with --json too.
  const needs = await botkins(["team", "members", "remove", "Kim", "--json"]);
  assert.equal(needs.exit, 1, "the member is gone now");
  const left = await botkins(["team", "invites", "revoke", invite.id, "--json"]);
  assert.equal(left.exit, 2);
  assert.match(left.err, /This needs a yes\. Run it again with --yes\./);
});

test("team members rename: a member is renamed by name or id, and the name is the member's everywhere, with no yes needed", { skip }, async (t) => {
  const { botkins, client, changes, asks, link } = await service(t);
  const invite = (await botkins(["team", "invite", "--uses", "5", "--json"])).json();
  const joined =(await client.call("team.approve", asks(invite.id, "Sam's phone", "Sam"), { agreed: true })).member;
  const other = (await client.call("team.approve", asks(invite.id, "Kim's laptop", "Kim"), { agreed: true })).member;

  // A rename changes nothing about access, so it asks nothing. The member is found by name, as the other member commands do.
  const done = await botkins(["team", "members", "rename", "sam", "Samantha", "Lee"]);
  assert.equal(done.exit, 0, done.err);
  assert.equal(done.out, "Sam is called Samantha Lee now.\n");
  const listed = (await botkins(["team", "members", "list", "--json"])).json();
  assert.deepEqual(listed.map((entry) => entry.name).sort(), ["Kim", "Samantha Lee"]);
  // The link's own records agree: the people list and the member's device (`devices set-person` shows the same name).
  assert.equal(link.team().people.find((person) => person.id === joined.id).name, "Samantha Lee");
  assert.equal(link.store.data.devices.find((device) => device.memberId === joined.id).person, "Samantha Lee");
  // A name with spaces is one word when quoted, and the id works too; --json answers the member.
  const quoted = await botkins(["team", "members", "rename", joined.id, "Sam L", "--json"]);
  assert.equal(quoted.exit, 0, quoted.err);
  assert.deepEqual([quoted.json().id, quoted.json().name], [joined.id, "Sam L"]);
  assert.match((await botkins(["team", "members", "rename", "Samantha", "Sam"])).err, /There is no member called Samantha\./);

  // Nothing to rename, no name, an empty name and a name that is too long are refused.
  assert.equal((await botkins(["team", "members", "rename"])).exit, 2);
  assert.equal((await botkins(["team", "members", "rename", "Kim"])).exit, 2);
  const blank = await botkins(["team", "members", "rename", "Kim", "   "]);
  assert.equal(blank.exit, 1);
  assert.match(blank.err, /Give the member a name of up to 60 characters\./);
  const long = await botkins(["team", "members", "rename", "Kim", "x".repeat(61)]);
  assert.equal(long.exit, 1);
  assert.match(long.err, /Give the member a name of up to 60 characters\./);
  await assert.rejects(client.call("team.renameMember", "Kim", ""), { code: "BAD_ARGUMENT" });
  await assert.rejects(client.call("team.renameMember", "Nobody", "Zed"), { code: "NOT_FOUND" });
  assert.equal((await client.call("team.members")).find((entry) => entry.id === other.id).name, "Kim", "a refusal changes nothing");

  // The log has the member's id, never the name.
  const lines = (await changes()).filter((line) => line.startsWith("team.renameMember"));
  assert.deepEqual(lines, ["team.renameMember " + joined.id, "team.renameMember " + joined.id]);
});
