// The Chats page's order with sections ("chat-sections-v1"): Pinned, each section, then the rest by day.
import test from "node:test";
import assert from "node:assert/strict";
import { chatGroups, hasChatSections, movedSection } from "../src/chatSections.ts";

const today = new Date(2026, 10, 20).getTime();
const hour = 3600000;
const chat = (id, time, more = {}) => ({ id, botId: "pip", title: id, time, messages: [], ...more });
const chats = [
  chat("plan", today + 5 * hour, { sectionId: "cs_work" }),
  chat("notes", today + 2 * hour, { sectionId: "cs_work" }),
  chat("pinned", today - 3 * hour, { pinned: true, sectionId: "cs_work" }),
  chat("trip", today + hour),
  chat("old", today - 9 * 86400000, { sectionId: "cs_gone" }),
  chat("asleep", today, { archived: true, sectionId: "cs_work", pinned: true }),
  chat("news", today + 3 * hour, { unread: true, sectionId: "cs_home" }),
];
const sections = [
  { id: "cs_work", name: "Work" },
  { id: "cs_home", name: "Home" },
  { id: "cs_empty", name: "Later" },
];
const shape = (groups) => groups.map((group) => [group.label, group.chats.map((item) => item.id)]);

test("Pinned, then each section in the person's order newest first, then the rest by day", () => {
  assert.deepEqual(shape(chatGroups({ chats, sections, today })), [
    ["Pinned", ["pinned"]],
    ["Work", ["plan", "notes"]],
    ["Home", ["news"]],
    ["Later", []],
    ["Today", ["trip"]],
    ["Earlier", ["old"]],
  ]);
  const work = chatGroups({ chats, sections, today }).find((group) => group.kind === "section");
  assert.deepEqual(work.section, sections[0]);
});

test("without sections on the computer the list is as before", () => {
  assert.deepEqual(shape(chatGroups({ chats, today })), [
    ["Pinned", ["pinned"]],
    ["Today", ["plan", "news", "notes", "trip"]],
    ["Earlier", ["old"]],
  ]);
});

test("while searching only groups with a match show, and the bot's name matches too", () => {
  assert.deepEqual(shape(chatGroups({ chats, sections, today, query: "PLA" })), [["Work", ["plan"]]]);
  assert.deepEqual(shape(chatGroups({ chats, sections, today, query: "zebra" })), []);
  assert.equal(chatGroups({ chats, sections, today, query: "pip", botName: () => "Pip" }).length, 5);
});

test("Unread shows only groups with an unread chat; Archived lists archived chats by day, without sections", () => {
  assert.deepEqual(shape(chatGroups({ chats, sections, today, filter: "Unread" })), [["Home", ["news"]]]);
  assert.deepEqual(shape(chatGroups({ chats, sections, today, filter: "Archived" })), [["Today", ["asleep"]]]);
});

test("a section moves up and down in the person's order", () => {
  assert.deepEqual(movedSection(sections, "cs_home", -1), ["cs_home", "cs_work", "cs_empty"]);
  assert.deepEqual(movedSection(sections, "cs_home", 1), ["cs_work", "cs_empty", "cs_home"]);
  assert.equal(movedSection(sections, "cs_work", -1), null);
  assert.equal(movedSection(sections, "cs_empty", 1), null);
  assert.equal(movedSection(sections, "cs_none", 1), null);
});

test("the computer in use has sections when it sends them, or another computer names the capability", () => {
  assert.equal(hasChatSections({}), false);
  assert.equal(hasChatSections({ chatSections: [] }), true);
  assert.equal(hasChatSections({ remote: { using: { capabilities: ["chat-sections-v1"] }, hosts: [] } }), true);
  assert.equal(hasChatSections({ remote: { using: { capabilities: [] }, hosts: [] } }), false);
});
