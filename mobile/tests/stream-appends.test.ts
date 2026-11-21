import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { checkJoin, LinkClient, type LinkOptions, pair, startJoin } from "../src/link/client";
import { applyParts, useApp } from "../src/state/store";
import { activityLabel, botActivity, chatActivity, needsYou, panelRefreshing } from "../src/state/sessionActivity";

async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < end, "timed out waiting for link");
    await sleep(5);
  }
}

async function setup(t: TestContext, appends = true) {
  const saved = process.env.BOTKINS_DEV_APPENDS;
  process.env.BOTKINS_DEV_APPENDS = appends ? "on" : "off";
  let backend;
  try {
    backend = new MockBackend();
  } finally {
    if (saved === undefined) delete process.env.BOTKINS_DEV_APPENDS;
    else process.env.BOTKINS_DEV_APPENDS = saved;
  }
  const dir = mkdtempSync(join(tmpdir(), "botkins-stream-"));
  const link = new LinkHost({ backend, relay: false, port: 0, dir });
  await link.setEnabled(true);
  const clients: LinkClient[] = [];
  t.after(async () => {
    for (const client of clients) client.stop();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function phone(streamAppends = false, onParts = (_parts: Record<string, unknown>) => {}, more: Partial<LinkOptions> = {}) {
    const paired = await pair(fetch, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "phone", platform: "ios" });
    const client = new LinkClient(paired, { fetch, streamAppends, onParts, onState() {}, ...more });
    clients.push(client);
    return client;
  }
  return { backend, link, phone };
}

for (const [phone, host] of [[true, true], [true, false], [false, true]]) {
  test(`unwatched session updates Home, Today and Work on the first pump (phone appends ${phone}, host appends ${host})`, async (t) => {
    const { backend, link, phone: connect } = await setup(t, host);
    let wireLive;
    const client = await connect(phone, (news) => {
      if (news.live) wireLive = news.live;
      applyParts(news);
    });
    client.start();
    const state = backend.state;
    const chat = state.chats.find((c) => !c.botIds);
    const id = chat.id;
    const parts = () => useApp.getState().parts;
    async function change(write: () => void) {
      await until(() => link.waiters.size === 1);
      const [waiter] = link.waiters;
      write();
      backend.changed();
      // Registered after changed(): the first 60 ms pump must have answered the waiting request.
      await sleep(75);
      assert.ok(!link.waiters.has(waiter), "non-text change left the original poll waiting");
      await until(() => link.waiters.size === 1);
    }
    const label = () => activityLabel(botActivity(parts().live, parts().chats!, chat.botId));
    await change(() => {
      state.streams[id] = "";
      state.panels = [{ id: "panel", refreshChatId: id }];
      state.board = [{ id: "card" }];
    });
    assert.equal(label(), "Thinking…");
    assert.ok(panelRefreshing(parts().live?.streams, parts().panels![0].refreshChatId));
    assert.equal(parts().board![0].id, "card");
    await change(() => { state.intents[id] = "Searching the wiki"; });
    assert.equal(chatActivity(parts().live, id), "browsing");
    await change(() => { state.streams[id] = "first"; });
    assert.equal(label(), "Replying…");
    assert.equal(parts().meta!.capabilities.includes("stream-appends-v1"), host);
    assert.equal(wireLive.streams[id], phone && host ? true : "first");
    assert.equal(parts().live!.streams[id], true);
    const [watcher] = link.waiters;
    state.streams[id] += " more";
    backend.changed();
    if (phone && host) {
      await sleep(225);
      assert.ok(link.waiters.has(watcher), "unwatched text alone should leave the phone asleep");
      assert.equal(useApp.getState().texts[id], undefined);
    } else {
      await until(() => useApp.getState().texts[id]?.stream === "first more");
    }
    await change(() => {
      state.streams[id] += " words";
      state.requests = [{ id: "ask", botId: chat.botId, chatId: id }];
      state.speakers[id] = chat.botId;
      state.queued[id] = [{ id: "q", text: "next" }];
      state.steerable = { [id]: true };
      state.tasks = [{ id: "task", status: "review" }];
      state.runs = [{ id: "run", chatId: id, status: "Working" }];
    });
    assert.equal(label(), "Needs you");
    assert.equal(needsYou(parts()), 2);
    assert.equal(parts().live!.requests[0].id, "ask");
    assert.equal(parts().live!.speakers[id], chat.botId);
    assert.equal(parts().live!.queued[id][0].id, "q");
    assert.equal(parts().live!.steerable![id], true);
    assert.equal(parts().runs![0].id, "run");
    await change(() => {
      delete state.streams[id];
      state.requests = [];
      chat.unread = true;
      chat.messages.push({ role: "assistant", text: "finished" });
    });
    assert.equal(label(), "");
    assert.ok(!panelRefreshing(parts().live?.streams, id));
    const summary = parts().chats!.find((c) => c.id === id)!;
    assert.ok(summary.unread);
    assert.equal(summary.last!.text, "finished");
    assert.ok(!useApp.getState().chats[id], "chat detail was never watched");
  });
}

test("legacy sync and invalid opt-ins retain the full live bytes", async (t) => {
  const { backend, link, phone } = await setup(t);
  const client = await phone();
  const state = backend.state;
  const id = state.chats[0].id;
  state.streams[id] = "whole reply";
  state.thinking[id] = "whole thought";
  backend.changed();
  const sync = (appends?) => client.call("link.sync", { epoch: link.epoch, watch: [id], ...(appends !== undefined && { appends }) });
  const legacy = await sync();
  const expected = { streams: state.streams, intents: state.intents, thinking: state.thinking, speakers: state.speakers, queued: state.queued, requests: state.requests, active: Object.keys(state.streams), ...(state.steerable && { steerable: state.steerable }) };
  assert.equal(JSON.stringify(legacy.parts.live), JSON.stringify(expected));
  assert.ok(!("quietLive" in legacy.parts));
  assert.ok(!("text:" + id in legacy.parts));
  const valid = { id: "s", stream: 0, thinking: 0 };
  for (const invalid of [false, [], { other: valid }, { [id]: { ...valid, stream: -1 } }, { [id]: { ...valid, thinking: 0.5 } }, { [id]: { ...valid, id: "x".repeat(129) } }, { [id]: { ...valid, stream: 1e20 } }]) {
    assert.equal(JSON.stringify((await sync(invalid)).parts), JSON.stringify(legacy.parts));
  }
  const watch = [id, "second", "third", "fourth", "fifth"];
  const tooMany = Object.fromEntries(watch.map((chat) => [chat, valid]));
  const rejected = await client.call("link.sync", { epoch: link.epoch, watch, appends: tooMany });
  assert.equal(JSON.stringify(rejected.parts.live), JSON.stringify(expected));
  const quiet = await sync({});
  assert.notEqual(quiet.v.live, legacy.v.live);
  const key = "text:" + id;
  const expired = await client.call("link.sync", { watch: [id], epoch: "old", appends: { [id]: { id: quiet.parts[key].id, stream: 3, thinking: 4 } } });
  assert.equal(expired.parts[key].stream.from, 0);
  const oversized = await sync({ [id]: { id: quiet.parts[key].id, stream: 500, thinking: 4 } });
  assert.equal(oversized.parts[key].thinking.from, 0);
});

test("watch, unwatch, rewatch, renewed session and a restarted host reconstruct the phone's text", async (t) => {
  const { backend, link, phone } = await setup(t);
  const client = await phone(true, applyParts);
  const id = backend.state.chats[0].id;
  const stream = backend.state.streams;
  const thinking = backend.state.thinking;
  const held = () => useApp.getState().texts[id];
  stream[id] = "\ud83d";
  thinking[id] = "one";
  backend.changed();
  client.start();
  await until(() => link.waiters.size === 1);
  assert.equal(held(), undefined);
  client.watch([id]);
  await until(() => held()?.stream === "\ud83d");
  stream[id] += "\ude42";
  thinking[id] += " two";
  backend.changed();
  await until(() => held()?.stream === "🙂");
  assert.equal(held()?.thinking, "one two");
  client.watch([]);
  await until(() => !held());
  stream[id] = "changed while away";
  backend.changed();
  client.watch([id]);
  await until(() => held()?.stream === stream[id]);
  await until(() => link.waiters.size === 1);
  link.sessions.clear();
  client.wake();
  stream[id] += " after 401";
  backend.changed();
  await until(() => held()?.stream === stream[id] && link.sessions.size > 0);
  client.stop();
  // A fresh epoch, versions and cache as after relaunch, with the pairing still on disk.
  link.epoch = "next-epoch";
  link.parts.clear();
  link.texts.clear();
  link.version = 0;
  stream[id] = "fresh";
  backend.changed();
  client.start();
  await until(() => held()?.stream === "fresh");
  delete stream[id];
  delete thinking[id];
  backend.changed();
  await until(() => !held());
  stream[id] = "next turn";
  backend.changed();
  await until(() => held()?.stream === "next turn");
});

test("text-only legacy and append syncs preserve live and every unchanged inner reference", () => {
  const live = { streams: { c: "first" }, thinking: { c: "one" }, active: ["c"], intents: { c: "test" }, speakers: {}, queued: {}, requests: [], steerable: {} };
  applyParts({ live });
  const before = useApp.getState();
  applyParts({ live: { ...structuredClone(live), streams: { c: "first word" } } });
  assert.equal(useApp.getState().parts, before.parts);
  assert.equal(useApp.getState().parts.live, before.parts.live);
  assert.deepEqual(useApp.getState().texts.c, { stream: "first word", thinking: "one" });
  applyParts({ "text:c": { stream: "first word", thinking: "one more" } });
  assert.equal(useApp.getState().parts.live, before.parts.live);
  applyParts({ live: { ...structuredClone(live), streams: { c: true }, thinking: { c: true }, intents: { c: "new" } } });
  const now = useApp.getState().parts.live!;
  assert.notEqual(now, before.parts.live);
  for (const key of Object.keys(live).filter((k) => k !== "intents")) assert.equal(now[key], before.parts.live![key]);
});

for (const optIn of [false, true]) {
  test(`text-only waits respect 200 ms and release pending text with a step (appends ${optIn})`, async (t) => {
    const { backend, link, phone } = await setup(t);
    const id = backend.state.chats[0].id;
    const received = [];
    const client = await phone(optIn, (news) => received.push(news));
    const stream = backend.state.streams;
    stream[id] = "a";
    backend.state.runs.unshift({ id: "run-cadence", chatId: id, status: "Working", steps: [] });
    backend.changed();
    client.watch([id]);
    client.start();
    await until(() => link.waiters.size === 1);
    const session = [...link.sessions.values()][0];
    const first = session.lastNews;
    stream[id] += "b";
    backend.changed();
    await until(() => received.length === 2);
    assert.ok(session.lastNews - first >= 200, "two text deliveries too close");
    await until(() => link.waiters.size === 1);
    stream[id] += "c";
    backend.changed();
    backend.state.runs[0].steps.push({ id: "step", status: "Running" });
    backend.changed();
    const [waiter] = link.waiters;
    await sleep(75);
    assert.ok(!link.waiters.has(waiter), "a step missed the fast pump");
    await until(() => received.length === 3);
    assert.equal(received[2]["run:" + id].steps.length, 1);
    assert.equal(optIn ? received[2]["text:" + id].stream : received[2].live.streams[id], "abc");
    await sleep(220);
    const [quietWaiter] = link.waiters;
    stream[id] += "d";
    backend.changed();
    await sleep(75);
    assert.ok(!link.waiters.has(quietWaiter), "first text after silence missed the fast pump");
  });
}

test("with live text off a phone gets indicators only, is not woken by text, and the reply whole", async (t) => {
  const { backend, link, phone } = await setup(t);
  const received: Record<string, any>[] = [];
  let text = true;
  const syncs: Record<string, unknown>[] = [];
  const client = await phone(true, (news) => {
    received.push(news);
    applyParts(news);
  }, { liveText: () => text });
  const sync = link.sync.bind(link);
  link.sync = (session, args, gone) => {
    syncs.push(args);
    return sync(session, args, gone);
  };
  const chat = backend.state.chats.find((c) => !c.botIds);
  const id = chat.id;
  const stream = backend.state.streams;
  const held = () => useApp.getState().texts[id];
  stream[id] = "first";
  backend.changed();
  client.watch([id]);
  client.start();
  await until(() => held()?.stream === "first");
  assert.ok(!("text" in syncs.at(-1)!), "live text on: the field is left out");

  text = false;
  client.liveTextChanged();
  await until(() => !held());
  assert.equal(syncs.at(-1)!.text, false);
  assert.ok(useApp.getState().parts.meta!.capabilities.includes("live-text-off-v1"));
  await until(() => link.waiters.size === 1);
  const [waiter] = link.waiters;
  const count = received.length;
  stream[id] += " and more";
  backend.changed();
  await sleep(300);
  assert.ok(link.waiters.has(waiter), "text alone woke the phone");
  assert.equal(received.length, count);
  backend.state.intents[id] = "Reading";
  backend.changed();
  await until(() => received.length > count);
  const news = received.at(-1)!;
  assert.equal(news.live.streams[id], true, "booleans only");
  assert.ok(!Object.keys(news).some((name) => name.startsWith("text:")), "no text");
  assert.equal(held(), undefined);

  delete stream[id];
  chat.messages.push({ role: "assistant", text: "first and more" });
  backend.changed();
  await until(() => useApp.getState().chats[id]?.messages.at(-1)?.text === "first and more");

  stream[id] = "next";
  backend.changed();
  await until(() => useApp.getState().parts.live?.streams[id] === true);
  text = true;
  client.liveTextChanged();
  await until(() => held()?.stream === "next");
});

test("a team member who asks for appends gets indicators and text for their own chats only", async (t) => {
  const { backend, link, phone } = await setup(t);
  const owner = await phone();
  const guest = structuredClone(link.store.data.team.roles.find((role: { id: string }) => role.id === "r_guest"));
  guest.bots = "all";
  await owner.call("link.team.saveRole", guest);
  const invite = await owner.call<{ code: string }>("link.team.createInvite", { groupId: "g_everyone", days: 1, maxUses: 1 });
  const target = { hosts: ["127.0.0.1:" + link.port], code: invite.code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name };
  const started = await startJoin(fetch, target, { name: "Sam's phone", platform: "ios", kind: "phone" });
  if (started.result.status !== "pending") throw new Error("the join did not wait for approval");
  await owner.call("link.team.approve", started.result.requestId);
  const checked = await checkJoin(fetch, started.attempt);
  if (checked.status !== "approved") throw new Error("the join was not approved");

  const parts: Record<string, any> = {};
  const sent: string[] = [];
  const member = new LinkClient(checked.pairing, {
    fetch,
    streamAppends: true,
    onParts(news) {
      sent.push(JSON.stringify(news));
      Object.assign(parts, news);
    },
    onState() {},
  });
  t.after(() => {
    member.stop();
    owner.stop();
  });
  member.start();
  await until(() => Array.isArray(parts.chats));
  const own = await member.call<string>("createChat", "bot-mira");
  const state = backend.state;
  const other = state.chats.find((chat: { id: string; botIds?: string[] }) => chat.id !== own && !chat.botIds).id;
  // The member asks to watch a chat that is not theirs as well.
  member.watch([own, other]);
  await until(() => parts["chat:" + own]?.id === own);
  state.streams[own] = "mine";
  state.streams[other] = "the owner's secret reply";
  state.thinking[other] = "the owner's secret thought";
  state.intents[other] = "Reading the owner's secret file";
  state.requests = [{ id: "ask", botId: "bot-mira", chatId: other, kind: "question", title: "the owner's secret question" }];
  backend.changed();
  await until(() => parts["text:" + own]?.stream === "mine");
  state.streams[own] += " and more";
  state.streams[other] += ", still secret";
  backend.changed();
  await until(() => parts["text:" + own]?.stream === "mine and more");

  assert.deepEqual(parts.live.streams, { [own]: true }, "indicators only for the member's own chat");
  assert.deepEqual(parts.live.thinking, {});
  assert.deepEqual(parts.live.intents, {});
  assert.deepEqual(parts.live.requests, []);
  assert.ok(!parts["text:" + other], "no text for a chat that is not theirs");
  assert.ok(!parts["chat:" + other], "no messages for a chat that is not theirs");
  assert.ok(!("quietLive" in parts), "the computer's own indicators are never sent by that name");
  assert.ok(!sent.some((batch) => batch.includes("secret")), "nothing of the other chat was ever sent");
});
