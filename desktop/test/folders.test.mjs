// The folder browser for a window that can't show the system's folder chooser (desktop/folders.mjs):
// what it lists, where it stops, and which paths it accepts. Everything is in the test's own
// temporary folders; the person's home folder is never read.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tempDir } from "./fake-copilot.mjs";
import { FOLDERS, Folders, MAX_FOLDERS } from "../desktop/folders.mjs";

/** A made-up home folder, a made-up place for plugged-in disks, and a browser over them. */
function rig(t, platform = "darwin") {
  const base = realpathSync(tempDir(t));
  const home = join(base, "home");
  const volumes = join(base, "volumes");
  const outside = join(base, "elsewhere");
  for (const dir of [
    "home/Documents/Reports/2026",
    "home/Documents/.drafts",
    "home/Projects/garden",
    "home/Library/Application Support",
    "home/.ssh",
    "home/apps/Tool.app/Contents",
    "volumes/Backup/Photos",
    "volumes/.hidden-disk",
    "elsewhere/secrets",
  ])
    mkdirSync(join(base, dir), { recursive: true });
  writeFileSync(join(home, "notes.txt"), "a file");
  writeFileSync(join(home, "Documents", "plan.md"), "a file");
  // Links: one to a folder inside the home folder, one out of it, one to a file, and the system's disk among the disks.
  symlinkSync(join(home, "Projects", "garden"), join(home, "garden-link"));
  symlinkSync(outside, join(home, "way-out"));
  symlinkSync(join(home, "notes.txt"), join(home, "notes-link"));
  symlinkSync("/", join(volumes, "System Disk"));
  return { base, home, volumes, outside, folders: new Folders({ home, platform, volumes: [volumes] }) };
}
const names = (listing) => listing.folders.map((folder) => folder.name);

test("the home folder lists its folders, and only those a person would pick from", async (t) => {
  const { folders, home } = rig(t);
  assert.equal(FOLDERS, "folders-v1");
  const top = await folders.list();
  assert.equal(top.path, home);
  assert.equal(top.parent, null, "nothing is above the home folder");
  assert.deepEqual(names(top), ["apps", "Documents", "garden-link", "Projects"], "no file, no hidden folder, no Library, no link that leads out or to a file");
  assert.deepEqual(top.folders.find((folder) => folder.name === "garden-link").path, join(home, "Projects", "garden"), "a link is listed as the folder it leads to");
  assert.deepEqual(top.roots, [{ name: "Home", path: home }, { name: "Backup", path: join(home, "..", "volumes", "Backup").replace("/home/..", "") }]);
  for (const same of [undefined, null, "", home]) assert.deepEqual(names(await folders.list(same)), names(top));
});

test("going down and up, and a plugged-in disk as a place of its own", async (t) => {
  const { folders, home, volumes } = rig(t);
  const documents = await folders.list(join(home, "Documents"));
  assert.deepEqual([documents.parent, names(documents)], [home, ["Reports"]], "a hidden folder inside is left out, and so is a file");
  const reports = await folders.list(join(home, "Documents", "Reports"));
  assert.deepEqual([reports.parent, names(reports)], [join(home, "Documents"), ["2026"]]);
  assert.deepEqual(names(await folders.list(join(home, "Documents", "Reports", "2026"))), []);
  const disk = await folders.list(join(volumes, "Backup"));
  assert.deepEqual([disk.parent, names(disk)], [null, ["Photos"]], "a disk's own top has nothing above it");
  assert.deepEqual((await folders.roots()).map((root) => root.name), ["Home", "Backup"], "the system's own disk and a hidden one are not places");
  // A folder that is an app is still a folder here: it is only named, never opened.
  assert.deepEqual(names(await folders.list(join(home, "apps"))), ["Tool.app"]);
});

