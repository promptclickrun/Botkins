// The default harness (desktop/harness/index.mjs, Workspace's loader): Pi, then each provider's own
// tool, then Copilot, then OMP. A choice the person made is kept; the old default ("copilot") saved
// without `harnessPicked` was not a choice and moves to Pi; a default whose program isn't here
// gives way to the next in the order.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "../desktop/workspace.mjs";
import { DEFAULT_HARNESS, HARNESSES } from "../desktop/harness/index.mjs";
import { changeSettings } from "../desktop/preferences.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

const open = (t, settings) => {
  const dir = tempDir(t);
  if (settings) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workspace.json"), JSON.stringify({ bots: [], chats: [], runs: [], settings }));
  }
  return new Workspace(dir, fakeClient().client, () => {});
};

test("the order is Pi, each provider's own, Copilot, OMP; Pi is the default", () => {
  assert.deepEqual(HARNESSES, ["pi", "provider", "copilot", "omp"]);
  assert.equal(DEFAULT_HARNESS, "pi");
});

test("a new computer starts on Pi, not as a choice", (t) => {
  const ws = open(t);
  assert.equal(ws.state.settings.harness, "pi");
  assert.equal(ws.state.settings.harnessPicked, false);
});

test("the old default saved without a choice moves to Pi; anything chosen stays", (t) => {
  assert.equal(open(t, { harness: "copilot" }).state.settings.harness, "pi", "the old default was not a choice");
  for (const chosen of ["provider", "omp", "pi"]) {
    const ws = open(t, { harness: chosen });
    assert.equal(ws.state.settings.harness, chosen);
    assert.equal(ws.state.settings.harnessPicked, true);
  }
  const kept = open(t, { harness: "copilot", harnessPicked: true });
  assert.equal(kept.state.settings.harness, "copilot", "Copilot picked on purpose stays");
});

test("picking a harness marks it the person's own", () => {
  const next = changeSettings({ harness: "pi", harnessPicked: false }, { harness: "copilot" });
  assert.deepEqual([next.harness, next.harnessPicked], ["copilot", true]);
});

test("a default whose program isn't here gives way to the next; a choice never does", (t) => {
  const ws = open(t);
  ws.harness.missing.add("pi");
  assert.equal(ws.harness.effective(), "provider", "no Pi here: each provider's own tool runs");
  assert.equal(ws.snapshot().settings.harness, "provider", "and Settings shows that one");
  assert.equal(ws.state.settings.harness, "pi", "what is saved stays the default, for when Pi arrives");
  ws.state.settings.harnessPicked = true;
  assert.equal(ws.harness.effective(), "pi", "a choice is kept even without its program");
  ws.harness.missing.delete("pi");
  ws.state.settings.harnessPicked = false;
  assert.equal(ws.harness.effective(), "pi");
});
