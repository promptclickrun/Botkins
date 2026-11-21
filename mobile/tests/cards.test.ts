// One Live Activity per Botkin: the plain rules in link-host/cards.mjs, which the computer and the
// phone both use (docs/live-cards.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { askDetail, askOf, botCard, CARD_LINGER_MS, cardOver, cardRows, DANGER, latestThought, SEALED_MAX, stepKind } from "../link-host/cards.mjs";
import { looksDangerous } from "../src/features/chat/request/logic";

const NOW = 1_795_200_000_000;
const MIN = 60_000;

/** A computer's state with one Botkin ("patch") and a few chats in different states. */
function world() {
  return {
    bots: [
      { id: "patch", name: "Patch", model: { provider: "claude", model: "claude-fable-5-2" } },
      { id: "mira", name: "Mira" },
    ],
    chats: [
      { id: "login", botId: "patch", title: "Fix login refresh", messages: [] },
      { id: "pr", botId: "patch", title: "Review PR #212", model: { provider: "copilot", model: "gpt-5.5" }, messages: [] },
      { id: "log", botId: "patch", title: "Update changelog", messages: [{ role: "assistant", runId: "r-log", text: "**Done:** the changelog lists 0.16.\n\nMore below." }] },
      { id: "old", botId: "patch", title: "An old one", messages: [] },
      { id: "group", botId: "patch", botIds: ["patch", "mira"], title: "Group", messages: [] },
      { id: "week", botId: "mira", title: "Plan next week", messages: [] },
    ],
    runs: [
      { id: "r-login", chatId: "login", status: "Working", time: NOW - 2 * MIN, steps: [
        { id: "1", name: "grep", label: "Searched for renew(", status: "Done", started: NOW - 110_000 },
        { id: "2", name: "edit", label: "Edited src/auth/session.ts", status: "Done", started: NOW - 80_000 },
        { id: "3", name: "bash", label: "Running npm test", status: "Running", started: NOW - 12_000 },
      ] },
      { id: "r-pr", chatId: "pr", status: "Working", time: NOW - 31_000, steps: [] },
      { id: "r-log", chatId: "log", status: "Completed", time: NOW - 10 * MIN, finished: NOW - 9 * MIN },
      { id: "r-old", chatId: "old", status: "Completed", time: NOW - 90 * MIN, finished: NOW - 80 * MIN },
      { id: "r-group", chatId: "group", status: "Working", time: NOW - MIN },
      { id: "r-routine", chatId: "login", status: "Working", time: NOW, scheduleId: 3 },
      { id: "r-week", chatId: "week", status: "Working", time: NOW - 3 * MIN },
    ],
    requests: [] as any[],
    streams: {} as Record<string, string>,
    thinking: { login: "The bug shows after a cold start. If the retry waits for the first renew, the token rotates once. So the fix is" } as Record<string, string>,
    intents: {} as Record<string, string>,
  };
}

test("the phone and the computer call the same commands risky", () => {
  assert.equal(DANGER.source, /\brm\s+(-\w*r\w*f|-\w*f\w*r|--recursive\s+--force|--force\s+--recursive)\b|\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|\bpush\b[^\n]*(\s-f\b|--force)|\bforce[- ]push|\bdelete\b|\bformat\b|\bmkfs\b|\bdd\s+if=|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-\w*f/i.source);
  for (const preview of ["git push --force origin main", "rm -rf build", "ls -la", "npm test"]) {
    const request = { id: "q", chatId: "c", botId: "b", kind: "permission" as const, title: "Run a command", preview };
    assert.equal(askOf(request) === "risky", looksDangerous(request), preview);
  }
});

