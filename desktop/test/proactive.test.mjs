// The Proactive agent (Settings › Experimental, and each bot's profile): the computer's switch, a bot's own
// settings and managed routine, the gate that wakes it, and who a bot's agent works for.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { botProactiveField, cronEvery, migrateProactive, proactiveField, signals } from "../desktop/proactive.mjs";
import { starterBots } from "./starter.mjs";
import { deviceCall } from "../desktop/device-call.mjs";
import { dispatch } from "../desktop/routines.mjs";
import { authorize, defaultTeam, filterParts } from "../desktop/link/team.mjs";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 22, 18);

/** A workspace whose model is a fake: `seen.prompts` are what the bots were woken with, `seen.reply` what they answer. */
function setup(t, { team, dir = mkdtempSync(join(tmpdir(), "botkins-proactive-")), before } = {}) {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  before?.(dir);
  const seen = { prompts: [], reply: "[SILENT]" };
  const handlers = new Set();
  const session = {
    on: (h) => (handlers.add(h), () => handlers.delete(h)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      seen.prompts.push(prompt);
      const id = "m" + seen.prompts.length;
      for (const h of handlers) h({ type: "user.message", id, data: { messageId: id } });
      for (const h of handlers) h({ type: "assistant.message", data: { originatingMessageId: id, content: seen.reply } });
      for (const h of handlers) h({ type: "session.idle", data: { mode: "interactive" } });
      return id;
    },
  };
  const client = async () => ({ createSession: async () => session, resumeSession: async () => session, deleteSession: async () => {} });
  const ws = new Workspace(dir, client, () => {}, { team: () => team ?? null });
  return { ws, seen, dir };
}

/** The routine of a bot's agent, ticking as its clock does. */
const tick = (ws, botId, trigger = "scheduled") => {
  const { chat, entry } = ws.proactive.routine(botId);
  return dispatch(ws, chat, entry, trigger);
};
const failedRun = (ws, id, chatId, title) => ws.state.runs.unshift({ id, chatId, scheduleId: 9, status: "Needs you", title, time: Date.now(), finished: Date.now() });
const managed = (ws) => ws.panels.routines.list().filter(({ entry }) => entry.proactive);

test("the computer's switch and a bot's settings are each checked whole", () => {
  assert.equal(proactiveField({}).enabled, false);
  assert.deepEqual(proactiveField({ enabled: true }, { enabled: false, bots: { pip: { enabled: true } } }), { enabled: true, bots: { pip: { enabled: true } } }, "the switch leaves the bots' settings as they are");
  assert.throws(() => proactiveField({ botId: "pip" }), /Unknown/, "the switch no longer picks a bot");
  assert.equal(botProactiveField({}).enabled, false);
  assert.throws(() => botProactiveField({ every: 7 }), /how often/);
  assert.throws(() => botProactiveField({ nope: 1 }), /Unknown/);
  assert.throws(() => botProactiveField({ person: "owner" }), /Unknown/, "who it is for is never taken from a caller");
  assert.deepEqual(botProactiveField({ watch: ["runs", "runs"] }).watch, ["runs"]);
  assert.equal(cronEvery(15), "*/15 * * * *");
  assert.equal(cronEvery(120), "0 */2 * * *");
});

test("one bot is proactive and another is not: only its routine exists, runs and alerts", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  assert.equal(managed(ws).length, 0, "the switch alone makes no routine");
  ws.proactive.setBot("pip", { enabled: true, every: 15, sweepHours: 0 });
  assert.equal(managed(ws).length, 1);
  assert.equal(managed(ws)[0].chat.botId, "pip");
  assert.equal(managed(ws)[0].entry.cron, "*/15 * * * *");
  assert.equal(ws.proactive.routine("scout"), null);
  assert.throws(() => ws.panels.routines.update(managed(ws)[0].chat.id, { name: "x" }), /Proactive/);

  const chat = ws.createChat("scout");
  failedRun(ws, "bad", chat, "Bills");
  seen.reply = "Bills routine is failing.";
  await tick(ws, "pip");
  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0], /Routine “Bills” needs the person/);
  assert.equal(ws.state.proactive.bots.pip.log[0].outcome, "alerted");
  assert.equal(ws.state.proactive.bots.scout, undefined, "a bot that is not proactive has no gate state");
  assert.deepEqual(ws.snapshot().proactive.bots.scout, undefined);
});

