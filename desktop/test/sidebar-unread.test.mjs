// Sidebar & Chats-page unread behavior: unified predicates, desktop/phone parity fixture,
// batched workspace mark-read (one save/notify), and view-only team member permissions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "./starter.mjs";
import { chatGroups, chatsPageUnreadChats, isChatsPageUnread } from "../src/chatSections.ts";
import { allUnreadChats, botUnreadChats, changedSpaces, isUnreadChat, unreadBotIds } from "../src/unread.ts";
import { LinkHost, REMOTE_METHODS } from "../desktop/link/index.mjs";
import { remoteArgs } from "../desktop/link/methods.mjs";
import { authorize, TEAM_METHODS } from "../desktop/link/team.mjs";
import { RemoteHosts } from "../desktop/remotehosts.mjs";

// Shared parity fixture (mirrored verbatim in mobile/tests/unread.test.ts) so desktop and phone
// never drift on group, routine, panel, or archived chats.
const PARITY_CHATS = [
  { id: "c_latest_read", botId: "pip", title: "Latest", time: 5000, unread: false },
  { id: "c_group", botId: "pip", botIds: ["pip", "milo"], title: "Group", time: 4000, unread: true },
  { id: "c_routine", botId: "pip", title: "Daily routine", time: 3000, unread: true, schedules: [{ id: "s1", routine: true }] },
  { id: "c_panel", botId: "pip", title: "Panel", time: 2000, unread: true, panelId: "p_1" },
  { id: "c_archived", botId: "pip", title: "Archived", time: 1000, unread: true, archived: true },
  { id: "c_other", botId: "milo", title: "Milo", time: 1500, unread: true },
];

test("shared parity fixture: group chats light Pip's dot; routine, panel, and archived chats stay excluded", () => {
  assert.deepEqual([...unreadBotIds(PARITY_CHATS)].sort(), ["milo", "pip"]);
  assert.deepEqual(
    botUnreadChats(PARITY_CHATS, "pip").map((c) => c.id),
    ["c_group"],
  );
  assert.deepEqual(
    allUnreadChats(PARITY_CHATS).map((c) => c.id),
    ["c_group", "c_other"],
  );

  // Marking only the newest 1:1 chat read leaves Pip's dot lit; marking botUnreadChats clears it.
  const onlyOpenedCleared = PARITY_CHATS.map((c) => (c.id === "c_latest_read" ? { ...c, unread: false } : c));
  assert.equal(unreadBotIds(onlyOpenedCleared).has("pip"), true);

  const toMark = new Set(botUnreadChats(PARITY_CHATS, "pip").map((c) => c.id));
  const afterBotClear = PARITY_CHATS.map((c) => (toMark.has(c.id) ? { ...c, unread: false } : c));
  assert.equal(unreadBotIds(afterBotClear).has("pip"), false);
  assert.equal(unreadBotIds(afterBotClear).has("milo"), true, "other bots stay untouched");

  // Chats page predicate matches across desktop and phone: includes unread panel chats, excludes routine and archived chats.
  const chatsPageUnread = chatsPageUnreadChats(PARITY_CHATS).map((c) => c.id);
  assert.deepEqual(chatsPageUnread, ["c_group", "c_panel", "c_other"]);
  const listedAll = new Set(chatGroups({ chats: PARITY_CHATS, filter: "All", today: 0 }).flatMap((g) => g.chats.map((c) => c.id)));
  const listedUnread = chatGroups({ chats: PARITY_CHATS, filter: "Unread", today: 0 }).flatMap((g) => g.chats.map((c) => c.id));
  assert.deepEqual(listedUnread, chatsPageUnread);
  for (const id of chatsPageUnread) assert.equal(listedAll.has(id), true, `Chats page lists ${id}`);
  assert.equal(listedAll.has("c_routine"), false, "routine chat is hidden by default");
  assert.equal(listedAll.has("c_archived"), false);
});

test("archived, panel, and routine chats never count as unread in the side menu", () => {
  assert.equal(isUnreadChat({ unread: true }), true);
  assert.equal(isUnreadChat({ unread: false }), false);
  assert.equal(isUnreadChat({ unread: true, archived: true }), false);
  assert.equal(isUnreadChat({ unread: true, panelId: "p_1" }), false);
  assert.equal(isUnreadChat({ unread: true, schedules: [{ id: 1, routine: true }] }), false);
  assert.equal(
    unreadBotIds([
      { botId: "pip", unread: true, archived: true },
      { botId: "pip", unread: true, panelId: "p_1" },
      { botId: "pip", unread: true, schedules: [{ id: 1, routine: true }] },
    ]).size,
    0,
  );
});

