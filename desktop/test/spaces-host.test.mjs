// Spaces on the host (desktop/spaces.mjs, panels.mjs, board.mjs; the contract is docs/spaces.md):
// the records and the move of what was there, a panel found by its bot, its space and its key,
// what a bot's tools see and change for the people a turn works for, whose limits a refresh runs
// under, and an app panel's saved state and notes.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { starterBots, Workspace } from "./starter.mjs";
import { framePage } from "../desktop/frames.mjs";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { linkCapabilities, SPACE_CALLS } from "../desktop/runtime.mjs";
import { LIMITS, migrateSpaces } from "../desktop/spaces.mjs";

// A team of two members: Avery may do everything with spaces, Blake may only look.
const perms = (today) => ({ agents: ["view", "chat"], today, skills: ["read"], mcp: ["view"], plugins: ["view"], settings: [] });
const team = {
  name: "Northstar",
  roles: [
    { id: "r_maker", name: "Maker", perms: perms(["view", "use", "create", "manage", "delete"]), bots: "all" },
    { id: "r_guest", name: "Guest", perms: perms(["view"]), bots: "all" },
    // Dana may do everything with spaces, with one bot only.
    { id: "r_pip", name: "Pip only", perms: perms(["view", "use", "create", "manage", "delete"]), bots: ["pip"] },
  ],
  groups: [{ id: "g_makers", name: "Makers", roleId: "r_maker" }, { id: "g_guests", name: "Guests", roleId: "r_guest" }, { id: "g_pip", name: "Pip only", roleId: "r_pip" }],
  members: [
    { id: "m_avery", name: "Avery", groupId: "g_makers", joinedAt: 1, deviceIds: [] },
    { id: "m_blake", name: "Blake", groupId: "g_guests", joinedAt: 2, deviceIds: [] },
    { id: "m_casey", name: "Casey", groupId: "g_makers", joinedAt: 3, deviceIds: [] },
    { id: "m_dana", name: "Dana", groupId: "g_pip", joinedAt: 4, deviceIds: [] },
  ],
  people: [{ id: "owner", name: "Sam" }, { id: "m_avery", name: "Avery" }, { id: "m_blake", name: "Blake" }, { id: "m_casey", name: "Casey" }, { id: "m_dana", name: "Dana" }],
};
const avery = { memberId: "m_avery", name: "Avery" };
const blake = { memberId: "m_blake", name: "Blake" };
const blocks = [{ type: "markdown", text: "Hello" }];

/**
 * A workspace whose bots do, in each turn, what the test hands in: `turn(chatId, script, author)`
 * sends a message and runs `script(tool)` as the bot, where `tool(name, args)` calls one of the
 * turn's tools and answers what it answered. `shared` says what the link would: who else may
 * open a space ({ [spaceId]: { [person]: "view" | "edit" } }).
 */
function setup(t, { shared = {} } = {}) {
  let script = async () => {};
  let broke = null;
  const fake = fakeClient(async (_id, _options, session) => {
    const tool = async (name, args = {}) => {
      const out = await session.tool(name, args);
      return typeof out === "string" ? JSON.parse(out) : out;
    };
    tool.names = session.toolNames();
    // What goes wrong in a script (a failed check, a tool that refused when it should not) is the test's to hear, not the bot's.
    await script(tool).catch((error) => void (broke = error));
    return { data: { content: "done" } };
  }, {
    // The stand-in knows the one command that the app sends by itself, and hands it on to the bot as the skill's prompt.
    rpc: (id, log) => ({
      model: { switchTo: async (params) => (log.models.push([id, params.modelId, params.reasoningEffort]), {}) },
      permissions: { setMode: async ({ mode }) => (log.modes.push([id, mode]), { success: true, mode }) },
      skills: { ensureLoaded: async () => {}, list: async () => ({ skills: [{ name: "today-panel", enabled: true, userInvocable: true, source: "Botkins", description: "A panel" }] }) },
      commands: { list: async () => ({ commands: [{ name: "today-panel", kind: "skill" }] }), invoke: async ({ name, input }) => ({ kind: "agent-prompt", prompt: "Use the skill " + name + ": " + input }) },
    }),
  });
  const dir = tempDir(t);
  const spaceCan = (space, person) => (person === "owner" || (space.createdBy ?? "owner") === person ? "own" : (shared[space.id]?.[person] ?? null));
  const events = [];
  const open = () => new Workspace(dir, fake.client, () => {}, { team: () => team, spaceCan, spaceEvent: (event) => void events.push(event) });
  const ws = open();
  const turn = async (chatId, run, author) => {
    script = run;
    broke = null;
    await ws.send(chatId, "do it", author ? { author } : {});
    script = async () => {};
    if (broke) throw broke;
  };
  /** Does `action`, which starts a turn in a chat by itself (a call from the app), with the bot doing `run` in that turn. Answers what the action answered, once the turn is over. */
  const during = async (run, action) => {
    script = run;
    broke = null;
    const before = fake.log.sent.length;
    const answer = action();
    for (let waited = 0; fake.log.sent.length === before || ws.active.has(answer.chatId); waited++) {
      if (waited > 5000) throw new Error("The turn did not start, or did not end.");
      await new Promise((done) => setImmediate(done));
    }
    script = async () => {};
    if (broke) throw broke;
    return answer;
  };
  /** A chat with a bot, started by a person. */
  const chat = (botId, person) => {
    const id = ws.createChat(botId);
    if (person && person !== "owner") ws.chat(id).createdBy = person;
    return id;
  };
  return { dir, ws, open, turn, during, chat, fake, shared, events };
}
const failure = async (promise) => promise.then(() => null, (error) => error.message);

