import test from "node:test";
import assert from "node:assert/strict";
import { createSlackAdapter } from "../desktop/channels/adapters/slack.mjs";
import { prepareOutboundChunks } from "../desktop/channels/format.mjs";

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  emit(type, payload) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }
}

test("Slack adapter: Socket Mode auth, inbound normalization, deduplication, mrkdwn splitting, threading, and backoff reconnect", async () => {
  const apiCalls = [];
  const sockets = [];
  const statuses = [];
  const inbound = [];

  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    apiCalls.push({ method, auth: init?.headers?.Authorization, body });
    if (method === "auth.test") {
      return { ok: true, status: 200, json: async () => ({ ok: true, user_id: "U_BOT", bot_id: "B_BOT", user: "helperbot", team: "ExampleTeam" }) };
    }
    if (method === "apps.connections.open") {
      return { ok: true, status: 200, json: async () => ({ ok: true, url: `wss://example.slack.test/socket/${sockets.length + 1}` }) };
    }
    if (method === "chat.postMessage") {
      return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1700000000.999" }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const adapter = createSlackAdapter({
    fetch: fetchImpl,
    baseBackoffMs: 15,
    maxBackoffMs: 60,
    createWebSocket: (url) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      queueMicrotask(() => ws.emit("message", { data: JSON.stringify({ type: "hello" }) }));
      return ws;
    },
  });

  await adapter.start({
    secrets: { botToken: "xoxb-fake-bot-token", appToken: "xapp-fake-app-token" },
    onStatus: (s) => statuses.push(s),
    onMessage: (ev) => inbound.push(ev),
  });

  assert.equal(sockets.length, 1);
  assert.equal(statuses.at(-1).state, "connected");
  assert.equal(apiCalls[0].method, "auth.test");
  assert.equal(apiCalls[0].auth, "Bearer xoxb-fake-bot-token");
  assert.equal(apiCalls[1].method, "apps.connections.open");
  assert.equal(apiCalls[1].auth, "Bearer xapp-fake-app-token");

  // 1. DM event normalization + envelope ACK.
  sockets[0].emit("message", {
    data: JSON.stringify({
      envelope_id: "env-dm-1",
      type: "events_api",
      payload: {
        event_id: "Ev-1",
        event: {
          type: "message",
          channel: "D12345",
          channel_type: "im",
          user: "U_ALICE",
          text: "Hello bot!",
          ts: "1700000001.100",
        },
      },
    }),
  });
  assert.deepEqual(sockets[0].sent[0], { envelope_id: "env-dm-1" });
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].channel, "slack");
  assert.equal(inbound[0].conversationId, "D12345");
  assert.equal(inbound[0].threadId, undefined);
  assert.equal(inbound[0].isDirect, true);
  assert.equal(inbound[0].sender.id, "U_ALICE");
  assert.equal(inbound[0].text, "Hello bot!");

  // 2. Group @mention strips bot mention, sets threadId to ts, and deduplicates paired message+app_mention.
  const groupEvent = {
    channel: "C99999",
    channel_type: "channel",
    user: "U_BOB",
    text: "<@U_BOT> summarize the roadmap",
    ts: "1700000002.200",
  };
  sockets[0].emit("message", {
    data: JSON.stringify({
      envelope_id: "env-grp-1",
      type: "events_api",
      payload: { event_id: "Ev-2a", event: { ...groupEvent, type: "app_mention" } },
    }),
  });
  sockets[0].emit("message", {
    data: JSON.stringify({
      envelope_id: "env-grp-2",
      type: "events_api",
      payload: { event_id: "Ev-2b", event: { ...groupEvent, type: "message" } },
    }),
  });
  assert.equal(inbound.length, 2, "Duplicate message+app_mention for same ts must be collapsed");
  assert.equal(inbound[1].isDirect, false);
  assert.equal(inbound[1].mentionsBot, true);
  assert.equal(inbound[1].threadId, "1700000002.200");
  assert.equal(inbound[1].text, "summarize the roadmap");

  // 3. Self message flagged as isSelf.
  sockets[0].emit("message", {
    data: JSON.stringify({
      envelope_id: "env-self",
      type: "events_api",
      payload: {
        event_id: "Ev-3",
        event: { type: "message", channel: "C99999", user: "U_BOT", text: "my own reply", ts: "1700000003.300" },
      },
    }),
  });
  assert.equal(inbound.length, 3);
  assert.equal(inbound[2].isSelf, true);

  // 4. Reply formatting (slack_mrkdwn) + splitting + thread_ts preserved.
  const longMarkdown = "**Summary** with [docs](https://example.com)\n\n" + "line of text\n".repeat(400);
  const chunks = prepareOutboundChunks(longMarkdown, adapter.capabilities);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].includes("*Summary*"));
  assert.ok(chunks[0].includes("<https://example.com|docs>"));
  for (const chunk of chunks) {
    assert.ok(chunk.length <= adapter.capabilities.maxLength);
    await adapter.send({ conversationId: "C99999", threadId: "1700000002.200", text: chunk });
  }
  const posts = apiCalls.filter((c) => c.method === "chat.postMessage");
  assert.equal(posts.length, chunks.length);
  assert.equal(posts[0].body.channel, "C99999");
  assert.equal(posts[0].body.thread_ts, "1700000002.200");

  // 5. Unexpected disconnect triggers reconnecting status + backoff + fresh Socket Mode connection.
  sockets[0].close();
  assert.ok(statuses.some((s) => s.state === "reconnecting"));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sockets.length, 2);
  assert.equal(statuses.at(-1).state, "connected");

  // 6. Future webhook ingress compatibility: url_verification + event_callback.
  const challenge = await adapter.handleWebhook({ rawBody: JSON.stringify({ type: "url_verification", challenge: "xyz-123" }) });
  assert.equal(challenge.status, 200);
  assert.deepEqual(challenge.body, { challenge: "xyz-123" });

  // 7. Test button succeeds cleanly.
  const testRes = await adapter.test({ secrets: { botToken: "xoxb-fake-bot-token", appToken: "xapp-fake-app-token" } });
  assert.equal(testRes.ok, true);

  await adapter.stop();
});

test("Slack adapter: auth error emits CHANNEL_AUTH_ERROR without reconnect loop", async () => {
  const adapter = createSlackAdapter({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "invalid_auth" }) }),
  });

  await assert.rejects(
    () => adapter.start({ secrets: { botToken: "xoxb-bad", appToken: "xapp-bad" }, onStatus: () => {}, onMessage: () => {} }),
    (err) => err.code === "CHANNEL_AUTH_ERROR",
  );
});
