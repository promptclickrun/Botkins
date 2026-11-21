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

/**
 * The characters that are not shown as they are:
 *   U+0000 to U+001F, U+007F to U+009F   control characters (a new line and a tab among them)
 *   U+061C, U+200E, U+200F               marks that set the direction of text
 *   U+202A to U+202E, U+2066 to U+2069   marks that turn text around, and that end such a turn
 *   U+200B to U+200D, U+2060 to U+2064   characters with no width (a joiner, a space of no width)
 *   U+FEFF                               the byte order mark, which has no width either
 *   U+2028, U+2029                       the line and paragraph separators
 *   U+E0000 to U+E007F                   the tag characters, which are not drawn
 */
export const UNSHOWN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/** Text with each such character written as its number, as \u{202e}. Other text is as it was: letters of every language, accents and emoji stay. */
export const shownText = (text) => String(text).replace(UNSHOWN, (char) => "\\u{" + char.codePointAt(0).toString(16) + "}");

/** True when text has such a character. */
export const hasUnshown = (text) => String(text).search(UNSHOWN) >= 0;
