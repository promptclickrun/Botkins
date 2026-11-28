// Pure logic for the desktop Projects screen redesign: Channels-style Overview index,
// Chats/Artifacts grouping, search filtering, and 20-item paging.
// No DOM/React imports or relative runtime imports without extension so desktop/test/*.test.mjs runs it directly.
import type { Artifact, Bot, Chat, Panel, Project, State } from "./types";

export const PROJECT_PAGE_SIZE = 20;
export const PROJECT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type ProjectChatStatus = "needs-you" | "working" | null;

export function chatActiveStatus(
  state: Pick<State, "requests" | "streams">,
  chatId: string,
): ProjectChatStatus {
  if (state.requests?.some((r) => r.chatId === chatId)) return "needs-you";
  if (state.streams?.[chatId] !== undefined) return "working";
  return null;
}

function desktopJobStage(state: Pick<State, "requests" | "streams">, chat: Chat): string {
  const job = chat.job;
  if (!job) return "finished";
  if (job.state === "brought-in") return "brought-in";
  if (job.state === "removed") return "closed";
  if (state.requests?.some((r) => r.chatId === chat.id)) return "needs-you";
  if (state.streams?.[chat.id] !== undefined) return "working";
  if (job.setup === "waiting" || job.setup === "running") return "setting-up";
  if (job.setup === "failed") return "setup-failed";
  return "finished";
}

function desktopAccessVia(state: Pick<State, "settings">, bot: Bot, project: Project): "" | "everyone" | "all" | "project" {
  if (state.settings.access?.allBots !== false) return "everyone";
  const all = bot.access?.all === true;
  const projects = bot.access?.projects ?? [];
  if (all) return "all";
  if (projects.includes(project.id)) return "project";
  return "";
}

export function folderLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
}

export function filterProjectChats<C extends Pick<Chat, "title" | "botId" | "botIds">>(
  chats: C[],
  query: string,
  botName: (botId: string) => string | undefined = () => undefined,
): C[] {
  const words = query.trim().toLowerCase();
  if (!words) return chats;
  return chats.filter((c) => {
    if ((c.title || "").toLowerCase().includes(words)) return true;
    const ids = c.botIds?.length ? c.botIds : [c.botId];
    return ids.some((id) => (botName(id) ?? "").toLowerCase().includes(words));
  });
}

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

export function pageItems<T>(items: T[], limit = PROJECT_PAGE_SIZE): { visible: T[]; older: number } {
  const safeLimit = Math.max(PROJECT_PAGE_SIZE, limit);
  const visible = items.slice(0, safeLimit);
  return { visible, older: Math.max(0, items.length - visible.length) };
}

export type ChatTimeBucket = "active" | "week" | "earlier";
export type ChatBucketGroup<C> = { key: ChatTimeBucket; title: string; chats: C[] };

