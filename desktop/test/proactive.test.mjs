// The Proactive agent (Settings › Experimental, and each bot's profile): the computer's switch, a bot's own
// settings and managed routine, and the gate that wakes it. Several people, who may change what, offers and
// the earlier shape are in proactive-team.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const packet = (prompt) => JSON.parse(prompt.split("\n\n").at(-2));
const candidate = (title, refs, method = "alert") => ({ title, refs, method, why: "This affects the next step.", next: "Check the details today." });
const proposal = (title) => (prompt) => JSON.stringify({ candidates: [candidate(title, [packet(prompt)[0]?.id])] });

/** Turns a bot's agent on for one person, as finishing its setup steps does. */
const on = (ws, botId, patch = {}, person = "owner") => ws.proactive.setBot(botId, { enabled: true, setUp: true, people: { [person]: { on: true } }, ...patch });
/** The routine a bot keeps for the one person it looks out for in these tests, ticking as its clock does. */
const tick = (ws, botId, trigger = "scheduled") => {
  const { chat, entry } = ws.proactive.routine(botId, Object.keys(ws.proactive.config(botId).people)[0]);
  return dispatch(ws, chat, entry, trigger);
};
const failedRun = (ws, id, chatId, title) => ws.state.runs.unshift({ id, chatId, scheduleId: 9, status: "Needs you", title, time: Date.now(), finished: Date.now() });
const managed = (ws) => ws.panels.routines.list().filter(({ entry }) => entry.proactive);

test("the computer's switch and a bot's settings are each checked whole", () => {
  assert.equal(proactiveField({}).enabled, true, "on from the start: a bot still waits for its setup steps");
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
  on(ws, "pip", { every: 15, sweepHours: 0 });
  assert.equal(managed(ws).length, 1);
  assert.equal(managed(ws)[0].chat.botId, "pip");
  assert.equal(managed(ws)[0].entry.cron, "*/15 * * * *");
  assert.equal(ws.proactive.routine("scout"), null);
  assert.throws(() => ws.panels.routines.update(managed(ws)[0].chat.id, { name: "x" }), /Proactive/);

  const chat = ws.createChat("scout");
  failedRun(ws, "bad", chat, "Bills");
  seen.reply = proposal("Bills routine is failing.");
  await tick(ws, "pip");
  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0], /Routine “Bills” needs the person/);
  assert.equal(ws.state.proactive.bots.pip.people.owner.log[0].outcome, "alerted");
  assert.equal(ws.state.proactive.bots.scout, undefined, "a bot that is not proactive has no gate state");
  assert.deepEqual(ws.snapshot().proactive.bots.scout, undefined);
});

test("each proactive bot keeps its own seen signals, alerts a day, look-around clock and log", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { sweepHours: 0, maxPerDay: 3 });
  on(ws, "scout", { sweepHours: 0, maxPerDay: 3 });
  seen.reply = proposal("Something needs you.");
  failedRun(ws, "bad", ws.createChat("patch"), "Bills");

  await tick(ws, "pip");
  assert.equal(seen.prompts.length, 1);
  assert.equal(ws.state.proactive.bots.pip.people.owner.pings, 1);
  await tick(ws, "scout");
  assert.equal(seen.prompts.length, 1, "what pip already told the person doesn't wake scout as well");
  assert.deepEqual(Object.keys(ws.state.proactive.bots.scout.people.owner.seen), [], "and isn't written into scout's own list");
  assert.ok(Object.keys(ws.state.proactive.bots.pip.people.owner.seen).length > 0);

  ws.memory.save("scout", "The next review is tomorrow.");
  seen.reply = proposal("Prepare for your review.");
  await tick(ws, "scout", "manual");
  assert.equal(seen.prompts.length, 2, "Check now wakes it whatever the other did");
  assert.equal(ws.state.proactive.bots.scout.people.owner.pings, 1);
  assert.equal(ws.state.proactive.bots.pip.people.owner.pings, 1, "its count is its own");
  assert.equal(ws.state.proactive.bots.pip.people.owner.log.length, 1);
  assert.equal(ws.state.proactive.bots.scout.people.owner.log.length, 1);

  ws.state.proactive.bots.pip.people.owner.pings = 3;
  failedRun(ws, "worse", ws.createChat("patch"), "Backups");
  await tick(ws, "pip");
  assert.equal(seen.prompts.length, 2, "pip is at its cap for the day");
  await tick(ws, "scout");
  assert.equal(seen.prompts.length, 3, "scout is not");
});

