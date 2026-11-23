// Settings › Chat › Steps › Folded (the default): while a turn runs it reads as Every step does; once
// it ends, everything of the bot's but the reply rolls up into one fold line under the reply. What
// goes into the fold and in which order, the line's words, how Thinking governs thoughts and interim
// texts everywhere, and how a saved choice is read. The plain logic is src/features/chat/fold.ts
// and src/features/chat/turn.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, Run, Step } from "../src/link/types";
import { foldLine, foldParts, liveLine, settleSteps, spentTime, statusLead } from "../src/features/chat/fold";
import { chatTimeline, type Item, reuseItems, type TimelineInput, type TurnPrefs } from "../src/features/chat/turn";

const T0 = 1_700_000_000_000;
const at = (seconds: number) => T0 + seconds * 1000;
const step = (id: string, seconds: number, more: Partial<Step> = {}): Step => ({ id, name: "bash", label: "Ran " + id, status: "Done", started: at(seconds), finished: at(seconds + 1), ...more });
const run = (more: Partial<Run> = {}): Run => ({ id: "r1", chatId: "c1", title: "Do the thing", time: at(0), status: "Working", ...more });
// Most historical fixtures exercise ordering with updates visible; dedicated cases below select
// Folded thinking explicitly now that it is rail-only.
const FOLDED: TurnPrefs = { steps: "folded", thinking: "folded", foldFinishedSteps: true };

function input(more: Partial<Omit<TimelineInput, "prefs">> & { prefs?: Partial<TurnPrefs> }): TimelineInput {
  const { prefs, ...rest } = more;
  return { messages: [], from: 0, runs: {}, timeline: false, group: false, prefs: { ...FOLDED, ...prefs }, ...rest };
}
/**
 * The chat, oldest first: "user:…", "assistant:…", "text:…" (an interim text), "thought:…",
 * "steps:a,b" / "work:a,b" (a part's steps live / finished), "live:c|…" (the newest part's steps
 * and the text being written), "fold:…" / "fold*:…" (the fold line, or the turn's status line while it runs).
 */
function shape(items: Item[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case "message":
        return (item.message.interim ? "interim" : item.message.role) + ":" + item.message.text;
      case "fold":
        return (item.live ? "fold*:" : "fold:") + item.line;
      case "live":
        return "live:" + item.steps.map((s) => s.id).join(",") + "|" + item.text;
      case "work":
        return (item.live ? "steps:" : "work:") + item.steps.map((s) => s.id).join(",") + (item.thinking ? "+thinking" : "");
      case "text":
        return "text:" + item.text;
      case "thought":
        return "thought:" + item.text;
      case "ended":
        return "ended:" + item.ending.label + (item.retry ? " (try again)" : "");
      default:
        return item.kind;
    }
  });
}
/** What a fold holds, in order: "text:…", "thought:…", "step:a", "you:…". */
function inside(items: Item[]): string[] {
  const fold = items.find((item) => item.kind === "fold");
  assert.ok(fold?.kind === "fold", "a fold");
  return fold.entries.map((entry) => (entry.kind === "step" ? "step:" + entry.step.id : entry.kind === "person" ? "you:" + entry.text : entry.kind + ":" + entry.text));
}

const ask: Message = { role: "user", text: "Do the thing", runId: "r1", time: at(0) };

// ── The setting ──────────────────────────────────────────────────────────────────────────────────

test("everyone moves to Folded once; a choice made after that is kept, and the old Summary reads as Folded", () => {
  assert.equal(settleSteps({}), "folded");
  assert.equal(settleSteps({ steps: "show" }), "folded", "a choice saved before the flag was the old default, not a pick");
  assert.equal(settleSteps({ steps: "hide" }), "folded");
  assert.equal(settleSteps({ steps: "show", stepsPicked: true }), "show");
  assert.equal(settleSteps({ steps: "failed", stepsPicked: true }), "failed");
  assert.equal(settleSteps({ steps: "hide", stepsPicked: true }), "folded");
  assert.equal(settleSteps({ steps: "summary", stepsPicked: true }), "folded");
  assert.equal(settleSteps({ steps: "nonsense", stepsPicked: true }), "folded");
});

// ── The fold line's words ────────────────────────────────────────────────────────────────────────