test("Chats page unread filter, count, and Mark all as read share one predicate including panel chats", () => {
  const chats = [
    { id: "c_panel", botId: "pip", title: "Panel chat", time: 3000, unread: true, panelId: "p_1", messages: [] },
    { id: "c_archived", botId: "pip", title: "Old chat", time: 2000, unread: true, archived: true, messages: [] },
    { id: "c_read", botId: "pip", title: "Read chat", time: 1000, unread: false, messages: [] },
  ];

  // Side menu keeps excluding panel chats.
  assert.deepEqual(allUnreadChats(chats), []);

  // Chats page Unread filter rows, count, and mark-all list all match the same predicate.
  const listed = chatGroups({ chats, filter: "Unread", today: 0 }).flatMap((g) => g.chats.map((c) => c.id));
  const counted = chatsPageUnreadChats(chats).map((c) => c.id);
  assert.deepEqual(listed, ["c_panel"]);
  assert.deepEqual(counted, listed);
  assert.equal(isChatsPageUnread(chats[0]), true);
  assert.equal(isChatsPageUnread(chats[1]), false);
  assert.equal(isChatsPageUnread(chats[2]), false);

  // After marking chatsPageUnreadChats read, no rows remain in the Unread filter.
  const toClear = new Set(counted);
  const after = chats.map((c) => (toClear.has(c.id) ? { ...c, unread: false } : c));
  assert.deepEqual(chatGroups({ chats: after, filter: "Unread", today: 0 }), []);
  assert.deepEqual(chatsPageUnreadChats(after), []);
});

