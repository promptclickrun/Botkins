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
  const everything = () => [readFileSync(join(paths.dataDir, "workspace.json"), "utf8"), readFileSync(paths.logFile, "utf8")].join("\n");
  return { dir, paths, client, botkins, put, changes, everything };
}
const SECRET = "sk-VALUE-that-must-not-show";

test("a tool that starts a program is shown first and needs a yes; its values go in by a file and never come out", { skip }, async (t) => {
  const { botkins, put, client, everything } = await service(t);
  // The program's own arguments come after "--", so that one may start with a dash.
  const add = (...more) => ["tools", "add", "files", "--command", "npx", "--env", "API_KEY", ...more, "--", "-y", "@example/files server"];
  // With no terminal there is nobody to ask: the command shows what would run, fails, and names the flag.
  const asked = await botkins(add());
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /files starts this program on this computer, as the user that runs Botkins:\n {2}npx -y "@example\/files server"\n/);
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
  assert.equal((await botkins(["tools", "add", "broken", "--command", "node", "--env", "TOKEN", "--yes", "--secrets", put("other.json", { env: { OTHER: "x" } })])).exit, 1, "a file with no value for the name");

  // Changing what it starts: shown and asked again, and the stored value must be given again, because it would go somewhere new.
  const moved = (...more) => ["tools", "edit", "files", ...more, "--", "-y", "@example/other"];
  assert.equal((await botkins(moved())).exit, 2);
  const kept = await botkins(moved("--yes"));
  assert.equal(kept.exit, 1);
  assert.match(kept.err, /Enter the value for API_KEY again\. You changed where this server sends it\./);
  const again = await botkins(moved("--yes", "--env", "API_KEY", "--secrets", put("values2.json", { env: { API_KEY: SECRET + "2" } })));
  assert.equal(again.exit, 0, again.err);
  assert.match(again.err, /npx -y @example\/other/);
  // A change that starts nothing new asks nothing: a new name, a value taken away.
  assert.equal((await botkins(["tools", "edit", "files", "--name", "docs", "--remove-env", "API_KEY"])).exit, 0);
  assert.deepEqual((await botkins(["tools", "show", "docs", "--json"])).json().env, []);
  assert.equal((await botkins(["tools", "edit", "docs"])).exit, 2, "nothing to change");
  assert.equal((await botkins(["tools", "edit", "docs", "--url", "https://example.com/mcp"])).exit, 2, "a program has no web address");

  // Off needs no question; on does, for a program.
  assert.match((await botkins(["tools", "disable", "docs"])).out, /docs is off\./);
  assert.equal((await botkins(["tools", "enable", "docs"])).exit, 2);
  assert.match((await botkins(["tools", "enable", "docs", "--yes"])).out, /docs is on\./);
  // A test starts it, and says so. With no bot yet there is no session to try it in.
  const tried = await botkins(["tools", "test", "docs"]);
  assert.match(tried.err, /Starting: npx -y @example\/other/);
  assert.match(tried.err, /Create a bot first\./);
  // Removing asks too.
  assert.equal((await botkins(["tools", "remove", "docs"])).exit, 2);
  assert.match((await botkins(["tools", "remove", "docs", "--yes"])).out, /Removed docs\./);
  assert.match((await botkins(["tools", "show", "docs"])).err, /There is no tool called docs\. See `botkins tools list`\./);
  assert.equal(everything().includes(SECRET), false);
});

test("a tool on the web takes its header by name, and a file of tools is shown before it is added", { skip }, async (t) => {
  const { botkins, put, changes, everything } = await service(t);
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
  assert.equal((await botkins(["tools", "sign-out", "search"])).exit, 0);

  // A file of tools: each program is shown, one yes for all, and a name that is taken is left out.
  const file = put("mcp.json", { mcpServers: { search: { url: "https://dup.example.com" }, notes: { command: "uvx", args: ["notes-mcp", "--dir", "/srv/notes"], env: { NOTES_KEY: SECRET } }, remote: { url: "https://remote.example.com/mcp" } } });
  const asked = await botkins(["tools", "import", file]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /These start a program on this computer, as the user that runs Botkins:\n {2}notes: uvx notes-mcp --dir \/srv\/notes\n/);
  assert.deepEqual((await botkins(["tools", "list", "--json"])).json().map((tool) => tool.name), ["search"]);
  const done = await botkins(["tools", "import", file, "--yes"]);
  assert.match(done.out, /Added notes, remote\. Left out, because the name is taken: search\./);
  assert.deepEqual((await botkins(["tools", "show", "notes", "--json"])).json().env, ["NOTES_KEY"]);
  assert.equal((await botkins(["tools", "import", put("bad.json", "{")])).exit, 1);
  // From standard input, with nothing that starts a program: no question.
  assert.equal((await botkins(["tools", "import", "-"], { input: JSON.stringify({ servers: { piped: { url: "https://piped.example.com" } } }) })).exit, 0);
  assert.equal((await botkins(["tools", "forget-approvals"])).exit, 0);

  // Each change is in the log by its call and its thing. No value is.
  assert.deepEqual(await changes(), ["tools.add search", "tools.edit " + shown.id, "tools.signOut search", "tools.import", "tools.import", "tools.forgetApprovals"]);
  assert.equal(everything().includes(SECRET), false);
});

test("skills are added, changed, turned off and removed, and one bot's tools and skills are its own", { skip }, async (t) => {
  const { botkins, put, client } = await service(t);
  assert.match((await botkins(["skills", "add", "weekly-report", "--description", "Use for the Friday report.", "--instructions-file", put("report.md", "# Weekly report\n\nList what shipped.")])).out, /^Added weekly-report\./);
  assert.equal((await botkins(["skills", "add", "from-pipe", "--description", "Use when asked.", "--instructions-file", "-"], { input: "Do it." })).exit, 0);
  assert.equal((await botkins(["skills", "add", "none", "--description", "x"])).exit, 2);
  assert.match((await botkins(["skills", "add", "!!!", "--description", "x", "--instructions", "y"])).err, /Name the skill with letters, numbers and dashes\./);
  const list = (await botkins(["skills", "list", "--json"])).json();
  assert.deepEqual(list.skills.filter((skill) => skill.origin === "commander").map((skill) => [skill.name, skill.enabled]).sort(), [["from-pipe", true], ["weekly-report", true]]);
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
