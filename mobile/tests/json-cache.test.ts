import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { interned, jsonFragments, jsonOf, sameFragments } from "../link-host/json-cache.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { chatPart, runPart } from "../link-host/parts.mjs";
import { LinkClient, pair } from "../src/link/client";

/** A small repeatable random source, so a failure can be run again. */
function random(seed: number) {
  let n = seed;
  return () => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return n / 2 ** 32;
  };
}

test("a record is copied again only when its values change, and a record with nested values never is", () => {
  let made = 0;
  const copy = (r: any) => (made++, { ...r });
  const step: any = { id: "a", status: "Running", output: "x", started: 1 };
  const one = interned(step, copy);
  assert.equal(interned(step, copy), one, "unchanged: the same copy");
  assert.equal(made, 1);
  step.output += "y";
  const two = interned(step, copy);
  assert.notEqual(two, one, "a changed value: a new copy");
  assert.equal(two.output, "xy");
  step.finished = 2;
  assert.equal(interned(step, copy).finished, 2, "a new key: a new copy");
  delete step.finished;
  assert.equal(interned(step, copy).finished, undefined, "a removed key: a new copy");
  const { id, ...rest } = step;
  const reordered = { ...rest, id };
  const first = interned(reordered, copy);
  assert.equal(interned(reordered, copy), first);
  // A nested value can change without the record's own values changing: never remembered.
  const nested: any = { id: "n", attachments: [{ name: "a" }] };
  const a = interned(nested, (r: any) => ({ ...r, attachments: structuredClone(r.attachments) }));
  nested.attachments[0].name = "b";
  const b = interned(nested, (r: any) => ({ ...r, attachments: structuredClone(r.attachments) }));
  assert.notEqual(a, b);
  assert.equal(b.attachments[0].name, "b");
  // A copy that is the record itself is not remembered either.
  const same: any = { id: "s" };
  assert.equal(interned(same, (r: any) => r), same);
});

test("jsonOf writes what JSON.stringify writes", () => {
  const odd: any = {
    a: undefined,
    b: () => 1,
    c: Symbol("s"),
    d: [undefined, () => 1, Symbol("x"), null, NaN, Infinity, -0, "é \n\"\\\u0001😀"],
    e: new Date(0),
    f: { toJSON: () => undefined },
    g: { toJSON: () => ({ h: 1 }) },
    h: new Map([[1, 2]]),
    i: Object.create(null),
    j: [{ k: [] }, {}],
    "k\n": true,
  };
  odd.i.z = 1;
  for (const value of [odd, [odd], "text", 3, null, true, [], {}, { a: [[[]]] }, { toJSON: () => "x" }]) assert.equal(jsonOf(value), JSON.stringify(value));
  assert.equal(jsonOf(undefined), undefined);
  assert.equal(jsonOf(() => 1), undefined);
  // The copies it keeps are written the same.
  const copy = interned({ id: "a", text: "é " }, (r: any) => ({ ...r }));
  assert.equal(jsonOf({ list: [copy, copy], one: copy }), JSON.stringify({ list: [copy, copy], one: copy }));
  assert.equal(jsonOf(copy), JSON.stringify(copy));
});

test("two writes of an unchanged part have the same fragments and need not be joined", () => {
  const steps = Array.from({ length: 50 }, (_, i) => ({ id: "s" + i, status: "Done", output: "o".repeat(1000) }));
  const write = () => jsonFragments({ id: "run", status: "Working", steps: steps.map((s) => interned(s, (r: any) => ({ ...r }))) });
  const a = write();
  const b = write();
  assert.ok(sameFragments(a, b));
  assert.equal(a.join(""), JSON.stringify({ id: "run", status: "Working", steps }));
  steps[10].status = "Failed";
  assert.ok(!sameFragments(a, write()));
  steps.push({ id: "new", status: "Running", output: "" });
  assert.ok(!sameFragments(b, write()));
});

