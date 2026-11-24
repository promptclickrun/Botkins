// Notifications and the tools that run on a phone, on the computer's side (link-host/push.mjs and
// device.mjs), with a real LinkHost, a real paired phone client and a stand-in for the relay's push
// route. Nothing leaves the machine: the host is given a fetch that only records.
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, checkJoin, pair, startJoin, type Pairing } from "../src/link/client";
import { agree, fromUtf8, hkdf, open, unb64u, utf8 } from "../src/link/crypto";

const fetcher = fetch as unknown as FetchLike;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const TOKEN = "ab".repeat(32);
const START = "cd".repeat(32);
const ACTIVITY = "ef".repeat(32);

type Sent = { token: string; env: string; type: string; priority: number; expiration: number; collapse?: string; payload: any };

/** Plays the relay's push route: checks the signature like the Worker does, and answers 200 for every item unless told otherwise. */
function fakeRelay() {
  const sent: Sent[] = [];
  const bodies: any[] = [];
  const answers = new Map<string, { status: number; reason?: string }>();
  let status = 200;
  const relay = (async (url: string, init: any) => {
    assert.equal(url, "https://relay.test/v1/push");
    const body = JSON.parse(init.body);
    bodies.push(body);
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: body.key }, format: "jwk" });
    assert.ok(verify(null, Buffer.from("botkins-push-v1:" + body.time + ":" + body.sends, "utf8"), key, Buffer.from(body.sig, "base64url")), "the request is signed with the computer's relay key");
    assert.ok(Math.abs(body.time - Date.now() / 1000) < 5);
    if (status !== 200) return new Response(JSON.stringify({ error: "x" }), { status });
    const items = JSON.parse(body.sends) as Sent[];
    assert.ok(items.length >= 1 && items.length <= 8);
    sent.push(...items);
    return new Response(JSON.stringify({ results: items.map((item) => answers.get(item.token) ?? { status: 200 }) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { relay, sent, bodies, answers, fail: (code: number) => (status = code) };
}

/** A computer with one paired phone and the stand-in relay. */
async function setup(speed = 0.05) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-push-")));
  folders.push(dir);
  const backend = new MockBackend({ speed });
  const push = fakeRelay();
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], searchPath: [], relay: false, fetch: push.relay });
  // The relay stays off; the push route's address is the one the store would use.
  (link as any).relayUrl = () => "https://relay.test";
  await link.setEnabled(true);
  const paired = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
  const parts: Record<string, any> = {};
  const client = new LinkClient(paired, { fetch: fetcher, onParts: (next) => void Object.assign(parts, next), onState() {} });
  client.start();
  const until = async (check: () => boolean, what: string, ms = 5000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("Timed out waiting for " + what);
      await delay(15);
    }
  };
  await until(() => !!parts.bots, "the first state");
  const call = (method: string, ...args: unknown[]): Promise<any> => (client as any).call(method, ...args);
  const done = async () => {
    client.stop();
    await link.stop();
  };
  return { dir, link, backend, parts, until, call, done, paired, ...push };
}

/** Opens a sealed notification the way the phone's notification extension does. */
function unseal(paired: Pairing, b: string) {
  const deviceKey = hkdf(agree(unb64u(paired.secretKey), unb64u(paired.serverKey)), utf8(paired.deviceId), "botkins/device/v1");
  const key = hkdf(deviceKey, utf8(paired.deviceId), "botkins/push/v1");
  const bytes = new Uint8Array(Buffer.from(b, "base64"));
  return JSON.parse(fromUtf8(open(key, bytes.subarray(0, 12), bytes.subarray(12), "botkins-push-v1")));
}

test("the computer says it can notify and run phone tools, and a phone's choices show without its token", async () => {
  const { parts, call, until, done, paired, link } = await setup();
  try {
    assert.ok(parts.meta.capabilities.includes("push-v1"));
    assert.ok(parts.meta.capabilities.includes("device-v1"));
    assert.deepEqual(parts.phones[paired.deviceId], { name: "Test phone", kind: "phone", platform: "ios", sources: {} });
    await call("link.push.register", { token: TOKEN.toUpperCase(), env: "production", start: START }, { routines: false });
    await until(() => !!parts.phones[paired.deviceId].push, "the phone's choices");
    assert.deepEqual(parts.phones[paired.deviceId].push, { replies: true, requests: true, routines: false, previews: true, activities: true, updates: true, spaces: true });
    assert.ok(!JSON.stringify(parts).includes(TOKEN), "no token is sent to phones");
    assert.equal(link.status().push.length, 1);
    assert.ok(!JSON.stringify(link.status()).includes(TOKEN), "nor shown on the computer's page");
    await assert.rejects(call("link.push.register", { token: "not-hex", env: "production" }), /notification address/);
    await call("link.push.unregister");
    await until(() => !parts.phones[paired.deviceId].push, "notifications off");
  } finally {
    await done();
  }
});