test("the gate wakes the bot once per signal, sweeps on its clock, and keeps quiet hours and the cap", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { sweepHours: 0, maxPerDay: 3 });
  const go = (trigger) => tick(ws, "pip", trigger);

  await go();
  assert.equal(seen.prompts.length, 0, "nothing new and no sweep: no model");

  failedRun(ws, "bad", ws.createChat("pip"), "Bills");
  await go();
  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0], /\[SILENT\]/);
  assert.equal(ws.state.runs.find((r) => r.proactive).silent, true);
  assert.equal(ws.state.proactive.bots.pip.people.owner.log[0].outcome, "silent");

  await go();
  assert.equal(seen.prompts.length, 1, "the same signal never wakes it twice");
  await go("manual");
  assert.equal(seen.prompts.length, 2, "Check now always wakes it");

  ws.memory.save("pip", "The Bills routine depends on the Gmail sign-in.");
  seen.reply = proposal("Bills routine is failing: Gmail sign-in expired.");
  ws.proactive.setBot("pip", { sweepHours: 1 });
  ws.state.proactive.bots.pip.people.owner.lastSweepAt = 0;
  await go();
  assert.equal(seen.prompts.length, 3, "a due sweep wakes it");
  assert.match(seen.prompts[2], /inbox, calendar/, "the owner's bot may look at the sources its tools reach");
  assert.equal(ws.state.proactive.bots.pip.people.owner.log[0].outcome, "alerted");
  assert.equal(ws.state.proactive.bots.pip.people.owner.pings, 1);
  assert.match(ws.proactive.prompt("pip", ws.proactive.wake("pip", "manual")), /already told the person[\s\S]*Gmail sign-in expired/);

  ws.state.proactive.bots.pip.people.owner.pings = 3;
  ws.state.proactive.bots.pip.people.owner.lastSweepAt = 0;
  await go();
  assert.equal(seen.prompts.length, 3, "the day's cap holds it");

  ws.state.proactive.bots.pip.people.owner.pings = 0;
  ws.setPreferences({ notifications: { quietHours: { enabled: true, from: "00:00", to: "23:59" } } });
  await go();
  assert.equal(seen.prompts.length, 3, "quiet hours hold it");
});

test("the computer's switch off pauses every proactive bot, and on brings them back as they were", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { every: 60, instructions: "Skip newsletters." });
  on(ws, "scout", { every: 15 });
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
  on(ws, "patch");
  on(ws, "scout");
  await ws.panels.routines.remove(ws.proactive.routine("patch").chat.id);
  assert.equal(ws.proactive.config("patch").people.owner.on, false, "removing the routine turns that person's check off");
  assert.equal(ws.proactive.routine("patch"), null);
  assert.equal(ws.proactive.config("scout").people.owner.on, true, "and no other");

  await ws.agents.deleteBot("scout");
  assert.equal(ws.proactive.config("scout"), undefined);
  assert.equal(ws.state.proactive.bots.scout, undefined);

  on(ws, "patch");
  ws.proactive.setBot("patch", null);
  assert.equal(ws.proactive.config("patch"), undefined, "null forgets a bot's settings");
  assert.equal(ws.proactive.routine("patch"), null);
  assert.throws(() => on(ws, "ghost"), /Unknown bot/);
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
    bots: { scout: { enabled: true, setUp: true, every: 15, sweepHours: 6, maxPerDay: 10, deliver: "feed", watch: ["runs"], instructions: "Be brief.", people: { owner: { on: true, notify: true } } } },
  });
  assert.equal(ws.state.proactive.botId, undefined);
  assert.deepEqual(ws.state.proactive.bots.scout.people.owner.seen, { "run:a": 5 });
  assert.equal(ws.state.proactive.bots.scout.people.owner.pings, 2);
  assert.equal(ws.state.proactive.bots.scout.people.owner.chatId, "c1");
  assert.equal(ws.state.proactive.bots.scout.people.owner.log.length, 1);
  assert.equal(managed(ws).length, 1, "the routine is kept, not made again");
  assert.equal(managed(ws)[0].chat.id, "c1");
  ws.proactive.sync();
  assert.equal(managed(ws).length, 1);
  assert.equal(managed(ws)[0].entry.enabled, true);
});

