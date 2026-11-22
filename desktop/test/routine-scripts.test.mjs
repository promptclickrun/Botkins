// Script routines (a script with no model, with or without a follow-up action) and a routine's model.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { authorize } from "../desktop/link/team.mjs";
import { shellFor } from "../desktop/routine-script.mjs";
import { decide } from "../desktop/notify.mjs";

const T0 = Date.UTC(2026, 10, 17, 12);
const DAILY = { kind: "daily", time: "09:00" };
const unix = process.platform !== "win32";

function setup(t, dir = mkdtempSync(join(tmpdir(), "botkins-routine-scripts-"))) {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = { prompts: [], reply: "Done with it." };
  const handlers = new Set();
  const session = {
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      seen.prompts.push(prompt);
      const id = "message:" + seen.prompts.length;
      for (const handler of handlers) handler({ type: "user.message", id, data: { messageId: id } });
      for (const handler of handlers) handler({ type: "assistant.message", data: { originatingMessageId: id, content: seen.reply } });
      for (const handler of handlers) handler({ type: "session.idle", data: { mode: "interactive" } });
      return id;
    },
  };
  const client = async () => ({ createSession: async () => session, resumeSession: async () => session, deleteSession: async () => {} });
  return { ws: new Workspace(dir, client, () => {}, () => ({ kind: "reject" })), seen, dir };
}

test("a script routine runs its script with no model and its output is the run's reply", { skip: !unix }, async (t) => {
  const { ws, seen } = setup(t);
  const id = ws.panels.routines.create({ botId: "pip", name: "Disk check", script: "echo hello\necho warning >&2", cadence: DAILY }, T0);
  await ws.panels.routines.run(id);
  const run = ws.state.runs[0];
  assert.equal(run.status, "Completed");
  assert.equal(run.script.exitCode, 0);
  assert.equal(seen.prompts.length, 0, "no model turn");
  assert.equal(run.steps[0].name, "Script");
  assert.match(run.steps[0].output, /hello[\s\S]*warning/);
  const reply = ws.chat(id).messages.findLast((message) => message.role === "assistant" && message.runId === run.id);
  assert.match(reply.text, /^hello\nwarning$/);
  assert.equal(ws.panels.routines.view(ws.chat(id), ws.panels.routines.find(id).entry).script, "echo hello\necho warning >&2");
});

test("a script whose last line is {\"wakeAgent\": false} ends the run quietly with no model turn", { skip: !unix }, async (t) => {
  const { ws, seen } = setup(t);
  const target = ws.createChat("pip");
  const id = ws.panels.routines.create({ botId: "pip", name: "Inbox watch", script: "echo checked 0 new\necho '{\"wakeAgent\": false}'", followUp: true, prompt: "Tell me what is new.", cadence: DAILY, deliver: { to: "chat", chatId: target } }, T0);
  await ws.panels.routines.run(id);
  const run = ws.state.runs[0];
  assert.equal(run.status, "Completed");
  assert.equal(run.silent, true);
  assert.equal(seen.prompts.length, 0, "no model turn");
  assert.equal(ws.chat(id).messages.filter((m) => m.role === "assistant").length, 0);
  assert.equal(ws.chat(target).messages.length, 0);
  assert.equal(decide({ type: "turn", bot: ws.bot("pip"), chat: ws.chat(id), run }, { settings: ws.state.settings, focused: false }), null);

  const failing = ws.panels.routines.create({ botId: "pip", name: "Broken watch", script: "echo '{\"wakeAgent\": false}'; exit 2", cadence: DAILY }, T0);
  await ws.panels.routines.run(failing);
  assert.equal(ws.state.runs[0].status, "Needs you", "a failed script is never quiet");
  assert.equal(ws.state.runs[0].silent, undefined);

  const waking = ws.panels.routines.create({ botId: "pip", name: "Busy watch", script: "echo '{\"wakeAgent\": true}'", followUp: true, prompt: "Tell me.", cadence: DAILY }, T0);
  await ws.panels.routines.run(waking);
  assert.equal(seen.prompts.length, 1, "any other last line wakes the bot");
});

test("a failing script ends its run as failed and says how", { skip: !unix }, async (t) => {
  const { ws } = setup(t);
  const id = ws.panels.routines.create({ botId: "pip", name: "Broken", script: "echo nope; exit 3", cadence: DAILY, deliver: { to: "feed" } }, T0);
  await ws.panels.routines.run(id);
  const run = ws.state.runs[0];
  assert.equal(run.status, "Needs you");
  assert.equal(run.detail, "The script failed (exit code 3).");
  assert.equal(ws.board.items.length, 0, "a failed run delivers nothing");
});

