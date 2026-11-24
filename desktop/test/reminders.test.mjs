// Reminders (Settings › Notifications › Reminders): one plain notification, with no model, when something
// is left waiting on a person. Once for each thing, never in quiet hours, at most a few a day for each
// person, only for the person it is waiting on, and never on top of an alert their bot already sent.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { REMINDER_CAP, waiting } from "../desktop/reminders.mjs";
import { decide as desktopNote } from "../desktop/notify.mjs";
import { dispatch } from "../desktop/routines.mjs";
import { signals } from "../desktop/proactive.mjs";
import { defaultTeam } from "../desktop/link/team.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;

function setup(t, { team } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-reminders-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = { prompts: [], reply: "[SILENT]" };
  const handlers = new Set();
  const session = {
    on: (h) => (handlers.add(h), () => handlers.delete(h)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      seen.prompts.push(prompt);
      const answer = typeof seen.reply === "function" ? await seen.reply(prompt) : seen.reply;
      const id = "m" + seen.prompts.length;
      for (const h of handlers) h({ type: "user.message", id, data: { messageId: id } });
      for (const h of handlers) h({ type: "assistant.message", data: { originatingMessageId: id, content: answer } });
      for (const h of handlers) h({ type: "session.idle", data: { mode: "interactive" } });
      return id;
    },
  };
  const client = async () => ({ createSession: async () => session, resumeSession: async () => session, deleteSession: async () => {} });
  const ws = new Workspace(dir, client, () => {}, { team: () => team ?? null });
  const sent = [];
  ws.events.on("reminder", (reminder) => sent.push(reminder));
  return { ws, sent, seen };
}
const team = () => {
  const base = defaultTeam();
  return {
    ...base,
    roles: [...base.roles, { id: "r_see", name: "Viewer", perms: { agents: ["view", "chat"], today: ["view"], skills: ["read"], mcp: ["view"], plugins: ["view"], settings: [] }, bots: "all" }],
    groups: [...base.groups, { id: "g_see", name: "Viewers", roleId: "r_see" }],
    members: [{ id: "m_avery", name: "Avery", groupId: "g_see", joinedAt: 1, deviceIds: [] }],
  };
};
const ask = (ws, list) => (ws.interactions.snapshot = () => list);

test("what is waiting, in plain words titled with the bot's name", () => {
  const now = Date.UTC(2026, 10, 22, 18);
  const state = {
    bots: [{ id: "patch", name: "Patch" }, { id: "mira", name: "Mira" }],
    chats: [{ id: "c1", botId: "patch", title: "Release notes" }, { id: "c2", botId: "mira", title: "Trip", schedules: [{ id: 1, routine: true }] }, { id: "c3", botId: "mira", title: "Quiet", schedules: [{ id: 1, routine: true, notify: false }] }],
    runs: [
      { id: "s1", chatId: "c1", status: "Stopped", stoppedOpen: true, plan: { open: 2 }, title: "Release notes", finished: now - HOUR },
      { id: "f1", chatId: "c2", scheduleId: 1, status: "Needs you", title: "Fare watch", detail: "The sign-in expired.", finished: now - HOUR },
      { id: "f2", chatId: "c3", scheduleId: 1, status: "Needs you", title: "Quiet one", finished: now - HOUR },
      { id: "f3", chatId: "c2", scheduleId: 1, status: "Needs you", title: "Too new", finished: now - 5 * MIN },
    ],
  };
  const requests = [
    { id: "q1", kind: "question", title: "Which version?\nMore", chatId: "c1", botId: "patch", time: now - 20 * MIN },
    { id: "q2", kind: "permission", title: "Run npm publish", chatId: "c1", botId: "patch", time: now - 20 * MIN },
    { id: "q3", kind: "question", title: "Too new", chatId: "c1", botId: "patch", time: now - 5 * MIN },
  ];
  const all = { run: () => true, task: () => true, request: () => true };
  const found = waiting(state, requests, now, all);
  assert.deepEqual(found.map((item) => [item.key, item.title, item.body]), [
    ["request:q1", "Patch is waiting on your answer", "Which version?"],
    ["request:q2", "Patch is waiting on your approval", "Run npm publish"],
    ["stopped:s1", "Patch stopped with 2 steps left", "Release notes"],
  ], "the newer failed run in the same routine hides the older one, a quiet routine stays quiet, and a thing must have waited 15 minutes");
  state.runs.pop();
  const again = waiting(state, requests, now, all);
  assert.deepEqual(again.at(-1), { key: "run:f1", kind: "runs", botId: "mira", chatId: "c2", title: "Mira needs you", body: "Fare watch: The sign-in expired.", at: now - HOUR });
  assert.equal(found[1].ownerOnly, true, "only the owner can answer an approval");
  assert.deepEqual(waiting(state, requests, now, { ...all, request: () => false, run: () => false }), []);
  for (const item of again) assert.doesNotMatch(item.title + item.body, /Proactive agent/);
});

