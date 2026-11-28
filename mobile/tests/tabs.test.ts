import assert from "node:assert/strict";
import { test } from "node:test";
import { BAR_MAX, barFromOrder, barOf, barTabs, botTabLabel, USUAL_BAR, withoutPin, withPin, withPinMoved } from "../src/state/tabs";

test("a saved bar is made whole: unknown names dropped, each tab once, three at most", () => {
  assert.deepEqual(barOf(undefined), USUAL_BAR);
  assert.deepEqual(barOf("spaces"), USUAL_BAR);
  assert.deepEqual(barOf([]), [], "an empty bar is a choice: the bot and All alone");
  assert.deepEqual(barOf(["spaces", "settings", "index", "spaces", 7, "all"]), ["spaces"]);
  assert.deepEqual(barOf(["market", "work", "spaces", "chats", "home"]), ["market", "work", "spaces"]);
});

test("the bar always starts with the bot and ends with All", () => {
  assert.deepEqual(barTabs([]), ["index", "all"]);
  assert.deepEqual(barTabs(USUAL_BAR), ["index", "home", "work", "all"]);
  assert.equal(barTabs(["home", "chats", "work"]).length, BAR_MAX + 2);
});

test("a phone that saved the old order of five tabs keeps the first three of an order it chose", () => {
  assert.deepEqual(barFromOrder(undefined), USUAL_BAR);
  assert.deepEqual(barFromOrder(["index", "chats", "spaces", "work", "market"]), USUAL_BAR, "the usual order was never a choice");
  assert.deepEqual(barFromOrder(["index", "chats"]), USUAL_BAR, "a short list is made whole first");
  assert.deepEqual(barFromOrder(["work", "chats", "index", "spaces", "market"]), ["work", "chats", "home"], "the old Home is the Home tab now");
  assert.deepEqual(barFromOrder(["market", "nope", "market", "spaces"]), ["market", "spaces", "home"]);
});

test("a tab is pinned at a place, and a full bar gives up its last one", () => {
  assert.deepEqual(withPin(["home", "work"], "chats", 1), { bar: ["home", "chats", "work"], bumped: null });
  assert.deepEqual(withPin(["home", "work"], "work", 0), { bar: ["work", "home"], bumped: null }, "a tab already on the bar only moves");
  assert.deepEqual(withPin(["home", "chats", "work"], "market", 0), { bar: ["market", "home", "chats"], bumped: "work" });
  assert.deepEqual(withPin(["home", "chats", "work"], "market", 99), { bar: ["home", "chats", "market"], bumped: "work" }, "never the one just pinned");
  assert.deepEqual(withoutPin(["home", "chats", "work"], "chats"), ["home", "work"]);
});

test("a pinned tab moves one place along and stops at either end", () => {
  assert.deepEqual(withPinMoved(["home", "chats", "work"], "chats", -1), ["chats", "home", "work"]);
  assert.deepEqual(withPinMoved(["home", "chats", "work"], "chats", 1), ["home", "work", "chats"]);
  assert.equal(withPinMoved(["home", "chats", "work"], "home", -1), null);
  assert.equal(withPinMoved(["home", "chats", "work"], "work", 1), null);
  assert.equal(withPinMoved(["home"], "market", 1), null, "not on the bar");
});

test("the first tab is named for its bot when the name is one short word", () => {
  assert.equal(botTabLabel("Pip"), "Pip");
  assert.equal(botTabLabel("  Chief of Staff "), "Chief");
  assert.equal(botTabLabel("Coding partner"), "Coding");
  assert.equal(botTabLabel("Superintendent"), "Bot", "a long word would widen the tab");
  assert.equal(botTabLabel(""), "Bot");
  assert.equal(botTabLabel(undefined), "Bot");
});
