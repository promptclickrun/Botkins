// The rename to Botkins: a person's data is found again, their keychain-guarded
// keys open again, and the old environment variables still work. (Their saved appearance: test/appearance.test.mjs.)
// Everything here runs in temporary folders with stand-in keychains; nothing touches real data.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { APP_NAME, LEGACY_NAME, adoptFolder, dataHome, env, hasWorkspace } from "../desktop/home.mjs";
import { HELPER_FLAG, hasEarlierKeychain, isKey, isKeyHelper, keyStore, lockedKeys, openWithEarlierKeychain, runKeyHelper } from "../desktop/keychain.mjs";
import { Vault } from "../desktop/vault.mjs";
import { Workspace } from "../desktop/workspace.mjs";
import { LinkStore } from "../desktop/link/store.mjs";

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-rename-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A stand-in for a keychain entry: what it wraps, only it opens. */
const keychain = (name) => ({
  wrap: (text) => Buffer.from(name + ":" + text).toString("base64"),
  unwrap: (data) => {
    const text = Buffer.from(String(data), "base64").toString();
    return text.startsWith(name + ":") ? text.slice(name.length + 1) : null;
  },
});
/** Everything the earlier data folder holds that must still be there afterwards. */
function earlierFolder(appData, { wrapWith } = {}) {
  const root = join(appData, LEGACY_NAME);
  const data = join(root, "data");
  const files = {
    "data/workspace.json": JSON.stringify({ bots: [{ id: "pip", name: "Pip", role: "Helper", instructions: "Help.", face: "idle", avatar: { body: "bighelp.biggie" } }], chats: [{ id: "c1", botId: "pip", title: "Hello", time: 1, messages: [{ role: "user", text: "Hi" }] }], runs: [], settings: { onboarded: true, appearance: { theme: "dark", lightBackground: "sage", darkBackground: "forest", bubble: "#336699" } } }),
    "data/wiki/WIKI.md": "# How this wiki works\n",
    "data/wiki/projects/website.md": "# Website\n",
    "data/copilot/session-state/s1/events.jsonl": "{}\n",
    "data/codex/sessions.json": "{}",
    "data/claude/sessions.json": "{}",
    "data/opencode/sessions.json": "{}",
    "data/files/pip/notes.txt": "kept",
    "Local Storage/leveldb/000003.log": "draft",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (wrapWith) {
    // The vault and the phone link as the earlier installation left them: keys wrapped by its keychain entry.
    const vault = new Vault(data, wrapWith);
    vault.put("sk-live-123", { label: "CRM key", kind: "header", owner: "mcp:crm" }, "crm-key");
    const link = new LinkStore(join(data, "link"), { protect: wrapWith.wrap, reveal: wrapWith.unwrap });
    link.set({ enabled: true });
    link.addDevice({ name: "Sam's phone", platform: "ios", publicKey: Buffer.alloc(32, 7) });
  }
  return { root, data, files };
}
const tree = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? tree(join(dir, entry.name), base) : [join(dir, entry.name).slice(base.length + 1)])).sort();

test("someone new gets a Botkins folder; tests name their own", (t) => {
  const appData = folder(t);
  assert.equal(APP_NAME, "Botkins");
  assert.deepEqual(dataHome({ appData }), { dir: join(appData, "Botkins"), from: "botkins" });
  assert.deepEqual(dataHome({ appData, override: "/somewhere/else" }), { dir: "/somewhere/else", from: "override" });
  assert.equal(existsSync(join(appData, "Botkins")), false, "choosing a folder creates nothing");
});

test("an earlier folder can be opened through Botkins while saved paths still work", (t) => {
  const appData = folder(t);
  const { root, files } = earlierFolder(appData);
  const before = tree(root);
  const botkins = join(appData, "Botkins");
  assert.equal(adoptFolder({ appData }), "linked");
  // Both paths open the same files.
  assert.deepEqual(tree(botkins), before);
  assert.ok(lstatSync(botkins).isSymbolicLink());
  assert.ok(lstatSync(root).isDirectory(), "the original folder stays in place");
  assert.equal(realpathSync(root), realpathSync(botkins));
  // A path saved under the old name still opens the same file.
  for (const path of Object.keys(files)) assert.equal(readFileSync(join(root, path), "utf8"), readFileSync(join(botkins, path), "utf8"), path);
  // The app now uses its own folder, and a bot works under the app's name.
  assert.deepEqual(dataHome({ appData }), { dir: botkins, from: "botkins" });
  const ws = new Workspace(join(botkins, "data"), async () => ({}), () => {});
  assert.equal(ws.state.chats[0].messages[0].text, "Hi");
  assert.equal(join(ws.dir, "files", "pip"), join(appData, "Botkins", "data", "files", "pip"));
  assert.ok(!join(ws.dir, "files", "pip").includes(LEGACY_NAME));
  // A second start uses the same Botkins entry point.
  assert.equal(adoptFolder({ appData }), "none");
  assert.ok(lstatSync(root).isDirectory() && hasWorkspace(botkins));
});

