// The command line stays complete by a test, not by memory (desktop/desktop/terminal/coverage.mjs).
// Every call the app's window can make, and every call of the phone link, has a command or one
// reason from a short fixed list. Nothing is owed, and there is no hidden `call` to reach a call by name.
// A new call with neither an entry nor a reason fails here. So does a named command that no longer exists.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli/main.mjs";
import { argumentsOf, COMMANDS, describe, find } from "../cli/commands/index.mjs";
import { CHANGES, LINK, LOGS_ITSELF, READS, REASONS, thingForLog, WORKSPACE } from "../desktop/terminal/coverage.mjs";
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
/** A real service on a folder of its own. */
async function service(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-cover-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  return { paths, client: controlClient(paths.socket, { timeout: 40_000 }) };
}
/** A command by its words ("bots add"): the command itself, never a group. */
const command = (words) => {
  const found = find(words.split(" "));
  return found && found.path.join(" ") === words && typeof found.command.run === "function" ? found.command : null;
};
/** One entry of the table is exactly one of: a command that exists, or a reason from the list. */
function checkEntry(name, entry) {
  assert.equal(Object.keys(entry).length, 1, name + " has one of `command` or `reason` (nothing is owed)");
  if ("command" in entry) assert.ok(command(entry.command), name + " names the command `botkins " + entry.command + "`, which does not exist");
  else assert.ok("reason" in entry && Object.hasOwn(REASONS, entry.reason), name + " gives a reason that is not in the list: " + entry.reason);
}
const missing = (names, table) => names.filter((name) => !Object.hasOwn(table, name));
const gone = (names, table) => Object.keys(table).filter((name) => !names.includes(name));
const ADD = "Give it an entry in desktop/desktop/terminal/coverage.mjs: the command that does it, or one of the reasons there.";

test("every call the app's window can make has a command or a reason from the list", { skip }, async (t) => {
  const { client } = await service(t);
  const { workspace, control } = await client.call("methods");
  assert.ok(workspace.length > 200, "the service says what it can do");
  assert.deepEqual(missing(workspace, WORKSPACE), [], "These calls of the app have no entry. " + ADD);
  assert.deepEqual(gone(workspace, WORKSPACE), [], "These entries name calls that the app no longer has. Take them out.");
  for (const [name, entry] of Object.entries(WORKSPACE)) checkEntry(name, entry);
  // The service's own calls: each one either changes something, and then leaves a line in the log, or only reads.
  // (A sign-in's calls write their own line when a sign-in is done: LOGS_ITSELF, and test/terminal-signin.test.mjs holds them to it.)
  const known = [...Object.keys(CHANGES), ...READS, ...LOGS_ITSELF];
  assert.deepEqual(control.filter((name) => !known.includes(name)), [], "These calls of the service are in neither CHANGES nor READS (coverage.mjs). Say which: a change leaves a line in the log.");
  assert.deepEqual(known.filter((name) => !control.includes(name)), [], "CHANGES or READS name calls that the service no longer has.");
  assert.deepEqual(Object.keys(CHANGES).filter((name) => READS.includes(name)), []);
  assert.deepEqual(LOGS_ITSELF.filter((name) => name in CHANGES || READS.includes(name)), [], "a call is in one list only");
  // Nothing is owed: an entry says a command or a reason, and `call` is not a method of the service.
  assert.equal(control.includes("call"), false, "the hidden way to any call by name is gone");
  t.diagnostic("Covered by a command: " + Object.values({ ...WORKSPACE, ...LINK }).filter((entry) => "command" in entry).length + ". With a reason: " + Object.values({ ...WORKSPACE, ...LINK }).filter((entry) => "reason" in entry).length + ".");
});

test("every call of the phone link has a command or a reason from the list", () => {
  // The link's own calls, by the names a device makes them with (desktop/link/server.mjs).
  const source = readFileSync(new URL("../desktop/link/server.mjs", import.meta.url), "utf8");
  const names = [...new Set([...source.matchAll(/^\s*"(link\.[A-Za-z.]+)":\s/gm)].map((match) => match[1]))].sort();
  assert.ok(names.length > 50 && names.includes("link.team.get") && names.includes("link.devices.list"), "the link's calls were found");
  assert.deepEqual(missing(names, LINK), [], "These calls of the phone link have no entry. " + ADD);
  assert.deepEqual(gone(names, LINK), [], "These entries name calls that the phone link no longer has. Take them out.");
  for (const [name, entry] of Object.entries(LINK)) checkEntry(name, entry);
  // The fourth, "person", is for a call that reaches a secret which a caller of the socket cannot read, or sends one somewhere. The owner agreed to this on 2026-11-21: "nothing that reaches a saved secret runs from the command line, so unlocking a password manager and using a saved credential by reference stay in the window and on the phone."
  assert.deepEqual(Object.keys(REASONS), ["window", "window's own", "phone's own", "person"], "the reasons are a fixed list: a new one is a decision");
});

