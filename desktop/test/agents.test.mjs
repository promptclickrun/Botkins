import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";

function setup(t, client = async () => ({ deleteSession: async () => {} })) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-agents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, ws: new Workspace(dir, client, () => {}) };
}
const look = { head: "muse", palette: "fern" };

test("existing bots keep their place on load: the primary bot shows and a missing section is cleared", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-agents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bot = (id, face) => ({ id, name: id, role: "R", instructions: "I", face });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify({ bots: [{ ...bot("pip", "idle"), hidden: true }, { ...bot("x", "coding"), sectionId: "gone" }], chats: [], runs: [] }));
  const ws = new Workspace(dir, async () => ({}), () => {});
  assert.equal(ws.state.bots[0].hidden, false, "the primary bot always shows");
  assert.equal(ws.bot("x").sectionId, null, "a missing section is cleared");
  assert.deepEqual(ws.state.sections, []);
});

test("bots are created and edited with a look, about text and partial updates", (t) => {
  const { ws } = setup(t);
  const id = ws.addBot({ name: "Nova", role: "Editor", instructions: "Edit prose", look, summary: "Tightens drafts" });
  const bot = ws.bot(id);
  assert.deepEqual(bot.look, look);
  assert.equal(bot.summary, "Tightens drafts");
  // Eyes and colors the app can't draw are refused, as the phone refuses them, and the look stays.
  assert.throws(() => ws.updateBot(id, { look: { head: "fathom", palette: "original", eyes: "ignored" } }), /Unknown eyes/);
  assert.deepEqual(bot.look, look);
  ws.updateBot(id, { look: { head: "fathom", palette: "original", eyes: "oval", extra: 1 } });
  assert.deepEqual(bot.look, { head: "fathom", palette: "original" }, "the character's own eyes are not written, and nothing unknown is kept");
  assert.equal(bot.name, "Nova", "a partial update keeps other fields");
  ws.updateBot(id, { summary: "  Edits essays  ", name: "Nova 2" });
  assert.equal(bot.summary, "Edits essays");
  assert.equal(bot.name, "Nova 2");
  assert.deepEqual(bot.look, { head: "fathom", palette: "original" }, "an update without a look leaves it");
  assert.throws(() => ws.updateBot(id, { name: "" }), /Invalid name/);
});

test("a bot's own voice is checked, kept on the bot and carried by a copy; null clears it; the app names the capability", async (t) => {
  const { ws } = setup(t);
  const id = ws.addBot({ name: "Nova", role: "Editor", instructions: "Edit prose", look, voice: { tts: { provider: "openai", voice: "nova" } } });
  assert.deepEqual(ws.bot(id).voice, { tts: { provider: "openai", voice: "nova" } });
  ws.updateBot(id, { voice: { live: { provider: "gemini", voice: "Puck" }, tts: { speed: 1.25 } } });
  assert.deepEqual(ws.bot(id).voice, { tts: { speed: 1.25 }, live: { provider: "gemini", voice: "Puck" } });
  // Junk is refused and the voice stays; a partial update of something else leaves it.
  for (const bad of [{ tts: { provider: "nope" } }, { tts: { speed: 3 } }, { live: { provider: "device" } }, { tts: { key: "sk-x" } }, "nova"]) assert.throws(() => ws.updateBot(id, { voice: bad }), /can't be saved|isn't supported|between 0\.5 and 2/);
  ws.updateBot(id, { name: "Nova 2" });
  assert.deepEqual(ws.bot(id).voice, { tts: { speed: 1.25 }, live: { provider: "gemini", voice: "Puck" } });
  assert.deepEqual(ws.bot(ws.agents.duplicateBot(id)).voice, ws.bot(id).voice, "a copy sounds the same");
  ws.updateBot(id, { voice: null });
  assert.equal("voice" in ws.bot(id), false, "the bot follows Settings › Voice again");
  const { CAPABILITIES, linkCapabilities } = await import("../desktop/runtime.mjs");
  assert.ok(CAPABILITIES.includes("bot-voice-v1") && linkCapabilities().includes("bot-voice-v1"));
});

test("pins, hiding, primary bot, order and sections", (t) => {
  const { ws } = setup(t);
  const [pip, scout, patch] = ws.state.bots.map((b) => b.id);
  ws.agents.setBotFlags(scout, { pinned: true });
  assert.equal(ws.bot(scout).pinned, true);
  assert.throws(() => ws.agents.setBotFlags(pip, { hidden: true }), /primary bot/);
  ws.agents.setBotFlags(patch, { hidden: true });
  ws.agents.makePrimary(patch);
  assert.equal(ws.state.bots[0].id, patch);
  assert.equal(ws.bot(patch).hidden, false, "a primary bot is shown again");
  ws.agents.reorderBots([scout, pip, patch]);
  assert.deepEqual(ws.state.bots.map((b) => b.id), [scout, pip, patch]);
  assert.throws(() => ws.agents.reorderBots([scout, pip]), /every bot once/);
  const section = ws.agents.addSection("Research");
  ws.agents.setBotFlags(pip, { sectionId: section });
  ws.agents.renameSection(section, "Deep research");
  assert.equal(ws.state.sections[0].name, "Deep research");
  assert.throws(() => ws.agents.setBotFlags(pip, { sectionId: "nope" }), /Unknown section/);
  assert.throws(() => ws.agents.setBotFlags(pip, { color: "red" }), /Unknown bot flag/);
  ws.agents.deleteSection(section);
  assert.equal(ws.bot(pip).sectionId, null, "deleting a section keeps its bots");
  assert.equal(ws.state.sections.length, 0);
});

