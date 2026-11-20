// Settings › Credentials on this computer (desktop/savedcredentials.mjs): the page's calls to the
// link's saved credentials and password managers. Run against the real Credentials store
// (desktop/link/credentials.mjs) with stand-in manager tools in a temp folder, and against a
// stand-in store. No real password manager, vault or keychain is touched.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Credentials } from "../desktop/link/credentials.mjs";
import { Failure } from "../desktop/link/tools.mjs";
import { LOCKED, NOT_READY, SavedCredentials, holdsReference, trialToolDirs } from "../desktop/savedcredentials.mjs";
import { drivers } from "../desktop/link/managers.mjs";

/** Points a test's store at stand-in tools in `toolPath` (none when it is empty), as a trial run's link is. */
function trialManagers(store, toolPath) {
  store.drivers = new Map(drivers({ dirs: trialToolDirs(toolPath) }).map((driver) => [driver.id, driver]));
  store.statuses = null;
}
import { tempDir } from "./fake-copilot.mjs";

const VALUE = "sk-test-VALUE-0123456789";
const OP_VALUE = "ghp_STANDIN_VALUE_42";
const BW_PASSWORD = "standin-master-pass";

/** Stand-in command-line tools in a folder of their own. `STATE` in a script is a folder it keeps notes in. */
function tools(t, scripts) {
  const root = tempDir(t, "botkins-tools-");
  const dir = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(dir);
  mkdirSync(state);
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, name), '#!/bin/sh\nSTATE="' + state + '"\n' + body, { mode: 0o755 });
  return { dir, state, log: (name) => readFileSync(join(state, name + ".log"), "utf8") };
}

const OP = `
echo "$*" >> "$STATE/op.log"
case "$*" in
  "--version") echo 2.30.0 ;;
  "whoami --format json") echo '{"url":"team.example.com","email":"someone@example.com"}' ;;
  "vault list --format json") echo '[{"id":"vault-1","name":"Work"},{"id":"vault-2","name":"Home"}]' ;;
  "item list --vault vault-1 --format json") echo '[{"id":"item-1","title":"GitHub","additional_information":"octo"},{"id":"item-2","title":"Cloud","additional_information":"root"}]' ;;
  "item get item-1 --vault vault-1 --format json") echo '{"id":"item-1","title":"GitHub","fields":[{"id":"username","label":"username","type":"STRING","value":"octo"},{"id":"tok1","label":"token","type":"CONCEALED","value":"${OP_VALUE}"}]}' ;;
  "read --no-newline op://vault-1/item-1/tok1") printf %s ${OP_VALUE} ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;
// Bitwarden: locked until `unlock` gets the right password in BW_PASSWORD (never on the command line).
const BW = `
echo "$*" >> "$STATE/bw.log"
case "$*" in
  "--version --nointeraction") echo 2024.9.0 ;;
  "status --nointeraction") if [ -f "$STATE/unlocked" ]; then echo '{"status":"unlocked","userEmail":"someone@example.com"}'; else echo '{"status":"locked","userEmail":"someone@example.com"}'; fi ;;
  "unlock --passwordenv BW_PASSWORD --raw --nointeraction") [ "$BW_PASSWORD" = "${BW_PASSWORD}" ] || exit 1; touch "$STATE/unlocked"; printf %s session-standin ;;
  "lock --nointeraction") rm -f "$STATE/unlocked" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;

/** Every answer of a call, as text: none may hold a value. */
function clean(value, ...secrets) {
  const text = JSON.stringify(value ?? null);
  for (const secret of secrets) assert.ok(!text.includes(secret), "a value came back: " + text);
  return value;
}

function real(t, { searchPath = [] } = {}) {
  const dir = tempDir(t, "botkins-saved-");
  const store = new Credentials({ dir, searchPath });
  return { dir, store, saved: new SavedCredentials({ get: () => store }) };
}

