// Reading a skill for display.
import type { SkillInfo } from "@/link/types";

/** "weekly-review" → "Weekly review". */
export function readableName(name: string) {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const isBuiltIn = (skill: SkillInfo) => skill.origin === "built-in";
export const canEdit = (skill: SkillInfo) => !isBuiltIn(skill) && skill.editable !== false;

type Folder = { id: string; path: string };

/** The last part of a folder's path: "/Users/me/skills/" → "skills". */
export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** Where a skill comes from, as the desktop labels it: Botkins, Built in, or its linked folder's name. */
export function skillOrigin(skill: SkillInfo, folders: Folder[] = []) {
  if (skill.origin === "built-in") return "Built in";
  if (skill.origin !== "folder") return "Botkins";
  const folder = folders.find((item) => item.id === skill.folderId);
  return folder ? folderName(folder.path) : "Linked folder";
}

/** The desktop shows a filter above the list once there are more than this many skills. */
export const FILTER_FROM = 8;

/** The skills whose name, description or origin hold the words typed. */
export function filterSkills(skills: SkillInfo[], query: string, folders: Folder[] = []) {
  const words = query.trim().toLowerCase();
  if (!words) return skills;
  return skills.filter((skill) => (skill.name + " " + readableName(skill.name) + " " + skill.description + " " + skillOrigin(skill, folders)).toLowerCase().includes(words));
}

/** How many skills came from a linked folder. */
export const skillsIn = (skills: SkillInfo[], folderId: string) => skills.filter((skill) => skill.folderId === folderId).length;
