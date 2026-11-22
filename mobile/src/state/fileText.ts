// The plain parts of handing files between the phone and the computer (see files.ts). No React
// Native imports, so the tests run it.
import type { FolderList, SharedFile } from "@/link/types";

/** The most a file picked on the phone may hold when it is read as text for the computer. */
export const MAX_PICKED_BYTES = 2 * 1024 * 1024;
export const TOO_BIG = "That file is too big to import (2 MB at most).";

/** A name the phone can save a file under: one name, no folders, nothing a file system refuses. */
export function cleanFileName(name: string, fallback = "Botkins file"): string {
  const last = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = last
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(-120);
  return clean || fallback;
}

export const isTextFile = (file: SharedFile): file is { name: string; text: string } => "text" in file;

/** A folder's own name, from its path on the computer (either kind of slash). */
export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** The place (the home folder, or a plugged-in disk) a folder is in: the longest root its path starts with. */
export function placeOf(list: Pick<FolderList, "path" | "roots">): string | undefined {
  const inside = (root: string) => list.path === root || list.path.startsWith(root.replace(/[\\/]+$/, "") + "/") || list.path.startsWith(root.replace(/[\\/]+$/, "") + "\\");
  return (list.roots ?? [])
    .filter((root) => inside(root.path))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;
}

/** What the skills page says after a folder was added, in the computer's own words. */
export function addedSkillsNote(result: { kind: "skill" | "plugin" | "folder"; name: string; count?: number; id?: string; enabled?: boolean }): string {
  if (result.kind === "skill") return "Added the skill " + result.name + ".";
  // A plugin folder is installed as a plugin, on (an older computer added it off).
  if (result.kind === "plugin") return "Added the plugin " + result.name + "." + (result.enabled === false ? " It is off until you turn it on." : "");
  const count = result.count ?? 0;
  return "Linked " + result.name + " (" + count + (count === 1 ? " skill" : " skills") + ").";
}
