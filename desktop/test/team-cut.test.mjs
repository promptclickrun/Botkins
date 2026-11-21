// The two-container host: what the link's container tells the workspace's container about the
// team (desktop/headless/team-cut.mjs), and what the workspace does with it. The two halves are
// joined here by a real Unix socket, with a real workspace behind it. Names are invented.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceCall } from "../desktop/device-call.mjs";
import { headlessBackend } from "../desktop/headless/backend.mjs";
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
  const link = { team: stored(), sent: 0 };
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
      (method, args) => {
        if (method === "team") link.sent++;
        return workspaceRequest(socket, method, args);
      },
      "test",
      { team: () => teamCut(link.team, people) },
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
