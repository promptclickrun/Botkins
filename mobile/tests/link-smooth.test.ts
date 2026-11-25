import assert from "node:assert/strict";
import { test } from "node:test";
import { createFollowing, LINGER_MS } from "../src/state/following";
import { useApp } from "../src/state/store";
import { setup, settle } from "./smooth-link";

for (const relay of [false, true]) {
  const route = relay ? "pushed relay updates" : "direct syncs";
  test("three bots on other chats produce ten " + route + " during ten seconds on Home", async (t) => {
    const { wire, start, advance, step, runs } = await setup(t, relay);
    await start();
    const deliveries = () => relay ? wire.pushes : wire.syncs;
    const before = deliveries();
    let updates = 0;
    const stop = useApp.subscribe(() => updates++);
    t.after(stop);
    for (let n = 0; n < 100; n++) {
      step();
      await advance(100);
    }
    t.diagnostic(`${deliveries() - before} ${route}, ${updates} store updates for 100 batches of three steps`);
    assert.deepEqual([deliveries() - before, updates], [10, 10]);
    await advance(1000);
    for (const run of runs) assert.equal(useApp.getState().parts.runs?.find((row) => row.id === run.id)?.stepCount, 100);
  });

  test("a pending summary leaves the link listening for approvals, sends and the open chat's first text over " + route, async (t) => {
    const { backend, client, mine, start, advance, step } = await setup(t, relay);
    client.watch([mine.id]);
    await start();
    step();
    await advance(100);
    step();
    await advance(100);
    const request = { id: "permission", botId: mine.botId, chatId: mine.id, title: "Allow the task?", kind: "permission" };
    backend.state.requests.push(request);
    backend.changed();
    await advance(100);
    const live = () => useApp.getState().parts.live!;
    assert.equal(live().requests.at(-1)?.id, request.id, "the approval arrived on the next pump");
    await client.call("respond", request.id, { action: "approve" });
    await advance(100);
    assert.equal(live().requests.some((entry) => entry.id === request.id), false);

    step();
    await advance(100);
    await client.call("send", mine.id, "Hello", { clientMessageId: "sent" });
    await advance(100);
    assert.ok(useApp.getState().chats[mine.id]?.messages.some((m) => m.clientMessageId === "sent"));
    backend.state.streams[mine.id] = "First words";
    backend.changed();
    await advance(200);
    await advance(16); // Text-only changes still commit on a frame.
    assert.equal(useApp.getState().texts[mine.id]?.stream, "First words");
  });
}

test("changing the watch on a dead path preserves the wake's original four-second deadline", async (t) => {
  const { wire, states, client, start, advance, mine } = await setup(t);
  await start();
  client.rest();
  await settle();
  wire.dead = true;
  client.wake();
  await settle();
  assert.equal(wire.attempts, 1);
  await advance(3000);
  client.watch([mine.id]);
  await settle();
  assert.equal(wire.attempts, 2, "the watch replaced the quick sync");
  await advance(1000);
  assert.ok(states.includes("connecting"), "the four-second check gave up the dead session");
  wire.dead = false;
  client.wake("retry");
  await advance(4000); // The in-flight dead hello also owns a deadline.
  await advance(2000);
  assert.equal(client.state, "online");
});

test("five quick returns to a chat use the original page, and a later return fetches a fresh one", async (t) => {
  const { backend, wire, additions, client, start, advance, mine } = await setup(t);
  const follow = createFollowing({ send: (ids, kept) => client.watch(ids, kept), away: () => false });
  let stop = follow.watch(mine.id);
  await start();
  backend.state.streams[mine.id] = "visible";
  backend.changed();
  await advance(200);
  for (let n = 0; n < 5; n++) {
    stop();
    await settle();
    const before = additions.length;
    backend.state.streams[mine.id] += " away";
    backend.changed();
    await advance(200);
    assert.equal(additions.length, before, "the hidden chat sent no reply text");
    stop = follow.watch(mine.id);
    await advance(100);
  }
  assert.equal(wire.pages, 1, "the page was sent only on the first visit");
  stop();
  await advance(LINGER_MS);
  await advance(25_000); // The watch without the chat was acknowledged.
  follow.watch(mine.id);
  await settle();
  assert.equal(wire.pages, 2);
});

test("a detail sheet can follow another chat's steps while only the visible conversation receives words", async (t) => {
  const { backend, mine, runs, client, start, advance } = await setup(t, false, { textStreaming: () => "chunks" });
  const sheet = runs[0].chatId;
  client.watch([mine.id, sheet], undefined, [mine.id]);
  backend.state.streams[mine.id] = "Visible words ";
  backend.state.streams[sheet] = "Hidden words ";
  backend.changed();
  await start();
  await advance(700);
  assert.equal(useApp.getState().texts[mine.id]?.stream, "Visible words ");
  assert.equal(useApp.getState().texts[sheet]?.stream, undefined);
  assert.ok(useApp.getState().running[sheet], "the detail sheet still has its run");
});

test("an unfinished word reaches a visible chat even while other bots keep changing the summaries", async (t) => {
  const { backend, mine, client, start, advance, step } = await setup(t, false, { textStreaming: () => "chunks" });
  client.watch([mine.id]);
  backend.state.streams[mine.id] = "unfinished";
  backend.changed();
  await start();
  for (let second = 0; second < 7; second++) {
    step();
    await advance(1000);
  }
  await advance(16);
  assert.equal(useApp.getState().texts[mine.id]?.stream, "unfinished");
});


test("a page that changed while kept sends the new messages on return", async (t) => {
  const { backend, client, mine, start, advance, wire } = await setup(t);
  const follow = createFollowing({ send: (ids, kept) => client.watch(ids, kept), away: () => false });
  const close = follow.watch(mine.id);
  await start();
  close();
  await settle();
  mine.messages.push({ role: "assistant", text: "Finished while hidden" });
  backend.changed();
  await advance(100);
  assert.equal(wire.pages, 1);
  follow.watch(mine.id);
  await advance(100);
  assert.equal(wire.pages, 2);
  assert.equal(useApp.getState().chats[mine.id]?.messages.at(-1)?.text, "Finished while hidden");
});
