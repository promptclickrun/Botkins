// Preferences, usage, the cache and the Mac tools from the command line (cli/commands/prefs.mjs),
// against a real service. (Voice is its own area: test/terminal-voice.test.mjs.) What these hold to: a
// preference is one of a fixed list; a change that gives bots more room is shown first, needs a yes, and
// is refused by the service's own call without the mark of that yes; with no terminal a question fails
// and names its flag; a change is in the log with its name and never its value (a level of approval or of
// a Mac tool is said, because it says how many questions bots ask).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
import { prefsCommands, PREFERENCE_KEYS } from "../cli/commands/prefs.mjs";
import { MAC_TOOL_NAMES, PREFERENCES } from "../desktop/terminal/control-prefs.mjs";
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
  const dir = mkdtempSync(join(tmpdir(), "bk-prefs-"));
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
  const lines = async (first) => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.startsWith(first)).map((text) => text.slice(first.length));
  const changes = () => lines("Changed from the command line: ");
  const tried = () => lines("Tried from the command line: ");
  const everything = () => [readFileSync(join(paths.dataDir, "workspace.json"), "utf8"), readFileSync(paths.logFile, "utf8")].join("\n");
  return { dir, paths, running, client, botkins, put, changes, tried, everything, workspace: running.runtime.workspace };
}

