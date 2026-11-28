// A project's plain logic, as the computer's app reads it: how a bot came to use it (its
// src/access.ts; the rules themselves are in src/features/bots/projectAccess.ts), how a to-do
// moves among the open ones, and the Channels-style project index + subpage grouping/search/paging.
// No React Native imports, so tests/projects.test.ts and tests/schedules.test.ts run it.
import type { AgentRequest, Artifact, Bot, ChatMode, ChatSummary, Panel, Preferences, Project, ProjectTodo, SpaceSummary } from "@/link/types";
import { globalAccess, grantOf } from "../bots/projectAccess";
import { jobStage, type JobStage } from "./jobLogic";

export const PAGE_SIZE = 20;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

// ---- Channels-style project index + subpage list helpers ------------------------------------

export type ProjectLive = {
  requests: Pick<AgentRequest, "chatId">[];
  streams: Record<string, unknown>;
  active?: string[];
} | undefined;

export type ChatActiveStatus = "needs-you" | "working" | null;

/** Whether a chat is currently active (needs the person, or a bot is working in it). */
export function chatActiveStatus(live: ProjectLive, chatId: string): ChatActiveStatus {
  if (!live) return null;
  if (live.requests.some((request) => request.chatId === chatId)) return "needs-you";
  if (chatId in live.streams || live.active?.includes(chatId)) return "working";
  return null;
}

/** A project's non-archived chats, newest first. */
export function projectChats<C extends Pick<ChatSummary, "id" | "projectId" | "archived" | "time">>(
  chats: C[],
  projectId: string,
): C[] {
  return chats.filter((chat) => chat.projectId === projectId && !chat.archived).sort((a, b) => b.time - a.time);
}

/** Filter chats by search query (title or bot name). */
export function filterProjectChats<C extends Pick<ChatSummary, "title" | "botId">>(
  chats: C[],
  query: string,
  botName: (botId: string) => string | undefined = () => undefined,
): C[] {
  const words = query.trim().toLowerCase();
  if (!words) return chats;
  return chats.filter(
    (chat) =>
      (chat.title || "").toLowerCase().includes(words) ||
      (botName(chat.botId) ?? "").toLowerCase().includes(words),
  );
}

/** Filter artifacts by search query (name, chatTitle, or bot name). */
export function filterProjectArtifacts<A extends Pick<Artifact, "name" | "chatTitle" | "botId">>(
  items: A[],
  query: string,
  botName: (botId: string) => string | undefined = () => undefined,
): A[] {
  const words = query.trim().toLowerCase();
  if (!words) return items;
  return items.filter(
    (item) =>
      (item.name || "").toLowerCase().includes(words) ||
      (item.chatTitle || "").toLowerCase().includes(words) ||
      (botName(item.botId) ?? "").toLowerCase().includes(words),
  );
}

/** Slice a list to `shown` items (defaulting to PAGE_SIZE) and report how many older items remain. */
export function pageItems<T>(items: T[], limit = PAGE_SIZE): { visible: T[]; older: number } {
  const safeLimit = Math.max(PAGE_SIZE, limit);
  const visible = items.slice(0, safeLimit);
  return { visible, older: Math.max(0, items.length - visible.length) };
}

export type ChatTimeBucket = "active" | "week" | "earlier";
export type ChatBucketGroup<C> = { key: ChatTimeBucket; title: string; chats: C[] };

/**
 * Group a project's chats for the Chats subpage:
 * 1) "Active" (working or needs you), newest first
 * 2) "This week" (updated within the last 7 days, not active), newest first
 * 3) "Earlier" (older than 7 days, not active), newest first
 *
 * Paging applies across the flattened ordered list so the screen shows `limit` items first
 * (default 20) and returns `older` for "Show N older".
 */
