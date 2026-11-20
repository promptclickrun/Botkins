// A Markdown table fits the width it is given (src/ui/tables.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { tableWidths } from "../src/ui/tables";

const total = (list: number[]) => Math.round(list.reduce((sum, n) => sum + n, 0));
const CHAR = 7.5;

test("a small table fills the width and does not scroll", () => {
  const { widths, scroll } = tableWidths([{ word: 4, longest: 4 }, { word: 6, longest: 12 }], 360, CHAR);
  assert.equal(scroll, false);
  assert.equal(total(widths), 360);
});

test("a table with long cells wraps to the width instead of scrolling", () => {
  const columns = [
    { word: 8, longest: 14 },
    { word: 11, longest: 120 },
    { word: 9, longest: 64 },
    { word: 6, longest: 9 },
  ];
  const { widths, scroll } = tableWidths(columns, 360, CHAR);
  assert.equal(scroll, false, "four columns fit a phone");
  assert.equal(total(widths), 360);
  // No column is narrower than its longest word needs.
  columns.forEach((column, c) => assert.ok(widths[c] >= column.word * CHAR, "column " + c + " holds its longest word"));
  // The column with the most text gets the most room.
  assert.equal(Math.max(...widths), widths[1]);
});

test("only a table whose narrowest columns can't sit side by side scrolls, and then by as little as it can", () => {
  const columns = Array.from({ length: 12 }, () => ({ word: 9, longest: 30 }));
  const { widths, scroll } = tableWidths(columns, 360, CHAR);
  assert.equal(scroll, true);
  assert.ok(total(widths) < 12 * 100, "columns stay narrow");
});

test("before the width is known nothing is forced", () => {
  assert.equal(tableWidths([{ word: 3, longest: 3 }], 0, CHAR).scroll, false);
});
