// A place being dragged: a tile from the All page toward the side menu, or a row of the side menu
// to another position on it or off it. The browser lets a drop target read what is dragged only on
// the drop itself, so the place is kept here while the drag lasts, and both ends follow it (the
// menu shows where it would land; All says a row dropped there comes off the menu).
import { type DragEvent, useSyncExternalStore } from "react";
import type { Place } from "./places";

export type PlaceDrag = { place: Place; from: "menu" | "all" };
/** The kind of data a dragged place carries, so only a place is taken where a place can land. */
export const PLACE_DATA = "application/x-botkins-place";

let held: PlaceDrag | null = null;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const placeDrag = {
  get: () => held,
  start(e: DragEvent, place: Place, from: PlaceDrag["from"]) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(PLACE_DATA, place);
    e.dataTransfer.setData("text/plain", place);
    held = { place, from };
    tell();
  },
  end() {
    if (!held) return;
    held = null;
    tell();
  },
  /** Whether a drag over this element is a place (and so may be dropped). */
  carries: (e: DragEvent) => !!held && e.dataTransfer.types.includes(PLACE_DATA),
};

/** The place being dragged now, or null. */
export const usePlaceDrag = () => useSyncExternalStore(subscribe, placeDrag.get);
