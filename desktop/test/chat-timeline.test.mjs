import test from "node:test";
import assert from "node:assert/strict";
import { chatDisplayEntries, isVoiceTranscriptInterim, orderedRunEvents } from "../src/chatTimeline.ts";

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

test("live voice transcripts render outside the running turn's work block in time order", () => {
  const working = { ...run, id: "run-live", status: "Working", finished: undefined };
  const messages = [
    { role: "user", text: "Refactor the parser", runId: "run-live", time: 100 },
    { role: "assistant", text: "Reading parser.ts", runId: "run-live", interim: true, time: 110 },
    { role: "user", text: "How is it going?", voiceId: "call:u1", time: 200 },
    { role: "assistant", text: "Still working on parser.ts.", voiceId: "call:a1", time: 205 },
  ];
  const entries = chatDisplayEntries(messages, new Map([[working.id, working]]), working);
  assert.deepEqual(
    entries.map((e) => (e.kind === "message" ? `${e.message.role}:${e.message.text}` : `timeline:${e.run.id}`)),
    [
      "user:Refactor the parser",
      "user:How is it going?",
      "assistant:Still working on parser.ts.",
      "timeline:run-live",
    ],
  );
  assert.deepEqual(
    orderedRunEvents(working, messages).filter((e) => e.kind === "interim").map((e) => e.value.text),
    ["Reading parser.ts"],
  );

  // When the turn finishes, its work block and final reply land at the end without reordering earlier voice lines.
  const finished = { ...working, status: "Completed", finished: 300 };
  const completedMessages = [...messages, { role: "assistant", text: "Refactor done.", runId: "run-live", time: 300 }];
  const after = chatDisplayEntries(completedMessages, new Map([[finished.id, finished]]));
  assert.deepEqual(
    after.map((e) => (e.kind === "message" ? `${e.message.role}:${e.message.text}` : `timeline:${e.run.id}`)),
    [
      "user:Refactor the parser",
      "user:How is it going?",
      "assistant:Still working on parser.ts.",
      "timeline:run-live",
    ],
  );
});

test("ask_bot voice acknowledgements (including legacy interim-tagged lines) stay outside the work block", () => {
  const working = { ...run, id: "run-ask", status: "Working", finished: undefined };
  const messages = [
    { role: "user", text: "Check my list", voiceId: "call:u1", runId: "run-ask", time: 100 },
    { role: "assistant", text: "Checking now.", voiceId: "call:a1", runId: "run-ask", interim: true, time: 102 },
    { role: "user", text: "Thanks", voiceId: "call:u2", time: 150 },
    { role: "assistant", text: "Sure thing.", voiceId: "call:a2", time: 155 },
  ];
  assert.equal(isVoiceTranscriptInterim(messages[1]), true);
  assert.deepEqual(
    orderedRunEvents(working, messages).filter((e) => e.kind === "interim"),
    [],
  );
  const entries = chatDisplayEntries(messages, new Map([[working.id, working]]), working);
  assert.deepEqual(
    entries.map((e) => (e.kind === "message" ? `${e.message.role}:${e.message.text}` : `timeline:${e.run.id}`)),
    [
      "user:Check my list",
      "assistant:Checking now.",
      "user:Thanks",
      "assistant:Sure thing.",
      "timeline:run-ask",
    ],
  );
});

test("a finished run without a reply stays between mid-turn and post-turn voice messages", () => {
  const stopped = { ...run, id: "run-stopped", status: "Stopped", finished: 200 };
  const messages = [
    { role: "user", text: "Run the build", runId: "run-stopped", time: 100 },
    { role: "user", text: "Still running?", voiceId: "call:u1", time: 150 },
    { role: "assistant", text: "Yep, compiling.", voiceId: "call:a1", time: 155 },
    { role: "user", text: "What happened?", voiceId: "call:u2", time: 250 },
  ];
  const entries = chatDisplayEntries(messages, new Map([[stopped.id, stopped]]));
  assert.deepEqual(
    entries.map((e) => (e.kind === "message" ? `${e.message.role}:${e.message.text}` : `timeline:${e.run.id}`)),
    [
      "user:Run the build",
      "user:Still running?",
      "assistant:Yep, compiling.",
      "timeline:run-stopped",
      "user:What happened?",
    ],
  );
});
