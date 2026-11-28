// The side menu's places as plain logic (src/places.ts): which are on the menu, in what order, and
// what a pin, a drop, a move and a reset save. The window's own behavior is test/all-smoke.mjs and
// test/sidebar-smoke.mjs; what the computer keeps is test/workspace.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { SIDEBAR, SIDEBAR_USUAL, sidebarField } from "../desktop/preferences.mjs";
import { hiddenPlaces, isUsual, menuPlaces, pinned, placeOrder, PLACES, stepped, unpinned, USUAL_MENU, usualArrangement } from "../src/places.ts";

const usual = sidebarField();

test("the window's places are the computer's, and a new menu is the short one", () => {
  assert.deepEqual(PLACES, SIDEBAR);
  assert.deepEqual(USUAL_MENU, SIDEBAR_USUAL);
  assert.deepEqual(menuPlaces(usual), ["Home", "Today", "Chats", "Work", "Spaces"]);
  assert.deepEqual(hiddenPlaces(usual), ["Projects", "Tasks", "Routines", "Wiki", "Market", "Activity", "Usage"]);
  assert.deepEqual(usualArrangement(), { order: usual.order, hidden: usual.hidden });
  assert.equal(isUsual(usual), true);
  // Nothing saved yet reads as the usual menu too.
  assert.deepEqual(menuPlaces(undefined), ["Home", "Today", "Chats", "Work", "Spaces"]);
  // An order is made whole: unknown and repeated names are dropped, the rest follow in the usual order.
  assert.deepEqual(placeOrder(["Wiki", "Nope", "Home", "Wiki"]).slice(0, 3), ["Wiki", "Home", "Today"]);
  assert.equal(placeOrder(["Wiki"]).length, PLACES.length);
});

test("a setting from before places could be taken off the menu keeps the places it names on it", () => {
  assert.deepEqual(menuPlaces({ order: ["Work", "Home", "Wiki"] }), ["Work", "Home", "Wiki"]);
  assert.deepEqual(hiddenPlaces({ order: ["Work", "Home", "Wiki"] }).includes("Market"), true);
});

test("a pin puts a place at the menu's end, or before the row it is dropped on", () => {
  const atEnd = pinned(usual, "Wiki");
  assert.deepEqual(menuPlaces(atEnd), ["Home", "Today", "Chats", "Work", "Spaces", "Wiki"]);
  assert.equal(atEnd.hidden.includes("Wiki"), false);
  assert.equal(isUsual(atEnd), false);
  const before = pinned(usual, "Market", "Chats");
  assert.deepEqual(menuPlaces(before), ["Home", "Today", "Market", "Chats", "Work", "Spaces"]);
  // Dropped on a place that is not on the menu, or on itself, it goes to the end.
  assert.deepEqual(menuPlaces(pinned(usual, "Market", "Usage")), ["Home", "Today", "Chats", "Work", "Spaces", "Market"]);
  assert.deepEqual(menuPlaces(pinned(usual, "Market", "Market")), ["Home", "Today", "Chats", "Work", "Spaces", "Market"]);
  // A place already on the menu moves, and nothing else changes.
  const moved = pinned(usual, "Work", "Home");
  assert.deepEqual(menuPlaces(moved), ["Work", "Home", "Today", "Chats", "Spaces"]);
  assert.deepEqual(moved.hidden, usual.hidden);
  // Every arrangement names every place once, so the computer has nothing to add.
  for (const next of [atEnd, before, moved]) assert.deepEqual([...next.order].sort(), [...PLACES].sort());
});

test("taking a place off the menu keeps the order, so it comes back where it was", () => {
  const off = unpinned(usual, "Chats");
  assert.deepEqual(menuPlaces(off), ["Home", "Today", "Work", "Spaces"]);
  assert.deepEqual(off.order, usual.order);
  assert.deepEqual(off.hidden, ["Chats", "Projects", "Tasks", "Routines", "Wiki", "Market", "Activity", "Usage"]);
  assert.deepEqual(unpinned(off, "Chats"), off, "twice is once");
});

test("a step moves a place past the next one this person sees, and stops at either end", () => {
  // On a computer with spaces the menu's rows are Home, Chats and Work: Today is a space, and the section of spaces is under them.
  const rows = ["Home", "Chats", "Work"];
  assert.equal(stepped(usual, "Home", -1, rows), null);
  assert.equal(stepped(usual, "Work", 1, rows), null);
  assert.equal(stepped(usual, "Wiki", -1, rows), null, "a place that is not a row has no step");
  const down = stepped(usual, "Home", 1, rows);
  assert.deepEqual(menuPlaces(down).filter((place) => rows.includes(place)), ["Chats", "Home", "Work"]);
  const up = stepped(usual, "Work", -1, rows);
  assert.deepEqual(menuPlaces(up).filter((place) => rows.includes(place)), ["Home", "Work", "Chats"]);
  assert.deepEqual(up.hidden, usual.hidden);
});

test("what the window saves is what the computer keeps", () => {
  for (const next of [pinned(usual, "Wiki"), pinned(usual, "Market", "Chats"), unpinned(usual, "Home"), stepped(usual, "Home", 1, ["Home", "Chats", "Work"]), usualArrangement()]) {
    const kept = sidebarField(next, usual);
    assert.deepEqual({ order: kept.order, hidden: kept.hidden }, next);
  }
});
