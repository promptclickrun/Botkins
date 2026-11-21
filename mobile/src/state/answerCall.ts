// What an answer given away from the app means, as one call to the computer (src/state/answers.ts
// sends it). No React Native imports: tests/cards.test.ts runs it.
import type { QueuedAnswer } from "../../modules/botkins-activity/types";

export type AnswerCall =
  | { method: "respond"; requestId: string; answer: { action: string; value?: string } }
  | { method: "stop"; chatId: string }
  | { method: "retry"; runId: string };

/** The call an answer makes, or undefined when it can't be made (a missing request, an empty reply, a kind this build doesn't know). */
export function answerCall(answer: QueuedAnswer, latestRun?: (chatId: string) => string | undefined): AnswerCall | undefined {
  switch (answer.action) {
    case "approve":
    case "remember":
    case "deny":
    case "cancel":
      return answer.request ? { method: "respond", requestId: answer.request, answer: { action: answer.action } } : undefined;
    case "answer": {
      const value = answer.value?.trim();
      return answer.request && value ? { method: "respond", requestId: answer.request, answer: { action: "answer", value } } : undefined;
    }
    case "stop":
      return answer.chat ? { method: "stop", chatId: answer.chat } : undefined;
    case "retry": {
      const runId = answer.chat ? latestRun?.(answer.chat) : undefined;
      return runId ? { method: "retry", runId } : undefined;
    }
    default:
      return undefined;
  }
}
