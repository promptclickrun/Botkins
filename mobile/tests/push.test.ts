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
import { type FetchLike, LinkClient, pair, type Pairing } from "../src/link/client";
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
    assert.deepEqual(parts.phones[paired.deviceId].push, { replies: true, requests: true, routines: false, previews: true, activities: true });
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
    await call("link.device.sources", { calendar: "read", location: "interact", mail: "read", photos: "interact", nonsense: "interact" });
    await until(() => !!parts.phones[paired.deviceId].sources.calendar, "the switches");
    // Location has nothing to change and Mail nothing to read.
    assert.deepEqual(parts.phones[paired.deviceId].sources, { calendar: "read", location: "read", photos: "interact" });
    const names = link.deviceTools().map((tool: any) => tool.name);
    assert.ok(names.includes("phone_calendar_events") && names.includes("phone_calendar_list") && names.includes("phone_location") && names.includes("phone_photos_get"));
    assert.ok(!names.includes("phone_calendar_create_event"), "read does not include changing");
    assert.ok(!names.includes("phone_mail_compose") && !names.includes("phone_contacts_search"));
    for (const tool of link.deviceTools()) {
      assert.match(tool.name, /^phone_[a-z_]{1,44}$/);
      assert.equal(tool.parameters.type, "object");
      assert.equal(typeof tool.readOnly, "boolean");
    }
    assert.equal(link.deviceTools().find((tool: any) => tool.name === "phone_calendar_events").readOnly, true);
    await call("link.device.sources", { calendar: "interact" });
    assert.ok(link.deviceTools().some((tool: any) => tool.name === "phone_calendar_create_event" && tool.readOnly === false));
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
