// A chat when the computer kept the work moving: the quiet "Kept going" line, "Stopped with N open
// steps" with Continue, a waiting question, and that a computer that sends none of it looks as before.
// The words are the desktop app's (desktop/src/keep.ts says the same; its test checks them too).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { CONTINUE_OPEN_STEPS, keptLine, openLine } from "../src/features/chat/keep";
import { DETACHED_LINE } from "../src/features/chat/request/logic";
import { chatTimeline, type Item, type TimelineInput } from "../src/features/chat/turn";
import type { AgentRequest, Message, Run } from "../src/link/types";

const T0 = 1_700_000_000_000;
const at = (seconds: number) => T0 + seconds * 1000;
const run = (more: Partial<Run> = {}): Run => ({ id: "r1", chatId: "c1", title: "Do the thing", time: at(0), status: "Completed", finished: at(30), ...more });
const SHOW = { steps: "show", thinking: "show", foldFinishedSteps: false } as const;
const input = (more: Partial<TimelineInput>): TimelineInput => ({ messages: [], from: 0, runs: {}, timeline: true, group: false, prefs: SHOW, ...more });
const shape = (items: Item[]) =>
  items.map((item) => (item.kind === "message" ? (item.message.interim ? "interim" : item.message.role) + ":" + item.message.text : item.kind === "kept" ? "kept:" + item.line : item.kind === "open" ? "open:" + item.line + (item.again ? " [Continue]" : "") : item.kind));

const ask: Message = { role: "user", text: "Do the thing", runId: "r1", time: at(0) };
const first: Message = { role: "assistant", text: "I read the notes.", runId: "r1", time: at(5) };
const last: Message = { role: "assistant", text: "All sent.", runId: "r1", time: at(25) };

test("the words: a plan that got more turns, the next step catch, and a stop with open steps", () => {
  assert.equal(keptLine(run({ continued: { count: 2, limit: 8, reason: "plan", open: 3 } })), "↻ Kept going: 3 plan steps were open");
  assert.equal(keptLine(run({ continued: { count: 1, limit: 8, reason: "plan", open: 1 } })), "↻ Kept going: 1 plan step was open");
  assert.equal(keptLine(run({ continued: { count: 1, limit: 8, reason: "next-step", open: 0 } })), "↻ Kept going: the next step was not done yet");
  assert.equal(keptLine(run({ continued: { count: 1, limit: 8, reason: "plan" } })), "↻ Kept going", "an older count is not guessed");
  assert.equal(keptLine(run()), undefined);
  assert.equal(openLine(run({ plan: { open: 2, total: 3 }, stoppedOpen: true })), "Stopped with 2 open steps");
  assert.equal(openLine(run({ plan: { open: 1, total: 3 }, stoppedOpen: true })), "Stopped with 1 open step");
  assert.equal(openLine(run({ plan: { open: 2, total: 3 } })), undefined, "open steps alone are not a stop");
  assert.equal(openLine(run({ plan: { open: 0, total: 3 }, stoppedOpen: true })), undefined);
  assert.equal(CONTINUE_OPEN_STEPS, "Continue with the open steps.");
  assert.equal(DETACHED_LINE, "Waiting for your answer. Your reply starts a new turn.");
});

test("a run that was kept going draws its earlier reply where it came, then the line, then the last reply", () => {
  const kept = run({ continued: { count: 1, limit: 8, reason: "plan", open: 2 }, plan: { open: 0, total: 3 } });
  const shown = chatTimeline(input({ messages: [ask, first, last], runs: { r1: kept } }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "assistant:I read the notes.", "assistant:All sent.", "kept:↻ Kept going: 2 plan steps were open"]);
  const end = shown.filter((item) => item.kind === "message").at(-1);
  assert.ok(end?.kind === "message" && end.end && !(shown[1] as Extract<Item, { kind: "message" }>).end, "only the last reply ends the run (its cards go under it)");
  // Without the field, as from an older computer, both replies come at the end as before.
  assert.deepEqual(shape(chatTimeline(input({ messages: [ask, first, last], runs: { r1: run() } }))), ["user:Do the thing", "assistant:I read the notes.", "assistant:All sent."]);
});