test("one reminder for each thing, to the person it waits on, with quiet hours, the day's cap and the switch", (t) => {
  const { ws, sent } = setup(t, { team: team() });
  const mine = ws.createChat("patch");
  const averys = ws.createChat("patch");
  ws.chat(averys).createdBy = "m_avery";
  const now = new Date(2026, 10, 22, 12, 0, 0, 0).getTime();
  const realNow = Date.now;
  Date.now = () => now;
  t.after(() => (Date.now = realNow));
  ask(ws, [
    { id: "q1", kind: "question", title: "Which branch?", chatId: mine, botId: "patch", time: now - 20 * MIN },
    { id: "q2", kind: "question", title: "Avery's question", chatId: averys, botId: "patch", time: now - 20 * MIN },
  ]);
  ws.reminders.tick(now);
  assert.deepEqual(sent.map((r) => [r.person, r.title, r.body, r.chatId]).sort(), [
    ["m_avery", "Patch is waiting on your answer", "Avery's question", averys],
    ["owner", "Patch is waiting on your answer", "Which branch?", mine],
  ]);
  ws.reminders.tick(now + MIN);
  ws.reminders.tick(now + HOUR);
  assert.equal(sent.length, 2, "once for each thing");
  assert.deepEqual(ws.snapshot().reminders.map((r) => r.key).sort(), ["request:q1", "request:q2"], "the link reads them from the snapshot");
  assert.deepEqual(ws.reminders.recent(now + HOUR), [], "and only for a short while");

  // The computer's own notification is the owner's, titled with the bot's name.
  const note = desktopNote({ type: "reminder", reminder: sent.find((r) => r.person === "owner"), bot: ws.bot("patch") }, { settings: ws.state.settings, focused: true, mine: true });
  assert.deepEqual(note, { title: "Patch is waiting on your answer", body: "Which branch?", chatId: mine });

  // Quiet hours hold a reminder back; it is sent when they are over.
  ask(ws, [{ id: "q3", kind: "question", title: "Later?", chatId: mine, botId: "patch", time: now - 20 * MIN }]);
  ws.setPreferences({ notifications: { quietHours: { enabled: true, from: "00:00", to: "23:59" } } });
  ws.reminders.tick(now + 2 * MIN);
  assert.equal(sent.length, 2);
  ws.setPreferences({ notifications: { quietHours: { enabled: false } } });
  ws.reminders.tick(now + 3 * MIN);
  assert.equal(sent.length, 3);

  // The switch in Settings › Notifications.
  assert.equal(ws.state.settings.notifications.reminders, true, "on from the start");
  ws.setPreferences({ notifications: { reminders: false } });
  ask(ws, [{ id: "q4", kind: "question", title: "Off?", chatId: mine, botId: "patch", time: now - 20 * MIN }]);
  ws.reminders.tick(now + 4 * MIN);
  assert.equal(sent.length, 3, "off: nothing is sent");
  assert.equal(desktopNote({ type: "reminder", reminder: sent[0], bot: ws.bot("patch") }, { settings: ws.state.settings, mine: true }), null);
  ws.setPreferences({ notifications: { reminders: true } });

  // At most a few a day for each person.
  ask(ws, Array.from({ length: REMINDER_CAP + 3 }, (_, n) => ({ id: "many" + n, kind: "question", title: "Q" + n, chatId: mine, botId: "patch", time: now - 20 * MIN })));
  ws.reminders.tick(now + 5 * MIN);
  assert.equal(sent.filter((r) => r.person === "owner").length, REMINDER_CAP, "the owner's cap for the day");
  ws.reminders.tick(now + 6 * MIN);
  assert.equal(sent.filter((r) => r.person === "owner").length, REMINDER_CAP);
});

