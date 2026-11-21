// The two-container host: what the link's container tells the workspace's container about the
// team (desktop/headless/team-cut.mjs), and what the workspace does with it. The two halves are
// joined here by a real Unix socket, with a real workspace behind it. Names are invented.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceCall } from "../desktop/device-call.mjs";
import { callContext, headlessBackend } from "../desktop/headless/backend.mjs";
import { cutRevision, FRESH_MS, HeldCut, normalCut, teamCut, teamFromCut } from "../desktop/headless/team-cut.mjs";
import { listenWorkspace, workspaceRequest } from "../desktop/headless/transport.mjs";
import { workspaceActions } from "../desktop/headless/workspace.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { Workspace } from "./starter.mjs";

const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" && "The Docker host uses Unix sockets." }, fn);

/** A team as the link stores it, with the things a workspace must never be told. */
const stored = () => ({
  name: "Studio",
  roles: [
    { id: "r_maker", name: "Maker", perms: { agents: ["view", "chat"], skills: ["use"], mcp: ["use"], today: ["view", "use", "create", "manage", "delete"] }, bots: "all" },
    { id: "r_guest", name: "Guest", perms: { agents: ["view", "chat"], today: ["view"] }, bots: ["pip"] },
  ],
  groups: [{ id: "g_makers", name: "Makers", roleId: "r_maker" }, { id: "g_guests", name: "Guests", roleId: "r_guest" }],
  members: [
    { id: "m_avery", name: "Avery", groupId: "g_makers", joinedAt: 1, deviceIds: ["DEVICE-ID"], presenceKey: "PRESENCE-KEY", pushToken: "PUSH-TOKEN" },
    { id: "m_blake", name: "Blake", groupId: "g_guests", joinedAt: 2, deviceIds: [] },
  ],
  invites: [{ code: "INVITE-CODE", groupId: "g_makers" }],
  requests: [{ id: "q_1", publicKey: "REQUEST-KEY", name: "Casey's phone" }],
  chats: { "chat-1": ["m_avery"] },
  views: { m_avery: { bots: {}, order: [], chats: {}, spaces: { seen: { s_launch: 5 }, notify: {} } } },
  spaces: { s_launch: { access: "members", grants: [{ id: "m_blake", can: "view" }], teamCan: "view", share: { id: "LINK-ID", key: "LINK-KEY" } } },
  spaceCopies: [{ id: "COPY-ID" }],
  linkSharing: true,
});
const people = [{ id: "owner", name: "Sam" }, { id: "m_avery", name: "Avery" }, { id: "m_blake", name: "Blake" }];
const avery = { kind: "member", memberId: "m_avery", name: "Avery", groupId: "g_makers" };
const blake = { kind: "member", memberId: "m_blake", name: "Blake", groupId: "g_guests" };
const owner = { kind: "owner" };
const full = { member: false, skills: true, mcp: true, plugins: true };
const makers = { member: true, skills: true, mcp: true, plugins: false };
const narrowest = { member: true, skills: false, mcp: false, plugins: false };
const REFUSED = /The team as this computer's link sent it can't be read\. Update both Botkins containers\./;

