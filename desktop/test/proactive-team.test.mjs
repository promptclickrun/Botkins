// A bot's Proactive agent for a team ("proactive-team-v1"): one bot looks out for several people. Each person has
// their own check, routine, gate state and delivery; an alert built from one person's evidence reaches only that
// person; who may change what; the setup steps; what an alert offers to take care of; and the earlier shape.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, starterBots } from "./starter.mjs";
import { botProactiveField, defaultProactive, migrateProactive, peopleField, signals, PROACTIVE_TEAM } from "../desktop/proactive.mjs";
import { deviceCall } from "../desktop/device-call.mjs";
import { dispatch } from "../desktop/routines.mjs";
import { decide as desktopNote, Notifier } from "../desktop/notify.mjs";
import { authorize, defaultTeam, filterParts, ownerParts } from "../desktop/link/team.mjs";
import { ownerWindowView } from "../desktop/admin-view.mjs";
import { routineName } from "../desktop/proactive.mjs";
import { controlApi } from "../desktop/terminal/control.mjs";
import { LinkHost } from "../desktop/link/index.mjs";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 22, 18);

function setup(t, { team, dir = mkdtempSync(join(tmpdir(), "botkins-proactive-team-")), before } = {}) {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  before?.(dir);
  const seen = { prompts: [], options: [], reply: "[SILENT]" };
  const handlers = new Set();
  const session = {
    on: (h) => (handlers.add(h), () => handlers.delete(h)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      seen.prompts.push(prompt);
      const answer = typeof seen.reply === "function" ? await seen.reply(prompt, seen.options.at(-1)) : seen.reply;
      const id = "m" + seen.prompts.length;
      for (const h of handlers) h({ type: "user.message", id, data: { messageId: id } });
      for (const h of handlers) h({ type: "assistant.message", data: { originatingMessageId: id, content: answer } });
      for (const h of handlers) h({ type: "session.idle", data: { mode: "interactive" } });
      return id;
    },
  };
  const client = async () => ({ createSession: async (options) => { seen.options.push(options); return session; }, resumeSession: async () => session, deleteSession: async () => {} });
  const ws = new Workspace(dir, client, () => {}, { team: () => team ?? null });
  return { ws, seen, dir };
}

const role = (id, name, agents, bots) => ({ id, name, perms: { agents, today: ["view", "use"], skills: ["read"], mcp: ["view"], plugins: ["view"], settings: ["view", "manage"] }, bots });
/** Avery manages pip. Blake only sees pip. Casey's role sees no bot. */
const team = () => {
  const base = defaultTeam();
  return {
    ...base,
    name: "Studio",
    roles: [...base.roles, role("r_mgr", "Manager", ["view", "chat", "manage"], ["pip"]), role("r_see", "Viewer", ["view", "chat"], ["pip"])],
    groups: [...base.groups, { id: "g_mgr", name: "Managers", roleId: "r_mgr" }, { id: "g_see", name: "Viewers", roleId: "r_see" }],
    members: [
      { id: "m_avery", name: "Avery", groupId: "g_mgr", joinedAt: 1, deviceIds: [] },
      { id: "m_blake", name: "Blake", groupId: "g_see", joinedAt: 1, deviceIds: [] },
      { id: "m_casey", name: "Casey", groupId: "g_everyone", joinedAt: 1, deviceIds: [] },
    ],
  };
};
const member = (id, name) => ({ kind: "member", memberId: id, name });
const avery = member("m_avery", "Avery");
const blake = member("m_blake", "Blake");
const casey = member("m_casey", "Casey");
const owner = { kind: "owner" };

const packet = (prompt) => JSON.parse(prompt.split("\n\n").at(-2));
const candidate = (title, refs, extra = {}) => ({ title, refs, method: "alert", why: "This affects the next step.", next: "Check the details today.", ...extra });
const proposal = (title, extra) => (prompt) => JSON.stringify({ candidates: [candidate(title, [packet(prompt)[0]?.id], extra)] });
const tick = (ws, botId, person = "owner", trigger = "scheduled") => {
  const { chat, entry } = ws.proactive.routine(botId, person);
  return dispatch(ws, chat, entry, trigger);
};
const failedRun = (ws, id, chatId, title) => ws.state.runs.unshift({ id, chatId, scheduleId: 9, status: "Needs you", title, time: Date.now(), finished: Date.now() });
const managed = (ws) => ws.panels.routines.list().filter(({ entry }) => entry.proactive);
/** A chat of a bot that a person started. */
const chatOf = (ws, botId, person) => {
  const id = ws.createChat(botId);
  if (person !== "owner") ws.chat(id).createdBy = person;
  return id;
};
/** What finishing the setup steps saves. */
const wizard = (people, more = {}) => ({ setUp: true, enabled: true, people: Object.fromEntries(people.map((id) => [id, { on: true, notify: true }])), sweepHours: 0, ...more });

// ── The settings and the earlier shape ──────────────────────────────────────────────────────────

test("the computer's switch starts on, and a bot does nothing until its setup steps are finished", async (t) => {
  assert.equal(defaultProactive.enabled, true);
  assert.equal(botProactiveField({}).setUp, false);
  assert.deepEqual(botProactiveField({}).people, {});
  const { ws, seen } = setup(t);
  assert.equal(ws.state.settings.proactive.enabled, true, "a new computer has the switch on");
  ws.proactive.setBot("pip", { enabled: true, people: { owner: { on: true } } });
  assert.equal(managed(ws).length, 0, "on, but not set up: no routine, so no model is used");
  assert.equal(ws.proactive.active("pip", "owner"), false);
  failedRun(ws, "bad", ws.createChat("pip"), "Bills");
  ws.proactive.setBot("pip", { setUp: true });
  assert.equal(managed(ws).length, 1);
  seen.reply = proposal("Bills is failing.");
  await tick(ws, "pip");
  assert.equal(seen.prompts.length, 1);
});

test("people are checked whole: a patch changes only what it names and null takes a person out", () => {
  assert.deepEqual(peopleField({ owner: {} }), { owner: { on: true, notify: true } });
  assert.deepEqual(peopleField({ owner: { notify: false } }, { owner: { on: false, notify: true }, m_a: { on: true, notify: true } }), { owner: { on: false, notify: false }, m_a: { on: true, notify: true } });
  assert.deepEqual(peopleField({ m_a: null }, { owner: { on: true, notify: true }, m_a: { on: true, notify: true } }), { owner: { on: true, notify: true } });
  assert.throws(() => peopleField({ owner: { on: "yes" } }), /on or off/);
  assert.throws(() => peopleField({ owner: { tell: "m_a" } }), /Unknown setting for a person/, "nobody is told of another person's alerts");
  assert.throws(() => peopleField([]), /who/);
  assert.deepEqual(botProactiveField({ every: 60 }, { people: { owner: { on: true, notify: false } } }).people, { owner: { on: true, notify: false } });
});

