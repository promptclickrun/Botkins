// Spaces, panels and cards from the command line (cli/commands/spaces.mjs), against a real service. The main path:
// a space is made and named, a panel is asked for and changed in every way, a card is answered, and the log has
// no text that a person or a bot wrote. The rule that matters most: what is hard to undo, and what runs a bot on
// a schedule with nobody watching, is shown and needs a yes, and the socket refuses it without the mark.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
import { COMMANDS, describe } from "../cli/commands/index.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
/** A real service, and `botkins(argv, { input, tty })` to run a command against it. No turn of a model runs: `workspace.send` is a stand-in that notes what it was given. */
async function service(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-spaces-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const workspace = running.runtime.workspace;
  const sent = [];
  workspace.send = async (chatId, message) => void sent.push({ chatId, message });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const botkins = async (argv, { input = "", tty = false } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const stdout = sink((text) => void (out += text));
    stdout.isTTY = false;
    const exit = await main(argv, { stdout, stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("Changed from the command line")).map((text) => text.split("Changed from the command line: ")[1]);
  const everything = () => [readFileSync(join(paths.dataDir, "workspace.json"), "utf8"), readFileSync(paths.logFile, "utf8")].join("\n");
  /** A panel as a bot would have published it (the host's own `write` needs a running turn). */
  const seed = (spaceId, title, extra = {}) => {
    const bot = workspace.state.bots[0];
    const panel = { id: randomUUID(), key: "k" + workspace.state.panels.length, botId: bot.id, chatId: "none", spaceId, size: "wide", hidden: false, revision: 1, routine: null, title, blocks: [{ type: "markdown", text: "Hello world\nSecond line" }, { type: "metric", label: "Pages", value: "12" }], updatedAt: Date.now(), ...extra };
    workspace.state.panels.push(panel);
    return panel;
  };
  return { dir, paths, running, client, botkins, changes, everything, workspace, sent, seed };
}

test("a space and its panels: ask for a panel, change it in every way, answer a card, and the log has no text", { skip }, async (t) => {
  const { botkins, client, changes, paths, workspace, sent, seed } = await service(t);
  await botkins(["bots", "add", "Nova"]);
  // The four spaces that every person has; a built-in one cannot be renamed.
  const listed = await botkins(["spaces", "list"]);
  assert.match(listed.out, /^NAME +MADE BY +PANELS +OPEN CARDS +PROJECT +ID\nToday +owner +0 +0 +- +s_\w+\n/);
  assert.deepEqual((await botkins(["spaces", "list", "--json"])).json().map((space) => space.name), ["Today", "Feed", "Ideas", "Goals"]);
  assert.equal((await botkins(["spaces", "rename", "Today", "Mine"])).exit, 1, "the app's own refusal");
  const added = await botkins(["spaces", "add", "Reading", "list", "--json"]);
  assert.equal(added.exit, 0, added.err);
  assert.equal(added.json().name, "Reading list");
  assert.match((await botkins(["spaces", "rename", "Read", "Books"])).out, /^The space is now called Books\.\n?$/, "a name is found by its start");
  assert.match((await botkins(["spaces", "show", "Books"])).out, /^Books {3}s_\w+\nMade by: the owner\.\nPanels: 0\. Routines: 0\. Views: 0\. Cards: 0 open of 0\.\n\nNo panels yet\. Ask a bot for one with `botkins panels new --space Books --bot <bot> "<what the panel is for>"`\./);
  // A new panel is a chat with the bot and a turn: the sentence goes to the host's own `/today-panel`, with the way to start.
  assert.equal((await botkins(["panels", "new", "--space", "Books", "--bot", "Nova"])).exit, 2, "a sentence is needed");
  assert.equal((await botkins(["panels", "new", "--space", "Books", "--bot", "Nova", "--start", "bogus", "Books to read"])).exit, 1);
  const made = await botkins(["panels", "new", "--space", "Books", "--bot", "Nova", "--start", "checklist", "Books to read", "--json"]);
  assert.equal(made.exit, 0, made.err);
  assert.equal(sent.at(-1).message, "/today-panel Books to read Make it a checklist.");
  assert.equal(sent.at(-1).chatId, made.json().chatId);
  assert.match((await botkins(["panels", "new", "--space", "Books", "--bot", "Nova", "A sentence"])).out, /That started a turn of its model\./);
  // With --refresh the routine is shown first and asked for; the host keeps it with the chat until the bot publishes the panel.
  const scheduled = await botkins(["panels", "new", "--space", "Books", "--bot", "Nova", "--refresh", "weekdays", "--at", "07:30", "--timezone", "UTC", "Daily reading news", "--yes", "--json"]);
  assert.equal(scheduled.exit, 0, scheduled.err);
  assert.match(scheduled.err, /When: Weekdays at 7:30 AM\n {2}Time zone: UTC/);
  assert.deepEqual(workspace.state.chats.find((chat) => chat.id === scheduled.json().chatId).panelRoutine, { cron: "30 7 * * 1-5", timezone: "UTC", prompt: "Daily reading news" });
  assert.equal((await botkins(["panels", "new", "--space", "Books", "--bot", "Nova", "--refresh", "weekdays", "--at", "07:30", "News"])).exit, 2, "a routine needs a yes");
  // Panels, as a bot would have published them (one with a title that tries to hide itself).
  const books = (await client.call("space.get", "Books")).id;
  const tidy = seed(books, "Books I read", { state: { done: [] }, notes: [] });
  const evil = seed(books, "\u001b[31mRed");
  const panels = await botkins(["panels", "list", "--space", "Books"]);
  assert.equal(panels.out.includes("\u001b"), false, "a control character is written as its number");
  assert.match(panels.out, /Books I read +Nova +Books +wide +shown/);
  const shown = await botkins(["panels", "show", "Books I"]);
  assert.match(shown.out, /^Books I read {3}[0-9a-f-]{36}\nSpace: Books\. Bot: Nova\. Size: wide\. Shown\./);
  assert.match(shown.out, /\[markdown\]\n {2}Hello world\n {2}Second line\n\[metric\]\n {2}Pages: 12/);
  assert.match(shown.out, /Saved state of an app panel/);
  assert.equal((await botkins(["panels", "show", "nothing"])).exit, 1);
  // Hide, show, size, order, move.
  assert.match((await botkins(["panels", "hide", "Books I"])).out, /^Hid the panel Books I read\. Bring it back with `botkins panels unhide 'Books I read'`\.\n?$/);
  assert.equal((await botkins(["panels", "show", "Books I", "--json"])).json().hidden, true);
  await botkins(["panels", "unhide", "Books I"]);
  assert.match((await botkins(["panels", "size", "Books I", "tall"])).out, /is tall\./);
  assert.equal((await botkins(["panels", "size", "Books I", "huge"])).exit, 1);
  assert.match((await botkins(["panels", "order", "Books I", "later"])).out, /Moved the panel Books I read later in Books\./);
  assert.deepEqual(workspace.state.panels.filter((p) => p.spaceId === books).map((p) => p.title), [evil.title, tidy.title]);
  const moved = await botkins(["panels", "move", "Books I", "Today", "--json"]);
  assert.equal(moved.json().space.name, "Today");
  assert.equal(workspace.state.panels.find((p) => p.id === tidy.id).spaceId, workspace.spaces.all.find((s) => s.builtin === "today").id);
  // A project; the state of an app panel and notes, as the owner's own changes.
  await botkins(["projects", "add", "--name", "Library"]);
  assert.match((await botkins(["panels", "project", "Books I", "Library"])).out, /is in the project Library\./);
  assert.match((await botkins(["panels", "project", "Books I", "--none"])).out, /is in no project\./);
  assert.equal((await botkins(["panels", "project", "Books I"])).exit, 2);
  const state = await botkins(["panels", "set-state", "Books I", "done", '["Dune"]', "--label", "finished a book"]);
  assert.match(state.out, /^Changed the state of the panel Books I read \(revision 1\)\. Its keys: done\.\n?$/);
  assert.deepEqual(workspace.state.panels.find((p) => p.id === tidy.id).state, { done: ["Dune"] });
  await botkins(["panels", "set-state", "Books I", "mood", "happy"]);
  assert.equal(workspace.state.panels.find((p) => p.id === tidy.id).state.mood, "happy", "text that is not JSON is text");
  await botkins(["panels", "set-state", "Books I", "mood", "--remove"]);
  assert.equal("mood" in workspace.state.panels.find((p) => p.id === tidy.id).state, false);
  const note = await botkins(["panels", "note", "Books I", "Ask", "Sam", "for", "more", "--json"]);
  assert.equal(note.exit, 0, note.err);
  assert.match((await botkins(["panels", "show", "Books I"])).out, /Notes \(1\):\n {2}1\. .*: Ask Sam for more {3}\(n_\w+\)/);
  // A removed note cannot be got back: the command shows it and asks, and the call carries the mark.
  const keep = await botkins(["panels", "remove-note", "Books I", "1"]);
  assert.equal(keep.exit, 2);
  assert.match(keep.err, /This removes the note n_\w+ by .*from the panel Books I read\. It cannot be got back\.\n/);
  await assert.rejects(client.call("panel.noteRemove", "Books I", "1"), { code: "NEEDS_AGREEMENT" });
  assert.match((await botkins(["panels", "remove-note", "Books I", "1", "--yes"])).out, /^Removed the note n_\w+ from the panel Books I read\.\n?$/);
  assert.equal(workspace.state.panels.find((p) => p.id === tidy.id).notes.length, 0);
  // Asking a bot, and a refresh, each start a turn: the help says so, and the host's own words go to the stand-in.
  for (const [group, name] of [["spaces", "ask"], ["panels", "ask"], ["panels", "refresh"], ["panels", "new"]]) assert.match(COMMANDS[group].commands[name].details, /turn of the bot's model/, group + " " + name);
  const asked = await botkins(["panels", "ask", "Books I", "--bot", "Nova", "What", "is", "new?"]);
  assert.equal(asked.exit, 0, asked.err);
  assert.equal(sent.at(-1).message, "What is new?");
  assert.equal(workspace.state.chats.find((chat) => chat.id === sent.at(-1).chatId).aboutPanelId, tidy.id);
  const spaceAsk = await botkins(["spaces", "ask", "Today", "--bot", "Nova", "--panel", "Books I", "--file", "-"], { input: "From a file\n" });
  assert.equal(spaceAsk.exit, 0, spaceAsk.err);
  assert.equal(sent.at(-1).message, "From a file");
  const refresh = await botkins(["panels", "refresh", "Books I"]);
  assert.equal(refresh.exit, 0, refresh.err);
  assert.match(sent.at(-1).message, /^Refresh your Today panel "k\d+"\./);
  // A routine is set after it is shown; a pause keeps it.
  const routine = await botkins(["panels", "routine", "set", "Books I", "--cadence", "weekdays", "--at", "07:30", "--timezone", "UTC", "--prompt", "Check the shelf.", "--yes"]);
  assert.equal(routine.exit, 0, routine.err);
  assert.match(routine.err, /This runs the panel's bot on a schedule, with nobody watching\. The routine will be saved as:\n {2}Panel: Books I read \(Today\)\n {2}Bot: Nova\n {2}When: Weekdays at 7:30 AM\n {2}Time zone: UTC\n {2}Next: .*\n {8}.*\n {2}Prompt:\n {6}Check the shelf\./);
  assert.equal(routine.err.includes("Cost:"), false, "a slow schedule has no cost line");
  assert.match((await botkins(["panels", "routine", "pause", "Books I"])).out, /^Paused the routine of the panel Books I read\./);
  assert.equal(workspace.state.panels.find((p) => p.id === tidy.id).routine.enabled, false);
  assert.match((await botkins(["panels", "show", "Books I"])).out, /Routine: Weekdays at 7:30 AM \(paused\)/);
  // Cards: an idea is answered, and becomes a goal.
  const idea = workspace.board.post(workspace.state.bots[0].id, { kind: "idea", title: "Learn to bake", body: "Start with bread." });
  const cards = await botkins(["cards", "list", "--kind", "idea"]);
  assert.match(cards.out, /^KIND +STATUS +TITLE +BOT +SPACE +ID\nidea +open +Learn to bake +Nova +Ideas +/);
  assert.match((await botkins(["cards", "show", "Learn"])).out, /^Learn to bake {3}[0-9a-f-]{36}\nKind: idea\. Status: open\. Not read\. Bot: Nova\. Space: Ideas\.\n\nStart with bread\./);
  const goal = await botkins(["cards", "act", "Learn", "goal", "interests", "--json"]);
  assert.equal(goal.exit, 0, goal.err);
  assert.deepEqual([goal.json().card.status, goal.json().created.kind, goal.json().created.category, goal.json().created.space.name], ["done", "goal", "interests", "Goals"]);
  assert.equal((await botkins(["cards", "act", "Learn", "goal", "nothing"])).exit, 1, "a goal's category is one of the app's");
  assert.equal((await botkins(["cards", "list", "--kind", "idea"])).out.includes("Learn to bake"), false, "a done card is not open");
  assert.match((await botkins(["cards", "list", "--status", "all"])).out, /Learn to bake/);
  assert.equal(idea.status, "done");
  // The log names a space by its name, a panel and a card by their ids, and has no text that was written.
  const lines = await changes();
  assert.ok(lines.includes("space.add Reading list"));
  assert.ok(lines.includes("space.rename Books"));
  assert.ok(lines.includes("panel.change " + tidy.id + " (hide)"));
  assert.ok(lines.includes("panel.routine.set " + tidy.id));
  assert.ok(lines.includes("card.act " + idea.id + " (goal)"));
  const logText = lines.join("\n");
  for (const secret of ["Dune", "finished a book", "Ask Sam", "Check the shelf", "Books I read", "Learn to bake", "What is new"]) assert.equal(logText.includes(secret), false, secret + " is not in the log");
  // (The log file itself has no routine prompt or note either.)
  const file = readFileSync(paths.logFile, "utf8");
  for (const secret of ["Check the shelf", "Ask Sam for more", "finished a book"]) assert.equal(file.includes(secret), false, secret + " is not in the log file");
  // `help --json` describes the commands.
  const help = describe("9.9.9");
  const names = new Set(help.areas.flatMap((area) => area.commands.map((command) => command.command)));
  for (const name of ["spaces list", "spaces remove", "panels new", "panels routine set", "panels set-state", "cards act"]) assert.ok(names.has(name), name);
});

test("what is hard to undo, and a routine that runs often, are shown and need a yes; the socket refuses them without the mark", { skip }, async (t) => {
  const { botkins, client, changes, workspace, seed } = await service(t);
  await botkins(["bots", "add", "Nova"]);
  await botkins(["spaces", "add", "Work"]);
  const work = (await client.call("space.get", "Work")).id;
  const plan = seed(work, "Plan");
  seed(work, "Tasks", { routine: { cron: "0 9 * * *", timezone: "UTC", prompt: "Secret prompt words", enabled: true, nextAt: Date.now() + 1000 } });
  // A space's removal shows what goes, and with no terminal needs --yes.
  const asked = await botkins(["spaces", "remove", "Work"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /This deletes the space Work \(s_\w+\), and with it:\n {2}2 panels, with 1 routine, 0 custom views and the chat of updates of each\.\n {2}Plan\n {2}Tasks \(has a routine\)\n {2}0 cards\.\nIt cannot be undone\./);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal(workspace.state.panels.filter((p) => p.spaceId === work).length, 2);
  // The socket's own call refuses it without the mark, so a caller cannot go round the command.
  await assert.rejects(client.call("space.remove", "Work"), /needs the mark|Show that to the person and ask first/);
  await assert.rejects(client.call("panel.remove", plan.id), /Show that to the person and ask first/);
  assert.equal(workspace.state.spaces.some((space) => space.id === work), true);
  // At a terminal, "n" leaves it, "y" deletes it.
  assert.equal((await botkins(["spaces", "remove", "Work"], { tty: true, input: "n\n" })).exit, 1);
  assert.equal(workspace.state.spaces.some((space) => space.id === work), true);
  // A routine that runs every 5 minutes shows its cost, and needs the yes and the mark.
  const space = (await client.call("space.get", "Today")).id;
  const fast = seed(space, "Fast");
  const quiet = await botkins(["panels", "routine", "set", "Fast", "--cron", "*/5 * * * *", "--prompt", "Look again.", "--timezone", "UTC"]);
  assert.equal(quiet.exit, 2);
  assert.match(quiet.err, /Cost: this runs as often as every 5 minutes\. Each run uses one model turn, and a model turn can cost money\./);
  assert.match(quiet.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal(workspace.state.panels.find((p) => p.id === fast.id).routine, null);
  await assert.rejects(client.call("panel.routine.set", fast.id, { cron: "*/5 * * * *", timezone: "UTC", prompt: "Look again." }), /Each run uses one model turn/);
  assert.equal(workspace.state.panels.find((p) => p.id === fast.id).routine, null);
  const sure = await botkins(["panels", "routine", "set", "Fast", "--cron", "*/5 * * * *", "--prompt", "Look again.", "--timezone", "UTC", "--yes"]);
  assert.equal(sure.exit, 0, sure.err);
  assert.equal(workspace.state.panels.find((p) => p.id === fast.id).routine.cron, "*/5 * * * *");
  // A routine's removal takes its prompt, so it asks too.
  assert.equal((await botkins(["panels", "routine", "remove", "Fast"])).exit, 2);
  assert.equal((await botkins(["panels", "routine", "remove", "Fast", "--yes"])).exit, 0);
  assert.equal(workspace.state.panels.find((p) => p.id === fast.id).routine, null);
  // With --yes the space goes with its panels and its routine; the text of the routine is in no log line.
  const gone = await botkins(["spaces", "remove", "Work", "--yes", "--json"]);
  assert.equal(gone.exit, 0, gone.err);
  assert.deepEqual([gone.json().panels, gone.json().routines], [2, 1]);
  assert.equal(workspace.state.panels.some((p) => p.spaceId === work), false);
  const lines = await changes();
  assert.ok(lines.includes("space.remove Work"));
  assert.ok(lines.includes("panel.routine.set " + fast.id + " (each 5 minutes)"));
  assert.equal(lines.join("\n").includes("Look again"), false);
  assert.equal(lines.join("\n").includes("Secret prompt words"), false);
});