test("Workspace.agents.markChatsRead clears many chats in one save/notify, ignores unknown ids, and validates input", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-unread-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let notifications = 0;
  const ws = new Workspace(dir, async () => ({}), () => { notifications += 1; });
  const botId = ws.state.bots[0].id;
  const ids = Array.from({ length: 12 }, (_, i) => ws.createChat(botId, `Chat ${i}`));
  for (const id of ids) ws.agents.setChatFlags(id, { unread: true });

  let saves = 0;
  const origSave = ws.save.bind(ws);
  ws.save = () => { saves += 1; return origSave(); };
  notifications = 0;

  ws.agents.markChatsRead([...ids, "missing-chat-id", ids[0]]);
  assert.equal(saves, 1, "marking 12 chats read writes workspace exactly once");
  assert.equal(notifications, 1, "marking 12 chats read notifies listeners exactly once");
  assert.equal(unreadBotIds(ws.state.chats).has(botId), false);

  // Calling again when already read is a no-op (no save, no notify).
  ws.agents.markChatsRead(ids);
  assert.equal(saves, 1);
  assert.equal(notifications, 1);

  // Invalid inputs are refused.
  assert.throws(() => ws.agents.markChatsRead("not-an-array"));
  assert.throws(() => ws.agents.markChatsRead([""]));
  assert.throws(() => ws.agents.markChatsRead([123]));
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

test("link authorization allows view-only members to mark visible chats read, but not pin, archive, or mark unread", () => {
  assert.equal(REMOTE_METHODS.has("markChatsRead"), true);
  assert.deepEqual(TEAM_METHODS.markChatsRead, ["agents", "view"]);
  assert.deepEqual(remoteArgs("markChatsRead", [["c1", "c2", "c1"]]), [["c1", "c2"]]);
  assert.throws(() => remoteArgs("markChatsRead", ["c1"]));
  assert.throws(() => remoteArgs("markChatsRead", [[""]]));

  const team = {
    roles: [{ id: "r_viewer", name: "Viewer", perms: { agents: ["view"], today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots: ["bot-vis"] }],
    groups: [{ id: "g_viewers", name: "Viewers", roleId: "r_viewer" }],
    members: [{ id: "m_view", name: "Val", groupId: "g_viewers" }],
    chats: { c_invited: ["m_view"] },
  };
  const viewer = { kind: "member", memberId: "m_view", name: "Val", groupId: "g_viewers" };
  const chats = [
    { id: "c_vis", botId: "bot-vis", createdBy: "m_view" },
    { id: "c_invited", botId: "bot-vis" },
    { id: "c_other_member", botId: "bot-vis", createdBy: "m_other" },
    { id: "c_hidden_bot", botId: "bot-hidden", createdBy: "m_view" },
  ];
  const lookups = {
    bot: (id) => [{ id: "bot-vis" }, { id: "bot-hidden" }].find((b) => b.id === id),
    chat: (id) => chats.find((c) => c.id === id),
    request: () => null,
    run: () => null,
  };

  // Marking read is allowed with agents.view on visible chats the member is in.
  assert.equal(authorize(viewer, team, "setChatFlags", ["c_vis", { unread: false }], lookups), "");
  assert.equal(authorize(viewer, team, "setChatFlags", ["c_invited", { unread: false }], lookups), "");
  assert.equal(authorize(viewer, team, "markChatsRead", [["c_vis", "c_invited"]], lookups), "");

  // Marking read on invisible or unjoined chats via setChatFlags is still refused.
  assert.notEqual(authorize(viewer, team, "setChatFlags", ["c_other_member", { unread: false }], lookups), "");
  assert.notEqual(authorize(viewer, team, "setChatFlags", ["c_hidden_bot", { unread: false }], lookups), "");

  // Pin, archive, mark unread, and mixed patches still require agents.chat.
  assert.notEqual(authorize(viewer, team, "setChatFlags", ["c_vis", { pinned: true }], lookups), "");
  assert.notEqual(authorize(viewer, team, "setChatFlags", ["c_vis", { archived: true }], lookups), "");
  assert.notEqual(authorize(viewer, team, "setChatFlags", ["c_vis", { unread: true }], lookups), "");
  assert.notEqual(authorize(viewer, team, "setChatFlags", ["c_vis", { unread: false, pinned: true }], lookups), "");
});

test("LinkHost markChatsRead updates a view-only member's own read marks in one store write and ignores invisible/missing ids", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-link-unread-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshot = {
    bots: [{ id: "bot-vis", name: "Pip" }, { id: "bot-hidden", name: "Ghost" }],
    chats: [
      { id: "c_vis_1", botId: "bot-vis", title: "One", time: 100, unread: true, createdBy: "m_view", messages: [] },
      { id: "c_vis_2", botId: "bot-vis", title: "Two", time: 200, unread: true, messages: [] },
      { id: "c_other", botId: "bot-vis", title: "Other", time: 300, unread: true, createdBy: "m_other", messages: [] },
      { id: "c_hidden", botId: "bot-hidden", title: "Hidden", time: 400, unread: true, createdBy: "m_other", messages: [] },
      { id: "c_hidden_own", botId: "bot-hidden", title: "Lost bot access", time: 450, unread: true, createdBy: "m_view", messages: [] },
    ],
    requests: [],
    runs: [],
  };
  let ownerCalls = 0;
  const host = new LinkHost({
    dir,
    backend: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      call: async (method) => {
        if (method === "markChatsRead" || method === "setChatFlags") ownerCalls += 1;
        return null;
      },
    },
  });
  host.store.data.devices = [{ id: "dev-1", name: "Val's Phone", memberId: "m_view", pub: "x", role: "member" }];
  host.store.data.team = {
    name: "Crew",
    roles: [{ id: "r_viewer", name: "Viewer", perms: { agents: ["view"], today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots: ["bot-vis"] }],
    groups: [{ id: "g_viewers", name: "Viewers", roleId: "r_viewer" }],
    members: [
      { id: "m_view", name: "Val", groupId: "g_viewers" },
      { id: "m_other", name: "Sam", groupId: "g_viewers" },
    ],
    chats: {
      c_vis_2: ["m_view"],
      c_hidden: ["m_view"],
    },
    views: {},
  };
  const session = { deviceId: "dev-1" };
  let teamSaves = 0;
  const origSetTeam = host.setTeam.bind(host);
  host.setTeam = (...a) => { teamSaves += 1; return origSetTeam(...a); };

  await host.dispatch(session, { m: "markChatsRead", a: [["c_vis_1", "c_vis_2", "c_other", "c_hidden", "c_hidden_own", "c_missing"]] });
  assert.equal(teamSaves, 1, "batch member markChatsRead writes team state once");
  assert.equal(ownerCalls, 0, "member read marks stay in memberView and never mutate owner backend");

  const view = host.store.data.team.views.m_view?.chats ?? {};
  assert.deepEqual(view.c_vis_1, { seen: 100 });
  assert.deepEqual(view.c_vis_2, { seen: 200 });
  assert.equal(view.c_other, undefined, "unjoined member chat is ignored");
  assert.equal(view.c_hidden, undefined, "hidden bot chat is ignored");
  assert.equal(view.c_hidden_own, undefined, "creator who lost access to bot is ignored");
  assert.equal(view.c_missing, undefined, "missing chat id is ignored");

  // Re-calling with the same already-read chats does not rewrite team state.
  await host.dispatch(session, { m: "markChatsRead", a: [["c_vis_1", "c_vis_2"]] });
  assert.equal(teamSaves, 1, "idempotent member markChatsRead does not rewrite");

  // View-only member can still mark one visible chat read via setChatFlags, but cannot archive, pin, or mark unread.
  await host.dispatch(session, { m: "setChatFlags", a: ["c_vis_1", { unread: false }] });
  await assert.rejects(() => host.dispatch(session, { m: "setChatFlags", a: ["c_vis_1", { archived: true }] }));
  await assert.rejects(() => host.dispatch(session, { m: "setChatFlags", a: ["c_vis_1", { pinned: true }] }));
  await assert.rejects(() => host.dispatch(session, { m: "setChatFlags", a: ["c_vis_1", { unread: true }] }));
});

test("RemoteHosts markChatsRead fallback binds to the starting computer, skips missing chats, and collects errors", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-remote-unread-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = new RemoteHosts({ file: join(dir, "hosts.json"), protect: null, lib: {} });
  t.after(() => remote.stop());

  const hostA = { id: "h_a", name: "Studio" };
  const hostB = { id: "h_b", name: "Mini" };
  remote.hosts = [hostA, hostB];

  // 1. Switching computers mid-fallback stops without sending remaining ids to the new computer.
  const callsA = [];
  const callsB = [];
  const clientB = { call: async (...args) => { callsB.push(args); return null; } };
  const clientA = {
    call: async (...args) => {
      callsA.push(args);
      remote.current = hostB.id;
      remote.client = clientB;
      return null;
    },
  };
  remote.current = hostA.id;
  remote.client = clientA;
  remote.state = "online";
  remote.parts = { meta: { capabilities: [] } };

  await remote.call("markChatsRead", [["c1", "c2", "c3"]]);
  assert.deepEqual(callsA, [["setChatFlags", "c1", { unread: false }]]);
  assert.deepEqual(callsB, [], "remaining ids must not be sent to newly selected host");

  // 2. Missing chats are skipped while remaining chats proceed; real failures are collected into one error.
  const attempted = [];
  remote.current = hostA.id;
  remote.client = {
    call: async (_method, id) => {
      attempted.push(id);
      if (id === "c_missing_1") throw new Error("Unknown chat");
      if (id === "c_missing_2") throw new Error("That chat is no longer available.");
      if (id === "c_fail_1") throw new Error("disk full");
      if (id === "c_fail_2") throw new Error("permission denied");
      return null;
    },
  };
  await assert.rejects(
    () => remote.call("markChatsRead", [["c1", "c_missing_1", "c2", "c_fail_1", "c_missing_2", "c3", "c_fail_2"]]),
    (err) => /disk full/.test(err.message) && /permission denied/.test(err.message) && !/Unknown chat/.test(err.message),
  );
  assert.deepEqual(attempted, ["c1", "c_missing_1", "c2", "c_fail_1", "c_missing_2", "c3", "c_fail_2"]);

  // 3. When only missing chats fail, fallback succeeds cleanly.
  const onlyMissing = [];
  remote.client = {
    stop() {},
    call: async (_method, id) => {
      onlyMissing.push(id);
      if (id === "c_gone") throw new Error("This chat no longer exists.");
      return null;
    },
  };
  assert.equal(await remote.call("markChatsRead", [["c1", "c_gone", "c2"]]), null);
  assert.deepEqual(onlyMissing, ["c1", "c_gone", "c2"]);
});

