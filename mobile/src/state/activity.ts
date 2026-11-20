// What a chat's Live Activity shows, worked out from what the phone knows. No React Native imports,
// so tests/activity.test.ts runs it. The computer builds the same shape for its pushes
// (`activityState` in link-host/push.mjs); change both together.
import type { ActivityState, Run, RunSummary } from "@/link/types";

export type ActivityInput = {
  /** The turn's detail, when this phone follows the chat (the chat is on screen). */
  run?: Run | null;
  /** The chat's latest run as the list of runs has it, for a chat that is not on screen. */
  summary?: RunSummary;
  /** The chat has a turn under way now. */
  active: boolean;
  /** A bot in the chat is waiting for the person's answer. */
  asked: boolean;
  /** The reply is being written. */
  streaming: boolean;
  /** Step names may be shown. */
  previews: boolean;
  /** What the card showed last. */
  previous?: ActivityState;
  now: number;
};

const seconds = (ms: number) => Math.floor(ms / 1000);
const OVER = ["done", "failed"];

export function activityView({ run, summary, active, asked, streaming, previews, previous, now }: ActivityInput): ActivityState {
  const known = run ?? summary;
  const steps = run?.steps ?? [];
  // A card that was showing a turn keeps that turn's start and step count when the detail goes away
  // (the person left the chat's screen). A card that showed a finished turn starts afresh.
  const carried = previous && !OVER.includes(previous.phase) ? previous : undefined;
  const count = run ? steps.length : (carried?.steps ?? (active ? 0 : (previous?.steps ?? 0)));
  const startedAt = known ? seconds(known.time) : (carried?.startedAt ?? (!active && previous ? previous.startedAt : seconds(now)));
  const base = { steps: count, startedAt };
  if (!active) {
    // Over. Once the card says so, it keeps saying the same: the end is not moved by a later look.
    if (previous && OVER.includes(previous.phase) && previous.startedAt === startedAt) return previous;
    const failed = !!known && known.status !== "Completed" && known.status !== "Working";
    const finishedAt = Math.max(startedAt, seconds(known?.finished ?? now));
    return { ...base, phase: failed ? "failed" : "done", label: failed ? "Stopped" : "Done", finishedAt };
  }
  if (asked) return { ...base, phase: "needs-you", label: "Needs you" };
  if (streaming) return { ...base, phase: "working", label: "Writing" };
  if (run) {
    const current = [...steps].reverse().find((step) => step.status === "Running") ?? steps[steps.length - 1];
    if (current) return { ...base, phase: "working", label: previews ? (current.label || current.name).slice(0, 60) || "Working" : "Working" };
    return { ...base, phase: "thinking", label: "Thinking" };
  }
  // Under way, and this phone doesn't have its detail: it is working, without a step's name.
  return { ...base, phase: carried?.phase === "thinking" ? "thinking" : "working", label: carried?.phase === "thinking" ? "Thinking" : "Working" };
}

/** A finished turn's card stays, marked done, this long, unless a new turn in the chat takes it over first. */
export const LINGER_MS = 30 * 60_000;