test("a credential typed in is saved, listed, checked, changed and removed, and no value ever comes back", async (t) => {
  const { dir, saved } = real(t);
  const id = clean(await saved.save({ name: "Deploy key", kind: "api-key", username: "ci", website: "https://deploy.example.com", value: VALUE }), VALUE);
  assert.match(id, /^cred-/);
  const list = clean(await saved.list(), VALUE);
  assert.equal(list.locked, false);
  assert.deepEqual(
    list.entries.map(({ name, kind, source, username, website }) => ({ name, kind, source, username, website })),
    [{ name: "Deploy key", kind: "api-key", source: "vault", username: "ci", website: "https://deploy.example.com" }],
  );
  assert.ok(!("secret" in list.entries[0]) && !("value" in list.entries[0]));
  // The store keeps it encrypted: the file never holds the value as typed.
  assert.ok(!readFileSync(join(dir, "credentials.json"), "utf8").includes(VALUE));
  assert.deepEqual(clean(await saved.check(id), VALUE), { ok: true });
  // A change without a value keeps the saved one.
  clean(await saved.save({ id, name: "Deploy key (CI)", value: null }), VALUE);
  assert.equal((await saved.list()).entries[0].name, "Deploy key (CI)");
  const { args } = await new Credentials({ dir, searchPath: [] }).resolve("respond", ["req-1", { action: "answer", value: { $credential: id } }]);
  assert.equal(args[1].value, VALUE, "the saved value is still the one typed in");
  await saved.remove(id);
  assert.deepEqual((await saved.list()).entries, []);
  assert.deepEqual(await saved.check(id), { ok: false, message: "That credential no longer exists." });
  await assert.rejects(saved.remove(id), { message: "That credential no longer exists." });
});

