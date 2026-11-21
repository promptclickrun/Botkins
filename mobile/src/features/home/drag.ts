// Dragging a bot on Home: the list as a flat run of items (the primary bot, each group's heading,
// its bots), where a dragged bot would land, how the other items make room, and what the computer
// is told on a drop. No React Native imports, so tests/arrange-drag.test.ts runs it. The functions
// the gesture calls on the UI thread are marked "worklet" (the mark is a plain string in Node).
import type { Bot, Section } from "@/link/types";
import { arrangeBots } from "./arrange";

/** The feel of a drag, in one place. Tune these first if a gesture feels wrong on a phone. */
export const DRAG = {
  /** The finger rests this long before a move drags the bot. A move sooner is a swipe: the page scrolls. iOS opens the menu at about 500 ms, so a drag must start between the two. */
  HOLD_MS: 160,
  /** Moving this far (points) before HOLD_MS is a swipe, and the drag gives way to the page. */
  SWIPE_SLOP: 8,
  /** After HOLD_MS, moving this far (points) lifts the bot. Under the page's own ~10 points, so the drag wins; over a held finger's tremble, so a still hold still opens the menu. */
  START_PT: 8,
  /** How much a lifted bot grows. */
  LIFT_SCALE: 1.03,
  /** How long rows take to make room, and a dropped bot to settle (ms). Reduce Motion makes them instant. */
  SETTLE_MS: 160,
  /** How near the top or bottom of the screen (points) the finger is when the page starts to scroll. */
  EDGE: 72,
  /** The fastest the page scrolls under a drag, in points per frame (at the very edge). */
  SCROLL_MAX: 14,
  /** How long the new order stays on screen waiting for the computer's, at most (ms). */
  HOLD_ORDER_MS: 3000,
} as const;

/** A group a bot can be dropped into: Pinned, one section, or the rest ("Other bots"). */
export type Zone = "pinned" | "rest" | `section:${string}`;

export type BoardItem =
  | { key: string; kind: "primary"; botId: string }
  | { key: string; kind: "head"; zone: Zone }
  | { key: string; kind: "row"; botId: string; zone: Zone };

type Arranged = ReturnType<typeof arrangeBots<Bot>>;

export const zoneOfSection = (id: string): Zone => `section:${id}`;
export const sectionIdOf = (zone: Zone) => (zone.startsWith("section:") ? zone.slice("section:".length) : undefined);
const rowKey = (id: string) => "bot:" + id;
const headKey = (zone: Zone) => "head:" + zone;

/**
 * The list under the "All" filter, top to bottom. Pinned bots are not in it: they sit in the row of
 * big avatars above it (the primary bot too, when it is pinned), so no bot shows twice. A section
 * has a heading always, the rest when a section is above it. While a bot is dragged (`dragging`),
 * Pinned and the rest show their heading even when empty, so a bot can be dropped into them; Pinned
 * has no rows of its own. A folded section shows its heading only.
 */
export function boardItems(arranged: Pick<Arranged, "primary" | "pinned" | "sections" | "rest">, folded: readonly string[], dragging: boolean): BoardItem[] {
  const items: BoardItem[] = [];
  if (arranged.primary && !arranged.primary.pinned) items.push({ key: rowKey(arranged.primary.id), kind: "primary", botId: arranged.primary.id });
  const zone = (z: Zone, bots: Bot[], head: boolean, open = true) => {
    if (head) items.push({ key: headKey(z), kind: "head", zone: z });
    if (open) for (const bot of bots) items.push({ key: rowKey(bot.id), kind: "row", botId: bot.id, zone: z });
  };
  zone("pinned", [], dragging);
  for (const { section, bots } of arranged.sections) zone(zoneOfSection(section.id), bots, true, !folded.includes(section.id));
  zone("rest", arranged.rest, dragging || (arranged.sections.length > 0 && arranged.rest.length > 0));
  return items;
}

/** A place to drop: after the item at `after` (an index into the items), into `zone` at `index` among its other bots. */
export type Slot = { after: number; zone: Zone; index: number };

/**
 * Every place the item at `dragged` could go, top to bottom: under a heading (the top of its group)
 * and under each other bot. Never above or beside the primary bot.
 */
export function slotsFor(items: readonly BoardItem[], dragged: number): Slot[] {
  "worklet";
  const slots: Slot[] = [];
  const counts: Record<string, number> = {};
  for (let i = 0; i < items.length; i++) {
    if (i === dragged) continue;
    const item = items[i];
    if (item.kind === "head") {
      counts[item.zone] = 0;
      slots.push({ after: i, zone: item.zone, index: 0 });
    } else if (item.kind === "row") {
      counts[item.zone] = (counts[item.zone] ?? 0) + 1;
      slots.push({ after: i, zone: item.zone, index: counts[item.zone] });
    }
  }
  return slots;
}

/**
 * The slot nearest a dragged bot whose middle is at `center` (the list's own coordinates). `ys` and
 * `hs` are each item's top and height as laid out with the bot still in place; the bot's own height
 * is taken out below it, and a gap of that height opens at the slot.
 */
