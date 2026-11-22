// The tabs of the bar and the order a person puts them in (Settings › Appearance › Tabs). The
// order is this phone's own choice (`prefs.tabOrder`). No React Native imports, so
// tests/tabs.test.ts runs it.

/** Every tab, in the usual order. `id` is the route's name in `src/app/(tabs)`. */
export const TABS = [
  { id: "index", label: "Home" },
  { id: "chats", label: "Chats" },
  { id: "spaces", label: "Spaces" },
  { id: "work", label: "Work" },
  { id: "market", label: "Market" },
] as const;
export type TabId = (typeof TABS)[number]["id"];
export const USUAL_TABS: TabId[] = TABS.map((tab) => tab.id);

const isTab = (id: unknown): id is TabId => USUAL_TABS.includes(id as TabId);

/** A saved order made whole: each tab once, names it doesn't know dropped, and a tab it lacks (one added since) at the end. */
export function tabOrder(saved: unknown): TabId[] {
  const kept = Array.isArray(saved) ? saved.filter(isTab).filter((id, at, all) => all.indexOf(id) === at) : [];
  return [...kept, ...USUAL_TABS.filter((id) => !kept.includes(id))];
}

/** The order with tab `id` at place `index`. */
export function withTabAt(order: TabId[], id: TabId, index: number): TabId[] {
  const rest = order.filter((one) => one !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}

/** The order with tab `id` one place earlier (-1) or later (1), or null when it is already at that end. */
export function withTabMoved(order: TabId[], id: TabId, by: -1 | 1): TabId[] | null {
  const to = order.indexOf(id) + by;
  return order.includes(id) && to >= 0 && to < order.length ? withTabAt(order, id, to) : null;
}