test("the fold line says how long the turn worked and what it did, in the old line's words", () => {
  assert.equal(spentTime(52_000), "52s");
  assert.equal(spentTime(400), "1s");
  assert.equal(spentTime(75_000), "1m 15s");
  assert.equal(spentTime(3_700_000), "1h 1m");
  assert.equal(foldLine({ took: 52_000, steps: 4, onlyThinking: false }), "Worked for 52s · 4 steps");
  assert.equal(foldLine({ took: 9_000, steps: 1, onlyThinking: false }), "Worked for 9s · 1 step");
  assert.equal(foldLine({ took: 3_000, steps: 0, onlyThinking: true }), "Thought for 3s");
  assert.equal(foldLine({ steps: 2, onlyThinking: false }), "2 steps", "no time known: no made-up time");
  assert.equal(foldLine({ steps: 0, onlyThinking: false }), "Show work");
});

test("while a turn runs, its status line under the text only counts: the steps themselves are in the chat", () => {
  assert.equal(liveLine(3), "Working… · 3 steps");
  assert.equal(liveLine(0), "Working…");
  // Beside the bot's face and its typing dots: what it says it is doing, else "Working…"; the count is a pill of its own.
  assert.equal(statusLead("Reading the logs"), "Reading the logs");
  assert.equal(statusLead("  "), "Working…");
  assert.equal(statusLead(undefined), "Working…");
});

test("the fold line's words come in two parts: the time, and the count for its pill", () => {
  assert.deepEqual(foldParts({ took: 11_000, steps: 7, onlyThinking: false }), { lead: "Worked for 11s", count: "7 steps" });
  assert.deepEqual(foldParts({ took: 3_000, steps: 0, onlyThinking: true }), { lead: "Thought for 3s", count: "" }, "no steps: no pill");
  assert.deepEqual(foldParts({ steps: 2, onlyThinking: false }), { lead: "", count: "2 steps" }, "no time known: the pill alone");
  assert.deepEqual(foldParts({ steps: 0, onlyThinking: false }), { lead: "Show work", count: "" });
});

// ── A finished turn ──────────────────────────────────────────────────────────────────────────────

const worked: Message[] = [
  { role: "user", text: "Check the deploy and fix what's broken", runId: "r1", time: 0 },
  { role: "assistant", text: "I'll look at the last deploy first.", runId: "r1", time: 400, interim: true },
  { role: "user", text: "Only staging, please", steeredRunId: "r1", time: 5200 },
  { role: "assistant", text: "Staging only, then. One question first.", runId: "r1", time: 5600, interim: true },
  { role: "user", text: "Yes", time: 9100, answer: { runId: "r1", requestId: "q1", kind: "question", title: "Restart the staging server?" } },
  { role: "assistant", text: "Restarted. Staging is healthy again.", runId: "r1", time: 14200 },
];
const workedSteps: Step[] = [
  { id: "s1", name: "bash", label: "tail deploy.log", status: "Done", started: 1900, finished: 2600 },
  { id: "h1", name: "task", label: "Check staging's health", status: "Done", started: 2700, finished: 8000 },
  { id: "s2", name: "web_fetch", label: "https://staging.example.com/health", status: "Done", started: 3000, finished: 3400, agentId: "h1" },
  { id: "s3", name: "ask_user", label: "ask_user", status: "Done", started: 6000, finished: 9100 },
  { id: "s4", name: "bash", label: "systemctl restart api", status: "Done", started: 9300, finished: 13800 },
];
const r1: Run = { id: "r1", chatId: "c1", title: "Check the deploy", time: 0, status: "Completed", finished: 52_000, steps: workedSteps, reasoning: [{ id: "t1", text: "Read the deploy log before anything.", started: 100, finished: 350 }] };

test("folded, a finished turn is the person's message, their steers and answers, the reply, and one fold line under it", () => {
  const items = chatTimeline(input({ timeline: true, messages: worked, runs: { r1 } }));
  assert.deepEqual(shape(items), ["user:Check the deploy and fix what's broken", "user:Only staging, please", "user:Yes", "assistant:Restarted. Staging is healthy again.", "fold:Worked for 52s · 5 steps"]);
  // The fold holds everything else, in the order it happened; a helper's own step stays in its sheet.
  assert.deepEqual(inside(items), [
    "thought:Read the deploy log before anything.",
    "text:I'll look at the last deploy first.",
    "step:s1",
    "step:h1",
    "step:s2",
    "you:Only staging, please",
    "text:Staging only, then. One question first.",
    "step:s3",
    "you:Restart the staging server?: Yes",
    "step:s4",
  ]);
  const reply = items.at(-2);
  assert.ok(reply?.kind === "message" && reply.end, "the reply ends the turn; its cards stay with it");
  const fold = items.at(-1);
  assert.ok(fold?.kind === "fold" && fold.key === "f:r1" && !fold.live && fold.lead === "Worked for 52s" && fold.count === "5 steps", "the time, and the count for its pill");
});

