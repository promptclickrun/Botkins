// The crew of a turn on the phone (src/features/chat/crew.ts): the crew card's place in the chat
// (turn.ts), which chapters of the Activity sheet start open, the command sheet's "why" and links,
// and the demo computer's stopHelper ("stop-helper-v1").
import assert from "node:assert/strict";
import { test } from "node:test";
import { MockBackend } from "../link-host/mock-backend.mjs";
import type { Message, Run, Step, Subagent } from "../src/link/types";
import { crewLine, crewOf, storyChapters } from "../src/features/chat/activityStory";
import { clockOffset, countLine, crewFace, failedTail, linkLabel, onComputer, openChapters, outputLinks, outputTail, whyThought } from "../src/features/chat/crew";
import { railLabel, runningCommands } from "../src/features/chat/helpers";
import { chatTimeline, type Item, reuseItems, type TimelineInput } from "../src/features/chat/turn";

const T0 = 1_700_000_000_000;
const at = (seconds: number) => T0 + seconds * 1000;
const step = (id: string, seconds: number, more: Partial<Step> = {}): Step => ({ id, name: "bash", label: "Ran " + id, status: "Done", started: at(seconds), finished: at(seconds + 1), ...more });
const helper = (id: string, seconds: number, more: Partial<Subagent> = {}): Subagent => ({ id, name: "Helper " + id, status: "Running", started: at(seconds), ...more });
const run = (more: Partial<Run> = {}): Run => ({ id: "r1", chatId: "c1", title: "Do the thing", time: at(0), status: "Working", ...more });
const ask: Message = { role: "user", text: "Do the thing", runId: "r1", time: at(0) };
const reply: Message = { role: "assistant", text: "Done.", runId: "r1", time: at(20) };

function input(more: Partial<Omit<TimelineInput, "prefs">> & { prefs?: Partial<TimelineInput["prefs"]> }): TimelineInput {
  const { prefs, ...rest } = more;
  return { messages: [], from: 0, runs: {}, timeline: true, group: false, prefs: { steps: "show", thinking: "show", foldFinishedSteps: false, ...prefs }, ...rest };
}
const kinds = (items: Item[]) => items.map((item) => (item.kind === "work" ? "work:" + item.steps.map((s) => s.id).join(",") : item.kind === "message" ? item.message.role : item.kind === "fold" ? (item.live ? "status" : "fold") : item.kind));

// A turn: a step, then a helper (its starting step has the helper's id), then another step.
const steps = [step("a", 1), step("h1", 3, { name: "task", status: "Running", finished: undefined }), step("h1-s", 4, { agentId: "h1" }), step("b", 6)];

test("while a turn runs, its crew card sits where the first helper started, before the status row", () => {
  const live = run({ steps, agents: [helper("h1", 3, { intent: "Reading" })] });
  for (const island of [false, true]) {
    const items = chatTimeline(input({ messages: [ask], running: live, prefs: island ? { island: true } : {} }));
    const shape = kinds(items);
    const crew = shape.indexOf("crew");
    assert.ok(crew > 0, shape.join(" "));
    assert.equal(shape.at(-1), "status", "the status line (or island) stays last");
    // After the helper's own starting step, before what came next (the live row, with step b).
    if (!island) assert.deepEqual(shape, ["user", "work:a,h1", "crew", "live", "status"]);
    else assert.deepEqual(shape, ["user", "crew", "status"]);
    const card = items[crew] as Extract<Item, { kind: "crew" }>;
    assert.deepEqual({ line: card.line, marks: card.marks, live: card.live }, { line: "1 helper · 1 working", marks: ["Running"], live: true });
  }
});

test("once the turn ended, finished crew folds into the fold, receipt or activity line while a still-running command keeps its crew card", () => {
  const done = run({ status: "Completed", finished: at(20), steps: steps.map((s) => ({ ...s, status: "Done", finished: s.started + 1000 })), agents: [helper("h1", 3, { status: "Done", finished: at(9), result: "Found two places." })] });
  const cases: [string, Partial<TimelineInput["prefs"]>, "activity" | "fold"][] = [
    ["every step", {}, "activity"],
    ["folded", { foldFinishedSteps: true }, "fold"],
    ["island", { island: true }, "fold"],
  ];
  for (const [name, prefs, kind] of cases) {
    const items = chatTimeline(input({ messages: [ask, reply], runs: { r1: done }, prefs }));
    const shape = kinds(items);
    assert.equal(shape.includes("crew"), false, name + ": finished crew folds into the turn line");
    const row = items.find((item) => item.kind === kind);
    assert.ok(row, name + ": " + shape.join(" "));
    const text = row.kind === "activity" ? row.label ?? "" : row.kind === "fold" ? row.line : "";
    assert.match(text, /1 helper finished/, name + ": " + text);
  }
  // A still-running background command stays reachable as a crew card even after the turn ended.
  const dev = step("dev", 2, { background: true, status: "Running", finished: undefined });
  const withBg = run({ status: "Completed", finished: at(20), steps: [...steps.map((s) => ({ ...s, status: "Done", finished: s.started + 1000 })), dev] });
  const bgItems = chatTimeline(input({ messages: [ask, reply], runs: { r1: withBg }, prefs: { foldFinishedSteps: true } }));
  const bgShape = kinds(bgItems);
  const bgCrew = bgShape.indexOf("crew");
  assert.equal(bgShape[bgCrew - 1], "fold");
  assert.equal((bgItems[bgCrew] as Extract<Item, { kind: "crew" }>).line, "1 command · 1 working");
});

