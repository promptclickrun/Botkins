// Text from outside as a person can be shown it (desktop/shown-text.mjs): one rule for the
// command line and the window.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasUnshown, shownText } from "../desktop/shown-text.mjs";

const at = (code) => String.fromCodePoint(code);

test("a character that changes what a person sees is written as its number", () => {
  const hidden = [0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x9b, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff, 0xe0001, 0xe0041, 0xe007f];
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

test("the file that holds the rule holds none of the characters itself", () => {
  const source = readFileSync(new URL("../desktop/shown-text.mjs", import.meta.url), "utf8");
  assert.equal(/[^\x20-\x7e\n]/.test(source), false, "the pattern is written with escapes");
});
