// Enforces at most one active screen feed per (hostId, display) and records feed lifetimes in
// the dev-only resource ledger. Pure TypeScript so tests run without React Native.
import { trackResource, type ResourceHandle } from "@/state/ledger";

type ActiveFeed = {
  id: number;
  abort: () => void;
  ledger: ResourceHandle;
};

const activeFeeds = new Map<string, ActiveFeed>();
let nextFeedId = 1;

export function feedKey(hostId: string, display?: string): string {
  return `${hostId}:${display ?? "primary"}`;
}

/**
 * Claim the single active screen-feed slot for `(hostId, display)`. If another feed is already
 * running for the same host/display (e.g., a passive pane preview when full-screen Remote opens),
 * the previous feed is aborted first so at most one feed runs per host/display.
 */
export function claimScreenFeed(hostId: string, display: string | undefined, owner: string, abort: () => void): () => void {
  const key = feedKey(hostId, display);
  const existing = activeFeeds.get(key);
  if (existing) {
    activeFeeds.delete(key);
    existing.ledger.release();
    existing.abort();
  }
  const id = nextFeedId++;
  const ledger = trackResource("feed", owner, `screen:${display ?? "primary"}`, hostId);
  activeFeeds.set(key, { id, abort, ledger });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = activeFeeds.get(key);
    if (current?.id === id) {
      activeFeeds.delete(key);
    }
    ledger.release();
  };
}

export function activeFeedCount(): number {
  return activeFeeds.size;
}
