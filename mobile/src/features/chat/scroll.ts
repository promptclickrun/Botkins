// When the "scroll to latest" button shows. No React Native imports, so tests/chat.test.ts runs it.
// The chat is drawn newest-first from the bottom (an inverted list), so how far the newest message
// is out of view is the list's scroll offset.
import { createStore } from "zustand/vanilla";

/** The button shows once the newest message is this far out of view… */
export const SHOW_AT = 96;
/** …and hides again only when it is nearer than this, so it never flickers at the edge. */
export const HIDE_AT = 48;

/** Whether the button shows, from where the list is and whether it showed before. */
export const showsAt = (offset: number, shown: boolean) => (shown ? offset > HIDE_AT : offset > SHOW_AT);

/** Each mounted chat has its own viewport. Only rows interested in their own visibility subscribe. */
export function createChatViewport() {
  const rows = createStore<ReadonlySet<string>>(() => new Set());
  const onViewableItemsChanged = ({ viewableItems }: { viewableItems: { key: string }[] }) => {
    const previous = rows.getState();
    if (previous.size === viewableItems.length && viewableItems.every(({ key }) => previous.has(key))) return;
    rows.setState(new Set(viewableItems.map(({ key }) => key)), true);
  };
  // The live island as the newest row (islandModel.ts): whether enough of it is above the message box.
  // The list runs on under the message box, so the list's own viewability counts a row hidden there
  // as seen. Worked out from the scroll offset the list already reports and the island's height, so
  // nothing is measured while scrolling. `undefined`: the island isn't the newest row; ask `rows`.
  const island = createStore<boolean | undefined>(() => undefined);
  let offset = 0;
  let height = 0;
  let tracking = false;
  const check = () => {
    const seen = tracking ? islandAboveDock({ offset, height }) : undefined;
    if (island.getState() !== seen) island.setState(seen, true);
  };
  return {
    rows,
    onViewableItemsChanged,
    island,
    scrolled: (y: number) => {
      offset = y;
      if (tracking) check();
    },
    islandHeight: (h: number) => {
      height = h;
      check();
    },
    trackIsland: (on: boolean) => {
      tracking = on;
      check();
    },
  };
}

/** The list's own padding above the message box's room (space.lg): the newest row starts this far up. */
export const ISLAND_LEAD = 16;
/** At least this much of the island shows above the message box for it to count as in view. */
export const ISLAND_SEEN = 32;

/** The newest row of an inverted list, `height` tall, scrolled `offset` away from the latest: is enough of it above the message box? */
export const islandAboveDock = ({ offset, height }: { offset: number; height: number }): boolean => height <= 0 || ISLAND_LEAD + height - offset > ISLAND_SEEN;
