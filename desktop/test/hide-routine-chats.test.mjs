// Hiding routine-owned chats by default and keeping them out of unread counts across
// desktop, link-host, and team member views.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { isRoutineChat } from "../desktop/link/routine-chat.mjs";
import { LinkHost, MEMBER_PREFERENCE_FIELDS, authorize, filterParts } from "../desktop/link/index.mjs";
import { baseParts } from "../desktop/link/parts.mjs";
import { changeSettings, defaultSettings } from "../desktop/preferences.mjs";
import { chatGroups, chatsPageUnreadChats, isChatsPageUnread, isVisibleInChatList } from "../src/chatSections.ts";
import { allUnreadChats, botUnreadChats, isUnreadChat, unreadBotIds } from "../src/unread.ts";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-hide-routines-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handlers = new Set();
  const session = {
    on: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
    emit: (event) => handlers.forEach((handler) => handler(event)),
    disconnect: async () => {},
    abort: async () => {},
    send: async ({ prompt }) => {
      const messageId = "m_" + Math.random().toString(36).slice(2);
      session.emit({ type: "user.message", id: messageId, data: { messageId } });
      session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Done: " + prompt } });
      session.emit({ type: "session.idle", data: { mode: "interactive" } });
      return messageId;
    },
  };
  const client = async () => ({
    createSession: async () => session,
    resumeSession: async () => session,
    deleteSession: async () => {},
  });
  const open = () => new Workspace(dir, client, () => {}, () => ({ kind: "reject" }));
  return { dir, open, ws: open() };
}

test("isRoutineChat matches routine-owned, proactive, and script routine chats only (never by title or delivery)", () => {
  assert.equal(isRoutineChat(undefined), false);
  assert.equal(isRoutineChat(null), false);
  assert.equal(isRoutineChat({ id: "c1", title: "Routine · Daily check" }), false, "never infer from title");
  assert.equal(isRoutineChat({ id: "c2", title: "Routine · Fake", schedules: [{ id: 1, prompt: "ping" }] }), false, "non-routine schedule is not hidden");
  assert.equal(isRoutineChat({ id: "c3", title: "Main chat", main: true }), false);
  assert.equal(isRoutineChat({ id: "c4", title: "Group", botIds: ["pip", "milo"] }), false);
  assert.equal(isRoutineChat({ id: "c5", title: "Deliver target", posted: [{ from: "Daily", text: "hi" }] }), false);
  assert.equal(isRoutineChat({ id: "r1", schedules: [{ id: 1, routine: true }] }), true);
  assert.equal(isRoutineChat({ id: "r2", schedules: [{ id: 1, routine: true, proactive: true }] }), true);
  assert.equal(isRoutineChat({ id: "r3", schedules: [{ id: 1, routine: true, script: "echo ok" }] }), true);
  assert.equal(isRoutineChat({ id: "r4", title: "Renamed", schedules: [{ id: 1, routine: true }] }), true, "renamed routine chat still matches");
});

