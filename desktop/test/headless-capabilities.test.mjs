import { test } from "node:test";
import assert from "node:assert/strict";
import { headlessBackend, PROMISES } from "../desktop/headless/backend.mjs";
import { authorize, BUILTIN_ROLES, EVERYONE_GROUP } from "../desktop/link/index.mjs";
import { workspaceActions } from "../desktop/headless/workspace.mjs";

const PROMISE = "plugin-starts-v1";
const OWNER = "routine-owner-v1";

// A workspace that answers `state` the way the real one does, with a list of capabilities, and `call` as told.
function workspace(capabilities = ["models-v2", OWNER, PROMISE], version = "epoch-a/1") {
  const seen = [];
  const state = { bots: [], chats: [], runs: [], settings: {} };
  const actions = workspaceActions({ snapshot: () => state, capabilities, subscribe: () => () => {}, call: async () => "ok", screen: { displays: async () => [{ id: "1", width: 10, height: 10 }] } }, () => {});
  return { seen, dispatch: (method, args) => { seen.push([method, args]); return actions.dispatch(method, args); } };
}
const refused = (message) => Object.assign(new Error(message), {});
const failure = (code) => Object.assign(new Error("connect " + code), { code });
const person = { principal: { kind: "owner" } };

function setup(overrides = {}) {
  const ws = workspace();
  const flags = { fail: null, ...overrides };
  const { backend, refresh } = headlessBackend(async (method, args) => {
    if (flags.fail && (flags.only ?? method) === method) throw flags.fail;
    if (flags.answer) return flags.answer(method, args);
    return ws.dispatch(method, args);
  }, "test");
  return { ws, flags, backend, refresh };
}

test("a call that cannot reach the workspace drops the promise and keeps the other names; a refusal of the workspace does not", async () => {
  for (const code of ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"]) {
    const { flags, backend, refresh } = setup();
    await refresh();
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
    let changes = 0;
    backend.subscribe(() => changes++);
    flags.fail = failure(code);
    flags.only = "call";
    await assert.rejects(backend.call("send", ["c1", "Hi", {}], person), (error) => error === flags.fail, code);
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER], code);
    assert.equal(changes, 1, "phones are told once");
    await assert.rejects(backend.call("send", ["c1", "Hi", {}], person));
    assert.equal(changes, 1, "nothing more to drop, nothing more told");
  }
  // The timer of the socket client has no code: its message is the one that counts.
  {
    const { flags, backend, refresh } = setup();
    await refresh();
    flags.fail = new Error("The workspace did not answer.");
    flags.only = "call";
    await assert.rejects(backend.call("send", ["c1", "Hi", {}], person), /did not answer/);
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER]);
  }
  // The workspace answered with an error of its own: it is there, so its promise stands.
  for (const message of ["This plugin is no longer installed.", "Unknown workspace call.", "connect ENOENT (said by the workspace)"]) {
    const { flags, backend, refresh } = setup();
    await refresh();
    let changes = 0;
    backend.subscribe(() => changes++);
    flags.fail = refused(message);
    flags.only = "call";
    await assert.rejects(backend.call("send", ["c1", "Hi", {}], person), (error) => error.message === message);
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE], message);
    assert.equal(changes, 0);
  }
  assert.deepEqual(PROMISES, [PROMISE]);
});

test("the promise comes back only with an answer that carries the whole list, also after a failed call", async () => {
  const { ws, flags, backend, refresh } = setup();
  await refresh();
  flags.fail = failure("ECONNRESET");
  flags.only = "call";
  await assert.rejects(backend.call("send", ["c1", "Hi", {}], person));
  flags.fail = null;
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER]);
  // The next look asks with no known version, so the same epoch still sends its list.
  ws.seen.length = 0;
  await refresh();
  assert.equal(ws.seen.find(([method]) => method === "state")[1][0], null);
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
  // A workspace that answers without the name (put back from an older image) does not get it.
  flags.fail = failure("ECONNRESET");
  await assert.rejects(backend.call("send", ["c1", "Hi", {}], person));
  flags.fail = null;
  flags.answer = (method, args) => (method === "state" ? { version: "epoch-a/1", display: true, team: null, snapshot: { bots: [], chats: [], runs: [], settings: {} }, capabilities: ["models-v2", OWNER] } : null);
  await refresh();
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER]);
  // A new start that says nothing of capabilities gives an empty list.
  flags.answer = (method) => (method === "state" ? { version: "epoch-b/1", display: true, team: null } : null);
  await refresh();
  assert.deepEqual(backend.capabilities, []);
});

test("a look asked before a failed call cannot bring the promise back", async () => {
  const ws = workspace();
  let hold;
  const held = new Promise((resolve) => { hold = resolve; });
  let stall = false;
  let failCall = false;
  const { backend, refresh } = headlessBackend(async (method, args) => {
    if (method === "state" && stall) {
      const answer = await ws.dispatch(method, args);
      await held;
      return answer;
    }
    if (method === "call" && failCall) throw failure("ECONNRESET");
    return ws.dispatch(method, args);
  }, "test");
  await refresh();
  // One call fails, so the next look asks for the whole list. That look is on its way when another call fails.
  failCall = true;
  await assert.rejects(backend.call("send", ["c1", "Hi", {}], person));
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER]);
  stall = true;
  const looking = refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(backend.call("send", ["c1", "Hi", {}], person));
  hold();
  await looking;
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER], "that answer is from before the drop");
  stall = false;
  failCall = false;
  await refresh();
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
});

test("the team rule on routines survives a failed look and a failed call", async () => {
  const { flags, backend, refresh } = setup();
  await refresh();
  // What the link's own code does (desktop/link/server.mjs, `dispatch`): the member's call is held to
  // the routine's maker while the app's list has the name.
  const team = { ...{ roles: BUILTIN_ROLES.map((role) => ({ ...role, perms: { ...role.perms } })), groups: [EVERYONE_GROUP] }, members: [{ id: "m_avery", groupId: "g_everyone" }] };
  team.roles = team.roles.map((role) => (role.id === "r_guest" ? { ...role, perms: { ...role.perms, today: ["view", "use", "create", "manage", "delete"] }, bots: "all" } : role));
  const state = { bots: [{ id: "pip" }], chats: [{ id: "routine-1", botId: "pip", createdBy: "m_someone_else" }] };
  const member = { kind: "member", memberId: "m_avery", groupId: "g_everyone" };
  const decide = () => authorize(member, team, "deleteRoutine", ["routine-1"], {
    bot: (id) => state.bots.find((bot) => bot.id === id),
    chat: (id) => state.chats.find((chat) => chat.id === id),
    routineOwners: Array.isArray(backend.capabilities) && backend.capabilities.includes(OWNER),
  });
  assert.match(decide(), /belongs to the owner or another member/);
  // The look fails: the promise goes, the rule stays.
  flags.fail = failure("ECONNREFUSED");
  await refresh();
  assert.equal(backend.capabilities.includes(PROMISE), false);
  assert.ok(backend.capabilities.includes(OWNER));
  assert.match(decide(), /belongs to the owner or another member/);
  // The call fails: the same.
  flags.fail = null;
  await refresh();
  flags.fail = failure("EPIPE");
  flags.only = "call";
  await assert.rejects(backend.call("send", ["c1", "Hi", {}], person));
  assert.ok(backend.capabilities.includes(OWNER));
  assert.match(decide(), /belongs to the owner or another member/);
});
