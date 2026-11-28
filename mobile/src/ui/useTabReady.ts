// Tab shell and isolation helpers:
// 1. `useTabReady`: a tab's first frame mounts a light shell (header + LoadingGrid), then promotes
//    to full content via `startTransition` after the first paint — keeping the native tab switch
//    responsive even on a tab's very first mount, and staying mounted once visited.
// 2. `useFrozenWhenHidden`: freezes the value returned to a tab's body while the tab is not in view,
//    so store updates triggered on another tab (e.g. a chat updating on Chats, or a task updating on
//    Work) don't re-render backgrounded tabs until they come back into view.
import { startTransition, useEffect, useRef, useState } from "react";
import { useOnShow } from "./useOnShow";

/**
 * Returns false on the tab's very first render so the tab can paint a light shell (header + LoadingGrid)
 * immediately, then flips to true in a React transition right after mount and stays true forever
 * while the tab remains mounted.
 *
 * Pass `immediate` (e.g. for Home, which is already the initial landing tab) to skip the shell frame.
 */
export function useTabReady(immediate = false): boolean {
  const [ready, setReady] = useState(immediate);
  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => {
            if (!cancelled) startTransition(() => setReady(true));
          })
        : (setTimeout(() => {
            if (!cancelled) startTransition(() => setReady(true));
          }, 0) as unknown as number);
    return () => {
      cancelled = true;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      else clearTimeout(raf);
    };
  }, [ready]);
  return ready;
}

/**
 * Returns `value` when the current screen is visible, and holds the last visible snapshot while
 * another tab is in front. Pair with React.memo on the tab's body so background store updates
 * don't re-render hidden tabs.
 */
export function useFrozenWhenHidden<T>(value: T): T {
  const shown = useOnShow();
  const held = useRef(value);
  if (shown) held.current = value;
  return held.current;
}
