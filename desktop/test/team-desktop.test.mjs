import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { Workspace } from "./starter.mjs";
import { decide } from "../desktop/notify.mjs";
import { RemoteHosts } from "../desktop/remotehosts.mjs";
import * as linkClient from "../desktop/remote/link-client.mjs";

const team = {
  name: "Northstar",
  roles: [{
    id: "r_guest",
    name: "Guest",
    perms: {
      agents: ["view", "chat"],
      today: ["view"],
      skills: ["read"],
      mcp: ["view"],
      plugins: ["view"],
      settings: [],
    },
    bots: "all",
  }],
  groups: [{ id: "g_everyone", name: "Everyone", roleId: "r_guest" }],
  members: [{ id: "m_avery", name: "Avery", groupId: "g_everyone", joinedAt: 1, deviceIds: [] }],
  invites: [],
  requests: [],
};

test("member identity prefixes model input without changing the displayed message", async (t) => {
  const fake = fakeClient();
  const ws = new Workspace(tempDir(t), fake.client, () => {}, { team: () => team });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Help with this", {
    author: { memberId: "m_avery", name: "Avery" },
  });

  assert.equal(
    fake.log.sent[0][1],
    "[From Avery, a member of Northstar's team, not the owner]\nHelp with this",
  );
  assert.equal(ws.chat(chatId).messages[0].text, "Help with this");
  const ownerChat = ws.createChat("pip");
  await ws.send(ownerChat, "Owner message");
  assert.equal(fake.log.sent[1][1], "Owner message");
});

test("a member role without use permissions receives no MCP, skills or plugin tools", async (t) => {
  const fake = fakeClient();
  const ws = new Workspace(tempDir(t), fake.client, () => {}, { team: () => team });
  ws.integrations.saveServer({ name: "docs", command: "node" });
  ws.integrations.pluginsFor = () => ["/linked-plugin"];
  ws.plugins.session = async () => ({
    directories: ["/marketplace-plugin"],
    mcpServers: { marketplace: { type: "stdio", command: "plugin" } },
    hooks: [{ event: "agentStop", command: "done" }],
  });
  const chatId = ws.createChat("pip");

  await ws.send(chatId, "Use the available tools", {
    author: { memberId: "m_avery", name: "Avery" },
  });

  const config = [...fake.log.configs.values()][0];
  assert.deepEqual(config.mcp.servers, {});
  assert.deepEqual(config.skills.directories, []);
  assert.deepEqual(config.plugins.directories, []);
  assert.equal(config.hooks, undefined);
  const tools = config.tools.definitions.map((tool) => tool.name);
  assert.ok(!tools.includes("search_plugins"));
  assert.ok(!tools.includes("propose_plugin"));
});

test("a turn runs under the narrower of the chat creator's limits and the writer's", (t) => {
  const fake = fakeClient();
  const full = { member: false, skills: true, mcp: true, plugins: true };
  const none = { member: true, skills: false, mcp: false, plugins: false };
  // A second member whose role may use skills, but nothing else.
  const wider = {
    ...team,
    roles: [...team.roles, { id: "r_skilled", name: "Skilled", perms: { ...team.roles[0].perms, skills: ["read", "use"] }, bots: ["pip"] }],
    groups: [...team.groups, { id: "g_skilled", name: "Skilled", roleId: "r_skilled" }],
    members: [...team.members, { id: "m_blake", name: "Blake", groupId: "g_skilled", joinedAt: 2, deviceIds: [] }],
  };
  const skilled = { member: true, skills: true, mcp: false, plugins: false };
  const ws = new Workspace(tempDir(t), fake.client, () => {}, { team: () => wider });
  const avery = { memberId: "m_avery", name: "Avery" };
  const blake = { memberId: "m_blake", name: "Blake" };
  // A member's chat keeps that member's limits when the owner writes in it.
  const chat = ws.chat(ws.createChat("pip"));
  chat.createdBy = "m_avery";
  chat.messages.push({ role: "user", text: "Owner note", time: Date.now() });
  assert.deepEqual(ws.accessForTurn(chat, {}), none);
  // The owner's chat: full for the owner, and a member invited into it writes under their own limits.
  const ownerChat = ws.chat(ws.createChat("pip"));
  assert.deepEqual(ws.accessForTurn(ownerChat, {}), full);
  assert.deepEqual(ws.accessForTurn(ownerChat, { author: avery }), none);
  assert.deepEqual(ws.accessForTurn(ownerChat, { author: blake }), skilled);
  // Without a turn's author (a session opened to warm it), the last message's writer counts.
  ownerChat.messages.push({ role: "user", text: "From Blake", time: Date.now(), author: blake });
  assert.deepEqual(ws.accessForTurn(ownerChat, {}), skilled);
  ownerChat.messages.push({ role: "user", text: "From the owner", time: Date.now() });
  assert.deepEqual(ws.accessForTurn(ownerChat, {}), full);
  // One member writing in another member's chat gets what both may use, in either direction.
  const blakes = ws.chat(ws.createChat("pip"));
  blakes.createdBy = "m_blake";
  assert.deepEqual(ws.accessForTurn(blakes, { author: blake }), skilled);
  assert.deepEqual(ws.accessForTurn(blakes, { author: avery }), none);
  assert.deepEqual(ws.accessForTurn(chat, { author: blake }), none);
  // Someone who is no longer a member has no optional tools at all.
  assert.deepEqual(ws.accessForTurn(ownerChat, { author: { memberId: "m_gone", name: "Gone" } }), none);
});

