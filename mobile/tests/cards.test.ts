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

test("between two steps a row says what the bot did last, never only that it is working", () => {
  // A step takes moments; the thinking between two takes most of a turn.
  const state = world();
  for (const step of state.runs[0].steps!) step.status = "Done";
  const row = (id: string) => botCard(state, "patch", { now: NOW })!.detail!.c.find((item) => item.id === id)!;
  assert.equal(row("login").l, "Running npm test", "the newest step");
  assert.equal(row("pr").l, "Thinking…", "nothing done yet");
  state.intents.login = "Checking the token's renewal";
  assert.equal(row("login").l, "Checking the token's renewal", "what the bot says it is doing comes first");
  state.runs[0].steps![2].status = "Running";
  assert.equal(row("login").l, "Running npm test", "and a step that runs before that");
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

// ── One card for all Botkins ("activity-all-v1") ───────────────────────────────────────────────

const looks = (botId: string) => (botId === "patch" ? { head: "tinker", palette: "fig", eyes: "oval", colors: [] } : { head: "luna", palette: "custom", eyes: "wink", colors: ["#111111", "#222222", "#333333", "#444444"] });

test("one card for all Botkins: every Botkin's chats in one order, each row with its Botkin's look, the name only sealed", () => {
  const state = world();
  const card = botCard(state, null, { now: NOW, look: looks })!;
  // Working chats by newest start across Botkins, then the ended one; the group chat and the routine never count.
  assert.deepEqual(
    card.state.chats.map((chat) => [chat.id, chat.bot, chat.head, chat.palette]),
    [
      ["pr", "patch", "tinker", "fig"],
      ["login", "patch", "tinker", "fig"],
      ["week", "mira", "luna", "custom"],
    ],
  );
  assert.equal(card.state.more, 1, "the ended changelog chat is counted, not shown");
  assert.deepEqual(card.state.chats[2].colors, ["#111111", "#222222", "#333333", "#444444"]);
  assert.equal(card.state.chats[2].eyes, "wink");
  assert.equal(card.state.chats[0].colors, undefined, "no colors for a kit palette");
  // Each row's model is its own Botkin's: Mira has none, so the computer's default.
  assert.equal(card.state.chats[2].provider, undefined);
  assert.deepEqual(
    card.detail!.c.map((row) => row.b),
    ["Patch", "Patch", "Mira"],
  );
  const plain = JSON.stringify(card.state);
  for (const name of ["Patch", "Mira"]) assert.ok(!plain.includes(name), "a Botkin's name is sealed: " + name);
  // A request anywhere leads the card.
  state.requests.push({ id: "ask", chatId: "week", botId: "mira", kind: "question", title: "Which day?", choices: ["Tue", "Wed"] });
  const asking = botCard(state, null, { now: NOW, look: looks })!;
  assert.equal(asking.state.chats[0].id, "week");
  assert.equal(asking.state.phase, "needs-you");
  assert.equal(asking.relevance, 100);
  // Without a look (an older computer's bot), a row still has its Botkin's id.
  assert.equal(botCard(state, null, { now: NOW })!.state.chats[0].head, undefined);
  assert.equal(botCard(state, null, { now: NOW })!.state.chats[0].bot, "mira");
});

test("one card for all Botkins stays under Apple's 4 KB however long the words are", () => {
  const state = world();
  const long = "word ".repeat(400);
  state.chats = state.chats.map((chat) => ({ ...chat, id: chat.id + "-".repeat(30), title: long }));
  state.runs = state.runs.map((run) => ({ ...run, chatId: run.chatId + "-".repeat(30) }));
  state.requests.push({ id: "ask", chatId: "week" + "-".repeat(30), botId: "mira", kind: "question", title: long, choices: ["a", "b"], freeform: true });
  const card = botCard(state, null, { now: NOW, look: looks })!;
  const sealedLength = Math.ceil((Buffer.byteLength(JSON.stringify(card.detail)) + 28) / 3) * 4;
  // What a push adds around the content: the event, the dates, the relevance and an alert.
  const around = 400;
  assert.ok(Buffer.byteLength(JSON.stringify(card.state)) + sealedLength + around < 4096);
});

// ── What the widget extension decodes (targets/widgets) ────────────────────────────────────────

type SwiftField = { type: string; optional: boolean };
/** The stored properties of the Swift struct `name` in `source`: each one's type, and whether it may be missing. */
function swiftFields(source: string, name: string): Record<string, SwiftField> {
  const open = source.indexOf("{", source.indexOf("struct " + name));
  assert.ok(open > 0, "the Swift struct " + name);
  const fields: Record<string, SwiftField> = {};
  let depth = 0;
  for (const line of source.slice(open + 1).split("\n")) {
    // Only the struct's own lines: not a nested struct's, an initializer's or a function's.
    const field = depth === 0 ? /^\s*(?:public )?(?:var|let) (\w+): ([^={]+?)\s*$/.exec(line) : null;
    if (field) fields[field[1]!] = { type: field[2]!.replace(/\?$/, ""), optional: field[2]!.endsWith("?") };
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    if (depth < 0) break;
  }
  return fields;
}

/**
 * What stops Swift's JSONDecoder from decoding `value` as `struct`, as it comes out of JSON. iOS drops
 * a push whose content-state doesn't decode, and a sealed part that doesn't is shown as no words at all.
 * A key Swift doesn't declare counts too (the card would never show it), unless it is in `extra`.
 */
function decodeProblems(value: unknown, struct: string, structs: Record<string, Record<string, SwiftField>>, extra: string[] = [], path = struct): string[] {
  const fields = structs[struct]!;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [path + " is not an object"];
  const problems: string[] = [];
  const fitsType = (item: unknown, type: string, at: string): boolean => {
    if (type === "String") return typeof item === "string";
    if (type === "Int") return Number.isInteger(item);
    if (type === "Double") return typeof item === "number";
    if (type === "Bool") return typeof item === "boolean";
    const list = /^\[(\w+)\]$/.exec(type);
    if (list) return Array.isArray(item) && item.every((entry, index) => fitsType(entry, list[1]!, at + "[" + index + "]"));
    if (!structs[type]) return false;
    const inner = decodeProblems(item, type, structs, extra, at);
    problems.push(...inner);
    return true;
  };
  for (const [key, field] of Object.entries(fields)) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined || item === null) {
      if (!field.optional) problems.push(path + "." + key + " is missing");
    } else if (!fitsType(item, field.type, path + "." + key)) problems.push(path + "." + key + " is not " + field.type);
  }
  for (const key of Object.keys(value)) if (!fields[key] && !extra.includes(key)) problems.push(path + "." + key + " is not in the Swift type");
  return problems;
}

test("what the computer sends decodes as the widget extension's Swift types", async () => {
  const { readFileSync } = await import("node:fs");
  const { activityState } = await import("../link-host/push.mjs");
  const attributes = readFileSync(new URL("../targets/widgets/BotkinActivityAttributes.swift", import.meta.url), "utf8");
  const sealed = readFileSync(new URL("../targets/widgets/Sealed.swift", import.meta.url), "utf8");
  const plain = { ContentState: swiftFields(attributes, "ContentState"), Chat: swiftFields(attributes, "Chat") };
  const words = { CardDetail: swiftFields(sealed, "CardDetail"), Chat: swiftFields(sealed, "Chat"), Step: swiftFields(sealed, "Step"), Ask: swiftFields(sealed, "Ask") };
  // The parser reads the files as they are: these are the properties every card needs.
  assert.deepEqual(Object.keys(plain.ContentState).filter((key) => !plain.ContentState[key]!.optional), ["phase", "label", "steps", "startedAt"]);
  assert.deepEqual(Object.keys(words.Chat).filter((key) => !words.Chat[key]!.optional), ["id", "t", "l"]);

  const worlds: [string, ReturnType<typeof world>][] = [["as it is", world()]];
  const asking = world();
  asking.requests.push({ id: "ask", chatId: "login", botId: "patch", kind: "permission", title: "Run a command", preview: "git push --force", remember: "git push" });
  asking.requests.push({ id: "ask2", chatId: "week", botId: "mira", kind: "question", title: "Which day?", choices: ["Tue 10:00", "Wed 2:00"], freeform: true });
  worlds.push(["with requests", asking]);
  const single = world();
  single.chats = single.chats.filter((chat) => chat.id === "login");
  worlds.push(["one chat at work", single]);
  const ended = world();
  ended.chats = ended.chats.filter((chat) => chat.id === "log");
  worlds.push(["all ended", ended]);
  // A step with no time and a run with none of its own: neither may put a null where Swift wants a number.
  const bare = world();
  bare.chats = bare.chats.filter((chat) => chat.id === "login");
  for (const step of bare.runs[0].steps!) delete (step as { started?: number }).started;
  worlds.push(["steps without a time", bare]);

  for (const [name, state] of worlds) {
    for (const botId of ["patch", null]) {
      const card = botCard(state, botId, { now: NOW, look: looks });
      if (!card) continue;
      const wire = JSON.parse(JSON.stringify({ ...card.state, sealed: "…" }));
      assert.deepEqual(decodeProblems(wire, "ContentState", plain), [], name + ": the card's state");
      // `x` (the approval looks destructive) is read by the notification extension only.
      assert.deepEqual(decodeProblems(JSON.parse(JSON.stringify(card.detail)), "CardDetail", words, ["x"]), [], name + ": the sealed words");
    }
  }
  // A chat's own card (an older phone's): the same Swift type, the first five properties.
  for (const run of [world().runs[0], { ...world().runs[2] }, null]) {
    assert.deepEqual(decodeProblems(JSON.parse(JSON.stringify(activityState(world(), "login", run, true))), "ContentState", plain), []);
  }
});

// ── The phone's side (src/state/cards.ts) ──────────────────────────────────────────────────────

import { botsWithWork, cardWorld, hasWork, MAX_CARDS, phoneCard } from "../src/state/cards";

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

test("the phone draws the same card for all Botkins as the computer, and starts it only for work", () => {
  const state = world();
  state.chats = state.chats.filter((chat) => chat.id === "login");
  const known = phoneKnows();
  known.parts.chats = known.parts.chats.filter((chat: any) => chat.id === "login");
  const fromComputer = botCard(state, null, { now: NOW, look: looks })!;
  const fromPhone = phoneCard(known, null, true, NOW, looks)!;
  assert.deepEqual(fromPhone.state, fromComputer.state);
  assert.deepEqual(fromPhone.detail, fromComputer.detail);

  const all = phoneKnows();
  assert.ok(hasWork(all, NOW));
  all.parts.runs = all.parts.runs.map((run: any) => ({ ...run, status: "Completed", finished: NOW - MIN }));
  all.running = {} as any;
  assert.equal(hasWork(all, NOW), false, "only ended chats: no new card");
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
