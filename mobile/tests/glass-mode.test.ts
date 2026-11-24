import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGlassMode } from "../src/ui/glassMode";

test("resolveGlassMode returns opaque when Reduce Transparency or opaque prop is set", () => {
  assert.equal(resolveGlassMode({ liquidAvailable: true, reduceTransparency: false }), "liquid");
  assert.equal(resolveGlassMode({ liquidAvailable: false, reduceTransparency: false }), "blur");
  assert.equal(resolveGlassMode({ liquidAvailable: true, reduceTransparency: true }), "opaque");
  assert.equal(resolveGlassMode({ liquidAvailable: false, reduceTransparency: true }), "opaque");
  assert.equal(resolveGlassMode({ liquidAvailable: true, reduceTransparency: false, opaque: true }), "opaque");
});
