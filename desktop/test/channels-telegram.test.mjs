import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramAdapter } from "../desktop/channels/adapters/telegram.mjs";
import { prepareOutboundChunks } from "../desktop/channels/format.mjs";

async function waitFor(predicate, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for condition");
}

test("Telegram adapter: getUpdates long polling, normalization, HTML splitting, threading, typing, and backoff reconnect", async () => {
  const calls = [];
  const statuses = [];
  const inbound = [];
  let pollCount = 0;

  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });

    if (method === "getMe") {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 9001, is_bot: true, username: "example_helper_bot" } }) };
    }
    if (method === "getUpdates") {
      pollCount += 1;
      if (pollCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 100,
                message: {
                  message_id: 10,
                  date: 1700000001,
                  chat: { id: 55501, type: "private" },
                  from: { id: 55501, is_bot: false, first_name: "Alice", last_name: "Test" },
                  text: "Hi from DM",
                },
              },
              {
                update_id: 101,
                message: {
                  message_id: 22,
                  message_thread_id: 77,
                  date: 1700000002,
                  chat: { id: -100999, type: "supergroup" },
                  from: { id: 55502, is_bot: false, username: "bob_user" },
                  text: "@example_helper_bot check status",
                  entities: [{ type: "mention", offset: 0, length: 19 }],
                },
              },
            ],
          }),
        };
      }
      if (pollCount === 2) {
        // Simulate transient server error -> triggers reconnect with backoff.
        return { ok: false, status: 502, json: async () => ({ ok: false, error_code: 502, description: "Bad Gateway" }) };
      }
      if (pollCount === 3) {
        // Recover cleanly, verify offset advanced to 102.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 102,
                message: {
                  message_id: 25,
                  date: 1700000005,
                  chat: { id: -100999, type: "group" },
                  from: { id: 55503, is_bot: false, first_name: "Carol" },
                  reply_to_message: { message_id: 24, from: { id: 9001, is_bot: true } },
                  text: "Follow up via reply",
                },
              },
            ],
          }),
        };
      }
      // Block until aborted by stop().
      return new Promise((_, reject) => {
        const abort = () => {
          const e = new Error("Aborted");
          e.name = "AbortError";
          reject(e);
        };
        if (init?.signal?.aborted) return abort();
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (method === "sendMessage") {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 800 + calls.length } }) };
    }
    if (method === "sendChatAction") {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    }
    throw new Error(`Unexpected Telegram call: ${method}`);
  };

  const adapter = createTelegramAdapter({
    fetch: fetchImpl,
    pollTimeoutSec: 0,
    baseBackoffMs: 15,
    maxBackoffMs: 50,
  });

  await adapter.start({
    secrets: { botToken: "123456:FAKE_TELEGRAM_TOKEN" },
    onStatus: (s) => statuses.push(s),
    onMessage: (ev) => inbound.push(ev),
  });

  await waitFor(() => inbound.length === 3);

  // 1. DM normalized.
  assert.equal(inbound[0].channel, "telegram");
  assert.equal(inbound[0].conversationId, "55501");
  assert.equal(inbound[0].isDirect, true);
  assert.equal(inbound[0].sender.id, "55501");
  assert.equal(inbound[0].sender.display, "Alice Test");
  assert.equal(inbound[0].text, "Hi from DM");

  // 2. Supergroup forum topic @mention stripped & topic threadId preserved.
  assert.equal(inbound[1].isDirect, false);
  assert.equal(inbound[1].mentionsBot, true);
  assert.equal(inbound[1].threadId, "topic:77");
  assert.equal(inbound[1].text, "check status");

  // 3. Reconnect with backoff happened after 502, and offset advanced to 102, and reply-to-bot counts as mention.
  assert.ok(statuses.some((s) => s.state === "reconnecting"));
  assert.equal(statuses.at(-1).state, "connected");
  const poll3 = calls.filter((c) => c.method === "getUpdates")[2];
  assert.equal(poll3.body.offset, 102);
  assert.equal(inbound[2].mentionsBot, true);
  assert.equal(inbound[2].threadId, "reply:25");

  // 4. HTML conversion, splitting, topic & reply threading, and typing indicator.
  const md = "**Bold** and `code` and [link](https://example.com)\n\n" + "paragraph text ".repeat(350);
  const chunks = prepareOutboundChunks(md, adapter.capabilities);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].includes("<b>Bold</b>"));
  assert.ok(chunks[0].includes("<code>code</code>"));
  assert.ok(chunks[0].includes('<a href="https://example.com">link</a>'));

  await adapter.typing({ conversationId: "-100999", threadId: "topic:77" });
  for (const chunk of chunks) {
    assert.ok(chunk.length <= adapter.capabilities.maxLength);
    await adapter.send({ conversationId: "-100999", threadId: "topic:77", text: chunk });
  }
  await adapter.send({ conversationId: "-100999", threadId: "reply:25", text: "Reply in thread" });

  const sends = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sends[0].body.parse_mode, "HTML");
  assert.equal(sends[0].body.message_thread_id, 77);
  assert.deepEqual(sends.at(-1).body.reply_parameters, { message_id: 25 });
  assert.ok(calls.some((c) => c.method === "sendChatAction" && c.body.action === "typing" && c.body.message_thread_id === 77));

  // 5. Token never leaked in error status.
  assert.ok(statuses.every((s) => !String(s.detail || "").includes("FAKE_TELEGRAM_TOKEN")));

  await adapter.stop();
});

test("Telegram adapter: invalid token throws CHANNEL_AUTH_ERROR without leaking token", async () => {
  const token = "999999:SUPER_SECRET_SENTINEL";
  const adapter = createTelegramAdapter({
    fetch: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error_code: 401, description: `Unauthorized for ${token}` }),
    }),
  });

  await assert.rejects(
    () => adapter.start({ secrets: { botToken: token }, onStatus: () => {}, onMessage: () => {} }),
    (err) => err.code === "CHANNEL_AUTH_ERROR" && !err.message.includes(token),
  );
});
