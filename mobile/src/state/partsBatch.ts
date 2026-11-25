// The first reply words paint on a frame. A faster computer can send many more updates than a
// person can read. Keep its newest expanded text or run list until the next paint is due.
// A message, approval or other structural change takes the pending parts with it in order.
export type FrameScheduler = {
  schedule: (fn: () => void) => unknown;
  cancel: (handle: unknown) => void;
  /** Runs the next update when its minimum interval has elapsed. */
  later?: (fn: () => void, ms: number) => unknown;
  cancelLater?: (handle: unknown) => void;
  /** The clock used for timing both kinds of updates. */
  now?: () => number;
};

/** The least time between two store updates that hold nothing but run summaries. */
export const SUMMARY_FLUSH_MS = 1000;
const TEXT_FLUSH_MS = 250;

const defaultScheduler: FrameScheduler = {
  schedule(fn) {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(() => fn());
    return setTimeout(fn, 16);
  },
  cancel(handle) {
    if (typeof cancelAnimationFrame === "function" && typeof handle === "number") cancelAnimationFrame(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function isTextOnlyParts(incoming: Record<string, unknown>): boolean {
  const keys = Object.keys(incoming);
  return keys.length > 0 && keys.every((key) => key.startsWith("text:"));
}

/** Nothing but the list of run summaries: what a bot's every step changes, on a screen that shows none of it. */
export function isSummaryOnlyParts(incoming: Record<string, unknown>): boolean {
  const keys = Object.keys(incoming);
  return keys.length === 1 && keys[0] === "runs";
}

export function createPartsBatcher(
  commit: (parts: Record<string, unknown>) => void,
  scheduler: FrameScheduler = defaultScheduler,
) {
  let pending: Record<string, unknown> | null = null;
  let hasText = false;
  let lastRuns: { id?: string; status?: string }[] | undefined;
  let lastText = -Infinity;
  let lastSummary = -Infinity;
  let scheduled: { frame: unknown } | { timer: unknown; due: number } | null = null;
  const later = scheduler.later ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelLater = scheduler.cancelLater ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = scheduler.now ?? (() => Date.now());

  function cancel() {
    if (scheduled && "frame" in scheduled) scheduler.cancel(scheduled.frame);
    else if (scheduled) cancelLater(scheduled.timer);
    scheduled = null;
  }

  function flush() {
    cancel();
    if (!pending) return;
    const batch = pending;
    pending = null;
    if (Array.isArray(batch.runs)) lastRuns = batch.runs;
    if (hasText) lastText = now();
    if (isSummaryOnlyParts(batch)) lastSummary = now();
    hasText = false;
    commit(batch);
  }

  function push(incoming: Record<string, unknown>) {
    const keys = Object.keys(incoming);
    hasText ||= keys.some((key) => key.startsWith("text:"));
    const runs = incoming.runs;
    const previous = lastRuns;
    const transition = Array.isArray(runs) && previous && (runs.length !== previous.length ||
      runs.some((run, i) => run?.id !== previous[i]?.id || run?.status !== previous[i]?.status));
    if (transition || !keys.length || keys.some((key) => key !== "runs" && !key.startsWith("text:"))) {
      if (pending) Object.assign(pending, incoming);
      else pending = incoming;
      flush();
      return;
    }
    pending = Object.assign(pending ?? {}, incoming);
    const interval = hasText ? TEXT_FLUSH_MS : SUMMARY_FLUSH_MS;
    const time = now();
    const wait = Math.min(interval, (hasText ? lastText : lastSummary) + interval - time);
    if (wait <= 0) {
      if (!hasText) flush();
      else if (!scheduled || !("frame" in scheduled)) {
        cancel();
        scheduled = { frame: scheduler.schedule(flush) };
      }
    } else if (!scheduled || !("timer" in scheduled) || scheduled.due !== time + wait) {
      cancel();
      scheduled = { timer: later(flush, wait), due: time + wait };
    }
  }

  function clear() {
    cancel();
    pending = null;
    hasText = false;
    lastRuns = undefined;
    lastText = lastSummary = -Infinity;
  }

  return { push, flush, clear };
}
