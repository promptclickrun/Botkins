// A chat read in the order things happened (src/features/chat/turn.ts), the helpers of a turn
// (src/features/chat/helpers.ts), and how a turn that ended without a reply is shown. The last
// tests run the demo computer (link-host/mock-backend.mjs) with and without "turn-timeline-v1".
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, pair, type Pairing } from "../src/link/client";
import { parsePairingUrl } from "../src/link/pairing";
import type { ChatDetail, Live, Message, PanePanel, Run, Step, Subagent } from "../src/link/types";
import { helperDetail, latestTurn, railLabel } from "../src/features/chat/helpers";
import { answerText, chatTimeline, endingOf, type Item, markKeys, noteMarks, type RunMarks, stepLabel, TIMELINE_V1, type TimelineInput, underWay, workSummary } from "../src/features/chat/turn";
import { mergeChat } from "../src/state/store";

const T0 = 1_700_000_000_000;
const at = (seconds: number) => T0 + seconds * 1000;
const step = (id: string, seconds: number, more: Partial<Step> = {}): Step => ({ id, name: "bash", label: "Ran " + id, status: "Done", started: at(seconds), finished: at(seconds + 1), ...more });
const run = (more: Partial<Run> = {}): Run => ({ id: "r1", chatId: "c1", title: "Do the thing", time: at(0), status: "Working", ...more });
const SHOW = { steps: "show", thinking: "folded" } as const;

function input(more: Partial<TimelineInput>): TimelineInput {
  return { messages: [], from: 0, runs: {}, timeline: false, group: false, prefs: SHOW, ...more };
}
/** A short picture of the list, oldest first: "user:Do the thing", "work:a,b", "text:…", "live:…". */
function shape(items: Item[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case "message":
        return (item.message.interim ? "interim" : item.message.role) + ":" + item.message.text;
      case "work":
        return (item.live ? "steps:" : "work:") + item.steps.map((s) => s.id).join(",");
      case "text":
        return (item.unfinished ? "unfinished:" : "text:") + item.text;
      case "thought":
        return "thought:" + item.text;
      case "screen":
        return "screen:" + item.panel.id;
      case "ended":
        return "ended:" + item.ending.label + (item.retry ? " (try again)" : "");
      case "live":
        return "live:" + item.steps.map((s) => s.id).join(",") + "|" + item.text;
      case "fold":
        return "fold";
    }
  });
}

const ask: Message = { role: "user", text: "Do the thing", runId: "r1", time: at(0) };

test("a steer from a computer without the capability lands between the steps around it, while the turn runs and after", () => {
  const steer: Message = { role: "user", text: "Use staging", steeredRunId: "r1", time: at(5) };
  const steps = [step("a", 1), step("b", 3), step("c", 7, { status: "Running", finished: undefined })];
  const live = run({ steps });
  // The phone saw the turn from its start: "Checking." came before b, "Now staging." after the steer.
  const marks: RunMarks = { marks: { "s:a": 0, "s:b": 9, [markKeys(live, [ask, steer]).at(-1)!]: 9, "s:c": 22 }, text: "Checking. Now staging. Almost" };
  const shown = chatTimeline(input({ messages: [ask, steer], running: live, live: { stream: "Checking. Now staging. Almost" }, marks: { r1: marks } }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "steps:a", "text:Checking.", "steps:b", "user:Use staging", "text:Now staging.", "live:c|Almost", "fold"]);

  // After the turn: the steps fold into work lines in place, and the reply comes last.
  const done = run({ status: "Completed", finished: at(9), steps: steps.map((s) => ({ ...s, status: "Done", finished: s.started + 500 })) });
  const reply: Message = { role: "assistant", text: "All done on staging.", runId: "r1" };
  const after = chatTimeline(input({ messages: [ask, steer, reply], runs: { r1: done } }));
  assert.deepEqual(shape(after), ["user:Do the thing", "work:a,b", "user:Use staging", "work:c", "assistant:All done on staging."]);
  const last = after.at(-1);
  assert.ok(last?.kind === "message" && last.end && !last.workUnder, "the reply ends its turn and has no work line of its own");
});

