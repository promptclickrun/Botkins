// What a chat says when the computer kept the work moving (the desktop app's `keptLine` and `openLine`
// in desktop/src/keep.ts say the same words). No React Native imports, so tests/keep-moving.test.ts runs it.
import type { Run } from "@/link/types";

/** What Continue sends to the chat. */
export const CONTINUE_OPEN_STEPS = "Continue with the open steps.";

/**
 * The quiet line in the timeline of a run the computer gave more turns by itself: "↻ Kept going: 3 plan
 * steps were open". Nothing for a run that wasn't continued, and for a computer that sends no such field.
 */
export function keptLine(run: Pick<Run, "continued"> | null | undefined): string | undefined {
  const kept = run?.continued;
  if (!kept || typeof kept.count !== "number" || kept.count < 1) return undefined;
  if (kept.reason === "next-step") return "↻ Kept going: the next step was not done yet";
  const open = kept.open;
  if (typeof open !== "number" || open < 1) return "↻ Kept going";
  return "↻ Kept going: " + open + (open === 1 ? " plan step was open" : " plan steps were open");
}

/** "Stopped with 2 open steps" for a turn that ended with plan steps open and nothing went on; otherwise nothing. */
export function openLine(run: Pick<Run, "plan" | "stoppedOpen"> | null | undefined): string | undefined {
  const open = run?.stoppedOpen ? run.plan?.open : undefined;
  if (typeof open !== "number" || open < 1) return undefined;
  return "Stopped with " + open + (open === 1 ? " open step" : " open steps");
}