test("a request's buttons away from the app", () => {
  const base = { id: "q", chatId: "c", botId: "b" };
  assert.equal(askOf({ ...base, kind: "permission", title: "Run a command", preview: "pip install qdrant-client" }), "approve");
  assert.equal(askOf({ ...base, kind: "permission", title: "Run a command", preview: "git push --force origin fix" }), "risky");
  assert.equal(askOf({ ...base, kind: "question", title: "Which day?", choices: ["Tue 10:00", "Wed 2:00"] }), "question");
  assert.equal(askOf({ ...base, kind: "question", title: "Anything else?" }), "question", "a free answer only");
  assert.equal(askOf({ ...base, kind: "question", title: "Which?", choices: ["a", "b", "c", "d"] }), "open", "more than three choices");
  assert.equal(askOf({ ...base, kind: "question", title: "Which?", choices: ["Staging — safe to break, and nobody uses it"] }), "open", "a long choice is read in the app");
  assert.equal(askOf({ ...base, kind: "form", title: "Sign in" }), "open");
  assert.equal(askOf({ ...base, kind: "secure", title: "Database password" }), "open");
  assert.equal(askOf(undefined), undefined);

  const approve = askDetail({ ...base, kind: "permission", title: "Run a command", preview: "pip install x", remember: "pip install" });
  assert.deepEqual(approve, { id: "q", k: "permission", t: "Run a command", p: "pip install x", rm: true });
  const risky = askDetail({ ...base, kind: "permission", title: "Run a command", preview: "git push --force", remember: "git push" });
  assert.equal(risky.rm, undefined, "a risky approval is never remembered from the Lock Screen");
  assert.equal(risky.x, true, "and says it is risky, for the notification's buttons");
  assert.deepEqual(askDetail({ ...base, kind: "question", title: "Which day?", choices: [" Tue 10:00 ", "Wed 2:00"], freeform: true }), { id: "q", k: "question", t: "Which day?", ch: ["Tue 10:00", "Wed 2:00"], free: true });
  assert.equal(askDetail({ ...base, kind: "question", title: "Which?", choices: ["a", "b", "c", "d"] }).ch, undefined);
});

test("the latest sentence of thinking, and a step's kind", () => {
  assert.equal(latestThought("First idea. Then the second one!"), "Then the second one!");
  assert.equal(latestThought("A whole sentence here. And then"), "A whole sentence here.", "a short unfinished sentence waits");
  assert.equal(latestThought("**Plan:** check `renew()` first."), "Plan: check renew() first.");
  assert.equal(latestThought(""), "");
  const long = latestThought("x".repeat(500));
  assert.equal(long.length, 140);
  assert.ok(long.startsWith("…"));
  assert.equal(stepKind("bash"), "run");
  assert.equal(stepKind("read_file"), "read");
  assert.equal(stepKind("str_replace_editor"), "edit");
  assert.equal(stepKind("grep"), "search");
  assert.equal(stepKind("web_fetch"), "web");
  assert.equal(stepKind("task"), "helper");
  assert.equal(stepKind("github.create_issue"), "tool");
  assert.equal(stepKind("mcp/server.read_file"), "read");
});

test("a Botkin's chats in order: needs you, working by start, ended by end; ended ones drop off after a while", () => {
  const state = world();
  const order = (now = NOW) => cardRows(state, "patch", { now }).map((row) => row.chat.id);
  // The group chat and the routine's turn never count; the old chat ended too long ago.
  assert.deepEqual(order(), ["pr", "login", "log"]);
  state.requests.push({ id: "ask", chatId: "log", botId: "patch", kind: "question", title: "Ship it?" });
  assert.deepEqual(order(), ["log", "pr", "login"], "a chat that needs the person comes first");
  state.requests.length = 0;
  assert.deepEqual(order(NOW - 9 * MIN + CARD_LINGER_MS + 1), ["pr", "login"], "an ended chat drops off 30 minutes after it ended");
  assert.equal(cardRows(state, "nobody", { now: NOW }).length, 0);
  assert.deepEqual(cardRows(state, "patch", { now: NOW, visible: (chat: any) => chat.id !== "pr" }).map((row) => row.chat.id), ["login", "log"], "chats a device may not see are left out");
});

test("a card with one chat carries its steps and thinking, sealed; Apple sees no words of the bot's", () => {
  const state = world();
  state.chats = state.chats.filter((chat) => chat.id === "login");
  const card = botCard(state, "patch", { now: NOW })!;
  assert.deepEqual(card.state, { v: 1, phase: "working", label: "Working", steps: 3, startedAt: (NOW - 2 * MIN) / 1000, chats: [{ id: "login", phase: "working", steps: 3, startedAt: (NOW - 2 * MIN) / 1000, provider: "claude" }], more: 0 });
  assert.equal(card.relevance, 50);
  assert.deepEqual(card.detail, {
    c: [
      {
        id: "login",
        t: "Fix login refresh",
        l: "Running npm test",
        m: "claude-fable-5-2",
        s: [
          { k: "search", l: "Searched for renew(", d: 1, at: (NOW - 110_000) / 1000 },
          { k: "edit", l: "Edited src/auth/session.ts", d: 1, at: (NOW - 80_000) / 1000 },
          { k: "run", l: "Running npm test", d: 0, at: (NOW - 12_000) / 1000 },
        ],
        th: "If the retry waits for the first renew, the token rotates once.",
      },
    ],
  });
  const plain = JSON.stringify(card.state);
  for (const words of ["Fix login", "npm", "renew", "fable"]) assert.ok(!plain.includes(words), "nothing the bot wrote is in the clear: " + words);
  // Previews off: nothing is sealed at all.
  assert.equal(botCard(state, "patch", { now: NOW, previews: false })!.detail, null);
});

