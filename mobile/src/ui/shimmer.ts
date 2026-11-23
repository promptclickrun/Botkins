// The live line's shimmer, as plain timing (T3 Code's work-shimmer-steps.ts). No React Native
// imports, so tests/shimmer.test.ts runs it.
//
// The band crosses the line in SHIMMER_STEPS jumps of a native Animated value, then rests off the
// line for SHIMMER_PAUSE_MS with no updates at all. That is about four updates a second, each one a
// native transform with no React render, instead of a 60 fps frame loop: the battery rule holds.

export const SHIMMER_SWEEP_MS = 1_350;
export const SHIMMER_PAUSE_MS = 1_450;
export const SHIMMER_STEPS = 12;
const STEP_MS = SHIMMER_SWEEP_MS / SHIMMER_STEPS;

/**
 * Steps `progress` from 0 to 1 and over again until the returned stop is called. Progress 0 and 1
 * both put the band off the line, so a cycle only needs steps 1 to SHIMMER_STEPS, and the rest
 * happens at 1.
 */
export function startShimmerSteps(progress: { setValue(value: number): void }): () => void {
  let step = 0;
  let timer: ReturnType<typeof setTimeout>;
  const advance = () => {
    step = (step % SHIMMER_STEPS) + 1;
    progress.setValue(step / SHIMMER_STEPS);
    timer = setTimeout(advance, step === SHIMMER_STEPS ? SHIMMER_PAUSE_MS + STEP_MS : STEP_MS);
  };
  timer = setTimeout(advance, STEP_MS);
  return () => clearTimeout(timer);
}
