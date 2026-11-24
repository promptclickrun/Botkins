// Pure unread/changed rules shared by Home's bot dots, BotMenu, Chats, and Spaces
// (src/features/chat/unread.ts; mirrors desktop/src/unread.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { allUnreadChats, botUnreadChats, changedSpaces, isUnreadChat, runMarkChatsRead, runMarkSpacesRead, unreadBotIds } from "../src/features/chat/unread";
import type { ChatSummary } from "../src/link/types";

const chat = (id: string, more: Partial<ChatSummary> = {}): ChatSummary => ({ id, botId: "pip", title: id, time: 1, count: 2, ...more });

// Shared parity fixture (mirrored verbatim in desktop/test/sidebar-unread.test.mjs) so desktop and
// phone never drift on group, routine, panel, or archived chats.
const PARITY_CHATS: ChatSummary[] = [
  chat("c_latest_read", { botId: "pip", title: "Latest", time: 5000, unread: false }),
  chat("c_group", { botId: "pip", botIds: ["pip", "milo"], title: "Group", time: 4000, unread: true }),
  chat("c_routine", { botId: "pip", title: "Daily routine", time: 3000, unread: true, schedules: [{ id: "s1", routine: true } as never] }),
  chat("c_panel", { botId: "pip", title: "Panel", time: 2000, unread: true, panelId: "p_1" }),
  chat("c_archived", { botId: "pip", title: "Archived", time: 1000, unread: true, archived: true }),
  chat("c_other", { botId: "milo", title: "Milo", time: 1500, unread: true }),
];

test("shared parity fixture: group and routine chats light Pip's dot and clear together; panel and archived stay excluded", () => {
  assert.deepEqual([...unreadBotIds(PARITY_CHATS)].sort(), ["milo", "pip"]);
  assert.deepEqual(
    botUnreadChats(PARITY_CHATS, "pip").map((c) => c.id),
    ["c_group", "c_routine"],
  );
  assert.deepEqual(
    allUnreadChats(PARITY_CHATS).map((c) => c.id),
    ["c_group", "c_routine", "c_other"],
  );
  assert.equal(isUnreadChat(PARITY_CHATS[1]), true);
  assert.equal(isUnreadChat(PARITY_CHATS[2]), true);
  assert.equal(isUnreadChat(PARITY_CHATS[3]), false);
  assert.equal(isUnreadChat(PARITY_CHATS[4]), false);
});

test("changedSpaces returns only spaces with changed > 0", () => {
  const spaces = [
    { id: "s_1", changed: 0 },
    { id: "s_2", changed: 3 },
    { id: "s_3", changed: 1 },
  ];
  assert.deepEqual(
    changedSpaces(spaces).map((space) => space.id),
    ["s_2", "s_3"],
  );
});

test("runMarkChatsRead uses one batch call when supported and falls back to per-chat calls on older computers", async () => {
  const batched: string[][] = [];
  const perChat: string[] = [];
  const modern = await runMarkChatsRead(["c1", "c2", "c1"], {
    hasBatch: true,
    markChatsRead: async (ids) => {
      batched.push(ids);
    },
    setChatFlags: async (id) => {
      perChat.push(id);
    },
  });
  assert.deepEqual(modern, { ok: true });
  assert.deepEqual(batched, [["c1", "c2"]]);
  assert.deepEqual(perChat, []);

  const legacyCalls: Array<[string, { unread: false }]> = [];
  const legacy = await runMarkChatsRead(["c1", "c2"], {
    hasBatch: false,
    markChatsRead: async () => {
      throw new Error("should not call batch on legacy host");
    },
    setChatFlags: async (id, flags) => {
      legacyCalls.push([id, flags]);
    },
  });
  assert.deepEqual(legacy, { ok: true });
  assert.deepEqual(legacyCalls, [
    ["c1", { unread: false }],
    ["c2", { unread: false }],
  ]);

  const fallbackCalls: string[] = [];
  const unknownMethod = await runMarkChatsRead(["c3"], {
    hasBatch: true,
    markChatsRead: async () => {
      throw new Error("Unknown method: markChatsRead");
    },
    setChatFlags: async (id) => {
      fallbackCalls.push(id);
    },
  });
  assert.deepEqual(unknownMethod, { ok: true });
  assert.deepEqual(fallbackCalls, ["c3"]);
});

test("runMarkChatsRead and runMarkSpacesRead report failures instead of swallowing them", async () => {
  const batchErr = new Error("Connection dropped");
  let perChatCalled = false;
  const dropped = await runMarkChatsRead(["c1", "c2"], {
    hasBatch: true,
    markChatsRead: async () => {
      throw batchErr;
    },
    setChatFlags: async () => {
      perChatCalled = true;
    },
  });
  assert.equal(perChatCalled, false);
  assert.equal(dropped.ok, false);
  if (!dropped.ok) {
    assert.equal(dropped.failed, 2);
    assert.equal(dropped.error, batchErr);
  }

  const partial = await runMarkChatsRead(["c1", "c2"], {
    hasBatch: false,
    markChatsRead: async () => {},
    setChatFlags: async (id) => {
      if (id === "c2") throw new Error("offline");
    },
  });
  assert.equal(partial.ok, false);
  if (!partial.ok) {
    assert.equal(partial.failed, 1);
    assert.match(String(partial.error), /offline/);
  }

  const spaceResult = await runMarkSpacesRead(["s1", "s2", "s3"], async (id) => {
    if (id === "s2") throw new Error("link closed");
  });
  assert.deepEqual(spaceResult.succeeded, ["s1", "s3"]);
  assert.equal(spaceResult.failed, 1);
  assert.match(String(spaceResult.error), /link closed/);
});
