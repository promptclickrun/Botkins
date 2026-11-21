// Dragging a bot on Home: the list's items, where a drop lands, how rows make room, and what the
// computer is told (src/features/home/drag.ts). Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot, Section } from "../src/link/types";
import { arrangeBots } from "../src/features/home/arrange";
import { applyPlan, type BoardItem, boardItems, dropPlan, pickSlot, restingTop, shiftOf, slotsFor, stepSlot, type Zone } from "../src/features/home/drag";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({ id, name: id, role: "", instructions: "", face: "idle", ...extra });
const sections: Section[] = [
  { id: "work", name: "Work" },
  { id: "home", name: "Home" },
];
const keys = (items: BoardItem[]) => items.map((item) => item.key);

// first is primary; p1, p2 pinned (p2 also in work); w1, w2 in work; h1 in home; r1, r2 the rest; x hidden; g in a gone section.
const sample = () => [
  bot("first"),
  bot("w1", { sectionId: "work" }),
  bot("p1", { pinned: true }),
  bot("x", { hidden: true }),
  bot("r1"),
  bot("w2", { sectionId: "work" }),
  bot("p2", { pinned: true, sectionId: "work" }),
  bot("h1", { sectionId: "home" }),
  bot("g", { sectionId: "gone" }),
  bot("r2"),
];

test("the list's items: no pinned bots, headings where a group has bots, every heading while dragging, folded sections closed", () => {
  const arranged = arrangeBots(sample(), sections);
  assert.deepEqual(keys(boardItems(arranged, [], false)), [
    "bot:first",
    "head:section:work", "bot:w1", "bot:w2",
    "head:section:home", "bot:h1",
    "head:rest", "bot:r1", "bot:g", "bot:r2",
  ]);
  assert.deepEqual(keys(boardItems(arranged, ["work"], false)).slice(1, 3), ["head:section:work", "head:section:home"]);
  // While dragging, Pinned is a heading to drop onto, with no rows: its bots sit in the top row.
  assert.deepEqual(keys(boardItems(arranged, [], true)).slice(0, 3), ["bot:first", "head:pinned", "head:section:work"]);
  // A pinned primary bot is up top too, not in the list.
  const pinnedFirst = arrangeBots([bot("first", { pinned: true }), bot("a"), bot("b")], []);
  assert.deepEqual(keys(boardItems(pinnedFirst, [], false)), ["bot:a", "bot:b"]);
  // Pinned bots and nothing else: no headings at all.
  const onlyPinned = arrangeBots([bot("first"), bot("a", { pinned: true }), bot("b")], []);
  assert.deepEqual(keys(boardItems(onlyPinned, [], false)), ["bot:first", "bot:b"]);
  // Nothing pinned and no sections: no headings until a drag shows Pinned and the rest.
  const plain = arrangeBots([bot("first"), bot("a"), bot("b")], []);
  assert.deepEqual(keys(boardItems(plain, [], false)), ["bot:first", "bot:a", "bot:b"]);
  assert.deepEqual(keys(boardItems(plain, [], true)), ["bot:first", "head:pinned", "head:rest", "bot:a", "bot:b"]);
});

test("slots: under each heading and each other bot, never next to the primary bot", () => {
  const items = boardItems(arrangeBots(sample(), sections), [], true);
  const dragged = items.findIndex((item) => item.key === "bot:w1");
  const slots = slotsFor(items, dragged);
  assert.ok(slots.every((slot) => slot.after !== 0), "nothing lands beside the primary bot");
  assert.ok(slots.every((slot) => slot.after !== dragged));
  const work = slots.filter((slot) => slot.zone === "section:work").map((slot) => slot.index);
  assert.deepEqual(work, [0, 1], "w1 can go above or below w2");
});

test("a dragged bot lands at the nearest slot, and the rows between make room", () => {
  // Five rows of 60 under the primary: first, head:pinned(44)... use a plain list while dragging.
  const items = boardItems(arrangeBots([bot("first"), bot("a"), bot("b"), bot("c")], []), [], true);
  // first 0–60, head:pinned 60–104, head:rest 104–148, a 148–208, b 208–268, c 268–328
  const hs = [60, 44, 44, 60, 60, 60];
  const ys = [0, 60, 104, 148, 208, 268];
  const a = 3;
  // Still over its own place: the slot under the rest's heading, so nothing moves.
  assert.deepEqual(pickSlot(items, ys, hs, a, 178), { after: 2, zone: "rest", index: 0 });
  // Dragged down past b's middle: after b.
  assert.deepEqual(pickSlot(items, ys, hs, a, 240), { after: 4, zone: "rest", index: 1 });
  // Up over the Pinned heading: into Pinned.
  assert.deepEqual(pickSlot(items, ys, hs, a, 95), { after: 1, zone: "pinned", index: 0 });
  // Far above: still never above the primary bot.
  assert.equal(pickSlot(items, ys, hs, a, -500)?.after, 1);
  // a hovering after b: b moves up into a's hole, c stays.
  assert.deepEqual([0, 1, 2, 4, 5].map((i) => shiftOf(i, a, 4, 60)), [0, 0, 0, -60, 0]);
  assert.equal(restingTop(ys, hs, a, 4), 208);
  // a hovering in Pinned: the rest's heading moves down to open the gap; b and c stay.
  assert.deepEqual([0, 1, 2, 4, 5].map((i) => shiftOf(i, a, 1, 60)), [0, 0, 60, 0, 0]);
  assert.equal(restingTop(ys, hs, a, 1), 104);
});

