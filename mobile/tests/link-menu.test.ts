// What a hold on a link in a message offers (src/ui/linkMenu.ts): the items, what Copy puts on the
// clipboard, and reading an item's id back so the right link is acted on after the finger has left it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isWebLink, linkActions, linkText, linkTitle, parseLinkAction } from "../src/ui/linkMenu";

test("a web link offers Open link, Copy link and Share, each carrying its link", () => {
  const url = "https://example.com/a?b=1&c=2:3";
  const actions = linkActions(url);
  assert.deepEqual(actions.map((action) => action.title), ["Open link", "Copy link", "Share…"]);
  // The id keeps everything after the choice, colons in the link included.
  assert.deepEqual(actions.map((action) => parseLinkAction(action.id!)), [
    { choice: "open", url },
    { choice: "copy", url },
    { choice: "share", url },
  ]);
});

test("a mailto: or tel: link is copied without its scheme, and is not opened", () => {
  assert.equal(linkText("mailto:me@example.com?subject=Hi%20there"), "me@example.com");
  assert.equal(linkText("tel:+1%20555-0100"), "+1 555-0100");
  assert.equal(linkText("https://example.com/x"), "https://example.com/x");
  assert.deepEqual(linkActions("mailto:me@example.com").map((action) => action.title), ["Copy email address", "Share…"]);
  assert.deepEqual(linkActions("tel:+15550100").map((action) => action.title), ["Copy phone number", "Share…"]);
  assert.equal(isWebLink("HTTP://example.com"), true);
  assert.equal(isWebLink("mailto:me@example.com"), false);
});

test("a message's own menu items are not read as a link's", () => {
  for (const id of ["copy", "select", "share", "read", "link", "link-copy", "link-delete:https://example.com"]) assert.equal(parseLinkAction(id), null);
});

test("a long link is cut short in the menu's title only", () => {
  const url = "https://example.com/" + "a".repeat(100);
  assert.equal(linkTitle(url).length, 56);
  assert.ok(linkTitle(url).endsWith("…"));
  assert.equal(linkTitle("mailto:me@example.com"), "me@example.com");
});