test("without marks the live text stays at the end, as before, and the steer still sits among the steps by time", () => {
  const steer: Message = { role: "user", text: "Also check prod", steeredRunId: "r1", time: at(4) };
  const live = run({ steps: [step("a", 1), step("b", 6, { status: "Running" })] });
  const shown = chatTimeline(input({ messages: [ask, steer], running: live, live: { stream: "Looking now" } }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "steps:a", "user:Also check prod", "live:b|Looking now", "fold"]);
});

test("a computer with turn-timeline-v1 sends interim text and answers as messages: they are drawn where they happened, interim text as the bot's updates", () => {
  const interim: Message = { role: "assistant", text: "Let me look at the logs.", runId: "r1", time: at(1), interim: true };
  const question: Message = { role: "user", text: "Staging", time: at(6), answer: { runId: "r1", requestId: "q1", kind: "question", title: "Which environment?" } };
  const second: Message = { role: "assistant", text: "Staging it is.", runId: "r1", time: at(7), interim: true };
  const steps = [step("a", 2), step("b", 4), step("c", 8, { status: "Running" })];
  const thinking = [{ id: "t1", text: "Read the logs first.", started: at(0.5) }];
  const live = run({ steps, reasoning: thinking });
  const shown = chatTimeline(input({ timeline: true, messages: [ask, interim, question, second], running: live, live: { stream: "Deploying" } }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "steps:", "text:Let me look at the logs.", "steps:a,b", "user:Staging", "text:Staging it is.", "live:c|Deploying", "fold"]);
  const thought = shown[1];
  assert.ok(thought.kind === "work" && thought.thinking === "Read the logs first.", "thinking sits where it began");

  const reply: Message = { role: "assistant", text: "Deployed.", runId: "r1", time: at(10) };
  const done = run({ status: "Completed", finished: at(11), steps: steps.map((s) => ({ ...s, status: "Done" })), reasoning: thinking });
  const after = chatTimeline(input({ timeline: true, messages: [ask, interim, question, second, reply], runs: { r1: done } }));
  // Finished, Every step keeps the thinking where it began too (Thinking and updates says how).
  assert.deepEqual(shape(after), ["user:Do the thing", "thought:Read the logs first.", "text:Let me look at the logs.", "work:a,b", "user:Staging", "text:Staging it is.", "work:c", "assistant:Deployed."]);
});

test("a helper's own steps are not the turn's: they stay in the helper's activity", () => {
  const steps = [step("task-1", 1, { name: "task" }), step("h1", 2, { agentId: "task-1" }), step("a", 3)];
  const shown = chatTimeline(input({ timeline: true, messages: [ask], running: run({ steps }), live: { stream: "" } }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "live:task-1,a|", "fold"]);
});

