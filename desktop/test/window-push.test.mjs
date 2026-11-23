import test from "node:test";
import assert from "node:assert/strict";
import { serialize } from "node:v8";
import { createWindowPush, shapeOf } from "../desktop/window-push.mjs";
import { applyHot, share } from "../src/hotState.ts";

const bytes = (value) => serialize(value).length;

/** A workspace state with many chats, one turn that runs and a lot of step output. */
function makeState({ chats = 200, messages = 100, steps = 40 } = {}) {
  const words = "Botkins reads the files, runs the tests and tells you what it found. ".repeat(6);
  return {
    bots: [{ id: "bot-1", name: "Bot" }],
    settings: { theme: "light" },
    chats: Array.from({ length: chats }, (_, c) => ({
      id: "chat-" + c,
      title: "Chat " + c,
      botId: "bot-1",
      messages: Array.from({ length: messages }, (_, m) => ({ role: m % 2 ? "assistant" : "user", text: words + m, time: 1000 + m, runId: "old-" + c })),
    })),
    runs: [
      {
        id: "run-live",
        chatId: "chat-0",
        status: "Working",
        title: "Live",
        time: 5000,
        detail: "",
        steps: Array.from({ length: steps }, (_, i) => ({ id: "step-" + i, name: "shell", label: "Run " + i, input: "x".repeat(2000), output: "y".repeat(12000), status: i === steps - 1 ? "Running" : "Done", started: 6000 + i })),
        reasoning: [{ id: "r", text: "Thinking about it", started: 5001 }],
      },
      ...Array.from({ length: chats }, (_, c) => ({ id: "old-" + c, chatId: "chat-" + c, status: "Completed", title: "Old", time: 100 + c, detail: "", steps: [{ id: "s", name: "shell", label: "Old", output: "z".repeat(12000), status: "Done", started: 1 }] })),
    ],
    streams: { "chat-0": "" },
    thinking: {},
    intents: { "chat-0": "Running tests" },
    speakers: {},
    steerable: { "chat-0": true },
    queued: {},
    requests: [],
    wiki: { revision: 1 },
  };
}

/** The window, as the page keeps it (src/app.tsx): whole states replace, hot messages apply. */
function windowOf() {
  const log = [];
  const held = { state: undefined };
  return {
    log,
    held,
    send(message) {
      log.push({ kind: "whole", message });
      held.state = share(held.state, structuredClone(message));
    },
    sendHot(message) {
      log.push({ kind: "hot", message });
      const sent = structuredClone(message);
      if (held.state?.seq !== sent.base) return;
      held.state = applyHot(held.state, sent) ?? held.state;
    },
  };
}

function setup(state, options = {}) {
  const page = windowOf();
  let clock = 0;
  const push = createWindowPush({ snapshot: () => state, send: page.send, sendHot: page.sendHot, now: () => clock, later: () => 0, ...options });
  return { page, push, tick: (ms = 40) => { clock += ms; push.flush(); }, state };
}
const withoutSeq = ({ seq: _seq, ...state }) => state;

test("while nothing streams every push is the whole state", () => {
  const state = makeState({ chats: 3, messages: 3, steps: 2 });
  state.streams = {};
  state.runs.shift();
  const { page, tick } = setup(state);
  tick();
  state.settings.theme = "dark";
  tick();
  assert.deepEqual(page.log.map((entry) => entry.kind), ["whole", "whole"]);
  assert.equal(page.held.state.settings.theme, "dark");
});

