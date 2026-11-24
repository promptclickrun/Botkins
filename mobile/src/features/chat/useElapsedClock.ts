// Visible elapsed-time labels share one timer. The last reader leaving stops it.
import { useIsFocused } from "expo-router";
import { useSyncExternalStore } from "react";
import { useAppActive } from "@/state/useAppActive";

const readers = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(reader: () => void) {
  readers.add(reader);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of readers) notify();
    }, 1000);
  }
  return () => {
    readers.delete(reader);
    if (!readers.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const skip = () => () => {};
const read = () => now;

export function useElapsedClock(running: boolean) {
  const focused = useIsFocused();
  const active = useAppActive(running && focused);
  const tick = useSyncExternalStore(active ? subscribe : skip, read);
  return active ? tick : Date.now();
}