test("an invited member's turn in the owner's chat is opened without the owner's tools", async (t) => {
  const fake = fakeClient();
  const ws = new Workspace(tempDir(t), fake.client, () => {}, { team: () => team });
  ws.integrations.saveServer({ name: "docs", command: "node" });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "The owner starts it");
  const first = [...fake.log.configs.values()].at(-1);
  assert.deepEqual(Object.keys(first.mcp.servers), ["docs"], "the owner's turn has the MCP server");
  await ws.send(chatId, "A member continues it", { author: { memberId: "m_avery", name: "Avery" } });
  const second = [...fake.log.configs.values()].at(-1);
  assert.deepEqual(second.mcp.servers, {}, "the session is opened again for the member's turn, without it");
  assert.deepEqual(second.skills.directories, []);
  assert.equal(fake.log.sent.at(-1)[1], "[From Avery, a member of Northstar's team, not the owner]\nA member continues it");
});

test("a chat's people are its creator and whom the link says were invited", (t) => {
  const invited = new Map();
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, { team: () => team, people: (chatId) => ({ createdBy: "ignored", invited: invited.get(chatId) ?? [] }) });
  const owners = ws.createChat("pip");
  const averys = ws.createChat("pip");
  ws.chat(averys).createdBy = "m_avery";
  assert.deepEqual(ws.chatPeople(owners), { createdBy: "owner", invited: [] });
  assert.deepEqual(ws.chatPeople(averys), { createdBy: "m_avery", invited: [] }, "who made a chat is the workspace's own record");
  assert.deepEqual([ws.inChat(owners, "owner"), ws.inChat(owners, "m_avery"), ws.inChat(averys, "m_avery"), ws.inChat(averys, "owner")], [true, false, true, false]);
  invited.set(owners, ["m_avery"]);
  invited.set(averys, ["owner", 7, null]);
  assert.deepEqual(ws.chatPeople(averys), { createdBy: "m_avery", invited: ["owner"] });
  assert.deepEqual([ws.inChat(owners, "m_avery"), ws.inChat(averys, "owner")], [true, true]);
  assert.equal(ws.inChat("no-such-chat", "owner"), false);
  // Whose alerts a chat's are: the owner's when the owner made it or was invited.
  assert.deepEqual([ws.notifiesOwner(owners), ws.notifiesOwner(averys)], [true, true]);
  invited.set(averys, []);
  assert.equal(ws.notifiesOwner(averys), false);
  // A link that answers the question itself is believed; one that fails falls back to the rule.
  const told = new Workspace(tempDir(t), fakeClient().client, () => {}, { notifiesOwner: (chatId) => (chatId === "throws" ? (() => { throw new Error("no"); })() : chatId === "says-no" ? false : undefined) });
  const plain = told.createChat("pip");
  told.chat(plain).createdBy = "m_avery";
  assert.equal(told.notifiesOwner(plain), false, "no answer from the link: the rule");
  assert.equal(told.notifiesOwner("says-no"), false);
  // Without a link at all, a chat has its creator only.
  const alone = new Workspace(tempDir(t), fakeClient().client, () => {});
  const mine = alone.createChat("pip");
  assert.deepEqual([alone.inChat(mine, "owner"), alone.notifiesOwner(mine)], [true, true]);
});

