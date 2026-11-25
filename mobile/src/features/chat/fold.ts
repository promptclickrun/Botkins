// Display choices and the words for a turn’s activity rail.
import type { Step } from "@/link/types";

/** Settings › Chat › Steps. folded: activity rail only. show (Open): the live island (islandModel.ts). failed: failed steps only. */
export type StepsChoice = "folded" | "show" | "failed";
const CHOICES: readonly StepsChoice[] = ["folded", "show", "failed"];

/** Settings › Chat › Thinking. show (Open): the island's lines of thought. folded: the activity rail. hide: nowhere. */
export type ThinkingChoice = "show" | "folded" | "hide";

/*
 * Which choice a saved record means (the island release, 2026-11-24). Open, the island, is the
 * default for Steps and for Thinking unless the person chose otherwise:
 * - Steps: a choice counts once `stepsPicked` is set (setChatPrefs sets it). Without it, whatever is
 *   saved was a default, so it becomes Open. A picked value that is no longer a choice (the old
 *   "summary" or "hide") reads as Folded, which is what it looked like.
 * - Thinking: `thinkingPicked` is new. A saved value without it is read by what it is: "folded" was
 *   the old default, so it becomes Open; "show" and "hide" were never defaults, so the person picked
 *   them and they stay. Anything else is Open.
 */
export function settleSteps(saved: { steps?: unknown; stepsPicked?: unknown }): StepsChoice {
  if (saved.stepsPicked !== true) return "show";
  return CHOICES.includes(saved.steps as StepsChoice) ? (saved.steps as StepsChoice) : "folded";
}

export function settleThinking(saved: { thinking?: unknown; thinkingPicked?: unknown }): ThinkingChoice {
  const value = saved.thinking;
  if (saved.thinkingPicked === true) return value === "folded" || value === "hide" || value === "show" ? value : "show";
  return value === "hide" ? "hide" : "show";
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