test("each proactive bot keeps its own seen signals, alerts a day, look-around clock and log", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  ws.proactive.setBot("pip", { enabled: true, sweepHours: 0, maxPerDay: 3 });
  ws.proactive.setBot("scout", { enabled: true, sweepHours: 0, maxPerDay: 3 });
  seen.reply = "Something needs you.";
  failedRun(ws, "bad", ws.createChat("patch"), "Bills");

  await tick(ws, "pip");
  assert.equal(seen.prompts.length, 1);
  assert.equal(ws.state.proactive.bots.pip.pings, 1);
  await tick(ws, "scout");
  assert.equal(seen.prompts.length, 1, "what pip already told the person doesn't wake scout as well");
  assert.deepEqual(Object.keys(ws.state.proactive.bots.scout.seen), [], "and isn't written into scout's own list");
  assert.ok(Object.keys(ws.state.proactive.bots.pip.seen).length > 0);

  await tick(ws, "scout", "manual");
  assert.equal(seen.prompts.length, 2, "Check now wakes it whatever the other did");
  assert.equal(ws.state.proactive.bots.scout.pings, 1);
  assert.equal(ws.state.proactive.bots.pip.pings, 1, "its count is its own");
  assert.equal(ws.state.proactive.bots.pip.log.length, 1);
  assert.equal(ws.state.proactive.bots.scout.log.length, 1);

  ws.state.proactive.bots.pip.pings = 3;
  failedRun(ws, "worse", ws.createChat("patch"), "Backups");
  await tick(ws, "pip");
  assert.equal(seen.prompts.length, 2, "pip is at its cap for the day");
  await tick(ws, "scout");
  assert.equal(seen.prompts.length, 3, "scout is not");
});

test("the gate wakes the bot once per signal, sweeps on its clock, and keeps quiet hours and the cap", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  ws.proactive.setBot("pip", { enabled: true, sweepHours: 0, maxPerDay: 3 });
  const go = (trigger) => tick(ws, "pip", trigger);

  await go();
  assert.equal(seen.prompts.length, 0, "nothing new and no sweep: no model");

  failedRun(ws, "bad", ws.createChat("pip"), "Bills");
  await go();
  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0], /\[SILENT\]/);
  assert.equal(ws.state.runs.find((r) => r.proactive).silent, true);
  assert.equal(ws.state.proactive.bots.pip.log[0].outcome, "silent");

  await go();
  assert.equal(seen.prompts.length, 1, "the same signal never wakes it twice");
  await go("manual");
  assert.equal(seen.prompts.length, 2, "Check now always wakes it");

  seen.reply = "Bills routine is failing: Gmail sign-in expired.";
  ws.proactive.setBot("pip", { sweepHours: 1 });
  ws.state.proactive.bots.pip.lastSweepAt = 0;
  await go();
  assert.equal(seen.prompts.length, 3, "a due sweep wakes it");
  assert.match(seen.prompts[2], /inbox, calendar/, "the owner's bot may look at the sources its tools reach");
  assert.equal(ws.state.proactive.bots.pip.log[0].outcome, "alerted");
  assert.equal(ws.state.proactive.bots.pip.pings, 1);
  assert.match(ws.proactive.prompt("pip", "sweep", []), /already told the person[\s\S]*Gmail sign-in expired/);

  ws.state.proactive.bots.pip.pings = 3;
  ws.state.proactive.bots.pip.lastSweepAt = 0;
  await go();
  assert.equal(seen.prompts.length, 3, "the day's cap holds it");

  ws.state.proactive.bots.pip.pings = 0;
  ws.setPreferences({ notifications: { quietHours: { enabled: true, from: "00:00", to: "23:59" } } });
  await go();
  assert.equal(seen.prompts.length, 3, "quiet hours hold it");
});

