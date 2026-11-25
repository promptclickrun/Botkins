// Frame-coalescing batcher for streaming text updates from the link client.
// Text-only ticks (`text:<chatId>`) are buffered and flushed at most once per animation frame so
// rapid LAN/direct chunks do not re-render Markdown multiple times per frame. Any structural part
// (`live`, `chat:*`, `run:*`, `chats`, `bots`, etc.) merges pending text and flushes immediately
// so completion commits and live-state clears stay atomic and ordered.
//
// Run summaries alone (`runs`) reach the store at most once per `SUMMARY_FLUSH_MS`. A computer
// changes them with every tool step of every bot at work, and each one that reached the store ran
// every selector on every mounted screen: Home, a list being scrolled, a page sliding in. The first
// after a quiet spell goes at once; the ones that follow within the spell wait for its end. The
// link already spaces its own syncs after such an answer (LinkClient's `summaryPaceMs`); through
// the relay the computer pushes them as they happen, up to ten a second, and this is what spaces
// those. Whatever comes next that is not a summary takes the waiting ones with it, so nothing
// arrives out of order.

export type FrameScheduler = {
  schedule: (fn: () => void) => unknown;
  cancel: (handle: unknown) => void;
  /** A plain timer for the summaries' wait. Left out, it is `setTimeout`. */
  later?: (fn: () => void, ms: number) => unknown;
  cancelLater?: (handle: unknown) => void;
  /** The clock the summaries' spell is measured by. Left out, it is `Date.now`. */
  now?: () => number;
};

/** The least time between two store updates that hold nothing but run summaries. */
export const SUMMARY_FLUSH_MS = 1000;

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
  // What will flush `pending`: the next frame (text is waiting) or the summaries' timer.
  let scheduled: { frame: unknown } | { later: unknown } | null = null;
  const later = scheduler.later ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancelLater = scheduler.cancelLater ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = scheduler.now ?? Date.now;
  // When summaries last reached the store by themselves.
  let summariesAt = -Infinity;

  const cancelScheduled = () => {
    if (scheduled === null) return;
    if ("frame" in scheduled) scheduler.cancel(scheduled.frame);
    else cancelLater(scheduled.later);
    scheduled = null;
  };

  const flush = () => {
    cancelScheduled();
    if (!pending) return;
    const batch = pending;
    pending = null;
    commit(batch);
  };
  const fire = () => {
    scheduled = null;
    flush();
  };

  const push = (incoming: Record<string, unknown>) => {
    if (isTextOnlyParts(incoming)) {
      if (!pending) pending = { ...incoming };
      else Object.assign(pending, incoming);
      // Text goes with the next frame, and summaries that were waiting go with it.
      if (scheduled && "later" in scheduled) cancelScheduled();
      if (scheduled === null) scheduled = { frame: scheduler.schedule(fire) };
      return;
    }
    if (isSummaryOnlyParts(incoming)) {
      const wait = summariesAt + SUMMARY_FLUSH_MS - now();
      if (!pending && wait <= 0) {
        summariesAt = now();
        commit(incoming);
        return;
      }
      if (!pending) pending = { ...incoming };
      else Object.assign(pending, incoming);
      // Text that is waiting takes them along with its frame. Else they wait for the spell's end;
      // the ones that follow replace them and keep that deadline.
      if (scheduled === null) {
        scheduled = {
          later: later(() => {
            summariesAt = now();
            fire();
          }, Math.max(1, wait)),
        };
      }
      return;
    }
    // Structural update: merge any buffered text before committing so order and atomicity hold.
    cancelScheduled();
    if (pending) {
      const merged = Object.assign(pending, incoming);
      pending = null;
      commit(merged);
    } else {
      commit(incoming);
    }
  };

  const clear = () => {
    cancelScheduled();
    pending = null;
  };

  return { push, flush, clear };
}
