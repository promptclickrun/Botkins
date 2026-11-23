// How a provider's turn is watched while its harness is quiet.
//
// The person can stop any turn (Stop in the chat, on the phone, in Work and Routines), so Botkins
// never fails a turn because it has been quiet for a while: a build, a long think or a slow tool
// may take as long as it takes. A turn ends on its own only when the harness is really gone (its
// process exited, its connection closed, its session no longer exists, or it reported an error),
// or when the person stops it. This file is the second part of that: after a quiet spell it asks
// the harness whether it is still there.

/** How long a turn is quiet before the harness is asked whether it is still there. */
export const QUIET_CHECK_MS = 2 * 60 * 1000;
/** How long that question may take. No answer in time is no news, and the turn goes on waiting. */
export const PROBE_MS = 30 * 1000;

/**
 * Watches one turn for silence. Call `touch()` for each sign of life from the harness. After
 * `every` ms with none, `probe()` runs: it resolves when the harness is alive or when the check
 * could not tell, and rejects with the error to end the turn with when the harness is gone. A
 * live harness is asked again after the next quiet spell, with no limit.
 * @param options.every   Quiet spell before each check.
 * @param options.probe   async () => void. Rejects only for a harness that is gone.
 * @param options.onDead  (error) => void: the turn's end, called at most once.
 * @returns {{ touch: () => void, stop: () => void }}
 */
export function watchQuiet({ every = QUIET_CHECK_MS, probe, onDead, probeMs = PROBE_MS }) {
  let timer;
  let over = false;
  let signs = 0;
  const arm = () => {
    clearTimeout(timer);
    if (over) return;
    timer = setTimeout(check, Math.max(1, every));
    timer.unref?.();
  };
  const check = async () => {
    const before = signs;
    let gone = null;
    let limit;
    try {
      await Promise.race([
        probe(),
        new Promise((resolve) => {
          limit = setTimeout(resolve, Math.max(1, probeMs));
          limit.unref?.();
        }),
      ]);
    } catch (error) {
      gone = error;
    } finally {
      clearTimeout(limit);
    }
    if (over) return;
    // A sign of life while the question was out: the harness was there a moment ago, so it is asked again later.
    if (gone && signs === before) {
      over = true;
      return onDead(gone);
    }
    arm();
  };
  arm();
  return {
    touch() {
      signs++;
      arm();
    },
    stop() {
      over = true;
      clearTimeout(timer);
    },
  };
}
