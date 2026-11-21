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
