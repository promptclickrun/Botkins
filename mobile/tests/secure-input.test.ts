// A secure input ("secure-input-v1") end to end against the demo computer: a phone pairs over
// loopback, the demo bot asks for one value ("secure password") and for three ("secure login"), the
// phone answers with marker values, and the markers are then looked for everywhere they must never
// be: every part the phone was sent, the chat's messages, runs and steps, the demo's state, and the
// files the computer saved. Run by `npm test` (tsx); the host is plain JavaScript.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { ChatDetail, Live, SecureField } from "../src/link/types";

const fetcher = fetch as unknown as FetchLike;

/** Every file under a folder, as text. */
function filesUnder(dir: string): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push({ path, text: readFileSync(path).toString("latin1") });
  }
  return found;
}

async function paired() {
  const dir = mkdtempSync(join(tmpdir(), "botkins-secure-"));
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  const pairing = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
  // Every part the phone is sent, as it came.
  const sent: string[] = [];
  const parts: Record<string, unknown> = {};
  let waiters: (() => void)[] = [];
  const client = new LinkClient(pairing, {
    fetch: fetcher,
    onParts(next) {
      sent.push(JSON.stringify(next));
      Object.assign(parts, next);
      for (const wake of waiters) wake();
      waiters = [];
    },
    onState: () => {},
  });
  client.start();
  const until = async (check: () => boolean, what: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("Timed out waiting for " + what);
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 50))]);
    }
  };
  await until(() => !!parts.chats, "the first state");
  return { dir, backend, link, client, parts, sent, until };
}

/** Asks the demo bot in a new chat and waits for its secure request. */
async function ask(setup: Awaited<ReturnType<typeof paired>>, prompt: string) {
  const { client, parts, until } = setup;
  const chatId = await client.call<string>("createChat", "bot-mira");
  client.watch([chatId]);
  await client.call("send", chatId, prompt);
  await until(() => (parts.live as Live).requests.some((request) => request.chatId === chatId), "the secure request");
  const request = (parts.live as Live).requests.find((r) => r.chatId === chatId)!;
  return { chatId, request };
}

const replyOf = (parts: Record<string, unknown>, chatId: string) => (parts["chat:" + chatId] as ChatDetail | undefined)?.messages.find((message) => message.role === "assistant")?.text;

test("the demo computer offers a secure input", () => {
  assert.ok(new MockBackend({ speed: 0.05 }).capabilities.includes("secure-input-v1"));
});

test("a secure input's values reach the bot as labels only, and land nowhere", async () => {
  const setup = await paired();
  const { backend, link, client, parts, sent, until, dir } = setup;
  const markers = { single: "MARKER-single-7f3a", user: "MARKER-user-91c2", code: "MARKER-code-5e18", saved: "MARKER-saved-c04d" };
  try {
    // A credential saved on the computer: the phone sends only its reference, and the computer fills it in.
    const saved: string = await link.credentials.save({ name: "Registry", kind: "login", value: markers.saved });
    // One value.
    const one = await ask(setup, "secure password please");
    assert.equal(one.request.kind, "secure");
    assert.deepEqual(one.request.fields, [{ key: "password", label: "Password", kind: "password" }] satisfies SecureField[]);
    await client.call("respond", one.request.id, { action: "accept", content: { password: markers.single } });
    await until(() => !!replyOf(parts, one.chatId), "the reply to one value");
    assert.equal(replyOf(parts, one.chatId), "I have 1 value: Password. I can use it without seeing it.");

    // Three, one of them a saved credential by reference.
    const three = await ask(setup, "secure login for the registry");
    assert.equal(three.request.kind, "secure");
    assert.deepEqual(
      three.request.fields?.map((field) => [field.key, field.label, field.kind, !!field.optional]),
      [
        ["username", "Username", "text", false],
        ["password", "Password", "password", false],
        ["code", "One-time code", "code", true],
      ],
    );
    await client.call("respond", three.request.id, { action: "accept", content: { username: markers.user, password: { $credential: saved }, code: markers.code } });
    await until(() => !!replyOf(parts, three.chatId), "the reply to three values");
    assert.equal(replyOf(parts, three.chatId), "I have 3 values: Username, Password, One-time code. I can use them without seeing them.");
    assert.equal((parts.live as Live).requests.length, 0, "both requests are answered");

    // Let the last turn finish and the computer save what it saves.
    await until(() => !(parts.live as Live).active?.length && !Object.keys((parts.live as Live).streams).length, "the turns to end");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const places: [string, string][] = [
      ["the parts sent to the phone", sent.join("\n")],
      ["the chats' messages, runs and steps", JSON.stringify([parts["chat:" + one.chatId], parts["chat:" + three.chatId], parts["run:" + one.chatId], parts["run:" + three.chatId]])],
      ["the demo's state", JSON.stringify(backend.state)],
      ...filesUnder(dir).map((file): [string, string] => ["the saved file " + file.path, file.text]),
    ];
    // The search sees what is there: the request's title and labels were sent, and files were saved.
    assert.ok(sent.join("\n").includes("Sign in to the registry") && sent.join("\n").includes("One-time code"));
    assert.ok(places.length > 3, "the computer saved files to look in");
    for (const [where, text] of places) for (const marker of Object.values(markers)) assert.equal(text.includes(marker), false, marker + " was found in " + where);
  } finally {
    client.stop();
    await link.stop();
  }
});

test("a declined secure input says so and keeps nothing", async () => {
  const setup = await paired();
  const { client, parts, until, link } = setup;
  try {
    const { chatId, request } = await ask(setup, "secure login");
    await client.call("respond", request.id, { action: "cancel" });
    await until(() => !!replyOf(parts, chatId), "the reply to a decline");
    assert.equal(replyOf(parts, chatId), "No problem. I'll leave it for now.");
  } finally {
    client.stop();
    await link.stop();
  }
});