test("what was on the one Today page moves to the owner's spaces, once, and every person has the four built-in ones", (t) => {
  // A workspace from before spaces: two panels, three cards, nothing that names a space.
  const dir = tempDir(t);
  const old = {
    bots: starterBots,
    chats: [],
    runs: [],
    panels: [{ id: "p1", key: "one", botId: "pip", title: "One", blocks, size: "wide", hidden: false, revision: 1, routine: null }, { id: "p2", key: "two", botId: "scout", title: "Two", blocks, size: "small", hidden: true, revision: 3, routine: null }],
    board: [{ id: "c1", botId: "pip", kind: "feed", title: "News", body: "", links: [], status: "open" }, { id: "c2", botId: "pip", kind: "idea", title: "Try it", body: "", links: [], status: "open" }, { id: "c3", botId: "scout", kind: "goal", title: "Ship", body: "", links: [], status: "done" }],
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(old));
  const ws = new Workspace(dir, fakeClient().client, () => {});
  const mine = ws.spaces.ensure("owner");
  assert.deepEqual(ws.state.spaces.map((space) => [space.name, space.builtin, space.createdBy]), [["Today", "today", undefined], ["Feed", "feed", undefined], ["Ideas", "ideas", undefined], ["Goals", "goals", undefined]]);
  for (const space of ws.state.spaces) assert.match(space.id, /^s_[a-z2-7]{10}$/);
  assert.deepEqual(ws.state.panels.map((panel) => panel.spaceId), [mine.today.id, mine.today.id], "every panel is in the owner's Today, hidden ones too");
  assert.deepEqual(ws.state.board.map((card) => [card.id, card.spaceId]), [["c1", mine.feed.id], ["c2", mine.ideas.id], ["c3", mine.goals.id]]);
  assert.deepEqual([ws.state.panels[1].hidden, ws.state.panels[1].revision, ws.state.panels[1].size], [true, 3, "small"], "nothing else about a panel changed");
  // Opening it again changes nothing: the same spaces, the same places.
  const before = JSON.stringify(ws.state.spaces.map((space) => space.id));
  const again = new Workspace(dir, fakeClient().client, () => {});
  assert.equal(JSON.stringify(again.state.spaces.map((space) => space.id)), before);
  assert.deepEqual(again.state.panels.map((panel) => panel.spaceId), [mine.today.id, mine.today.id]);
  // A member's four are made when asked for, are theirs, and asking again makes no more.
  const theirs = again.spaces.ensure("m_avery");
  assert.deepEqual(Object.values(theirs).map((space) => [space.name, space.builtin, space.createdBy]), [["Today", "today", "m_avery"], ["Feed", "feed", "m_avery"], ["Ideas", "ideas", "m_avery"], ["Goals", "goals", "m_avery"]]);
  assert.deepEqual(again.spaces.ensure("m_avery"), theirs);
  assert.equal(again.state.spaces.length, 8);
  // A panel or a card whose space is gone is never left where nobody can find it.
  const state = { spaces: structuredClone(again.state.spaces), panels: [{ id: "x", spaceId: "s_gone" }], board: [{ id: "y", kind: "goal", spaceId: "s_gone" }, { id: "z", kind: "idea" }] };
  migrateSpaces(state);
  assert.deepEqual([state.panels[0].spaceId, state.board[0].spaceId, state.board[1].spaceId], [mine.today.id, mine.goals.id, mine.ideas.id]);
});

test("a bot's panel is found by its bot, its space and its key: one person's is not another's", async (t) => {
  const { ws, turn, chat } = setup(t);
  const owners = ws.spaces.ensure("owner");
  const averys = ws.spaces.ensure("m_avery");
  // The same bot, the same key, for two people: two panels, each in its person's Today.
  const mine = chat("pip");
  const theirs = chat("pip", "m_avery");
  await turn(mine, async (tool) => assert.deepEqual(await tool("today_publish", { key: "signups", title: "Signups", blocks }), { key: "signups", revision: 1, title: "Signups", space: "Today" }));
  await turn(theirs, async (tool) => assert.equal((await tool("today_publish", { key: "signups", title: "Avery's signups", blocks })).revision, 1), avery);
  assert.deepEqual(ws.state.panels.map((panel) => [panel.title, panel.spaceId, panel.createdBy]), [["Signups", owners.today.id, undefined], ["Avery's signups", averys.today.id, "m_avery"]]);
  // In Avery's chat the bot sees Avery's panel and no other, by list, by key, and when it tries to write.
  await turn(theirs, async (tool) => {
    assert.deepEqual((await tool("today_list")).map((panel) => [panel.key, panel.title, panel.space]), [["signups", "Avery's signups", "Today"]]);
    assert.equal((await tool("today_list", { key: "signups" })).title, "Avery's signups");
    assert.deepEqual((await tool("space_list")).map((space) => [space.name, space.mine, space.change]), [["Today", true, true], ["Feed", true, true], ["Ideas", true, true], ["Goals", true, true]]);
    // The owner's Today is not there for this turn: named by its id, it is an unknown space, as one that doesn't exist is.
    assert.match(await failure(tool("today_list", { key: "signups", space: owners.today.id })), /No space named/);
    assert.match(await failure(tool("today_publish", { key: "signups", space: owners.today.id, revision: 1, title: "Taken over", blocks })), /No space named/);
    assert.match(await failure(tool("today_remove", { key: "signups", space: owners.today.id, revision: 1 })), /No space named/);
    assert.match(await failure(tool("today_publish", { key: "x", space: "No such place", title: "X", blocks })), /No space named "No such place"/);
  }, avery);
  assert.equal(ws.state.panels[0].title, "Signups", "the owner's panel was not touched");
  // The owner's own turn sees the owner's panel; Avery's Today is there for the owner too (the owner can open every space), by its id.
  await turn(mine, async (tool) => {
    assert.equal((await tool("today_list", { key: "signups" })).title, "Signups", "with the key in two spaces, the one this chat is about");
    assert.equal((await tool("today_list", { key: "signups", space: averys.today.id })).title, "Avery's signups");
    assert.deepEqual((await tool("today_list")).map((panel) => panel.title).sort(), ["Avery's signups", "Signups"]);
  });
  // A space the owner made: named, a panel goes there, and the key is free in it.
  const launch = ws.spaces.create({ name: "Launch" }, "owner");
  await turn(mine, async (tool) => {
    assert.deepEqual(await tool("today_publish", { key: "signups", space: "Launch", title: "Launch signups", blocks }), { key: "signups", revision: 1, title: "Launch signups", space: "Launch" });
    // Without a space, publishing the key again updates the one in this chat's space, at its revision.
    assert.equal((await tool("today_publish", { key: "signups", revision: 1, title: "Signups v2", blocks })).revision, 2);
    assert.match(await failure(tool("today_routine", { key: "nope", action: "pause" })), /Unknown panel for this bot/);
  });
  assert.deepEqual(ws.state.panels.map((panel) => [panel.title, panel.spaceId]), [["Signups v2", owners.today.id], ["Avery's signups", averys.today.id], ["Launch signups", launch]]);
  // A chat started from a space (as `spaces.newPanel` and `spaces.ask` start one) publishes there.
  const fromLaunch = chat("scout");
  ws.chat(fromLaunch).spaceId = launch;
  await turn(fromLaunch, async (tool) => assert.equal((await tool("today_publish", { key: "tasks", title: "Tasks", blocks })).space, "Launch"));
  // A space holds so many panels and no more.
  const full = ws.spaces.create({ name: "Full" }, "owner");
  for (let n = 0; n < LIMITS.panels; n++) ws.state.panels.push({ id: "f" + n, key: "f" + n, botId: "patch", spaceId: full, title: "F", blocks: [], revision: 1 });
  await turn(mine, async (tool) => assert.match(await failure(tool("today_publish", { key: "one-more", space: "Full", title: "More", blocks })), /Full has 40 panels/));
});

