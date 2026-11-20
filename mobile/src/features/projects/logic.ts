// A project's plain logic, as the computer's app reads it: how a bot came to use it (its
// src/access.ts; the rules themselves are in src/features/bots/projectAccess.ts) and how a to-do
// moves among the open ones (its src/Projects.tsx). No React Native imports, so
// tests/schedules.test.ts runs it.
import type { Bot, ChatMode, Preferences, Project, ProjectTodo } from "@/link/types";
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