test("RemoteHosts markChatsRead chunks above the 2,000-id protocol limit and stops on computer switch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-remote-chunk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = new RemoteHosts({ file: join(dir, "hosts.json"), protect: null, lib: {} });
  t.after(() => remote.stop());

  const hostA = { id: "h_a", name: "Studio" };
  const hostB = { id: "h_b", name: "Mini" };
  remote.hosts = [hostA, hostB];
  remote.current = hostA.id;
  remote.state = "online";
  remote.parts = { meta: { capabilities: ["mark-chats-read-v1"] } };

  const chunks = [];
  remote.client = {
    call: async (method, ids) => {
      assert.equal(method, "markChatsRead");
      // Every chunk must pass the host's own protocol validation.
      const validated = remoteArgs("markChatsRead", [ids])[0];
      chunks.push(validated);
      return null;
    },
  };
  const many = Array.from({ length: 2005 }, (_, i) => `c_${i}`);
  await remote.call("markChatsRead", [many]);
  assert.deepEqual(chunks.map((c) => c.length), [2000, 5]);
  assert.deepEqual(chunks.flat(), many);

  // Switching computers between chunks stops before sending the second chunk to the new host.
  const sentA = [];
  const sentB = [];
  const clientB = { stop() {}, call: async (...args) => { sentB.push(args); return null; } };
  remote.client = {
    stop() {},
    call: async (_method, ids) => {
      sentA.push(ids.length);
      remote.current = hostB.id;
      remote.client = clientB;
      return null;
    },
  };
  await remote.call("markChatsRead", [many]);
  assert.deepEqual(sentA, [2000]);
  assert.deepEqual(sentB, []);
});