test("a busy workspace and an occupied Botkins folder keep their paths", (t) => {
  // An earlier version of the app is running on the folder: its lock names a process that is alive.
  const busy = folder(t);
  const { root } = earlierFolder(busy);
  const before = tree(root);
  symlinkSync("this-mac-4242", join(root, "SingletonLock"));
  assert.equal(adoptFolder({ appData: busy, running: (pid) => pid === 4242 }), "busy");
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
  assert.equal(existsSync(join(busy, "Botkins")), false);
  assert.deepEqual(dataHome({ appData: busy }), { dir: root, from: "earlier" }, "the folder is used where it is");
  // A lock left by a process that is gone, or this very process's own, doesn't hold the folder.
  assert.equal(adoptFolder({ appData: busy, running: () => false }), "linked");
  assert.equal(readlinkSync(join(busy, "Botkins", "SingletonLock")), "this-mac-4242", "both paths see the lock");
  assert.deepEqual(tree(join(busy, "Botkins")).filter((path) => !path.includes("SingletonLock")), before);

  // A Botkins folder with anything in it is someone's: nothing is renamed over it.
  const taken = folder(t);
  earlierFolder(taken);
  mkdirSync(join(taken, "Botkins", "Cache"), { recursive: true });
  assert.equal(adoptFolder({ appData: taken }), "taken");
  assert.ok(hasWorkspace(join(taken, LEGACY_NAME)));
  assert.equal(dataHome({ appData: taken }).from, "earlier");
  // An empty one (a crashed first start can leave it) is no one's.
  const empty = folder(t);
  earlierFolder(empty);
  mkdirSync(join(empty, "Botkins"));
  assert.equal(adoptFolder({ appData: empty }), "linked");
  assert.ok(hasWorkspace(join(empty, "Botkins")));

  // Nothing to adopt: no earlier folder, or one that holds no workspace.
  const none = folder(t);
  assert.equal(adoptFolder({ appData: none }), "none");
  mkdirSync(join(none, LEGACY_NAME, "Cache"), { recursive: true });
  assert.equal(adoptFolder({ appData: none }), "none");
  assert.ok(existsSync(join(none, LEGACY_NAME, "Cache")));

  // A link the system refuses leaves everything as it was, and the app goes on in the old folder.
  const refused = folder(t);
  const kept = earlierFolder(refused);
  const whole = tree(kept.root);
  assert.equal(adoptFolder({ appData: refused, link: () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); } }), "failed");
  assert.deepEqual(tree(kept.root), whole);
  assert.equal(dataHome({ appData: refused }).from, "earlier");
});

test("an earlier folder that could not be linked is used where it is, with everything in it", (t) => {
  const appData = folder(t);
  const { root, data, files } = earlierFolder(appData);
  const before = tree(root);
  assert.deepEqual(dataHome({ appData }), { dir: root, from: "earlier" });
  assert.deepEqual(tree(root), before, "nothing is moved, copied or removed");
  assert.equal(existsSync(join(appData, "Botkins")), false);

  // The workspace opens from it: the chats, the wiki, each provider's sessions and the bot's files are all there.
  const ws = new Workspace(data, async () => ({}), () => {});
  assert.equal(ws.state.chats[0].messages[0].text, "Hi");
  assert.equal(ws.state.bots[0].name, "Pip");
  assert.ok(ws.state.bots[0].look, "the bot becomes a Botkin");
  assert.deepEqual(ws.state.bots[0].avatar, { body: "bighelp.biggie" }, "and what an earlier version drew stays in the file");
  assert.equal(ws.wiki.page("projects/website.md").content.trim(), "# Website");
  for (const path of Object.keys(files)) assert.ok(existsSync(join(root, path)), path);
  assert.equal(readFileSync(join(data, "files", "pip", "notes.txt"), "utf8"), "kept");
  // A chat still works in the folder its conversation was started in.
  assert.equal(join(ws.dir, "files", "pip"), join(appData, LEGACY_NAME, "data", "files", "pip"));

  // An appearance saved before themes keeps its look: the light preset decides.
  assert.deepEqual(ws.state.settings.appearance, { theme: "dark", colorTheme: "fern", themePicked: true, darkColorTheme: null, backdrop: "clean", contrast: 0, textSize: "default", font: "system", fontPicked: false, bubble: "#336699", avatarAnimations: true, lightBackground: "sage", darkBackground: "forest" });
});