test("the earlier shape: one person becomes the people, their state moves with them, and only a bot that really ran is set up", () => {
  const running = migrateProactive(
    { enabled: true, bots: { pip: { enabled: true, person: "m_avery", every: 60, sweepHours: 0, maxPerDay: 6, deliver: "chat", watch: ["runs"], instructions: "Be brief." }, scout: { enabled: false, person: "owner" } } },
    { bots: { pip: { chatId: "c1", seen: { "run:a": 5 }, pings: 2, day: "2026-11-22", log: [{ at: 1, runId: "r" }], learning: { history: [], weights: {} } } } },
  );
  assert.equal(running.settings.enabled, true);
  assert.deepEqual(running.settings.bots.pip.people, { m_avery: { on: true, notify: true } });
  assert.equal(running.settings.bots.pip.setUp, true, "the switch was on and the bot was on: it goes on running");
  assert.equal("person" in running.settings.bots.pip, false);
  assert.equal(running.settings.bots.pip.instructions, "Be brief.");
  assert.deepEqual(running.settings.bots.scout.people, { owner: { on: false, notify: true } });
  assert.equal(running.settings.bots.scout.setUp, false);
  assert.deepEqual(running.state.bots.pip.people.m_avery.seen, { "run:a": 5 });
  assert.equal(running.state.bots.pip.people.m_avery.chatId, "c1");
  assert.equal(running.state.bots.pip.people.m_avery.pings, 2);
  assert.equal(running.state.bots.pip.seen, undefined, "nothing of the gate stays on the bot");

  const paused = migrateProactive({ enabled: false, bots: { pip: { enabled: true, person: "owner", every: 15 } } }, { bots: {} });
  assert.equal(paused.settings.enabled, true, "the computer's switch becomes on");
  assert.equal(paused.settings.bots.pip.enabled, true);
  assert.equal(paused.settings.bots.pip.setUp, false, "it was on while the switch was off: it waits for its setup steps");
  assert.deepEqual(paused.settings.bots.pip.people, { owner: { on: true, notify: true } });

  const single = migrateProactive({ enabled: true, botId: "scout", every: 15, deliver: "feed" }, { chatId: "c9", seen: { k: 1 } });
  assert.deepEqual(single.settings.bots.scout.people, { owner: { on: true, notify: true } });
  assert.equal(single.settings.bots.scout.setUp, true);
  assert.equal(single.state.bots.scout.people.owner.chatId, "c9");

  for (const result of [running, paused, single]) assert.deepEqual(migrateProactive(result.settings, result.state), result, "migrating twice changes nothing");
  const off = migrateProactive({ ...running.settings, enabled: false }, running.state);
  assert.equal(off.settings.enabled, false, "once brought over, the owner's own Off is kept");
  assert.equal(migrateProactive(undefined, undefined).settings.enabled, true);
  assert.deepEqual(migrateProactive("nope", 5).settings, { enabled: true, bots: {} });
});

test("a saved workspace from before is brought over: the routine and its history are kept", (t) => {
  const { ws } = setup(t, {
    before: (dir) => {
      const entry = { id: 1, routine: true, proactive: true, enabled: true, name: "Proactive agent", prompt: "x", cadence: { kind: "custom", cron: "*/30 * * * *" }, cron: "*/30 * * * *", timezone: "UTC", recurring: true, nextAt: Date.now() + 60_000, createdAt: 1, deliver: { to: "chat" } };
      const chat = { id: "c1", botId: "pip", title: "Routine · Proactive agent", time: 1, messages: [], established: false, lastScheduleId: 1, schedules: [entry] };
      writeFileSync(join(dir, "workspace.json"), JSON.stringify({ bots: starterBots, chats: [chat], runs: [], settings: { autoSummarize: 0, proactive: { enabled: true, bots: { pip: { enabled: true, person: "owner", every: 30, sweepHours: 0, maxPerDay: 6, deliver: "chat", watch: ["runs"], instructions: "" } } } }, proactive: { bots: { pip: { chatId: "c1", seen: { "run:a": 5 }, log: [] } } } }));
    },
  });
  assert.equal(ws.proactive.active("pip", "owner"), true);
  assert.equal(managed(ws).length, 1, "the routine is kept, not made again");
  assert.equal(ws.proactive.routine("pip", "owner").chat.id, "c1");
  assert.equal(ws.proactive.inStep(), false, "the scheduler sees that the routine still has its earlier name");
  ws.proactive.sync();
  assert.equal(ws.proactive.inStep(), true);
  assert.equal(managed(ws).length, 1);
  assert.doesNotMatch(managed(ws)[0].entry.name, /Proactive agent/, "its routine is named for the bot");
  assert.match(managed(ws)[0].entry.name, /^Pip looks out for /);
});

// ── Several people ──────────────────────────────────────────────────────────────────────────────

test("one bot looks out for several people: each has their own routine, gate state and cap", async (t) => {
  const { ws, seen } = setup(t, { team: team() });
  ws.proactive.setBot("pip", wizard(["owner", "m_avery", "m_blake"], { maxPerDay: 3 }));
  assert.equal(managed(ws).length, 3);
  assert.deepEqual(managed(ws).map(({ chat }) => chat.createdBy ?? "owner").sort(), ["m_avery", "m_blake", "owner"]);
  assert.deepEqual(managed(ws).map(({ entry }) => entry.name).sort(), ["Pip looks out for Avery", "Pip looks out for Blake", "Pip looks out for you"]);

  failedRun(ws, "a", chatOf(ws, "pip", "m_avery"), "Avery report");
  failedRun(ws, "o", chatOf(ws, "pip", "owner"), "Owner payroll");
  seen.reply = proposal("Something needs you.");
  await tick(ws, "pip", "m_avery");
  await tick(ws, "pip", "owner");
  await tick(ws, "pip", "m_blake");
  assert.equal(seen.prompts.length, 2, "Blake has nothing waiting: no model is used for Blake");
  const gates = ws.state.proactive.bots.pip.people;
  assert.equal(gates.m_avery.pings, 1);
  assert.equal(gates.owner.pings, 1);
  assert.deepEqual(Object.keys(gates.m_avery.seen), ["run:a"]);
  assert.deepEqual(Object.keys(gates.owner.seen), ["run:o"]);
  assert.equal(gates.m_avery.log.length, 1);
  assert.equal(gates.m_blake?.log?.length ?? 0, 0);

  gates.m_avery.pings = 3;
  failedRun(ws, "a2", chatOf(ws, "pip", "m_avery"), "Avery backups");
  failedRun(ws, "o2", chatOf(ws, "pip", "owner"), "Owner backups");
  await tick(ws, "pip", "m_avery");
  assert.equal(seen.prompts.length, 2, "Avery is at the cap for the day");
  await tick(ws, "pip", "owner");
  assert.equal(seen.prompts.length, 3, "the owner is not");
});

