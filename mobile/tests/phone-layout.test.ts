// The plain logic behind the phone's simplified layout (built 2026-11-25 from the owner's mockups):
// Home's inline approvals, the Chats screen's chips and one list, Work's overview and Tasks page,
// the project page's folder chip, and Settings' search.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerInline } from "../src/features/home/arrange";
import { arrangeChatsFlat, chatChips, chatDropPlan, chatsForFilter } from "../src/features/chat/sections";
import { activeGroups, dayWord, projectProgress, taskCounts, tasksIn, upNext } from "../src/features/work/overview";
import { folderLabel } from "../src/features/projects/logic";
import { findSettings, matchesSetting } from "../src/features/settings/search";
import type { BotTask, ChatSummary, Section } from "../src/link/types";

const chat = (id: string, time: number, extra: Partial<ChatSummary> = {}) => ({ id, time, title: id, botId: "b", ...extra }) as ChatSummary;
const sections: Section[] = [{ id: "work", name: "Work" }, { id: "home", name: "Home" }] as Section[];

test("Home answers only an ordinary approval in its own row", () => {
  assert.equal(answerInline({ kind: "permission" }, false), true);
  assert.equal(answerInline({ kind: "permission" }, true), false, "a command that looks risky opens the chat");
  assert.equal(answerInline({ kind: "permission", review: true }, false), false, "a script is read whole first");
  assert.equal(answerInline({ kind: "permission", dispatch: true }, false), false);
  assert.equal(answerInline({ kind: "permission", nodeJob: true }, false), false);
  for (const kind of ["question", "form", "secure"]) assert.equal(answerInline({ kind }, false), false, kind);
});

test("the Chats list is one list, newest first, with pinned chats left for the row above it", () => {
  const chats = [chat("a", 1), chat("b", 3, { sectionId: "work" }), chat("c", 2, { pinned: true })];
  const groups = arrangeChatsFlat(chats, sections);
  assert.deepEqual(groups.map((group) => [group.key, group.title, group.chats.map((one) => one.id)]), [["recent", "Recent", ["b", "a"]]]);
  assert.deepEqual(arrangeChatsFlat([chat("c", 2, { pinned: true })], sections), [], "nothing but pinned chats: no list");
});

test("while a chat is dragged, Pinned and every section show above the list as places to drop it", () => {
  const groups = arrangeChatsFlat([chat("a", 1)], sections, { dragging: true });
  assert.deepEqual(groups.map((group) => [group.key, group.chats.length]), [["pinned", 0], ["section:work", 0], ["section:home", 0], ["recent", 1]]);
  assert.equal(arrangeChatsFlat([], sections, { dragging: true }).at(-1)?.key, "recent", "the list stays a place too");
});

test("a drop on Recent only unpins: a chat keeps its section", () => {
  assert.deepEqual(chatDropPlan({ pinned: true, sectionId: "work" }, sections, "recent"), { pinned: false });
  assert.equal(chatDropPlan({ sectionId: "work" }, sections, "recent"), undefined);
  assert.equal(chatDropPlan({}, sections, "recent"), undefined);
  assert.deepEqual(chatDropPlan({ sectionId: "work" }, sections, "section:home"), { sectionId: "home" }, "a section still moves it");
});

test("the chips: All, Unread with its count for someone who may read, then each section", () => {
  assert.deepEqual(chatChips(sections, 3, true), [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread", count: 3 },
    { value: "section:work", label: "Work" },
    { value: "section:home", label: "Home" },
  ]);
  assert.deepEqual(chatChips(undefined, 0, true), [{ value: "all", label: "All" }, { value: "unread", label: "Unread" }]);
  assert.deepEqual(chatChips(undefined, 2, false), [{ value: "all", label: "All" }]);
});

test("a chip shows its chats, and a section that is gone shows them all", () => {
  const chats = [chat("a", 1), chat("b", 2, { sectionId: "work" }), chat("c", 3, { sectionId: "home" })];
  const ids = (list: ChatSummary[]) => list.map((one) => one.id);
  assert.deepEqual(ids(chatsForFilter(chats, "all", sections, new Set())), ["a", "b", "c"]);
  assert.deepEqual(ids(chatsForFilter(chats, "unread", sections, new Set(["c"]))), ["c"]);
  assert.deepEqual(ids(chatsForFilter(chats, "section:work", sections, new Set())), ["b"]);
  assert.deepEqual(ids(chatsForFilter(chats, "section:gone", sections, new Set())), ["a", "b", "c"]);
});

