// What keeps the app smooth while bots work, and what once left it waiting: how often an idle phone
// is woken by other bots' steps, that a wake's quick check survives a change of watched chats, and
// that coming straight back to a chat does not load it again.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, type LinkOptions, pair } from "../src/link/client";
import { createFollowing } from "../src/state/following";
import { applyParts, forgetComputer, useApp } from "../src/state/store";

async function until(check: () => boolean, ms = 4000, what = "the link") {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, "timed out waiting for " + what);
    await sleep(5);
  }
}

async function setup(t: TestContext) {
  forgetComputer();
  useApp.setState({ parts: {}, texts: {}, chats: {}, running: {}, synced: false });
  const backend = new MockBackend();
  const dir = mkdtempSync(join(tmpdir(), "botkins-smooth-"));
  const link = new LinkHost({ backend, relay: false, port: 0, dir });
  await link.setEnabled(true);
  const clients: LinkClient[] = [];
  t.after(async () => {
    for (const client of clients) client.stop();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  // Every sync the phone makes, and a switch that makes the path go dead: a request then never
  // answers, as on a network the phone has left.
  const wire = { syncs: 0, dead: false };
  const counted: FetchLike = (url, init) => {
    if (!url.endsWith("/rpc")) return fetch(url, init);
    wire.syncs++;
    if (!wire.dead) return fetch(url, init);
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  async function phone(more: Partial<LinkOptions> = {}) {
    const paired = await pair(fetch, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "phone", platform: "ios" });
    let state = "connecting";
    const client = new LinkClient(paired, {
      fetch: counted, streamAppends: true, separateThinking: true, lightSteps: true, runStepDeltas: true, runSummaryDeltas: true,
      onParts: applyParts, onState: (next) => { state = next; }, ...more,
    });
    clients.push(client);
    return { client, state: () => state };
  }
  /** Bots at work in chats nobody has open: each call is one more tool step for every one of them. */
  function work(count: number) {
    const chats = backend.state.chats.filter((chat) => !chat.botIds).slice(0, count);
    const runs = chats.map((chat, index) => ({ id: "work-" + index, chatId: chat.id, title: "Work " + index, status: "Working", time: Date.now(), steps: [] as Record<string, unknown>[] }));
    backend.state.runs.unshift(...runs);
    for (const chat of chats) backend.state.streams[chat.id] = "";
    backend.changed();
    const step = () => {
      for (const run of runs) {
        const last = run.steps.at(-1);
        if (last) Object.assign(last, { status: "Done", finished: run.steps.length });
        run.steps.push({ id: run.id + "-s" + run.steps.length, name: "shell", label: "Step " + run.steps.length, status: "Running", started: run.steps.length, input: "{}" });
      }
      backend.changed();
    };
    return { chats, runs, step };
  }
  const steps = (runId: string) => useApp.getState().parts.runs?.find((run) => run.id === runId)?.stepCount ?? 0;
  return { backend, link, phone, wire, work, steps };
}

test("bots working in chats nobody has open wake an idle phone about once a second, not with every step", async (t) => {
  const { phone, wire, work, steps } = await setup(t);
  const { client } = await phone();
  client.start();
  await until(() => useApp.getState().synced);
  const { runs, step } = work(3);
  await until(() => !!useApp.getState().parts.runs?.some((run) => run.id === "work-0"));
  await sleep(300);
  let updates = 0;
  const stop = useApp.subscribe(() => void updates++);
  const before = wire.syncs;
  const began = Date.now();
  // Three bots, a step each every 60 ms: before the pace, every step was one sync and one store update.
  for (let n = 0; n < 40; n++) {
    step();
    await sleep(60);
  }
  const seconds = (Date.now() - began) / 1000;
  const syncs = wire.syncs - before;
  stop();
  const most = Math.ceil(seconds) + 3;
  assert.ok(syncs <= most, `${syncs} syncs in ${seconds.toFixed(1)} s; at most ${most} expected`);
  assert.ok(updates <= most, `${updates} store updates in ${seconds.toFixed(1)} s; at most ${most} expected`);
  // Nothing is lost: the last step still arrives.
  await until(() => steps(runs[0]!.id) === 40, 4000, "the last step's summary");
});

test("the wait after a summary-only answer ends with a call, a wake, and a change of the watched chats", async (t) => {
  const { phone, work, steps } = await setup(t);
  const { client } = await phone({ summaryPaceMs: 60_000 });
  client.start();
  await until(() => useApp.getState().synced);
  const { chats, runs, step } = work(1);
  const id = runs[0]!.id;
  // The run's start is more than a summary (the bot's indicator changes too): let it arrive first.
  await until(() => !!useApp.getState().parts.runs?.some((run) => run.id === id) && chats[0]!.id in (useApp.getState().parts.live?.streams ?? {}));
  await sleep(200);
  // The first step's answer holds only summaries, so every answer from here on is followed by the wait.
  step();
  await until(() => steps(id) === 1, 4000, "the first step's summary");
  const held = async (count: number) => {
    step();
    await sleep(400);
    assert.equal(steps(id), count, "the next summary waits for the pace");
  };
  await held(1);
  await client.call("models");
  await until(() => steps(id) === 2, 4000, "the summary after a call");
  await held(2);
  client.wake();
  await until(() => steps(id) === 3, 4000, "the summary after a wake");
  await held(3);
  client.watch([chats[0]!.id]);
  await until(() => steps(id) === 4, 4000, "the summary after the watched chats changed");
});

test("a watched chat under way is never slowed by another bot's summaries", async (t) => {
  const { backend, phone, work, steps } = await setup(t);
  const { client } = await phone({ summaryPaceMs: 60_000 });
  const { chats, runs, step } = work(2);
  const [mine, other] = [chats[0]!.id, runs[1]!.id];
  client.watch([mine]);
  client.start();
  await until(() => useApp.getState().running[mine]?.status === "Working");
  // The other bot's steps keep changing the summaries while this chat's reply is written.
  for (let n = 1; n <= 3; n++) {
    step();
    backend.state.streams[mine] += "word ";
    backend.changed();
    await until(() => steps(other) === n && useApp.getState().texts[mine]?.stream === "word ".repeat(n), 4000, "step " + n + " and the reply's text");
  }
});

test("a wake's quick check is kept when the watched chats change before it is answered", async (t) => {
  const { backend, phone, wire } = await setup(t);
  const id = backend.state.chats.find((chat) => !chat.botIds)!.id;
  const { client, state } = await phone({ wakeMs: 200 });
  client.watch([id]);
  client.start();
  await until(() => state() === "online" && !!useApp.getState().chats[id]);
  // The app goes away: the chat's screen stops watching and the link rests.
  client.watch([]);
  client.rest();
  // Meanwhile the phone left the network. Back in front, the link wakes and the chat watches again.
  wire.dead = true;
  client.wake();
  await sleep(20);
  client.watch([id]);
  // The quick check must still run: a dead path is given up in `wakeMs`, not after a 40 s wait.
  await until(() => state() !== "online", 3000, "the dead path to be given up");
  wire.dead = false;
  await until(() => state() === "online", 8000, "the link to come back");
});

test("a chat covered and shown again is sent once, not again with every return", async (t) => {
  const { backend, phone, wire } = await setup(t);
  const id = backend.state.chats.find((chat) => !chat.botIds)!.id;
  let pages = 0;
  const { client } = await phone({
    onParts: (parts) => {
      if (parts["chat:" + id]) pages++;
      applyParts(parts);
    },
  });
  const follow = createFollowing({ send: (ids) => client.watch(ids), away: () => false });
  let stop = follow.watch(id);
  client.start();
  await until(() => !!useApp.getState().chats[id]);
  const held = useApp.getState().chats[id];
  const before = wire.syncs;
  // A page goes over the chat and comes back, five times: each was a new sync and the whole chat again.
  for (let n = 0; n < 5; n++) {
    stop();
    await sleep(40);
    stop = follow.watch(id);
    await sleep(40);
  }
  await sleep(200);
  assert.equal(pages, 1, "the chat's page came once");
  assert.equal(wire.syncs, before, "and no sync was cut short to ask again");
  assert.strictEqual(useApp.getState().chats[id], held, "so the chat on screen is the same object: no row is drawn again");
});
