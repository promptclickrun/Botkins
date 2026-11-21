// An app panel's saved state, as its view reaches it (`botkins.state` in the page; the contract's
// "App panels: saved state"). The frame itself is in HtmlFrame.tsx. This part decides when a
// page's `set` may be passed on, and has no window in it, so a test can read it.

/** A panel's state for its views, from the space's page. A view in a chat has none. */
export type FrameStore = {
  state: Record<string, unknown>;
  /** How many times the state changed (`stateRev`). */
  rev: number;
  /** Saves a patch on the computer and answers the state's new revision. Absent when the person may only look. */
  set?: (patch: Record<string, unknown>, label?: string) => Promise<number>;
};

/** A page may save only this soon after the person clicked or pressed a key in its view. */
export const GESTURE_MS = 3000;
/** And at most this often. */
export const SET_GAP_MS = 1000;
export const LABEL_MAX = 80;

/**
 * The gate for one view's saves: a page cannot write under a person's name when they only opened
 * it. `gesture()` is called when the main process says the person really clicked or pressed a key
 * inside the view (a page cannot make that signal itself); `allow()` says whether a save may go
 * out now, and counts it when it may. `reset()` is for a page that has just loaded: a click in the
 * page before it does not count for the new one, or a page could reload itself after a click and
 * save as it starts.
 */
export function saveGate(now: () => number = Date.now) {
  let gestureAt = -Infinity;
  let savedAt = -Infinity;
  return {
    gesture() {
      gestureAt = now();
    },
    reset() {
      gestureAt = -Infinity;
    },
    allow() {
      const t = now();
      if (t - gestureAt > GESTURE_MS || t - savedAt < SET_GAP_MS) return false;
      savedAt = t;
      return true;
    },
  };
}

/** A page's patch as it may be sent: a plain object of top-level keys, or null when it is not one. */
export function cleanPatch(patch: unknown): Record<string, unknown> | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
  return { ...(patch as Record<string, unknown>) };
}

/** The page's own words for what changed: plain text, at most 80 characters, or nothing. */
export function cleanLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  const text = label.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, LABEL_MAX);
  return text || undefined;
}
