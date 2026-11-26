import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPACE_FULLSCREEN, spaceFullscreenKeyAction } from "../src/panelOpen.ts";

describe("a space's full screen keys", () => {
  const key = (k, more = {}) => ({ key: k, ...more });
  it("toggles on Cmd+Shift+F and Ctrl+Shift+F", () => {
    assert.equal(spaceFullscreenKeyAction(key("F", { metaKey: true, shiftKey: true }), false, false), "toggle");
    assert.equal(spaceFullscreenKeyAction(key("f", { ctrlKey: true, shiftKey: true }), true, false), "toggle");
  });
  it("leaves the keys to an open dialog (an opened panel has its own Cmd+Shift+F)", () => {
    assert.equal(spaceFullscreenKeyAction(key("F", { metaKey: true, shiftKey: true }), false, true), null);
    assert.equal(spaceFullscreenKeyAction(key("Escape"), true, true), null);
  });
  it("exits on a plain Escape only while on", () => {
    assert.equal(spaceFullscreenKeyAction(key("Escape"), true, false), "exit");
    assert.equal(spaceFullscreenKeyAction(key("Escape"), false, false), null);
    assert.equal(spaceFullscreenKeyAction(key("Escape", { repeat: true }), true, false), null);
    assert.equal(spaceFullscreenKeyAction(key("Escape", { shiftKey: true }), true, false), null);
    assert.equal(spaceFullscreenKeyAction(key("Escape", { defaultPrevented: true }), true, false), null);
  });
  it("ignores other keys and a held shortcut", () => {
    assert.equal(spaceFullscreenKeyAction(key("F", { shiftKey: true }), false, false), null);
    assert.equal(spaceFullscreenKeyAction(key("F", { metaKey: true, shiftKey: true, repeat: true }), false, false), null);
    assert.equal(spaceFullscreenKeyAction(key("F", { metaKey: true, shiftKey: true, altKey: true }), false, false), null);
    assert.equal(SPACE_FULLSCREEN, "space");
  });
});
