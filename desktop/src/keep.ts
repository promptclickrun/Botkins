// What a chat says when Botkins kept the work moving (desktop/keep-moving.mjs). The phone says the same
// words (mobile/src/features/chat/keep.ts); test/keep-moving-ui.test.mjs holds both to them.
import type { Run } from "./types";

/** What Continue sends to the chat. */
export const CONTINUE_OPEN_STEPS = "Continue with the open steps.";
/** The line on a question whose turn went on without an answer. */
export const DETACHED_LINE = "Waiting for your answer. Your reply starts a new turn.";

/** "↻ Kept going: 3 plan steps were open", for a run that Botkins gave more turns by itself. Nothing for any other. */
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
