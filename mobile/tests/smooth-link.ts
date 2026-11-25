// Run the real phone, host, encrypted RPCs and store with a clock the test advances one pump at a time.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { countPhoneTimers } from "./phone-timers";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, type LinkOptions, LinkClient, pair } from "../src/link/client";
import { makeRelayHost } from "../src/link/relay";
import { createPartsBatcher } from "../src/state/partsBatch";
import { applyParts, forgetComputer, useApp } from "../src/state/store";

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function setup(t: TestContext, relay = false, options: Partial<LinkOptions> = {}) {
  forgetComputer();
  useApp.setState({ parts: {}, texts: {}, chats: {}, running: {}, synced: false });
  const backend = new MockBackend();
  const dir = mkdtempSync(join(tmpdir(), "botkins-smooth-"));
  const link = new LinkHost({ backend, relay: false, port: 0, dir });
  await link.setEnabled(true);
  const host = "127.0.0.1:" + link.port;
  const paired = await pair(fetch, { hosts: [host], code: link.startPairing().code }, { name: "phone", platform: "ios" });
  if (relay) paired.hosts = [makeRelayHost("a".repeat(43), "localhost")];

  const wire = { dead: false, attempts: 0, syncs: 0, pushes: 0, pages: 0, sentBytes: 0, receivedBytes: 0 };
  const additions: { from: number; add: string }[] = [];
  const news = link.news.bind(link);
  link.news = (...args) => {
    const result = news(...args);
    if (result?.text) {
      const parts = JSON.parse(result.text).parts;
      for (const [key, delta] of Object.entries(parts)) {
        if (key.startsWith("text:") && delta?.stream?.add) additions.push(delta.stream);
      }
    }
    return result;
  };
  const sync = link.sync.bind(link);
  link.sync = (...args) => {
    wire.syncs++;
    return sync(...args);
  };
  // Pass sealed bytes straight to the host's transport entry point. Only the network is a stand-in.
  const transport: FetchLike = async (url, init) => {
    if (wire.dead) {
      wire.attempts++;
      return new Promise(() => {}); // A suspended transport can ignore even an abort.
    }
    const signal = init?.signal;
    const gone = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    const onPart = init?.onPart;
    const body = Buffer.from(init?.body ?? "");
    wire.sentBytes += body.length;
    const answer = await link.serve({
      route: url.slice(url.lastIndexOf("/") + 1), session: init?.headers?.["x-botkins-session"],
      body, from: host, gone, via: relay ? "relay" : "http",
      ...(onPart && { push: { closed: signal, ready: () => true, send: (part: Uint8Array) => { wire.pushes++; wire.receivedBytes += part.length; onPart(part); } } }),
    });
    wire.receivedBytes += answer.body.length;
    return new Response(new Uint8Array(answer.body), { status: answer.status });
  };
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  const timers = countPhoneTimers(t);
  const batch = createPartsBatcher(applyParts);
  const states: string[] = [];
  const client = new LinkClient(paired, {
    fetch: Object.assign(transport, { supportsPush: relay }), probeMs: 60_000,
    streamAppends: true, separateThinking: true, lightSteps: true, runStepDeltas: true, runSummaryDeltas: true,
    onState: (state) => states.push(state),
    onParts(parts) {
      wire.pages += Object.keys(parts).filter((key) => key.startsWith("chat:") && parts[key]).length;
      batch.push(parts);
    },
    ...options,
  });
  await client.call("models");
  t.after(async () => {
    client.stop();
    batch.clear();
    await settle();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  // Each bot gains one tool step per work update. The person's own chat is the fourth chat.
  const chats = backend.state.chats.filter((chat) => !chat.botIds).slice(0, 4);
  const runs = chats.slice(0, 3).map((chat, i) => ({
    id: "work-" + i, chatId: chat.id, title: "Work " + i, status: "Working", time: Date.now(),
    steps: [] as Record<string, unknown>[],
  }));
  backend.state.runs.unshift(...runs);
  for (const run of runs) backend.state.streams[run.chatId] = "";
  backend.changed();
  const step = () => {
    for (const run of runs) {
      const last = run.steps.at(-1);
      if (last) Object.assign(last, { status: "Done", finished: Date.now() });
      run.steps.push({ id: "s" + run.steps.length, name: "shell", label: "Step " + run.steps.length, status: "Running", started: Date.now() });
    }
    backend.changed();
  };
  const start = async () => {
    client.start();
    await settle();
    assert.equal(client.state, "online");
  };
  return { backend, link, wire, timers, states, additions, client, start, advance, step, runs, mine: chats[3] };
}