test("pages and runs written through the cache are the bytes of a fresh write after any in-place change", () => {
  const next = random(7);
  const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
  const text = () => Array.from({ length: Math.floor(next() * 12) }, () => pick(["alpha", "beta", "é", "😀", '"q"', "line\n", "x".repeat(500)])).join(" ");
  const state: any = {
    chats: [{ id: "c", botId: "b", title: "t", time: 1, messages: [] }],
    runs: [],
  };
  const chat = state.chats[0];
  let n = 0;
  for (let round = 0; round < 250; round++) {
    const op = Math.floor(next() * 9);
    const runs = state.runs;
    if (op === 0 || chat.messages.length < 3) chat.messages.push({ role: pick(["user", "assistant"]), text: text(), time: ++n, ...(next() < 0.3 && { runId: pick(["r1", "r2", "r3"]) }), ...(next() < 0.2 && { attachments: [{ name: text(), path: "/x" }] }), ...(next() < 0.2 && { context: { big: text() } }) });
    else if (op === 1) pick(chat.messages as any[]).text = text();
    else if (op === 2) delete pick(chat.messages as any[]).runId;
    else if (op === 3 && runs.length < 3) runs.unshift({ id: "r" + (runs.length + 1), chatId: "c", status: pick(["Working", "Done"]), steps: [], reasoning: [{ id: "q", text: text(), started: 1 }] });
    else if (op === 4 && runs.length) pick(runs as any[]).steps.push({ id: "s" + ++n, name: "bash", label: text(), status: "Running", input: text() + "i".repeat(next() < 0.3 ? 5000 : 0), output: text() + "o".repeat(next() < 0.3 ? 5000 : 0), started: n, ...(next() < 0.3 && { botId: "b" }) });
    else if (op === 5 && runs.some((r: any) => r.steps.length)) {
      const run: any = pick(runs.filter((r: any) => r.steps.length) as any[]);
      const step: any = pick(run.steps);
      step.status = pick(["Running", "Done", "Failed"]);
      step.output = (step.output ?? "") + text();
      if (next() < 0.3) step.finished = n;
      if (next() < 0.1) delete step.input;
    } else if (op === 6 && runs.length) pick(runs as any[]).status = pick(["Working", "Done"]);
    else if (op === 7 && runs.length) pick(runs as any[]).teamwork = [{ id: "t", steps: [{ id: "ts" + ++n, status: "Done", output: text() }] }];
    else if (op === 8 && chat.messages.length) chat.messages.splice(Math.floor(next() * chat.messages.length), 1);
    // What a fresh write of the same state, with nothing remembered, is.
    const fresh = structuredClone(state);
    const page = chatPart(state, "c");
    const running = runPart(state, "c");
    assert.equal(jsonOf(page), JSON.stringify(chatPart(fresh, "c")), "page, round " + round);
    assert.equal(jsonOf(running), JSON.stringify(runPart(fresh, "c")), "run, round " + round);
    assert.equal(jsonOf(page), JSON.stringify(page));
  }
});

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
  const dir = mkdtempSync(join(tmpdir(), "botkins-json-cache-"));
  const link = new LinkHost({ backend, relay: false, port: 0, dir });
  await link.setEnabled(true);
  const clients: LinkClient[] = [];
  t.after(async () => {
    for (const client of clients) client.stop();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function phone() {
    const paired = await pair(fetch, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "phone", platform: "ios" });
    const client = new LinkClient(paired, { fetch, streamAppends: true, onParts() {}, onState() {}, lightSteps: true });
    clients.push(client);
    client.start();
    return client;
  }
  return { backend, link, phone };
}

/** A running turn of `n` steps with long output, in a chat of long messages: what a long coding chat looks like. */
function longTurn(backend: any, n = 300) {
  const chat = backend.state.chats.find((c: any) => !c.botIds);
  for (let i = 0; i < 60; i++) chat.messages.push({ role: i % 2 ? "assistant" : "user", text: "message " + i + " " + "m".repeat(500), time: i, ...(i % 2 && { runId: "done" + i }) });
  for (let i = 1; i < 60; i += 2) backend.state.runs.push({ id: "done" + i, chatId: chat.id, status: "Done", title: "t", time: "x", steps: Array.from({ length: 10 }, (_, k) => ({ id: "d" + i + "-" + k, name: "bash", label: "step", status: "Done", input: "i".repeat(600), output: "o".repeat(3000), started: 1, finished: 2 })) });
  const steps = Array.from({ length: n }, (_, k) => ({ id: "w" + k, name: "bash", label: "step " + k, status: "Done", input: "i".repeat(500), output: "o".repeat(2500), started: 1, finished: 2 }));
  backend.state.runs.unshift({ id: "live-run", chatId: chat.id, status: "Working", title: "live", time: "now", steps });
  backend.state.streams[chat.id] = "Hello ";
  return { chat, steps };
}

