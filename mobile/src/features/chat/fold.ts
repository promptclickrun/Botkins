// Display choices and the words for a turn’s activity rail.
import type { Step } from "@/link/types";

/** Settings › Chat › Steps. folded: activity rail only. show: every step in order. failed: failed steps only. */
export type StepsChoice = "folded" | "show" | "failed";
const CHOICES: readonly StepsChoice[] = ["folded", "show", "failed"];

/**
 * The Steps choice a saved record means. Everyone moves to Folded once: a choice saved before
 * `stepsPicked` existed was the old default, not a pick. The old "summary" (one line) is Folded.
 */
export function settleSteps(saved: { steps?: unknown; stepsPicked?: unknown }): StepsChoice {
  if (saved.stepsPicked !== true) return "folded";
  return CHOICES.includes(saved.steps as StepsChoice) ? (saved.steps as StepsChoice) : "folded";
}

/** One thing in a fold, in the order it happened. */
export type FoldEntry =
  /** Text the bot wrote before it moved on (an interim message, or a piece the phone noted). */
  | { kind: "text"; key: string; text: string }
  | { kind: "thought"; key: string; text: string }
  | { kind: "step"; key: string; step: Step }
  /** Where the person steered or answered; their message itself stays in the chat. */
  | { kind: "person"; key: string; text: string };

/** "52s", "1m 15s", "1h 1m". */
export function spentTime(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
}

export const stepCount = (steps: number): string => steps ? steps + (steps === 1 ? " step" : " steps") : "";

type FoldFacts = { took?: number; steps: number; onlyThinking: boolean };

export function foldParts({ took, steps, onlyThinking }: FoldFacts): { lead: string; count: string } {
  const count = stepCount(steps);
  const lead = took && took > 0 ? (onlyThinking ? "Thought for " : "Worked for ") + spentTime(took) : "";
  return { lead: lead || (count ? "" : "Show work"), count };
}

export function foldLine(facts: FoldFacts): string {
  const { lead, count } = foldParts(facts);
  return [lead, count].filter(Boolean).join(" · ");
}

export const liveLine = (steps: number) => [statusLead(), stepCount(steps)].filter(Boolean).join(" · ");

/** The words beside the bot's face and its typing dots: what it says it is doing, else "Working…". The count is a pill of its own. */
export function statusLead(intent?: string): string {
  return intent?.trim() || "Working…";
}
