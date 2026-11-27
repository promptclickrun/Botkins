import { isSilentMessage } from "../desktop/link/silent-reply.mjs";
import type { Message, Reasoning, Run, Step } from "./types";

export type RunTimelineEvent =
  | { kind: "reasoning"; at: number; order: number; sequence: number; key: string; value: Reasoning }
  | { kind: "step"; at: number; order: number; sequence: number; key: string; value: Step }
  | { kind: "interim"; at: number; order: number; sequence: number; key: string; value: Message }
  | { kind: "command"; at: number; order: number; sequence: number; key: string; value: Message; index: number }
  | { kind: "person"; at: number; order: number; sequence: number; key: string; value: Message; index: number }
  | { kind: "reply"; at: number; order: number; sequence: number; key: string; value: Message; index: number };

export type ChatDisplayEntry =
  | { kind: "message"; index: number; message: Message }
  | { kind: "timeline"; run: Run };

/** Assistant voice lines were previously saved as run-owned interims; treat them as normal chat messages. */
export function isVoiceTranscriptInterim(message: Pick<Message, "role" | "voiceId" | "interim">): boolean {
  return message.role === "assistant" && !!message.voiceId && !!message.interim;
}

/** The run whose timeline owns this message, or undefined for standalone chat messages (such as live voice). */
export function messageTimelineOwner(
  message: Pick<Message, "role" | "voiceId" | "interim" | "runId" | "steeredRunId" | "answer">,
): string | undefined {
  if (isVoiceTranscriptInterim(message)) return undefined;
  return message.runId ?? message.steeredRunId ?? message.answer?.runId;
}

/**
 * Interleaves standalone messages and each run's initial prompt in chronological message order,
 * anchoring a live run's timeline at the bottom and a finished run's timeline where that run ended.
 */
export function chatDisplayEntries(
  messages: Message[],
  runs: ReadonlyMap<string, Run>,
  liveRun?: Run,
): ChatDisplayEntry[] {
  const initialIndexOf = new Map<string, number>();
  const lastIndexOf = new Map<string, number>();
  const hasReplyOf = new Set<string>();
  const seenRuns: Run[] = [];
  const seenRunIds = new Set<string>();

  messages.forEach((message, index) => {
    const owner = messageTimelineOwner(message);
    const run = owner ? runs.get(owner) : undefined;
    if (!run) return;
    if (!seenRunIds.has(run.id)) {
      seenRunIds.add(run.id);
      seenRuns.push(run);
    }
    if (!initialIndexOf.has(run.id) && message.role === "user" && message.runId === run.id && !message.steeredRunId && !message.answer) {
      initialIndexOf.set(run.id, index);
    }
    if (message.role === "assistant" && !message.interim && !isVoiceTranscriptInterim(message) && !isSilentMessage(message)) {
      hasReplyOf.add(run.id);
    }
    lastIndexOf.set(run.id, index);
  });

  const anchorsAt = new Map<number, Run[]>();
  const deferredLive: Run[] = [];
  for (const run of seenRuns) {
    if (run.status === "Working") {
      deferredLive.push(run);
      continue;
    }
    let anchor = lastIndexOf.get(run.id)!;
    if (!hasReplyOf.has(run.id) && typeof run.finished === "number") {
      while (anchor + 1 < messages.length) {
        const next = messages[anchor + 1];
        const nextOwner = messageTimelineOwner(next);
        if (nextOwner && runs.has(nextOwner)) break;
        if (typeof next.time !== "number" || next.time > run.finished) break;
        anchor++;
      }
    }
    const list = anchorsAt.get(anchor);
    if (list) list.push(run);
    else anchorsAt.set(anchor, [run]);
  }

  const entries: ChatDisplayEntry[] = [];
  const emittedRuns = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const owner = messageTimelineOwner(message);
    const run = owner ? runs.get(owner) : undefined;
    if (!run || initialIndexOf.get(run.id) === i) {
      entries.push({ kind: "message", index: i, message });
    }
    const anchored = anchorsAt.get(i);
    if (anchored) {
      for (const anchoredRun of anchored) {
        if (emittedRuns.has(anchoredRun.id)) continue;
        emittedRuns.add(anchoredRun.id);
        entries.push({ kind: "timeline", run: anchoredRun });
      }
    }
  }

  for (const run of deferredLive) {
    if (emittedRuns.has(run.id)) continue;
    emittedRuns.add(run.id);
    entries.push({ kind: "timeline", run });
  }
  if (liveRun && liveRun.status === "Working" && !emittedRuns.has(liveRun.id)) {
    entries.push({ kind: "timeline", run: liveRun });
  }

  return entries;
}

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
    const belongs = messageTimelineOwner(message) === run.id;
    if (!belongs || isSilentMessage(message)) return;
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
