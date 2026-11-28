// Moving a bot in the first tab's row (src/features/home/rowDrag.ts): what the computer is told,
// and the numbers the drag runs on. How the drag feels is for a phone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPlan } from "../src/features/home/drag";
import { homeBots } from "../src/features/home/homeBot";
import { centreFor, driftSpeed, landingSlot, placeOf, ROW_DRAG, rowPlan, slotAfterMove } from "../src/features/home/rowDrag";
import { STRIP } from "../src/features/home/strip";
import type { Bot } from "../src/link/types";

const bot = (id: string, more: Partial<Bot> = {}) => ({ id, name: id, ...more }) as Bot;
const ids = (bots: Bot[]) => bots.map((entry) => entry.id).join(" ");
const P = { pinned: true };

/** The row after the computer has done what the plan asks. */
const moved = (bots: Bot[], id: string, to: number) => {
  const plan = rowPlan(bots, id, to);
  return plan ? ids(homeBots(applyPlan(bots, id, plan))) : ids(homeBots(bots));
};

test("a bot dropped in the row lands where it was dropped", () => {
  const bots = [bot("primary"), bot("a"), bot("b"), bot("c"), bot("d")];
  assert.equal(moved(bots, "d", 1), "primary d a b c");
  assert.equal(moved(bots, "a", 4), "primary b c d a");
  assert.equal(moved(bots, "b", 3), "primary a c b d");
  assert.equal(rowPlan(bots, "b", 2), undefined);
  // Only the order changes: nobody is pinned by a move among bots that are not.
  assert.deepEqual(rowPlan(bots, "d", 1), { order: ["primary", "d", "a", "b", "c"] });
});

test("the primary bot never moves and nothing goes before it", () => {
  const bots = [bot("primary"), bot("a"), bot("b")];
  assert.equal(rowPlan(bots, "primary", 2), undefined);
  assert.equal(moved(bots, "b", 0), "primary b a");
  assert.equal(moved(bots, "a", 99), "primary b a");
  assert.equal(rowPlan(bots, "nobody", 1), undefined);
  // Two bots: there is nowhere to move the second.
  assert.equal(rowPlan([bot("primary"), bot("a")], "a", 1), undefined);
});

test("where a bot is dropped says whether it is pinned", () => {
  // The computer's order mixes them; the row is primary, the pinned (p1 p2), the rest (a b).
  const bots = [bot("primary"), bot("a"), bot("p1", P), bot("b"), bot("p2", P), bot("gone", { hidden: true })];
  assert.equal(ids(homeBots(bots)), "primary p1 p2 a b");
  // Among the pinned: it becomes pinned, and lands between them.
  assert.deepEqual(rowPlan(bots, "b", 2)?.flags, { pinned: true });
  assert.equal(moved(bots, "b", 2), "primary p1 b p2 a");
  // Among the rest: it stops being pinned.
  assert.deepEqual(rowPlan(bots, "p1", 4)?.flags, { pinned: false });
  assert.equal(moved(bots, "p1", 4), "primary p2 a b p1");
  // At the join it stays as it was: the last pinned, or the first of the rest.
  assert.equal(rowPlan(bots, "p1", 2)?.flags, undefined);
  assert.equal(moved(bots, "p1", 2), "primary p2 p1 a b");
  assert.equal(rowPlan(bots, "b", 3)?.flags, undefined);
  assert.equal(moved(bots, "b", 3), "primary p1 p2 b a");
  // The first place after the primary bot, with pinned bots there: pinned.
  assert.deepEqual(rowPlan(bots, "a", 1)?.flags, { pinned: true });
  assert.equal(moved(bots, "a", 1), "primary a p1 p2 b");
});

test("every move of every bot lands where it was dropped, hidden bots and all", () => {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 300; round++) {
    const count = 3 + Math.floor(next() * 7);
    const bots = Array.from({ length: count }, (_, i) => bot(i === 0 ? "primary" : "b" + i, { pinned: i > 0 && next() < 0.4, hidden: i > 0 && next() < 0.15 }));
    const row = homeBots(bots);
    for (let from = 1; from < row.length; from++) {
      for (let to = 1; to < row.length; to++) {
        const plan = rowPlan(bots, row[from].id, to);
        const after = plan ? applyPlan(bots, row[from].id, plan) : bots;
        const expected = row.filter((entry) => entry !== row[from]);
        expected.splice(to, 0, row[from]);
        assert.equal(ids(homeBots(after)), ids(expected), "round " + round + ": " + from + " to " + to);
        // Every bot once, the primary first, and nobody but the moved bot changes its pin.
        assert.equal(after.length, bots.length);
        assert.equal(after[0].id, "primary");
        for (const entry of after) if (entry.id !== row[from].id) assert.equal(!!entry.pinned, !!bots.find((b) => b.id === entry.id)!.pinned);
      }
    }
  }
});

test("the others step over as a bot is carried past them", () => {
  // Carried from 1 to 3: the bots at 2 and 3 step back one; the rest stay.
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => slotAfterMove(i, 1, 3)), [0, 3, 1, 2, 4]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => slotAfterMove(i, 4, 2)), [0, 1, 3, 4, 2]);
  assert.deepEqual([0, 1, 2].map((i) => slotAfterMove(i, -1, -1)), [0, 1, 2]);
  assert.deepEqual([0, 1, 2].map((i) => slotAfterMove(i, 2, 2)), [0, 1, 2]);
});

test("the bot on show stays in the middle while another is carried past it", () => {
  // Bot 2 is on show (the row's middle is slot 2). Bot 4 carried to slot 1 pushes it to slot 3, and the middle follows.
  assert.equal(centreFor(2, 2, 4, 1), 3);
  assert.equal(placeOf(slotAfterMove(2, 4, 1), centreFor(2, 2, 4, 1)), 0);
  // Carried on its own side of the bot on show: the middle stays.
  assert.equal(centreFor(2, 2, 4, 3), 2);
  // The bot on show itself is carried: the row stays where it is.
  assert.equal(centreFor(2, 2, 2, 4), 2);
});

test("a carried face lands in the slot nearest to where it is held", () => {
  const count = 6;
  const chosen = 2;
  for (const from of [1, 3, 5]) {
    for (let to = 1; to < count; to++) {
      // Held exactly where that slot would be: that slot.
      const at = placeOf(to, centreFor(chosen, chosen, from, to));
      assert.equal(landingSlot(at, from, chosen, chosen, count), to, from + " to " + to);
    }
  }
  // Far off either end: the last slot, or the first after the primary bot. Never the primary's.
  assert.equal(landingSlot(9999, 1, chosen, chosen, count), count - 1);
  assert.equal(landingSlot(-9999, 4, chosen, chosen, count), 1);
  // The bot on show carried one slot's width to the right lands one slot on.
  assert.equal(landingSlot(STRIP.slot + STRIP.push, 2, 2, 2, count), 3);
});

test("the row moves under a carried face only near its ends", () => {
  const width = 290;
  assert.equal(driftSpeed(0, width), 0);
  assert.equal(driftSpeed(width / 2 - ROW_DRAG.EDGE, width), 0);
  assert.ok(driftSpeed(width / 2 - 10, width) > 0);
  assert.ok(driftSpeed(-(width / 2 - 10), width) < 0);
  assert.equal(driftSpeed(width, width), ROW_DRAG.SCROLL_MAX);
  assert.equal(driftSpeed(-width, width), -ROW_DRAG.SCROLL_MAX);
});