test("the computer's switch off pauses every proactive bot, and on brings them back as they were", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  ws.proactive.setBot("pip", { enabled: true, every: 60, instructions: "Skip newsletters." });
  ws.proactive.setBot("scout", { enabled: true, every: 15 });
  assert.equal(managed(ws).length, 2);

  ws.setPreferences({ proactive: { enabled: false } });
  assert.deepEqual(managed(ws).map(({ entry }) => entry.enabled), [false, false]);
  assert.equal(ws.proactive.config("pip").enabled, true, "the bot's own switch is untouched");
  assert.equal(ws.proactive.config("pip").instructions, "Skip newsletters.");
  failedRun(ws, "bad", ws.createChat("patch"), "Bills");
  await tick(ws, "pip", "manual");
  assert.equal(seen.prompts.length, 0, "a paused agent doesn't wake, not even for Check now");

  ws.setPreferences({ proactive: { enabled: true } });
  assert.deepEqual(managed(ws).map(({ entry }) => entry.enabled), [true, true]);
  assert.equal(managed(ws).length, 2, "no routine is made twice");
  assert.equal(ws.proactive.routine("scout").entry.cron, "*/15 * * * *");
});

test("a bot's agent is turned off for good by removing its routine, its settings or the bot", async (t) => {
  const { ws } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  ws.proactive.setBot("patch", { enabled: true });
  ws.proactive.setBot("scout", { enabled: true });
  await ws.panels.routines.remove(ws.proactive.routine("patch").chat.id);
  assert.equal(ws.proactive.config("patch").enabled, false, "removing the routine turns that bot's agent off");
  assert.equal(ws.proactive.routine("patch"), null);
  assert.equal(ws.proactive.config("scout").enabled, true, "and no other");

  await ws.agents.deleteBot("scout");
  assert.equal(ws.proactive.config("scout"), undefined);
  assert.equal(ws.state.proactive.bots.scout, undefined);

  ws.proactive.setBot("patch", { enabled: true });
  ws.proactive.setBot("patch", null);
  assert.equal(ws.proactive.config("patch"), undefined, "null forgets a bot's settings");
  assert.equal(ws.proactive.routine("patch"), null);
  assert.throws(() => ws.proactive.setBot("ghost", { enabled: true }), /Unknown bot/);
});

test("the single-bot setting of an earlier version becomes that bot's, with its routine and state kept", (t) => {
  const old = {
    enabled: true, botId: "scout", every: 15, sweepHours: 6, maxPerDay: 10, deliver: "feed", watch: ["runs"], instructions: "Be brief.",
  };
  const { ws } = setup(t, {
    before: (dir) => {
      const entry = { id: 1, routine: true, proactive: true, enabled: true, name: "Proactive agent", prompt: "x", cadence: { kind: "custom", cron: "*/15 * * * *" }, cron: "*/15 * * * *", timezone: "UTC", recurring: true, nextAt: Date.now() + 60_000, createdAt: 1, deliver: { to: "feed" } };
      const chat = { id: "c1", botId: "scout", title: "Routine · Proactive agent", time: 1, messages: [], established: false, lastScheduleId: 1, schedules: [entry] };
      writeFileSync(join(dir, "workspace.json"), JSON.stringify({ bots: starterBots, chats: [chat], runs: [], settings: { autoSummarize: 0, proactive: old }, proactive: { chatId: "c1", seen: { "run:a": 5 }, lastSweepAt: 7, day: "2026-11-22", pings: 2, log: [{ at: 1, reason: "sweep", signals: 0, outcome: "silent", runId: "r" }] } }));
    },
  });
  assert.deepEqual(ws.state.settings.proactive, {
    enabled: true,
    bots: { scout: { enabled: true, person: "owner", every: 15, sweepHours: 6, maxPerDay: 10, deliver: "feed", watch: ["runs"], instructions: "Be brief." } },
  });
  assert.equal(ws.state.proactive.botId, undefined);
  assert.deepEqual(ws.state.proactive.bots.scout.seen, { "run:a": 5 });
  assert.equal(ws.state.proactive.bots.scout.pings, 2);
  assert.equal(ws.state.proactive.bots.scout.chatId, "c1");
  assert.equal(ws.state.proactive.bots.scout.log.length, 1);
  assert.equal(managed(ws).length, 1, "the routine is kept, not made again");
  assert.equal(managed(ws)[0].chat.id, "c1");
  ws.proactive.sync();
  assert.equal(managed(ws).length, 1);
  assert.equal(managed(ws)[0].entry.enabled, true);
});

