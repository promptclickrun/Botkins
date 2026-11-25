// Pure unread/changed rules shared by Home's bot dots, BotMenu, Chats, and Spaces
// (src/features/chat/unread.ts; mirrors desktop/src/unread.ts and desktop/src/chatSections.ts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MAX_MARK_CHATS_READ as HOST_MAX_MARK_CHATS_READ, remoteArgs } from "../link-host/methods.mjs";
import {
  allUnreadChats,
  botUnreadChats,
  changedSpaces,
  chatsPageUnreadChats,
  isChatsPageChat,
  isChatsPageUnread,
  isUnreadChat,
  MAX_MARK_CHATS_READ,
  runMarkChatsRead,
  runMarkSpacesRead,
  unreadBotIds,
} from "../src/features/chat/unread";
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

  // Chats page predicate matches desktop's Chats page: lists, counts, and clears unread panel and routine chats; excludes archived.
  const chatsPageUnread = chatsPageUnreadChats(PARITY_CHATS).map((c) => c.id);
  assert.deepEqual(chatsPageUnread, ["c_group", "c_routine", "c_panel", "c_other"]);
  const listed = new Set(PARITY_CHATS.filter(isChatsPageChat).map((c) => c.id));
  for (const id of chatsPageUnread) assert.equal(listed.has(id), true, `Chats page lists ${id}`);
  assert.equal(listed.has("c_archived"), false);
  assert.equal(isChatsPageUnread(PARITY_CHATS[3]), true, "unread panel chat is included on Chats page");
  assert.equal(isChatsPageUnread(PARITY_CHATS[2]), true, "unread routine chat is included on Chats page");
  assert.equal(isChatsPageUnread(PARITY_CHATS[4]), false, "archived chat is excluded on Chats page");
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

test("runMarkChatsRead chunks above MAX_MARK_CHATS_READ, stops on computer switch, skips missing chats, and collects errors", async () => {
  assert.equal(MAX_MARK_CHATS_READ, HOST_MAX_MARK_CHATS_READ);
  const many = Array.from({ length: 2005 }, (_, i) => `c_${i}`);
  const chunks: string[][] = [];
  const chunked = await runMarkChatsRead(many, {
    hasBatch: true,
    markChatsRead: async (ids) => {
      const validated = remoteArgs("markChatsRead", [ids])[0] as string[];
      chunks.push(validated);
    },
    setChatFlags: async () => {
      throw new Error("should not fall back");
    },
  });
  assert.deepEqual(chunked, { ok: true });
  assert.deepEqual(
    chunks.map((c) => c.length),
    [2000, 5],
  );
  assert.deepEqual(chunks.flat(), many);

  // Switching computers between batch chunks stops cleanly.
  let current = true;
  const switchedChunks: number[] = [];
  const switchedBatch = await runMarkChatsRead(many, {
    hasBatch: true,
    isCurrent: () => current,
    markChatsRead: async (ids) => {
      switchedChunks.push(ids.length);
      current = false;
    },
    setChatFlags: async () => {},
  });
  assert.deepEqual(switchedBatch, { ok: true });
  assert.deepEqual(switchedChunks, [2000]);

  // Switching computers mid-fallback stops before sending remaining ids.
  current = true;
  const switchedPerChat: string[] = [];
  const switchedFallback = await runMarkChatsRead(["c1", "c2", "c3"], {
    hasBatch: false,
    isCurrent: () => current,
    markChatsRead: async () => {},
    setChatFlags: async (id) => {
      switchedPerChat.push(id);
      current = false;
    },
  });
  assert.deepEqual(switchedFallback, { ok: true });
  assert.deepEqual(switchedPerChat, ["c1"]);

  // Fallback skips missing-chat errors and collects real errors into one combined Error.
  const attempted: string[] = [];
  const collected = await runMarkChatsRead(["c1", "c_missing", "c2", "c_err1", "c3", "c_err2"], {
    hasBatch: false,
    markChatsRead: async () => {},
    setChatFlags: async (id) => {
      attempted.push(id);
      if (id === "c_missing") throw new Error("This chat no longer exists.");
      if (id === "c_err1") throw new Error("disk full");
      if (id === "c_err2") throw new Error("permission denied");
    },
  });
  assert.deepEqual(attempted, ["c1", "c_missing", "c2", "c_err1", "c3", "c_err2"]);
  assert.equal(collected.ok, false);
  if (!collected.ok) {
    assert.equal(collected.failed, 2);
    assert.match(String(collected.error), /disk full/);
    assert.match(String(collected.error), /permission denied/);
    assert.doesNotMatch(String(collected.error), /no longer exists/);
  }

  // Fallback succeeds cleanly when only missing chats throw.
  const missingOnly = await runMarkChatsRead(["c1", "c_missing", "c2"], {
    hasBatch: false,
    markChatsRead: async () => {},
    setChatFlags: async (id) => {
      if (id === "c_missing") throw new Error("Unknown chat");
    },
  });
  assert.deepEqual(missingOnly, { ok: true });
});