test("the folder is chosen by which one holds a workspace", (t) => {
  const appData = folder(t);
  earlierFolder(appData);
  // An empty Botkins folder (the system or a crashed first start can leave one) doesn't hide the data.
  mkdirSync(join(appData, "Botkins", "Cache"), { recursive: true });
  assert.equal(dataHome({ appData }).from, "earlier");
  // Once Botkins has a workspace of its own, that one is used and the earlier folder is left alone.
  mkdirSync(join(appData, "Botkins", "data"), { recursive: true });
  writeFileSync(join(appData, "Botkins", "data", "workspace.json"), "{}");
  assert.deepEqual(dataHome({ appData }), { dir: join(appData, "Botkins"), from: "botkins" });
  assert.ok(hasWorkspace(join(appData, LEGACY_NAME)));
  // An earlier folder without a workspace is not data.
  const other = folder(t);
  mkdirSync(join(other, LEGACY_NAME, "Cache"), { recursive: true });
  assert.equal(dataHome({ appData: other }).from, "botkins");
});

test("environment variables are read under the new name, then the old one", () => {
  assert.equal(env("DATA_DIR", { [LEGACY_NAME.toUpperCase() + "_DATA_DIR"]: "/old" }), "/old");
  assert.equal(env("DATA_DIR", { BOTKINS_DATA_DIR: "/new", [LEGACY_NAME.toUpperCase() + "_DATA_DIR"]: "/old" }), "/new");
  assert.equal(env("PROVIDERS", { BOTKINS_PROVIDERS: "copilot" }), "copilot");
  assert.equal(env("LIVE", {}), undefined);
  assert.equal(env("TIMING", { [LEGACY_NAME.toUpperCase() + "_TIMING"]: "1" }), "1");
  // An empty new spelling doesn't hide the old one: a smoke that names its folder the old way stays in it.
  assert.equal(env("DATA_DIR", { BOTKINS_DATA_DIR: "", [LEGACY_NAME.toUpperCase() + "_DATA_DIR"]: "/tmp/test" }), "/tmp/test");
  assert.equal(env("DATA_DIR", { BOTKINS_DATA_DIR: "", [LEGACY_NAME.toUpperCase() + "_DATA_DIR"]: "" }), undefined);
});