test("older and damaged shapes are tolerated", () => {
  const mig = (settings, state) => migrateProactive(settings, state);
  assert.deepEqual(mig(undefined, undefined), { settings: { enabled: false, bots: {} }, state: { bots: {} } });
  assert.deepEqual(mig("nope", 5).settings, { enabled: false, bots: {} });
  assert.deepEqual(mig({ enabled: true, botId: 5 }, {}).settings, { enabled: true, bots: {} });
  assert.equal(mig({ enabled: false, botId: "pip", every: 7 }, {}).settings.bots.pip.every, 30, "a value that is no longer valid is the usual one");
  assert.equal(mig({ enabled: false, botId: "pip" }, {}).settings.bots.pip.enabled, false);
  const current = { enabled: true, bots: { pip: { enabled: true, person: "m_a", every: 60 }, bad: 3, other: { every: 999 } } };
  const kept = mig(current, { bots: { pip: { pings: 1 } } });
  assert.equal(kept.settings.bots.pip.person, "m_a");
  assert.equal(kept.settings.bots.pip.every, 60);
  assert.equal(kept.settings.bots.bad, undefined);
  assert.equal(kept.settings.bots.other.every, 30);
  assert.equal(kept.settings.bots.other.person, "owner");
  assert.equal(kept.state.bots.pip.pings, 1);
  assert.deepEqual(mig(kept.settings, kept.state), kept, "migrating twice changes nothing");
});

test("signals come from failed routine runs, waiting tasks and unanswered requests, within a person's scope", () => {
  const state = {
    runs: [
      { id: "r1", scheduleId: 1, status: "Needs you", title: "Bills", detail: "Gmail expired", finished: NOW - HOUR, chatId: "c" },
      { id: "r2", status: "Needs you", title: "A chat", finished: NOW - HOUR, chatId: "c" },
      { id: "r3", scheduleId: 1, status: "Needs you", title: "Old", finished: NOW - 48 * HOUR, chatId: "c" },
      { id: "r4", scheduleId: 1, status: "Needs you", title: "Private", finished: NOW - HOUR, chatId: "other" },
    ],
    tasks: [
      { id: "t1", status: "review", title: "Draft", updatedAt: NOW - 5 * HOUR },
      { id: "t2", status: "review", title: "Fresh", updatedAt: NOW - HOUR },
    ],
  };
  const requests = [{ id: "q1", kind: "permission", title: "Run rm", chatId: "c", time: NOW - HOUR }];
  const everything = { run: (run) => run.chatId === "c", task: () => true, request: () => true };
  const keys = signals(state, requests, ["runs", "tasks", "requests"], NOW, everything).map((s) => s.key.split(":").slice(0, 2).join(":"));
  assert.deepEqual(keys, ["run:r1", "task:t1", "request:q1"]);
  assert.deepEqual(signals(state, requests, ["tasks"], NOW, everything).length, 1);
  assert.deepEqual(signals(state, requests, ["runs", "tasks", "requests"], NOW, { run: () => false, task: () => false, request: () => false }), []);
});

// ── Team members ────────────────────────────────────────────────────────────────────────────────

const role = (id, name, agents, bots) => ({ id, name, perms: { agents, today: ["view", "use"], skills: ["read"], mcp: ["view"], plugins: ["view"], settings: ["view", "manage"] }, bots });
const team = () => {
  const base = defaultTeam();
  return {
    ...base,
    roles: [...base.roles, role("r_mgr", "Manager", ["view", "chat", "manage"], ["pip"])],
    groups: [...base.groups, { id: "g_mgr", name: "Managers", roleId: "r_mgr" }],
    members: [
      { id: "m_avery", name: "Avery", groupId: "g_mgr", joinedAt: 1, deviceIds: [] },
      { id: "m_blake", name: "Blake", groupId: "g_mgr", joinedAt: 1, deviceIds: [] },
      { id: "m_casey", name: "Casey", groupId: "g_everyone", joinedAt: 1, deviceIds: [] },
    ],
  };
};
const member = (id, name) => ({ kind: "member", memberId: id, name });
const avery = member("m_avery", "Avery");
const bots = ["pip", "scout"].map((id) => ({ id }));
const lookups = { bot: (id) => bots.find((bot) => bot.id === id) };

