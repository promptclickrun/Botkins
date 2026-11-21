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

function setup(overrides = {}, options = {}) {
  const ws = workspace();
  const flags = { fail: null, ...overrides };
  const { backend, refresh } = headlessBackend(async (method, args) => {
    if (flags.fail && (flags.only ?? method) === method) throw flags.fail;
    if (flags.answer) return flags.answer(method, args);
    return ws.dispatch(method, args);
  }, "test", options);
  return { ws, flags, backend, refresh };
}

test("a call that cannot reach the workspace drops the promise and keeps the other names; a refusal of the workspace does not", async () => {
  // Any code is a connection that did not happen or did not last, not only the first five.
  for (const code of ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EACCES", "ENOTCONN", "ECONNABORTED", "EAGAIN", "EHOSTUNREACH"]) {
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
  for (const message of ["This plugin is no longer installed.", "Unknown workspace call.", "Unknown workspace action", "Unknown workspace action. And more.", "connect ENOENT (said by the workspace)"]) {
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

test("an answer that is not JSON drops the promise, as the transport lets the reading error go on", async () => {
  // The same error that `jsonBody` in headless/transport.mjs lets out for a body that is not JSON.
  const reading = (text) => { try { JSON.parse(text); } catch (error) { return error; } };
  for (const error of [reading("<html>Bad Gateway</html>"), reading(""), new SyntaxError("Unexpected end of JSON input")]) {
    assert.ok(error instanceof SyntaxError);
    const { flags, backend, refresh } = setup();
    await refresh();
    let changes = 0;
    backend.subscribe(() => changes++);
    flags.fail = error;
    flags.only = "call";
    await assert.rejects(backend.call("send", ["c1", "Hi", {}], person), (caught) => caught === error);
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER]);
    assert.equal(changes, 1);
  }
});

test("a refusal \"Unknown workspace action.\" is the sign of an older workspace and drops the promise, and no other refusal does", async () => {
  const { ws, flags, backend, refresh } = setup();
  await refresh();
  let changes = 0;
  backend.subscribe(() => changes++);
  flags.fail = refused("Unknown workspace action.");
  flags.only = "call";
  await assert.rejects(backend.call("send", ["c1", "Hi", {}], person), (error) => error === flags.fail);
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER]);
  assert.equal(changes, 1);
  // The next look asks for a whole answer and brings the name back from a workspace that now says it.
  flags.fail = null;
  ws.seen.length = 0;
  await refresh();
  assert.equal(ws.seen.find(([method]) => method === "state")[1][0], null);
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
  // Also when it is another of the link's own requests that an older workspace does not know.
  flags.fail = refused("Unknown workspace action.");
  flags.only = "setLook";
  await assert.rejects(backend.setLook({}), /Unknown workspace action\./);
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER]);
  // Another refusal of the workspace leaves it alone.
  flags.fail = null;
  await refresh();
  flags.fail = refused("This chat is gone.");
  flags.only = "call";
  await assert.rejects(backend.call("send", ["c1", "Hi", {}], person), /This chat is gone\./);
  assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
});

test("a current workspace with no team cut or no spaces says \"Unknown workspace action.\" and keeps the promise", async () => {
  // The workspace of `workspace()` has neither a team cut nor spaces, so it refuses `team` and `spaces` with that very text.
  const team = () => ({ cut: { roles: [] }, rev: "rev-1" });
  // `team`: the link tells the cut at a look, and the workspace refuses it.
  {
    const { ws, backend, refresh } = setup({}, { team });
    await refresh();
    assert.ok(ws.seen.some(([method]) => method === "team"), "the cut was told, and refused");
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
    // It is not asked again, and the call that follows drops nothing and tells no phone.
    let changes = 0;
    backend.subscribe(() => changes++);
    assert.equal(await backend.call("send", ["c1", "Hi", {}], person), "ok");
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
    assert.equal(changes, 0, "phones are told nothing");
  }
  // The same when the team appears after a look and the call is the first to tell it.
  {
    let now = null;
    const { ws, backend, refresh } = setup({}, { team: () => now });
    await refresh();
    let changes = 0;
    backend.subscribe(() => changes++);
    now = team();
    ws.seen.length = 0;
    assert.equal(await backend.call("send", ["c1", "Hi", {}], person), "ok");
    assert.ok(ws.seen.some(([method]) => method === "team"));
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
    assert.equal(changes, 0);
  }
  // `spaces`.
  {
    const { ws, backend, refresh } = setup();
    await refresh();
    let changes = 0;
    backend.subscribe(() => changes++);
    ws.seen.length = 0;
    await assert.rejects(backend.spaces.ensure("m_avery"), /Unknown workspace action\./);
    assert.ok(ws.seen.some(([method]) => method === "spaces"));
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
    assert.equal(changes, 0);
    // Not asked again while it runs, and still nothing dropped.
    await assert.rejects(backend.spaces.snapshot("s1", {}), /doesn't support that yet/);
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER, PROMISE]);
  }
  // Any other action that says it is an older workspace, as before.
  for (const [only, run] of [["call", (backend) => backend.call("send", ["c1", "Hi", {}], person)], ["setLook", (backend) => backend.setLook({})]]) {
    const { backend, refresh } = setup({ fail: refused("Unknown workspace action."), only }, { team });
    await refresh();
    let changes = 0;
    backend.subscribe(() => changes++);
    await assert.rejects(run(backend), /Unknown workspace action\./);
    assert.deepEqual(backend.capabilities, ["models-v2", OWNER], only);
    assert.equal(changes, 1, only);
  }
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
  // `routineOwners` below is a COPY of the expression in `LinkHost.dispatch` (search `routineOwners` in
  // desktop/link/server.mjs). That is a method of a class that needs a whole server, and nothing exports
  // it, so this test does not follow a change there: change both together.
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
