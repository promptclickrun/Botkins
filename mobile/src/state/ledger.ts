// Dev-only resource ledger for diagnosing battery and wakeups on a real phone.
// Tracks active and recently stopped app-owned animation loops, timers, polls, sockets,
// screen feeds, keep-awake locks, and mic sessions. Never stores message content or tokens.
// Release builds pay nothing: when disabled, trackResource() returns a shared frozen no-op.

export type ResourceKind = "animation" | "timer" | "poll" | "socket" | "feed" | "keep-awake" | "mic";

export type ResourceEntry = {
  id: number;
  kind: ResourceKind;
  owner: string;
  hostId?: string;
  reason: string;
  startedAt: number;
  stoppedAt: number | null;
  ticks: number;
  lastFailure?: string;
};

export type ResourceHandle = {
  bump: (count?: number) => void;
  fail: (reason: string) => void;
  release: () => void;
};

export type LedgerSnapshot = {
  enabled: boolean;
  totalActive: number;
  activeByKind: Record<ResourceKind, number>;
  counters: Record<ResourceKind, number>;
  active: ResourceEntry[];
  recentStopped: ResourceEntry[];
};

const ALL_KINDS: readonly ResourceKind[] = ["animation", "timer", "poll", "socket", "feed", "keep-awake", "mic"];
const MAX_RECENT = 60;

const NOOP: ResourceHandle = Object.freeze({
  bump() {},
  fail() {},
  release() {},
});

let overrideEnabled: boolean | undefined;
let nextId = 1;
const activeMap = new Map<number, ResourceEntry>();
const recentStopped: ResourceEntry[] = [];
const counters: Record<ResourceKind, number> = emptyCounts();

function emptyCounts(): Record<ResourceKind, number> {
  return {
    animation: 0,
    timer: 0,
    poll: 0,
    socket: 0,
    feed: 0,
    "keep-awake": 0,
    mic: 0,
  };
}

/** Enabled in dev builds or when explicitly flipped on for tests/diagnostics. Release pays nothing. */
export function isLedgerEnabled(): boolean {
  if (overrideEnabled !== undefined) return overrideEnabled;
  return typeof __DEV__ !== "undefined" && Boolean(__DEV__);
}

export function setLedgerEnabled(enabled: boolean | undefined): void {
  overrideEnabled = enabled;
}

export function resetLedger(): void {
  activeMap.clear();
  recentStopped.length = 0;
  for (const kind of ALL_KINDS) counters[kind] = 0;
  nextId = 1;
}

function sanitizeLabel(value: string): string {
  // Keep only short metadata; never allow multiline payloads or large blobs into the ledger.
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
}

export function trackResource(kind: ResourceKind, owner: string, reason: string, hostId?: string): ResourceHandle {
  if (!isLedgerEnabled()) return NOOP;
  const id = nextId++;
  const entry: ResourceEntry = {
    id,
    kind,
    owner: sanitizeLabel(owner),
    ...(hostId ? { hostId: sanitizeLabel(hostId) } : {}),
    reason: sanitizeLabel(reason),
    startedAt: Date.now(),
    stoppedAt: null,
    ticks: 0,
  };
  activeMap.set(id, entry);
  counters[kind] += 1;

  let released = false;
  return {
    bump(count = 1) {
      if (released) return;
      entry.ticks += count;
    },
    fail(errorCode: string) {
      entry.lastFailure = sanitizeLabel(errorCode);
    },
    release() {
      if (released) return;
      released = true;
      entry.stoppedAt = Date.now();
      activeMap.delete(id);
      recentStopped.push({ ...entry });
      if (recentStopped.length > MAX_RECENT) recentStopped.shift();
    },
  };
}

export function ledgerSnapshot(): LedgerSnapshot {
  const activeByKind = emptyCounts();
  const active: ResourceEntry[] = [];
  for (const entry of activeMap.values()) {
    activeByKind[entry.kind] += 1;
    active.push({ ...entry });
  }
  return {
    enabled: isLedgerEnabled(),
    totalActive: active.length,
    activeByKind,
    counters: { ...counters },
    active,
    recentStopped: recentStopped.map((entry) => ({ ...entry })),
  };
}

// Expose a read-only diagnostic hook in dev builds for Xcode / Metro / Safari inspector checks.
if (typeof globalThis !== "undefined" && typeof __DEV__ !== "undefined" && __DEV__) {
  (globalThis as Record<string, unknown>).__BOTKINS_LEDGER__ = {
    snapshot: ledgerSnapshot,
    reset: resetLedger,
    setEnabled: setLedgerEnabled,
  };
}
