import { existsSync, lstatSync, readlinkSync, rmdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import brand from "./brand.json" with { type: "json" };

export const APP_NAME = brand.name;
/** The app's earlier name: the name of an existing data folder and of its keychain entry. */
export const LEGACY_NAME = brand.previousName;

/** Read the current environment setting first, including on an upgraded installation. */
export function env(name, source = process.env) {
  // An empty value counts as not set, so an empty new spelling never hides the old one.
  return source["BOTKINS_" + name] || source[LEGACY_NAME.toUpperCase() + "_" + name] || undefined;
}

/** True when a folder holds a workspace: the app has run there. */
export const hasWorkspace = (dir) => existsSync(join(dir, "data", "workspace.json"));

/**
 * The folder for the app's data (Electron's "userData").
 * @param appData   The per-user application data folder (~/Library/Application Support, %APPDATA%).
 * @param override  A folder named by BOTKINS_DATA_DIR, which tests and smokes use.
 * @returns { dir, from }: `from` is "override", "botkins" (the app's own folder, new or in use)
 *   or "earlier" (a folder from before the rename, kept in use).
 */
export function dataHome({ appData, override }) {
  if (override) return { dir: override, from: "override" };
  const own = join(appData, APP_NAME);
  const earlier = join(appData, LEGACY_NAME);
  // The app's own folder wins once it holds a workspace. Until then an earlier folder that holds one is used.
  if (!hasWorkspace(own) && hasWorkspace(earlier)) return { dir: earlier, from: "earlier" };
  return { dir: own, from: "botkins" };
}

/** True when the process with this id is running. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // No such process means gone; "not permitted" means it is there and someone else's.
    return error.code === "EPERM";
  }
}

/**
 * An earlier workspace stays at its original path so saved links and bookmarks keep working.
 * Give it a Botkins entry point without creating a path named after an earlier build.
 * Fresh installations use a regular Botkins directory.
 */
export function adoptFolder({ appData, platform = process.platform, running = alive, link = symlinkSync }) {
  const own = join(appData, APP_NAME);
  const earlier = join(appData, LEGACY_NAME);
  if (hasWorkspace(own)) return "none";
  let stat;
  try {
    stat = lstatSync(earlier);
  } catch {
    return "none";
  }
  // Previous upgrades may already have left a link beside the current folder.
  if (stat.isSymbolicLink() || !stat.isDirectory() || !hasWorkspace(earlier)) return "none";
  // Chromium's lock in the folder names the process that has it open ("<host>-<pid>").
  try {
    const pid = Number(/-(\d+)$/.exec(readlinkSync(join(earlier, "SingletonLock")))?.[1]);
    if (pid && pid !== process.pid && running(pid)) return "busy";
  } catch {
    // No lock: nothing has it open.
  }
  if (existsSync(own)) {
    // An empty folder (a crashed first start can leave one) is no one's data. Anything else is left alone.
    try {
      rmdirSync(own);
    } catch {
      return "taken";
    }
  }
  try {
    link(earlier, own, platform === "win32" ? "junction" : "dir");
    return "linked";
  } catch {
    return "failed";
  }
}
