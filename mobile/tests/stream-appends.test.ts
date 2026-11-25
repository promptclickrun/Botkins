import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { reasoningPreview } from "../link-host/reasoning-preview.mjs";
import { compactWorkingRun, reasoningDelta } from "../link-host/parts.mjs";
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

async function setup(t: TestContext, appends = true, chunkTiming?: { every?: number; live?: number; holdMax?: number }) {
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
  const link = new LinkHost({ backend, relay: false, port: 0, dir, chunkTiming });
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

test("a folded chat keeps reply deltas while its hidden reasoning rolls, and can reopen current detail", async (t) => {
  const { backend, link, phone } = await setup(t);
  const id = backend.state.chats[0].id;
  const latest: Record<string, any> = {};
  const events: Record<string, unknown>[] = [];
  const client = await phone(true, (news) => { Object.assign(latest, news); events.push(news); }, { separateThinking: true, lightSteps: true });
  const thought = { id: "t", started: 1, text: "r".repeat(4800) };
  const textKey = "text:" + id, detailKey = "reasoning:" + id;
  backend.state.streams[id] = "first";
  backend.state.thinking[id] = thought.text.slice(-4000);
  backend.state.runs = [{ id: "run-demand", chatId: id, status: "Working", reasoning: [thought] }];
  backend.changed();
  client.watch([id]);
  client.start();
  await until(() => latest[textKey]?.stream === "first");
  assert.ok(latest["run:" + id].hasReasoning);
  assert.equal(latest[textKey].thinking, "");
  assert.equal(latest[detailKey], undefined);
  const received = events.length;
  thought.text += " more";
  backend.state.thinking[id] = thought.text.slice(-4000);
  backend.changed();
  await sleep(300);
  assert.ok(events.slice(received).every((event) => !(detailKey in event || textKey in event)), "a hidden thought alone did not publish text");
  assert.ok(!link.reasoningParts.has(id));
  backend.state.streams[id] += " reply";
  backend.changed();
  await until(() => latest[textKey]?.stream === "first reply");

  client.watchReasoning([id]);
  await until(() => latest[detailKey]?.items?.[0]?.text === thought.text);
  assert.equal(latest[textKey].thinking, thought.text.slice(-4000));
  client.watchReasoning([]);
  await until(() => latest[detailKey] === null && latest[textKey]?.thinking === "");
  thought.text += " while closed";
  backend.state.thinking[id] = thought.text.slice(-4000);
  backend.changed();
  client.watchReasoning([id]);
  await until(() => latest[detailKey]?.items?.[0]?.text === thought.text);
  assert.equal(latest[textKey].stream, "first reply");
});

test("bounded thinking previews preserve separators and skip unrelated speakers", () => {
  for (const lastLength of [0, 1, 3998, 3999, 4000, 4001]) {
    const items = [{ text: "old".repeat(2000), botId: "one" }, { text: "other", botId: "two" },
      { text: "", botId: "one" }, { text: "z".repeat(lastLength), botId: "one" }];
    for (const speaker of [undefined, "one", "two", "missing"]) {
      const reference = items.filter(({ text, botId }) => text && (!speaker || botId === speaker)).map(({ text }) => text).join("\n\n").slice(-4000);
      assert.equal(reasoningPreview(items, speaker), reference);
    }
  }
});

test("negotiated reasoning appends do not replay a working run", async (t) => {
  const { backend, link, phone } = await setup(t);
  const client = await phone(true, undefined, { lightSteps: true });
  const chat = backend.state.chats.find((c) => !c.botIds)!;
  const id = chat.id;
  backend.state.streams[id] = "reply";
  backend.state.thinking[id] = "thinking";
  backend.state.runs = [{ id: "run-reasoning", chatId: id, status: "Working", steps: [{ id: "tool", name: "bash", input: "x".repeat(900), status: "Running", started: 1 }], reasoning: [{ id: "thought", text: "first", started: 1 }] }];
  backend.changed();
  const first = await client.call<any>("link.sync", {
    epoch: link.epoch,
    watch: [id],
    reasoningWatch: [id],
    appends: { [id]: { id: "initial", stream: 0, thinking: 0 } },
    steps: "light",
    wait: 0,
  });
  assert.ok(first.parts.meta.capabilities.includes("reasoning-appends-v1"));
  const text = first.parts["text:" + id];
  backend.state.thinking[id] += " next";
  backend.state.runs[0].reasoning[0].text += " next";
  backend.changed();
  const next = await client.call<any>("link.sync", {
    epoch: link.epoch,
    have: first.v,
    watch: [id],
    reasoningWatch: [id],
    appends: { [id]: { id: text.id, stream: text.stream.add.length, thinking: text.thinking.add.length } },
    steps: "light",
    wait: 0,
  });
  assert.equal(next.parts["run:" + id], undefined, "reasoning-only changes do not resend the whole run");
  assert.deepEqual(next.parts["reasoning:" + id].items, [{ id: "thought", started: 1, from: 5, add: " next" }]);
  let latest = next;
  let thinkingOffset = text.thinking.add.length + 5;
  let reasoningOffset = 10;
  let bytes = JSON.stringify(next.parts).length;
  for (let update = 2; update <= 100; update++) {
    backend.state.thinking[id] += " x";
    backend.state.runs[0].reasoning[0].text += " x";
    backend.changed();
    const news = await client.call<any>("link.sync", {
      epoch: link.epoch,
      have: latest.v,
      watch: [id],
      reasoningWatch: [id],
      appends: { [id]: { id: text.id, stream: text.stream.add.length, thinking: thinkingOffset } },
      steps: "light",
      wait: 0,
    });
    assert.equal(news.parts["run:" + id], undefined);
    bytes += JSON.stringify(news.parts).length;
    latest = news;
    thinkingOffset += 2;
    reasoningOffset += 2;
  }
  assert.ok(bytes < 100 * 500, "100 reasoning updates stay bounded to deltas");
  backend.state.runs[0].steps[0].input += " changed";
  backend.changed();
  const afterToolBody = await client.call<any>("link.sync", {
    epoch: link.epoch,
    have: latest.v,
    watch: [id],
    reasoningWatch: [id],
    appends: { [id]: { id: text.id, stream: text.stream.add.length, thinking: thinkingOffset } },
    steps: "light",
    wait: 0,
  });
  assert.equal(afterToolBody.parts["run:" + id], undefined, "long invisible tool-body changes stay compact");
});

test("whole mode negotiates compact light runs and explicit reasoning without reply bodies", async (t) => {
  const { backend, link, phone } = await setup(t);
  const client = await phone(true);
  const id = backend.state.chats.find((c) => !c.botIds)!.id;
  backend.state.runs = [{ id: "run-whole", chatId: id, status: "Working", steps: [{ id: "tool", name: "bash", input: "x".repeat(900), status: "Running", started: 1 }], reasoning: [{ id: "thought", text: "thinking", started: 1 }] }];
  backend.changed();
  const args = { epoch: link.epoch, watch: [id], text: false, steps: "light", reasoningWatch: [], wait: 0 };
  const compact = await client.call<any>("link.sync", args);
  assert.equal(compact.parts["run:" + id].reasoning, undefined);
  assert.equal(compact.parts["run:" + id].steps[0].more, true);
  assert.equal(compact.parts["reasoning:" + id], undefined);

  const detailed = await client.call<any>("link.sync", { ...args, have: compact.v, reasoningWatch: [id] });
  assert.deepEqual(detailed.parts["reasoning:" + id].items.map((item: any) => item.add), ["thinking"]);
  assert.equal(detailed.parts["run:" + id], undefined);

  const full = await client.call<any>("link.sync", { epoch: link.epoch, have: detailed.v, watch: [id], text: false, wait: 0, reasoningWatch: [] });
  assert.equal(full.parts["run:" + id].steps[0].input.length, 900);
  assert.equal(full.parts["run:" + id].reasoning, undefined);
});

test("a lost reasoning clear is replayed until acknowledged, then the phone stays quiet", async (t) => {
  const { backend, link, phone } = await setup(t);
  const client = await phone(true);
  const id = backend.state.chats[0].id;
  const key = "reasoning:" + id;
  backend.state.runs = [{ id: "clearing", chatId: id, status: "Working", reasoning: [{ id: "thought", started: 1, text: "One" }] }];
  backend.changed();
  const read = (have: Record<string, number>) => client.call<any>("link.sync", { epoch: link.epoch, have, watch: [id], appends: {}, reasoningWatch: [id], wait: 0 });
  const first = await read({});
  assert.equal(first.parts[key].items[0].add, "One");
  backend.state.runs[0].reasoning = undefined;
  backend.changed();
  assert.equal((await read(first.v)).parts[key], null);
  const retry = await read(first.v);
  assert.equal(retry.parts[key], null);
  assert.deepEqual((await read(retry.v)).parts, {});
});

test("reasoning revisions reset equal-length replacements and remove missing items", () => {
  const previous = { run: "run", items: [{ id: "a", text: "old!", started: 1 }, { id: "empty", text: "", started: 2 }, { id: "gone", text: "bye", started: 3 }] };
  const current = { run: "run", items: [{ id: "a", text: "new!", started: 1 }, { id: "empty", text: "", started: 2 }] };
  const replaced = reasoningDelta(current, previous)!;
  assert.equal(replaced.reset, undefined);
  assert.equal(replaced.items.find((item: any) => item.id === "a").from, 0);
  assert.deepEqual(replaced.remove, ["gone"]);
  assert.deepEqual(reasoningDelta(current, previous), replaced);
  assert.equal(reasoningDelta(current, current), undefined);
  const compact = compactWorkingRun({ status: "Working", reasoning: [{ id: "a", text: "hidden", started: 1 }], steps: [{ id: "long", name: "bash", input: "x".repeat(401), output: "y".repeat(401) }, { id: "short", name: "bash", input: "ok" }, { id: "ask", name: "ask_user", input: "?" }] });
  assert.equal(compact.reasoning, undefined);
  assert.equal(compact.steps[0].more, true);
  assert.equal(compact.steps[1].input, "ok");
  assert.equal(compact.steps[2].input, "?");
});

test("a long reasoning turn bounds its cursor without replaying the acknowledged prefix", () => {
  const items = Array.from({ length: 129 }, (_, index) => ({ id: "t" + index, text: "x", started: index }));
  const previous = { run: "run", items };
  assert.equal(reasoningDelta(previous, previous), undefined);
  const current = [{ id: "t0", text: "z", started: 0 }, ...items.slice(1), { id: "t129", text: "y", started: 129 }];
  const next = reasoningDelta({ run: "run", items: current }, previous)!;
  assert.deepEqual(next.items.map((item: any) => item.id), ["t0", "t129"]);
  assert.equal(next.items[0].from, 0);
  assert.equal(next.items[1].from, 0);
});

test("a completion snapshot wins over a trailing reasoning clear", () => {
  const completed = { id: "done", chatId: "c-done", status: "Completed", reasoning: [{ id: "thought", text: "authoritative", started: 1, finished: 2 }] };
  applyParts({ "run:c-done": completed });
  applyParts({ "reasoning:c-done": null });
  assert.deepEqual(useApp.getState().running["c-done"]?.reasoning, completed.reasoning);
});

test("a complete snapshot from an older host can remove reasoning during the same run", () => {
  const run = { id: "older", chatId: "older-chat", status: "Working" };
  applyParts({ "run:older-chat": { ...run, reasoning: [{ id: "one", started: 1, text: "Before" }] } });
  applyParts({ "run:older-chat": run });
  assert.equal(useApp.getState().running["older-chat"]?.reasoning, undefined);
});

test("a rolling thinking preview never replays an unchanged reply and follows the current group speaker", async (t) => {
  const { backend, link, phone } = await setup(t);
  const chat = backend.state.chats[0];
  const id = chat.id;
  const first = { id: "one", started: 1, text: "Old thought", botId: "first" };
  const last = { id: "two", started: 2, text: "123456789.".repeat(399), botId: "second" };
  const run = { id: "rolling", chatId: id, status: "Working", reasoning: [first, last] };
  const reply = "The reply so far. ".repeat(300);
  backend.state.runs = [run];
  backend.state.speakers[id] = last.botId;
  backend.state.streams[id] = reply;
  backend.state.thinking[id] = last.text;
  backend.changed();
  const textParts: { stream: { add: string }; thinking: { add: string } }[] = [];
  const news = link.news.bind(link);
  link.news = (...args) => {
    const result = news(...args);
    const text = result?.text && JSON.parse(result.text).parts["text:" + id];
    if (text) textParts.push(text);
    return result;
  };
  let visible: { stream: string; thinking: string } | undefined;
  const client = await phone(true, (parts) => {
    if ("text:" + id in parts) visible = parts["text:" + id] as typeof visible;
  }, { lightSteps: true });
  client.watch([id]);
  client.start();
  await until(() => visible?.stream === reply && visible?.thinking === last.text);
  textParts.length = 0;
  for (const suffix of [" first extension.", " another extension."]) {
    last.text += suffix;
    backend.state.thinking[id] = last.text.slice(-4000);
    backend.changed();
    await until(() => visible?.thinking === backend.state.thinking[id]);
  }
  assert.equal(textParts.map((part) => part.stream.add).join(""), "", "sliding the preview never retransmits the reply");
  assert.equal(textParts.map((part) => part.thinking.add).join(""), "", "the card and chat reuse the reasoning that arrived");
  assert.equal(visible?.stream, reply);
  backend.state.thinking[id] = "A provider-specific preview";
  backend.changed();
  await until(() => visible?.thinking === "A provider-specific preview");
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

test("with text streaming off a phone gets indicators only, is not woken by text, and the reply whole", async (t) => {
  const { backend, link, phone } = await setup(t);
  const received: Record<string, any>[] = [];
  let text = true;
  const syncs: Record<string, unknown>[] = [];
  const client = await phone(true, (news) => {
    received.push(news);
    applyParts(news);
  }, { textStreaming: () => text });
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
  assert.ok(!("text" in syncs.at(-1)!), "text streaming on: the field is left out");

  text = false;
  client.textStreamingChanged();
  await until(() => !held());
  assert.equal(syncs.at(-1)!.text, false);
  assert.ok(useApp.getState().parts.meta!.capabilities.includes("text-streaming-off-v1"));
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
  client.textStreamingChanged();
  await until(() => held()?.stream === "next");
});

test("the first words of a reply go at once, and the next chunk waits for the live clock", async (t) => {
  // A slow clock, so a first chunk that waited for it could not be mistaken for one that did not.
  const { backend, link, phone } = await setup(t, true, { every: 1500, live: 1500, holdMax: 6000 });
  const client = await phone(true, applyParts, { textStreaming: () => "chunks" });
  const chat = backend.state.chats.find((c) => !c.botIds);
  const id = chat.id;
  const stream = backend.state.streams;
  const held = () => useApp.getState().texts[id]?.stream;
  client.watch([id]);
  client.start();
  await until(() => link.waiters.size === 1);
  // The stream starts: indicators go at once (not text news), which starts the clock.
  stream[id] = "Hel";
  backend.changed();
  await until(() => useApp.getState().parts.live?.streams[id] === true);
  const session = [...link.sessions.values()][0];
  await sleep(80);
  assert.equal(held() ?? "", "", "half a word is not sent");
  const since = Date.now();
  assert.ok(since - session.lastNews < 400, "the clock was started by the indicators");
  stream[id] = "Hello wor";
  backend.changed();
  await until(() => held() === "Hello ");
  assert.ok(Date.now() - since < 400, "the first words waited for the clock");
  // Not the first words any more: this one waits for the 1.5 s clock.
  await until(() => link.waiters.size === 1);
  stream[id] = "Hello world is big and wide ";
  backend.changed();
  await sleep(700);
  assert.equal(held(), "Hello ", "the second chunk came before the live clock");
  await until(() => held() === "Hello world is big and wide ");
  assert.ok(Date.now() - since >= 1300, "the second chunk came before the live clock");
  // A new reply (a new text) is first words again.
  delete stream[id];
  chat.messages.push({ role: "assistant", text: "Hello world is big and wide " });
  backend.changed();
  await until(() => link.waiters.size === 1);
  stream[id] = "Again ";
  backend.changed();
  const again = Date.now();
  await until(() => held() === "Again ");
  assert.ok(Date.now() - again < 400, "the first words of the next reply waited for the clock");
});

test("reply text in chunks comes every live clock after a whole word, thinking at sentence ends, and no-space text is held", async (t) => {
  const { backend, link, phone } = await setup(t, true, { every: 700, live: 250, holdMax: 800 });
  const received: { at: number; news: Record<string, any> }[] = [];
  const syncs: Record<string, unknown>[] = [];
  const client = await phone(true, (news) => {
    received.push({ at: Date.now(), news });
    applyParts(news);
  }, { textStreaming: () => "chunks" });
  const sync = link.sync.bind(link);
  link.sync = (session, args, gone) => {
    syncs.push(args);
    return sync(session, args, gone);
  };
  const chat = backend.state.chats.find((c) => !c.botIds);
  const id = chat.id;
  const stream = backend.state.streams;
  const held = () => useApp.getState().texts[id]?.stream;
  stream[id] = "One ";
  backend.changed();
  client.watch([id]);
  client.start();
  await until(() => held() === "One ");
  assert.equal(syncs.at(-1)!.text, "chunks");
  assert.ok(useApp.getState().parts.meta!.capabilities.includes("text-chunks-v1"));
  // Typed a few characters at a time, words and sentences, a line, an emoji, and Han text with no spaces.
  const typed = "Two words here. Three more\n- a list item 😀 here\nand then 你好世界。再见 ";
  for (let at = 0; at < typed.length; at += 3) {
    stream[id] += typed.slice(at, at + 3);
    backend.changed();
    await sleep(20);
  }
  await until(() => held() === stream[id]);
  const texts = received.filter((r) => r.news["text:" + id]);
  assert.ok(texts.length >= 3, "the text came in several chunks");
  for (const r of texts) {
    // Everything the phone holds ends after a whole word: a space or a line end, or a Han character.
    assert.match(r.news["text:" + id].stream, /(\s|[\u3400-\u9fff\u3000-\u303f])$/, "ended inside a word: " + JSON.stringify(r.news["text:" + id].stream));
    assert.doesNotMatch(r.news["text:" + id].stream, /[\ud800-\udbff]$/, "split an emoji");
  }
  for (let i = 1; i < texts.length; i++) assert.ok(texts[i].at - texts[i - 1].at >= 230, "two chunks closer than the live clock");
  // Faster than the slow clock, and not waiting for a sentence's end: that is what makes it feel written.
  assert.ok(texts.some((r, i) => i > 0 && r.at - texts[i - 1].at < 600), "no chunk came sooner than the slow clock");
  assert.ok(texts.some((r) => !/([.!?\u3002]\s*|\n)$/.test(r.news["text:" + id].stream)), "every chunk waited for a sentence's end");
  assert.ok(texts.length <= 1 + Math.ceil((typed.length / 3 * 20 + 400) / 230), "far more chunks than the clock allows");
  // The last word has no space after it: held, then sent after the hold.
  const before = Date.now();
  stream[id] += "tail";
  backend.changed();
  await sleep(300);
  assert.equal(held(), stream[id].slice(0, -4), "a word that may not be finished was sent");
  await until(() => held() === stream[id]);
  assert.ok(Date.now() - before >= 600, "the held word waited for the hold");
  // Thinking is not the reply: it waits for a sentence's end and for the slower clock.
  const base = Date.now();
  backend.state.thinking[id] = "Plan one. Plan tw";
  backend.changed();
  await until(() => useApp.getState().texts[id]?.thinking === "Plan one. ");
  backend.state.thinking[id] += "o is next. And more words";
  backend.changed();
  await sleep(300);
  assert.equal(useApp.getState().texts[id]?.thinking, "Plan one. ", "thinking came faster than the slow clock");
  await until(() => useApp.getState().texts[id]?.thinking === "Plan one. Plan two is next. ");
  assert.ok(Date.now() - base >= 600, "thinking came before the slow clock");
  delete stream[id];
  delete backend.state.thinking[id];
  chat.messages.push({ role: "assistant", text: "One " + typed + "tail" });
  backend.changed();
  await until(() => useApp.getState().chats[id]?.messages.at(-1)?.text?.endsWith("tail") === true);
});

test("a phone asks for chunks only from a computer that sends them, and whole text otherwise", async (t) => {
  const { backend, link, phone } = await setup(t);
  const meta = link.meta.bind(link);
  link.meta = () => ({ ...meta(), capabilities: meta().capabilities.filter((c: string) => c !== "text-chunks-v1") });
  const syncs: Record<string, unknown>[] = [];
  const sync = link.sync.bind(link);
  link.sync = (session, args, gone) => {
    syncs.push(args);
    return sync(session, args, gone);
  };
  const client = await phone(true, applyParts, { textStreaming: () => "chunks" });
  const id = backend.state.chats[0].id;
  client.watch([id]);
  client.start();
  await until(() => !!useApp.getState().parts.meta && syncs.length >= 2);
  assert.equal(syncs.at(-1)!.text, false);
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

test("the phone applies step patches in order, keeps earlier rows and recovers a missing base", async (t) => {
  const { backend, link, phone } = await setup(t);
  const id = backend.state.chats.find((chat) => !chat.botIds).id;
  const key = "run:" + id;
  const raw: any[] = [];
  const rawSummaries: any[] = [];
  let corrupt = false;
  let corruptSummary = false;
  const news = link.news.bind(link);
  link.news = (...args) => {
    const result = news(...args);
    if (typeof result?.text !== "string") return result;
    const message = JSON.parse(result.text);
    if (key in message.parts) raw.push(message.parts[key]);
    if ("runs" in message.parts) rawSummaries.push(message.parts.runs);
    if (corrupt && message.parts[key]?.patch === "steps") {
      corrupt = false;
      message.parts[key].base = -1;
      result.text = JSON.stringify(message);
    }
    if (corruptSummary && message.parts.runs?.patch === "summaries") {
      corruptSummary = false;
      message.parts.runs.base = -1;
      result.text = JSON.stringify(message);
    }
    return result;
  };
  const steps = Array.from({ length: 20 }, (_, index) => ({ id: "s" + index, name: "shell", label: "Read", status: "Done", started: index }));
  const run = { id: "step-test", chatId: id, title: "First", status: "Working", steps, reasoning: [{ id: "why", text: "thought", started: 10 }] };
  backend.state.runs = [run, ...Array.from({ length: 20 }, (_, index) => ({ id: "earlier-" + index, chatId: id, title: "Earlier run " + index, status: "Completed", time: index }))];
  backend.changed();
  const client = await phone(true, applyParts, { lightSteps: true, runStepDeltas: true, runSummaryDeltas: true });
  client.watch([id]);
  client.start();
  const current = () => useApp.getState().running[id];
  await until(() => current()?.id === run.id && current()?.steps?.length === 20);
  const stable = current()!.steps![0];
  const stableSummary = useApp.getState().parts.runs![1];
  assert.equal(raw[0].steps.length, 20);
  run.steps[19].label = "Updated";
  backend.changed();
  await until(() => current()?.steps?.[19]?.label === "Updated");
  assert.equal(raw.at(-1).patch, "steps");
  assert.strictEqual(current()!.steps![0], stable);
  assert.equal(current()!.reasoning![0]!.text, "thought");
  run.title = "Changed";
  run.steps.splice(4, 1);
  run.steps.reverse();
  backend.changed();
  await until(() => current()?.title === "Changed");
  assert.deepEqual(current()!.steps!.map(row => row.id), steps.map(row => row.id));
  assert.strictEqual(useApp.getState().parts.runs![1], stableSummary);
  assert.equal(useApp.getState().parts.runs![0]?.title, "Changed");
  backend.state.runs.splice(3, 1);
  backend.state.runs.unshift(backend.state.runs.pop());
  backend.changed();
  await until(() => useApp.getState().parts.runs?.[0]?.id === "earlier-19");
  assert.deepEqual(useApp.getState().parts.runs!.map(row => row.id), backend.state.runs.map(row => row.id));
  corruptSummary = true;
  backend.state.runs[0].title = "Changed historical run";
  backend.changed();
  await until(() => useApp.getState().parts.runs?.[0]?.title === "Changed historical run");
  assert.equal(corruptSummary, false);
  assert.ok(Array.isArray(rawSummaries.at(-1)), "the client recovered the run list from a fresh snapshot");
  corrupt = true;
  run.steps.push({ id: "last", name: "shell", label: "Last", status: "Running", started: 25 });
  backend.changed();
  await until(() => current()?.steps?.at(-1)?.id === "last");
  assert.equal(corrupt, false);
  assert.ok(Array.isArray(raw.at(-1).steps), "client retried without the corrupt patch's base");
  assert.equal(current()!.reasoning![0]!.text, "thought");
  run.status = "Completed";
  backend.changed();
  await until(() => current()?.status === "Completed" || !current());
  assert.ok(raw.at(-1)?.patch === undefined, "completion is a fresh authoritative snapshot");
});

test("a phone requesting step deltas consumes full runs from older hosts", async (t) => {
  const { backend, link, phone } = await setup(t);
  const meta = link.meta.bind(link);
  link.meta = () => { const value = meta(); return { ...value, capabilities: value.capabilities.filter(name => name !== "run-step-deltas-v1" && name !== "run-summary-deltas-v1") }; };
  const sync = link.sync.bind(link);
  const requests: any[] = [];
  link.sync = (session, args, ...rest) => {
    requests.push([args.runSteps, args.runSummaries]);
    const { runSteps, runSummaries, ...legacy } = args;
    return sync(session, legacy, ...rest);
  };
  const id = backend.state.chats[0].id;
  const run = { id: "old-host-run", chatId: id, status: "Working", steps: [{ id: "a", status: "Running" }] };
  backend.state.runs = [run];
  backend.changed();
  const client = await phone(true, applyParts, { lightSteps: true, runStepDeltas: true, runSummaryDeltas: true });
  client.watch([id]);
  client.start();
  await until(() => useApp.getState().running[id]?.id === run.id && requests.length > 1);
  assert.deepEqual(requests[0], ["delta", "delta"]);
  assert.deepEqual(requests[1], [undefined, undefined]);
  run.steps[0].status = "Done";
  backend.changed();
  await until(() => useApp.getState().running[id]?.steps?.[0]?.status === "Done");
});