test("the computer's own alerts are for the owner's chats; a request only the owner can answer still alerts", () => {
  const settings = { notifications: { replies: true, routines: true, requests: true, quietHours: { enabled: false, from: "22:00", to: "07:00" } } };
  const context = { settings, focused: false, now: new Date("2026-11-20T12:00:00Z"), timeZone: "UTC" };
  const chat = { id: "c", title: "Plans", messages: [{ role: "assistant", text: "Done.", runId: "r" }] };
  const turn = { type: "turn", bot: { name: "Pip" }, chat, run: { id: "r", chatId: "c", status: "Completed" } };
  assert.equal(decide(turn, context)?.title, "Pip · Plans");
  assert.equal(decide(turn, { ...context, mine: false }), null, "a reply in somebody else's chat");
  assert.equal(decide({ ...turn, run: { ...turn.run, scheduleId: 1, title: "Morning scan" } }, { ...context, mine: false }), null, "nor their routine's result");
  assert.equal(decide({ ...turn, run: { ...turn.run, status: "Needs you", detail: "It failed" } }, { ...context, mine: false }), null);
  const ask = (kind) => ({ type: "request", bot: { name: "Pip" }, request: { kind, title: "Which one?", chatId: "c", askedBy: { memberId: "m_avery", name: "Avery" } } });
  assert.equal(decide(ask("question"), context)?.title, "Pip has a question");
  assert.equal(decide(ask("question"), { ...context, mine: false }), null, "a bot's question is for the chat's people");
  assert.equal(decide(ask("permission"), { ...context, mine: false })?.title, "Pip needs your approval");
  assert.equal(decide(ask("secure"), { ...context, mine: false, focused: true })?.title, "Pip has a question");
});