test("the cut of a team holds the roles, the groups, the members and who shares what, and nothing else about a person", () => {
  const { cut, rev } = teamCut(stored(), people);
  assert.deepEqual(Object.keys(cut), ["v", "name", "roles", "groups", "members", "people", "chats", "spaces"]);
  assert.deepEqual(cut.members, [{ id: "m_avery", name: "Avery", groupId: "g_makers" }, { id: "m_blake", name: "Blake", groupId: "g_guests" }]);
  assert.deepEqual(cut.roles[1], { id: "r_maker", name: "Maker", perms: { agents: ["chat", "view"], mcp: ["use"], skills: ["use"], today: ["create", "delete", "manage", "use", "view"] }, bots: "all" });
  assert.deepEqual([cut.name, cut.groups.length, cut.people, cut.chats], ["Studio", 2, [{ id: "m_avery", name: "Avery" }, { id: "m_blake", name: "Blake" }, { id: "owner", name: "Sam" }], { "chat-1": ["m_avery"] }]);
  // A space's sharing is who may open it. The key of its public link is not in it.
  assert.deepEqual(cut.spaces, { s_launch: { access: "members", grants: [{ id: "m_blake", can: "view" }], teamCan: "view" } });
  const sent = JSON.stringify(cut);
  for (const secret of ["DEVICE-ID", "PRESENCE-KEY", "PUSH-TOKEN", "INVITE-CODE", "REQUEST-KEY", "LINK-ID", "LINK-KEY", "COPY-ID", "share", "deviceIds", "invites", "requests", "views", "joinedAt", "linkSharing", "Casey"]) assert.equal(sent.includes(secret), false, secret);
  // The same team gives the same revision, in whatever order the link keeps it. Another team gives another.
  const shuffled = stored();
  shuffled.roles.reverse();
  shuffled.members.reverse();
  assert.equal(teamCut(shuffled, [...people].reverse()).rev, rev);
  assert.match(rev, /^[A-Za-z0-9_-]{32}$/);
  const demoted = stored();
  demoted.members[0].groupId = "g_guests";
  assert.notEqual(teamCut(demoted, people).rev, rev);
  // A team with nothing in it is a cut too.
  assert.deepEqual(teamCut({}, []).cut, { v: 1, name: "", roles: [], groups: [], members: [], people: [], chats: {}, spaces: {} });
});

test("the workspace takes a cut whole or not at all, drops it when the link has another, and stops trusting one it has not heard of lately", () => {
  let clock = 1000;
  const held = new HeldCut({ now: () => clock });
  const { cut, rev } = teamCut(stored(), people);
  assert.equal(held.current(), null, "none at first");
  assert.equal(held.take(cut, rev), rev);
  assert.deepEqual(held.current(), cut);
  // The link names its revision with each call and each look: the same one keeps the cut in use.
  clock += FRESH_MS;
  assert.deepEqual(held.current(), cut);
  clock += 1;
  assert.equal(held.current(), null, "not heard of for longer than that: not trusted");
  assert.equal(held.heard(rev), rev);
  assert.deepEqual(held.current(), cut, "heard again: in use again");
  // Another revision, or none: what is held is old, and is dropped.
  for (const other of ["another-revision", null, undefined, 7, ""]) {
    held.take(cut, rev);
    assert.equal(held.heard(other), null, String(other));
    assert.equal(held.current(), null);
    assert.equal(held.heard(rev), null, "and it does not come back by its name alone");
  }
  // A cut that cannot be read is refused whole, with one sentence. What was held before goes too.
  const broken = [
    [cut, "not-its-revision"],
    [cut, ""],
    [cut, undefined],
    [null, rev],
    ["team", rev],
    [[cut], rev],
    [{ ...cut, v: 2 }, cutRevision({ ...cut, v: 2 })],
    [{ ...cut, share: { key: "x" } }, cutRevision({ ...cut, share: { key: "x" } })],
    [{ ...cut, members: [{ id: "m_avery", name: "Avery", groupId: "g_makers", deviceIds: ["d"] }] }, rev],
    [{ ...cut, members: [{ id: "", name: "Avery", groupId: "g_makers" }] }, rev],
    [{ ...cut, members: "all" }, rev],
    [{ ...cut, roles: [{ id: "r", name: "R", perms: { skills: "use" }, bots: "all" }] }, rev],
    [{ ...cut, roles: [{ id: "r", name: "R", perms: {}, bots: "every" }] }, rev],
    [{ ...cut, spaces: { s_launch: { access: "members", grants: [], teamCan: "view", share: { key: "LINK-KEY" } } } }, rev],
    [{ ...cut, spaces: { s_launch: { access: "everyone", grants: [], teamCan: "view" } } }, rev],
    [{ ...cut, chats: { "chat-1": "m_avery" } }, rev],
    [(({ people: _people, ...rest }) => rest)(cut), rev],
    [{ ...cut, name: "x".repeat(5 * 1024 * 1024) }, rev],
  ];
  for (const [value, revision] of broken) {
    held.take(cut, rev);
    assert.throws(() => held.take(value, revision), REFUSED, JSON.stringify(value)?.slice(0, 120));
    assert.deepEqual([held.current(), held.heard(rev)], [null, null], "none of it was taken");
  }
  // What is held is its own copy: the link's object changing afterwards changes nothing here.
  const mine = structuredClone(cut);
  held.take(mine, rev);
  mine.members.length = 0;
  assert.equal(held.current().members.length, 2);
  assert.throws(() => normalCut({ ...cut, extra: 1 }), /unknown team field/);
});

