// Unified multi-host pooling: scoped IDs, state composition, IPC call routing/rescoping,
// remote notification diffing, and RemoteHosts persistence + control-socket API.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  combineMergedDesktopSpaceContent,
  composeUnifiedDesktopState,
  diffRemoteNotifications,
  hostOfId,
  isMergeableBuiltinSpace,
  isMergedBuiltinSpaceId,
  isScopedId,
  LOCAL_HOST_ID,
  mergedBuiltinSpaceId,
  mergeUnifiedDesktopSpaces,
  parseMergedBuiltinSpaceId,
  parseScopedId,
  rescopeResult,
  routeUnifiedCall,
  scopeId,
  unscopeId,
  unscopeValueForHost,
} from "../desktop/unified-hosts.mjs";
import { RemoteHosts } from "../desktop/remotehosts.mjs";
import { hostsApi } from "../desktop/terminal/control-hosts.mjs";

const makeLocalSnap = () => ({
  bots: [{ id: "bot-local", name: "Nova", role: "Coder" }],
  chats: [{ id: "chat-local", botId: "bot-local", title: "Local work", messages: [{ role: "user", text: "hi" }] }],
  streams: { "chat-local": "thinking…" },
  requests: [{ id: "req-local", chatId: "chat-local", kind: "permission", title: "Run tests" }],
  runs: [{ id: "run-local", chatId: "chat-local", status: "Done", time: 200 }],
  projects: [{ id: "proj-local", name: "Botkins" }],
  tasks: [{ id: "task-local", botId: "bot-local", title: "Ship feature" }],
  spaces: [{ id: "sp-local", name: "Today", panels: [] }],
  prefs: { theme: "dark" },
});

const makeRemoteSnap = (suffix) => ({
  bots: [{ id: "bot-" + suffix, name: "Bot " + suffix, role: "Ops" }],
  chats: [{ id: "chat-" + suffix, botId: "bot-" + suffix, title: "Remote " + suffix, messages: [{ role: "assistant", text: "ready" }] }],
  streams: { ["chat-" + suffix]: "running…" },
  requests: [{ id: "req-" + suffix, chatId: "chat-" + suffix, kind: "permission", title: "Deploy " + suffix }],
  runs: [{ id: "run-" + suffix, chatId: "chat-" + suffix, status: "Done", time: 500 }],
  projects: [{ id: "proj-" + suffix, name: "Infra " + suffix }],
  tasks: [{ id: "task-" + suffix, botId: "bot-" + suffix, title: "Restart " + suffix }],
  spaces: [{ id: "sp-" + suffix, name: "Ops " + suffix, panels: [] }],
  prefs: { theme: "light" },
});

test("scopeId and parseScopedId round-trip arbitrary host and entity IDs including tildes", () => {
  const hostId = "srv~prod/east:01";
  const rawId = "chat~abc~123";
  const scoped = scopeId(hostId, rawId);
  assert.equal(isScopedId(scoped), true);
  assert.deepEqual(parseScopedId(scoped), { hostId, rawId });
  assert.equal(unscopeId(scoped), rawId);
  assert.equal(hostOfId(scoped), hostId);
  assert.equal(scopeId(LOCAL_HOST_ID, rawId), rawId);
  assert.equal(isScopedId("plain-id"), false);
  assert.equal(parseScopedId("plain-id"), null);
  assert.equal(hostOfId("plain-id"), LOCAL_HOST_ID);
});

test("unscopeValueForHost strips only the target host prefix across nested structures", () => {
  const aChat = scopeId("host-a", "c1");
  const bChat = scopeId("host-b", "c2");
  const payload = { chatId: aChat, nested: [aChat, bChat, "plain"] };
  assert.deepEqual(unscopeValueForHost(payload, "host-a"), {
    chatId: "c1",
    nested: ["c1", bChat, "plain"],
  });
});

