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
import { LIMITS, migrateSpaces } from "../desktop/spaces.mjs";

// A team of two members: Avery may do everything with spaces, Blake may only look.
const perms = (today) => ({ agents: ["view", "chat"], today, skills: ["read"], mcp: ["view"], plugins: ["view"], settings: [] });
const team = {
  name: "Northstar",
  roles: [
    { id: "r_maker", name: "Maker", perms: perms(["view", "use", "create", "manage", "delete"]), bots: "all" },
    { id: "r_guest", name: "Guest", perms: perms(["view"]), bots: "all" },
  ],
  groups: [{ id: "g_makers", name: "Makers", roleId: "r_maker" }, { id: "g_guests", name: "Guests", roleId: "r_guest" }],
  members: [
    { id: "m_avery", name: "Avery", groupId: "g_makers", joinedAt: 1, deviceIds: [] },
    { id: "m_blake", name: "Blake", groupId: "g_guests", joinedAt: 2, deviceIds: [] },
    { id: "m_casey", name: "Casey", groupId: "g_makers", joinedAt: 3, deviceIds: [] },
  ],
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
  });
  const dir = tempDir(t);
  const spaceCan = (space, person) => (person === "owner" || (space.createdBy ?? "owner") === person ? "own" : (shared[space.id]?.[person] ?? null));
  const open = () => new Workspace(dir, fake.client, () => {}, { team: () => team, spaceCan });
  const ws = open();
  const turn = async (chatId, run, author) => {
    script = run;
    broke = null;
    await ws.send(chatId, "do it", author ? { author } : {});
    script = async () => {};
    if (broke) throw broke;
  };
  /** A chat with a bot, started by a person. */
  const chat = (botId, person) => {
    const id = ws.createChat(botId);
    if (person && person !== "owner") ws.chat(id).createdBy = person;
    return id;
  };
  return { dir, ws, open, turn, chat, fake, shared };
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
  assert.equal("spaces" in JSON.parse(JSON.stringify(alone.snapshot())), false, "the records as kept are no part of what an app is sent");
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
  const { ws, turn, chat } = setup(t);
  const mine = chat("pip");
  await turn(mine, async (tool) => void (await tool("today_publish", { key: "list", title: "Checklist", blocks: [{ type: "html", html: "<p>list</p>" }], state: { milk: false } })));
  const panel = ws.state.panels[0];
  const space = ws.spaces.of(panel);
  assert.deepEqual([panel.state, panel.stateRev], [{ milk: false }, 1]);
  // Two people change different things: neither undoes the other. null takes a key away.
  const maya = { id: "m_avery", name: "Avery" };
  const rev = space.rev;
  assert.deepEqual(ws.spaces.patchState(panel.id, { milk: true }, "Ticked Milk", maya), { rev: 2 });
  assert.deepEqual(ws.spaces.patchState(panel.id, { eggs: true, gone: 1 }, undefined, { id: "owner", name: "Sam" }), { rev: 3 });
  ws.spaces.patchState(panel.id, { gone: null }, "  Removed\n\tGone  ", { id: "owner", name: "Sam" });
  assert.deepEqual(panel.state, { milk: true, eggs: true });
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
  assert.throws(() => ws.spaces.note(panel.id, "x".repeat(LIMITS.note + 1), maya), /Invalid note/);
  assert.throws(() => ws.spaces.removeNote(panel.id, second, "m_avery"), /your own notes/);
  ws.spaces.removeNote(panel.id, first, "m_avery");
  ws.spaces.removeNote(panel.id, second, "m_casey", true);
  assert.deepEqual(panel.notes, []);
  assert.throws(() => ws.spaces.removeNote(panel.id, second, "owner", true), /no longer exists/);
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
