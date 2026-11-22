import assert from "node:assert/strict";
import test from "node:test";
import { applyParts, pendingSends } from "../src/state/store";
import type { Message } from "../src/link/types";

test("the phone keeps each local bubble until its own chat or queue echoes it", async () => {
  const message = (id: string) => ({ clientMessageId: id, role: "user" as const, text: "again", quote: "Which one?" });
  const first = message("first");
  const second = message("second");
  const page = (messages: Message[]) => ({ from: 0, total: messages.length, messages, runs: [] });
  const reply = Promise.withResolvers<void>();
  const sent = pendingSends.send("c", first, () => reply.promise);
  await pendingSends.send("c", second, async () => {});
  assert.deepEqual(pendingSends.rows("c"), [first, second]);
  applyParts({ "chat:other": page([first]), "chat:c": page([message("another-device")]) });
  assert.deepEqual(pendingSends.rows("c"), [first, second]);
  applyParts({ "chat:c": page([second]) });
  assert.deepEqual(pendingSends.rows("c"), [first]);
  applyParts({ live: { streams: {}, thinking: {}, queued: { c: [{ id: "queue-item", ...first }] } } });
  assert.deepEqual(pendingSends.rows("c"), []);
  reply.reject(new Error("reply lost after host accepted the send"));
  await sent;
  await assert.rejects(pendingSends.send("c", first, async () => { throw new Error("offline"); }), /offline/);
  assert.deepEqual(pendingSends.rows("c"), []);
});

test("an older host can confirm repeated text one new row at a time", async () => {
  for (const id of ["one", "two"]) {
    await pendingSends.send("legacy", { clientMessageId: id, role: "user", text: "again" }, async () => {},
      { from: 20, queued: new Set(["old"]) });
  }
  const page = { from: 19, total: 21, messages: [{ role: "user", text: "again" }, { role: "user", text: "again" }], runs: [] };
  applyParts({ "chat:legacy": page, live: { streams: {}, thinking: {}, queued: { legacy: [{ id: "old", text: "again" }] } } });
  assert.deepEqual(pendingSends.rows("legacy").map(m => m.clientMessageId), ["two"]);
  applyParts({ "chat:legacy": page });
  assert.equal(pendingSends.rows("legacy").length, 1);
  applyParts({ live: { streams: {}, thinking: {}, queued: { legacy: [{ id: "new", text: "again" }] } } });
  assert.equal(pendingSends.rows("legacy").length, 0);
});
