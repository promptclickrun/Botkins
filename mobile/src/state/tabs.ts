// The bar's tabs and which of them a person keeps on it. The bar always starts with the bot the
// person is with (the app opens there) and ends with All, where everything is; up to three more sit
// between them, the person's own choice and order (`prefs.bar`, this phone's). A tab that is not on
// the bar is a tile in All and opens as a page. No React Native imports, so tests/tabs.test.ts runs it.

/** Every tab. `id` is the route's name in `src/app/(tabs)`; `label` is the one short word under its icon. */
export const TABS = [
  { id: "index", label: "Bot" },
  { id: "home", label: "Home" },
  { id: "chats", label: "Chats" },
  { id: "spaces", label: "Spaces" },
  { id: "work", label: "Work" },
  { id: "market", label: "Market" },
  { id: "all", label: "All" },
] as const;
export type TabId = (typeof TABS)[number]["id"];
/** A tab a person can put on the bar or take off it. The first and the last always stay. */
export type PinId = Exclude<TabId, "index" | "all">;

export const PINNABLE: PinId[] = ["home", "chats", "spaces", "work", "market"];
/** iPhone shows five tabs: the bot, All, and three of the person's own. */
export const BAR_MAX = 3;
/** The bar a phone starts with: one place is left open. */
export const USUAL_BAR: PinId[] = ["home", "work"];

const isPin = (id: unknown): id is PinId => PINNABLE.includes(id as PinId);

/** A saved bar made whole: names it doesn't know dropped, each tab once, three at most. */
export function barOf(saved: unknown): PinId[] {
  if (!Array.isArray(saved)) return USUAL_BAR;
  return saved.filter(isPin).filter((id, at, all) => all.indexOf(id) === at).slice(0, BAR_MAX);
}

/** The five tabs before the bar could be changed, in their usual order ("index" was Home). */
const OLD_USUAL = ["index", "chats", "spaces", "work", "market"];

/**
 * The bar for a phone that saved the old order of five tabs. A person who had put them in their own
 * order keeps the first three of it; one who never did gets the usual bar.
 */
export function barFromOrder(saved: unknown): PinId[] {
  if (!Array.isArray(saved)) return USUAL_BAR;
  const kept = saved.filter((id): id is string => typeof id === "string" && OLD_USUAL.includes(id)).filter((id, at, all) => all.indexOf(id) === at);
  const order = [...kept, ...OLD_USUAL.filter((id) => !kept.includes(id))];
  if (order.join() === OLD_USUAL.join()) return USUAL_BAR;
  return barOf(order.map((id) => (id === "index" ? "home" : id)));
}

/** The tabs the bar shows, in order. */
export const barTabs = (bar: readonly PinId[]): TabId[] => ["index", ...bar, "all"];

/**
 * The bar with `id` at place `index`. A full bar makes room: its last tab (never `id`) comes off,
 * and `bumped` names it.
 */
export function withPin(bar: readonly PinId[], id: PinId, index: number): { bar: PinId[]; bumped: PinId | null } {
  const rest = bar.filter((one) => one !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  if (rest.length <= BAR_MAX) return { bar: rest, bumped: null };
  const last = rest[rest.length - 1] === id ? rest.length - 2 : rest.length - 1;
  const [bumped] = rest.splice(last, 1);
  return { bar: rest, bumped };
}

export const withoutPin = (bar: readonly PinId[], id: PinId): PinId[] => bar.filter((one) => one !== id);

/** The bar with `id` one place earlier (-1) or later (1), or null when it is not on it or already at that end. */
export function withPinMoved(bar: readonly PinId[], id: PinId, by: -1 | 1): PinId[] | null {
  const to = bar.indexOf(id) + by;
  return bar.includes(id) && to >= 0 && to < bar.length ? withPin(bar, id, to).bar : null;
}

/**
 * The word under the first tab: the bot's name when it is one short word, as the other labels are
 * (a long label widens its tab into the next one), otherwise its first word, otherwise "Bot".
 */
export function botTabLabel(name: string | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first.length > 0 && first.length <= 8 ? first : "Bot";
}
