// The pure parts of Spaces in the window (src/spaces.ts): when the computer has them, names, tags,
// lines and the lists of All spaces. Names here are invented.
import test from "node:test";
import assert from "node:assert/strict";
import {
  accessTag,
  ago,
  arrangeMove,
  arrangePin,
  arrangeStep,
  askBot,
  attachable,
  canRemoveNote,
  ASK_LENGTH,
  ASKS_MAX,
  asksOf,
  changedLine,
  changedPanels,
  deleteQuestion,
  hasSpaces,
  lastLine,
  moveTargets,
  panelChanged,
  panelDrop,
  seenWords,
  spaceIcon,
  spaceLine,
  spaceName,
  spaceSections,
  spaceWhen,
  snapSize,
  stepSize,
} from "../src/spaces.ts";

const maya = { id: "m1", name: "Maya Chen" };
const dev = { id: "m2", name: "Dev Patel" };
const me = { id: "owner", name: "Studio Mac" };
const space = (over = {}) => ({
  id: "s_1", name: "Launch", by: me, mine: true, access: "private", can: "own", count: 5, changed: 0,
  pinned: true, notify: "daily", here: [], rev: 1, updatedAt: 0, ...over,
});
// A Friday afternoon, in the local time zone.
const now = new Date(2026, 10, 20, 15, 30).getTime();
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

test("a computer has Spaces when its snapshot carries them, or the computer in use names spaces-v1", () => {
  assert.equal(hasSpaces({ spaces: [] }), true);
  assert.equal(hasSpaces({}), false);
  const using = (capabilities) => ({ remote: { using: { capabilities }, hosts: [] } });
  assert.equal(hasSpaces(using(["team-people-v1", "spaces-v1"])), true);
  assert.equal(hasSpaces(using(["team-people-v1"])), false);
  assert.equal(hasSpaces({ ...using([]), spaces: [] }), false, "the computer in use decides, not a stale part");
});

test("a space's name, and another person's built-in named with its maker", () => {
  assert.equal(spaceName(space()), "Launch");
  assert.equal(spaceName(space({ name: "Today", builtin: "today" })), "Today");
  assert.equal(spaceName(space({ name: "Today", builtin: "today", mine: false, by: maya })), "Maya's Today");
  assert.equal(spaceName(space({ mine: false, by: maya })), "Launch");
});

test("who can open it, in the contract's words", () => {
  assert.equal(accessTag(space()), "Only you");
  assert.equal(accessTag(space({ mine: false, by: maya })), "Only Maya");
  const people = (...list) => list.map((p) => ({ ...p, can: "edit" }));
  assert.equal(accessTag(space({ access: "members", people: people(maya) })), "Maya");
  assert.equal(accessTag(space({ access: "members", people: people(maya, dev) })), "Maya and Dev");
  assert.equal(
    accessTag(space({ access: "members", people: people(maya, dev, { id: "m3", name: "Sam Ortiz" }, { id: "m4", name: "Rae Kim" }) })),
    "Maya, Dev and 2 more",
  );
  assert.equal(accessTag(space({ access: "members", people: [] })), "Only you", "nobody picked is private");
  assert.equal(accessTag(space({ access: "team" })), "All members");
  assert.equal(accessTag(space({ access: "link" })), "Anyone with the link");
});

test("when it was last seen, in words", () => {
  assert.equal(seenWords(at(20, 9), now), "this morning");
  assert.equal(seenWords(at(20, 13), now), "earlier today");
  assert.equal(seenWords(at(19, 22), now), "yesterday");
  assert.equal(seenWords(at(17, 8), now, "en-US"), "Tuesday");
  assert.equal(seenWords(at(14, 8), now, "en-US"), "Saturday", "six days back is still a weekday");
  assert.equal(seenWords(at(10, 8), now, "en-US"), "Nov 10");
});

test("the changed line", () => {
  assert.equal(changedLine(2, at(19, 18), now), "2 panels changed since yesterday");
  assert.equal(changedLine(1, at(20, 8), now), "1 panel changed since this morning");
  assert.equal(changedLine(3, 0, now), "3 panels changed");
  assert.equal(changedLine(0, at(19, 18), now), null);
});