test("privacy: an alert built from one person's evidence reaches only that person", async (t) => {
  const { ws, seen } = setup(t, { team: team() });
  ws.memory.save("pip", "PRIVATE owner memory");
  ws.proactive.setBot("pip", wizard(["owner", "m_avery", "m_blake"]));
  const ownerChat = chatOf(ws, "pip", "owner");
  const averysChat = chatOf(ws, "pip", "m_avery");
  const blakesChat = chatOf(ws, "pip", "m_blake");
  failedRun(ws, "a", averysChat, "Avery report");
  failedRun(ws, "b", blakesChat, "Blake expenses");
  failedRun(ws, "o", ownerChat, "Owner payroll");
  ws.interactions.snapshot = () => [
    { id: "q1", kind: "question", title: "Avery question", chatId: averysChat, time: Date.now() - HOUR },
    { id: "q2", kind: "question", title: "Blake question", chatId: blakesChat, time: Date.now() - HOUR },
  ];

  seen.reply = (prompt) => JSON.stringify({ candidates: [candidate("Your report failed.", [packet(prompt).find((e) => /report/.test(e.text)).id])] });
  await tick(ws, "pip", "m_avery");
  assert.match(seen.prompts[0], /Avery report/);
  assert.match(seen.prompts[0], /Avery question/);
  assert.doesNotMatch(seen.prompts[0], /Blake|Owner|payroll|PRIVATE/, "nothing of another person's is in Avery's check");
  const told = (chatId) => ws.chat(chatId).messages.filter((m) => m.role === "assistant").map((m) => m.text).join("\n");
  assert.match(told(averysChat), /^Your report failed\./);
  assert.equal(told(blakesChat), "");
  assert.equal(told(ownerChat), "");
  const run = ws.state.runs.find((r) => r.proactive);
  assert.equal(ws.chat(run.chatId).createdBy, "m_avery", "the check ran in Avery's own routine");
  assert.equal(ws.notifiesOwner(run.chatId), false, "the owner is not told of it");
  assert.equal(ws.inChat(run.delivery.chatId, "m_blake"), false);

  // A reply that cites what only another person's check was given is refused: it is not in this check's evidence.
  const averysFact = packet(seen.prompts[0])[0].id;
  seen.reply = () => JSON.stringify({ candidates: [candidate("Avery's report failed.", [averysFact])] });
  await tick(ws, "pip", "m_blake");
  assert.match(seen.prompts[1], /Blake expenses/);
  assert.doesNotMatch(seen.prompts[1], /Avery/);
  assert.equal(told(blakesChat), "", "an alert from someone else's evidence is never delivered");
  assert.equal(ws.state.proactive.bots.pip.people.m_blake.log[0].outcome, "silent");

  // Look-around reads the computer's own accounts: only the owner's check may.
  ws.proactive.setBot("pip", { sweepHours: 1 });
  assert.equal(ws.proactive.wake("pip", "manual", Date.now(), "m_avery").sweep, false);
  assert.equal(ws.proactive.wake("pip", "manual", Date.now(), "owner").sweep, true);
});

test("notify off delivers quietly: the alert is in the person's chat with no notification", async (t) => {
  const { ws, seen } = setup(t, { team: team() });
  ws.proactive.setBot("pip", wizard(["owner", "m_avery"]));
  ws.proactive.setBot("pip", { people: { m_avery: { notify: false } } });
  assert.equal(ws.proactive.routine("pip", "m_avery").entry.notify, false);
  // Pausing a person's routine from Routines is their own switch, so the scheduler leaves it paused.
  ws.panels.routines.setEnabled(ws.proactive.routine("pip", "owner").chat.id, null, false);
  assert.equal(ws.proactive.config("pip").people.owner.on, false);
  assert.equal(ws.proactive.inStep(), true);
  ws.panels.routines.setEnabled(ws.proactive.routine("pip", "owner").chat.id, null, true);
  assert.equal(ws.proactive.config("pip").people.owner.on, true);
  assert.notEqual(ws.proactive.routine("pip", "owner").entry.notify, false);
  const averysChat = chatOf(ws, "pip", "m_avery");
  failedRun(ws, "a", averysChat, "Avery report");
  seen.reply = proposal("Your report failed.");
  await tick(ws, "pip", "m_avery");
  assert.match(ws.chat(averysChat).messages.at(-1).text, /^Your report failed\./, "still delivered");
  const run = ws.state.runs.find((r) => r.proactive);
  assert.equal(desktopNote({ type: "turn", chat: ws.chat(run.chatId), run, bot: ws.bot("pip") }, { settings: ws.state.settings, focused: false, mine: true }), null);
});

test("a proactive check never takes routine notify targets: no override tool, and saved targets are ignored", async (t) => {
  const { ws, seen } = setup(t, { team: team() });
  ws.proactive.setBot("pip", wizard(["owner", "m_avery"]));
  const { chat, entry } = ws.proactive.routine("pip", "m_avery");
  // Targets saved on Avery's routine would tell the owner about Avery's evidence.
  entry.notifyTargets = { people: ["owner"], devices: [] };
  const names = ws.panels.routines.tools(ws.bot("pip"), chat, { id: "r1", chatId: chat.id, scheduleId: entry.id, trigger: "scheduled", proactive: true }, { stopped: false }).map((tool) => tool.name);
  assert.ok(!names.includes("routine_notify"), "a proactive check can't choose who hears of it");
  const averysChat = chatOf(ws, "pip", "m_avery");
  failedRun(ws, "a", averysChat, "Avery report");
  seen.reply = proposal("Your report failed.");
  await tick(ws, "pip", "m_avery");
  const run = ws.state.runs.find((r) => r.proactive);
  assert.equal(ws.resolveRoutineTargets(ws.chat(run.chatId), run), null);
  // The owner's computer is not Avery's: no notification there, whatever targets were saved.
  const resolved = ws.resolveRoutineTargets(ws.chat(run.chatId), run);
  assert.equal(desktopNote({ type: "turn", chat: ws.chat(run.chatId), run, bot: ws.bot("pip") }, { settings: ws.state.settings, focused: false, mine: false, resolved }), null);
});

// ── Who may change what ─────────────────────────────────────────────────────────────────────────

