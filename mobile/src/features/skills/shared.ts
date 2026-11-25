// Reading a skill for display.
import type { SkillInfo } from "@/link/types";

/** "weekly-review" → "Weekly review". */
export function readableName(name: string) {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const isBuiltIn = (skill: SkillInfo) => skill.origin === "built-in";
/** A slash command that runs a script on the computer with no model ("script-commands-v1"). No bot is given it as a skill. */
export const isScript = (skill: SkillInfo) => skill.command === "script";
/** The skills that a bot can have or leave out: a script command is typed by the person, never read by a bot. */
export const botSkills = (skills: SkillInfo[]) => skills.filter((skill) => !isScript(skill));
export const canEdit = (skill: SkillInfo) => !isBuiltIn(skill) && skill.editable !== false;

type Folder = { id: string; path: string };

/** The last part of a folder's path: "/Users/me/skills/" → "skills". */
export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** Where a skill comes from, as the desktop labels it: Botkins, Built in, or its linked folder's name. */
export function skillOrigin(skill: SkillInfo, folders: Folder[] = []) {
  if (skill.origin === "built-in") return "Built in";
  if (isScript(skill)) return "Script command";
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

/** The longest script that the computer keeps (the same as a routine's). */
export const SCRIPT_LIMIT = 20000;

/** A command's name as it is typed in the field: lower case, words joined by hyphens, no slash. */
export const scriptName = (value: string) => value.toLowerCase().replace(/^\/+/, "").replace(/[^a-z0-9-]+/g, "-");

export type ScriptDraft = { name: string; description: string; script: string };

/** What is missing or too long in a script command, in the words the editor shows. The computer checks it again, and the names that a command can't take. */
export function scriptProblems(draft: ScriptDraft): Partial<Record<keyof ScriptDraft, string>> {
  const name = draft.name.trim();
  return {
    ...(!name ? { name: "Give the command a name." } : !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? { name: "Use lowercase letters, numbers and dashes." } : {}),
    ...(!draft.description.trim() ? { description: "Say what it does." } : draft.description.trim().length > 600 ? { description: "Use up to 600 characters." } : {}),
    ...(!draft.script.trim() ? { script: "Write the script." } : draft.script.length > SCRIPT_LIMIT ? { script: "A script can have up to 20,000 characters." } : {}),
  };
}