const task = (id: string, status: BotTask["status"], priority: BotTask["priority"] = "normal", updatedAt = 0, extra: Partial<BotTask> = {}) => ({ id, status, priority, updatedAt, ...extra }) as BotTask;

test("Active holds what needs the person, then bot-reviewed tasks, then what works, then what is ready; Later and Done hold the rest", () => {
  const tasks = [
    task("ready-low", "ready", "low", 9),
    task("working", "working"),
    task("ready-urgent", "ready", "urgent"),
    task("blocked", "blocked"),
    task("review", "review", "normal", 5),
    task("creator-review", "review", "high", 6, { reviewerBotId: "alfie" }),
    task("later", "later"),
    task("done-old", "done", "normal", 1),
    task("done-new", "done", "normal", 2),
    task("gone", "archived"),
  ];
  assert.deepEqual(tasksIn(tasks, "active").map((one) => one.id), ["review", "blocked", "creator-review", "working", "ready-urgent", "ready-low"]);
  assert.deepEqual(tasksIn(tasks, "later").map((one) => one.id), ["later"]);
  assert.deepEqual(tasksIn(tasks, "done").map((one) => one.id), ["done-new", "done-old"]);
  assert.deepEqual(taskCounts(tasks), { active: 6, later: 1, done: 2 });
  assert.deepEqual(activeGroups(tasks).map((group) => [group.title, group.tasks.length]), [["Needs you", 2], ["Reviewing", 1], ["Working", 1], ["Ready", 2]]);
  assert.deepEqual(activeGroups([task("l", "later")]), [], "no empty groups");
});

test("up next: routines that are on and have a next run, soonest first", () => {
  const routine = (id: string, nextAt: number | null, enabled?: boolean) => ({ id, entry: { nextAt, enabled } });
  const list = [routine("late", 300), routine("paused", 100, false), routine("never", null), routine("soon", 200), routine("later", 400)];
  assert.deepEqual(upNext(list, 2).map((one) => one.id), ["soon", "late"]);
});

test("a project's progress counts its to-dos", () => {
  const todo = (done: boolean) => ({ id: String(Math.random()), text: "x", done, createdAt: 0 });
  assert.deepEqual(projectProgress({ todos: [todo(true), todo(false), todo(true), todo(false)] }), { done: 2, total: 4, share: 0.5, line: "2 of 4 to-dos" });
  assert.deepEqual(projectProgress({ todos: [] }), { done: 0, total: 0, share: 0, line: "No to-dos yet" });
});

test("the day under a routine's time", () => {
  const now = new Date(2026, 10, 25, 10, 0).getTime();
  assert.equal(dayWord(new Date(2026, 10, 25, 11, 30).getTime(), now), "Today");
  assert.equal(dayWord(new Date(2026, 10, 25, 21, 0).getTime(), now), "Tonight");
  assert.equal(dayWord(new Date(2026, 10, 26, 7, 30).getTime(), now), "Tomorrow");
  assert.equal(dayWord(new Date(2026, 10, 28, 16, 0).getTime(), now), new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(2026, 10, 28, 16, 0)));
});

test("a folder chip names a folder by its last two parts", () => {
  assert.equal(folderLabel("/Users/colt/Code/botkins-ios"), "Code/botkins-ios");
  assert.equal(folderLabel("C:\\Users\\colt\\Code\\site"), "Code/site");
  assert.equal(folderLabel("/srv"), "/srv");
});

test("Settings' search keeps the rows whose words all match, and the groups that keep any", () => {
  const groups = [
    { key: "phone", rows: [{ title: "Appearance", words: "theme dark light backdrop" }, { title: "Tabs" }] },
    { key: "how", rows: [{ title: "Chat", subtitle: "Thinking, steps, approvals" }] },
  ];
  assert.deepEqual(findSettings(groups, "").map((group) => group.rows.length), [2, 1]);
  assert.deepEqual(findSettings(groups, "DARK").map((group) => group.rows.map((row) => row.title)), [["Appearance"]]);
  assert.deepEqual(findSettings(groups, "approvals").map((group) => group.key), ["how"]);
  assert.deepEqual(findSettings(groups, "dark approvals"), [], "every word has to match one row");
  assert.equal(matchesSetting({ title: "General", words: "harness model" }, "harness"), true);
});
