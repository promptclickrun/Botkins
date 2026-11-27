// Jobs on a project's page (desktop/jobs.mjs): where each job stands, as the page and the phone show it.
import type { Chat, State } from "./types";

export type JobStage = "setting-up" | "setup-failed" | "working" | "needs-you" | "finished" | "brought-in" | "closed";

/** Where a job's chat stands: the person's turn first, then the bot's, then the job's own state. */
export function jobStage(state: Pick<State, "requests" | "streams">, chat: Chat): JobStage {
  const job = chat.job;
  if (!job) return "finished";
  if (job.state === "brought-in") return "brought-in";
  if (job.state === "removed") return "closed";
  if (state.requests?.some((request) => request.chatId === chat.id)) return "needs-you";
  if (state.streams?.[chat.id] !== undefined) return "working";
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
export const projectJobs = (state: Pick<State, "chats">, projectId: string) =>
  state.chats.filter((chat) => chat.projectId === projectId && chat.job && !chat.archived).sort((a, b) => b.job!.createdAt - a.job!.createdAt);

/** The line over the feed: "2 working · 1 needs you · 3 finished". */
export function jobCounts(state: Pick<State, "requests" | "streams">, chats: Chat[]) {
  const count = { working: 0, needs: 0, finished: 0 };
  for (const chat of chats) {
    const stage = jobStage(state, chat);
    if (stage === "working" || stage === "setting-up") count.working++;
    else if (stage === "needs-you" || stage === "setup-failed") count.needs++;
    else if (stage === "finished") count.finished++;
  }
  return [count.working && count.working + " working", count.needs && count.needs + " need" + (count.needs === 1 ? "s" : "") + " you", count.finished && count.finished + " finished"].filter(Boolean).join(" · ");
}

/** The last folder name of a path, for "botkins · main @ 6bff0b4". */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** One prompt of the batch the person is writing, with the bots it goes to. */
export type Draft = { id: number; prompt: string; botIds: string[] };
/** The batch's drafts that will start, and how many jobs that is. */
export function launchable(drafts: Draft[]) {
  const ready = drafts.filter((draft) => draft.prompt.trim() && draft.botIds.length);
  return { ready, jobs: ready.reduce((n, draft) => n + draft.botIds.length, 0) };
}