test("while a kept-going run works, its earlier reply is already shown and the line is above the live text", () => {
  const working = run({ status: "Working", finished: undefined, continued: { count: 1, limit: 8, reason: "plan", open: 2 } });
  const shown = chatTimeline(input({ messages: [ask, first], running: working, live: { stream: "Drafting the summary" } }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "assistant:I read the notes.", "kept:↻ Kept going: 2 plan steps were open", "live", "fold"]);
});

test("a run that stopped with open steps says so, and only the newest offers Continue", () => {
  const stopped = run({ plan: { open: 2, total: 3 }, stoppedOpen: true });
  const shown = chatTimeline(input({ messages: [ask, last], runs: { r1: stopped } }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "assistant:All sent.", "open:Stopped with 2 open steps [Continue]"]);
  // Once a later message started another turn, the old one's line stays, without the button.
  const later: Message = { role: "user", text: "Continue with the open steps.", runId: "r2", time: at(60) };
  const after = chatTimeline(input({ messages: [ask, last, later], runs: { r1: stopped } }));
  assert.ok(shape(after).includes("open:Stopped with 2 open steps"));
  // A stopped run says how it ended, then the open steps.
  const hand = run({ status: "Stopped", ending: "stopped", detail: "", plan: { open: 1, total: 2 }, stoppedOpen: true });
  assert.deepEqual(shape(chatTimeline(input({ messages: [ask], runs: { r1: hand } }))), ["user:Do the thing", "ended", "open:Stopped with 1 open step [Continue]"]);
  // A folded turn keeps the line too.
  const folded = chatTimeline(input({ messages: [ask, first, last], runs: { r1: { ...stopped, continued: { count: 8, limit: 8, reason: "plan", open: 2 } } }, prefs: { foldFinishedSteps: true } }));
  const lines = shape(folded).filter((line) => /^(kept|open):/.test(line));
  assert.deepEqual(lines, ["kept:↻ Kept going: 2 plan steps were open", "open:Stopped with 2 open steps [Continue]"]);
  assert.equal(folded.filter((item) => item.kind === "message" && item.message.role === "assistant").length, 2);
});

test("the demo computer shows all three: kept going, stopped with open steps, and a waiting question", async () => {
  const backend = new MockBackend({ speed: 0.05 });
  const chat = backend.state.chats[0];
  const wait = async (ready: () => boolean, what: string) => {
    for (const end = Date.now() + 8000; !ready(); ) {
      if (Date.now() > end) throw new Error("Timed out waiting for " + what);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const idle = () => !backend.turns.has(chat.id);
  const send = async (text: string) => {
    backend.handlers.send.call(backend, chat.id, text);
    await wait(idle, "the turn to end");
    return backend.state.runs.find((r) => r.chatId === chat.id)!;
  };
  const kept = await send("keep going on the summary");
  assert.deepEqual(kept.continued, { count: 2, limit: 8, reason: "plan", open: 2 });
  assert.deepEqual(kept.plan, { open: 0, total: 3 });
  const stopped = await send("stopped with open steps");
  assert.equal(stopped.stoppedOpen, true);
  assert.deepEqual(stopped.plan, { open: 2, total: 3 });
  assert.equal(openLine(stopped), "Stopped with 2 open steps");
  // Continue is an ordinary message: it starts a turn, and does not start the demo above again.
  const again = await send(CONTINUE_OPEN_STEPS);
  assert.equal(again.stoppedOpen, undefined);
  const before = backend.state.runs.length;
  await send("a waiting question");
  const [asked] = backend.state.requests as AgentRequest[];
  assert.equal(asked.detached, true);
  assert.equal(asked.kind, "question");
  backend.handlers.respond.call(backend, asked.id, { action: "answer", value: "Staging" });
  await wait(() => backend.state.runs.length === before + 2, "the answer's turn");
  await wait(idle, "the answer's turn to end");
  const answer = chat.messages.findLast((m: Message) => m.role === "user");
  assert.deepEqual([answer.text, answer.quote], ["Staging", "Which environment should I use?"]);
  assert.equal(backend.state.requests.length, 0);
});