test("a turn without helpers or background commands has no crew card", () => {
  const items = chatTimeline(input({ messages: [ask], running: run({ steps: [step("a", 1)] }) }));
  assert.ok(!items.some((item) => item.kind === "crew"));
});

test("the folded card is the same row while helpers take steps, and a new one when a state changes", () => {
  const first = run({ steps, agents: [helper("h1", 3)] });
  const held = reuseItems(undefined, chatTimeline(input({ messages: [ask], running: first })));
  const card = held.items.find((item) => item.kind === "crew");
  // The helper takes another step: the line and the marks are the same.
  const more = run({ steps: [...steps, step("h1-t", 7, { agentId: "h1", status: "Running", finished: undefined })], agents: [helper("h1", 3, { intent: "Something else" })] });
  const next = reuseItems(held.byKey, chatTimeline(input({ messages: [ask], running: more })));
  assert.equal(next.items.find((item) => item.kind === "crew"), card, "kept as the same object, so it isn't drawn again");
  // It finishes: the line and its mark change.
  const ended = run({ steps, agents: [helper("h1", 3, { status: "Done", finished: at(8) })] });
  const after = reuseItems(next.byKey, chatTimeline(input({ messages: [ask], running: ended })));
  const changed = after.items.find((item) => item.kind === "crew");
  assert.notEqual(changed, card);
  assert.deepEqual(changed?.kind === "crew" && changed.marks, ["Done"]);
});

test("a background command is crew, and the rail shows it while it runs", () => {
  const dev = step("dev", 2, { background: true, status: "Running", finished: undefined, progress: "ready on localhost:3000", input: JSON.stringify({ command: "npm run dev" }) });
  const r = run({ steps: [step("a", 1), dev], agents: [helper("h1", 3, { status: "Done", finished: at(5) })] });
  const crew = crewOf(r);
  assert.ok(crew);
  assert.deepEqual(crewFace(crew), { line: crewLine(crew), marks: ["Running", "Done"] });
  assert.equal(crewFace(crew).line, "1 helper · 1 command · 1 working");
  assert.deepEqual(runningCommands(r.steps).map((s) => s.id), ["dev"]);
  assert.equal(railLabel(r.agents ?? [], 1), "In the background · 1 running");
  assert.equal(railLabel(r.agents ?? []), "In the background · 1 finished");
});

test("chapters with a failed step, the running one and the one holding the tapped step start open", () => {
  const thought = (id: string, seconds: number) => ({ id, text: "**Part " + id + "**\nMore words.", started: at(seconds) });
  const r = run({
    reasoning: [thought("t1", 1), thought("t2", 10), thought("t3", 20), thought("t4", 30)],
    steps: [step("a", 2, { name: "view" }), step("b", 11, { status: "Failed", output: "ok\n\n✗ applies once\n  expected 18.00, got 16.20\n$ \n" }), step("c", 21, { name: "view" }), step("d", 31, { status: "Running", finished: undefined })],
  });
  const chapters = storyChapters(r);
  assert.equal(chapters.length, 4);
  assert.deepEqual([...openChapters(chapters)], ["chapter-t2", "chapter-t4"]);
  assert.deepEqual([...openChapters(chapters, "c")], ["chapter-t2", "chapter-t3", "chapter-t4"]);
  assert.deepEqual([...openChapters(chapters, "nowhere")], ["chapter-t2", "chapter-t4"]);
  assert.equal(failedTail(r.steps?.[1].output), "ok\n✗ applies once\n  expected 18.00, got 16.20");
  assert.equal(failedTail(r.steps?.[1].output, 2), "✗ applies once\n  expected 18.00, got 16.20");
  assert.equal(failedTail(undefined), "");
});

test("a chapter's work reads as counts, and a time from the turn's start as a clock", () => {
  assert.equal(countLine([{ kind: "read", count: 3 }, { kind: "search-files", count: 2 }, { kind: "web", count: 1 }]), "3 files · 2 searches · 1 web");
  assert.equal(countLine([{ kind: "edit", count: 1 }, { kind: "command", count: 2 }]), "1 edit · 2 commands");
  assert.equal(clockOffset(0), "0:00");
  assert.equal(clockOffset(41_900), "0:41");
  assert.equal(clockOffset(12 * 60_000 + 3000), "12:03");
  assert.equal(clockOffset(3_729_000), "1:02:09");
  assert.equal(clockOffset(-5000), "0:00");
});