test("keys the earlier keychain entry guards open again, and the earlier wrapping is kept", async (t) => {
  const appData = folder(t);
  const oldKeys = keychain(LEGACY_NAME);
  const botkins = keychain("Botkins");
  const { data } = earlierFolder(appData, { wrapWith: oldKeys });
  const vaultBefore = JSON.parse(readFileSync(join(data, "vault.json"), "utf8"));
  const linkBefore = readFileSync(join(data, "link", "link.json"), "utf8");
  assert.equal(vaultBefore.key.by, "os");

  // The renamed app's own keychain entry opens neither.
  assert.equal(new Vault(data, botkins).locked, true, "without help the vault stays shut, and untouched");
  assert.equal(readFileSync(join(data, "vault.json"), "utf8"), JSON.stringify(vaultBefore));
  const locked = lockedKeys(data, botkins.unwrap);
  assert.deepEqual(locked, [vaultBefore.key.data, JSON.parse(linkBefore).privateKey]);

  // The helper opens them with the earlier entry (here a stand-in process that speaks the helper's protocol).
  const started = [];
  const launch = (command, args, options) => {
    started.push({ command, args, dir: options.env.BOTKINS_KEYS_DIR });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => child.emit("close");
    const output = new PassThrough();
    output.pipe(child.stdout);
    output.on("end", () => setImmediate(() => child.emit("close", 0)));
    const app = { setName: (name) => (app.name = name), setPath: (key, value) => (app[key] = value), whenReady: () => Promise.resolve(), exit: () => output.end() };
    const safeStorage = { isEncryptionAvailable: () => true, decryptString: (buffer) => {
      const text = oldKeys.unwrap(buffer.toString("base64"));
      if (text == null) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return text;
    } };
    runKeyHelper({ app, safeStorage, input: child.stdin, output, dir: options.env.BOTKINS_KEYS_DIR });
    assert.equal(app.name, LEGACY_NAME, "the helper takes the earlier name before anything else");
    assert.equal(app.userData, options.env.BOTKINS_KEYS_DIR, "and a folder of its own");
    return child;
  };
  const opened = await openWithEarlierKeychain(locked, { command: "/Applications/Botkins.app/Contents/MacOS/Botkins", launch });
  assert.deepEqual(started.map((s) => [s.command, s.args]), [["/Applications/Botkins.app/Contents/MacOS/Botkins", [HELPER_FLAG]]]);
  assert.equal(existsSync(started[0].dir), false, "the helper's folder is removed afterwards");
  assert.equal(opened.size, 2);

  // The vault opens, every credential is there, and this app's own wrapping joins the earlier one.
  const keys = keyStore(botkins, opened);
  const vault = new Vault(data, keys);
  assert.equal(vault.locked, false);
  assert.equal(vault.get("vault:crm-key"), "sk-live-123");
  const saved = JSON.parse(readFileSync(join(data, "vault.json"), "utf8"));
  assert.equal(saved.key.data, vaultBefore.key.data, "the earlier wrapping is never overwritten");
  assert.equal(botkins.unwrap(saved.key.botkins), oldKeys.unwrap(vaultBefore.key.data), "the same key, under the new entry too");
  assert.deepEqual(saved.entries, vaultBefore.entries);

  // The next start needs no helper, and changes keep both wrappings.
  assert.deepEqual(lockedKeys(data, botkins.unwrap).filter((k) => k === vaultBefore.key.data), []);
  const again = new Vault(data, keyStore(botkins));
  assert.equal(again.get("vault:crm-key"), "sk-live-123");
  again.put("sk-second", { label: "Second" }, "second");
  const later = JSON.parse(readFileSync(join(data, "vault.json"), "utf8"));
  assert.equal(later.key.data, vaultBefore.key.data);
  assert.ok(botkins.unwrap(later.key.botkins));
  // An earlier installation still opens the same vault, with what Botkins added.
  const earlier = new Vault(data, oldKeys);
  assert.equal(earlier.locked, false);
  assert.equal(earlier.get("vault:second"), "sk-second");

  // The phone link opens with the same key store: the same computer, the same paired phone.
  const reveal = (wrapped) => {
    const text = keys.unwrap(wrapped);
    if (text == null) throw new Error("locked");
    return text;
  };
  const link = new LinkStore(join(data, "link"), { protect: keys.wrap, reveal });
  assert.equal(link.data.locked, undefined);
  assert.equal(link.data.serverId, JSON.parse(linkBefore).serverId);
  assert.deepEqual(link.data.devices.map((d) => d.name), ["Sam's phone"]);
  assert.equal(link.data.enabled, true);
  // Once the link saves, its key is under the new entry and no helper is needed for it either.
  link.touch(link.data.devices[0].id);
  link.set({ name: "Studio Mac" });
  assert.deepEqual(lockedKeys(data, botkins.unwrap), []);
  assert.deepEqual(new LinkStore(join(data, "link"), { protect: botkins.wrap, reveal: (w) => botkins.unwrap(w) ?? (() => { throw new Error("locked"); })() }).data.devices.map((d) => d.name), ["Sam's phone"]);
});