test("composeUnifiedDesktopState merges local and multiple remote hosts while preserving host badges and approvals", () => {
  const composed = composeUnifiedDesktopState(makeLocalSnap(), {
    localName: "Desk Mac",
    remotes: [
      { host: { id: "srv-a", name: "Studio Linux", state: "online" }, snapshot: makeRemoteSnap("a") },
      { host: { id: "srv-b", name: "Cloud Box", state: "online", member: true, team: "Ops" }, snapshot: makeRemoteSnap("b") },
    ],
  });

  assert.equal(composed.bots.length, 3);
  assert.equal(composed.bots[0].id, "bot-local");
  assert.equal(composed.bots[0].hostId, LOCAL_HOST_ID);
  assert.equal(composed.bots[0].hostName, "Desk Mac");

  const botA = composed.bots.find((b) => b.hostId === "srv-a");
  assert.equal(botA.id, scopeId("srv-a", "bot-a"));
  assert.equal(botA.hostName, "Studio Linux");

  // Pending approvals from all hosts appear together with scoped request & chat IDs.
  assert.equal(composed.requests.length, 3);
  const reqB = composed.requests.find((r) => r.hostId === "srv-b");
  assert.equal(reqB.id, scopeId("srv-b", "req-b"));
  assert.equal(reqB.chatId, scopeId("srv-b", "chat-b"));
  assert.equal(reqB.hostName, "Cloud Box");

  // Active streams keep scoped keys for remote chats.
  assert.equal(composed.streams["chat-local"], "thinking…");
  assert.equal(composed.streams[scopeId("srv-a", "chat-a")], "running…");
});

test("routeUnifiedCall routes scoped IDs, explicit addBot hostId, and settings host cleanly", () => {
  // Local unscoped call stays local.
  assert.deepEqual(routeUnifiedCall("send", ["chat-local", "hello"]), {
    kind: "local",
    args: ["chat-local", "hello"],
  });

  // Remote scoped call routes to that host with unscoped arguments.
  const remoteChat = scopeId("srv-a", "chat-a");
  assert.deepEqual(routeUnifiedCall("send", [remoteChat, "hello"]), {
    kind: "remote",
    hostId: "srv-a",
    name: "send",
    args: ["chat-a", "hello"],
  });

  // Remote approval response routes to the remote host with unscoped request ID.
  const remoteReq = scopeId("srv-b", "req-b");
  assert.deepEqual(routeUnifiedCall("respond", [remoteReq, { action: "approve" }]), {
    kind: "remote",
    hostId: "srv-b",
    name: "respond",
    args: ["req-b", { action: "approve" }],
  });

  // Explicit hostId on addBot targets that host and strips hostId from payload.
  const addRoute = routeUnifiedCall("addBot", [{ name: "Gordie", role: "Ops", hostId: "srv-a" }]);
  assert.equal(addRoute.kind, "remote");
  assert.equal(addRoute.hostId, "srv-a");
  assert.equal(addRoute.args[0].name, "Gordie");
  assert.equal("hostId" in addRoute.args[0], false);

  // Multi-host batch calls fan out cleanly by owning host.
  const batch = routeUnifiedCall("markChatsRead", [["chat-local", remoteChat]]);
  assert.equal(batch.kind, "fanout");
  assert.deepEqual(batch.calls, [
    { hostId: LOCAL_HOST_ID, name: "markChatsRead", args: [["chat-local"]] },
    { hostId: "srv-a", name: "markChatsRead", args: [["chat-a"]] },
  ]);

  // Settings-scoped RPC uses settingsHost when no scoped ID is present.
  const settingsRoute = routeUnifiedCall("providers", [], { settingsHost: "srv-a" });
  assert.equal(settingsRoute.kind, "remote");
  assert.equal(settingsRoute.hostId, "srv-a");

  // Returned string IDs are rescoped back to the remote host.
  assert.equal(rescopeResult("addBot", "srv-a", "bot-new"), scopeId("srv-a", "bot-new"));
  assert.equal(rescopeResult("mainChat", "srv-a", "chat-9"), scopeId("srv-a", "chat-9"));
  assert.equal(rescopeResult("addBot", LOCAL_HOST_ID, "bot-new"), "bot-new");
});