test("older and damaged shapes are tolerated", () => {
  const mig = (settings, state) => migrateProactive(settings, state);
  assert.deepEqual(mig(undefined, undefined), { settings: { enabled: true, bots: {} }, state: { shape: 4, bots: {}, reminders: {}, snoozed: {} } });
  assert.deepEqual(mig("nope", 5).settings, { enabled: true, bots: {} });
  assert.deepEqual(mig({ enabled: true, botId: 5 }, {}).settings, { enabled: true, bots: {} });
  assert.equal(mig({ enabled: false, botId: "pip", every: 7 }, {}).settings.bots.pip.every, 30, "a value that is no longer valid is the usual one");
  assert.equal(mig({ enabled: false, botId: "pip" }, {}).settings.bots.pip.enabled, false);
  const current = { enabled: true, bots: { pip: { enabled: true, person: "m_a", every: 60 }, bad: 3, other: { every: 999 } } };
  const kept = mig(current, { bots: { pip: { pings: 1 } } });
  assert.deepEqual(kept.settings.bots.pip.people, { m_a: { on: true, notify: true } });
  assert.equal(kept.settings.bots.pip.every, 60);
  assert.equal(kept.settings.bots.bad, undefined);
  assert.equal(kept.settings.bots.other.every, 30);
  assert.deepEqual(kept.settings.bots.other.people, { owner: { on: false, notify: true } });
  assert.equal(kept.state.bots.pip.people.m_a.pings, 1);
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

// Who may change what, and what each person is sent, are in proactive-team.test.mjs.
test("a member whose role sees a bot may reach its Proactive agent; the computer's switch is the owner's", () => {
  const t = team();
  const call = (principal, method, ...args) => authorize(principal, t, method, args, lookups);
  assert.equal(call(avery, "setBotProactive", "pip", { enabled: true }), "");
  assert.match(call(avery, "setBotProactive", "scout", { enabled: true }), /isn't available to your team role/, "a bot the role can't see");
  assert.match(call(member("m_casey", "Casey"), "setBotProactive", "pip", { enabled: true }), /isn't available to your team role/, "a role that doesn't see the bot");
  assert.match(call(avery, "setPreferences", { proactive: { enabled: true } }), /display preferences only/, "the computer's switch");
  assert.equal(call({ kind: "owner" }, "setBotProactive", "scout", { enabled: true }), "");
});

test("a member's agent hears only of what that member may see, and tells that member", async (t) => {
  const { ws, seen } = setup(t, { team: team() });
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", {}, "m_avery");

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
  seen.reply = proposal("Your report failed.");
  await tick(ws, "pip");

  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0], /Avery report/);
  assert.match(seen.prompts[0], /Avery question/);
  assert.doesNotMatch(seen.prompts[0], /Owner|payroll|Blake|roadmap/, "nothing of the owner's or of another member's");
  assert.doesNotMatch(seen.prompts[0], /inbox, calendar/, "and no look at the computer's own accounts");
  const said = ws.chat(ws.mainChat("pip", "m_avery")).messages.findLast((m) => m.role === "assistant");
  assert.match(said?.text, /^Your report failed\./, "the alert is in the member's chat");
  for (const id of [ownerChat, blakesChat]) assert.equal(ws.chat(id).messages.some((m) => m.text?.startsWith("Your report failed.")), false);
  assert.equal(ws.notifiesOwner(ws.proactive.routine("pip", "m_avery").chat.id), false, "and not the owner's to be told of");

  // The owner's agent is the owner's: not Avery's or Blake's private runs.
  on(ws, "scout", { sweepHours: 0 });
  await tick(ws, "scout");
  assert.match(seen.prompts[1], /Owner payroll/);
  assert.match(seen.prompts[1], /Owner roadmap/);
  assert.match(seen.prompts[1], /Owner question/);
  assert.doesNotMatch(seen.prompts[1], /Avery|Blake/);
});

test("a past conversation and a goal surface preparation without an inbox event, with no model call on the next quiet tick", async (t) => {
  const { ws, seen } = setup(t);
  const chat = ws.chat(ws.createChat("pip"));
  chat.messages.push({ role: "user", text: "I have twenty minutes between trains in York.", time: Date.now() });
  ws.memory.save("pip", "Interested in railway photography.");
  ws.board.post("pip", { kind: "goal", title: "Build my station photo portfolio" });
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { sweepHours: 0 });
  seen.reply = (prompt) => {
    const facts = packet(prompt);
    const from = (type) => facts.find((e) => e.id.startsWith(type + "-")).id;
    return JSON.stringify({ candidates: [
      candidate("Browse photography books", [from("memory")], "discover"),
      { method: "prepare", refs: [from("goal"), from("chat"), from("memory")], title: "Use your York stop for one portfolio shot",
        why: "Your train change gives you twenty minutes to work on the station portfolio.", next: "Pick one platform detail to photograph before you board." },
      candidate("A festival is on this weekend", ["made-up-event"], "discover"),
    ] });
  };
  await ws.panels.routines.run(ws.proactive.routine("pip").chat.id);
  const inbox = ws.chat(ws.mainChat("pip"));
  const alert = inbox.messages.at(-1);
  assert.match(alert.text, /^Use your York stop/);
  assert.match(alert.text, /twenty minutes.*\n\nPick one platform detail/s);
  assert.doesNotMatch(alert.text, /candidates|festival|books/);
  const view = ws.proactive.view("pip");
  assert.equal(view.log[0].score, 69);
  assert.equal(view.pings, 1);
  assert.equal(alert.proactiveRunId, view.log[0].runId);
  assert.ok(!JSON.stringify(view).includes("memory-"));
  await tick(ws, "pip");
  assert.equal(seen.prompts.length, 1);
  await tick(ws, "pip", "manual");
  // The alternative grounded in different evidence can win once the first was said.
  assert.match(inbox.messages.at(-1).text, /photography books/);
  await tick(ws, "pip", "manual");
  assert.equal(ws.proactive.view("pip").log[0].outcome, "silent");
  assert.equal(ws.proactive.view("pip").pings, 2);
  ws.memory.save("pip", "Prefers morning light for photographs.");
  seen.reply = "[SILENT]";
  await tick(ws, "pip");
  assert.equal(ws.proactive.view("pip").log[0].reason, "context");
  assert.match(seen.prompts.at(-1), /morning light/);
  assert.equal(ws.proactive.wake("pip", "scheduled", Date.now() + 15 * 24 * HOUR), null, "unchanged memory stays observed after operational signal receipts expire");
  const routineText = ws.proactive.routine("pip").chat.messages.map((m) => m.text).join("\n");
  assert.doesNotMatch(routineText, /"refs"|candidates|morning light/, "only the selected suggestion appears in a transcript");
});

test("chat and Feed feedback train only the recipient, survive restart, and curate the next wake", async (t) => {
  const { ws, seen, dir } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { sweepHours: 0, deliver: "feed" });
  const addInterest = (workspace, text) => workspace.memory.save("pip", text);
  const discover = (prompt) => {
    const last = packet(prompt).filter((e) => e.id.startsWith("memory-")).at(-1);
    return JSON.stringify({ candidates: [candidate("Try " + last.text, [last.id], "discover")] });
  };
  seen.reply = discover;
  addInterest(ws, "Sketching with charcoal");
  await tick(ws, "pip");
  const card = ws.board.items[0];
  assert.equal(card.proactiveRunId, ws.proactive.view("pip").log[0].runId);
  ws.board.act(card.id, "read", undefined, "owner");
  ws.board.act(card.id, "up", undefined, "m_blake");
  assert.equal(ws.proactive.view("pip").learning.rated, 0);
  ws.board.act(card.id, "down", "Not relevant", "owner");
  assert.equal(ws.proactive.view("pip").learning.rated, 1);

  ws.proactive.setBot("pip", { deliver: "chat" });
  addInterest(ws, "Painting in watercolours");
  await tick(ws, "pip");
  const run = ws.state.runs.find((r) => r.id === ws.proactive.view("pip").log[0].runId);
  const chat = ws.chat(run.delivery.chatId);
  const index = chat.messages.length - 1;
  const react = (workspace, emoji, actor) => workspace.reactToMessage(chat.id, index, chat.messages[index].time, emoji, actor);
  react(ws, "👎", "bot:pip");
  react(ws, "👎", "member:m_blake");
  assert.equal(ws.proactive.view("pip").learning.rated, 1);
  react(ws, "👎🏽", "owner");
  react(ws, "👎", "owner");
  assert.deepEqual(ws.proactive.view("pip").learning, { rated: 2, retired: ["Discovery from saved memory"], preferred: [] });

  const restarted = setup(t, { dir });
  addInterest(restarted.ws, "Drawing with pastels");
  restarted.seen.reply = discover;
  await tick(restarted.ws, "pip");
  assert.match(restarted.seen.prompts[0], /retired: Discovery from saved memory/);
  assert.equal(restarted.ws.proactive.view("pip").log[0].outcome, "silent");
  react(restarted.ws, "👍", "owner");
  restarted.ws.board.act(card.id, "up", undefined, "owner");
  assert.deepEqual(restarted.ws.proactive.view("pip").learning, { rated: 2, preferred: ["Discovery from saved memory"], retired: [] });
  await tick(restarted.ws, "pip", "manual");
  assert.match(restarted.seen.prompts.at(-1), /preferred: Discovery from saved memory/);
  assert.equal(restarted.ws.proactive.view("pip").log[0].outcome, "alerted");
  react(restarted.ws, "🎨", "owner");
  restarted.ws.board.act(card.id, "up", undefined, "owner");
  assert.equal(restarted.ws.proactive.view("pip").learning.rated, 0, "neutral/retracted reactions undo both training labels");
  restarted.ws.proactive.setBot("pip", null);
  on(restarted.ws, "pip");
  react(restarted.ws, "👍", "owner");
  assert.equal(restarted.ws.proactive.view("pip").learning.rated, 0, "an old delivery never trains a new setup");
});