test("a team member is offered, and may send, only the files of chats they are in", async (t) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const invited = new Map();
  const fake = fakeClient();
  const dir = tempDir(t);
  const ws = new Workspace(dir, fake.client, () => {}, { team: () => team, people: (chatId) => ({ invited: invited.get(chatId) ?? [] }) });
  const files = join(dir, "files", "pip");
  mkdirSync(join(files, "shared"), { recursive: true });
  const put = (name) => (writeFileSync(join(files, name), name), join(files, name));
  const avery = { memberId: "m_avery", name: "Avery" };
  const owners = ws.createChat("pip");
  const averys = ws.createChat("pip");
  ws.chat(averys).createdBy = "m_avery";
  ws.artifacts.record(put("owner-budget.csv"), { botId: "pip", chatId: owners, source: "tool" });
  ws.artifacts.record(put("avery-notes.md"), { botId: "pip", chatId: averys, source: "tool" });
  put("shared/inside.txt");
  ws.artifacts.record(join(files, "shared"), { botId: "pip", chatId: averys, source: "upload" });
  put("never-recorded.txt");
  const projectId = ws.projects.create({ name: "Owner's plan", description: "Private." });
  ws.wiki.write("goals/q4.md", "# Q4\n\nOwner only.\n");
  const item = ws.board.post("pip", { kind: "idea", title: "Try a weekly digest" });
  const names = (list) => list.files.map((file) => file.name).sort();

  // The owner is offered everything, as before.
  const all = ws.mentions.candidates(averys, "pip");
  assert.deepEqual(names(all), ["avery-notes.md", "inside.txt", "never-recorded.txt", "owner-budget.csv"]);
  assert.equal(all.projects.length, 1);
  assert.ok(all.wiki.length >= 1);
  // A member: no project, no wiki page, and only the files of their own chat (a folder shared there counts whole).
  const own = ws.mentions.candidates(averys, "pip", "m_avery");
  assert.deepEqual([own.projects, own.wiki, names(own)], [[], [], ["avery-notes.md", "inside.txt"]]);
  assert.deepEqual(names(ws.mentions.candidates(null, "pip", "m_avery")), ["avery-notes.md", "inside.txt"], "the same before a chat exists");
  assert.deepEqual(names(ws.mentions.candidates(averys, "pip", "m_stranger")), [], "a member in no chat is offered no file");
  // Invited into the owner's chat, they are offered that chat's files too.
  invited.set(owners, ["m_avery"]);
  assert.deepEqual(names(ws.mentions.candidates(owners, "pip", "m_avery")), ["avery-notes.md", "inside.txt", "owner-budget.csv"]);
  invited.set(owners, []);

  // What a member's device sends is cut to the same, whatever it names.
  const sent = [
    { kind: "project", id: projectId },
    { kind: "wiki", path: "goals/q4.md" },
    { kind: "file", path: join(files, "owner-budget.csv") },
    { kind: "file", path: join(files, "never-recorded.txt") },
    { kind: "file", path: join(files, "gone.txt") },
    { kind: "file", path: join(files, "avery-notes.md") },
    { kind: "file", path: join(files, "shared", "inside.txt") },
    { kind: "board", id: item.id },
    { kind: "customer", id: "x" },
  ];
  const kept = ws.mentions.resolve(ws.chat(averys), sent, avery);
  assert.deepEqual(kept.list.map((m) => m.label), ["avery-notes.md", "inside.txt", "Try a weekly digest"]);
  assert.ok(!/Owner|Private|budget|never-recorded/.test(kept.context), "nothing of the owner's is in the prompt");
  // The owner's own message is checked as before: a mention that is wrong is refused, not dropped.
  assert.equal(ws.mentions.resolve(ws.chat(averys), sent.slice(0, 4)).list.length, 4);
  assert.throws(() => ws.mentions.resolve(ws.chat(averys), [{ kind: "customer", id: "x" }]), /Unknown mention/);
  // A Today item of a bot the member's role may not see is left out.
  const narrow = { ...team, roles: [{ ...team.roles[0], bots: ["scout"] }] };
  ws.teamOf = () => narrow;
  assert.deepEqual(ws.mentions.resolve(ws.chat(averys), [{ kind: "board", id: item.id }], avery).list, []);
  ws.teamOf = () => team;

  // End to end: the turn's prompt and the stored message carry only the member's own file.
  await ws.send(averys, "Compare these", { author: avery, mentions: sent });
  assert.ok(fake.log.sent.at(-1)[1].includes("avery-notes.md") && !fake.log.sent.at(-1)[1].includes("owner-budget.csv") && !fake.log.sent.at(-1)[1].includes("Owner's plan"));
  assert.deepEqual(ws.chat(averys).messages.find((m) => m.role === "user").mentions.map((m) => m.label), ["avery-notes.md", "inside.txt", "Try a weekly digest"]);
});

