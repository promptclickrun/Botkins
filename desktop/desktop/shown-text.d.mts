/** The characters that are not shown as they are (see shown-text.mjs). */
export const UNSHOWN: RegExp;
/** Text with each such character written as its number, as \u{202e}. */
export function shownText(text: unknown): string;
/** True when text has such a character. */
export function hasUnshown(text: unknown): boolean;
/** The short list: control characters and the marks that turn text around. For a name, where a joiner is correct writing. */
export const PLAIN_UNSHOWN: RegExp;
/** Text with each character of the short list written as its number. */
export function plainText(text: unknown): string;
/** True when text has a character of the short list. */
export function hasUnplain(text: unknown): boolean;
