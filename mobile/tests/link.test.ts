// The phone's link client against the desktop's link host, over real HTTP on loopback.
// Run by `npm test` (tsx); the host is plain JavaScript, so this file is left out of `tsc`.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, LinkError, type LinkState, pair, type Pairing, pushKeyOf } from "../src/link/client";
import { parsePairingUrl } from "../src/link/pairing";
import type { ChatDetail, ChatSummary, Live, Run } from "../src/link/types";

const fetcher = fetch as unknown as FetchLike;
const device = { name: "Test phone", platform: "ios" };

async function host(options: Record<string, unknown> = {}) {
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ relay: false, dir: mkdtempSync(join(tmpdir(), "botkins-link-")), backend, port: 0, extraHosts: ["127.0.0.1"], ...options });
  await link.setEnabled(true);
  return { link, backend };
}
const loopback = (link: { port: number }) => "127.0.0.1:" + link.port;

/** A client that records every part it is sent. */
function follow(pairing: Pairing) {
  const parts: Record<string, unknown> = {};
  const states: LinkState[] = [];
  let waiters: (() => void)[] = [];
  const client = new LinkClient(pairing, {
    fetch: fetcher,
    onParts(next) {
      Object.assign(parts, next);
      for (const wake of waiters) wake();
      waiters = [];
    },
    onState: (state) => states.push(state),
  });
  client.start();
  const until = async (check: () => boolean, what: string, ms = 4000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("Timed out waiting for " + what);
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 50))]);
    }
  };
  return { client, parts, states, until };
}

