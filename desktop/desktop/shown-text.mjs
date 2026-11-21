// Text from outside, as a person can be shown it.
//
// A name, a command, an address or a description that comes from a plugin, a tool, a file or a
// server can hold characters that change what a person sees: control characters, marks that turn
// the direction of text around, and characters that take no room at all. With them a command can
// look like another command. So before such text is shown for a decision, each of these
// characters is written as its number, and the text around it stays where it is.
//
// One rule, for the command line (desktop/cli) and for the window (src), so that the two show the
// same. The pattern is written with escapes only: this file itself holds none of the characters.
//
// There are two lists, and each one is for a different use:
//   The wide one (UNSHOWN, shownText, hasUnshown) is for text that is shown for a decision: a
//   plugin's command, name or address, a header's name, a folder, and an error that quotes a
//   plugin's text. There, a character that takes no room is a way to hide something.
//   The short one (PLAIN_UNSHOWN, plainText, hasUnplain) is for a name in the log, and for a
//   message that quotes the caller's own words. It must not spoil a name that has an emoji or is
//   written in a script that uses joiners: U+200C and U+200D are correct writing in some
//   languages and a part of many emoji, and a variation selector (U+FE0F) is what makes a heart
//   or a flag an emoji and not a sign. A bot named with a flag would show "\u{fe0f}" in the
//   middle of its name. The short list holds only what can break a line of output or turn text
//   around.

/**
 * The characters that are not shown as they are. The classes are Unicode's own, so that a
 * character that a later version adds to them is caught too:
 *   Cc  control characters: U+0000 to U+001F, U+007F to U+009F (a new line and a tab among them)
 *   Cf  format characters: U+00AD (the soft hyphen), U+061C, U+200B to U+200F, U+202A to U+202E,
 *       U+2060 to U+2064, U+2066 to U+2069, U+FEFF, U+180E, the tag characters U+E0001 and
 *       U+E0020 to U+E007F, and more. These set the direction of text, or have no width.
 *   Zl, Zp  the line and paragraph separators U+2028 and U+2029
 * and, which the classes do not hold, characters that draw nothing or change nothing:
 *   U+FE00 to U+FE0F, U+E0100 to U+E01EF   variation selectors
 *   U+115F, U+1160, U+3164, U+FFA0         Hangul fillers (they look like a space)
 *   U+034F                                 the combining grapheme joiner
 *   U+E0000 to U+E007F                     the tag block, whole
 */
export const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034f\u115f\u1160\u180e\u3164\uffa0\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** Text with each such character written as its number, as \u{202e}. Other text is as it was: letters of every language, accents and emoji stay. */
export const shownText = (text) => String(text).replace(UNSHOWN, (char) => "\\u{" + char.codePointAt(0).toString(16) + "}");

/** True when text has such a character. */
export const hasUnshown = (text) => String(text).search(UNSHOWN) >= 0;

/**
 * The short list: control characters (U+0000 to U+001F, U+007F to U+009F, a new line and an
 * escape among them) and the marks that turn text around (U+061C, U+200E, U+200F, U+202A to
 * U+202E, U+2066 to U+2069). Joiners, variation selectors and the like are left as they are.
 */
export const PLAIN_UNSHOWN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text with each character of the short list written as its number, as \u{202e}. Emoji and every script stay as they are. */
export const plainText = (text) => String(text).replace(PLAIN_UNSHOWN, (char) => "\\u{" + char.codePointAt(0).toString(16) + "}");

/** True when text has a character of the short list. */
export const hasUnplain = (text) => String(text).search(PLAIN_UNSHOWN) >= 0;
