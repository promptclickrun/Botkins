// A message as text a person can select part of (src/ui/selectable.ts): what is copied has no
// Markdown marks and no hidden characters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectableRuns, selectableText } from "../src/ui/selectable";

const plain = (markdown: string) => selectableText(selectableRuns(markdown));

test("Markdown marks are not part of what is copied", () => {
  assert.equal(plain("Here is **bold**, *italic*, ~~gone~~ and `code`."), "Here is bold, italic, gone and code.");
  assert.equal(plain("# Plan\n\nFirst we *write*.\n\n## Then\n\nWe ship."), "Plan\n\nFirst we write.\n\nThen\n\nWe ship.");
  assert.equal(plain("See [the docs](https://example.com/docs) and <https://example.com>."), "See the docs and https://example.com.");
  assert.equal(plain("> A quote\n> on two lines"), "A quote\non two lines");
  assert.equal(plain("Line one  \nline two"), "Line one\nline two");
  assert.equal(plain("Tom &amp; Jerry < 3 &quot;ok&quot;"), 'Tom & Jerry < 3 "ok"');
});

test("lists, code blocks and tables keep their text and their shape", () => {
  assert.equal(plain("- one\n- two\n  - inner\n- three"), "• one\n• two\n  • inner\n• three");
  assert.equal(plain("3. third\n4. fourth"), "3. third\n4. fourth");
  assert.equal(plain("- [x] done\n- [ ] open"), "☑ done\n☐ open");
  assert.equal(plain("Run this:\n\n```sh\nnpm test -- --watch\nnpm run build\n```\n\nThen wait."), "Run this:\n\nnpm test -- --watch\nnpm run build\n\nThen wait.");
  assert.equal(plain("| Plan | Price |\n| --- | ---: |\n| Team | $18 |\n| Solo | $9 |"), "Plan\tPrice\nTeam\t$18\nSolo\t$9");
  // Code is copied exactly, marks and all.
  assert.equal(plain("```md\n**not bold** and `ticks`\n```"), "**not bold** and `ticks`");
});

test("each run says how it is drawn, and runs of one style are joined", () => {
  const runs = selectableRuns("# Title\n\nSome **bold** and `code` and a [link](https://example.com).");
  assert.deepEqual(runs, [
    { text: "Title", bold: true, heading: 1 },
    { text: "\n\nSome " },
    { text: "bold", bold: true },
    { text: " and " },
    { text: "code", code: true },
    { text: " and a " },
    { text: "link", link: true },
    { text: "." },
  ]);
});

test("no character that draws nothing is copied, and the text has no stray space at its end", () => {
  const hidden = "Zero​width⁠ and﻿ soft­hyphen";
  assert.equal(plain(hidden), "Zerowidth and softhyphen");
  assert.equal(plain("Ends with space   \n\n\n"), "Ends with space");
  assert.equal(plain("One\n\n\n\n\nTwo"), "One\n\nTwo");
  assert.equal(plain("Windows\r\nline"), "Windows\nline");
  assert.equal(plain(""), "");
  for (const text of ["# A\n\n- b\n- c\n\n```\nd\n```\n\n| e | f |\n| - | - |\n| g | h |\n\n> i", "Just a line."]) {
    const copied = plain(text);
    assert.ok(!/[​‌⁠﻿­\r]/.test(copied));
    assert.ok(!/\n{3,}/.test(copied), "never more than one empty line");
    assert.equal(copied, copied.trim());
  }
});

test("a person's own message is taken as written", () => {
  const typed = "Use **two stars** for bold, and `ticks`.\n- not a list";
  assert.equal(selectableText(selectableRuns(typed, false)), typed);
});