test("a path that the browser could not have shown is refused, in words", async (t) => {
  const { folders, home, outside, base, volumes } = rig(t);
  const refused = async (path, why) => assert.rejects(folders.list(path), why, String(path)).then(() => assert.rejects(folders.allowed(path), why, String(path)));
  await refused(outside, /Only folders in your home folder or on a plugged-in disk/);
  await refused(join(outside, "secrets"), /Only folders in your home folder/);
  await refused(base, /Only folders in your home folder/);
  await refused("/", /Only folders in your home folder/);
  await refused("/etc", /Only folders in your home folder|doesn't exist/);
  await refused(volumes, /Only folders in your home folder/);
  await refused(join(home, "way-out"), /Only folders in your home folder/);
  await refused(join(home, "way-out", "secrets"), /Only folders in your home folder/);
  await refused(join(home, "Documents", "..", "..", "elsewhere"), /Only folders in your home folder/);
  await refused(join(home, ".ssh"), /Hidden folders can't be chosen/);
  await refused(join(home, "Documents", ".drafts"), /Hidden folders can't be chosen/);
  await refused(join(home, "Library"), /Hidden folders can't be chosen/);
  await refused(join(home, "Library", "Application Support"), /Hidden folders can't be chosen/);
  await refused(join(home, "notes.txt"), /doesn't exist on the computer/);
  await refused(join(home, "nowhere"), /doesn't exist on the computer/);
  for (const bad of ["Documents", "~/Documents", "", "\0", 5, null, {}]) await assert.rejects(folders.allowed(bad), /Choose a folder|doesn't exist/, String(bad));
  // What is accepted comes back as the real path, with the place it is in.
  assert.deepEqual(await folders.allowed(join(home, "garden-link")), { path: join(home, "Projects", "garden"), root: { name: "Home", path: home } });
  assert.equal((await folders.allowed(join(volumes, "Backup", "Photos"))).root.name, "Backup");
});

test("another system: a Library folder is an ordinary folder off the Mac, and Linux disks are one folder down", async (t) => {
  const { folders, home, base } = rig(t, "linux");
  assert.ok(names(await folders.list()).includes("Library"));
  mkdirSync(join(base, "media", "someone", "USB stick", "Music"), { recursive: true });
  const linux = new Folders({ home, platform: "linux", volumes: [join(base, "media")] });
  assert.deepEqual((await linux.roots()).map((root) => root.name), ["Home", "USB stick"]);
  assert.deepEqual(names(await linux.list(join(base, "media", "someone", "USB stick"))), ["Music"]);
  // A system with no place for disks has the home folder and nothing else.
  assert.deepEqual(Object.keys(await new Folders({ home, platform: "win32", volumes: [] }).list()).sort(), ["folders", "parent", "path"]);
});

test("a very full folder is cut off and says so, and a folder that can't be read says why", async (t) => {
  const { folders, home } = rig(t);
  for (let i = 0; i < MAX_FOLDERS + 5; i++) mkdirSync(join(home, "Projects", "many", "folder " + String(i).padStart(3, "0")), { recursive: true });
  const many = await folders.list(join(home, "Projects", "many"));
  assert.deepEqual([many.folders.length, many.more, many.folders[0].name, many.folders.at(-1).name], [MAX_FOLDERS, true, "folder 000", "folder " + (MAX_FOLDERS - 1)]);
  assert.equal((await folders.list(join(home, "Projects"))).more, undefined);
  // The system holding the answer back (its own question on the computer's screen) is said, not waited out.
  const waiting = new Folders({ home, volumes: [], waitMs: 30, read: () => new Promise(() => {}) });
  await assert.rejects(waiting.list(join(home, "Documents")), /still deciding whether Botkins may look in “Documents”.*answer on the computer/);
  // And a folder the system keeps closed says where that is changed.
  const closed = new Folders({ home, volumes: [], read: async () => Promise.reject(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })) });
  await assert.rejects(closed.list(join(home, "Documents")), /hasn't let Botkins look in “Documents”.*Files and Folders/);
  const broken = new Folders({ home, volumes: [], read: async () => Promise.reject(new Error("EIO")) });
  await assert.rejects(broken.list(join(home, "Documents")), /That folder can't be read\./);
});
