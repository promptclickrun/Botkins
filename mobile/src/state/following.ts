// Which chats the link follows: the ones a screen shows, and the one that was shown last, for a
// little longer. No React Native imports, so a test can run it.
//
// A chat stops being shown whenever its screen is covered by a page, the app is left for a moment
// (Control Center, Face ID, another app), or the person goes back to Home. Telling the computer at
// once made coming back expensive: the computer drops a chat nobody follows, so the same chat was
// sent again whole (about 100 KB for a page of 60 messages, opened and parsed on the JavaScript
// thread while the screen slides back), and the change of chats cut short the quick check a wake
// makes. So the chat that was just left is kept for `lingerMs`. Coming back within that time tells
// the computer nothing, and costs nothing. After it the chat is let go as before, so a chat that is
// out of view for longer is not followed: that saving stays.

export type FollowingOptions = {
  /** Tells the link which chats to follow now. Called only when the set may have changed. */
  send(ids: string[]): void;
  /**
   * Whether the app is in the background. Timers that came due while it was there fire as it comes
   * back, before its screens say they are on show again, so a kept chat is not let go then: `returned`
   * gives it a moment more. (In the background the link is at rest, so keeping it costs nothing.)
   */
  away(): boolean;
  /** How long a chat that is no longer shown is still followed (default 15 s). */
  lingerMs?: number;
  /** How long a kept chat has, at least, once the app is in front again (default 3 s). */
  graceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export const LINGER_MS = 15_000;
export const RETURN_GRACE_MS = 3_000;

export function createFollowing(options: FollowingOptions) {
  const lingerMs = options.lingerMs ?? LINGER_MS;
  const graceMs = options.graceMs ?? RETURN_GRACE_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  // Chats on screen; each screen counts once.
  const shown = new Map<string, number>();
  // One chat at most: the computer follows four, and the ones on show come first.
  let kept: { id: string; until: number } | null = null;
  let timer: unknown;

  const ids = () => {
    const list = [...shown.keys()];
    if (kept && !shown.has(kept.id)) list.push(kept.id);
    return list;
  };
  const disarm = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const arm = (ms: number) => {
    disarm();
    timer = setTimer(expire, Math.max(1, ms));
  };
  const release = () => {
    disarm();
    if (!kept) return;
    kept = null;
    options.send(ids());
  };
  function expire() {
    timer = undefined;
    if (!kept || options.away()) return;
    const wait = kept.until - now();
    if (wait > 0) arm(wait);
    else release();
  }

  return {
    /** A screen shows this chat. Returns the function that says it no longer does. */
    watch(id: string) {
      const count = shown.get(id) ?? 0;
      shown.set(id, count + 1);
      if (kept?.id === id) {
        // Back in view while it was kept: the link follows it already, so there is nothing to tell.
        kept = null;
        disarm();
      } else if (!count) options.send(ids());
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const left = (shown.get(id) ?? 1) - 1;
        if (left > 0) {
          shown.set(id, left);
          return;
        }
        shown.delete(id);
        const before = kept?.id;
        kept = { id, until: now() + lingerMs };
        arm(lingerMs);
        // The chat kept until now is let go for this one: only then did the set change.
        if (before !== undefined && before !== id) options.send(ids());
      };
    },
    /** The chats on screen, in the order they were first shown. */
    shown: () => [...shown.keys()],
    /** The chats the link follows: the ones on screen, then the kept one. */
    ids,
    /** The app is in front again: a kept chat gets a moment for its screen to show it again. */
    returned() {
      if (!kept) return;
      kept.until = Math.max(kept.until, now() + graceMs);
      arm(kept.until - now());
    },
    /** Lets the kept chat go now: a wake in the background follows nothing that isn't shown, and another computer has other chats. */
    release,
  };
}