test("diffRemoteNotifications emits new approval requests and finished runs without duplicating seen ones", () => {
  const prev = {
    live: { requests: [{ id: "r1", chatId: "c1", botId: "b1", kind: "permission", title: "Old" }] },
    runs: [{ id: "run1", chatId: "c1", botId: "b1", status: "Done", time: 100 }],
  };
  const next = {
    bots: [{ id: "b1", name: "Ops Bot" }],
    chats: [{ id: "c1", botId: "b1", title: "Deploy" }],
    live: {
      requests: [
        { id: "r1", chatId: "c1", botId: "b1", kind: "permission", title: "Old" },
        { id: "r2", chatId: "c1", botId: "b1", kind: "permission", title: "Restart nginx" },
      ],
    },
    runs: [
      { id: "run2", chatId: "c1", botId: "b1", status: "Done", title: "Finished deploy", time: 200 },
      { id: "run1", chatId: "c1", botId: "b1", status: "Done", time: 100 },
    ],
  };

  const events = diffRemoteNotifications(prev, next, { hostId: "srv-a", hostName: "Studio Linux" });
  assert.equal(events.length, 2);
  const approval = events.find((e) => e.type === "request");
  assert.ok(approval);
  assert.equal(approval.request.id, scopeId("srv-a", "r2"));
  assert.equal(approval.request.chatId, scopeId("srv-a", "c1"));
  assert.equal(approval.hostName, "Studio Linux");
  assert.equal(approval.request.title, "Restart nginx");

  const done = events.find((e) => e.type === "turn");
  assert.ok(done);
  assert.equal(done.run.id, scopeId("srv-a", "run2"));
  assert.equal(done.chat.id, scopeId("srv-a", "c1"));
  assert.equal(done.hostName, "Studio Linux");
});