test("prior-session grounding and delivery stay inside the recipient and bot boundaries", async (t) => {
  const { ws, seen } = setup(t, { team: team() });
  const make = (creator, writer, text, fields = {}) => {
    const chat = ws.chat(ws.createChat("pip"));
    Object.assign(chat, { createdBy: creator, ...fields });
    chat.messages.push({ role: "user", text, ...(writer && { author: { memberId: writer } }), time: Date.now() });
    return chat;
  };
  ws.memory.save("pip", "PRIVATE owner profile");
  make(undefined, undefined, "PRIVATE owner message");
  make("m_blake", "m_blake", "PRIVATE Blake message");
  const mine = make("m_avery", "m_avery", "My conference poster is due next week");
  make("m_avery", undefined, "PRIVATE another speaker");
  make("m_avery", "m_avery", "PRIVATE temporary note", { temporary: true });
  const shared = make("m_avery", "m_avery", "PRIVATE planning with Blake", { time: Date.now() + HOUR });
  ws.peopleOf = (id) => ({ invited: id === shared.id ? ["m_blake"] : [] });
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", {}, "m_avery");
  seen.reply = proposal("Plan a poster rehearsal");
  await tick(ws, "pip");
  assert.match(seen.prompts[0], /conference poster/);
  assert.doesNotMatch(seen.prompts[0], /PRIVATE/);
  const options = seen.options.at(-1);
  assert.doesNotMatch(JSON.stringify(options.systemMessage), /PRIVATE/);
  assert.deepEqual(options.tools.availableTools, []);
  assert.deepEqual(options.mcp.servers, {});
  assert.equal(options.skills.enabled, false);
  assert.equal(ws.state.runs[0].delivery.chatId === shared.id, false);
  assert.equal(shared.messages.length, 1);
  assert.equal(mine.messages[0].text, "My conference poster is due next week");
});

