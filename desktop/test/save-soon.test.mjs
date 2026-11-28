// The turn's hot path writes the state soon, not on every step (Workspace.saveSoon in desktop/workspace.mjs):
// many changes make one write, the window still hears of each at once, and a save, a flush or a
// new Workspace on the same folder leaves nothing waiting.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Workspace, readPersistedWorkspace } from "./starter.mjs";
import { readWorkspace } from "../desktop/workspace-file.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

function setup(t) {
  const dir = tempDir(t);
  let heard = 0;
  const ws = new Workspace(dir, fakeClient().client, () => heard++);
  const onDisk = () => readPersistedWorkspace(dir);
  t.after(() => ws.flushSave());
  return { dir, ws, onDisk, heard: () => heard };
}

test("many hot-path changes make one write, after the window heard each", async (t) => {
  const { ws, onDisk, heard } = setup(t);
  ws.save();
  const before = heard();
  for (let i = 0; i < 50; i++) {
    ws.state.settings.saveSoonProbe = i;
    ws.saveSoon();
  }
  assert.equal(heard() - before, 50, "the window hears every change at once");
  assert.equal(onDisk().settings.saveSoonProbe, undefined, "nothing written yet");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(onDisk().settings.saveSoonProbe, 49, "one write with the newest state");
  assert.equal(ws.saveTimer, null);
});

test("a save or a flush writes what was waiting and leaves no timer", (t) => {
  const { ws, onDisk } = setup(t);
  ws.state.settings.saveSoonProbe = "soon";
  ws.saveSoon();
  ws.flushSave();
  assert.equal(onDisk().settings.saveSoonProbe, "soon");
  assert.equal(ws.saveTimer, null);

  ws.state.settings.saveSoonProbe = "then saved";
  ws.saveSoon();
  ws.save();
  assert.equal(onDisk().settings.saveSoonProbe, "then saved");
  assert.equal(ws.saveTimer, null);
  ws.flushSave();
});

test("concurrent live turns checkpoint their own work without rewriting historical messages", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tempDir(t);
  const starts = [];
  const bothStarted = Promise.withResolvers();
  const { client } = fakeClient((_id, _options, session) => {
    starts.push(session);
    if (starts.length === 2) bothStarted.resolve();
    return new Promise(() => {}); // simulate a process that dies before the provider finishes
  });
  const ws = new Workspace(dir, client, () => {}, { storage: "json" });
  const a = ws.createChat("pip"), b = ws.createChat("scout");
  const history = "old-history".repeat(100_000);
  ws.chat(a).messages.push({ role: "assistant", text: history });
  void ws.send(a, "First task");
  void ws.send(b, "Second task");
  await bothStarted.promise;
  const file = join(dir, "workspace.json");
  const checkpointDir = join(dir, "turn-checkpoints");
  const original = readFileSync(file, "utf8");
  const [first, second] = starts;
  const delta = (session, text) => session.emit({ type: "assistant.message_delta", data: { deltaContent: text } });
  delta(first, "Checking.");
  first.emit({ type: "tool.execution_start", data: { toolCallId: "check", toolName: "shell", arguments: { command: "pwd" } } });
  delta(first, "First draft.");
  delta(second, "Second draft.");
  t.mock.timers.tick(750);
  assert.equal(readFileSync(file, "utf8"), original);
  const files = readdirSync(checkpointDir).map(name => join(checkpointDir, name));
  assert.equal(files.length, 2);
  const sidecar = files.find(path => JSON.parse(readFileSync(path)).data.run.chatId === b);
  assert.ok(files.reduce((size, path) => size + statSync(path).size, 0) < 10_000);
  assert.equal(statSync(sidecar).mode & 0o777, 0o600);
  const saved = readWorkspace(file);
  const run = saved.runs.find(r => r.chatId === a);
  assert.equal(run.recovery.draft, "First draft.");
  assert.equal(run.steps[0].id, "check");
  assert.deepEqual(saved.chats.find(c => c.id === a).messages.map(m => m.text), [history, "First task", "Checking."]);
  assert.equal(saved.runs.find(r => r.chatId === b).recovery.draft, "Second draft.");
  const oldCheckpoint = readFileSync(sidecar);
  const { data } = JSON.parse(oldCheckpoint);
  const encoded = record => JSON.stringify({ digest: createHash("sha256").update(JSON.stringify(record)).digest("hex"), data: record });
  for (const broken of ["{", "null", oldCheckpoint.toString().replace("Second draft.", "Damaged draft."),
    encoded({ ...data, run: { ...data.run, chatId: a } }), encoded({ ...data, from: -1 }),
    encoded({ ...data, from: 20_000 }), encoded({ ...data, messages: null })]) {
    writeFileSync(sidecar, broken);
    const fallback = readWorkspace(file);
    assert.equal(fallback.runs.find(r => r.chatId === b).recovery.draft, undefined, "use this turn's full save");
    assert.equal(fallback.runs.find(r => r.chatId === a).recovery.draft, "First draft.", "keep the healthy sibling");
  }
  writeFileSync(sidecar, oldCheckpoint);
  utimesSync(sidecar, 10, 10);
  ws.active.get(a).nextCheckpoint = 0;
  delta(first, " Done.");
  t.mock.timers.tick(750);
  assert.equal(statSync(sidecar).mtimeMs, 10_000, "a different chat's delta leaves the checkpoint alone");

  const restarted = fakeClient();
  const again = new Workspace(dir, restarted.client, () => {}, { storage: "json" });
  assert.equal(existsSync(sidecar), false);
  await Promise.all(again.resumeActive());
  assert.match(restarted.log.sent.find(([, prompt]) => prompt.includes("First task"))[1], /Earlier partial reply:\nFirst draft/);
  assert.ok(again.state.runs.every(r => r.status === "Completed" && !r.recovery));
  await again.agents.deleteChat(b);
  // Model a crash after installing a newer full snapshot but before unlinking the prior sidecar.
  writeFileSync(sidecar, oldCheckpoint);
  const latest = readWorkspace(file);
  assert.ok(latest.runs.every(r => r.status === "Completed" && !r.recovery));
  assert.ok(!latest.chats.some(c => c.id === b));
  assert.ok(!latest.runs.some(r => r.chatId === b));
});

