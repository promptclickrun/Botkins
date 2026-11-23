import type { Message, Reasoning, Run, Step } from "./types";

export type RunTimelineEvent =
  | { kind: "reasoning"; at: number; order: number; sequence: number; key: string; value: Reasoning }
  | { kind: "step"; at: number; order: number; sequence: number; key: string; value: Step }
  | { kind: "interim"; at: number; order: number; sequence: number; key: string; value: Message }
  | { kind: "command"; at: number; order: number; sequence: number; key: string; value: Message; index: number }
  | { kind: "person"; at: number; order: number; sequence: number; key: string; value: Message; index: number }
  | { kind: "reply"; at: number; order: number; sequence: number; key: string; value: Message; index: number };

/**
 * Events in the order a turn happened. The backend timestamps every timeline message, step and
 * reasoning segment. The order number keeps equal timestamps deterministic and places a person's
 * steer after the bot event that prompted it.
 */
export function orderedRunEvents(
  run: Run,
  messages: Message[],
  options: { includeReplies?: boolean; includeHelperSteps?: boolean } = {},
): RunTimelineEvent[] {
  const events: RunTimelineEvent[] = [];
  messages.forEach((message, index) => {
    const belongs = message.runId === run.id || message.steeredRunId === run.id || message.answer?.runId === run.id;
    if (!belongs) return;
    if (message.interim) {
      events.push({ kind: "interim", at: message.time ?? Number.POSITIVE_INFINITY, order: 2, sequence: index, key: "interim-" + index, value: message });
      return;
    }
    if (message.role === "command" && message.runId === run.id) {
      events.push({ kind: "command", at: message.time ?? Number.POSITIVE_INFINITY, order: 3, sequence: index, key: "command-" + index, value: message, index });
      return;
    }
    if (options.includeReplies && message.role === "assistant" && message.runId === run.id) {
      events.push({ kind: "reply", at: message.time ?? Number.POSITIVE_INFINITY, order: 5, sequence: index, key: "reply-" + index, value: message, index });
      return;
    }
    if (message.role === "user" && (message.steeredRunId === run.id || message.answer?.runId === run.id)) {
      events.push({ kind: "person", at: message.time ?? Number.POSITIVE_INFINITY, order: 3, sequence: index, key: "person-" + index, value: message, index });
    }
  });
  for (const [index, reasoning] of (run.reasoning ?? []).entries()) events.push({ kind: "reasoning", at: reasoning.started, order: 1, sequence: messages.length + index, key: "reason-" + reasoning.id, value: reasoning });
  for (const [index, step] of (run.steps ?? []).entries()) {
    if (!step.agentId || options.includeHelperSteps) events.push({ kind: "step", at: step.started, order: 4, sequence: messages.length + (run.reasoning?.length ?? 0) + index, key: "step-" + step.id, value: step });
  }
  return events.sort((a, b) => {
    const byTime = a.at - b.at;
    if (byTime) return byTime;
    const messageKind = (event: RunTimelineEvent) => event.kind === "interim" || event.kind === "person" || event.kind === "command" || event.kind === "reply";
    const bothMessages = messageKind(a) && messageKind(b);
    return bothMessages ? a.sequence - b.sequence : a.order - b.order || a.sequence - b.sequence;
  });
}