/**
 * The two containers: a real workspace that is told the team only through the socket, and the
 * link's side with the team as the link stores it. `turns` are the limits of each turn that a
 * `send` started, as the workspace worked them out when the call arrived.
 */
async function containers(t, { clock = { now: Date.now() } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bk-team-"));
  const socket = join(dir, "workspace.sock");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // `sent` counts the cuts that were sent and `revs` names them in order. `hold[method]` is a
  // promise that a request of that kind waits for before it goes on the socket (a slow moment).
  const link = { team: stored(), sent: 0, revs: [], logs: [], hold: {} };
  let ws;
  const startWorkspace = async () => {
    const held = new HeldCut({ now: () => clock.now });
    const told = teamFromCut(held, (chatId) => ws.state.chats.find((chat) => chat.id === chatId));
    ws = new Workspace(join(dir, "app"), fakeClient().client, () => {}, told);
    const turns = [];
    const handlers = {
      createChat: (...args) => ws.createChat(...args),
      send: (chatId, text, options = {}) => void turns.push(ws.accessForTurn(ws.chat(chatId), { author: options.author })),
    };
    const backend = {
      snapshot: () => ws.snapshot(),
      capabilities: [],
      subscribe: () => () => {},
      screen: { displays: async () => [{ id: "1", width: 1, height: 1 }] },
      call: deviceCall({ workspace: ws, handlers, folders: {} }),
      teamCut: held,
      spaces: { ensure: (person) => Object.keys(ws.spaces.ensure(person)), release: (person) => ws.spaces.memberRemoved(person), snapshot: (id) => ws.spaces.snapshot(id) },
    };
    const actions = workspaceActions(backend, () => {});
    const close = await listenWorkspace(socket, actions.dispatch);
    const stop = () => { close(); actions.unsubscribe(); };
    return { held, turns, stop, ws };
  };
  const startLink = () =>
    headlessBackend(
      async (method, args) => {
        if (link.hold[method]) await link.hold[method];
        if (method === "team") {
          link.sent++;
          link.revs.push(args[1]);
        }
        return workspaceRequest(socket, method, args);
      },
      "test",
      { team: () => teamCut(link.team, people), log: (line) => link.logs.push(line), clock: () => clock.now },
    );
  let workspace = await startWorkspace();
  let host = startLink();
  t.after(() => workspace.stop());
  const chats = {};
  /** A message from a person in their own chat. Answers the limits of the turn it started. */
  const turn = async (principal) => {
    const key = principal.memberId ?? "owner";
    chats[key] ??= await host.backend.call("createChat", ["pip"], { principal });
    await host.backend.call("send", [chats[key], "Hello", {}], { principal });
    return workspace.turns.at(-1);
  };
  return {
    dir, socket, link, clock, turn, chats,
    get ws() { return workspace.ws; },
    get held() { return workspace.held; },
    get backend() { return host.backend; },
    look: () => host.refresh(),
    async restartWorkspace() { workspace.stop(); workspace = await startWorkspace(); },
    restartLink() { host = startLink(); },
  };
}

test("a member's turn on the two-container host is held to the member's own role, as the link tells it", async (t) => {
  const host = await containers(t);
  // Nothing was told yet, and the first call tells it before it runs.
  assert.equal(host.held.current(), null);
  assert.deepEqual(await host.turn(avery), makers, "the role's own limits, not the narrowest and not the owner's");
  assert.deepEqual(await host.turn(blake), narrowest, "a role that allows none of them");
  assert.deepEqual(await host.turn(owner), full);
  assert.equal(host.link.sent, 1, "told once; the revision goes with every call after that");
  // A member's name, which bots their role shows them, and a chat's people come from the same cut.
  assert.deepEqual(host.ws.memberAuthor("m_avery"), { memberId: "m_avery", name: "Avery" });
  assert.deepEqual(["pip", "scout"].map((bot) => [host.ws.spaces.seesBot("m_avery", bot), host.ws.spaces.seesBot("m_blake", bot)]), [[true, true], [true, false]]);
  const shared = host.ws.createChat("pip");
  host.link.team.chats[shared] = ["m_avery"];
  await host.look();
  assert.deepEqual(host.ws.chatPeople(shared), { createdBy: "owner", invited: ["m_avery"] });
  assert.equal(host.link.sent, 2, "a change to the team is told with the next look");
});

test("a member who is moved to a smaller role, or removed, does not get one more turn under the old role", async (t) => {
  const host = await containers(t);
  assert.deepEqual(await host.turn(avery), makers);
  // Moved to the guests between two calls. No look happens in between: the call itself brings the news.
  host.link.team.members.find((member) => member.id === "m_avery").groupId = "g_guests";
  assert.deepEqual(await host.turn(avery), narrowest);
  // The role itself is cut down: the same.
  host.link.team.members.find((member) => member.id === "m_avery").groupId = "g_makers";
  assert.deepEqual(await host.turn(avery), makers);
  host.link.team.roles.find((role) => role.id === "r_maker").perms.skills = [];
  assert.deepEqual(await host.turn(avery), { member: true, skills: false, mcp: true, plugins: false });
  // Removed. (The link refuses a removed member's own calls. A message of theirs that is still on its way, or a routine they set, meets this.)
  host.link.team.members = host.link.team.members.filter((member) => member.id !== "m_avery");
  assert.deepEqual(await host.turn(owner), full);
  const theirs = host.ws.chat(host.chats.m_avery);
  assert.deepEqual(host.ws.accessForTurn(theirs, {}), narrowest, "a later turn in the chat they made");
  assert.deepEqual(host.ws.accessForTurn(host.ws.chat(host.chats.owner), { author: { memberId: "m_avery", name: "Avery" } }), narrowest);
});

test("a workspace that started again, a link that started again, and a call with an old revision", async (t) => {
  const host = await containers(t);
  assert.deepEqual(await host.turn(avery), makers);
  const rev = teamCut(host.link.team, people).rev;

  // The workspace starts again and holds nothing. The link does not know yet: its next call names
  // a revision the workspace does not hold, so that turn gets the narrowest limits.
  await host.restartWorkspace();
  assert.equal(host.held.current(), null);
  assert.deepEqual(await host.turn(avery), narrowest);
  // The link looks after each call, hears that the workspace holds none, and tells it. Then the role applies again.
  assert.deepEqual(host.held.current(), teamCut(host.link.team, people).cut);
  assert.deepEqual(await host.turn(avery), makers);

  // The link starts again. The team is the same, so is its revision, and the workspace still holds it: nothing is sent twice.
  const sent = host.link.sent;
  host.restartLink();
  await host.look();
  assert.deepEqual(await host.turn(avery), makers);
  assert.equal(host.link.sent, sent);

  // A call that names an old revision, written straight on the socket: the workspace drops what
  // it holds before the call runs, and says in its next answer that it holds none.
  const before = host.ws.chat(host.chats.m_avery).messages.length;
  await workspaceRequest(host.socket, "call", ["send", [host.chats.m_avery, "Hello", {}], { principal: avery }, "an-old-revision"]);
  assert.equal(host.held.current(), null);
  assert.equal((await workspaceRequest(host.socket, "state", [null, rev])).team, null);
  assert.deepEqual(host.ws.accessForTurn(host.ws.chat(host.chats.m_avery), { author: { memberId: "m_avery", name: "Avery" } }), narrowest);
  assert.equal(host.ws.chat(host.chats.m_avery).messages.length, before);
  // A call with no revision at all (a link container from before this): the same.
  await host.look();
  assert.deepEqual(await host.turn(avery), makers);
  await workspaceRequest(host.socket, "call", ["send", [host.chats.m_avery, "Hello", {}], { principal: avery }]);
  assert.equal(host.held.current(), null);

  // The link goes quiet (its container stopped). After a while the workspace no longer trusts what it was told.
  await host.look();
  assert.deepEqual(host.ws.accessForTurn(host.ws.chat(host.chats.m_avery), {}), makers);
  host.clock.now += FRESH_MS + 1;
  assert.deepEqual(host.ws.accessForTurn(host.ws.chat(host.chats.m_avery), {}), narrowest);
  assert.deepEqual(host.ws.accessForTurn(host.ws.chat(host.chats.m_avery), { author: undefined }), narrowest);
});

test("the socket takes a cut that can be read and no other, answers nothing about the team, and writes none of it to disk", async (t) => {
  const host = await containers(t);
  const { cut, rev } = teamCut(host.link.team, people);
  assert.equal(await workspaceRequest(host.socket, "team", [cut, rev]), rev, "the answer is the revision that was taken, nothing more");
  for (const sent of [[cut, "not-its-revision"], [{ ...cut, share: { key: "LINK-KEY" } }, rev], [null, rev], [cut], []]) {
    await workspaceRequest(host.socket, "team", [cut, rev]);
    await assert.rejects(workspaceRequest(host.socket, "team", sent), REFUSED, JSON.stringify(sent).slice(0, 100));
    assert.equal(host.held.current(), null, "none of it was taken, and what was held before went");
  }
  // In memory only: after turns, a chat and a save, no file of the workspace names a role, a group or who shares a space.
  await host.turn(avery);
  await host.turn(blake);
  host.ws.save();
  const files = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!path.endsWith(".sock")) files.push(path);
    }
  };
  walk(host.dir);
  assert.ok(files.some((path) => path.endsWith("workspace.json")));
  for (const path of files) for (const word of ["r_maker", "g_makers", "Makers", "Guests", "\"grants\"", "\"perms\""]) assert.equal(readFileSync(path, "utf8").includes(word), false, word + " in " + path);
  // The link's own half of Spaces goes through too, by three names and no other.
  assert.deepEqual(await workspaceRequest(host.socket, "spaces", ["ensure", "m_avery"]), ["today", "feed", "ideas", "goals"]);
  for (const name of ["remove", "create", "constructor", "__proto__", ""]) await assert.rejects(workspaceRequest(host.socket, "spaces", [name, "m_avery"]), /Unknown workspace action/);
});