test("a turn that ended without a reply says how, keeps its work, and only the latest offers Try again", () => {
  assert.equal(underWay(run({ status: "Needs you" })), undefined, "the computer's run part for a failure is not a turn under way");
  const stalled = run({ status: "Needs you", finished: at(700), detail: "Copilot session stalled without an event for 600 seconds.", steps: [step("a", 1), step("b", 2, { status: "Interrupted" })] });
  assert.deepEqual(endingOf(stalled), { kind: "timed-out", label: "Timed out", detail: "Copilot session stalled without an event for 600 seconds." });
  assert.deepEqual(endingOf(run({ status: "Interrupted", detail: "" })), { kind: "interrupted", label: "Interrupted", detail: "Reply stopped." });
  assert.deepEqual(endingOf(run({ status: "Stopped" })), { kind: "stopped", label: "Stopped", detail: "Reply stopped." });
  assert.deepEqual(endingOf(run({ status: "Needs you", detail: "Claude isn't signed in." })), { kind: "failed", label: "Needs you", detail: "Claude isn't signed in." });
  assert.equal(endingOf(run({ status: "Needs you", ending: "timed-out", detail: "Gone quiet" }))?.label, "Timed out", "the computer's own word wins");
  assert.equal(endingOf(run({ status: "Completed" })), null);

  // The computer still sends the failed run as the chat's run part: the phone must not take it for a turn under way.
  const shown = chatTimeline(input({ messages: [ask], runs: { r1: stalled }, running: stalled }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "work:a,b", "ended:Timed out (try again)"]);

  // What the phone saw written before it stopped is kept (an older computer drops it).
  const remembered = chatTimeline(input({ messages: [ask], runs: { r1: stalled }, running: stalled, marks: { r1: { marks: { "s:a": 0, "s:b": 0 }, text: "I found three files and" } } }));
  assert.deepEqual(shape(remembered), ["user:Do the thing", "work:a,b", "unfinished:I found three files and", "ended:Timed out (try again)"]);

  // An earlier failed turn keeps its line but not the button; the newer turn has its reply.
  const next: Message = { role: "user", text: "Again", runId: "r2", time: at(800) };
  const reply: Message = { role: "assistant", text: "Done this time.", runId: "r2" };
  const both = chatTimeline(input({ messages: [ask, next, reply], runs: { r1: stalled, r2: run({ id: "r2", time: at(800), status: "Completed" }) } }));
  assert.deepEqual(shape(both), ["user:Do the thing", "work:a,b", "ended:Timed out", "user:Again", "assistant:Done this time."]);
  // Nothing to try again while a turn is under way.
  const busy = chatTimeline(input({ messages: [ask], runs: { r1: stalled }, live: { stream: "" } }));
  assert.ok(busy.some((item) => item.kind === "ended" && !item.retry));
});

test("a reply that already holds the text the phone remembered is not shown twice", () => {
  const done = run({ status: "Completed", steps: [step("a", 1)] });
  const reply: Message = { role: "assistant", text: "Checking.\n\nAll good.", runId: "r1" };
  const shown = chatTimeline(input({ messages: [ask, reply], runs: { r1: done }, marks: { r1: { marks: { "s:a": 9 }, text: "Checking.\n\nAll good." } } }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "work:a", "assistant:Checking.\n\nAll good."]);
});

test("Settings › Chat still decides what shows", () => {
  const steer: Message = { role: "user", text: "Stop at two", steeredRunId: "r1", time: at(5) };
  const steps = [step("a", 1), step("b", 3, { status: "Failed" }), step("c", 7)];
  const done = run({ status: "Completed", steps, summary: "Ran 3 commands" });
  const reply: Message = { role: "assistant", text: "Done.", runId: "r1" };
  const base = { messages: [ask, steer, reply], runs: { r1: done } };
  assert.deepEqual(shape(chatTimeline(input({ ...base, prefs: { steps: "hide", thinking: "folded" } }))), ["user:Do the thing", "user:Stop at two", "assistant:Done."]);
  // Failed only folds the turn like Folded does (tests/fold.test.ts), with only the failed step in it.
  const failed = chatTimeline(input({ ...base, prefs: { steps: "failed", thinking: "folded" } }));
  assert.deepEqual(shape(failed), ["user:Do the thing", "user:Stop at two", "assistant:Done.", "fold"]);
  const line = failed[3];
  assert.ok(line.kind === "fold" && line.line === "1 step failed" && line.entries.filter((entry) => entry.kind === "step").length === 1);
  // Every step: an unsplit turn keeps the computer's own summary; a split one says what each part did.
  const whole = chatTimeline(input({ messages: [ask, reply], runs: { r1: done } }));
  assert.ok(whole[1].kind === "work" && whole[1].label === "Ran 3 commands");
  const split = chatTimeline(input(base));
  assert.ok(split[1].kind === "work" && split[1].label === "Ran 2 commands");
});