export function groupProjectChats<C extends Pick<ChatSummary, "id" | "time" | "title" | "botId">>(
  chats: C[],
  live: ProjectLive,
  options: {
    query?: string;
    botName?: (botId: string) => string | undefined;
    now?: number;
    limit?: number;
  } = {},
): { groups: ChatBucketGroup<C>[]; total: number; shown: number; older: number } {
  const { query = "", botName = () => undefined, now = Date.now(), limit = PAGE_SIZE } = options;
  const filtered = filterProjectChats(chats, query, botName);
  const cutoff = now - WEEK_MS;

  const active: C[] = [];
  const week: C[] = [];
  const earlier: C[] = [];

  const sorted = [...filtered].sort((a, b) => b.time - a.time);
  for (const chat of sorted) {
    if (chatActiveStatus(live, chat.id)) active.push(chat);
    else if (chat.time >= cutoff) week.push(chat);
    else earlier.push(chat);
  }

  const ordered = [...active, ...week, ...earlier];
  const { visible, older } = pageItems(ordered, limit);
  const visibleSet = new Set(visible);

  const groups: ChatBucketGroup<C>[] = [];
  const visibleActive = active.filter((c) => visibleSet.has(c));
  const visibleWeek = week.filter((c) => visibleSet.has(c));
  const visibleEarlier = earlier.filter((c) => visibleSet.has(c));

  if (visibleActive.length) groups.push({ key: "active", title: "Active", chats: visibleActive });
  if (visibleWeek.length) groups.push({ key: "week", title: "This week", chats: visibleWeek });
  if (visibleEarlier.length) groups.push({ key: "earlier", title: "Earlier", chats: visibleEarlier });

  return { groups, total: ordered.length, shown: visible.length, older };
}

/** Order jobs with running/active jobs first ("needs-you", "working", "setting-up", "setup-failed"), then newest first. */
const RUNNING_JOB_STAGES = new Set<JobStage>(["needs-you", "working", "setting-up", "setup-failed"]);

export function isRunningJobStage(stage: JobStage): boolean {
  return RUNNING_JOB_STAGES.has(stage);
}

export function orderJobsRunningFirst<C extends Pick<ChatSummary, "id" | "job">>(
  jobs: C[],
  live: ProjectLive,
): C[] {
  return [...jobs].sort((a, b) => {
    const aRun = isRunningJobStage(jobStage(live, a)) ? 0 : 1;
    const bRun = isRunningJobStage(jobStage(live, b)) ? 0 : 1;
    if (aRun !== bRun) return aRun - bRun;
    return (b.job?.createdAt ?? 0) - (a.job?.createdAt ?? 0);
  });
}

// ---- Index rows (visibility, subtitles, counts, badges) -------------------------------------

export type ProjectIndexKey = "jobs" | "todos" | "chats" | "artifacts" | "spaces" | "changes" | "access" | "folders";
export type ProjectIndexGroupKey = "work" | "files" | "settings";

export type ProjectIndexRow = {
  key: ProjectIndexKey;
  group: ProjectIndexGroupKey;
  title: string;
  subtitle?: string;
  count?: number;
  badge?: { label: string; tone: "accent" | "warning" };
};

export type ProjectIndexInput = {
  project: Pick<Project, "id" | "todos" | "folder" | "folders" | "artifacts">;
  chats: Pick<ChatSummary, "id" | "projectId" | "archived" | "time" | "title" | "botId" | "job">[];
  live: ProjectLive;
  bots: Pick<Bot, "id" | "name" | "access">[];
  settings: Pick<Preferences, "access"> | undefined;
  /** Optional loaded artifacts (newest first) for the newest artifact name subtitle. */
  artifacts?: Pick<Artifact, "id" | "name" | "time">[];
  spaces?: Pick<SpaceSummary, "id" | "name" | "projectId">[];
  panels?: Pick<Panel, "id" | "title" | "projectId">[];
  /** Number of uncommitted changed files when known, or null if not fetched yet. */
  changedFiles?: number | null;
  features: {
    jobs: boolean;
    artifacts: boolean;
    spaces: boolean;
    changes: boolean;
  };
  now?: number;
};

export type ProjectIndexModel = {
  recentChat: ProjectIndexInput["chats"][number] | null;
  work: ProjectIndexRow[];
  files: ProjectIndexRow[];
  settings: ProjectIndexRow[];
};

function accessSubtitle(
  settings: Pick<Preferences, "access"> | undefined,
  bots: Pick<Bot, "id" | "name" | "access">[],
  project: Pick<Project, "id">,
): string {
  if (globalAccess(settings)) return "All bots";
  const allowed = bots.filter((bot) => !!accessVia(settings, bot as Bot, project));
  if (allowed.length === 0) return "No bots";
  if (allowed.length === bots.length && bots.length > 0) return "All bots";
  if (allowed.length <= 3) return allowed.map((bot) => bot.name).join(", ");
  return allowed.slice(0, 2).map((bot) => bot.name).join(", ") + ` +${allowed.length - 2}`;
}