test("RemoteHosts persists unified mode & per-host inclusion and exposes hostsApi control methods", () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-unified-test-"));
  const file = join(dir, "remote-hosts.json");
  const noopClient = class {
    constructor() {}
    start() {}
    stop() {}
    wake() {}
    watch() {}
  };
  const protect = { wrap: (v) => v, unwrap: (v) => v };
  try {
    const rh = new RemoteHosts({
      file,
      protect,
      lib: { LinkClient: noopClient },
      fetch: async () => new Response("{}"),
      changed: () => {},
    });
    rh.hosts = [
      { id: "srv-a", name: "Studio Mac", addedAt: 1, pairing: { serverId: "srv-a", serverKey: "k", deviceId: "d", secretKey: "s", hosts: [] } },
      { id: "srv-b", name: "Home Linux", addedAt: 2, pairing: { serverId: "srv-b", serverKey: "k2", deviceId: "d2", secretKey: "s2", hosts: [] } },
    ];
    rh.save();

    const api = hostsApi({ remote: rh, runtime: { link: { status: () => ({ name: "Laptop" }) } } });
    assert.equal(api["hosts.status"]().unified, false);

    // Enable unified mode.
    const on = api["hosts.unified"]([true]);
    assert.equal(on.unified, true);
    assert.equal(on.unifiedEnabled, true);
    assert.equal(rh.includedHosts().length, 2);

    // Exclude one host by name.
    const excl = api["hosts.include"](["Home Linux", false]);
    assert.equal(excl.hosts.find((h) => h.id === "srv-b").included, false);
    assert.equal(rh.includedHosts().length, 1);

    // Reload from disk and resume: confirm unified + excluded persisted.
    const rh2 = new RemoteHosts({
      file,
      protect,
      lib: { LinkClient: noopClient },
      fetch: async () => new Response("{}"),
      changed: () => {},
    });
    rh2.resume();
    assert.equal(rh2.unifiedEnabled(), true);
    assert.equal(rh2.isUnified(), true);
    assert.deepEqual(rh2.includedHosts().map((h) => h.id), ["srv-a"]);

    // Focus local turns unified off.
    const api2 = hostsApi({ remote: rh2, runtime: { link: { status: () => ({ name: "Laptop" }) } } });
    const focused = api2["hosts.focus"](["local"]);
    assert.equal(focused.unified, false);
    assert.equal(focused.unifiedEnabled, false);
    assert.equal(focused.using, null);

    rh.stopAll();
    rh2.stopAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unified desktop routes channel* and chat.cardAction to the owning host, keeps secrets scoped, and rescopes results", () => {
  const remoteConn = scopeId("srv-a", "ch-slack-1");
  const remoteBot = scopeId("srv-a", "bot-ops");
  const otherBot = scopeId("srv-b", "bot-other");
  const remoteChat = scopeId("srv-a", "chat-wf-1");

  // 1. composeUnifiedDesktopState scopes remote channels, workflows, workflowRuns, and actionCard references.
  const composed = composeUnifiedDesktopState(
    {
      ...makeLocalSnap(),
      channels: [{ id: "ch-local", kind: "telegram", label: "Local TG", botId: "bot-local", enabled: true }],
      workflows: [{ id: "wf-local", name: "Local WF", nodes: [], edges: [] }],
      workflowRuns: [{ id: "wfr-local", workflowId: "wf-local", startedAt: 100 }],
    },
    {
      localName: "Desk Mac",
      remotes: [
        {
          host: { id: "srv-a", name: "Studio Linux", state: "online" },
          snapshot: {
            ...makeRemoteSnap("a"),
            chats: [
              {
                id: "chat-wf-1",
                botId: "bot-ops",
                title: "Triage",
                messages: [
                  {
                    role: "assistant",
                    text: "Review PR",
                    actionCard: {
                      id: "card-1",
                      title: "PR #99",
                      needsYou: true,
                      state: "dispatched",
                      dispatchedChatId: "chat-child",
                      dispatchedBotId: "bot-ops",
                      dispatch: { botId: "bot-ops", prompt: "Review it" },
                    },
                  },
                ],
              },
            ],
            channels: [
              {
                id: "ch-slack-1",
                kind: "slack",
                label: "Eng Slack",
                botId: "bot-ops",
                enabled: true,
                policy: { dm: "pairing", notifyPhone: true },
                pendingPairings: [{ connectionId: "ch-slack-1", code: "ABCD-1234", senderId: "U1" }],
              },
            ],
            workflows: [
              {
                id: "wf-a",
                name: "CI Watch",
                nodes: [{ id: "n1", kind: "agent", config: { botId: "bot-ops", chatId: "chat-wf-1" } }],
                edges: [],
              },
            ],
            workflowRuns: [{ id: "wfr-a", workflowId: "wf-a", startedAt: 500 }],
          },
        },
      ],
    },
  );

  assert.equal(composed.channels.length, 2);
  const scopedCh = composed.channels.find((c) => c.id === remoteConn);
  assert.ok(scopedCh);
  assert.equal(scopedCh.botId, remoteBot);
  assert.equal(scopedCh.hostId, "srv-a");
  assert.equal(scopedCh.hostName, "Studio Linux");
  assert.equal(scopedCh.policy.notifyPhone, true);
  assert.equal(scopedCh.pendingPairings[0].connectionId, remoteConn);

  const wfChat = composed.chats.find((c) => c.id === remoteChat);
  assert.equal(wfChat.messages[0].actionCard.dispatchedChatId, scopeId("srv-a", "chat-child"));
  assert.equal(wfChat.messages[0].actionCard.dispatchedBotId, remoteBot);
  assert.equal(wfChat.messages[0].actionCard.dispatch.botId, remoteBot);

  assert.equal(composed.workflows.find((w) => w.id === scopeId("srv-a", "wf-a")).nodes[0].config.botId, remoteBot);
  assert.equal(composed.workflowRuns[0].id, scopeId("srv-a", "wfr-a"));

  // 2. chat.cardAction routes by scoped chatId and rescopes returned dispatched chatId/botId/card.
  const cardRoute = routeUnifiedCall("chat.cardAction", [remoteChat, "card-1", "dispatch"], { settingsHost: LOCAL_HOST_ID });
  assert.deepEqual(cardRoute, { kind: "remote", hostId: "srv-a", name: "chat.cardAction", args: ["chat-wf-1", "card-1", "dispatch"] });
  const cardRes = rescopeResult(
    "chat.cardAction",
    "srv-a",
    {
      ok: true,
      state: "dispatched",
      chatId: "chat-child",
      botId: "bot-ops",
      card: { id: "card-1", state: "dispatched", dispatchedChatId: "chat-child", dispatchedBotId: "bot-ops", dispatch: { botId: "bot-ops", prompt: "go" } },
    },
  );
  assert.equal(cardRes.chatId, scopeId("srv-a", "chat-child"));
  assert.equal(cardRes.botId, remoteBot);
  assert.equal(cardRes.card.dispatchedChatId, scopeId("srv-a", "chat-child"));
  assert.equal(cardRes.card.dispatchedBotId, remoteBot);
  assert.equal(cardRes.card.dispatch.botId, remoteBot);

  // 3. channelAdd sends secrets ONLY to the owning host (derived from botId or settingsHost), never fans out.
  const addSecret = { botToken: "xoxb-SUPER-SECRET-TOKEN", appToken: "xapp-SUPER-SECRET" };
  const addRoute = routeUnifiedCall("channelAdd", [{ kind: "slack", label: "Ops", botId: remoteBot, secrets: addSecret }], { settingsHost: LOCAL_HOST_ID });
  assert.equal(addRoute.kind, "remote");
  assert.equal(addRoute.hostId, "srv-a");
  assert.deepEqual(addRoute.args, [{ kind: "slack", label: "Ops", botId: "bot-ops", secrets: addSecret }]);

  // channelUpdate routes only to the connection's owning host with unscoped id.
  const updateRoute = routeUnifiedCall("channelUpdate", [remoteConn, { secrets: { botToken: "xoxb-NEW" } }], { settingsHost: LOCAL_HOST_ID });
  assert.deepEqual(updateRoute, { kind: "remote", hostId: "srv-a", name: "channelUpdate", args: ["ch-slack-1", { secrets: { botToken: "xoxb-NEW" } }] });

  // Cross-host channel binding is rejected before dispatch so secrets and bindings cannot leak across hosts.
  assert.throws(() => routeUnifiedCall("channelBind", [remoteConn, otherBot]), /same computer/);
  assert.throws(() => routeUnifiedCall("channelUpdate", [remoteConn, { botId: otherBot }]), /same computer/);
  assert.throws(() => routeUnifiedCall("channelAdd", [{ kind: "slack", hostId: "srv-a", botId: otherBot }]), /same computer/);

  // Same-host channel* RPCs route to srv-a with unscoped IDs.
  assert.deepEqual(routeUnifiedCall("channelBind", [remoteConn, remoteBot]), { kind: "remote", hostId: "srv-a", name: "channelBind", args: ["ch-slack-1", "bot-ops"] });
  assert.deepEqual(routeUnifiedCall("channelSetPolicy", [remoteConn, { notifyPhone: true }]), { kind: "remote", hostId: "srv-a", name: "channelSetPolicy", args: ["ch-slack-1", { notifyPhone: true }] });
  assert.deepEqual(routeUnifiedCall("channelPause", [remoteConn]), { kind: "remote", hostId: "srv-a", name: "channelPause", args: ["ch-slack-1"] });
  assert.deepEqual(routeUnifiedCall("channelResume", [remoteConn]), { kind: "remote", hostId: "srv-a", name: "channelResume", args: ["ch-slack-1"] });
  assert.deepEqual(routeUnifiedCall("channelTest", [remoteConn]), { kind: "remote", hostId: "srv-a", name: "channelTest", args: ["ch-slack-1"] });
  assert.deepEqual(routeUnifiedCall("channelRemove", [remoteConn]), { kind: "remote", hostId: "srv-a", name: "channelRemove", args: ["ch-slack-1"] });
  assert.deepEqual(routeUnifiedCall("channelPairApprove", ["ABCD-1234", remoteConn]), { kind: "remote", hostId: "srv-a", name: "channelPairApprove", args: ["ABCD-1234", "ch-slack-1"] });
  assert.deepEqual(routeUnifiedCall("channelPairDeny", ["ABCD-1234", remoteConn]), { kind: "remote", hostId: "srv-a", name: "channelPairDeny", args: ["ABCD-1234", "ch-slack-1"] });
  assert.deepEqual(routeUnifiedCall("channelLogs", [remoteConn, { limit: 50 }]), { kind: "remote", hostId: "srv-a", name: "channelLogs", args: ["ch-slack-1", { limit: 50 }] });

  // Host-scoped reads without a connection id follow settingsHost (single host, not broadcast).
  assert.deepEqual(routeUnifiedCall("channelsList", [], { settingsHost: "srv-a" }), { kind: "remote", hostId: "srv-a", name: "channelsList", args: [] });
  assert.deepEqual(routeUnifiedCall("channelLogs", [null, { limit: 50 }], { settingsHost: "srv-a" }), { kind: "remote", hostId: "srv-a", name: "channelLogs", args: [null, { limit: 50 }] });

  // Rescoping channel* results restores scoped IDs.
  const listed = rescopeResult("channelsList", "srv-a", [{ id: "ch-slack-1", botId: "bot-ops", kind: "slack" }]);
  assert.equal(listed[0].id, remoteConn);
  assert.equal(listed[0].botId, remoteBot);
  const logs = rescopeResult("channelLogs", "srv-a", [{ time: 1, connectionId: "ch-slack-1", kind: "slack", decision: "replied", turnId: "t-1" }]);
  assert.equal(logs[0].connectionId, remoteConn);
  assert.equal(logs[0].turnId, scopeId("srv-a", "t-1"));
});

