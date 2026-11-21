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
  write(join(memory, "hooks", "hooks.json"), { hooks: { userPromptSubmitted: [{ matcher: "*", hooks: [{ type: "command", bash: HOOK }] }] } });
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
  return { dir, write, market, memory, botkins, client, logged, everything };
}

test("a plugin that runs commands is looked at first, and its install names the revision that was looked at", { skip }, async (t) => {
  const { botkins, market, memory, write, client, logged, everything } = await setup(t);
  assert.equal((await botkins(["plugins", "add-marketplace", market])).exit, 0);
  const id = "memory@test-market";
  // What a person sees before deciding: what it holds, the command that it runs here, what it needs, and its revision.
  const show = await botkins(["plugins", "show", id]);
  assert.match(show.out, /^memory 1\.0\.0 {3}memory@test-market\nRemember things\nHolds: 1 tool, 1 hook\.\nRuns on this computer, as the user that runs Botkins:\n {2}at userPromptSubmitted: node "\$\{PLUGIN_ROOT\}\/recall\.mjs"\nReaches: https:\/\/example\.test\/mcp\nSettings: MEMORY_API_KEY \(needed\) \(secret\), REGION\n/);
  const seen = (await botkins(["plugins", "show", id, "--json"])).json();
  assert.match(seen.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(seen.runs, [{ what: "hook", when: "userPromptSubmitted", command: HOOK }]);

  // With no terminal: no install by the id alone, and none with a yes alone. Each time it says what it runs and what to do.
  for (const more of [[], ["--yes"], ["--revision", seen.revision]]) {
    const refused = await botkins(["plugins", "install", id, ...more]);
    assert.equal(refused.exit, 2, more.join(" "));
    assert.match(refused.err, /Runs on this computer, as the user that runs Botkins:\n {2}at userPromptSubmitted: /);
    assert.match(refused.err, /This plugin runs commands on this computer\. Look at it with `botkins plugins show memory@test-market`, then run this again with --yes --revision <its revision>\./);
  }
  assert.deepEqual((await botkins(["plugins", "list", "--json"])).json(), []);
  // A revision that is not the one of its source now: refused before anything is asked or written.
  const stale = await botkins(["plugins", "install", id, "--yes", "--revision", "0".repeat(64)]);
  assert.equal(stale.exit, 1);
  assert.match(stale.err, /This plugin changed after the revision that you looked at\. Look at it again/);
  // The source changes after it was looked at: the same.
  write(join(memory, "recall.mjs"), "console.log('changed')\n");
  assert.match((await botkins(["plugins", "install", id, "--yes", "--revision", seen.revision])).err, /changed after the revision that you looked at/);
  const now = (await botkins(["plugins", "show", id, "--json"])).json().revision;
  assert.notEqual(now, seen.revision);
  // With the revision of what is there now, and its secret setting from a file: installed.
  const installed = await botkins(["plugins", "install", id, "--yes", "--revision", now, "--settings", write(join(market, "..", "settings.json"), { MEMORY_API_KEY: SECRET })]);
  assert.equal(installed.exit, 0, installed.err);
  assert.match(installed.out, /^Installed memory\.\n$/);
  const [listed] = (await botkins(["plugins", "list", "--json"])).json();
  assert.deepEqual([listed.id, listed.revision, listed.enabled, listed.status, listed.config.map((field) => [field.key, field.set])], [id, now, true, "ready", [["MEMORY_API_KEY", true], ["REGION", false]]]);
  // With --json the block is on standard error all the same, and the answer says what runs.
  await botkins(["plugins", "uninstall", id, "--yes"]);
  const jsonned = await botkins(["plugins", "install", id, "--json", "--yes", "--revision", now]);
  assert.equal(jsonned.exit, 0, jsonned.err);
  assert.match(jsonned.err, /Runs on this computer, as the user that runs Botkins:\n {2}at userPromptSubmitted: /);
  assert.deepEqual([jsonned.json().revision, jsonned.json().runs], [now, [{ what: "hook", when: "userPromptSubmitted", command: HOOK }]]);
  assert.equal((await botkins(["plugins", "install", "other@test-market", "--json", "--yes"])).exit, 1, "a plugin that the marketplace does not have");
  // At a terminal the person is shown it and asked; a "no" installs nothing.
  await botkins(["plugins", "uninstall", id, "--yes"]);
  const no = await botkins(["plugins", "install", id], { input: "n\n", tty: true });
  assert.equal(no.exit, 1);
  assert.match(no.err, /Install it and let it run these on this computer\? \[y\/N\]/);
  assert.deepEqual((await botkins(["plugins", "list", "--json"])).json(), []);
  const yes = await botkins(["plugins", "install", id], { input: "y\n", tty: true });
  assert.equal(yes.exit, 0, yes.err);
  assert.match(yes.out, /Installed memory\. It needs settings before it works: MEMORY_API_KEY\. Give them with `botkins plugins configure memory@test-market`\./);

  // Its settings: by a file, or asked for at a terminal (the secret one is not shown). No answer has a value.
  assert.equal((await botkins(["plugins", "configure", "memory"])).exit, 2, "with no terminal the flag is named");
  const typed = await botkins(["plugins", "configure", "memory"], { input: [SECRET, "eu"], tty: true });
  assert.equal(typed.exit, 0, typed.err);
  assert.equal((typed.out + typed.err).includes(SECRET), false);
  assert.deepEqual((await botkins(["plugins", "show", "memory", "--json"])).json().config.map((field) => field.set), [true, true]);
  assert.equal((await botkins(["plugins", "configure", "memory", "--unset", "REGION"])).exit, 0);
  assert.match((await botkins(["plugins", "show", "memory"])).out, /Settings: MEMORY_API_KEY \(needed\) \(secret\) ✓, REGION\n/);

  // Off needs no question. On does, because of what it runs.
  assert.equal((await botkins(["plugins", "disable", id])).exit, 0);
  assert.equal((await botkins(["plugins", "enable", "memory"])).exit, 2);
  assert.match((await botkins(["plugins", "enable", "memory", "--yes"])).out, /memory is on\./);
  // An update is looked at the same way, and names the revision of the new source.
  assert.match((await botkins(["plugins", "update", "memory"])).out, /memory is up to date\./);
  write(join(memory, "recall.mjs"), "console.log('a newer one')\n");
  assert.match((await botkins(["plugins", "show", "memory"])).out, /Its source changed since it was installed\./);
  assert.equal((await botkins(["plugins", "update", "memory", "--yes"])).exit, 2);
  const newer = (await client.call("plugins.preview", id)).revision;
  assert.match((await botkins(["plugins", "update", "memory", "--yes", "--revision", newer])).out, /Updated memory\./);
  assert.equal((await botkins(["plugins", "list", "--json"])).json()[0].revision, newer);
  // Which bots have it, by their names.
  await client.call("bots.add", { name: "Nova" });
  await client.call("bots.add", { name: "Orbit" });
  assert.match((await botkins(["plugins", "bots", "memory", "--bot", "Nova"])).out, /memory is for 1 bot\./);
  assert.match((await botkins(["plugins", "bots", "memory", "--all"])).out, /memory is for every bot\./);
  assert.equal((await botkins(["plugins", "bots", "memory"])).exit, 2);
  assert.match((await botkins(["plugins", "bots", "memory", "--bot", "Nobody"])).err, /There is no bot called Nobody/);
  assert.match((await botkins(["plugins", "sign-out", "memory"])).out, /memory (is signed out|has no tool that signs in)\./);

  // The log has each change, and each one that failed, by its call and its plugin. The secret is nowhere.
  const lines = await logged();
  assert.ok(lines.includes("Changed from the command line: plugins.install memory@test-market"));
  assert.ok(lines.includes("Changed from the command line: plugins.configure memory@test-market"));
  assert.ok(lines.includes("Changed from the command line: plugins.update memory@test-market"));
  // What the command refused by itself never reached the service. What the service refused is in the log as tried.
  assert.deepEqual(lines.filter((line) => line.startsWith("Tried")), ["Tried from the command line: plugins.setBots memory (it failed)"]);
  assert.equal(lines.some((line) => /Tried.*plugins\.install/.test(line)), false);
  await assert.rejects(client.call("plugins.install", id, { revision: "0".repeat(64) }));
  assert.equal((await logged()).at(-1), "Tried from the command line: plugins.install memory@test-market (it failed)");
  assert.equal(everything().includes(SECRET), false);
});

test("a plugin that runs nothing installs with no question, and a folder plugin is added switched off", { skip }, async (t) => {
  const { botkins, market, dir, write } = await setup(t);
  await botkins(["plugins", "add-marketplace", market]);
  const show = await botkins(["plugins", "show", "notes@test-market"]);
  assert.match(show.out, /Holds: 1 skill\.\nRuns nothing on this computer\./);
  // No yes is needed. The revision that was read a moment before goes with it all the same.
  const installed = await botkins(["plugins", "install", "notes@test-market", "--json"]);
  assert.equal(installed.exit, 0, installed.err);
  assert.match(installed.json().revision, /^[a-f0-9]{64}$/);
  assert.equal((await botkins(["plugins", "enable", "notes"])).exit, 0, "and none to switch it on");

  // A folder of this computer: added switched off, so nothing of it runs, with what it would run shown.
  const mine = join(dir, "mine");
  write(join(mine, "plugin.json"), { name: "mine", version: "0.1.0" });
  write(join(mine, "hooks", "hooks.json"), { hooks: { sessionStart: [{ hooks: [{ type: "command", bash: "sh ./start.sh" }] }] } });
  const added = await botkins(["plugins", "add-folder", mine]);
  assert.equal(added.exit, 0, added.err);
  assert.match(added.out, /\(installed, off\)\n[\s\S]*Runs on this computer, as the user that runs Botkins:\n {2}at sessionStart: sh \.\/start\.sh\n[\s\S]*Added, and switched off\. Switch it on with `botkins plugins enable mine@folder-[a-f0-9]{12}`\./);
  assert.equal((await botkins(["plugins", "enable", "mine"])).exit, 2, "switching it on asks");
  assert.match((await botkins(["plugins", "enable", "mine", "--yes"])).out, /mine is on\./);
  // The same folder is not one for `skills add-folder`, which shows nothing before it links.
  const viaSkills = await botkins(["skills", "add-folder", mine]);
  assert.equal(viaSkills.exit, 1);
  assert.match(viaSkills.err, /This folder is a plugin, which can run commands on this computer\. It is not added as a folder of skills\. Add it with `botkins plugins add-folder`|Only folders in your home folder/);
});
