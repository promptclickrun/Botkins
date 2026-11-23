import { useRef } from "react";

/**
 * The function props of `props`, each as one function that never changes and calls the newest one.
 * A function the parent makes anew on every render would otherwise make everything that holds it
 * different on every render. A missing function stays missing.
 */
export function useStableFunctions<P extends Record<string, unknown>>(props: P): P {
  const latest = useRef(props);
  latest.current = props;
  const made = useRef<Record<string, unknown>>({});
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    if (typeof value !== "function") {
      out[name] = value;
      delete made.current[name];
    } else out[name] = made.current[name] ??= (...args: unknown[]) => (latest.current[name] as (...a: unknown[]) => unknown)(...args);
  }
  return out as P;
}