test("runMarkSpacesRead captures visible timestamps and computer before sending so in-flight updates stay unread", async () => {
  const cached: Record<string, number> = { s1: 100, s2: 200 };
  let releaseS2!: () => void;
  const s2Pending = new Promise<void>((resolve) => {
    releaseS2 = resolve;
  });
  const applied: Record<string, number>[] = [];

  const run = runMarkSpacesRead(
    ["s1", "s2"],
    async (id) => {
      if (id === "s2") await s2Pending;
    },
    {
      snapshotUpTo: (id) => cached[id] ?? 0,
      isCurrent: () => true,
      applyMarks: (marks) => applied.push(marks),
    },
  );

  // While s2 is still pending, s1 receives a newer update (updatedAt = 500).
  cached.s1 = 500;
  releaseS2();
  const result = await run;

  assert.deepEqual(result.succeeded, ["s1", "s2"]);
  assert.equal(result.failed, 0);
  assert.deepEqual(applied, [{ s1: 100, s2: 200 }], "must apply only the pre-send timestamps so s1's 500 update stays unread");

  // Switching computers while requests are in flight drops the captured marks and suppresses errors.
  let sameComputer = true;
  const switchedApplied: Record<string, number>[] = [];
  const switched = await runMarkSpacesRead(
    ["s1", "s2"],
    async (id) => {
      sameComputer = false;
      if (id === "s2") throw new Error("link closed");
    },
    {
      snapshotUpTo: (id) => cached[id] ?? 0,
      isCurrent: () => sameComputer,
      applyMarks: (marks) => switchedApplied.push(marks),
    },
  );
  assert.deepEqual(switchedApplied, []);
  assert.deepEqual(switched.succeeded, []);
  assert.equal(switched.failed, 0);
});

test("mobile link-host markChatsRead enforces current bot role even for chat creator", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-mobile-host-unread-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshot = {
    bots: [
      { id: "bot-vis", name: "Pip" },
      { id: "bot-hidden", name: "Ghost" },
    ],
    chats: [
      { id: "c_vis", botId: "bot-vis", title: "Visible", time: 100, unread: true, createdBy: "m_view", messages: [] },
      { id: "c_hidden_own", botId: "bot-hidden", title: "Lost access", time: 200, unread: true, createdBy: "m_view", messages: [] },
    ],
    requests: [],
    runs: [],
  };
  const host = new LinkHost({
    dir,
    backend: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      call: async () => null,
    },
  });
  host.store.data.devices = [{ id: "dev-1", name: "Val's Phone", memberId: "m_view", pub: "x", role: "member" }];
  host.store.data.team = {
    name: "Crew",
    roles: [{ id: "r_viewer", name: "Viewer", perms: { agents: ["view"], today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots: ["bot-vis"] }],
    groups: [{ id: "g_viewers", name: "Viewers", roleId: "r_viewer" }],
    members: [{ id: "m_view", name: "Val", groupId: "g_viewers" }],
    chats: {},
    views: {},
  };

  await host.dispatch({ deviceId: "dev-1" }, { m: "markChatsRead", a: [["c_vis", "c_hidden_own"]] });
  const view = host.store.data.team.views.m_view?.chats ?? {};
  assert.deepEqual(view.c_vis, { seen: 100 });
  assert.equal(view.c_hidden_own, undefined, "creator who lost access to bot is ignored");
});
