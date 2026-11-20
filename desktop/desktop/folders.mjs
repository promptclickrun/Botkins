// Folders of this computer, for a window that can't show the system's folder chooser: a paired
// phone, or another computer using this one (the calls `listFolders`, `addProjectFolder` and
// `addSkillFolderAt`, capability "folders-v1").
//
// A folder chooser on the computer shows the person their own disk. This one shows a paired
// device the names of folders, so it shows as little as picking a folder needs:
//
//   - folders only: never a file, never anything inside a file;
//   - inside the person's home folder, or on a disk that is plugged in (roots()); nothing of the
//     system, and nothing above those places;
//   - no hidden folder (a name that starts with a dot, and the home folder's Library on a Mac),
//     neither listed nor accepted when a path is sent by hand;
//   - a link is followed only when it leads to a folder inside the same place;
//   - a few hundred names at most (`more` says there were more).
//
// `allowed(path)` is the same rule for a path that is being chosen: the calls that take a folder
// from a paired device accept only a folder this browser could have shown.
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

export const FOLDERS = "folders-v1";
export const MAX_FOLDERS = 400;
/** How long a folder may take to list. macOS can hold the first look into Documents until the person answers its question. */
const WAIT_MS = 5000;

const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const hidden = (name) => name.startsWith(".");
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
const timed = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), ms)))]).finally(() => clearTimeout(timer));
};

export class Folders {
  /**
   * @param options.home      The folder the browser starts in (the person's home folder).
   * @param options.platform  For tests: another system's rules.
   * @param options.volumes   For tests: where plugged-in disks are found, instead of the system's own places.
   * @param options.read      For tests: async (path) => the folder's entries, instead of reading the disk.
   */
  constructor({ home = homedir(), platform = process.platform, volumes, waitMs = WAIT_MS, read = (path) => readdir(path, { withFileTypes: true }) } = {}) {
    Object.assign(this, { home, platform, waitMs, read });
    this.volumes = volumes ?? (platform === "darwin" ? ["/Volumes"] : platform === "linux" ? ["/media", "/run/media", "/mnt"] : []);
  }
  /**
   * The places a person may browse: the home folder, then each disk that is plugged in. The disk
   * the system itself is on is not one of them (on a Mac it is listed among the disks as a link to "/").
   */
  async roots() {
    const home = await realpath(this.home).catch(() => this.home);
    const out = [{ name: "Home", path: home }];
    const add = async (path, depth) => {
      const names = await timed(readdir(path, { withFileTypes: true }), WAIT_MS).catch(() => []);
      for (const entry of names) {
        if (hidden(entry.name) || out.length > 40) continue;
        const full = join(path, entry.name);
        const real = await realpath(full).catch(() => null);
        // A disk is a folder of its own: not the system's disk under another name, and not the home folder again.
        if (!real || real === sep || within(home, real) || !(await stat(real).then((s) => s.isDirectory(), () => false))) continue;
        // Linux keeps a person's disks one folder down (/media/<user>/<disk>).
        if (depth > 0 && this.platform === "linux" && path !== "/mnt") await add(real, depth - 1);
        else if (!out.some((root) => root.path === real)) out.push({ name: entry.name, path: real });
      }
    };
    for (const place of this.volumes) await add(place, 1);
    return out;
  }
  /**
   * A folder that may be browsed or chosen, as its real path, with the place it is in. Anything
   * else is refused in words: not a folder, outside the home folder and the plugged-in disks, or hidden.
   */
  async allowed(path) {
    if (typeof path !== "string" || !path || path.includes("\0") || !isAbsolute(path)) throw new Error("Choose a folder.");
    let real;
    try {
      real = await realpath(path);
      if (!(await stat(real)).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new Error("That folder doesn't exist on the computer.");
    }
    const root = (await this.roots()).find((place) => within(real, place.path));
    if (!root) throw new Error("Only folders in your home folder or on a plugged-in disk can be chosen from here. Choose another folder, or choose this one on the computer itself.");
    const below = real.slice(root.path.length).split(sep).filter(Boolean);
    if (below.some(hidden) || (this.platform === "darwin" && root.name === "Home" && below[0] === "Library")) throw new Error("Hidden folders can't be chosen from here. Choose this one on the computer itself.");
    return { path: real, root };
  }
  /**
   * The folders inside a folder: { path, parent, folders: [{ name, path }], more?, roots? }.
   * Without a path it is the home folder. `parent` is null at the top of a place; `roots` lists the
   * places there are when there is more than the home folder.
   */
  async list(path) {
    const { path: at, root } = await this.allowed(path === undefined || path === null || path === "" ? this.home : path);
    let entries;
    try {
      entries = await timed(this.read(at), this.waitMs);
    } catch (error) {
      if (error?.code === "ETIMEDOUT") throw new Error("The computer is still deciding whether Botkins may look in “" + basename(at) + "”. If it is asking, answer on the computer, then try again.");
      if (error?.code === "EPERM" || error?.code === "EACCES") throw new Error("The computer hasn't let Botkins look in “" + basename(at) + "”. On a Mac, allow it under System Settings › Privacy & Security › Files and Folders.");
      throw new Error("That folder can't be read.");
    }
    const folders = [];
    for (const entry of entries) {
      if (hidden(entry.name) || (this.platform === "darwin" && root.name === "Home" && at === root.path && entry.name === "Library")) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) folders.push({ name: entry.name, path: full });
      else if (entry.isSymbolicLink()) {
        // A link counts when it leads to a folder inside the same place; the folder is listed under the link's name.
        const real = await realpath(full).catch(() => null);
        if (real && within(real, root.path) && (await stat(real).then((s) => s.isDirectory(), () => false))) folders.push({ name: entry.name, path: real });
      }
    }
    folders.sort(byName);
    const roots = await this.roots();
    return {
      path: at,
      parent: at === root.path ? null : dirname(at),
      folders: folders.slice(0, MAX_FOLDERS),
      ...(folders.length > MAX_FOLDERS && { more: true }),
      ...(roots.length > 1 && { roots }),
    };
  }
}

/**
 * The arguments of an app call that came from a paired device, with any folder in them checked:
 * a project's folder set from a device (`createProject`, `updateProject`) must be one the browser
 * could have shown, as for the calls that pick a folder. Other calls pass as they are.
 */
export async function deviceArgs(folders, name, args) {
  if (name === "plugins.addFolder" || (name === "plugins.addMarketplace" && typeof args[0] === "string" && isAbsolute(args[0]))) return [(await folders.allowed(args[0])).path];
  if (name === "updateProject" && args[1] && typeof args[1] === "object" && args[1].folder) return [args[0], { ...args[1], folder: (await folders.allowed(args[1].folder)).path }, ...args.slice(2)];
  if (name === "createProject" && args[0] && typeof args[0] === "object" && args[0].folder) return [{ ...args[0], folder: (await folders.allowed(args[0].folder)).path }, ...args.slice(1)];
  return args;
}
