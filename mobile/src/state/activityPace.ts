// Coalescing + minimum-interval pacer for expensive native bridges (WidgetKit timeline reloads
// and ActivityKit Live Activity updates). Pure TypeScript so it is directly unit-tested.
export type PacerOptions = {
  /** Debounce quiet window after a burst of triggers (ms). */
  quietMs: number;
  /** Minimum interval between consecutive runs while in the foreground (ms). */
  minIntervalMs: number;
  /** Callback invoked when the pacer fires. */
  run: () => void;
  /** Optional clock for tests. */
  now?: () => number;
};

export type CoalescedPacer = {
  /** Request a run, coalesced by `quietMs` and rate-limited by `minIntervalMs`. */
  schedule: () => void;
  /** Cancel any pending timer and run immediately (e.g. on background transition). */
  flushNow: () => void;
  /** Cancel any pending timer without running. */
  cancel: () => void;
  /** True when a trailing timer is scheduled. */
  pending: () => boolean;
};

export const WIDGET_QUIET_MS = 3000;
export const WIDGET_MIN_INTERVAL_MS = 15_000;
export const ACTIVITY_QUIET_MS = 250;
export const ACTIVITY_MIN_INTERVAL_MS = 2000;

export function createCoalescedPacer({ quietMs, minIntervalMs, run, now = Date.now }: PacerOptions): CoalescedPacer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRun = -Infinity;

  const fire = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastRun = now();
    run();
  };

  return {
    schedule() {
      if (timer) return;
      const elapsed = now() - lastRun;
      const wait = Math.max(quietMs, elapsed < minIntervalMs ? minIntervalMs - elapsed : 0);
      if (wait <= 0) {
        fire();
        return;
      }
      timer = setTimeout(fire, wait);
    },
    flushNow() {
      fire();
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    pending() {
      return timer !== null;
    },
  };
}
