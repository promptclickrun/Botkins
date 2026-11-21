// The screen's shape on iPhone Duo and every other phone (src/ui/shape.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { foldGap, listWidth, shapeOf } from "../src/ui/shape";

const none = { top: 59, right: 0, bottom: 34, left: 0 };

test("a phone, the Duo closed and opened, and the fold: rail, tab room, two panes, pose", () => {
  // An ordinary iPhone upright: no rail, room for the tab bar, one pane.
  const phone = shapeOf({ width: 402, height: 874, insets: none, tabBar: 64 });
  assert.deepEqual([phone.rail, phone.tabRoom, phone.wide, phone.pose], [null, 64, false, "flat"]);

  // An iPhone on its side has the notch's inset on both sides: still no rail.
  const sideways = shapeOf({ width: 874, height: 402, insets: { top: 0, right: 59, bottom: 21, left: 59 }, tabBar: 64 });
  assert.equal(sideways.rail, null);
  assert.equal(sideways.tabRoom, 64);

  // Android on its side: its buttons sit on one side, and the tab bar stays at the bottom.
  const android = shapeOf({ width: 915, height: 412, insets: { top: 24, right: 48, bottom: 0, left: 0 }, tabBar: 96, ios: false });
  assert.deepEqual([android.rail, android.right, android.tabRoom], [null, 48, 96]);

  // iPhone Duo closed: the rail is on the trailing edge (84 points, measured in the simulator).
  const closed = shapeOf({ width: 466, height: 678, insets: { top: 0, right: 84, bottom: 34, left: 0 }, tabBar: 64 });
  assert.deepEqual([closed.rail, closed.right, closed.tabRoom, closed.wide], ["right", 84, 0, false]);

  // Opened on its side: the same rail, and room for the list beside the chat.
  const open = shapeOf({ width: 951, height: 669, insets: { top: 0, right: 84, bottom: 21, left: 0 }, tabBar: 64 });
  assert.equal(open.wide, true);
  assert.equal(listWidth(open, 951), 312);
  assert.equal(foldGap(open), 0);

  // The system's own word for the edge wins over the guess, and follows right-to-left text.
  assert.equal(shapeOf({ width: 951, height: 669, insets: none, tabBar: 64, native: { hinge: "open", edge: "leading", fold: null } }).rail, "left");
  assert.equal(shapeOf({ width: 951, height: 669, insets: none, tabBar: 64, native: { hinge: "open", edge: "leading", fold: null }, rtl: true }).rail, "right");

  // Partly open like a book: the list snaps to the page before the fold, and the fold is the gap.
  const fold = { x: 465, y: 0, width: 21, height: 669 };
  const book = shapeOf({ width: 951, height: 669, insets: { top: 0, right: 84, bottom: 21, left: 0 }, tabBar: 64, native: { hinge: "partial", angle: 120, edge: "trailing", fold } });
  assert.equal(book.pose, "book");
  assert.equal(listWidth(book, 951), 465);
  assert.equal(foldGap(book), 21);

  // Partly open and flat on a table: the fold runs side to side.
  const laptop = shapeOf({ width: 669, height: 951, insets: none, tabBar: 64, native: { hinge: "partial", edge: null, fold: { x: 0, y: 465, width: 669, height: 21 } } });
  assert.equal(laptop.pose, "laptop");

  // Fully open, the fold is no longer in the way.
  assert.equal(shapeOf({ width: 951, height: 669, insets: none, tabBar: 64, native: { hinge: "open", edge: null, fold } }).pose, "flat");
});