export function groupProjectChats<C extends Pick<Chat, "id" | "time" | "title" | "botId" | "botIds">>(
  chats: C[],
  state: Pick<State, "requests" | "streams">,
  options: {
    query?: string;
    botName?: (botId: string) => string | undefined;
    now?: number;
    limit?: number;
  } = {},
): { groups: ChatBucketGroup<C>[]; total: number; shown: number; older: number } {
  const { query = "", botName = () => undefined, now = Date.now(), limit = PROJECT_PAGE_SIZE } = options;
  const filtered = filterProjectChats(chats, query, botName);
  const cutoff = now - PROJECT_WEEK_MS;

  const active: C[] = [];
  const week: C[] = [];
  const earlier: C[] = [];

  const sorted = [...filtered].sort((a, b) => b.time - a.time);
  for (const chat of sorted) {
    if (chatActiveStatus(state, chat.id)) active.push(chat);
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

export async function confirmAndRemoveProjectArtifact(
  ask: (options: { title: string; body: string; confirm: string; danger: true }) => Promise<string | null>,
  remove: (projectId: string, artifactId: string) => Promise<unknown>,
  project: Pick<Project, "id" | "name">,
  item: Pick<Artifact, "id" | "name">,
): Promise<boolean> {
  const ok = await ask({
    title: "Remove from " + project.name + "?",
    body: item.name + " stays in its chat and on the computer.",
    confirm: "Remove",
    danger: true,
  });
  if (!ok) return false;
  await remove(project.id, item.id);
  return true;
}

export type DesktopIndexRowKey = "jobs" | "todos" | "chats" | "artifacts" | "panels" | "changes" | "access" | "folders";
export type DesktopIndexTarget = "jobs" | "todos" | "chats" | "artifacts" | "panels" | "changes" | "access" | "overview";

export type DesktopIndexRow = {
  key: DesktopIndexRowKey;
  target: DesktopIndexTarget;
  title: string;
  subtitle?: string;
  count?: number;
  badge?: { label: string; tone: "accent" | "warning" };
};

export type DesktopIndexInput = {
  state: Pick<State, "bots" | "chats" | "panels" | "spaces" | "settings" | "requests" | "streams">;
  project: Project;
  artifacts?: Pick<Artifact, "id" | "name" | "time">[];
  changedFiles?: number | null;
  features: {
    jobs: boolean;
    artifacts: boolean;
    spaces: boolean;
    changes: boolean;
  };
  now?: number;
};

export type DesktopIndexModel = {
  recentChat: Chat | null;
  work: DesktopIndexRow[];
  files: DesktopIndexRow[];
  settings: DesktopIndexRow[];
};

function accessSubtitle(state: Pick<State, "bots" | "settings">, project: Project): string {
  if (state.settings.access?.allBots !== false) return "All bots";
  const allowed = state.bots.filter((b: Bot) => !!desktopAccessVia(state, b, project));
  if (allowed.length === 0) return "No bots";
  if (allowed.length === state.bots.length && state.bots.length > 0) return "All bots";
  if (allowed.length <= 3) return allowed.map((b) => b.name).join(", ");
  return allowed.slice(0, 2).map((b) => b.name).join(", ") + ` +${allowed.length - 2}`;
}

export function buildDesktopProjectIndex(input: DesktopIndexInput): DesktopIndexModel {
  const { state, project, artifacts, changedFiles, features, now = Date.now() } = input;
  const chats = state.chats
    .filter((c) => c.projectId === project.id && !c.archived)
    .sort((a, b) => b.time - a.time);
  const recentChat = chats[0] ?? null;

  const work: DesktopIndexRow[] = [];
  if (features.jobs) {
    const jobs = chats.filter((c) => !!c.job).sort((a, b) => (b.job?.createdAt ?? 0) - (a.job?.createdAt ?? 0));
    let running = 0;
    let needsYou = 0;
    for (const job of jobs) {
      const stage = desktopJobStage(state, job);
      if (stage === "working" || stage === "setting-up") running++;
      else if (stage === "needs-you" || stage === "setup-failed") needsYou++;
    }
    const activeCount = running + needsYou;
    const newest = jobs[0];
    work.push({
      key: "jobs",
      target: "jobs",
      title: "Jobs",
      subtitle: newest ? newest.title || "Job" : "None yet",
      count: activeCount === 0 && jobs.length > 0 ? jobs.length : undefined,
      badge: activeCount > 0 ? { label: `${activeCount} running`, tone: needsYou > 0 && running === 0 ? "warning" : "accent" } : undefined,
    });
  }

  const openTodos = project.todos.filter((t) => !t.done);
  const doneTodos = project.todos.filter((t) => t.done);
  work.push({
    key: "todos",
    target: "todos",
    title: "To-dos",
    subtitle: openTodos.length > 0 ? `Next: ${openTodos[0]!.text}` : doneTodos.length > 0 ? "All done" : "None yet",
    count: openTodos.length,
  });

  const cutoff = now - PROJECT_WEEK_MS;
  const activeThisWeek = chats.filter((c) => !!chatActiveStatus(state, c.id) || c.time >= cutoff).length;
  work.push({
    key: "chats",
    target: "chats",
    title: "Chats",
    subtitle:
      chats.length === 0
        ? "No chats yet"
        : activeThisWeek > 0
          ? `${activeThisWeek} active this week`
          : "None this week",
    count: chats.length,
  });

  const files: DesktopIndexRow[] = [];
  if (features.artifacts) {
    const totalArtifacts = artifacts ? artifacts.length : (project.artifacts?.length ?? 0);
    const newest = artifacts?.[0];
    files.push({
      key: "artifacts",
      target: "artifacts",
      title: "Artifacts",
      subtitle: newest ? newest.name : totalArtifacts === 0 ? "None attached" : `${totalArtifacts} ${totalArtifacts === 1 ? "artifact" : "artifacts"}`,
      count: totalArtifacts,
    });
  }

  const attachedSpaces = features.spaces
    ? (state.spaces ?? []).filter((s) => s.projectId === project.id)
    : [];
  const projectPanels = (state.panels ?? []).filter((p: Panel) => p.projectId === project.id);
  const spaceAndPanelCount = attachedSpaces.length + projectPanels.length;
  const firstSpaceOrPanel = attachedSpaces[0]?.name || projectPanels[0]?.title;
  files.push({
    key: "panels",
    target: "panels",
    title: features.spaces ? "Spaces" : "Panels",
    subtitle: firstSpaceOrPanel || (features.spaces ? "None attached" : "No panels yet"),
    count: spaceAndPanelCount,
  });

  if (features.changes) {
    files.push({
      key: "changes",
      target: "changes",
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

  const folders = project.folders?.length ? project.folders : project.folder ? [project.folder] : [];
  const settings: DesktopIndexRow[] = [
    {
      key: "access",
      target: "access",
      title: "Who can use it",
      subtitle: accessSubtitle(state, project),
    },
    {
      key: "folders",
      target: "overview",
      title: "Folders",
      subtitle: folders.length > 0 ? folderLabel(folders[0]!) : "No folder",
      count: folders.length > 0 ? folders.length : undefined,
    },
  ];

  return { recentChat, work, files, settings };
}
