// Every theme, light and dark, keeps its text readable (WCAG AA, 4.5:1 for body text).
// Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Colors, contrast, DEFAULT_THEME, THEMES, themeById } from "../src/ui/themes";

const MIN = 4.5;

// [text, background]: the pairs the app draws text with.
const PAIRS: [keyof Colors, keyof Colors][] = [
  ["ink", "canvas"],
  ["ink", "surface"],
  ["muted", "canvas"],
  ["muted", "surface"],
  ["accentText", "canvas"],
  ["onPrimary", "primary"],
  ["onAccent", "accent"],
  ["success", "successSoft"],
  ["warning", "warningSoft"],
  ["danger", "dangerSoft"],
  ["info", "infoSoft"],
  ["onBubble", "bubble"],
];

const HEX = /^#[0-9A-F]{6}$/i;

test("the default theme is Ink, and the kit's own theme is still there", () => {
  assert.equal(DEFAULT_THEME, "ink");
  assert.equal(themeById(DEFAULT_THEME).light.canvas, "#FFFFFF");
  assert.equal(themeById(DEFAULT_THEME).light.ink, "#000000");
  assert.equal(themeById(DEFAULT_THEME).dark.canvas, "#000000");
  assert.equal(themeById(DEFAULT_THEME).dark.ink, "#FFFFFF");
  assert.equal(themeById("no such theme").id, "ink");
  assert.equal(themeById(undefined).id, "ink");
  assert.equal(themeById("botkins").light.canvas, "#FBF1DE");
  assert.equal(themeById("botkins").dark.primary, "#EF9E78");
});

test("theme ids are unique and every theme has every color", () => {
  assert.equal(new Set(THEMES.map((theme) => theme.id)).size, THEMES.length);
  const keys = Object.keys(THEMES[0].light).sort();
  for (const theme of THEMES)
    for (const mode of ["light", "dark"] as const) {
      assert.deepEqual(Object.keys(theme[mode]).sort(), keys, theme.id + " " + mode);
      for (const key of keys) {
        if (key === "scrim") continue;
        assert.match(theme[mode][key as keyof Colors], HEX, `${theme.id} ${mode} ${key}`);
      }
    }
});

for (const theme of THEMES)
  for (const mode of ["light", "dark"] as const)
    test(`${theme.name} ${mode} text meets ${MIN}:1`, () => {
      const colors = theme[mode];
      const misses = PAIRS.map(([fg, bg]) => ({ fg, bg, ratio: contrast(colors[fg], colors[bg]) }))
        .filter((pair) => pair.ratio < MIN)
        .map((pair) => `${pair.fg} on ${pair.bg}: ${pair.ratio.toFixed(2)}`);
      assert.deepEqual(misses, []);
    });