test("a finished reply reaches the phone sealed: the relay carries no message text", async () => {
  const { call, until, done, paired, sent, bodies, backend } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    await call("send", "chat-blog", "Shorten this for me.");
    await until(() => sent.some((item) => item.type === "alert"), "the notification");
    const alert = sent.find((item) => item.type === "alert")!;
    assert.equal(alert.token, TOKEN);
    assert.equal(alert.env, "production");
    assert.equal(alert.priority, 10);
    assert.equal(alert.payload.aps["mutable-content"], 1);
    assert.deepEqual(alert.payload.aps.alert, { title: "Botkins", body: "New message" });
    assert.equal(alert.payload.aps.category, "botkins_message");
    const content = unseal(paired, alert.payload.b);
    assert.equal(content.c, "chat-blog");
    assert.equal(content.k, "reply");
    assert.match(content.t, /^Quill/);
    assert.ok(content.m.length > 3);
    const chat = backend.state.chats.find((c: any) => c.id === "chat-blog");
    const reply = chat.messages.at(-1).text.split("\n")[0].replace(/[*_`#]/g, "").trim();
    assert.ok(reply.startsWith(content.m.replace(/…$/, "")), "the banner is the first line of the reply");
    // Nothing the relay saw holds the bot's name, the chat's id or the reply.
    const wire = JSON.stringify(bodies);
    for (const secret of ["Quill", "chat-blog", content.m]) assert.ok(!wire.includes(secret), secret + " crossed the relay in the clear");
  } finally {
    await done();
  }
});

test("a phone that paired again with its old entry still there gets each alert once, sealed for the new pairing", async () => {
  const { link, call, until, done, sent } = await setup();
  const oldStart = "12".repeat(32);
  try {
    await call("link.push.register", { token: TOKEN, env: "production", start: oldStart });
    // The same phone pairs again with a new key; its first entry is left behind.
    const again = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
    const client = new LinkClient(again, { fetch: fetcher, onParts() {}, onState() {} });
    client.start();
    try {
      await (client as any).call("link.push.register", { token: TOKEN, env: "production", start: START });
      assert.equal(link.status().push.length, 1, "the address is held once");
      await call("send", "chat-blog", "Once.");
      await until(() => sent.some((item) => item.type === "alert"), "the notification");
      await delay(500);
      const alerts = sent.filter((item) => item.type === "alert");
      assert.equal(alerts.length, 1);
      assert.equal(unseal(again, alerts[0].payload.b).c, "chat-blog");
      assert.equal(sent.filter((item) => item.type === "liveactivity" && item.token === oldStart).length, 0, "the old entry starts no Live Activity");
    } finally {
      client.stop();
    }
  } finally {
    await done();
  }
});

test("a phone that is showing the chat is not notified; one in the background is", async () => {
  const { call, until, done, sent } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    await call("link.push.presence", true, "chat-blog");
    await call("send", "chat-blog", "One.");
    await until(() => true, "x");
    await delay(900);
    assert.equal(sent.filter((item) => item.type === "alert").length, 0, "the chat is on screen");
    // Another chat while the app is open still tells them.
    await call("send", "chat-market", "Two.");
    await until(() => sent.some((item) => item.type === "alert"), "a notification for the other chat");
    const before = sent.length;
    await call("link.push.presence", false);
    await call("send", "chat-blog", "Three.");
    await until(() => sent.filter((item) => item.type === "alert").length > sent.slice(0, before).filter((item) => item.type === "alert").length, "a notification in the background");
  } finally {
    await done();
  }
});

test("each kind can be switched off, previews can be hidden, and a quiet routine says nothing", async () => {
  const { call, until, done, sent, paired } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" }, { replies: false });
    await call("send", "chat-blog", "Quiet.");
    await delay(900);
    assert.equal(sent.length, 0, "replies are off");

    await call("link.push.prefs", { replies: true, previews: false });
    await call("send", "chat-blog", "Hidden.");
    await until(() => sent.length === 1, "a notification without a preview");
    assert.equal(unseal(paired, sent[0].payload.b).m, "New message");

    // A routine: on by default, quiet when the person says so.
    const id = await call("createRoutine", { botId: "bot-mira", name: "Stand up", prompt: "Remind me.", cadence: { kind: "daily", time: "10:00" }, notify: false });
    await call("runRoutine", id);
    await delay(900);
    assert.equal(sent.length, 1, "a quiet routine sends nothing");
    await call("updateRoutine", id, { notify: true });
    await call("runRoutine", id);
    await until(() => sent.length === 2, "the routine's notification");
    assert.equal(unseal(paired, sent[1].payload.b).k, "routine");

    // A routine set to "No output" publishes nothing, so a run that completes says nothing either,
    // also with "Notify me" left on. (The run is marked `noOutput` by the computer's app.)
    await call("updateRoutine", id, { deliver: { to: "none" }, notify: true });
    await call("runRoutine", id);
    await delay(900);
    assert.equal(sent.length, 2, "a no-output run sends no notification");
    // Back to a destination: it notifies again.
    await call("updateRoutine", id, { deliver: { to: "routine" } });
    await call("runRoutine", id);
    await until(() => sent.length === 3, "the routine's notification again");
  } finally {
    await done();
  }
});

test("a bot's request is urgent and names what it needs", async () => {
  const { call, until, done, sent, paired } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    await call("send", "chat-auth", "Please approve the cleanup.");
    await until(() => sent.some((item) => item.payload.aps?.category === "botkins_request"), "the request's notification");
    const alert = sent.find((item) => item.payload.aps?.category === "botkins_request")!;
    assert.equal(alert.payload.aps["interruption-level"], "time-sensitive");
    assert.equal(alert.expiration, 300);
    const content = unseal(paired, alert.payload.b);
    assert.match(content.t, /needs your approval|has a question/);
    assert.equal(content.k, "request");
    assert.ok(content.r, "it carries the request's id");
  } finally {
    await done();
  }
});

test("a secure input's notification says what it is, and never asks a question", async () => {
  const { call, until, done, sent, paired } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    await call("send", "chat-auth", "secure password");
    await until(() => sent.some((item) => item.payload.aps?.category === "botkins_request"), "the secure input's notification");
    const alert = sent.find((item) => item.payload.aps?.category === "botkins_request")!;
    const content = unseal(paired, alert.payload.b);
    assert.match(content.t, /needs a secure input$/);
    assert.equal(content.k, "request");
  } finally {
    await done();
  }
});

test("a Live Activity is started for a turn begun elsewhere, follows it, and is marked done when the turn ends", async () => {
  // A turn that lasts long enough to be seen under way.
  const { link, call, until, done, sent } = await setup(0.6);
  try {
    await call("link.push.register", { token: TOKEN, env: "sandbox", start: START });
    await call("link.push.presence", false);
    await call("send", "chat-blog", "A long one, please.");
    await until(() => sent.some((item) => item.payload.aps?.event === "start"), "the start");
    const start = sent.find((item) => item.payload.aps?.event === "start")!;
    assert.equal(start.token, START);
    assert.equal(start.env, "sandbox");
    assert.equal(start.type, "liveactivity");
    assert.equal(start.payload.aps["attributes-type"], "BotkinActivityAttributes");
    assert.equal(start.payload.aps.attributes.chatId, "chat-blog");
    assert.equal(start.payload.aps.attributes.botName, "Quill");
    assert.ok(["thinking", "working"].includes(start.payload.aps["content-state"].phase));

    // The phone's activity has its own token; updates go to it, and so does the word that the turn is over.
    await call("link.push.activity", "chat-blog", ACTIVITY);
    const mine = () => sent.filter((item) => item.token === ACTIVITY);
    await until(() => mine().some((item) => item.payload.aps["content-state"].phase === "done"), "the card marked done", 15_000);
    const finished = mine().find((item) => item.payload.aps["content-state"].phase === "done")!;
    // The card is not ended: it stays, says done with when the turn ended, and can be taken over by a new turn.
    assert.equal(finished.payload.aps.event, "update");
    assert.equal(finished.priority, 10);
    const state = finished.payload.aps["content-state"];
    assert.equal(state.label, "Done");
    assert.ok(state.finishedAt >= state.startedAt);
    assert.ok(finished.payload.aps["stale-date"] > Date.now() / 1000 + 25 * 60, "a done card isn't shown as out of date while it stays");
    assert.ok(finished.expiration >= 3600, "kept for a phone that is out of reach for a while");
    assert.ok(!mine().some((item) => item.payload.aps.event === "end"));
    assert.equal(link.push.store.push(link.status().devices[0].id).activities["chat-blog"], ACTIVITY, "the card's address is kept");
    // Every push to the card is newer than the one before, by Apple's clock for it.
    const stamps = mine().map((item) => item.payload.aps.timestamp);
    assert.deepEqual(stamps, [...stamps].sort((x, y) => x - y));
    assert.equal(new Set(stamps).size, stamps.length, "no two pushes to a card share a timestamp");

    // A new turn in the chat takes the same card over: no second card is started.
    const starts = sent.filter((item) => item.payload.aps?.event === "start").length;
    await call("send", "chat-blog", "And one more.");
    await until(() => mine().some((item) => item.payload.aps.timestamp > finished.payload.aps.timestamp && item.payload.aps["content-state"].phase !== "done"), "the card showing the new turn", 15_000);
    assert.equal(sent.filter((item) => item.payload.aps?.event === "start").length, starts);
    assert.equal(link.push.lingering.size, 0, "a card with a turn under way isn't waiting to be ended");
    await until(() => mine().filter((item) => item.payload.aps["content-state"].phase === "done").length === 2, "the second turn marked done", 15_000);
    assert.equal(link.push.lingering.size, 1);

    // After the while a done card stays, it is ended and its address forgotten.
    link.push.endActivity(link.status().devices[0].id, "chat-blog");
    await until(() => mine().some((item) => item.payload.aps.event === "end"), "the end");
    const end = mine().find((item) => item.payload.aps.event === "end")!;
    assert.equal(end.payload.aps["content-state"].phase, "done");
    assert.ok(end.payload.aps["dismissal-date"] <= Date.now() / 1000 + 2, "gone at once");
    assert.equal(link.push.store.push(link.status().devices[0].id).activities?.["chat-blog"], undefined);
    // Nothing in an activity's state is message text.
    for (const item of sent.filter((entry) => entry.type === "liveactivity")) assert.ok(JSON.stringify(item.payload.aps["content-state"]).length < 200);
  } finally {
    await done();
  }
});

/** Opens a Botkin's card's sealed part the way the widget extension does (its own AAD). */
function unsealCard(paired: Pairing, b: string) {
  const deviceKey = hkdf(agree(unb64u(paired.secretKey), unb64u(paired.serverKey)), utf8(paired.deviceId), "botkins/device/v1");
  const key = hkdf(deviceKey, utf8(paired.deviceId), "botkins/push/v1");
  const bytes = new Uint8Array(Buffer.from(b, "base64"));
  return JSON.parse(fromUtf8(open(key, bytes.subarray(0, 12), bytes.subarray(12), "botkins-card-v1")));
}

test("a phone with one card per Botkin gets it started from afar, sealed, and ended showing done once its chats have ended", async () => {
  const { link, call, until, done, sent, paired, parts, backend } = await setup(0.6);
  try {
    link.push.overHold = 600;
    assert.ok(parts.meta.capabilities.includes("activity-bots-v1"));
    await call("link.push.register", { token: TOKEN, env: "production", start: START, cards: "bots" });
    const deviceId = link.status().devices[0].id;
    assert.equal(link.push.store.push(deviceId).cards, "bots");
    await call("link.push.presence", false);
    await call("send", "chat-blog", "A long one, please.");
    await until(() => sent.some((item) => item.payload.aps?.event === "start"), "the start");
    const start = sent.find((item) => item.payload.aps?.event === "start")!;
    assert.equal(start.token, START);
    assert.deepEqual(start.payload.aps.attributes, { chatId: "", botId: "bot-quill", botName: "Quill", head: start.payload.aps.attributes.head, palette: start.payload.aps.attributes.palette, eyes: start.payload.aps.attributes.eyes, colors: start.payload.aps.attributes.colors, card: "bot" });
    const first = start.payload.aps["content-state"];
    assert.equal(first.v, 1);
    assert.equal(first.chats[0].id, "chat-blog");
    assert.ok(start.payload.aps["relevance-score"] >= 50);
    // The chat's title travels only sealed, and only the card's key and AAD open it.
    assert.ok(!JSON.stringify(start.payload).includes("Blog"), "no title in the clear");
    const opened = unsealCard(paired, first.sealed);
    assert.equal(opened.c[0].id, "chat-blog");
    assert.ok(opened.c[0].t.length > 0);
    assert.throws(() => unseal(paired, first.sealed), "an alert's AAD does not open a card");
    // A second turn of the same Botkin doesn't start a second card while the first waits for its address.
    assert.equal(sent.filter((item) => item.payload.aps?.event === "start").length, 1);

    // The card's own address: updates go there, and the card is ended showing done when the turn ends.
    await call("link.push.activity", "bot:bot-quill", ACTIVITY);
    const mine = () => sent.filter((item) => item.token === ACTIVITY);
    await until(() => mine().some((item) => item.payload.aps["content-state"].phase === "done"), "the card marked done", 15_000);
    const finished = mine().find((item) => item.payload.aps["content-state"].phase === "done")!;
    assert.equal(finished.payload.aps.event, "update");
    assert.equal(finished.priority, 10, "a chat that ends is sent at once");
    assert.equal(finished.payload.aps["relevance-score"], 10);
    assert.equal(finished.payload.aps.alert, undefined, "a Botkin's card doesn't chime");
    await until(() => mine().some((item) => item.payload.aps.event === "end"), "the end", 5_000);
    const ended = mine().find((item) => item.payload.aps.event === "end")!;
    assert.ok(ended.payload.aps["dismissal-date"] > Date.now() / 1000 + 200, "the final state stays a few minutes");
    const last = unsealCard(paired, finished.payload.aps["content-state"].sealed);
    assert.equal(last.c[0].l, "Done");
    assert.ok(last.c[0].r, "the reply's first line");
    assert.equal(link.push.store.push(deviceId).activities?.["bot:bot-quill"], undefined, "its address is forgotten");
    const stamps = mine().map((item) => item.payload.aps.timestamp);
    assert.equal(new Set(stamps).size, stamps.length, "no two pushes to a card share a timestamp");
    void backend;
  } finally {
    await done();
  }
});

test("a request reaches the phone with its buttons, on the card and in the notification, and not with previews off", async () => {
  const { link, call, until, done, sent, paired } = await setup(0.3);
  try {
    await call("link.push.register", { token: TOKEN, env: "production", start: START, cards: "bots" });
    await call("link.push.presence", false);
    await call("link.push.activity", "bot:bot-quill", ACTIVITY);
    await call("send", "chat-blog", "Please approve the deploy.");
    await until(() => sent.some((item) => item.type === "alert"), "the request's notification");
    const alert = unseal(paired, sent.find((item) => item.type === "alert")!.payload.b);
    assert.equal(alert.k, "request");
    assert.deepEqual(alert.q, { id: alert.r, k: "permission", t: "Run a command", p: "npm run deploy -- --env production", rm: true });
    await until(() => sent.some((item) => item.token === ACTIVITY && item.payload.aps["content-state"].phase === "needs-you"), "the card asking");
    const card = sent.find((item) => item.token === ACTIVITY && item.payload.aps["content-state"].phase === "needs-you")!;
    assert.equal(card.priority, 10);
    assert.equal(card.payload.aps["relevance-score"], 100);
    assert.equal(card.payload.aps["content-state"].chats[0].ask, "approve");
    assert.equal(unsealCard(paired, card.payload.aps["content-state"].sealed).c[0].q.id, alert.r);
    // The person answers (as a card's button would): the card goes back to work.
    await call("respond", alert.r, { action: "approve" });
    await until(() => sent.some((item) => item.token === ACTIVITY && item.payload.aps.timestamp > card.payload.aps.timestamp && item.payload.aps["content-state"].phase !== "needs-you"), "the card after the answer", 15_000);

    // Previews off: the notification only opens the app, and the card carries nothing sealed.
    await call("link.push.prefs", { previews: false });
    sent.length = 0;
    // The card still shows the first turn done: the next turn takes it over.
    await call("send", "chat-blog", "Approve one more, please.");
    await until(() => sent.some((item) => item.type === "alert"), "the second request");
    assert.equal(unseal(paired, sent.find((item) => item.type === "alert")!.payload.b).q, undefined);
    await until(() => sent.some((item) => item.token === ACTIVITY && item.payload.aps["content-state"].phase === "needs-you"), "the card asking again");
    const quiet = sent.find((item) => item.token === ACTIVITY && item.payload.aps["content-state"].phase === "needs-you")!;
    assert.equal(quiet.payload.aps["content-state"].sealed, undefined);
    assert.equal(quiet.payload.aps["content-state"].chats[0].ask, "approve");
    void link;
  } finally {
    await done();
  }
});

test("one card for all Botkins: never started from afar, kept up to date, and when every chat is done it chimes, then ends a moment later", async () => {
  const { link, call, until, done, sent, paired, parts } = await setup(0.3);
  try {
    assert.ok(parts.meta.capabilities.includes("activity-all-v1"));
    await call("link.push.register", { token: TOKEN, env: "production", start: START, cards: "all" });
    const deviceId = link.status().devices[0].id;
    assert.equal(link.push.store.push(deviceId).cards, "all");
    // The phone started the card while it was in front and said where its updates go.
    await call("link.push.activity", "all", ACTIVITY);
    await delay(400);
    assert.ok(!sent.some((item) => item.token === ACTIVITY && !item.payload.aps["content-state"]?.chats), "never a chat's state on the card for all Botkins");
    assert.equal(link.push.lingering.size, 0, "and no chat's timer to end it");
    await call("link.push.presence", false);
    // (The demo has chats that ended a little while ago: the card may say "all done" until the turn begins.)
    const from = sent.length;
    await call("send", "chat-blog", "Short one.");
    const mine = () => sent.slice(from).filter((item) => item.token === ACTIVITY);
    const blogAtWork = (item: Sent) => item.payload.aps["content-state"]?.chats?.[0]?.id === "chat-blog" && item.payload.aps["content-state"].chats[0].phase !== "done";
    await until(() => mine().some(blogAtWork), "the card at work");
    link.push.overHold = 600;
    const working = mine().find(blogAtWork)!;
    const row = working.payload.aps["content-state"].chats[0];
    assert.equal(row.id, "chat-blog");
    assert.equal(row.bot, "bot-quill");
    assert.ok(row.head, "the row has its Botkin's look");
    assert.ok(!JSON.stringify(working.payload).includes("Quill"), "the Botkin's name travels only sealed");
    assert.equal(unsealCard(paired, working.payload.aps["content-state"].sealed).c[0].b, "Quill");

    // The turn ends: the card shows it with an alert (the island opens and the sound plays), and the
    // done notification comes too, without a second sound.
    await until(() => mine().some((item) => item.payload.aps["content-state"]?.phase === "done"), "the card done", 15_000);
    const final = mine().find((item) => item.payload.aps["content-state"]?.phase === "done")!;
    assert.equal(final.payload.aps.event, "update");
    assert.equal(final.priority, 10);
    assert.equal(final.payload.aps.alert.sound, "default");
    assert.ok(!JSON.stringify(final.payload.aps.alert).includes("Quill"), "the alert says nothing in the clear");
    await until(() => sent.slice(from).some((item) => item.type === "alert"), "the done notification");
    const note = sent.slice(from).find((item) => item.type === "alert")!;
    assert.equal(unseal(paired, note.payload.b).k, "reply");
    assert.equal(note.payload.aps.sound, undefined, "the card made the sound");
    // A moment later the card is ended; its final state stays a few minutes.
    await until(() => mine().some((item) => item.payload.aps.event === "end"), "the end", 5_000);
    const end = mine().find((item) => item.payload.aps.event === "end")!;
    assert.equal(end.payload.aps["content-state"].phase, "done");
    assert.equal(end.payload.aps.alert, undefined);
    assert.ok(end.payload.aps["dismissal-date"] >= Date.now() / 1000 + 200, "the final state stays a few minutes");
    assert.ok(end.payload.aps["dismissal-date"] <= Date.now() / 1000 + 600);
    assert.equal(mine().filter((item) => item.payload.aps.alert).length, 1, "one sound");
    assert.equal(link.push.store.push(deviceId).activities?.all, undefined, "the card's address is forgotten");
    assert.ok(!sent.some((item) => item.payload.aps?.event === "start"), "no card is started from afar");
  } finally {
    await done();
  }
});

test("with one card for all Botkins, a request rides on the card as its alert; without a card it is a notification", async () => {
  const { link, call, until, done, sent, paired } = await setup(0.3);
  try {
    link.push.overHold = 300;
    await call("link.push.register", { token: TOKEN, env: "production", cards: "all" });
    await call("link.push.activity", "all", ACTIVITY);
    await call("link.push.presence", false);
    await call("send", "chat-blog", "Please approve the deploy.");
    const asking = () => sent.find((item) => item.token === ACTIVITY && item.payload.aps["content-state"]?.phase === "needs-you");
    await until(() => !!asking(), "the card asking");
    const card = asking()!;
    assert.equal(card.priority, 10);
    assert.deepEqual(Object.keys(card.payload.aps.alert).sort(), ["body", "sound", "title"]);
    assert.equal(card.payload.aps.alert.sound, "default");
    assert.ok(!JSON.stringify(card.payload.aps.alert).includes("deploy"), "the alert says nothing the bot wrote");
    const ask = unsealCard(paired, card.payload.aps["content-state"].sealed).c[0].q;
    await delay(400);
    assert.ok(!sent.some((item) => item.type === "alert"), "no notification of its own");
    // Only the first push that shows the request makes a sound.
    await call("respond", ask.id, { action: "approve" });
    await until(() => sent.some((item) => item.token === ACTIVITY && item.payload.aps.event === "end"), "the end", 15_000);
    // One sound for the request, one for the end of the turn.
    assert.equal(sent.filter((item) => item.token === ACTIVITY && item.payload.aps.alert).length, 2);

    // The card is gone: the next request is a notification, as before.
    sent.length = 0;
    await call("send", "chat-blog", "Approve one more, please.");
    await until(() => sent.some((item) => item.type === "alert"), "the request's notification");
    assert.equal(unseal(paired, sent.find((item) => item.type === "alert")!.payload.b).k, "request");
    void link;
  } finally {
    await done();
  }
});

test("when the phone leaves the app, the computer sends the card again at once, and quietly", async () => {
  const { call, until, done, sent } = await setup(0.3);
  try {
    await call("link.push.register", { token: TOKEN, env: "production", cards: "all" });
    await call("link.push.activity", "all", ACTIVITY);
    await call("link.push.presence", false);
    // A turn waiting for an approval: nothing on the card changes while the phone comes and goes.
    await call("send", "chat-blog", "Please approve the deploy.");
    const mine = () => sent.filter((item) => item.token === ACTIVITY);
    await until(() => mine().some((item) => item.payload.aps["content-state"]?.phase === "needs-you"), "the card asking");
    await delay(300);
    // The phone comes to the front (it draws the card itself then), and leaves again.
    await call("link.push.presence", true);
    const before = mine().length;
    await call("link.push.presence", false);
    await until(() => mine().length > before, "the card sent again", 1500);
    const again = mine()[mine().length - 1];
    assert.equal(again.payload.aps["content-state"].phase, "needs-you");
    assert.equal(again.payload.aps.alert, undefined, "it doesn't ring again");
  } finally {
    await done();
  }
});

test("a computer that starts again ends a card that has nothing left on it, without waiting for a change in the chats", async () => {
  const { link, call, until, done, sent } = await setup(0.3);
  try {
    await call("link.push.register", { token: TOKEN, env: "production", cards: "all" });
    await call("link.push.presence", false);
    const deviceId = link.status().devices[0].id;
    // A card left over from before the computer stopped: its address is kept, nothing is at work.
    const record = link.push.store.push(deviceId);
    link.push.store.setPush(deviceId, { ...record, activities: { all: ACTIVITY } });
    link.push.working = null;
    link.push.sent.clear();
    link.push.overHold = 300;
    link.push.start();
    await until(() => sent.some((item) => item.token === ACTIVITY && item.payload.aps.event === "end"), "the end");
    assert.equal(link.push.store.push(deviceId).activities?.all, undefined);
  } finally {
    await done();
  }
});

test("a card whose address the computer never got is still brought up to date: the app is woken, and a late address catches up", async () => {
  const { link, call, until, done, sent } = await setup(0.3);
  try {
    await call("link.push.register", { token: TOKEN, env: "production", start: START });
    await call("link.push.presence", false);
    await call("send", "chat-blog", "Short one.");
    await until(() => sent.some((item) => item.payload.aps?.event === "start"), "the start");
    // The app is closed: the card's own address never comes. When the turn ends, the phone is woken
    // (a push it doesn't show), so the app can mark its card done and say where the card's updates go.
    await until(() => sent.some((item) => item.type === "background" && item.token === TOKEN), "the wake", 15_000);
    const wake = sent.find((item) => item.type === "background")!;
    assert.deepEqual(wake.payload.aps, { "content-available": 1 });
    assert.equal(sent.filter((item) => item.type === "background").length, 1, "one wake for one turn");

    // Woken, the app says where the card's updates go. The turn is over by then: the card is marked done at once.
    const before = sent.length;
    await call("link.push.activity", "chat-blog", ACTIVITY);
    await until(() => sent.slice(before).some((item) => item.token === ACTIVITY), "the catch-up");
    const caught = sent.slice(before).find((item) => item.token === ACTIVITY)!;
    assert.equal(caught.payload.aps.event, "update");
    assert.equal(caught.payload.aps["content-state"].phase, "done");
    assert.ok(caught.payload.aps["content-state"].finishedAt > 0);
    assert.equal(link.push.lingering.size, 1);
  } finally {
    await done();
  }
});

test("a token Apple no longer knows is forgotten, and a test notification reports what went wrong", async () => {
  const { call, until, done, sent, answers, parts, paired, fail } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    await call("link.push.test");
    assert.equal(unseal(paired, sent[0].payload.b).k, "test");
    fail(503);
    await assert.rejects(call("link.push.test"), /isn't set up yet/);
    fail(200);
    answers.set(TOKEN, { status: 410, reason: "Unregistered" });
    await assert.rejects(call("link.push.test"), /no longer knows this phone/);
    await until(() => !parts.phones[paired.deviceId].push, "the token to be forgotten");
  } finally {
    await done();
  }
});

// ---------------------------------------------------------------------------------------------
// Tools that run on a phone.

test("bots get the tools a phone allows, at the level it allows", async () => {
  const { link, call, until, done, parts, paired } = await setup();
  try {
    let changes = 0;
    link.on("tools", () => changes++);
    assert.deepEqual(link.deviceTools(), [], "nothing is on until the person switches it on");
    await call("link.device.sources", { calendar: "read", location: "interact", mail: "read", photos: "interact", music: "read", nonsense: "interact" });
    await until(() => !!parts.phones[paired.deviceId].sources.calendar, "the switches");
    // Location has nothing to change and Mail nothing to read.
    assert.deepEqual(parts.phones[paired.deviceId].sources, { calendar: "read", location: "read", photos: "interact", music: "read" });
    const names = link.deviceTools().map((tool: any) => tool.name);
    assert.ok(names.includes("phone_calendar_events") && names.includes("phone_calendar_list") && names.includes("phone_location") && names.includes("phone_photos_get") && names.includes("phone_music_search"));
    assert.ok(!names.includes("phone_calendar_create_event"), "read does not include changing");
    assert.ok(!names.includes("phone_mail_compose") && !names.includes("phone_contacts_search"));
    for (const tool of link.deviceTools()) {
      assert.match(tool.name, /^phone_[a-z_]{1,44}$/);
      assert.equal(tool.parameters.type, "object");
      assert.equal(typeof tool.readOnly, "boolean");
    }
    assert.equal(link.deviceTools().find((tool: any) => tool.name === "phone_calendar_events").readOnly, true);
    assert.equal(link.deviceTools().find((tool: any) => tool.name === "phone_music_play"), undefined);
    await call("link.device.sources", { calendar: "interact" });
    assert.ok(link.deviceTools().some((tool: any) => tool.name === "phone_calendar_create_event" && tool.readOnly === false));
    await call("link.device.sources", { music: "interact" });
    assert.ok(link.deviceTools().some((tool: any) => tool.name === "phone_music_play" && tool.readOnly === false));
    assert.ok(changes >= 2, "the app is told when the list changes");
    await assert.rejects(link.callDeviceTool("phone_contacts_search", { query: "a" }), /No phone allows this.*Contacts.*Read/);
    await assert.rejects(link.callDeviceTool("phone_nonsense", {}), /no phone tool named/);
  } finally {
    await done();
  }
});

test("a tool call waits for the phone it is addressed to, and gets that phone's answer", async () => {
  const { link, call, until, done, parts, paired } = await setup();
  try {
    await call("link.device.sources", { calendar: "read" });
    await call("link.push.presence", true);
    const asked = link.callDeviceTool("phone_calendar_events", { from: "2026-11-19", to: "2026-11-20" }, { botId: "bot-mira", chatId: "chat-launch" });
    await until(() => parts.asks?.length === 1, "the ask to reach the phone");
    const ask = parts.asks[0];
    assert.deepEqual({ ...ask, id: "", at: 0 }, { id: "", at: 0, deviceId: paired.deviceId, tool: "phone_calendar_events", args: { from: "2026-11-19", to: "2026-11-20" }, botId: "bot-mira", chatId: "chat-launch" });
    await call("link.device.answer", ask.id, { ok: true, result: { events: [{ title: "Standup" }] } });
    assert.deepEqual(await asked, { events: [{ title: "Standup" }] });
    await until(() => parts.asks.length === 0, "the ask to clear");
    // An ask can be answered once.
    await assert.rejects(call("link.device.answer", ask.id, { ok: true, result: 1 }), /no longer open/);

    // The phone says no: the bot hears why.
    const refused = assert.rejects(link.callDeviceTool("phone_calendar_list", {}), /Calendar access is off in Settings\./);
    await until(() => parts.asks?.length === 1, "the second ask");
    await call("link.device.answer", parts.asks[0].id, { ok: false, error: "Calendar access is off in Settings." });
    await refused;

    // A bot that stops waiting takes its ask with it.
    const stop = new AbortController();
    const stopped = assert.rejects(link.callDeviceTool("phone_calendar_list", {}, { signal: stop.signal }), /Stopped/);
    await until(() => parts.asks?.length === 1, "the third ask");
    stop.abort();
    await stopped;
    await until(() => parts.asks.length === 0, "the stopped ask to clear");
  } finally {
    await done();
  }
});

test("a sleeping phone is woken quietly, and a tool the person finishes by hand tells them at once", async () => {
  const { link, call, until, done, parts, sent, paired } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    await call("link.device.sources", { calendar: "read", mail: "interact" });
    await call("link.push.presence", false);
    const asked = link.callDeviceTool("phone_calendar_list", {});
    await until(() => sent.some((item) => item.type === "background"), "the wake");
    const wake = sent.find((item) => item.type === "background")!;
    assert.deepEqual(wake.payload.aps, { "content-available": 1 });
    assert.equal(wake.priority, 5);
    await until(() => parts.asks?.length === 1, "the ask");
    await call("link.device.answer", parts.asks[0].id, { ok: true, result: [] });
    assert.deepEqual(await asked, []);

    const mail = link.callDeviceTool("phone_mail_compose", { to: ["a@example.com"], subject: "Hi", body: "Hello" }, { botId: "bot-quill", chatId: "chat-blog" });
    await until(() => sent.some((item) => item.type === "alert"), "the notification that a bot is waiting");
    const content = unseal(paired, sent.find((item) => item.type === "alert")!.payload.b);
    assert.equal(content.t, "Quill is waiting on your phone");
    assert.match(content.m, /Mail/);
    await until(() => parts.asks?.[0]?.tool === "phone_mail_compose", "the mail ask");
    await call("link.device.answer", parts.asks[0].id, { ok: true, result: { status: "sent" } });
    assert.deepEqual(await mail, { status: "sent" });
  } finally {
    await done();
  }
});

test("removing a phone ends its asks, its tools and its notifications", async () => {
  const { link, call, until, done, parts, paired } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    await call("link.device.sources", { contacts: "read" });
    await call("link.push.presence", true);
    const asked = link.callDeviceTool("phone_contacts_search", { query: "sam" });
    await until(() => parts.asks?.length === 1, "the ask");
    const failed = assert.rejects(asked, /phone was removed/);
    link.removeDevice(paired.deviceId);
    await failed;
    assert.deepEqual(link.deviceTools(), []);
    assert.equal(link.status().push.length, 0);
    assert.equal((link as any).store.push(paired.deviceId), null);
  } finally {
    await done();
  }
});

test("a picture a bot saves to Photos travels to the phone it is for, and the computer's path stays behind", async () => {
  const { link, call, until, done, parts, dir } = await setup();
  try {
    const { writeFileSync } = await import("node:fs");
    const picture = join(dir, "chart.png");
    writeFileSync(picture, Buffer.from("not really a png, but a file"));
    await call("link.device.sources", { photos: "interact" });
    await call("link.push.presence", true);
    assert.ok(link.deviceTools().some((tool: any) => tool.name === "phone_photos_save" && tool.readOnly === false));

    await assert.rejects(link.callDeviceTool("phone_photos_save", { path: "chart.png" }), /full path/);
    await assert.rejects(link.callDeviceTool("phone_photos_save", { path: join(dir, "link.json") }), /Only a picture/);
    await assert.rejects(link.callDeviceTool("phone_photos_save", { path: join(dir, "missing.png") }), /no picture at that path/);

    const saved = link.callDeviceTool("phone_photos_save", { path: picture, album: "Charts" });
    await until(() => parts.asks?.[0]?.tool === "phone_photos_save", "the ask");
    const ask = parts.asks[0];
    assert.deepEqual(ask.args, { path: "chart.png", album: "Charts" }, "the phone is told the file's name only");
    const file = await call("link.device.file", ask.id);
    assert.equal(file.name, "chart.png");
    assert.equal(Buffer.from(file.data, "base64").toString(), "not really a png, but a file");
    await call("link.device.answer", ask.id, { ok: true, result: { id: "photo-1" } });
    assert.deepEqual(await saved, { id: "photo-1" });
    // The file is there only while the ask is open.
    await assert.rejects(call("link.device.file", ask.id), /no longer open/);
  } finally {
    await done();
  }
});

test("a phone that named the wrong one of Apple's services is corrected from the relay's answer", async () => {
  const { call, until, done, sent, answers, link, paired } = await setup();
  try {
    // A TestFlight build of the app once said "sandbox" for a production address.
    await call("link.push.register", { token: TOKEN, env: "sandbox" });
    answers.set(TOKEN, { status: 200, env: "production" } as any);
    await call("link.push.test");
    assert.equal(sent[0].env, "sandbox");
    await until(() => (link as any).store.push(paired.deviceId).env === "production", "the service to be remembered");
    await call("link.push.test");
    assert.equal(sent[1].env, "production", "the next one goes straight to the right service");
  } finally {
    await done();
  }
});

test("a proactive alert is titled with the bot's name alone and carries its action; a check that failed says nothing", async () => {
  const { call, until, done, sent, paired, backend, bodies } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    const state = (backend as any).state;
    const look = { id: "chat-look", botId: "bot-mira", title: "Routine · Mira looks out for you", time: Date.now(), messages: [] as any[], schedules: [{ id: 1, routine: true, proactive: true, enabled: true, name: "Mira looks out for you" }] };
    state.chats.unshift(look);
    const check = (id: string) => {
      const run: any = { id, chatId: "chat-look", scheduleId: 1, proactive: true, title: "Mira looks out for you", status: "Working", time: Date.now() };
      state.runs.unshift(run);
      backend.changed();
      return run;
    };
    // A check that failed is in the bot's Proactive log, not a notification.
    const failed = check("run-failed");
    await delay(400);
    Object.assign(failed, { status: "Needs you", detail: "The model didn't answer.", finished: Date.now() });
    backend.changed();
    await delay(900);
    assert.equal(sent.filter((item) => item.type === "alert").length, 0);

    const run = check("run-look");
    await delay(400);
    const words = "Ana is waiting on three replies.\n\nThe oldest is from Monday.";
    look.messages.push({ role: "assistant", runId: "run-look", text: words, time: Date.now() });
    const chat = state.chats.find((c: any) => c.id === "chat-launch");
    chat.messages.push({ role: "assistant", text: words, time: Date.now(), proactiveRunId: "run-look", alert: { runId: "run-look", offer: "Draft the replies" } });
    Object.assign(run, { status: "Completed", finished: Date.now(), delivery: { to: "chat", chatId: "chat-launch" } });
    backend.changed();
    await until(() => sent.some((item) => item.type === "alert"), "the alert");
    const content = unseal(paired, sent.find((item) => item.type === "alert")!.payload.b);
    assert.equal(content.t, "Mira", "the bot's name alone");
    assert.equal(content.m, "Ana is waiting on three replies.");
    assert.equal(content.c, "chat-launch", "a tap opens the alert where it was delivered");
    assert.deepEqual(content.a, { b: "bot-mira", r: "run-look" }, "what the phone needs for Take care of it");
    assert.doesNotMatch(JSON.stringify(content), /Proactive agent|looks out for/);
    assert.ok(!JSON.stringify(bodies).includes("Ana"), "nothing crossed the relay in the clear");
  } finally {
    await done();
  }
});

test("a proactive push rechecks the recipient's agents.view permission and bot allowlist", async () => {
  const { call, done, paired, link } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    const device = { ...link.store.device(paired.deviceId), memberId: "m_sam" };
    const team = link.store.data.team;
    team.members.push({ id: "m_sam", name: "Sam", groupId: "g_everyone", deviceIds: [device.id] });
    const role = team.roles.find((role: { id: string }) => role.id === "r_guest");
    role.bots = ["bot-mira"];
    const run = { id: "proactive-private", chatId: "proactive-check", scheduleId: 1, proactive: true, status: "Completed", delivery: { to: "chat", chatId: "proactive-check" } };
    const chat = { id: run.chatId, botId: "bot-mira", createdBy: device.memberId, messages: [{ role: "assistant", runId: run.id, text: "Private alert" }] };
    const check = () => {
      const sends: Sent[] = [];
      link.push.onFinish(sends, [device], {}, run, new Map([[chat.id, chat]]), new Map());
      return sends;
    };
    assert.equal(check().length, 1);
    role.perms.agents = [];
    assert.deepEqual(check(), [], "membership does not keep delivery after agents.view is revoked");
    role.perms.agents = ["view"];
    role.bots = [];
    assert.deepEqual(check(), [], "permission without the bot does not allow delivery");
  } finally {
    await done();
  }
});

test("a reminder reaches only the person it is for, once, by their own choices", async () => {
  const { call, until, done, sent, paired, backend } = await setup();
  try {
    await call("link.push.register", { token: TOKEN, env: "production" });
    const state = (backend as any).state;
    await delay(400);
    const reminder = (key: string, person: string) => ({ key, person, botId: "bot-patch", chatId: "chat-auth", title: "Patch is waiting on your answer", body: "Which branch should I use?", sentAt: Date.now() });
    state.reminders = [reminder("request:theirs", "m_someone")];
    backend.changed();
    await delay(900);
    assert.equal(sent.length, 0, "another person's reminder is not the owner's phone's");
    state.reminders = [reminder("request:theirs", "m_someone"), reminder("request:mine", "owner")];
    backend.changed();
    await until(() => sent.length === 1, "the reminder");
    const content = unseal(paired, sent[0].payload.b);
    assert.deepEqual([content.t, content.m, content.c, content.k], ["Patch is waiting on your answer", "Which branch should I use?", "chat-auth", "reminder"]);
    assert.equal(sent[0].payload.aps.alert.body, "A bot needs you");
    backend.changed();
    await delay(900);
    assert.equal(sent.length, 1, "once");
    // A phone that turned "A bot needs me" off gets no reminder either.
    await call("link.push.prefs", { requests: false });
    state.reminders = [...state.reminders, reminder("request:another", "owner")];
    backend.changed();
    await delay(900);
    assert.equal(sent.length, 1);
  } finally {
    await done();
  }
});

test("routine notification targets route pushes to exact people and devices, support run overrides, respect previews and access, and keep Live Activities", async () => {
  const { dir, link, backend, parts, until, call, done, sent, paired } = await setup(0.05);
  void dir;
  const extraClients: LinkClient[] = [];
  const OWNER2_TOKEN = "11".repeat(32);
  const SARAH_TOKEN = "22".repeat(32);
  const ALEX_TOKEN = "33".repeat(32);
  try {
    assert.ok(parts.meta.capabilities.includes("routine-notify-targets-v1"), "capability is advertised");

    // Second owner phone
    const owner2Paired = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner iPad", platform: "ios" });
    const owner2 = new LinkClient(owner2Paired, { fetch: fetcher, onParts() {}, onState() {} });
    owner2.start();
    extraClients.push(owner2);

    // Give r_guest access to bot-mira so team members can see bot-mira routines
    const guestRole = structuredClone((link as any).store.data.team.roles.find((r: any) => r.id === "r_guest"));
    guestRole.bots = ["bot-mira"];
    await call("link.team.saveRole", guestRole);

    // Create a second group/role without bot-mira for access-check testing
    const restrictedRole = { ...structuredClone(guestRole), id: "r_ABCDEFGHJK", name: "Quill only", bots: ["bot-quill"] };
    await call("link.team.saveRole", restrictedRole);
    await call("link.team.saveGroup", { id: "g_quill", name: "Quill team", roleId: "r_ABCDEFGHJK" });

    // Join Sarah (can see bot-mira) and Alex (can only see bot-quill)
    const joinMember = async (groupId: string, deviceName: string, memberName: string) => {
      const invite = await call("link.team.createInvite", { groupId, days: 7, maxUses: 1 });
      const target = {
        hosts: ["127.0.0.1:" + link.port],
        code: invite.code,
        serverId: link.status().serverId,
        serverKey: Buffer.from((link as any).store.data.keys.publicKey).toString("base64url"),
        name: link.status().name,
      };
      const started = await startJoin(fetcher, target, { name: deviceName, person: memberName, platform: "ios", kind: "phone" });
      if (started.result.status !== "pending") throw new Error("expected pending join");
      await call("link.team.approve", started.result.requestId);
      const checked = await checkJoin(fetcher, started.attempt);
      if (checked.status !== "approved") throw new Error("expected approved join");
      const memberParts: Record<string, any> = {};
      const client = new LinkClient(checked.pairing, { fetch: fetcher, onParts: (next) => void Object.assign(memberParts, next), onState() {} });
      client.start();
      extraClients.push(client);
      await until(() => !!memberParts.meta, memberName + " first state");
      return { pairing: checked.pairing, client, parts: memberParts, memberId: (link as any).store.data.team.members.find((m: any) => m.name === memberName).id as string };
    };

    const sarah = await joinMember("g_everyone", "Sarah iPhone", "Sarah");
    const alex = await joinMember("g_quill", "Alex iPhone", "Alex");

    // Verify member's own synced team.me.devices includes Sarah's phone and canNotify updates after push registration.
    assert.deepEqual(
      sarah.parts.team?.me?.devices?.map((d: any) => [d.id, d.name, d.canNotify]),
      [[sarah.pairing.deviceId, "Sarah iPhone", false]],
    );

    // Register push on all 4 phones and mark them away
    await call("link.push.register", { token: TOKEN, env: "production", cards: "all" });
    await call("link.push.activity", "all", ACTIVITY);
    await call("link.push.presence", false);
    await (owner2 as any).call("link.push.register", { token: OWNER2_TOKEN, env: "production" });
    await (owner2 as any).call("link.push.presence", false);
    await (sarah.client as any).call("link.push.register", { token: SARAH_TOKEN, env: "production" });
    await (sarah.client as any).call("link.push.presence", false);
    await (alex.client as any).call("link.push.register", { token: ALEX_TOKEN, env: "production" });
    await (alex.client as any).call("link.push.presence", false);

    await until(() => sarah.parts.team?.me?.devices?.[0]?.canNotify === true, "Sarah canNotify synced");

    // 1. Person-targeted routine (Sarah only): only Sarah's phone gets alert; owner phones do NOT; owner Live Activity still runs.
    const routineId = await call("createRoutine", {
      botId: "bot-mira",
      name: "Daily Ops",
      prompt: "Check ops.",
      cadence: { kind: "daily", time: "09:00" },
      notifyTargets: { people: [sarah.memberId] },
    });
    sent.length = 0;
    await call("runRoutine", routineId);
    await until(() => sent.some((item) => item.type === "alert" && item.token === SARAH_TOKEN), "Sarah alert");
    await delay(250);
    const alerts1 = sent.filter((item) => item.type === "alert");
    assert.deepEqual(alerts1.map((a) => a.token), [SARAH_TOKEN], "only Sarah's phone gets the routine alert");
    assert.equal(unseal(sarah.pairing, alerts1[0].payload.b).k, "routine");
    assert.ok(sent.some((item) => item.token === ACTIVITY), "Live Activity on owner's phone still updated");

    // 2. Device-only targeting: only Owner iPad gets the alert (not Owner's primary phone or Sarah).
    await call("updateRoutine", routineId, { notifyTargets: { devices: [owner2Paired.deviceId] } });
    sent.length = 0;
    await call("runRoutine", routineId);
    await until(() => sent.some((item) => item.type === "alert" && item.token === OWNER2_TOKEN), "Owner iPad alert");
    await delay(250);
    assert.deepEqual(
      sent.filter((item) => item.type === "alert").map((a) => a.token),
      [OWNER2_TOKEN],
      "only the targeted device gets the alert",
    );

    // 3. Per-run override (run.notifyTargets) with custom message + previews: false redaction + access boundary.
    // Disable previews on Sarah's phone, then emit a completed routine run overriding targets to Sarah + Alex (ineligible for bot-mira) with a custom message.
    await (sarah.client as any).call("link.push.prefs", { previews: false });
    await until(() => (link as any).store.push(sarah.pairing.deviceId)?.prefs?.previews === false, "Sarah previews off");

    sent.length = 0;
    const customRunId = "run-override-1";
    const chat = (backend as any).chat(routineId);
    chat.messages.push({ role: "assistant", text: "Secret body details", runId: customRunId, time: Date.now() });
    (backend as any).state.runs.unshift({
      id: customRunId,
      chatId: routineId,
      title: "Daily Ops",
      time: Date.now(),
      status: "Completed",
      detail: "",
      trigger: "scheduled",
      scheduleId: 1,
      notifyTargets: {
        mode: "only",
        people: [sarah.memberId, alex.memberId],
        devices: [owner2Paired.deviceId],
        message: "Server CPU 99% — check prod",
      },
    });
    (backend as any).changed();
    await until(() => sent.filter((item) => item.type === "alert").length === 2, "Sarah + Owner iPad alerts");
    await delay(250);
    const alerts3 = sent.filter((item) => item.type === "alert");
    assert.deepEqual(alerts3.map((a) => a.token).sort(), [OWNER2_TOKEN, SARAH_TOKEN].sort(), "Alex is skipped because Alex cannot access bot-mira");
    const owner2Alert = unseal(owner2Paired, alerts3.find((a) => a.token === OWNER2_TOKEN)!.payload.b);
    const sarahAlert = unseal(sarah.pairing, alerts3.find((a) => a.token === SARAH_TOKEN)!.payload.b);
    assert.equal(owner2Alert.m, "Server CPU 99% — check prod", "custom message delivered when previews are on");
    assert.equal(sarahAlert.m, "New message", "custom message is redacted when previews are off");

    // 4. Per-run override mode: "none" suppresses all phone alerts even when routine targets exist.
    sent.length = 0;
    const quietRunId = "run-override-none";
    (backend as any).state.runs.unshift({
      id: quietRunId,
      chatId: routineId,
      title: "Daily Ops",
      time: Date.now(),
      status: "Completed",
      detail: "",
      trigger: "scheduled",
      scheduleId: 1,
      notifyTargets: { mode: "none" },
    });
    (backend as any).changed();
    await delay(300);
    assert.equal(sent.filter((item) => item.type === "alert").length, 0, "mode:none suppresses all phone alerts");
  } finally {
    for (const c of extraClients) c.stop();
    await done();
  }
});
