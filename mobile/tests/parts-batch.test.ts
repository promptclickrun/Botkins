import assert from "node:assert/strict";
import { test } from "node:test";
import { createPartsBatcher, isTextOnlyParts } from "../src/state/partsBatch";
import { applyParts, forgetComputer, useApp } from "../src/state/store";

test("partsBatcher coalesces multiple text-only ticks into one frame flush", () => {
  const commits: Record<string, unknown>[] = [];
  const callbacks: Array<() => void> = [];
  const batcher = createPartsBatcher(
    (parts) => commits.push(parts),
    {
      schedule(fn) {
        callbacks.push(fn);
        return callbacks.length;
      },
      cancel() {},
    },
  );

  batcher.push({ "text:c1": { stream: "Hel" } });
  batcher.push({ "text:c1": { stream: "Hello" } });
  batcher.push({ "text:c1": { stream: "Hello world" } });

  assert.equal(commits.length, 0, "text ticks wait for the next animation frame");
  assert.equal(callbacks.length, 1, "only one frame callback is scheduled");

  callbacks[0]!();
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], { "text:c1": { stream: "Hello world" } });
});

test("partsBatcher flushes pending text atomically before structural updates", () => {
  const commits: Record<string, unknown>[] = [];
  let cancelled = 0;
  const batcher = createPartsBatcher(
    (parts) => commits.push(parts),
    {
      schedule() {
        return 1;
      },
      cancel() {
        cancelled++;
      },
    },
  );

  batcher.push({ "text:c1": { stream: "partial" } });
  batcher.push({ "chat:c1": { messages: [{ id: "m1" }] }, "text:c1": null });

  assert.equal(cancelled, 1, "pending frame callback is cancelled");
  assert.equal(commits.length, 1, "merged into one atomic commit");
  assert.deepEqual(commits[0], { "text:c1": null, "chat:c1": { messages: [{ id: "m1" }] } });
});

test("applyParts keeps parts, chats, and running identities unchanged on text-only ticks", () => {
  forgetComputer();
  applyParts({
    chats: [{ id: "c1", title: "One" }],
    live: { streams: { c1: true }, thinking: {}, requests: [], queued: {}, working: {} },
    "run:c1": { id: "r1", status: "running", steps: [] },
  });
  const before = useApp.getState();

  assert.equal(isTextOnlyParts({ "text:c1": { stream: "hi" } }), true);
  applyParts({ "text:c1": { stream: "hi" } });
  const after = useApp.getState();

  assert.equal(after.parts, before.parts, "parts reference unchanged on text-only tick");
  assert.equal(after.chats, before.chats, "chats reference unchanged on text-only tick");
  assert.equal(after.running, before.running, "running reference unchanged on text-only tick");
  assert.equal(after.texts.c1?.stream, "hi");

  // Re-sending an identical run does not churn the running map reference.
  applyParts({ "run:c1": { id: "r1", status: "running", steps: [] } });
  assert.equal(useApp.getState().running, after.running);
});