test("a group chat keeps its replies in order with the work line under the last one", () => {
  const first: Message = { role: "assistant", text: "Mira here.", runId: "r1", botId: "mira", time: at(3) };
  const second: Message = { role: "assistant", text: "Otto here.", runId: "r1", botId: "otto", time: at(6) };
  const done = run({ status: "Completed", steps: [step("a", 1)] });
  const shown = chatTimeline(input({ group: true, messages: [ask, first, second], runs: { r1: done } }));
  assert.deepEqual(shape(shown), ["user:Do the thing", "assistant:Mira here.", "assistant:Otto here."]);
  const last = shown.at(-1);
  assert.ok(last?.kind === "message" && last.workUnder);
});

test("the screen a bot showed sits in the chat at the time it showed it", () => {
  const screen = (id: string, seconds: number): PanePanel => ({ id, kind: "screen", title: "Screen", botId: "b", createdAt: at(seconds), updatedAt: at(seconds) });
  const old: Message = { role: "user", text: "Earlier", time: at(-100) };
  const live = run({ steps: [step("a", 1), step("b", 5, { status: "Running" })] });
  const shown = chatTimeline(input({ timeline: true, messages: [old, ask], running: live, live: { stream: "" }, screens: [screen("s1", 3), screen("s0", -50)] }));
  assert.deepEqual(shape(shown), ["user:Earlier", "screen:s0", "user:Do the thing", "steps:a", "screen:s1", "live:b|", "fold"]);
});

test("the phone notes how long the text was when each thing first showed", () => {
  const live = run({ steps: [step("a", 1)] });
  const first = noteMarks(undefined, "Hello", markKeys(live, []));
  assert.deepEqual(first, { marks: { "s:a": 0 }, text: "Hello" }, "what was there before the phone looked counts from the start");
  const steer: Message = { role: "user", text: "More", steeredRunId: "r1", time: at(2) };
  const later = noteMarks(first, "Hello world", markKeys(run({ steps: [step("a", 1), step("b", 3)] }), [steer]));
  assert.equal(later.marks["s:b"], 11);
  assert.equal(Object.values(later.marks).filter((n) => n === 11).length, 2, "the steer too");
  assert.equal(noteMarks(later, "Hello world", markKeys(run({ steps: [step("a", 1), step("b", 3)] }), [steer])), later, "nothing new: the same object");
  assert.equal(noteMarks(later, "", []).text, "Hello world", "a text that went empty keeps what was seen");
});

test("work lines and step labels use the desktop app's words", () => {
  assert.equal(workSummary([step("a", 1), step("b", 2), { ...step("c", 3), name: "view" }, { ...step("d", 4), name: "web_search" }]), "Ran 2 commands, read a file, searched the web");
  assert.equal(workSummary([{ ...step("a", 1), name: "report_intent" }]), "");
  assert.equal(workSummary([{ ...step("a", 1), name: "x", source: "github" }]), "Used a tool");
  assert.equal(stepLabel({ ...step("q", 1), name: "ask_user", label: "ask_user", input: JSON.stringify({ question: "Which one?", choices: ["A"] }, null, 2) }), "Asked you: Which one?");
  assert.equal(stepLabel(step("a", 1)), "Ran a");
});