test("a graceful flush commits the current draft and supersedes its checkpoint even while the run is working", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tempDir(t);
  const ready = Promise.withResolvers();
  const { client } = fakeClient((_id, _options, session) => {
    ready.resolve(session);
    return new Promise(() => {});
  });
  const ws = new Workspace(dir, client, () => {}, { storage: "json" });
  const chat = ws.createChat("pip");
  void ws.send(chat, "Task");
  const session = await ready.promise;
  const delta = text => session.emit({ type: "assistant.message_delta", data: { deltaContent: text } });
  delta("first");
  t.mock.timers.tick(750);
  const directory = join(dir, "turn-checkpoints");
  const path = join(directory, readdirSync(directory)[0]);
  const previous = readFileSync(path);
  delta(" second");
  ws.flushSave();
  assert.equal(JSON.parse(readFileSync(ws.file)).runs[0].recovery.draft, "first second");
  assert.equal(existsSync(path), false);
  writeFileSync(path, previous);
  assert.equal(readWorkspace(ws.file).runs[0].recovery.draft, "first second");
});

test("a partial voice insertion or correction before the checkpoint boundary keeps transcript order", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tempDir(t);
  const ready = Promise.withResolvers();
  const { client } = fakeClient((_id, _options, session) => {
    ready.resolve(session);
    return new Promise(() => {});
  });
  const ws = new Workspace(dir, client, () => {});
  const chatId = ws.createChat("pip");
  ws.recordVoiceLine(chatId, "older", "Start", false);
  ws.recordVoiceLine(chatId, "out-1", "Assistant heard first", true, undefined, { role: "assistant", afterVoiceId: "user-1" });
  void ws.send(chatId, "Text request");
  const session = await ready.promise;
  const checkpoint = text => {
    ws.active.get(chatId).nextCheckpoint = 0;
    session.emit({ type: "assistant.message_delta", data: { deltaContent: text } });
    t.mock.timers.tick(750);
    assert.deepEqual(readPersistedWorkspace(dir).chats.find(c => c.id === chatId).messages, ws.chat(chatId).messages);
  };
  ws.recordVoiceLine(chatId, "user-1", "User arriving late", false);
  checkpoint("draft");
  ws.recordVoiceLine(chatId, "older", "Starting to speak", false);
  checkpoint(" continued");
});
