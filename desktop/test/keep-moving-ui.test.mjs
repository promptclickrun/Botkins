// The words of "keep the work moving" in the window (src/keep.ts), and that the phone says the same
// (mobile/src/features/chat/keep.ts): a control or a state on one app is on the other, in the same words.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTINUE_OPEN_STEPS, DETACHED_LINE, keptLine, openLine } from "../src/keep.ts";

const phoneFile = fileURLToPath(new URL("../../mobile/src/features/chat/keep.ts", import.meta.url));
const phoneRequest = fileURLToPath(new URL("../../mobile/src/features/chat/request/logic.ts", import.meta.url));

const runs = [
  { continued: { count: 2, limit: 8, reason: "plan", open: 3 } },
  { continued: { count: 1, limit: 8, reason: "plan", open: 1 } },
  { continued: { count: 1, limit: 8, reason: "plan" } },
  { continued: { count: 1, limit: 8, reason: "next-step", open: 0 } },
  { continued: { count: 0, limit: 8, reason: "plan", open: 2 } },
  {},
  { plan: { open: 2, total: 3 }, stoppedOpen: true },
  { plan: { open: 1, total: 3 }, stoppedOpen: true },
  { plan: { open: 2, total: 3 } },
  { plan: { open: 0, total: 3 }, stoppedOpen: true },
];

test("the window says what Botkins did to keep the work moving", () => {
  assert.equal(keptLine({ continued: { count: 2, limit: 8, reason: "plan", open: 3 } }), "↻ Kept going: 3 plan steps were open");
  assert.equal(keptLine({ continued: { count: 1, limit: 8, reason: "plan", open: 1 } }), "↻ Kept going: 1 plan step was open");
  assert.equal(keptLine({ continued: { count: 1, limit: 8, reason: "next-step", open: 0 } }), "↻ Kept going: the next step was not done yet");
  assert.equal(keptLine({}), undefined, "a computer that sends nothing of it looks as before");
  assert.equal(openLine({ plan: { open: 2, total: 3 }, stoppedOpen: true }), "Stopped with 2 open steps");
  assert.equal(openLine({ plan: { open: 1, total: 3 }, stoppedOpen: true }), "Stopped with 1 open step");
  assert.equal(openLine({ plan: { open: 2, total: 3 } }), undefined);
  assert.equal(CONTINUE_OPEN_STEPS, "Continue with the open steps.");
});

test("the phone says the same words, for every run", { skip: !existsSync(phoneFile) && "The phone app is not beside this one." }, async () => {
  const phone = await import(phoneFile);
  for (const run of runs) {
    assert.equal(phone.keptLine(run), keptLine(run), JSON.stringify(run));
    assert.equal(phone.openLine(run), openLine(run), JSON.stringify(run));
  }
  assert.equal(phone.CONTINUE_OPEN_STEPS, CONTINUE_OPEN_STEPS);
  assert.equal((await import(phoneRequest)).DETACHED_LINE, DETACHED_LINE);
});
