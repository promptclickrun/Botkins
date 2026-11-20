// The helpers a turn started (the desktop app's "In the background"): the line above the composer,
// and one helper's activity. No React Native imports, so tests/turn.test.ts runs it.
import type { Message, Run, Step, Subagent } from "@/link/types";
import { inputField } from "./turn";

/** "In the background · 2 running", or "… · 3 finished" (the desktop app's words). */
export function railLabel(agents: Subagent[]): string {
  const running = agents.filter((agent) => agent.status === "Running").length;
  return "In the background · " + (running ? running + " running" : agents.length + " finished");
}

/**
 * The chat's newest turn, whose helpers the rail shows: the chat's run part when there is one (the
 * turn under way, or the newest turn when it ended without a reply), else the run of the newest
 * message that has one.
 */
export function latestTurn(running: Run | null | undefined, messages: Message[], runs: Record<string, Run>): Run | undefined {
  if (running) return running;
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i].runId;
    if (id && runs[id]) return runs[id];
  }
  return undefined;
}

export type HelperDetail = {
  helper: Subagent;
  /** What it was asked to do. */
  asked?: string;
  /** What it came back with, once it finished. */
  answer?: string;
  /** Its own steps, or null when the computer doesn't say which steps were a helper's. */
  steps: Step[] | null;
  /** How long it ran, or has run so far (from `now`). */
  took: number;
};

/**
 * One helper of a run. The step that started it has the helper's id: its input holds what it was
 * asked and its output what it said, on any computer. A computer with "turn-timeline-v1" also marks
 * the helper's own steps and says the rest on the helper itself.
 */
export function helperDetail(run: Run, helperId: string, timeline: boolean, now = Date.now()): HelperDetail | null {
  const helper = run.agents?.find((agent) => agent.id === helperId);
  if (!helper) return null;
  const all = run.steps ?? [];
  const start = all.find((step) => step.id === helper.id);
  const finished = helper.status !== "Running";
  const asked = helper.prompt?.trim() || inputField(start?.input, "prompt", "task", "message", "description") || helper.description?.trim() || undefined;
  const answer = finished ? helper.result?.trim() || start?.output?.trim() || (helper.status === "Failed" ? helper.detail : undefined) || undefined : undefined;
  const known = timeline || all.some((step) => !!step.agentId);
  return { helper, asked, answer, steps: known ? all.filter((step) => step.agentId === helper.id) : null, took: Math.max(0, (helper.finished ?? now) - helper.started) };
}
