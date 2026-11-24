// One native subscription for work that belongs to the foreground. Take a fresh snapshot on
// subscribe so an app-state change between render and mount cannot leave a timer running.
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

const listeners = new Set<() => void>();
let subscription: ReturnType<typeof AppState.addEventListener> | undefined;
function subscribe(fn: () => void) {
  listeners.add(fn);
  subscription ??= AppState.addEventListener("change", () => {
    for (const listener of listeners) listener();
  });
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      subscription?.remove();
      subscription = undefined;
    }
  };
}
const skip = () => () => {};
const active = () => AppState.currentState === "active";
const off = () => false;

export function useAppActive(enabled = true) {
  return useSyncExternalStore(enabled ? subscribe : skip, enabled ? active : off);
}