test("a panel's last line, and whether it changed", () => {
  assert.equal(lastLine({ by: "m1", name: "Maya Chen", label: "Ticked Press kit", at: now - 2 * 60000 }, now), "Maya ticked Press kit · 2m");
  assert.equal(lastLine({ by: "m1", name: "Maya", at: now - 2 * 60000 }, now), "Maya changed this · 2m");
  assert.equal(lastLine({ by: "m1", name: "Maya", label: "  ", at: now }, now), "Maya changed this · now");
  assert.equal(panelChanged({ updatedAt: 10 }, 5), true);
  assert.equal(panelChanged({ updatedAt: 10 }, 20), false);
  assert.equal(panelChanged({ updatedAt: 10 }, 0), false, "never opened: nothing is marked");
});

test("a person's own tick or note is not news to them", () => {
  const seen = 1_000_000;
  const mine = { updatedAt: seen + 60_000, last: { by: "owner", at: seen + 60_000 } };
  assert.equal(panelChanged(mine, seen, "owner"), false);
  assert.equal(panelChanged(mine, seen, "m_maya"), true, "it is news to everyone else");
  assert.equal(panelChanged(mine, seen), true, "with no person known, as before");
  // The bot changed the panel after the person's tick: that is news again.
  assert.equal(panelChanged({ updatedAt: seen + 120_000, last: { by: "owner", at: seen + 60_000 } }, seen, "owner"), true);
  // The two times are stamped together; up to two seconds between them still counts as the same change.
  assert.equal(panelChanged({ updatedAt: seen + 61_500, last: { by: "owner", at: seen + 60_000 } }, seen, "owner"), false);
  // The line counts the same panels as the dots, and never a hidden one.
  const panels = [mine, { updatedAt: seen + 5, last: { by: "m_maya", at: seen + 5 } }, { updatedAt: seen + 9 }, { updatedAt: seen + 9, hidden: true }, { updatedAt: seen - 9 }];
  assert.equal(changedPanels(panels, seen, "owner"), 2);
  assert.equal(changedPanels(panels, seen, "m_maya"), 2);
  assert.equal(changedPanels(panels, 0, "owner"), 0);
});

test("a panel's asks are the bot's own words, cleaned: at most three, one line, 60 characters", () => {
  assert.deepEqual(asksOf({ asks: ["Add a team discount", "Compare with last quarter"] }), ["Add a team discount", "Compare with last quarter"]);
  assert.deepEqual(asksOf({ asks: ["  Add a\n team   discount ", "", "   ", 42, null, "x".repeat(80), "Third", "Fourth"] }), ["Add a team discount", "x".repeat(60), "Third"]);
  // None are ever made up.
  for (const none of [undefined, {}, { asks: [] }, { asks: "Add a row" }, { asks: null }]) assert.deepEqual(asksOf(none), []);
  assert.equal(ASKS_MAX, 3);
  assert.equal(ASK_LENGTH, 60);
});

test("times on a panel and a row", () => {
  assert.equal(ago(now - 5 * 60000, now), "5m");
  assert.equal(ago(now - 3 * 3600000, now), "3h");
  assert.equal(ago(now - 3 * 86400000, now, "en-US"), "Nov 17");
  assert.equal(spaceWhen(now - 5 * 60000, now), "5m");
  assert.equal(spaceWhen(at(20, 18), now, "en-US"), "6:00 PM");
  assert.equal(spaceWhen(at(21, 10), now, "en-US"), "Nov 21, 10:00 AM");
  assert.equal(
    spaceLine(space({ access: "members", people: [{ ...maya, can: "edit" }, { ...dev, can: "view" }], updatedAt: now - 5 * 60000 }), now),
    "5 panels · Maya and Dev · Updated 5m",
  );
  assert.equal(spaceLine(space({ count: 1, updatedAt: now }), now), "1 panel · Only you · Updated now");
});

test("icons: a built-in keeps its own, a shared space has people, any other a grid", () => {
  assert.equal(spaceIcon(space({ builtin: "today", access: "team" })), "today");
  assert.equal(spaceIcon(space({ builtin: "feed" })), "feed");
  assert.equal(spaceIcon(space({ access: "members" })), "shared");
  assert.equal(spaceIcon(space({ access: "link" })), "shared");
  assert.equal(spaceIcon(space()), "grid");
});

test("deleting asks with the name and the panels", () => {
  assert.equal(deleteQuestion("Launch", 5), "Delete Launch and its 5 panels?");
  assert.equal(deleteQuestion("Launch", 1), "Delete Launch and its 1 panel?");
  assert.equal(deleteQuestion("Launch", 0), "Delete Launch?");
});

