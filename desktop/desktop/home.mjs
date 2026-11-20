// The app's name, where it keeps a person's data, and what stays from when it was called Commander.
//
// Data. Botkins keeps everything under one folder in the per-user application data folder, named
// "Botkins". Someone who used the app when it was called Commander has a "Commander" folder
// there. That folder is given the new name once (adoptFolder): it is renamed where it is, in one
// step, with nothing copied, and a link named "Commander" is left pointing at it. A bot works in
// <folder>/data/files/<bot> and sees that path in everything it does, so a folder still called
// Commander kept telling the bots they were in an app of that name. The link keeps every path
// that was saved under the old name working: a file a chat mentions, an earlier version of the
// app, anything a person bookmarked.
//
// What the move costs: Claude Code and OpenCode find a conversation again by the folder it was
// started in, so a chat that one of them ran continues from Botkins' own copy of the conversation
// instead of theirs. Nothing a person sees is lost. The folder is not renamed while another copy
// of the app is running on it, or when a "Botkins" folder with anything in it is already there;
// the app then goes on using the folder where it is, as before.
//
// Environment variables. BOTKINS_<NAME> is read first, then COMMANDER_<NAME>, the earlier spelling.
import { existsSync, lstatSync, readlinkSync, renameSync, rmdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export const APP_NAME = "Botkins";
/** The app's earlier name: the name of an existing data folder and of its keychain entry. */
export const LEGACY_NAME = "Commander";

/** An environment variable by its short name: env("DATA_DIR") reads BOTKINS_DATA_DIR, else COMMANDER_DATA_DIR. */
export function env(name, source = process.env) {
  // An empty value counts as not set, so an empty new spelling never hides the old one.
  return source["BOTKINS_" + name] || source["COMMANDER_" + name] || undefined;
}

/** True when a folder holds a workspace: the app has run there. */
export const hasWorkspace = (dir) => existsSync(join(dir, "data", "workspace.json"));

/**
 * The folder for the app's data (Electron's "userData").
 * @param appData   The per-user application data folder (~/Library/Application Support, %APPDATA%).
 * @param override  A folder named by BOTKINS_DATA_DIR, which tests and smokes use.
 * @returns { dir, from }: `from` is "override", "botkins" (the app's own folder, new or in use)
 *   or "commander" (a folder from before the rename, kept in use).
 */
export function dataHome({ appData, override }) {
  if (override) return { dir: override, from: "override" };
  const own = join(appData, APP_NAME);
  const earlier = join(appData, LEGACY_NAME);
  // The app's own folder wins once it holds a workspace. Until then an earlier folder that holds one is used.
  if (!hasWorkspace(own) && hasWorkspace(earlier)) return { dir: earlier, from: "commander" };
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
 * Gives a data folder from before the rename the app's name: "Commander" becomes "Botkins", and a
 * link named "Commander" is left pointing at it. One rename, nothing copied. Does nothing when
 * there is no earlier folder with a workspace, when a Botkins folder with anything in it exists,
 * or while an app is running on the earlier folder.
 * @returns "moved", or why not: "none", "taken", "busy" or "failed".
 */
export function adoptFolder({ appData, platform = process.platform, running = alive, rename = renameSync }) {
  const own = join(appData, APP_NAME);
  const earlier = join(appData, LEGACY_NAME);
  let stat;
  try {
    stat = lstatSync(earlier);
  } catch {
    return "none";
  }
  // A link is what this leaves behind: the move is done.
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
    rename(earlier, own);
  } catch {
    return "failed";
  }
  try {
    // A junction on Windows needs no special rights.
    symlinkSync(own, earlier, platform === "win32" ? "junction" : "dir");
  } catch {
    // Without the link the data is still whole, under its new name.
  }
  return "moved";
}
