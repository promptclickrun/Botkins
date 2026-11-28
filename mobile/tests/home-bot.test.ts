// The first tab's row of bots as numbers (src/features/home/strip.ts) and the room under a chat's
// message box (chatDockRoom in src/ui/shape.ts). Both are plain logic: this is what can be checked
// without a phone. How the row looks and feels is for a device.
import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeRoom, faceScale, faceShown, indexAt, middleOf, offsetOf, pillWords, STRIP } from "../src/features/home/strip";
import { chatDockRoom } from "../src/ui/shape";

test("the bot in the middle of the row is the one on show, whatever the row's width", () => {
  for (const width of [139, 281, 290, 328]) {
    for (let index = 0; index < 8; index++) {
      // At a bot's own offset its middle is the row's middle.
      assert.equal(middleOf(index, offsetOf(index), width), width / 2);
      assert.equal(indexAt(offsetOf(index), 8), index);
    }
  }
  // A swipe that stops between two bots lands on the nearer one, and never past either end.
  assert.equal(indexAt(STRIP.slot * 2.4, 8), 2);
  assert.equal(indexAt(STRIP.slot * 2.6, 8), 3);
  assert.equal(indexAt(-50, 8), 0);
  assert.equal(indexAt(9999, 8), 7);
  assert.equal(indexAt(0, 0), 0);
  // The row rests on a slot: every resting offset is a whole number of slots.
  assert.equal(offsetOf(3) % STRIP.slot, 0);
  assert.equal(edgeRoom(STRIP.slot - 10), 0);
});

test("the bot on show is drawn large and whole; the others small, dimmed and close together", () => {
  assert.equal(faceScale(0), 1);
  assert.equal(Math.round(faceScale(1) * STRIP.face), STRIP.small);
  assert.equal(Math.round(faceScale(-3) * STRIP.face), STRIP.small);
  assert.ok(STRIP.face >= STRIP.small * 2.5, "the difference is plain to see");
  assert.equal(faceShown(0), 1);
  assert.equal(faceShown(1), STRIP.dim);
  assert.equal(faceShown(-1), STRIP.dim);
  assert.equal(faceShown(3), STRIP.far);
  assert.equal(faceShown(9), STRIP.far);
  // Half way between two bots, both are on their way: neither is whole, neither is small.
  assert.ok(faceScale(0.5) > faceScale(1) && faceScale(0.5) < 1);

  // With the second of eight bots on show, on a 440-point phone: where each bot's middle is in the row.
  const row = 440 - 2 * 8 - 2 * STRIP.side;
  const at = (index: number) => middleOf(index, offsetOf(1), row) - row / 2;
  assert.equal(at(1), 0);
  // The bots beside the large face stand clear of it, with space between.
  assert.ok(at(2) - STRIP.small / 2 - STRIP.face / 2 >= 8, "a neighbor touches the large face");
  assert.equal(at(0), -at(2));
  // Beyond them the small faces are a slot apart, close together, with space between.
  assert.equal(at(3) - at(2), STRIP.slot);
  assert.ok(STRIP.slot - STRIP.small >= 10 && STRIP.slot - STRIP.small <= 18);
  // Two bots show whole on each side of the one on show.
  assert.ok(at(3) + STRIP.small / 2 <= row / 2, "the second neighbor is cut off");
  // On a 393-point phone the second is whole too, or all but a point or two.
  assert.ok(at(3) + STRIP.small / 2 <= (393 - 2 * 8 - 2 * STRIP.side) / 2 + 6);
  // Mid-swipe the bots move apart smoothly: a bot never jumps as another takes the middle.
  for (let offset = 0; offset < offsetOf(4); offset += 3) {
    const step = middleOf(2, offset + 3, row) - middleOf(2, offset, row);
    assert.ok(Math.abs(step) <= 3 * (1 + STRIP.push / STRIP.slot) + 0.001, "a bot jumped at " + offset);
  }
  assert.deepEqual(pillWords({ name: " Pip ", role: " Chief of staff " }), { name: "Pip", role: "Chief of staff" });
  assert.deepEqual(pillWords({ name: "Pip" }), { name: "Pip", role: "" });
});

test("the message box leaves the tab bar's room once, and only the home indicator's on a page", () => {
  // The phone the gap was seen on (2026-11-28): in a tab its safe area is 85 points, the bar included.
  // The bar's 64 points were added again, which put the message box 149 points up.
  assert.equal(chatDockRoom({ bottom: 85, tabRoom: 64, pane: true, ios: true, pad: 8 }), 85);
  // With the bar in the side rail there is no bar's room, and the safe area is the home indicator's.
  assert.equal(chatDockRoom({ bottom: 21, tabRoom: 0, pane: true, ios: true, pad: 8 }), 21);
  // Elsewhere the safe area is the screen's own, and the bar's room is added to it.
  assert.equal(chatDockRoom({ bottom: 24, tabRoom: 96, pane: true, ios: false, pad: 8 }), 120);
  // On a page the box's own padding sits inside the home indicator's room: it rests 34 points up, not 42.
  assert.equal(chatDockRoom({ bottom: 34, tabRoom: 64, pane: false, ios: true, pad: 8 }) + 8, 34);
  assert.equal(chatDockRoom({ bottom: 0, tabRoom: 64, pane: false, ios: true, pad: 8 }), 0);
});
