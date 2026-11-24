// The brand marks of the apps catalog: generated once by scripts/build-app-icons.mjs from a pinned
// Simple Icons release (CC0-1.0), and kept as the same file on the phone and here. The color math that
// draws a mark (marketColors.ts) is shared the same way.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CATALOG } from "../desktop/mcp-catalog.mjs";
import { APP_ICONS, APP_ICONS_SOURCE } from "../src/appIcons.generated.ts";
import { contrast, markStyle, MARK_CONTRAST } from "../src/marketColors.ts";

const same = (a, b) => assert.equal(readFileSync(new URL(a, import.meta.url), "utf8"), readFileSync(new URL(b, import.meta.url), "utf8"), a + " must equal " + b);

test("the generated icons are the same file on the phone and the desktop app", () => {
  same("../src/appIcons.generated.ts", "../../mobile/src/data/appIcons.generated.ts");
});

test("the color math is the same file on the phone and the desktop app", () => {
  same("../src/marketColors.ts", "../../mobile/src/data/marketColors.ts");
});

test("each icon is a catalog id with a path, a six-digit color and a title; the source is recorded", () => {
  assert.equal(APP_ICONS_SOURCE.name, "Simple Icons");
  assert.equal(APP_ICONS_SOURCE.license, "CC0-1.0");
  assert.match(APP_ICONS_SOURCE.version, /^\d+\.\d+\.\d+$/);
  const ids = new Set(CATALOG.map((entry) => entry.id));
  for (const [id, icon] of Object.entries(APP_ICONS)) {
    assert.ok(ids.has(id), id + " is in the catalog");
    assert.ok(icon.path && icon.title, id);
    assert.match(icon.hex, /^[0-9A-Fa-f]{6}$/, id);
  }
  assert.ok(Object.keys(APP_ICONS).length >= 30);
});

test("every mark reads on its tile", () => {
  for (const [id, icon] of Object.entries(APP_ICONS)) {
    const { glyph, tile } = markStyle(icon.hex);
    assert.ok(contrast(glyph, tile) >= MARK_CONTRAST, id);
  }
});
