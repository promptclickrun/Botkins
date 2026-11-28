// Moving a bot in the first tab's row: hold a face, then slide it. This is the drag as numbers:
// where the others stand while one is carried, the slot it would land in, and what the computer is
// told on a drop. No React Native imports, so tests/row-drag.test.ts runs it. What the gesture
// calls on the UI thread is marked "worklet". The row's own geometry is strip.ts; the hold-then-move
// that starts a drag is the same as on Home's board (DRAG in drag.ts).
import type { Bot } from "@/link/types";
import type { Plan } from "./drag";
import { homeBots } from "./homeBot";
import { pushOf, STRIP } from "./strip";

/** The feel of a drag in the row. Tune these first if it feels wrong on a phone. */
export const ROW_DRAG = {
  /** How much larger than the small faces a carried face is. */
  LIFT: 1.35,
  /** How near the row's end (points) the carried face is when the row starts to move under it. */
  EDGE: 34,
  /** The fastest the row moves under a carried face, in points per frame. */
  SCROLL_MAX: 4,
  /** How long the others take to make room, and a dropped face to settle (ms). */
  SETTLE_MS: 160,
} as const;

/** The slot the bot at `index` stands in while the bot at `from` is carried to `to`: the ones between step one slot over. */
export const slotAfterMove = (index: number, from: number, to: number) => {
  "worklet";
  if (from < 0 || to < 0 || from === to) return index;
  if (index === from) return to;
  if (from < to && index > from && index <= to) return index - 1;
  if (to < from && index >= to && index < from) return index + 1;
  return index;
};

/** Where a slot's middle is from the row's middle, in points, when the row's middle is at slot `centre` (a fraction while the row moves). */
export const placeOf = (slot: number, centre: number) => {
  "worklet";
  const away = slot - centre;
  return away * STRIP.slot + pushOf(away);
};

/**
 * The row's middle, in slots, if the carried bot landed in slot `to`. The bot on show stays in the
 * middle while another is carried past it, so its own step is taken out again. When the bot on
 * show is the one carried, the row stays where it is and the others close up under it.
 * `base` is the middle before any of that: the row's scroll and its drift under the drag.
 */
export const centreFor = (base: number, chosen: number, from: number, to: number) => {
  "worklet";
  return from === chosen ? base : base + slotAfterMove(chosen, from, to) - chosen;
};

/** The slot a carried face would land in: the nearest to where it is held (`at`, in points from the row's middle). The first slot is the primary bot's and is never given. */
export const landingSlot = (at: number, from: number, chosen: number, base: number, count: number) => {
  "worklet";
  let best = from;
  let gap = Infinity;
  for (let slot = 1; slot < count; slot++) {
    const away = Math.abs(at - placeOf(slot, centreFor(base, chosen, from, slot)));
    if (away < gap) {
      gap = away;
      best = slot;
    }
  }
  return best;
};

/** How fast the row moves under a face held `at` points from its middle, in a row `width` wide: nothing until the face nears an end. */
export const driftSpeed = (at: number, width: number) => {
  "worklet";
  const over = Math.abs(at) - (width / 2 - ROW_DRAG.EDGE);
  if (over <= 0) return 0;
  return Math.sign(at) * ROW_DRAG.SCROLL_MAX * Math.min(1, over / ROW_DRAG.EDGE);
};

/**
 * What moving bot `id` to place `to` in the row asks of the computer. The row is the primary bot,
 * then the pinned bots, then the rest (homeBots), so where a bot is dropped says whether it is
 * pinned: among the pinned ones it becomes pinned, among the rest it stops being, and at the join
 * of the two it stays as it was. `bots` is the computer's whole order (hidden bots too):
 * `reorderBots` takes every bot once, and only the moved bot changes place in it. The primary bot
 * never moves and nothing goes before it. Undefined when nothing changes.
 */
export function rowPlan(bots: Bot[], id: string, to: number): Plan | undefined {
  const row = homeBots(bots);
  const from = row.findIndex((bot) => bot.id === id);
  if (from <= 0 || row.length < 3) return undefined;
  const place = Math.max(1, Math.min(row.length - 1, Math.round(to)));
  if (place === from) return undefined;
  const bot = row[from];
  const next = row.filter((entry) => entry !== bot);
  next.splice(place, 0, bot);
  const left = next[place - 1];
  const right = next[place + 1];
  const pinned = right?.pinned ? true : left !== row[0] && !left.pinned ? false : !!bot.pinned;
  const plan: Plan = {};
  if (pinned !== !!bot.pinned) plan.flags = { pinned };
  // Its neighbours of its own kind (pinned or not) say where it goes in the computer's order.
  const kin = (entry: Bot | undefined) => !!entry && entry !== row[0] && !!entry.pinned === pinned;
  const after = kin(left) ? left : undefined;
  const before = kin(right) ? right : undefined;
  const here = bots.indexOf(bot);
  const fits = (!after || bots.indexOf(after) < here) && (!before || bots.indexOf(before) > here);
  if ((after || before) && !fits) {
    const without = bots.filter((entry) => entry !== bot);
    const at = before ? without.indexOf(before) : without.indexOf(after!) + 1;
    plan.order = [...without.slice(0, at), bot, ...without.slice(at)].map((entry) => entry.id);
  }
  return plan.flags || plan.order ? plan : undefined;
}
