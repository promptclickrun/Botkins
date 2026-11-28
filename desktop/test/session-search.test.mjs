// Searching past chats (desktop/session-search.mjs): session_search and session_read for every bot,
// across every harness, and `chats.search` for the command line.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { terms } from "../desktop/session-search.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-session-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = { setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" };
  const client = async () => ({ createSession: async () => session, resumeSession: async () => session, deleteSession: async () => {} });
  const ws = new Workspace(dir, client, () => {}, () => ({ kind: "reject" }));
  const say = (chatId, ...lines) => {
    const chat = ws.chat(chatId);
    lines.forEach(([role, text, time], i) => chat.messages.push({ role, text, time: time ?? Date.now() - (lines.length - i) * 1000 }));
    return chat;
  };
  const turn = (chatId, botId) => {
    const chat = ws.chat(chatId);
    const run = { id: "run-" + chatId, chatId, botId };
    const task = { stopped: false, run };
    ws.active.set(chatId, task);
    t.after(() => ws.active.delete(chatId));
    return new Map(ws.sessionTools(ws.bot(botId), chat, run, task).map((tool) => [tool.name, tool]));
  };
  return { ws, say, turn };
}
const call = (tools, name, args) => JSON.parse(tools.get(name).handler(args));

test("terms keep quoted phrases whole and drop repeats", () => {
  assert.deepEqual(terms('Browser "relay cost" browser'), ["browser", "relay cost"]);
  assert.throws(() => terms("   "), /Give some words/);
});

test("every turn has session_search and session_read, and the bot is told to use them", (t) => {
  const { ws, turn } = setup(t);
  const id = ws.createChat("pip");
  const tools = turn(id, "pip");
  assert.ok(tools.has("session_search") && tools.has("session_read"));
  assert.match(ws.instructionsFor(ws.chat(id), ws.bot("pip")), /session_search/);
  // A helper, a task and a scheduled run read too: the tools change nothing.
  const helper = ws.sessionTools(ws.bot("pip"), { ...ws.chat(id), helper: true }, { id: "r" }, { stopped: false });
  assert.ok(helper.some((tool) => tool.name === "session_search"));
});

test("a bot finds its own past chats, never another bot's, and not this chat unless asked", (t) => {
  const { ws, say, turn } = setup(t);
  const old = ws.createChat("pip", "Botkins Browser Control Extension");
  say(old, ["user", "Build a Chromium browser extension for Botkins"], ["assistant", "Merged PR #250 with the extension."]);
  const other = ws.createChat("scout", "Scout's research");
  say(other, ["user", "browser extension research for scout only"]);
  const now = ws.createChat("pip");
  say(now, ["user", "wait for the browser extension"]);
  const tools = turn(now, "pip");

  const found = call(tools, "session_search", { query: "browser extension" });
  assert.deepEqual([...new Set(found.results.map((hit) => hit.chatId))], [old]);
  assert.equal(found.results[0].title, "Botkins Browser Control Extension");
  assert.ok(found.results.every((hit) => typeof hit.index === "number" && hit.snippet));

  const withThis = call(tools, "session_search", { query: "browser extension", includeThisChat: true });
  assert.ok(withThis.results.some((hit) => hit.chatId === now));

  // A chat's title counts as a match: "#250" is only in a message, "control" only in the title.
  assert.equal(call(tools, "session_search", { query: "control #250" }).results.length, 1);
  assert.equal(call(tools, "session_search", { query: '"extension research"' }).results.length, 0, "Scout's chat is not Pip's");

  const read = call(tools, "session_read", { chatId: old, around: found.results[0].index });
  assert.equal(read.messages.length, 2);
  assert.match(read.messages[1].text, /PR #250/);
  assert.throws(() => tools.get("session_read").handler({ chatId: other }), /no chat/);
});

test("filters: role, dates, one chat, and a limit", (t) => {
  const { ws, say, turn } = setup(t);
  const old = ws.createChat("pip", "Relay");
  say(old, ["user", "relay cost at scale", Date.parse("2026-10-01")], ["assistant", "relay cost stays low", Date.parse("2026-11-20")]);
  const now = ws.createChat("pip");
  const tools = turn(now, "pip");
  assert.equal(call(tools, "session_search", { query: "relay cost", role: "user" }).results[0].role, "user");
  assert.equal(call(tools, "session_search", { query: "relay cost", since: "2026-11-01" }).results.length, 1);
  assert.equal(call(tools, "session_search", { query: "relay cost", before: "2026-11-01" }).results.length, 1);
  assert.equal(call(tools, "session_search", { query: "relay cost", limit: 1 }).results.length, 1);
  assert.throws(() => tools.get("session_search").handler({ query: "x", since: "soon" }), /ISO 8601/);
});

test("a bot without access to a project doesn't find that project's chats", (t) => {
  const { ws, say, turn } = setup(t);
  ws.state.projects = [{ id: "secret", name: "Secret", todos: [] }];
  ws.state.settings.access = { allBots: false };
  ws.bot("pip").access = { all: false, projects: [] };
  const hidden = ws.createChat("pip", "Hidden");
  ws.chat(hidden).projectId = "secret";
  say(hidden, ["user", "the launch codes are tea"]);
  const now = ws.createChat("pip");
  assert.equal(call(turn(now, "pip"), "session_search", { query: "launch codes" }).results.length, 0);
  ws.bot("pip").access = { all: false, projects: ["secret"] };
  assert.equal(call(turn(now, "pip"), "session_search", { query: "launch codes" }).results.length, 1);
});

test("the owner's search covers every bot's chats and skips scratch spaces", (t) => {
  const { ws, say } = setup(t);
  say(ws.createChat("pip"), ["user", "teal anvils"]);
  say(ws.createChat("scout"), ["assistant", "more teal anvils"]);
  const scratch = ws.createChat("patch");
  ws.chat(scratch).temporary = true;
  say(scratch, ["user", "teal anvils in a scratch space"]);
  const found = ws.sessionSearch.search("teal anvils");
  assert.equal(found.results.length, 2);
  assert.equal(found.chats, 2);
});

test("a bot finds the chats of tasks it handed out, and no other task chats", (t) => {
  const { ws, say, turn } = setup(t);
  const handed = ws.createChat("scout", "Task · Relay deploy");
  say(handed, ["user", "Deploy the relay worker"], ["assistant", "Deployed relay worker version 42."]);
  const notMine = ws.createChat("scout", "Task · Other relay job");
  say(notMine, ["user", "relay worker cleanup for the person"]);
  ws.state.tasks = [
    { id: "t1", title: "Relay deploy", botId: "scout", createdBy: "pip", chatId: handed, status: "review" },
    { id: "t2", title: "Other relay job", botId: "scout", createdBy: "person", chatId: notMine, status: "done" },
  ];
  const now = ws.createChat("pip");
  say(now, ["user", "did the relay deploy go out?"]);
  const tools = turn(now, "pip");
  const found = call(tools, "session_search", { query: "relay worker" });
  assert.deepEqual([...new Set(found.results.map((hit) => hit.chatId))], [handed]);
  assert.match(call(tools, "session_read", { chatId: handed }).messages.at(-1).text, /version 42/);
  assert.throws(() => tools.get("session_read").handler({ chatId: notMine }), /no chat/);
});
