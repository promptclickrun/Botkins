// Auto-summarize (desktop/summaries.mjs): a chat is named from its first message, then again every
// few turns, by the Default routines model.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace, readPersistedWorkspace } from "./starter.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";
import { defaultSettings } from "../desktop/preferences.mjs";
import { titleFrom } from "../desktop/summaries.mjs";

/** `hold` keeps the summary model from answering until the test lets it. */
function setup(t, hold) {
  let named = 0;
  const fake = fakeClient(async (id, options) => {
    if (!id.startsWith("summary-")) return { data: { content: "Reply to " + options.prompt } };
    await hold?.();
    return { data: { content: "“Title " + ++named + ".”" } };
  });
  const ws = new Workspace(join(tempDir(t), "data"), fake.client, () => {});
  return { ws, ...fake };
}
const summaries = (log) => log.sent.filter(([id]) => id.startsWith("summary-"));
/** Lets a summary that was started answer. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};
/** Sends `count` more messages, numbered on from the chat's last one. */
async function turns(ws, id, count) {
  const sent = ws.chat(id).messages.filter((m) => m.role === "user").length;
  for (let i = 1; i <= count; i++) await ws.send(id, "Message " + (sent + i));
  await settle();
}

test("a chat is named from its first message, then again every few turns, by the Default routines model", async (t) => {
  const { ws, log } = setup(t);
  assert.equal(defaultSettings.autoSummarize, 10, "on, every 10 turns, until the person picks");
  ws.setPreferences({ autoSummarize: 5 });
  ws.state.settings.routineModel = { model: "routines-model" };
  const id = ws.createChat("pip");
  await turns(ws, id, 1);
  assert.equal(ws.chat(id).title, "Title 1", "the first message is named: no quotes, no full stop");
  const [[session, first]] = summaries(log);
  assert.match(first, /<conversation>\nPerson: Message 1\n<\/conversation>/, "from the first message alone, sent before the reply");
  assert.doesNotMatch(first, /The chat is called/);
  const config = log.configs.get(session);
  assert.equal(config.model, "routines-model", "the Default routines model answers it");
  assert.deepEqual((config.tools?.definitions ?? config.tools ?? []).map((tool) => tool.name), [], "with no tools");
  await turns(ws, id, 3);
  assert.equal(summaries(log).length, 1, "not again before the fifth turn");
  await turns(ws, id, 1);
  assert.equal(ws.chat(id).title, "Title 2");
  const again = summaries(log)[1][1];
  assert.match(again, /The chat is called “Title 1”/);
  assert.match(again, /Person: Message 1\n\nPip: Reply to Message 1/);
  assert.match(again, /Pip: Reply to Message 5/);
  await turns(ws, id, 5);
  assert.equal(summaries(log).length, 3, "and every five turns after that");
});

test("a long chat keeps its first message and its latest ones", async (t) => {
  const { ws, log } = setup(t);
  ws.setPreferences({ autoSummarize: 5 });
  const id = ws.createChat("pip");
  await ws.send(id, "Plan my garden");
  // 30 turns: the last summary is made at the 30th.
  for (let i = 0; i < 29; i++) await ws.send(id, "Question " + i + " " + "x".repeat(1500));
  await settle();
  const last = summaries(log).at(-1)[1];
  assert.match(last, /<conversation>\nPerson: Plan my garden\n\n…\n\n/, "the first message, then a gap");
  assert.match(last, /Pip: Reply to Question 28/);
  assert.doesNotMatch(last, /Question 3 /, "the middle is left out");
  assert.ok(last.length < 14000);
});

test("a first title that fails is tried twice more, then the first message stays", async (t) => {
  let failures = 2;
  const { ws, log } = setup(t, async () => {
    if (failures-- > 0) throw new Error("the model is busy");
  });
  ws.setPreferences({ autoSummarize: 5 });
  ws.summaries.retryDelay = 1;
  const errors = t.mock.method(console, "error", () => {});
  const named = ws.createChat("pip");
  await turns(ws, named, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ws.chat(named).title, "Title 1", "the third try named it");
  assert.equal(summaries(log).length, 3);
  assert.doesNotMatch(summaries(log)[2][1], /The chat is called/, "a try after the reply still names a new chat");
  // Three failures: the chat keeps its first message, and nothing is tried again until a round of turns has passed.
  failures = 3;
  const kept = ws.createChat("pip");
  await turns(ws, kept, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ws.chat(kept).title, "Message 1");
  assert.equal(summaries(log).length, 6);
  assert.match(String(errors.mock.calls.at(-1)?.arguments.join(" ")), /could not name a chat: the model is busy/);
  await turns(ws, kept, 3);
  assert.equal(summaries(log).length, 6);
});

