// The places of the app, and which of them a person keeps on the side menu. The menu shows the
// pinned ones in the person's order and always ends with All, the page where every place is a tile
// (src/AllPage.tsx). A place that is off the menu is `hidden` there and still a tile on All. The
// order and the hidden places are the person's (Preferences.sidebar, checked by the computer in
// desktop/preferences.mjs; set by dragging a tile onto the menu, or in Settings › Side menu); this
// is the usual order. Their icons are in PlaceIcon.tsx. "Spaces" is the menu's own section of
// spaces, on a computer that has them. No React and nothing of the window, so a test can run it
// (test/places.test.mjs).
export type Place = "Home" | "Today" | "Chats" | "Work" | "Projects" | "Tasks" | "Routines" | "Spaces" | "Wiki" | "Market" | "Activity" | "Usage";
export const PLACES: Place[] = ["Home", "Today", "Chats", "Work", "Projects", "Tasks", "Routines", "Spaces", "Wiki", "Market", "Activity", "Usage"];
/** The places a new side menu shows. Today is a place only on a computer without spaces. */
export const USUAL_MENU: Place[] = ["Home", "Today", "Chats", "Work", "Spaces"];

const isPlace = (name: string): name is Place => (PLACES as string[]).includes(name);
type Saved = { order?: string[]; hidden?: string[] } | undefined;

/** The person's order made whole: every place once. Unknown names are dropped; missing places keep their usual position at the end. */
export function placeOrder(order?: string[]): Place[] {
  const named = [...new Set((order ?? []).filter(isPlace))];
  return [...named, ...PLACES.filter((p) => !named.includes(p))];
}

/** The places kept off the menu. A setting without them (an older computer's) keeps every place it names on the menu. */
export function hiddenPlaces(sidebar: Saved): Place[] {
  if (Array.isArray(sidebar?.hidden)) return PLACES.filter((p) => sidebar.hidden!.includes(p));
  return sidebar?.order ? PLACES.filter((p) => !sidebar.order!.includes(p)) : PLACES.filter((p) => !USUAL_MENU.includes(p));
}

/** The places on the menu, in the person's order. */
export function menuPlaces(sidebar: Saved): Place[] {
  const hidden = hiddenPlaces(sidebar);
  return placeOrder(sidebar?.order).filter((p) => !hidden.includes(p));
}

/** What to save. Both lists are whole, so one call can't leave the two out of step. */
export type Arranged = { order: Place[]; hidden: Place[] };

/**
 * `place` on the menu, before the menu's place `before` (at the menu's end without one, or with one
 * that is not on the menu). Places that are not shown to this person keep where they were.
 */
export function pinned(sidebar: Saved, place: Place, before?: Place): Arranged {
  const hidden = hiddenPlaces(sidebar).filter((p) => p !== place);
  const order = placeOrder(sidebar?.order).filter((p) => p !== place);
  const target = before && before !== place && !hidden.includes(before) ? order.indexOf(before) : -1;
  if (target >= 0) order.splice(target, 0, place);
  else {
    // After the last place that is on the menu.
    let last = -1;
    order.forEach((p, i) => {
      if (!hidden.includes(p)) last = i;
    });
    order.splice(last + 1, 0, place);
  }
  return { order, hidden };
}

/** `place` off the menu: a tile on All, and nothing else. */
export function unpinned(sidebar: Saved, place: Place): Arranged {
  const hidden = hiddenPlaces(sidebar);
  return { order: placeOrder(sidebar?.order), hidden: PLACES.filter((p) => p === place || hidden.includes(p)) };
}

/** `place` one step up (-1) or down (1) among the menu's places as this person sees them (`shown`), or null at that end. */
export function stepped(sidebar: Saved, place: Place, by: -1 | 1, shown: readonly Place[]): Arranged | null {
  const at = shown.indexOf(place);
  const to = at + by;
  if (at < 0 || to < 0 || to >= shown.length) return null;
  // Down: before the place after the one it passes. Up: before the one it passes.
  return pinned(sidebar, place, by < 0 ? shown[to] : shown[to + 1]);
}

/** The usual menu and order. */
export const usualArrangement = (): Arranged => ({ order: [...PLACES], hidden: PLACES.filter((p) => !USUAL_MENU.includes(p)) });
export const isUsual = (sidebar: Saved) => placeOrder(sidebar?.order).join() === PLACES.join() && hiddenPlaces(sidebar).join() === usualArrangement().hidden.join();

/** ⌘ on a Mac, Ctrl elsewhere, for shortcut hints. */
export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