test("a space on the two-container host opens for the people the link says, and for nobody when the workspace was told nothing", async (t) => {
  const host = await containers(t);
  await host.turn(owner);
  const launch = host.ws.spaces.create({ name: "Launch" }, "owner");
  const record = host.ws.spaces.get(launch);
  host.link.team.spaces = { [launch]: { access: "members", grants: [{ id: "m_blake", can: "view" }], teamCan: "view", share: { id: "LINK-ID", key: "LINK-KEY" } } };
  await host.look();
  const can = () => ["owner", "m_avery", "m_blake", "m_nobody"].map((person) => host.ws.spaces.can(record, person));
  assert.deepEqual(can(), ["own", null, "view", null]);
  // Shared with all members to change.
  host.link.team.spaces[launch] = { access: "team", grants: [], teamCan: "edit" };
  await host.look();
  assert.deepEqual(can(), ["own", "edit", "edit", null], "someone who is not on the team opens nothing");
  // A member's own space is theirs, and is the owner's too.
  const averys = host.ws.spaces.create({ name: "Avery's" }, "m_avery");
  assert.deepEqual(["owner", "m_avery", "m_blake"].map((person) => host.ws.spaces.can(host.ws.spaces.get(averys), person)), ["own", "own", null]);
  // Told nothing (the link went quiet): only the owner opens a space. A member opens none, not their own either.
  host.clock.now += FRESH_MS + 1;
  assert.deepEqual(can(), ["own", null, null, null]);
  assert.equal(host.ws.spaces.can(host.ws.spaces.get(averys), "m_avery"), null);
  // A member who left the team opens nothing, also what they made, until the link's `release` passes it to the owner.
  await host.look();
  host.link.team.members = host.link.team.members.filter((member) => member.id !== "m_avery");
  await host.look();
  assert.equal(host.ws.spaces.can(host.ws.spaces.get(averys), "m_avery"), null);
});