test("the helpers of a turn: the rail's words, and what each was asked, did and came back with", () => {
  const helper = (id: string, status: Subagent["status"], more: Partial<Subagent> = {}): Subagent => ({ id, name: "Helper " + id, status, started: at(1), ...more });
  assert.equal(railLabel([helper("1", "Running"), helper("2", "Running"), helper("3", "Done")]), "In the background · 2 running");
  assert.equal(railLabel([helper("1", "Done"), helper("2", "Failed")]), "In the background · 2 finished");

  // An older computer: what it was asked and what it said come from the task step; its own steps aren't known.
  const task = step("h1", 1, { name: "task", input: JSON.stringify({ description: "Find tests", prompt: "Find every test that opens a socket." }, null, 2), output: "Three tests open sockets." });
  const older = run({ steps: [task, step("x", 2)], agents: [helper("h1", "Done", { finished: at(31), description: "Find tests" })] });
  const seen = helperDetail(older, "h1", false);
  assert.equal(seen?.asked, "Find every test that opens a socket.");
  assert.equal(seen?.answer, "Three tests open sockets.");
  assert.equal(seen?.steps, null, "an older computer doesn't say which steps were the helper's");
  assert.equal(seen?.took, 30_000);

  // A computer with the capability marks the helper's steps and says the rest itself.
  const newer = run({ steps: [task, step("x", 2, { agentId: "h1" }), step("y", 3)], agents: [helper("h1", "Running", { prompt: "Look for sockets.", intent: "Reading tests" })] });
  const live = helperDetail(newer, "h1", true);
  assert.equal(live?.asked, "Look for sockets.");
  assert.equal(live?.answer, undefined, "nothing came back while it runs");
  assert.deepEqual(live?.steps?.map((s) => s.id), ["x"]);
  assert.equal(helperDetail(newer, "nope", true), null);

  // The rail follows the chat's newest turn, running or not.
  const finished = run({ id: "r0", status: "Completed", agents: [helper("h0", "Done")] });
  const messages: Message[] = [{ role: "user", text: "x", runId: "r0" }, { role: "assistant", text: "y", runId: "r0" }];
  assert.equal(latestTurn(undefined, messages, { r0: finished })?.id, "r0");
  assert.equal(latestTurn(newer, messages, { r0: finished })?.id, "r1");
  assert.equal(latestTurn(run({ status: "Needs you" }), [], {})?.id, "r1", "an ended run part is still the newest turn");
});

// ── The demo computer ──────────────────────────────────────────────────────────────────────────

const fetcher = fetch as unknown as FetchLike;
async function demo(timeline: boolean) {
  const backend = new MockBackend({ speed: 0.1, timeline });
  const link = new LinkHost({ relay: false, dir: mkdtempSync(join(tmpdir(), "botkins-turn-")), backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  const target = parsePairingUrl(link.startPairing().url);
  assert.ok(target);
  const paired: Pairing = await pair(fetcher, { ...target, hosts: ["127.0.0.1:" + link.port] }, { name: "Test phone", platform: "ios" });
  const parts: Record<string, unknown> = {};
  let waiters: (() => void)[] = [];
  const client = new LinkClient(paired, {
    fetch: fetcher,
    onParts(next) {
      Object.assign(parts, next);
      for (const wake of waiters) wake();
      waiters = [];
    },
    onState() {},
  });
  client.start();
  const until = async (check: () => boolean, what: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("Timed out waiting for " + what);
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 40))]);
    }
  };
  const close = async () => {
    client.stop();
    await link.stop();
  };
  return { backend, link, client, parts, until, close };
}
type Demo = Awaited<ReturnType<typeof demo>>;

/** A new chat with the demo's first bot, watched. */
async function openChat(d: Demo) {
  await d.until(() => !!d.parts.bots, "the first state");
  const botId = (d.parts.bots as { id: string }[])[0].id;
  const chatId = await d.client.call<string>("createChat", botId);
  d.client.watch([chatId]);
  await d.until(() => !!d.parts["chat:" + chatId], "the chat's messages");
  const detail = () => d.parts["chat:" + chatId] as ChatDetail;
  const running = () => d.parts["run:" + chatId] as Run | null;
  const live = () => d.parts.live as Live;
  return { chatId, detail, running, live };
}

