// What the terminal host does as root, in and around the service user's data folder
// (desktop/terminal/update-install.mjs, manager.mjs). These run only as root, where they can
// really give rights up and plant links another user could not write through:
//
//   sudo env "PATH=$PATH" node --test test/terminal-root.test.mjs
//
// Anyone else's run skips them; test/terminal-install.test.mjs covers the same code without root.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serviceManager } from "../desktop/terminal/manager.mjs";
import { asOwnerOf, lastUpdateFile, notRootOwned, readLastUpdate, takeRequest, writeLastUpdate } from "../desktop/terminal/update-install.mjs";

const skip = process.getuid?.() !== 0 && "These need root.";
// Somebody who is not root, and owns nothing else on this machine.
const USER = 54321;
const tempDir = (t) => {
  // In the system's shared temporary folder, which everyone can pass through. (The one in
  // TMPDIR may be a person's own, closed to every other user: under sudo on a Mac it is.)
  const dir = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "bk-root-"));
  // Like /var/lib and /opt: root's, and open for others to pass through.
  chmodSync(dir, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const good = { at: "2026-01-03T00:00:00.000Z", from: "1.2.3", to: "1.3.0", ok: true };

test("root does its work in the data folder with the rights of the folder's owner, and has its own back afterwards", { skip }, (t) => {
  const dir = tempDir(t);
  const data = join(dir, "data");
  mkdirSync(join(data, "run"), { recursive: true });
  chownSync(data, USER, USER);
  chownSync(join(data, "run"), USER, USER);
  // A file only root may write, and a link to it under a name in the data folder.
  const secret = join(dir, "root-only.conf");
  writeFileSync(secret, "root's own\n", { mode: 0o600 });
  symlinkSync(secret, join(data, "planted"));
  const seen = asOwnerOf(data, () => {
    const who = { uid: process.geteuid(), gid: process.getegid(), groups: process.getgroups() };
    // With the owner's rights the link leads nowhere: the file behind it can't be written.
    assert.throws(() => writeFileSync(join(data, "planted"), "overwritten"), { code: "EACCES" });
    return who;
  });
  assert.deepEqual(seen, { uid: USER, gid: USER, groups: [USER] });
  assert.deepEqual([process.geteuid(), process.getegid()], [0, 0], "root's rights are back");
  assert.equal(readFileSync(secret, "utf8"), "root's own\n");
  // Also when the work throws.
  assert.throws(() => asOwnerOf(data, () => { throw new Error("stopped"); }), /stopped/);
  assert.equal(process.geteuid(), 0);
  // A folder that is root's own is worked in as root.
  assert.equal(asOwnerOf(dir, () => process.geteuid()), 0);
});

test("the request is taken up whatever is under its name, and what a link there points at is left alone", { skip }, (t) => {
  const dir = tempDir(t);
  const data = join(dir, "data");
  mkdirSync(join(data, "run"), { recursive: true });
  for (const path of [data, join(data, "run")]) chownSync(path, USER, USER);
  const request = join(data, "run", "update-requested");
  const kept = join(dir, "kept");
  mkdirSync(join(kept, "inside"), { recursive: true });
  writeFileSync(join(kept, "inside", "file"), "root's\n");
  // A link to a folder of root's: the link goes, the folder and what is in it stay.
  symlinkSync(kept, request);
  assert.equal(takeRequest(data), true);
  assert.equal(existsSync(request), false);
  assert.equal(readFileSync(join(kept, "inside", "file"), "utf8"), "root's\n");
  // A folder with things in it, which a plain removal would stop at.
  asOwnerOf(data, () => {
    mkdirSync(join(request, "deep"), { recursive: true });
    writeFileSync(join(request, "deep", "file"), "x");
  });
  assert.equal(takeRequest(data), true);
  assert.equal(existsSync(request), false);
  // `run` itself made a link to a folder of root's: nothing in that folder is removed.
  rmSync(join(data, "run"), { recursive: true });
  writeFileSync(join(kept, "update-requested"), "root's\n");
  symlinkSync(kept, join(data, "run"));
  takeRequest(data);
  assert.equal(readFileSync(join(kept, "update-requested"), "utf8"), "root's\n", "the owner's rights don't reach it");
});

test("the install record goes only into a folder that is root's own, and through no link", { skip }, (t) => {
  const dir = tempDir(t);
  const installRoot = join(dir, "opt");
  mkdirSync(installRoot, { mode: 0o755 });
  const victim = join(dir, "victim.conf");
  for (const name of [lastUpdateFile(installRoot) + ".tmp", lastUpdateFile(installRoot)]) {
    writeFileSync(victim, "the system's own file\n", { mode: 0o600 });
    rmSync(name, { force: true });
    symlinkSync(victim, name);
    assert.equal(writeLastUpdate(installRoot, good, { top: dir }), true);
    assert.equal(readFileSync(victim, "utf8"), "the system's own file\n");
    assert.deepEqual([statSync(victim).uid, statSync(victim).mode & 0o777], [0, 0o600], "neither its owner nor its mode changed");
    assert.deepEqual(readLastUpdate(installRoot), good);
  }
  assert.deepEqual([lstatSync(lastUpdateFile(installRoot)).uid, lstatSync(lastUpdateFile(installRoot)).mode & 0o777], [0, 0o644]);
  // A folder somebody else owns, or could write to, gets no record from root at all.
  const theirs = join(dir, "theirs");
  mkdirSync(theirs);
  chownSync(theirs, USER, USER);
  assert.equal(writeLastUpdate(theirs, good, { top: dir }), false);
  const loose = join(dir, "loose");
  mkdirSync(loose);
  chmodSync(loose, 0o777);
  assert.equal(writeLastUpdate(loose, good, { top: dir }), false);
  assert.equal(existsSync(lastUpdateFile(theirs)) || existsSync(lastUpdateFile(loose)), false);
  // A folder that is root's own under one that somebody else can write to: they could put
  // another folder under its name between the look and the write, so nothing is written.
  const under = join(loose, "botkins");
  mkdirSync(under, { mode: 0o755 });
  assert.equal(writeLastUpdate(under, good, { top: dir }), false);
  assert.equal(existsSync(lastUpdateFile(under)), false);
  // Without a place to stop, the look goes to the top of the disk: the shared temporary folder this test is in is everybody's.
  rmSync(lastUpdateFile(installRoot));
  assert.equal(writeLastUpdate(installRoot, good), false);
  assert.equal(existsSync(lastUpdateFile(installRoot)), false);
});

test("the installer and the updater agree on which install folder is root's alone", { skip }, (t) => {
  const dir = tempDir(t);
  // The installer's own look, from install/install.sh, run as it is.
  const look = /^not_roots_own\(\) \{\n[\s\S]*?\n\}$/m.exec(readFileSync(new URL("../install/install.sh", import.meta.url), "utf8"))[0];
  const installer = (path) => execFileSync("sh", ["-c", "set -eu\n" + look + '\nnot_roots_own "$1"', "sh", path], { encoding: "utf8" }).trim();
  const make = (path, uid, mode) => {
    mkdirSync(path, { recursive: true });
    chownSync(path, uid, uid);
    chmodSync(path, mode);
    return path;
  };
  // Root's own all the way down from the test's folder: both say so (each names the shared temporary folder above it, and nothing below).
  const good = make(join(dir, "opt", "botkins"), 0, 0o755);
  assert.equal(notRootOwned(good, dir), null);
  assert.ok(!installer(good).startsWith(dir + "/"), installer(good));
  // Each way a folder on the way can be somebody else's to change: theirs, or open to a group, or open to everyone (as GitHub's runners have /opt).
  for (const [name, uid, mode] of [["theirs", USER, 0o755], ["group", 0, 0o775], ["everyone", 0, 0o777], ["sticky", 0, 0o1777]]) {
    const parent = make(join(dir, name), uid, mode);
    const under = make(join(parent, "botkins"), 0, 0o755);
    assert.equal(notRootOwned(under, dir).path, parent, name);
    assert.equal(installer(under), parent, name);
    // And when Botkins' own folder is not there yet.
    assert.equal(installer(join(parent, "not", "there", "yet")), parent, name);
  }
  // The install folder itself being theirs.
  const own = make(join(dir, "opt", "own"), USER, 0o755);
  assert.equal(notRootOwned(own, dir).path, own);
  assert.equal(installer(own), own);
});

test("installing the service again follows no link a bot's tool left in the data folder", { skip }, async (t) => {
  const root = tempDir(t);
  const dataDir = root + "/var/lib/botkins";
  mkdirSync(dataDir, { recursive: true });
  chownSync(dataDir, USER, USER);
  // The home folder was replaced by a link to a folder of root's.
  const system = join(root, "etc-like");
  mkdirSync(system, { mode: 0o755 });
  symlinkSync(system, dataDir + "/home");
  const run = async (file, args) => ({ code: 0, stdout: file === "id" ? USER + "\n" : "", stderr: "", args });
  await serviceManager({ command: ["/opt/botkins/current/bin/botkins"], platform: "linux", uid: 0, env: {}, run, root }).install({ start: false });
  assert.deepEqual([statSync(system).uid, statSync(system).mode & 0o777], [0, 0o755], "what the link points at is still root's, with its mode");
  assert.equal(lstatSync(dataDir + "/home").isSymbolicLink(), true);
  // The data folder as a link is refused outright.
  const odd = tempDir(t);
  mkdirSync(odd + "/var/lib", { recursive: true });
  symlinkSync(system, odd + "/var/lib/botkins");
  await assert.rejects(serviceManager({ command: ["/opt/botkins/current/bin/botkins"], platform: "linux", uid: 0, env: {}, run, root: odd }).install({ start: false }), /is not a folder/);
  assert.deepEqual([statSync(system).uid, statSync(system).mode & 0o777], [0, 0o755]);
});

/** The whole computer's service, really installed as root into a folder that stands in for "/": its data folder is another user's. */
async function installedIn(root, options = {}) {
  const calls = [];
  const run = async (file, args) => (calls.push([file, ...args].join(" ")), { code: 0, stdout: file === "id" ? USER + "\n" : file === "systemctl" && args[0] === "is-enabled" ? "enabled\n" : "", stderr: "" });
  const manager = serviceManager({ command: ["/opt/botkins/current/bin/botkins"], platform: "linux", env: {}, run, root, pause: async () => {} });
  await manager.install({ start: false, ...options });
  calls.length = 0;
  return { manager, calls };
}
const UNITS = "/etc/systemd/system/";
/** Every name in a folder with what it is, to see afterwards that nothing in it changed. */
const listing = (dir) => readdirSync(dir).sort().map((name) => { const at = lstatSync(join(dir, name)); return [name, at.uid, at.mode, at.isSymbolicLink() ? "link" : at.isDirectory() ? "folder" : "file", at.mtimeMs].join(" "); });

test("an update's new service files are root's own, and writing them touches nothing in the data folder", { skip }, async (t) => {
  const root = tempDir(t);
  const { manager, calls } = await installedIn(root, { allowPaths: ["/srv/projects"] });
  const data = root + "/var/lib/botkins";
  assert.equal(statSync(data).uid, USER);
  // What a bot's tool could have left in the data folder: links under the service files' names, to a file only root may write.
  const secret = join(root, "root-only.conf");
  writeFileSync(secret, "root's own\n", { mode: 0o600 });
  for (const name of ["botkins.service", "botkins-update.path", "install.json", "etc"]) symlinkSync(secret, join(data, name));
  const before = listing(data);
  // The files as an earlier version wrote them.
  const unit = root + UNITS + "botkins.service";
  const fresh = readFileSync(unit, "utf8");
  writeFileSync(unit, fresh.replace("\nProtectClock=true\n", "\n"));
  writeFileSync(root + UNITS + "botkins-update.service", readFileSync(root + UNITS + "botkins-update.service", "utf8").replace("UMask=0022\n", ""));
  const saved = manager.snapshot();
  const result = await manager.refresh();
  assert.deepEqual(result.changed, [UNITS + "botkins.service", UNITS + "botkins-update.service"]);
  assert.equal(readFileSync(unit, "utf8"), fresh);
  assert.match(fresh, /^User=botkins$/m);
  assert.match(fresh, /^ReadWritePaths=\/var\/lib\/botkins \/srv\/projects$/m);
  // Each new file, and the copy of what it replaced, is root's own; and nothing is left of the writing.
  for (const path of result.changed.flatMap((path) => [path, path + ".bak"])) assert.deepEqual([lstatSync(root + path).isFile(), statSync(root + path).uid, statSync(root + path).mode & 0o777], [true, 0, 0o644], path);
  assert.deepEqual(readdirSync(root + UNITS).sort(), ["botkins-update.path", "botkins-update.service", "botkins-update.service.bak", "botkins.service", "botkins.service.bak"]);
  assert.deepEqual(listing(data), before, "nothing in the data folder was made, changed or removed");
  assert.equal(readFileSync(secret, "utf8"), "root's own\n");
  assert.ok(!calls.some((call) => call.includes(data) || /restart botkins|stop/.test(call)), calls.join("; "));
  // And putting them back, as an update that is undone does.
  assert.equal(await manager.restore(saved), true);
  assert.equal(readFileSync(unit, "utf8"), fresh.replace("\nProtectClock=true\n", "\n"));
  assert.deepEqual([statSync(unit).uid, statSync(unit).mode & 0o777], [0, 0o644]);
  assert.deepEqual(listing(data), before);
  assert.equal(readFileSync(secret, "utf8"), "root's own\n");
});

test("a link under a service file's name is not written through, by the new files or by putting the old ones back", { skip }, async (t) => {
  const root = tempDir(t);
  const { manager } = await installedIn(root);
  const victim = join(root, "victim.conf");
  writeFileSync(victim, "the system's own file\n", { mode: 0o600 });
  // The update watch, masked or replaced by a link: it is not the service's file any more.
  const watch = root + UNITS + "botkins-update.path";
  const saved = manager.snapshot();
  assert.ok(UNITS + "botkins-update.path" in saved.files);
  rmSync(watch);
  symlinkSync(victim, watch);
  const unit = root + UNITS + "botkins.service";
  writeFileSync(unit, readFileSync(unit, "utf8").replace("\nProtectClock=true\n", "\n"));
  // A link under the name of the copy that is kept, too: it is replaced, and what it pointed at is left alone.
  symlinkSync(victim, unit + ".bak");
  assert.deepEqual((await manager.refresh()).changed, [UNITS + "botkins.service"]);
  assert.equal(lstatSync(unit + ".bak").isFile(), true);
  assert.equal(lstatSync(watch).isSymbolicLink(), true);
  assert.equal(readFileSync(victim, "utf8"), "the system's own file\n");
  assert.deepEqual([statSync(victim).uid, statSync(victim).mode & 0o777], [0, 0o600]);
  assert.ok(!(UNITS + "botkins-update.path" in manager.snapshot().files), "a link is no file of the service's");
  // Putting back what was there before the link: the link itself is replaced, and what it pointed at is left alone.
  await manager.restore(saved);
  assert.equal(lstatSync(watch).isFile(), true);
  assert.equal(readFileSync(victim, "utf8"), "the system's own file\n");
  assert.deepEqual([statSync(victim).uid, statSync(victim).mode & 0o777], [0, 0o600]);
});