test("the link lets a member who sees a bot reach its Proactive agent, and nobody else", () => {
  const t = team();
  const bots = ["pip", "scout"].map((id) => ({ id }));
  const call = (principal, method, ...args) => authorize(principal, t, method, args, { bot: (id) => bots.find((bot) => bot.id === id) });
  assert.equal(call(owner, "setBotProactive", "scout", { enabled: true }), "");
  assert.equal(call(avery, "setBotProactive", "pip", { people: { m_avery: { on: true } } }), "");
  assert.equal(call(blake, "setBotProactive", "pip", { people: { m_blake: { notify: false } } }), "", "a role that only sees the bot may reach its own entry");
  assert.match(call(blake, "setBotProactive", "scout", {}), /isn't available to your team role/);
  assert.match(call(casey, "setBotProactive", "pip", {}), /isn't available to your team role/);
  assert.match(call(avery, "setPreferences", { proactive: { enabled: false } }), /display preferences only/, "the computer's switch is the owner's");
  assert.equal(call(blake, "proactiveAct", "pip", "run-1", "later"), "");
  assert.match(call(casey, "proactiveAct", "pip", "run-1", "later"), /isn't available to your team role/);
});

test("the host enforces it: the owner sets anyone, a member only their own entry, and only a managing role adds itself", async (t) => {
  const current = team();
  const { ws } = setup(t, { team: current });
  const handlers = { setBotProactive: (...args) => ws.proactive.setBot(...args) };
  const call = deviceCall({ workspace: ws, handlers, folders: {} });
  const set = (principal, bot, patch) => call("setBotProactive", [bot, patch], { principal });
  const people = () => ws.proactive.config("pip").people;

  // The owner adds anyone whose role sees the bot, and nobody else.
  await set(owner, "pip", wizard(["owner", "m_blake"]));
  assert.deepEqual(Object.keys(people()).sort(), ["m_blake", "owner"]);
  await assert.rejects(set(owner, "pip", { people: { m_casey: { on: true } } }), /Casey's team role can't see this bot/);
  await assert.rejects(set(owner, "pip", { people: { m_ghost: { on: true } } }), /not on the team/);

  // A member who only sees the bot: their own entry, once the owner added them.
  await set(blake, "pip", { people: { m_blake: { notify: false } } });
  assert.deepEqual(people().m_blake, { on: true, notify: false });
  await set(blake, "pip", { people: { m_blake: { on: false } } });
  assert.equal(people().m_blake.on, false, "they opt out");
  assert.equal(ws.proactive.routine("pip", "m_blake").entry.enabled, false);
  await assert.rejects(set(blake, "pip", { people: { owner: { on: false } } }), /only your own/);
  await assert.rejects(set(blake, "pip", { people: { m_avery: { on: true } } }), /only your own/);
  await assert.rejects(set(blake, "pip", { every: 15 }), /can't change this bot's Proactive settings/);
  await assert.rejects(set(blake, "pip", { enabled: false }), /can't change this bot's Proactive settings/);
  await assert.rejects(set(blake, "pip", { setUp: false }), /can't change this bot's Proactive settings/);
  // Taken out by the owner, they can't put themselves back: their role doesn't manage the bot.
  await set(owner, "pip", { people: { m_blake: null } });
  await assert.rejects(set(blake, "pip", { people: { m_blake: { on: true } } }), /can't add you/);
  assert.equal(ws.proactive.routine("pip", "m_blake"), null, "their routine went with them");

  // A member whose role manages the bot adds themselves and changes the shared settings, but never look-around or another person.
  await set(avery, "pip", { people: { m_avery: { on: true } }, every: 60 });
  assert.deepEqual(people().m_avery, { on: true, notify: true });
  assert.equal(ws.proactive.config("pip").every, 60);
  await assert.rejects(set(avery, "pip", { sweepHours: 3 }), /Only the owner/);
  await assert.rejects(set(avery, "pip", { people: { owner: null } }), /only your own/);
  await assert.rejects(set(avery, "pip", { enabled: false }), /Only the owner can turn this bot's Proactive agent off/);
  await set(avery, "pip", { watch: ["runs", "requests"] });
  assert.deepEqual(ws.proactive.config("pip").watch, ["runs", "requests", "tasks"], "the tasks watch stays as the owner set it");
  await assert.rejects(set(avery, "scout", { people: { m_avery: { on: true } } }), /can't see this bot/);
  // Forgetting, from a member, takes only that member out.
  await set(avery, "pip", null);
  assert.deepEqual(Object.keys(people()), ["owner"]);
  // A member who doesn't see the bot may do nothing.
  await assert.rejects(set(casey, "pip", { people: { m_casey: { on: true } } }), /can't see this bot/);

  // A managing member sets up a bot nobody has: it never looks around, and tasks stay the owner's.
  current.roles.find((r) => r.id === "r_mgr").bots = ["pip", "scout"];
  await set(avery, "scout", { setUp: true, enabled: true, people: { m_avery: { on: true } } });
  assert.equal(ws.proactive.config("scout").sweepHours, 0);
  assert.equal(ws.proactive.config("scout").watch.includes("tasks"), false);
  assert.equal(ws.proactive.active("scout", "m_avery"), true);

  // A role that no longer sees the bot pauses that person's check, and brings it back with the role.
  await set(owner, "pip", { people: { m_blake: { on: true } } });
  current.roles.find((r) => r.id === "r_see").bots = [];
  assert.equal(ws.proactive.inStep(), false, "the scheduler sees the role change");
  assert.equal(ws.proactive.wake("pip", "manual", Date.now(), "m_blake"), null, "and even before it does, the check doesn't wake");
  ws.proactive.sync();
  assert.equal(ws.proactive.inStep(), true);
  assert.equal(ws.proactive.routine("pip", "m_blake").entry.enabled, false);
  assert.equal(ws.proactive.active("pip", "m_blake"), false);
  current.roles.find((r) => r.id === "r_see").bots = ["pip"];
  ws.proactive.sync();
  assert.equal(ws.proactive.routine("pip", "m_blake").entry.enabled, true);

  // The owner's null forgets everything.
  await set(owner, "pip", null);
  assert.equal(ws.proactive.config("pip"), undefined);
  assert.equal(managed(ws).filter(({ chat }) => chat.botId === "pip").length, 0);
});

test("a member is sent the shared settings and only their own entry and activity", async (t) => {
  const current = team();
  const { ws, seen } = setup(t, { team: current });
  ws.proactive.setBot("pip", wizard(["owner", "m_avery", "m_blake"], { instructions: "Skip newsletters." }));
  ws.proactive.setBot("scout", wizard(["owner"]));
  failedRun(ws, "a", chatOf(ws, "pip", "m_avery"), "Avery report");
  failedRun(ws, "o", chatOf(ws, "pip", "owner"), "Owner payroll");
  seen.reply = proposal("PRIVATE alert words");
  await tick(ws, "pip", "m_avery");
  await tick(ws, "pip", "owner");
  const parts = { bots: [{ id: "pip" }, { id: "scout" }], chats: [], proactive: ws.snapshot().proactive, settings: ws.state.settings };
  const sees = (principal) => filterParts(parts, principal, current).proactive;

  const averys = sees(avery);
  assert.deepEqual(Object.keys(averys.bots), ["pip"], "only the bots the role sees");
  assert.deepEqual(averys.bots.pip.people, { m_avery: { on: true, notify: true } }, "only their own entry");
  assert.equal(averys.bots.pip.instructions, "Skip newsletters.");
  assert.equal(averys.bots.pip.setUp, true);
  assert.equal(averys.bots.pip.log.length, 1);
  assert.match(averys.bots.pip.log[0].said, /PRIVATE alert words/, "their own log");
  assert.equal(averys.bots.pip.pings, 1);
  assert.equal("activity" in averys.bots.pip, false);
  assert.equal("seen" in averys.bots.pip, false);

  const blakes = sees(blake);
  assert.deepEqual(blakes.bots.pip.people, { m_blake: { on: true, notify: true } });
  assert.equal(JSON.stringify(blakes).includes("PRIVATE"), false, "nothing another person was told");
  assert.equal(blakes.bots.pip.log?.length ?? 0, 0);
  assert.equal(JSON.stringify(sees(casey).bots), "{}", "a role that doesn't see the bot is sent none");

  // The owner: everyone's entry and the owner's own activity. Another person's activity only with Admin mode on.
  const full = ws.snapshot().proactive.bots.pip;
  assert.deepEqual(Object.keys(full.people).sort(), ["m_avery", "m_blake", "owner"]);
  assert.equal(full.log.length, 1);
  assert.equal(full.activity.m_avery.log.length, 1);
  const cut = ownerParts({ ...parts, live: {}, runs: [] }, current).proactive.bots.pip;
  assert.equal("activity" in cut, false);
  assert.deepEqual(Object.keys(cut.people).sort(), ["m_avery", "m_blake", "owner"]);
});

test("only the owner can resume a bot they paused, including after loading its settings", (t) => {
  const { ws } = setup(t, { team: team() });
  ws.proactive.setBot("pip", wizard(["owner", "m_avery"], { sweepHours: 3 }));
  ws.proactive.setBot("pip", { enabled: false });
  assert.throws(() => ws.proactive.setBot("pip", { enabled: true }, "m_avery"), /The owner paused this bot's Proactive agent/);
  ws.proactive.setBot("pip", { people: { m_avery: { notify: false } } }, "m_avery");
  const saved = migrateProactive(ws.state.settings.proactive, ws.state.proactive);
  assert.equal(saved.settings.bots.pip.pausedBy, "owner");
  assert.equal(ws.proactive.active("pip", "owner"), false);
  assert.equal(ws.proactive.active("pip", "m_avery"), false);
  ws.proactive.setBot("pip", { enabled: true });
  assert.equal(ws.proactive.config("pip").pausedBy, undefined);
  assert.equal(ws.proactive.active("pip", "owner"), true);
  assert.equal(ws.proactive.config("pip").sweepHours, 3);
  assert.ok(ws.proactive.config("pip").watch.includes("tasks"));
  assert.throws(() => ws.proactive.setBot("pip", { pausedBy: "owner" }, "m_avery"), /Unknown Proactive agent setting/);
});

test("revoking agents.view while retaining the bot in the role stops the member's check", async (t) => {
  const current = team();
  const { ws, seen } = setup(t, { team: current });
  ws.proactive.setBot("pip", wizard(["m_avery"]));
  failedRun(ws, "a", chatOf(ws, "pip", "m_avery"), "Avery report");
  const role = current.roles.find((role) => role.id === "r_mgr");
  role.perms.agents = [];
  await tick(ws, "pip", "m_avery", "manual");
  assert.equal(seen.prompts.length, 0);
  assert.equal(ws.proactive.active("pip", "m_avery"), false);
  role.perms.agents = ["view"];
  await tick(ws, "pip", "m_avery", "manual");
  assert.equal(seen.prompts.length, 1);
});

test("an alert is not delivered when agents.view is revoked after the check decides", async (t) => {
  const current = team();
  const { ws, seen } = setup(t, { team: current });
  ws.proactive.setBot("pip", wizard(["m_avery"]));
  const evidenceChat = chatOf(ws, "pip", "m_avery");
  failedRun(ws, "a", evidenceChat, "Avery report");
  seen.reply = proposal("Private report alert.");
  const routines = ws.panels.routines;
  const deliver = routines.deliver.bind(routines);
  routines.deliver = (...args) => {
    current.roles.find((role) => role.id === "r_mgr").perms.agents = [];
    return deliver(...args);
  };
  await tick(ws, "pip", "m_avery");
  assert.equal(ws.chat(evidenceChat).messages.length, 0);
  assert.equal(ws.state.runs.find((run) => run.proactive).delivery, undefined);
});

// ── What it watches ─────────────────────────────────────────────────────────────────────────────

test("signals: a routine run that failed, and a turn that stopped with open plan steps", () => {
  const state = {
    runs: [
      { id: "s1", chatId: "c", status: "Stopped", stoppedOpen: true, plan: { open: 2 }, title: "Launch plan", finished: NOW - HOUR },
      { id: "f1", chatId: "d", scheduleId: 1, status: "Failed", title: "Bills", detail: "Gmail expired", finished: NOW - HOUR },
      { id: "f2", chatId: "d", scheduleId: 1, status: "error", title: "Backups", finished: NOW - 2 * HOUR },
      { id: "f3", chatId: "d", scheduleId: 1, status: "Failed", title: "Old", finished: NOW - 30 * HOUR },
      { id: "s2", chatId: "e", status: "Stopped", stoppedOpen: true, plan: { open: [{ title: "a" }] }, title: "Earlier", finished: NOW - 3 * HOUR },
      { id: "e2", chatId: "e", status: "Completed", title: "Went on", finished: NOW - 2 * HOUR },
      { id: "s3", chatId: "g", status: "Stopped", title: "No plan", finished: NOW - HOUR },
      { id: "s4", chatId: "h", status: "Stopped", stoppedOpen: true, plan: { open: 0 }, title: "Nothing left", finished: NOW - HOUR },
      { id: "ok", chatId: "d", scheduleId: 1, status: "Completed", title: "Fine", finished: NOW - HOUR },
    ],
  };
  const all = { run: () => true, task: () => true, request: () => true };
  const found = signals(state, [], ["runs"], NOW, all);
  assert.deepEqual(found.map((s) => s.key), ["stopped:s1", "run:f1", "run:f2"], "the turn that went on afterwards, and one with nothing left, are not raised");
  assert.match(found[0].text, /stopped with 2 steps left/);
  assert.match(found[1].text, /Routine “Bills” failed/);
  assert.deepEqual(signals(state, [], ["requests"], NOW, all), []);
  assert.deepEqual(signals(state, [], ["runs"], NOW, { ...all, run: (run) => run.chatId === "d" }).map((s) => s.key), ["run:f1", "run:f2"]);
});

// ── Offers ──────────────────────────────────────────────────────────────────────────────────────

test("taking an alert starts a fresh private turn, and Not now brings an alert back a day later", async (t) => {
  const { ws, seen } = setup(t, { team: team() });
  ws.proactive.setBot("pip", wizard(["owner", "m_avery"]));
  const averysChat = chatOf(ws, "pip", "m_avery");
  failedRun(ws, "a", averysChat, "Avery report");
  seen.reply = proposal("Your report failed.", { offer: { label: "Run the report again", prompt: "Run my weekly report again and tell me what failed." } });
  await tick(ws, "pip", "m_avery");
  assert.match(seen.prompts[0], /"offer"/, "the check is asked for one thing the bot can do");
  assert.match(seen.prompts[0], /Read and draft only/, "the check itself changes nothing");
  const alert = ws.chat(averysChat).messages.at(-1);
  assert.equal(alert.alert.offer, "Run the report again");
  assert.equal(alert.alert.runId, alert.proactiveRunId);
  assert.equal(JSON.stringify(alert).includes("weekly report again"), false, "the prompt stays on the computer until it is taken");
  const runId = alert.proactiveRunId;

  // Only the person it was for may act on it.
  assert.throws(() => ws.proactive.act("pip", runId, "take", "owner"), /no longer available/);
  assert.throws(() => ws.proactive.act("pip", runId, "take", "m_blake"), /no longer available/);
  assert.throws(() => ws.proactive.act("pip", runId, "sing", "m_avery"), /Choose/);

  seen.reply = "On it.";
  const sent = ws.proactive.act("pip", runId, "take", "m_avery");
  await sent.turn;
  assert.notEqual(sent.chatId, averysChat);
  const work = ws.chat(sent.chatId);
  assert.equal(work.title, alert.alert.offer);
  assert.equal(work.createdBy, "m_avery");
  assert.deepEqual(ws.chatPeople(work.id).invited, []);
  assert.equal(work.schedules, undefined);
  assert.doesNotMatch(JSON.stringify(work.messages), /Your report failed/);
  assert.doesNotMatch(seen.prompts[1], /Your report failed/);
  const asked = work.messages.find((m) => m.role === "user" && /weekly report again/.test(m.text));
  assert.deepEqual(asked.author, { memberId: "m_avery", name: "Avery" }, "the turn is the member's own, under their limits");
  const run = ws.state.runs.find((r) => r.id === asked.runId);
  assert.equal(run.proactive, undefined, "a normal turn: its tools and approvals are the chat's");
  assert.equal(run.scheduleId, undefined);
  assert.equal(ws.chat(averysChat).messages.find((m) => m.proactiveRunId === runId).alert.chosen, "take");
  assert.throws(() => ws.proactive.act("pip", runId, "take", "m_avery"), /already/);

  // Not now: the same thing is not raised for 24 hours, then comes back.
  failedRun(ws, "a2", averysChat, "Avery backups");
  seen.reply = proposal("Your backups failed.", { offer: { label: "Check the backups", prompt: "Look at why my backups failed." } });
  await tick(ws, "pip", "m_avery");
  const delivered = (prefix) => ws.state.chats.flatMap((chat) => chat.messages).find((message) => message.alert && message.text.startsWith(prefix));
  const second = delivered("Your backups failed.");
  assert.match(second.text, /^Your backups failed\./);
  ws.proactive.act("pip", second.proactiveRunId, "later", "m_avery");
  assert.equal(second.alert.chosen, "later");
  const now = Date.now();
  assert.equal(ws.proactive.wake("pip", "scheduled", now + HOUR, "m_avery"), null, "snoozed");
  const back = ws.proactive.wake("pip", "scheduled", now + 25 * HOUR, "m_avery");
  assert.deepEqual(back?.keys, ["run:a2"], "raised again a day later");

  // An offer that is not one short line and one prompt is left out; the alert is still delivered.
  failedRun(ws, "a3", averysChat, "Avery invoices");
  seen.reply = proposal("Your invoices failed.", { offer: { label: "x".repeat(200), prompt: "" } });
  await tick(ws, "pip", "m_avery");
  const third = delivered("Your invoices failed.");
  assert.match(third.text, /^Your invoices failed\./);
  assert.equal(third.alert.offer, undefined);
  assert.throws(() => ws.proactive.act("pip", third.proactiveRunId, "take", "m_avery"), /nothing to take care of/);
});

test("Not now holds evidence across the recipient's bots, even after the original bot is forgotten", async (t) => {
  const current = team();
  current.roles.find((role) => role.id === "r_mgr").bots.push("scout");
  const { ws, seen } = setup(t, { team: current });
  ws.proactive.setBot("pip", wizard(["m_avery"]));
  ws.proactive.setBot("scout", wizard(["m_avery", "owner"]));
  const chatId = chatOf(ws, "pip", "m_avery");
  failedRun(ws, "a", chatId, "Shared evidence across bots");
  seen.reply = proposal("Report failed.");
  await tick(ws, "pip", "m_avery");
  const { until } = ws.proactive.act("pip", ws.chat(chatId).messages.at(-1).proactiveRunId, "later", "m_avery");
  const held = until - 23 * HOUR;
  assert.equal(ws.proactive.wake("scout", "scheduled", held, "m_avery"), null);
  ws.peopleOf = (id) => ({ invited: id === chatId ? ["owner"] : [] });
  assert.deepEqual(ws.proactive.wake("scout", "scheduled", held, "owner")?.keys, ["run:a"], "the same evidence is still available to someone else");
  ws.proactive.setBot("pip", null);
  ws.state.proactive = migrateProactive(ws.state.settings.proactive, ws.state.proactive).state;
  assert.equal(ws.proactive.wake("scout", "scheduled", held, "m_avery"), null);
  assert.deepEqual(ws.proactive.wake("scout", "scheduled", until, "m_avery")?.keys, ["run:a"]);
});

test("legacy bot pauses and snoozes survive migration without enabling a bot or shortening a snooze", () => {
  const settings = { enabled: false, bots: { pip: { enabled: false, setUp: true }, scout: { enabled: true, setUp: true } } };
  const old = { shape: 3, bots: {
    pip: { people: { m_avery: { snoozed: { "run:a": NOW } }, owner: { snoozed: { "run:a": NOW - HOUR } } } },
    scout: { people: { m_avery: { snoozed: { "run:a": NOW + HOUR } } } },
  } };
  const saved = migrateProactive(settings, old);
  assert.equal(saved.settings.enabled, false);
  assert.deepEqual([saved.settings.bots.pip.enabled, saved.settings.bots.pip.pausedBy], [false, "owner"]);
  assert.equal(saved.settings.bots.scout.pausedBy, undefined);
  assert.deepEqual(saved.state.snoozed, { m_avery: { "run:a": NOW + HOUR }, owner: { "run:a": NOW - HOUR } });
  assert.equal(saved.state.bots.pip.people.m_avery.snoozed, undefined);
  assert.deepEqual(migrateProactive(saved.settings, saved.state), saved);
});

function waitingAlert(t) {
  const current = team();
  const { ws } = setup(t, { team: current });
  const chat = ws.chat(chatOf(ws, "pip", "m_avery"));
  const text = "PRIVATE alert words";
  chat.messages.push({ role: "assistant", text, alert: { runId: "proactive-1" }, proactiveRunId: "proactive-1" }, { role: "user", text: "Please run the report", runId: "working" });
  chat.posted = [{ from: "Pip", text }];
  const request = { kind: "permission", id: "approval", title: "Approve report?", chatId: chat.id };
  ws.interactions.snapshot = () => [request];
  return { ws, current, chat, request };
}

test("the owner approval view redacts alert history in link parts and window IPC, without changing storage", (t) => {
  const { ws, current, chat, request } = waitingAlert(t);
  const part = "chat:" + chat.id;
  const link = { ownerParts: (parts) => ownerParts(parts, current), spacesFor: () => [] };
  const cut = link.ownerParts({ chats: [{ id: chat.id, createdBy: chat.createdBy, last: { text: chat.messages[0].text } }], live: { requests: [request] }, [part]: { id: chat.id, messages: chat.messages } });
  const off = ownerWindowView(ws.snapshot(), link, false);
  for (const view of [[cut.chats, cut[part]], off.chats]) {
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE alert words|proactive-1/);
    assert.match(JSON.stringify(view), /Please run the report/);
  }
  assert.match(JSON.stringify(ownerWindowView(ws.snapshot(), link, true).chats), /PRIVATE alert words/);
  assert.equal(chat.posted[0].text, "PRIVATE alert words");
});

test("the CLI can read enough to answer a member's approval without reading their proactive alerts", async (t) => {
  const { ws, chat } = waitingAlert(t);
  const cli = controlApi({ runtime: { workspace: ws, handlers: {} } });
  const output = await cli["chat.read"]([chat.id], {});
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE alert words/);
  assert.deepEqual(output.messages.map(({ index, text }) => [index, text]), [[1, "Please run the report"]]);
  assert.equal(output.request.id, "approval");
});

test("the host cannot invite anyone into a chat that holds a person's alerts", (t) => {
  const { ws, current, chat } = waitingAlert(t);
  const dir = mkdtempSync(join(tmpdir(), "botkins-proactive-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = new LinkHost({ dir, backend: { snapshot: () => ws.snapshot(), subscribe: () => () => {} }, relay: false });
  link.store.data.team = current;
  assert.throws(() => link.inviteToChat(chat.id, "owner"), /holds one person's alerts and can't be shared/);
  assert.deepEqual(link.chatPeople(chat.id).invited, []);
});

test("a Feed card carries the same actions, and taking care of it starts a turn in the person's own chat", async (t) => {
  const { ws, seen } = setup(t);
  ws.proactive.setBot("pip", wizard(["owner"], { deliver: "feed" }));
  failedRun(ws, "bad", ws.createChat("scout"), "Bills");
  seen.reply = proposal("Bills is failing.", { offer: { label: "Fix the sign-in", prompt: "Help me fix the Gmail sign-in for Bills." } });
  await tick(ws, "pip");
  const card = ws.board.items[0];
  assert.equal(card.alert.offer, "Fix the sign-in");
  assert.doesNotMatch(String(card.source), /Proactive agent/);
  seen.reply = "Let's look.";
  const sent = ws.proactive.act("pip", card.proactiveRunId, "take", "owner");
  await sent.turn;
  const chat = ws.chat(sent.chatId);
  assert.equal(chat.botId, "pip");
  assert.equal(chat.createdBy, undefined);
  assert.ok(chat.messages.some((m) => m.role === "user" && /Gmail sign-in/.test(m.text)));
  assert.equal(ws.board.items[0].alert.chosen, "take");
});

// ── Titles ──────────────────────────────────────────────────────────────────────────────────────

test("a proactive alert's notification is titled with the bot's name alone, never “Proactive agent”", async (t) => {
  assert.equal(PROACTIVE_TEAM, "proactive-team-v1");
  const { ws, seen } = setup(t);
  ws.proactive.setBot("pip", wizard(["owner"]));
  failedRun(ws, "bad", ws.createChat("scout"), "Bills");
  seen.reply = proposal("Bills is failing: the Gmail sign-in expired.");
  await tick(ws, "pip");
  const run = ws.state.runs.find((r) => r.proactive);
  const note = desktopNote({ type: "turn", chat: ws.chat(run.chatId), run, bot: ws.bot("pip") }, { settings: ws.state.settings, focused: false, mine: true });
  assert.equal(note.title, "Pip");
  assert.equal(note.body, "Bills is failing: the Gmail sign-in expired.");
  assert.equal(note.chatId, run.delivery.chatId, "a click opens the alert");
  assert.doesNotMatch(JSON.stringify([note, run.title, ws.chat(run.chatId).title, ws.chat(run.delivery.chatId).messages.at(-1), ws.chat(run.delivery.chatId).posted]), /Proactive agent/);
});

test("the computer's own notification of an alert has the two actions where the system shows buttons, and a click opens the alert", async (t) => {
  const current = team();
  const { ws, seen } = setup(t, { team: current });
  const shown = [];
  class FakeNotification {
    static isSupported = () => true;
    constructor(options) {
      this.options = options;
      this.handlers = {};
      shown.push(this);
    }
    on(name, handler) {
      this.handlers[name] = handler;
    }
    show() {}
  }
  const opened = [];
  const acted = [];
  new Notifier(ws, { Notification: FakeNotification, focused: () => false, open: (chatId) => opened.push(chatId), openSettings() {}, act: (alert, action) => {
    acted.push([alert.botId, alert.runId, action]);
    return action === "take" ? { chatId: "new-work-chat" } : {};
  } });
  ws.proactive.setBot("pip", wizard(["owner", "m_avery"]));
  failedRun(ws, "o", chatOf(ws, "pip", "owner"), "Owner payroll");
  failedRun(ws, "a", chatOf(ws, "pip", "m_avery"), "Avery report");
  seen.reply = proposal("Payroll failed.", { offer: { label: "Run payroll again", prompt: "Run payroll again and tell me what failed." } });
  await tick(ws, "pip", "owner");
  await tick(ws, "pip", "m_avery");
  assert.equal(shown.length, 1, "the computer's notifications are the owner's: a member's alert shows none here");
  const memberRun = ws.state.runs.find((r) => r.proactive && ws.chat(r.chatId).createdBy === "m_avery");
  current.roles.find((role) => role.id === "r_mgr").perms.agents = [];
  ws.notifiesOwner = () => true; // A stale invitation must not cause a member's alert to be shown here.
  ws.events.emit("turn", { chat: ws.chat(memberRun.chatId), run: memberRun });
  assert.equal(shown.length, 1, "no alert is shown if the recipient lost bot access before notification");
  const note = shown[0];
  assert.equal(note.options.title, "Pip");
  assert.equal(note.options.body, "Payroll failed.");
  assert.deepEqual(note.options.actions, [{ type: "button", text: "Take care of it" }, { type: "button", text: "Not now" }]);
  const run = ws.state.runs.find((r) => r.proactive && ws.chat(r.chatId).createdBy === undefined);
  note.handlers.action({}, 1);
  note.handlers.action({}, 0);
  assert.deepEqual(acted, [["pip", run.id, "later"], ["pip", run.id, "take"]]);
  assert.deepEqual(opened, ["new-work-chat"], "taking it opens the new chat where the bot goes to work");
  note.handlers.click();
  assert.deepEqual(opened, ["new-work-chat", run.delivery.chatId]);
});

// ── Found in review ─────────────────────────────────────────────────────────────────────────────

test("the computer's own window, with Admin mode off, is shown no other person's activity or reminders", async (t) => {
  const current = team();
  const { ws, seen } = setup(t, { team: current });
  ws.proactive.setBot("pip", wizard(["owner", "m_avery"]));
  failedRun(ws, "a", chatOf(ws, "pip", "m_avery"), "Avery report");
  seen.reply = proposal("PRIVATE alert words");
  await tick(ws, "pip", "m_avery");
  const link = { ownerParts: (parts) => ownerParts(parts, current), spacesFor: () => [] };
  const state = { ...ws.snapshot(), reminders: [{ key: "request:x", person: "m_avery", title: "Pip is waiting on your answer", body: "PRIVATE question" }, { key: "request:y", person: "owner", title: "Pip is waiting on your answer", body: "Mine" }] };
  const off = ownerWindowView(state, link, false);
  assert.equal("activity" in off.proactive.bots.pip, false);
  assert.equal(JSON.stringify([off.proactive, off.reminders]).includes("PRIVATE"), false);
  assert.deepEqual(Object.keys(off.proactive.bots.pip.people).sort(), ["m_avery", "owner"], "who it looks out for is still shown");
  const on = ownerWindowView(state, link, true);
  assert.match(on.proactive.bots.pip.activity.m_avery.log[0].said, /PRIVATE alert words/, "Admin mode shows everything, as it does for chats");
});

test("a long bot name and a long person's name still make a routine, and one bot that can't be brought in step doesn't stop the rest", (t) => {
  const current = team();
  current.members[0].name = "Avery " + "Longname ".repeat(6).trim();
  const { ws } = setup(t, { team: current });
  ws.updateBot("pip", { name: "Pip the very long named assistant of the studio" });
  assert.ok(routineName(ws.bot("pip"), "m_avery", current).length <= 80);
  ws.proactive.setBot("pip", wizard(["owner", "m_avery"]));
  assert.equal(managed(ws).length, 2);
  assert.equal(ws.proactive.inStep(), true);
  // A bot whose routine can't be made is left for the next look; the others are still brought in step.
  ws.proactive.setBot("scout", wizard(["owner"]));
  const real = ws.panels.routines.fields.bind(ws.panels.routines);
  ws.panels.routines.fields = (data, now) => {
    if (data.botId === "pip") throw new Error("Invalid name");
    return real(data, now);
  };
  ws.proactive.config("pip").every = 15;
  ws.proactive.config("scout").every = 60;
  assert.doesNotThrow(() => ws.proactive.sync());
  assert.equal(ws.proactive.routine("scout").entry.cron, "0 */1 * * *");
});

test("taking an offer needs a role that may chat, a failed start leaves the alert to try again, and Not now also holds a plain reminder back", async (t) => {
  const current = team();
  const { ws, seen } = setup(t, { team: current });
  const bots = [{ id: "pip" }];
  const call = (principal, ...args) => authorize(principal, current, "proactiveAct", args, { bot: (id) => bots.find((bot) => bot.id === id) });
  current.roles.find((r) => r.id === "r_see").perms.agents = ["view"];
  assert.match(call(blake, "pip", "run-1", "take"), /role can't do that/, "starting a turn is chatting");
  assert.equal(call(blake, "pip", "run-1", "later"), "");
  assert.equal(call(avery, "pip", "run-1", "take"), "");

  ws.proactive.setBot("pip", wizard(["owner", "m_blake"]));
  const blakesChat = chatOf(ws, "pip", "m_blake");
  failedRun(ws, "b", blakesChat, "Blake expenses");
  seen.reply = proposal("Your expenses failed.", { offer: { label: "Run them again", prompt: "Run my expenses again." } });
  await tick(ws, "pip", "m_blake");
  const alert = ws.chat(blakesChat).messages.findLast((m) => m.alert);
  assert.throws(() => ws.proactive.act("pip", alert.proactiveRunId, "take", "m_blake"), /role can't chat/, "the host checks it too");

  // A start that fails leaves the alert as it was.
  const ownersChat = chatOf(ws, "pip", "owner");
  failedRun(ws, "o", ownersChat, "Owner payroll");
  seen.reply = proposal("Payroll failed.", { offer: { label: "Run payroll again", prompt: "Run payroll again." } });
  await tick(ws, "pip", "owner");
  const mine = ws.chat(ownersChat).messages.findLast((m) => m.alert);
  const submit = ws.submit.bind(ws);
  ws.submit = () => { throw new Error("Up to 20 messages can wait at once."); };
  assert.throws(() => ws.proactive.act("pip", mine.proactiveRunId, "take", "owner"), /Up to 20/);
  assert.equal(mine.alert.chosen, undefined);
  ws.submit = submit;
  // Not now: no plain reminder for the same thing while it is held back.
  ws.proactive.act("pip", mine.proactiveRunId, "later", "owner");
  const sent = [];
  ws.events.on("reminder", (reminder) => sent.push(reminder.key));
  ws.reminders.tick(Date.now() + 3 * HOUR);
  assert.equal(sent.includes("run:o"), false);
});

test("removing a person's routine turns their check off even when the scheduler looks in between", async (t) => {
  const { ws } = setup(t);
  ws.proactive.setBot("pip", wizard(["owner"]));
  const id = ws.proactive.routine("pip").chat.id;
  const deleteChat = ws.agents.deleteChat.bind(ws.agents);
  ws.agents.deleteChat = async (chatId) => {
    await deleteChat(chatId);
    if (!ws.proactive.inStep()) ws.proactive.sync();
  };
  await ws.panels.routines.remove(id);
  assert.equal(ws.proactive.config("pip").people.owner.on, false);
  assert.equal(ws.proactive.routine("pip"), null, "it is not made again");
});