for (const timeline of [true, false]) {
  const name = timeline ? "the demo computer with turn-timeline-v1" : "the demo computer as an older computer";

  test(name + ": a turn that times out is shown as ended, with its work, and the chat survives a lost session", async () => {
    const d = await demo(timeline);
    try {
      const caps = (d.parts.meta as { capabilities: string[] } | undefined)?.capabilities;
      await d.until(() => !!d.parts.meta, "the computer's meta");
      assert.equal((d.parts.meta as { capabilities: string[] }).capabilities.includes(TIMELINE_V1), timeline, String(caps));
      const { chatId, detail, running, live } = await openChat(d);
      await d.client.call("send", chatId, "time out please");
      await d.until(() => !!running()?.steps?.length && !!live().streams[chatId], "the turn's first step and text");
      await d.until(() => running()?.status === "Needs you", "the turn to time out", 12000);
      // The cause on the phone: the computer still sends the ended run as the chat's run part.
      const ended = running()!;
      assert.equal(ended.status, "Needs you");
      assert.equal(chatId in live().streams, false);
      const view = mergeChat(undefined, detail());
      const items = chatTimeline({ messages: view.messages, from: view.from, runs: view.runs, running: ended, live: {}, timeline, group: false, prefs: SHOW });
      assert.equal(items.some((item) => item.kind === "live"), false, "no turn under way");
      const note = items.find((item) => item.kind === "ended");
      assert.ok(note?.kind === "ended" && note.ending.label === "Timed out" && note.retry);
      assert.ok(items.some((item) => item.kind === "work"), "what it did is still there");
      // With the capability the computer kept what the bot had written; an older one drops it.
      assert.equal(view.messages.some((m) => m.interim && m.runId === ended.id), timeline);

      // The computer forgets the phone's session (it was away a long time): the chat comes back whole.
      const before = detail().messages.length;
      (d.link as unknown as { sessions: Map<string, unknown> }).sessions.clear();
      await d.client.call("renameChat", chatId, "After a nap");
      await d.until(() => (d.parts.chats as { id: string; title: string }[]).some((c) => c.id === chatId && c.title === "After a nap"), "the renamed chat");
      assert.equal(detail().messages.length, before, "every message is still there");
    } finally {
      await d.close();
    }
  });

  test(name + ": a long turn with helpers takes a steer in order", async () => {
    const d = await demo(timeline);
    try {
      const { chatId, detail, running, live } = await openChat(d);
      await d.client.call("send", chatId, "long turn");
      await d.until(() => (running()?.steps?.length ?? 0) >= 2 && !!live().steerable?.[chatId], "the long turn to be steerable");
      await d.client.call("send", chatId, "Skip the docs", { delivery: "steer" });
      await d.until(() => detail().messages.some((m) => m.steeredRunId === running()?.id), "the steer in the chat");
      const messages = detail().messages;
      const steerAt = messages.findIndex((m) => m.steeredRunId);
      assert.equal(messages[steerAt].text, "Skip the docs");
      assert.equal(live().queued[chatId]?.length ?? 0, 0, "a steer is not queued");
      if (timeline) assert.ok(messages[steerAt - 1]?.interim, "the text before the steer was kept as its own entry");
      await d.until(() => (running()?.agents?.length ?? 0) === 2, "two helpers");
      await d.until(() => running() === null || running()?.status !== "Working", "the turn to end", 15000);
      const finished = detail().runs.find((r) => r.id === messages[0].runId)!;
      assert.equal(finished.status, "Completed");
      assert.ok(finished.agents?.every((a) => a.status === "Done"));
      const own = finished.steps?.filter((s) => s.agentId) ?? [];
      assert.equal(own.length > 0, timeline, "only the capability marks a helper's own steps");
      const reply = detail().messages.at(-1)!;
      assert.equal(reply.role, "assistant");
      assert.equal(!!reply.time, timeline, "an older computer sends the reply without a time");
      const view = mergeChat(undefined, detail());
      const items = chatTimeline({ messages: view.messages, from: view.from, runs: view.runs, running: running(), live: {}, timeline, group: false, prefs: SHOW });
      const kinds = shape(items);
      const steer = kinds.indexOf("user:Skip the docs");
      assert.ok(steer > 1 && kinds.slice(1, steer).some((k) => k.startsWith("work:")), "work before the steer: " + kinds.join(" | "));
      assert.ok(kinds.slice(steer + 1).some((k) => k.startsWith("work:")), "work after it");
      assert.ok(kinds.at(-1)?.startsWith("assistant:"));
    } finally {
      await d.close();
    }
  });

  test(name + ": a question in the middle of a turn, and its answer", async () => {
    const d = await demo(timeline);
    try {
      const { chatId, detail, running, live } = await openChat(d);
      await d.client.call("send", chatId, "ask midway");
      await d.until(() => live().requests.some((r) => r.chatId === chatId), "the question");
      const request = live().requests.find((r) => r.chatId === chatId)!;
      assert.equal(request.kind, "question");
      await d.client.call("respond", request.id, { action: "answer", value: "Staging" });
      await d.until(() => running() === null || running()?.status !== "Working", "the turn to end", 12000);
      const messages = detail().messages;
      const answer = messages.find((m) => m.answer);
      assert.equal(!!answer, timeline);
      if (answer) {
        assert.equal(answer.text, "Staging");
        assert.equal(answer.answer?.title, request.title);
        const index = messages.indexOf(answer);
        assert.ok(messages[index - 1]?.interim && messages[index + 1]?.role === "assistant", "it sits between what was written before and after");
      }
      assert.match(messages.at(-1)!.text, /Staging/);
    } finally {
      await d.close();
    }
  });
}

