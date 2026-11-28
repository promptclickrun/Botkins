// A project's plain logic, as the computer's app reads it: how a bot came to use it (its
// src/access.ts; the rules themselves are in src/features/bots/projectAccess.ts) and how a to-do
// moves among the open ones (its src/Projects.tsx). No React Native imports, so
// tests/schedules.test.ts runs it.
import type { Bot, ChatMode, ChatSummary, Preferences, Project, ProjectTodo } from "@/link/types";
import { globalAccess, grantOf } from "../bots/projectAccess";

/** How a bot may use a project: "everyone" (all bots may), "all" (this bot has every project), "project" (granted here), or "" (it may not). */
export function accessVia(settings: Pick<Preferences, "access"> | undefined, bot: Bot, project: Pick<Project, "id">): "" | "everyone" | "all" | "project" {
  if (globalAccess(settings)) return "everyone";
  const grant = grantOf(bot);
  if (grant.all) return "all";
  if (grant.projects.includes(project.id)) return "project";
  return "";
}

/** The desktop's words for each way. */
export const ACCESS_REASON: Record<ReturnType<typeof accessVia>, string> = {
  everyone: "All bots have access",
  all: "Has all projects",
  project: "Granted for this project",
  "": "No access",
};

/** The modes of a chat in a project with a folder, in the desktop's words. */
export const MODES: { value: ChatMode; label: string; hint: string }[] = [
  { value: "default", label: "Default", hint: "Asks before risky commands." },
  { value: "plan", label: "Plan", hint: "Writes a plan first. Changes no code." },
  { value: "yolo", label: "YOLO", hint: "Runs commands without asking." },
];

/** Open to-dos in their stored order (the order bots and the person keep), then done ones, newest first. */
export function orderedTodos(todos: ProjectTodo[]) {
  const open = todos.filter((todo) => !todo.done);
  const done = todos.filter((todo) => todo.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return { open, done };
}

/**
 * How many single moves (`moveTodo` takes one place at a time) take an open to-do past the next open
 * one up (-1) or down (1), skipping done ones in the stored order. 0 when it is already at that end.
 */
export function moveSteps(todos: ProjectTodo[], todoId: string, delta: -1 | 1): number {
  let index = todos.findIndex((todo) => todo.id === todoId);
  if (index < 0) return 0;
  let steps = 0;
  do {
    index += delta;
    steps++;
  } while (index >= 0 && index < todos.length && todos[index]!.done);
  return index < 0 || index >= todos.length ? 0 : steps;
}

/**
 * The chats "Add a chat…" offers for a project: ordinary chats and groups that are not in it
 * yet, newest first, narrowed by what was typed. Not an archived chat, a routine's or a panel's; and
 * no group chat for a project with a folder (a group takes text only). `inProject` names the project
 * a chat would move out of.
 */
export function addableChats(
  chats: ChatSummary[],
  project: Pick<Project, "id" | "folder">,
  projects: Pick<Project, "id" | "name">[],
  query = "",
  botName: (botId: string) => string | undefined = () => undefined,
): { chat: ChatSummary; inProject?: string }[] {
  const words = query.trim().toLowerCase();
  return chats
    .filter((chat) => chat.projectId !== project.id && !chat.archived && !chat.panelId && !chat.schedules?.some((schedule) => schedule.routine))
    .filter((chat) => !(project.folder && chat.botIds && chat.botIds.length > 1))
    .filter((chat) => !words || (chat.title || "").toLowerCase().includes(words) || (botName(chat.botId) ?? "").toLowerCase().includes(words))
    .sort((a, b) => b.time - a.time)
    .map((chat) => {
      const from = chat.projectId ? projects.find((item) => item.id === chat.projectId)?.name : undefined;
      return from ? { chat, inProject: from } : { chat };
    });
}

/** "3 artifacts", "1 artifact", or the empty line. */
export const artifactCount = (count: number) => (count === 0 ? "Nothing attached yet." : count === 1 ? "1 artifact" : count + " artifacts");

/** A folder as a chip says it: its last two parts ("Code/botkins-ios"), or the whole path when it is short. */
export function folderLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
}
