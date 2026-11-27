import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { LinkClient, pair, type FetchLike } from "../src/link/client";
import { sendShortcut, shortcutReply } from "../src/features/shortcuts/chat";

test("a shortcut sends over the paired link, returns its final reply, and can also send quietly without waiting", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-shortcut-"));
  const backend = new MockBackend({ speed: 0.03 });
  const host = new LinkHost({ backend, dir, relay: false, port: 0, extraHosts: ["127.0.0.1"] });
  await host.setEnabled(true);
  t.after(async () => { await host.stop(); rmSync(dir, { recursive: true, force: true }); });
  const fetcher = fetch as unknown as FetchLike;
  const pairing = await pair(fetcher, { hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code }, { name: "Shortcuts", platform: "ios" });
  const link = new LinkClient(pairing, { fetch: fetcher, onState() {}, onParts() {} });
  t.after(() => link.stop());
  const request = { prompt: "Plan the launch week", notify: true, wait: true };
  const reply = await sendShortcut(link, request, new AbortController().signal);
  const first = backend.state.chats[0];
  assert.equal(first.botId, backend.state.bots[0].id);
  assert.ok(reply.trim());
  assert.equal(reply, first.messages.at(-1).text);
  const secondBot = backend.state.bots[1];
  const model = (await link.call<any[]>("models")).find(m => m.available && m.efforts.length);
  const key = model.id + "\n" + (model.provider ?? "");
  assert.equal(await sendShortcut(link, { ...request, bot: secondBot.id, model: key, effort: model.efforts[0], notify: false, wait: false }, new AbortController().signal), "");
  const second = backend.state.chats[0];
  assert.notEqual(first.id, second.id);
  assert.equal(second.botId, secondBot.id);
  assert.equal(second.model.model, model.id);
  assert.equal(second.model.reasoningEffort, model.efforts[0]);
  const run = backend.state.runs.find((r: any) => r.chatId === second.id);
  assert.equal(run.status, "Working");
  assert.equal(host.push.kindOf(run, second), null);
  assert.equal(host.push.kindOf(backend.state.runs.find((r: any) => r.chatId === first.id), first), "replies");

  const count = backend.state.chats.length;
  await assert.rejects(sendShortcut(link, { ...request, model: key, effort: "not offered" }, new AbortController().signal), /thinking level/i);
  backend.capabilities = backend.capabilities.filter((item: string) => item !== "quiet-replies-v1");
  backend.changed();
  await assert.rejects(sendShortcut(link, { ...request, notify: false }, new AbortController().signal), /update Botkins/i);
  assert.equal(backend.state.chats.length, count);
});

test("a wait returns only the requested run's final text and reports a failed turn", () => {
  const message = (runId: string, text: string, interim = false) => ({ role: "assistant", runId, text, interim });
  const detail = { messages: [message("r", "thinking", true), message("other", "wrong"), message("r", "answer")], runs: [{ id: "r", status: "Completed" }] };
  assert.equal(shortcutReply(detail as any, "r"), "answer");
  assert.equal(shortcutReply({ ...detail, runs: [] } as any, "r"), undefined);
  assert.throws(() => shortcutReply({ ...detail, runs: [{ id: "r", status: "Failed", detail: "Provider offline" }] } as any, "r"), /Provider offline/);
});

test("Push.kindOf suppresses channel chat reply pushes unless the connection's notifyPhone policy is true", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-channel-push-"));
  const backend = new MockBackend({ speed: 0.03 }) as any;
  const host = new LinkHost({ backend, dir, relay: false, port: 0, extraHosts: ["127.0.0.1"] });
  t.after(async () => { await host.stop(); rmSync(dir, { recursive: true, force: true }); });

  backend.state.channels = [
    { id: "ch_quiet", kind: "telegram", label: "Quiet", policy: { dm: "pairing", notifyPhone: false } },
    { id: "ch_legacy", kind: "slack", label: "Legacy", policy: { dm: "pairing" } },
    { id: "ch_loud", kind: "telegram", label: "Loud", policy: { dm: "pairing", notifyPhone: true } },
  ];

  const run = { id: "run-1", chatId: "chat-1", status: "Completed", time: 1 };
  const scheduledRun = { id: "run-2", chatId: "chat-1", status: "Completed", trigger: "scheduled", time: 2 };
  const normalChat = { id: "chat-normal", botId: backend.state.bots[0].id, title: "Normal" };
  const quietChat = { id: "chat-1", botId: backend.state.bots[0].id, title: "Quiet: Alice", channel: { connectionId: "ch_quiet", kind: "telegram" } };
  const legacyChat = { id: "chat-2", botId: backend.state.bots[0].id, title: "Legacy: Bob", channel: { connectionId: "ch_legacy", kind: "slack" } };
  const loudChat = { id: "chat-3", botId: backend.state.bots[0].id, title: "Loud: Cara", channel: { connectionId: "ch_loud", kind: "telegram" } };
  const missingChat = { id: "chat-4", botId: backend.state.bots[0].id, title: "Removed: Dan", channel: { connectionId: "ch_gone", kind: "discord" } };

  assert.equal(host.push.kindOf(run, quietChat), null);
  assert.equal(host.push.kindOf(run, legacyChat), null);
  assert.equal(host.push.kindOf(run, missingChat), null);
  assert.equal(host.push.kindOf(run, loudChat), "replies");
  assert.equal(host.push.kindOf(scheduledRun, quietChat), "routines");
  assert.equal(host.push.kindOf(run, normalChat), "replies");
});
