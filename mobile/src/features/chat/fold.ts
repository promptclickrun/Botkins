// A turn folded to one line (Settings › Chat › Steps › Folded, the default): the person's message,
// the reply, and "Worked for 52s · 4 steps" under it. The fold holds the bot's interim texts, its
// thinking and its steps, and marks where the person steered or answered, in the order they
// happened. turn.ts decides what goes where; this file has the words and the setting's reading.
// No React Native imports, so tests/fold.test.ts runs it.
import type { Step } from "@/link/types";

/** Settings › Chat › Steps. folded: one line per turn. show: every step in order. failed: failed steps only. hide: nothing. */
export type StepsChoice = "folded" | "show" | "failed" | "hide";
const CHOICES: readonly StepsChoice[] = ["folded", "show", "failed", "hide"];

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

const stepsWord = (n: number) => (n === 1 ? "1 step" : n + " steps");
const failedWord = (n: number) => (n === 1 ? "1 step failed" : n + " steps failed");
type Mode = Exclude<StepsChoice, "show">;

function count(mode: Mode, steps: number, failed: number): string {
  if (mode === "folded") return steps ? stepsWord(steps) : "";
  if (mode === "failed") return failed ? failedWord(failed) : "";
  return "";
}

/** A finished turn's fold line: "Worked for 52s · 4 steps", "Thought for 3s", "Worked for 52s · 1 step failed". */
export function foldLine({ took, steps, failed, mode, onlyThinking }: { took?: number; steps: number; failed: number; mode: Mode; onlyThinking: boolean }): string {
  const time = took && took > 0 ? (onlyThinking ? "Thought for " : "Worked for ") + spentTime(took) : "";
  return [time, count(mode, steps, failed)].filter(Boolean).join(" · ") || "Show work";
}

/**
 * A turn under way's fold line: what the bot is doing now and a running count. `doing` is the
 * running step's label; Hidden and Failed only name no step. Without a step: the bot's intent,
 * "Writing…" while its text streams, else "Thinking…".
 */
export function liveLine({ doing, writing, intent, steps, failed, mode }: { doing?: string; writing: boolean; intent?: string; steps: number; failed: number; mode: Mode }): string {
  const now = (mode === "folded" && doing) || (mode === "folded" && intent?.trim()) || (writing ? "Writing…" : "Thinking…");
  return [now, count(mode, steps, failed)].filter(Boolean).join(" · ");
}
