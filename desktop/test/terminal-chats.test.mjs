// Chats from the command line (cli/commands/chats.mjs), against a real service. What these hold to:
// a chat is named by its id or its title; a delete asks first and needs --yes with no terminal;
// a change is in the log by the chat's id and never by its title or a value; the sections are the
// owner's own, kept by the phone link, and are reached through the window's own calls.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
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
/** A real service, and `botkins(argv, { input, tty })` to run a command against it. */
async function service(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-chats-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const botkins = async (argv, { input = "", tty = false } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  const put = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("Changed from the command line")).map((text) => text.split("Changed from the command line: ")[1]).filter((line) => line.startsWith("chats."));
  const everything = () => [readFileSync(join(paths.dataDir, "workspace.json"), "utf8"), readFileSync(paths.logFile, "utf8")].join("\n");
  /** A chat of a bot, with messages put into it as a turn would leave them. */
  const chatWith = async (bot, title, messages = []) => {
    const { chatId } = await client.call("chat.open", bot);
    const chat = running.runtime.workspace.chat(chatId);
    chat.title = title;
    chat.messages.push(...messages.map((text, index) => ({ role: index % 2 ? "assistant" : "user", text })));
    return chatId;
  };
  return { dir, paths, client, botkins, put, changes, everything, workspace: running.runtime.workspace, handlers: running.runtime.handlers, chatWith };
}
/** The ids and titles of the chats, for a short comparison. */
const titles = async (botkins) => (await botkins(["chats", "list", "--json"])).json().filter(c => !c.main).map((chat) => chat.title).sort();

test("a chat is found by its id or its title, and rename, flags, show and list work with text and --json", { skip }, async (t) => {
  const { botkins, client, chatWith, changes, everything, workspace } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  await client.call("bots.add", { name: "Orbit" });
  const plan = await chatWith("Nova", "Quarterly plan", ["hello", "hi"]);
  const other = await chatWith("Orbit", "Quarterly review");
  const notes = await chatWith("Orbit", "Notes");

  const list = await botkins(["chats", "list"]);
  assert.match(list.out, /^TITLE +WITH +STATE +SECTION +ID\n/);
  assert.match(list.out, new RegExp("Quarterly plan +Nova +- +- +" + plan));
  const json = (await botkins(["chats", "list", "--json"])).json();
  assert.deepEqual(json.filter(c => !c.main).map((chat) => [chat.title, chat.bot, chat.messages, chat.pinned, chat.mode]).sort(), [["Notes", "Orbit", 0, false, "default"], ["Quarterly plan", "Nova", 2, false, "default"], ["Quarterly review", "Orbit", 0, false, "default"]]);
  assert.deepEqual((await botkins(["chats", "list", "--bot", "Nova", "--json"])).json().filter(c => !c.main).map((chat) => chat.id), [plan]);
  assert.match((await botkins(["chats", "list", "--bot", "Nobody"])).err, /There is no bot called Nobody/);

  // By id, by the whole title (not by its case), and by the start of a title that one chat has.
  for (const ref of [plan, "Quarterly plan", "quarterly PLAN", "Quarterly p", "Not"]) assert.equal((await botkins(["chats", "show", ref, "--json"])).json().id, ref === "Not" ? notes : plan, ref);
  // A start that two chats have, and a name that none has, are refused, and the refusal says which.
  const two = await botkins(["chats", "show", "Quarterly"]);
  assert.equal(two.exit, 1);
  assert.match(two.err, new RegExp('More than one chat matches "Quarterly": "Quarterly review" \\(' + other + '\\), "Quarterly plan" \\(' + plan + "\\)\\. Use its id"));
  assert.match((await botkins(["chats", "show", "Nothing"])).err, /There is no chat called "Nothing"\. See `botkins chats list`\./);
  assert.equal((await botkins(["chats", "show"])).exit, 2);
  assert.match((await botkins(["chats", "show", plan])).out, new RegExp("^Quarterly plan   " + plan + "\\nWith: Nova\\nMessages: 2\\n"));

  // Rename: the new title is the chat's, and the log names the id only.
  const renamed = await botkins(["chats", "rename", "Quarterly plan", "Plan", "for", "Q3"]);
  assert.equal(renamed.out, 'The chat is called "Plan for Q3" now.\n');
  assert.equal((await botkins(["chats", "show", plan, "--json"])).json().title, "Plan for Q3");
  assert.equal((await botkins(["chats", "rename", plan])).exit, 2);
  assert.equal((await botkins(["chats", "rename", plan, "x".repeat(121)])).exit, 1);

  t.mock.method(workspace.summaries, "ask", async () => "Quarterly roadmap");
  const regenerated = await botkins(["chats", "regenerate-title", "Plan for Q3", "--json"]);
  assert.equal(regenerated.exit, 0, regenerated.err);
  assert.equal(regenerated.json().title, "Quarterly roadmap");
  assert.equal((await botkins(["chats", "show", plan, "--json"])).json().title, "Quarterly roadmap");

  // Flags: each way, and the refusals.
  const pinned = await botkins(["chats", "flags", plan, "--pin", "--unread", "--json"]);
  assert.deepEqual([pinned.json().pinned, pinned.json().unread, pinned.json().archived], [true, true, false]);
  assert.match((await botkins(["chats", "flags", plan, "--archive"])).out, /: pinned, archived, unread\.$/m);
  const back = (await botkins(["chats", "flags", plan, "--unpin", "--unarchive", "--read", "--json"])).json();
  assert.deepEqual([back.pinned, back.archived, back.unread], [false, false, false]);
  assert.equal((await botkins(["chats", "flags", plan])).exit, 2);
  assert.match((await botkins(["chats", "flags", plan, "--pin", "--unpin"])).err, /Give --pin or --unpin, not both\./);

  // Each change is in the log by the chat's id: never the title.
  assert.deepEqual(await changes(), ["chats.rename " + plan, "chats.regenerateTitle " + plan, "chats.flags " + plan, "chats.flags " + plan, "chats.flags " + plan]);
  assert.doesNotMatch(everything().split("Changed from the command line").slice(1).join(""), /Plan for Q3|Quarterly roadmap/);
});

