// The phone's link client against the desktop's link host, over real HTTP on loopback.
// Run by `npm test` (tsx); the host is plain JavaScript, so this file is left out of `tsc`.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, LinkError, type LinkState, pair, type Pairing } from "../src/link/client";
import { parsePairingUrl } from "../src/link/pairing";
import type { ChatDetail, ChatSummary, Live, Run } from "../src/link/types";
import { PROTON_CAPABILITY, sendProtonPassword, supportsProtonSetup } from "../src/link/proton-pass";

import { VoiceHistoryWriter } from "../src/features/voice/live/history";

const fetcher = fetch as unknown as FetchLike;
const device = { name: "Test phone", platform: "ios" };

async function host(options: Record<string, unknown> = {}) {
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ relay: false, dir: mkdtempSync(join(tmpdir(), "botkins-link-")), backend, port: 0, extraHosts: ["127.0.0.1"], ...options });
  await link.setEnabled(true);
  return { link, backend };
}
const loopback = (link: { port: number }) => "127.0.0.1:" + link.port;

test("a cold background link makes no request until it is explicitly woken", async (t) => {
  const { link } = await host();
  t.after(() => link.stop());
  const paired = await pair(fetcher, { hosts: [loopback(link)], code: link.startPairing().code }, device);
  let requests = 0;
  const synced = Promise.withResolvers<void>();
  const client = new LinkClient(paired, {
    fetch(url, init) { requests++; return fetcher(url, init); },
    onParts() {},
    onState() {},
    onSync: () => synced.resolve(),
  });
  t.after(() => client.stop());
  client.start({ resting: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests, 0);
  client.wake();
  await synced.promise;
  assert.ok(requests > 0);
  client.rest();
});

test("Proton Pass setup is negotiated, and the demo can install and share a selected vault", async (t) => {
  assert.equal(supportsProtonSetup(["credentials-v1"]), false);
  const old = await host({ backend: new MockBackend({ proton: false }) });
  t.after(() => old.link.stop());
  assert.equal(supportsProtonSetup(old.link.meta().capabilities), false);
  const { link } = await host();
  t.after(() => link.stop());
  const paired = await pair(fetcher, { hosts: [loopback(link)], code: link.startPairing().code }, device);
  const client = new LinkClient(paired, { fetch: fetcher });
  assert.ok(link.meta().capabilities.includes(PROTON_CAPABILITY));
  const plan = await client.call("link.credentials.protonPassInstallPlan");
  await assert.rejects(client.call("link.credentials.protonPassInstall", { sha256: "wrong" }), /review/i);
  const install = await client.call("link.credentials.protonPassInstall", { sha256: plan.sha256 });
  assert.equal((await client.call("link.credentials.protonPassSignInRead", install)).done, false);
  assert.equal((await client.call("link.credentials.protonPassSignInRead", install)).result?.state, "signed-out");
  const signIn = await client.call("link.credentials.protonPassSignInStart", {});
  const open = await client.call("link.credentials.protonPassSignInRead", signIn);
  assert.ok(open.events.some((event) => event.type === "open"));
  const prep = await client.call("link.credentials.protonPassSignInRead", { ...signIn, after: open.next });
  const choice = prep.events.find((event) => event.type === "choose-vaults");
  assert.ok(choice && choice.type === "choose-vaults");
  await client.call("link.credentials.protonPassSignInInput", { ...signIn, vaultIds: [choice.vaults[0].id] });
  const done = await client.call("link.credentials.protonPassSignInRead", { ...signIn, after: prep.next });
  assert.deepEqual(done.result?.sharedVaults, [choice.vaults[0].name]);
  assert.equal(done.done, true);
  assert.deepEqual(await client.call("link.credentials.vaults", "protonpass"), [{ id: choice.vaults[0].id, name: choice.vaults[0].name }]);
});

test("Proton Pass extra-password fields clear before awaiting a send, even when the send fails", async () => {
  let field = "test-password";
  await assert.rejects(sendProtonPassword(
    () => field,
    () => { field = ""; },
    async (password) => {
      assert.equal(password, "test-password");
      assert.equal(field, "");
      throw new Error("didn't send");
    },
  ), /didn't send/);
  assert.equal(field, "");
});

test("the phone link host and desktop share the same Proton Pass driver and implementation", () => {
  for (const file of ["managers.mjs", "proton-setup.mjs", "proton-login.mjs", "proton-install.mjs", "proton-pins.mjs"]) {
    assert.equal(readFileSync(new URL("../link-host/" + file, import.meta.url), "utf8"),
      readFileSync(new URL("../../desktop/desktop/link/" + file, import.meta.url), "utf8"), file);
  }
});

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

test("closing a screen read after its HTTP headers aborts the frame body", async t => {
  const { link } = await host();
  t.after(() => link.stop());
  const target = parsePairingUrl(link.startPairing().url)!;
  const paired = await pair(fetcher, { ...target, hosts: [loopback(link)] }, device);
  const reading = Promise.withResolvers<void>();
  const body = Promise.withResolvers<ArrayBuffer>();
  let transport: AbortSignal | undefined;
  const client = new LinkClient(paired, {
    fetch: async (url, init) => {
      if (!url.endsWith("/rpc")) return fetcher(url, init);
      transport = init?.signal;
      return { ok: true, status: 200, arrayBuffer: () => { reading.resolve(); return body.promise; }, json: async () => ({}) };
    },
    onState() {}, onParts() {},
  });
  t.after(() => client.stop());
  const viewer = new AbortController();
  const frame = client.callWithSignal("link.screen.frame", viewer.signal, {});
  await reading.promise;
  viewer.abort();
  // A suspended native transport may never finish the body itself.
  try {
    assert.equal(transport?.aborted, true);
  } finally {
    body.resolve(new ArrayBuffer(0));
    await assert.rejects(frame);
  }
});

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

test("live microphone text reaches the watched chat before final and keeps one row", async t => {
  const { link } = await host();
  t.after(() => link.stop());
  const paired = await pair(fetcher, { hosts: [loopback(link)], code: link.startPairing().code }, device);
  const { client, parts, until } = follow(paired);
  t.after(() => client.stop());
  await until(() => !!parts.chats, "the first state");
  const chatId = await client.call<string>("createChat", "bot-mira");
  client.watch([chatId]);
  const detail = () => parts["chat:" + chatId] as ChatDetail | undefined;
  const writer = new VoiceHistoryWriter(
    line => client.call<void>("recordVoiceLine", chatId, line.id, line.text, line.final),
    () => assert.fail("the transcript could not be saved"),
  );
  const line = { who: "you" as const, id: "call:u1", final: false, text: "Is it four" };
  writer.put(line);
  await until(() => detail()?.messages[0]?.text === line.text, "partial speech in the watched chat");
  writer.put({ ...line, text: "Is it Friday?", final: true });
  await until(() => detail()?.messages[0]?.text === "Is it Friday?", "the corrected final");
  assert.equal(detail()?.messages.length, 1);
  assert.equal(detail()?.messages[0].voicePartial, undefined);
  assert.equal(detail()?.runs.length, 0);
});

test("the watched chat receives the voice's partial reply and final on one assistant row", async t => {
  const { link } = await host();
  t.after(() => link.stop());
  const paired = await pair(fetcher, { hosts: [loopback(link)], code: link.startPairing().code }, device);
  const { client, parts, until } = follow(paired);
  t.after(() => client.stop());
  await until(() => !!parts.chats, "the first state");
  const chat = await client.call<string>("createChat", "bot-mira");
  client.watch([chat]);
  const messages = () => (parts["chat:" + chat] as ChatDetail | undefined)?.messages;
  await client.call("recordVoiceLine", chat, "call:u", "Hello", true);
  // Only the provider handshake is a stand-in. Session registration and dispatch use the real link.
  link.voice.liveGemini = async () => ({ id: "call", kind: "gemini-ws" });
  await client.call("link.voice.live", { provider: "gemini", chatId: chat, botId: "bot-mira" });
  await assert.rejects(client.call("recordVoiceLine", chat, "other:a", "Wrong call", true, { role: "assistant", sessionId: "call" }), /doesn't belong/);
  const write = (text: string, final: boolean) => client.call("recordVoiceLine", chat, "call:a", text, final, { role: "assistant", sessionId: "call" });
  await write("Hi", false);
  await until(() => messages()?.length === 2, "the growing reply");
  assert.deepEqual(messages()?.map(m => [m.role, m.text]), [["user", "Hello"], ["assistant", "Hi"]]);
  await write("Hi there.", true);
  await until(() => messages()?.[1]?.text === "Hi there.", "the final words");
  assert.equal(messages()?.length, 2);
});

test("manual retry transitions offline back through connecting and reconnects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-link-"));
  const first = await host({ dir });
  const port = first.link.port;
  const paired = await pair(fetcher, { hosts: [loopback(first.link)], code: first.link.startPairing().code }, device);
  await first.link.stop();

  const { client, states, until } = follow(paired);
  await until(() => states.at(-1) === "offline", "initial offline", 6000);

  const beforeFailRetry = states.length;
  client.wake("retry");
  assert.equal(states[beforeFailRetry], "connecting", "manual retry enters connecting immediately");
  await until(() => states.length > beforeFailRetry + 1 && states.at(-1) === "offline", "offline after failed retry", 6000);

  const again = new LinkHost({ relay: false, dir, backend: new MockBackend(), port });
  await again.start();
  const beforeSuccessRetry = states.length;
  client.wake("retry");
  assert.equal(states[beforeSuccessRetry], "connecting", "manual retry enters connecting before reconnecting");
  await until(() => states.at(-1) === "online", "online after manual retry", 6000);

  client.stop();
  await again.stop();
});