test("failed checks release their evidence, concurrent ticks reserve it and revoked evidence stays quiet", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { sweepHours: 0 });
  on(ws, "scout", { sweepHours: 0 });
  failedRun(ws, "bad", ws.createChat("patch"), "Prepare agenda");
  const started = Promise.withResolvers(), answer = Promise.withResolvers();
  seen.reply = async () => { started.resolve(); return answer.promise; };
  const working = tick(ws, "pip");
  await started.promise;
  assert.equal(await tick(ws, "scout"), null);
  assert.equal(await tick(ws, "pip", "manual"), null);
  answer.resolve("malformed response");
  await working;
  assert.equal(ws.proactive.view("pip").log[0].outcome, "failed");
  assert.equal(ws.proactive.gate("pip").seen["run:bad"], undefined);
  seen.reply = proposal("Check the agenda");
  await ws.retry(ws.proactive.view("pip").log[0].runId);
  assert.equal(ws.proactive.view("pip").pings, 1);
  assert.equal(ws.proactive.gate("pip").learning.history.length, 1);
  assert.equal(await tick(ws, "scout"), null);

  ws.memory.save("pip", "Practice watercolour painting");
  seen.reply = (prompt) => {
    ws.memory.write("pip", "");
    return JSON.stringify({ candidates: [candidate("Take a painting class", [packet(prompt)[0].id], "discover")] });
  };
  await tick(ws, "pip");
  assert.equal(ws.proactive.view("pip").log[0].outcome, "silent");
  assert.equal(ws.proactive.view("pip").pings, 1);
});

