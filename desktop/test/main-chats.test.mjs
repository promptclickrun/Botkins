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
  // Reset clears the bot's context and keeps the conversation on screen, in the same fork.
  const forks = chat.forks.length;
  await ws.changeMainFork(id, "reset");
  assert.equal(chat.activeFork, fork);
  assert.equal(chat.forks.length, forks, "reset adds no fork");
  assert.ok(chat.messages.some(m => m.text === "fork only"), "earlier messages stay visible");
  assert.equal(chat.messages.at(-1).role, "command");
  await ws.send(id, "after reset");
  assert.doesNotMatch(opened.at(-1).spec.instructions, /earlier-conversation|fork only/);
  assert.doesNotMatch(prompts.at(-1), /earlier-conversation|fork only/);
  ws = load();
  assert.equal(ws.mainChat("pip"), id);
  assert.equal(chatPart(ws.snapshot(), id).messages.at(-1).text, "reply to after reset");
  await ws.send(id, "still on fork");
  assert.doesNotMatch(prompts.at(-1), /fork only/, "the cleared context stays cleared after a restart");
  await ws.changeMainFork(id, "switch", original);
  assert.ok(!JSON.stringify(ws.snapshot().chats.find(c => c.id === id)).includes("fork only"), "inactive histories are kept off the wire");
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

test("a Main chat is only replaced when its person archives or deletes it; /new and /clear clear its context in place", async t => {
  const dir = folder(t);
  const prompts = [];
  const registry = new Providers([new class extends ModelProvider {
    id = "copilot";
    name = "copilot";
    async status() { return { connected: true }; }
    async models() { return [{ id: "model", name: "Model", available: true }]; }
    async openSession() {
      return new class extends ProviderSession {
        async inventory() { return buildInventory({ name: "copilot" }); }
        resolvePrompt(...args) { return resolvePrompt(this, ...args); }
        async send({ prompt }) { prompts.push(prompt); return { text: "ok" }; }
      }();
    }
  }()]);
  const ws = new Workspace(dir, registry, () => {});
  const id = ws.mainChat("pip");
  const member = ws.mainChat("pip", "m_1");
  await ws.send(id, "remember the plan");
  for (const typed of ["/new", "/clear"]) {
    await ws.submit(id, typed);
    assert.equal(ws.mainChat("pip"), id, typed + " keeps the same Main chat");
    assert.ok(ws.chat(id).messages.some(m => m.text === "remember the plan"), typed + " keeps the messages on screen");
    assert.equal(ws.chat(id).forks.length, 1, typed + " adds no fork");
  }
  await ws.send(id, "what plan?");
  assert.doesNotMatch(prompts.at(-1), /remember the plan/, "the bot starts fresh after /new");
  assert.equal(ws.state.chats.filter(c => c.main && c.botId === "pip" && !c.createdBy).length, 1);
  // A task notice goes to the owner's Main chat, never to a member's.
  const target = ws.state.chats.find(c => c.botId === "pip" && c.main && !c.createdBy);
  assert.equal(target.id, id);
  // Archiving retires it: it stays as an ordinary chat, and the next visit makes a new Main chat.
  ws.agents.setChatFlags(id, { archived: true });
  const retired = ws.chat(id);
  assert.ok(!retired.main && retired.archived);
  assert.ok(retired.messages.some(m => m.text === "remember the plan"));
  const next = ws.mainChat("pip");
  assert.notEqual(next, id);
  ws.agents.setChatFlags(id, { archived: false });
  assert.equal(ws.mainChat("pip"), next, "restoring the old one never makes two Main chats");
  assert.equal(ws.mainChat("pip", "m_1"), member, "another person's Main chat is untouched");
  // Deleting is allowed too.
  await ws.agents.deleteChat(next);
  const third = ws.mainChat("pip");
  assert.ok(![id, next].includes(third));
  assert.equal(ws.state.chats.filter(c => c.main && c.botId === "pip" && !c.createdBy).length, 1);
});

test("/reload-tools reconnects a chat's tools: its harness starts afresh at the next turn, and the conversation stays", async t => {
  const dir = folder(t);
  const opened = [], released = [];
  const registry = new Providers([new class extends ModelProvider {
    id = "copilot";
    name = "copilot";
    async status() { return { connected: true }; }
    async models() { return [{ id: "model", name: "Model", available: true }]; }
    async releaseSession(id) { released.push(id); }
    async openSession(spec) {
      opened.push(spec.sessionId);
      return new class extends ProviderSession {
        async inventory() { return buildInventory({ name: "copilot" }); }
        resolvePrompt(...args) { return resolvePrompt(this, ...args); }
        async send() { return { text: "ok" }; }
      }();
    }
  }()]);
  const ws = new Workspace(dir, registry, () => {});
  const id = ws.mainChat("pip");
  await ws.send(id, "first");
  const before = ws.chat(id).messages.length;
  await ws.submit(id, "/reload-tools");
  assert.ok(released.length >= 1, "the chat's session was let go");
  assert.equal(ws.mainChat("pip"), id);
  assert.equal(ws.chat(id).messages.length, before + 1, "one line says the tools were reloaded");
  assert.match(ws.chat(id).messages.at(-1).text, /Tools reloaded/);
  assert.ok(!ws.state.runs.some(r => r.chatId === id && r.title === "/reload-tools"), "no turn of the model ran for it");
  await ws.send(id, "after");
  assert.equal(ws.chat(id).messages.at(-1).text, "ok");
  // Every chat of a bot, from the command line's `bots reload-tools`.
  ws.reloadBotTools("pip");
  assert.throws(() => ws.reloadBotTools("nobody"));
});
