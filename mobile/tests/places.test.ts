import assert from "node:assert/strict";
import { test } from "node:test";
import { type GridItem, keysIn, moved } from "../src/features/all/grid";
import { allItems, CAPS, placeLines, placeOrder, PLACES, placesFor, savedFrom, type Viewer } from "../src/features/all/places";
import { PINNABLE } from "../src/state/tabs";

const OWNER: Viewer = { member: false, spaces: true, today: true, models: true, tools: true, skills: true };
const ALL = placesFor(OWNER);
const groups = (items: GridItem[]) => ({ bar: keysIn(items, "bar"), more: keysIn(items, "more"), hidden: keysIn(items, "hidden") });

test("every tab that can be pinned is a place, and every other place has a page to open", () => {
  for (const id of PINNABLE) assert.ok(PLACES.some((place) => place.id === id && !place.route), id);
  for (const place of PLACES) assert.equal(!!place.route, !PINNABLE.includes(place.id as (typeof PINNABLE)[number]), place.id);
  assert.equal(new Set(PLACES.map((place) => place.id)).size, PLACES.length);
});

test("a person has the places their role and their computer give them", () => {
  assert.equal(ALL.length, PLACES.length);
  const member = placesFor({ member: true, spaces: false, today: false, models: false, tools: false, skills: false });
  assert.deepEqual(member, ["home", "chats", "work", "market", "activity", "settings"]);
});

test("a saved order is made whole", () => {
  assert.deepEqual(placeOrder([]).slice(0, 3), ["home", "chats", "work"]);
  assert.deepEqual(placeOrder(["wiki", "nope", 3, "wiki", "home"]).slice(0, 4), ["wiki", "home", "chats", "work"]);
  assert.equal(placeOrder(["wiki"]).length, PLACES.length);
});

test("All shows the bar's tabs, then the rest, and Hidden once something is in it or a tile is dragged", () => {
  const start = allItems({ bar: ["home", "work"], order: [], hidden: [] }, ALL);
  assert.deepEqual(groups(start).bar, ["home", "work"]);
  assert.deepEqual(groups(start).more.slice(0, 4), ["chats", "spaces", "market", "projects"]);
  assert.ok(!start.some((item) => item.zone === "hidden"));
  assert.ok(allItems({ bar: ["home", "work"], order: [], hidden: [] }, ALL, true).some((item) => item.key === "empty:hidden"));
  const hidden = allItems({ bar: ["home"], order: ["wiki"], hidden: ["usage", "home", "nope"] }, ALL);
  assert.deepEqual(groups(hidden).hidden, ["usage"], "a tab on the bar is not hidden");
  assert.equal(groups(hidden).more[0], "wiki");
  assert.deepEqual(groups(allItems({ bar: [], order: [], hidden: [] }, ALL)).bar, []);
  assert.ok(allItems({ bar: [], order: [], hidden: [] }, ALL).some((item) => item.key === "empty:bar"), "an empty bar keeps a place to drop a tile");
});

test("only a tab may be dropped on the bar; any tile may be hidden", () => {
  for (const item of allItems({ bar: ["home"], order: [], hidden: [] }, ALL)) {
    if (item.kind !== "tile") continue;
    assert.equal(item.to.includes("bar"), (PINNABLE as string[]).includes(item.key), item.key);
    assert.ok(item.to.includes("hidden") && item.to.includes("more"), item.key);
  }
});

test("a computer without spaces shows no Spaces tile, and keeps the pin for one that has them", () => {
  const without = placesFor({ ...OWNER, spaces: false });
  const before = { bar: ["spaces", "home"] as const, order: [], hidden: [] };
  const items = allItems(before, without);
  assert.deepEqual(groups(items).bar, ["home"]);
  const saved = savedFrom(moved(items, "chats", "bar", 0, CAPS), before, without);
  assert.deepEqual(saved.bar, ["chats", "home", "spaces"]);
  assert.ok(saved.allOrder.includes("spaces"));
});

test("a drop saves the bar, the order and what is hidden", () => {
  const before = { bar: ["home", "work"] as const, order: [], hidden: [] };
  const items = allItems(before, ALL, true);
  const pinned = savedFrom(moved(items, "chats", "bar", 1, CAPS), before, ALL);
  assert.deepEqual(pinned.bar, ["home", "chats", "work"]);
  assert.deepEqual(pinned.allHidden, []);
  assert.equal(pinned.allOrder.length, PLACES.length);
  const full = allItems({ bar: pinned.bar, order: pinned.allOrder, hidden: [] }, ALL, true);
  const bumped = savedFrom(moved(full, "market", "bar", 0, CAPS), { bar: pinned.bar, order: pinned.allOrder, hidden: [] }, ALL);
  assert.deepEqual(bumped.bar, ["market", "home", "chats"]);
  assert.equal(bumped.allOrder[0], "work", "the tab that came off the bar is first in More");
  const hid = savedFrom(moved(items, "wiki", "hidden", 0, CAPS), before, ALL);
  assert.deepEqual(hid.allHidden, ["wiki"]);
  const again = allItems({ bar: hid.bar, order: hid.allOrder, hidden: hid.allHidden }, ALL);
  assert.deepEqual(groups(again).hidden, ["wiki"]);
  assert.ok(!groups(again).more.includes("wiki"));
  const unpinned = savedFrom(moved(items, "home", "more", 0, CAPS), before, ALL);
  assert.deepEqual(unpinned.bar, ["work"]);
  assert.equal(unpinned.allOrder[0], "home");
});

test("a tile says what waits for the person first, in a few words", () => {
  const quiet = placeLines({ bots: 6, requests: 0, unread: 0, waiting: 0, activeTasks: 0, spaces: 0, changedSpaces: 0, projects: 1, routines: 0, toolsOn: 0 });
  assert.deepEqual(quiet.home, { text: "6 bots" });
  assert.deepEqual(quiet.chats, { text: "All read" });
  assert.deepEqual(quiet.work, { text: "Nothing waiting" });
  assert.deepEqual(quiet.spaces, { text: "No spaces yet" });
  assert.deepEqual(quiet.projects, { text: "1 project" });
  assert.deepEqual(quiet.tools, { text: "None on" });
  const busy = placeLines({ bots: 1, requests: 2, unread: 3, waiting: 1, activeTasks: 4, spaces: 5, changedSpaces: 2, projects: 0, routines: 3, toolsOn: 7 });
  assert.deepEqual(busy.home, { text: "2 need you", tone: "warning" });
  assert.deepEqual(busy.chats, { text: "3 unread" });
  assert.deepEqual(busy.work, { text: "1 needs you", tone: "warning" });
  assert.deepEqual(busy.spaces, { text: "2 changed" });
  assert.deepEqual(busy.tasks, { text: "4 active" });
  assert.deepEqual(busy.routines, { text: "3 routines" });
  assert.deepEqual(busy.tools, { text: "7 on" });
  for (const line of Object.values(busy)) assert.ok(line.text.length <= 28, line.text);
});
