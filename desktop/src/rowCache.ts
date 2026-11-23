import { useRef, type ReactNode } from "react";

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/**
 * Keeps the element a row last made, the way the phone's chat keeps its rows (`reuseItems`): while a
 * row's `deps` are the same, the very same element comes back, so React skips the row and nothing
 * under it runs. Rows not asked for in a render are dropped. `deps` must list everything the row
 * reads from outside itself (a stale row is the cost of leaving one out).
 */
export function useRowCache() {
  const kept = useRef(new Map<string, { deps: readonly unknown[]; node: ReactNode }>());
  const seen = useRef(new Set<string>());
  return {
    /**
     * The row under `key`: the kept element while `deps` hold, else what `build` makes (when it makes
     * one). With `deps` null the row is made every time (a row that is live).
     */
    row(key: string, deps: readonly unknown[] | null, build: () => ReactNode | null): ReactNode | null {
      seen.current.add(key);
      const old = kept.current.get(key);
      if (deps && old && same(old.deps, deps)) return old.node;
      const node = build();
      if (deps && node !== null) kept.current.set(key, { deps, node });
      else kept.current.delete(key);
      return node;
    },
    /** Called once at the end of a render. */
    sweep() {
      for (const key of kept.current.keys()) if (!seen.current.has(key)) kept.current.delete(key);
      seen.current = new Set();
    },
  };
}
