// Count only timers started by phone source in the shared fake clock. The host and test runner
// have their own timers in this process. A frame uses the batcher's one-shot fallback in Node.
import type { TestContext } from "node:test";

export function countPhoneTimers(t: TestContext) {
  const active = new Map<unknown, string>();
  const fired: Record<string, number> = {};
  let peak = 0;
  for (const [start, stop] of [["setTimeout", "clearTimeout"], ["setInterval", "clearInterval"]] as const) {
    const schedule = globalThis[start];
    const cancel = globalThis[stop];
    globalThis[start] = function (callback, ms, ...args) {
      const owner = new Error().stack?.match(/\/mobile\/(?:src\/([^:\s)]+)|link-host\/)/)?.[1];
      if (!owner) return schedule(callback, ms, ...args);
      const handle = schedule((...values) => {
        if (start === "setTimeout") active.delete(handle);
        fired[owner] = (fired[owner] ?? 0) + 1;
        callback(...values);
      }, ms, ...args);
      active.set(handle, owner);
      peak = Math.max(peak, active.size);
      return handle;
    };
    globalThis[stop] = (handle) => { active.delete(handle); return cancel(handle); };
    t.after(() => { globalThis[start] = schedule; globalThis[stop] = cancel; });
  }
  return {
    reset() { peak = active.size; for (const key of Object.keys(fired)) delete fired[key]; },
    snapshot: () => ({ active: [...active.values()].sort(), peak, fired: { ...fired } }),
  };
}