test("a reply growing does not write the run or the page again, and builds the app's state once", async (t) => {
  const { backend, link } = await setup(t);
  const { chat, steps } = longTurn(backend);
  const id = chat.id;
  link.refresh([id]);
  const run = link.parts.get("run:" + id);
  const page = link.parts.get("chat:" + id);
  assert.ok(run.json.length > 700_000, "a long turn: " + run.json.length);
  assert.ok(page.json.length > 100_000, "a long page: " + page.json.length);

  const stringify = JSON.stringify;
  let written = 0;
  let calls = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const out = stringify(...args);
    written += out?.length ?? 0;
    calls++;
    return out;
  }) as typeof JSON.stringify;
  const snapshot = backend.snapshot.bind(backend);
  let snapshots = 0;
  backend.snapshot = () => (snapshots++, snapshot());
  try {
    for (let i = 0; i < 20; i++) {
      backend.state.streams[id] += "more words. ";
      link.dirty = true;
      link.refresh([id]);
    }
  } finally {
    JSON.stringify = stringify;
    backend.snapshot = snapshot;
  }
  assert.equal(link.parts.get("run:" + id), run, "the run part is the same part, with the same version");
  assert.equal(link.parts.get("chat:" + id), page);
  assert.equal(snapshots, 20, "one build of the app's state for each refresh");
  // Twenty refreshes wrote the small parts (the list of chats, live and the rest) and none of the steps: a
  // refresh used to write the run and the page, more than a megabyte, every time.
  assert.ok(written / 20 < 60_000, "wrote " + written / 20 + " characters a refresh");
  assert.ok(written / 20 < (run.json.length + page.json.length) / 20, "wrote " + written + " characters in all, a refresh wrote " + written / 20);
  assert.ok(calls > 0);

  // A step that changes in place is written again, and the part is a new version with the new bytes.
  const before = run.v;
  steps[17].output += " and a little more";
  backend.state.runs[0].steps.push({ id: "fresh", name: "bash", label: "new", status: "Running", started: 3 });
  link.dirty = true;
  link.refresh([id]);
  const after = link.parts.get("run:" + id);
  assert.ok(after.v > before);
  assert.equal(after.json, stringify(runPart(structuredClone(backend.state), id)));
  assert.ok(after.json.includes(" and a little more") && after.json.includes('"id":"fresh"'));
});

test("a quiet phone's view is not made again for a reply growing, and a phone sent the full text still is", async (t) => {
  const { backend, link, phone } = await setup(t);
  const { chat } = longTurn(backend);
  const id = chat.id;
  const client = await phone();
  client.watch([id]);
  const end = Date.now() + 4000;
  while (link.sessions.size !== 1 || link.waiters.size !== 1) {
    assert.ok(Date.now() < end, "timed out waiting for link");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  client.stop();
  const [session] = [...link.sessions.values()];
  link.dirty = true;
  link.refresh([id]);
  link.viewParts(session, [id], true);
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parsed += String(args[0]).length;
    return parse(...args);
  }) as typeof JSON.parse;
  try {
    for (let i = 0; i < 10; i++) {
      backend.state.streams[id] += "more words. ";
      link.dirty = true;
      link.refresh([id]);
      link.viewParts(session, [id], true);
    }
    assert.equal(parsed, 0, "a quiet phone's view was made again: parsed " + parsed + " characters");
    const view = link.viewParts(session, [id], false);
    assert.ok(parsed > 0, "a phone sent the full text was not given a new view");
    assert.ok(parse(view.get("live").json).streams[id].endsWith("more words. "));
    // A change that is not text (a step) makes the quiet view again, with the step in it.
    backend.state.runs[0].steps.push({ id: "fresh", name: "bash", label: "new", status: "Running", started: 3 });
    link.dirty = true;
    link.refresh([id]);
    parsed = 0;
    const next = link.viewParts(session, [id], true);
    assert.ok(parse(next.get("run:" + id).json).steps.some((step: any) => step.id === "fresh"));
  } finally {
    JSON.parse = parse;
  }
});