test("duplicating a bot copies its setup with fresh ids", (t) => {
  const { ws } = setup(t);
  const source = ws.state.bots[1];
  source.skillsOff = ["notes"];
  source.pinned = true;
  const copy = ws.bot(ws.agents.duplicateBot(source.id));
  assert.equal(copy.name, source.name + " copy");
  assert.equal(copy.instructions, source.instructions);
  assert.deepEqual(copy.look, source.look, "the copy is the same character");
  assert.equal(copy.pinned, false);
  assert.deepEqual(copy.skillsOff, ["notes"], "the skills it leaves out come along");
  assert.notEqual(copy.skillsOff, source.skillsOff);
  assert.equal(ws.state.bots.indexOf(copy), 2, "the copy sits after the original");
});

test("deleting a bot removes its chats, runs, panels and Copilot sessions", async (t) => {
  const deleted = [];
  const { ws } = setup(t, async () => ({ deleteSession: async (id) => deleted.push(id) }));
  const [pip, scout] = ws.state.bots.map((b) => b.id);
  const a = ws.createChat(scout);
  const b = ws.createChat(scout);
  const keep = ws.createChat(pip);
  ws.chat(a).established = true;
  ws.state.runs.push({ id: "r1", chatId: a }, { id: "r2", chatId: keep });
  ws.state.panels.push({ id: "p1", botId: scout }, { id: "p2", botId: pip });
  ws.active.set(b, {});
  await assert.rejects(ws.agents.deleteBot(scout), /Stop the running reply/);
  ws.active.delete(b);
  await ws.agents.deleteBot(scout);
  assert.ok(!ws.state.bots.some((x) => x.id === scout));
  assert.deepEqual(ws.state.chats.map((c) => c.id), [keep]);
  assert.deepEqual(ws.state.runs.map((r) => r.id), ["r2"]);
  assert.deepEqual(ws.state.panels.map((p) => p.id), ["p2"]);
  assert.deepEqual(deleted, [a], "only established sessions are deleted");
  ws.state.bots = [ws.state.bots[0]];
  await assert.rejects(ws.agents.deleteBot(ws.state.bots[0].id), /at least one bot/);
});

test("chat flags, rename and delete", async (t) => {
  const deleted = [];
  const { ws } = setup(t, async () => ({ deleteSession: async (id) => deleted.push(id) }));
  const id = ws.createChat(ws.state.bots[0].id);
  ws.agents.setChatFlags(id, { pinned: true, unread: true, archived: true });
  assert.deepEqual([ws.chat(id).pinned, ws.chat(id).unread, ws.chat(id).archived], [true, true, true]);
  ws.agents.setChatFlags(id, { archived: false });
  assert.equal(ws.chat(id).archived, false);
  assert.throws(() => ws.agents.setChatFlags(id, { starred: true }), /Unknown chat flag/);
  assert.throws(() => ws.agents.setChatFlags(id, { pinned: "yes" }), /Invalid chat flag/);
  ws.agents.renameChat(id, "  Trip plan  ");
  assert.equal(ws.chat(id).title, "Trip plan");
  assert.throws(() => ws.agents.renameChat(id, " "), /Invalid chat title/);
  ws.chat(id).established = true;
  ws.state.panels.push({ id: "p", botId: ws.state.bots[0].id, refreshChatId: id });
  await ws.agents.deleteChat(id);
  assert.equal(ws.state.chats.length, 0);
  assert.equal(ws.state.panels[0].refreshChatId, undefined);
  assert.deepEqual(deleted, [id]);
});

test("a finished reply marks its chat unread; a stopped one does not", async (t) => {
  const handlers = new Set();
  const session = {
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    emit: (event) => handlers.forEach((handler) => handler(event)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      const messageId = "message";
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Re: " + prompt } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };
  const { ws } = setup(t, async () => ({ createSession: async () => session, resumeSession: async () => session }));
  const id = ws.createChat(ws.state.bots[0].id);
  await ws.send(id, "Hello");
  assert.equal(ws.chat(id).unread, true);
  ws.agents.setChatFlags(id, { unread: false });
  const turn = ws.send(id, "Again");
  await ws.stop(id);
  await turn;
  assert.equal(ws.chat(id).unread, false);
});