test("a bot changes a shared space only when every person of the turn may, and a member's role applies on top", async (t) => {
  const context = setup(t);
  const { ws, turn, chat, shared } = context;
  const launch = ws.spaces.create({ name: "Launch" }, "owner");
  const board = ws.spaces.create({ name: "Board" }, "owner");
  shared[launch] = { m_avery: "edit", m_blake: "view" };
  shared[board] = { m_avery: "view" };
  const mine = chat("pip");
  await turn(mine, async (tool) => void (await tool("today_publish", { key: "plan", space: "Launch", title: "Plan", blocks })));
  // Avery may change Launch: the bot in Avery's chat reads the owner's panel there and updates it. Board, which Avery may only look at, it can't change.
  const averys = chat("pip", "m_avery");
  await turn(averys, async (tool) => {
    assert.deepEqual((await tool("space_list")).filter((space) => !space.mine).map((space) => [space.name, space.change]), [["Launch", true], ["Board", false]]);
    assert.equal((await tool("today_publish", { key: "plan", space: "Launch", revision: 1, title: "Plan, by Avery", blocks })).revision, 2);
    assert.match(await failure(tool("today_publish", { key: "x", space: "Board", title: "X", blocks })), /can look at Board, not change it/);
  }, avery);
  assert.equal(ws.state.panels[0].title, "Plan, by Avery");
  assert.equal(ws.state.panels[0].createdBy, undefined, "the panel stays its maker's");
  // Blake may only look, by the space and by a role that has no more than "view": the bot shows it, and changes nothing anywhere, Blake's own Today included.
  const blakes = chat("pip", "m_blake");
  await turn(blakes, async (tool) => {
    assert.equal((await tool("today_list", { key: "plan", space: "Launch" })).title, "Plan, by Avery");
    assert.match(await failure(tool("today_publish", { key: "plan", space: "Launch", revision: 2, title: "No", blocks })), /can look at Launch, not change it/);
    assert.match(await failure(tool("today_publish", { key: "own", title: "Own", blocks })), /role .* doesn't allow that/);
    // A card is how a bot tells a person something: it still goes to Blake's own Feed, which Blake can open.
    assert.equal((await tool("board_post", { kind: "feed", title: "News for Blake" })).kind, "feed");
  }, blake);
  assert.deepEqual(ws.state.board.map((card) => [card.title, card.spaceId]), [["News for Blake", ws.spaces.ensure("m_blake").feed.id]]);
  // A turn works for the chat's starter and for whoever wrote the message: Blake writing in the owner's chat narrows that turn to what Blake may do.
  await turn(mine, async (tool) => {
    // What both can open: Launch, which is shared with Blake, and Blake's own four (the owner can open every space). Not the owner's own Today.
    assert.deepEqual((await tool("space_list")).map((space) => [space.name, space.mine]), [["Launch", true], ["Today", false], ["Feed", false], ["Ideas", false], ["Goals", false]]);
    assert.match(await failure(tool("today_publish", { key: "plan", space: "Launch", revision: 2, title: "No", blocks })), /not change it/);
    assert.match(await failure(tool("today_publish", { key: "new", title: "New", blocks })), /Unknown space|No space|not change/);
  }, blake);
  assert.equal(ws.state.panels.length, 1);
  // Without a link to say who else may open a space, a space is its maker's and the owner's.
  const alone = new Workspace(tempDir(t), fakeClient().client, () => {}, { team: () => team });
  const space = alone.spaces.get(alone.spaces.create({ name: "Mine" }, "m_avery"));
  assert.deepEqual(["m_avery", "owner", "m_blake"].map((person) => alone.spaces.can(space, person)), ["own", "own", null]);
  // The owner's four built-in ones are every member's to change until a link says otherwise, as
  // the one Today page was before spaces. A space the owner made is not.
  assert.deepEqual(["owner", "m_avery"].map((person) => alone.spaces.can(alone.spaces.ensure("owner").today, person)), ["own", "edit"]);
  assert.equal(alone.spaces.can(alone.spaces.get(alone.spaces.create({ name: "Private" }, "owner")), "m_avery"), null);
  // What the link is given to make each person's list from: each space with what it holds.
  const part = alone.snapshot().spaces;
  assert.deepEqual(part.map((entry) => [entry.name, entry.createdBy, entry.items.length]), [["Today", undefined, 0], ["Feed", undefined, 0], ["Ideas", undefined, 0], ["Goals", undefined, 0], ["Mine", "m_avery", 0], ["Private", undefined, 0]]);
});

test("a refresh runs for the panel's maker and for whoever asked, under the narrower of their limits", async (t) => {
  const { ws, turn, chat, fake } = setup(t);
  const averys = chat("pip", "m_avery");
  await turn(averys, async (tool) => {
    await tool("today_publish", { key: "numbers", title: "Numbers", blocks });
    assert.equal((await tool("today_routine", { key: "numbers", action: "set", cron: "0 8 * * *", prompt: "Count them." })).setBy, "m_avery");
  }, avery);
  const panel = ws.state.panels[0];
  assert.deepEqual([panel.createdBy, panel.routine.setBy], ["m_avery", "m_avery"]);
  // Its refresh chat is Avery's, so what the refresh has to say goes to Avery and not to the owner.
  await ws.panels.refresh(panel.id, "manual", Date.now(), "owner");
  const refreshChat = ws.chat(panel.refreshChatId);
  assert.equal(refreshChat.createdBy, "m_avery");
  assert.equal(refreshChat.messages.find((message) => message.role === "user").author, undefined, "pressed by the owner");
  // The owner pressing Refresh lends the member nothing: the turn has the member's limits.
  assert.deepEqual(ws.accessForTurn(refreshChat, {}), { member: true, skills: false, mcp: false, plugins: false });
  // The owner's panel with a routine a member set: the scheduled refresh is written in that member's name, so it has that member's limits and not the owner's.
  const mine = chat("pip");
  await turn(mine, async (tool) => void (await tool("today_publish", { key: "revenue", title: "Revenue", blocks })));
  const owned = ws.state.panels[1];
  assert.equal(ws.panels.routine(owned.id, { action: "set", cron: "0 8 * * *", prompt: "Read the owner's mail and put it here." }, "m_blake").setBy, "m_blake");
  owned.routine.nextAt = Date.now() - 1000;
  await ws.panels.tick();
  const ownedChat = ws.chat(owned.refreshChatId);
  assert.equal(ownedChat.createdBy, undefined);
  const asked = ownedChat.messages.find((message) => message.role === "user");
  assert.deepEqual(asked.author, blake);
  assert.deepEqual(ws.accessForTurn(ownedChat, { author: asked.author }), { member: true, skills: false, mcp: false, plugins: false });
  // The model is told whose request it is.
  assert.match(fake.log.sent.at(-1)[1], /^\[From Blake, a member of Northstar's team, not the owner\]\nRefresh your Today panel "revenue"/);
  // A routine the owner sets has no member's name on it, and runs as the owner's always did.
  assert.equal(ws.panels.routine(owned.id, { action: "set", cron: "0 9 * * *", prompt: "Count." }, "owner").setBy, undefined);
});

test("panels keep their order inside one space, and can be moved to another", async (t) => {
  const { ws } = setup(t);
  const today = ws.spaces.ensure("owner").today.id;
  const launch = ws.spaces.create({ name: "Launch" }, "owner");
  const add = (id, spaceId) => ws.state.panels.push({ id, key: id, botId: "pip", spaceId, title: id, blocks: [], revision: 1 });
  // Two spaces whose panels lie mixed in the one list.
  for (const [id, space] of [["a", today], ["x", launch], ["b", today], ["y", launch], ["c", today]]) add(id, space);
  const order = (spaceId) => ws.spaces.panels(spaceId).map((panel) => panel.id).join("");
  ws.panels.change("b", "earlier");
  assert.deepEqual([order(today), order(launch)], ["bac", "xy"], "it changed places with the one before it in its own space");
  ws.panels.change("a", "later");
  assert.deepEqual([order(today), order(launch)], ["bca", "xy"]);
  ws.panels.change("b", "earlier");
  ws.panels.change("a", "later");
  assert.deepEqual([order(today), order(launch)], ["bca", "xy"], "the first stays first and the last last");
  // To another space: at its end, or before one of its panels. Each space's count goes up.
  const revs = () => [ws.spaces.get(today).rev, ws.spaces.get(launch).rev];
  const before = revs();
  ws.panels.move("c", launch, "y");
  assert.deepEqual([order(today), order(launch)], ["ba", "xcy"]);
  assert.ok(revs()[0] > before[0] && revs()[1] > before[1]);
  ws.panels.move("b", launch);
  assert.deepEqual([order(today), order(launch)], ["a", "xcyb"]);
  ws.panels.move("x", launch);
  assert.equal(order(launch), "cybx", "the same space puts it in order there");
  assert.throws(() => ws.panels.move("a", launch, "a"), /not in Launch/);
  assert.throws(() => ws.panels.move("a", "s_nowhere"), /no longer exists/);
  // A bot has one panel by a key in a space.
  add("c2", today);
  ws.state.panels.at(-1).key = "c";
  assert.throws(() => ws.panels.move("c2", launch), /already has a panel like this one in Launch/);
});

test("an app panel keeps what people change in it, and people leave notes", async (t) => {
  const { ws, turn, chat, shared, events } = setup(t);
  const mine = chat("pip");
  await turn(mine, async (tool) => void (await tool("today_publish", { key: "list", title: "Checklist", blocks: [{ type: "html", html: "<p>list</p>" }], state: { milk: false } })));
  assert.deepEqual(events, [], "what a bot publishes is not a person's change");
  const panel = ws.state.panels[0];
  const space = ws.spaces.of(panel);
  // The owner's Today, shared so that Avery and Casey may change it and Blake may look.
  shared[space.id] = { m_avery: "edit", m_casey: "edit", m_blake: "view" };
  assert.deepEqual([panel.state, panel.stateRev], [{ milk: false }, 1]);
  // Two people change different things: neither undoes the other. null takes a key away.
  const maya = { id: "m_avery", name: "Avery" };
  const rev = space.rev;
  assert.deepEqual(ws.spaces.patchState(panel.id, { milk: true }, "Ticked Milk", maya), { rev: 2 });
  assert.deepEqual(ws.spaces.patchState(panel.id, { eggs: true, gone: 1 }, undefined, { id: "owner", name: "Sam" }), { rev: 3 });
  ws.spaces.patchState(panel.id, { gone: null }, "  Removed\n\tGone  ", { id: "owner", name: "Sam" });
  assert.deepEqual(panel.state, { milk: true, eggs: true });
  // The link is told of each, to pick who gets an alert: who did it, where, and the page's own words for it.
  assert.deepEqual(events.splice(0), [
    { spaceId: space.id, panelId: panel.id, by: "m_avery", kind: "change", label: "Ticked Milk" },
    { spaceId: space.id, panelId: panel.id, by: "owner", kind: "change" },
    { spaceId: space.id, panelId: panel.id, by: "owner", kind: "change", label: "Removed Gone" },
  ]);
  assert.deepEqual([panel.last.by, panel.last.name, panel.last.label], ["owner", "Sam", "Removed Gone"], "the last line is the page's own words, as one line of plain text");
  assert.ok(space.rev > rev, "the space's count went up, so apps read it again");
  // What a page may keep is limited, and a refused change changes nothing.
  assert.throws(() => ws.spaces.patchState(panel.id, { big: "x".repeat(LIMITS.state) }, "", maya), /64 KB/);
  assert.throws(() => ws.spaces.patchState(panel.id, Object.fromEntries(Array.from({ length: LIMITS.keys }, (_, n) => ["k" + n, 1])), "", maya), /at most 200 keys/);
  assert.throws(() => ws.spaces.patchState(panel.id, ["not", "an", "object"], "", maya), /object of the keys/);
  assert.deepEqual([panel.state, panel.stateRev], [{ milk: true, eggs: true }, 4]);
  // The bot reads the state with the whole panel, and an update keeps it unless it sends a new one.
  await turn(mine, async (tool) => {
    assert.equal((await tool("today_list", { key: "list" })).state, undefined);
    assert.deepEqual((await tool("today_list", { key: "list", full: true })).state, { milk: true, eggs: true });
    await tool("today_publish", { key: "list", revision: 1, title: "Checklist", blocks: [{ type: "html", data: { n: 1 } }] });
  });
  assert.deepEqual(panel.state, { milk: true, eggs: true }, "kept through the bot's update");
  await turn(mine, async (tool) => void (await tool("today_publish", { key: "list", revision: 2, title: "Checklist", blocks: [{ type: "html", data: { n: 2 } }], state: {} })));
  assert.deepEqual([panel.state, panel.stateRev], [{}, 5]);
  // The page reaches its state through the bridge every app puts in front of it: it asks the app
  // that shows it, and hears of a change someone else made.
  const page = framePage("<p>list</p>", {});
  for (const part of ['ask("state", {})', 'ask("setState", { patch', 'm.type === "state"', "onChange: (fn) => (changed.add(fn)"]) assert.ok(page.includes(part), part);
  // Notes: short, so many a panel, a person removes their own, and the maker or the owner removes any.
  const first = ws.spaces.note(panel.id, " Looks right. ", maya);
  const second = ws.spaces.note(panel.id, "Thanks", { id: "owner", name: "Sam" });
  assert.deepEqual(panel.notes.map((note) => [note.by, note.name, note.text]), [["m_avery", "Avery", "Looks right."], ["owner", "Sam", "Thanks"]]);
  assert.match(first, /^n_[a-z2-7]{10}$/);
  assert.deepEqual(events.splice(0), [
    { spaceId: space.id, panelId: panel.id, by: "m_avery", kind: "note", text: "Looks right." },
    { spaceId: space.id, panelId: panel.id, by: "owner", kind: "note", text: "Thanks" },
  ]);
  assert.throws(() => ws.spaces.note(panel.id, "x".repeat(LIMITS.note + 1), maya), /Invalid note/);
  assert.throws(() => ws.spaces.removeNote(panel.id, second, "m_avery"), /your own notes/);
  assert.throws(() => ws.spaces.removeNote(panel.id, second, "m_casey"), /your own notes/, "another person who may change the space is not its maker");
  ws.spaces.removeNote(panel.id, first, "m_avery");
  ws.spaces.removeNote(panel.id, second, "owner");
  assert.deepEqual(panel.notes, [], "the owner removes any");
  assert.throws(() => ws.spaces.removeNote(panel.id, second, "owner"), /no longer exists/);
  // By a person's id, the space's own rule is asked: one who may only look changes nothing, and one who can't open it finds nothing there.
  assert.throws(() => ws.spaces.patchState(panel.id, { x: 1 }, "", "m_blake"), /can look at Today, not change it/);
  assert.throws(() => ws.spaces.note(panel.id, "hello", "m_blake"), /not change it/);
  shared[space.id] = {};
  assert.throws(() => ws.spaces.patchState(panel.id, { x: 1 }, "", "m_avery"), /no longer exists/);
  assert.deepEqual(ws.spaces.patchState(panel.id, { x: 1 }, "Set x", "owner"), { rev: 6 });
  assert.deepEqual([panel.last.by, panel.last.name, panel.last.label], ["owner", "Sam", "Set x"]);
  shared[space.id] = { m_avery: "edit" };
  for (let n = 0; n < LIMITS.notes; n++) ws.spaces.note(panel.id, "note " + n, maya);
  assert.throws(() => ws.spaces.note(panel.id, "one more", maya), /has 50 notes/);
});

test("a bot's cards go to the Feed, Ideas and Goals of the person the chat is for, and it reads only theirs", async (t) => {
  const { ws, turn, chat } = setup(t);
  const owners = ws.spaces.ensure("owner");
  const averys = ws.spaces.ensure("m_avery");
  const mine = chat("pip");
  const theirs = chat("pip", "m_avery");
  let ownersIdea;
  await turn(mine, async (tool) => {
    await tool("board_post", { kind: "feed", title: "Owner's news" });
    ownersIdea = (await tool("board_post", { kind: "idea", title: "Owner's idea" })).posted;
  });
  await turn(theirs, async (tool) => {
    await tool("board_post", { kind: "feed", title: "Avery's news" });
    await tool("board_post", { kind: "goal", title: "Avery's goal", category: "career" });
    // The same bot, in Avery's chat: the owner's cards are not there to list or to change.
    assert.deepEqual((await tool("board_list")).map((card) => card.title).sort(), ["Avery's goal", "Avery's news"]);
    assert.match(await failure(tool("board_update", { id: ownersIdea, title: "Changed" })), /no longer exists/);
  }, avery);
  assert.deepEqual(ws.state.board.map((card) => [card.title, card.spaceId]).sort(), [["Avery's goal", averys.goals.id], ["Avery's news", averys.feed.id], ["Owner's idea", owners.ideas.id], ["Owner's news", owners.feed.id]]);
  // An idea a person turns into a goal becomes a goal in that same person's Goals.
  const idea = ws.board.post("pip", { kind: "idea", title: "Avery's idea" }, averys.ideas.id);
  const goal = ws.board.item(ws.board.act(idea.id, "goal", "career"));
  assert.equal(goal.spaceId, averys.goals.id);
  // Whatever happens to a card raises its space's count.
  const rev = ws.spaces.get(averys.goals.id).rev;
  ws.board.act(goal.id, "done");
  assert.ok(ws.spaces.get(averys.goals.id).rev > rev);
  // A bot that is deleted takes its panels and cards with it, and each space that lost one counts up.
  await turn(mine, async (tool) => void (await tool("today_publish", { key: "p", title: "P", blocks })));
  const before = Object.fromEntries(ws.state.spaces.map((space) => [space.id, space.rev]));
  await ws.agents.deleteBot("pip");
  assert.deepEqual([ws.state.panels.length, ws.state.board.length], [0, 0]);
  for (const id of [owners.today.id, owners.feed.id, owners.ideas.id, averys.feed.id, averys.goals.id]) assert.ok(ws.spaces.get(id).rev > before[id], ws.spaces.get(id).name);
});

test("a person makes, names, reads and deletes a space, and is sent only what is theirs to see", async (t) => {
  const { ws, turn, during, chat, shared, fake } = setup(t);
  // Made: private, its maker's. Named again. The four built-in ones keep their names and stay.
  const launch = ws.spaces.create({ name: " Launch " }, "m_avery");
  assert.deepEqual([ws.spaces.get(launch).name, ws.spaces.get(launch).createdBy], ["Launch", "m_avery"]);
  assert.throws(() => ws.spaces.create({ name: "" }, "owner"), /Invalid name/);
  assert.throws(() => ws.spaces.create({ name: "x".repeat(41) }, "owner"), /Invalid name/);
  ws.spaces.rename(launch, "Launch week", "m_avery");
  assert.throws(() => ws.spaces.rename(launch, "Mine now", "m_casey"), /no longer exists/, "a space a person can't open is not there for them");
  const today = ws.spaces.ensure("m_avery").today.id;
  assert.throws(() => ws.spaces.rename(today, "Tomorrow", "m_avery"), /can't be renamed/);
  await assert.rejects(ws.spaces.remove(today, "m_avery"), /can't be deleted/);
  for (let n = ws.spaces.all.filter((space) => space.createdBy === "m_avery").length; n < LIMITS.spaces; n++) ws.spaces.create({ name: "S" + n }, "m_avery");
  assert.throws(() => ws.spaces.create({ name: "One more" }, "m_avery"), /You have 60 spaces/);
  assert.match(ws.spaces.create({ name: "The owner's" }, "owner"), /^s_/, "the limit is each person's own");
  // Shared with Casey to change, with Blake to look, with Dana (whose role shows one bot only) to change.
  shared[launch] = { m_casey: "edit", m_blake: "view", m_dana: "edit" };
  const averys = chat("pip", "m_avery");
  ws.chat(averys).spaceId = launch;
  await turn(averys, async (tool) => {
    await tool("today_publish", { key: "plan", title: "Plan", blocks });
    await tool("today_routine", { key: "plan", action: "set", cron: "0 8 * * *", prompt: "Read Avery's notes." });
  }, avery);
  const scouts = chat("scout", "m_avery");
  ws.chat(scouts).spaceId = launch;
  await turn(scouts, async (tool) => void (await tool("today_publish", { key: "research", title: "Research", blocks })), avery);
  const [plan, research] = ws.spaces.panels(launch);
  ws.panels.change(research.id, "hide");
  plan.projectId = "project-1";
  // The maker is sent everything but what only the run that wrote a panel needs.
  const mine = ws.spaces.read(launch, "m_avery");
  assert.deepEqual([mine.id, mine.rev, mine.panels.map((panel) => panel.title)], [launch, ws.spaces.get(launch).rev, ["Plan", "Research"]]);
  assert.deepEqual([mine.panels[0].chatId, mine.panels[0].routine.prompt, "lastWriter" in mine.panels[0], "projectId" in mine.panels[0]], [averys, "Read Avery's notes.", false, false], "a project is the owner's, and is not sent to a member");
  // The owner is sent the project too.
  assert.equal(ws.spaces.read(launch, "owner").panels[0].projectId, "project-1");
  // Someone who may change it: the hidden panel too, the routine with its prompt, and no chat they are not in.
  const caseys = ws.spaces.read(launch, "m_casey");
  assert.deepEqual([caseys.panels.map((panel) => panel.title), caseys.panels[0].routine.prompt, "chatId" in caseys.panels[0]], [["Plan", "Research"], "Read Avery's notes.", false]);
  // Someone who may only look: no hidden panel, and a routine without its prompt.
  const blakes = ws.spaces.read(launch, "m_blake");
  assert.deepEqual([blakes.panels.map((panel) => panel.title), "prompt" in blakes.panels[0].routine, blakes.panels[0].routine.cron], [["Plan"], false, "0 8 * * *"]);
  // A member whose role shows them one bot is sent that bot's panels only.
  assert.deepEqual(ws.spaces.read(launch, "m_dana").panels.map((panel) => panel.title), ["Plan"]);
  assert.throws(() => ws.spaces.read(launch, "m_nobody"), /no longer exists/);
  // What the link is given to count with: what is there to see, by its bot and when it last changed.
  assert.deepEqual(ws.snapshot().spaces.find((space) => space.id === launch).items, [{ id: plan.id, botId: "pip", updatedAt: plan.updatedAt }]);
  // Projects are the owner's: only the owner attaches one, and only to the owner's own space.
  ws.state.projects = [{ id: "project-1", name: "Launch" }];
  const owners = ws.spaces.create({ name: "Owner's" }, "owner");
  ws.spaces.setProject(owners, "project-1", "owner");
  assert.equal(ws.spaces.get(owners).projectId, "project-1");
  ws.spaces.setProject(owners, null, "owner");
  assert.equal("projectId" in ws.spaces.get(owners), false);
  assert.throws(() => ws.spaces.setProject(launch, "project-1", "m_avery"), /Only the owner's spaces/);
  assert.throws(() => ws.spaces.setProject(owners, "project-gone", "owner"), /project no longer exists/);
  assert.throws(() => ws.spaces.setPanelProject(plan.id, "project-1", "m_avery"), /Only the owner/);
  // A new panel, asked for from the space: the person's own chat, in that space, with their sentence as /today-panel takes it, and one line for how to start.
  shared[launch].m_casey = "edit";
  // The first panel the bot publishes from that chat gets the refresh that was asked for, set by that person, with their sentence as its prompt.
  const made = await during(
    async (tool) => void (await tool("today_publish", { key: "press-kit", title: "Press kit", blocks })),
    () => ws.spaces.newPanel({ spaceId: launch, botId: "pip", prompt: "Track the press kit", start: "checklist", refresh: { cron: "30 7 * * 1", timezone: "Europe/Lisbon" } }, "m_casey"),
  );
  const newChat = ws.chat(made.chatId);
  assert.deepEqual([newChat.botId, newChat.spaceId, newChat.createdBy, newChat.messages[0].text, newChat.messages[0].author], ["pip", launch, "m_casey", "/today-panel Track the press kit Make it a checklist.", { memberId: "m_casey", name: "Casey" }]);
  const pressKit = ws.spaces.panels(launch).at(-1);
  assert.deepEqual([pressKit.title, pressKit.createdBy, pressKit.routine.cron, pressKit.routine.timezone, pressKit.routine.prompt, pressKit.routine.setBy, pressKit.routine.enabled], ["Press kit", "m_casey", "30 7 * * 1", "Europe/Lisbon", "Track the press kit", "m_casey", true]);
  assert.equal("panelRoutine" in newChat, false, "asked for once, set once");
  assert.throws(() => ws.spaces.newPanel({ spaceId: launch, botId: "pip", prompt: "x" }, "m_blake"), /not change it/);
  assert.throws(() => ws.spaces.newPanel({ spaceId: launch, botId: "scout", prompt: "x" }, "m_dana"), /Unknown bot/, "a bot the person's role doesn't show them");
  assert.throws(() => ws.spaces.newPanel({ spaceId: launch, botId: "pip", prompt: "x", start: "spreadsheet" }, "m_casey"), /Unknown way to start/);
  assert.throws(() => ws.spaces.newPanel({ spaceId: launch, botId: "pip", prompt: "x", refresh: { cron: "every day" } }, "m_casey"), /five cron fields/);
  // Asking about a space, or about one of its panels: the person's own chat, and the bot is told where it is.
  const asked = await during(async () => {}, () => ws.spaces.ask({ spaceId: launch, botId: "pip", text: "What changed?", panelId: plan.id }, "m_blake"));
  const askChat = ws.chat(asked.chatId);
  assert.deepEqual([askChat.spaceId, askChat.aboutPanelId, askChat.createdBy, askChat.messages[0].text], [launch, plan.id, "m_blake", "What changed?"]);
  const told = ws.instructionsFor(askChat, ws.bot("pip"));
  assert.match(told, /This chat was started from the space "Launch week" \(a page of panels\)/);
  assert.match(told, /"Plan" \(key plan, by Pip\); "Press kit" \(key press-kit, by Pip\)/);
  assert.match(told, /The person is asking about the panel "Plan" \(key plan\)\./);
  assert.doesNotMatch(told, /"Research"/, "a hidden panel is not named");
  assert.equal(ws.instructionsFor(ws.chat(chat("pip")), ws.bot("pip")).includes("started from the space"), false);
  assert.throws(() => ws.spaces.ask({ spaceId: launch, botId: "pip", text: "x", panelId: "nope" }, "m_blake"), /Panel no longer exists/);
  // Moving a panel: into a space the person may change; out of one only by its maker or by the person it was made for.
  const caseysOwn = ws.spaces.create({ name: "Casey's" }, "m_casey");
  assert.throws(() => ws.spaces.movePanel(plan.id, { spaceId: caseysOwn }, "m_casey"), /can move it out/, "Avery's panel in Avery's space is not Casey's to take");
  ws.spaces.movePanel(pressKit.id, { spaceId: caseysOwn }, "m_casey");
  assert.equal(pressKit.spaceId, caseysOwn, "the one made for Casey is");
  ws.spaces.movePanel(plan.id, { spaceId: launch, before: null }, "m_casey");
  assert.throws(() => ws.spaces.movePanel(plan.id, { spaceId: launch }, "m_blake"), /not change it/);
  // Deleted: the space, its panels, their views and their refresh chats. A chat started from it stays, about no space.
  await ws.panels.refresh(plan.id, "manual", Date.now(), "m_avery");
  const refreshChat = plan.refreshChatId;
  await assert.rejects(ws.spaces.remove(launch, "m_casey"), /Only the person who made/);
  await ws.spaces.remove(launch, "m_avery");
  assert.equal(ws.spaces.all.some((space) => space.id === launch), false);
  assert.deepEqual([ws.state.panels.some((panel) => panel.spaceId === launch), ws.state.chats.some((item) => item.id === refreshChat), "spaceId" in ws.chat(asked.chatId)], [false, false, false]);
  assert.ok(fake.log.sent.length > 0);
});

test("the copy of a space that a link opens holds what the space says, and nothing that names the host or its people", async (t) => {
  const { ws, turn, chat } = setup(t);
  const launch = ws.spaces.create({ name: "Launch" }, "owner");
  const mine = chat("pip");
  ws.chat(mine).spaceId = launch;
  await turn(mine, async (tool) => {
    await tool("today_publish", { key: "list", title: "Checklist", blocks: [{ type: "markdown", text: "Ship it" }, { type: "html", html: "<p id=x>list</p>", data: { items: ["a"] }, height: 200 }], state: { a: true } });
    await tool("today_publish", { key: "secret", title: "Hidden", blocks });
    await tool("today_routine", { key: "list", action: "set", cron: "0 8 * * *", prompt: "Read my mail." });
  });
  const [list, hidden] = ws.spaces.panels(launch);
  ws.panels.change(hidden.id, "hide");
  list.size = "tall";
  list.projectId = "project-1";
  ws.spaces.note(list.id, "A private note", "owner");
  const copy = ws.spaces.snapshot(launch);
  assert.deepEqual(Object.keys(copy), ["v", "name", "from", "kind", "updatedAt", "panels", "cards"]);
  assert.deepEqual([copy.v, copy.name, copy.from, copy.kind], [1, "Launch", "Northstar", "panels"]);
  assert.deepEqual(copy.panels.map((panel) => Object.keys(panel)), [["title", "size", "bot", "updatedAt", "blocks", "state"]], "the hidden panel is not in it");
  assert.deepEqual([copy.panels[0].title, copy.panels[0].size, copy.panels[0].bot.name, copy.panels[0].state], ["Checklist", "tall", "Pip", { a: true }]);
  assert.deepEqual(copy.panels[0].blocks, [{ type: "markdown", text: "Ship it" }, { type: "html", height: 200, page: "<p id=x>list</p>", data: { items: ["a"] } }], "a custom view is its page, not an id of one");
  // No id of the host, of a chat, a bot, a panel, a project or a space; no routine, no note, no last line.
  const text = JSON.stringify(copy);
  for (const secret of [launch, list.id, list.chatId, "project-1", "Read my mail", "A private note", "routine", "notes", '"last"', "createdBy", "botId", ws.state.frames[0].id]) assert.equal(text.includes(secret), false, secret);
  // A Feed's copy: its open cards, as cards.
  const feed = ws.spaces.ensure("owner").feed;
  ws.board.post("pip", { kind: "feed", title: "News", body: "Read this", links: [{ url: "https://example.com" }] });
  const done = ws.board.post("pip", { kind: "feed", title: "Old news" });
  ws.board.act(done.id, "clear");
  const cards = ws.spaces.snapshot(feed.id, { from: "Sam" });
  assert.deepEqual([cards.kind, cards.from, cards.cards.map((card) => [card.kind, card.title, card.body, card.bot.name])], ["feed", "Sam", [["feed", "News", "Read this", "Pip"]]]);
  assert.deepEqual(Object.keys(cards.cards[0]), ["kind", "title", "body", "links", "bot", "createdAt"]);
  // A member's space: only what that member's role shows them goes out, whoever else put something there.
  const danas = ws.spaces.create({ name: "Dana's" }, "m_dana");
  ws.state.panels.push({ id: "d1", key: "d1", botId: "pip", spaceId: danas, title: "By Pip", blocks, revision: 1 }, { id: "d2", key: "d2", botId: "scout", spaceId: danas, title: "By Scout", blocks, revision: 1 });
  assert.deepEqual(ws.spaces.snapshot(danas).panels.map((panel) => panel.title), ["By Pip"]);
  // Too large once packed: the largest page is left out first, and its panel says so; what fits stays.
  const big = ws.spaces.create({ name: "Big" }, "owner");
  const bigChat = chat("pip");
  ws.chat(bigChat).spaceId = big;
  // Pages that do not pack small.
  const noise = (length) => randomBytes(length * 0.75).toString("base64");
  await turn(bigChat, async (tool) => {
    await tool("today_publish", { key: "small", title: "Small", blocks: [{ type: "html", html: "<p>" + noise(20000) + "</p>" }] });
    await tool("today_publish", { key: "large", title: "Large", blocks: [{ type: "markdown", text: "Kept" }, { type: "html", html: "<p>" + noise(90000) + "</p>" }] });
  });
  const whole = gzipSync(JSON.stringify(ws.spaces.snapshot(big))).length;
  const cut = ws.spaces.snapshot(big, { limit: whole - 1000 });
  assert.deepEqual(cut.panels.map((panel) => [panel.title, panel.left, panel.blocks.map((block) => block.type)]), [["Small", undefined, ["html"]], ["Large", "size", ["markdown"]]]);
  assert.ok(gzipSync(JSON.stringify(cut)).length <= whole - 1000);
});

test("when a member leaves, their spaces pass to the owner and what they set stops running in their name", async (t) => {
  const { ws, turn, chat } = setup(t);
  const owners = ws.spaces.ensure("owner");
  const theirs = ws.spaces.ensure("m_avery");
  const launch = ws.spaces.create({ name: "Avery's launch" }, "m_avery");
  const averys = chat("pip", "m_avery");
  await turn(averys, async (tool) => {
    await tool("today_publish", { key: "numbers", title: "Numbers", blocks });
    await tool("today_publish", { key: "plan", space: "Avery's launch", title: "Plan", blocks });
    await tool("board_post", { kind: "idea", title: "Avery's idea" });
  }, avery);
  // A routine Avery set on the owner's panel.
  const mine = chat("pip");
  await turn(mine, async (tool) => void (await tool("today_publish", { key: "revenue", title: "Revenue", blocks })));
  const revenue = ws.state.panels.find((panel) => panel.key === "revenue");
  ws.panels.routine(revenue.id, { action: "set", cron: "0 8 * * *", prompt: "Count." }, "m_avery");
  ws.spaces.note(revenue.id, "Looks right", { id: "m_avery", name: "Avery" });
  ws.spaces.memberRemoved("m_avery");
  // The space they made is the owner's now. Their four built-in ones are gone, and what was in them is in the owner's.
  assert.equal(ws.spaces.get(launch).createdBy, undefined);
  assert.equal(ws.spaces.all.some((space) => Object.values(theirs).some((gone) => gone.id === space.id)), false);
  assert.equal(ws.spaces.all.filter((space) => space.builtin).length, 4);
  const numbers = ws.state.panels.find((panel) => panel.key === "numbers");
  assert.deepEqual([numbers.spaceId, numbers.createdBy, ws.state.panels.find((panel) => panel.key === "plan").spaceId], [owners.today.id, undefined, launch]);
  assert.equal(ws.state.board[0].spaceId, owners.ideas.id);
  // The routine they set is paused and is nobody's; their note stays, with their name.
  assert.deepEqual([revenue.routine.enabled, revenue.routine.nextAt, "setBy" in revenue.routine], [false, null, false]);
  assert.deepEqual(revenue.notes.map((note) => [note.name, note.text]), [["Avery", "Looks right"]]);
  // Said twice, nothing more happens.
  const before = JSON.stringify(ws.state.spaces);
  ws.spaces.memberRemoved("m_avery");
  assert.equal(JSON.stringify(ws.state.spaces), before);
});

test("a device is told of spaces only when the link carries every one of their calls", () => {
  assert.equal(SPACE_CALLS.length, 12);
  assert.equal(linkCapabilities(new Set()).includes("spaces-v1"), false);
  assert.equal(linkCapabilities(new Set(SPACE_CALLS.slice(1))).includes("spaces-v1"), false);
  assert.equal(linkCapabilities(new Set(SPACE_CALLS)).includes("spaces-v1"), true);
});