export function buildProjectIndex(input: ProjectIndexInput): ProjectIndexModel {
  const { project, chats, live, bots, settings, artifacts, spaces = [], panels = [], changedFiles, features, now = Date.now() } = input;
  const mine = projectChats(chats, project.id);
  const recentChat = mine[0] ?? null;

  // Work group
  const work: ProjectIndexRow[] = [];
  if (features.jobs) {
    const jobs = mine.filter((c) => !!c.job).sort((a, b) => (b.job?.createdAt ?? 0) - (a.job?.createdAt ?? 0));
    let running = 0;
    let needsYou = 0;
    for (const job of jobs) {
      const stage = jobStage(live, job);
      if (stage === "working" || stage === "setting-up") running++;
      else if (stage === "needs-you" || stage === "setup-failed") needsYou++;
    }
    const activeCount = running + needsYou;
    const newest = jobs[0];
    work.push({
      key: "jobs",
      group: "work",
      title: "Jobs",
      subtitle: newest ? newest.title || "Job" : "None yet",
      count: activeCount === 0 && jobs.length > 0 ? jobs.length : undefined,
      badge: activeCount > 0 ? { label: `${activeCount} running`, tone: needsYou > 0 && running === 0 ? "warning" : "accent" } : undefined,
    });
  }

  const { open, done } = orderedTodos(project.todos);
  work.push({
    key: "todos",
    group: "work",
    title: "To-dos",
    subtitle: open.length > 0 ? `Next: ${open[0]!.text}` : done.length > 0 ? "All done" : "None yet",
    count: open.length,
  });

  const cutoff = now - WEEK_MS;
  const activeThisWeek = mine.filter((chat) => !!chatActiveStatus(live, chat.id) || chat.time >= cutoff).length;
  work.push({
    key: "chats",
    group: "work",
    title: "Chats",
    subtitle:
      mine.length === 0
        ? "No chats yet"
        : activeThisWeek > 0
          ? `${activeThisWeek} active this week`
          : "None this week",
    count: mine.length,
  });

  // Files and views group
  const files: ProjectIndexRow[] = [];
  if (features.artifacts) {
    const totalArtifacts = artifacts ? artifacts.length : (project.artifacts?.length ?? 0);
    const newest = artifacts?.[0];
    files.push({
      key: "artifacts",
      group: "files",
      title: "Artifacts",
      subtitle: newest ? newest.name : totalArtifacts === 0 ? "None attached" : artifactCount(totalArtifacts),
      count: totalArtifacts,
    });
  }

  const attachedSpaces = features.spaces ? spaces.filter((s) => s.projectId === project.id) : [];
  const projectPanels = panels.filter((p) => p.projectId === project.id);
  const spaceAndPanelCount = attachedSpaces.length + projectPanels.length;
  const firstSpaceOrPanelName = attachedSpaces[0]?.name || projectPanels[0]?.title;
  files.push({
    key: "spaces",
    group: "files",
    title: features.spaces ? "Spaces" : "Panels",
    subtitle: firstSpaceOrPanelName || (features.spaces ? "None attached" : "No panels yet"),
    count: spaceAndPanelCount,
  });

  if (features.changes) {
    files.push({
      key: "changes",
      group: "files",
      title: "Changes",
      subtitle:
        typeof changedFiles === "number"
          ? changedFiles === 0
            ? "Working tree clean"
            : changedFiles === 1
              ? "1 file changed"
              : `${changedFiles} files changed`
          : "Review git diff",
    });
  }

  // Settings group
  const folders = project.folders?.length ? project.folders : project.folder ? [project.folder] : [];
  const settingsRows: ProjectIndexRow[] = [
    {
      key: "access",
      group: "settings",
      title: "Who can use it",
      subtitle: accessSubtitle(settings, bots, project),
    },
    {
      key: "folders",
      group: "settings",
      title: "Folders",
      subtitle: folders.length > 0 ? folderLabel(folders[0]!) : "No folder",
      count: folders.length > 0 ? folders.length : undefined,
    },
  ];

  return { recentChat, work, files, settings: settingsRows };
}

