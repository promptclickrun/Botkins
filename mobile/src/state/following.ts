// Follow the chats on screen. Keep one recently closed page available for a quick return.
// Its version can be reused without following its run, reasoning or reply while it is hidden.
export type FollowingOptions = {
  /** Tells the link which chats to follow now. Called only when the set may have changed. */
  send(shown: string[], keptPage?: string): void;
  /** A suspended timer may fire before a returning screen has reclaimed its page. */
  away(): boolean;
  /** A zero interval releases a watch as soon as its last screen closes. */
  lingerMs?: number;
};

export const LINGER_MS = 15_000;
export const RETURN_GRACE_MS = 3_000;

export function createFollowing(options: FollowingOptions) {
  const lingerMs = options.lingerMs ?? LINGER_MS;
  const shown = new Map<string, number>();
  // The kept page has its own slot outside the four active watches.
  let kept: { id: string; until: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publish = () => options.send([...shown.keys()], kept?.id);
  const disarm = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const arm = (ms: number) => {
    disarm();
    timer = setTimeout(expire, Math.max(1, ms));
  };
  const release = () => {
    disarm();
    if (!kept) return;
    kept = null;
    publish();
  };
  function expire() {
    timer = undefined;
    if (!kept || options.away()) return;
    const wait = Math.min(lingerMs, kept.until - Date.now());
    if (wait > 0) {
      kept.until = Date.now() + wait;
      arm(wait);
    } else release();
  }

  return {
    /** A screen shows this chat. Returns the function that says it no longer does. */
    watch(id: string) {
      const count = shown.get(id) ?? 0;
      shown.set(id, count + 1);
      if (kept?.id === id) {
        kept = null;
        disarm();
      }
      if (!count) publish();
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
        if (lingerMs > 0) {
          kept = { id, until: Date.now() + lingerMs };
          arm(lingerMs);
        }
        publish();
      };
    },
    /** The chats on screen, in the order they were first shown. */
    shown: () => [...shown.keys()],
    keptPage: () => kept?.id,
    /** The app is in front again: a kept chat gets a moment for its screen to show it again. */
    returned() {
      if (!kept) return;
      kept.until = Date.now() + Math.max(RETURN_GRACE_MS, Math.min(lingerMs, kept.until - Date.now()));
      arm(kept.until - Date.now());
    },
    /** Lets the kept chat go now: a wake in the background follows nothing that isn't shown, and another computer has other chats. */
    release,
  };
}