test("pinning and unpinning keep the person's order", () => {
  const list = [
    { id: "today", pinned: true },
    { id: "launch", pinned: true },
    { id: "money", pinned: false },
    { id: "trip", pinned: false },
  ];
  assert.deepEqual(arrangePin(list, "trip", true), { order: ["today", "launch", "trip", "money"], pinned: ["today", "launch", "trip"] });
  assert.deepEqual(arrangePin(list, "launch", false), { order: ["today", "launch", "money", "trip"], pinned: ["today"] });
});

test("All spaces: Pinned, More, and From members for the owner only", () => {
  const list = [
    space({ id: "today", pinned: true }),
    space({ id: "money", pinned: false }),
    space({ id: "maya-trip", pinned: false, mine: false, by: maya }),
    space({ id: "maya-pinned", pinned: true, mine: false, by: maya }),
  ];
  const ids = (l) => l.map((s) => s.id);
  const owner = spaceSections(list, true);
  assert.deepEqual([ids(owner.pinned), ids(owner.more), ids(owner.fromMembers)], [["today", "maya-pinned"], ["money"], ["maya-trip"]]);
  const member = spaceSections(list, false);
  assert.deepEqual([ids(member.more), ids(member.fromMembers)], [["money", "maya-trip"], []]);
  // A member's own spaces, seen by that member, are theirs: mine, so never "From members".
  assert.deepEqual(ids(spaceSections([space({ id: "own", pinned: false, by: maya })], true).fromMembers), []);
});

test("an ask goes to the first panel's bot when it is visible, else the primary bot", () => {
  const bots = [{ id: "luna" }, { id: "pip" }];
  assert.equal(askBot(bots, [{ botId: "pip" }]).id, "pip");
  assert.equal(askBot(bots, [{ botId: "gone" }]).id, "luna");
  assert.equal(askBot(bots, []).id, "luna");
});

test("dragging a pinned space, and Move up and Move down, keep the rest as they were", () => {
  const list = [
    { id: "today", pinned: true },
    { id: "feed", pinned: true },
    { id: "launch", pinned: true },
    { id: "money", pinned: false },
    { id: "trip", pinned: false },
  ];
  assert.deepEqual(arrangeMove(list, "launch", "today", false), {
    order: ["launch", "today", "feed", "money", "trip"],
    pinned: ["launch", "today", "feed"],
  });
  assert.deepEqual(arrangeMove(list, "today", "launch", true).pinned, ["feed", "launch", "today"]);
  assert.deepEqual(arrangeMove(list, "today", "feed", false), null, "dropped where it was");
  assert.deepEqual(arrangeMove(list, "feed", "today", true), null, "dropped where it was");
  assert.deepEqual(arrangeMove(list, "money", "today", false), null, "only pinned spaces are dragged");
  assert.deepEqual(arrangeStep(list, "feed", -1).pinned, ["feed", "today", "launch"]);
  assert.deepEqual(arrangeStep(list, "feed", 1).pinned, ["today", "launch", "feed"]);
  assert.equal(arrangeStep(list, "today", -1), null);
  assert.equal(arrangeStep(list, "launch", 1), null);
  assert.equal(arrangeStep(list, "money", -1), null);
});

test("where a dragged panel lands, and the panel it lands in front of", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(panelDrop(ids, "d", "b", false), { order: ["a", "d", "b", "c"], before: "b" });
  assert.deepEqual(panelDrop(ids, "a", "c", true), { order: ["b", "c", "a", "d"], before: "d" });
  assert.deepEqual(panelDrop(ids, "a", "d", true), { order: ["b", "c", "d", "a"], before: null }, "the end");
  assert.equal(panelDrop(ids, "b", "c", false), null, "in front of the one after it: no move");
  assert.equal(panelDrop(ids, "b", "a", true), null);
  assert.equal(panelDrop(ids, "b", "b", true), null);
  assert.equal(panelDrop(ids, "x", "b", true), null);
});