test("a drop sends the flags that change and the whole order, every bot once", () => {
  const bots = sample();
  // Into Pinned: at the end of the pinned bots, whatever the index (Pinned has no rows in the list).
  const pin = dropPlan(bots, sections, "r1", "pinned", 0);
  assert.deepEqual(pin?.flags, { pinned: true });
  assert.deepEqual(pin?.order, ["first", "w1", "p1", "x", "w2", "p2", "r1", "h1", "g", "r2"]);
  assert.deepEqual(dropPlan(bots, sections, "h1", "pinned", 0), { flags: { pinned: true } }, "already after the last pinned bot: only the flag");
  // Out of Pinned into Home: unpinned and moved; p2 keeps nothing of Work.
  const home = dropPlan(bots, sections, "p2", "section:home", 1);
  assert.deepEqual(home?.flags, { pinned: false, sectionId: "home" });
  // Out of Pinned back into its own section: only the pin changes.
  assert.deepEqual(dropPlan(bots, sections, "p2", "section:work", 2)?.flags, { pinned: false });
  // Into the rest: the section is cleared.
  assert.deepEqual(dropPlan(bots, sections, "w1", "rest", 0)?.flags, { sectionId: null });
  // A bot whose section is gone stays among the rest without a flag.
  assert.equal(dropPlan(bots, sections, "g", "rest", 1)?.flags, undefined);
  // Its own place: nothing to send.
  assert.equal(dropPlan(bots, sections, "r1", "rest", 0), undefined);
  assert.equal(dropPlan(bots, sections, "w2", "section:work", 1), undefined);
  // The primary bot and hidden bots don't move.
  assert.equal(dropPlan(bots, sections, "first", "rest", 0), undefined);
  assert.equal(dropPlan(bots, sections, "x", "rest", 0), undefined);
  // Into an empty group: the flags, and no reorder needed.
  const empty = dropPlan([bot("first"), bot("a"), bot("b")], sections, "b", "section:home", 0);
  assert.deepEqual(empty, { flags: { sectionId: "home" } });
});

test("every drop lands where it was dropped, and the primary and hidden bots keep their places", () => {
  const bots = sample();
  const arranged = arrangeBots(bots, sections);
  const items = boardItems(arranged, [], true);
  for (const [dragged, item] of items.entries()) {
    if (item.kind !== "row") continue;
    for (const slot of slotsFor(items, dragged)) {
      const plan = dropPlan(bots, sections, item.botId, slot.zone, slot.index);
      const after = plan ? applyPlan(bots, item.botId, plan) : bots;
      assert.equal(after.length, bots.length);
      assert.equal(new Set(after.map((entry) => entry.id)).size, bots.length, "every bot once");
      assert.equal(after[0].id, "first");
      const again = arrangeBots(after, sections);
      const group: Record<Zone, Bot[]> = { pinned: again.pinned, rest: again.rest, "section:work": again.sections[0].bots, "section:home": again.sections[1].bots };
      const at = slot.zone === "pinned" ? group.pinned.length - 1 : slot.index;
      assert.equal(group[slot.zone][at]?.id, item.botId, `${item.botId} → ${slot.zone} #${at}`);
      // Nothing else changed group.
      for (const other of bots.filter((entry) => entry.id !== item.botId)) {
        const before = after.find((entry) => entry.id === other.id);
        assert.deepEqual(before, other);
      }
      // The hidden bot keeps its place among the others.
      const rest = (list: Bot[]) => list.filter((entry) => entry.id !== item.botId).map((entry) => entry.id);
      assert.deepEqual(rest(after), rest(bots));
    }
  }
});

test("Move up and Move down step one place, across groups, and stop at the ends", () => {
  const items = boardItems(arrangeBots(sample(), sections), [], true);
  assert.deepEqual(stepSlot(items, "w2", -1), { after: 2, zone: "section:work", index: 0 });
  // Up from the top of the first section: into Pinned, which pins it (it joins the end of the top row).
  assert.deepEqual(stepSlot(items, "w1", -1), { after: 1, zone: "pinned", index: 0 });
  assert.equal(stepSlot(items, "p1", 1), undefined, "a pinned bot is up top, not in the list");
  assert.equal(stepSlot(items, "r2", 1), undefined);
  assert.equal(stepSlot(items, "first", 1), undefined, "the primary bot stays");
});
