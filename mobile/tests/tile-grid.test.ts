import assert from "node:assert/strict";
import { test } from "node:test";
import { countIn, type GridCap, type GridItem, type GridMetrics, keysIn, layoutOf, moved, pickPlace, stepped, tidy } from "../src/features/all/grid";

const M: GridMetrics = { columns: 2, gap: 10, tile: 100, head: 20, section: 16 };
const CAPS: GridCap[] = [{ zone: "bar", max: 3, spill: "more" }];
const head = (zone: string): GridItem => ({ key: "head:" + zone, kind: "head", zone });
const tile = (key: string, zone: string, to = ["bar", "more", "hidden"]): GridItem => ({ key, kind: "tile", zone, to });
const empty = (zone: string): GridItem => ({ key: "empty:" + zone, kind: "empty", zone });
const order = (items: GridItem[]) => items.map((item) => (item.kind === "tile" ? item.zone + ":" + item.key : item.key));

const LIST = tidy([head("bar"), tile("home", "bar"), tile("work", "bar"), head("more"), tile("chats", "more"), tile("spaces", "more"), tile("market", "more"), tile("wiki", "more", ["more", "hidden"])]);

test("every group has its heading, then its tiles, or one empty place", () => {
  assert.deepEqual(order(tidy([head("bar"), head("more"), tile("a", "more")])), ["head:bar", "empty:bar", "head:more", "more:a"]);
  assert.deepEqual(order(tidy([head("more"), tile("a", "bar")])), ["head:more", "empty:more"], "a tile of a group that isn't shown is left out");
  assert.equal(countIn(LIST, "more"), 4);
  assert.equal(countIn(LIST, "more", "chats"), 3);
});

test("tiles sit two to a row under their heading, and the next heading has more room above it", () => {
  const layout = layoutOf(LIST, 210, M);
  const at = (key: string) => {
    const i = layout.keys.indexOf(key);
    return [layout.xs[i], layout.ys[i], layout.ws[i], layout.hs[i]];
  };
  assert.deepEqual(at("head:bar"), [0, 0, 210, 20]);
  assert.deepEqual(at("home"), [0, 20, 100, 100]);
  assert.deepEqual(at("work"), [110, 20, 100, 100]);
  assert.deepEqual(at("head:more"), [0, 146, 210, 20], "a row, its gap, then the section's room");
  assert.deepEqual(at("chats"), [0, 166, 100, 100]);
  assert.deepEqual(at("market"), [0, 276, 100, 100]);
  assert.deepEqual(at("wiki"), [110, 276, 100, 100]);
  assert.equal(layout.height, 376, "no gap after the last row");
});

test("an empty group keeps one place as wide as the grid, and a last row with one tile is a whole row", () => {
  const layout = layoutOf(tidy([head("bar"), head("more"), tile("a", "more"), tile("b", "more"), tile("c", "more")]), 210, M);
  const i = layout.keys.indexOf("empty:bar");
  assert.deepEqual([layout.xs[i], layout.ys[i], layout.ws[i], layout.hs[i]], [0, 20, 210, 100]);
  assert.equal(layout.ys[layout.keys.indexOf("head:more")], 146);
  assert.equal(layout.height, 166 + 100 + 10 + 100);
  assert.equal(layoutOf([], 210, M).height, 0);
});

test("a tile moves to a place in a group, and the group it left closes up", () => {
  assert.deepEqual(order(moved(LIST, "market", "bar", 1)), ["head:bar", "bar:home", "bar:market", "bar:work", "head:more", "more:chats", "more:spaces", "more:wiki"]);
  assert.deepEqual(order(moved(LIST, "home", "more", 99)), ["head:bar", "bar:work", "head:more", "more:chats", "more:spaces", "more:market", "more:wiki", "more:home"]);
  assert.deepEqual(order(moved(moved(LIST, "home", "more", 0), "work", "more", 0)), ["head:bar", "empty:bar", "head:more", "more:work", "more:home", "more:chats", "more:spaces", "more:market", "more:wiki"]);
  assert.deepEqual(order(moved(LIST, "nope", "bar", 0)), order(LIST));
  assert.deepEqual(order(moved(LIST, "home", "nowhere", 0)), order(LIST), "a group that isn't shown takes nothing");
  assert.equal(moved(LIST, "home", "more", 0)[0], LIST[0], "a heading stays the same item");
});

test("a full group hands its last tile on, never the one just dropped", () => {
  const full = moved(LIST, "chats", "bar", 2, CAPS);
  assert.deepEqual(keysIn(full, "bar"), ["home", "work", "chats"]);
  assert.deepEqual(keysIn(moved(full, "market", "bar", 0, CAPS), "bar"), ["market", "home", "work"]);
  assert.deepEqual(keysIn(moved(full, "market", "bar", 0, CAPS), "more"), ["chats", "spaces", "wiki"], "the one that left is first in More");
  assert.deepEqual(keysIn(moved(full, "market", "bar", 3, CAPS), "bar"), ["home", "work", "market"]);
  assert.deepEqual(keysIn(moved(full, "work", "bar", 0, CAPS), "bar"), ["work", "home", "chats"], "a move inside a full group sends nothing away");
});

test("a dragged tile lands on the nearest place it may go to", () => {
  const drop = (key: string, x: number, y: number) => {
    const pick = pickPlace(LIST, 210, M, CAPS, key, x, y)!;
    return [pick.zone, pick.index];
  };
  assert.deepEqual(drop("market", 50, 326), ["more", 2], "held where it is, it stays");
  assert.deepEqual(drop("market", 160, 216), ["more", 1], "over the second place of More");
  assert.deepEqual(drop("market", 50, 70), ["bar", 0]);
  assert.deepEqual(drop("market", 60, 180), ["bar", 2], "a third on the bar starts its second row, just under the first");
  assert.deepEqual(drop("wiki", 50, 70), ["more", 0], "a tile that is no tab never lands on the bar");
  assert.deepEqual(drop("home", 50, 430), ["more", 4], "below the last row, a new row opens");
  const pick = pickPlace(LIST, 210, M, CAPS, "market", 50, 70)!;
  assert.deepEqual(keysIn(pick.items, "bar"), ["market", "home", "work"]);
  assert.equal(pick.layout.keys.length, pick.items.length);
  assert.equal(pickPlace(LIST, 210, M, CAPS, "head:bar", 0, 0), undefined);
  assert.equal(pickPlace(LIST, 210, M, CAPS, "nope", 0, 0), undefined);
});

test("the list a drag shows is the list a drop saves", () => {
  const pick = pickPlace(LIST, 210, M, CAPS, "spaces", 160, 70)!;
  assert.deepEqual(order(pick.items), order(moved(LIST, "spaces", pick.zone, pick.index, CAPS)));
});

test("a tile steps one place along in its own group", () => {
  assert.deepEqual(keysIn(stepped(LIST, "spaces", -1)!, "more"), ["spaces", "chats", "market", "wiki"]);
  assert.deepEqual(keysIn(stepped(LIST, "spaces", 1)!, "more"), ["chats", "market", "spaces", "wiki"]);
  assert.equal(stepped(LIST, "chats", -1), null);
  assert.equal(stepped(LIST, "wiki", 1), null);
  assert.equal(stepped(LIST, "head:bar", 1), null);
});
