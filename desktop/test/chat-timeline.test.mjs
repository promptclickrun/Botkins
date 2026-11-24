import test from "node:test";
import assert from "node:assert/strict";
import { orderedRunEvents } from "../src/chatTimeline.ts";

const run = {
  id: "run-1",
  chatId: "chat-1",
  title: "Timeline",
  time: 100,
  status: "Completed",
  detail: "",
  reasoning: [{ id: "thought", text: "Planning", started: 120 }],
  steps: [
    { id: "step", name: "write_file", label: "Write file", status: "Done", started: 140 },
    { id: "helper-step", name: "helper", label: "Helper", status: "Done", started: 145, agentId: "helper-1" },
  ],
};

test("saved silent replies are omitted without moving later message indices", () => {
  const messages = [
    { role: "assistant", runId: run.id, text: " [SILENT] " },
    { role: "assistant", runId: run.id, text: "[SILENT] means no reply." },
  ];
  const replies = orderedRunEvents(run, messages, { includeReplies: true }).filter(event => event.kind === "reply");
  assert.deepEqual(replies.map(event => event.index), [1]);
});

test("timeline renderer orders thinking, interim text, steer and steps", () => {
  const messages = [
    { role: "user", text: "Start", runId: "run-1", time: 100 },
    { role: "assistant", text: "I am checking the files", interim: true, runId: "run-1", time: 130 },
    { role: "user", text: "Keep going", steeredRunId: "run-1", time: 135 },
    { role: "command", text: "generated.txt", runId: "run-1", time: 138 },
    { role: "assistant", text: "done", runId: "run-1", time: 160 },
  ];
  assert.deepEqual(orderedRunEvents(run, messages).map((event) => event.kind), ["reasoning", "interim", "person", "command", "step"]);
});

test("timeline ordering is deterministic for equal timestamps and excludes helper steps", () => {
  const messages = [
    { role: "user", text: "Start", runId: "run-1", time: 100 },
    { role: "assistant", text: "First update", interim: true, runId: "run-1", time: 140 },
    { role: "user", text: "Answer", answer: { runId: "run-1", requestId: "req", kind: "question", title: "Question" }, time: 140 },
  ];
  const events = orderedRunEvents(run, messages);
  assert.equal(events.at(-1)?.kind, "step");
  assert.equal(events.filter((event) => event.kind === "step").length, 1);
  assert.deepEqual(events.filter((event) => event.at === 140).map((event) => event.kind), ["interim", "person", "step"]);
  assert.equal(events.find((event) => event.kind === "person")?.key, "person-2");
});

test("group turns interleave each speaker's reply with activity without duplicating replies", () => {
  const groupRun = { ...run, id: "group-run", chatId: "group-chat", speakers: ["pip", "scout"] };
  const messages = [
    { role: "user", text: "Start", runId: "group-run", time: 100 },
    { role: "assistant", text: "Pip is checking", interim: true, runId: "group-run", botId: "pip", time: 110 },
    { role: "assistant", text: "Pip found an answer", runId: "group-run", botId: "pip", time: 120 },
    { role: "command", text: "scout-search", runId: "group-run", time: 125 },
    { role: "assistant", text: "Scout is checking", interim: true, runId: "group-run", botId: "scout", time: 130 },
    { role: "user", text: "Keep going", steeredRunId: "group-run", time: 135 },
    { role: "assistant", text: "Scout found an answer", runId: "group-run", botId: "scout", time: 140 },
  ];
  const events = orderedRunEvents(groupRun, messages, { includeReplies: true });
  assert.deepEqual(events.map((event) => event.kind), ["interim", "reasoning", "reply", "command", "interim", "person", "step", "reply"]);
  assert.deepEqual(events.filter((event) => event.kind === "reply").map((event) => event.value.botId), ["pip", "scout"]);
  assert.equal(events.filter((event) => event.kind === "reply").length, 2);
});