test("a card with several chats has one row each and no steps; one that needs the person leads it", () => {
  const state = world();
  state.requests.push({ id: "ask", chatId: "login", botId: "patch", kind: "permission", title: "Run a command", preview: "git push --force origin fix/login-refresh", remember: "git push" });
  const card = botCard(state, "patch", { now: NOW })!;
  assert.equal(card.state.phase, "needs-you");
  assert.equal(card.state.label, "Needs you");
  assert.equal(card.relevance, 100);
  assert.deepEqual(
    card.state.chats.map((chat: any) => [chat.id, chat.phase, chat.provider, chat.ask]),
    [
      ["login", "needs-you", "claude", "risky"],
      ["pr", "thinking", "copilot", undefined],
      ["log", "done", "claude", undefined],
    ],
  );
  assert.equal(card.state.chats[2].finishedAt, (NOW - 9 * MIN) / 1000);
  for (const row of card.detail!.c) assert.equal(row.s, undefined, "no steps with several chats");
  assert.deepEqual(card.detail!.c[0].q, { id: "ask", k: "permission", t: "Run a command", p: "git push --force origin fix/login-refresh", x: true });
  assert.equal(card.detail!.c[2].l, "Done");
  assert.ok(card.expires === NOW - 9 * MIN + CARD_LINGER_MS);
  assert.equal(cardOver(card.state), false);
});

test("a card whose chats all ended says done, with the reply's first line", () => {
  const state = world();
  state.chats = state.chats.filter((chat) => chat.id === "log");
  const card = botCard(state, "patch", { now: NOW })!;
  assert.equal(card.state.phase, "done");
  assert.equal(card.state.finishedAt, (NOW - 9 * MIN) / 1000);
  assert.equal(card.detail!.c[0].r, "Done: the changelog lists 0.16.");
  assert.equal(card.relevance, 10);
  assert.ok(cardOver(card.state));
  // A turn that timed out says so in the app's words.
  state.runs.find((run) => run.id === "r-log")!.status = "Needs you";
  (state.runs.find((run) => run.id === "r-log") as any).detail = "Copilot session stalled without an event for 600 seconds.";
  const failed = botCard(state, "patch", { now: NOW })!;
  assert.equal(failed.state.phase, "failed");
  assert.equal(failed.state.label, "Stopped");
  assert.equal(failed.detail!.c[0].l, "Timed out");
  assert.equal(botCard(state, "patch", { now: NOW + CARD_LINGER_MS }), null, "a card with nothing left to show ends");
});

test("the sealed part stays small however long the words are", () => {
  const state = world();
  const long = "word ".repeat(400);
  state.chats = state.chats.filter((chat) => chat.id === "login").map((chat) => ({ ...chat, title: long }));
  state.thinking.login = long + ".";
  for (const step of state.runs[0].steps!) step.label = long;
  state.requests.push({ id: "ask", chatId: "login", botId: "patch", kind: "question", title: long, choices: ["a", "b"], freeform: true });
  const card = botCard(state, "patch", { now: NOW })!;
  assert.ok(Buffer.byteLength(JSON.stringify(card.detail)) <= SEALED_MAX);
  assert.equal(card.detail!.c[0].t.length, 60);
});

// ── The phone's side (src/state/cards.ts) ──────────────────────────────────────────────────────

import { botsWithWork, cardWorld, MAX_CARDS, phoneCard } from "../src/state/cards";