test("a phone pairs from the QR link, then follows and changes the computer", async () => {
  const { link } = await host();
  const pairing = link.startPairing();
  const target = parsePairingUrl(pairing.url);
  assert.ok(target, "the pairing link parses");
  assert.equal(target.code, pairing.code);
  const paired = await pair(fetcher, { ...target, hosts: [loopback(link)] }, device);
  assert.equal(link.status().devices.length, 1);
  assert.equal(link.status().devices[0].name, "Test phone");
  assert.equal(link.status().pairing, null, "the code is spent");
  // A pairing's keys are worked out once: X25519 in plain JavaScript is slow on the phone, and it
  // used to run again on every reconnect (build 12's CPU reports). The same key comes back each time.
  assert.equal(pushKeyOf(paired), pushKeyOf({ ...paired, hosts: ["10.0.0.9:47610"] }));

  const { client, parts, until } = follow(paired);
  await until(() => !!parts.bots, "the first state");
  const bots = parts.bots as { id: string; name: string }[];
  assert.ok(bots.some((bot) => bot.name === "Mira"));
  assert.ok(Array.isArray(parts.chats) && (parts.chats as ChatSummary[])[0].count > 0);
  assert.equal((parts.chats as unknown as { messages?: unknown }[])[0].messages, undefined, "summaries carry no messages");

  const id = await client.call<string>("addBot", { name: "Nova", role: "Tester", instructions: "Test things.", face: "idle" });
  await until(() => (parts.bots as { id: string }[]).some((bot) => bot.id === id), "the new bot");
  // Every bot has a Botkin. A new bot is given one, and the one a person picks comes back with the bot.
  type Looked = { id: string; look?: { head: string; palette: string } };
  const lookOf = () => (parts.bots as Looked[]).find((bot) => bot.id === id)?.look;
  assert.equal(lookOf()?.palette, "original", "a new bot is given a character");
  assert.equal(new Set((parts.bots as Looked[]).map((bot) => bot.look?.head)).size, (parts.bots as Looked[]).length, "a small team is all different");
  await client.call("link.setLook", id, { head: "sprig", palette: "honey" });
  await until(() => lookOf()?.palette === "honey", "the bot's new look");
  assert.deepEqual(lookOf(), { head: "sprig", palette: "honey" });
  await assert.rejects(client.call("link.setLook", "no-such-bot", { head: "sprig", palette: "honey" }), /no longer exists/);
  await assert.rejects(client.call("link.setLook", id, { head: "../x", palette: "honey" }), /can't be saved/);
  await assert.rejects(client.call("openLink", "https://example.com"), (error: unknown) => error instanceof LinkError && error.code === "remote" && /phone/.test(error.message));
  await assert.rejects(client.call("addBot", { name: "", role: "", instructions: "", face: "idle" }), /name/);
  client.stop();
  await link.stop();
});

test("a watched chat streams a reply and ends with the message", async () => {
  const { link } = await host();
  const paired = await pair(fetcher, { hosts: [loopback(link)], code: link.startPairing().code }, device);
  const { client, parts, until } = follow(paired);
  await until(() => !!parts.chats, "the first state");
  const chatId = await client.call<string>("createChat", "bot-mira");
  client.watch([chatId]);
  await until(() => !!parts["chat:" + chatId], "the chat's detail");
  assert.equal((parts["chat:" + chatId] as ChatDetail).messages.length, 0);

  await client.call("send", chatId, "Plan the launch week");
  const seen = new Set<string>();
  await until(
    () => {
      const live = parts.live as Live;
      if (chatId in live.streams) seen.add(live.streams[chatId] ? "talking" : "thinking");
      const run = parts["run:" + chatId] as Run | null;
      if (run?.steps?.length) seen.add("step");
      return (parts["chat:" + chatId] as ChatDetail).messages.some((m) => m.role === "assistant");
    },
    "the reply",
    8000,
  );
  assert.ok(seen.has("talking"), "the reply streamed");
  const detail = parts["chat:" + chatId] as ChatDetail;
  assert.equal(detail.messages[0].role, "user");
  assert.match(detail.messages[1].text, /launch week/);
  assert.equal(detail.runs.length, 1, "the finished run comes with the messages");
  assert.equal(detail.runs[0].status, "Completed");
  assert.equal(parts["run:" + chatId], null, "no turn is running any more");
  assert.equal((parts.live as Live).streams[chatId], undefined);
  client.stop();
  await link.stop();
});

test("an approval is asked on the phone and answered from it", async () => {
  const { link } = await host();
  const paired = await pair(fetcher, { hosts: [loopback(link)], code: link.startPairing().code }, device);
  const { client, parts, until } = follow(paired);
  await until(() => !!parts.chats, "the first state");
  const chatId = await client.call<string>("createChat", "bot-patch");
  client.watch([chatId]);
  await client.call("send", chatId, "Please approve the deploy");
  await until(() => (parts.live as Live).requests.length > 0, "the approval", 8000);
  const request = (parts.live as Live).requests[0];
  assert.equal(request.kind, "permission");
  await client.call("respond", request.id, { action: "approve" });
  await until(() => !!(parts["chat:" + chatId] as ChatDetail | undefined)?.messages.some((m) => /deploy finished/.test(m.text)), "the reply after approval", 8000);
  assert.equal((parts.live as Live).requests.length, 0);
  client.stop();
  await link.stop();
});

test("a wrong code is refused, and an address that has used its 8 tries is told to wait even with the right code", async () => {
  const { link } = await host();
  const { code } = link.startPairing();
  for (let i = 0; i < 8; i++)
    await assert.rejects(pair(fetcher, { hosts: [loopback(link)], code: "AAAABBBBCCCC" }, device), (error: unknown) => error instanceof LinkError && (error.code === "code" || error.code === "closed"));
  // The code stays open for everyone else: only 200 wrong tries in all withdraw it (tests/relay-host.test.ts).
  assert.ok(link.status().pairing, "the code is still open");
  // An address that has used its 8 tries is told to wait (429 "pair_wait") even with the right code.
  await assert.rejects(pair(fetcher, { hosts: [loopback(link)], code }, device), (error: unknown) => error instanceof LinkError);
  assert.equal(link.status().devices.length, 0);
  await link.stop();
});

test("a QR link for another computer's key doesn't pair", async () => {
  const { link } = await host();
  const other = await host();
  const target = parsePairingUrl(other.link.startPairing().url)!;
  // The other computer's key, this computer's address and code: a computer in the middle.
  await assert.rejects(pair(fetcher, { ...target, hosts: [loopback(link)], code: link.startPairing().code }, device), (error: unknown) => error instanceof LinkError && error.code === "not-found");
  await link.stop();
  await other.link.stop();
});

test("a removed phone is told so, and a replayed message is refused", async () => {
  const { link } = await host();
  const paired = await pair(fetcher, { hosts: [loopback(link)], code: link.startPairing().code }, device);

  // Record one sealed call and play it again.
  let recorded: { url: string; init: Parameters<FetchLike>[1] } | null = null;
  const recording: FetchLike = (url, init) => {
    if (url.endsWith("/rpc")) recorded = { url, init };
    return fetcher(url, init);
  };
  const quiet = new LinkClient(paired, { fetch: recording, onParts() {}, onState() {} });
  assert.ok(Array.isArray(await quiet.call("models")));
  const replay = await fetcher(recorded!.url, recorded!.init);
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: "replay" });

  const { client, states, until } = follow(paired);
  await until(() => states.includes("online"), "online");
  link.removeDevice(paired.deviceId);
  await until(() => states.includes("revoked"), "revoked", 6000);
  await assert.rejects(client.call("models"), (error: unknown) => error instanceof LinkError && error.code === "revoked");
  client.stop();
  await link.stop();
});