const mkSpace = (overrides = {}) => ({
  id: "sp-1",
  name: "Today",
  by: { id: "owner", name: "Colt" },
  mine: true,
  access: "private",
  can: "own",
  count: 1,
  changed: 0,
  pinned: true,
  notify: "off",
  here: [],
  rev: 1,
  updatedAt: 100,
  ...overrides,
});

test("unified desktop merges builtin+mine spaces across hosts and keeps custom & others' built-ins separate", () => {
  const localSnap = {
    ...makeLocalSnap(),
    spaces: [
      mkSpace({ id: "sp-today-local", name: "Today", builtin: "today", mine: true, count: 2, changed: 1, rev: 3, updatedAt: 500 }),
      mkSpace({ id: "sp-feed-local", name: "Feed", builtin: "feed", mine: true, count: 3, changed: 2, rev: 4, updatedAt: 600 }),
      mkSpace({ id: "sp-ideas-local", name: "Ideas", builtin: "ideas", mine: true, count: 1, rev: 2, updatedAt: 400 }),
      mkSpace({ id: "sp-goals-local", name: "Goals", builtin: "goals", mine: true, count: 2, rev: 1, updatedAt: 300 }),
      // Custom space named "Today" (no builtin): never merged by name.
      mkSpace({ id: "sp-custom-today-local", name: "Today", builtin: undefined, mine: true, count: 1, rev: 1, updatedAt: 200 }),
      // Member's built-in space (mine: false): stays separate.
      mkSpace({ id: "sp-maya-today", name: "Today", builtin: "today", mine: false, by: { id: "m1", name: "Maya" }, can: "view", count: 2, rev: 1, updatedAt: 250 }),
    ],
  };

  const remoteSnap = {
    ...makeRemoteSnap("a"),
    spaces: [
      mkSpace({ id: "sp-today-a", name: "Today", builtin: "today", mine: true, count: 4, changed: 3, rev: 6, updatedAt: 900 }),
      mkSpace({ id: "sp-feed-a", name: "Feed", builtin: "feed", mine: true, count: 1, changed: 1, rev: 2, updatedAt: 700 }),
      mkSpace({ id: "sp-ideas-a", name: "Ideas", builtin: "ideas", mine: true, count: 2, rev: 3, updatedAt: 750 }),
      mkSpace({ id: "sp-goals-a", name: "Goals", builtin: "goals", mine: true, count: 1, rev: 2, updatedAt: 650 }),
      mkSpace({ id: "sp-custom-today-a", name: "Today", builtin: undefined, mine: true, count: 2, rev: 1, updatedAt: 310 }),
      mkSpace({ id: "sp-dev-today", name: "Today", builtin: "today", mine: false, by: { id: "m2", name: "Dev" }, can: "view", count: 1, rev: 1, updatedAt: 260 }),
    ],
  };

  assert.equal(isMergeableBuiltinSpace(mkSpace({ builtin: "today", mine: true })), true);
  assert.equal(isMergeableBuiltinSpace(mkSpace({ builtin: "today", mine: false })), false);
  assert.equal(isMergeableBuiltinSpace(mkSpace({ name: "Today", builtin: undefined, mine: true })), false);

  const composed = composeUnifiedDesktopState(localSnap, {
    localName: "Desk Mac",
    remotes: [{ host: { id: "srv-a", name: "Studio Linux", state: "online" }, snapshot: remoteSnap }],
  });

  // 4 merged built-ins + 2 custom "Today" spaces + 2 other-people's built-ins = 8.
  assert.equal(composed.spaces.length, 8);

  const today = composed.spaces.find((s) => s.id === mergedBuiltinSpaceId("today"));
  assert.ok(today);
  assert.equal(isMergedBuiltinSpaceId(today.id), true);
  assert.equal(parseMergedBuiltinSpaceId(today.id), "today");
  assert.equal(today.count, 6);
  assert.equal(today.changed, 4);
  assert.equal(today.rev, 9);
  assert.equal(today.updatedAt, 900);
  assert.equal(today.merged.offlineCount, 0);
  assert.deepEqual(
    today.merged.sources.map((s) => ({ hostId: s.hostId, rawSpaceId: s.rawSpaceId })),
    [
      { hostId: LOCAL_HOST_ID, rawSpaceId: "sp-today-local" },
      { hostId: "srv-a", rawSpaceId: "sp-today-a" },
    ],
  );

  for (const kind of ["feed", "ideas", "goals"]) {
    const matches = composed.spaces.filter((s) => s.builtin === kind && s.mine);
    assert.equal(matches.length, 1, kind);
    assert.equal(matches[0].id, mergedBuiltinSpaceId(kind));
    assert.equal(matches[0].merged.sources.length, 2);
  }

  // Custom spaces named "Today" stay separate.
  const customTodays = composed.spaces.filter((s) => !s.builtin && s.name === "Today");
  assert.equal(customTodays.length, 2);
  assert.deepEqual(customTodays.map((s) => s.id), ["sp-custom-today-local", scopeId("srv-a", "sp-custom-today-a")]);

  // Other people's built-ins stay separate per host.
  const others = composed.spaces.filter((s) => s.builtin === "today" && !s.mine);
  assert.equal(others.length, 2);
  assert.deepEqual(others.map((s) => s.id), ["sp-maya-today", scopeId("srv-a", "sp-dev-today")]);
});

