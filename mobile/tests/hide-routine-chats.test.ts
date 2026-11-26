// Mobile predicate, chat-list visibility, open-chat exception, unread exclusion, and member pref sync.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isRoutineChat } from "../link-host/routine-chat.mjs";
import { LinkHost, MEMBER_PREFERENCE_FIELDS, authorize, filterParts } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import {
  allUnreadChats,
  chatsPageUnreadChats,
  isChatsPageArchived,
  isChatsPageChat,
  isChatsPageUnread,
  isUnreadChat,
  isVisibleInChatList,
  unreadBotIds,
} from "../src/features/chat/unread";
import type { ChatSummary } from "../src/link/types";

const chat = (id: string, more: Partial<ChatSummary> = {}): ChatSummary => ({ id, botId: "pip", title: id, time: 1, count: 2, ...more });

test("phone chat list hides routine chats by default, keeps open routine chat visible, and excludes them from badges", () => {
  const ordinary = chat("ordinary", { title: "Ordinary" });
  const fakeTitle = chat("fake", { title: "Routine · Not a routine" });
  const deliverTarget = chat("target", { title: "Digest target", unread: true });
  const routine = chat("routine", { title: "Routine · Daily", unread: true, schedules: [{ id: 1, routine: true } as never] });
  const proactive = chat("proactive", { title: "Routine · Watch", unread: true, schedules: [{ id: 1, routine: true, proactive: true } as never] });
  const archivedRoutine = chat("archived_routine", { title: "Routine · Old", archived: true, schedules: [{ id: 1, routine: true } as never] });
  const chats = [ordinary, fakeTitle, deliverTarget, routine, proactive, archivedRoutine];

  assert.equal(isRoutineChat(ordinary), false);
  assert.equal(isRoutineChat(fakeTitle), false);
  assert.equal(isRoutineChat(deliverTarget), false);
  assert.equal(isRoutineChat(routine), true);
  assert.equal(isRoutineChat(proactive), true);

  // Default hidden:
  assert.deepEqual(
    chats.filter((c) => isChatsPageChat(c)).map((c) => c.id),
    ["ordinary", "fake", "target"],
  );
  assert.deepEqual(
    chats.filter((c) => isChatsPageArchived(c)).map((c) => c.id),
    [],
  );

  // Open-chat exception (selectedChatId / split pane):
  assert.deepEqual(
    chats.filter((c) => isChatsPageChat(c, { showRoutineChats: false, selectedChatId: "routine" })).map((c) => c.id),
    ["ordinary", "fake", "target", "routine"],
  );
  assert.equal(isVisibleInChatList(routine, { showRoutineChats: false, selectedChatId: "ordinary" }), false);

  // Search reveals routine chats:
  assert.equal(isVisibleInChatList(routine, { showRoutineChats: false, query: "daily" }), true);

  // Show routine chats enabled:
  assert.deepEqual(
    chats.filter((c) => isChatsPageChat(c, { showRoutineChats: true })).map((c) => c.id),
    ["ordinary", "fake", "target", "routine", "proactive"],
  );
  assert.deepEqual(
    chats.filter((c) => isChatsPageArchived(c, { showRoutineChats: true })).map((c) => c.id),
    ["archived_routine"],
  );

  // Unread list and Chats tab badge exclude routine chats whether showRoutineChats is on or off:
  assert.deepEqual(chatsPageUnreadChats(chats).map((c) => c.id), ["target"]);
  assert.deepEqual(allUnreadChats(chats).map((c) => c.id), ["target"]);
  assert.equal(chats.filter(isChatsPageUnread).length, 1);
  assert.equal(isUnreadChat(routine), false);
  assert.equal(isUnreadChat(proactive), false);
  assert.equal(isChatsPageUnread(routine), false);
  assert.deepEqual([...unreadBotIds([routine, proactive])], []);
});

test("MockBackend and mobile link-host round-trip showRoutineChats per person and keep routine chats read", async (t) => {
  assert.equal(MEMBER_PREFERENCE_FIELDS.includes("showRoutineChats"), true);
  const backend = new MockBackend();
  assert.equal(backend.state.settings.showRoutineChats, false);
  await backend.call("setPreferences", [{ showRoutineChats: true }]);
  assert.equal(backend.state.settings.showRoutineChats, true);
  await assert.rejects(backend.call("setPreferences", [{ showRoutineChats: "yes" }]));

  const dir = mkdtempSync(join(tmpdir(), "botkins-mobile-routines-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const team = {
    name: "Team",
    roles: [{ id: "r_v", name: "Viewer", perms: { agents: ["view"], today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots: "all" }],
    groups: [{ id: "g_v", name: "Viewers", roleId: "r_v" }],
    members: [{ id: "m_1", name: "Alex", groupId: "g_v", joinedAt: 1 }],
    invites: [],
    requests: [],
    chats: {},
    views: {},
  };
  const alex = { kind: "member", memberId: "m_1", name: "Alex", groupId: "g_v" };
  assert.equal(authorize(alex, team, "setPreferences", [{ showRoutineChats: true }], {}), "");

  const host = new LinkHost({ dir, port: 0, backend });
  host.store.set({ team });
  await backend.call("setPreferences", [{ showRoutineChats: false }]);
  host.memberView(alex, "setPreferences", [{ showRoutineChats: true }], backend.snapshot());
  const filtered = filterParts(
    {
      bots: backend.state.bots,
      chats: [{ id: "rc", botId: backend.state.bots[0].id, createdBy: "m_1", title: "Routine · Ping", time: Date.now(), count: 1, unread: true, schedules: [{ id: 1, routine: true }] }],
      live: { streams: {}, intents: {}, thinking: {}, speakers: {}, queued: {}, requests: [], active: [] },
      runs: [],
      settings: backend.state.settings,
      meta: { name: "Demo" },
    },
    alex,
    host.store.data.team,
  );
  assert.equal(backend.state.settings.showRoutineChats, false);
  assert.equal(filtered.settings.showRoutineChats, true);
  assert.equal(filtered.chats[0].unread, undefined);
});
