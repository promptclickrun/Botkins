// Projects, to-dos, tasks and artifacts from the command line (cli/commands/projects.mjs), against a real
// service. What these hold to: a project's folder is chosen by the app's own rule; a commit shows its files
// first and needs a yes; a chat is opened with no turn, and in YOLO only after a block and a yes; text from others is made safe at a
// terminal; with no terminal a question fails and names its flag; a change is in the log, with no value in it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** A real service, and `botkins(argv, { input, tty, ttyOut })` to run a command against it. */
async function service(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-projects-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const botkins = async (argv, { input = "", tty = false, ttyOut = false } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    // (Real streams: a question at a terminal is asked through one.)
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const stdout = sink((text) => void (out += text));
    stdout.isTTY = ttyOut;
    const exit = await main(argv, { stdout, stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("Changed from the command line")).map((text) => text.split("Changed from the command line: ")[1]);
  const everything = () => [readFileSync(join(paths.dataDir, "workspace.json"), "utf8"), readFileSync(paths.logFile, "utf8")].join("\n");
  // The folders that can be chosen are below the service's own home folder (a trial run keeps one in its data folder).
  const home = join(paths.dataDir, "folders-home");
  const folder = (name) => {
    const path = join(home, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { dir, paths, running, client, botkins, changes, everything, home, folder, workspace: running.runtime.workspace };
}
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

test("a project: its folder is chosen by the app's rule, a name is found by prefix, and remove asks and keeps the files", { skip }, async (t) => {
  const { botkins, folder, changes, everything, dir } = await service(t);
  assert.match((await botkins(["projects", "list"])).out, /^No projects yet\. Add one with `botkins projects add`\./);
  assert.equal((await botkins(["projects", "add"])).exit, 2, "a folder or a name");
  // A folder that can be chosen: the name is the folder's, and the answer says what to do next.
  const site = folder("site");
  writeFileSync(join(site, "index.html"), "<p>hi</p>");
  const added = await botkins(["projects", "add", site]);
  assert.equal(added.exit, 0, added.err);
  assert.match(added.out, /^Added the project site for the folder ".*site"\. Open a chat in it with `botkins projects chat site --bot <bot>`\.\n?$/);
  const [listed] = (await botkins(["projects", "list", "--json"])).json();
  assert.deepEqual([listed.name, listed.folder.endsWith("site"), listed.todos, listed.chats, listed.artifacts], ["site", true, { open: 0, done: 0 }, 0, 0]);
  // The same folder is not added twice; with more to say the command refuses and changes nothing.
  const again = await botkins(["projects", "add", site, "--json"]);
  assert.equal(again.json().created, false);
  assert.match((await botkins(["projects", "add", site])).out, /^The project site has this folder already\. Nothing was added\.\n?$/);
  const named = await botkins(["projects", "add", site, "--name", "Other"]);
  assert.equal(named.exit, 1);
  assert.match(named.err, /The project site has this folder already\. Change it with `botkins projects edit`\./);
  // The app's own rule: a folder outside the home folder and the plugged-in disks is refused in the app's words, and nothing is made.
  const outside = mkdtempSync(join(tmpdir(), "bk-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const refused = await botkins(["projects", "add", outside]);
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /Only folders in your home folder or on a plugged-in disk can be chosen/);
  assert.equal((await botkins(["projects", "add", join(site, "nope")])).exit, 1);
  assert.equal((await botkins(["projects", "list", "--json"])).json().length, 1);
  // A project with no folder, with a long description from a file and a color.
  const notes = await botkins(["projects", "add", "--name", "Notes", "--color", "blue", "--description-file", "-", "--json"], { input: "Line one.\r\nLine two.\n" });
  assert.equal(notes.exit, 0, notes.err);
  assert.deepEqual([notes.json().name, notes.json().color, notes.json().description, notes.json().folder], ["Notes", "blue", "Line one.\nLine two.", null]);
  assert.equal((await botkins(["projects", "add", "--name", "Bad", "--color", "plaid"])).exit, 1, "the app's own check of the color");
  assert.equal((await botkins(["projects", "add", "--name", "Both", "--description", "a", "--description-file", "-"])).exit, 2);
  assert.equal((await botkins(["projects", "list", "--json"])).json().length, 2, "a refused add leaves nothing behind");
  // A name is found exactly, then by its start; more than one is said, not guessed.
  await botkins(["projects", "add", "--name", "Pro"]);
  await botkins(["projects", "add", "--name", "Project"]);
  assert.match((await botkins(["projects", "show", "pro"])).out, /^Pro {3}/, "an exact name wins over a longer one");
  assert.match((await botkins(["projects", "show", "Proj"])).out, /^Project {3}/, "a unique start");
  const many = await botkins(["projects", "show", "P"]);
  assert.equal(many.exit, 1);
  assert.match(many.err, /More than one project matches P: (?=.*\bPro \()(?=.*Project \().* Use its id/);
  assert.match((await botkins(["projects", "show", "nothing"])).err, /There is no project called nothing\. See `botkins projects list`\./);
  // Rename and edit.
  assert.match((await botkins(["projects", "rename", "Not", "Journal"])).out, /^The project is now called Journal\.\n?$/);
  const edited = await botkins(["projects", "edit", "Journal", "--no-color", "--description", "A new one.", "--json"]);
  assert.deepEqual([edited.json().color, edited.json().description], [null, "A new one."]);
  assert.equal((await botkins(["projects", "edit", "Journal"])).exit, 2, "nothing to change");
  assert.equal((await botkins(["projects", "edit", "Journal", "--color", "red", "--no-color"])).exit, 2);
  const away = await botkins(["projects", "edit", "Journal", "--folder", outside]);
  assert.equal(away.exit, 1);
  assert.match(away.err, /Only folders in your home folder or on a plugged-in disk can be chosen/);
  assert.equal((await botkins(["projects", "edit", "Journal", "--folder", folder("journal"), "--json"])).json().folder.endsWith("journal"), true);
  assert.equal((await botkins(["projects", "edit", "Journal", "--no-folder", "--json"])).json().folder, null);
  // What can be chosen, as the same command for folders shows it.
  assert.match((await botkins(["projects", "folders"])).out, /site/);
  // Remove asks, says whether the files stay, and needs --yes with no terminal.
  await botkins(["todos", "add", "site", "Ship it"]);
  const asked = await botkins(["projects", "remove", "site"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /This removes the project site from Botkins, with its 1 to-do and its list of attached artifacts\. The folder ".*site" and its files are not touched\./);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal((await botkins(["projects", "list", "--json"])).json().length, 4);
  // At a terminal, "n" leaves it, "y" removes it.
  const no = await botkins(["projects", "remove", "site"], { tty: true, input: "n\n" });
  assert.equal(no.exit, 1);
  assert.equal((await botkins(["projects", "list", "--json"])).json().length, 4);
  const yes = await botkins(["projects", "remove", "site"], { tty: true, input: "y\n" });
  assert.equal(yes.exit, 0, yes.err);
  assert.match(yes.out, /^Removed the project site\.\n?$/);
  assert.equal(existsSync(join(site, "index.html")), true, "the folder's files stay");
  assert.match((await botkins(["projects", "remove", "Pro", "--yes"])).out, /^Removed the project Pro\.\n?$/);
  // The log names the project, never the folder, the description or a to-do's words.
  const lines = await changes();
  assert.deepEqual(
    lines.filter((line) => /^(projects|todos)\./.test(line)),
    ["projects.add site", "projects.add site", "projects.add site", "projects.add Notes", "projects.add Pro", "projects.add Project", "projects.rename Journal", "projects.edit Journal", "projects.edit Journal", "projects.edit Journal", "todos.add site", "projects.remove site", "projects.remove Pro"],
  );
  for (const secret of [site, outside, "A new one.", "Line one.", "Ship it"]) assert.equal(lines.join("\n").includes(secret), false);
  assert.equal(everything().includes("Changed from the command line: todos.add site Ship"), false);
});

test("to-dos: by id, words or number; the words never reach the log; delete asks", { skip }, async (t) => {
  const { botkins, changes, everything, dir } = await service(t);
  await botkins(["projects", "add", "--name", "Home"]);
  const text = "Buy milk with a secret-looking-word";
  assert.match((await botkins(["todos", "list", "Home"])).out, /^No to-dos in Home\. Add one with `botkins todos add`\.\n?$/);
  assert.equal((await botkins(["todos", "add", "Home"])).exit, 2, "no words");
  assert.match((await botkins(["todos", "add", "Home", "Buy", "milk", "with", "a", "secret-looking-word"])).out, /^Added to-do 1 to Home\.\n?$/);
  const file = join(dir, "todo.txt");
  writeFileSync(file, "Call the bank\r\n");
  assert.equal((await botkins(["todos", "add", "Home", "--file", file])).exit, 0);
  assert.equal((await botkins(["todos", "add", "Home", "--file", "-", "--json"], { input: "From a pipe" })).json().todo.text, "From a pipe");
  assert.equal((await botkins(["todos", "add", "Home", "Words", "--file", file])).exit, 2, "words and a file");
  assert.equal((await botkins(["todos", "add", "Home", "   "])).exit, 2);
  const list = (await botkins(["todos", "list", "Home", "--json"])).json();
  assert.deepEqual(list.todos.map((todo) => [todo.position, todo.text, todo.done]), [[1, text, false], [2, "Call the bank", false], [3, "From a pipe", false]]);
  assert.match((await botkins(["todos", "list", "Home"])).out, /^#\s+DONE\s+TO-DO\s+ID\n1\s+no\s+Buy milk/);
  // By number, by words, by the start of its words, and by id.
  assert.match((await botkins(["todos", "done", "Home", "1"])).out, /^To-do 1 of Home is done\.\n?$/);
  assert.match((await botkins(["todos", "done", "Home", "Call the bank"])).out, /^To-do 2 of Home is done\.\n?$/);
  assert.match((await botkins(["todos", "reopen", "Home", "From"])).out, /^To-do 3 of Home is open again\.\n?$/);
  assert.equal((await botkins(["todos", "edit", "Home", list.todos[2].id, "--done", "--json"])).json().todo.done, true);
  assert.equal((await botkins(["todos", "edit", "Home", "1", "--open", "--done"])).exit, 2);
  assert.equal((await botkins(["todos", "edit", "Home", "1"])).exit, 2, "nothing to change");
  assert.match((await botkins(["todos", "edit", "Home", "1", "Buy", "oat", "milk"])).out, /^Changed to-do 1 of Home\.\n?$/);
  const missing = await botkins(["todos", "done", "Home", "9"]);
  assert.equal(missing.exit, 1);
  assert.match(missing.err, /The project Home has no to-do number 9\./);
  assert.match((await botkins(["todos", "done", "Home", "nothing here"])).err, /There is no to-do called nothing here\./);
  // Move.
  assert.equal((await botkins(["todos", "move", "Home", "3"])).exit, 2, "up or down");
  const moved = await botkins(["todos", "move", "Home", "3", "--up", "--json"]);
  assert.deepEqual(moved.json().todos.map((todo) => todo.text), ["Buy oat milk", "From a pipe", "Call the bank"]);
  assert.equal((await botkins(["todos", "move", "Home", "1", "--down"])).exit, 0);
  // Delete asks first and shows which to-do.
  const asked = await botkins(["todos", "remove", "Home", "Call the bank"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This deletes the to-do "Call the bank" from Home\.\nbotkins: This needs a yes\. Run it again with --yes\./);
  assert.match((await botkins(["todos", "remove", "Home", "Call the bank", "--yes"])).out, /^Deleted the to-do from Home\.\n?$/);
  assert.equal((await botkins(["todos", "list", "Home", "--json"])).json().todos.length, 2);
  // A to-do with a control character is shown as its number at a terminal-form table, and as it is in JSON.
  await botkins(["todos", "add", "Home", "Evil \u001b[31m\u202eword"]);
  const shown = await botkins(["todos", "list", "Home"]);
  assert.equal(/[\u001b\u202e]/.test(shown.out), false);
  assert.match(shown.out, /Evil \\u\{1b\}\[31m\\u\{202e\}word/);
  assert.equal((await botkins(["todos", "list", "Home", "--json"])).json().todos.at(-1).text, "Evil \u001b[31m\u202eword");
  // The log names the project only.
  const lines = (await changes()).filter((line) => /^todos\./.test(line));
  assert.equal(lines.length > 10 && lines.every((line) => line.endsWith(" Home") || line.startsWith("todos.") && /^todos\.\w+ Home$/.test(line)), true, lines.join(" | "));
  for (const words of [text, "secret-looking-word", "oat milk", "Call the bank"]) assert.equal((await changes()).join("\n").includes(words), false);
  assert.equal(everything().split("\n").filter((line) => line.includes("Changed from the command line")).some((line) => line.includes("milk")), false);
});

test("a project's folder: changes name the files a commit takes, a commit shows them and asks, and its message is not in the log", { skip }, async (t) => {
  const { botkins, client, folder, changes, everything } = await service(t);
  const repo = folder("repo");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "first");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "b.txt"), "new file\n");
  await botkins(["projects", "add", repo, "--name", "Repo"]);
  const view = await botkins(["projects", "changes", "Repo"]);
  assert.equal(view.exit, 0, view.err);
  assert.match(view.out, /Branch main/);
  assert.match(view.out, /2 changed files, \+2 -0\. A commit takes 2\./);
  assert.match(view.out, /a\.txt\s+modified\s+-\s+\+1 -0\s+yes/);
  assert.match(view.out, /b\.txt\s+untracked\s+-\s+\+1 -0\s+yes/);
  const json = (await botkins(["projects", "changes", "Repo", "--json"])).json();
  assert.deepEqual(json.files.map((file) => [file.path, file.commit]).sort(), [["a.txt", true], ["b.txt", true]]);
  // A diff: as git wrote it in a pipe and in JSON; made safe at a terminal.
  writeFileSync(join(repo, "c.txt"), "red \u001b[31m and \u202e turned\n");
  const diff = await botkins(["projects", "diff", "Repo", "a.txt"]);
  assert.match(diff.out, /^diff --git a\/a\.txt b\/a\.txt[\s\S]*\+two\n?\n?$/);
  assert.deepEqual([(await botkins(["projects", "diff", "Repo", "a.txt", "--json"])).json().truncated, (await botkins(["projects", "diff", "Repo", "a.txt", "--json"])).json().text.includes("+two")], [false, true]);
  assert.equal((await botkins(["projects", "diff", "Repo", "c.txt"])).out.includes("\u001b"), true, "in a pipe it is as it is");
  const safeDiff = await botkins(["projects", "diff", "Repo", "c.txt"], { ttyOut: true });
  assert.equal(/[\u001b\u202e]/.test(safeDiff.out), false);
  assert.match(safeDiff.out, /\+red \\u\{1b\}\[31m and \\u\{202e\} turned/);
  assert.equal((await botkins(["projects", "diff", "Repo", "../x"])).exit, 1, "the app's own refusal of a path outside the repository");
  assert.equal((await botkins(["projects", "diff", "Repo"])).exit, 2);
  // A commit: the message from --message, --file or a line typed; the files shown first; a yes.
  const noMessage = await botkins(["projects", "commit", "Repo", "--yes"]);
  assert.equal(noMessage.exit, 2);
  assert.match(noMessage.err, /Give the commit message with --message <text>, or --file <path>/);
  assert.equal((await botkins(["projects", "commit", "Repo", "-m", "x", "--file", "-"])).exit, 2);
  const asked = await botkins(["projects", "commit", "Repo", "--message", "Add the files"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This makes a git commit in the folder of Repo, ".*repo", on the branch main\.\nGit hooks do not run\. The files that go into it \(3\):\n {2}modified\s+a\.txt\n {2}untracked\s+b\.txt\n {2}untracked\s+c\.txt\nMessage: Add the files\nbotkins: This needs a yes\. Run it again with --yes\./);
  assert.equal(git(repo, "rev-list", "--count", "HEAD").trim(), "1", "nothing was committed");
  // A change between the list that was shown and the commit stops it: nothing is committed.
  const stale = await client.call("projects.commit", "Repo", "Stale", ["a.txt"]).catch((error) => error);
  assert.equal(stale.code, "CHANGED");
  assert.equal(git(repo, "rev-list", "--count", "HEAD").trim(), "1");
  const done = await botkins(["projects", "commit", "Repo", "--file", "-", "--yes"], { input: "Add the files\n\nWith a body that is private.\n" });
  assert.equal(done.exit, 0, done.err);
  assert.match(done.out, /^Committed [0-9a-f]{7,} in Repo: 3 files\.\n?$/);
  assert.match(done.err, /Message: Add the files …/);
  assert.equal(git(repo, "log", "-1", "--format=%B").trim(), "Add the files\n\nWith a body that is private.");
  assert.equal(git(repo, "status", "--porcelain").trim(), "");
  assert.equal((await botkins(["projects", "changes", "Repo"])).out.trimEnd().endsWith("No changes."), true);
  const nothing = await botkins(["projects", "commit", "Repo", "-m", "Empty", "--yes"]);
  assert.equal(nothing.exit, 1);
  assert.match(nothing.err, /There is nothing to commit in Repo\./);
  // At a terminal a question asks for the message and then for the yes.
  writeFileSync(join(repo, "d.txt"), "d\n");
  const typed = await botkins(["projects", "commit", "Repo", "--yes"], { tty: true, input: "Typed message\n" });
  assert.equal(typed.exit, 0, typed.err);
  assert.equal(git(repo, "log", "-1", "--format=%s").trim(), "Typed message");
  // A project in a folder of a repository: only that folder's files go in, and the command says so.
  const sub = join(repo, "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "in.txt"), "in\n");
  writeFileSync(join(repo, "out.txt"), "out\n");
  await botkins(["projects", "add", sub, "--name", "Sub"]);
  const inside = (await botkins(["projects", "changes", "Sub", "--json"])).json();
  assert.deepEqual(inside.files.map((file) => [file.path, file.commit]).sort(), [["out.txt", false], ["sub/in.txt", true]]);
  assert.match((await botkins(["projects", "changes", "Sub"])).out, /out\.txt\s+untracked\s+-\s+\+1 -0\s+no \(outside the project's folder\)/);
  assert.equal((await botkins(["projects", "commit", "Sub", "-m", "Only sub", "--yes"])).exit, 0);
  assert.equal(git(repo, "show", "--name-only", "--format=", "HEAD").trim(), "sub/in.txt");
  assert.equal(git(repo, "status", "--porcelain").trim(), "?? out.txt");
  // Not a repository, and no folder.
  const plain = folder("plain");
  await botkins(["projects", "add", plain]);
  assert.match((await botkins(["projects", "changes", "plain"])).out, /^The folder of plain is not a git repository\.\n?$/);
  assert.match((await botkins(["projects", "commit", "plain", "-m", "x", "--yes"])).err, /The folder of plain is not a git repository, so there is nothing to commit\./);
  await botkins(["projects", "add", "--name", "Bare"]);
  assert.match((await botkins(["projects", "changes", "Bare"])).err, /The project Bare has no folder\. Give it one with `botkins projects edit` \(--folder\)\./);
  // The log names the project: not the message, the files or the folder.
  const lines = (await changes()).filter((line) => line.startsWith("projects.commit"));
  assert.deepEqual(lines, ["projects.commit Repo", "projects.commit Repo", "projects.commit Sub"]);
  for (const value of ["private", "Add the files", "Typed message", "a.txt", repo]) assert.equal(everything().split("\n").filter((line) => line.includes("Changed from the command line")).join("\n").includes(value), false);
});

test("a chat in a project opens with no turn, and says how to send the first message", { skip }, async (t) => {
  const { botkins, client, folder, changes } = await service(t);
  await botkins(["bots", "add", "Nova"]);
  await botkins(["bots", "add", "Orbit"]);
  const repo = folder("coding");
  await botkins(["projects", "add", repo, "--name", "Coding"]);
  await botkins(["projects", "add", "--name", "Plain"]);
  const chatsBefore = (await client.call("chat.list")).length;
  assert.equal((await botkins(["projects", "chat", "Coding"])).exit, 2, "a bot is needed");
  const opened = await botkins(["projects", "chat", "Coding", "--bot", "Nova"]);
  assert.equal(opened.exit, 0, opened.err);
  assert.match(opened.out, /^Opened the chat \S+ in Coding with Nova\. Mode: default\. Its tools work in the folder ".*coding"\.\nNothing is sent yet\. To send the first message, which starts a turn of the model, run:\n {2}botkins chat Nova --chat \S+ -m <message>\n?$/);
  const chat = (await botkins(["projects", "chat", "Coding", "--bot", "Nova", "--mode", "plan", "--json"])).json();
  assert.deepEqual([chat.mode, chat.project.name, chat.bots.map((bot) => bot.name)], ["plan", "Coding", ["Nova"]]);
  const made = (await client.call("chat.list")).filter((entry) => entry.id === chat.chatId);
  assert.deepEqual([made.length, made[0].messages, made[0].working], [1, 0, false], "no message, no turn");
  assert.equal((await client.call("chat.list")).length, chatsBefore + 2);
  // The modes default and plan ask nothing, also at a terminal.
  const quiet = await botkins(["projects", "chat", "Coding", "--bot", "Nova", "--mode", "plan"], { tty: true });
  assert.equal(quiet.exit, 0, quiet.err);
  assert.equal(quiet.err, "", "no block, no question");
  assert.equal((await botkins(["projects", "chat", "Coding", "--bot", "Nova", "--mode", "other"])).exit, 1);
  assert.equal((await client.call("chat.list")).length, chatsBefore + 3);
  assert.match((await botkins(["projects", "chat", "Coding", "--bot", "Nobody"])).err, /There is no bot called Nobody\./);
  // A project with no folder takes a group; a project with a folder does not (the app's own refusal). A mode is for a folder only.
  const group = await botkins(["projects", "chat", "Plain", "--bot", "Nova", "--bot", "Orbit", "--mode", "plan", "--json"]);
  assert.equal(group.exit, 0, group.err);
  assert.deepEqual([group.json().bots.length, group.json().mode], [2, "default"]);
  const refused = await botkins(["projects", "chat", "Coding", "--bot", "Nova", "--bot", "Orbit"]);
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /Group chats take text only/);
  assert.equal((await botkins(["projects", "list", "--json"])).json().find((entry) => entry.name === "Coding").chats, 3);
  assert.equal((await changes()).filter((line) => line.startsWith("projects.chat")).length >= 3, true);
});

test("a chat in the mode yolo shows what it gives and needs a yes; the log line says yolo", { skip }, async (t) => {
  const { botkins, client, folder, changes, workspace } = await service(t);
  await botkins(["bots", "add", "Nova"]);
  await botkins(["bots", "add", "Orbit"]);
  const repo = folder("yolo-site");
  await botkins(["projects", "add", repo, "--name", "Site"]);
  await botkins(["projects", "add", "--name", "Plain"]);
  const count = async () => (await client.call("chat.list")).length;
  const before = await count();
  const SENTENCE = "Each request of the bot in this chat gets a yes with no question, but for one that leaves the sandbox.";
  const yoloLines = async () => (await changes()).filter((line) => line.startsWith("projects.chat") && line.includes("yolo"));
  // No terminal and no --yes: the block is shown, the refusal names the flag, and nothing is opened.
  const none = await botkins(["projects", "chat", "Site", "--bot", "Nova", "--mode", "yolo"]);
  assert.equal(none.exit, 2);
  assert.match(none.err, /This opens a chat in the mode yolo\.\nProject: Site, folder ".*yolo-site"\.\nBot: Nova\.\n/);
  assert.ok(none.err.includes(SENTENCE));
  assert.match(none.err, /This needs a yes\. Run it again with --yes\./);
  const noneJson = await botkins(["projects", "chat", "Site", "--bot", "Nova", "--mode", "yolo", "--json"]);
  assert.equal(noneJson.exit, 2);
  assert.ok(noneJson.err.includes(SENTENCE) && noneJson.err.includes("--yes"));
  assert.equal(await count(), before);
  assert.deepEqual(await yoloLines(), []);
  // At a terminal, a "no" opens nothing; so does an empty answer.
  for (const input of ["n\n", "\n"]) {
    const refused = await botkins(["projects", "chat", "Site", "--bot", "Nova", "--mode", "yolo"], { tty: true, input });
    assert.equal(refused.exit, 1);
    assert.ok(refused.err.includes(SENTENCE) && refused.err.includes("Open the chat in the mode yolo? [y/N]"));
  }
  assert.equal(await count(), before);
  // A bot or a project that is not there is refused before any question.
  const missing = await botkins(["projects", "chat", "Site", "--bot", "Nobody", "--mode", "yolo"], { tty: true });
  assert.equal(missing.exit, 1);
  assert.equal(missing.err.includes("Open the chat"), false);
  // At a terminal, a "yes" opens it in the mode yolo.
  const typed = await botkins(["projects", "chat", "Site", "--bot", "Nova", "--mode", "yolo"], { tty: true, input: "y\n" });
  assert.equal(typed.exit, 0, typed.err);
  assert.match(typed.out, /Mode: yolo\./);
  assert.equal(await count(), before + 1);
  // With --yes, with and without --json: the block goes to standard error, the chat is opened in yolo, and the output is the one JSON value.
  const yes = await botkins(["projects", "chat", "Site", "--bot", "Nova", "--mode", "yolo", "--yes", "--json"]);
  assert.equal(yes.exit, 0, yes.err);
  assert.ok(yes.err.includes(SENTENCE) && yes.err.includes("Project: Site"));
  const chat = yes.json();
  assert.deepEqual([chat.mode, chat.project.name], ["yolo", "Site"]);
  assert.equal(workspace.chat(chat.chatId).mode, "yolo", "the app holds the chat in the mode yolo");
  const plainYes = await botkins(["projects", "chat", "Site", "--bot", "Nova", "--mode", "yolo", "--yes"]);
  assert.ok(plainYes.err.includes(SENTENCE));
  assert.match(plainYes.out, /Mode: yolo\./);
  assert.equal(await count(), before + 3);
  // A project with no folder has no modes: the block says so and the chat is default. The log line does not say yolo then.
  const group = await botkins(["projects", "chat", "Plain", "--bot", "Nova", "--bot", "Orbit", "--mode", "yolo", "--yes", "--json"]);
  assert.equal(group.exit, 0, group.err);
  assert.match(group.err, /Project: Plain, with no folder \(a project with no folder opens its chats in the mode default\)\.\nBots: Nova, Orbit\./);
  assert.equal(group.json().mode, "default");
  // The log: the project and the word yolo, no folder and no value; and a chat in default or plan has no such word.
  const lines = await changes();
  assert.equal(lines.filter((line) => line === "projects.chat Site (yolo)").length, 3);
  assert.equal(lines.filter((line) => line === "projects.chat Plain").length, 1);
  await botkins(["projects", "chat", "Site", "--bot", "Nova", "--mode", "plan"]);
  assert.equal((await changes()).filter((line) => line === "projects.chat Site").length, 1);
  assert.equal(JSON.stringify(await changes()).includes("yolo-site"), false);
  // The socket call: the mode yolo needs the caller's mark; the other modes need none.
  const direct = await client.call("projects.chat", "Site", { bots: ["Nova"], mode: "yolo" }).catch((error) => error);
  assert.equal(direct.code, "NEEDS_YES");
  assert.equal(await count() > before + 4, true);
  const marked = await client.call("projects.chat", "Site", { bots: ["Nova"], mode: "yolo", agreed: true });
  assert.equal(marked.mode, "yolo");
  // A failed call with the mode yolo says yolo in its line too.
  assert.deepEqual((await changes()).filter((line) => line.includes("Tried")), []);
  const tried = (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.startsWith("Tried from the command line: projects.chat"));
  assert.deepEqual(tried, ["Tried from the command line: projects.chat Site (yolo) (it failed)"]);
});

test("tasks: the lanes, a title is its name, a start says what starts, and delete asks", { skip }, async (t) => {
  const { botkins, client, changes, everything, dir } = await service(t);
  await botkins(["bots", "add", "Nova"]);
  assert.match((await botkins(["tasks", "list"])).out, /^No tasks\. Add one with `botkins tasks add`\.\n?$/);
  assert.equal((await botkins(["tasks", "add"])).exit, 2);
  const details = join(dir, "details.md");
  writeFileSync(details, "Do it carefully.\r\nSecond line.\n");
  const added = await botkins(["tasks", "add", "Write", "the", "report", "--details-file", details, "--priority", "high", "--json"]);
  assert.equal(added.exit, 0, added.err);
  const task = added.json();
  assert.deepEqual([task.title, task.status, task.priority, task.bot, task.createdBy, task.details], ["Write the report", "later", "high", null, "person", "Do it carefully.\nSecond line."]);
  assert.match((await botkins(["tasks", "add", "Second", "--bot", "Nova"])).out, /^Added the task Second \(later, for Nova\)\.\n?$/);
  assert.equal((await botkins(["tasks", "add", "Third", "--priority", "huge"])).exit, 1);
  assert.match((await botkins(["tasks", "add", "Third", "--priority", "huge"])).err, /A priority is one of low, normal, high, urgent\./);
  assert.match((await botkins(["tasks", "add", "Third", "--bot", "Nobody"])).err, /There is no bot called Nobody\./);
  assert.equal((await botkins(["tasks", "add", "Fourth", "--status", "done"])).exit, 1, "the app: a new task starts in Later or Ready");
  assert.equal((await botkins(["tasks", "add", "Both", "--details", "a", "--details-file", details])).exit, 2);
  // Listing and finding: by title, by the start of a title, by id.
  const list = await botkins(["tasks", "list"]);
  assert.match(list.out, /^TITLE\s+STATUS\s+PRIORITY\s+BOT\s+ID\nSecond\s+later\s+normal\s+Nova\s+\S+\nWrite the report\s+later\s+high\s+-\s+\S+\n?$/);
  assert.deepEqual((await botkins(["tasks", "list", "--bot", "Nova", "--json"])).json().map((entry) => entry.title), ["Second"]);
  assert.deepEqual((await botkins(["tasks", "list", "--status", "ready", "--json"])).json(), []);
  assert.equal((await botkins(["tasks", "list", "--status", "stuck"])).exit, 1);
  assert.match((await botkins(["tasks", "show", "Write"])).out, /^Write the report {3}\S+\nStatus: later\. Priority: high\. Bot: none\. Added by: person\.\nDetails: Do it carefully\.\nSecond line\.\n?$/);
  assert.match((await botkins(["tasks", "show", task.id])).out, /^Write the report/);
  assert.match((await botkins(["tasks", "show", "Nothing"])).err, /There is no task called Nothing\. See `botkins tasks list`\./);
  // Edit: only what is named changes (the app's save takes the whole task).
  const edited = await botkins(["tasks", "edit", "Write", "--bot", "Nova", "--json"]);
  assert.deepEqual([edited.json().bot, edited.json().title, edited.json().priority, edited.json().details], ["Nova", "Write the report", "high", "Do it carefully.\nSecond line."]);
  assert.equal((await botkins(["tasks", "edit", "Write"])).exit, 2);
  assert.equal((await botkins(["tasks", "edit", "Write", "--bot", "Nova", "--no-bot"])).exit, 2);
  assert.equal((await botkins(["tasks", "edit", "Write", "--no-bot", "--title", "Write the final report", "--json"])).json().bot, null);
  assert.match((await botkins(["tasks", "show", "Write the final"])).out, /Bot: none/);
  // Move: a Ready task with a bot starts by itself, and the text says so. Working is not chosen by hand.
  assert.match((await botkins(["tasks", "move", "Write the final", "ready"])).out, /^The task Write the final report is now ready\. It has no bot yet\. Give it one with `botkins tasks edit 'Write the final report' --bot <bot>`\.\n?$/);
  assert.match((await botkins(["tasks", "move", "Write the final", "later"])).out, /is now later\.\n?$/);
  assert.equal((await botkins(["tasks", "move", "Write the final", "working"])).exit, 1);
  assert.match((await botkins(["tasks", "move", "Write the final", "sideways"])).err, /A status is one of later, ready, working, review, blocked, done, archived\./);
  assert.equal((await botkins(["tasks", "move", "Write the final"])).exit, 2);
  // Start needs a bot (a turn of a model is not started in this test: see the next one).
  const noBot = await botkins(["tasks", "start", "Write the final"]);
  assert.equal(noBot.exit, 1);
  assert.match(noBot.err, /The task Write the final report has no bot\. Give it one with `botkins tasks edit/);
  // Delete asks first; a task that is working is not deleted (the app's refusal).
  const asked = await botkins(["tasks", "remove", "Write the final"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This deletes the task Write the final report \(later\)\.\nbotkins: This needs a yes\. Run it again with --yes\./);
  assert.match((await botkins(["tasks", "remove", "Write the final", "--yes"])).out, /^Deleted the task Write the final report\.\n?$/);
  assert.deepEqual((await botkins(["tasks", "list", "--json"])).json().map((entry) => entry.title), ["Second"]);
  // The log names the task by its title: not its details.
  const lines = (await changes()).filter((line) => /^tasks\./.test(line));
  assert.deepEqual(lines.slice(0, 2), ["tasks.add Write the report", "tasks.add Second"]);
  assert.equal(lines.at(-1), "tasks.remove Write the final report");
  assert.equal(lines.join("\n").includes("carefully"), false);
  assert.equal(everything().split("\n").filter((line) => line.includes("Changed from the command line")).join("\n").includes("carefully"), false);
  assert.equal((await client.call("tasks.list", [])).length, 1);
});

test("starting a task says that a turn of the bot's model starts, and a task that works already is left", { skip }, async () => {
  // A turn is not started here: a stand-in service answers, so no model program runs in this test.
  const run = async (task, started) => {
    const calls = [];
    const client = { call: async (method, ...args) => (calls.push([method, ...args]), method === "tasks.get" ? task : started) };
    let out = "";
    let err = "";
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const stdin = Readable.from([]);
    stdin.isTTY = false;
    const exit = await main(["tasks", "start", "Write it"], { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err, calls };
  };
  const task = { id: "t1", title: "Write it", status: "ready", bot: "Nova", botId: "b1" };
  const fresh = await run(task, { ...task, status: "working", chatId: "c1" });
  assert.equal(fresh.exit, 0);
  assert.equal(fresh.err, "This starts a turn of the model of Nova on the task Write it, now. The bot works on it with its tools.\n");
  assert.equal(fresh.out, "Started the task Write it. Follow it with `botkins tasks show 'Write it'`.\n");
  assert.deepEqual(fresh.calls, [["tasks.get", "Write it"], ["tasks.start", "t1"]]);
  const busy = await run({ ...task, status: "working" }, { ...task, status: "working", already: true });
  assert.equal(busy.err, "", "nothing starts, so nothing is said to start");
  assert.equal(busy.out, "The task Write it is working already.\n");
});

test("artifacts: a text one is printed (safe at a terminal), any one is saved with --output, a binary one is never printed", { skip }, async (t) => {
  const { botkins, client, workspace, dir, changes } = await service(t);
  const nova = (await botkins(["bots", "add", "Nova", "--json"])).json();
  const files = join(dir, "files");
  mkdirSync(files);
  const make = (name, content) => {
    const path = join(files, name);
    writeFileSync(path, content);
    return workspace.artifacts.record(path, { botId: nova.id, source: "export" });
  };
  const note = make("note.md", "# Title\nline two\n");
  const evil = make("evil.log", "red \u001b[31m and \u202e turned\n\tkept tab\n");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
  const image = make("pic.png", png);
  const big = Buffer.alloc(1_300_000);
  for (let index = 0; index < big.length; index++) big[index] = index % 251;
  const bigFile = make("big.bin", big);
  const folderPath = join(files, "docs");
  mkdirSync(folderPath);
  writeFileSync(join(folderPath, "inner.txt"), "inside\n");
  const docs = workspace.artifacts.record(folderPath, { botId: nova.id, source: "export" });
  // The list: a bot is needed; the names are shown, newest first.
  assert.equal((await botkins(["artifacts", "list"])).exit, 2);
  const list = await botkins(["artifacts", "list", "--bot", "Nova"]);
  assert.equal(list.exit, 0, list.err);
  assert.match(list.out, /^NAME\s+KIND\s+SIZE\s+WHEN\s+SOURCE\s+ID\n/);
  for (const name of ["note.md", "evil.log", "pic.png", "big.bin", "docs"]) assert.match(list.out, new RegExp("\\b" + name.replace(".", "\\.") + "\\b"));
  const json = (await botkins(["artifacts", "list", "--bot", "Nova", "--json"])).json();
  assert.deepEqual([json.items.length, json.nextCursor], [5, null]);
  assert.match((await botkins(["artifacts", "list", "--bot", "Nobody"])).err, /There is no bot called Nobody\./);
  const inFolder = (await botkins(["artifacts", "list", "--bot", "Nova", "--folder", docs.id, "--json"])).json();
  assert.deepEqual(inFolder.items.map((item) => item.name), ["inner.txt"]);
  // Text: exact in a pipe, safe at a terminal (the tab stays), a field of --json.
  assert.equal((await botkins(["artifacts", "read", note.id])).out, "# Title\nline two\n");
  assert.equal((await botkins(["artifacts", "read", note.path])).out, "# Title\nline two\n", "by its path too");
  assert.equal((await botkins(["artifacts", "read", evil.id])).out, "red \u001b[31m and \u202e turned\n\tkept tab\n");
  const safe = await botkins(["artifacts", "read", evil.id], { ttyOut: true });
  assert.equal(/[\u001b\u202e]/.test(safe.out), false);
  assert.equal(safe.out, "red \\u{1b}[31m and \\u{202e} turned\n\tkept tab\n");
  const asJson = (await botkins(["artifacts", "read", evil.id, "--json"])).json();
  assert.deepEqual([asJson.artifact.name, asJson.text], ["evil.log", "red \u001b[31m and \u202e turned\n\tkept tab\n"]);
  // A binary artifact is never printed, in text or in JSON; it is saved.
  const refused = await botkins(["artifacts", "read", image.id]);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /The artifact pic\.png is image\/png, not text, so it is not printed\. Save it with --output <path>\./);
  assert.equal(refused.out, "");
  assert.equal((await botkins(["artifacts", "read", image.id, "--json"])).exit, 2);
  const out = join(dir, "saved.png");
  const saved = await botkins(["artifacts", "read", image.id, "--output", out]);
  assert.equal(saved.exit, 0, saved.err);
  assert.match(saved.out, /^Saved pic\.png \(11 B\) to .*saved\.png\.\n?$/);
  assert.deepEqual(readFileSync(out), png);
  // A file that is there is replaced only after a yes.
  writeFileSync(out, "old");
  const asked = await botkins(["artifacts", "read", image.id, "--output", out]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /saved\.png is there already\. Replace it\?|This needs a yes\. Run it again with --yes\./);
  assert.equal(readFileSync(out, "utf8"), "old");
  assert.equal((await botkins(["artifacts", "read", image.id, "--output", out, "--yes", "--json"])).json().bytes, 11);
  assert.deepEqual(readFileSync(out), png);
  // A file of more than one piece (512 KB each) is written whole and exact; no part file is left behind.
  const bigOut = join(dir, "big-copy.bin");
  assert.equal((await botkins(["artifacts", "read", bigFile.id, "-o", bigOut])).exit, 0);
  assert.equal(readFileSync(bigOut).equals(big), true);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".part")), []);
  // A text artifact can be saved too; a folder says how to look inside.
  assert.equal((await botkins(["artifacts", "read", note.id, "--output", join(dir, "note-copy.md")])).exit, 0);
  assert.equal(readFileSync(join(dir, "note-copy.md"), "utf8"), "# Title\nline two\n");
  const folder = await botkins(["artifacts", "read", docs.id]);
  assert.equal(folder.exit, 1);
  assert.match(folder.err, /The artifact docs is a folder\. List what is in it with `botkins artifacts list --bot \S+ --folder \S+`\./);
  assert.match((await botkins(["artifacts", "read", "no-such-artifact"])).err, /This artifact is unavailable\./);
  assert.equal(readdirSync(dir).filter((name) => name.endsWith(".part")).length, 0);
  // Resolve: the paths of a chat, in the order given; a path that is none says none.
  const chat = (await client.call("chat.open", "Nova")).chatId;
  workspace.artifacts.record(join(files, "note.md"), { botId: nova.id, chatId: chat, source: "reply" });
  const resolved = await botkins(["artifacts", "resolve", chat, join(files, "note.md"), join(files, "missing.md")]);
  assert.equal(resolved.exit, 0, resolved.err);
  assert.match(resolved.out, /note\.md\s+note\.md\s+\S+\n.*missing\.md\s+none/);
  assert.deepEqual((await botkins(["artifacts", "resolve", chat, join(files, "note.md"), join(files, "missing.md"), "--json"])).json().items.map((item) => item?.name ?? null), ["note.md", null]);
  assert.equal((await botkins(["artifacts", "resolve", chat])).exit, 2);
  // Reading and listing change nothing, so they leave no line in the log.
  assert.deepEqual((await changes()).filter((line) => line.startsWith("artifacts.")), []);
});

test("an artifact is attached to a project and taken off again; the file stays", { skip }, async (t) => {
  const { botkins, workspace, dir, changes } = await service(t);
  const nova = (await botkins(["bots", "add", "Nova", "--json"])).json();
  const path = join(dir, "plan.md");
  writeFileSync(path, "the plan\n");
  const plan = workspace.artifacts.record(path, { botId: nova.id, source: "export" });
  await botkins(["projects", "add", "--name", "Launch"]);
  assert.match((await botkins(["projects", "artifacts", "Launch"])).out, /^No artifacts are attached to Launch\. Attach one with `botkins projects add-artifact`\.\n?$/);
  assert.match((await botkins(["projects", "add-artifact", "Launch", plan.id])).out, /^Attached\. Launch has 1 artifact\.\n?$/);
  assert.match((await botkins(["projects", "add-artifact", "Launch", path])).out, /^Attached\. Launch has 1 artifact\.\n?$/, "by its path, and not twice");
  assert.match((await botkins(["projects", "artifacts", "Launch"])).out, /^NAME\s+KIND\s+SIZE\s+WHEN\s+SOURCE\s+ID\nplan\.md\s+file/);
  assert.equal((await botkins(["projects", "show", "Launch", "--json"])).json().artifacts, 1);
  assert.deepEqual((await botkins(["projects", "artifacts", "Launch", "--json"])).json().items.map((item) => item.id), [plan.id]);
  assert.match((await botkins(["projects", "add-artifact", "Launch", "nothing"])).err, /This artifact no longer exists\./);
  assert.equal((await botkins(["projects", "add-artifact", "Launch"])).exit, 2);
  // The link goes and the file stays; it asks nothing, as it can be attached again.
  assert.match((await botkins(["projects", "remove-artifact", "Launch", plan.id])).out, /^Taken off\. Launch has 0 artifacts\.\n?$/);
  assert.equal(existsSync(path), true);
  assert.deepEqual((await changes()).filter((line) => /^projects\.(add|remove)Artifact/.test(line)), ["projects.addArtifact Launch", "projects.addArtifact Launch", "projects.removeArtifact Launch"]);
});

test("every command of the four groups is described by `botkins help --json`, with each option in its usage line", () => {
  const all = describe("9.9.9", {});
  for (const group of ["projects", "todos", "tasks", "artifacts"]) {
    const area = all.areas.find((entry) => entry.name === group);
    assert.ok(area?.commands.length >= 3, group + " is listed");
    for (const command of area.commands) {
      assert.ok(command.summary && command.usage.startsWith("botkins " + command.path.join(" ")), command.command + " has a summary and a usage line");
      for (const option of command.options) assert.ok(command.usage.includes(option.name), command.command + " names " + option.name + " in its usage line");
      // A command that asks has --yes, and the description says so.
      if (command.options.some((option) => option.name === "--yes")) assert.equal(command.asks, "--yes", command.command);
      // The words of the usage line are the arguments the description lists.
      for (const argument of command.arguments) assert.ok(command.usage.includes("<" + argument.name + ">"), command.command + " has <" + argument.name + ">");
    }
  }
  // The commands that ask: the ones that delete or commit, and a chat (only in the mode yolo).
  const asks = all.areas.flatMap((area) => area.commands).filter((command) => command.asks === "--yes" && ["projects", "todos", "tasks", "artifacts"].includes(command.path[0])).map((command) => command.command).sort();
  assert.deepEqual(asks, ["artifacts read", "projects chat", "projects commit", "projects remove", "tasks remove", "todos remove"]);
  assert.ok(COMMANDS.projects.commands.commit.run);
});