test("a streaming turn sends the live parts only, and the window ends up with the same state", () => {
  const state = makeState();
  const { page, tick } = setup(state);
  tick();
  assert.equal(page.log.at(-1).kind, "whole");
  const base = page.log.at(-1).message.seq;
  for (let i = 0; i < 20; i++) {
    state.streams["chat-0"] += "word " + i + " ";
    state.runs[0].steps.at(-1).output += "line " + i + "\n";
    tick();
    assert.deepEqual(withoutSeq(page.held.state), state);
  }
  const hots = page.log.filter((entry) => entry.kind === "hot");
  assert.equal(hots.length, 20);
  assert.ok(hots.every(({ message }) => message.base === base));
  // Only the step that changed, and no other step or run, is in the message.
  const message = hots.at(-1).message;
  assert.deepEqual(Object.keys(message.fields), ["streams"]);
  assert.equal(message.runs.length, 1);
  assert.deepEqual(message.runs[0].steps.map((step) => step.id), ["step-39"]);
  assert.equal(message.runs[0].rest, undefined);
  assert.equal(message.runs[0].order, undefined);
});

test("what did not change keeps its identity in the window", () => {
  const state = makeState({ chats: 20, messages: 10, steps: 5 });
  const { page, tick } = setup(state);
  tick();
  const before = page.held.state;
  state.streams["chat-0"] += "more";
  state.runs[0].steps.at(-1).output = "changed";
  tick();
  const after = page.held.state;
  assert.notEqual(after, before);
  assert.equal(after.chats, before.chats);
  assert.equal(after.bots, before.bots);
  assert.equal(after.settings, before.settings);
  assert.notEqual(after.runs, before.runs);
  assert.equal(after.runs[1], before.runs[1]);
  assert.equal(after.runs[0].steps[0], before.runs[0].steps[0]);
  assert.notEqual(after.runs[0].steps[4], before.runs[0].steps[4]);
});

test("a push with nothing new sends nothing", () => {
  const state = makeState({ chats: 5, messages: 5, steps: 3 });
  const { page, tick } = setup(state);
  tick();
  tick();
  const count = page.log.length;
  tick();
  tick();
  assert.equal(page.log.length, count);
});

test("a message added mid-stream goes at once as a whole state, before any later live part", () => {
  const state = makeState({ chats: 5, messages: 5, steps: 3 });
  const { page, tick } = setup(state);
  tick();
  state.streams["chat-0"] += "hello";
  tick();
  // The turn commits its text before a tool call: the live text is cleared and a message is added.
  state.chats[0].messages.push({ role: "assistant", text: "hello", interim: true, runId: "run-live", time: 7000 });
  state.streams["chat-0"] = "";
  tick();
  assert.equal(page.log.at(-1).kind, "whole");
  assert.equal(page.held.state.chats[0].messages.at(-1).text, "hello");
  const seq = page.log.at(-1).message.seq;
  state.streams["chat-0"] = "next";
  tick();
  assert.equal(page.log.at(-1).kind, "hot");
  assert.equal(page.log.at(-1).message.base, seq);
  assert.equal(page.held.state.streams["chat-0"], "next");
});

test("a turn ending or starting is a whole state", () => {
  const state = makeState({ chats: 3, messages: 3, steps: 2 });
  const { page, tick } = setup(state);
  tick();
  state.runs[0].status = "Completed";
  state.streams = {};
  state.intents = {};
  tick();
  assert.equal(page.log.at(-1).kind, "whole");
  assert.deepEqual(withoutSeq(page.held.state), state);
  state.runs.unshift({ id: "run-2", chatId: "chat-1", status: "Working", title: "Second", time: 9000, detail: "", steps: [] });
  state.streams = { "chat-1": "" };
  tick();
  assert.equal(page.log.at(-1).kind, "whole");
  assert.ok(page.held.state.runs.some((run) => run.id === "run-2"));
});

test("a change to the rest that the shape does not show is found by the slower comparison", () => {
  const state = makeState({ chats: 5, messages: 5, steps: 3 });
  const { page, tick } = setup(state, { every: 500 });
  tick();
  state.settings.theme = "dark";
  state.streams["chat-0"] += "x";
  tick(40);
  assert.equal(page.held.state.settings.theme, "light");
  assert.equal(page.log.at(-1).kind, "hot");
  state.streams["chat-0"] += "y";
  tick(600);
  assert.equal(page.log.at(-1).kind, "whole");
  assert.equal(page.held.state.settings.theme, "dark");
  assert.deepEqual(withoutSeq(page.held.state), state);
});