test("an enabled live read supplies an evidence ID, invented IDs cannot alert, and a shared Feed falls back to private chat", async (t) => {
  const current = team();
  const { ws, seen } = setup(t, { team: current });
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { deliver: "feed" });
  const feed = ws.spaces.forCards("owner", "feed");
  current.spaces = { [feed.id]: { access: "link" } };
  const calls = [];
  ws.phone.source = () => ({
    tools: () => ["read", "change"].map((mode) => ({ name: "phone_" + mode, description: mode, readOnly: mode === "read", parameters: { type: "object" } })),
    call: (name) => { calls.push(name); return "The next train departs 30 minutes early."; },
  });
  seen.reply = async (_prompt, options) => {
    assert.deepEqual(options.tools.availableTools, ["custom:phone_read"]);
    const result = await options.tools.definitions[0].handler({});
    const ref = result.split(" ")[0];
    return JSON.stringify({ candidates: [
      { ...candidate("Check gate seven", ["live-unknown"]), timeSensitive: true },
      { ...candidate("Leave for the train earlier", [ref]), timeSensitive: true },
    ] });
  };
  await tick(ws, "pip");
  assert.deepEqual(calls, ["phone_read"]);
  assert.equal(ws.board.items.length, 0);
  const run = ws.state.runs[0];
  assert.equal(run.delivery?.to, "chat");
  assert.match(ws.chat(run.delivery.chatId).messages.at(-1).text, /Leave for the train/);
  assert.equal(ws.proactive.view("pip").pings, 1);
});

test("a quiet decision can schedule one grounded follow-up, which rechecks the underlying facts", async (t) => {
  const { ws, seen, dir } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { sweepHours: 0 });
  ws.memory.save("pip", "I need a rehearsal before the poster session on Friday.");
  const at = Date.now() + 2 * HOUR;
  const defer = (prompt) => JSON.stringify({ candidates: [], revisit: { at: new Date(at).toISOString(), refs: [packet(prompt)[0].id] } });
  seen.reply = defer;
  await tick(ws, "pip");
  assert.equal(ws.proactive.view("pip").nextReviewAt, at);
  assert.equal(ws.proactive.view("pip").review, undefined);
  assert.equal(ws.proactive.view("pip").pings, 0);
  const restarted = setup(t, { dir }).ws;
  assert.equal(restarted.proactive.wake("pip", "scheduled", at - 1), null);
  const check = restarted.proactive.wake("pip", "scheduled", at);
  assert.equal(check.reason, "review");
  assert.equal(check.sweep, false);
  assert.match(restarted.proactive.prompt("pip", check), /Reassess the facts/);
  const routine = restarted.proactive.routine("pip");
  await restarted.send(routine.chat.id, "Check for a helpful suggestion.", { proactive: true, proactiveCheck: check, scheduleId: routine.entry.id });
  assert.equal(restarted.proactive.view("pip").nextReviewAt, undefined);
  assert.equal(restarted.proactive.wake("pip", "scheduled", at + HOUR), null);
  ws.memory.write("pip", "");
  assert.equal(ws.proactive.wake("pip", "scheduled", at), null, "a forgotten fact cancels a pending review");
});

