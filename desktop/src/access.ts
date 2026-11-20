// The renderer's copy of desktop/access.mjs, for showing who can use what. The main process enforces it.
import type { Bot, BotAccessGrant, Chat, Project, State } from "./types";

export const grantOf = (bot: Bot): BotAccessGrant => ({
  all: bot.access?.all === true,
  projects: bot.access?.projects ?? [],
});
export const globalAccess = (state: State) => state.settings.access?.allBots !== false;

export function canUseProject(state: State, bot: Bot, project: Project) {
  if (globalAccess(state)) return true;
  const a = grantOf(bot);
  return a.all || a.projects.includes(project.id);
}
/** How a bot got access to a project, for labels: "", "everyone", "all" or "project". */
export function accessVia(state: State, bot: Bot, project: Project): "" | "everyone" | "all" | "project" {
  if (globalAccess(state)) return "everyone";
  const a = grantOf(bot);
  if (a.all) return "all";
  if (a.projects.includes(project.id)) return "project";
  return "";
}
/** The bots in a chat that can't use its project. */
export function blockedBots(state: State, chat: Chat): Bot[] {
  const project = chat.projectId ? state.projects?.find((p) => p.id === chat.projectId) : undefined;
  if (!project) return [];
  const ids = chat.botIds?.length ? chat.botIds : [chat.botId];
  return ids
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => !!b && !canUseProject(state, b, project));
}
/** A short summary of a bot's grant. */
export function grantSummary(state: State, bot: Bot) {
  if (globalAccess(state)) return "Every project";
  const a = grantOf(bot);
  if (a.all) return "All projects";
  const p = a.projects.filter((id) => state.projects?.some((x) => x.id === id)).length;
  return p ? p + (p === 1 ? " project" : " projects") : "No projects";
}
/** Asks the app shell to open a bot's page (from Settings, which has no navigation of its own). */
export function openBotPage(botId: string) {
  window.dispatchEvent(new CustomEvent("botkins-open-bot", { detail: botId }));
}
