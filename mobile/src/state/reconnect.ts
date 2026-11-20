const MIN_GAP = 20_000;
const MAX_GAP = 5 * 60_000;

export class NearbyPace {
  private last = -Infinity;
  private next = -Infinity;
  private gap = MIN_GAP;
  private pending = false;

  allowed(now: number) {
    return now >= this.next;
  }

  started(now: number) {
    this.last = now;
    this.next = now + MIN_GAP;
    this.pending = true;
  }

  missed(now: number) {
    // A reset during the browse takes precedence over its late result.
    if (!this.pending) return;
    this.next = now + this.gap;
    this.gap = Math.min(this.gap * 2, MAX_GAP);
    this.pending = false;
  }

  reset() {
    this.next = this.last + MIN_GAP;
    this.gap = MIN_GAP;
    this.pending = false;
  }
}

export function canBrowse(network?: { type?: string; isConnected?: boolean }) {
  return network?.isConnected !== false && network?.type !== "CELLULAR" && network?.type !== "NONE";
}
