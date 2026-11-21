// The phone's rule for text shown for a decision, held to the computer's rule
// (desktop/desktop/shown-text.mjs): the same characters are written as their numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasUnshown, shownText, UNSHOWN, unshown } from "../src/ui/shownText";

// The computer's pattern, as its file writes it.
const HOST = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034f\u115f\u1160\u180e\u3164\uffa0\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
const FILLERS = new Set([0x115f, 0x1160, 0x3164, 0xffa0]);

test("the ranges are the computer's classes: every such character, and nothing a person reads", () => {
  for (let i = 1; i < UNSHOWN.length; i++) assert.ok(UNSHOWN[i]![0] > UNSHOWN[i - 1]![1], "in order, apart");
  const visible = /[\p{L}\p{N}\p{P}\p{S}\p{Zs}]/u;
  for (let point = 0; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const char = String.fromCodePoint(point);
    // Every character the computer writes as a number, the phone does too. (A newer Unicode than the ranges were made from fails here: add the new characters.)
    if (HOST.test(char)) assert.ok(unshown(point), "U+" + point.toString(16) + " is written as its number");
    // And the phone hides no letter, digit, mark of punctuation, symbol or space, but the fillers that look like a space.
    else if (unshown(point)) assert.fail("U+" + point.toString(16) + " is not in the computer's rule");
    if (unshown(point) && !FILLERS.has(point)) assert.ok(!visible.test(char), "U+" + point.toString(16) + " is not something a person reads");
  }
});

test("a command that would read as another one shows what it holds", () => {
  // A mark that turns the text around, a character with no width, a tag character and an escape.
  assert.equal(shownText("rm -rf \u202e/ # cod.exe"), "rm -rf \\u{202e}/ # cod.exe");
  assert.equal(shownText("git\u200b push"), "git\\u{200b} push");
  assert.equal(shownText("a\u{e0041}b"), "a\\u{e0041}b");
  assert.equal(shownText("\u001b[2Kok"), "\\u{1b}[2Kok");
  // A new line and a tab are written as numbers too, so two lines can't pass as one word.
  assert.equal(shownText("one\ntwo\tthree\r"), "one\\u{a}two\\u{9}three\\u{d}");
  // In a block that shows its lines, a line feed stays; nothing else does.
  assert.equal(shownText("one\ntwo\tthree\r\u202e", { lines: true }), "one\ntwo\\u{9}three\\u{d}\\u{202e}");
  // Letters of every language, accents and plain emoji stay as they are.
  for (const text of ["npx -y @scope/pkg --flag=1", "café ñandú", "日本語のコマンド", "العربية", "😀 👍"]) assert.equal(shownText(text), text);
  // A variation selector and a joiner are shown as numbers here: this rule is for a decision, never for a chat's or a bot's name.
  assert.equal(shownText("\u2764\ufe0f"), "\u2764\\u{fe0f}");
  assert.equal(shownText("a\u200db"), "a\\u{200d}b");
  assert.equal(shownText(undefined), "");
  assert.equal(shownText(42), "42");
  assert.ok(hasUnshown("x\u2066y") && !hasUnshown("plain text") && !hasUnshown(""));
});
