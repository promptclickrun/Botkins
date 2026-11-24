// The composer's and the context sheet's plain logic: the "/", "@" and "#" trigger, how a record
// reads in the text, a Today card as message text, teammates, dictation, the context window's
// parts, the replies' totals, and a model's facts. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { createChatViewport, HIDE_AT, SHOW_AT, showsAt } from "../src/features/chat/scroll";
import { test } from "node:test";
import type { BoardItem, Bot, ModelInfo, RunSummary } from "../src/link/types";
import { arrived, boardMessage, boardQuote, composeSlashPrompt, findTrigger, joinDictation, mentionKey, stripTrigger, teammates, tokenOf, toInput, waitingCopies, withBoardQuote } from "../src/features/chat/compose";
import { chatRuns, contextParts, contextPercent, contextTone, tokens, usageSummary } from "../src/features/chat/contextMath";
import { contextFact, effortRows, modelFacts } from "../src/features/models/facts";
import { completeUpTo } from "../link-host/parts.mjs";

test("text in chunks is cut after a complete sentence or line", () => {
  const cut = (text: string, from = 0) => text.slice(0, completeUpTo(text, from, text.length));
  assert.equal(cut("One sentence. And half"), "One sentence. ");
  assert.equal(cut("Use tools, e.g. a hammer"), "");
  assert.equal(cut("He said \"done.\" Then"), "He said \"done.\" ");
  assert.equal(cut("Steps:\n12. Mix it"), "Steps:\n");
  assert.equal(cut("First para.\n\nSecond"), "First para.\n\n");
  assert.equal(cut("```\nx = 1. y = 2\nz"), "```\nx = 1. y = 2\n");
  assert.equal(cut("```js\nlet a = 1. b"), "```js\n");
  assert.equal(cut("no end in sight"), "");
  assert.equal(completeUpTo("Done. more words", 8, 16), 8, "nothing complete after the cursor");
});


test("a trigger is the sigil word that ends at the caret", () => {
  assert.deepEqual(findTrigger("#", 1), { sigil: "#", query: "", start: 0, end: 1 });
  assert.deepEqual(findTrigger("see #web", 8), { sigil: "#", query: "web", start: 4, end: 8 });
  assert.deepEqual(findTrigger("ask @Ma", 7), { sigil: "@", query: "Ma", start: 4, end: 7 });
  assert.deepEqual(findTrigger("/comp", 5), { sigil: "/", query: "comp", start: 0, end: 5 });
  // Never inside a word, and not once a space follows.
  assert.equal(findTrigger("mail@example", 12), null);
  assert.equal(findTrigger("issue#4", 7), null);
  assert.equal(findTrigger("#web ", 5), null);
  // Only what is before the caret counts.
  assert.deepEqual(findTrigger("#web and more", 4), { sigil: "#", query: "web", start: 0, end: 4 });
});

test("attached slash commands strip their trigger and compose into outgoing slash prompts", () => {
  assert.deepEqual(stripTrigger("/sum", 0, 4), { text: "", caret: 0 });
  assert.deepEqual(stripTrigger("/sum the notes", 0, 4), { text: "the notes", caret: 0 });
  assert.deepEqual(stripTrigger("please /sum", 7, 11), { text: "please", caret: 6 });
  assert.deepEqual(stripTrigger("please /sum this", 7, 11), { text: "please this", caret: 7 });

  const skill = { name: "summarize", command: "summarize", kind: "Skill" as const };
  assert.equal(composeSlashPrompt("", skill), "/summarize");
  assert.equal(composeSlashPrompt("  the notes  ", skill), "/summarize the notes");
  assert.equal(composeSlashPrompt("hello", null), "hello");
  // Leading slash in stored command is normalized rather than doubled.
  assert.equal(composeSlashPrompt("why?", { name: "btw", command: "/btw", kind: "Command" }), "/btw why?");
});

