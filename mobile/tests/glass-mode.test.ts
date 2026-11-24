import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveGlassMode } from "../src/ui/glassMode";

test("resolveGlassMode returns opaque when Reduce Transparency or opaque prop is set", () => {
  assert.equal(resolveGlassMode({ liquidAvailable: true, reduceTransparency: false }), "liquid");
  assert.equal(resolveGlassMode({ liquidAvailable: false, reduceTransparency: false }), "blur");
  assert.equal(resolveGlassMode({ liquidAvailable: true, reduceTransparency: true }), "opaque");
  assert.equal(resolveGlassMode({ liquidAvailable: false, reduceTransparency: true }), "opaque");
  assert.equal(resolveGlassMode({ liquidAvailable: true, reduceTransparency: false, opaque: true }), "opaque");
});

test("StatusCapsule and ScrollToLatest render opaque surfaces instead of Glass", () => {
  for (const rel of ["src/features/chat/StatusCapsule.tsx", "src/features/chat/ScrollToLatest.tsx"]) {
    const source = readFileSync(resolve(__dirname, "..", rel), "utf8");
    assert.equal(source.includes("<Glass"), false, `${rel} should not render a Glass layer over the streaming transcript`);
  }
});
