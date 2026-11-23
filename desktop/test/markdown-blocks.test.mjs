import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { splitMarkdownBlocks, streamBlocks } from "../src/markdownBlocks.ts";

// The same Markdown rules the chat reads text with (src/RichText.tsx), without its React parts.
const render = (source) =>
  renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [[remarkGfm, { singleTilde: false }]], rehypePlugins: [[rehypeHighlight, { detect: false }]] }, source));
// Blank lines between top-level blocks do not show in the page.
const html = (source) => render(source).replace(/>\s+</g, "><").trim();

const samples = [
  "# Title\n\nFirst paragraph with `code` and **bold**.\n\nSecond [link](https://example.com).",
  "- one\n- two\n\n- loose three\n\n  continued\n\nAfter the list.",
  "1. first\n\n2. second\n\nText\n\n3) restarted",
  "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter\n\n~~~\nx\n\n~~~~\n\ny\n~~~\n\nend",
  "> quote\n\n> another quote\n\n> [!NOTE]\n> alert",
  "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
  "para\n\n    indented code\n\nnext",
  "Setext\n===\n\nnext\n---\n\n- [ ] task\n- [x] done",
  "- a\n\n  ```\n  x\n\n```\n\nb",
  "- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb",
  "```a``` is inline.\n\nprose\n\n```\none\n\ntwo\n```\n\nafter",
  "Line one  \nline two\n\n***\n\n~~strike~~ and ~5 minutes\n\n\n\nafter blanks",
  "\n\nleading blank lines\n\nthen text",
];

test("each streamed prefix renders the same split as it renders whole", () => {
  for (const text of samples) {
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source) ?? [source];
      assert.equal(blocks.join(""), source, JSON.stringify(source));
      assert.equal(streamBlocks(source).map(html).join(""), html(source), JSON.stringify(source));
    }
  }
});

test("splits only between closed blocks", () => {
  assert.deepEqual(splitMarkdownBlocks("a\n\n```\nb\n\nc\n```\n\n- d\n\n- e\n\nf"), ["a\n\n", "```\nb\n\nc\n```\n\n- d\n\n- e\n\n", "f"]);
  assert.deepEqual(splitMarkdownBlocks("a\n\n---\n\nb"), ["a\n\n", "---\n\n", "b"]);
  assert.deepEqual(splitMarkdownBlocks("one block"), ["one block"]);
  assert.deepEqual(splitMarkdownBlocks(""), [""]);
});

test("an open code fence stays in the last block", () => {
  assert.deepEqual(splitMarkdownBlocks("intro\n\n```js\nlet a;\n\nlet b;"), ["intro\n\n", "```js\nlet a;\n\nlet b;"]);
});

test("a finished block keeps its source when the next block starts", () => {
  const open = streamBlocks("first\n\nsecond");
  const next = streamBlocks("first\n\nsecond\n\nthird");
  assert.equal(open[0], next[0]);
  assert.equal(streamBlocks("first\n\nsec")[0], streamBlocks("first\n\n\nsecond")[0]);
  assert.equal(next[1], "second");
});

test("text that spans blocks is kept whole", () => {
  for (const text of [
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "<details>\n\nbody\n\n</details>",
    ":::note\n\ncontent\n\n:::",
    "$$\na\n\nb\n$$",
    "a\r\n\r\nb",
    "﻿# a\n\nb",
  ]) {
    assert.equal(splitMarkdownBlocks(text), null, JSON.stringify(text));
    assert.deepEqual(streamBlocks(text), [text]);
  }
});
