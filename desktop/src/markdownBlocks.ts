// A reply that is still arriving, cut into its top-level Markdown blocks. A finished block never
// changes while later text arrives, so it can render once and be kept; only the open last block is
// parsed again on each tick (the way T3 Code and the phone app do it).

// Reference definitions, footnotes, raw HTML, container directives and display math can tie blocks
// together (a late "[x]: url" changes a link in an earlier paragraph; footnotes are numbered across
// the whole text), so text that has any of them is rendered whole.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m;
// A backtick fence's info string cannot contain a backtick, so "```a``` is inline" is a code span.
const FENCE_PATTERN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/;
// After a blank line these still continue the previous block: indented content or a list item.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text, and the pieces joined give the text back. Returns null when the text
 * uses syntax that spans blocks; render it whole then.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  // remark-parse strips a leading BOM; a carriage return changes where lines end.
  if (text.startsWith("﻿") || text.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(text)) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  for (const line of text.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item that holds it, which is not
      // tracked here: the rest stays in this block.
      if (/\S/.test(line.slice(0, fenceIndent))) break;
      if (opener && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) fence = null;
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
      if (afterBlankLine && lineStart > blockStart && !CONTINUATION_PATTERN.test(line)) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlankLine = false;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

/**
 * What to render for a streaming reply: the blocks, each as its own source, or the whole text as
 * one block. A block before the last is finished: its trailing line breaks are cut, so that it
 * reads the same whether or not a blank line follows it. The last block is the open one and is
 * kept as it is (blank lines inside an open code fence are code).
 */
export function streamBlocks(text: string): string[] {
  const blocks = splitMarkdownBlocks(text);
  return blocks ? blocks.map((block, index) => (index < blocks.length - 1 ? block.replace(/\n[ \t\n]*$/, "") : block)) : [text];
}
