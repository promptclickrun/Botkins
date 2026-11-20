// When the "scroll to latest" button shows. No React Native imports, so tests/chat.test.ts runs it.
// The chat is drawn newest-first from the bottom (an inverted list), so how far the newest message
// is out of view is the list's scroll offset.

/** The button shows once the newest message is this far out of view… */
export const SHOW_AT = 96;
/** …and hides again only when it is nearer than this, so it never flickers at the edge. */
export const HIDE_AT = 48;

/** Whether the button shows, from where the list is and whether it showed before. */
export const showsAt = (offset: number, shown: boolean) => (shown ? offset > HIDE_AT : offset > SHOW_AT);
