import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FRAME_KEY_EVENT,
  PANEL_FULLSCREEN_SUFFIX,
  frameKeyAction,
  isPanelFullscreenShortcut,
  openedPanelKeyAction,
  panelCancelAction,
  readPanelFullscreen,
  resolvePanelFullscreen,
  shouldPersistPanelFullscreen,
  writePanelFullscreen,
} from "../src/panelOpen.ts";

const TEST_KEY = "botkins." + PANEL_FULLSCREEN_SUFFIX;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

describe("panelOpen helpers", () => {
  it("stores and reads the remembered fullscreen choice", () => {
    assert.equal(PANEL_FULLSCREEN_SUFFIX, "panel.fullscreen");
    assert.equal(FRAME_KEY_EVENT, "botkins-frame-key");
    const store = memoryStorage();
    assert.equal(readPanelFullscreen(TEST_KEY, store), false);
    writePanelFullscreen(TEST_KEY, true, store);
    assert.equal(readPanelFullscreen(TEST_KEY, store), true);
    writePanelFullscreen(TEST_KEY, false, store);
    assert.equal(readPanelFullscreen(TEST_KEY, store), false);
  });

  it("handles missing or throwing storage without failing", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    assert.equal(readPanelFullscreen(TEST_KEY, null), false);
    assert.equal(readPanelFullscreen(TEST_KEY, broken), false);
    assert.doesNotThrow(() => writePanelFullscreen(TEST_KEY, true, null));
    assert.doesNotThrow(() => writePanelFullscreen(TEST_KEY, true, broken));
  });

  it("uses an explicit initial mode without changing the remembered choice", () => {
    const store = memoryStorage({ [TEST_KEY]: "0" });
    assert.equal(resolvePanelFullscreen(undefined, TEST_KEY, store), false);
    assert.equal(resolvePanelFullscreen(true, TEST_KEY, store), true);
    // One-shot "Open full screen" leaves the remembered default untouched for later panels.
    assert.equal(readPanelFullscreen(TEST_KEY, store), false);
    assert.equal(resolvePanelFullscreen(undefined, TEST_KEY, store), false);

    writePanelFullscreen(TEST_KEY, true, store);
    assert.equal(resolvePanelFullscreen(undefined, TEST_KEY, store), true);
    assert.equal(resolvePanelFullscreen(false, TEST_KEY, store), false);
    assert.equal(readPanelFullscreen(TEST_KEY, store), true);
  });

  it("persists fullscreen only for explicit toggles, not one-shot open or Escape restore", () => {
    assert.equal(shouldPersistPanelFullscreen("toggle"), true);
    assert.equal(shouldPersistPanelFullscreen("initial"), false);
    assert.equal(shouldPersistPanelFullscreen("escape"), false);
  });

  it("matches only Cmd/Ctrl+Shift+F when not repeating, composing, or already handled", () => {
    assert.equal(isPanelFullscreenShortcut({ key: "f", metaKey: true, shiftKey: true }), true);
    assert.equal(isPanelFullscreenShortcut({ key: "F", metaKey: true, shiftKey: true }), true);
    assert.equal(isPanelFullscreenShortcut({ key: "F", ctrlKey: true, shiftKey: true }), true);
    assert.equal(isPanelFullscreenShortcut({ key: "f", metaKey: true, shiftKey: false }), false);
    assert.equal(isPanelFullscreenShortcut({ key: "f", metaKey: true, shiftKey: true, altKey: true }), false);
    assert.equal(isPanelFullscreenShortcut({ key: "f", shiftKey: true }), false);
    assert.equal(isPanelFullscreenShortcut({ key: "Escape" }), false);
    assert.equal(isPanelFullscreenShortcut({ key: "f", metaKey: true, shiftKey: true, repeat: true }), false);
    assert.equal(isPanelFullscreenShortcut({ key: "f", metaKey: true, shiftKey: true, isComposing: true }), false);
    assert.equal(isPanelFullscreenShortcut({ key: "f", metaKey: true, shiftKey: true, defaultPrevented: true }), false);
  });

  it("maps Escape and Cmd/Ctrl+Shift+F while ignoring repeats, IME composition, and handled events", () => {
    assert.equal(openedPanelKeyAction({ key: "Escape" }, true), "restore");
    assert.equal(openedPanelKeyAction({ key: "Escape" }, false), "close");
    assert.equal(openedPanelKeyAction({ key: "Escape", metaKey: true }, true), null);
    assert.equal(openedPanelKeyAction({ key: "Escape", ctrlKey: true }, false), null);
    assert.equal(openedPanelKeyAction({ key: "Escape", repeat: true }, true), null);
    assert.equal(openedPanelKeyAction({ key: "Escape", isComposing: true }, true), null);
    assert.equal(openedPanelKeyAction({ key: "Escape", defaultPrevented: true }, false), null);
    assert.equal(openedPanelKeyAction({ key: "f", metaKey: true, shiftKey: true }, false), "toggle");
    assert.equal(openedPanelKeyAction({ key: "F", ctrlKey: true, shiftKey: true }, true), "toggle");
    assert.equal(openedPanelKeyAction({ key: "f", metaKey: true, shiftKey: true, repeat: true }, false), null);
    assert.equal(openedPanelKeyAction({ key: "f", metaKey: true, shiftKey: true, isComposing: true }, false), null);
    assert.equal(openedPanelKeyAction({ key: "f", metaKey: true, shiftKey: true, defaultPrevented: true }, false), null);
  });

  it("handles native dialog cancel only for its own target", () => {
    assert.equal(panelCancelAction(true, true), "restore");
    assert.equal(panelCancelAction(false, true), "close");
    assert.equal(panelCancelAction(true, false), "ignore");
    assert.equal(panelCancelAction(false, false), "ignore");
  });

  it("maps forwarded iframe key messages to panel actions", () => {
    assert.equal(frameKeyAction("toggle", false), "toggle");
    assert.equal(frameKeyAction("toggle", true), "toggle");
    assert.equal(frameKeyAction("escape", true), "restore");
    assert.equal(frameKeyAction("escape", false), "close");
    assert.equal(frameKeyAction("other", true), null);
    assert.equal(frameKeyAction(undefined, false), null);
  });
});
