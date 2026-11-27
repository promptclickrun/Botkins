import test from "node:test";
import assert from "node:assert/strict";
import { createDiscordAdapter, DISCORD_INTENTS } from "../desktop/channels/adapters/discord.mjs";
import { prepareOutboundChunks } from "../desktop/channels/format.mjs";

class FakeDiscordSocket {
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
  send(raw) {
    const parsed = JSON.parse(raw);
    this.sent.push(parsed);
    if (parsed.op === 2) {
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            d: {
              user: { id: "BOT_100", username: "botkins_demo" },
              session_id: "sess-abc",
              resume_gateway_url: "wss://resume.discord.test",
            },
          }),
        });
      });
    } else if (parsed.op === 6) {
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ op: 0, s: 5, t: "RESUMED", d: {} }),
        });
      });
    }
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}

test("Discord adapter: Gateway identify with Message Content intent, normalization, splitting, threading, typing, and resume reconnect", async () => {
  const apiCalls = [];
  const sockets = [];
  const statuses = [];
  const inbound = [];

  const fetchImpl = async (url, init) => {
    const path = url.replace("https://discord.com/api/v10", "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    apiCalls.push({ method: init?.method || "GET", path, auth: init?.headers?.Authorization, body });

    if (path === "/gateway/bot") {
      return { ok: true, status: 200, json: async () => ({ url: "wss://gateway.discord.test" }) };
    }
    if (path === "/users/@me") {
      return { ok: true, status: 200, json: async () => ({ id: "BOT_100", username: "botkins_demo" }) };
    }
    if (path.endsWith("/typing")) {
      return { ok: true, status: 204 };
    }
    if (path.endsWith("/messages")) {
      return { ok: true, status: 200, json: async () => ({ id: "msg-out-" + apiCalls.length }) };
    }
    throw new Error(`Unexpected Discord path: ${path}`);
  };

  const adapter = createDiscordAdapter({
    fetch: fetchImpl,
    baseBackoffMs: 15,
    maxBackoffMs: 60,
    createWebSocket: (url) => {
      const ws = new FakeDiscordSocket(url);
      sockets.push(ws);
      queueMicrotask(() => {
        ws.emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }) });
      });
      return ws;
    },
  });

  await adapter.start({
    secrets: { botToken: "discord-fake-bot-token" },
    onStatus: (s) => statuses.push(s),
    onMessage: (ev) => inbound.push(ev),
  });

  assert.equal(sockets.length, 1);
  assert.equal(statuses.at(-1).state, "connected");
  // Verify IDENTIFY sent with Message Content intent (1 << 15).
  const identify = sockets[0].sent.find((f) => f.op === 2);
  assert.ok(identify, "Expected OP 2 IDENTIFY");
  assert.equal(identify.d.intents, DISCORD_INTENTS);
  assert.ok((identify.d.intents & (1 << 15)) !== 0, "Message Content intent must be enabled");

  // 1. DM message normalization.
  sockets[0].emit("message", {
    data: JSON.stringify({
      op: 0,
      s: 2,
      t: "MESSAGE_CREATE",
      d: {
        id: "M-DM-1",
        channel_id: "DM-CH-1",
        author: { id: "U-1", global_name: "Alice", username: "alice" },
        content: "Hello on Discord!",
        timestamp: "2026-01-01T12:00:00.000Z",
      },
    }),
  });
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].channel, "discord");
  assert.equal(inbound[0].conversationId, "DM-CH-1");
  assert.equal(inbound[0].isDirect, true);
  assert.equal(inbound[0].threadId, undefined);
  assert.equal(inbound[0].sender.display, "Alice");
  assert.equal(inbound[0].text, "Hello on Discord!");

  // 2. Guild @mention strips <@!BOT_100> and preserves reply threadId.
  sockets[0].emit("message", {
    data: JSON.stringify({
      op: 0,
      s: 3,
      t: "MESSAGE_CREATE",
      d: {
        id: "M-GUILD-1",
        guild_id: "G-1",
        channel_id: "CH-GENERAL",
        author: { id: "U-2", username: "bob" },
        mentions: [{ id: "BOT_100" }],
        content: "<@!BOT_100> help with CI",
        timestamp: "2026-01-01T12:01:00.000Z",
      },
    }),
  });
  assert.equal(inbound.length, 2);
  assert.equal(inbound[1].isDirect, false);
  assert.equal(inbound[1].mentionsBot, true);
  assert.equal(inbound[1].threadId, "reply:M-GUILD-1");
  assert.equal(inbound[1].text, "help with CI");

  // 3. Long reply splits under 1950 chars, sends typing, and threads via message_reference.
  const longText = "Discord update: " + "word ".repeat(500);
  const chunks = prepareOutboundChunks(longText, adapter.capabilities);
  assert.ok(chunks.length >= 2);
  await adapter.typing({ conversationId: "CH-GENERAL" });
  for (const chunk of chunks) {
    assert.ok(chunk.length <= adapter.capabilities.maxLength);
    await adapter.send({ conversationId: "CH-GENERAL", threadId: "reply:M-GUILD-1", text: chunk });
  }
  const msgCalls = apiCalls.filter((c) => c.path === "/channels/CH-GENERAL/messages");
  assert.equal(msgCalls.length, chunks.length);
  assert.equal(msgCalls[0].body.message_reference.message_id, "M-GUILD-1");
  assert.ok(apiCalls.some((c) => c.path === "/channels/CH-GENERAL/typing"));

  // 4. Gateway drop triggers backoff reconnect and OP 6 RESUME against resume_gateway_url.
  sockets[0].close(1006, "network drop");
  assert.ok(statuses.some((s) => s.state === "reconnecting"));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sockets.length, 2);
  assert.ok(sockets[1].url.startsWith("wss://resume.discord.test"));
  assert.ok(sockets[1].sent.some((f) => f.op === 6 && f.d.session_id === "sess-abc" && f.d.seq === 3));
  assert.equal(statuses.at(-1).state, "connected");

  // 5. Connection test works.
  const testRes = await adapter.test({ secrets: { botToken: "discord-fake-bot-token" } });
  assert.equal(testRes.ok, true);

  await adapter.stop();
});

test("Discord adapter: close code 4014 (disallowed Message Content intent) emits auth_error without reconnect loop", async () => {
  const statuses = [];
  const adapter = createDiscordAdapter({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ url: "wss://gateway.discord.test" }) }),
    createWebSocket: (url) => {
      const ws = new FakeDiscordSocket(url);
      queueMicrotask(() => ws.close(4014, "Disallowed intent"));
      return ws;
    },
  });

  await assert.rejects(
    () => adapter.start({ secrets: { botToken: "discord-token" }, onStatus: (s) => statuses.push(s), onMessage: () => {} }),
    (err) => err.code === "CHANNEL_AUTH_ERROR" && /Message Content Intent/i.test(err.message),
  );
  assert.equal(statuses.at(-1).state, "auth_error");
});