test("folded, from an older computer: the steps and the steer's place are in the fold, the reply in the chat", () => {
  const older = [worked[0], worked[2], { role: "assistant", text: "Restarted. Staging is healthy again.", runId: "r1" } as Message];
  const plain = { ...r1, reasoning: undefined, steps: workedSteps.map(({ agentId: _agentId, ...rest }) => rest) };
  const items = chatTimeline(input({ messages: older, runs: { r1: plain } }));
  assert.deepEqual(shape(items), ["user:Check the deploy and fix what's broken", "user:Only staging, please", "assistant:Restarted. Staging is healthy again.", "fold:Worked for 52s · 5 steps"]);
  assert.deepEqual(inside(items), ["step:s1", "step:h1", "step:s2", "you:Only staging, please", "step:s3", "step:s4"]);
});

test("Thinking decides whether thoughts are in the fold", () => {
  const hidden = chatTimeline(input({ timeline: true, messages: worked, runs: { r1 }, prefs: { steps: "folded", thinking: "hide" } }));
  assert.equal(inside(hidden).some((entry) => entry.startsWith("thought:")), false);
  const open = chatTimeline(input({ timeline: true, messages: worked, runs: { r1 }, prefs: { steps: "folded", thinking: "show" } }));
  assert.equal(inside(open)[0], "thought:Read the deploy log before anything.");
});

test("finished folding includes all calls when the canvas is filtered", () => {
  const failedRun = { ...r1, steps: workedSteps.map((s) => (s.id === "s4" ? { ...s, status: "Failed" } : s)) };
  const failed = chatTimeline(input({ timeline: true, messages: worked, runs: { r1: failedRun }, prefs: { steps: "failed", thinking: "folded" } }));
  assert.deepEqual(shape(failed).at(-1), "fold:Worked for 52s · 5 steps");
  assert.deepEqual(inside(failed), ["thought:Read the deploy log before anything.", "text:I'll look at the last deploy first.", "step:s1", "step:h1", "step:s2", "you:Only staging, please", "text:Staging only, then. One question first.", "step:s3", "you:Restart the staging server?: Yes", "step:s4"]);
  const hidden = chatTimeline(input({ timeline: true, messages: worked, runs: { r1 }, prefs: { steps: "folded", thinking: "folded" } }));
  assert.deepEqual(shape(hidden).at(-1), "fold:Worked for 52s · 5 steps");
  assert.equal(inside(hidden).filter((entry) => entry.startsWith("step:")).length, 5);
  // A single call still has a fold even with thinking hidden.
  const quiet = chatTimeline(input({ messages: [ask, { role: "assistant", text: "Done.", runId: "r1" }], runs: { r1: run({ status: "Completed", steps: [step("a", 1)] }) }, prefs: { steps: "folded", thinking: "hide" } }));
  assert.deepEqual(shape(quiet), ["user:Do the thing", "assistant:Done.", "fold:1 step"]);
});

test("a turn that ended with no reply: the fold, then how it ended with Try again; what it wrote is in the fold", () => {
  const stalled = run({ status: "Needs you", finished: at(700), detail: "Copilot session stalled without an event for 600 seconds.", steps: [step("a", 1), step("b", 2, { status: "Interrupted" })] });
  const items = chatTimeline(input({ messages: [ask], runs: { r1: stalled }, running: stalled, marks: { r1: { marks: { "s:a": 0, "s:b": 0 }, text: "I found three files and" } } }));
  assert.deepEqual(shape(items), ["user:Do the thing", "fold:Worked for 11m 40s · 2 steps", "ended:Timed out (try again)"]);
  assert.deepEqual(inside(items), ["step:a", "step:b", "text:I found three files and"]);
  // Only tools, no reply, finished: the fold and nothing after it.
  const tools = chatTimeline(input({ messages: [ask], runs: { r1: run({ status: "Completed", finished: at(4), steps: [step("a", 1)] }) } }));
  assert.deepEqual(shape(tools), ["user:Do the thing", "fold:Worked for 4s · 1 step"]);
});

// ── A turn under way ─────────────────────────────────────────────────────────────────────────────

const interim: Message = { role: "assistant", text: "Let me look at the logs.", runId: "r1", time: at(1), interim: true };
const answer: Message = { role: "user", text: "Staging", time: at(6), answer: { runId: "r1", requestId: "q1", kind: "question", title: "Which environment?" } };
const second: Message = { role: "assistant", text: "Staging it is.", runId: "r1", time: at(7), interim: true };
const liveSteps = [step("a", 2), step("b", 4), step("c", 8, { status: "Running", finished: undefined })];
const liveRun = run({ steps: liveSteps, reasoning: [{ id: "t1", text: "Read the logs first.", started: at(0.5) }] });
const underWay = (prefs: Partial<TurnPrefs>) => chatTimeline(input({ timeline: true, messages: [ask, interim, answer, second], running: liveRun, live: { stream: "Deploying" }, prefs: { ...FOLDED, ...prefs } }));

