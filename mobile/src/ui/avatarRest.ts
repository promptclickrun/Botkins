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
