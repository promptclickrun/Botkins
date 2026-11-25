// The turn as a story, its crew and lanes are one plain file shared by both apps. Its behavior is
// tested on the phone's side (mobile/tests/activity-story.test.ts, which runs TypeScript); this
// keeps the desktop's copy the same file.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("the desktop's activityStory.ts is the phone's, byte for byte", () => {
  const desktop = readFileSync(new URL("../src/activityStory.ts", import.meta.url), "utf8");
  const phone = readFileSync(new URL("../../mobile/src/features/chat/activityStory.ts", import.meta.url), "utf8");
  assert.equal(desktop, phone, "change both copies together");
});
