// Background lifecycle for the phone's link and relay socket.
//
// When the app leaves the foreground (AppState === "background"), wait a short grace period and
// then rest the link and close the relay WebSocket cleanly — unless background work actually needs
// the link (an active upload, a live voice or talk call, a Watch voice session, or a background
// push wake). When that work finishes while the app is still in the background, close cleanly.
//
// No React Native imports, so unit tests drive this directly with fake AppState, fake sockets and
// fake timers.

/** Short grace window before closing the relay socket on background. Covers quick app switches and
 * lets an already-queued `link.unfollow` or `link.push.presence` finish cleanly. */
export const BACKGROUND_GRACE_MS = 3_000;

export type BackgroundReason = "upload" | "voice" | "watch" | "push";

export type BackgroundPolicyOptions = {
  /** Delay before closing after entering background. Default BACKGROUND_GRACE_MS. */
  graceMs?: number;
  /** Called immediately when entering background (before grace expires) to flush UI batches etc. */
  onBackground?(): void;
  /** Called once the grace period expires (or when the last hold releases in background). */
  onSleep(): void;
  /** Called when returning to active foreground or woken by a notification tap. */
  onWake(): void;
  /** Initial state (defaults to "active"). */
  initialState?: string;
  /** Injectable timers for deterministic tests. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type BackgroundController = {
  /** Feed an AppState change ("active", "background", "inactive", ...). */
  setAppState(state: string): void;
  /** Current known AppState. */
  readonly appState: string;
  /** True once the link has been put to sleep for the background. */
  readonly sleeping: boolean;
  /** Acquire a hold keeping the link/socket open while in the background. Returns a release function. */
  hold(reason: BackgroundReason): () => void;
  /** Active hold counts by reason (for diagnostics and tests). */
  holds(): Record<BackgroundReason, number>;
  /** True when at least one background hold is active. */
  readonly held: boolean;
  /** Wake immediately for a notification tap or foreground resume; idempotent while awake. */
  wake(): void;
  /** Request immediate sleep if currently in the background and no hold is active (used after push wakes). */
  sleepNowIfAway(): void;
  /** Cancel timers. */
  dispose(): void;
};

export function createBackgroundController(options: BackgroundPolicyOptions): BackgroundController {
  const graceMs = options.graceMs ?? BACKGROUND_GRACE_MS;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;

  let appState = options.initialState ?? "active";
  let sleeping = appState === "background";
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const activeHolds = new Map<symbol, BackgroundReason>();

  function clearGrace() {
    if (graceTimer !== null) {
      cancel(graceTimer);
      graceTimer = null;
    }
  }

  function enterSleep() {
    clearGrace();
    if (appState !== "background" || activeHolds.size > 0) return;
    if (sleeping) return;
    sleeping = true;
    options.onSleep();
  }

  function scheduleGrace() {
    clearGrace();
    if (appState !== "background" || sleeping || activeHolds.size > 0) return;
    if (graceMs <= 0) {
      enterSleep();
      return;
    }
    graceTimer = schedule(() => {
      graceTimer = null;
      enterSleep();
    }, graceMs);
  }

  function wakeNow() {
    clearGrace();
    if (!sleeping) return;
    sleeping = false;
    options.onWake();
  }

  return {
    get appState() {
      return appState;
    },
    get sleeping() {
      return sleeping;
    },
    get held() {
      return activeHolds.size > 0;
    },
    holds() {
      const counts: Record<BackgroundReason, number> = { upload: 0, voice: 0, watch: 0, push: 0 };
      for (const reason of activeHolds.values()) counts[reason]++;
      return counts;
    },
    setAppState(next: string) {
      const previous = appState;
      appState = next;
      if (next === "active") {
        // Returning from background or inactive while sleeping wakes once.
        clearGrace();
        if (sleeping) {
          sleeping = false;
          options.onWake();
        } else if (previous === "background") {
          // Returned within the grace window: link never closed, still tell caller to wake/refresh.
          options.onWake();
        }
      } else if (next === "background") {
        if (previous !== "background") options.onBackground?.();
        scheduleGrace();
      }
    },
    hold(reason: BackgroundReason) {
      const token = Symbol(reason);
      activeHolds.set(token, reason);
      // A hold started during the grace window prevents sleep; one started while already asleep
      // wakes the link so background callers (Watch voice, push, uploads) get a live connection
      // and release() cleanly returns to sleep afterwards.
      if (sleeping) wakeNow();
      else clearGrace();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeHolds.delete(token);
        if (appState === "background" && activeHolds.size === 0 && !sleeping) {
          // If the app is still backgrounded when the last hold ends, close after grace (or immediately for push).
          if (reason === "push") enterSleep();
          else scheduleGrace();
        }
      };
    },
    wake() {
      wakeNow();
    },
    sleepNowIfAway() {
      if (appState !== "active" && activeHolds.size === 0) {
        clearGrace();
        if (!sleeping) {
          sleeping = true;
          options.onSleep();
        }
      }
    },
    dispose() {
      clearGrace();
      activeHolds.clear();
    },
  };
}
