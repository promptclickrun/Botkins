import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PANEL_OPEN_FRAMES, normalizePanelFrameId, normalizePanelFrameIds, panelKeyFromInput } from "../desktop/frames.mjs";
import {
  PANEL_FULLSCREEN_SUFFIX,
  isPanelFullscreenShortcut,
  isRepeatedPanelEscape,
  panelCancelAction,
  readPanelFullscreen,
  resolvePanelFullscreen,
  shouldPersistPanelFullscreen,
  trustedFrameKeyAction,
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

  it("suppresses only repeated unmodified Escape keydowns", () => {
    assert.equal(isRepeatedPanelEscape({ key: "Escape", repeat: true }), true);
    assert.equal(isRepeatedPanelEscape({ key: "Escape", repeat: false }), false);
    assert.equal(isRepeatedPanelEscape({ key: "Escape" }), false);
    assert.equal(isRepeatedPanelEscape({ key: "Escape", repeat: true, metaKey: true }), false);
    assert.equal(isRepeatedPanelEscape({ key: "Escape", repeat: true, ctrlKey: true }), false);
    assert.equal(isRepeatedPanelEscape({ key: "Escape", repeat: true, altKey: true }), false);
    assert.equal(isRepeatedPanelEscape({ key: "Escape", repeat: true, shiftKey: true }), false);
    assert.equal(isRepeatedPanelEscape({ key: "Escape", repeat: true, isComposing: true }), false);
    assert.equal(isRepeatedPanelEscape({ key: "Escape", repeat: true, defaultPrevented: true }), false);
    assert.equal(isRepeatedPanelEscape({ key: "Enter", repeat: true }), false);
  });

  it("handles native dialog cancel only for its own target", () => {
    assert.equal(panelCancelAction(true, true), "restore");
    assert.equal(panelCancelAction(false, true), "close");
    assert.equal(panelCancelAction(true, false), "ignore");
    assert.equal(panelCancelAction(false, false), "ignore");
  });

  it("maps trusted main-process frame keys without ever closing on Escape", () => {
    assert.equal(trustedFrameKeyAction("toggle", false), "toggle");
    assert.equal(trustedFrameKeyAction("toggle", true), "toggle");
    assert.equal(trustedFrameKeyAction("escape", true), "restore");
    assert.equal(trustedFrameKeyAction("escape", false), null);
    assert.equal(trustedFrameKeyAction("other", true), null);
    assert.equal(trustedFrameKeyAction(undefined, false), null);
  });

  it("classifies Electron before-input-event payloads while ignoring keyUp, repeat, and composition", () => {
    assert.equal(panelKeyFromInput({ type: "keyDown", key: "f", meta: true, shift: true }), "toggle");
    assert.equal(panelKeyFromInput({ type: "keyDown", key: "F", control: true, shift: true }), "toggle");
    assert.equal(panelKeyFromInput({ type: "keyDown", key: "Escape" }), "escape");
    assert.equal(panelKeyFromInput({ type: "keyUp", key: "f", meta: true, shift: true }), null);
    assert.equal(panelKeyFromInput({ type: "keyUp", key: "Escape" }), null);
    assert.equal(panelKeyFromInput({ type: "keyDown", key: "f", meta: true, shift: true, isAutoRepeat: true }), null);
    assert.equal(panelKeyFromInput({ type: "keyDown", key: "Escape", isAutoRepeat: true }), null);
    assert.equal(panelKeyFromInput({ type: "keyDown", key: "Escape", isComposing: true }), null);
    assert.equal(panelKeyFromInput({ type: "keyDown", key: "Escape", shift: true }), null);
    assert.equal(panelKeyFromInput({ type: "keyDown", key: "f", meta: true, shift: true, alt: true }), null);
  });

  it("validates reported opened-panel frame ids", () => {
    const id = "9f8e7d6c-5b4a-4321-89ab-cdef01234567";
    assert.equal(normalizePanelFrameId(id), id);
    assert.equal(normalizePanelFrameId(null), null);
    assert.equal(normalizePanelFrameId(undefined), null);
    assert.equal(normalizePanelFrameId(true), null);
    assert.equal(normalizePanelFrameId(""), null);
    assert.equal(normalizePanelFrameId("frame-" + id), null);
    assert.equal(normalizePanelFrameId(id.toUpperCase()), null);
    assert.equal(normalizePanelFrameId("not-a-frame-id"), null);
  });

  it("validates, deduplicates, and caps opened-panel frame id lists", () => {
    const ids = [
      "9f8e7d6c-5b4a-4321-89ab-cdef01234561",
      "9f8e7d6c-5b4a-4321-89ab-cdef01234562",
      "9f8e7d6c-5b4a-4321-89ab-cdef01234563",
      "9f8e7d6c-5b4a-4321-89ab-cdef01234564",
      "9f8e7d6c-5b4a-4321-89ab-cdef01234565",
    ];
    assert.deepEqual(normalizePanelFrameIds([ids[0], ids[1]]), [ids[0], ids[1]]);
    assert.deepEqual(
      normalizePanelFrameIds([ids[0], "bad", ids[0], null, ids[1], "frame-" + ids[2], ids[2], ids[3], ids[4]]),
      ids.slice(0, MAX_PANEL_OPEN_FRAMES),
    );
    assert.deepEqual(normalizePanelFrameIds([]), []);
    assert.deepEqual(normalizePanelFrameIds(null), []);
    assert.deepEqual(normalizePanelFrameIds(undefined), []);
    assert.deepEqual(normalizePanelFrameIds(ids[0]), []);
  });
});
