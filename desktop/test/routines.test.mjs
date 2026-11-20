import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { tickChatSchedules } from "../desktop/schedules.mjs";
import { compileCadence, describeCadence, zonedTime } from "../desktop/routines.mjs";
import { decide, firstLine, inQuietHours } from "../desktop/notify.mjs";
import { usageCsv, usageReport } from "../desktop/usage.mjs";
import { changeSettings, defaultSettings } from "../desktop/preferences.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-routines-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prompts = [];
  const handlers = new Set();
  const session = {
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    emit: (event) => handlers.forEach((handler) => handler(event)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      prompts.push(prompt);
      const messageId = "message:" + prompts.length;
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      const content = "Done: " + prompt + "\nmore";
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };
  const client = async () => ({
    createSession: async () => session,
    resumeSession: async () => session,
    deleteSession: async () => {},
  });
  const open = () => new Workspace(dir, client, () => {}, () => ({ kind: "reject" }));
  return { open, ws: open(), prompts };
}
const NY = "America/New_York";
const T0 = Date.UTC(2026, 10, 17, 12); // Tue 2026-11-17 07:00 in New York

test("cadences compile to cron or a one-time instant in the routine's time zone", () => {
  assert.equal(compileCadence({ kind: "daily", time: "9:05" }, NY, T0).cron, "5 9 * * *");
  assert.equal(compileCadence({ kind: "weekdays", time: "09:00" }, NY, T0).cron, "0 9 * * 1-5");
  const weekly = compileCadence({ kind: "weekly", time: "18:30", days: ["fri", 1, "mon"] }, NY, T0);
  assert.equal(weekly.cron, "30 18 * * 1,5");
  assert.deepEqual(weekly.cadence.days, [1, 5]);
  assert.equal(weekly.recurring, true);
  assert.equal(new Date(weekly.nextAt).toISOString(), "2026-11-20T23:30:00.000Z");
  const once = compileCadence({ kind: "once", date: "2026-11-18", time: "09:00" }, NY, T0);
  assert.equal(once.recurring, false);
  assert.equal(once.cron, undefined);
  assert.equal(new Date(once.nextAt).toISOString(), "2026-11-18T14:00:00.000Z");
  assert.equal(compileCadence({ kind: "custom", cron: "*/15  *  * * *" }, "UTC", T0).cron, "*/15 * * * *");
  assert.throws(() => compileCadence({ kind: "once", date: "2026-11-17", time: "06:00" }, NY, T0), /future/);
  assert.throws(() => compileCadence({ kind: "once", date: "2026-02-30", time: "06:00" }, NY, T0), /doesn't exist/);
  assert.throws(() => compileCadence({ kind: "daily", time: "25:00" }, NY, T0), /24-hour/);
  assert.throws(() => compileCadence({ kind: "weekly", time: "09:00", days: [] }, NY, T0), /at least one day/);
  assert.throws(() => compileCadence({ kind: "custom", cron: "* * *" }, NY, T0), /five cron fields/);
  assert.throws(() => compileCadence({ kind: "hourly" }, NY, T0), /Choose Once/);
  assert.throws(() => compileCadence({ kind: "daily", time: "09:00" }, "Mars/Olympus", T0), /time zone/);
  // The computer's zone is the default.
  assert.equal(compileCadence({ kind: "daily", time: "09:00" }, undefined, T0).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(describeCadence(weekly.cadence), "Weekly on Mon, Fri at 6:30 PM");
  assert.equal(describeCadence({ kind: "weekdays", time: "09:00" }), "Weekdays at 9:00 AM");
  assert.equal(describeCadence(once.cadence), "Once on 2026-11-18 at 9:00 AM");
});

test("daily and one-time cadences keep the local hour across DST changes", () => {
  // DST starts 2026-03-08 in New York: 9:00 is 14:00Z before and 13:00Z after.
  const before = compileCadence({ kind: "daily", time: "09:00" }, NY, Date.UTC(2026, 2, 7, 0));
  assert.equal(new Date(before.nextAt).toISOString(), "2026-03-07T14:00:00.000Z");
  const after = compileCadence({ kind: "daily", time: "09:00" }, NY, Date.UTC(2026, 2, 8, 15));
  assert.equal(new Date(after.nextAt).toISOString(), "2026-03-09T13:00:00.000Z");
  assert.equal(new Date(zonedTime("2026-03-09", "09:00", NY)).toISOString(), "2026-03-09T13:00:00.000Z");
  assert.equal(new Date(zonedTime("2026-11-02", "09:00", NY)).toISOString(), "2026-11-02T14:00:00.000Z");
  assert.equal(new Date(zonedTime("2026-07-01", "09:00", "Europe/Berlin")).toISOString(), "2026-07-01T07:00:00.000Z");
  // 02:30 doesn't exist on 2026-03-08; it lands within an hour of it.
  const gap = zonedTime("2026-03-08", "02:30", NY);
  assert.ok(Math.abs(gap - Date.UTC(2026, 2, 8, 7, 0)) <= 3600000);
});

test("create, edit, pause, resume, duplicate and delete a routine", async (t) => {
  const { ws } = setup(t);
  const r = ws.panels.routines;
  assert.throws(() => r.create({ botId: "pip", name: "x".repeat(81), prompt: "Hi", cadence: { kind: "daily", time: "09:00" } }, T0), /80/);
  assert.throws(() => r.create({ botId: "pip", name: "Inbox", prompt: "x".repeat(4001), cadence: { kind: "daily", time: "09:00" } }, T0), /4,000/);
  assert.throws(() => r.create({ botId: "nobody", name: "Inbox", prompt: "Hi", cadence: { kind: "daily", time: "09:00" } }, T0), /Unknown bot/);
  const id = r.create({ botId: "pip", name: "Inbox", prompt: "Remind me to review my inbox.", cadence: { kind: "weekdays", time: "09:00" }, timezone: NY }, T0);
  const chat = ws.chat(id);
  assert.equal(chat.title, "Routine · Inbox");
  const entry = chat.schedules[0];
  assert.deepEqual(
    { routine: entry.routine, enabled: entry.enabled, createdAt: entry.createdAt, recurring: entry.recurring, cron: entry.cron, timezone: entry.timezone },
    { routine: true, enabled: true, createdAt: T0, recurring: true, cron: "0 9 * * 1-5", timezone: NY },
  );
  assert.equal(new Date(entry.nextAt).toISOString(), "2026-11-17T14:00:00.000Z");

  r.update(id, { name: "Inbox sweep", cadence: { kind: "weekly", time: "10:00", days: ["mon"] } }, T0);
  assert.equal(chat.title, "Routine · Inbox sweep");
  assert.equal(entry.cron, "0 10 * * 1");
  assert.equal(entry.prompt, "Remind me to review my inbox.");

  r.setEnabled(id, null, false);
  assert.equal(entry.enabled, false);
  tickChatSchedules(ws, entry.nextAt + 1);
  assert.equal(ws.state.runs.length, 0, "a paused routine never ticks");
  const later = entry.nextAt + 7 * 86400000;
  r.setEnabled(id, null, true, later);
  assert.ok(entry.nextAt > later, "resuming moves the next run past now");

  const copy = r.duplicate(id, "scout", T0);
  assert.equal(ws.chat(copy).botId, "scout");
  assert.equal(ws.chat(copy).schedules[0].name, "Inbox sweep");
  assert.equal(r.list("scout").length, 1);
  assert.equal(r.list().length, 2);

  await r.remove(id);
  assert.throws(() => ws.chat(id), /Unknown chat/);
  // Deleting the routine chat itself also removes its routine.
  await ws.agents.deleteChat(copy);
  assert.equal(r.list().length, 0);
});

test("the tick runs due routines with scheduleId, finishes one-time routines and skips paused schedules", async (t) => {
  const { ws, prompts } = setup(t);
  const r = ws.panels.routines;
  const id = r.create({ botId: "pip", name: "Stretch", prompt: "Remind me to stretch.", cadence: { kind: "once", date: "2026-11-18", time: "09:00" }, timezone: NY }, T0);
  const plain = ws.chat(ws.createChat("scout"));
  plain.messages.push({ role: "user", text: "earlier" });
  plain.schedules = [{ id: 4, prompt: "Ping", nextAt: 1000, intervalMs: 60000, recurring: true, enabled: false }];
  const due = ws.chat(id).schedules[0].nextAt;
  tickChatSchedules(ws, due);
  assert.equal(ws.state.runs.length, 1, "only the routine ran");
  const run = ws.state.runs[0];
  assert.deepEqual([run.scheduleId, run.trigger, run.title], [1, "scheduled", "Stretch"]);
  await ws.active.get(id).done;
  assert.equal(run.status, "Completed");
  assert.equal(ws.chat(id).title, "Routine · Stretch", "the first run keeps the routine chat title");
  assert.deepEqual(prompts, ["Remind me to stretch."]);
  const entry = ws.chat(id).schedules[0];
  assert.equal(entry.nextAt, null);
  assert.equal(entry.finishedAt, due);
  tickChatSchedules(ws, due + 86400000);
  assert.equal(ws.state.runs.length, 1, "a finished one-time routine does not run again");
  assert.throws(() => r.setEnabled(id, null, true, due + 1), /one-time/);

  // Resuming a plain /every schedule restores it; the tick then runs it.
  r.setEnabled(plain.id, 4, true, 67000);
  assert.equal(plain.schedules[0].nextAt, 121000);
  tickChatSchedules(ws, 121000);
  await ws.active.get(plain.id).done;
  assert.equal(ws.state.runs[0].scheduleId, 4);
  assert.equal(ws.state.runs[0].title, "Scheduled · Ping");
  r.removeSchedule(plain.id, 4);
  assert.equal(plain.schedules.length, 0);

  // Run now records the schedule without moving it.
  const daily = r.create({ botId: "pip", name: "Daily", prompt: "Hello", cadence: { kind: "daily", time: "09:00" }, timezone: NY }, T0);
  const next = ws.chat(daily).schedules[0].nextAt;
  await r.run(daily);
  assert.deepEqual([ws.state.runs[0].scheduleId, ws.state.runs[0].trigger], [1, "manual"]);
  assert.equal(ws.chat(daily).schedules[0].nextAt, next);
});

function activeTurn(ws, chatId, run) {
  const task = { stopped: false };
  ws.active.set(chatId, task);
  return { task, run: { id: "run-" + chatId, chatId, ...run } };
}
const toolMap = (ws, botId, chatId, run, task) =>
  Object.fromEntries(ws.panels.routines.tools(ws.bot(botId), ws.chat(chatId), run, task).map((tool) => [tool.name, tool]));

test("routine tools are scoped to the calling bot and routine runs can't create routines", async (t) => {
  const { ws } = setup(t);
  const pipChat = ws.createChat("pip");
  const a = activeTurn(ws, pipChat, {});
  const pip = toolMap(ws, "pip", pipChat, a.run, a.task);
  assert.deepEqual(Object.keys(pip).sort(), ["routine_create", "routine_delete", "routine_list", "routine_pause", "routine_resume", "routine_update"]);
  const created = JSON.parse(
    await pip.routine_create.handler({ name: "Inbox", instructions: "Remind the person to review their inbox.", cadence: "weekdays", time: "09:00", timezone: NY }),
  );
  assert.equal(created.cadence, "Weekdays at 9:00 AM");
  assert.equal(ws.chat(created.id).botId, "pip");
  assert.equal(JSON.parse(await pip.routine_list.handler({})).length, 1);
  const updated = JSON.parse(await pip.routine_update.handler({ id: created.id, cadence: "daily", time: "08:15" }));
  assert.equal(updated.cadence, "Daily at 8:15 AM");
  assert.equal(JSON.parse(await pip.routine_pause.handler({ id: created.id })).enabled, false);
  assert.equal(JSON.parse(await pip.routine_resume.handler({ id: created.id })).enabled, true);

  const scoutChat = ws.createChat("scout");
  const b = activeTurn(ws, scoutChat, {});
  const scout = toolMap(ws, "scout", scoutChat, b.run, b.task);
  assert.deepEqual(JSON.parse(await scout.routine_list.handler({})), []);
  await assert.rejects(async () => scout.routine_pause.handler({ id: created.id }), /Unknown routine for this bot/);
  await assert.rejects(async () => scout.routine_delete.handler({ id: created.id }), /Unknown routine for this bot/);
  await assert.rejects(async () => scout.routine_delete.handler({ id: scoutChat }), /Unknown routine/);

  // A routine's own run gets no routine_create, so it can't multiply.
  const c = activeTurn(ws, created.id, { scheduleId: 1, trigger: "scheduled" });
  const inRoutine = toolMap(ws, "pip", created.id, c.run, c.task);
  assert.equal(inRoutine.routine_create, undefined);
  assert.ok(inRoutine.routine_list);
  // A routine can't delete itself mid-run.
  await assert.rejects(async () => inRoutine.routine_delete.handler({ id: created.id }), /Stop the running reply/);
  ws.active.delete(created.id);
  // Panel refreshes get no routine tools; inactive turns are refused.
  assert.equal(ws.panels.routines.tools(ws.bot("pip"), ws.chat(pipChat), { panelId: "p" }, a.task).length, 0);
  a.task.stopped = true;
  await assert.rejects(async () => pip.routine_list.handler({}), /no longer active/);
  b.task.stopped = false;
  ws.active.delete(scoutChat);
  await assert.rejects(async () => scout.routine_list.handler({}), /no longer active/);
  a.task.stopped = false;
  await pip.routine_delete.handler({ id: created.id }).catch(() => {});
});

test("quiet hours include the start, exclude the end and can cross midnight", () => {
  const at = (h, m = 0) => new Date(Date.UTC(2026, 10, 17, h, m));
  const night = { enabled: true, from: "22:00", to: "07:00" };
  assert.equal(inQuietHours(night, at(22), "UTC"), true);
  assert.equal(inQuietHours(night, at(23, 30), "UTC"), true);
  assert.equal(inQuietHours(night, at(6, 59), "UTC"), true);
  assert.equal(inQuietHours(night, at(7), "UTC"), false);
  assert.equal(inQuietHours(night, at(12), "UTC"), false);
  assert.equal(inQuietHours(night, at(3), NY), true, "03:00Z is 22:00 in New York");
  assert.equal(inQuietHours(night, at(13), NY), false, "13:00Z is 08:00 in New York");
  const day = { enabled: true, from: "09:00", to: "17:00" };
  assert.equal(inQuietHours(day, at(9), "UTC"), true);
  assert.equal(inQuietHours(day, at(17), "UTC"), false);
  assert.equal(inQuietHours(day, at(8, 59), "UTC"), false);
  assert.equal(inQuietHours({ enabled: true, from: "08:00", to: "08:00" }, at(8), "UTC"), false, "equal times make an empty window");
  assert.equal(inQuietHours({ ...night, enabled: false }, at(23), "UTC"), false);
});

test("notification decisions follow the toggles, focus, quiet hours and run kind", () => {
  const noon = new Date(Date.UTC(2026, 10, 17, 12));
  const settings = { notifications: structuredClone(defaultSettings.notifications) };
  const ctx = (extra = {}) => ({ settings, focused: false, now: noon, timeZone: "UTC", ...extra });
  const bot = { name: "Pip" };
  const chat = { id: "c1", title: "Plans", messages: [{ role: "user", text: "Hi", runId: "r1" }, { role: "assistant", text: "## Here you go\nSecond line", runId: "r1" }] };
  const reply = { type: "turn", bot, chat, run: { id: "r1", chatId: "c1", title: "Hi", status: "Completed" } };
  assert.deepEqual(decide(reply, ctx()), { title: "Pip · Plans", body: "Here you go", chatId: "c1" });
  assert.equal(decide(reply, ctx({ focused: true })), null, "no reply alert while the window is focused");
  assert.equal(decide({ ...reply, run: { ...reply.run, status: "Stopped" } }, ctx()), null);

  const routine = { ...reply, run: { ...reply.run, title: "Inbox", trigger: "scheduled", scheduleId: 1 } };
  assert.deepEqual(decide(routine, ctx({ focused: true })), { title: "Pip · Inbox", body: "Here you go", chatId: "c1" }, "routines notify even when focused");
  const failed = { ...routine, run: { ...routine.run, status: "Needs you", detail: "Copilot is offline\nstack" } };
  assert.equal(decide(failed, ctx()).body, "Failed: Copilot is offline");
  const runNow = { ...reply, run: { ...reply.run, title: "Inbox", trigger: "manual", scheduleId: 1 } };
  assert.ok(decide(runNow, ctx({ focused: true })), "Run now counts as a routine run");

  const panel = { ...reply, run: { ...reply.run, panelId: "p", trigger: "scheduled" } };
  assert.equal(decide(panel, ctx()), null, "successful panel refreshes stay quiet");
  assert.ok(decide({ ...panel, run: { ...panel.run, status: "Needs you", detail: "x" } }, ctx()));

  const request = { type: "request", bot, request: { id: "q", chatId: "c1", botId: "pip", kind: "permission", title: "Run git status" } };
  assert.deepEqual(decide(request, ctx()), { title: "Pip needs your approval", body: "Run git status", chatId: "c1" });
  assert.equal(decide(request, ctx({ focused: true })), null);
  assert.equal(decide({ ...request, request: { ...request.request, kind: "question" } }, ctx()).title, "Pip has a question");

  settings.notifications.replies = false;
  assert.equal(decide(reply, ctx()), null);
  settings.notifications.routines = false;
  assert.equal(decide(routine, ctx()), null);
  settings.notifications.requests = false;
  assert.equal(decide(request, ctx()), null);
  Object.assign(settings.notifications, { replies: true, routines: true, requests: true });
  settings.notifications.quietHours = { enabled: true, from: "11:00", to: "13:00" };
  for (const e of [reply, routine, request]) assert.equal(decide(e, ctx()), null, "quiet hours skip every alert");
  assert.equal(firstLine("\n\n- **x**" + "y".repeat(200)).length, 140);
});

test("notification settings are validated and merged", () => {
  const s = changeSettings(defaultSettings, { notifications: { replies: false, quietHours: { enabled: true, from: "23:30" } } });
  assert.deepEqual(s.notifications, { replies: false, routines: true, requests: true, quietHours: { enabled: true, from: "23:30", to: "07:00" } });
  assert.throws(() => changeSettings(s, { notifications: { quietHours: { from: "24:00" } } }), /Invalid notification/);
  assert.throws(() => changeSettings(s, { notifications: { replies: "yes" } }), /Invalid notification/);
  assert.throws(() => changeSettings(s, { notifications: { sound: true } }), /Invalid notification/);
});

test("usage totals by day, model and bot over 7, 30 and 90 days", () => {
  const now = Date.UTC(2026, 10, 17, 18);
  const day = 86400000;
  const state = {
    bots: [{ id: "pip", name: "Pip" }, { id: "scout", name: "Scout" }],
    chats: [{ id: "a", botId: "pip", title: "=SUM(1)" }, { id: "b", botId: "scout", title: "Research, notes" }],
    runs: [
      { id: "1", chatId: "a", time: now - 1000, status: "Completed", title: "One", usage: { input: 100, output: 50, cost: 0.5, model: "gpt-x" } },
      { id: "2", chatId: "a", time: now - day, status: "Completed", title: "Two", model: { model: "claude-y" }, usage: { input: 10, output: 5 } },
      { id: "3", chatId: "b", time: now - 10 * day, status: "Needs you", title: "Three", usage: { input: 1000, output: 1, model: "gpt-x", cost: 1 } },
      { id: "4", chatId: "b", time: now - 40 * day, status: "Completed", title: "Old", usage: { input: 7, output: 7 } },
      { id: "5", chatId: "a", time: now - 2000, status: "Working", title: "Live" },
      { id: "6", chatId: "gone", time: now - 3000, status: "Completed", title: "No usage" },
    ],
  };
  // Two providers can have a model of the same id: each gets its own row, named with its provider.
  const twice = usageReport(
    {
      ...state,
      runs: [
        { id: "a", chatId: "a", time: now - 1000, status: "Completed", title: "A", model: { model: "gpt-x", provider: "copilot" }, usage: { input: 5, output: 1 } },
        { id: "b", chatId: "a", time: now - 900, status: "Completed", title: "B", model: { model: "gpt-x", provider: "codex" }, usage: { input: 9, output: 1 } },
        { id: "c", chatId: "a", time: now - 800, status: "Completed", title: "C", model: { model: "gpt-x", provider: "codex" }, usage: { input: 9, output: 1 } },
      ],
    },
    { days: 7, now, timeZone: "UTC" },
  );
  assert.deepEqual(twice.byModel.map((m) => [m.provider, m.model, m.turns]), [["codex", "gpt-x", 2], ["copilot", "gpt-x", 1]]);
  const week = usageReport(state, { days: 7, now, timeZone: "UTC" });
  assert.equal(week.byDay.length, 7);
  assert.equal(week.byDay.at(-1).date, "2026-11-17");
  assert.deepEqual(
    { turns: week.totals.turns, input: week.totals.input, output: week.totals.output, cost: week.totals.cost, priced: week.totals.priced },
    { turns: 3, input: 110, output: 55, cost: 0.5, priced: 1 },
  );
  assert.equal(week.byDay.at(-1).turns, 2);
  assert.equal(week.byDay.at(-2).input, 10);
  assert.deepEqual(week.byModel.map((m) => [m.model, m.turns]), [["gpt-x", 1], ["claude-y", 1], ["Unknown", 1]]);
  assert.deepEqual(week.byBot.map((b) => [b.name, b.turns]), [["Pip", 2], ["Deleted bot", 1]]);
  const month = usageReport(state, { days: 30, now, timeZone: "UTC" });
  assert.equal(month.totals.turns, 4);
  assert.equal(month.byModel[0].model, "gpt-x");
  assert.equal(month.byModel[0].input, 1100);
  assert.equal(usageReport(state, { days: 90, now, timeZone: "UTC" }).totals.turns, 5);
  assert.throws(() => usageReport(state, { days: 12, now }), /7, 30 or 90/);
  // A run at 02:00Z on the 17th is the 16th in New York.
  const ny = usageReport({ ...state, runs: [{ ...state.runs[0], time: Date.UTC(2026, 10, 17, 2) }] }, { days: 7, now, timeZone: NY });
  assert.equal(ny.byDay.find((d) => d.turns).date, "2026-11-16");
  const csv = usageCsv(state, { days: 7, now, timeZone: "UTC" }).trim().split("\n");
  assert.equal(csv.length, 4);
  assert.match(csv[0], /^time,date,bot,chat,title,status,trigger,model,input_tokens.*,duration_ms,provider$/);
  assert.ok(csv.some((l) => l.includes(`"'=SUM(1)"`)), "formula-like cells are neutralized");
});