test("chatGroups hides routine chats by default, keeps open routine chat visible until left, and reveals all when enabled or searching", () => {
  const today = new Date(2026, 10, 20).getTime();
  const chat = (id, time, more = {}) => ({ id, botId: "pip", title: id, time, messages: [], ...more });
  const chats = [
    chat("ordinary", today + 4000),
    chat("routine_named_ordinary", today + 3500, { title: "Routine · Fake title" }),
    chat("deliver_target", today + 3000, { unread: true }),
    chat("routine_own", today + 2500, { title: "Routine · Standup", unread: true, schedules: [{ id: 1, routine: true }] }),
    chat("routine_proactive", today + 2000, { title: "Routine · Proactive", unread: true, schedules: [{ id: 1, routine: true, proactive: true }] }),
    chat("routine_archived", today + 1500, { title: "Routine · Old", archived: true, schedules: [{ id: 1, routine: true }] }),
  ];

  const ids = (opts) => chatGroups({ chats, today, ...opts }).flatMap((g) => g.chats.map((c) => c.id));

  // Default (off): routine chats hidden, fake-titled ordinary chat & delivery target stay visible.
  assert.deepEqual(ids({}), ["ordinary", "routine_named_ordinary", "deliver_target"]);
  assert.deepEqual(ids({ filter: "Archived" }), []);

  // Open-chat exception: currently open routine chat stays visible until you leave it.
  assert.deepEqual(ids({ selectedChatId: "routine_own" }), ["ordinary", "routine_named_ordinary", "deliver_target", "routine_own"]);
  assert.deepEqual(ids({ selectedChatId: "ordinary" }), ["ordinary", "routine_named_ordinary", "deliver_target"]);
  assert.equal(isVisibleInChatList(chats[3], { showRoutineChats: false, selectedChatId: "routine_own" }), true);
  assert.equal(isVisibleInChatList(chats[3], { showRoutineChats: false, selectedChatId: "ordinary" }), false);

  // Search still surfaces routine chats so they can be opened from search.
  assert.deepEqual(ids({ query: "standup" }), ["routine_own"]);

  // Show routine chats = true reveals all routine chats (including under Archived).
  assert.deepEqual(ids({ showRoutineChats: true }), ["ordinary", "routine_named_ordinary", "deliver_target", "routine_own", "routine_proactive"]);
  assert.deepEqual(ids({ showRoutineChats: true, filter: "Archived" }), ["routine_archived"]);

  // Unread filter excludes routine chats even when showRoutineChats is on.
  assert.deepEqual(ids({ filter: "Unread", showRoutineChats: false }), ["deliver_target"]);
  assert.deepEqual(ids({ filter: "Unread", showRoutineChats: true }), ["deliver_target"]);
});

