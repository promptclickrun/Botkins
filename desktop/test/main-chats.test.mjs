import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace, starterBots } from "./starter.mjs";
import { ModelProvider, ProviderSession, Providers } from "../desktop/providers/index.mjs";
import { resolvePrompt, buildInventory } from "../desktop/providers/commands.mjs";
import { chatPart } from "../desktop/link/parts.mjs";

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("migration gives each bot's creator a private Main chat and preserves every existing conversation", async t => {
  const dir = folder(t);
  const legacy = { id: "before", botId: "pip", title: "Main chat", messages: [{ role: "user", text: "A project" }], projectId: "p" };
  writeFileSync(join(dir, "workspace.json"), JSON.stringify({ bots: [starterBots[0], { ...starterBots[1], createdBy: "member" }], chats: [legacy, { ...legacy, id: "member-thread", createdBy: "member" }], runs: [] }));
  const open = () => new Workspace(dir, async () => ({}), () => {});
  const ws = open();
  const rows = ws.state.chats.filter(c => c.main);
  assert.deepEqual(rows.map(c => [c.botId, c.createdBy]).sort(), [["pip", undefined], ["pip", "member"], ["scout", "member"]]);
  assert.deepEqual(ws.chat("before"), legacy);
  const id = ws.mainChat("pip");
  const other = ws.mainChat("pip", "member");
  const created = ws.addBot({ name: "A", role: "Helper", instructions: "Help" });
  const copy = ws.agents.duplicateBot(created);
  for (const botId of [created, copy]) assert.ok(ws.state.chats.some(c => c.main && c.botId === botId));
  const newId = ws.createChat("pip");
  assert.equal(new Set([id, newId, other, "before"]).size, 4);
  assert.equal(ws.chat(other).createdBy, "member");
  assert.throws(() => ws.agents.setChatFlags(id, { archived: true }), /Main chat/);
  await assert.rejects(ws.agents.deleteChat(id), /Main chat/);
  assert.throws(() => ws.agents.renameChat(id, "Something else"), /Main chat/);
  const reopened = open();
  assert.equal(reopened.mainChat("pip"), id);
  assert.equal(reopened.mainChat("pip", "member"), other);
  assert.equal(reopened.state.chats.length, ws.state.chats.length);
});

test("Main chat keeps its address through compact, provider changes, fork switches, reset and restart", async t => {
  const dir = folder(t);
  const opened = [], compacted = [], prompts = [];
  const registry = new Providers(["copilot", "codex"].map(id => new class extends ModelProvider {
    id = id;
    name = id;
    async status() { return { connected: true }; }
    async models() { return [{ id: "model", name: "Model", available: true }]; }
    async openSession(spec) {
      opened.push({ provider: id, spec });
      return new class extends ProviderSession {
        async inventory() { return buildInventory({ name: id, compact: true }); }
        async compact() { compacted.push(spec.sessionId); }
        resolvePrompt(...args) { return resolvePrompt(this, ...args); }
        // (It answers the message, the last paragraph: a transcript Botkins sends before one isn't repeated.)
        async send({ prompt }) { prompts.push(prompt); return { text: "reply to " + prompt.split("\n\n").at(-1) }; }
      }();
    }
  }()));
  const load = () => new Workspace(dir, registry, () => {});
  let ws = load();
  ws.setPreferences({ harness: "provider" });
  const id = ws.state.chats.find(c => c.main && c.botId === "pip")?.id;
  assert.ok(id, "migration supplied a Main chat");
  const chat = ws.chat(id);
  await ws.send(id, "original only");
  assert.equal(chat.title, "Main chat");
  const delivery = { text: "Signal waiting for a reply", from: "Pip", time: Date.now() };
  chat.posted = [delivery];
  await ws.compact(id);
  assert.deepEqual(chat.posted, [delivery], "native compaction did not consume a delivered signal");
  assert.equal(ws.state.runs[0].chatId, id);
  assert.deepEqual(compacted, [id]);
  const original = chat.activeFork;
  await ws.changeMainFork(id, "fork", 1);
  const fork = chat.activeFork;
  assert.notEqual(fork, original);
  await assert.rejects(ws.changeMainFork(id, "reset", undefined, original), /active fork changed/);
  assert.deepEqual(chat.messages.map(m => m.text), ["original only", "reply to original only"]);
  await ws.send(id, "fork only");
  const forkSession = opened.at(-1).spec.sessionId;
  await ws.setModel("chat", id, { provider: "codex", model: "model" });
  await ws.send(id, "continue");
  assert.equal(opened.at(-1).provider, "codex");
  // The fork's conversation comes with the new session's first message, never in its system prompt.
  assert.doesNotMatch(opened.at(-1).spec.instructions, /earlier-conversation|fork only/);
  assert.match(prompts.at(-1), /<earlier-conversation>[\s\S]*fork only[\s\S]*<\/earlier-conversation>\n\ncontinue$/);
  await ws.changeMainFork(id, "reset");
  assert.equal(chat.messages.length, 0);
  await ws.send(id, "after reset");
  assert.doesNotMatch(opened.at(-1).spec.instructions, /earlier-conversation|fork only/);
  assert.doesNotMatch(prompts.at(-1), /earlier-conversation|fork only/);
  assert.notEqual(opened.at(-1).spec.sessionId, forkSession);
  ws = load();
  assert.equal(ws.mainChat("pip"), id);
  assert.ok(!JSON.stringify(ws.snapshot().chats.find(c => c.id === id)).includes("fork only"), "inactive histories are kept off the wire");
  await ws.changeMainFork(id, "switch", fork);
  assert.equal(chatPart(ws.snapshot(), id).messages.at(-1).text, "reply to continue");
  await ws.send(id, "still on fork");
  assert.equal(opened.at(-1).spec.sessionId, forkSession);
  await ws.changeMainFork(id, "switch", original);
  await ws.send(id, "Answer that signal");
  assert.match(prompts.at(-1), /Since your last turn[\s\S]*Signal waiting for a reply/);
  assert.equal(ws.chat(id).posted, undefined);
  assert.ok(ws.chat(id).messages.some(m => m.text === "/compact"));
  assert.ok(!ws.chat(id).messages.some(m => m.text === "fork only"));
  assert.equal(ws.state.chats.filter(c => c.botId === "pip").length, 1);
  const ordinary = await ws.forkChat(id, 1);
  assert.notEqual(ordinary, id);
  assert.ok(!ws.chat(ordinary).main);
});