test("why a command started: the thought that began last before it", () => {
  const thoughts = [
    { id: "1", text: "First, read the code.", started: at(1) },
    { id: "2", text: "  Start the dev server so the fix can be tried.  ", started: at(10) },
    { id: "3", text: "   ", started: at(11) },
    { id: "4", text: "Later thought.", started: at(30) },
  ];
  assert.equal(whyThought(thoughts, at(12)), "Start the dev server so the fix can be tried.", "an empty thought is passed over");
  assert.equal(whyThought(thoughts, at(10)), "Start the dev server so the fix can be tried.", "one that began at the same moment counts");
  assert.equal(whyThought(thoughts, at(5)), "First, read the code.");
  assert.equal(whyThought(thoughts, at(0)), undefined, "nothing before it");
  assert.equal(whyThought(undefined, at(5)), undefined);
});

test("links a command printed: web addresses and local ports, once each, in order", () => {
  const out = "  VITE ready\n  ➜  Local:   http://localhost:3000/\n  ➜  Network: use --host\nDocs at https://vite.dev/guide/, see (https://example.com/a?b=1).\nAlso on localhost:3000 and 127.0.0.1:8080/api and 0.0.0.0:5173.";
  assert.deepEqual(outputLinks(out), ["http://localhost:3000/", "https://vite.dev/guide/", "https://example.com/a?b=1", "http://127.0.0.1:8080/api"]);
  assert.deepEqual(outputLinks(out, 10).at(-1), "http://localhost:5173");
  assert.deepEqual(outputLinks("no links here, port 3000"), []);
  assert.deepEqual(outputLinks(undefined), []);
  // On the phone, localhost is the phone: those addresses are your computer's, so they aren't opened here.
  assert.deepEqual(["http://localhost:3000/", "http://127.0.0.1:8080/api", "http://[::1]:5000/", "https://vite.dev/guide/", "http://localhost.example.com/"].map(onComputer), [true, true, true, false, false]);
  assert.equal(linkLabel("http://localhost:3000/"), "localhost:3000");
});

test("a long output keeps its newest lines and says how many came before", () => {
  const text = Array.from({ length: 10 }, (_, i) => "line " + (i + 1)).join("\n") + "\n";
  assert.deepEqual(outputTail(text, 3), { text: "line 8\nline 9\nline 10", hidden: 7 });
  assert.deepEqual(outputTail("one\ntwo", 3), { text: "one\ntwo", hidden: 0 });
});

test("the demo computer's crew turn, and stopping a helper and a command there", async () => {
  const backend = new MockBackend({ speed: 0.1 });
  assert.ok(backend.capabilities.includes("stop-helper-v1"));
  const demo = () => backend.state.runs.find((one: Run) => one.id === "run-crew") as Run;
  const crew = crewOf(demo());
  assert.ok(crew);
  assert.equal(crewLine(crew), "2 helpers · 1 command · 2 working");
  assert.deepEqual(crew.members.map((member) => [member.kind, member.name, member.stoppable]), [
    ["helper", "Code searcher", true],
    ["helper", "Docs reader", false],
    ["command", "npm run dev", true],
  ]);
  assert.ok(demo().steps?.some((s) => s.agentId === "task-searcher"), "the helper's own steps say whose they are");
  assert.ok(outputLinks(demo().steps?.find((s) => s.background)?.progress).includes("http://localhost:3000/"));
  assert.ok(storyChapters(demo()).length >= 3, "it has thinking to tell as a story");
  assert.ok(backend.state.chats.find((chat: { id: string; messages: Message[] }) => chat.id === "chat-crew")?.messages.some((m: Message) => m.interim), "and updates between");

  await backend.call("stopHelper", ["chat-crew", "task-searcher"]);
  const searcher = demo().agents?.find((agent) => agent.id === "task-searcher");
  assert.equal(searcher?.status, "Stopped");
  assert.equal(searcher?.stoppable, undefined);
  assert.ok(searcher?.finished);
  assert.ok(!demo().steps?.some((s) => (s.agentId === "task-searcher" || s.id === "task-searcher") && s.status === "Running"), "its steps under way end with it");

  await backend.call("stopHelper", ["chat-crew", "crew-dev"]);
  const dev = demo().steps?.find((s) => s.id === "crew-dev");
  assert.equal(dev?.status, "Stopped");
  assert.equal(dev?.stoppable, undefined);
  assert.equal(crewOf(demo())?.running, 0);

  await assert.rejects(backend.call("stopHelper", ["chat-crew", "nobody"]));
  await assert.rejects(backend.call("stopHelper", ["chat-launch", "crew-dev"]), "only in its own chat");
});