test("RemoteHosts markChatsRead fallback skips the host's real reply for a team member's deleted chat but keeps other refusals", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-remote-member-fallback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshot = {
    bots: [
      { id: "bot-vis", name: "Pip" },
      { id: "bot-hidden", name: "Ghost" },
    ],
    chats: [
      { id: "c_vis", botId: "bot-vis", title: "Visible", time: 100, unread: true, createdBy: "m_view", messages: [] },
      { id: "c_other", botId: "bot-vis", title: "Other member", time: 200, unread: true, createdBy: "m_other", messages: [] },
      { id: "c_hidden_own", botId: "bot-hidden", title: "Lost bot access", time: 300, unread: true, createdBy: "m_view", messages: [] },
    ],
    requests: [],
    runs: [],
  };
  const host = new LinkHost({
    dir: join(dir, "host"),
    backend: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      call: async () => null,
    },
  });
  host.store.data.devices = [{ id: "dev-1", name: "Val's Mac", memberId: "m_view", pub: "x", role: "member" }];
  host.store.data.team = {
    name: "Crew",
    roles: [{ id: "r_viewer", name: "Viewer", perms: { agents: ["view"], today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots: ["bot-vis"] }],
    groups: [{ id: "g_viewers", name: "Viewers", roleId: "r_viewer" }],
    members: [
      { id: "m_view", name: "Val", groupId: "g_viewers" },
      { id: "m_other", name: "Sam", groupId: "g_viewers" },
    ],
    chats: {},
    views: {},
  };
  const session = { deviceId: "dev-1" };

  // Confirm the host's real reply for a deleted chat is the shared not-found/not-allowed message.
  await assert.rejects(
    () => host.dispatch(session, { m: "setChatFlags", a: ["c_deleted", { unread: false }] }),
    (err) => err.message === "That chat belongs to the owner or another member.",
  );

  const remote = new RemoteHosts({ file: join(dir, "hosts.json"), protect: null, lib: {} });
  t.after(() => remote.stop());
  remote.hosts = [{ id: "h_a", name: "Studio" }];
  remote.current = "h_a";
  remote.state = "online";
  remote.parts = { meta: { capabilities: [] } };
  remote.client = {
    stop() {},
    call: (method, ...args) => host.dispatch(session, { m: method, a: args }),
  };

  assert.equal(await remote.call("markChatsRead", [["c_vis", "c_deleted", "c_other"]]), null);
  assert.deepEqual(host.store.data.team.views.m_view?.chats, { c_vis: { seen: 100 } });

  // Other real host refusals (such as a bot removed from the member's role) still report as failures.
  await assert.rejects(
    () => remote.call("markChatsRead", [["c_deleted", "c_hidden_own"]]),
    (err) => /bot isn't available to your team role/i.test(err.message),
  );
});