test("a reference in an answer is resolved on the computer, and a plain answer passes through", async (t) => {
  const { saved } = real(t);
  const id = await saved.save({ name: "API key", value: VALUE });
  // A typed answer (or a phone's, already resolved by the link) goes on as it is.
  const plain = ["req-1", { action: "answer", value: "typed text" }];
  assert.equal(await saved.respondArgs(plain), plain);
  // A question answered with a saved credential.
  const [rid, answer] = await saved.respondArgs(["req-1", { action: "answer", value: { $credential: id } }]);
  assert.equal(rid, "req-1");
  assert.deepEqual(answer, { action: "answer", value: VALUE });
  // A form: a reference in a field, next to typed fields.
  const [, form] = await saved.respondArgs(["req-2", { action: "accept", content: { user: "ci", token: { $credential: id } } }]);
  assert.deepEqual(form.content, { user: "ci", token: VALUE });
  // Anywhere else it is refused, and nothing is filled in.
  await assert.rejects(saved.respondArgs(["req-3", { action: "accept", content: { deep: { token: { $credential: id } } } }]), { message: "A credential can't be used there." });
  await assert.rejects(saved.respondArgs(["req-4", { action: "answer", value: { $credential: "cred-gone" } }]), (error) => error instanceof Failure && /^That credential can't be read right now/.test(error.message));
  // Before the link exists: a plain answer still goes, a reference says why it can't.
  const early = new SavedCredentials({ get: () => null });
  assert.equal(await early.respondArgs(plain), plain);
  await assert.rejects(early.respondArgs(["req-5", { action: "answer", value: { $credential: id } }]), { message: NOT_READY });
  await assert.rejects(early.list(), { message: NOT_READY });
  assert.equal(holdsReference({ a: [{ b: { $credential: "x" } }] }), true);
  assert.equal(holdsReference({ a: "$credential" }), false);
});

test("without the tools, each manager is not installed, with how to install it", async (t) => {
  const { store, saved } = real(t);
  // A trial run names its tool folders; with none named, nothing is found (and nothing is run).
  trialManagers(store, "");
  const managers = await saved.managers(true);
  assert.deepEqual(managers.map((m) => [m.id, m.state]), [["onepassword", "missing"], ["bitwarden", "missing"], ["protonpass", "missing"]]);
  for (const m of managers) {
    assert.match(m.message, /^Install the .+ command-line tool \((op|bw|pass-cli)\) on your computer\.$/);
    assert.match(m.install.url, /^https:\/\//);
  }
  assert.deepEqual(Object.keys(managers[0]).sort(), ["id", "install", "message", "name", "state"]);
});

test("1Password through a stand-in op: browse a vault, link a field, check it and answer with it", async (t) => {
  const op = tools(t, { op: OP });
  const { store, saved } = real(t);
  trialManagers(store, op.dir);
  const [one] = clean(await saved.managers(true), OP_VALUE);
  assert.equal(one.state, "ready");
  assert.equal(one.account, "someone@example.com");
  assert.deepEqual(clean(await saved.vaults("onepassword"), OP_VALUE), [{ id: "vault-1", name: "Work" }, { id: "vault-2", name: "Home" }]);
  assert.deepEqual(clean(await saved.items("onepassword", "vault-1", "git"), OP_VALUE), [{ id: "item-1", title: "GitHub", subtitle: "octo" }]);
  const item = clean(await saved.item("onepassword", "vault-1", "item-1"), OP_VALUE, "octo");
  assert.deepEqual(item.fields, [{ id: "username", label: "username", secret: false }, { id: "tok1", label: "token", secret: true }]);
  const id = clean(await saved.link({ manager: "onepassword", vaultId: "vault-1", itemId: "item-1", fieldId: "tok1", name: "GitHub token" }), OP_VALUE);
  const [entry] = clean(await saved.list(), OP_VALUE).entries;
  assert.equal(entry.id, id);
  assert.equal(entry.source, "onepassword");
  assert.equal(entry.reference, "Work / GitHub / token");
  assert.ok(!("ref" in entry), "the place inside the manager isn't shown either");
  assert.deepEqual(clean(await saved.check(id), OP_VALUE), { ok: true });
  const [, answer] = await saved.respondArgs(["req-1", { action: "answer", value: { $credential: id } }]);
  assert.equal(answer.value, OP_VALUE);
  // A linked one can be renamed, not given a value here.
  await assert.rejects(saved.save({ id, name: "GitHub", value: "other" }), { message: "A linked credential is read from its password manager. Change it there." });
  await saved.save({ id, name: "GitHub" });
  assert.equal((await saved.list()).entries[0].name, "GitHub");
  // A manager's error is its sentence, never the tool's own words.
  await assert.rejects(saved.vaults("nope"), { message: "That password manager isn't supported." });
  await assert.rejects(saved.items("onepassword", "vault-2"), { message: "1Password reported an error." });
});

test("Bitwarden through a stand-in bw: locked, unlocked with the master password, locked again", async (t) => {
  const bw = tools(t, { bw: BW });
  const { store, saved } = real(t);
  trialManagers(store, bw.dir);
  const status = (await saved.managers(true)).find((m) => m.id === "bitwarden");
  assert.equal(status.state, "locked");
  assert.equal(status.canUnlock, true);
  assert.equal(status.message, "Enter your master password to unlock Bitwarden.");
  await assert.rejects(saved.unlock("bitwarden", "wrong"), { message: "Bitwarden didn't unlock. Check the master password." });
  await assert.rejects(saved.unlock("bitwarden", ""), { message: "Enter the master password." });
  const ready = clean(await saved.unlock("bitwarden", BW_PASSWORD), BW_PASSWORD, "session-standin");
  assert.equal(ready.state, "ready");
  // The password went to the tool in its environment only, never on its command line.
  assert.ok(!bw.log("bw").includes(BW_PASSWORD));
  const after = clean(await saved.lock("bitwarden"), "session-standin");
  assert.equal(after.state, "locked");
});

test("errors arrive as one plain sentence; what a store adds beyond labels is dropped", async () => {
  const leaky = {
    locked: false,
    list: () => [{ id: "c1", name: "One", kind: "api-key", source: "vault", createdAt: 1, updatedAt: 1, secret: "sealed-bytes", ref: { itemId: "x" } }],
    check: async () => ({ ok: false, message: "It can't be read.", value: "leak" }),
    managers: async () => [{ id: "bitwarden", name: "Bitwarden", state: "locked", canUnlock: true, session: "leak", install: { url: "javascript:alert(1)" } }],
    item: async () => ({ id: "i", title: "T", fields: [{ id: "f", label: "Password", secret: true, value: "leak" }] }),
    vaults: async () => {
      throw new Error("raw tool output with leak in it");
    },
    items: async () => {
      throw new Failure("Bitwarden is locked. Unlock it first.");
    },
  };
  const saved = new SavedCredentials({ get: () => leaky });
  clean(await saved.list(), "sealed-bytes", "itemId");
  assert.deepEqual(await saved.check("c1"), { ok: false, message: "It can't be read." });
  const [status] = clean(await saved.managers(), "leak");
  assert.equal(status.install, undefined, "only a web address is passed on as an install guide");
  clean(await saved.item("bitwarden", "v", "i"), "leak");
  await assert.rejects(saved.vaults("bitwarden"), (error) => error instanceof Failure && error.message === "Something went wrong with the saved credentials. Try again.");
  await assert.rejects(saved.items("bitwarden", "v"), { message: "Bitwarden is locked. Unlock it first." });
  // A store that can't be opened here: listed, not changed, with words for this computer.
  const locked = new SavedCredentials({ get: () => ({ ...leaky, locked: true, save: () => assert.fail("saved"), remove: () => assert.fail("removed") }) });
  assert.equal((await locked.list()).locked, true);
  await assert.rejects(locked.save({ name: "x", value: "y" }), { message: LOCKED });
  await assert.rejects(locked.remove("c1"), { message: LOCKED });
});
