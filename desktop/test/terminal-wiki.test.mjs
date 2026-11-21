// The wiki from the command line (cli/commands/wiki.mjs), against a real service. What these hold
// to: a page is named by its path or its title; `show` prints the page as it is and a title is made
// safe in the text forms; a save with a stale revision is refused and says how to get the new one; a
// removal and a restore need a yes with no terminal; an export is written where --output says and
// never opens the window's dialog; a change is in the log by the page's name and never by its text.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
/** A real service, and `botkins(argv, { input, tty, env })` to run a command against it. */
async function service(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-wiki-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const botkins = async (argv, { input = "", tty = false, env = {} } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env, client });
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  const put = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, value);
    return path;
  };
  const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("Changed from the command line")).map((text) => text.split("Changed from the command line: ")[1]);
  return { dir, paths, client, botkins, put, changes };
}
const PLAN = "# Launch plan\n\nShip the thing on Friday. SECRET-PAGE-WORDS\n";

test("pages: add, show as it is, search, save with a revision, history, restore, move, remove", { skip }, async (t) => {
  const { botkins, put, client, changes, paths } = await service(t);

  // A page from a file: its path comes from its title, and the answer names it.
  const added = await botkins(["wiki", "add", "Launch", "plan", "--file", put("plan.md", PLAN)]);
  assert.equal(added.exit, 0, added.err);
  assert.match(added.out, /^Added launch-plan\.md \(Launch plan\)\./);
  const json = (await botkins(["wiki", "add", "Other page", "--file", "-", "--json"], { input: "# Other page\n\nfrom standard input\n" })).json();
  assert.deepEqual([json.path, json.title], ["other-page.md", "Other page"]);
  // The tree names it by the path that every command takes, and the same page is found by its title.
  const tree = await botkins(["wiki", "tree"]);
  assert.match(tree.out, /^launch-plan\.md {2,}Launch plan$/m);
  assert.ok((await botkins(["wiki", "tree", "--json"])).json().pages.some((page) => page.path === "launch-plan.md"));

  // `show` prints the page and nothing else on standard output; the note is on standard error.
  const shown = await botkins(["wiki", "show", "launch-plan"]);
  assert.equal(shown.out, PLAN);
  assert.match(shown.err, /^launch-plan\.md \(Launch plan\), revision [0-9a-f]{16}, 1 earlier version\.\n$/);
  assert.equal((await botkins(["wiki", "show", "Launch Plan"])).out, PLAN, "by its title, in any letter case");
  const page = (await botkins(["wiki", "show", "launch-plan.md", "--json"])).json();
  assert.equal(page.content, PLAN);
  assert.match(page.base, /^[0-9a-f]{16}$/);

  // A page that is not there, and a section is not a page.
  const missing = await botkins(["wiki", "show", "nothing-here"]);
  assert.equal(missing.exit, 1);
  assert.match(missing.err, /There is no page or section called nothing-here\. See `botkins wiki tree`\./);
  assert.equal((await botkins(["wiki", "show", "launch-plan", "extra"])).exit, 2);

  // Search finds it, with its path.
  const found = await botkins(["wiki", "search", "friday", "ship"]);
  assert.match(found.out, /^launch-plan\.md {3}Launch plan\n {4}.*Ship the thing on Friday/);
  assert.equal((await botkins(["wiki", "search", "friday", "--json"])).json()[0].path, "launch-plan.md");
  assert.match((await botkins(["wiki", "search", "zebra"])).out, /No page has all of those words\./);

  // A section, and a page in it. The folder must be there.
  assert.match((await botkins(["wiki", "add-folder", "Ideas"])).out, /Added the section ideas\//);
  const inFolder = await botkins(["wiki", "add", "Big idea", "--folder", "ideas"]);
  assert.match(inFolder.out, /^Added ideas\/big-idea\.md \(Big idea\)/);
  const noFolder = await botkins(["wiki", "add", "Lost", "--folder", "nowhere"]);
  assert.equal(noFolder.exit, 1);
  assert.match(noFolder.err, /There is no page or section called nowhere/);
  assert.equal((await botkins(["wiki", "add"])).exit, 2, "a page needs a title");
  assert.equal((await botkins(["wiki", "add", "Lost", "--file", join(paths.root, "no-such-file")])).exit, 1);
  assert.equal((await client.call("wiki.tree")).pages.some((item) => item.title === "Lost"), false, "a refused add leaves no page");

  // A page for a project starts from the project's record; the title comes from the project.
  // (The project is made by the socket's own call.)
  await client.call("projects.add", { name: "Website", description: "The new site" });
  const forProject = await botkins(["wiki", "add", "--for", "Website"]);
  assert.match(forProject.out, /^Added projects\/website\.md \(Website\)/);
  assert.equal((await botkins(["wiki", "add", "--for", "Nothing"])).exit, 1);
  assert.equal((await botkins(["wiki", "add", "--for", "Website", "Title"])).exit, 2);

  // A save with the revision that was read. A stale one is refused, nothing is saved, and the refusal says how to get the new one.
  const revised = "# Launch plan\n\nShip the thing on Monday. SECRET-PAGE-WORDS\n";
  const saved = await botkins(["wiki", "save", "launch-plan", "--file", put("v2.md", revised), "--base", page.base]);
  assert.equal(saved.exit, 0, saved.err);
  assert.match(saved.out, /^Saved launch-plan\.md \(Launch plan\)\. The earlier text is kept: `botkins wiki history launch-plan\.md`\./);
  const stale = await botkins(["wiki", "save", "launch-plan", "--file", put("v3.md", "# Launch plan\n\nLate.\n"), "--base", page.base]);
  assert.equal(stale.exit, 1);
  assert.match(stale.err, /changed after revision [0-9a-f]{16}\. Nothing was saved\. Read the page again, which gives its current revision \(`botkins wiki show launch-plan --json` has it as `base`/);
  assert.equal((await botkins(["wiki", "show", "launch-plan"])).out, revised);
  const stored = (await botkins(["wiki", "show", "launch-plan", "--json"])).json();
  const same = await botkins(["wiki", "save", "launch-plan", "--file", "-", "--base", stored.base, "--json"], { input: revised });
  assert.equal(same.json().changed, false);
  // With no terminal the text comes from a file; nothing is asked.
  const nothing = await botkins(["wiki", "save", "launch-plan"]);
  assert.equal(nothing.exit, 2);
  assert.match(nothing.err, /Give --file <path>, or --file - to read standard input\./);
  assert.equal((await botkins(["wiki", "save", "launch-plan", "--file", put("empty.md", "  \n")])).exit, 1);
  assert.equal((await botkins(["wiki", "save", "nothing-here", "--file", put("v4.md", "x")])).exit, 1);
  // At a terminal with no file, the editor opens with the page, and its save is checked against what was read.
  const editor = put("editor.mjs", "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2], '\\nAdded in the editor.\\n');");
  const edited = await botkins(["wiki", "save", "launch-plan"], { tty: true, env: { EDITOR: process.execPath + " " + editor } });
  assert.equal(edited.exit, 0, edited.err);
  assert.match((await botkins(["wiki", "show", "launch-plan"])).out, /Ship the thing on Monday\. SECRET-PAGE-WORDS\n\nAdded in the editor\.\n$/);

  // History, a version read as it is (by the start of its id), and a restore that needs a yes.
  const history = (await botkins(["wiki", "history", "launch-plan", "--json"])).json();
  // (The page's own template is the first version: the text of the file replaced it.)
  assert.equal(history.versions.length, 3);
  assert.match(history.versions[0].id, /^\d{13}-/);
  const text = await botkins(["wiki", "history", "launch-plan"]);
  assert.match(text.out, /^VERSION {2,}WHEN {2,}BY\n\d{13}-You {2,}.* ago {2,}You\n/);
  const oldest = history.versions[1];
  const read = await botkins(["wiki", "version", "launch-plan", oldest.id.slice(0, 15)]);
  assert.equal(read.out, PLAN);
  assert.equal((await botkins(["wiki", "version", "launch-plan", oldest.id, "--json"])).json().text, PLAN);
  assert.equal((await botkins(["wiki", "version", "launch-plan", "1"])).exit, 1);
  const noYes = await botkins(["wiki", "restore", "launch-plan", oldest.id]);
  assert.equal(noYes.exit, 2);
  assert.match(noYes.err, /This replaces the text of launch-plan\.md with the version from .* ago\.\n.*This needs a yes\. Run it again with --yes\./s);
  assert.equal((await botkins(["wiki", "show", "launch-plan"])).out.includes("Monday"), true, "nothing changed without the yes");
  const restored = await botkins(["wiki", "restore", "launch-plan", oldest.id, "--yes"]);
  assert.equal(restored.exit, 0, restored.err);
  assert.equal((await botkins(["wiki", "show", "launch-plan"])).out, PLAN);
  assert.equal((await botkins(["wiki", "history", "launch-plan", "--json"])).json().versions.length, 4, "the text before the restore is kept too");

  // Move: the whole new path is given; a page and a section.
  const moved = await botkins(["wiki", "move", "launch-plan", "ideas/launch.md"]);
  assert.match(moved.out, /^Moved launch-plan\.md to ideas\/launch\.md\./);
  assert.equal((await botkins(["wiki", "show", "ideas/launch"])).out, PLAN);
  assert.match((await botkins(["wiki", "move", "ideas", "notions"])).out, /^Moved ideas to notions\./);
  assert.equal((await botkins(["wiki", "move", "notions/launch.md", "other-page.md"])).exit, 1, "a page is there already");

  // Remove asks first, and with no terminal needs --yes. A section goes with its pages.
  const noRemove = await botkins(["wiki", "remove", "notions"]);
  assert.equal(noRemove.exit, 2);
  assert.match(noRemove.err, /This removes the section notions\/ and its 2 pages\.\n.*This needs a yes\. Run it again with --yes\./s);
  assert.ok((await client.call("wiki.tree")).folders.includes("notions"));
  assert.equal((await botkins(["wiki", "remove", "notions"], { input: "n\n", tty: true })).exit, 1);
  assert.match((await botkins(["wiki", "remove", "notions"], { input: "y\n", tty: true })).out, /^Removed notions\./);
  const gone = await botkins(["wiki", "remove", "other-page", "--yes", "--json"]);
  assert.deepEqual(gone.json(), { removed: "other-page.md", kind: "page" });
  assert.equal((await botkins(["wiki", "remove", "other-page", "--yes"])).exit, 1);

  // Each change left a line with the name of the page, and no line has a page's words.
  const lines = await changes();
  for (const line of ["wiki.add launch-plan.md", "wiki.addFolder ideas", "wiki.save launch-plan.md", "wiki.restore launch-plan.md", "wiki.move launch-plan.md", "wiki.remove notions", "wiki.remove other-page.md"]) assert.ok(lines.includes(line), line + " is in the log: " + lines.join(" | "));
  assert.ok(lines.includes("wiki.add projects/website.md"));
  assert.equal(readFileSync(paths.logFile, "utf8").includes("SECRET-PAGE-WORDS"), false);
  // A change that failed is in the log as one that was tried.
  assert.equal(readFileSync(paths.logFile, "utf8").includes("Tried from the command line: wiki.save launch-plan"), true);
});

test("a title is made safe in the text forms, and a page is printed as it is", { skip }, async (t) => {
  const { botkins, put, client, changes } = await service(t);
  const bidi = "Evil ‮ title";
  const body = "# " + bidi + "\n\nred: \u001b[31mtext\u001b[0m and a flag of ‮\n";
  const made = await botkins(["wiki", "add", bidi, "--file", put("evil.md", body)]);
  assert.equal(made.exit, 0, made.err);
  assert.equal(made.out.includes("‮"), false);
  assert.match(made.out, /\\u\{202e\}/);
  const path = (await client.call("wiki.tree")).pages.find((item) => item.title.includes("Evil")).path;
  // The tree, a search and the history: titles written as their numbers. The JSON has the value as it is.
  for (const argv of [["wiki", "tree"], ["wiki", "search", "evil"], ["wiki", "history", path], ["wiki", "save", path, "--file", put("next.md", body + "more\n")]]) {
    const result = await botkins(argv);
    assert.equal(result.out.includes("‮"), false, argv.join(" "));
    assert.equal(result.out.includes("\u001b"), false, argv.join(" "));
  }
  assert.equal((await botkins(["wiki", "tree", "--json"])).json().pages.find((item) => item.path === path).title, bidi);
  assert.equal((await botkins(["wiki", "search", "evil", "--json"])).json()[0].title, bidi);
  // `show` and `version` print the text exactly, the escape character and all.
  assert.equal((await botkins(["wiki", "show", path])).out, body + "more\n");
  const [version] = (await botkins(["wiki", "history", path, "--json"])).json().versions;
  assert.equal((await botkins(["wiki", "version", path, version.id])).out, body);
  // The log has the page's path and never its words.
  assert.ok((await changes()).every((line) => !line.includes("red:") && !line.includes("‮")));
});

test("an export is written where --output says: a zip, or a web page; the window's dialog is not used", { skip }, async (t) => {
  const { botkins, put, client, dir, changes } = await service(t);
  await botkins(["wiki", "add", "Alpha", "--file", put("a.md", "# Alpha\n\nSee [Beta](beta.md). EXPORT-WORDS\n")]);
  await botkins(["wiki", "add", "Beta", "--file", put("b.md", "# Beta\n\nBack to [Alpha](alpha.md).\n")]);
  await botkins(["wiki", "add", "Gamma", "--file", put("g.md", "# Gamma\n\nNo links.\n")]);

  // What an export holds, and why; with a page: the page and the pages that link with it.
  const plan = (await botkins(["wiki", "export", "--list", "--json"])).json();
  assert.ok(plan.pages.length >= 3);
  assert.match((await botkins(["wiki", "export", "--list"])).out, /^PATH {2,}TITLE {2,}WHY\n/);
  const around = (await botkins(["wiki", "export", "alpha", "--list", "--json"])).json();
  assert.deepEqual(around.pages.map((item) => [item.path, item.why]), [["alpha.md", "start"], ["beta.md", "linked"]]);

  // A zip into a folder: the app's name for the file; it is a zip with the pages in it.
  const folder = join(dir, "out");
  mkdirSync(folder);
  const zipped = await botkins(["wiki", "export", "--output", folder, "--json"]);
  assert.equal(zipped.exit, 0, zipped.err);
  const info = zipped.json();
  assert.equal(info.path, join(folder, "Wiki wiki export.zip"));
  assert.ok(info.pages >= 3 && info.bytes > 100);
  const bytes = readFileSync(info.path);
  assert.equal(bytes.subarray(0, 2).toString(), "PK");
  assert.ok(bytes.includes("alpha.md") && bytes.includes("gamma.md"));
  assert.equal(statSync(info.path).mode & 0o077, 0, "only its owner reads the file");
  // The same again is refused with no terminal, and replaced with the yes; at a terminal it asks.
  const again = await botkins(["wiki", "export", "--output", folder]);
  assert.equal(again.exit, 2);
  assert.match(again.err, /Wiki wiki export\.zip is there already\. This replaces it\.\n.*This needs a yes/s);
  assert.equal((await botkins(["wiki", "export", "--output", folder, "--yes"])).exit, 0);
  assert.equal((await botkins(["wiki", "export", "--output", folder], { input: "n\n", tty: true })).exit, 1);

  // One page and the ones it links with, as a web page, to a file.
  const html = join(dir, "alpha.html");
  const page = await botkins(["wiki", "export", "alpha", "--format", "html", "--output", html]);
  assert.equal(page.exit, 0, page.err);
  assert.match(page.out, /^Wrote 2 pages to .*alpha\.html \(\d[\d,]* bytes\)\./);
  const text = readFileSync(html, "utf8");
  assert.ok(text.includes("EXPORT-WORDS") && text.includes("Beta") && !text.includes("No links."));

  // What is refused: no place to write, a format that needs the window, a scope with no page, a page that is not there, and a path that cannot be written.
  const noOutput = await botkins(["wiki", "export"]);
  assert.equal(noOutput.exit, 2);
  assert.match(noOutput.err, /Say where to write the file with --output <path>, or list the pages with --list\./);
  const pdf = await botkins(["wiki", "export", "--format", "pdf", "--output", join(dir, "x.pdf")]);
  assert.equal(pdf.exit, 2);
  assert.match(pdf.err, /A PDF is laid out by the app's window/);
  assert.equal(existsSync(join(dir, "x.pdf")), false);
  assert.equal((await botkins(["wiki", "export", "--scope", "page", "--output", html])).exit, 2);
  assert.equal((await botkins(["wiki", "export", "alpha", "--scope", "all", "--output", html])).exit, 2);
  assert.equal((await botkins(["wiki", "export", "nope", "--output", html])).exit, 1);
  assert.equal((await botkins(["wiki", "export", "--output", join(dir, "no", "such", "folder.zip")])).exit, 1);
  assert.match((await client.call("wiki.export", { scope: "all", format: "pdf" }).catch((error) => error)).message, /A PDF is laid out/);
  // The log has the scope, and no page's words.
  const lines = await changes();
  assert.ok(lines.includes("wiki.export all pages") && lines.includes("wiki.export alpha"), lines.join(" | "));
});

test("the wiki's commands are in `botkins help --json`, and every one works with --json and with no terminal", { skip }, () => {
  const { areas } = describe("9.9.9", {});
  const wiki = areas.find((area) => area.name === "wiki");
  assert.deepEqual(wiki.commands.map((command) => command.command).sort(), ["wiki add", "wiki add-folder", "wiki export", "wiki history", "wiki move", "wiki remove", "wiki restore", "wiki save", "wiki search", "wiki show", "wiki tree", "wiki version"]);
  const save = wiki.commands.find((command) => command.command === "wiki save");
  assert.match(save.usage, /--base <revision>/);
  assert.deepEqual(save.options.map((option) => option.name), ["--file", "--base"]);
  assert.deepEqual(save.arguments, [{ name: "page", required: true }]);
  assert.equal(wiki.commands.find((command) => command.command === "wiki remove").asks, "--yes");
  assert.equal(wiki.commands.find((command) => command.command === "wiki restore").asks, "--yes");
  for (const command of wiki.commands) {
    assert.ok(command.summary && command.usage.startsWith("botkins wiki"), command.command);
    // Each option that its usage line names is there, and the other way round.
    for (const option of command.options) assert.ok(command.usage.includes(option.name), command.command + " names " + option.name);
  }
  assert.ok(COMMANDS.wiki.details.includes("as it is"));
});