test("a routine a member makes is theirs, runs under their limits and delivers only into their chats", async (t) => {
  const { deviceCall } = await import("../desktop/device-call.mjs");
  const { Folders } = await import("../desktop/folders.mjs");
  const invited = new Map();
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, { team: () => team, people: (chatId) => ({ invited: invited.get(chatId) ?? [] }) });
  const routines = ws.panels.routines;
  const handlers = {
    createRoutine: (data) => routines.create(data),
    updateRoutine: (id, data) => routines.update(id, data),
    duplicateRoutine: (id, botId) => routines.duplicate(id, botId),
    mentionables: (chatId, botId) => ws.mentions.candidates(chatId, botId),
  };
  const call = deviceCall({ workspace: ws, handlers, folders: new Folders({ home: tempDir(t), volumes: [] }) });
  const member = { principal: { kind: "member", memberId: "m_avery", name: "Avery" } };
  const daily = { botId: "pip", name: "Morning scan", prompt: "Scan the news.", cadence: { kind: "daily", time: "09:00" }, timezone: "UTC" };
  const owners = ws.createChat("pip");
  const averys = ws.createChat("pip");
  ws.chat(averys).createdBy = "m_avery";

  // The app says it stamps routines, which is what turns on the link's check of who may change one.
  const { CAPABILITIES, linkCapabilities } = await import("../desktop/runtime.mjs");
  const { ROUTINE_OWNER } = await import("../desktop/routines.mjs");
  assert.equal(ROUTINE_OWNER, "routine-owner-v1");
  assert.ok(CAPABILITIES.includes(ROUTINE_OWNER) && linkCapabilities(new Set()).includes(ROUTINE_OWNER));
  // Made by a member: the routine and its chat say whose it is, and its turns have the member's limits.
  const id = await call("createRoutine", [{ ...daily, createdBy: "m_someone_else" }], member);
  const { chat, entry } = routines.find(id);
  assert.deepEqual([chat.createdBy, entry.createdBy], ["m_avery", "m_avery"], "never what the device sent");
  assert.equal(routines.view(chat, entry).createdBy, "m_avery");
  assert.equal(ws.snapshot().chats.find((c) => c.id === id).schedules[0].createdBy, "m_avery", "in the snapshot, for the link's check");
  assert.deepEqual(ws.accessForTurn(chat, {}), { member: true, skills: false, mcp: false, plugins: false });
  // The owner's own routine carries no name, from the window or from the owner's phone.
  const mine = routines.create({ ...daily, createdBy: "m_avery" });
  assert.deepEqual([routines.find(mine).chat.createdBy, routines.find(mine).entry.createdBy], [undefined, undefined]);
  const fromPhone = await call("createRoutine", [daily], { principal: { kind: "owner" } });
  assert.equal(routines.find(fromPhone).entry.createdBy, undefined);

  // Where the result goes: only a chat the creator is in.
  const toChat = (chatId) => ({ to: "chat", chatId });
  await assert.rejects(call("createRoutine", [{ ...daily, deliver: toChat(owners) }], member), /That chat belongs to someone else/);
  assert.equal(routines.find(await call("createRoutine", [{ ...daily, deliver: toChat(averys) }], member)).entry.deliver.chatId, averys);
  assert.throws(() => routines.create({ ...daily, deliver: toChat(averys) }), /That chat belongs to someone else/, "the owner's routine stays out of a member's chat too");
  assert.throws(() => routines.update(id, { deliver: toChat(owners) }), /That chat belongs to someone else/, "whoever changes it, the creator counts");
  routines.update(id, { deliver: toChat(averys) });
  // Invited into the owner's chat, the member's routine may deliver there.
  invited.set(owners, ["m_avery"]);
  routines.update(id, { deliver: toChat(owners) });
  // ...and no longer once they are taken out: the run says why, and nothing is written into the chat.
  invited.set(owners, []);
  const run = { id: "run-1", scheduleId: entry.id, status: "Completed" };
  chat.messages.push({ role: "assistant", text: "Three headlines.", runId: run.id, time: Date.now() });
  routines.deliver(chat, run);
  assert.match(run.detail, /Not delivered: That chat belongs to someone else/);
  assert.equal(ws.chat(owners).messages.length, 0);
  // "A chat with the bot" without a chosen one is the creator's latest, never another person's.
  routines.update(id, { deliver: { to: "chat" } });
  ws.chat(owners).time = Date.now() + 10_000;
  const next = { id: "run-2", scheduleId: entry.id, status: "Completed" };
  chat.messages.push({ role: "assistant", text: "Two more.", runId: next.id, time: Date.now() });
  routines.deliver(chat, next);
  assert.equal(next.delivery.chatId, averys);
  assert.deepEqual([ws.chat(averys).messages.at(-1).text, ws.chat(owners).messages.length], ["Two more.", 0]);
  // With no chat of theirs for that bot, one is made, and it is theirs.
  const scoutRoutine = await call("createRoutine", [{ ...daily, botId: "scout", deliver: { to: "chat" } }], member);
  const scout = routines.find(scoutRoutine);
  const third = { id: "run-3", scheduleId: scout.entry.id, status: "Completed" };
  scout.chat.messages.push({ role: "assistant", text: "Found it.", runId: third.id, time: Date.now() });
  routines.deliver(scout.chat, third);
  assert.equal(ws.chat(third.delivery.chatId).createdBy, "m_avery");

  // A copy belongs to whoever copies it, and drops a chosen chat they are not in.
  const ownersRoutine = routines.create({ ...daily, deliver: toChat(owners) });
  const copy = routines.find(await call("duplicateRoutine", [ownersRoutine, "pip"], member));
  assert.deepEqual([copy.chat.createdBy, copy.entry.createdBy, copy.entry.deliver], ["m_avery", "m_avery", { to: "chat" }]);
  const ownersCopy = routines.find(routines.duplicate(id, "pip"));
  assert.equal(ownersCopy.entry.createdBy, undefined);

  // A routine a bot makes in a member's turn is that member's.
  const task = { stopped: false, author: { memberId: "m_avery", name: "Avery" } };
  ws.active.set(owners, task);
  t.after(() => ws.active.delete(owners));
  const tools = routines.tools(ws.bot("pip"), ws.chat(owners), { id: "r" }, task);
  await tools.find((tool) => tool.name === "routine_create").handler({ name: "Bot made", instructions: "Check in.", cadence: "daily", time: "08:00", timezone: "UTC" });
  const botMade = ws.state.chats.find((c) => c.schedules?.[0]?.name === "Bot made");
  assert.deepEqual([botMade.createdBy, botMade.schedules[0].createdBy], ["m_avery", "m_avery"]);

  // A member's device asking what can be mentioned is answered as a member.
  assert.deepEqual((await call("mentionables", [averys, "pip"], member)).projects, []);
});