test("Folded keeps running steps in the rail and Open also puts them in the canvas", () => {
  const every = underWay({ steps: "show", thinking: "folded", foldFinishedSteps: false });
  assert.deepEqual(shape(every), ["user:Do the thing", "steps:a,b", "user:Staging", "live:c|Deploying", "fold*:Working… · 3 steps"]);
  const folded = underWay(FOLDED);
  assert.deepEqual(shape(folded), ["user:Do the thing", "user:Staging", "live:|Deploying", "fold*:Working… · 3 steps"]);
  const status = folded.at(-1);
  assert.ok(status?.kind === "fold" && status.live && status.count === "3 steps", "the count, for the pill beside the bot's face");
  const text = folded.at(-2);
  assert.ok(text?.kind === "live" && text.reserve, "the text keeps room for the reply's row, so it stays put when it becomes the reply");
  const everyLive = every.at(-2);
  assert.ok(everyLive?.kind === "live" && !everyLive.reserve, "Every step keeps no room: it doesn't fold");
  // The rail counts all calls, including when the canvas only shows failures.
  assert.deepEqual(shape(underWay({ steps: "failed", thinking: "folded" })).at(-1), "fold*:Working… · 3 steps");
});

test("from live to finished the reply keeps its place and the status line becomes the fold line, as the same row", () => {
  const steps = [step("a", 1)];
  const working = chatTimeline(input({ timeline: true, messages: [ask], running: run({ steps }), live: { stream: "All done." } }));
  const done = run({ status: "Completed", finished: at(3), steps });
  const finished = chatTimeline(input({ timeline: true, messages: [ask, { role: "assistant", text: "All done.", runId: "r1", time: at(2) }], runs: { r1: done }, running: null }));
  assert.deepEqual(shape(working), ["user:Do the thing", "live:|All done.", "fold*:Working… · 1 step"]);
  assert.deepEqual(shape(finished), ["user:Do the thing", "assistant:All done.", "fold:Worked for 3s · 1 step"]);
  assert.equal(working.at(-1)?.key, finished.at(-1)?.key, "one row, so it settles in place");
  // Before anything has come, the status line (the bot's face and its typing dots) is the whole live row, in every mode.
  for (const steps of ["folded", "show", "failed"] as const) {
    const quiet = chatTimeline(input({ timeline: true, messages: [ask], running: run({ steps: [] }), live: { stream: "" }, prefs: { steps, thinking: "folded" } }));
    assert.deepEqual(shape(quiet), ["user:Do the thing", "fold*:Working…"], steps);
  }
  // A part whose only steps Hidden leaves out has nothing to draw either.
  const hidden = chatTimeline(input({ timeline: true, messages: [ask], running: run({ steps }), live: { stream: "" }, prefs: { steps: "folded", thinking: "folded" } }));
  assert.deepEqual(shape(hidden), ["user:Do the thing", "fold*:Working… · 1 step"]);
});

test("from an older computer, a turn under way is cut by the phone's marks as Every step cuts it", () => {
  const steer: Message = { role: "user", text: "Use staging", steeredRunId: "r1", time: at(5) };
  const marks = { r1: { marks: { "s:a": 0, "s:b": 9, ["p:" + at(5) + ":11"]: 9, "s:c": 22 }, text: "Checking. Now staging. Almost" } };
  const items = chatTimeline(input({ messages: [ask, steer], running: run({ steps: [step("a", 1), step("b", 3), step("c", 7, { status: "Running" })] }), live: { stream: "Checking. Now staging. Almost" }, marks }));
  assert.deepEqual(shape(items), ["user:Do the thing", "user:Use staging", "live:|Almost", "fold*:Working… · 3 steps"]);
});

// ── Thinking and updates ─────────────────────────────────────────────────────────────────────────