test("when the earlier keys can't be opened, nothing is changed and nothing is lost", async (t) => {
  const appData = folder(t);
  const oldKeys = keychain(LEGACY_NAME);
  const botkins = keychain("Botkins");
  const { data } = earlierFolder(appData, { wrapWith: oldKeys });
  const vaultBefore = readFileSync(join(data, "vault.json"), "utf8");
  const linkBefore = readFileSync(join(data, "link", "link.json"), "utf8");
  const locked = lockedKeys(data, botkins.unwrap);

  // The person says no at the keychain's question: the helper answers with nothing it could open.
  const denied = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {};
    child.stdin.resume();
    setImmediate(() => {
      child.stdout.end("\n@@botkins-keys@@" + JSON.stringify({ values: locked.map(() => null) }) + "\n");
      child.emit("close", 0);
    });
    return child;
  };
  // Or the helper can't start at all, or says something else entirely.
  const broken = () => {
    throw new Error("spawn ENOENT");
  };
  const silent = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end("Starting…\n");
      child.emit("close", 1);
    });
    return child;
  };
  for (const launch of [denied, broken, silent]) {
    const opened = await openWithEarlierKeychain(locked, { launch });
    assert.equal(opened.size, 0);
    const keys = keyStore(botkins, opened);
    const vault = new Vault(data, keys);
    assert.equal(vault.locked, true);
    assert.equal(vault.list().length, 1, "the page still sees what is stored, without its secret");
    assert.throws(() => vault.put("x", {}, "y"), /can't open its credential vault/);
    const link = new LinkStore(join(data, "link"), { protect: keys.wrap, reveal: (w) => keys.unwrap(w) ?? (() => { throw new Error("locked"); })() });
    assert.equal(link.data.locked, "locked");
    link.set({ enabled: false });
    assert.equal(readFileSync(join(data, "vault.json"), "utf8"), vaultBefore, "the vault file is untouched");
    assert.equal(readFileSync(join(data, "link", "link.json"), "utf8"), linkBefore, "and so is the link's");
  }
  // The earlier app, or a later start where the person allows it, still opens everything.
  assert.equal(new Vault(data, oldKeys).get("vault:crm-key"), "sk-live-123");
  assert.equal((await openWithEarlierKeychain([], { launch: broken })).size, 0, "with nothing locked the helper isn't started");
});

test("the helper is only this app started with its flag, and only looks for the earlier entry on a Mac", () => {
  assert.equal(isKeyHelper(["/Applications/Botkins.app/Contents/MacOS/Botkins", HELPER_FLAG]), true);
  assert.equal(isKeyHelper(["electron", "."]), false);
  const asked = [];
  const run = (command, args) => (asked.push([command, ...args]), { status: 0 });
  assert.equal(hasEarlierKeychain({ platform: "darwin", run }), true);
  assert.deepEqual(asked, [["/usr/bin/security", "find-generic-password", "-s", LEGACY_NAME + " Safe Storage"]], "it asks whether the entry exists, never for its secret");
  assert.equal(hasEarlierKeychain({ platform: "darwin", run: () => ({ status: 44 }) }), false);
  assert.equal(hasEarlierKeychain({ platform: "win32", run }), false, "Windows keeps the key with the data folder, so nothing changes there");
  assert.equal(asked.length, 1);
});

test("a vault from a fresh Botkins has one wrapping, and a development vault still moves to the keychain", (t) => {
  const dir = folder(t);
  const botkins = keychain("Botkins");
  const fresh = new Vault(dir, keyStore(botkins));
  fresh.put("secret", {}, "a");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "vault.json"), "utf8")).key), ["by", "data"]);
  const dev = folder(t);
  new Vault(dev).put("secret", {}, "a");
  const taken = new Vault(dev, keyStore(botkins));
  assert.equal(taken.get("vault:a"), "secret");
  assert.equal(JSON.parse(readFileSync(join(dev, "vault.json"), "utf8")).key.by, "os");
  assert.equal(existsSync(join(dev, "vault.key")), false);
});