test("preferences: a fixed list of keys, a value that fits, and a log line with the key only", { skip }, async (t) => {
  const { botkins, put, client, changes, tried, everything } = await service(t);
  // The list: every key, as text and as JSON, and one key alone.
  const shown = await botkins(["preferences", "show"]);
  assert.equal(shown.exit, 0, shown.err);
  assert.match(shown.out, /^KEY +VALUE\n/);
  assert.match(shown.out, /^approval +ask$/m);
  assert.match(shown.out, /^clarificationInstructions +""$/m);
  assert.match(shown.out, /^notifications\.quietHours\.from +22:00$/m);
  assert.match(shown.out, /^sidebar\.collapsed +on$/m);
  const all = (await botkins(["preferences", "show", "--json"])).json();
  assert.deepEqual(Object.keys(all), PREFERENCE_KEYS);
  assert.equal(all.approval, "ask");
  assert.deepEqual(all.clarify, ["missing"]);
  assert.equal((await botkins(["preferences", "show", "approval"])).out, "ask\n");
  assert.deepEqual((await botkins(["preferences", "show", "approval", "--json"])).json(), { approval: "ask" });
  // A key that is not in the list is refused, and the list is in the refusal. Nothing changed.
  const unknown = await botkins(["preferences", "set", "macTools.mail", "read"]);
  assert.equal(unknown.exit, 1);
  assert.match(unknown.err, /There is no preference called macTools\.mail\. The keys are: appearance\.theme, /);
  assert.equal((await botkins(["preferences", "show", "nothing"])).exit, 1);
  // A value that fits is set and says what it is now. A switch takes on, off, yes, no, true, false.
  const set = await botkins(["preferences", "set", "appearance.theme", "dark"]);
  assert.equal(set.exit, 0, set.err);
  assert.equal(set.out, "Set appearance.theme to dark.\n");
  assert.equal((await botkins(["preferences", "set", "showThinking", "off", "--json"])).json().value, false);
  assert.equal((await botkins(["preferences", "set", "linkPreviews", "YES"])).exit, 0);
  assert.equal((await botkins(["preferences", "set", "notifications.quietHours.from", "21:30"])).exit, 0);
  assert.equal((await botkins(["preferences", "set", "clarify", "choices,changes"])).out, "Set clarify to choices, changes.\n");
  assert.equal((await botkins(["preferences", "set", "clarify", "none"])).out, "Set clarify to none.\n");
  assert.equal((await botkins(["preferences", "set", "sidebar.order", "Wiki,Home"])).exit, 0);
  assert.equal((await botkins(["preferences", "set", "appearance.bubble", "#3366CC"])).exit, 0);
  const now = (await botkins(["preferences", "show", "--json"])).json();
  assert.deepEqual([now["appearance.theme"], now.showThinking, now.linkPreviews, now["notifications.quietHours.from"], now.clarify, now["appearance.bubble"]], ["dark", false, true, "21:30", [], "#3366CC"]);
  assert.deepEqual(now["sidebar.order"].slice(0, 2), ["Wiki", "Home"]);
  // The change is in the workspace itself, not only in the answer.
  assert.equal((await client.call("preferences.get", "appearance.theme"))["appearance.theme"], "dark");
  // A value that does not fit is refused with what the key takes, and the setting stays.
  for (const [argv, words] of [
    [["appearance.theme", "purple"], /appearance\.theme takes one of system, light, dark\./],
    [["showThinking", "maybe"], /showThinking takes on or off\./],
    [["notifications.quietHours.to", "25:00"], /takes a time of day as HH:MM/],
    [["clarify", "missing,nonsense"], /clarify takes some of missing, choices, changes, or none\./],
    [["appearance.bubble", "red"], /takes theme, or a color such as #3366cc\./],
  ]) {
    const refused = await botkins(["preferences", "set", ...argv]);
    assert.equal(refused.exit, 1, argv.join(" "));
    assert.match(refused.err, words);
  }
  assert.equal((await botkins(["preferences", "show", "appearance.theme"])).out, "dark\n");
  // With no value, nothing to ask: a usage error.
  assert.equal((await botkins(["preferences", "set", "foldTools"])).exit, 2);
  assert.equal((await botkins(["preferences", "set"])).exit, 2);

  // A long text comes from a file or standard input, never only from the line. An empty value clears it.
  const WORDS = "Ask me before you rename a file. SECRET-WORDS";
  assert.equal((await botkins(["preferences", "set", "clarificationInstructions", "--file", put("words.txt", WORDS + "\n")])).exit, 0);
  assert.equal((await botkins(["preferences", "show", "clarificationInstructions"])).out, WORDS + "\n");
  assert.equal((await botkins(["preferences", "set", "clarificationInstructions", "-"], { input: "From a pipe.\n" })).exit, 0);
  assert.equal((await botkins(["preferences", "show", "clarificationInstructions", "--json"])).json().clarificationInstructions, "From a pipe.");
  assert.equal((await botkins(["preferences", "set", "clarificationInstructions", ""])).exit, 0);
  assert.equal((await botkins(["preferences", "show", "clarificationInstructions", "--json"])).json().clarificationInstructions, "");
  assert.equal((await botkins(["preferences", "set", "clarificationInstructions", "x", "--file", put("w2.txt", "y")])).exit, 2, "a word and a file");
  assert.equal((await botkins(["preferences", "set", "foldTools", "off", "--file", put("w3.txt", "on")])).exit, 2, "a file is for a text");
  assert.equal((await botkins(["preferences", "set", "clarificationInstructions", "--file", join(tmpdir(), "bk-prefs-no-such-file")])).exit, 1);

  // The log: the call and the key, never a value and never the text.
  const log = await changes();
  assert.ok(log.includes("preferences.set appearance.theme"));
  assert.ok(log.includes("preferences.set clarificationInstructions"));
  assert.ok(log.includes("preferences.set sidebar.order"));
  assert.ok(log.every((line) => !/dark|SECRET-WORDS|3366|21:30/.test(line)), log.join("\n"));
  // A refusal is in the log as a try, with the key as it was written (a name of letters and dots) and no value.
  assert.ok((await tried()).includes("preferences.set appearance.theme (it failed)"));
  assert.ok((await tried()).every((line) => /^preferences\.set [A-Za-z.]+ \(it failed\)$/.test(line) && !/purple|maybe|25:00|nonsense|red/.test(line)), (await tried()).join("\n"));
});

test("preferences harnesses: the choices, the one that is set, and whether a harness program is installed", { skip }, async (t) => {
  const { botkins, client, running } = await service(t);
  // Stand-ins for the program harnesses: the answer must not depend on what this computer has installed.
  running.runtime.handlers.harnesses = async () => [
    { id: "pi", name: "Pi", harness: true, installed: true, version: "1.0.0", connected: true },
    { id: "omp", name: "OMP", harness: true, installed: false, connected: false },
  ];
  const shown = await botkins(["preferences", "harnesses"]);
  assert.equal(shown.exit, 0, shown.err);
  assert.match(shown.out, /^CHOICE +CHOSEN +WHAT IT IS\ncopilot +yes +One harness runs every chat/m);
  assert.match(shown.out, /^pi +- +The Pi program runs the chats/m);
  assert.match(shown.out, /^PROGRAM +INSTALLED +VERSION +NOTE\npi +yes +1\.0\.0 +-$/m);
  const before = (await botkins(["preferences", "harnesses", "--json"])).json();
  assert.deepEqual([before.chosen, before.choices.map((entry) => entry.id), before.programs.map((entry) => [entry.id, entry.installed])], ["copilot", ["copilot", "provider", "pi", "omp"], [["pi", true], ["omp", false]]]);
  assert.equal(before.programs[0].version, "1.0.0");
  // The choice is the preference `harness`: setting it moves the mark.
  assert.equal((await botkins(["preferences", "set", "harness", "pi"])).exit, 0);
  assert.equal((await client.call("preferences.harnesses")).chosen, "pi");
  assert.match((await botkins(["preferences", "harnesses"])).out, /^pi +yes +The Pi program/m);
  assert.equal((await botkins(["preferences", "set", "harness", "omp"])).exit, 0);
  assert.equal((await client.call("preferences.harnesses")).chosen, "omp");
  assert.match((await botkins(["preferences", "harnesses"])).out, /^omp +yes +The OMP program/m);
  assert.equal((await botkins(["preferences", "harnesses", "extra"])).exit, 2);
  // Every program is a read: it leaves no line in the log.
  assert.deepEqual((await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("harnesses")), []);
});

test("preferences: a looser approval level is shown first and needs a yes", { skip }, async (t) => {
  const { botkins, client, changes, tried } = await service(t);
  const loosen = await botkins(["preferences", "set", "approval", "all"]);
  assert.equal(loosen.exit, 2);
  assert.match(loosen.err, /^This gives bots more room\. Bots then run commands and change files on this computer, and use every tool, without asking you first\.\n/);
  assert.match(loosen.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal((await client.call("preferences.get", "approval")).approval, "ask", "nothing changed");
  // --json shows it on standard error too: a caller that reads JSON still shows its person.
  const json = await botkins(["preferences", "set", "approval", "read", "--yes", "--json"]);
  assert.equal(json.exit, 0, json.err);
  assert.match(json.err, /file reads and read-only tools without asking you/);
  assert.equal(json.json().value, "read");
  // --yes alone shows it too, on standard error: the yes says that the person agreed, and the person can still read it.
  const yes = await botkins(["preferences", "set", "approval", "all", "--yes"]);
  assert.equal(yes.exit, 0, yes.err);
  assert.match(yes.err, /^This gives bots more room\. Bots then run commands and change files on this computer, and use every tool, without asking you first\.\n$/);
  assert.equal(yes.out, "Set approval to all.\n");
  // A level that is not looser needs no yes. Nor does a level that does not fit: that is refused as it is.
  const tighten = await botkins(["preferences", "set", "approval", "ask"]);
  assert.equal(tighten.exit, 0, tighten.err);
  assert.equal(tighten.err, "");
  assert.equal((await botkins(["preferences", "set", "approval", "everything"])).exit, 1);
  // At a terminal it asks, and no is no.
  assert.equal((await botkins(["preferences", "set", "approval", "assisted"], { input: "n\n", tty: true })).exit, 1);
  assert.equal((await client.call("preferences.get", "approval")).approval, "ask");
  assert.equal((await botkins(["preferences", "set", "approval", "assisted"], { input: "y\n", tty: true })).exit, 0);
  assert.equal((await client.call("preferences.get", "approval")).approval, "assisted");
  // The log says the new level (one of four words) and nothing else.
  assert.deepEqual(await changes(), ["preferences.set approval to read", "preferences.set approval to all", "preferences.set approval to ask", "preferences.set approval to assisted"]);
  // The one try is the level "everything", which is no level. The command line asked first for every real one, so the service refused none.
  assert.deepEqual(await tried(), ["preferences.set approval (it failed)"]);
});

test("preferences: access for all bots and teamwork give bots more room when they are switched on, so they are shown first and need a yes", { skip }, async (t) => {
  const { botkins, client, changes, tried } = await service(t);
  const value = async (key) => (await client.call("preferences.get", key))[key];
  // Both are on by default. Switching one off takes room away: no yes, no block.
  for (const key of ["access.allBots", "teamwork"]) {
    const off = await botkins(["preferences", "set", key, "off"]);
    assert.equal(off.exit, 0, off.err);
    assert.equal(off.err, "");
    assert.equal(await value(key), false);
  }
  // Switching one on is shown and needs a yes (with no terminal, --yes), and the service's own call needs the mark.
  const ask = await botkins(["preferences", "set", "access.allBots", "on"]);
  assert.equal(ask.exit, 2);
  assert.match(ask.err, /^This gives bots more room\. Every bot can then use every project\./);
  assert.match(ask.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal(await value("access.allBots"), false, "nothing changed");
  await assert.rejects(client.call("preferences.set", "teamwork", "on"), (error) => error.code === "NEEDS_YES" && /"agreed": true/.test(error.message));
  await assert.rejects(client.call("preferences.set", "teamwork", true, { agreed: false }), (error) => error.code === "NEEDS_YES");
  const yes = await botkins(["preferences", "set", "access.allBots", "true", "--yes", "--json"]);
  assert.equal(yes.exit, 0, yes.err);
  assert.match(yes.err, /^This gives bots more room\. Every bot can then use every project\./, "shown with --yes and --json too");
  assert.equal(await value("access.allBots"), true);
  // At a terminal it asks, and no is no.
  assert.equal((await botkins(["preferences", "set", "teamwork", "on"], { input: "n\n", tty: true })).exit, 1);
  assert.equal(await value("teamwork"), false);
  assert.equal((await botkins(["preferences", "set", "teamwork", "on"], { input: "y\n", tty: true })).exit, 0);
  assert.equal(await value("teamwork"), true);
  // A switch that is on already needs no yes. The log has the new word, and no try was needed to stop one.
  assert.equal((await botkins(["preferences", "set", "teamwork", "on"])).exit, 0);
  assert.deepEqual(await changes(), ["preferences.set access.allBots to off", "preferences.set teamwork to off", "preferences.set access.allBots to on", "preferences.set teamwork to on", "preferences.set teamwork to on"]);
  assert.deepEqual(await tried(), ["preferences.set teamwork (it failed)", "preferences.set teamwork (it failed)"]);
});

test("preferences: run at startup makes a login item, so switching it on is shown first and needs a yes", { skip }, async (t) => {
  const { botkins, client, changes, tried } = await service(t);
  const value = async () => (await client.call("preferences.get", "background.runAtStartup"))["background.runAtStartup"];
  assert.equal(await value(), false);
  // No terminal and no --yes: the block is shown, the flag is named, and nothing changes.
  const ask = await botkins(["preferences", "set", "background.runAtStartup", "on"]);
  assert.equal(ask.exit, 2);
  assert.match(ask.err, /^This changes this computer\. Botkins then starts when you log in to this computer\./);
  assert.match(ask.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal(await value(), false, "nothing changed");
  // The service's own call needs the mark.
  for (const extra of [[], [{ agreed: false }], [{ agreed: "yes" }]])
    await assert.rejects(client.call("preferences.set", "background.runAtStartup", true, ...extra), (error) => error.code === "NEEDS_YES" && /makes Botkins start when the person logs in to this computer.*"agreed": true/.test(error.message), JSON.stringify(extra));
  assert.equal(await value(), false);
  // With the mark it is set. Switching it off takes nothing and needs none.
  assert.deepEqual(await client.call("preferences.set", "background.runAtStartup", true, { agreed: true }), { key: "background.runAtStartup", value: true });
  assert.deepEqual(await client.call("preferences.set", "background.runAtStartup", false), { key: "background.runAtStartup", value: false });
  assert.deepEqual(await changes(), ["preferences.set background.runAtStartup to on", "preferences.set background.runAtStartup to off"]);
  assert.equal((await tried()).length, 3);
});

test("preferences: the service's own call refuses a looser approval level without the mark that the caller agreed", { skip }, async (t) => {
  const { client, changes, tried } = await service(t);
  const now = async () => (await client.call("preferences.get", "approval")).approval;
  // No mark, a wrong mark, a mark of the wrong kind: refused, and nothing changes. The sentence says what to give.
  for (const extra of [[], [{}], [{ agreed: false }], [{ agreed: "true" }], [true], ["agreed"], [null]]) {
    await assert.rejects(client.call("preferences.set", "approval", "all", ...extra), (error) => error.code === "NEEDS_YES" && /The approval level all is looser than ask: bots get more room.*"agreed": true/.test(error.message), JSON.stringify(extra));
  }
  assert.equal(await now(), "ask");
  // The level is checked as the call reads it: capitals and spaces do not get round it.
  await assert.rejects(client.call("preferences.set", "approval", " READ ", {}), (error) => error.code === "NEEDS_YES");
  // The mark opens exactly this: a looser level.
  assert.deepEqual(await client.call("preferences.set", "approval", "read", { agreed: true }), { key: "approval", value: "read" });
  // A tighter level, and the same one, need no mark. Another key never needs one.
  assert.deepEqual(await client.call("preferences.set", "approval", "ask"), { key: "approval", value: "ask" });
  assert.deepEqual(await client.call("preferences.set", "approval", "ask"), { key: "approval", value: "ask" });
  assert.deepEqual(await client.call("preferences.set", "foldTools", "off"), { key: "foldTools", value: false });
  // From a level that is not the first, only a level further on is looser.
  await client.call("preferences.set", "approval", "assisted", { agreed: true });
  assert.deepEqual(await client.call("preferences.set", "approval", "read"), { key: "approval", value: "read" });
  await assert.rejects(client.call("preferences.set", "approval", "all"), (error) => error.code === "NEEDS_YES");
  // The log: the level for a change of approval, the key alone for anything else, and a refusal as a try with no level.
  assert.deepEqual(await changes(), ["preferences.set approval to read", "preferences.set approval to ask", "preferences.set approval to ask", "preferences.set foldTools", "preferences.set approval to assisted", "preferences.set approval to read"]);
  assert.ok((await tried()).length >= 8);
  assert.ok((await tried()).every((line) => line === "preferences.set approval (it failed)"), (await tried()).join("\n"));
});

test("usage: the report as text and JSON, and the export to standard output or a file", { skip }, async (t) => {
  const { botkins, workspace, dir, changes } = await service(t);
  const empty = await botkins(["usage", "show"]);
  assert.equal(empty.exit, 0, empty.err);
  assert.match(empty.out, /^The last 30 days: 0 turns\./);
  // Two turns of one bot and one of a bot that is gone, in the state the report reads.
  const bot = workspace.state.bots[0] ?? { id: "b1", name: "Ada" };
  if (!workspace.state.bots.length) workspace.state.bots.push(bot);
  workspace.state.chats.push({ id: "c1", botId: bot.id, title: "Chat one", messages: [] });
  const run = (id, usage, extra = {}) => ({ id, chatId: "c1", time: Date.now() - 3600_000, status: "Done", title: "A turn", usage, ...extra });
  workspace.state.runs.push(run("r1", { input: 1200, output: 300, cost: 0.5, model: "gpt-x" }), run("r2", { input: 800, output: 100, model: "gpt-x" }), run("r3", { input: 50, output: 5, model: "other" }, { chatId: "gone", title: "=SUM(A1)" }));
  const report = await botkins(["usage", "show", "--days", "7"]);
  assert.equal(report.exit, 0, report.err);
  assert.match(report.out, /^The last 7 days: 3 turns\.\nTokens in 2,050, out 405, read from the cache 0\. Cost \$0\.50 \(priced for 1 of the 3 turns\)\./);
  assert.match(report.out, /By model:\nMODEL +PROVIDER +TURNS +IN +OUT +COST\ngpt-x +- +2 +2,000 +400 +\$0\.50\n/);
  assert.match(report.out, new RegExp("By bot:\\nBOT +TURNS +IN +OUT +COST\\n" + bot.name + " +2 +2,000"));
  assert.match(report.out, /Deleted bot +1 +50/);
  const json = (await botkins(["usage", "show", "--json"])).json();
  assert.equal(json.days, 30);
  assert.equal(json.totals.turns, 3);
  assert.equal(json.byDay.length, 30);
  // A period that is not offered is refused, by the command and by the service.
  const refused = await botkins(["usage", "show", "--days", "10"]);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /--days is 7, 30 or 90\./);

  // The export: the CSV on standard output, as JSON, or in a file that only the owner reads.
  const csv = await botkins(["usage", "export", "--days", "7"]);
  assert.equal(csv.exit, 0, csv.err);
  assert.match(csv.out, /^time,date,bot,chat,title,status,trigger,model,input_tokens,output_tokens,cache_read_tokens,cost,duration_ms,provider\n/);
  assert.equal(csv.out.trim().split("\n").length, 4);
  assert.match(csv.out, /'=SUM\(A1\)/, "a title that is a formula is guarded");
  const wrapped = (await botkins(["usage", "export", "--days", "7", "--json"])).json();
  assert.deepEqual([wrapped.name, wrapped.days, wrapped.text], ["botkins-usage-7d.csv", 7, csv.out]);
  const file = join(dir, "usage.csv");
  const saved = await botkins(["usage", "export", "--days", "7", "--output", file]);
  assert.equal(saved.exit, 0, saved.err);
  assert.match(saved.out, /^Saved botkins-usage-7d\.csv \(\d[\d,]* bytes\) to /);
  assert.equal(readFileSync(file, "utf8"), csv.out);
  // A file that is there is overwritten only after a yes.
  writeFileSync(file, "mine");
  const again = await botkins(["usage", "export", "--days", "7", "--output", file]);
  assert.equal(again.exit, 2);
  assert.match(again.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal(readFileSync(file, "utf8"), "mine");
  const over = await botkins(["usage", "export", "--days", "7", "--output", file, "--yes", "--json"]);
  assert.equal(over.exit, 0, over.err);
  assert.deepEqual([over.json().saved, readFileSync(file, "utf8")], [file, csv.out]);
  assert.equal((await botkins(["usage", "export", "--output", join(dir, "no", "such", "folder.csv")])).exit, 1);
  // Reading changes nothing: no log line, and nothing left in the artifact exports.
  assert.deepEqual(await changes(), []);
  assert.equal(existsSync(join(workspace.dir, "artifact-exports")), false);
});

test("cache: show, and clear after a yes", { skip }, async (t) => {
  const { botkins, changes } = await service(t);
  const shown = await botkins(["cache", "show"]);
  assert.equal(shown.exit, 0, shown.err);
  assert.equal(shown.out, "The window's cache: 0 bytes (this host has none). Bot menus kept: 0.\n");
  assert.deepEqual((await botkins(["cache", "show", "--json"])).json(), { bytes: 0, catalogs: 0 });
  const asked = await botkins(["cache", "clear"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.deepEqual(await changes(), []);
  const no = await botkins(["cache", "clear"], { input: "n\n", tty: true });
  assert.equal(no.exit, 1);
  const done = await botkins(["cache", "clear", "--yes"]);
  assert.equal(done.exit, 0, done.err);
  assert.match(done.out, /^The cache is clear\. The window's cache: 0 bytes/);
  assert.deepEqual((await botkins(["cache", "clear", "--yes", "--json"])).json(), { cleared: true, bytes: 0, catalogs: 0 });
  assert.deepEqual(await changes(), ["cache.clear", "cache.clear"]);
});

test("mac-tools: a level that gives bots more is shown first and needs a yes", { skip }, async (t) => {
  const { botkins, client, changes, workspace } = await service(t);
  // The permission checks of the real Mac are replaced: a test never asks macOS.
  Object.assign(workspace.mac, { platform: "darwin", findImsg: () => null, detect: { fullDisk: () => true, automation: async () => false } });
  const status = await botkins(["mac-tools", "status"]);
  assert.equal(status.exit, 0, status.err);
  assert.match(status.out, /^iMessage +off\nMail +off\n\nThe imsg program is not installed\. iMessage needs it: brew install steipete\/tap\/imsg\./);
  assert.equal((await botkins(["mac-tools", "status", "--json"])).json().available, true);

  // On: shown first (on standard error, with --json too), and asked for.
  const asked = await botkins(["mac-tools", "set", "mail", "read"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This lets bots use Mail on this Mac\. At the level read, bots can list your mailboxes, search your mail, and read the text of any email \(mail_mailboxes, mail_search, mail_read\)\. They do not ask you first\.\nBotkins runs \/usr\/bin\/osascript with its own fixed scripts on this Mac to do this\./);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal((await client.call("macTools.status")).levels.mail, "off", "nothing changed");
  const read = await botkins(["mac-tools", "set", "mail", "on", "--yes", "--json"]);
  assert.equal(read.exit, 0, read.err);
  assert.match(read.err, /read the text of any email/);
  assert.deepEqual([read.json().tool, read.json().levels], ["mail", { imessage: "off", mail: "read" }]);
  // A name that starts the same way works when only one tool starts so. The words of what it gives are for the level.
  const interact = await botkins(["mac-tools", "set", "imes", "interact", "--yes"]);
  assert.equal(interact.exit, 0, interact.err);
  assert.match(interact.err, /send an iMessage or SMS as you \(imessage_send\)/);
  assert.match(interact.err, /Botkins runs the imsg program/);
  assert.match(interact.out, /^iMessage is interact\.\n\niMessage +interact\nMail +read\n/);
  assert.match(interact.out, /macOS has not allowed Botkins: Automation of Messages, Automation of Mail\./);
  assert.equal((await botkins(["mac-tools", "set", "M", "interact", "--yes"])).exit, 0, "m starts Mail only, and capitals do not matter");
  assert.equal((await client.call("macTools.status")).levels.mail, "interact");
  // Lower, and the same level again, ask nothing.
  assert.equal((await botkins(["mac-tools", "set", "mail", "read"])).exit, 0);
  assert.equal((await botkins(["mac-tools", "set", "mail", "read"])).exit, 0);
  const off = await botkins(["mac-tools", "set", "imessage", "off"]);
  assert.equal(off.exit, 0, off.err);
  assert.equal(off.err, "");
  assert.deepEqual((await client.call("macTools.status")).levels, { imessage: "off", mail: "read" });
  // At a terminal it asks, and no is no.
  assert.equal((await botkins(["mac-tools", "set", "imessage", "read"], { input: "n\n", tty: true })).exit, 1);
  assert.equal((await client.call("macTools.status")).levels.imessage, "off");
  assert.equal((await botkins(["mac-tools", "set", "imessage", "read"], { input: "y\n", tty: true })).exit, 0);
  // What is not a tool or a level is refused.
  assert.equal((await botkins(["mac-tools", "set", "calendar", "read", "--yes"])).exit, 1);
  assert.equal((await botkins(["mac-tools", "set", "mail", "most", "--yes"])).exit, 2);
  assert.equal((await botkins(["mac-tools", "set", "mail"])).exit, 2);
  // The log: the call, the tool, and the level that it has now (the level says what bots may do).
  assert.deepEqual(await changes(), ["macTools.set mail to read", "macTools.set imessage to interact", "macTools.set mail to interact", "macTools.set mail to read", "macTools.set mail to read", "macTools.set imessage to off", "macTools.set imessage to read"]);
});

test("mac-tools: the service's own call refuses a level that gives bots more without the mark that the caller agreed", { skip }, async (t) => {
  const { client, changes, tried, workspace } = await service(t);
  Object.assign(workspace.mac, { platform: "darwin", findImsg: () => null, detect: { fullDisk: () => true, automation: async () => false } });
  const level = async (tool) => (await client.call("macTools.status")).levels[tool];
  for (const extra of [[], [{}], [{ agreed: false }], [{ agreed: "yes" }], [true]]) {
    await assert.rejects(client.call("macTools.set", "mail", "interact", ...extra), (error) => error.code === "NEEDS_YES" && /gives bots more of Mail than off.*"agreed": true/.test(error.message), JSON.stringify(extra));
  }
  assert.equal(await level("mail"), "off");
  assert.equal((await client.call("macTools.set", "mail", "read", { agreed: true })).levels.mail, "read");
  // From read, interact is more; read again and off are not. A different tool is judged on its own level.
  await assert.rejects(client.call("macTools.set", "mail", "interact"), (error) => error.code === "NEEDS_YES");
  await assert.rejects(client.call("macTools.set", "imessage", "read"), (error) => error.code === "NEEDS_YES");
  assert.equal((await client.call("macTools.set", "mail", "read")).levels.mail, "read");
  assert.equal((await client.call("macTools.set", "mail", "off")).levels.mail, "off");
  assert.equal((await client.call("macTools.set", "imessage", "off")).levels.imessage, "off");
  assert.deepEqual(await changes(), ["macTools.set mail to read", "macTools.set mail to read", "macTools.set mail to off", "macTools.set imessage to off"]);
  assert.ok((await tried()).length >= 7 && (await tried()).every((line) => /^macTools\.set (mail|imessage) \(it failed\)$/.test(line)), (await tried()).join("\n"));
  // Off a Mac the app's own sentence is the answer, not a question: there is nothing to agree to.
  workspace.mac.platform = "linux";
  await assert.rejects(client.call("macTools.set", "mail", "read"), (error) => error.code !== "NEEDS_YES" && /work only in Botkins on a Mac/.test(error.message));
});

test("mac-tools: on a computer that is not a Mac the app's own answer is passed on", { skip }, async (t) => {
  const { botkins, client, changes, workspace } = await service(t);
  workspace.mac.platform = "linux";
  const status = await botkins(["mac-tools", "status"]);
  assert.equal(status.exit, 0, status.err);
  assert.equal(status.out, "iMessage and Mail tools work only in Botkins on a Mac. This computer is not one.\n");
  const json = (await botkins(["mac-tools", "status", "--json"])).json();
  assert.deepEqual([json.available, json.levels, json.imsg.found], [false, { imessage: "off", mail: "off" }, false]);
  // No question is asked first: the app refuses, with its own sentence, even with no --yes and no terminal.
  const refused = await botkins(["mac-tools", "set", "mail", "read"]);
  assert.equal(refused.exit, 1);
  assert.equal(refused.err, "botkins: iMessage and Mail tools work only in Botkins on a Mac.\n");
  assert.equal(refused.err.includes("This needs a yes"), false);
  assert.equal((await botkins(["mac-tools", "set", "imessage", "interact", "--yes"])).exit, 1);
  // Off is always fine, so a choice carried over from a Mac can be cleared anywhere.
  assert.equal((await botkins(["mac-tools", "set", "mail", "off"])).exit, 0);
  assert.equal((await client.call("macTools.status")).available, false);
  assert.deepEqual(await changes(), ["macTools.set mail to off"]);
});

test("the commands are in `botkins help --json`, and the lists of the command line are the service's", { skip }, async (t) => {
  const { botkins } = await service(t);
  const help = (await botkins(["help", "--json"])).json();
  const area = (name) => help.areas.find((entry) => entry.name === name);
  for (const [name, verbs] of Object.entries({ preferences: ["show", "set", "harnesses"], usage: ["show", "export"], cache: ["show", "clear"], "mac-tools": ["status", "set"] })) {
    assert.deepEqual(area(name).commands.map((command) => command.path[1]), verbs, name);
    for (const command of area(name).commands) assert.match(command.usage, /^botkins /);
  }
  const set = area("preferences").commands.find((command) => command.path[1] === "set");
  assert.deepEqual(set.arguments, [{ name: "key", required: true }, { name: "value", required: false }]);
  assert.deepEqual(set.options.map((option) => option.name), ["--file", "--yes"]);
  assert.equal(set.asks, "--yes");
  // The commands that ask a person first, by the flag that answers (what the fixed list of test/terminal-coverage.test.mjs needs).
  const asking = help.areas.flatMap((entry) => (["preferences", "usage", "cache", "mac-tools"].includes(entry.name) ? entry.commands : [])).filter((command) => command.asks).map((command) => command.command + " " + command.asks);
  assert.deepEqual(asking.sort(), ["cache clear --yes", "mac-tools set --yes", "preferences set --yes", "usage export --yes"]);
  // `--help` lists every key, with what it takes.
  const text = (await botkins(["preferences", "set", "--help"])).out;
  for (const name of Object.keys(PREFERENCES)) assert.ok(text.includes("  " + name.padEnd(Math.max(...Object.keys(PREFERENCES).map((key) => key.length))) + "  "), name);
  for (const [name, spec] of Object.entries(PREFERENCES)) for (const value of spec.values ?? []) assert.ok(text.includes(value), name + " " + value);
  assert.deepEqual(PREFERENCE_KEYS, Object.keys(PREFERENCES));
  // The Mac tools are the service's.
  assert.deepEqual(Object.keys(MAC_TOOL_NAMES), ["imessage", "mail"]);
  assert.deepEqual(Object.keys(prefsCommands), ["preferences", "usage", "cache", "mac-tools"]);
});