test("a delete asks first, and --yes is the answer with no terminal", { skip }, async (t) => {
  const { botkins, client, chatWith, changes, workspace } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  const doomed = await chatWith("Nova", "Old drafts", ["a", "b", "c"]);
  await chatWith("Nova", "Keep");
  const asked = await botkins(["chats", "delete", "Old"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.deepEqual(await titles(botkins), ["Keep", "Old drafts"]);
  // At a terminal: a no keeps it, a yes deletes it. The question shows the chat that the words found.
  const no = await botkins(["chats", "delete", "Old"], { input: "n\n", tty: true });
  assert.equal(no.exit, 1);
  assert.match(no.err, new RegExp('Delete the chat "Old drafts" \\(' + doomed + "\\) with its 3 messages\\? This cannot be undone\\. \\[y/N\\]"));
  assert.deepEqual(await titles(botkins), ["Keep", "Old drafts"]);
  const yes = await botkins(["chats", "delete", "Old", "--json", "--yes"]);
  assert.deepEqual([yes.json().removed, yes.json().title], [doomed, "Old drafts"]);
  assert.deepEqual(await titles(botkins), ["Keep"]);
  const typed = await botkins(["chats", "delete", "Keep"], { input: "y\n", tty: true });
  assert.equal(typed.exit, 0, typed.err);
  assert.deepEqual(await titles(botkins), []);
  assert.match((await botkins(["chats", "delete", "Old", "--yes"])).err, /There is no chat called "Old"/);
  // A chat that works is refused, and is still there.
  const busy = await chatWith("Nova", "Busy");
  workspace.active.set(busy, { stream: "" });
  const refused = await botkins(["chats", "delete", "Busy", "--yes"]);
  assert.equal(refused.exit, 1);
  assert.equal((await titles(botkins)).length, 1);
  workspace.active.delete(busy);
  // The refused delete left a line that says it failed, with no chat's title and no id of a chat that was not found.
  const tried = (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("Tried from the command line"));
  assert.deepEqual(tried, ["Tried from the command line: chats.delete (it failed)"]);
  // Only the one that was deleted left lines, and a refused delete left a "tried" line with no chat.
  assert.equal((await changes()).filter((line) => line.startsWith("chats.delete ")).length, 2);
  assert.equal((await changes()).includes("chats.delete " + doomed), true);
});

test("fork, group chats, projects and compact", { skip }, async (t) => {
  const { botkins, client, chatWith, changes, handlers, workspace } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  await client.call("bots.add", { name: "Orbit" });
  const source = await chatWith("Nova", "Plan", ["one", "two", "three", "four"]);

  const reacted = await botkins(["chats", "react", source, "2", "🥳", "--json"]);
  assert.equal(reacted.exit, 0, reacted.err);
  assert.deepEqual(workspace.chat(source).messages[2].reactions, [{ actor: "owner", emoji: "🥳" }]);

  // A fork holds the conversation up to a message, and is a new chat. No message, or one that is not there, is refused.
  const forked = await botkins(["chats", "fork", "Plan", "--at", "1", "--json"]);
  assert.equal(forked.exit, 0, forked.err);
  assert.deepEqual([forked.json().from, forked.json().at, forked.json().messages, forked.json().title], [source, 1, 2, "Fork of Plan"]);
  const last = await botkins(["chats", "fork", source]);
  assert.match(last.out, /^Made the chat "Fork of Plan" \([^)]+\) from message 3 of /);
  assert.equal((await botkins(["chats", "fork", source, "--at", "9"])).exit, 1);
  assert.equal((await botkins(["chats", "fork", source, "--at", "-1"])).exit, 2);
  assert.match((await botkins(["chats", "fork", (await client.call("chat.open", "Orbit")).chatId])).err, /This chat has no message to fork from\./);

  // A group chat: two to six bots, each once, by name.
  const group = await botkins(["chats", "group", "Nova", "Orbit", "--title", "Launch team", "--json"]);
  assert.equal(group.exit, 0, group.err);
  assert.deepEqual([group.json().title, group.json().group, group.json().bots], ["Launch team", true, ["Nova", "Orbit"]]);
  assert.match((await botkins(["chats", "group", "Nova", "Orbit"])).out, /^Made the group chat "Nova, Orbit" /);
  assert.equal((await botkins(["chats", "group", "Nova"])).exit, 2);
  assert.match((await botkins(["chats", "group", "Nova", "Nova"])).err, /Choose each bot once\./);
  assert.match((await botkins(["chats", "group", "Nova", "Nobody"])).err, /There is no bot called Nobody/);
  assert.match((await botkins(["chats", "show", "Launch"])).out, /With: Nova, Orbit \(a group chat\)/);
  // A group chat cannot be forked.
  assert.match((await botkins(["chats", "fork", "Launch team"])).err, /no message to fork from|Group chats can't be forked yet/);

  // A project: by name or id, `--none`, and a mode. A mode alone keeps the project. (Yolo has its own test.)
  const project = handlers.createProject({ name: "Website" });
  const first = await botkins(["chats", "project", "Plan", "Website", "--mode", "plan", "--json"]);
  assert.equal(first.exit, 0, first.err);
  assert.deepEqual([first.json().projectId, first.json().project], [project, "Website"]);
  assert.match((await botkins(["chats", "project", "Plan", "web"])).out, /is in the project "Website" \(default\)\./);
  const kept = (await botkins(["chats", "project", "Plan", "--mode", "plan", "--json"])).json();
  assert.deepEqual([kept.project, kept.mode], ["Website", "default"], "a project with no folder takes no mode");
  // A chat that is in yolo mode is taken out of it with no question.
  workspace.chat(source).mode = "yolo";
  assert.equal((await botkins(["chats", "project", "Plan", "--mode", "default", "--json"])).json().mode, "default");
  const none = (await botkins(["chats", "project", "Plan", "--none", "--json"])).json();
  assert.deepEqual([none.projectId, none.project], [null, null]);
  assert.match((await botkins(["chats", "project", "Plan", "Nowhere"])).err, /There is no project called "Nowhere"\./);
  assert.match((await botkins(["chats", "project", "Plan", "--mode", "wild"])).err, /A mode is default, plan or yolo\./);
  for (const bad of [[], ["Website", "--none"]]) assert.equal((await botkins(["chats", "project", "Plan", ...bad])).exit, 2);

  // Compact starts a turn of the model: the call answers at once, and the turn runs on its own.
  let sent = null;
  const submit = workspace.submit.bind(workspace);
  workspace.submit = (id, text) => ((sent = [id, text]), null);
  const compact = await botkins(["chats", "compact", "Plan", "--json"]);
  workspace.submit = submit;
  assert.equal(compact.exit, 0, compact.err);
  assert.deepEqual(sent, [source, "/compact"]);
  assert.equal(compact.json().started, true);

  // Each change is in the log by a chat's id.
  const lines = await changes();
  assert.ok(lines.includes("chats.fork " + source));
  assert.ok(lines.includes("chats.react " + source));
  assert.ok(lines.includes("chats.compact " + source));
  assert.equal(lines.filter((line) => line.startsWith("chats.group ")).length, 2);
  assert.equal(lines.filter((line) => line.startsWith("chats.project " + source)).length, 5);
  assert.equal(lines.some((line) => /Launch team|Website|Fork of/.test(line)), false);
});

test("--mode yolo shows what it gives and needs a yes; default and plan ask nothing", { skip }, async (t) => {
  const { botkins, client, chatWith, changes, handlers, workspace, dir } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  const folder = join(dir, "site");
  mkdirSync(folder);
  const project = handlers.createProject({ name: "Website", folder });
  const chat = await chatWith("Nova", "Plan", ["one"]);
  const mode = () => workspace.chat(chat).mode ?? "default";
  const block = new RegExp('Yolo mode for this chat:\\n  Chat: "Plan" \\(' + chat + '\\)\\n  Project: "Website" \\(' + project + '\\)\\n  Folder: ' + JSON.stringify(folder).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\nEach request of the bot in this chat gets a yes with no question, but for one that leaves the sandbox\\.");

  // No terminal and no --yes: the block is shown, the refusal names the flag, nothing changes.
  const refused = await botkins(["chats", "project", "Plan", "Website", "--mode", "yolo"]);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, block);
  assert.match(refused.err, /This needs a yes\. Run it again with --yes\./);
  const json = await botkins(["chats", "project", "Plan", "Website", "--mode", "yolo", "--json"]);
  assert.equal(json.exit, 2);
  assert.match(json.err, block);
  assert.match(json.json().error.message, /This needs a yes\. Run it again with --yes\./);
  assert.equal(mode(), "default");

  // A terminal asks, and a no changes nothing.
  const no = await botkins(["chats", "project", "Plan", "Website", "--mode", "yolo"], { input: "n\n", tty: true });
  assert.equal(no.exit, 1);
  assert.match(no.err, block);
  assert.match(no.err, /Give this chat the mode yolo\? \[y\/N\]/);
  assert.equal(mode(), "default");
  assert.equal(workspace.chat(chat).projectId, undefined);
  assert.deepEqual(await changes(), []);

  // A yes at a terminal sets it.
  const typed = await botkins(["chats", "project", "Plan", "Website", "--mode", "yolo"], { input: "y\n", tty: true });
  assert.equal(typed.exit, 0, typed.err);
  assert.equal(mode(), "yolo");
  workspace.chat(chat).mode = "default";

  // --yes sets it, with the block still on standard error, also with --json (which keeps standard output to the JSON value).
  const yes = await botkins(["chats", "project", "Plan", "Website", "--mode", "yolo", "--yes", "--json"]);
  assert.equal(yes.exit, 0, yes.err);
  assert.match(yes.err, block);
  assert.deepEqual([yes.json().mode, yes.json().projectId], ["yolo", project]);
  assert.equal(mode(), "yolo");
  // A chat that stays in yolo and moves projects asks the same, because the new folder gets the mode.
  assert.equal((await botkins(["chats", "project", "Plan", "--none"])).exit, 2);
  // The socket call takes yolo only with the mark of a caller that agreed.
  workspace.chat(chat).mode = "default";
  await assert.rejects(client.call("chats.project", chat, { project, mode: "yolo" }), { code: "BAD_ARGUMENT" });
  await assert.rejects(client.call("chats.project", chat, { project, mode: "yolo", agreed: "yes" }), { code: "BAD_ARGUMENT" });
  assert.equal(mode(), "default");
  assert.equal((await client.call("chats.projectLook", chat, { project, mode: "yolo" })).folder, folder);
  assert.equal(mode(), "default", "a look changes nothing");
  await client.call("chats.project", chat, { project, mode: "yolo", agreed: true });
  assert.equal(mode(), "yolo");

  // Taking a chat out of yolo, and default and plan, ask nothing.
  const out = await botkins(["chats", "project", "Plan", "--mode", "default", "--json"]);
  assert.equal(out.exit, 0, out.err);
  assert.equal(out.err, "");
  assert.equal(out.json().mode, "default");
  const plan = await botkins(["chats", "project", "Plan", "--mode", "plan", "--json"]);
  assert.equal(plan.exit, 0, plan.err);
  assert.equal(plan.err, "");
  assert.equal(plan.json().mode, "plan");
  assert.match((await botkins(["chats", "project", "Plan", "--mode", "wild"])).err, /A mode is default, plan or yolo\./);

  // The log says which chat and which mode it has now, and nothing else of it.
  const lines = (await changes()).filter((line) => line.startsWith("chats.project"));
  assert.deepEqual(lines, ["chats.project " + chat + " (yolo)", "chats.project " + chat + " (yolo)", "chats.project " + chat + " (yolo)", "chats.project " + chat + " (default)", "chats.project " + chat + " (plan)"]);
});

test("waiting messages, retry, mentions and a side question", { skip }, async (t) => {
  const { botkins, client, chatWith, changes, put, workspace, handlers } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  const chat = await chatWith("Nova", "Plan", ["ask", "answer"]);
  // Two messages wait in the chat while a turn works.
  workspace.active.set(chat, { stream: "", finishing: false });
  workspace.queues.set(chat, [{ id: "q-one", steer: false, text: "first waiting message", attachments: [] }, { id: "q-two", steer: false, text: "second\nwaiting", attachments: [] }]);
  const queue = await botkins(["chats", "queue", "Plan"]);
  assert.match(queue.out, /^# +MESSAGE +ID\n1 +first waiting message +q-one\n2 +second waiting +q-two\n$/);
  assert.deepEqual((await botkins(["chats", "queue", chat, "--json"])).json().map((item) => [item.position, item.id]), [[1, "q-one"], [2, "q-two"]]);
  // A message is named by its number or its id.
  assert.match((await botkins(["chats", "unqueue", "Plan", "2"])).out, /^Took the message out of the line of "Plan" /);
  assert.deepEqual((await botkins(["chats", "queue", "Plan", "--json"])).json().map((item) => item.id), ["q-one"]);
  assert.match((await botkins(["chats", "unqueue", "Plan", "q-two"])).err, /This chat has no waiting message "q-two"\. See `botkins chats queue /);
  assert.match((await botkins(["chats", "unqueue", "Plan", "5"])).err, /no waiting message "5"/);
  assert.equal((await botkins(["chats", "unqueue", "Plan"])).exit, 2);
  // Send now moves it to the front and sends it: here the workspace's own call is watched.
  let now = null;
  const sendNow = workspace.sendNow.bind(workspace);
  workspace.sendNow = (id, item) => void (now = [id, item]);
  const sent = await botkins(["chats", "send-now", "Plan", "1", "--json"]);
  workspace.sendNow = sendNow;
  assert.deepEqual([sent.exit, now, sent.json().sent], [0, [chat, "q-one"], true]);
  workspace.active.delete(chat);
  workspace.queues.delete(chat);
  assert.match((await botkins(["chats", "queue", "Plan"])).out, /No message waits in this chat\./);

  // Retry sends the latest turn again, and refuses a chat that works.
  workspace.chat(chat).messages[0].runId = "run-1";
  workspace.state.runs.unshift({ id: "run-1", chatId: chat, title: "ask", time: Date.now(), status: "Needs you", finished: Date.now(), ending: "failed" });
  assert.match((await botkins(["chats", "show", "Plan"])).out, /Latest turn: run-1 \(Needs you\)/);
  let again = null;
  const retry = workspace.retry.bind(workspace);
  workspace.retry = (id) => void (again = id);
  const retried = await botkins(["chats", "retry", "Plan", "--json"]);
  assert.deepEqual([retried.exit, again, retried.json().runId], [0, "run-1", "run-1"]);
  workspace.active.set(chat, { stream: "" });
  assert.match((await botkins(["chats", "retry", "Plan"])).err, /This chat is working\./);
  workspace.active.delete(chat);
  workspace.retry = retry;
  await chatWith("Nova", "Empty");
  assert.match((await botkins(["chats", "retry", "Empty"])).err, /This chat has no turn to send again\./);

  // Mentions: for a chat, or for a bot with no chat yet.
  handlers.createProject({ name: "Website" });
  const mentions = await botkins(["chats", "mentions", "Plan"]);
  assert.match(mentions.out, /^Projects:\n {2}Website\n/);
  assert.deepEqual((await botkins(["chats", "mentions", "Plan", "--json"])).json().projects.map((item) => item.name), ["Website"]);
  assert.deepEqual((await botkins(["chats", "mentions", "--bot", "Nova", "--json"])).json().projects.map((item) => item.name), ["Website"]);
  assert.equal((await botkins(["chats", "mentions"])).exit, 2);
  assert.equal((await botkins(["chats", "mentions", "Plan", "--bot", "Nova"])).exit, 2);

  // A side question: the question comes as words, from a file or from standard input; the answer is made safe.
  const asked = [];
  workspace.sideQuestion = async (id, question) => (asked.push([id, question]), "The budget is\u202e fixed.");
  const words = await botkins(["chats", "aside", "Plan", "What", "did", "we", "decide?"]);
  assert.equal(words.out, "The budget is\\u{202e} fixed.\n");
  await botkins(["chats", "aside", "Plan", "--file", put("question.txt", "From a file?")]);
  await botkins(["chats", "aside", "Plan", "-"], { input: "From a pipe?" });
  const json = (await botkins(["chats", "aside", "Plan", "Again?", "--json"])).json();
  assert.deepEqual(asked.map(([, question]) => question), ["What did we decide?", "From a file?", "From a pipe?", "Again?"]);
  assert.deepEqual([json.id, json.answer], [chat, "The budget is\u202e fixed."], "--json carries the answer as it is");
  assert.equal((await botkins(["chats", "aside", "Plan"])).exit, 2);
  assert.equal((await botkins(["chats", "aside", "Plan", "x", "--file", put("q2.txt", "y")])).exit, 2);
  // With no model to ask, the refusal is the service's, and nothing was kept in the chat.
  delete workspace.sideQuestion;
  assert.equal((await botkins(["chats", "aside", "Plan", "Anything?"])).exit, 1);
  assert.equal(workspace.chat(chat).messages.length, 2);

  // Retry, send-now and unqueue are in the log by the chat's id; a question and a read are not.
  assert.deepEqual(await changes(), ["chats.unqueue " + chat, "chats.sendNow " + chat, "chats.retry " + chat]);
});

test("one helper of a turn is listed and stopped alone, and the log has the chat's id", { skip }, async (t) => {
  const { botkins, client, chatWith, changes, workspace, handlers } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  const chat = await chatWith("Nova", "Plan", ["ask", "answer"]);
  assert.match((await botkins(["chats", "stop-helper", "Plan"])).out, /No helper or background command works in this chat\./);
  const run = { id: "run-1", chatId: chat, status: "Working", agents: [{ id: "h1", name: "explore\u202e", status: "Running", stoppable: true }, { id: "h0", name: "old", status: "Done" }], steps: [{ id: "s1", background: true, label: "npm run dev", status: "Running" }, { id: "t1", label: "view", status: "Running" }] };
  workspace.active.set(chat, { stream: "", finishing: false, run });
  const listed = (await botkins(["chats", "stop-helper", "Plan", "--json"])).json();
  assert.deepEqual(listed.map((item) => [item.id, item.kind, item.stoppable]), [["h1", "helper", true], ["s1", "command", false]], "what works now, and what can be stopped alone");
  assert.match((await botkins(["chats", "stop-helper", "Plan"])).out, /^ID +KIND +STOPPABLE +NAME\nh1 +helper +yes +explore\\u\{202e\}\n/, "a name is made safe");
  const stopped = [];
  workspace.stopHelper = async (id, helper) => void stopped.push([id, helper]);
  const done = await botkins(["chats", "stop-helper", "Plan", "h1", "--json"]);
  assert.deepEqual([done.exit, stopped, done.json().stopped], [0, [[chat, "h1"]], true]);
  assert.match((await botkins(["chats", "stop-helper", "Plan", "h1"])).out, /^Stopped h1 in "Plan" /);
  // The workspace's own sentence is the command's.
  workspace.stopHelper = async () => {
    throw new Error("That helper already finished.");
  };
  const refused = await botkins(["chats", "stop-helper", "Plan", "h1"]);
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /That helper already finished\./);
  assert.equal((await botkins(["chats", "stop-helper"])).exit, 2);
  assert.equal((await botkins(["chats", "stop-helper", "Plan", "h1", "extra"])).exit, 2);
  assert.deepEqual((await changes()).filter((line) => line.startsWith("chats.stopHelper")), ["chats.stopHelper " + chat, "chats.stopHelper " + chat], "the log names the chat, and not the helper");
  workspace.active.delete(chat);
  assert.equal(typeof handlers.stopHelper, "function");
});

test("sections: add, rename, order, set a chat, delete; read through the window's own calls", { skip }, async (t) => {
  const { botkins, client, chatWith, changes, everything } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  const plan = await chatWith("Nova", "Plan");
  const notes = await chatWith("Nova", "Notes");
  assert.match((await botkins(["chats", "sections", "list"])).out, /^No sections yet\. Add one with `botkins chats sections add <name>`\./);
  const work = await botkins(["chats", "sections", "add", "Work", "--json"]);
  assert.equal(work.exit, 0, work.err);
  assert.equal(work.json().name, "Work");
  assert.equal((await botkins(["chats", "sections", "add", "Home"])).out, 'Added the section "Home".\n');
  // The link's own rules come through: one name, once.
  assert.match((await botkins(["chats", "sections", "add", "work"])).err, /You already have a section with that name\./);
  assert.equal((await botkins(["chats", "sections", "add"])).exit, 2);

  // Put chats in sections, by section name or id, and out again.
  assert.equal((await botkins(["chats", "sections", "set", "Plan", "Work"])).out, 'Put "Plan" (' + plan + ') in the section "Work".\n');
  assert.equal((await botkins(["chats", "sections", "set", notes, work.json().id])).exit, 0);
  const list = await botkins(["chats", "sections", "list"]);
  assert.match(list.out, /^SECTION +CHATS +ID\nWork +2 +cs_[\w-]+\nHome +0 +cs_[\w-]+\n1 chat is in no section\.\n$/);
  assert.deepEqual((await botkins(["chats", "show", plan, "--json"])).json().section, "Work");
  assert.match((await botkins(["chats", "list"])).out, /Plan +Nova +- +Work +/);
  assert.equal((await botkins(["chats", "sections", "set", "Plan", "--none"])).out, '"Plan" (' + plan + ") is in no section.\n");
  assert.equal((await botkins(["chats", "sections", "set", "Plan"])).exit, 2);
  assert.equal((await botkins(["chats", "sections", "set", "Plan", "Work", "--none"])).exit, 2);
  assert.match((await botkins(["chats", "sections", "set", "Plan", "Nowhere"])).err, /There is no section called "Nowhere"\. See `botkins chats sections`\./);
  assert.match((await botkins(["chats", "sections", "set", "Missing", "Work"])).err, /There is no chat called "Missing"/);

  // Rename and order.
  assert.equal((await botkins(["chats", "sections", "rename", "Home", "Family", "and", "friends"])).out, 'The section is called "Family and friends" now.\n');
  assert.equal((await botkins(["chats", "sections", "rename", "Work"])).exit, 2);
  const order = await botkins(["chats", "sections", "order", "Family", "Work", "--json"]);
  assert.deepEqual(order.json().map((section) => section.name), ["Family and friends", "Work"]);
  assert.equal((await botkins(["chats", "sections", "order", "Work"])).out, "1. Work\n2. Family and friends\n");
  assert.equal((await botkins(["chats", "sections", "order"])).exit, 2);

  // Delete asks, keeps the chats, and says nothing of them being gone.
  const asked = await botkins(["chats", "sections", "delete", "Work"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  const gone = await botkins(["chats", "sections", "delete", "Work", "--yes"]);
  assert.equal(gone.out, 'Deleted the section "Work".\n');
  assert.deepEqual((await botkins(["chats", "sections", "list", "--json"])).json(), { sections: [{ id: (await client.call("chats.sections")).sections[0].id, name: "Family and friends", chats: 0 }], without: 3 });
  assert.deepEqual(await titles(botkins), ["Notes", "Plan"], "the chats stay");

  // The log: a new section by its name, the rest by id. The titles are not in it.
  const lines = await changes();
  assert.equal(lines.filter((line) => line.startsWith("chats.sections.set " + plan) || line.startsWith("chats.sections.set " + notes)).length, 3);
  assert.deepEqual(lines.filter((line) => /sections\.(add|order)/.test(line)), ["chats.sections.add Work", "chats.sections.add Home", "chats.sections.order", "chats.sections.order"]);
  assert.equal(lines.some((line) => /Plan|Notes/.test(line)), false);
  assert.equal(everything().includes("cs_undefined"), false);
});

test("chats read marks specific chats, a bot's chats, or all unread chats read in one batch", { skip }, async (t) => {
  const { botkins, client, chatWith, changes, workspace } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  await client.call("bots.add", { name: "Orbit" });
  const a = await chatWith("Nova", "Alpha");
  const b = await chatWith("Nova", "Beta");
  const c = await chatWith("Orbit", "Gamma");
  workspace.agents.setChatFlags(a, { unread: true });
  workspace.agents.setChatFlags(b, { unread: true });
  workspace.agents.setChatFlags(c, { unread: true });

  // By explicit refs
  const one = await botkins(["chats", "read", "Alpha", "--json"]);
  assert.equal(one.exit, 0, one.err);
  assert.deepEqual(one.json(), { ids: [a], count: 1 });
  assert.equal(workspace.chat(a).unread, false);
  assert.equal(workspace.chat(b).unread, true);

  // By --bot
  workspace.agents.setChatFlags(a, { unread: true });
  const byBot = await botkins(["chats", "read", "--bot", "Nova", "--json"]);
  assert.equal(byBot.exit, 0, byBot.err);
  assert.equal(byBot.json().count, 2);
  assert.equal(workspace.chat(a).unread, false);
  assert.equal(workspace.chat(b).unread, false);
  assert.equal(workspace.chat(c).unread, true);

  // By --all
  workspace.agents.setChatFlags(b, { unread: true });
  const all = await botkins(["chats", "read", "--all", "--json"]);
  assert.equal(all.exit, 0, all.err);
  assert.equal(all.json().count, 2);
  assert.equal(workspace.chat(b).unread, false);
  assert.equal(workspace.chat(c).unread, false);

  // Validation: missing target or combining modes
  assert.equal((await botkins(["chats", "read"])).exit, 2);
  assert.equal((await botkins(["chats", "read", "Alpha", "--all"])).exit, 2);
  assert.equal((await botkins(["chats", "read", "--bot", "Nova", "--all"])).exit, 2);
  assert.equal((await changes()).filter((line) => line.startsWith("chats.read")).length, 3);
});

test("help --json lists the chats commands with usage and options, and a command with a delete asks", { skip }, async () => {
  const out = [];
  const stdout = new Writable({ write: (chunk, _encoding, done) => (out.push(String(chunk)), done()) });
  assert.equal(await main(["help", "chats", "--json"], { stdout, stderr: stdout, stdin: Readable.from([]), env: {} }), 0);
  const area = JSON.parse(out.join("")).areas.find((entry) => entry.name === "chats");
  const names = area.commands.map((command) => command.command);
  for (const name of ["list", "show", "rename", "delete", "fork", "compact", "flags", "project", "group", "retry", "queue", "unqueue", "stop-helper", "send-now", "mentions", "aside", "sections list", "sections add", "sections rename", "sections delete", "sections order", "sections set"]) assert.ok(names.includes("chats " + name), name);
  const by = (name) => area.commands.find((command) => command.command === "chats " + name);
  assert.equal(by("delete").asks, "--yes");
  assert.equal(by("sections delete").asks, "--yes");
  assert.equal(by("project").asks, "--yes");
  assert.deepEqual(by("fork").options.map((option) => option.name).sort(), ["--at", "--in-main"].sort());
  assert.deepEqual(by("aside").arguments.map((argument) => argument.name), ["chat", "question"]);
  for (const command of area.commands) assert.match(command.usage, /^botkins chats /);
});

test("an answer to a request that waits in a chat leaves a line: the chat, the kind of request, yes or no, and nothing of the text", { skip }, async (t) => {
  const { client, chatWith, workspace } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  const chatId = await chatWith("Nova", "Notes");
  const chat = workspace.chat(chatId);
  const ask = (view) => {
    const pending = workspace.interactions.request(chat, {}, view);
    const [{ id }] = workspace.interactions.snapshot().slice(-1);
    return { id, pending };
  };
  const permission = ask({ kind: "permission", label: "Run", title: "PRIVATE-TITLE run a command", preview: "PRIVATE-PREVIEW" });
  // A yes needs the mark: with none, the request still waits. A bot's shell cannot approve its own request by a quiet call.
  for (const action of ["approve", "today", "remember"]) await assert.rejects(client.call("chat.respond", permission.id, { action }), { code: "NEEDS_YES" });
  await assert.rejects(client.call("chat.respond", permission.id, { action: "approve" }, { agreed: "yes" }), { code: "NEEDS_YES" });
  assert.equal(workspace.interactions.snapshot().some((entry) => entry.id === permission.id), true, "the request waits");
  assert.deepEqual(await client.call("chat.respond", permission.id, { action: "approve" }, { agreed: true }), { chatId, kind: "permission", answered: "yes" });
  assert.deepEqual(await permission.pending, { action: "approve" });
  // A no, a cancel and an answer to a question need no mark.
  const refused = ask({ kind: "permission", label: "Run", title: "PRIVATE-TITLE two", preview: "PRIVATE-PREVIEW" });
  assert.deepEqual(await client.call("chat.respond", refused.id, { action: "deny" }), { chatId, kind: "permission", answered: "no" });
  assert.deepEqual(await refused.pending, { action: "deny" });
  const typed = ask({ kind: "question", title: "PRIVATE-QUESTION two", choices: [], freeform: true });
  assert.deepEqual(await client.call("chat.respond", typed.id, { action: "answer", value: "Partners" }), { chatId, kind: "question", answered: "yes" });
  const question = ask({ kind: "question", title: "PRIVATE-QUESTION", choices: [], freeform: true });
  await client.call("chat.respond", question.id, { action: "cancel" });
  const all = (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("chat.respond"));
  // The four attempts without a valid mark are in the log too, as tries that failed.
  assert.equal(all.filter((text) => text.includes("Tried from the command line: chat.respond") && text.endsWith("(it failed)")).length, 4);
  const lines = all.filter((text) => text.includes("Changed from the command line"));
  assert.deepEqual(lines.map((text) => text.split("Changed from the command line: ")[1]), ["chat.respond " + chatId + " permission yes", "chat.respond " + chatId + " permission no", "chat.respond " + chatId + " question yes", "chat.respond " + chatId + " question no"]);
  assert.equal(lines.join("\n").includes("PRIVATE"), false);
});

test("the terminal opens Main chat, resets and resumes its forks, and sets the proactive destination", { skip }, async t => {
  const { botkins, client } = await service(t);
  await client.call("bots.add", { name: "Nova" });
  const { chatId: id } = await client.call("chat.main", "Nova");
  assert.equal((await client.call("chat.main", "Nova")).chatId, id);
  assert.notEqual((await client.call("chat.open", "Nova")).chatId, id);
  const reset = await botkins(["chats", "reset", id, "--json"]);
  assert.equal(reset.exit, 0, reset.err);
  const fresh = reset.json();
  assert.equal(fresh.id, id);
  assert.notEqual(fresh.activeFork, "original");
  assert.match((await botkins(["chats", "show", id])).out, new RegExp(fresh.activeFork));
  const back = await botkins(["chats", "switch-fork", id, "original", "--json"]);
  assert.equal(back.exit, 0, back.err);
  assert.equal(back.json().activeFork, "original");
  const set = await botkins(["preferences", "set", "proactive.chatMode", "new", "--json"]);
  assert.equal(set.exit, 0, set.err);
  assert.equal(set.json().value, "new");
  assert.deepEqual(await client.call("preferences.get", "proactive.chatMode"), { "proactive.chatMode": "new" });
});
