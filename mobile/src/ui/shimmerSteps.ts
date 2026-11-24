// The live line's shimmer, as plain timing (T3 Code's work-shimmer-steps.ts). No React Native
// imports, so tests/shimmer-steps.test.ts runs it.
//
// The band crosses the line in SHIMMER_STEPS jumps of a native Animated value, then rests off the
// line for SHIMMER_PAUSE_MS with no updates at all. That is about four updates a second, each one a
// native transform with no React render, instead of a 60 fps frame loop: the battery rule holds.

export const SHIMMER_SWEEP_MS = 1_350;
export const SHIMMER_PAUSE_MS = 1_450;
export const SHIMMER_STEPS = 12;
export const SHIMMER_MAX_MS = 10_000;
const STEP_MS = SHIMMER_SWEEP_MS / SHIMMER_STEPS;

export type ShimmerOptions = {
  /** Stop shimmering after this many milliseconds and keep a static status label. Default 10 s. */
  maxMs?: number;
  /** Called once when `maxMs` elapses. */
  onDone?: () => void;
};

/**
 * Steps `progress` from 0 to 1 and over again until the returned stop is called or `maxMs` elapses.
 * Progress 0 and 1 both put the band off the line, so a cycle only needs steps 1 to SHIMMER_STEPS,
 * and the rest happens at 1.
 */
export function startShimmerSteps(progress: { setValue(value: number): void }, options?: ShimmerOptions): () => void {
  const maxMs = options?.maxMs ?? SHIMMER_MAX_MS;
  let step = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (deadline !== undefined) clearTimeout(deadline);
  };

  const finish = () => {
    if (stopped) return;
    stop();
    progress.setValue(0);
    options?.onDone?.();
  };

  const advance = () => {
    if (stopped) return;
    step = (step % SHIMMER_STEPS) + 1;
    progress.setValue(step / SHIMMER_STEPS);
    timer = setTimeout(advance, step === SHIMMER_STEPS ? SHIMMER_PAUSE_MS + STEP_MS : STEP_MS);
  };

  timer = setTimeout(advance, STEP_MS);
  if (Number.isFinite(maxMs)) {
    deadline = setTimeout(finish, maxMs);
  }
  return stop;
}

export type ShimmerCoordinator = {
  acquire: (id: string) => boolean;
  release: (id: string) => void;
  activeId: () => string | null;
  subscribe: (listener: () => void) => () => void;
};

/** Ensures at most one shimmer runs at a time across the visible screen. */
export function createShimmerCoordinator(): ShimmerCoordinator {
  let holder: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    acquire(id: string) {
      if (holder === id) return true;
      if (holder !== null) return false;
      holder = id;
      notify();
      return true;
    },
    release(id: string) {
      if (holder !== id) return;
      holder = null;
      notify();
    },
    activeId() {
      return holder;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const shimmerCoordinator = createShimmerCoordinator();
