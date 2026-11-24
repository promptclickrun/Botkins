// Pure state and keyboard helpers for an opened panel (`SpacePanelOpen.tsx`), kept free of
// window/DOM imports so unit tests can import it directly under Node.

export const PANEL_FULLSCREEN_SUFFIX = "panel.fullscreen";
export const FRAME_KEY_EVENT = "botkins-frame-key";

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
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
};

export type OpenedPanelKeyAction = "restore" | "close" | "toggle" | null;
export type PanelFullscreenSource = "toggle" | "escape" | "initial";
export type PanelCancelAction = "restore" | "close" | "ignore";
export type FrameKeyKind = "toggle" | "escape";

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

/** Picks the starting full-screen mode without changing the remembered choice. */
export function resolvePanelFullscreen(initial: boolean | undefined, key: string, storage: StorageLike | null = defaultStorage()): boolean {
  if (typeof initial === "boolean") return initial;
  return readPanelFullscreen(key, storage);
}

/** Only an explicit toggle (button or Cmd/Ctrl+Shift+F) changes the remembered full-screen choice. */
export function shouldPersistPanelFullscreen(source: PanelFullscreenSource): boolean {
  return source === "toggle";
}

/** Whether a keyboard event is a live Cmd/Ctrl+Shift+F toggle shortcut. */
export function isPanelFullscreenShortcut(e: PanelKeyEvent): boolean {
  if (e.repeat || e.isComposing || e.defaultPrevented) return false;
  return !!(e.metaKey || e.ctrlKey) && !!e.shiftKey && !e.altKey && e.key.toLowerCase() === "f";
}

/** Keyboard action for an opened panel: Esc restores full screen before closing; Cmd/Ctrl+Shift+F toggles. */
export function openedPanelKeyAction(e: PanelKeyEvent, fullscreen: boolean): OpenedPanelKeyAction {
  if (e.repeat || e.isComposing || e.defaultPrevented) return null;
  if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) return fullscreen ? "restore" : "close";
  if (isPanelFullscreenShortcut(e)) return "toggle";
  return null;
}

/** Decides how an opened panel's <dialog> handles a native `cancel` event. */
export function panelCancelAction(fullscreen: boolean, isOwnTarget: boolean): PanelCancelAction {
  if (!isOwnTarget) return "ignore";
  return fullscreen ? "restore" : "close";
}

/** Maps a key message forwarded from a focused sandboxed frame to an opened-panel action. */
export function frameKeyAction(kind: unknown, fullscreen: boolean): OpenedPanelKeyAction {
  if (kind === "toggle") return "toggle";
  if (kind === "escape") return fullscreen ? "restore" : "close";
  return null;
}
