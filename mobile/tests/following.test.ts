import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createFollowing, LINGER_MS, RETURN_GRACE_MS } from "../src/state/following";

function following(t: TestContext, lingerMs = LINGER_MS) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const sent: { shown: string[]; kept?: string }[] = [];
  const app = { away: false };
  const follow = createFollowing({ send: (shown, kept) => sent.push({ shown, kept }), away: () => app.away, lingerMs });
  return { follow, sent, app };
}

test("a quick return reuses one kept page while only visible chats are followed", (t) => {
  const { follow, sent } = following(t);
  let close = follow.watch("a");
  for (let n = 0; n < 5; n++) {
    close();
    assert.deepEqual(sent.at(-1), { shown: [], kept: "a" });
    t.mock.timers.tick(LINGER_MS - 1);
    close = follow.watch("a");
    assert.deepEqual(sent.at(-1), { shown: ["a"], kept: undefined });
    t.mock.timers.tick(LINGER_MS * 2);
  }
  assert.equal(sent.length, 11);
});

test("screens share a watch and the last one closed replaces the previous kept page", (t) => {
  const { follow, sent } = following(t);
  const first = follow.watch("a");
  const sheet = follow.watch("a");
  first();
  first();
  assert.equal(sent.length, 1);
  sheet();
  const close = follow.watch("b");
  assert.deepEqual(sent.at(-1), { shown: ["b"], kept: "a" });
  close();
  assert.deepEqual(sent.at(-1), { shown: [], kept: "b" });
  t.mock.timers.tick(LINGER_MS);
  assert.deepEqual(sent.at(-1), { shown: [], kept: undefined });
  assert.equal(sent.length, 5);
});

test("a suspended timer gives the returning screen time to reclaim its page", (t) => {
  const { follow, sent, app } = following(t);
  app.away = true;
  follow.watch("a")();
  t.mock.timers.tick(LINGER_MS * 4);
  assert.equal(follow.keptPage(), "a");
  app.away = false;
  follow.returned();
  t.mock.timers.tick(RETURN_GRACE_MS - 1);
  assert.equal(follow.keptPage(), "a");
  t.mock.timers.tick(1);
  assert.deepEqual(sent.at(-1), { shown: [], kept: undefined });
});

test("a background sync releases a page once and a reasoning watch stops immediately", (t) => {
  const { follow, sent } = following(t);
  follow.watch("a")();
  const close = follow.watch("b");
  follow.release();
  follow.release();
  assert.deepEqual(sent.at(-1), { shown: ["b"], kept: undefined });
  assert.equal(sent.length, 4);
  close();
  const reasoning = createFollowing({ send: (shown, kept) => sent.push({ shown, kept }), away: () => false, lingerMs: 0 });
  reasoning.watch("a")();
  assert.deepEqual(sent.at(-1), { shown: [], kept: undefined });
});