test("a live voice a member starts hears nothing of the owner's notes", async (t) => {
  const { liveContextFor } = await import("../desktop/live-context.mjs");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = tempDir(t);
  const ws = new Workspace(dir, fakeClient().client, () => {}, { team: () => team });
  const chatId = ws.createChat("pip");
  const profile = join(dir, "files", "pip");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "USER.md"), "Name: Robin\n\nPrefers short answers. Lives near the harbour.\n");
  writeFileSync(join(profile, "IDENTITY.md"), "Pip is cheerful.\n");
  const owner = liveContextFor(ws, { chatId, botId: "pip" });
  if (owner.user === undefined) return t.skip("this workspace keeps profile files elsewhere");
  assert.deepEqual([owner.userName, /harbour/.test(owner.user), owner.identity], ["Robin", true, "Pip is cheerful."]);
  assert.deepEqual(liveContextFor(ws, { chatId, botId: "pip", memberId: "m_avery" }), { identity: "Pip is cheerful." });
});

test("a join request notification follows request preferences and opens Team requests", () => {
  const settings = {
    notifications: {
      replies: true,
      routines: true,
      requests: true,
      quietHours: { enabled: false, from: "22:00", to: "07:00" },
    },
  };
  const event = {
    type: "joinRequest",
    request: { id: "q_avery", name: "Avery" },
  };
  const context = {
    settings,
    focused: false,
    now: new Date("2026-11-20T12:00:00Z"),
    timeZone: "UTC",
  };

  assert.deepEqual(decide(event, context), {
    title: "Avery wants to join your team",
    body: "Review the request in Settings › Team.",
    settings: "Team:Requests",
  });
  assert.equal(
    decide({ type: "request", bot: { name: "Pip" }, request: { kind: "permission", title: "Run it", chatId: "chat", askedBy: { memberId: "m_avery", name: "Avery" } } }, {
      ...context,
      focused: true,
    })?.title,
    "Pip needs your approval",
    "a member turn still notifies its owner while the window is focused",
  );
  settings.notifications.requests = false;
  assert.equal(decide(event, context), null);
});

test("team IPC handlers call the LinkHost owner API", async () => {
  const { teamHandlers } = await import("../desktop/team-ipc.mjs");
  const calls = [];
  const returned = {};
  const methods = {
    team: [],
    saveRole: [{ id: "r_custom" }],
    deleteRole: ["r_custom"],
    saveGroup: [{ id: "g_custom" }],
    deleteGroup: ["g_custom", "g_everyone"],
    createInvite: [{ groupId: "g_everyone", days: 7, maxUses: 5 }],
    revokeInvite: ["i_invite"],
    approve: ["q_request", "g_everyone"],
    deny: ["q_request"],
    moveMember: ["m_member", "g_everyone"],
    removeMember: ["m_member"],
    renameTeam: ["Northstar"],
  };
  const host = Object.fromEntries(
    Object.entries(methods).map(([name]) => [
      name,
      (...args) => {
        calls.push([name, args]);
        return returned;
      },
    ]),
  );
  const handlers = teamHandlers(() => host);
  const actions = [
    ["team", "team"],
    ["saveTeamRole", "saveRole"],
    ["deleteTeamRole", "deleteRole"],
    ["saveTeamGroup", "saveGroup"],
    ["deleteTeamGroup", "deleteGroup"],
    ["createTeamInvite", "createInvite"],
    ["revokeTeamInvite", "revokeInvite"],
    ["approveTeamRequest", "approve"],
    ["denyTeamRequest", "deny"],
    ["moveTeamMember", "moveMember"],
    ["removeTeamMember", "removeMember"],
    ["renameTeam", "renameTeam"],
  ];
  for (const [handler, method] of actions) {
    assert.equal(await handlers[handler](...methods[method]), returned);
  }
  assert.deepEqual(calls, actions.map(([, method]) => [method, methods[method]]));
});

