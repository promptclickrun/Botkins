// A project's jobs ("project-jobs-v1"), as plain logic: where each job stands, the line over the feed, and
// the batch the person is writing. The same words as the computer's src/jobs.ts. No React Native imports,
// so tests/project-jobs.test.ts runs it.
import type { AgentRequest, ChatSummary } from "@/link/types";

export type JobStage = "setting-up" | "setup-failed" | "working" | "needs-you" | "finished" | "brought-in" | "closed";

type Live = { requests: Pick<AgentRequest, "chatId">[]; streams: Record<string, unknown> } | undefined;

/** Where a job's chat stands: the person's turn first, then the bot's, then the job's own state. */
export function jobStage(live: Live, chat: Pick<ChatSummary, "id" | "job">): JobStage {
  const job = chat.job;
  if (!job) return "finished";
  if (job.state === "brought-in") return "brought-in";
  if (job.state === "removed") return "closed";
  if (live?.requests.some((request) => request.chatId === chat.id)) return "needs-you";
  if (live && chat.id in live.streams) return "working";
  if (job.setup === "waiting" || job.setup === "running") return "setting-up";
  if (job.setup === "failed") return "setup-failed";
  return "finished";
}

export const STAGE_LABELS: Record<JobStage, string> = {
  "setting-up": "Setting up",
  "setup-failed": "Setup failed",
  working: "Working",
  "needs-you": "Needs you",
  finished: "Finished",
  "brought-in": "Brought in",
  closed: "Closed",
};

/** A project's jobs, newest first. */
export const projectJobs = <C extends Pick<ChatSummary, "projectId" | "job" | "archived">>(chats: C[], projectId: string): C[] =>
  chats.filter((chat) => chat.projectId === projectId && chat.job && !chat.archived).sort((a, b) => b.job!.createdAt - a.job!.createdAt);

/** The line over the feed: "2 working · 1 needs you · 3 finished". */
export function jobCounts(live: Live, chats: Pick<ChatSummary, "id" | "job">[]): string {
  const count = { working: 0, needs: 0, finished: 0 };
  for (const chat of chats) {
    const stage = jobStage(live, chat);
    if (stage === "working" || stage === "setting-up") count.working++;
    else if (stage === "needs-you" || stage === "setup-failed") count.needs++;
    else if (stage === "finished") count.finished++;
  }
  return [count.working && count.working + " working", count.needs && count.needs + " need" + (count.needs === 1 ? "s" : "") + " you", count.finished && count.finished + " finished"].filter(Boolean).join(" · ");
}

/** A path's last part, for "botkins · main @ 6bff0b4". */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** One prompt of the batch, with the bots it goes to. */
export type Draft = { id: number; prompt: string; botIds: string[] };
/** The drafts that will start (a prompt and a bot), and how many jobs that is. */
export function launchable(drafts: Draft[]) {
  const ready = drafts.filter((draft) => draft.prompt.trim() && draft.botIds.length);
  return { ready, jobs: ready.reduce((n, draft) => n + draft.botIds.length, 0) };
}
/** A bot tapped on a draft: on or off, but never none; in the checkout, only that one. */
export function toggleBot(draft: Draft, botId: string, single: boolean): string[] {
  if (single) return [botId];
  const has = draft.botIds.includes(botId);
  if (has && draft.botIds.length === 1) return draft.botIds;
  return has ? draft.botIds.filter((id) => id !== botId) : [...draft.botIds, botId];
}
/** "Start job", "Start 3 jobs". */
export const launchLabel = (jobs: number) => (jobs > 1 ? "Start " + jobs + " jobs" : "Start job");