test("a running turn's other fields and the order of its steps reach the window", () => {
  const state = makeState({ chats: 3, messages: 3, steps: 3 });
  const { page, tick } = setup(state);
  tick();
  state.runs[0].reasoning[0].text += " and more";
  state.runs[0].steps.push({ id: "step-new", name: "read", label: "Read", status: "Running", started: 9 });
  state.runs[0].todos = [{ id: "t", text: "Do it", status: "in_progress" }];
  tick();
  assert.equal(page.log.at(-1).kind, "hot");
  assert.deepEqual(withoutSeq(page.held.state), state);
  delete state.runs[0].steps;
  tick();
  assert.deepEqual(withoutSeq(page.held.state), state);
});

test("a live part that does not fit the window's state asks for the whole state", () => {
  const state = makeState({ chats: 3, messages: 3, steps: 2 });
  const { page, tick } = setup(state);
  tick();
  const held = page.held.state;
  const hot = { base: held.seq, seq: held.seq + 1, runs: [{ id: "no-such-run", rest: {} }] };
  assert.equal(applyHot(held, hot), null);
  const missing = { base: held.seq, seq: held.seq + 1, runs: [{ id: "run-live", order: ["step-0", "never-sent"] }] };
  assert.equal(applyHot(held, missing), null);
});

test("when there is no window the next push starts again with a whole state", () => {
  const state = makeState({ chats: 3, messages: 3, steps: 2 });
  const sent = [];
  let open = true;
  const push = createWindowPush({
    snapshot: () => state,
    send: (message) => { if (!open) return false; sent.push("whole"); },
    sendHot: () => { if (!open) return false; sent.push("hot"); },
    now: () => 0,
    later: () => 0,
  });
  push.flush();
  state.streams["chat-0"] = "a";
  push.flush();
  open = false;
  state.streams["chat-0"] = "ab";
  push.flush();
  open = true;
  state.streams["chat-0"] = "abc";
  push.flush();
  assert.deepEqual(sent, ["whole", "hot", "whole"]);
});

test("a hot message is a small part of the whole state for a chat with many messages", () => {
  const state = makeState({ chats: 300, messages: 200, steps: 40 });
  const { page, tick } = setup(state);
  tick();
  const whole = page.log.at(-1).message;
  state.streams["chat-0"] += "a few more words of the reply";
  state.runs[0].steps.at(-1).output += "one more line of output\n";
  tick();
  const hot = page.log.at(-1).message;
  const ratio = bytes(hot) / bytes(whole);
  console.log(`whole state ${(bytes(whole) / 1e6).toFixed(1)} MB (${state.chats.length} chats x 200 messages, ${state.runs.length} runs), hot message ${(bytes(hot) / 1e3).toFixed(1)} KB (${(ratio * 100).toFixed(3)}%)`);
  assert.equal(page.log.at(-1).kind, "hot");
  assert.ok(ratio < 0.01, "ratio " + ratio);
});

test("the shape changes with what a person waits for", () => {
  const state = makeState({ chats: 2, messages: 2, steps: 1 });
  const before = shapeOf(state);
  state.chats[1].messages.push({ role: "user", text: "hi", time: 3 });
  assert.notEqual(shapeOf(state), before);
});

test("share matches lists of things with an id by the id, and other lists by place", () => {
  const before = { chats: [{ id: "a", messages: [{ text: "1" }] }, { id: "b", messages: [{ text: "2" }] }] };
  const after = share(before, structuredClone({ chats: [{ id: "new", messages: [] }, ...before.chats] }));
  assert.equal(after.chats[1], before.chats[0]);
  assert.equal(after.chats[2], before.chats[1]);
  const appended = share(before, structuredClone({ chats: [{ id: "a", messages: [{ text: "1" }, { text: "3" }] }, before.chats[1]] }));
  assert.equal(appended.chats[0].messages[0], before.chats[0].messages[0]);
  assert.equal(appended.chats[1], before.chats[1]);
  assert.equal(share(before, structuredClone(before)), before);
});
