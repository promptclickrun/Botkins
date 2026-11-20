// Who may use which project: the phone's copy of the computer's rules (desktop/access.mjs there),
// for labels and for greying out a choice. The computer enforces them. No React Native imports, so
// tests/bots-chats.test.ts runs it.
import type { Bot, BotAccessGrant, Preferences, Project } from "@/link/types";

export const grantOf = (bot: Pick<Bot, "access">): BotAccessGrant => ({ all: bot.access?.all === true, projects: bot.access?.projects ?? [] });

/** Settings › Access: every bot can use every project (the default). */
export const globalAccess = (settings: Pick<Preferences, "access"> | undefined) => settings?.access?.allBots !== false;

export function canUseProject(settings: Pick<Preferences, "access"> | undefined, bot: Pick<Bot, "access">, project: Pick<Project, "id">) {
  if (globalAccess(settings)) return true;
  const grant = grantOf(bot);
  return grant.all || grant.projects.includes(project.id);
}

/** A bot's grant in a few words: "Every project", "All projects", "2 projects", "No projects". */
export function grantSummary(settings: Pick<Preferences, "access"> | undefined, bot: Pick<Bot, "access">, projects: Pick<Project, "id">[]) {
  if (globalAccess(settings)) return "Every project";
  const grant = grantOf(bot);
  if (grant.all) return "All projects";
  const count = grant.projects.filter((id) => projects.some((project) => project.id === id)).length;
  return count ? count + (count === 1 ? " project" : " projects") : "No projects";
}

/** The grant after one project is switched on or off. */
export function toggleProject(grant: BotAccessGrant, id: string, on: boolean): BotAccessGrant {
  return { ...grant, projects: on ? [...new Set([...grant.projects, id])] : grant.projects.filter((x) => x !== id) };
}

/**
 * Why a chat with these bots can't work in a project, in the desktop's words, or "" when it can.
 * A group chat is text only, so it can't use a project with a folder.
 */
export function projectBlock(settings: Pick<Preferences, "access"> | undefined, bots: Pick<Bot, "access" | "name">[], project: Pick<Project, "id" | "folder">, group: boolean) {
  const blocked = bots.filter((bot) => !canUseProject(settings, bot, project));
  if (blocked.length) return blocked.map((bot) => bot.name).join(", ") + " can't use it";
  if (group && project.folder) return "has a folder; group chats are text only";
  return "";
}

/** Projects by name, as the computer lists them. */
export const sortedProjects = <P extends Pick<Project, "name">>(projects: P[] | undefined) => [...(projects ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

/** The chat modes a project with a folder offers, in the desktop's words. */
export const MODE_LABELS = {
  default: { label: "Default", hint: "Asks before risky commands." },
  plan: { label: "Plan", hint: "Writes a plan first. Changes no code." },
  yolo: { label: "YOLO", hint: "Runs commands without asking." },
} as const;
