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
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
};

export type PanelFullscreenSource = "toggle" | "escape" | "initial";
export type PanelCancelAction = "restore" | "close" | "ignore";
export type TrustedFrameKeyKind = "toggle" | "escape";
export type TrustedFrameKeyAction = "toggle" | "restore" | null;

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

/** Whether a dialog keydown is an auto-repeated Escape whose default must be suppressed. */
export function isRepeatedPanelEscape(e: PanelKeyEvent): boolean {
  if (!e.repeat || e.isComposing || e.defaultPrevented) return false;
  return e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Decides how an opened panel's <dialog> handles a native `cancel` event. */
export function panelCancelAction(fullscreen: boolean, isOwnTarget: boolean): PanelCancelAction {
  if (!isOwnTarget) return "ignore";
  return fullscreen ? "restore" : "close";
}

/** Maps a trusted main-process key event from a focused panel iframe to an opened-panel action. */
export function trustedFrameKeyAction(kind: unknown, fullscreen: boolean): TrustedFrameKeyAction {
  if (kind === "toggle") return "toggle";
  if (kind === "escape") return fullscreen ? "restore" : null;
  return null;
}

/**
 * A space's page in full screen (`SpacePage.tsx`). The root carries this while it is on, and the
 * shell's CSS hides the side menu, the banners and the app's chrome. Nothing about it is saved.
 */
export const SPACE_FULLSCREEN = "space";
export type SpaceFullscreenKeyAction = "toggle" | "exit" | null;

/**
 * What a key pressed over a space's page does to its full screen. While a dialog is open over the
 * page the keys are the dialog's: an opened panel uses the same ⇧⌘F for its own full screen, and
 * Escape closes or restores it, so the space keeps out of the way.
 */
export function spaceFullscreenKeyAction(e: PanelKeyEvent, on: boolean, dialogOpen: boolean): SpaceFullscreenKeyAction {
  if (dialogOpen) return null;
  if (isPanelFullscreenShortcut(e)) return "toggle";
  if (!on || e.repeat || e.isComposing || e.defaultPrevented) return null;
  return e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey ? "exit" : null;
}