test("a reminder never doubles an alert the person's bot sends for the same thing, and needs no Proactive agent", async (t) => {
  const { ws, sent, seen } = setup(t);
  const chat = ws.createChat("patch");
  const now = Date.now();
  const failed = (id, title, ago = HOUR) => ws.state.runs.unshift({ id, chatId: ws.createChat("patch"), scheduleId: 9, status: "Needs you", title, time: now - ago, finished: now - ago });

  // No bot is proactive: the reminder still goes.
  failed("r0", "Backups");
  ws.reminders.tick(now);
  assert.deepEqual(sent.map((r) => r.key), ["run:r0"]);
  assert.equal(seen.prompts.length, 0, "no model");

  // A bot that watches runs for the owner gets to a new one first.
  ws.proactive.setBot("pip", { enabled: true, setUp: true, sweepHours: 0, every: 15, people: { owner: { on: true } } });
  failed("r1", "Bills", 20 * MIN);
  ws.reminders.tick(now);
  assert.equal(sent.length, 1, "held while the bot's own check may still raise it");
  const packet = (prompt) => JSON.parse(prompt.split("\n\n").at(-2));
  seen.reply = (prompt) => JSON.stringify({ candidates: [{ title: "Bills is failing.", refs: [packet(prompt).find((e) => /Bills/.test(e.text)).id], method: "alert", why: "It affects the month's close.", next: "Sign in again." }] });
  const { chat: routine, entry } = ws.proactive.routine("pip");
  await dispatch(ws, routine, entry, "scheduled");
  assert.equal(ws.state.proactive.bots.pip.people.owner.log[0].outcome, "alerted");
  ws.reminders.tick(now + 2 * HOUR);
  assert.equal(sent.some((r) => r.key === "run:r1"), false, "the bot told them: no second ping");
  assert.equal(ws.proactive.wake("pip", "scheduled", now + 2 * HOUR), null, "and what a reminder already said (r0) doesn't wake the bot");

  // What the bot stayed quiet about is still reminded of, once its turn has passed.
  failed("r2", "Invoices", 20 * MIN);
  seen.reply = "[SILENT]";
  await dispatch(ws, routine, entry, "scheduled");
  ws.reminders.tick(now + 5 * MIN);
  assert.equal(sent.some((r) => r.key === "run:r2"), false);
  ws.reminders.tick(now + 2 * HOUR);
  assert.equal(sent.some((r) => r.key === "run:r2"), true);
  assert.ok(chat);
});

test("a request the host raises is stamped, so it is reminded after 15 minutes and Proactive waits as long", (t) => {
  const { ws, sent } = setup(t);
  const chat = ws.createChat("patch");
  const task = { run: { id: "r1" }, stopped: false, ended: false };
  const before = Date.now();
  void ws.interactions.request(ws.chat(chat), task, { kind: "question", title: "Which branch?", choices: [], freeform: true });
  void ws.interactions.request(ws.chat(chat), task, { kind: "permission", label: "Run", title: "Run npm publish", preview: "npm publish" });
  void ws.interactions.request(ws.chat(chat), task, { kind: "secure", title: "Sign in", fields: [] });
  const requests = ws.interactions.snapshot();
  assert.equal(requests.length, 3);
  for (const request of requests) assert.ok(request.time >= before && request.time <= Date.now(), request.kind + " has the time it was raised");
  const asked = Math.max(...requests.map((request) => request.time));
  const everything = { run: () => true, task: () => true, request: () => true };
  // Young requests are nobody's to hear of yet: no reminder, and no Proactive signal.
  assert.deepEqual(ws.reminders.tick(asked + 5 * MIN), []);
  assert.deepEqual(signals(ws.state, requests, ["requests"], asked + 5 * MIN, everything), []);
  // Old enough: both readers see all three.
  assert.deepEqual(signals(ws.state, requests, ["requests"], asked + 20 * MIN, everything).map((signal) => signal.key).sort(), requests.map((request) => "request:" + request.id).sort());
  ws.reminders.tick(asked + 20 * MIN);
  assert.deepEqual(sent.map((reminder) => reminder.key).sort(), requests.map((request) => "request:" + request.id).sort());
});