test("unified desktop spaces.read combine interleaves cards newest-first, routes item actions to owning host, and handles offline hosts", () => {
  const remoteRead = rescopeResult("spaces.read", "srv-a", {
    id: "sp-feed-a",
    rev: 2,
    seenAt: 150,
    seenItems: { "card-a1": 150 },
    panels: [{ id: "pan-a1", botId: "bot-a", title: "Remote Panel", blocks: [], hidden: false, size: "small", updatedAt: 400 }],
    cards: [
      { id: "card-a1", botId: "bot-a", kind: "feed", title: "Newest remote", body: "", status: "open", read: false, createdAt: 900, updatedAt: 900 },
      { id: "card-a2", botId: "bot-a", kind: "feed", title: "Oldest remote", body: "", status: "open", read: false, createdAt: 100, updatedAt: 100 },
    ],
  });
  const localRead = {
    id: "sp-feed-local",
    rev: 4,
    seenAt: 200,
    seenItems: { "card-local": 200 },
    panels: [{ id: "pan-local", botId: "bot-local", title: "Local Panel", blocks: [], hidden: false, size: "small", updatedAt: 300 }],
    cards: [
      { id: "card-local", botId: "bot-local", kind: "feed", title: "Middle local", body: "", status: "open", read: false, createdAt: 500, updatedAt: 500 },
    ],
  };

  const combined = combineMergedDesktopSpaceContent(
    mergedBuiltinSpaceId("feed"),
    6,
    [
      { hostId: LOCAL_HOST_ID, hostName: "Desk Mac", content: localRead },
      { hostId: "srv-a", hostName: "Studio Linux", content: remoteRead },
    ],
    0,
  );

  assert.equal(combined.contributingHosts, 2);
  assert.equal(combined.offlineCount, 0);
  assert.deepEqual(
    combined.panels.map((p) => ({ id: p.id, hostId: p.hostId, hostName: p.hostName })),
    [
      { id: "pan-local", hostId: LOCAL_HOST_ID, hostName: "Desk Mac" },
      { id: scopeId("srv-a", "pan-a1"), hostId: "srv-a", hostName: "Studio Linux" },
    ],
  );
  assert.deepEqual(
    combined.cards.map((c) => ({ id: c.id, createdAt: c.createdAt, hostId: c.hostId, hostName: c.hostName })),
    [
      { id: scopeId("srv-a", "card-a1"), createdAt: 900, hostId: "srv-a", hostName: "Studio Linux" },
      { id: "card-local", createdAt: 500, hostId: LOCAL_HOST_ID, hostName: "Desk Mac" },
      { id: scopeId("srv-a", "card-a2"), createdAt: 100, hostId: "srv-a", hostName: "Studio Linux" },
    ],
  );

  // Actions on merged cards & panels route to each item's source host.
  const remoteCardId = combined.cards[0].id;
  const localCardId = combined.cards[1].id;
  const remotePanelId = combined.panels[1].id;

  assert.deepEqual(routeUnifiedCall("boardAct", [remoteCardId, "done"]), {
    kind: "remote",
    hostId: "srv-a",
    name: "boardAct",
    args: ["card-a1", "done"],
  });
  assert.deepEqual(routeUnifiedCall("boardAct", [localCardId, "clear"]), {
    kind: "local",
    args: ["card-local", "clear"],
  });
  assert.deepEqual(routeUnifiedCall("spaces.patchState", [remotePanelId, { checked: true }, "Checked"]), {
    kind: "remote",
    hostId: "srv-a",
    name: "spaces.patchState",
    args: ["pan-a1", { checked: true }, "Checked"],
  });
  assert.deepEqual(routeUnifiedCall("changePanel", [remotePanelId, "delete"]), {
    kind: "remote",
    hostId: "srv-a",
    name: "changePanel",
    args: ["pan-a1", "delete"],
  });

  // Offline remote drops out of merged space cleanly without blanking it.
  const withOffline = mergeUnifiedDesktopSpaces(
    [
      { hostId: LOCAL_HOST_ID, hostName: "Desk Mac", online: true, spaces: [mkSpace({ id: "sp-today-local", builtin: "today", mine: true, count: 2, rev: 3 })] },
      { hostId: "srv-a", hostName: "Studio Linux", online: false, spaces: [mkSpace({ id: scopeId("srv-a", "sp-today-a"), builtin: "today", mine: true, count: 5, rev: 8 })] },
    ],
    { primaryHostId: LOCAL_HOST_ID },
  );
  assert.equal(withOffline.length, 1);
  assert.equal(withOffline[0].id, mergedBuiltinSpaceId("today"));
  assert.equal(withOffline[0].merged.sources.length, 1);
  assert.equal(withOffline[0].merged.sources[0].hostId, LOCAL_HOST_ID);
  assert.equal(withOffline[0].merged.offlineCount, 1);
  assert.equal(withOffline[0].count, 2);

  // Partial read failure during fan-out keeps the online host's content and records offlineCount.
  const partial = combineMergedDesktopSpaceContent(
    mergedBuiltinSpaceId("today"),
    3,
    [
      { hostId: LOCAL_HOST_ID, hostName: "Desk Mac", content: localRead },
      { hostId: "srv-a", hostName: "Studio Linux", failed: true },
    ],
    0,
  );
  assert.equal(partial.panels.length, 1);
  assert.equal(partial.panels[0].title, "Local Panel");
  assert.equal(partial.contributingHosts, 1);
  assert.equal(partial.offlineCount, 1);
});
