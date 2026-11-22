// The Proactive agent (Settings › Experimental): its setting, its managed routine and the gate that wakes it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { cronEvery, proactiveField, signals } from "../desktop/proactive.mjs";
import { dispatch } from "../desktop/routines.mjs";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 22, 18);

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-proactive-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  return { ws: new Workspace(dir, client, () => {}, () => ({ kind: "reject" })), seen };
}

test("the setting is checked whole, off by default, and needs a bot to turn on", () => {
  assert.equal(proactiveField({}).enabled, false);
  assert.throws(() => proactiveField({ enabled: true }), /Choose the bot/);
  assert.throws(() => proactiveField({ every: 7 }), /how often/);
  assert.throws(() => proactiveField({ nope: 1 }), /Unknown/);
  assert.deepEqual(proactiveField({ watch: ["runs", "runs"] }).watch, ["runs"]);
  assert.equal(cronEvery(15), "*/15 * * * *");
  assert.equal(cronEvery(120), "0 */2 * * *");
});

test("turning it on makes one managed routine; off pauses it; another bot moves it", (t) => {
  const { ws } = setup(t);
  ws.setPreferences({ proactive: { enabled: true, botId: "pip", every: 15 } });
  const mine = () => ws.panels.routines.list().filter(({ entry }) => entry.proactive);
  assert.equal(mine().length, 1);
  assert.equal(mine()[0].entry.cron, "*/15 * * * *");
  assert.equal(mine()[0].chat.botId, "pip");
  assert.throws(() => ws.panels.routines.update(mine()[0].chat.id, { name: "x" }), /Settings › Experimental/);
  ws.setPreferences({ proactive: { enabled: false } });
  assert.equal(mine()[0].entry.enabled, false);
  ws.setPreferences({ proactive: { enabled: true, botId: "scout" } });
  assert.equal(mine().length, 1);
  assert.equal(mine()[0].chat.botId, "scout");
  assert.throws(() => ws.setPreferences({ proactive: { botId: "ghost" } }), /Unknown bot/);
});

test("signals come from failed routine runs, waiting tasks and unanswered requests", () => {
  const state = {
    runs: [
      { id: "r1", scheduleId: 1, status: "Needs you", title: "Bills", detail: "Gmail expired", finished: NOW - HOUR, chatId: "c" },
      { id: "r2", status: "Needs you", title: "A chat", finished: NOW - HOUR, chatId: "c" },
      { id: "r3", scheduleId: 1, status: "Needs you", title: "Old", finished: NOW - 48 * HOUR, chatId: "c" },
    ],
    tasks: [
      { id: "t1", status: "review", title: "Draft", updatedAt: NOW - 5 * HOUR },
      { id: "t2", status: "review", title: "Fresh", updatedAt: NOW - HOUR },
    ],
  };
  const requests = [{ id: "q1", kind: "permission", title: "Run rm", chatId: "c", time: NOW - HOUR }];
  const keys = signals(state, requests, ["runs", "tasks", "requests"], NOW, "own").map((s) => s.key.split(":").slice(0, 2).join(":"));
  assert.deepEqual(keys, ["run:r1", "task:t1", "request:q1"]);
  assert.deepEqual(signals(state, requests, ["tasks"], NOW, "own").length, 1);
});

test("the gate wakes the bot once per signal, sweeps on its clock, and keeps quiet hours and the cap", async (t) => {
  const { ws, seen } = setup(t);
  ws.setPreferences({ proactive: { enabled: true, botId: "pip", sweepHours: 0, maxPerDay: 3 } });
  const { chat, entry } = ws.proactive.routine();
  const tick = () => dispatch(ws, chat, entry, "scheduled");

  await tick();
  assert.equal(seen.prompts.length, 0, "nothing new and no sweep: no model");

  ws.state.runs.unshift({ id: "bad", chatId: "x", scheduleId: 9, status: "Needs you", title: "Bills", time: Date.now(), finished: Date.now() });
  await tick();
  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0], /Routine “Bills” needs the person/);
  assert.match(seen.prompts[0], /\[SILENT\]/);
  const run = ws.state.runs.find((r) => r.proactive);
  assert.equal(run.silent, true);
  assert.equal(ws.state.proactive.log[0].outcome, "silent");

  await tick();
  assert.equal(seen.prompts.length, 1, "the same signal never wakes it twice");

  await dispatch(ws, chat, entry, "manual");
  assert.equal(seen.prompts.length, 2, "Check now always wakes it");

  seen.reply = "Bills routine is failing: Gmail sign-in expired.";
  ws.setPreferences({ proactive: { sweepHours: 1 } });
  ws.state.proactive.lastSweepAt = 0;
  await tick();
  assert.equal(seen.prompts.length, 3, "a due sweep wakes it");
  assert.equal(ws.state.proactive.log[0].outcome, "alerted");
  assert.equal(ws.state.proactive.pings, 1);
  assert.match(ws.proactive.prompt("sweep", [], ws.state.settings.proactive), /already told the person[\s\S]*Gmail sign-in expired/);

  ws.state.proactive.pings = 3;
  ws.state.proactive.lastSweepAt = 0;
  await tick();
  assert.equal(seen.prompts.length, 3, "the day's cap holds it");

  ws.state.proactive.pings = 0;
  ws.setPreferences({ notifications: { quietHours: { enabled: true, from: "00:00", to: "23:59" } } });
  await tick();
  assert.equal(seen.prompts.length, 3, "quiet hours hold it");
});

test("removing its routine or its bot turns the agent off", async (t) => {
  const { ws } = setup(t);
  ws.setPreferences({ proactive: { enabled: true, botId: "patch" } });
  await ws.panels.routines.remove(ws.proactive.routine().chat.id);
  assert.equal(ws.state.settings.proactive.enabled, false);
  assert.equal(ws.proactive.routine(), null);

  ws.setPreferences({ proactive: { enabled: true, botId: "patch" } });
  await ws.agents.deleteBot("patch");
  assert.equal(ws.state.settings.proactive.enabled, false);
  assert.equal(ws.state.settings.proactive.botId, null);
});
