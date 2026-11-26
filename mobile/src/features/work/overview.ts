// The plain logic of the Work tab's overview and the Tasks page: which tasks each chip shows and in
// what order, the routines that run next, a project's progress, and the day word beside a routine's
// time. No React Native imports, so tests/work-overview.test.ts runs it.
import type { BotTask, Project, TaskStatus } from "@/link/types";

/** The chips over the tasks: what is moving (or waiting on the person), what was put off, and what is done. */
export type TaskView = "active" | "later" | "done";

const VIEW_OF: Record<TaskStatus, TaskView> = { review: "active", blocked: "active", working: "active", ready: "active", later: "later", done: "done" };
/** Within Active: what needs the person first, then bot-reviewed tasks, then working, then ready. */
const STATUS_RANK: Record<TaskStatus, number> = { review: 0, blocked: 0, working: 2, ready: 3, later: 4, done: 5 };
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

type TaskLike = Pick<BotTask, "id" | "status" | "priority" | "updatedAt" | "reviewerBotId">;

const rankOf = (task: TaskLike) => (task.status === "review" && task.reviewerBotId ? 1 : STATUS_RANK[task.status as TaskStatus]);

/** Whether a task waits for the person rather than an orchestrating creator bot. */
export const taskNeedsPerson = (task: Pick<BotTask, "status" | "reviewerBotId">) =>
  task.status === "blocked" || (task.status === "review" && !task.reviewerBotId);

/** The tasks a chip shows, in order. Archived tasks show under none. Done is newest first; the others go by status, then priority, then the latest change. */
export function tasksIn<T extends TaskLike>(tasks: T[], view: TaskView): T[] {
  const shown = tasks.filter((task) => task.status !== "archived" && VIEW_OF[task.status as TaskStatus] === view);
  if (view === "done") return shown.sort((a, b) => b.updatedAt - a.updatedAt);
  return shown.sort(
    (a, b) => rankOf(a) - rankOf(b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt - a.updatedAt,
  );
}

/** How many tasks each chip holds. */
export function taskCounts(tasks: TaskLike[]): Record<TaskView, number> {
  const counts = { active: 0, later: 0, done: 0 };
  for (const task of tasks) if (task.status !== "archived") counts[VIEW_OF[task.status as TaskStatus]]++;
  return counts;
}

/** The Tasks page's Active chip in its groups, each already in order. */
export function activeGroups<T extends TaskLike>(tasks: T[]): { title: "Needs you" | "Reviewing" | "Working" | "Ready"; tasks: T[] }[] {
  const active = tasksIn(tasks, "active");
  return [
    { title: "Needs you" as const, tasks: active.filter((task) => taskNeedsPerson(task)) },
    { title: "Reviewing" as const, tasks: active.filter((task) => task.status === "review" && Boolean(task.reviewerBotId)) },
    { title: "Working" as const, tasks: active.filter((task) => task.status === "working") },
    { title: "Ready" as const, tasks: active.filter((task) => task.status === "ready") },
  ].filter((group) => group.tasks.length);
}

/** The routines that run next: on, with a next run, soonest first; at most `count`. */
export function upNext<R extends { entry: { enabled?: boolean; nextAt: number | null } }>(routines: R[], count: number): R[] {
  return routines
    .filter((routine) => routine.entry.enabled !== false && typeof routine.entry.nextAt === "number")
    .sort((a, b) => (a.entry.nextAt as number) - (b.entry.nextAt as number))
    .slice(0, count);
}

/** A project's to-dos as progress: how many are done of all, and the line under its name. */
export function projectProgress(project: Pick<Project, "todos">): { done: number; total: number; share: number; line: string } {
  const total = project.todos.length;
  const done = project.todos.filter((todo) => todo.done).length;
  return { done, total, share: total ? done / total : 0, line: total ? done + " of " + total + " to-dos" : "No to-dos yet" };
}

const DAY = 24 * 60 * 60 * 1000;
const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

/** The word under a routine's time in "Up next": "Today", "Tonight" (from 6 PM), "Tomorrow", a weekday within the week, else the date. */
export function dayWord(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(time) - startOfDay(now)) / DAY);
  if (days <= 0) return new Date(time).getHours() >= 18 ? "Tonight" : "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(time);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(time);
}
