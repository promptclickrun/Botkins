// Credentials, the vault, password managers and the rest of a provider from the command line
// (cli/commands/credentials.mjs), against a real service. What these hold to: no secret value is
// ever printed, logged or answered (each test looks for each value it used in the log file, in both
// outputs of the command, in --json output and in the workspace's file); a new value comes from a
// hidden question or standard input and never from the command line; what cannot be undone asks, and
// with no terminal names its flag; a reference to a saved credential is refused; a change leaves a
// line in the log with a name and no value; a password manager's items and master password are not
// reachable from here.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Every value that a test gives. None is ever allowed to show anywhere.
const PIPED = "sk-PIPED-value-that-must-not-show";
const TYPED = "sk-TYPED-value-that-must-not-show";
const NEWER = "sk-NEWER-value-that-must-not-show";
const KEY = "sk-KEY-of-a-tool-that-must-not-show";
const EXTRA = "sk-ON-THE-LINE-that-must-not-show";
const ALL = [PIPED, TYPED, NEWER, KEY, EXTRA];

let world;
before(async () => {
  if (skip) return;
  const dir = mkdtempSync(join(tmpdir(), "bk-credentials-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  // One provider that is not real: nothing starts a tool of the person's.
  writeFileSync(paths.config, JSON.stringify({ providers: { only: ["grok"] }, link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  /** Runs a command against the service: `botkins(argv, { input, tty })`. */
  const botkins = async (argv, { input = "", tty = false } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    seen.push(out, err);
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  // Everything that any command printed, to be searched for a value at the end of each test.
  const seen = [];
  const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => /(Changed|Tried) from the command line/.test(text)).map((text) => text.slice(text.search(/(Changed|Tried) from/)).replace("Changed from the command line: ", ""));
  const store = () => running.runtime.link.credentials;
  /** Every place that could hold a value in the clear: the log, the workspace's file, the stores' files, and what the commands printed. */
  const places = () => [readFileSync(paths.logFile, "utf8"), readFileSync(join(paths.dataDir, "workspace.json"), "utf8"), readFileSync(store().vault.file, "utf8"), ...(existsSync(running.runtime.workspace.vault.file) ? [readFileSync(running.runtime.workspace.vault.file, "utf8")] : []), ...seen];
  const none = (message = "") => {
    for (const place of places()) for (const value of ALL) assert.equal(place.includes(value), false, "a value shows " + message + ": " + place.slice(Math.max(0, place.indexOf(value) - 40), place.indexOf(value) + 60));
  };
  world = { dir, paths, running, client, botkins, changes, store, none };
});
after(async () => {
  if (!world) return;
  await world.running.stop("the test ended");
  rmSync(world.dir, { recursive: true, force: true });
});

test("a credential is saved from standard input or a hidden question, and its value is never shown", { skip }, async () => {
  const { botkins, changes, client, store, none } = world;
  // With nothing to read, no value is saved and the sentence says where a value comes from.
  const nothing = await botkins(["credentials", "save", "GitHub token"]);
  assert.equal(nothing.exit, 2);
  assert.match(nothing.err, /No value was given\. Type it at the question, or give it on standard input\. A value is never a word of the command line/);
  // A value as a word of the command line is turned away, and the word is not repeated.
  const word = await botkins(["credentials", "save", "GitHub token", EXTRA]);
  assert.equal(word.exit, 2);
  assert.match(word.err, /Give the credential a name, as one word or in quotes\./);
  const option = await botkins(["credentials", "save", "GitHub token", "--value", EXTRA]);
  assert.equal(option.exit, 2, "there is no --value option on save");
  assert.deepEqual((await botkins(["credentials", "list", "--json"])).json(), { locked: false, entries: [] });
  assert.match((await botkins(["credentials", "list"])).out, /No credential is saved\. Add one with `botkins credentials save <name>`\./);
  assert.equal((await botkins(["credentials", "save", "x", "--kind", "password"], { input: PIPED })).exit, 2, "a kind that is not one");

  // From standard input.
  const piped = await botkins(["credentials", "save", "GitHub token", "--website", "github.com", "--username", "octo-user", "--notes", "rotate in spring", "--json"], { input: PIPED + "\n" });
  assert.equal(piped.exit, 0, piped.err);
  const first = piped.json();
  assert.deepEqual(Object.keys(first).sort(), ["createdAt", "id", "kind", "name", "source", "updatedAt", "website"]);
  assert.deepEqual([first.name, first.kind, first.source, first.website], ["GitHub token", "api-key", "vault", "github.com"]);
  // From a hidden question at a terminal.
  const typed = await botkins(["credentials", "save", "Work login", "--kind", "login"], { input: TYPED + "\n", tty: true });
  assert.equal(typed.exit, 0, typed.err);
  assert.match(typed.out, /^Saved Work login \(cred-[\w-]+\)\. Its value is kept sealed and is never shown\.$/m);
  assert.match(typed.err, /Value for Work login \(not shown\): /);
  // A name that is taken is refused before the value is asked for.
  const again = await botkins(["credentials", "save", "github TOKEN"], { input: PIPED });
  assert.equal(again.exit, 2);
  assert.match(again.err, /A saved credential is called github TOKEN already\. Give it a new value with `botkins credentials edit`/);

  // The list has names, kinds and where each is read from: no value, no user name, no note.
  const text = (await botkins(["credentials", "list"])).out;
  assert.match(text, /^NAME +KIND +KEPT IN +WEBSITE +UPDATED +ID\n/);
  assert.match(text, /GitHub token +api-key +Botkins +github\.com/);
  assert.match(text, /Work login +login +Botkins/);
  const listed = await botkins(["credentials", "list", "--json"]);
  assert.deepEqual(listed.json().entries.map((entry) => entry.name), ["GitHub token", "Work login"]);
  for (const out of [text, listed.out]) for (const hidden of ["octo-user", "rotate in spring"]) assert.equal(out.includes(hidden), false, hidden + " is not in a list");
  // What the service itself answers is the same: no call of the area holds a value.
  assert.equal(JSON.stringify(await client.call("credentials.list")).includes("octo-user"), false);
  // The value is in the store, sealed, and the commands never read it out.
  assert.equal(await store().read(first.id), PIPED);
  assert.equal(readFileSync(store().vault.file, "utf8").includes(PIPED), false, "the store's file is sealed");

  // A check reads a linked field through the password manager's tool, so it is not for the socket: the call and the command are gone.
  await assert.rejects(client.call("credentials.check", first.id), { code: "UNKNOWN_METHOD" });
  assert.equal((await botkins(["credentials", "check", "GitHub token"])).exit, 2, "there is no `credentials check`");

  // A name that two have (made by the phone link's own save, which does not mind) is refused with its ids, before anything changes.
  const twin = await store().save({ name: "Work login", value: "not-one-of-ours-1234" });
  await assert.rejects(client.call("credentials.edit", "work login", { value: "x" }), /More than one saved credential is called work login\. Use its id \(see `botkins credentials list`\)\./);
  store().remove(twin);

  // A change from here is a new value and nothing else. Replacing a value cannot be undone, so it asks first; with no terminal it needs --yes,
  // and nothing is read or changed without it.
  const overwrite = await botkins(["credentials", "edit", "GitHub token"], { input: NEWER });
  assert.equal(overwrite.exit, 2);
  assert.match(overwrite.err, /This needs a yes\. Run it again with --yes\./);
  const kept = await botkins(["credentials", "edit", "GitHub token"], { input: "n\n", tty: true });
  assert.equal(kept.exit, 1);
  assert.match(kept.err, /Replace the value of GitHub token\? The old value is lost and cannot be got back\. \[y\/N\] /);
  assert.equal(await store().read(first.id), PIPED, "the value is as it was");
  const swapped = await botkins(["credentials", "edit", "GitHub token", "--yes", "--json"], { input: NEWER });
  assert.equal(swapped.exit, 0, swapped.err);
  assert.equal(await store().read(first.id), NEWER, "the value changed");
  assert.equal(swapped.json().name, "GitHub token");
  // The same from a hidden question at a terminal.
  const asked2 = await botkins(["credentials", "edit", "Work login", "--yes"], { input: TYPED + "\n", tty: true });
  assert.equal(asked2.exit, 0, asked2.err);
  assert.match(asked2.err, /New value for Work login \(not shown\): /);
  assert.equal(await store().read((await client.call("credentials.list")).entries.find((one) => one.name === "Work login").id), TYPED);
  assert.equal((await botkins(["credentials", "edit", "GitHub token", "--yes"])).exit, 2, "no value to read");
  assert.equal((await botkins(["credentials", "edit", "nobody", "--yes"], { input: NEWER })).exit, 1);
  assert.equal((await botkins(["credentials", "edit"])).exit, 2);

  // Removing shows what goes and asks first; with no terminal it needs --yes.
  const asked = await botkins(["credentials", "remove", "Work login"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.match(asked.err, /^This removes the saved credential Work login \(login\)\.\n {2}Kept in: Botkins, sealed on this computer\nWhat uses it can no longer read it\./);
  assert.equal((await botkins(["credentials", "list", "--json"])).json().entries.length, 2);
  const declined = await botkins(["credentials", "remove", "Work login"], { input: "n\n", tty: true });
  assert.equal(declined.exit, 1);
  assert.match(declined.err, /Remove the saved credential Work login\? \[y\/N\] /);
  assert.match(declined.err, /Not removed\./);
  // With --yes and with --json what goes is still shown, on standard error, and the name and the place are in it (never a value).
  const removed = await botkins(["credentials", "remove", "work LOGIN", "--yes", "--json"]);
  assert.equal(removed.exit, 0, removed.err);
  assert.deepEqual(Object.keys(removed.json()).sort(), ["name", "removed"]);
  assert.match(removed.err, /^This removes the saved credential Work login \(login\)\.\n {2}Kept in: Botkins, sealed on this computer\n/);
  assert.equal(removed.err.includes(TYPED), false);
  const gone = await botkins(["credentials", "remove", "Work login", "--yes"]);
  assert.equal(gone.exit, 1);
  assert.match(gone.err, /There is no saved credential called Work login\. See `botkins credentials list`\./);
  assert.deepEqual((await botkins(["credentials", "list", "--json"])).json().entries.map((one) => one.name), ["GitHub token"]);

  // Each change is in the log by its call and a name. No value is, and a refused change does not say that it was made.
  // (A refusal that the command makes before it calls the service, such as a name that is taken, leaves no line: nothing was tried.)
  assert.deepEqual((await changes()).filter((line) => line.includes("credentials.")), [
    "credentials.save GitHub token",
    "credentials.save Work login",
    "Tried from the command line: credentials.edit work login (it failed)",
    "credentials.edit GitHub token",
    "credentials.edit Work login",
    "Tried from the command line: credentials.edit nobody (it failed)",
    "credentials.remove Work login",
  ]);
  none("after saving, changing and removing");
});

test("no call of the area takes a reference to a saved credential, or a value that is not text", { skip }, async () => {
  const { client, store, none } = world;
  const [{ id }] = (await client.call("credentials.list")).entries;
  const refused = /A saved credential is chosen in the app's window or on a paired phone\. From the command line, give the value itself\./;
  await assert.rejects(client.call("credentials.save", { name: "Copy", value: { $credential: id } }), refused);
  await assert.rejects(client.call("credentials.save", { name: "Copy", value: "x-12345", notes: { deep: [{ $credential: id }] } }), refused);
  await assert.rejects(client.call("credentials.edit", id, { value: { $credential: id, prefix: "Bearer " } }), refused);
  await assert.rejects(client.call("providers.install", "grok", { command: { $credential: id } }), refused);
  // A value that is not text is refused on its own account too.
  await assert.rejects(client.call("credentials.save", { name: "Copy", value: 12345 }), /Give the value to save, as text\./);
  await assert.rejects(client.call("credentials.save", { name: "Copy", value: "" }), /Give the value to save, as text\./);
  await assert.rejects(client.call("credentials.edit", id, { value: ["x"] }), /Give the new value as text\./);
  assert.equal(store().list().some((entry) => entry.name === "Copy"), false, "nothing was saved");
  none("in a refused call");
});

test("the vault is listed without values, an entry is removed after a question, and a reset needs the flag that names what is lost", { skip }, async () => {
  const { botkins, changes, client, running, paths, none } = world;
  // A tool's key goes into the vault.
  const added = await botkins(["tools", "add", "files", "--command", "node", "--env", "API_KEY", "--yes", "--secrets", "-"], { input: JSON.stringify({ env: { API_KEY: KEY } }) });
  assert.equal(added.exit, 0, added.err);
  const text = await botkins(["vault", "list"]);
  assert.match(text.out, /^Protection: the key is in a file in the data folder\.\n\n/);
  assert.match(text.out, /NAME +KIND +USED BY +UPDATED +ID\n.*files.*API_KEY|NAME +KIND +USED BY +UPDATED +ID\n.*files/s);
  const listed = (await botkins(["vault", "list", "--json"])).json();
  assert.deepEqual([listed.protection, listed.locked, listed.entries.length], ["file", false, 1]);
  assert.deepEqual(Object.keys(listed.entries[0]).sort(), ["createdAt", "id", "kind", "name", "updatedAt", "usedBy"]);
  assert.equal(listed.entries[0].usedBy, "files");
  assert.equal(JSON.stringify(listed).includes(KEY), false);

  // Removing asks first.
  const entry = listed.entries[0];
  const asked = await botkins(["vault", "remove", entry.name]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.match(asked.err, new RegExp("^This removes " + entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\(" + entry.kind + "\\) from the vault, where files uses it\\.\nWhat uses it stops working until you enter it again\\."));
  assert.equal((await botkins(["vault", "list", "--json"])).json().entries.length, 1);
  const nothing = await botkins(["vault", "remove", "nothing like this", "--yes"]);
  assert.equal(nothing.exit, 1);
  assert.match(nothing.err, /There is no vault entry called nothing like this\. See `botkins vault list`\./);
  const declined = await botkins(["vault", "remove", entry.name], { input: "n\n", tty: true });
  assert.equal(declined.exit, 1);
  assert.match(declined.err, /Remove .* from the vault\? \[y\/N\] /);
  assert.equal((await botkins(["vault", "list", "--json"])).json().entries.length, 1, "a no removes nothing");
  // With --yes and --json, what goes is still shown, on standard error.
  const removed = await botkins(["vault", "remove", entry.id, "--yes", "--json"]);
  assert.deepEqual(removed.json(), { removed: entry.id, name: entry.name });
  assert.match(removed.err, /^This removes .* from the vault, where files uses it\./);
  assert.equal((await botkins(["vault", "list", "--json"])).json().entries.length, 0);
  assert.match((await botkins(["vault", "list"])).out, /The vault is empty\./);

  // A vault that opens needs no reset: the question is not even asked.
  const needless = await botkins(["vault", "reset", "--yes", "--erase-all-saved-secrets"]);
  assert.equal(needless.exit, 1);
  assert.match(needless.err, /The vault opens on this computer, so it does not need a reset\. Nothing was changed\./);
  // The call needs the mark of a caller that got a yes, and then the app's own refusal is the answer.
  await assert.rejects(client.call("credentials.vaultReset"), { code: "NEEDS_YES" });
  // It needs both words, as the command does: one of them alone is refused with a sentence that names both.
  for (const one of [{ agreed: true }, { eraseAllSavedSecrets: true }, { agreed: true, eraseAllSavedSecrets: false }]) await assert.rejects(client.call("credentials.vaultReset", one), { code: "NEEDS_YES", message: /`agreed: true` and `eraseAllSavedSecrets: true`/ });
  await assert.rejects(client.call("credentials.vaultReset", { agreed: true, eraseAllSavedSecrets: true }), /The vault doesn't need resetting\./);

  // A vault that this computer cannot open (the state that a key it lacks leaves).
  await botkins(["tools", "add", "second", "--command", "node", "--env", "TOKEN", "--yes", "--secrets", "-"], { input: JSON.stringify({ env: { TOKEN: KEY } }) });
  const vault = running.runtime.workspace.vault;
  Object.assign(vault, { locked: true, reason: "key" });
  const locked = await botkins(["vault", "list"]);
  assert.match(locked.out, /This computer cannot open the vault\. Its key is not available on this computer\. Nothing in it can be read or removed\. `botkins vault reset` starts an empty one\./);
  assert.equal((await botkins(["vault", "list", "--json"])).json().reason, "key");
  // With no terminal: no flag is a refusal that names both; --yes alone is one too; the named flag alone is not a yes.
  const none1 = await botkins(["vault", "reset"]);
  assert.equal(none1.exit, 2);
  // The block names what goes: every key and sign-in, with how many of each kind (they are listed without opening the vault).
  assert.match(none1.err, /This computer cannot open the vault\. Its key is not available on this computer\. If you reset it, every key and sign-in that it holds \(1 now: 1 \w[\w-]*\) is lost to Botkins, and each one has to be entered again\. The old file is set aside and not deleted\. Saved credentials \(`botkins credentials`\) are kept apart and stay\./);
  assert.match(none1.err, /This needs a yes, and a flag that names what is lost\. Run it again with --yes --erase-all-saved-secrets\./);
  const yesOnly = await botkins(["vault", "reset", "--yes"]);
  assert.equal(yesOnly.exit, 2);
  assert.match(yesOnly.err, /--yes is not enough to reset the vault\. It loses every key and sign-in in it\. Run it again with --yes --erase-all-saved-secrets\./);
  assert.equal((await botkins(["vault", "reset", "--erase-all-saved-secrets"])).exit, 2);
  assert.equal(vault.locked, true, "nothing was reset");
  // At a terminal the sentence is shown and the answer decides.
  const no = await botkins(["vault", "reset"], { input: "n\n", tty: true });
  assert.equal(no.exit, 1);
  assert.match(no.err, /Reset the vault and lose every key and sign-in in it\? \[y\/N\] /);
  assert.match(no.err, /The vault is not reset\./);
  assert.equal(vault.locked, true);
  // Both flags: the vault is set aside, not deleted, and a new one is empty.
  const reset = await botkins(["vault", "reset", "--yes", "--erase-all-saved-secrets", "--json"]);
  assert.equal(reset.exit, 0, reset.err);
  assert.deepEqual(reset.json(), { reset: true });
  assert.match(reset.err, /If you reset it, every key and sign-in that it holds/, "what is lost is said even with --json");
  assert.equal(vault.locked, false);
  assert.equal(readdirSync(paths.dataDir).filter((name) => /^vault\.unreadable-\d+\.json$/.test(name)).length, 1, "the old file is kept");
  assert.equal((await botkins(["vault", "list", "--json"])).json().entries.length, 0);

  const lines = (await changes()).filter((line) => /credentials\.vault/.test(line));
  assert.deepEqual(lines, [
    "credentials.vaultRemove " + entry.name,
    ...Array(5).fill("Tried from the command line: credentials.vaultReset (it failed)"),
    "credentials.vaultReset the vault was reset",
  ]);
  none("after the vault's changes");
});

test("a password manager is listed and locked; its items and master password are not reachable from here", { skip }, async () => {
  const { botkins, changes, client, none } = world;
  const listed = (await botkins(["password-managers", "list", "--json"])).json();
  assert.deepEqual(listed.map((entry) => [entry.id, entry.state]), [["onepassword", "missing"], ["bitwarden", "missing"], ["protonpass", "missing"]]);
  for (const entry of listed) assert.deepEqual(Object.keys(entry).filter((key) => !["id", "name", "state", "message", "install", "canUnlock", "version", "account"].includes(key)), []);
  const text = (await botkins(["password-managers", "list"])).out;
  assert.match(text, /^MANAGER +STATE +VERSION +ACCOUNT +NOTE\n/);
  assert.match(text, /Bitwarden +not installed +- +- +Its command-line tool is not installed\./);
  assert.match(text, /Bitwarden: install its tool from https:\/\/bitwarden\.com\/help\/cli\//);
  assert.equal((await botkins(["password-managers", "list", "--refresh"])).exit, 0);
  // Locking by name or by id. A manager that cannot be locked from here says where to do it.
  const locked = await botkins(["password-managers", "lock", "bitwarden"]);
  assert.equal(locked.exit, 0, locked.err);
  assert.match(locked.out, /^Bitwarden is not installed\.\n$/);
  assert.equal((await botkins(["password-managers", "lock", "Proton Pass"])).exit, 1);
  const onepassword = await botkins(["password-managers", "lock", "onepassword"]);
  assert.equal(onepassword.exit, 1);
  assert.match(onepassword.err, /Lock 1Password on your computer\./);
  const nobody = await botkins(["password-managers", "lock", "keepass"]);
  assert.equal(nobody.exit, 1);
  assert.match(nobody.err, /There is no password manager called keepass\. See `botkins password-managers list`\./);
  assert.deepEqual((await changes()).filter((line) => line.includes("managerLock")), [
    "credentials.managerLock bitwarden",
    "Tried from the command line: credentials.managerLock Proton Pass (it failed)",
    "Tried from the command line: credentials.managerLock onepassword (it failed)",
    "Tried from the command line: credentials.managerLock keepass (it failed)",
  ]);
  // Not built: unlocking, the vaults, items and fields of a manager, and linking a field. (Rule 10 of the part's brief.)
  for (const word of ["unlock", "vaults", "items", "item", "link"]) {
    const missing = await botkins(["password-managers", word, "bitwarden"]);
    assert.equal(missing.exit, 2, word);
    assert.match(missing.err, /`botkins password-managers` has no command/);
  }
  const { control } = await client.call("methods");
  assert.deepEqual(control.filter((name) => /unlock|manager|vaults|items|link/i.test(name) && name.startsWith("credentials.")).sort(), ["credentials.managerLock", "credentials.managers"]);
  none("in the password managers");
});

test("a provider's plan and limits are listed with nothing of the account", { skip }, async (t) => {
  const { botkins, client, running, none } = world;
  const registry = running.runtime.providers;
  const grok = registry.require("grok");
  const statuses = registry.statuses;
  const usage = grok.usage;
  registry.statuses = async () => [{ id: "grok", name: "Grok", enabled: true, connected: true, installed: true }];
  grok.usage = async () => ({ plan: "Grok Plus", account: "subscription", limits: [{ id: "weekly", label: "Weekly", percentRemaining: 40, resetAt: Date.now() + 3 * 86_400_000, window: "week" }, { id: "chat", label: "Chat", unlimited: true }], credits: { label: "Credits", amount: 12, unit: "credits" }, source: "Grok", email: "someone@example.com", token: "sk-LEAK" });
  t.after(() => {
    registry.statuses = statuses;
    grok.usage = usage;
  });
  const text = await botkins(["providers", "usage", "--refresh"]);
  assert.equal(text.exit, 0, text.err);
  assert.match(text.out, /^Grok: Grok Plus\n {2}Weekly {2}40% left, starts again in 3 days\n {2}Chat {4}unlimited\n {2}Credits: 12 credits\n$/);
  const json = (await botkins(["providers", "usage", "grok", "--json"])).json();
  assert.deepEqual(json.map((entry) => [entry.provider, entry.name, entry.plan, entry.limits.map((limit) => limit.id)]), [["grok", "Grok", "Grok Plus", ["weekly", "chat"]]]);
  assert.equal(JSON.stringify(json).includes("someone@example.com") || JSON.stringify(json).includes("sk-LEAK"), false);
  // A provider by its name, and one that is not there.
  assert.equal((await botkins(["providers", "usage", "GROK"])).exit, 0);
  const nobody = await botkins(["providers", "usage", "nobody"]);
  assert.equal(nobody.exit, 1);
  assert.match(nobody.err, /There is no model provider called nobody\. See `botkins providers list`\./);
  assert.equal((await botkins(["providers", "usage", "a", "b"])).exit, 2);
  // Nothing signed in: nothing to show.
  registry.statuses = async () => [];
  assert.match((await botkins(["providers", "usage"])).out, /No provider is switched on and signed in, so there is no plan to show\./);
  assert.deepEqual((await botkins(["providers", "usage", "--json"])).json(), []);
  assert.equal(JSON.stringify(await client.call("providers.usage", {})), "[]");
  none("in usage");
});

test("a provider's tool is installed with the command it names: shown first, a yes, and no other command", { skip }, async (t) => {
  const { botkins, changes, client, dir, running, none } = world;
  const registry = running.runtime.providers;
  const status = registry.status;
  const marker = join(dir, "installed");
  let install = { url: "https://example.com/guide", command: "printf 'Downloading Fake CLI\\n'; touch " + JSON.stringify(marker) + "; printf 'Installed\\n'" };
  registry.status = async (id) => (id !== "grok" ? status.call(registry, id) : existsSync(marker) ? { id, installed: true, version: "2.0.0", connected: false } : { id, installed: false, connected: false, install });
  t.after(() => void (registry.status = status));

  // With no terminal: what would run is shown, the question needs --yes, and nothing runs.
  const asked = await botkins(["providers", "install", "grok"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This runs a command in a shell on this computer, as the user that runs Botkins, to install .*:\n {2}printf 'Downloading Fake CLI\\n'; touch .*installed.*; printf 'Installed\\n'\nThe provider's guide: https:\/\/example\.com\/guide\n/);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal(existsSync(marker), false, "nothing ran");
  // A person at a terminal can say no.
  const declined = await botkins(["providers", "install", "grok"], { input: "n\n", tty: true });
  assert.equal(declined.exit, 1);
  assert.match(declined.err, /Let Botkins run it\? \[y\/N\] /);
  assert.match(declined.err, /Not installed\./);
  assert.equal(existsSync(marker), false);
  // With the yes, it runs and what it prints is shown as it comes.
  const done = await botkins(["providers", "install", "grok", "--yes"]);
  assert.equal(done.exit, 0, done.err);
  assert.match(done.err, /This runs a command in a shell on this computer/, "the command is shown with --yes too");
  assert.match(done.out, /Downloading Fake CLI\n.*Installed\nInstalled .* \(2\.0\.0\)\. Sign it in with `botkins providers login grok`\./s);
  assert.equal(existsSync(marker), true);
  assert.equal((await botkins(["providers", "install", "grok", "--yes"])).exit, 1);
  assert.match((await botkins(["providers", "install", "grok", "--yes"])).err, /is already installed\./);
  // --json: the command is still shown (on standard error), and the answer is one document.
  rmSync(marker);
  const asJson = await botkins(["providers", "install", "grok", "--yes", "--json"]);
  assert.equal(asJson.exit, 0, asJson.err);
  assert.match(asJson.err, /This runs a command in a shell on this computer/);
  const answer = asJson.json();
  assert.deepEqual([answer.done, answer.id, answer.installed, answer.version], [true, "grok", true, "2.0.0"]);
  assert.ok(answer.output.includes("Downloading Fake CLI") && answer.output.includes("Installed"));

  // An install that fails says why, with exit code 1.
  rmSync(marker);
  install = { command: "printf 'npm ERR! network\\n'; exit 7" };
  const failed = await botkins(["providers", "install", "grok", "--yes"]);
  assert.equal(failed.exit, 1);
  assert.match(failed.err, /The install didn't finish\. npm ERR! network/);
  // A provider with no command to run has a guide only; one that is not there is named.
  install = { url: "https://example.com/guide" };
  assert.match((await botkins(["providers", "install", "grok", "--yes"])).err, /can't be installed from Botkins\. Its guide: https:\/\/example\.com\/guide/);
  assert.match((await botkins(["providers", "install", "nobody", "--yes"])).err, /There is no model provider called nobody\./);

  // Program harnesses are not model providers, and the window installs them the same way.
  const fakePi = { id: "pi", name: "Pi", harness: true };
  const fakeOmp = { id: "omp", name: "OMP", harness: true };
  registry.harnesses.push(fakePi, fakeOmp);
  registry.byId.set("pi", fakePi);
  registry.byId.set("omp", fakeOmp);
  t.after(() => {
    registry.harnesses.splice(registry.harnesses.indexOf(fakePi), 1);
    registry.harnesses.splice(registry.harnesses.indexOf(fakeOmp), 1);
    registry.byId.delete("pi");
    registry.byId.delete("omp");
  });
  registry.status = async (id) =>
    id === "pi"
      ? { id, installed: false, connected: false, install: { url: "https://pi.dev", command: "printf 'pi'" } }
      : id === "omp"
        ? { id, installed: false, connected: false, install: { url: "https://omp.sh", command: "printf 'omp'" } }
        : status.call(registry, id);
  const pi = await botkins(["providers", "install", "pi"]);
  assert.equal(pi.exit, 2, pi.err);
  assert.match(pi.err, /to install Pi:\n {2}printf 'pi'\nThe provider's guide: https:\/\/pi\.dev\n/);
  assert.equal((await client.call("providers.installPlan", "pi")).id, "pi");
  const omp = await botkins(["providers", "install", "omp"]);
  assert.equal(omp.exit, 2, omp.err);
  assert.match(omp.err, /to install OMP:\n {2}printf 'omp'\nThe provider's guide: https:\/\/omp\.sh\n/);
  assert.equal((await client.call("providers.installPlan", "omp")).id, "omp");
  registry.status = async (id) => (id !== "grok" ? status.call(registry, id) : existsSync(marker) ? { id, installed: true, version: "2.0.0", connected: false } : { id, installed: false, connected: false, install });
  // The command is the provider's own: a caller on the socket cannot name another, and must say which one it looked at.
  install = { command: "printf 'fine\\n'; touch " + JSON.stringify(marker) };
  await assert.rejects(client.call("providers.install", "grok", { command: "touch " + JSON.stringify(join(dir, "other")) }), /Say which command you looked at: it is `printf 'fine\\n'; touch .*`\. Run `botkins providers install grok` to see it first\./);
  await assert.rejects(client.call("providers.install", "grok"), /Say which command you looked at/);
  assert.equal(existsSync(join(dir, "other")) || existsSync(marker), false, "nothing ran");
  assert.deepEqual((await client.call("providers.installPlan", "grok")).command, install.command);

  // (The first line is the refused reference of the earlier test. A refusal before the install is asked for leaves none: it started nothing.
  // The install that ran and failed is a change: it started a program.)
  assert.deepEqual((await changes()).filter((line) => line.includes("providers.install")), [
    "Tried from the command line: providers.install grok (it failed)",
    "providers.install grok",
    "providers.install grok",
    "providers.install grok",
    "Tried from the command line: providers.install grok (it failed)",
    "Tried from the command line: providers.install grok (it failed)",
  ]);
  none("in an install");
});

test("a model service is disconnected after a question, by its id or its name", { skip }, async (t) => {
  const { botkins, changes, running, none } = world;
  const grok = running.runtime.providers.require("grok");
  const { services, disconnectService } = grok;
  const gone = [];
  grok.services = async (query) => [{ id: "anthropic", name: "Anthropic", connected: true, methods: [] }, { id: "openai", name: "OpenAI", connected: false, methods: [] }].filter((entry) => !query || entry.id.includes(query.toLowerCase()) || entry.name.toLowerCase().includes(query.toLowerCase()));
  grok.disconnectService = async (id) => void gone.push(id);
  t.after(() => Object.assign(grok, { services, disconnectService }));

  const asked = await botkins(["providers", "disconnect", "grok", "anthropic"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  const declined = await botkins(["providers", "disconnect", "grok", "anthropic"], { input: "n\n", tty: true });
  assert.equal(declined.exit, 1);
  assert.match(declined.err, /Disconnect anthropic from grok\? Its key or sign-in is removed, and its models are no longer offered\./);
  assert.deepEqual(gone, []);
  const done = await botkins(["providers", "disconnect", "grok", "anthropic", "--yes"]);
  assert.equal(done.exit, 0, done.err);
  assert.match(done.out, /^Disconnected Anthropic from grok\.\n$/);
  assert.deepEqual((await botkins(["providers", "disconnect", "GROK", "ANTHROPIC", "--yes", "--json"])).json(), { provider: "grok", service: "anthropic", name: "Anthropic" });
  assert.deepEqual(gone, ["anthropic", "anthropic"]);
  const idle = await botkins(["providers", "disconnect", "grok", "openai", "--yes"]);
  assert.equal(idle.exit, 1);
  assert.match(idle.err, /OpenAI is not connected\./);
  assert.match((await botkins(["providers", "disconnect", "grok", "nothing", "--yes"])).err, /There is no model service called nothing\. See `botkins providers services grok`\./);
  assert.match((await botkins(["providers", "disconnect", "nobody", "x", "--yes"])).err, /There is no model provider called nobody\./);
  assert.equal((await botkins(["providers", "disconnect", "grok"])).exit, 2);
  assert.deepEqual((await changes()).filter((line) => line.includes("disconnectService")), [
    "providers.disconnectService grok/anthropic",
    "providers.disconnectService grok/anthropic",
    "Tried from the command line: providers.disconnectService grok/openai (it failed)",
    "Tried from the command line: providers.disconnectService grok/nothing (it failed)",
    "Tried from the command line: providers.disconnectService nobody/x (it failed)",
  ]);
  none("in a disconnect");
});

test("a saved credential that exists gets a new value from the socket and nothing else, and the command line has no way to give it another name, website or kind", { skip }, async () => {
  const { botkins, changes, client, store, none } = world;
  const made = (await botkins(["credentials", "save", "Deploy key", "--kind", "api-key", "--website", "deploy.example.com", "--username", "deployer", "--notes", "from the owner", "--json"], { input: PIPED })).json();
  const snapshot = () => JSON.stringify(store().list().find((entry) => entry.id === made.id));
  const before = snapshot();
  const sentence = /A saved credential gets another name, website or kind in the app's window or on a paired phone\. From here you can give it a new value, or remove it and save it again\./;
  // Each field that the app's save takes for one that exists is refused, alone and with a value, by name and by id. Nothing changes.
  for (const [field, given] of [["name", "Renamed"], ["kind", "login"], ["website", "evil.example.com"], ["username", "someone-else"], ["notes", "a new note"]]) {
    await assert.rejects(client.call("credentials.edit", made.id, { [field]: given }), sentence, field);
    await assert.rejects(client.call("credentials.edit", "deploy KEY", { [field]: given, value: EXTRA }), sentence, field + " with a value");
  }
  assert.equal(snapshot(), before, "the credential is as it was");
  assert.equal(await store().read(made.id), PIPED, "the value is as it was");
  // The refusal is for one that exists: a name that is not there is a not-found.
  await assert.rejects(client.call("credentials.edit", "nobody", { name: "x" }), /There is no saved credential called nobody\./);
  // A field that the call does not know, and a call with no value.
  await assert.rejects(client.call("credentials.edit", made.id, { value: EXTRA, source: "onepassword" }), /Give the new value as \{ value \}\./);
  await assert.rejects(client.call("credentials.edit", made.id, {}), /Give the new value as text\./);
  assert.equal(snapshot(), before);
  // The value alone works, and the name, kind, user name, website and notes stay.
  await assert.rejects(client.call("credentials.edit", "Deploy key", { value: NEWER }), { code: "NEEDS_YES" });
  assert.notEqual(await store().read(made.id), NEWER, "nothing was replaced without the mark");
  const edited = await client.call("credentials.edit", "Deploy key", { value: NEWER }, { agreed: true });
  assert.deepEqual([edited.id, edited.name, edited.kind, edited.website], [made.id, "Deploy key", "api-key", "deploy.example.com"]);
  assert.equal(await store().read(made.id), NEWER);
  const kept = store().list().find((entry) => entry.id === made.id);
  assert.deepEqual([kept.username, kept.notes], ["deployer", "from the owner"]);
  // The command line: each of these options is gone from `edit`, and the value stays as it was.
  for (const option of ["--name", "--website", "--kind", "--username", "--notes", "--value"]) {
    const gone = await botkins(["credentials", "edit", "Deploy key", option, "x", "--yes"], { input: EXTRA });
    assert.equal(gone.exit, 2, option);
    assert.equal(gone.err.includes(EXTRA), false);
  }
  assert.equal(await store().read(made.id), NEWER);
  // A refused call is a "Tried" line with the name; the one that worked is a line with the name. No value is in either.
  assert.deepEqual((await changes()).filter((line) => line.includes("credentials.edit Deploy key")).length > 0, true);
  assert.equal((await changes()).filter((line) => line === "credentials.edit Deploy key").length, 1, "one change was made");
  // Clean up for the tests after this one.
  await botkins(["credentials", "remove", made.id, "--yes"]);
  none("in a refused edit");
});

test("no call of the area takes a reference to a saved credential, in any argument", { skip }, async () => {
  const { client, store, none } = world;
  const saved = await store().save({ name: "Referenced", value: PIPED });
  const ref = { $credential: saved };
  const refused = /A saved credential is chosen in the app's window or on a paired phone\. From the command line, give the value itself\./;
  const { control } = await client.call("methods");
  const mine = control.filter((name) => name.startsWith("credentials.") || name.startsWith("providers.") && !["providers.list", "providers.services", "providers.login.read", "providers.login.input", "providers.login.cancel"].includes(name) && !/^providers\.(login|logout|enable|set)/.test(name));
  // The calls that this file made: every one of them is in the list that is looked at.
  for (const name of ["credentials.list", "credentials.save", "credentials.edit", "credentials.remove", "credentials.vault", "credentials.vaultRemove", "credentials.vaultReset", "credentials.managers", "credentials.managerLock", "providers.usage", "providers.installPlan", "providers.install", "providers.install.read", "providers.install.input", "providers.install.cancel", "providers.disconnectService"]) assert.ok(mine.includes(name), name);
  for (const name of ["credentials.list", "credentials.save", "credentials.edit", "credentials.remove", "credentials.vault", "credentials.vaultRemove", "credentials.vaultReset", "credentials.managers", "credentials.managerLock", "providers.usage", "providers.installPlan", "providers.install", "providers.install.read", "providers.install.input", "providers.install.cancel", "providers.disconnectService"]) {
    await assert.rejects(client.call(name, ref), refused, name + " takes none as its first argument");
    await assert.rejects(client.call(name, "x", ref), refused, name + " takes none as its second argument");
    await assert.rejects(client.call(name, { nested: [{ deeper: ref }] }), refused, name + " takes none inside an object");
  }
  assert.equal(await store().read(saved), PIPED, "nothing was changed");
  store().remove(saved);
  none("in a refused reference");
});

test("`botkins help --json` lists the commands of the area, and the ones that ask say which flag answers", { skip }, async () => {
  const { botkins, none } = world;
  const all = (await botkins(["help", "--json"])).json();
  const commands = all.areas.flatMap((area) => area.commands);
  const mine = ["credentials list", "credentials save", "credentials edit", "credentials remove", "vault list", "vault remove", "vault reset", "password-managers list", "password-managers lock", "providers usage", "providers install", "providers disconnect"];
  for (const name of mine) assert.ok(commands.some((entry) => entry.command === name), name + " is listed");
  const entry = (name) => commands.find((one) => one.command === name);
  assert.deepEqual(entry("credentials remove").arguments, [{ name: "credential", required: true }]);
  assert.deepEqual(entry("providers disconnect").arguments, [{ name: "provider", required: true }, { name: "service", required: true }]);
  assert.deepEqual(entry("providers usage").arguments, [{ name: "provider", required: false }]);
  assert.deepEqual(["credentials edit", "credentials remove", "vault remove", "vault reset", "providers install", "providers disconnect"].map((name) => entry(name).asks), ["--yes", "--yes", "--yes", "--yes --erase-all-saved-secrets", "--yes", "--yes"]);
  assert.equal(entry("credentials save").options.some((option) => option.name === "--value"), false, "a value is not an option of save");
  // `edit` gives a new value and nothing else: it has no option that changes how a credential is shown or where it is offered, and no option that carries a value.
  assert.deepEqual(entry("credentials edit").options.map((option) => option.name), ["--yes"]);
  none("in help");
});
