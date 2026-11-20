// "Position after response completes" (Settings › Chat): where a chat lands once a reply has
// finished. "Keep at latest content" (the default) follows the reply to its end, as the chat always
// did. "Show beginning of completed response" scrolls once so the top of the final reply is at the
// top of the view, so it is read from the start. While a reply streams, both behave the same.
//
// The rules (the same as Hermex's, github.com/uzairansaruzi/hermex, ChatView.swift):
// - Once per run, and only for a run this phone saw under way that finished with a reply. An error,
//   a stop or an interruption moves nothing.
// - Only once the final reply is drawn (no live turn left in the list), and its target is that
//   reply, never a step or text written on the way.
// - Only while the chat is on screen and the app is in front; otherwise when the person comes back
//   to the chat, once. The run is remembered here, outside the screen, so a chat that was closed
//   and opened again still lands at the reply's beginning.
// - Not when the person had scrolled away from the newest content while it streamed. That is read
//   during the stream and kept with the run: a reply that arrives all at once (the app was away)
//   moves the list by itself, which is not the person scrolling.
// Plain logic with no React Native imports: tests/completion.test.ts runs it.
import type { Message, Run } from "@/link/types";

export type CompletionPosition = "latest" | "beginning";

export const COMPLETION_POSITIONS: { value: CompletionPosition; label: string; subtitle: string }[] = [
  { value: "latest", label: "Keep at latest content", subtitle: "Follows the reply to its end" },
  { value: "beginning", label: "Show beginning of completed response", subtitle: "Scrolls to where the reply starts" },
];

/** A saved choice as it is used: anything unknown is "latest". */
export const completionPositionOf = (value: unknown): CompletionPosition => (value === "beginning" ? "beginning" : "latest");

/** What became of a run: still going, ended without a reply, or finished with its final reply at `index` (its place in the whole chat). */
export type Outcome = { kind: "pending" } | { kind: "failed" } | { kind: "completed"; index: number };

const ENDED = new Set(["Needs you", "Stopped", "Interrupted"]);

export function outcomeOf(runId: string, chat: { running: Run | null | undefined; messages: Message[]; from: number; runs: Record<string, Run | undefined> }): Outcome {
  // The chat's run part is this run only while it is under way or ended without a reply.
  const part = chat.running?.id === runId ? chat.running : undefined;
  const summary = part ?? chat.runs[runId];
  if (summary && (ENDED.has(summary.status) || summary.ending)) return { kind: "failed" };
  if (part?.status === "Working") return { kind: "pending" };
  // The final reply: the run's last message from a bot that isn't text written on the way.
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const message = chat.messages[i];
    if (message.role === "assistant" && !message.interim && message.runId === runId) return { kind: "completed", index: chat.from + i };
  }
  // Finished, but its reply isn't here yet.
  return { kind: "pending" };
}

export type CompletionInput = {
  mode: CompletionPosition;
  /** The chat's run part (`running[chatId]`). */
  running: Run | null | undefined;
  messages: Message[];
  from: number;
  /** The chat's runs by id, as the watched chat keeps them. */
  runs: Record<string, Run | undefined>;
  /** The chat is on screen and the app is in front. */
  visible: boolean;
  /** The newest content is in view: the person hasn't scrolled away from it. Read while the run is under way. */
  following: boolean;
  /** The reply is drawn: no live turn is left in the list. */
  drawn: boolean;
};

/** none: nothing to do. wait: ask again when something changes. jump: scroll to the reply at `index`, then call `done`. */
export type CompletionStep = { kind: "none" } | { kind: "wait" } | { kind: "jump"; runId: string; index: number };

/** The runs each chat saw under way, by chat. One for the whole app, so a chat closed and opened again remembers. */
export function createCompletions() {
  // The run each chat saw under way, and whether the person was following it the last time it was seen working.
  const watched = new Map<string, { runId: string; following: boolean }>();
  return {
    check(chatId: string, input: CompletionInput): CompletionStep {
      const running = input.running;
      if (running?.status === "Working") {
        watched.set(chatId, { runId: running.id, following: input.following });
        return { kind: "wait" };
      }
      const seen = watched.get(chatId);
      if (!seen) return { kind: "none" };
      const { runId } = seen;
      const outcome = outcomeOf(runId, input);
      if (outcome.kind === "pending") return { kind: "wait" };
      // Ended without finishing, or the person keeps the latest content: nothing moves, now or later.
      if (outcome.kind === "failed" || input.mode !== "beginning") {
        watched.delete(chatId);
        return { kind: "none" };
      }
      if (!input.visible || !input.drawn) return { kind: "wait" };
      // The person was reading something else while it streamed: they stay there.
      if (!seen.following) {
        watched.delete(chatId);
        return { kind: "none" };
      }
      return { kind: "jump", runId, index: outcome.index };
    },
    /** The jump was made: this run never moves the chat again. */
    done(chatId: string, runId: string) {
      if (watched.get(chatId)?.runId === runId) watched.delete(chatId);
    },
  };
}

export const completions = createCompletions();