test("a workspace from before this takes no cut: the link stops asking, calls still work, and a member gets the narrowest limits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-old-"));
  const socket = join(dir, "workspace.sock");
  const ws = new Workspace(join(dir, "app"), fakeClient().client, () => {});
  const turns = [];
  const handlers = { createChat: (...args) => ws.createChat(...args), send: (chatId, text, options = {}) => void turns.push(ws.accessForTurn(ws.chat(chatId), { author: options.author })) };
  // No `teamCut` on this backend: the workspace's side has nothing to take a cut with.
  const actions = workspaceActions({ snapshot: () => ws.snapshot(), capabilities: [], subscribe: () => () => {}, screen: { displays: async () => [] }, call: deviceCall({ workspace: ws, handlers, folders: {} }) }, () => {});
  const close = await listenWorkspace(socket, actions.dispatch);
  t.after(() => { close(); actions.unsubscribe(); rmSync(dir, { recursive: true, force: true }); });
  let sent = 0;
  const { backend, refresh } = headlessBackend((method, args) => (method === "team" && sent++, workspaceRequest(socket, method, args)), "test", { team: () => teamCut(stored(), people) });
  await refresh();
  const chat = await backend.call("createChat", ["pip"], { principal: avery });
  await backend.call("send", [chat, "Hello", {}], { principal: avery });
  await refresh();
  await refresh();
  assert.deepEqual(turns, [narrowest]);
  assert.equal(sent, 1, "asked once, and not again while that workspace runs");
});

