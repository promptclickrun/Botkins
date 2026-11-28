// All: every place in the app as a tile. Which places a person has, the three groups they sit in
// ("On your bar", "More" and "Hidden"), what a drop or a menu choice saves, and the one line each
// tile says. A place that is a tab can go on the bar; the rest open as pages. No React Native
// imports, so tests/places.test.ts runs it.
import { BAR_MAX, PINNABLE, type PinId } from "@/state/tabs";
import { type GridCap, type GridItem, keysIn } from "./grid";

export type PlaceId = PinId | "projects" | "tasks" | "routines" | "activity" | "models" | "tools" | "skills" | "wiki" | "usage" | "settings";

/** Every place, in the usual order. `route` is the page a place opens; a tab opens as its tab while it is on the bar. */
export const PLACES: readonly { id: PlaceId; title: string; route?: string }[] = [
  { id: "home", title: "Home" },
  { id: "chats", title: "Chats" },
  { id: "work", title: "Work" },
  { id: "spaces", title: "Spaces" },
  { id: "market", title: "Market" },
  { id: "projects", title: "Projects", route: "/projects" },
  { id: "tasks", title: "Tasks", route: "/work/tasks" },
  { id: "routines", title: "Routines", route: "/work/routines" },
  { id: "activity", title: "Activity", route: "/work/activity" },
  { id: "models", title: "Models", route: "/models" },
  { id: "tools", title: "Tools", route: "/tools" },
  { id: "skills", title: "Skills", route: "/skills" },
  { id: "wiki", title: "Wiki", route: "/wiki" },
  { id: "usage", title: "Usage", route: "/settings/usage" },
  { id: "settings", title: "Settings", route: "/settings" },
];
const USUAL: PlaceId[] = PLACES.map((place) => place.id);
const isPlace = (id: unknown): id is PlaceId => USUAL.includes(id as PlaceId);
export const isPin = (id: string): id is PinId => PINNABLE.includes(id as PinId);
export const placeTitle = (id: PlaceId) => PLACES.find((place) => place.id === id)?.title ?? id;
export const placeRoute = (id: PlaceId) => PLACES.find((place) => place.id === id)?.route;

/** What decides which places a person has: their role, and what the computer can do. */
export type Viewer = { member: boolean; spaces: boolean; today: boolean; models: boolean; tools: boolean; skills: boolean };

/** The places this person has, in the usual order. A team member has no projects, tasks, wiki or usage. */
export function placesFor(viewer: Viewer): PlaceId[] {
  const has: Record<PlaceId, boolean> = {
    home: true,
    chats: true,
    work: true,
    spaces: viewer.spaces,
    market: true,
    projects: !viewer.member,
    tasks: !viewer.member,
    routines: viewer.today,
    activity: true,
    models: viewer.models,
    tools: viewer.tools,
    skills: viewer.skills,
    wiki: !viewer.member,
    usage: !viewer.member,
    settings: true,
  };
  return USUAL.filter((id) => has[id]);
}

/** A saved order made whole: each place once, names it doesn't know dropped, and a place it lacks in its usual turn at the end. */
export function placeOrder(saved: readonly unknown[]): PlaceId[] {
  const kept = saved.filter(isPlace).filter((id, at, all) => all.indexOf(id) === at);
  return [...kept, ...USUAL.filter((id) => !kept.includes(id))];
}

export type Zone = "bar" | "more" | "hidden";
export const ZONE_TITLES: Record<Zone, string> = { bar: "On your bar", more: "More", hidden: "Hidden" };
/** The bar holds three: a fourth sends its last one back to More. */
export const CAPS: GridCap[] = [{ zone: "bar", max: BAR_MAX, spill: "more" }];

/** What All shows and saves. */
export type AllState = { bar: readonly PinId[]; order: readonly string[]; hidden: readonly string[] };

/**
 * All's tiles in their groups. "Hidden" shows once something is in it, and while a tile is dragged
 * so one can be dropped there. A tile that is a tab may go to the bar; any tile may be hidden.
 */
