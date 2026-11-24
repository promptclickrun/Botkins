// Frame-coalescing batcher for streaming text updates from the link client.
// Text-only ticks (`text:<chatId>`) are buffered and flushed at most once per animation frame so
// rapid LAN/direct chunks do not re-render Markdown multiple times per frame. Any structural part
// (`live`, `chat:*`, `run:*`, `chats`, `bots`, etc.) merges pending text and flushes immediately
// so completion commits and live-state clears stay atomic and ordered.

export type FrameScheduler = {
  schedule: (fn: () => void) => unknown;
  cancel: (handle: unknown) => void;
};

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

export function createPartsBatcher(
  commit: (parts: Record<string, unknown>) => void,
  scheduler: FrameScheduler = defaultScheduler,
) {
  let pending: Record<string, unknown> | null = null;
  let scheduled: unknown = null;

  const cancelScheduled = () => {
    if (scheduled === null) return;
    scheduler.cancel(scheduled);
    scheduled = null;
  };

  const flush = () => {
    cancelScheduled();
    if (!pending) return;
    const batch = pending;
    pending = null;
    commit(batch);
  };

  const push = (incoming: Record<string, unknown>) => {
    if (isTextOnlyParts(incoming)) {
      if (!pending) pending = { ...incoming };
      else Object.assign(pending, incoming);
      if (scheduled === null) {
        scheduled = scheduler.schedule(() => {
          scheduled = null;
          flush();
        });
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
