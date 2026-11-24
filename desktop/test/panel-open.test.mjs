import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PANEL_FULLSCREEN_SUFFIX,
  openedPanelKeyAction,
  readPanelFullscreen,
  resolvePanelFullscreen,
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

  it("uses an explicit initial mode over the remembered choice", () => {
    const store = memoryStorage({ [TEST_KEY]: "0" });
    assert.equal(resolvePanelFullscreen(undefined, TEST_KEY, store), false);
    assert.equal(resolvePanelFullscreen(true, TEST_KEY, store), true);

    writePanelFullscreen(TEST_KEY, true, store);
    assert.equal(resolvePanelFullscreen(undefined, TEST_KEY, store), true);
    assert.equal(resolvePanelFullscreen(false, TEST_KEY, store), false);
  });

  it("maps Escape to restore when fullscreen and close when normal", () => {
    assert.equal(openedPanelKeyAction({ key: "Escape" }, true), "restore");
    assert.equal(openedPanelKeyAction({ key: "Escape" }, false), "close");
    assert.equal(openedPanelKeyAction({ key: "Escape", metaKey: true }, true), null);
    assert.equal(openedPanelKeyAction({ key: "Escape", ctrlKey: true }, false), null);
  });

  it("maps Cmd/Ctrl+Shift+F to toggle regardless of key casing", () => {
    assert.equal(openedPanelKeyAction({ key: "f", metaKey: true, shiftKey: true }, false), "toggle");
    assert.equal(openedPanelKeyAction({ key: "F", metaKey: true, shiftKey: true }, true), "toggle");
    assert.equal(openedPanelKeyAction({ key: "F", ctrlKey: true, shiftKey: true }, false), "toggle");
    assert.equal(openedPanelKeyAction({ key: "f", metaKey: true, shiftKey: false }, false), null);
    assert.equal(openedPanelKeyAction({ key: "f", metaKey: true, shiftKey: true, altKey: true }, false), null);
    assert.equal(openedPanelKeyAction({ key: "f", shiftKey: true }, false), null);
  });
});
