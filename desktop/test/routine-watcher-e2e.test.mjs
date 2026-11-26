// A watcher as a script routine, end to end, against a real service: the script reads the task board with the
// `botkins` command from its own shell (BOTKINS_ROUTINE=1), remembers what it reported in $BOTKINS_ROUTINE_STATE,
// stays silent while nothing changed, and wakes the bot once, with the task's facts already gathered.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";
import { fakeClient } from "./fake-copilot.mjs";

const skip = process.platform === "win32" && "A bot's shell has the `botkins` command on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const quoted = (text) => "'" + String(text).replaceAll("'", "'\\''") + "'";

test("a watcher script is silent while a task works, wakes the bot once on review with its facts, and not again", { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-watch-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  // The service's environment is what a routine's script gets (its PATH and BOTKINS_SOCKET): put this process's back after.
  const before = { PATH: process.env.PATH, BOTKINS_SOCKET: process.env.BOTKINS_SOCKET };
  t.after(() => {
    for (const [name, value] of Object.entries(before)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  const running = await startService({ paths, version: "9.9.9", trial: true, reach: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const ws = running.runtime.workspace;
  // The follow-up's model: a fake that records what it is sent.
  const prompts = [];
  const fake = fakeClient(async (_id, options) => {
    prompts.push(options.prompt);
    return { data: { content: "The task Ship the release notes is ready for your review." } };
  });
  ws.providers.byId.get("copilot").connect = fake.client;
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const nova = await client.call("bots.add", { name: "Nova" });
  const task = await client.call("tasks.add", { title: "Ship the release notes", details: "Draft and post them.", bot: "Nova" });
  // A task the bot is working on (only Botkins puts a task there).
  Object.assign(ws.tasks.get(task.id), { status: "working" });

  const script = [
    "now=$(botkins tasks show " + quoted(task.id) + " --json) || exit 1",
    "printf '%s' \"$now\" | " + quoted(process.execPath) + " -e '",
    '  const fs = require("fs"), file = process.env.BOTKINS_ROUTINE_STATE + "/reported.json";',
    '  const t = JSON.parse(fs.readFileSync(0, "utf8"));',
    '  const seen = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};',
    '  if (t.status !== "review" || seen[t.id] === t.status) { console.log(JSON.stringify({ wakeAgent: false })); process.exit(0); }',
    "  seen[t.id] = t.status;",
    "  fs.writeFileSync(file, JSON.stringify(seen));",
    '  console.log("routine=" + process.env.BOTKINS_ROUTINE);',
    "  console.log(JSON.stringify({ id: t.id, title: t.title, status: t.status, bot: t.bot, details: t.details }));'",
  ].join("\n");
  const routines = ws.panels.routines;
  const watcher = routines.create({ botId: nova.id, name: "Task watch", script, followUp: true, prompt: "Tell the person which task is ready for review, from the script's output.", cadence: { kind: "custom", cron: "*/15 * * * *" } });
  const runsOf = () => ws.state.runs.filter((run) => run.chatId === watcher);

  // Working: the script sees nothing to say, and no model turn is taken.
  await routines.run(watcher);
  await routines.run(watcher);
  assert.deepEqual(runsOf().map((run) => [run.status, run.silent, run.script?.exitCode]), [["Completed", true, 0], ["Completed", true, 0]]);
  assert.equal(prompts.length, 0, "no model turn while the task works");

  // Review: one follow-up, with the task's facts already gathered by the script.
  // The task's turn ends: Botkins moves it to review itself (desktop/tasks.mjs `finished`).
  Object.assign(ws.tasks.get(task.id), { status: "review", updatedAt: Date.now() });
  ws.save();
  await routines.run(watcher);
  assert.equal(runsOf()[0].status, "Completed");
  assert.equal(runsOf()[0].silent, undefined);
  assert.equal(prompts.length, 1, "woken once");
  assert.match(prompts[0], /Tell the person which task is ready for review/);
  assert.match(prompts[0], /routine=1/);
  assert.ok(prompts[0].includes(JSON.stringify({ id: task.id, title: "Ship the release notes", status: "review", bot: "Nova", details: "Draft and post them." })), prompts[0]);

  // Still in review: already reported, so silent again.
  await routines.run(watcher);
  assert.equal(runsOf()[0].silent, true);
  assert.equal(prompts.length, 1, "not woken again");

  // The routine's runs and a chat's messages are JSON a script can read, from its own shell.
  const reader = routines.create({ botId: nova.id, name: "Reader", script: 'botkins routines runs "' + watcher + '" --limit 2 --json && botkins chats messages "' + watcher + '" --role assistant --last 1 --json', cadence: { kind: "daily", time: "09:00" } });
  await routines.run(reader);
  const output = ws.chat(reader).messages.findLast((message) => message.role === "assistant").text;
  assert.equal(ws.state.runs[0].script?.exitCode, 0, output);
  const [runsLine, messagesLine] = output.split("\n");
  const runs = JSON.parse(runsLine);
  assert.deepEqual(runs.map((run) => [run.status, run.silent === true]), [["Completed", true], ["Completed", false]]);
  assert.equal(runs[1].reply, "The task Ship the release notes is ready for your review.");
  const messages = JSON.parse(messagesLine);
  assert.equal(messages.chatId, watcher);
  assert.deepEqual(messages.messages.map((message) => [message.role, message.text]), [["assistant", "The task Ship the release notes is ready for your review."]]);
});