test("a record reads #label in the text, as on the desktop, and is sent without its label", () => {
  const file = { kind: "file" as const, path: "/work/notes.md", label: "notes.md" };
  const project = { kind: "project" as const, id: "p1", label: "Website" };
  assert.equal(tokenOf(file), "#notes.md");
  assert.equal(tokenOf(project), "#Website");
  assert.equal(mentionKey(file), "file:/work/notes.md");
  assert.deepEqual(toInput(file), { kind: "file", path: "/work/notes.md" });
  assert.deepEqual(toInput(project), { kind: "project", id: "p1" });
});

const bot = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id.toUpperCase(), role: "Helper", ...extra }) as Bot;

test("a one-bot chat's @ offers the teammates Teamwork lets the bot ask", () => {
  const bots = [bot("max"), bot("ada"), bot("off", { teamwork: false }), bot("gone", { hidden: true })];
  assert.deepEqual(teammates(bots, "max", true).map((b) => b.id), ["ada"]);
  assert.deepEqual(teammates(bots, "max", undefined).map((b) => b.id), ["ada"]);
  assert.deepEqual(teammates(bots, "max", false), []);
  assert.deepEqual(teammates(bots, "off", true), []);
  assert.deepEqual(teammates(bots, "nobody", true), []);
});

const item = (extra: Partial<BoardItem> = {}): BoardItem => ({
  id: "b1",
  botId: "max",
  kind: "idea",
  title: "Launch a newsletter",
  body: "Weekly.\nShort.",
  status: "open",
  read: true,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

test("a Today card is quoted at the top of a message: kind and title, body, links", () => {
  assert.equal(boardQuote(item({ links: [{ url: "https://example.com", title: "Example [site]" }] })), "> Idea · **Launch a newsletter**\n>\n> Weekly.\n> Short.\n>\n> [Example site](https://example.com)");
  assert.equal(boardQuote(item({ kind: "feed", body: "" })), "> Feed · **Launch a newsletter**");
  assert.equal(withBoardQuote(item({ kind: "goal", body: "" }), "  What first? "), "> Goal · **Launch a newsletter**\n\nWhat first?");
  assert.equal(withBoardQuote(item({ body: "" }), ""), "> Idea · **Launch a newsletter**\n\nLet's talk about this.");
});

test("Let's do it sends the desktop's own message", () => {
  assert.equal(boardMessage(item(), "Let's do it!"), "Let's do it! **Launch a newsletter**\n\nWeekly.\nShort.");
  assert.equal(boardMessage(item({ body: "" }), "Let's do it!"), "Let's do it! **Launch a newsletter**");
});

test("dictated words join the text with one space where needed", () => {
  assert.equal(joinDictation("", "hello there"), "hello there");
  assert.equal(joinDictation("Hi", "there"), "Hi there");
  assert.equal(joinDictation("Hi ", "there"), "Hi there");
  assert.equal(joinDictation("Hi\n", " there "), "Hi\nthere");
  assert.equal(joinDictation("Hi", "   "), "Hi");
});

test("the context window's parts, Other and Free", () => {
  const context = { current: 84_000, limit: 200_000, system: 12_000, tools: 30_000, conversation: 40_000 };
  assert.equal(contextPercent(context), 42);
  assert.deepEqual(contextParts(context), {
    parts: [
      { key: "system", label: "Instructions and system", value: 12_000 },
      { key: "tools", label: "Tool definitions", value: 30_000 },
      { key: "conversation", label: "Conversation", value: 40_000 },
      { key: "other", label: "Other", value: 2_000 },
    ],
    free: 116_000,
    known: true,
  });
  // Without a breakdown there are no parts and no "Other".
  assert.deepEqual(contextParts({ current: 10, limit: 100 }), { parts: [], free: 90, known: false });
  // Over the limit: 100% and nothing free.
  assert.equal(contextPercent({ current: 250, limit: 200 }), 100);
  assert.equal(contextParts({ current: 250, limit: 200 }).free, 0);
  assert.equal(contextPercent({ current: 5, limit: 0 }), 0);
  assert.deepEqual([contextTone(10), contextTone(70), contextTone(89), contextTone(90)], ["success", "warning", "warning", "danger"]);
});

test("token counts read like the app's compact numbers, without a trailing .0", () => {
  assert.deepEqual([tokens(950), tokens(1_000), tokens(84_200), tokens(128_000), tokens(1_000_000), tokens(1_048_576), tokens(1_500_000), tokens(-3)], ["950", "1K", "84K", "128K", "1M", "1M", "1.5M", "0"]);
  assert.equal(tokens(8_400), "8.4K");
});

test("a chat's replies: the latest one's tokens and the totals, each run once", () => {
  const run = (id: string, time: number, usage?: RunSummary["usage"], chatId = "c1") => ({ id, chatId, title: "", time, status: "Completed", usage }) as RunSummary;
  const recent = [run("r1", 1, { input: 100, output: 10, cacheRead: 50 }), run("r2", 3, { input: 300, output: 30, cost: 1 }), run("x", 9, { input: 5, output: 5 }, "other")];
  const loaded = { r2: run("r2", 3), r3: run("r3", 2, { input: 200, output: 20 }) };
  const runs = chatRuns("c1", recent, loaded);
  assert.deepEqual(runs.map((r) => r.id), ["r2", "r3", "r1"]);
  const summary = usageSummary(runs);
  assert.deepEqual(summary, { latest: { input: 300, output: 30, cost: 1 }, replies: 3, input: 600, output: 60, cacheRead: 50, cost: 1 });
  assert.deepEqual(usageSummary([]), { latest: undefined, replies: 0, input: 0, output: 0, cacheRead: 0, cost: 0 });
});

test("a model shows only the facts its provider gave", () => {
  const bare: ModelInfo = { id: "m", name: "M", efforts: [], available: true };
  assert.equal(contextFact(bare), undefined);
  assert.equal(contextFact({ contextWindow: 0 }), undefined);
  assert.equal(contextFact({ contextWindow: 1_000_000 }), "1M context");
  assert.deepEqual(modelFacts(bare), []);
  const full: ModelInfo = { ...bare, contextWindow: 200_000, maxOutput: 64_000, maxPrompt: 168_000, vision: false, tools: true, knowledge: " Early 2026 ", vendor: "Anthropic", tier: "" };
  assert.deepEqual(
    modelFacts(full).map((fact) => [fact.label, fact.value]),
    [
      ["Context window", "200K tokens"],
      ["Max output", "64K tokens"],
      ["Max prompt", "168K tokens"],
      ["Reads pictures", "No"],
      ["Uses tools", "Yes"],
      ["Knowledge", "Early 2026"],
      ["Made by", "Anthropic"],
    ],
  );
  const levels = effortRows({ ...bare, efforts: ["low", "high"], defaultEffort: "high", effortNotes: { low: "Quick" } }, (e) => e.toUpperCase());
  assert.deepEqual(levels, [
    { level: "low", label: "LOW", note: "Quick" },
    { level: "high", label: "HIGH · Default", note: undefined },
  ]);
});

test("a Today card sent with a message is read back out of it, and other messages are left whole", async () => {
  const { boardQuote, splitBoardQuote, withBoardQuote } = await import("../src/features/chat/compose");
  const item = { id: "b2", botId: "bot-mira", kind: "idea", title: "Batch the launch emails", body: "Send the three launch emails\nas one sequence.", links: [{ url: "https://example.com/a", title: "Notes" }], status: "open", read: true, createdAt: 1, updatedAt: 1 } as any;
  const sent = withBoardQuote(item, "What do you think?");
  assert.deepEqual(splitBoardQuote(sent), { card: { kind: "Idea", title: "Batch the launch emails", body: "Send the three launch emails\nas one sequence.\n\nNotes" }, rest: "What do you think?" });
  assert.deepEqual(splitBoardQuote(boardQuote({ ...item, body: "", links: [] })), { card: { kind: "Idea", title: "Batch the launch emails", body: "" }, rest: "" });
  // A quote a person typed themselves is theirs.
  for (const text of ["> just a quote\n\nhello", "hello", "", "> Idea · not bold"]) assert.deepEqual(splitBoardQuote(text), { card: null, rest: text });
});

test("the scroll-to-latest button shows when the newest message is well out of view, and doesn't flicker at the edge", () => {
  assert.equal(showsAt(0, false), false);
  assert.equal(showsAt(SHOW_AT, false), false);
  assert.equal(showsAt(SHOW_AT + 1, false), true);
  // Once it shows it stays until the list is nearly back, so a small move at the edge changes nothing.
  assert.equal(showsAt(SHOW_AT - 40, true), true);
  assert.equal(showsAt(HIDE_AT + 1, true), true);
  assert.equal(showsAt(HIDE_AT, true), false);
  assert.equal(showsAt(SHOW_AT - 40, false), false);
  // The list can be pulled past its end (a negative offset): never shown there.
  assert.equal(showsAt(-30, true), false);
});

test("a send that seemed to fail is not put back as a draft when the message did arrive", () => {
  const view = { from: 40, messages: [{ role: "user", text: "yes" }, { role: "assistant", text: "Done." }, { role: "user", text: "ship it" }] };
  // In the chat, at or after where the chat ended when it was sent.
  assert.equal(arrived("ship it", { length: 42, waiting: 0 }, view, undefined), true);
  // The same words from before the send don't count, nor a bot's message with them.
  assert.equal(arrived("yes", { length: 42, waiting: 0 }, view, undefined), false);
  assert.equal(arrived("Done.", { length: 40, waiting: 0 }, view, undefined), false);
  // Waiting its turn while the bot works: one more copy than before.
  assert.equal(arrived("and tests", { length: 43, waiting: 0 }, view, [{ text: "and tests" }]), true);
  assert.equal(arrived("yes", { length: 43, waiting: 1 }, view, [{ text: "yes" }]), false);
  assert.equal(arrived("yes", { length: 43, waiting: 1 }, view, [{ text: "yes" }, { text: "yes" }]), true);
  assert.equal(waitingCopies("yes", [{ text: "yes" }, { text: "no" }, { text: "yes" }]), 2);
  // Nothing loaded, or nothing sent: not arrived.
  assert.equal(arrived("ship it", { length: 0, waiting: 0 }, undefined, undefined), false);
  assert.equal(arrived("", { length: 0, waiting: 0 }, view, undefined), false);
  // A page that starts after the send's place is read from its start.
  assert.equal(arrived("ship it", { length: 10, waiting: 0 }, view, undefined), true);
});

test("activity and screen rows are visible only while this chat's list shows them", () => {
  const chat = createChatViewport();
  const beside = createChatViewport();
  assert.equal(chat.rows.getState().has("status"), false);
  chat.onViewableItemsChanged({ viewableItems: [{ key: "status" }, { key: "screen" }] });
  const visible = chat.rows.getState();
  assert.equal(visible.has("status"), true);
  assert.equal(visible.has("screen"), true);
  assert.equal(beside.rows.getState().has("status"), false);
  // Replacing visible rows with the same keys (e.g. new streamed text) does not publish again.
  chat.onViewableItemsChanged({ viewableItems: [{ key: "screen" }, { key: "status" }] });
  assert.equal(chat.rows.getState(), visible);
  chat.onViewableItemsChanged({ viewableItems: [{ key: "older" }] });
  assert.equal(chat.rows.getState().has("status"), false);
  assert.equal(chat.rows.getState().has("screen"), false);
});
