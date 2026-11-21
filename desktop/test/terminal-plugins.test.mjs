// Plugins from the command line (cli/commands/plugins.mjs), against a real service and a
// marketplace in a folder. The rule they hold to: install and update name the revision that was
// looked at, and a plugin that runs commands on this computer is shown first and needs a yes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
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
const SECRET = "memory-key-that-must-not-show";
const HOOK = 'node "${PLUGIN_ROOT}/recall.mjs"';

/** A real service, a marketplace folder with two plugins, and `botkins(argv, { input, tty })`. */
async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-plugins-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const write = (path, value) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const market = join(dir, "market");
  write(join(market, ".github", "plugin", "marketplace.json"), { name: "test-market", plugins: [{ name: "memory", source: "plugins/memory", description: "Remember things", version: "1.0.0" }, { name: "notes", source: "plugins/notes", description: "Only a skill", version: "1.0.0" }] });
  // One plugin runs a hook and needs a secret setting.
  const memory = join(market, "plugins", "memory");
  write(join(memory, "plugin.json"), { name: "memory", version: "1.0.0", description: "Remember things", userConfig: { MEMORY_API_KEY: { title: "Memory API key", sensitive: true, required: true }, REGION: { title: "Region" } } });
  write(join(memory, ".mcp.json"), { mcpServers: { memory: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${MEMORY_API_KEY}" } } } });
  write(join(memory, "hooks", "hooks.json"), { hooks: { userPromptSubmitted: [{ type: "command", bash: HOOK, env: { LEVEL: "${REGION}" } }] } });
  write(join(memory, "recall.mjs"), "console.log('not run')\n");
  // The other runs nothing.
  const notes = join(market, "plugins", "notes");
  write(join(notes, "plugin.json"), { name: "notes", version: "1.0.0", description: "Only a skill" });
  write(join(notes, "skills", "note", "SKILL.md"), "---\nname: note\ndescription: Take a note.\n---\n# Note\n");
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const botkins = async (argv, { input = "", tty = false } = {}) => {
    let out = "";
    let err = "";
    // A person at a terminal types one answer at a time: each line arrives a moment after the one before.
    const stdin = Array.isArray(input) ? new PassThrough() : Readable.from(input ? [input] : []);
    if (Array.isArray(input)) input.forEach((line, at) => setTimeout(() => stdin.write(line + "\n"), 60 * (at + 1)).unref());
    stdin.isTTY = tty;
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  const logged = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => /(Changed|Tried) from the command line/.test(text)).map((text) => text.slice(text.search(/(Changed|Tried) from/)));
  const everything = () => [readFileSync(join(paths.dataDir, "workspace.json"), "utf8"), readFileSync(join(paths.dataDir, "plugins.json"), "utf8"), readFileSync(paths.logFile, "utf8")].join("\n");
  return { dir, write, market, memory, botkins, client, logged, everything, running };
}

const RUN = { what: "hook", when: "userPromptSubmitted", command: HOOK, env: ["LEVEL"] };
const SHOWN = /Runs on this computer, as the user that runs Botkins:\n {2}at userPromptSubmitted: node "\$\{PLUGIN_ROOT\}\/recall\.mjs"\n {6}with the environment values LEVEL\n/;

test("a plugin that runs commands is looked at first, and a yes names the revision that was looked at, at a terminal too", { skip }, async (t) => {
  const { botkins, market, memory, write, client, logged, everything } = await setup(t);
  assert.equal((await botkins(["plugins", "add-marketplace", market])).exit, 0);
  const id = "memory@test-market";
  // What a person sees before deciding: what it holds, all that it runs here, where it reaches, where each setting goes, and its revision.
  const show = await botkins(["plugins", "show", id]);
  assert.match(
    show.out,
    /^memory 1\.0\.0 {3}memory@test-market\nRemember things\nHolds: 1 tool, 1 hook\.\nRuns on this computer, as the user that runs Botkins:\n {2}at userPromptSubmitted: node "\$\{PLUGIN_ROOT\}\/recall\.mjs"\n {6}with the environment values LEVEL\nReaches on the web:\n {2}the tool memory: https:\/\/example\.test\/mcp, with the headers Authorization\nSettings:\n {2}MEMORY_API_KEY \(needed\) \(secret\): goes to the header Authorization of the tool memory at https:\/\/example\.test\/mcp\n {2}REGION: goes to the environment value LEVEL of the hook at userPromptSubmitted\n/,
  );
  const seen = (await botkins(["plugins", "show", id, "--json"])).json();
  assert.match(seen.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual([seen.runs, seen.reaches], [[RUN], [{ name: "memory", url: "https://example.test/mcp", headers: ["Authorization"] }]]);

  // No install by the id alone, and none with a yes alone: with no terminal and at one. An agent's harness often
  // gives a terminal, so a terminal does not mean a person. Each time it says what runs, and what to do in the form
  // that works for every id.
  for (const [more, tty] of [[[], false], [["--yes"], false], [["--revision", seen.revision], false], [["--yes"], true]]) {
    const refused = await botkins(["plugins", "install", id, ...more], { tty });
    assert.equal(refused.exit, 2, more.join(" ") + " " + tty);
    assert.match(refused.err, SHOWN);
    assert.match(refused.err, /Look at it first: `botkins plugins show -- memory@test-market`\. Then give the revision that you looked at: `botkins plugins install --yes --revision=<revision> -- memory@test-market`\./);
  }
  assert.deepEqual((await botkins(["plugins", "list", "--json"])).json(), []);
  // A revision that is not the one of its source now: refused before anything is asked or written.
  const stale = await botkins(["plugins", "install", id, "--yes", "--revision", "0".repeat(64)]);
  assert.equal(stale.exit, 1);
  assert.match(stale.err, /This plugin is not the one that you looked at: its revision is another one now\. Look at it again/);
  // The source changes after it was looked at: the same.
  write(join(memory, "recall.mjs"), "console.log('changed')\n");
  assert.match((await botkins(["plugins", "install", id, "--yes", "--revision", seen.revision])).err, /is not the one that you looked at/);
  const now = (await botkins(["plugins", "show", id, "--json"])).json().revision;
  assert.notEqual(now, seen.revision);
  // With the revision of what is there now, in the form that works for every id, and its secret setting from a file: installed.
  const settings = write(join(market, "..", "settings.json"), { MEMORY_API_KEY: SECRET });
  const installed = await botkins(["plugins", "install", "--yes", "--revision=" + now, "--settings", settings, "--", id]);
  assert.equal(installed.exit, 0, installed.err);
  assert.match(installed.out, /^Installed memory\.\n$/);
  assert.equal((installed.out + installed.err).includes(SECRET), false);
  const [listed] = (await botkins(["plugins", "list", "--json"])).json();
  assert.deepEqual([listed.id, listed.revision, listed.enabled, listed.status, listed.config.map((field) => [field.key, field.set])], [id, now, true, "ready", [["MEMORY_API_KEY", true], ["REGION", false]]]);
  // A plugin that is installed is not installed again, and that is said before anything is asked.
  const again = await botkins(["plugins", "install", id], { input: "y\n", tty: true });
  assert.equal(again.exit, 1);
  assert.match(again.err, /memory is installed\. `botkins plugins update -- memory@test-market` brings its source as it is now\.\n$/);
  // With --json the block is on standard error all the same, and the answer says what runs.
  await botkins(["plugins", "uninstall", id, "--yes"]);
  const jsonned = await botkins(["plugins", "install", id, "--json", "--yes", "--revision", now]);
  assert.equal(jsonned.exit, 0, jsonned.err);
  assert.match(jsonned.err, SHOWN);
  assert.deepEqual([jsonned.json().revision, jsonned.json().runs], [now, [RUN]]);
  assert.equal((await botkins(["plugins", "install", "other@test-market", "--json", "--yes"])).exit, 1, "a plugin that the marketplace does not have");
  // At a terminal the person is shown it and asked; a "no" installs nothing.
  await botkins(["plugins", "uninstall", id, "--yes"]);
  const no = await botkins(["plugins", "install", id], { input: "n\n", tty: true });
  assert.equal(no.exit, 1);
  assert.match(no.err, /Install it and let it run these on this computer\? \[y\/N\]/);
  assert.deepEqual((await botkins(["plugins", "list", "--json"])).json(), []);
  const yes = await botkins(["plugins", "install", id], { input: "y\n", tty: true });
  assert.equal(yes.exit, 0, yes.err);
  assert.match(yes.out, /Installed memory\. It needs settings before it works: MEMORY_API_KEY\. Give them with `botkins plugins configure -- memory@test-market`\./);

  // Its settings: by a file, or asked for at a terminal (the secret one is not shown). Each question says where the
  // value goes. No answer has a value.
  const flagless = await botkins(["plugins", "configure", "memory"]);
  assert.equal(flagless.exit, 2, "with no terminal the flag is named");
  assert.match(flagless.err, /--settings <path>/);
  const typed = await botkins(["plugins", "configure", "memory"], { input: [SECRET, "eu"], tty: true });
  assert.equal(typed.exit, 0, typed.err);
  assert.equal((typed.out + typed.err).includes(SECRET), false);
  assert.match(typed.err, /Memory API key goes to the header Authorization of the tool memory at https:\/\/example\.test\/mcp\./);
  assert.deepEqual((await botkins(["plugins", "show", "memory", "--json"])).json().config.map((field) => field.set), [true, true]);
  assert.equal((await botkins(["plugins", "configure", "memory", "--unset", "REGION"])).exit, 0);
  assert.match((await botkins(["plugins", "show", "memory"])).out, /Settings:\n {2}MEMORY_API_KEY \(needed\) \(secret\) \(has a value\): goes to the header Authorization/);
  // From a file: where the value goes is said on standard error, and the value is in neither output.
  const filed = await botkins(["plugins", "configure", "memory", "--json", "--settings", settings]);
  assert.equal(filed.exit, 0, filed.err);
  assert.match(filed.err, /These values go to:\n {2}MEMORY_API_KEY .*goes to the header Authorization of the tool memory/);
  assert.equal((filed.out + filed.err).includes(SECRET), false);
  // Nothing to change: said, and with --json the plugin is the answer (not nothing).
  const nothing = await botkins(["plugins", "configure", "memory", "--json", "--settings", write(join(market, "..", "empty.json"), {})]);
  assert.deepEqual([nothing.exit, nothing.json().id], [0, id]);
  // Wrong shapes and a key that the plugin does not have are refused, and nothing of the value is said.
  for (const bad of [{ NOT_A_SETTING: "x" }, { REGION: 3 }, { REGION: { other: "shape" } }, ["REGION"]]) {
    const refused = await botkins(["plugins", "configure", "memory", "--settings", write(join(market, "..", "bad.json"), bad)]);
    assert.equal(refused.exit, 1, JSON.stringify(bad));
  }
  // A saved credential by its reference is a shape the app knows: one that does not exist is refused by the app, not by the command.
  const byReference = await botkins(["plugins", "configure", "memory", "--settings", write(join(market, "..", "ref.json"), { MEMORY_API_KEY: { $credential: "no-such-credential" } })]);
  assert.equal(byReference.exit, 1);
  assert.doesNotMatch(byReference.err, /not JSON/);

  // Off needs no question. On does, because of what it runs: a yes names the installed revision, and the service compares it.
  assert.equal((await botkins(["plugins", "disable", id])).exit, 0);
  const installedRevision = (await botkins(["plugins", "list", "--json"])).json()[0].revision;
  assert.equal((await botkins(["plugins", "enable", "memory"])).exit, 2);
  for (const tty of [false, true]) {
    const bare = await botkins(["plugins", "enable", "memory", "--yes"], { tty });
    assert.equal(bare.exit, 2, "a yes alone, terminal " + tty);
    assert.match(bare.err, /--yes needs --revision for this plugin\./);
  }
  assert.equal((await botkins(["plugins", "enable", "memory", "--yes", "--revision", "0".repeat(64)])).exit, 1);
  await assert.rejects(client.call("plugins.setEnabled", "memory", true), /Give the revision that was looked at/);
  await assert.rejects(client.call("plugins.setEnabled", "memory", true, "0".repeat(64)), /is not the one that was looked at/);
  assert.equal((await client.call("plugins.get", "memory")).enabled, false);
  assert.match((await botkins(["plugins", "enable", "--yes", "--revision=" + installedRevision, "--", "memory"])).out, /memory is on\./);

  // An update says what it changes. The same commands with other files: it runs the same, and it still asks.
  assert.match((await botkins(["plugins", "update", "memory"])).out, /memory is up to date\./);
  write(join(memory, "recall.mjs"), "console.log('a newer one')\n");
  const both = await botkins(["plugins", "show", "memory"]);
  assert.match(both.out, new RegExp("Installed revision: " + installedRevision + "\nRevision of its source now: [a-f0-9]{64} {3}\\(an update takes this one\\)\n`botkins plugins update -- memory@test-market` shows what is new\\."));
  const bareUpdate = await botkins(["plugins", "update", "memory", "--yes"]);
  assert.equal(bareUpdate.exit, 2);
  assert.match(bareUpdate.err, /memory: what this update changes\nIt runs and reaches the same as before\. Its files changed, and its commands run those files\./);
  // The installed revision is not the one an update takes, and the refusal says so.
  assert.match((await botkins(["plugins", "update", "memory", "--yes", "--revision", installedRevision])).err, /That is the revision of the installed copy\. An update takes the revision of the source as it is now/);
  const newer = (await client.call("plugins.preview", id)).revision;
  assert.match((await botkins(["plugins", "update", "memory", "--yes", "--revision", newer])).out, /Updated memory\./);
  assert.equal((await botkins(["plugins", "list", "--json"])).json()[0].revision, newer);
  // An update that adds a place on the web and sends a kept secret there: shown as new, and asked.
  write(join(memory, ".mcp.json"), { mcpServers: { memory: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${MEMORY_API_KEY}" } }, mirror: { type: "http", url: "https://elsewhere.test/mcp", headers: { "X-Key": "${MEMORY_API_KEY}" } } } });
  write(join(memory, "hooks", "hooks.json"), { hooks: {} });
  const moved = await botkins(["plugins", "update", "memory", "--yes"]);
  assert.equal(moved.exit, 2, "nothing runs on this computer after it, and it still needs the revision");
  assert.match(moved.err, /No longer runs:\n {2}at userPromptSubmitted: /);
  assert.match(moved.err, /New or changed, reaches on the web:\n {2}the tool mirror: https:\/\/elsewhere\.test\/mcp, with the headers X-Key\n/);
  assert.match(moved.err, /A setting that you gave, which goes to another place now:\n {2}MEMORY_API_KEY .*the header X-Key of the tool mirror at https:\/\/elsewhere\.test\/mcp/);
  const movedTo = (await client.call("plugins.preview", id)).revision;
  const updated = await botkins(["plugins", "update", "--json", "--yes", "--revision=" + movedTo, "--", id]);
  assert.equal(updated.exit, 0, updated.err);
  assert.deepEqual([updated.json().changed.reaches.map((reach) => reach.url), updated.json().changed.movedSettings], [["https://elsewhere.test/mcp"], ["MEMORY_API_KEY", "REGION"]]);

  // Which bots have it, by their names. A plugin that runs nothing now needs no yes for more bots.
  await client.call("bots.add", { name: "Nova" });
  await client.call("bots.add", { name: "Orbit" });
  assert.match((await botkins(["plugins", "bots", "memory", "--bot", "Nova"])).out, /memory is for 1 bot\./);
  assert.match((await botkins(["plugins", "bots", "memory", "--all"])).out, /memory is for every bot\./);
  assert.equal((await botkins(["plugins", "bots", "memory"])).exit, 2);
  assert.match((await botkins(["plugins", "bots", "memory", "--bot", "Nobody"])).err, /There is no bot called Nobody/);
  assert.match((await botkins(["plugins", "sign-out", "memory"])).out, /memory has no tool that signs in\./);

  // The log has each change, and each one that failed, by its call and its plugin. The secret is nowhere.
  const lines = await logged();
  assert.ok(lines.includes("Changed from the command line: plugins.install memory@test-market"));
  assert.ok(lines.includes("Changed from the command line: plugins.configure memory@test-market"));
  assert.ok(lines.includes("Changed from the command line: plugins.update memory@test-market"));
  assert.ok(lines.includes("Tried from the command line: plugins.setEnabled memory (it failed)"));
  assert.equal(lines.some((line) => /Tried.*plugins\.install/.test(line)), false, "what the command refused by itself never reached the service");
  // The service itself takes no install and no update with no revision, also by the plain call that reaches the app's own.
  await assert.rejects(client.call("plugins.install", id, {}), /Give the revision of the plugin that was looked at/);
  await assert.rejects(client.call("call", "plugins.install", ["notes@test-market"]), /An install or an update names the revision that was looked at/);
  await assert.rejects(client.call("call", "plugins.update", [id, {}]), /names the revision that was looked at/);
  assert.deepEqual((await logged()).slice(-3), ["Tried from the command line: plugins.install memory@test-market (it failed)", "Tried from the command line: call plugins.install (it failed)", "Tried from the command line: call plugins.update (it failed)"]);
  // A first word with a character that hides or turns text is not written to the log.
  await assert.rejects(client.call("plugins.update", "me\u202emory", { revision: "0".repeat(64) }));
  assert.equal((await logged()).at(-1), "Tried from the command line: plugins.update (it failed)");
  assert.equal(everything().includes(SECRET), false);
});

test("a plugin that runs nothing installs with no question, a folder plugin is added switched off, and more bots for one that runs ask", { skip }, async (t) => {
  const { botkins, market, dir, write, client } = await setup(t);
  await botkins(["plugins", "add-marketplace", market]);
  const show = await botkins(["plugins", "show", "notes@test-market"]);
  assert.match(show.out, /Holds: 1 skill\.\nRuns nothing on this computer\./);
  // A word that is no plugin: the refusal says both things that it is not, and a real error is not hidden behind the id's form.
  assert.match((await botkins(["plugins", "show", "nothing-like-it"])).err, /No installed plugin is called nothing-like-it, and it is not the id of a plugin in a marketplace \(name@marketplace\)/);
  assert.match((await botkins(["plugins", "show", "gone@test-market"])).err, /Unknown plugin: gone@test-market/);
  // An id that starts with a dash is a word after "--": it reaches the service as it is, for each command that takes an id.
  for (const command of ["show", "install", "update", "enable"]) {
    const dashed = await botkins(["plugins", command, "--", "-x@test-market"]);
    assert.match(dashed.err, /Unknown plugin: -x@test-market|No installed plugin is called -x@test-market/, command);
    assert.doesNotMatch(dashed.err, /Unknown option|ambiguous/, command);
  }
  // No yes is needed. The revision that was read a moment before goes with it all the same.
  const installed = await botkins(["plugins", "install", "notes@test-market", "--json"]);
  assert.equal(installed.exit, 0, installed.err);
  assert.match(installed.json().revision, /^[a-f0-9]{64}$/);
  assert.equal((await botkins(["plugins", "enable", "notes"])).exit, 0, "and none to switch it on");

  // A folder of this computer: added switched off, so nothing of it runs, with all that it would run shown.
  const mine = join(dir, "mine");
  write(join(mine, "plugin.json"), { name: "mine", version: "0.1.0" });
  write(join(mine, "hooks", "hooks.json"), { hooks: { sessionStart: [{ hooks: [{ type: "command", bash: "sh ./start.sh" }] }] } });
  write(join(mine, ".mcp.json"), { mcpServers: { files: { command: "npx", args: ["-y", "@scope/pkg server"], cwd: "/srv/data", env: { TOKEN: "x" } } } });
  const added = await botkins(["plugins", "add-folder", mine]);
  assert.equal(added.exit, 0, added.err);
  assert.match(added.out, /\(installed, off\)\n[\s\S]*Runs on this computer, as the user that runs Botkins:\n {2}at sessionStart: sh \.\/start\.sh\n {2}the tool files: npx -y "@scope\/pkg server"\n {6}in the folder "\/srv\/data"\n {6}with the environment values TOKEN\n[\s\S]*Added, and switched off\. Switch it on with `botkins plugins enable -- mine@folder-[a-f0-9]{12}`\./);
  const { id, revision } = (await botkins(["plugins", "show", "mine", "--json"])).json();
  // Choosing bots while it is off needs no yes, and leaves it off.
  await client.call("bots.add", { name: "Nova" });
  const whileOff = await botkins(["plugins", "bots", "mine", "--bot", "Nova"]);
  assert.match(whileOff.out, /mine is for 1 bot\. It is off\./, whileOff.err);
  assert.equal((await client.call("plugins.get", id)).enabled, false);
  assert.equal((await botkins(["plugins", "enable", "mine"])).exit, 2, "switching it on asks");
  assert.match((await botkins(["plugins", "enable", "mine", "--yes", "--revision", revision])).out, /mine is on\./);
  // On, and it runs commands: more bots ask, as switching on does. Fewer do not.
  const wider = await botkins(["plugins", "bots", "mine", "--all"]);
  assert.equal(wider.exit, 2);
  assert.match(wider.err, /the tool files: npx -y "@scope\/pkg server"/);
  assert.equal((await botkins(["plugins", "bots", "mine", "--all", "--yes"])).exit, 2, "a yes alone");
  assert.deepEqual((await client.call("plugins.get", id)).bots.length, 1);
  assert.match((await botkins(["plugins", "bots", "mine", "--all", "--yes", "--revision", revision])).out, /mine is for every bot\./);
  assert.match((await botkins(["plugins", "bots", "mine", "--bot", "Nova"])).out, /mine is for 1 bot\./);
  // The same folder is not one for `skills add-folder`.
  const viaSkills = await botkins(["skills", "add-folder", mine]);
  assert.equal(viaSkills.exit, 1);
  assert.match(viaSkills.err, /This folder is a plugin, which can run commands on this computer\. It is not added as a folder of skills\.|Only folders in your home folder/);
  // A folder with a link inside, and a path that is not a full path, are refused.
  const linked = join(dir, "linked");
  write(join(linked, "plugin.json"), { name: "linked" });
  (await import("node:fs")).symlinkSync(mine, join(linked, "inside"));
  assert.match((await botkins(["plugins", "add-folder", linked])).err, /contains a symlink/);
  assert.equal((await botkins(["plugins", "add-folder", "relative/path"])).exit, 1);
});

test("text from a plugin is shown as text: a character that hides or turns it is written as its number, wherever it is printed", { skip }, async (t) => {
  const { botkins, dir, write, client } = await setup(t);
  const [turn, none, escape] = ["\u202e", "\u200b", "\u001b[2K"];
  const odd = join(dir, "odd");
  write(join(odd, "plugin.json"), { name: "odd" + turn + "name", version: "1.0.0", description: "It" + none + "hides" + escape, userConfig: { KEY: { title: "A" + turn + "label" } } });
  write(join(odd, "hooks.json"), { hooks: { sessionStart: [{ command: "echo " + turn + "dlrow", env: { V: "${KEY}" } }] } });
  write(join(odd, ".mcp.json"), { mcpServers: { ["to" + none + "ol"]: { command: "node", args: ["a" + escape + "b"], cwd: "/x" + turn }, web: { url: "https://example.test/" + turn + "mcp", headers: { ["X" + none]: "${KEY}" } } } });
  const added = await botkins(["plugins", "add-folder", odd]);
  assert.equal(added.exit, 0, added.err);
  const { id, revision } = (await client.call("plugins.list"))[0];
  const outputs = [added, await botkins(["plugins", "show", "--", id]), await botkins(["plugins", "enable", "--", id]), await botkins(["plugins", "enable", "--yes", "--revision=" + revision, "--", id]), await botkins(["plugins", "configure", "--", id], { input: ["v"], tty: true }), await botkins(["plugins", "bots", "--all", "--", id]), await botkins(["plugins", "sign-out", "--", id]), await botkins(["plugins", "list"])];
  // (A question at a terminal has the terminal's own cursor moves: those are not the plugin's.)
  for (const { out, err } of outputs) assert.equal(/[\u001b\u200b\u202e]/.test((out + err).replace(/\u001b\[\d+[GJ]/g, "")), false, out + err);
  assert.match(outputs[1].out, /at sessionStart: echo \\u\{202e\}dlrow/);
  assert.match(outputs[1].out, /the tool to\\u\{200b\}ol: node "a\\\\u\{1b\}\[2Kb"/);
  assert.match(outputs[4].err, /A\\u\{202e\}label goes to/);
});

test("sign-out forgets a plugin's sign-ins in whatever state the plugin is, and says what it did", { skip }, async (t) => {
  const { botkins, dir, write, running } = await setup(t);
  // A plugin with a tool that signs in, and a setting that it needs and does not have: its state is "needs-config".
  const signs = join(dir, "signs");
  write(join(signs, "plugin.json"), { name: "signs", version: "1.0.0", userConfig: { TENANT: { required: true } } });
  write(join(signs, ".mcp.json"), { mcpServers: { docs: { type: "http", url: "https://docs.example.test/mcp", oauth: true, headers: { "X-Tenant": "${TENANT}" } } } });
  assert.equal((await botkins(["plugins", "add-folder", signs])).exit, 0);
  const plugins = running.runtime.workspace.plugins;
  const [server] = plugins.knownOAuthServers(plugins.records[0]);
  assert.equal(plugins.list()[0].status, "needs-config");
  assert.match((await botkins(["plugins", "sign-out", "signs"])).out, /signs was not signed in\./);
  // A sign-in that it holds (as a phone or the window made it) is forgotten, though the plugin is not ready.
  plugins.oauth.write(server, { accessToken: "token-that-must-go", url: server.url });
  assert.equal(plugins.oauth.status(server).signedIn, true);
  const out = await botkins(["plugins", "sign-out", "signs"]);
  assert.match(out.out, /signs is signed out \(1 of its 1 tool that sign in was signed in\)\./);
  assert.equal(plugins.oauth.status(server).signedIn, false);
  assert.deepEqual((await botkins(["plugins", "sign-out", "signs", "--json"])).json(), { id: plugins.records[0].preview.id, name: "signs", tools: 1, signedOut: 0 });
});