export function pickSlot(items: readonly BoardItem[], ys: readonly number[], hs: readonly number[], dragged: number, center: number): Slot | undefined {
  "worklet";
  const size = hs[dragged] ?? 0;
  let best: Slot | undefined;
  let bestDistance = Infinity;
  for (const slot of slotsFor(items, dragged)) {
    const bottom = (ys[slot.after] ?? 0) + (hs[slot.after] ?? 0) - (slot.after > dragged ? size : 0);
    const distance = Math.abs(bottom + size / 2 - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  }
  return best;
}

/** How far the item at `index` moves while the item at `dragged` hovers over the slot after `after`: the dragged bot leaves a hole, and a gap opens at the slot. */
export function shiftOf(index: number, dragged: number, after: number, size: number) {
  "worklet";
  if (index === dragged) return 0;
  return (index > dragged ? -size : 0) + (index > after ? size : 0);
}

/** Where a dropped bot comes to rest: the top of the gap at the slot, in the list's coordinates. */
export function restingTop(ys: readonly number[], hs: readonly number[], dragged: number, after: number) {
  "worklet";
  return (ys[after] ?? 0) + (hs[after] ?? 0) - (after > dragged ? (hs[dragged] ?? 0) : 0);
}

/** The flags that change and the order the computer gets. Either is left out when it stays. */
export type Plan = { flags?: Partial<Pick<Bot, "pinned" | "sectionId">>; order?: string[] };

const zoneOf = (bot: Bot, arranged: Arranged): Zone | undefined => {
  if (arranged.pinned.includes(bot)) return "pinned";
  const group = arranged.sections.find((entry) => entry.bots.includes(bot));
  if (group) return zoneOfSection(group.section.id);
  if (arranged.rest.includes(bot)) return "rest";
  return undefined;
};

const botsOf = (zone: Zone, arranged: Arranged) =>
  zone === "pinned" ? arranged.pinned : zone === "rest" ? arranged.rest : (arranged.sections.find((entry) => zoneOfSection(entry.section.id) === zone)?.bots ?? []);

/**
 * What dropping bot `id` into `zone`, at `index` among that group's other bots, asks of the computer.
 * `bots` is the computer's whole order (hidden bots too): `reorderBots` takes every bot once, and the
 * first is the primary, which never moves. Only the dropped bot moves in it: it goes just before the
 * group's bot at `index`, or just after the group's last. Pinned has no rows in the list, so a bot
 * dropped there joins the end of the pinned bots (the last of the big avatars), whatever `index` says.
 * Undefined when nothing changes.
 */
export function dropPlan(bots: Bot[], sections: Section[] | undefined, id: string, zone: Zone, index: number): Plan | undefined {
  const arranged = arrangeBots(bots, sections);
  const bot = bots.find((entry) => entry.id === id);
  if (!bot || bot === arranged.primary || bot.hidden) return undefined;
  const from = zoneOf(bot, arranged);
  const flags: Plan["flags"] = {};
  if (zone === "pinned") {
    if (!bot.pinned) flags.pinned = true;
  } else {
    if (bot.pinned) flags.pinned = false;
    const sectionId = sectionIdOf(zone) ?? null;
    // A bot already among the rest keeps a section id that points nowhere: nothing to clear.
    if (sectionId ? bot.sectionId !== sectionId : from !== "rest" && bot.sectionId != null) flags.sectionId = sectionId;
  }
  const others = botsOf(zone, arranged).filter((entry) => entry !== bot);
  if (zone === "pinned") index = others.length;
  const without = bots.filter((entry) => entry !== bot);
  let order = bots.map((entry) => entry.id);
  // Already between its new neighbours in the computer's order: it stays where it is.
  const here = bots.indexOf(bot);
  const prev = others[index - 1];
  const next = others[index];
  const fits = (!prev || bots.indexOf(prev) < here) && (!next || bots.indexOf(next) > here);
  if (others.length > 0 && !fits) {
    const at = next ? without.indexOf(next) : without.indexOf(others[others.length - 1]) + 1;
    order = [...without.slice(0, at), bot, ...without.slice(at)].map((entry) => entry.id);
  }
  const plan: Plan = {};
  if (Object.keys(flags).length > 0) plan.flags = flags;
  if (order.some((entry, i) => entry !== bots[i].id)) plan.order = order;
  return plan.flags || plan.order ? plan : undefined;
}

/** The bots as they will be once the computer has carried out `plan`: shown at once, until its own state arrives. */
export function applyPlan(bots: Bot[], id: string, plan: Plan): Bot[] {
  const changed = bots.map((bot) => (bot.id === id && plan.flags ? { ...bot, ...plan.flags } : bot));
  if (!plan.order) return changed;
  const byId = new Map(changed.map((bot) => [bot.id, bot]));
  return plan.order.map((entry) => byId.get(entry)).filter((bot): bot is Bot => !!bot);
}

/**
 * One step up or down for "Move up" and "Move down" (VoiceOver): the next place in the list, which
 * can be the end of the group above or the top of the group below. `items` is the list as it is laid
 * out during a drag, with every group's heading. Undefined at either end.
 */
export function stepSlot(items: readonly BoardItem[], id: string, by: -1 | 1): Slot | undefined {
  const dragged = items.findIndex((item) => item.kind === "row" && item.botId === id);
  if (dragged < 0) return undefined;
  const slots = slotsFor(items, dragged);
  const here = slots.findIndex((slot) => slot.after === dragged - 1);
  if (here < 0) return undefined;
  return slots[here + by];
}
