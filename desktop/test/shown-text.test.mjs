// Text from outside as a person can be shown it (desktop/shown-text.mjs): one rule for the
// command line and the window.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasUnplain, hasUnshown, plainText, shownText } from "../desktop/shown-text.mjs";

const at = (code) => String.fromCodePoint(code);

test("a character that changes what a person sees is written as its number", () => {
  const hidden = [
    // Cc, Cf, Zl and Zp: the classes themselves.
    0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x9b, 0xad, 0x0600, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2061, 0x2063, 0x2064, 0x2066, 0x2067, 0x2069, 0xfeff, 0xe0001, 0xe0041, 0xe007f,
    // What the classes do not hold: the combining grapheme joiner, the Hangul fillers, the variation selectors.
    0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef,
  ];
  for (const code of hidden) {
    const text = "rm" + at(code) + "x";
    assert.equal(shownText(text), "rm\\u{" + code.toString(16) + "}x", "U+" + code.toString(16));
    assert.equal(hasUnshown(text), true);
  }
  // A command that reads as another one: the turn mark is seen, and the words stay in the order they have.
  assert.equal(shownText("echo " + at(0x202e) + "dlrow" + at(0x202c)), "echo \\u{202e}dlrow\\u{202c}");
  // It answers the same each time (the pattern keeps no place between calls).
  assert.equal(hasUnshown("a" + at(0x200b)), true);
  assert.equal(hasUnshown("a" + at(0x200b)), true);
});

test("other text is as it was: every language, accents, emoji and the signs of a command", () => {
  for (const text of ["npx -y @scope/pkg --root \"${PLUGIN_ROOT}\"", "café naïve Ærø", "日本語のテキスト", "العربية", "👩🏽 ✅", "a b c", "tab-free | pipe && $(sub) `tick` \\n"]) {
    assert.equal(shownText(text), text);
    assert.equal(hasUnshown(text), false);
  }
  assert.equal(shownText(42), "42");
});

test("an emoji's variation selector is written as its number: the rule is for text shown for a decision, not for every name", () => {
  // U+FE0F is what draws the heart as an emoji. It has no width, so a command can hide behind it, and so the rule writes it as a number.
  // (A name that is only drawn, such as a chat's, does not go through this rule.)
  assert.equal(shownText("\u2764\ufe0f"), "\u2764\\u{fe0f}");
  assert.equal(hasUnshown("\u2764\ufe0f"), true);
  assert.equal(hasUnshown("\u2764"), false);
});

test("the short list leaves an emoji and a script with joiners as they are, and writes what breaks a line or turns text around", () => {
  // A flag, a family (U+200D), a heart (U+FE0F), Persian text (U+200C): a name that a person gave.
  for (const text of ["\u{1f1f8}\u{1f1ea}", "\u{1f469}\u200d\u{1f469}\u200d\u{1f467}", "\u2764\ufe0f", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "caf\u00e9 \u65e5\u672c\u8a9e"]) {
    assert.equal(plainText(text), text);
    assert.equal(hasUnplain(text), false);
  }
  for (const code of [0x00, 0x09, 0x0a, 0x1b, 0x1f, 0x7f, 0x85, 0x9f, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
    const text = "a" + at(code) + "b";
    assert.equal(plainText(text), "a\\u{" + code.toString(16) + "}b", "U+" + code.toString(16));
    assert.equal(hasUnplain(text), true);
  }
  assert.equal(plainText("two\nlines"), "two\\u{a}lines");
  // The wide list still holds what the short one leaves.
  assert.equal(hasUnshown("\u{1f469}\u200d\u{1f469}"), true);
  // It answers the same each time, and takes a number as text.
  assert.equal(hasUnplain("a\u202e"), true);
  assert.equal(hasUnplain("a\u202e"), true);
  assert.equal(plainText(42), "42");
});

test("the file that holds the rule holds none of the characters itself", () => {
  const source = readFileSync(new URL("../desktop/shown-text.mjs", import.meta.url), "utf8");
  assert.equal(/[^\x20-\x7e\n]/.test(source), false, "the pattern is written with escapes");
});
