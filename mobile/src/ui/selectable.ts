// A message as text a person can select part of: Markdown turned into runs of plain text, each
// with how it is drawn. What is copied is the text of the runs, so it has no Markdown marks and no
// hidden characters. No React Native imports, so tests/selectable.test.ts runs it.
import { Marked, type Token, type Tokens } from "marked";

export type RunStyle = { bold?: true; italic?: true; code?: true; link?: true; strike?: true; heading?: 1 | 2 | 3; quote?: true };
export type TextRun = { text: string } & RunStyle;

const parser = new Marked({ gfm: true, breaks: true });
const unescape = (text: string) => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
/** No character that draws nothing: zero-width marks, joiners used as padding, and the byte-order mark. Line breaks and tabs stay. */
const visible = (text: string) => text.replace(/[​‌⁠﻿­]/g, "").replace(/\r\n?/g, "\n");

function inline(tokens: Token[] | undefined, style: RunStyle, out: TextRun[]) {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        inline((token as Tokens.Strong).tokens, { ...style, bold: true }, out);
        break;
      case "em":
        inline((token as Tokens.Em).tokens, { ...style, italic: true }, out);
        break;
      case "del":
        inline((token as Tokens.Del).tokens, { ...style, strike: true }, out);
        break;
      case "codespan":
        out.push({ text: unescape((token as Tokens.Codespan).text), ...style, code: true });
        break;
      case "link": {
        const link = token as Tokens.Link;
        // The words of a link, as they are read. A bare address is its own words.
        if (link.tokens?.length) inline(link.tokens, { ...style, link: true }, out);
        else out.push({ text: unescape(link.text || link.href), ...style, link: true });
        break;
      }
      case "image":
        out.push({ text: unescape((token as Tokens.Image).text || (token as Tokens.Image).href), ...style, link: true });
        break;
      case "br":
        out.push({ text: "\n", ...style });
        break;
      case "text": {
        const text = token as Tokens.Text;
        if (text.tokens?.length) inline(text.tokens, style, out);
        else out.push({ text: unescape(text.text), ...style });
        break;
      }
      case "escape":
        out.push({ text: unescape((token as Tokens.Escape).text), ...style });
        break;
      default:
        // Anything else (HTML in a message, a footnote mark) is shown as it was written.
        if (typeof (token as { raw?: unknown }).raw === "string") out.push({ text: (token as { raw: string }).raw, ...style });
    }
  }
}

function list(token: Tokens.List, style: RunStyle, depth: number, out: TextRun[]) {
  let number = typeof token.start === "number" ? token.start : 1;
  for (const item of token.items) {
    const mark = item.task ? (item.checked ? "☑ " : "☐ ") : token.ordered ? number++ + ". " : "• ";
    out.push({ text: "  ".repeat(depth) + mark, ...style });
    const before = out.length;
    for (const child of item.tokens) {
      // A task's box is its mark above, not text.
      if ((child.type as string) === "checkbox") continue;
      if (child.type === "list") {
        if (out.length > before && !out[out.length - 1].text.endsWith("\n")) out.push({ text: "\n", ...style });
        list(child as Tokens.List, style, depth + 1, out);
      } else if (child.type === "text" || child.type === "paragraph") {
        if (out.length > before && !out[out.length - 1].text.endsWith("\n")) out.push({ text: "\n" + "  ".repeat(depth + 1), ...style });
        inline((child as Tokens.Text).tokens ?? [child], style, out);
      } else block(child, style, depth + 1, out);
    }
    if (!out[out.length - 1].text.endsWith("\n")) out.push({ text: "\n", ...style });
  }
}

function block(token: Token, style: RunStyle, depth: number, out: TextRun[]) {
  switch (token.type) {
    case "space":
    case "hr":
      return;
    case "heading": {
      const heading = token as Tokens.Heading;
      inline(heading.tokens, { ...style, bold: true, heading: Math.min(3, heading.depth) as 1 | 2 | 3 }, out);
      break;
    }
    case "paragraph":
      inline((token as Tokens.Paragraph).tokens, style, out);
      break;
    case "text":
      inline((token as Tokens.Text).tokens ?? [token], style, out);
      break;
    case "code":
      out.push({ text: (token as Tokens.Code).text, ...style, code: true });
      break;
    case "blockquote":
      blocks((token as Tokens.Blockquote).tokens, { ...style, quote: true }, depth, out);
      return;
    case "list":
      list(token as Tokens.List, style, depth, out);
      // A list ends its last line itself.
      out.push({ text: "\n", ...style });
      return;
    case "table": {
      const table = token as Tokens.Table;
      const row = (cells: Tokens.TableCell[], more: RunStyle) =>
        cells.forEach((cell, index) => {
          if (index) out.push({ text: "\t", ...style });
          inline(cell.tokens, { ...style, ...more }, out);
        });
      row(table.header, { bold: true });
      for (const cells of table.rows) {
        out.push({ text: "\n", ...style });
        row(cells, {});
      }
      break;
    }
    default:
      if (typeof (token as { raw?: unknown }).raw === "string") out.push({ text: (token as { raw: string }).raw.replace(/\n+$/, ""), ...style });
  }
  out.push({ text: "\n\n", ...style });
}

function blocks(tokens: Token[], style: RunStyle, depth: number, out: TextRun[]) {
  for (const token of tokens) block(token, style, depth, out);
}

const sameStyle = (a: TextRun, b: TextRun) => a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.link === b.link && a.strike === b.strike && a.heading === b.heading && a.quote === b.quote;

/** A message's text as runs. With `markdown` false the text is taken as written (a person's own message). */
export function selectableRuns(text: string, markdown = true): TextRun[] {
  const out: TextRun[] = [];
  if (!markdown) out.push({ text });
  else blocks(parser.lexer(text) as Token[], {}, 0, out);
  // Runs of one style are joined, no character that draws nothing is kept, and the text ends where its last word ends.
  const joined: TextRun[] = [];
  for (const run of out) {
    const clean = visible(run.text);
    if (!clean) continue;
    const last = joined[joined.length - 1];
    if (last && sameStyle(last, run)) last.text += clean;
    else joined.push({ ...run, text: clean });
  }
  while (joined.length) {
    const last = joined[joined.length - 1];
    last.text = last.text.replace(/\s+$/, "");
    if (last.text) break;
    joined.pop();
  }
  // Never three line breaks in a row: one empty line between two blocks.
  for (const run of joined) run.text = run.text.replace(/\n{3,}/g, "\n\n");
  for (let i = 1; i < joined.length; i++) {
    const before = /\n*$/.exec(joined[i - 1].text)![0].length;
    if (before >= 2) joined[i].text = joined[i].text.replace(/^\n+/, "");
    else if (before === 1) joined[i].text = joined[i].text.replace(/^\n{2,}/, "\n");
  }
  return joined.filter((run) => run.text);
}

/** The whole text of the runs: what a person copies when they select everything. */
export const selectableText = (runs: TextRun[]) => runs.map((run) => run.text).join("");