test("a row that didn't change is the same object the next time, so it isn't drawn again", async () => {
  const { reuseItems } = await import("../src/features/chat/turn");
  const steps = [step("a", 1)];
  const make = (stream: string) => chatTimeline(input({ messages: [ask], running: run({ steps }), live: { stream } }));
  const first = reuseItems(undefined, make("Hel"));
  const second = reuseItems(first.byKey, make("Hello"));
  assert.equal(second.items[0], first.items[0], "the person's message is kept");
  assert.notEqual(second.items[1], first.items[1], "the live end changed");
  const third = reuseItems(second.byKey, make("Hello"));
  assert.equal(third.items[1], second.items[1], "and is kept when it didn't change again");
});

test("a long turn's earlier work rows are kept when the run arrives again with one more step", async () => {
  const { reuseItems } = await import("../src/features/chat/turn");
  // The computer sends the whole run with every step: new objects, the same earlier steps.
  const fresh = (count: number) =>
    chatTimeline(
      input({
        messages: [ask, { role: "assistant", text: "That is the first part.", runId: "r1", time: at(10), interim: true }],
        // Two steps before the bot's update, the rest after it.
        running: run({ steps: Array.from({ length: count }, (_, i) => step("s" + i, i < 2 ? 2 + i * 2 : 20 + i * 2)) }),
        live: {},
      }),
    );
  const first = reuseItems(undefined, fresh(4));
  const second = reuseItems(first.byKey, fresh(5));
  const work = (items: Item[]) => items.filter((item) => item.kind === "work");
  assert.ok(work(first.items).length >= 1, "there is work before the interim text");
  // The steps before the interim text did not change: that row is the same object, though its run is a new one.
  assert.equal(work(second.items)[0], work(first.items)[0]);
  assert.equal(second.items.find((item) => item.kind === "text"), first.items.find((item) => item.kind === "text"));
});

