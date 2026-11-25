// At most one screen feed runs per computer, and the ledger (dev only) records each feed's life.
// A phone shows one picture of a computer at a time, so the slot is per computer, not per display:
// the pane's `display: undefined` and Settings › Screen's display id would otherwise never meet.
// The bigger view wins: Settings › Screen over the side pane over a chat card. A view that loses
// the slot (or can't take it) waits, and takes it back when the slot is free. Pure TypeScript, so
// the tests run it without React Native.
import { trackResource, type ResourceHandle } from "@/state/ledger";

type ActiveFeed = {
  id: number;
  rank: number;
  abort: () => void;
  ledger: ResourceHandle;
};

/** Settings › Screen, then the side pane, then a chat card's single still. */
export type ScreenFeedOwner = "Remote" | "PaneScreen" | "ScreenCard";
const RANK: Record<string, number> = { Remote: 3, PaneScreen: 2, ScreenCard: 1 };

const activeFeeds = new Map<string, ActiveFeed>();
const freeWaiters = new Map<string, Set<() => void>>();
let nextFeedId = 1;

export function feedKey(hostId: string): string {
  return hostId;
}

/**
 * Claims the computer's one feed slot. A holder of the same or a smaller rank is aborted (its
 * `abort` runs) and the new feed takes the slot. A bigger holder keeps it: the claim answers null,
 * and the caller waits with `whenScreenFeedFree`. Otherwise it answers the release.
 */
export function claimScreenFeed(hostId: string, display: string | undefined, owner: string, abort: () => void): (() => void) | null {
  const key = feedKey(hostId);
  const rank = RANK[owner] ?? 0;
  const existing = activeFeeds.get(key);
  if (existing) {
    if (existing.rank > rank) return null;
    activeFeeds.delete(key);
    existing.ledger.release();
    existing.abort();
  }
  const id = nextFeedId++;
  const ledger = trackResource("feed", owner, `screen:${display ?? "primary"}`, hostId);
  activeFeeds.set(key, { id, rank, abort, ledger });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ledger.release();
    if (activeFeeds.get(key)?.id !== id) return;
    activeFeeds.delete(key);
    const waiting = freeWaiters.get(key);
    if (!waiting?.size) return;
    freeWaiters.delete(key);
    for (const wake of waiting) wake();
  };
}

/** Calls `wake` once, the next time the computer's feed slot is let go. Answers the cancel. */
export function whenScreenFeedFree(hostId: string, wake: () => void): () => void {
  const key = feedKey(hostId);
  let waiting = freeWaiters.get(key);
  if (!waiting) freeWaiters.set(key, (waiting = new Set()));
  waiting.add(wake);
  const held = waiting;
  return () => {
    held.delete(wake);
    if (!held.size && freeWaiters.get(key) === held) freeWaiters.delete(key);
  };
}

export function activeFeedCount(): number {
  return activeFeeds.size;
}