/** A wait that the test ends when it chooses. */
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};
const demote = (host) => void (host.link.team.members.find((member) => member.id === "m_avery").groupId = "g_guests");

test("an old cut is never sent after a newer one: a look that was slow does not bring a removed role back", async (t) => {
  const host = await containers(t);
  assert.deepEqual(await host.turn(avery), makers);
  const before = teamCut(host.link.team, people).rev;
  // A look starts and names the revision of that moment. It is slow to reach the workspace.
  const slow = gate();
  host.link.hold.state = slow.promise;
  const looking = host.look();
  await new Promise((resolve) => setImmediate(resolve));
  // Meanwhile the member is moved to a smaller role, and a message of theirs arrives: it brings the new cut with it.
  demote(host);
  const after = teamCut(host.link.team, people).rev;
  host.link.hold.state = null;
  const chat = host.chats.m_avery;
  // (The look that follows each call joins the slow one, so the call is not waited for here.)
  const sending = host.backend.call("send", [chat, "Hello", {}], { principal: avery });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(host.ws.accessForTurn(host.ws.chat(chat), { author: { memberId: "m_avery", name: "Avery" } }), narrowest, "the turn of that message is under the new role");
  // Now the slow look arrives, with the old revision. The workspace drops what it holds; it is not given the old cut again.
  slow.open();
  await looking;
  await sending;
  await host.look();
  assert.equal(host.link.revs.lastIndexOf(before) < host.link.revs.indexOf(after), true, "the old cut was not sent after the new one: " + host.link.revs.map((rev) => (rev === before ? "old" : "new")).join(", "));
  assert.deepEqual(host.held.current(), teamCut(host.link.team, people).cut);
  assert.deepEqual(await host.turn(avery), narrowest);
});

