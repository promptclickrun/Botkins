// The places in the app's side menu. Their order is the person's (Preferences.sidebar.order, set in
// Settings › Side menu); this is the usual order. Their icons are in PlaceIcon.tsx.
// Projects are a tab of Work (src/WorkBar.tsx), not a place of their own.
export type Place = "Home" | "Today" | "Chats" | "Work" | "Wiki" | "Market";
export const PLACES: Place[] = ["Home", "Today", "Chats", "Work", "Wiki", "Market"];

/** The person's order made whole: every place once. Unknown names are dropped; missing places keep their usual position at the end. */
export function placeOrder(order?: string[]): Place[] {
  const named = [...new Set((order ?? []).filter((p): p is Place => (PLACES as string[]).includes(p)))];
  return [...named, ...PLACES.filter((p) => !named.includes(p))];
}

/** ⌘ on a Mac, Ctrl elsewhere, for shortcut hints. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
