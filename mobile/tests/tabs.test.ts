import assert from "node:assert/strict";
import { test } from "node:test";
import { tabOrder, USUAL_TABS, withTabAt, withTabMoved } from "../src/state/tabs";

test("a saved order is made whole: unknown names dropped, each tab once, a missing tab at the end", () => {
  assert.deepEqual(tabOrder(undefined), USUAL_TABS);
  assert.deepEqual(tabOrder("spaces"), USUAL_TABS);
  assert.deepEqual(tabOrder(["spaces", "settings", "index", "spaces", 7]), ["spaces", "index", "chats", "work", "market"]);
  assert.deepEqual(tabOrder(["market", "work", "spaces", "chats", "index"]), ["market", "work", "spaces", "chats", "index"]);
});

test("a tab moves to a place, or one place along, and stops at either end", () => {
  assert.deepEqual(withTabAt(USUAL_TABS, "spaces", 0), ["spaces", "index", "chats", "work", "market"]);
  assert.deepEqual(withTabAt(USUAL_TABS, "index", 99), ["chats", "spaces", "work", "market", "index"]);
  assert.deepEqual(withTabMoved(USUAL_TABS, "spaces", -1), ["index", "spaces", "chats", "work", "market"]);
  assert.deepEqual(withTabMoved(USUAL_TABS, "spaces", 1), ["index", "chats", "work", "spaces", "market"]);
  assert.equal(withTabMoved(USUAL_TABS, "index", -1), null);
  assert.equal(withTabMoved(USUAL_TABS, "market", 1), null);
});
