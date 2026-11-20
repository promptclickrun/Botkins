import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Board, isShowing, nextMidnight } from "../desktop/board.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-board-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({}), () => {});
  return { ws, board: new Board(ws), bot: ws.state.bots[0].id, other: ws.state.bots[1].id };
}

test("bots post feed items, ideas and goals with validated fields", (t) => {
  const { ws, board, bot } = setup(t);
  const feed = board.post(bot, { kind: "feed", title: " Rates fell ", body: "Mortgage rates dropped.", links: [{ url: "https://example.com/a" }] });
  assert.equal(feed.title, "Rates fell");
  assert.deepEqual(feed.links, [{ url: "https://example.com/a", title: "example.com" }]);
  assert.equal(feed.status, "open");
  assert.equal(feed.read, false);
  assert.equal(board.post(bot, { kind: "goal", title: "Run 5k" }).category, "other");
  assert.equal(board.post(bot, { kind: "goal", title: "Save", category: "finance" }).category, "finance");
  assert.equal(board.post(bot, { kind: "idea", title: "Try a walk" }).category, undefined);
  assert.throws(() => board.post(bot, { kind: "note", title: "x" }), /feed, idea or goal/);
  assert.throws(() => board.post(bot, { kind: "feed", title: "" }), /Invalid title/);
  assert.throws(() => board.post(bot, { kind: "goal", title: "x", category: "chores" }), /goal categories/);
  assert.throws(() => board.post(bot, { kind: "feed", title: "x", links: [{ url: "file:///etc/passwd" }] }), /http or https/);
  assert.throws(() => board.post("nope", { kind: "feed", title: "x" }), /Unknown bot/);
  assert.equal(ws.state.board.length, 4);
});

test("the person's answers change status, rating and snooze", (t) => {
  const { board, bot } = setup(t);
  const feed = board.post(bot, { kind: "feed", title: "News" });
  board.act(feed.id, "read");
  assert.equal(feed.read, true);
  board.act(feed.id, "down", "Too frequent");
  assert.deepEqual([feed.rating, feed.reason, feed.status], ["down", "Too frequent", "cleared"]);
  assert.throws(() => board.act(feed.id, "down", "Boring"), /Unknown reason/);
  const idea = board.post(bot, { kind: "idea", title: "Learn piano", body: "15 minutes a day" });
  const goalId = board.act(idea.id, "goal", "interests");
  assert.deepEqual([idea.answer, idea.status], ["goal", "done"]);
  const goal = board.item(goalId);
  assert.deepEqual([goal.kind, goal.title, goal.category, goal.body], ["goal", "Learn piano", "interests", "15 minutes a day"]);
  board.act(goal.id, "notToday");
  assert.equal(goal.snoozedUntil, nextMidnight());
  assert.equal(isShowing(goal), false);
  assert.equal(isShowing(goal, goal.snoozedUntil), true, "a snoozed goal shows again tomorrow");
  board.act(goal.id, "done");
  assert.equal(isShowing(goal, goal.snoozedUntil), false);
  board.act(goal.id, "reopen");
  assert.equal(isShowing(goal), true);
  const yes = board.post(bot, { kind: "idea", title: "Call mom" });
  board.act(yes.id, "yes");
  assert.deepEqual([yes.answer, yes.status], ["yes", "done"]);
  assert.throws(() => board.act(goal.id, "yes"), /Only ideas/);
  assert.throws(() => board.act(yes.id, "notToday"), /Only goals/);
  board.act(yes.id, "delete");
  assert.throws(() => board.item(yes.id), /no longer exists/);
});

test("bots list and update only their own items, and old open items roll off", (t) => {
  const { board, bot, other } = setup(t);
  const mine = board.post(bot, { kind: "feed", title: "Mine" });
  const theirs = board.post(other, { kind: "feed", title: "Theirs" });
  board.act(mine.id, "up");
  assert.deepEqual(board.list(bot).map((i) => [i.title, i.rating]), [["Mine", "up"]]);
  assert.throws(() => board.update(bot, theirs.id, { title: "Hijack" }), /your own items/);
  board.update(bot, mine.id, { title: "Mine, revised", status: "done" });
  assert.deepEqual([mine.title, mine.status], ["Mine, revised", "done"]);
  for (let i = 0; i < 61; i++) board.post(bot, { kind: "idea", title: "Idea " + i });
  const open = board.items.filter((i) => i.botId === bot && i.kind === "idea" && i.status === "open");
  assert.equal(open.length, 60);
  assert.equal(board.items.find((i) => i.title === "Idea 0").status, "cleared");
});

test("board tools act for the calling bot only during its live turn", async (t) => {
  const { ws, board, bot } = setup(t);
  const chat = { id: ws.createChat(bot) };
  const task = { stopped: false };
  ws.active.set(chat.id, task);
  const run = { id: "r" };
  const tools = Object.fromEntries(board.tools(ws.bot(bot), chat, run, task).map((x) => [x.name, x]));
  const posted = JSON.parse(await tools.board_post.handler({ kind: "goal", title: "Sleep by 11", category: "health" }));
  assert.equal(board.item(posted.posted).botId, bot);
  assert.equal(JSON.parse(await tools.board_list.handler({ kind: "goal" }))[0].title, "Sleep by 11");
  task.stopped = true;
  await assert.rejects(async () => tools.board_post.handler({ kind: "feed", title: "Late" }), /no longer active/);
});
