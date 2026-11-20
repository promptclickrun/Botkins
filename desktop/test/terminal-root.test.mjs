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
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