test("a wrapping the wrong keychain entry turns into junk still counts as locked", async (t) => {
  const appData = folder(t);
  const oldKeys = keychain(LEGACY_NAME);
  const { data } = earlierFolder(appData, { wrapWith: oldKeys });
  const before = JSON.parse(readFileSync(join(data, "vault.json"), "utf8"));
  // Now and then decrypting with the wrong key doesn't fail: it returns nonsense. This entry always does.
  const junky = { wrap: keychain("Botkins").wrap, unwrap: (wrapped) => keychain("Botkins").unwrap(wrapped) ?? "\u0000\u0013junk" };
  assert.equal(isKey("\u0000\u0013junk"), false);
  assert.equal(isKey(oldKeys.unwrap(before.key.data)), true);
  assert.equal(isKey(Buffer.alloc(32, 1).toString("base64url")), true, "the link's key is written without padding");
  assert.equal(isKey(Buffer.alloc(31, 1).toString("base64")), false);
  const locked = lockedKeys(data, junky.unwrap);
  assert.equal(locked.length, 2, "both keys are seen as locked, so the helper is asked");
  // With what the helper opened, the junk never wins.
  const opened = new Map(locked.map((wrapped) => [wrapped, oldKeys.unwrap(wrapped)]));
  const keys = keyStore(junky, opened);
  assert.equal(keys.unwrap(before.key.data), oldKeys.unwrap(before.key.data));
  const vault = new Vault(data, keys);
  assert.equal(vault.locked, false);
  assert.equal(vault.get("vault:crm-key"), "sk-live-123");
  // Without the helper the vault is locked, not opened with nonsense, and its file is as it was.
  const alone = folder(t);
  const again = earlierFolder(alone, { wrapWith: oldKeys });
  const file = readFileSync(join(again.data, "vault.json"), "utf8");
  assert.equal(new Vault(again.data, keyStore(junky)).locked, true);
  assert.equal(readFileSync(join(again.data, "vault.json"), "utf8"), file);
});

test("the vault's own wrapping is written again when it is lost, or when an earlier build saved the vault", (t) => {
  const appData = folder(t);
  const oldKeys = keychain(LEGACY_NAME);
  const botkins = keychain("Botkins");
  const { data } = earlierFolder(appData, { wrapWith: oldKeys });
  // Only the vault is looked at here.
  rmSync(join(data, "link"), { recursive: true });
  const read = () => JSON.parse(readFileSync(join(data, "vault.json"), "utf8"));
  const original = read().key.data;
  const helped = () => keyStore(botkins, new Map([[original, oldKeys.unwrap(original)]]));
  new Vault(data, helped());
  assert.ok(botkins.unwrap(read().key.botkins));

  // "Botkins Safe Storage" is removed from the keychain: the app gets a new entry that opens nothing old.
  const fresh = keychain("Botkins2");
  assert.deepEqual(lockedKeys(data, fresh.unwrap), [original], "the helper is asked again");
  const repaired = new Vault(data, keyStore(fresh, new Map([[original, oldKeys.unwrap(original)]])));
  assert.equal(repaired.get("vault:crm-key"), "sk-live-123");
  assert.equal(read().key.data, original);
  assert.ok(fresh.unwrap(read().key.botkins), "its own wrapping is written under the new entry");
  assert.deepEqual(lockedKeys(data, fresh.unwrap), [], "and the next start needs no help");

  // An earlier installation saves the vault the way it always did: one wrapping, its own, in `data`.
  const file = read();
  const rewrapped = oldKeys.wrap(oldKeys.unwrap(original));
  writeFileSync(join(data, "vault.json"), JSON.stringify({ version: 1, key: { by: "os", data: rewrapped }, entries: file.entries }));
  assert.deepEqual(lockedKeys(data, botkins.unwrap), [rewrapped]);
  const back = new Vault(data, keyStore(botkins, new Map([[rewrapped, oldKeys.unwrap(rewrapped)]])));
  assert.equal(back.get("vault:crm-key"), "sk-live-123");
  assert.equal(read().key.data, rewrapped, "what the earlier build wrote stays");
  assert.ok(botkins.unwrap(read().key.botkins));

  // The same class under the earlier name (a stand-in for that build) opens the vault and changes nothing in the file.
  const untouched = readFileSync(join(data, "vault.json"), "utf8");
  assert.equal(new Vault(data, oldKeys).get("vault:crm-key"), "sk-live-123");
  assert.equal(readFileSync(join(data, "vault.json"), "utf8"), untouched);
});

test("a helper that never answers is given up on, and the app goes on", async () => {
  const killed = [];
  // It ignores the signal and never closes, as a process stuck behind the keychain's question does.
  const stuck = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = (signal) => killed.push(signal);
    child.stdin.resume();
    return child;
  };
  const started = Date.now();
  const opened = await openWithEarlierKeychain(["d3JhcHBlZA=="], { launch: stuck, timeoutMs: 40 });
  assert.equal(opened.size, 0);
  assert.deepEqual(killed, ["SIGKILL"]);
  assert.ok(Date.now() - started < 2000, "it does not wait for the helper to end");
});
