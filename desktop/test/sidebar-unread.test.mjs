// Sidebar unread & changed markers: one helper governs both the dots and the mark-read actions,
// so clicking a bot clears every chat that kept its dot lit (including older work-item, task, or
// routine chats), and spaces/bots can also be explicitly marked read.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Workspace } from "./starter.mjs";
import { allUnreadChats, botUnreadChats, changedSpaces, isUnreadChat, unreadBotIds } from "../src/unread.ts";

test("older unread chat (e.g. from a work item or routine) still lights the bot dot and is returned by botUnreadChats", () => {
  const chats = [
    { id: "c_new", botId: "pip", time: 2000, unread: false },
    { id: "c_old_work", botId: "pip", time: 1000, unread: true },
    { id: "c_archived", botId: "pip", time: 1500, unread: true, archived: true },
    { id: "c_panel", botId: "pip", time: 1800, unread: true, panelId: "p_1" },
    { id: "c_other", botId: "milo", time: 1900, unread: true },
  ];

  // Before marking the bot read, Pip still has an unread dot because c_old_work is unread,
  // even though Pip's newest chat (c_new, which clicking Pip opens) is already read.
  assert.equal(unreadBotIds(chats).has("pip"), true);
  assert.deepEqual(
    botUnreadChats(chats, "pip").map((c) => c.id),
    ["c_old_work"],
  );
  assert.deepEqual(
    allUnreadChats(chats).map((c) => c.id),
    ["c_old_work", "c_other"],
  );

  // Marking only the opened chat (c_new) read leaves Pip's dot stuck; marking botUnreadChats clears it.
  const onlyOpenedCleared = chats.map((c) => (c.id === "c_new" ? { ...c, unread: false } : c));
  assert.equal(unreadBotIds(onlyOpenedCleared).has("pip"), true);

  const toMark = new Set(botUnreadChats(chats, "pip").map((c) => c.id));
  const afterBotClick = chats.map((c) => (toMark.has(c.id) ? { ...c, unread: false } : c));
  assert.equal(unreadBotIds(afterBotClick).has("pip"), false);
  assert.equal(unreadBotIds(afterBotClick).has("milo"), true, "other bots stay untouched");
});

test("archived and panel chats never count as unread", () => {
  assert.equal(isUnreadChat({ unread: true }), true);
  assert.equal(isUnreadChat({ unread: false }), false);
  assert.equal(isUnreadChat({ unread: true, archived: true }), false);
  assert.equal(isUnreadChat({ unread: true, panelId: "p_1" }), false);
  assert.equal(unreadBotIds([{ botId: "pip", unread: true, archived: true }, { botId: "pip", unread: true, panelId: "p_1" }]).size, 0);
});

test("Workspace.setChatFlags clears every unread chat of a bot so its dot disappears", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-unread-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({}), () => {});
  const botId = ws.state.bots[0].id;
  const olderId = ws.createChat(botId, "Work item chat");
  const newerId = ws.createChat(botId, "Latest chat");
  ws.agents.setChatFlags(olderId, { unread: true });
  ws.agents.setChatFlags(newerId, { unread: false });

  assert.equal(unreadBotIds(ws.state.chats).has(botId), true);
  // Marking only the newest chat read reproduces the sticky-dot bug.
  ws.agents.setChatFlags(newerId, { unread: false });
  assert.equal(unreadBotIds(ws.state.chats).has(botId), true);

  for (const chat of botUnreadChats(ws.state.chats, botId)) {
    ws.agents.setChatFlags(chat.id, { unread: false });
  }
  assert.equal(unreadBotIds(ws.state.chats).has(botId), false);
});

test("changedSpaces returns only spaces with changed > 0", () => {
  const spaces = [
    { id: "s_1", changed: 0 },
    { id: "s_2", changed: 2 },
    { id: "s_3", changed: 1 },
  ];
  assert.deepEqual(changedSpaces(spaces).map((s) => s.id), ["s_2", "s_3"]);
  assert.deepEqual(changedSpaces(undefined), []);
});

test("desktop UI wires the shared unread helper and explicit mark-as-read controls", () => {
  const app = readFileSync(join(import.meta.dirname, "../src/app.tsx"), "utf8");
  const pages = readFileSync(join(import.meta.dirname, "../src/Pages.tsx"), "utf8");
  const spacePage = readFileSync(join(import.meta.dirname, "../src/SpacePage.tsx"), "utf8");
  assert.match(app, /botUnreadChats/);
  assert.match(app, /markBotRead/);
  assert.match(app, /markAllChatsRead/);
  assert.match(pages, /unreadBotIds/);
  assert.match(pages, /Mark as read/);
  assert.match(pages, /Mark all as read/);
  assert.match(spacePage, /Mark as read/);
});