test("the worked example in docs/turn-timeline.md reads as the doc says, from either computer", () => {
  const messages: Message[] = [
    { role: "user", text: "Check the deploy and fix what's broken", runId: "r1", time: 0 },
    { role: "assistant", text: "I'll look at the last deploy first.", runId: "r1", time: 400, interim: true },
    { role: "user", text: "Only staging, please", steeredRunId: "r1", time: 5200 },
    { role: "assistant", text: "Staging only, then. One question first.", runId: "r1", time: 5600, interim: true },
    { role: "user", text: "Yes", time: 9100, answer: { runId: "r1", requestId: "q1", kind: "question", title: "Restart the staging server?" } },
    { role: "assistant", text: "Restarted. Staging is healthy again.", runId: "r1", time: 14200 },
  ];
  const steps: Step[] = [
    { id: "s1", name: "bash", label: "tail deploy.log", status: "Done", started: 1900, finished: 2600 },
    { id: "h1", name: "task", label: "Check staging's health", status: "Done", started: 2700, finished: 8000 },
    { id: "s2", name: "web_fetch", label: "https://staging.example.com/health", status: "Done", started: 3000, finished: 3400, agentId: "h1" },
    { id: "s3", name: "ask_user", label: "ask_user", status: "Done", started: 6000, finished: 9100 },
    { id: "s4", name: "bash", label: "systemctl restart api", status: "Done", started: 9300, finished: 13800 },
  ];
  const r1: Run = { id: "r1", chatId: "c1", title: "Check the deploy", time: 0, status: "Completed", finished: 14800, steps };
  const labels = (items: Item[]) => items.map((item) => (item.kind === "work" ? "work:" + item.label : item.kind === "message" || item.kind === "text" ? ("message" in item ? item.message.text : item.text) : item.kind));
  assert.deepEqual(labels(chatTimeline(input({ timeline: true, messages, runs: { r1 } }))), [
    "Check the deploy and fix what's broken",
    "I'll look at the last deploy first.",
    "work:Ran a command, started a helper",
    "Only staging, please",
    "Staging only, then. One question first.",
    "work:Asked you a question",
    "Yes",
    "work:Ran a command",
    "Restarted. Staging is healthy again.",
  ]);
  // An older computer: no interim messages, no answer, no time on the reply, no agentId.
  const older = [messages[0], messages[2], { role: "assistant", text: "Restarted. Staging is healthy again.", runId: "r1" } as Message];
  const plain = { ...r1, steps: steps.map(({ agentId: _agentId, ...rest }) => rest) };
  assert.deepEqual(labels(chatTimeline(input({ messages: older, runs: { r1: plain } }))), [
    "Check the deploy and fix what's broken",
    "work:Ran a command, started a helper, read a web page",
    "Only staging, please",
    "work:Asked you a question, ran a command",
    "Restarted. Staging is healthy again.",
  ]);
});

test("the demo computer: 'show me the screen' opens a screen tab, and 'long question' asks with three long choices", async () => {
  const d = await demo(true);
  try {
    const { chatId, detail, live } = await openChat(d);
    await d.client.call("send", chatId, "show me the screen");
    await d.until(() => !!detail().pane?.panels.some((panel) => panel.kind === "screen"), "a screen tab");
    const pane = detail().pane!;
    const screen = pane.panels.find((panel) => panel.kind === "screen")!;
    assert.equal(pane.ask?.panelId, screen.id, "the bot asks to show it");
    const view = mergeChat(undefined, detail());
    const items = chatTimeline({ messages: view.messages, from: view.from, runs: view.runs, running: null, live: {}, timeline: true, group: false, screens: [screen], prefs: SHOW });
    assert.ok(items.some((item) => item.kind === "screen" && item.panel.id === screen.id), "the chat draws it");

    await d.until(() => !(chatId in live().streams), "the first turn to end");
    await d.client.call("send", chatId, "long question");
    await d.until(() => live().requests.some((r) => r.chatId === chatId), "the question");
    const question = live().requests.find((r) => r.chatId === chatId)!;
    assert.equal(question.choices?.length, 3);
    assert.ok(question.freeform);
    for (const choice of question.choices ?? []) assert.ok(choice.length >= 80 && choice.length <= 120, choice.length + ": " + choice);
    await d.client.call("respond", question.id, { action: "answer", value: question.choices![1] });
    await d.until(() => !(chatId in live().streams), "the turn to end");
  } finally {
    await d.close();
  }
});

test("an answer's bubble does not repeat the request's title that is drawn above it", () => {
  const answer = { runId: "r1", requestId: "q1", kind: "secure" as const, title: "Sign in to the registry" };
  // The desktop app's receipt for a secure input: the title, then the labels that were given.
  assert.equal(answerText({ text: "Sign in to the registry · Provided Username, Password", answer }), "Provided Username, Password");
  assert.equal(answerText({ text: "Sign in to the registry · No fields supplied", answer }), "No fields supplied");
  // Any other answer is shown as it came, also one that merely starts like the title.
  assert.equal(answerText({ text: "Yes", answer: { ...answer, kind: "question" as const, title: "Restart the staging server?" } }), "Yes");
  assert.equal(answerText({ text: "Sign in to the registry later", answer }), "Sign in to the registry later");
  // A message that is no answer is never cut.
  assert.equal(answerText({ text: "Sign in to the registry · Provided Password" }), "Sign in to the registry · Provided Password");
});