test("`botkins help --json` names every command with its usage, its arguments and its options", async () => {
  let out = "";
  const io = { stdout: { write: (text) => void (out += text) }, stderr: { write: () => {} }, env: {} };
  assert.equal(await main(["help", "--json"], io), 0);
  const all = JSON.parse(out);
  assert.deepEqual(Object.keys(all), ["botkins", "usage", "everyCommand", "exit", "areas"]);
  assert.match(all.botkins, /^\d+\.\d+\.\d+/);
  assert.deepEqual(all.exit.map((entry) => entry.code), [0, 1, 2, 3, 4]);
  assert.deepEqual(all.everyCommand.map((option) => option.name), ["--json", "--data-dir", "--socket"]);
  // Every command of the tree that is not hidden is there once, under its area, and nothing else is.
  const walk = (group, path) => Object.entries(group).filter(([, entry]) => !entry.hidden).flatMap(([name, entry]) => (entry.commands ? walk(entry.commands, [...path, name]) : [[...path, name].join(" ")]));
  const listed = all.areas.flatMap((area) => area.commands.map((entry) => entry.command));
  assert.deepEqual(listed, walk(COMMANDS, []));
  assert.equal(listed.includes("call"), false, "there is no command that reaches a call by name");
  assert.equal(find(["call"]), null);
  for (const area of all.areas) {
    assert.ok(area.summary, area.name);
    for (const entry of area.commands) {
      assert.deepEqual(Object.keys(entry).filter((key) => !["asks", "details"].includes(key)), ["command", "path", "summary", "usage", "arguments", "options"]);
      assert.equal(entry.path[0], area.name);
      assert.ok(entry.summary && entry.usage.startsWith("botkins " + entry.command), entry.command);
      // What the usage line says and what the command takes are the same options.
      for (const option of entry.options) {
        assert.ok(option.about, entry.command + " " + option.name + " says what it is for");
        assert.ok(entry.usage.includes(option.name) || (option.short && entry.usage.includes(option.short)), entry.command + ": its usage names " + option.name);
        assert.equal(option.takes === null || typeof option.takes === "string", true);
      }
    }
  }
  // Every command that the table names is one a program can find here.
  for (const entry of Object.values({ ...WORKSPACE, ...LINK })) if ("command" in entry) assert.ok(listed.includes(entry.command), entry.command);
  // One area or one command, by its words.
  out = "";
  assert.equal(await main(["help", "bots", "--json"], io), 0);
  assert.deepEqual(JSON.parse(out).areas.map((area) => [area.name, area.commands.map((entry) => entry.command)]), [["bots", ["bots list", "bots add", "bots edit", "bots remove", "bots tools", "bots skills", "bots access", "bots menu", "bots duplicate", "bots order", "bots primary", "bots flags", "bots proactive", "bots alert", "bots memory", "bots sections list", "bots sections add", "bots sections rename", "bots sections move", "bots sections remove", "bots import"]]]);
  out = "";
  assert.equal(await main(["help", "bots", "edit", "--json"], io), 0);
  const [edit] = JSON.parse(out).areas[0].commands;
  assert.deepEqual(edit.arguments, [{ name: "bot", required: true }]);
  assert.deepEqual(edit.options.find((option) => option.name === "--instructions-file"), { name: "--instructions-file", takes: "path", about: edit.options.find((option) => option.name === "--instructions-file").about });
  // A command that asks a person first says which flag answers it, for a caller with no terminal.
  assert.deepEqual(all.areas.flatMap((area) => area.commands).filter((entry) => entry.asks).map((entry) => entry.command + " " + entry.asks).sort(), ["apps remove --yes", "artifacts read --yes", "bots import --yes", "bots memory --yes", "bots proactive --yes", "bots remove --yes", "bots sections remove --yes", "cache clear --yes", "cards act --yes", "chat --yes", "chats delete --yes", "chats project --yes", "chats sections delete --yes", "credentials edit --yes", "credentials remove --yes", "devices remove --yes", "jobs remove --yes", "jobs start --yes", "mac-tools set --yes", "marketplace install --yes --revision", "node convert --yes", "node disconnect --yes", "node remote --yes", "node revoke --yes", "panels new --yes", "panels remove --yes", "panels remove-note --yes", "panels routine remove --yes", "panels routine resume --yes", "panels routine set --yes", "password-managers disconnect --yes", "password-managers install --yes", "pi enable --yes --revision", "pi install --yes --revision", "pi remove --yes", "plugins bots --yes --revision", "plugins configure --settings --yes --revision", "plugins enable --yes --revision", "plugins install --yes --revision", "plugins sign-out --yes", "plugins uninstall --yes", "plugins update --yes --revision", "preferences set --yes", "profile delete --yes", "profile devices revoke --yes", "profile disconnect --yes", "profile opt-out --yes", "profile sign-out --yes", "projects chat --yes", "projects commit --yes", "projects remove --yes", "providers disconnect --yes", "providers install --yes", "providers login --yes", "providers logout --yes", "providers set --yes", "relay reset --yes", "routines add --yes", "routines duplicate --yes", "routines edit --yes", "routines remove --yes", "routines schedule --yes", "service uninstall --yes", "sharing link --yes", "sharing links --yes", "sharing set --yes", "skills add-script --yes --revision", "skills install --yes", "skills remove --yes", "skills upload --yes", "spaces remove --yes", "tasks add --yes", "tasks edit --yes", "tasks move --yes", "tasks remove --yes", "tasks start --yes", "team chat invite --yes", "team groups remove --yes", "team groups save --yes", "team invites revoke --yes", "team members move --yes", "team members remove --yes", "team requests approve --yes", "team requests deny --yes", "team roles remove --yes", "team roles save --yes", "templates export --yes", "templates import --yes", "templates remove --yes", "templates use --yes", "todos remove --yes", "tools add --yes", "tools connect --yes", "tools edit --yes", "tools enable --yes", "tools import --yes", "tools remove --yes", "tools sign-out --yes", "tools test --yes", "usage export --yes", "vault remove --yes", "vault reset --yes --erase-all-saved-secrets", "voice key --yes", "voice set --yes", "wiki export --yes", "wiki remove --yes", "wiki restore --yes", "workflows remove --yes"]);
  out = "";
  const asked = { ...io, stdin: { isTTY: false }, stderr: { write: (text) => void (out += text) }, client: { call: async () => ({ id: "nova", name: "Nova" }) } };
  assert.equal(await main(["bots", "remove", "Nova"], asked), 2);
  assert.match(out, /This needs a yes\. Run it again with --yes\./);
  // How the words after a command are read from its usage line.
  assert.deepEqual(argumentsOf("botkins providers services <provider> [<search>]", ["providers", "services"]), [{ name: "provider", required: true }, { name: "search", required: false }]);
  assert.deepEqual(argumentsOf("botkins chat <bot> [-m <message>] [--chat <id>]", ["chat"]), [{ name: "bot", required: true }]);
  assert.deepEqual(argumentsOf("botkins example <name> [<more word>…]", ["example"]), [{ name: "name", required: true }, { name: "more word", required: false, many: true }]);
  assert.deepEqual(argumentsOf("botkins service install [--system | --user] [--run-as <user>] [--allow-path <dir>]… [--no-start]", ["service", "install"]), []);
  assert.deepEqual(describe("1.2.3").botkins, "1.2.3");
});

