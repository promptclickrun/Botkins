// How wide each column of a Markdown table is. No React Native imports here, so the tests can run it.
//
// A table always fits the width it is given: each column gets a share by how much it holds, never
// less than its longest word needs, and text wraps inside its cell. Only when even the narrowest
// columns can't fit side by side (many columns on a phone) does the table scroll sideways.

export const CELL_PAD = 8;
const MIN_COLUMN = 44;
const MAX_WORD_COLUMN = 132;

const sum = (list: number[]) => list.reduce((total, n) => total + n, 0);

/**
 * Column widths that add up to `room` when they can; `scroll` says they could not.
 * `word` is a column's longest word and `longest` its longest cell, both in characters.
 */
export function tableWidths(columns: { word: number; longest: number }[], room: number, charWidth: number): { widths: number[]; scroll: boolean } {
  const pad = CELL_PAD * 2;
  const least = columns.map((column) => Math.max(MIN_COLUMN, Math.min(MAX_WORD_COLUMN, Math.ceil(column.word * charWidth) + pad)));
  const want = columns.map((column, c) => Math.max(least[c], Math.ceil(column.longest * charWidth) + pad));
  if (room <= 0 || columns.length === 0) return { widths: want, scroll: false };
  if (sum(want) <= room) {
    // Everything fits on one line: share the spare room out evenly.
    const spare = (room - sum(want)) / columns.length;
    return { widths: want.map((w) => w + spare), scroll: false };
  }
  if (sum(least) <= room) {
    // Wrap: every column keeps its least, and the rest goes to the columns with the most to say.
    const spare = room - sum(least);
    const need = want.map((w, c) => w - least[c]);
    const total = sum(need) || 1;
    return { widths: least.map((w, c) => w + (spare * need[c]) / total), scroll: false };
  }
  return { widths: least, scroll: true };
}