test("a follow-up action takes the same run's turn with the script's output", { skip: !unix }, async (t) => {
  const { ws, seen } = setup(t);
  const id = ws.panels.routines.create({ botId: "pip", name: "Count", script: "echo 42", followUp: true, prompt: "Tell me the number.", cadence: DAILY, deliver: { to: "feed" } }, T0);
  await ws.panels.routines.run(id);
  const runs = ws.state.runs.filter((run) => run.chatId === id);
  assert.equal(runs.length, 1, "one run for the script and its follow-up");
  assert.equal(runs[0].status, "Completed");
  assert.equal(runs[0].steps[0].status, "Done");
  assert.equal(seen.prompts.length, 1);
  assert.match(seen.prompts[0], /Tell me the number\./);
  assert.match(seen.prompts[0], /exit code 0[\s\S]*42/);
  assert.equal(ws.board.items[0]?.title, "Done with it.", "the follow-up's reply goes where the result goes");
});

test("a follow-up needs instructions, and a script-only routine keeps them for later", () => {
  const { ws } = setup({ after() {} });
  const routines = ws.panels.routines;
  assert.throws(() => routines.create({ botId: "pip", name: "X", script: "true", followUp: true, cadence: DAILY }, T0), /follow-up instructions/);
  const id = routines.create({ botId: "pip", name: "X", script: "true", followUp: false, prompt: "Keep me.", cadence: DAILY }, T0);
  assert.equal(routines.find(id).entry.prompt, "Keep me.");
  routines.update(id, { script: null }, T0);
  assert.equal(routines.find(id).entry.script, undefined, "null takes the script away");
  assert.throws(() => routines.update(id, { script: "x".repeat(20001) }, T0), /up to 20,000/);
});

test("only the owner adds or changes a routine's script", () => {
  const { ws } = setup({ after() {} });
  assert.throws(() => ws.panels.routines.create({ botId: "pip", name: "X", script: "true", cadence: DAILY }, T0, "m_avery"), /Only the computer's owner/);
  const team = { members: [{ id: "m_avery", groupId: "g" }], groups: [{ id: "g", roleId: "r" }], roles: [{ id: "r", bots: "all", perms: { today: ["use", "create", "manage"] } }] };
  const member = { kind: "member", memberId: "m_avery" };
  const lookups = { bot: (id) => (id === "pip" ? { id } : null) };
  const refusal = authorize(member, team, "createRoutine", [{ botId: "pip", name: "X", script: "rm -rf ~" }], lookups);
  assert.match(refusal, /Only the owner/);
  assert.match(authorize(member, team, "updateRoutine", ["chat", { script: "true" }], lookups), /Only the owner/);
});

test("a routine's chat uses its own model, then the routines default, then the bot's and the default", () => {
  const { ws } = setup({ after() {} });
  const id = ws.panels.routines.create({ botId: "pip", name: "X", prompt: "Do it.", cadence: DAILY }, T0);
  const plain = ws.createChat("pip");
  ws.state.settings.model = { model: "global" };
  ws.bot("pip").model = { model: "bots" };
  assert.equal(ws.effectiveModel(ws.chat(id)).model, "bots");
  ws.state.settings.routineModel = { model: "routines" };
  assert.equal(ws.effectiveModel(ws.chat(id)).model, "routines");
  assert.equal(ws.effectiveModel(ws.chat(plain)).model, "bots", "other chats keep the bot's model");
  ws.chat(id).model = { model: "own" };
  assert.equal(ws.effectiveModel(ws.chat(id)).model, "own");
  assert.equal(ws.panels.routines.view(ws.chat(id), ws.panels.routines.find(id).entry).model.model, "own");
});

test("Stop ends a running script, and a restart ends one that Botkins closed during", { skip: !unix }, async (t) => {
  const { ws, dir } = setup(t);
  const id = ws.panels.routines.create({ botId: "pip", name: "Slow", script: "sleep 30", cadence: DAILY }, T0);
  const done = ws.panels.routines.run(id);
  assert.ok(ws.active.has(id), "the chat is busy while the script runs");
  assert.throws(() => ws.panels.routines.run(id), /already running/);
  // A copy opened from the saved file now sees a script that was running when it closed.
  const reopened = setup({ after() {} }, dir).ws;
  const interrupted = reopened.state.runs.find((run) => run.chatId === id);
  assert.equal(interrupted.status, "Interrupted");
  assert.equal(interrupted.detail, "Botkins closed while the script ran.");
  await ws.stop(id);
  await done;
  assert.equal(ws.state.runs[0].status, "Stopped");
});

test("a script runs with the person's shell, or PowerShell on Windows", () => {
  assert.deepEqual(shellFor("ls", "darwin", { SHELL: "/bin/zsh" }), { file: "/bin/zsh", args: ["-l", "-c", "ls"] });
  assert.deepEqual(shellFor("ls", "linux", {}), { file: "/bin/sh", args: ["-l", "-c", "ls"] });
  assert.equal(shellFor("dir", "win32", {}).file, "powershell.exe");
});
