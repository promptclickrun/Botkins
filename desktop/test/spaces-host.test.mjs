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
import { LIMITS, migrateSpaces, PACE } from "../desktop/spaces.mjs";

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
  // The owner presses Refresh on that panel. The prompt that runs is the member's text, so the
  // member is one of the turn's people: the turn does not get the owner's tools.
  await ws.panels.refresh(owned.id, "manual", Date.now(), "owner");
  const pressed = ownedChat.messages.findLast((message) => message.role === "user");
  assert.deepEqual([pressed.author, pressed.also], [undefined, ["m_blake"]]);
  assert.match(pressed.text, /Read the owner's mail and put it here\./);
  assert.deepEqual(ws.accessForTurn(ownedChat, {}), { member: true, skills: false, mcp: false, plugins: false });
  assert.deepEqual(ws.turnPeople(ownedChat).people, ["owner", "m_blake"], "and the bot's tools reach only the spaces that both can open");
  // Three people: the panel is one member's, another set its routine, a third presses Refresh. The narrowest limits of all apply.
  const roles = structuredClone(team.roles);
  t.after(() => void (team.roles = roles));
  team.roles.find((role) => role.id === "r_maker").perms.skills = ["use"];
  team.roles.find((role) => role.id === "r_maker").perms.mcp = ["use"];
  team.roles.find((role) => role.id === "r_pip").perms.skills = ["use"];
  const makers = { member: true, skills: true, mcp: true, plugins: false };
  const pips = { member: true, skills: true, mcp: false, plugins: false };
  assert.deepEqual([ws.accessForTurn({ createdBy: "m_avery" }, {}), ws.accessForTurn({ createdBy: "m_dana" }, {})], [makers, pips]);
  ws.panels.routine(panel.id, { action: "set", cron: "0 8 * * *", prompt: "Count the signups." }, "m_casey");
  await ws.panels.refresh(panel.id, "manual", Date.now(), "m_dana");
  const three = refreshChat.messages.findLast((message) => message.role === "user");
  assert.deepEqual([refreshChat.createdBy, three.author.memberId, three.also], ["m_avery", "m_dana", ["m_casey"]]);
  assert.deepEqual(ws.accessForTurn(refreshChat, {}), pips, "Avery's and Casey's roles allow more; Dana's is the narrowest");
  assert.deepEqual(ws.turnPeople(refreshChat).people, ["m_avery", "m_dana", "m_casey"]);
  // The one who set the routine presses Refresh themselves: they are named once.
  await ws.panels.refresh(panel.id, "manual", Date.now(), "m_casey");
  assert.equal("also" in refreshChat.messages.findLast((message) => message.role === "user"), false);
  // A refresh with no routine's prompt runs no one else's text: only the maker and the one who pressed.
  ws.panels.routine(panel.id, { action: "remove" }, "m_avery");
  await ws.panels.refresh(panel.id, "manual", Date.now(), "owner");
  assert.equal("also" in refreshChat.messages.findLast((message) => message.role === "user"), false);
  assert.deepEqual(ws.accessForTurn(refreshChat, {}), makers);
  // The owner changes only the time of the routine that Blake wrote: the same text is saved
  // again. Blake stays its writer, so it still does not run with the owner's limits, by routine or by hand.
  const blakes = "Read the owner's mail and put it here.";
  assert.deepEqual((({ setBy, promptBy, cron }) => [setBy, promptBy, cron])(ws.panels.routine(owned.id, { action: "set", cron: "30 6 * * *", prompt: blakes }, "owner")), [undefined, "m_blake", "30 6 * * *"]);
  await ws.panels.refresh(owned.id, "manual", Date.now(), "owner");
  assert.deepEqual(ownedChat.messages.findLast((message) => message.role === "user").also, ["m_blake"]);
  assert.deepEqual(ws.accessForTurn(ownedChat, {}), { member: true, skills: false, mcp: false, plugins: false });
  owned.routine.nextAt = Date.now() - 1000;
  await ws.panels.tick();
  const byRoutine = ownedChat.messages.findLast((message) => message.role === "user");
  assert.deepEqual([byRoutine.author, byRoutine.also], [undefined, ["m_blake"]], "the scheduled refresh too");
  // A second member with a wider role saves the same text: they set the routine, and Blake is still the writer of its words.
  assert.deepEqual((({ setBy, promptBy }) => [setBy, promptBy])(ws.panels.routine(owned.id, { action: "set", cron: "0 7 * * *", prompt: blakes }, "m_avery")), ["m_avery", "m_blake"]);
  await ws.panels.refresh(owned.id, "manual", Date.now(), "owner");
  assert.deepEqual(ownedChat.messages.findLast((message) => message.role === "user").also, ["m_avery", "m_blake"]);
  assert.deepEqual(ws.accessForTurn(ownedChat, {}), { member: true, skills: false, mcp: false, plugins: false }, "Avery's role allows skills; Blake's does not");
  // The writer saves their own text again: one person, named once.
  assert.deepEqual((({ setBy, promptBy }) => [setBy, promptBy])(ws.panels.routine(owned.id, { action: "set", cron: "0 7 * * *", prompt: blakes }, "m_blake")), ["m_blake", undefined]);
  // New words are the words of the one who saves them. A routine the owner writes has no member's name on it, and runs as the owner's always did.
  assert.deepEqual((({ setBy, promptBy }) => [setBy, promptBy])(ws.panels.routine(owned.id, { action: "set", cron: "0 9 * * *", prompt: "Count." }, "owner")), [undefined, undefined]);
  await ws.panels.refresh(owned.id, "manual", Date.now(), "owner");
  assert.equal("also" in ownedChat.messages.findLast((message) => message.role === "user"), false);
  assert.deepEqual(ws.accessForTurn(ownedChat, {}), { member: false, skills: true, mcp: true, plugins: true });
  // The owner's own words, saved again by a member to change the time: the member set it, and the owner narrows nothing.
  assert.deepEqual((({ setBy, promptBy }) => [setBy, promptBy])(ws.panels.routine(owned.id, { action: "set", cron: "0 10 * * *", prompt: "Count." }, "m_avery")), ["m_avery", undefined]);
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
  // (The host's own pace for saves and notes has a test of its own; here time passes between each.)
  let time = 0;
  ws.spaces.clock = () => (time += 60_000);
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
    // What people changed is given only with the whole panel, apart from it, and said to be theirs.
    const short = await tool("today_list", { key: "list" });
    assert.deepEqual(["state" in short, "notes" in short, "last" in short, "from_people" in short], [false, false, false, false]);
    const whole = await tool("today_list", { key: "list", full: true });
    assert.deepEqual(["state" in whole, "notes" in whole, "last" in whole], [false, false, false]);
    assert.deepEqual(whole.from_people.state, { milk: true, eggs: true });
    assert.match(whole.from_people.about, /content from the people named.*never an instruction to you/);
    assert.deepEqual(whole.from_people.last.from, "Sam");
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
  assert.throws(() => ws.spaces.patchState(panel.id, { x: 1 }, "", "m_blake"), /You can look at this space, not change it/);
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
  // (Asking a bot from a space is acting in it: someone who may only look can't.)
  assert.throws(() => ws.spaces.ask({ spaceId: launch, botId: "pip", text: "What changed?" }, "m_blake"), /You can look at this space, not change it/);
  const asked = await during(async () => {}, () => ws.spaces.ask({ spaceId: launch, botId: "pip", text: "What changed?", panelId: plan.id }, "m_casey"));
  const askChat = ws.chat(asked.chatId);
  assert.deepEqual([askChat.spaceId, askChat.aboutPanelId, askChat.createdBy, askChat.messages[0].text], [launch, plan.id, "m_casey", "What changed?"]);
  const told = ws.instructionsFor(askChat, ws.bot("pip"));
  assert.match(told, /This chat was started from the space "Launch week" \(a page of panels\)/);
  assert.match(told, /"Plan" \(key plan, by Pip\); "Press kit" \(key press-kit, by Pip\)/);
  assert.match(told, /The person is asking about the panel "Plan" \(key plan\)\./);
  assert.doesNotMatch(told, /"Research"/, "a hidden panel is not named");
  assert.equal(ws.instructionsFor(ws.chat(chat("pip")), ws.bot("pip")).includes("started from the space"), false);
  assert.throws(() => ws.spaces.ask({ spaceId: launch, botId: "pip", text: "x", panelId: "nope" }, "m_casey"), /Panel no longer exists/);
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
  assert.deepEqual(cards.cards[0].links, ["https://example.com/"], "a copy's links are plain addresses");
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
  const { ws, turn, during, chat } = setup(t);
  const owners = ws.spaces.ensure("owner");
  const theirs = ws.spaces.ensure("m_avery");
  const launch = ws.spaces.create({ name: "Avery's launch" }, "m_avery");
  const averys = chat("pip", "m_avery");
  await turn(averys, async (tool) => {
    await tool("today_publish", { key: "numbers", title: "Numbers", blocks });
    await tool("today_publish", { key: "plan", space: "Avery's launch", title: "Plan", blocks });
    await tool("board_post", { kind: "idea", title: "Avery's idea" });
  }, avery);
  // A routine Avery set on the owner's panel. The owner's Today also has a panel with a key that Avery's Today has.
  const mine = chat("pip");
  await turn(mine, async (tool) => {
    await tool("today_publish", { key: "revenue", title: "Revenue", blocks });
    await tool("today_publish", { key: "numbers", title: "The owner's numbers", blocks });
  });
  const revenue = ws.state.panels.find((panel) => panel.key === "revenue");
  ws.panels.routine(revenue.id, { action: "set", cron: "0 8 * * *", prompt: "Count." }, "m_avery");
  ws.spaces.note(revenue.id, "Looks right", { id: "m_avery", name: "Avery" });
  ws.spaces.memberRemoved("m_avery");
  // The space they made is the owner's now. Their four built-in ones are gone, and what was in them is in the owner's.
  assert.equal(ws.spaces.get(launch).createdBy, undefined);
  assert.equal(ws.spaces.all.some((space) => Object.values(theirs).some((gone) => gone.id === space.id)), false);
  assert.equal(ws.spaces.all.filter((space) => space.builtin).length, 4);
  const numbers = ws.state.panels.find((panel) => panel.title === "Numbers");
  assert.deepEqual([numbers.spaceId, numbers.createdBy, ws.state.panels.find((panel) => panel.key === "plan").spaceId], [owners.today.id, undefined, launch]);
  // Two panels of one bot can't have one key in one space: the one that came over has the next free key, and still refreshes.
  assert.deepEqual(ws.spaces.panels(owners.today.id).filter((panel) => panel.botId === "pip").map((panel) => [panel.title, panel.key]).sort(), [["Numbers", "numbers-2"], ["Revenue", "revenue"], ["The owner's numbers", "numbers"]]);
  let refreshed;
  await during(
    async (tool) => void (refreshed = await tool("today_publish", { key: "numbers-2", revision: numbers.revision, title: "Numbers", blocks })),
    () => (ws.panels.refresh(numbers.id, "manual", Date.now(), "owner"), { chatId: numbers.refreshChatId }),
  );
  assert.deepEqual([refreshed.key, numbers.revision], ["numbers-2", 2]);
  assert.equal(ws.state.board[0].spaceId, owners.ideas.id);
  // The routine they set is paused. Its prompt is still their text, so it keeps them as its writer: run again as it is, it does not get the owner's limits.
  assert.deepEqual([revenue.routine.enabled, revenue.routine.nextAt, revenue.routine.setBy], [false, null, "m_avery"]);
  await ws.panels.refresh(revenue.id, "manual", Date.now(), "owner");
  assert.deepEqual(ws.chat(revenue.refreshChatId).messages.findLast((message) => message.role === "user").also, ["m_avery"]);
  // Once the team no longer has them, such a refresh cannot write the panel, and it says what to do about it.
  const members = team.members;
  t.after(() => void (team.members = members));
  team.members = members.filter((member) => member.id !== "m_avery");
  let said;
  await during(
    async (tool) => void (said = await failure(tool("today_publish", { key: "revenue", revision: revenue.revision, title: "Revenue", blocks }))),
    () => (ws.panels.refresh(revenue.id, "manual", Date.now(), "owner"), { chatId: revenue.refreshChatId }),
  );
  assert.match(said, /written by someone who is no longer on the team.*Set the routine again/);
  // The owner sets it again: it is the owner's, and it writes.
  ws.panels.routine(revenue.id, { action: "set", cron: "0 8 * * *", prompt: "Count again." }, "owner");
  await during(
    async (tool) => void (said = await tool("today_publish", { key: "revenue", revision: revenue.revision, title: "Revenue", blocks })),
    () => (ws.panels.refresh(revenue.id, "manual", Date.now(), "owner"), { chatId: revenue.refreshChatId }),
  );
  assert.equal(said.key, "revenue");
  team.members = members;
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

test("a member's routine that sends its result to Feed, Ideas or Goals puts the card in that member's own space", async (t) => {
  const { ws, chat } = setup(t);
  const owners = ws.spaces.ensure("owner");
  const averys = ws.spaces.ensure("m_avery");
  // A finished run of a routine, as the routines' own code hands it over (desktop/routines.mjs, deliver).
  const run = (chatId, id, entry) => {
    const routines = ws.chat(chatId);
    routines.schedules = [{ id, routine: true, name: "Morning news", ...entry }];
    routines.messages.push({ role: "assistant", text: "Three things today\n\nOne, two, three.", runId: "run-" + id });
    const done = { id: "run-" + id, scheduleId: id, status: "Completed" };
    ws.panels.routines.deliver(routines, done);
    return [done.detail, ws.state.board.find((card) => card.id === done.delivery?.itemId)?.spaceId];
  };
  assert.deepEqual(run(chat("pip", "m_avery"), 1, { deliver: { to: "feed" }, createdBy: "m_avery" }), [undefined, averys.feed.id], "not the owner's Feed");
  assert.deepEqual(run(chat("pip", "m_avery"), 2, { deliver: { to: "idea" } }), [undefined, averys.ideas.id], "a routine with no maker of its own is its chat's maker's");
  assert.deepEqual(run(chat("pip"), 3, { deliver: { to: "goal", category: "career" } }), [undefined, owners.goals.id], "the owner's routine: the owner's Goals, as before");
  // A routine of someone who is no longer on the team is not delivered, and makes no spaces for them.
  const before = ws.state.spaces.length;
  assert.deepEqual(run(chat("pip", "m_gone"), 4, { deliver: { to: "feed" } }), ["Not delivered: That person is no longer on the team.", undefined]);
  assert.equal(ws.state.spaces.length, before);
});

test("a member can't read a card by mentioning it once its space is not theirs to open", async (t) => {
  const { ws, chat, shared } = setup(t);
  const launch = ws.spaces.create({ name: "Launch" }, "owner");
  // A card in the owner's own space of cards, by a bot the member's role shows them.
  const card = ws.board.post("pip", { kind: "feed", title: "Board minutes", body: "PRIVATE-NUMBERS", links: [] }, ws.spaces.ensure("owner").feed.id);
  const averys = ws.chat(chat("pip", "m_avery"));
  const mention = [{ kind: "board", id: card.id }];
  const read = (who) => ws.mentions.resolve(averys, mention, who);
  // Shared with Avery: the card can be mentioned, and its text goes with the message.
  shared[card.spaceId] = { m_avery: "view" };
  assert.equal(read(avery).list.length, 1);
  assert.match(read(avery).context, /PRIVATE-NUMBERS/);
  // The share is taken back. Avery still holds the card's id: it is no longer there for them.
  shared[card.spaceId] = {};
  assert.deepEqual([read(avery).list, read(avery).context.includes("PRIVATE-NUMBERS")], [[], false]);
  // Another member, who never could open it, the same; the owner, as before.
  assert.deepEqual(read(blake).list, []);
  assert.equal(read(undefined).list.length, 1);
  // A card whose space is gone is the owner's alone.
  shared[launch] = { m_avery: "edit" };
  const loose = ws.board.post("pip", { kind: "idea", title: "Loose" }, launch);
  loose.spaceId = "s_gone";
  assert.deepEqual(ws.mentions.resolve(averys, [{ kind: "board", id: loose.id }], avery).list, []);
});

test("a bot is told of a space's panels only as the people of the chat see them", async (t) => {
  const { ws, turn, during, chat, shared } = setup(t);
  const launch = ws.spaces.create({ name: "Launch" }, "owner");
  shared[launch] = { m_dana: "edit", m_casey: "edit" };
  for (const [botId, key] of [["pip", "plan"], ["scout", "research"]]) {
    const id = chat(botId);
    ws.chat(id).spaceId = launch;
    await turn(id, async (tool) => void (await tool("today_publish", { key, title: key === "plan" ? "Plan" : "Research", blocks })));
  }
  // Dana's role shows them one bot. In Dana's chat the other bot's panel is not named, and not counted.
  let seen;
  const danas = await during(async (tool) => void (seen = await tool("space_list")), () => ws.spaces.ask({ spaceId: launch, botId: "pip", text: "What is here?" }, "m_dana"));
  const told = ws.instructionsFor(ws.chat(danas.chatId), ws.bot("pip"));
  assert.match(told, /Its panels: "Plan" \(key plan, by Pip\)\. /);
  assert.doesNotMatch(told, /"Research"/);
  assert.deepEqual(seen.filter((space) => space.id === launch).map((space) => space.panels), [1]);
  // Casey's role shows both.
  const caseys = await during(async (tool) => void (seen = await tool("space_list")), () => ws.spaces.ask({ spaceId: launch, botId: "pip", text: "What is here?" }, "m_casey"));
  assert.match(ws.instructionsFor(ws.chat(caseys.chatId), ws.bot("pip")), /"Plan" \(key plan, by Pip\); "Research" \(key research, by Scout\)/);
  assert.deepEqual(seen.filter((space) => space.id === launch).map((space) => space.panels), [2]);
});

test("the host itself holds one person to a pace on one panel's saved state and notes", async (t) => {
  const { ws, turn, chat, shared } = setup(t);
  let now = 0;
  ws.spaces.clock = () => now;
  const mine = chat("pip");
  await turn(mine, async (tool) => {
    await tool("today_publish", { key: "list", title: "Checklist", blocks, state: {} });
    await tool("today_publish", { key: "other", title: "Other", blocks, state: {} });
  });
  const [list, other] = ws.state.panels;
  shared[list.spaceId] = { m_avery: "edit", m_casey: "edit" };
  // Ten changes at once, and no more: a client that does not keep the window's rule cannot make the host write without end.
  for (let n = 0; n < PACE.state.burst; n++) ws.spaces.patchState(list.id, { ["k" + n]: n }, "", "m_avery");
  const rev = list.stateRev;
  assert.throws(() => ws.spaces.patchState(list.id, { more: 1 }, "", "m_avery"), /Wait a moment before you change this panel again\./);
  assert.deepEqual([list.stateRev, "more" in list.state], [rev, false], "a refused change changes nothing");
  // The pace is one person's on one panel: another person, and another panel, go on.
  ws.spaces.patchState(list.id, { casey: 1 }, "", "m_casey");
  ws.spaces.patchState(other.id, { avery: 1 }, "", "m_avery");
  // One more each second.
  now += 999;
  assert.throws(() => ws.spaces.patchState(list.id, { more: 1 }, "", "m_avery"), /Wait a moment/);
  now += 1;
  ws.spaces.patchState(list.id, { more: 1 }, "", "m_avery");
  assert.throws(() => ws.spaces.patchState(list.id, { again: 1 }, "", "m_avery"), /Wait a moment/);
  // After a while, the ten again, and never more than ten.
  now += 60 * 60_000;
  for (let n = 0; n < PACE.state.burst; n++) ws.spaces.patchState(list.id, { ["k" + n]: -n }, "", "m_avery");
  assert.throws(() => ws.spaces.patchState(list.id, { again: 1 }, "", "m_avery"), /Wait a moment/);
  // Notes: five at once, then one every five seconds. A note that is refused for its length uses none of them.
  assert.throws(() => ws.spaces.note(list.id, "", "m_avery"), /Invalid note/);
  for (let n = 0; n < PACE.note.burst; n++) ws.spaces.note(list.id, "note " + n, "m_avery");
  assert.throws(() => ws.spaces.note(list.id, "one more", "m_avery"), /Wait a moment before you write another note\./);
  assert.equal(list.notes.length, PACE.note.burst);
  now += PACE.note.every;
  ws.spaces.note(list.id, "one more", "m_avery");
  // What a bot publishes is not a person's change and has no pace.
  await turn(mine, async (tool) => {
    for (let n = 0; n < 15; n++) await tool("today_publish", { key: "list", revision: list.revision, title: "Checklist", blocks, state: { n } });
  });
  assert.deepEqual(list.state, { n: 14 });
});

test("a copy for a link is never given over its limit: pages go first, then a panel's other content, then cards", async (t) => {
  const { ws, turn, chat } = setup(t);
  const noise = (length) => randomBytes(length * 0.75).toString("base64");
  const packed = (copy) => gzipSync(JSON.stringify(copy)).length;
  const big = ws.spaces.create({ name: "Big" }, "owner");
  const id = chat("pip");
  ws.chat(id).spaceId = big;
  await turn(id, async (tool) => {
    await tool("today_publish", { key: "page", title: "Page", blocks: [{ type: "html", html: "<p>" + noise(30000) + "</p>" }] });
    // No page here: the size is in what people saved and in the text.
    await tool("today_publish", { key: "state", title: "State", blocks: [{ type: "markdown", text: noise(8000) }], state: { saved: noise(40000) } });
    await tool("today_publish", { key: "small", title: "Small", blocks: [{ type: "markdown", text: "Kept" }] });
  });
  const whole = packed(ws.spaces.snapshot(big));
  // A little too large: the page goes, and the rest stays as it is.
  const first = ws.spaces.snapshot(big, { limit: whole - 2000 });
  assert.deepEqual(first.panels.map((panel) => [panel.title, panel.left, panel.blocks.length, "state" in panel]), [["Page", "size", 0, false], ["State", undefined, 1, true], ["Small", undefined, 1, false]]);
  assert.ok(packed(first) <= whole - 2000);
  // Too large with no page left: the largest panel keeps its title and says that it is left out, and the copy fits.
  const second = ws.spaces.snapshot(big, { limit: 3000 });
  assert.deepEqual(second.panels.map((panel) => [panel.title, panel.left, panel.blocks.length, "state" in panel]), [["Page", "size", 0, false], ["State", "size", 0, false], ["Small", undefined, 1, false]]);
  assert.ok(packed(second) <= 3000);
  // Cards: the largest go first, until it fits.
  const feed = ws.spaces.ensure("owner").feed.id;
  for (let n = 0; n < 6; n++) ws.board.post("pip", { kind: "feed", title: "Card " + n, body: noise(n === 3 ? 3500 : 300) }, feed);
  const all = ws.spaces.snapshot(feed);
  const cut = ws.spaces.snapshot(feed, { limit: packed(all) - 1000 });
  assert.deepEqual(cut.cards.map((card) => card.title).sort(), ["Card 0", "Card 1", "Card 2", "Card 4", "Card 5"]);
  assert.ok(packed(cut) <= packed(all) - 1000);
  // What cannot be made to fit is refused with a sentence. It is not returned over its limit.
  assert.throws(() => ws.spaces.snapshot(big, { limit: 50 }), /This space is too large to share by link\./);
  assert.throws(() => ws.spaces.snapshot(feed, { limit: 50 }), /too large to share by link/);
  // A copy that fits is not touched.
  assert.deepEqual(ws.spaces.snapshot(big, { limit: whole }), ws.spaces.snapshot(big));
});

test("a workspace file with an entry that is no space starts, and a chat of someone who left the team makes no spaces for them", async (t) => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify({ bots: starterBots, chats: [], runs: [], panels: [], board: [], spaces: [null, "s_text", 7, { name: "No id" }, { id: "s_kept000000", name: "Kept", createdAt: 1, updatedAt: 1, rev: 1 }] }));
  const ws = new Workspace(dir, fakeClient().client, () => {}, { team: () => team });
  assert.deepEqual(ws.state.spaces.map((space) => space.name), ["Kept", "Today", "Feed", "Ideas", "Goals"]);
  // Someone who is on no team started this chat (a member who was removed): their bot's panel goes nowhere, and nothing is made in their name.
  const { ws: live, turn, chat } = setup(t);
  const gone = chat("pip", "m_gone");
  const before = live.state.spaces.length;
  let said;
  await turn(gone, async (tool) => void (said = await failure(tool("today_publish", { key: "x", title: "X", blocks }))));
  assert.match(said, /The role of the person this is for doesn't allow that/);
  assert.deepEqual([live.state.spaces.length, live.state.panels.length], [before, 0]);
});
