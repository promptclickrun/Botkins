// Pure state and keyboard helpers for an opened panel (`SpacePanelOpen.tsx`), kept free of
// window/DOM imports so unit tests can import it directly under Node.

export const PANEL_FULLSCREEN_SUFFIX = "panel.fullscreen";

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type PanelKeyEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

export type OpenedPanelKeyAction = "restore" | "close" | "toggle" | null;

const defaultStorage = (): StorageLike | null => (typeof localStorage === "undefined" ? null : localStorage);

/** Reads whether the person last chose full-screen mode for opened panels. */
export function readPanelFullscreen(key: string, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Saves the person's full-screen choice for future opened panels in this window. */
export function writePanelFullscreen(key: string, fullscreen: boolean, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(key, fullscreen ? "1" : "0");
  } catch {
    // Storage may be unavailable or full.
  }
}

/** Picks the starting full-screen mode: an explicit open choice wins over the remembered choice. */
export function resolvePanelFullscreen(initial: boolean | undefined, key: string, storage: StorageLike | null = defaultStorage()): boolean {
  if (typeof initial === "boolean") return initial;
  return readPanelFullscreen(key, storage);
}

/** Keyboard action for an opened panel: Esc restores full screen before closing; Cmd/Ctrl+Shift+F toggles. */
export function openedPanelKeyAction(e: PanelKeyEvent, fullscreen: boolean): OpenedPanelKeyAction {
  if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) return fullscreen ? "restore" : "close";
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") return "toggle";
  return null;
}