test("a member whose role manages a bot may set its Proactive agent; others, and the computer's switch, are the owner's", () => {
  const t = team();
  const call = (principal, method, ...args) => authorize(principal, t, method, args, lookups);
  assert.equal(call(avery, "setBotProactive", "pip", { enabled: true }), "");
  assert.match(call(avery, "setBotProactive", "scout", { enabled: true }), /isn't available to your team role/, "a bot the role can't see");
  assert.match(call(member("m_casey", "Casey"), "setBotProactive", "pip", { enabled: true }), /role can't do that/, "a role that doesn't manage bots");
  assert.match(call(avery, "setPreferences", { proactive: { enabled: true } }), /display preferences only/, "the computer's switch");
  assert.equal(call({ kind: "owner" }, "setBotProactive", "scout", { enabled: true }), "");
});

test("a member's call sets their own agent, marked as theirs; another member and a bot they don't manage are refused", async (t) => {
  const { ws } = setup(t, { team: team() });
  ws.setPreferences({ proactive: { enabled: true } });
  const handlers = { setBotProactive: (...args) => ws.proactive.setBot(...args) };
  const call = deviceCall({ workspace: ws, handlers, folders: {} });

  await call("setBotProactive", ["pip", { enabled: true, deliver: "chat" }], { principal: avery });
  assert.equal(ws.proactive.config("pip").person, "m_avery");
  const { chat, entry } = ws.proactive.routine("pip");
  assert.equal(chat.createdBy, "m_avery", "its routine and chat are the member's");
  assert.equal(entry.deliver.to, "chat");

  await assert.rejects(call("setBotProactive", ["pip", { enabled: false }], { principal: member("m_blake", "Blake") }), /set up for someone else/);
  await assert.rejects(call("setBotProactive", ["scout", { enabled: true }], { principal: avery }), /can't manage/);
  await assert.rejects(call("setBotProactive", ["pip", { sweepHours: 3 }], { principal: avery }), /Only the owner/, "a member's agent never reads the computer's own accounts");
  await call("setBotProactive", ["pip", { enabled: false }], { principal: avery });
  assert.equal(ws.proactive.config("pip").enabled, false);
  assert.equal(ws.proactive.routine("pip").entry.enabled, false);

  // The owner may set up any bot, and take over one that a member left by forgetting it.
  await call("setBotProactive", ["pip", null], { principal: { kind: "owner" } });
  await call("setBotProactive", ["pip", { enabled: true }], { principal: { kind: "owner" } });
  assert.equal(ws.proactive.config("pip").person, "owner");
  assert.equal(ws.proactive.routine("pip").chat.createdBy, undefined);
});

test("a member's agent hears only of what that member may see, and tells that member", async (t) => {
  const { ws, seen } = setup(t, { team: team() });
  ws.setPreferences({ proactive: { enabled: true } });
  ws.proactive.setBot("pip", { enabled: true }, "m_avery");

  const ownerChat = ws.createChat("pip");
  const averysChat = ws.createChat("pip");
  ws.chat(averysChat).createdBy = "m_avery";
  const blakesChat = ws.createChat("pip");
  ws.chat(blakesChat).createdBy = "m_blake";
  failedRun(ws, "o", ownerChat, "Owner payroll");
  failedRun(ws, "a", averysChat, "Avery report");
  failedRun(ws, "b", blakesChat, "Blake expenses");
  ws.state.tasks = [{ id: "t", status: "blocked", title: "Owner roadmap", updatedAt: Date.now() - 9 * HOUR }];
  ws.interactions.snapshot = () => [
    { id: "q1", kind: "permission", title: "Owner approval", chatId: averysChat, time: Date.now() - HOUR },
    { id: "q2", kind: "question", title: "Owner question", chatId: ownerChat, time: Date.now() - HOUR },
    { id: "q3", kind: "question", title: "Avery question", chatId: averysChat, time: Date.now() - HOUR },
  ];
  seen.reply = "Your report failed.";
  await tick(ws, "pip");

  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0], /Avery report/);
  assert.match(seen.prompts[0], /Avery question/);
  assert.doesNotMatch(seen.prompts[0], /Owner|payroll|Blake|roadmap/, "nothing of the owner's or of another member's");
  assert.doesNotMatch(seen.prompts[0], /inbox, calendar/, "and no look at the computer's own accounts");
  const said = ws.chat(averysChat).messages.findLast((m) => m.role === "assistant");
  assert.equal(said?.text, "Your report failed.", "the alert is in the member's chat");
  for (const id of [ownerChat, blakesChat]) assert.equal(ws.chat(id).messages.some((m) => m.text === "Your report failed."), false);
  assert.equal(ws.notifiesOwner(ws.proactive.routine("pip").chat.id), false, "and not the owner's to be told of");

  // The owner's agent is the owner's: not Avery's or Blake's private runs.
  ws.proactive.setBot("scout", { enabled: true, sweepHours: 0 });
  await tick(ws, "scout");
  assert.match(seen.prompts[1], /Owner payroll/);
  assert.match(seen.prompts[1], /Owner roadmap/);
  assert.match(seen.prompts[1], /Owner question/);
  assert.doesNotMatch(seen.prompts[1], /Avery|Blake/);
});

test("a member's agent pauses when their role no longer manages the bot, and comes back with it", async (t) => {
  const current = team();
  const { ws, seen } = setup(t, { team: current });
  ws.setPreferences({ proactive: { enabled: true } });
  ws.proactive.setBot("pip", { enabled: true }, "m_avery");
  failedRun(ws, "a", (() => { const id = ws.createChat("pip"); ws.chat(id).createdBy = "m_avery"; return id; })(), "Avery report");

  current.roles.find((r) => r.id === "r_mgr").perms.agents = ["view", "chat"];
  ws.proactive.sync();
  assert.equal(ws.proactive.routine("pip").entry.enabled, false);
  await tick(ws, "pip", "manual");
  assert.equal(seen.prompts.length, 0);

  current.roles.find((r) => r.id === "r_mgr").perms.agents = ["view", "chat", "manage"];
  ws.proactive.sync();
  assert.equal(ws.proactive.routine("pip").entry.enabled, true);
  await tick(ws, "pip", "manual");
  assert.equal(seen.prompts.length, 1);
});

test("a member is sent their own agent's state, not the owner's or another member's", (t) => {
  const { ws } = setup(t, { team: team() });
  ws.setPreferences({ proactive: { enabled: true } });
  ws.proactive.setBot("pip", { enabled: true, instructions: "Avery's private rules" }, "m_avery");
  ws.proactive.setBot("scout", { enabled: true, instructions: "Owner's private rules" });
  const parts = { bots: [{ id: "pip" }, { id: "scout" }], chats: [], proactive: ws.snapshot().proactive, settings: ws.state.settings };
  const t2 = team();
  const sees = (id, name) => filterParts(parts, member(id, name), t2);

  const averys = sees("m_avery", "Avery").proactive;
  assert.equal(averys.enabled, true);
  assert.deepEqual(Object.keys(averys.bots), ["pip"], "only the bots the role sees");
  assert.equal(averys.bots.pip.instructions, "Avery's private rules");
  assert.equal(averys.bots.pip.mine, true);
  assert.equal("person" in averys.bots.pip, false);
  assert.equal("seen" in averys.bots.pip, false, "never the keys of what it raised");

  const blakes = sees("m_blake", "Blake").proactive;
  assert.deepEqual(blakes.bots.pip, { enabled: true, taken: true }, "another member's agent is only known to be there");
  assert.equal(JSON.stringify(blakes).includes("private rules"), false);
  assert.equal(JSON.stringify(sees("m_casey", "Casey").proactive.bots), "{}", "a role that doesn't manage bots is sent none");
});
