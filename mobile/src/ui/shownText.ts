// Text from outside, as a person can be shown it for a decision: a command, an argument, a folder,
// an address, a header, a name beside a question. Such text can hold characters that change what a
// person sees: control characters, marks that turn the direction of text around, and characters
// that take no room at all. With them a command can look like another command. So each of these
// characters is written as its number (\u{202e}), and the text around it stays where it is.
//
// The rule is the computer's (`desktop/desktop/shown-text.mjs`), so the phone and the computer show
// the same: Unicode's control and format characters (Cc, Cf), the line and paragraph separators
// (Zl, Zp), the variation selectors, the Hangul fillers, U+034F, U+180E and the tag block. It is
// written here as ranges, with no pattern, so it reads the same on every JavaScript engine;
// tests/shown-text.test.ts holds the ranges to the classes. This file holds none of the characters.
//
// It is NOT for every name that is drawn. U+200C and U+200D are correct writing in some languages
// and part of many emoji, and a variation selector is what makes a heart an emoji. A chat's or a
// bot's name stays as written. No React Native imports.

/** The code points that are not shown as they are, as [first, last], in order. */
export const UNSHOWN: readonly (readonly [number, number])[] = [
  [0x0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd], [0x70f, 0x70f], [0x890, 0x891], [0x8e2, 0x8e2],
  [0x115f, 0x1160], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

/** Whether a code point is one of them. */
export function unshown(point: number): boolean {
  let low = 0;
  let high = UNSHOWN.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [first, last] = UNSHOWN[mid]!;
    if (point < first) high = mid - 1;
    else if (point > last) low = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Text with each such character written as its number. Letters of every language, accents and
 * emoji stay. `lines`: the text is drawn in a block that shows its lines, so a line feed stays a
 * line feed (it is seen there as what it is); everything else, a carriage return and a tab too, is
 * still written as its number.
 */
export function shownText(text: unknown, { lines = false }: { lines?: boolean } = {}): string {
  let out = "";
  for (const char of String(text ?? "")) {
    const point = char.codePointAt(0)!;
    out += unshown(point) && !(lines && point === 0xa) ? "\\u{" + point.toString(16) + "}" : char;
  }
  return out;
}

/** True when text has such a character. */
export function hasUnshown(text: unknown): boolean {
  for (const char of String(text ?? "")) if (unshown(char.codePointAt(0)!)) return true;
  return false;
}