test("the computer's identity and phones survive a restart, and a session is renewed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-link-"));
  const first = await host({ dir });
  const paired = await pair(fetcher, { hosts: [loopback(first.link)], code: first.link.startPairing().code }, device);
  const port = first.link.port;
  const quiet = new LinkClient(paired, { fetch: fetcher, onParts() {}, onState() {} });
  assert.ok(await quiet.call("models"));
  await first.link.stop();

  const again = new LinkHost({ relay: false, dir, backend: new MockBackend(), port });
  await again.start();
  // The connection kept open to the old computer has to be seen as closed before the next call.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(again.status().devices.length, 1, "the phone is still paired");
  // The old session is unknown to the restarted computer; the client opens a new one by itself.
  assert.ok(Array.isArray(await quiet.call("models")));
  await again.stop();
});

test("older messages are read a page at a time", async () => {
  const { link, backend } = await host();
  const chat = backend.state.chats[0];
  chat.messages = Array.from({ length: 150 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "message " + i }));
  const paired = await pair(fetcher, { hosts: [loopback(link)], code: link.startPairing().code }, device);
  const { client, parts, until } = follow(paired);
  client.watch([chat.id]);
  await until(() => !!parts["chat:" + chat.id], "the chat");
  const latest = parts["chat:" + chat.id] as ChatDetail;
  assert.equal(latest.total, 150);
  assert.equal(latest.from, 90);
  assert.equal(latest.messages.at(-1)!.text, "message 149");
  const earlier = await client.call<ChatDetail>("link.messages", chat.id, latest.from, 50);
  assert.equal(earlier.from, 40);
  assert.equal(earlier.messages.at(-1)!.text, "message 89");
  client.stop();
  await link.stop();
});

test("a phone at rest follows nothing until it wakes, and its calls still go through", async () => {
  const { link } = await host();
  const pairing = link.startPairing();
  const target = parsePairingUrl(pairing.url)!;
  const paired = await pair(fetcher, { ...target, hosts: [loopback(link)] }, device);
  const { client, parts, until } = follow(paired);
  await until(() => !!parts.bots, "the first state");

  // In the background the phone stops following: a change on the computer reaches it no more.
  client.rest();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const before = (parts.bots as { id: string }[]).length;
  const id = await client.call<string>("addBot", { name: "Rested", role: "Tester", instructions: "Wait.", face: "idle" });
  assert.ok(id, "a call still goes through while at rest");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((parts.bots as { id: string }[]).length, before, "nothing is followed while at rest");

  // Waking follows again and catches up at once.
  client.wake();
  await until(() => (parts.bots as { id: string }[]).some((bot) => bot.id === id), "the change after waking");
  client.stop();
  await link.stop();
});