export function allItems(state: AllState, available: readonly PlaceId[], dragging = false): GridItem[] {
  const bar = state.bar.filter((id) => available.includes(id));
  const hidden = placeOrder(state.order).filter((id) => available.includes(id) && state.hidden.includes(id) && !bar.includes(id as PinId));
  const more = placeOrder(state.order).filter((id) => available.includes(id) && !bar.includes(id as PinId) && !hidden.includes(id));
  const tile = (zone: Zone) => (id: PlaceId): GridItem => ({ key: id, kind: "tile", zone, to: isPin(id) ? ["bar", "more", "hidden"] : ["more", "hidden"] });
  const group = (zone: Zone, ids: PlaceId[]): GridItem[] => [{ key: "head:" + zone, kind: "head", zone }, ...(ids.length ? ids.map(tile(zone)) : [{ key: "empty:" + zone, kind: "empty" as const, zone }])];
  return [...group("bar", bar), ...group("more", more), ...(hidden.length > 0 || dragging ? group("hidden", hidden) : [])];
}

/**
 * What a new arrangement of the tiles saves. The bar keeps a tab this person can't see now (a
 * computer without spaces) after the ones shown, while there is room; the order keeps the places
 * that are not shown where they were, after the ones that are.
 */
export function savedFrom(items: readonly GridItem[], before: AllState, available: readonly PlaceId[]): { bar: PinId[]; allOrder: PlaceId[]; allHidden: PlaceId[] } {
  const bar = keysIn(items, "bar").filter(isPin);
  const more = keysIn(items, "more").filter(isPlace);
  const hidden = keysIn(items, "hidden").filter(isPlace);
  const unseen = before.bar.filter((id) => !available.includes(id));
  const shown = [...more, ...hidden, ...bar];
  return {
    bar: [...bar, ...unseen].slice(0, BAR_MAX),
    allOrder: [...shown, ...placeOrder(before.order).filter((id) => !shown.includes(id))],
    allHidden: [...hidden, ...before.hidden.filter(isPlace).filter((id) => !available.includes(id))],
  };
}

/** A tile's line: a few words, and "warning" when something waits for the person. */
export type PlaceLine = { text: string; tone?: "warning" };

const count = (n: number, one: string, many: string, none: string) => (n === 0 ? none : n === 1 ? "1 " + one : n + " " + many);
const needs = (n: number) => (n === 1 ? "1 needs you" : n + " need you");

/** What each tile says now. A count is the computer's own; where there is none to give, a few plain words. */
export function placeLines(now: { bots: number; requests: number; unread: number; waiting: number; activeTasks: number; spaces: number; changedSpaces: number; projects: number; routines: number; toolsOn: number }): Record<PlaceId, PlaceLine> {
  return {
    home: now.requests > 0 ? { text: needs(now.requests), tone: "warning" } : { text: count(now.bots, "bot", "bots", "No bots yet") },
    chats: { text: now.unread > 0 ? now.unread + " unread" : "All read" },
    work: now.waiting > 0 ? { text: needs(now.waiting), tone: "warning" } : { text: count(now.activeTasks, "task active", "tasks active", "Nothing waiting") },
    spaces: { text: now.changedSpaces > 0 ? now.changedSpaces + " changed" : count(now.spaces, "space", "spaces", "No spaces yet") },
    market: { text: "Bots, apps and skills" },
    projects: { text: count(now.projects, "project", "projects", "No projects yet") },
    tasks: { text: count(now.activeTasks, "active", "active", "None active") },
    routines: { text: count(now.routines, "routine", "routines", "No routines yet") },
    activity: { text: "What your bots did" },
    models: { text: "Providers and plans" },
    tools: { text: count(now.toolsOn, "on", "on", "None on") },
    skills: { text: "What your bots know" },
    wiki: { text: "Pages your bots keep" },
    usage: { text: "Tokens, plans and limits" },
    settings: { text: "This phone and your computer" },
  };
}