test("showRoutineChats preference defaults to false, round-trips for owner, and stays per-member in link team views", async (t) => {
  assert.equal(defaultSettings.showRoutineChats, false);
  assert.equal(MEMBER_PREFERENCE_FIELDS.includes("showRoutineChats"), true);
  assert.equal(changeSettings(defaultSettings, { showRoutineChats: true }).showRoutineChats, true);
  assert.throws(() => changeSettings(defaultSettings, { showRoutineChats: "yes" }), /on or off/i);

  const dir = mkdtempSync(join(tmpdir(), "botkins-pref-member-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = {
    bots: [{ id: "pip", name: "Pip" }],
    chats: [
      { id: "c_owner", botId: "pip", title: "Owner", time: 2000, messages: [] },
      { id: "c_member_routine", botId: "pip", createdBy: "m_sam", title: "Routine · Sam", time: 3000, unread: true, schedules: [{ id: 1, routine: true }], messages: [{ role: "assistant", text: "ok" }] },
    ],
    runs: [],
    panels: [],
    board: [],
    requests: [],
    settings: { ...defaultSettings, showRoutineChats: false },
    skills: { skills: [], folders: [], plugins: [], disabled: [] },
    mcp: [],
    plugins: [],
    meta: { name: "Host" },
  };
  const team = {
    name: "Studio",
    roles: [
      { id: "r_view", name: "Viewer", perms: { agents: ["view"], today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots: ["pip"] },
    ],
    groups: [{ id: "g_view", name: "Viewers", roleId: "r_view" }],
    members: [
      { id: "m_sam", name: "Sam", groupId: "g_view", joinedAt: 1 },
      { id: "m_lee", name: "Lee", groupId: "g_view", joinedAt: 2 },
    ],
    invites: [],
    requests: [],
    chats: {},
    views: {},
  };
  const sam = { kind: "member", memberId: "m_sam", name: "Sam", groupId: "g_view" };
  const lee = { kind: "member", memberId: "m_lee", name: "Lee", groupId: "g_view" };

  // View-only member can toggle their own showRoutineChats without settings.manage, but cannot set other settings.
  assert.equal(authorize(sam, team, "setPreferences", [{ showRoutineChats: true }], {}), "");
  assert.notEqual(authorize(sam, team, "setPreferences", [{ readAloud: true }], {}), "");

  const host = new LinkHost({
    dir,
    port: 0,
    backend: {
      info: () => ({ app: "Botkins", version: "1.0.0", platform: "darwin" }),
      snapshot: () => state,
      call: (method, args) => {
        if (method === "setPreferences") state.settings = changeSettings(state.settings, args[0]);
        return null;
      },
      subscribe: () => () => {},
    },
  });
  host.store.set({ team });

  // Sam toggles showRoutineChats via memberView; owner & Lee remain false.
  host.memberView(sam, "setPreferences", [{ showRoutineChats: true }], state);
  const parts = baseParts(state, { name: "Host", version: "1.0.0", platform: "darwin", capabilities: [] }, {});
  // Routine chat never carries unread in baseParts either.
  assert.equal(parts.chats.find((c) => c.id === "c_member_routine")?.unread, undefined);

  const samParts = filterParts(parts, sam, host.store.data.team);
  const leeParts = filterParts(parts, lee, host.store.data.team);
  assert.equal(state.settings.showRoutineChats, false, "owner workspace setting unchanged");
  assert.equal(samParts.settings.showRoutineChats, true, "Sam sees their own preference");
  assert.equal(leeParts.settings.showRoutineChats, false, "Lee's preference stays off");
  // Even for a member who hasn't opened their routine chat, fresh must be false (never unread).
  assert.equal(samParts.chats.find((c) => c.id === "c_member_routine")?.unread, undefined);
});

test("routine run leaves own chat unread false; delivering to ordinary chat marks target unread; legacy unread routine chat cleared on load", async (t) => {
  const { open, ws } = setup(t);
  const T0 = Date.UTC(2026, 10, 17, 12);
  const targetId = ws.createChat("pip", "Morning inbox");

  // 1. Routine running in its own chat leaves unread false and badges unchanged.
  const ownId = ws.panels.routines.create({
    botId: "pip",
    name: "Self check",
    prompt: "Check status",
    cadence: { kind: "daily", time: "09:00" },
    timezone: "UTC",
  }, T0);
  await ws.panels.routines.run(ownId);
  assert.equal(ws.chat(ownId).unread, undefined);
  assert.equal(allUnreadChats(ws.state.chats).length, 0);
  assert.equal(chatsPageUnreadChats(ws.state.chats).length, 0);

  // 2. Routine delivering to an ordinary chat marks that delivery target unread, not the routine chat.
  const deliverRoutineId = ws.panels.routines.create({
    botId: "pip",
    name: "Deliver check",
    prompt: "Send digest",
    cadence: { kind: "daily", time: "09:00" },
    timezone: "UTC",
    deliver: { to: "chat", chatId: targetId },
  }, T0);
  await ws.panels.routines.run(deliverRoutineId);
  assert.equal(ws.chat(deliverRoutineId).unread, undefined, "routine's own chat stays read");
  assert.equal(ws.chat(targetId).unread, true, "ordinary delivery target chat goes unread");
  assert.deepEqual(allUnreadChats(ws.state.chats).map((c) => c.id), [targetId]);
  assert.deepEqual(chatsPageUnreadChats(ws.state.chats).map((c) => c.id), [targetId]);

  // 3. Attempting to mark a routine chat unread via setChatFlags never makes it unread.
  ws.agents.setChatFlags(ownId, { unread: true });
  assert.equal(ws.chat(ownId).unread, false);

  // 4. Legacy routine chat with stale unread: true is excluded from all counts and cleared on reload.
  ws.chat(ownId).unread = true;
  assert.equal(isUnreadChat(ws.chat(ownId)), false);
  assert.equal(isChatsPageUnread(ws.chat(ownId)), false);
  assert.deepEqual(botUnreadChats(ws.state.chats, "pip").map((c) => c.id), [targetId]);
  assert.deepEqual([...unreadBotIds(ws.state.chats)], ["pip"]);
  ws.save();

  const reloaded = open();
  assert.equal(reloaded.chat(ownId).unread, false, "migration cleared stale unread flag on routine chat");
  assert.equal(reloaded.chat(targetId).unread, true, "ordinary chat unread preserved across reload");
});

test("routine-chat helper stays byte-identical between desktop/desktop/link and mobile/link-host", () => {
  for (const file of ["routine-chat.mjs", "routine-chat.d.mts", "team.mjs", "server.mjs", "parts.mjs", "index.mjs"]) {
    assert.equal(
      readFileSync(new URL("../desktop/link/" + file, import.meta.url), "utf8"),
      readFileSync(new URL("../../mobile/link-host/" + file, import.meta.url), "utf8"),
      file + " matches mobile/link-host",
    );
  }
});