test("an old cut is never sent after a newer one: a cut that was on its way when the team changed is followed by the new one", async (t) => {
  const host = await containers(t);
  const before = teamCut(host.link.team, people).rev;
  // The first cut is on its way, and slow.
  const slow = gate();
  host.link.hold.team = slow.promise;
  const first = host.backend.call("createChat", ["pip"], { principal: avery });
  await new Promise((resolve) => setImmediate(resolve));
  // The team changes, and a message arrives. It waits for the cut that is on its way, reads the team again, and sends the new cut before it runs.
  demote(host);
  host.link.team.roles.find((role) => role.id === "r_guest").perms.skills = ["use"];
  const after = teamCut(host.link.team, people).rev;
  const owners = host.backend.call("createChat", ["pip"], { principal: owner });
  await new Promise((resolve) => setImmediate(resolve));
  host.link.hold.team = null;
  slow.open();
  host.chats.m_avery = await first;
  await owners;
  assert.deepEqual(host.link.revs.filter((rev, at, all) => rev !== all[at - 1]), [before, after]);
  // The member's turn has the role of now (the guests' role, which allows skills here), not the makers' of before.
  assert.deepEqual(await host.turn(avery), { member: true, skills: true, mcp: false, plugins: false });
});

test("a team that cannot be cut stops no call: the owner goes on, a member gets the narrowest limits, and the log says why once", async (t) => {
  const host = await containers(t);
  assert.deepEqual(await host.turn(avery), makers);
  // An id past its limit: there is no cut of this team.
  host.link.team.groups.push({ id: "g_" + "x".repeat(300), name: "Too long", roleId: "r_guest" });
  assert.throws(() => teamCut(host.link.team, people), /bad group id/);
  assert.deepEqual(await host.turn(owner), full);
  assert.deepEqual(await host.turn(avery), narrowest);
  await host.look();
  await host.look();
  assert.equal(host.held.current(), null);
  assert.deepEqual(host.link.logs.length, 1);
  assert.match(host.link.logs[0], /told nothing about the team \(bad group id\)\. Team members get the narrowest limits/);
  // Put right: the role applies again.
  host.link.team.groups.pop();
  assert.deepEqual(await host.turn(avery), makers);
});

test("no member is called owner, and ids that are also names of an object's own parts are only ids", async (t) => {
  // A member with the owner's id is refused on both ways in: in a cut, and as the person of a call.
  const { cut } = teamCut(stored(), people);
  assert.throws(() => normalCut({ ...cut, members: [{ id: "owner", name: "Mallory", groupId: "g_makers" }] }), /bad member id/);
  assert.throws(() => new HeldCut().take({ ...cut, members: [{ id: "owner", name: "Mallory", groupId: "g_makers" }] }, cutRevision(cut)), REFUSED);
  assert.throws(() => callContext({ principal: { kind: "member", memberId: "owner", name: "Mallory" } }), /not the same version/);
  assert.deepEqual(callContext({ principal: { kind: "owner" } }), { principal: { kind: "owner" } });
  // `__proto__`, `constructor` and the like as a chat's, a space's, a role's or a member's id.
  const odd = stored();
  odd.chats = JSON.parse('{"__proto__":["m_avery"],"constructor":["m_blake"],"chat-1":["m_avery"]}');
  odd.spaces = JSON.parse('{"__proto__":{"access":"team","grants":[],"teamCan":"edit"},"toString":{"access":"members","grants":[{"id":"constructor","can":"edit"}],"teamCan":"view"}}');
  odd.members.push({ id: "constructor", name: "Connie", groupId: "__proto__" });
  odd.groups.push({ id: "__proto__", name: "Odd", roleId: "hasOwnProperty" });
  odd.roles.push({ id: "hasOwnProperty", name: "Odd", perms: JSON.parse('{"__proto__":["use"],"skills":["use"]}'), bots: ["__proto__"] });
  const told = teamCut(odd, people);
  // As it crosses the socket, as text.
  const held = new HeldCut();
  assert.equal(held.take(JSON.parse(JSON.stringify(told.cut)), told.rev), told.rev);
  const rules = teamFromCut(held, (id) => ({ id }));
  assert.deepEqual(rules.people("__proto__"), { createdBy: "owner", invited: ["m_avery"] });
  assert.deepEqual(rules.people("constructor"), { createdBy: "owner", invited: ["m_blake"] });
  assert.deepEqual(rules.people("valueOf"), { createdBy: "owner", invited: [] }, "a chat the cut does not name has its creator only");
  assert.deepEqual(["__proto__", "toString", "valueOf", "hasOwnProperty"].map((id) => rules.spaceCan({ id }, "m_avery")), ["edit", null, null, null]);
  assert.equal(rules.spaceCan({ id: "toString" }, "constructor"), "edit");
  assert.equal(rules.spaceCan({ id: "toString" }, "toString"), null, "someone who is not a member");
  // Nothing of it reached what every object shares.
  assert.deepEqual([{}.polluted, Object.keys(Object.prototype), typeof {}.constructor, typeof {}.toString], [undefined, [], "function", "function"]);
  // The 15 seconds are counted on a clock that only goes forward, not on the time of day.
  assert.ok(Math.abs(new HeldCut().now() - Date.now()) > 1e9);
});