/** What a phone knows of world(): summaries for every run, the detail and text only for the chat it follows ("login"). */
function phoneKnows() {
  const state = world();
  const runs = state.runs.map(({ steps, ...summary }) => summary);
  return {
    parts: {
      bots: state.bots as any,
      chats: state.chats.map(({ messages, ...chat }) => ({ ...chat, time: NOW, count: 1 })) as any,
      runs: runs as any,
      live: { streams: { login: false, pr: false }, thinking: { login: true }, intents: {}, speakers: {}, queued: {}, requests: [], active: ["login", "pr"] } as any,
    },
    running: { login: state.runs[0] as any },
    texts: { login: { stream: "", thinking: state.thinking.login } },
  };
}

test("the phone draws the same card as the computer for the chat it follows", () => {
  const state = world();
  state.chats = state.chats.filter((chat) => chat.id === "login");
  const known = phoneKnows();
  known.parts.chats = known.parts.chats.filter((chat: any) => chat.id === "login");
  const fromComputer = botCard(state, "patch", { now: NOW })!;
  const fromPhone = phoneCard(known, "patch", true, NOW)!;
  assert.deepEqual(fromPhone.state, fromComputer.state);
  assert.deepEqual(fromPhone.detail, fromComputer.detail);
  // The run detail the phone follows takes the place of its summary.
  assert.equal(cardWorld(known).runs!.find((run) => run.id === "r-login")!.steps!.length, 3);
});

test("a chat the phone doesn't follow shows its title and what it is doing, without steps", () => {
  const known = phoneKnows();
  known.running = {} as any;
  known.texts = {} as any;
  known.parts.live.intents = { login: "Running the tests" };
  const card = phoneCard(known, "patch", true, NOW)!;
  const login = card.detail!.c.find((row) => row.id === "login")!;
  assert.equal(login.l, "Running the tests");
  assert.equal(login.s, undefined);
  assert.equal(card.state.chats.find((chat) => chat.id === "login")!.phase, "working");
});

test("cards start for Botkins at work, at most four, not for chats that only ended", () => {
  const known = phoneKnows();
  assert.deepEqual(botsWithWork(known, NOW), ["patch", "mira"]);
  known.parts.runs = known.parts.runs.map((run: any) => ({ ...run, status: "Completed", finished: NOW - MIN }));
  known.running = {} as any;
  assert.deepEqual(botsWithWork(known, NOW), [], "only ended chats: no new card");
  known.parts.bots = Array.from({ length: 6 }, (_, i) => ({ id: "b" + i, name: "B" + i }));
  known.parts.chats = known.parts.bots.map((bot: any) => ({ id: "c-" + bot.id, botId: bot.id, title: "x", time: NOW, count: 1 }));
  known.parts.runs = known.parts.bots.map((bot: any) => ({ id: "r-" + bot.id, chatId: "c-" + bot.id, status: "Working", time: NOW }));
  assert.equal(botsWithWork(known, NOW).length, MAX_CARDS);
});

// ── Answers given away from the app (src/state/answerCall.ts) ──────────────────────────────────

import { answerCall } from "../src/state/answerCall";

test("an answer from a card or a notification is one call to the computer", () => {
  const base = { id: "a", at: 1, chat: "login", request: "ask" };
  assert.deepEqual(answerCall({ ...base, action: "approve" }), { method: "respond", requestId: "ask", answer: { action: "approve" } });
  assert.deepEqual(answerCall({ ...base, action: "remember" }), { method: "respond", requestId: "ask", answer: { action: "remember" } });
  assert.deepEqual(answerCall({ ...base, action: "deny" }), { method: "respond", requestId: "ask", answer: { action: "deny" } });
  assert.deepEqual(answerCall({ ...base, action: "answer", value: "  Tue 10:00 " }), { method: "respond", requestId: "ask", answer: { action: "answer", value: "Tue 10:00" } });
  assert.equal(answerCall({ ...base, action: "answer", value: "   " }), undefined, "an empty reply isn't sent");
  assert.equal(answerCall({ id: "a", at: 1, action: "approve" }), undefined, "nothing to answer without a request");
  assert.deepEqual(answerCall({ ...base, action: "stop" }), { method: "stop", chatId: "login" });
  assert.deepEqual(answerCall({ ...base, action: "retry" }, (chat) => (chat === "login" ? "r-9" : undefined)), { method: "retry", runId: "r-9" });
  assert.equal(answerCall({ ...base, action: "retry" }), undefined);
  assert.equal(answerCall({ ...base, action: "launch" as any }), undefined, "a kind this build doesn't know");
});