test("a persisted in-flight check resumes once after restart, and refuses a late result after reset", async (t) => {
  const { ws, seen, dir } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { sweepHours: 0 });
  ws.memory.save("pip", "I want to practise French before my trip.");
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  seen.reply = async (prompt) => { started.resolve(); await finish.promise; return proposal("A French rehearsal")(prompt); };
  const pending = tick(ws, "pip");
  await started.promise;
  const restarted = setup(t, { before: (other) => copyFileSync(join(dir, "workspace.json"), join(other, "workspace.json")) });
  restarted.ws.memory.write("pip", ws.memory.read("pip"));
  restarted.seen.reply = proposal("A French rehearsal");
  await Promise.all(restarted.ws.resumeActive());
  assert.deepEqual(restarted.ws.resumeActive(), []);
  const gate = restarted.ws.proactive.gate("pip");
  assert.equal(gate.log.length, 1);
  assert.equal(gate.log[0].reason, "context");
  assert.equal(gate.learning.history.length, 1);
  assert.equal(gate.pings, 1);
  assert.equal(await tick(restarted.ws, "pip"), null);
  ws.proactive.setBot("pip", null);
  on(ws, "pip");
  finish.resolve();
  await pending;
  assert.deepEqual(ws.proactive.view("pip").log, []);
  assert.equal(ws.state.runs.find((r) => r.proactive).silent, true);
});

test("selecting one suggestion leaves another distinct waiting request available for the next tick", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true } });
  on(ws, "pip", { sweepHours: 0 });
  const chat = ws.createChat("patch");
  failedRun(ws, "first", chat, "Reconcile invoices");
  failedRun(ws, "second", chat, "Prepare the launch");
  seen.reply = (prompt) => JSON.stringify({ candidates: packet(prompt).map((e) => candidate(e.text, [e.id])) });
  await tick(ws, "pip");
  await tick(ws, "pip");
  assert.equal(ws.proactive.view("pip").pings, 2);
  assert.notEqual(ws.proactive.view("pip").log[0].said, ws.proactive.view("pip").log[1].said);
  assert.equal(await tick(ws, "pip"), null);
});

test("delivery into a busy Main chat survives restart and reaches the queued follow-up once", async t => {
  const { ws, seen, dir } = setup(t);
  on(ws, "pip", { watch: ["runs"], sweepHours: 0 });
  const id = ws.mainChat("pip");
  const source = ws.createChat("pip");
  failedRun(ws, "backup", source, "Backup check");
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  seen.reply = async prompt => {
    if (prompt === "Keep working") {
      entered.resolve();
      await release.promise;
      return "Finished.";
    }
    if (prompt.includes("Generate") || prompt.includes('"candidates"')) return proposal("Backups need attention")(prompt);
    return "All right.";
  };
  const queuedFinished = host => new Promise(resolve => {
    const listener = ({ run }) => {
      if (run.chatId === id && run.title === "Follow up") { host.events.off("turn", listener); resolve(); }
    };
    host.events.on("turn", listener);
  });
  const originalDone = queuedFinished(ws);
  const working = ws.send(id, "Keep working");
  await entered.promise;
  ws.submit(id, "Follow up", { delivery: "queue" });
  try {
    await assert.rejects(ws.changeMainFork(id, "reset"), /Finish the reply/);
    await tick(ws, "pip");
    assert.equal(ws.chat(id).messages.filter(m => m.alert).length, 1);
    const restored = setup(t, { before: other => copyFileSync(join(dir, "workspace.json"), join(other, "workspace.json")) });
    assert.equal(restored.ws.mainChat("pip"), id);
    assert.equal(restored.ws.queues.get(id)[0].text, "Follow up");
    restored.seen.reply = "Done.";
    const drained = queuedFinished(restored.ws);
    await Promise.all(restored.ws.resumeActive());
    await drained;
    assert.equal(restored.ws.chat(id).messages.filter(m => m.alert).length, 1);
    assert.equal(restored.ws.proactive.view("pip").pings, 1);
    assert.equal(restored.ws.queues.has(id), false);
    assert.equal(restored.seen.prompts.filter(p => p.includes("Since your last turn") && p.includes("Backups need attention")).length, 1);
  } finally {
    release.resolve();
    await working;
    await originalDone;
  }
});