test("a member who was removed while the workspace could not be reached is said again until it is heard", async (t) => {
  const host = await containers(t);
  await host.turn(avery);
  const theirs = host.ws.spaces.create({ name: "Avery's" }, "m_avery");
  host.ws.save();
  // The workspace is down when the member is removed: the link's call fails.
  await host.restartWorkspace();
  const down = gate();
  host.link.hold.spaces = Promise.reject(new Error("The workspace can't be reached.")).catch((error) => down.promise.then(() => { throw error; }));
  const released = host.backend.spaces.release("m_avery");
  down.open();
  await assert.rejects(released, /can't be reached/);
  assert.equal(host.ws.spaces.get(theirs).createdBy, "m_avery");
  // It is back at the next look: what the member made passes to the owner then.
  host.link.hold.spaces = null;
  await host.look();
  assert.equal(host.ws.spaces.get(theirs).createdBy, undefined);
  // Said once more it changes nothing, and it is not said for ever.
  let asked = 0;
  host.link.hold.spaces = { then: (go) => (asked++, go()) };
  await host.look();
  await host.look();
  assert.equal(asked, 0);
});

test("a workspace that refuses the cut, or knows nothing of spaces, is not asked again at every look", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-refuse-"));
  const socket = join(dir, "workspace.sock");
  // A workspace that refuses every cut (as for one it cannot read), and that is from before spaces.
  const actions = workspaceActions({ snapshot: () => ({}), capabilities: [], subscribe: () => () => {}, screen: { displays: async () => [] }, call: async () => "ok", teamCut: { take: () => { throw new Error("The team as this computer's link sent it can't be read."); }, heard: () => null } }, () => {});
  const close = await listenWorkspace(socket, actions.dispatch);
  t.after(() => { close(); actions.unsubscribe(); rmSync(dir, { recursive: true, force: true }); });
  const sent = { team: 0, spaces: 0 };
  let now = 0;
  const { backend, refresh } = headlessBackend((method, args) => (method in sent && sent[method]++, workspaceRequest(socket, method, args)), "test", { team: () => teamCut(stored(), people), clock: () => now, log: () => {} });
  await refresh();
  assert.equal(sent.team, 1);
  for (let looks = 0; looks < 5; looks++) await refresh();
  assert.equal(await backend.call("renameChat", ["c", "x"], { principal: owner }), "ok", "calls go on");
  assert.equal(sent.team, 1, "not again at once");
  // Later each time: after 1.5 seconds, then 3, then 6, and never less often than once a minute.
  const again = [];
  for (const wait of [1499, 2, 2999, 2, 5999, 2]) {
    now += wait;
    await refresh();
    again.push(sent.team);
  }
  assert.deepEqual(again, [1, 2, 2, 3, 3, 4]);
  now += 10 * 60_000;
  await refresh();
  now += 60_001;
  await refresh();
  assert.equal(sent.team, 6);
  // The app's half of Spaces: asked once, then answered here without a request.
  for (let times = 0; times < 4; times++) await assert.rejects(backend.spaces.ensure("m_avery"));
  await assert.rejects(backend.spaces.snapshot("s_1"));
  assert.equal(sent.spaces, 1);
});