test("a desktop join resumes a protocol invite through pending, approved, denied and closed states", async (t) => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return { ok: true };
  };
  let next = { result: { status: "pending", requestId: "q_one", team: { name: "Northstar" } }, attempt: undefined };
  const lib = {
    ...linkClient,
    findInvite: async (fetcher, code, relayBase, serverKey) => {
      await fetcher("invite:" + relayBase + ":" + serverKey);
      return {
        code,
        serverId: "server-one",
        serverKey: "B".repeat(43),
        name: "Northstar",
        hosts: ["127.0.0.1:9876"],
        room: "C".repeat(43),
        relayBase,
      };
    },
    startJoin: async (fetcher, target, device) => {
      await fetcher("join:start:" + device.kind);
      const attempt = { target, device, keys: { publicKey: "D".repeat(43), secretKey: "never-store-plain" } };
      return { ...next, attempt };
    },
    checkJoin: async (fetcher, attempt) => {
      await fetcher("join:check:" + attempt.target.code);
      if (next instanceof Error) throw next;
      return next.result;
    },
  };
  const protectedFile = join(tempDir(t), "remote-hosts.json");
  const protect = {
    wrap: (text) => "sealed:" + Buffer.from(text).toString("base64"),
    unwrap: (text) => Buffer.from(String(text).replace(/^sealed:/, ""), "base64").toString(),
  };
  const remote = new RemoteHosts({
    file: protectedFile,
    protect,
    lib,
    fetch,
    device: { name: "Laptop", platform: "linux" },
  });
  const target = await remote.findTeamInvite("botkins://join?c=ABCDE-FG123&k=" + "B".repeat(43));
  assert.equal(target.code, "ABCDEFG123");
  const pending = await remote.startTeamJoin(target);
  assert.equal(pending.status, "pending");
  assert.match(calls[0], /^invite:/);

  const reopened = new RemoteHosts({ file: protectedFile, protect, lib, fetch, device: { name: "Laptop", platform: "linux" } });
  assert.equal(reopened.teamJoins()[0].status, "pending");
  assert.ok(!readFileSync(protectedFile, "utf8").includes("never-store-plain"));
  const pairing = {
    serverId: "server-one",
    serverKey: "B".repeat(43),
    deviceId: "device-one",
    secretKey: "paired-secret",
    hosts: ["127.0.0.1:9876"],
    name: "Northstar",
    member: true,
  };
  next = { result: { status: "approved", pairing } };
  assert.equal((await reopened.checkTeamJoin(pending.id)).status, "approved");
  assert.equal(reopened.list()[0].member, true);

  next = { result: { status: "pending", requestId: "q_two", team: { name: "Northstar" } } };
  const denied = await reopened.startTeamJoin(target);
  next = { result: { status: "denied" } };
  assert.equal((await reopened.checkTeamJoin(denied.id)).status, "denied");

  next = { result: { status: "pending", requestId: "q_three", team: { name: "Northstar" } } };
  const closed = await reopened.startTeamJoin(target);
  next = Object.assign(new Error("closed"), { code: "join_closed" });
  assert.equal((await reopened.checkTeamJoin(closed.id)).status, "closed");
  assert.equal(reopened.teamJoins().length, 0);
});

test("a member turn labels approval requests for the owner", (t) => {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, { team: () => team });
  const chat = ws.chat(ws.createChat("pip"));
  const task = { stopped: false, author: { memberId: "m_avery", name: "Avery" } };
  const pending = ws.interactions.request(chat, task, {
    kind: "permission",
    title: "Run the command",
  });
  const request = ws.interactions.snapshot()[0];
  assert.deepEqual(request.askedBy, task.author);
  ws.interactions.respond(request.id, { action: "deny" });
  return pending;
});