test("a change made through the socket leaves a line in the log: which call, which thing, never a value", { skip }, async (t) => {
  const { client } = await service(t);
  const lines = async () => (await client.call("logs.read", { tail: 200 })).entries.map((entry) => entry.text).filter((text) => text.includes("Changed from the command line"));
  // Reading leaves none.
  await client.call("status");
  await client.call("bots.list");
  await client.call("config.get");
  assert.deepEqual(await lines(), []);
  // A change names its call and the thing, as the person named it.
  await client.call("bots.add", { name: "Nova", instructions: "SECRET-INSTRUCTIONS" });
  await client.call("bots.add", { name: "Orbit" });
  await client.call("bots.edit", "Nova", { role: "SECRET-ROLE" });
  await client.call("config.set", "name", "SECRET-NAME");
  await client.call("preferences.set", "appearance.theme", "dark");
  await client.call("bots.remove", "Nova");
  const said = await lines();
  assert.deepEqual(said.map((text) => text.slice(text.indexOf("Changed"))), [
    "Changed from the command line: bots.add Nova",
    "Changed from the command line: bots.add Orbit",
    "Changed from the command line: bots.edit Nova",
    "Changed from the command line: config.set name",
    "Changed from the command line: preferences.set appearance.theme",
    "Changed from the command line: bots.remove Nova",
  ]);
  for (const secret of ["SECRET", "dark"]) assert.equal(said.join("\n").includes(secret), false, secret);
  // A change that failed changed nothing, and says nothing.
  await assert.rejects(client.call("bots.remove", "Nobody"));
  assert.equal((await lines()).length, 6);
  // What can be written in a log as the name of a thing: one short line.
  assert.deepEqual(["pip", "Sam's iPhone", "", "two\nlines", "x".repeat(81), 7, { id: "pip" }, null].map(thingForLog), ["pip", "Sam's iPhone", null, null, null, null, null, null]);
  // A name with an emoji or a joiner is a name: a flag, a family (U+200D), a heart (U+FE0F), Persian text (U+200C). One that turns text around, or has a control character, is left out.
  const named = ["Flag \u{1f1f8}\u{1f1ea}", "Family \u{1f469}\u200d\u{1f469}\u200d\u{1f467}", "Heart \u2764\ufe0f", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645"];
  assert.deepEqual(named.map(thingForLog), named);
  assert.deepEqual(["Nova\u202e", "Nova\u001b[2J", "Nova\u0085", "Nova\u2066"].map(thingForLog), [null, null, null, null]);
});