test("a pulled corner snaps to Small, Wide or Tall, and arrow keys step through them", () => {
  // Two columns of 392 px with a 16 px gap: Small is nearer one column than both.
  const grid = { width: 800, gap: 16, tallAt: 500 };
  assert.equal(snapSize(390, 200, grid), "small");
  assert.equal(snapSize(590, 200, grid), "small");
  assert.equal(snapSize(600, 200, grid), "wide");
  assert.equal(snapSize(800, 499, grid), "wide");
  assert.equal(snapSize(800, 500, grid), "tall");
  assert.equal(snapSize(300, 900, grid), "small", "a narrow pull stays Small however long");
  assert.equal(stepSize("small", "ArrowRight"), "wide");
  assert.equal(stepSize("wide", "ArrowDown"), "tall");
  assert.equal(stepSize("tall", "ArrowDown"), "tall");
  assert.equal(stepSize("tall", "ArrowLeft"), "wide");
  assert.equal(stepSize("small", "ArrowUp"), "small");
  assert.equal(stepSize("wide", "Enter"), "wide");
});

test("notes: a person removes their own; the maker and the owner remove any", () => {
  const note = { by: "m1" };
  assert.equal(canRemoveNote(note, "m1", { mine: false }), true);
  assert.equal(canRemoveNote(note, "m2", { mine: false }), false);
  assert.equal(canRemoveNote(note, "m2", { mine: true }), true, "the maker");
  assert.equal(canRemoveNote(note, "owner", { mine: false }), true, "the owner");
});

test("a panel moves to the other spaces the person can change", () => {
  const list = [
    { id: "launch", can: "own" },
    { id: "money", can: "edit" },
    { id: "maya", can: "view" },
  ];
  assert.deepEqual(moveTargets(list, list[0], {}, "owner").map((s) => s.id), ["money"]);
  assert.deepEqual(moveTargets(list, list[1], {}, "m1"), [], "an editor moves only the panels they asked for");
  assert.deepEqual(moveTargets(list, list[1], { createdBy: "m1" }, "m1").map((s) => s.id), ["launch"]);
});

test("Attach offers the person's own spaces and those already attached", () => {
  const list = [
    space({ id: "today", builtin: "today" }),
    space({ id: "launch", projectId: "p1" }),
    space({ id: "money" }),
    space({ id: "maya", mine: false, by: maya, projectId: "p1" }),
    space({ id: "maya2", mine: false, by: maya }),
  ];
  assert.deepEqual(attachable(list, "p1").map((s) => s.id), ["launch", "money", "maya"]);
});

test("a view's save goes out only soon after a real click or key press, and not too often", async () => {
  const { GESTURE_MS, SET_GAP_MS, cleanLabel, cleanPatch, saveGate } = await import("../src/frameState.ts");
  let now = 1_000_000;
  const gate = saveGate(() => now);
  assert.equal(gate.allow(), false, "a page that was only opened cannot save");
  gate.gesture();
  assert.equal(gate.allow(), true);
  assert.equal(gate.allow(), false, "at most one a second");
  now += SET_GAP_MS - 1;
  assert.equal(gate.allow(), false);
  now += 1;
  assert.equal(gate.allow(), true, "a second later, still within 3 seconds of the click");
  now += SET_GAP_MS;
  assert.equal(gate.allow(), true);
  now += SET_GAP_MS + 1;
  assert.equal(gate.allow(), false, "more than 3 seconds after the click, the page is on its own again");
  gate.gesture();
  now += GESTURE_MS;
  assert.equal(gate.allow(), true, "exactly 3 seconds still counts");
  gate.gesture();
  now += GESTURE_MS + 1;
  assert.equal(gate.allow(), false);
  // A refused save does not count as one: the next allowed one is not pushed back.
  gate.gesture();
  assert.equal(gate.allow(), true);
  // A page that has just loaded starts over: a click in the page before it does not let the new one save.
  gate.gesture();
  gate.reset();
  now += SET_GAP_MS;
  assert.equal(gate.allow(), false);
  gate.gesture();
  assert.equal(gate.allow(), true);
  // What a page hands over is cut to what the computer takes.
  assert.deepEqual(cleanPatch({ a: 1, b: null }), { a: 1, b: null });
  for (const bad of [null, undefined, "x", 3, ["a"]]) assert.equal(cleanPatch(bad), null, String(bad));
  assert.equal(cleanLabel("  Ticked Press kit\n"), "Ticked Press kit");
  assert.equal(cleanLabel("x".repeat(200)).length, 80);
  for (const none of ["", "   ", 5, null, undefined, {}]) assert.equal(cleanLabel(none), undefined);
});
