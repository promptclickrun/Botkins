import type { AvatarState } from "@/state/hooks";

export const avatarMotion = {
  idle: "rest",
  waiting: "rest",
  "needs-input": "rest",
  pending: "rest",
  sleeping: "rest",
  thinking: "loop",
  planning: "loop",
  browsing: "loop",
  coding: "loop",
  working: "loop",
  retrying: "loop",
  talking: "loop",
  listening: "loop",
  completed: "once",
  happy: "once",
  error: "once",
  like: "once",
  love: "once",
  laugh: "once",
  sad: "once",
} as const satisfies Record<AvatarState, "rest" | "loop" | "once">;

export type AvatarMotionMode = "off" | "focal" | "list";

/** Maximum number of Chats-list rows allowed to loop concurrently (2026-11-24 battery rule). */
export const MAX_LIST_AVATAR_LOOPS = 3;

const LIST_WORKING_STATES: ReadonlySet<AvatarState> = new Set([
  "thinking",
  "planning",
  "browsing",
  "coding",
  "working",
  "retrying",
]);

/** True when a list row's bot is actively working and eligible for a capped loop slot. */
export function isListWorkingState(state: AvatarState): boolean {
  return LIST_WORKING_STATES.has(state);
}

/** The phone's setting and its accessibility preference both override a caller's motion request. */
export function avatarCanMove(enabled: boolean, reducedMotion: boolean, requested: boolean) {
  return enabled && !reducedMotion && requested;
}

export type ResolvedAvatarMotion = {
  allowMotion: boolean;
  allowRest: boolean;
  allowBlink: boolean;
};

/**
 * Decide which motion passes an avatar may run:
 * - Focal avatars (Home primary bot, bot page, live voice) keep full motion, rest beats, and blinks.
 * - List avatars (Chats list rows) hold their state pose: never run idle/rest passes or blinks,
 *   and may loop only while actively working and holding one of the capped visible loop slots.
 */
export function resolveAvatarMotion({
  enabled,
  reducedMotion,
  mode,
  state,
  animated,
  hasLoopSlot,
}: {
  enabled: boolean;
  reducedMotion: boolean;
  mode: AvatarMotionMode;
  state: AvatarState;
  animated?: boolean;
  hasLoopSlot: boolean;
}): ResolvedAvatarMotion {
  if (!enabled || reducedMotion || animated === false) {
    return { allowMotion: false, allowRest: false, allowBlink: false };
  }
  const effectiveMode: AvatarMotionMode = animated === true ? "focal" : mode;
  if (effectiveMode === "off") {
    return { allowMotion: false, allowRest: false, allowBlink: false };
  }
  if (effectiveMode === "list") {
    return {
      allowMotion: isListWorkingState(state) && hasLoopSlot,
      allowRest: false,
      allowBlink: false,
    };
  }
  return { allowMotion: true, allowRest: true, allowBlink: true };
}

export type AvatarLoopBudget = {
  acquire: (id: string) => boolean;
  release: (id: string) => void;
  has: (id: string) => boolean;
  activeCount: () => number;
  subscribe: (listener: () => void) => () => void;
};

/** Caps how many list avatars may run a working loop at the same time. */
export function createAvatarLoopBudget(limit = MAX_LIST_AVATAR_LOOPS): AvatarLoopBudget {
  const active = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    acquire(id: string) {
      if (active.has(id)) return true;
      if (active.size >= limit) return false;
      active.add(id);
      notify();
      return true;
    },
    release(id: string) {
      if (!active.delete(id)) return;
      notify();
    },
    has(id: string) {
      return active.has(id);
    },
    activeCount() {
      return active.size;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// The owner can tune the shared rest beat and the spread of starts within it.
export const REST_BEAT_MS = 30_000;
export const REST_SPREAD_MS = 900;
// How late a pass may start. A timer is often tens of milliseconds late; only one that slept through the window skips.
export const REST_LATE_MS = 1_500;
const hash = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);

export function nextPass(nowMs: number, name: string) {
  return REST_BEAT_MS - (nowMs % REST_BEAT_MS) + hash(name) % (REST_SPREAD_MS + 1);
}

export function scheduleRestPasses(name: string, play: () => void) {
  const wait = () => setTimeout(wake, nextPass(Date.now(), name));
  function wake() {
    // A suspended app may sleep through the window: then skip this pass and rejoin the next beat.
    if (Date.now() % REST_BEAT_MS <= REST_SPREAD_MS + REST_LATE_MS) play();
    timer = wait();
  }
  let timer = wait();
  return () => clearTimeout(timer);
}

export function avatarBeat(name: string) {
  const seed = hash(name);
  const blinkMs = 3800 + seed % 1201;
  return { blinkMs, firstBlinkMs: seed % 2200 + blinkMs * 0.92 };
}

/** Wake once per pass. Between calls only the next timeout is pending. */
export function schedulePasses(firstMs: number, periodMs: number, play: () => void) {
  function wake() {
    play();
    timer = setTimeout(wake, periodMs);
  }
  let timer = setTimeout(wake, firstMs);
  return () => clearTimeout(timer);
}