test("Thinking and updates governs interim texts as it does thinking: in the chat while it runs, in Every step's finished turns, and in the fold", () => {
  // Hidden: neither is in the chat; the reply and the person's words stay.
  const hidden = underWay({ steps: "show", thinking: "hide" });
  assert.deepEqual(shape(hidden), ["user:Do the thing", "steps:a,b", "user:Staging", "live:c|Deploying", "fold*:Working… · 3 steps"]);
  const folded = underWay({ steps: "folded", thinking: "hide" });
  assert.deepEqual(shape(folded), ["user:Do the thing", "user:Staging", "live:|Deploying", "fold*:Working… · 3 steps"]);

  // Every step, finished: thoughts and interim texts sit in place, as asides; Hidden leaves them out.
  const reply: Message = { role: "assistant", text: "Deployed.", runId: "r1", time: at(10) };
  const done = { ...liveRun, status: "Completed", finished: at(11), steps: liveSteps.map((s) => ({ ...s, status: "Done" })) };
  const finished = (thinking: TurnPrefs["thinking"]) => shape(chatTimeline(input({ timeline: true, messages: [ask, interim, answer, second, reply], runs: { r1: done }, prefs: { steps: "show", thinking, foldFinishedSteps: false } })));
  assert.deepEqual(finished("folded"), ["user:Do the thing", "work:a,b", "user:Staging", "work:c", "assistant:Deployed.", "activity"]);
  assert.deepEqual(finished("show"), ["user:Do the thing", "thought:Read the logs first.", "text:Let me look at the logs.", "work:a,b", "user:Staging", "text:Staging it is.", "work:c", "assistant:Deployed.", "activity"]);
  assert.deepEqual(finished("hide"), ["user:Do the thing", "work:a,b", "user:Staging", "work:c", "assistant:Deployed.", "activity"]);

  // In the fold: Hidden keeps both out; the steps and the person's place stay.
  const fold = chatTimeline(input({ timeline: true, messages: worked, runs: { r1 }, prefs: { steps: "folded", thinking: "hide", foldFinishedSteps: true } }));
  assert.deepEqual(inside(fold), ["step:s1", "step:h1", "step:s2", "you:Only staging, please", "step:s3", "you:Restart the staging server?: Yes", "step:s4"]);
  // The reply is never folded or hidden.
  assert.equal(shape(fold).at(-2), "assistant:Restarted. Staging is healthy again.");
});

test("nothing the person said moves above what came before it", () => {
  const items = chatTimeline(input({ timeline: true, messages: worked, runs: { r1 } }));
  const said = items.flatMap((item) => (item.kind === "message" ? [item.index] : []));
  assert.deepEqual(said, [...said].sort((a, b) => a - b));
});

test("a fold that didn't change is the same row the next time, while the text streams", () => {
  const steps = [step("a", 1), step("b", 2, { status: "Running", finished: undefined })];
  const make = (stream: string) => chatTimeline(input({ timeline: true, messages: [ask], running: run({ steps }), live: { stream } }));
  const first = reuseItems(undefined, make("Hel"));
  const second = reuseItems(first.byKey, make("Hello"));
  const fold = (items: Item[]) => items.find((item) => item.kind === "fold");
  assert.equal(fold(second.items), fold(first.items));
});

// ── Group chats ──────────────────────────────────────────────────────────────────────────────────

test("a group chat keeps each member's reply in turn, with interim texts in the fold under the last reply", () => {
  const note: Message = { role: "assistant", text: "Mira: checking the calendar.", runId: "r1", botId: "mira", time: at(1), interim: true };
  const first: Message = { role: "assistant", text: "Mira here.", runId: "r1", botId: "mira", time: at(3) };
  const second: Message = { role: "assistant", text: "Otto here.", runId: "r1", botId: "otto", time: at(6) };
  const done = run({ status: "Completed", finished: at(8), steps: [step("a", 2)] });
  const items = chatTimeline(input({ group: true, timeline: true, messages: [ask, note, first, second], runs: { r1: done } }));
  assert.deepEqual(shape(items), ["user:Do the thing", "assistant:Mira here.", "assistant:Otto here.", "fold:Worked for 8s · 1 step"]);
  assert.deepEqual(inside(items), ["text:Mira: checking the calendar.", "step:a"]);
  const last = items.at(-2);
  assert.ok(last?.kind === "message" && last.end);

  // While it runs: each reply in turn, the interim text in its place (as Thinking says), the text being written, and the status line.
  const running = run({ steps: [step("a", 2)] });
  const live = chatTimeline(input({ group: true, timeline: true, messages: [ask, note, first], running, live: { stream: "Otto: on it" } }));
  assert.deepEqual(shape(live), ["user:Do the thing", "assistant:Mira here.", "live:|Otto: on it", "fold*:Working… · 1 step"]);
  const quiet = chatTimeline(input({ group: true, timeline: true, messages: [ask, note, first], running, live: { stream: "Otto: on it" }, prefs: { steps: "folded", thinking: "hide" } }));
  assert.deepEqual(shape(quiet), ["user:Do the thing", "assistant:Mira here.", "live:|Otto: on it", "fold*:Working… · 1 step"]);
});