test("without a Default routines model, the bot's own model answers", async (t) => {
  const { ws, log } = setup(t);
  ws.setPreferences({ autoSummarize: 5 });
  ws.bot("pip").model = { model: "bot-model" };
  await turns(ws, ws.createChat("pip"), 1);
  assert.equal(log.configs.get(summaries(log)[0][0]).model, "bot-model");
});

test("off, or a title the person gave, keeps the chat's title", async (t) => {
  let answer;
  const { ws, log } = setup(t, () => new Promise((resolve) => (answer = resolve)));
  ws.setPreferences({ autoSummarize: 0 });
  const off = ws.createChat("pip");
  await turns(ws, off, 12);
  assert.equal(ws.chat(off).title, "Message 1");
  assert.equal(summaries(log).length, 0);
  // Renamed while its first title was being made: the person's title stays, and no more are made.
  ws.setPreferences({ autoSummarize: 5 });
  const named = ws.createChat("pip");
  await ws.send(named, "Hi");
  await settle();
  ws.agents.renameChat(named, "My garden");
  answer();
  await turns(ws, named, 6);
  assert.equal(ws.chat(named).title, "My garden");
  assert.equal(summaries(log).length, 1);
});

test("regenerating a title uses the conversation and saves it even with automatic naming off", async (t) => {
  const { ws, log } = setup(t);
  ws.state.settings.routineModel = { model: "routines-model" };
  const id = ws.createChat("pip");
  await ws.send(id, "Plan my garden");
  ws.agents.renameChat(id, "My garden");
  const messages = structuredClone(ws.chat(id).messages);

  assert.equal(await ws.summaries.regenerate(id), "Title 1");
  assert.equal(ws.chat(id).title, "Title 1");
  assert.equal(ws.chat(id).titleSet, true, "automatic naming still respects a manual title");
  assert.equal(readPersistedWorkspace(ws.dir).chats.find((chat) => chat.id === id).title, "Title 1");
  assert.deepEqual(ws.chat(id).messages, messages);
  const [[session, prompt]] = summaries(log);
  assert.match(prompt, /The chat is called “My garden”/);
  assert.match(prompt, /Person: Plan my garden\n\nPip: Reply to Plan my garden/);
  assert.equal(log.configs.get(session).model, "routines-model");
});

test("regeneration keeps the title when there is no message or the model can't name it", async (t) => {
  const { ws, log } = setup(t);
  const id = ws.createChat("pip");
  await assert.rejects(ws.summaries.regenerate(id), /Send a message/);
  assert.equal(summaries(log).length, 0);
  await ws.send(id, "Plan my garden");
  const ask = t.mock.method(ws.summaries, "ask", async () => "Title:");
  await assert.rejects(ws.summaries.regenerate(id), /didn't produce a title/);
  ask.mock.mockImplementation(async () => { throw new Error("The model is busy"); });
  await assert.rejects(ws.summaries.regenerate(id), /The model is busy/);
  assert.equal(ws.chat(id).title, "Plan my garden");
});

test("a manual rename while regeneration is running wins", async (t) => {
  const { ws } = setup(t);
  const id = ws.createChat("pip");
  await ws.send(id, "Plan my garden");
  let answer;
  t.mock.method(ws.summaries, "ask", () => new Promise((resolve) => (answer = resolve)));
  const pending = ws.summaries.regenerate(id);
  await assert.rejects(ws.summaries.regenerate(id), /already being generated/);
  ws.agents.renameChat(id, "Spring planting");
  answer("Garden plan");
  await assert.rejects(pending, /title was changed/);
  assert.equal(ws.chat(id).title, "Spring planting");
});

test("the choice is off or 5 to 30 turns", (t) => {
  const { ws } = setup(t);
  for (const value of [0, 5, 17, 30]) {
    ws.setPreferences({ autoSummarize: value });
    assert.equal(ws.state.settings.autoSummarize, value);
  }
  for (const value of [4, 31, 7.5, "10", null, true]) assert.throws(() => ws.setPreferences({ autoSummarize: value }), /Choose off, or every 5 to 30 turns/);
});

test("a reply becomes a short plain title", () => {
  assert.equal(titleFrom('Title: "**Tide tables** research."\nMore words'), "Tide tables research");
  assert.equal(titleFrom("\n\n  Fixing the login bug  \n"), "Fixing the login bug");
  assert.equal(titleFrom("   "), "");
  const long = titleFrom("word ".repeat(40));
  assert.ok(long.length <= 80 && long.endsWith("…"));
});
