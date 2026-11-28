// Mobile unified multi-host mode: ID scoping, multi-host parts merging,
// RPC routing/fanout, result rescoping, and per-host status aggregation.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Parts } from "../src/link/types";
import {
  buildUnifiedHostsStatus,
  combineMergedSpaceContent,
  idForHost,
  isMergeableBuiltinSpace,
  isMergedBuiltinSpaceId,
  isScopedId,
  mergedBuiltinSpaceId,
  mergeUnifiedParts,
  mergeUnifiedSpaces,
  offlineComputersNote,
  parseMergedBuiltinSpaceId,
  parseScopedId,
  rescopeMobileResult,
  resolveMergedSpaceTarget,
  routeMobileCall,
  scopeId,
  scopePartsForHost,
  unscopeId,
  unscopeValueForHost,
  type PooledHostSnapshot,
} from "../src/state/unified";

const sampleParts = (tag: string): Parts => ({
  meta: { name: "Host " + tag, version: "1.0.0", capabilities: [] },
  bots: [{ id: "bot-" + tag, name: "Bot " + tag, role: "Helper", instructions: "Help", color: "#555" }],
  chats: [{ id: "chat-" + tag, botId: "bot-" + tag, title: "Chat " + tag, updatedAt: tag === "b" ? 200 : 100, count: 1 }],
  live: {
    active: ["chat-" + tag],
    requests: [{ id: "req-" + tag, chatId: "chat-" + tag, kind: "permission", title: "Allow " + tag }],
  },
  runs: [{ id: "run-" + tag, chatId: "chat-" + tag, status: "Done", title: "Done " + tag, time: tag === "b" ? 500 : 300 }],
  tasks: [{ id: "task-" + tag, botId: "bot-" + tag, title: "Task " + tag, status: "ready", createdAt: 100, updatedAt: 100 }],
  routines: [{ id: "rt-" + tag, botId: "bot-" + tag, name: "Routine " + tag, enabled: true }],
  projects: [{ id: "proj-" + tag, name: "Project " + tag }],
  spaces: [{ id: "sp-" + tag, name: "Space " + tag, panels: [] }],
  providers: [{ id: "prov-" + tag, name: "Provider " + tag, enabled: true, connected: true }],
  unread: { ["chat-" + tag]: tag === "b" ? 3 : 1 },
});

test("mobile scopeId/parseScopedId preserve primary host IDs unscoped and scope secondary hosts reversibly", () => {
  assert.equal(idForHost("host-a", "bot-1", "host-a"), "bot-1");
  const scoped = idForHost("host-b", "bot-1", "host-a");
  assert.equal(isScopedId(scoped), true);
  assert.deepEqual(parseScopedId(scoped), { hostId: "host-b", rawId: "bot-1" });
  assert.equal(unscopeId(scoped), "bot-1");
  assert.equal(scopeId("host~special/1", "id~2"), "rh~host~25~special%2F1~id~2".replace("~25~", "%7E"));
  assert.deepEqual(parseScopedId(scopeId("host~special/1", "id~2")), { hostId: "host~special/1", rawId: "id~2" });
});

test("scopePartsForHost and mergeUnifiedParts combine bots, chats, approvals, and settingsHost cleanly", () => {
  const pairingA = { serverId: "host-a", name: "Desk Mac" } as any;
  const pairingB = { serverId: "host-b", name: "Studio Linux" } as any;
  const scopedA = scopePartsForHost(sampleParts("a"), "host-a", "Desk Mac", "host-a");
  const scopedB = scopePartsForHost(sampleParts("b"), "host-b", "Studio Linux", "host-a");
  const hostA: PooledHostSnapshot = {
    pairing: pairingA,
    link: "online",
    synced: true,
    parts: scopedA as Partial<Parts>,
  };
  const hostB: PooledHostSnapshot = {
    pairing: pairingB,
    link: "online",
    synced: true,
    parts: scopedB as Partial<Parts>,
  };

  // Primary host keeps raw IDs; secondary host gets scoped IDs.
  assert.equal(scopedA.bots?.[0]?.id, "bot-a");
  assert.equal(scopedA.bots?.[0]?.hostId, "host-a");
  assert.equal(scopedA.bots?.[0]?.hostName, "Desk Mac");
  assert.equal(scopedB.bots?.[0]?.id, scopeId("host-b", "bot-b"));
  assert.equal(scopedB.bots?.[0]?.hostId, "host-b");
  assert.equal(scopedB.bots?.[0]?.hostName, "Studio Linux");
  assert.equal(scopedB.live?.requests?.[0]?.id, scopeId("host-b", "req-b"));
  assert.equal(scopedB.live?.requests?.[0]?.chatId, scopeId("host-b", "chat-b"));

  // Merging with settingsHostId = "host-b" sources providers from host-b while merging all bots/approvals.
  const merged = mergeUnifiedParts([hostA, hostB], "host-a", "host-b");
  assert.equal(merged.bots?.length, 2);
  assert.equal(merged.bots?.[0]?.id, "bot-a");
  assert.equal(merged.bots?.[0]?.hostName, "Desk Mac");
  assert.equal(merged.bots?.[1]?.id, scopeId("host-b", "bot-b"));
  assert.equal(merged.bots?.[1]?.hostName, "Studio Linux");

  // Pending approvals from both hosts appear together in live.requests.
  assert.equal(merged.live?.requests?.length, 2);
  assert.equal(merged.live?.requests?.[0]?.hostName, "Desk Mac");
  assert.equal(merged.live?.requests?.[1]?.hostName, "Studio Linux");

  // Active chats combine primary unscoped + secondary scoped IDs.
  assert.deepEqual(merged.live?.active, ["chat-a", scopeId("host-b", "chat-b")]);

  // Settings-scoped parts follow settingsHostId ("host-b").
  assert.equal(merged.providers?.[0]?.id, "prov-b");

  // Host status summaries reflect live bot counts and inclusion state.
  const statuses = buildUnifiedHostsStatus(
    [pairingA, pairingB],
    "host-a",
    [],
    new Map([
      ["host-a", { link: "online", parts: hostA.parts }],
      ["host-b", { link: "online", parts: hostB.parts }],
    ]),
  );
  assert.equal(statuses.length, 2);
  assert.deepEqual(
    statuses.map((s) => ({ id: s.id, bots: s.bots, included: s.included, state: s.state })),
    [
      { id: "host-a", bots: 1, included: true, state: "online" },
      { id: "host-b", bots: 1, included: true, state: "online" },
    ],
  );
});

test("routeMobileCall routes scoped IDs, explicit addBot hostId, settings calls, and fanouts", () => {
  const secondaryChat = scopeId("host-b", "chat-b");
  const secondaryReq = scopeId("host-b", "req-b");
  const ctx = { primaryId: "host-a", settingsHostId: "host-b", poolIds: ["host-a", "host-b"] };

  // Scoped chat send routes to host-b with unscoped chatId.
  const sendRoute = routeMobileCall("send", [secondaryChat, "hello"], ctx);
  assert.deepEqual(sendRoute, { kind: "single", hostId: "host-b", args: ["chat-b", "hello"] });

  // Scoped approval response routes to host-b with unscoped requestId.
  const respRoute = routeMobileCall("respond", [secondaryReq, { action: "approve" }], ctx);
  assert.deepEqual(respRoute, { kind: "single", hostId: "host-b", args: ["req-b", { action: "approve" }] });

  // Explicit hostId on addBot targets host-b and strips hostId from the RPC payload.
  const addRoute = routeMobileCall("addBot", [{ name: "NewBot", role: "Ops", hostId: "host-b" }], ctx);
  assert.equal(addRoute.kind, "single");
  if (addRoute.kind === "single") {
    assert.equal(addRoute.hostId, "host-b");
    assert.equal((addRoute.args[0] as Record<string, unknown>).name, "NewBot");
    assert.equal("hostId" in (addRoute.args[0] as Record<string, unknown>), false);
  }

  // Multi-host markChatsRead fans out cleanly across owning hosts.
  const fanout = routeMobileCall("markChatsRead", [["chat-a", secondaryChat]], ctx);
  assert.deepEqual(fanout, {
    kind: "fanout",
    calls: [
      { hostId: "host-a", args: [["chat-a"]] },
      { hostId: "host-b", args: [["chat-b"]] },
    ],
  });

  // Host-scoped settings RPC uses settingsHostId.
  const settingsRoute = routeMobileCall("setPreferences", [{ theme: "dark" }], ctx);
  assert.deepEqual(settingsRoute, { kind: "single", hostId: "host-b", args: [{ theme: "dark" }] });

  // unscopeValueForHost only strips the targeted host prefix (used for widget snapshots too).
  const mixed = { a: secondaryChat, b: scopeId("host-c", "chat-c"), plain: "chat-a" };
  assert.deepEqual(unscopeValueForHost(mixed, "host-b"), {
    a: "chat-b",
    b: scopeId("host-c", "chat-c"),
    plain: "chat-a",
  });
});

test("rescopeMobileResult rescopes string IDs, string arrays, and nested objects for secondary hosts", () => {
  // Single string ID returners.
  for (const method of ["addBot", "mainChat", "createChat", "createGroupChat", "forkChat", "saveTask", "spaces.create"]) {
    assert.equal(rescopeMobileResult(method, "raw-1", "host-b", "host-a"), scopeId("host-b", "raw-1"), method);
    assert.equal(rescopeMobileResult(method, "raw-1", "host-a", "host-a"), "raw-1", method + " primary");
  }

  // String-array returners.
  assert.deepEqual(rescopeMobileResult("importAgents", ["b1", "b2"], "host-b", "host-a"), [
    scopeId("host-b", "b1"),
    scopeId("host-b", "b2"),
  ]);

  // Object returner with nested IDs (link.messages chat detail).
  const detail = rescopeMobileResult(
    "link.messages",
    { id: "chat-b", messages: [{ id: "m1", role: "assistant", text: "ok", runId: "run-b" }], runs: [{ id: "run-b", chatId: "chat-b", status: "Done", title: "Done", time: 1 }] },
    "host-b",
    "host-a",
  );
  assert.equal(detail.id, scopeId("host-b", "chat-b"));
  assert.equal(detail.messages[0]?.runId, scopeId("host-b", "run-b"));
  assert.equal(detail.runs[0]?.id, scopeId("host-b", "run-b"));
});

test("mobile unified layer routes channel* and chat.cardAction to the owning host, keeps secrets scoped, and rescopes results", () => {
  const ctx = { primaryId: "host-a", settingsHostId: "host-b", poolIds: ["host-a", "host-b", "host-c"] };
  const connB = scopeId("host-b", "ch-discord-1");
  const botB = scopeId("host-b", "bot-b");
  const botC = scopeId("host-c", "bot-c");
  const chatB = scopeId("host-b", "chat-b");

  // 1. scopePartsForHost & mergeUnifiedParts preserve channels, workflows, and actionCards with scoped IDs.
  const scopedA = scopePartsForHost(
    {
      ...sampleParts("a"),
      channels: [{ id: "ch-a", kind: "slack", label: "A Slack", transport: "socket", enabled: true, botId: "bot-a" }],
    },
    "host-a",
    "Desk Mac",
    "host-a",
  );
  const scopedB = scopePartsForHost(
    {
      ...sampleParts("b"),
      channels: [{ id: "ch-discord-1", kind: "discord", label: "B Discord", transport: "gateway", enabled: true, botId: "bot-b", policy: { notifyPhone: true } }],
      "chat:chat-b": {
        id: "chat-b",
        from: 0,
        total: 1,
        messages: [
          {
            role: "assistant",
            text: "Deploy?",
            actionCard: {
              id: "card-9",
              title: "Deploy prod",
              blocks: [],
              needsYou: true,
              state: "dispatched",
              dispatchedChatId: "chat-deploy",
              dispatchedBotId: "bot-b",
              dispatch: { botId: "bot-b", prompt: "deploy" },
            },
          },
        ],
        runs: [],
      },
    },
    "host-b",
    "Studio Linux",
    "host-a",
  );

  const merged = mergeUnifiedParts(
    [
      { pairing: { serverId: "host-a", name: "Desk Mac" } as any, link: "online", synced: true, parts: scopedA as Partial<Parts>, chats: {}, running: {}, texts: {} },
      { pairing: { serverId: "host-b", name: "Studio Linux" } as any, link: "online", synced: true, parts: scopedB as Partial<Parts>, chats: {}, running: {}, texts: {} },
    ],
    "host-a",
    "host-b",
  );
  assert.equal(merged.channels?.length, 2);
  const remoteCh = merged.channels?.find((c) => c.id === connB);
  assert.ok(remoteCh);
  assert.equal(remoteCh.botId, botB);
  assert.equal(remoteCh.policy?.notifyPhone, true);

  const chatDetail = scopedB["chat:" + chatB] as { messages: Array<{ actionCard?: { dispatchedChatId?: string; dispatchedBotId?: string; dispatch?: { botId?: string } } }> };
  assert.equal(chatDetail.messages[0]?.actionCard?.dispatchedChatId, scopeId("host-b", "chat-deploy"));
  assert.equal(chatDetail.messages[0]?.actionCard?.dispatchedBotId, botB);
  assert.equal(chatDetail.messages[0]?.actionCard?.dispatch?.botId, botB);

  // 2. chat.cardAction routes to host-b with unscoped chatId and rescopes returned dispatched IDs.
  const cardRoute = routeMobileCall("chat.cardAction", [chatB, "card-9", "dispatch"], ctx);
  assert.deepEqual(cardRoute, { kind: "single", hostId: "host-b", args: ["chat-b", "card-9", "dispatch"] });
  const cardRes = rescopeMobileResult(
    "chat.cardAction",
    {
      ok: true,
      state: "dispatched",
      chatId: "chat-deploy",
      botId: "bot-b",
      card: {
        id: "card-9",
        title: "Deploy prod",
        blocks: [],
        needsYou: true,
        state: "dispatched",
        dispatchedChatId: "chat-deploy",
        dispatchedBotId: "bot-b",
        dispatch: { botId: "bot-b", prompt: "deploy" },
      },
    },
    "host-b",
    "host-a",
  );
  assert.equal(cardRes.chatId, scopeId("host-b", "chat-deploy"));
  assert.equal(cardRes.botId, botB);
  assert.equal(cardRes.card.dispatchedChatId, scopeId("host-b", "chat-deploy"));
  assert.equal(cardRes.card.dispatchedBotId, botB);
  assert.equal(cardRes.card.dispatch?.botId, botB);

  // 3. channelAdd / channelUpdate route secrets strictly to the single owning host (never fanout).
  const secretPayload = { botToken: "MTIz.SECRET.DISCORD" };
  const addRoute = routeMobileCall("channelAdd", [{ kind: "discord", label: "Ops", botId: botB, secrets: secretPayload }], ctx);
  assert.deepEqual(addRoute, {
    kind: "single",
    hostId: "host-b",
    args: [{ kind: "discord", label: "Ops", botId: "bot-b", secrets: secretPayload }],
  });
  const updateRoute = routeMobileCall("channelUpdate", [connB, { secrets: { botToken: "NEW-SECRET" } }], ctx);
  assert.deepEqual(updateRoute, {
    kind: "single",
    hostId: "host-b",
    args: ["ch-discord-1", { secrets: { botToken: "NEW-SECRET" } }],
  });

  // Cross-host channel binding refuses to mix hosts.
  assert.throws(() => routeMobileCall("channelBind", [connB, botC], ctx), /same computer/);
  assert.throws(() => routeMobileCall("channelUpdate", [connB, { botId: botC }], ctx), /same computer/);
  assert.throws(() => routeMobileCall("channelAdd", [{ kind: "discord", hostId: "host-b", botId: botC }], ctx), /same computer/);

  // Other channel* RPCs route to the owning host with unscoped IDs.
  assert.deepEqual(routeMobileCall("channelBind", [connB, botB], ctx), { kind: "single", hostId: "host-b", args: ["ch-discord-1", "bot-b"] });
  assert.deepEqual(routeMobileCall("channelSetPolicy", [connB, { dm: "allowlist", notifyPhone: false }], ctx), {
    kind: "single",
    hostId: "host-b",
    args: ["ch-discord-1", { dm: "allowlist", notifyPhone: false }],
  });
  assert.deepEqual(routeMobileCall("channelPause", [connB], ctx), { kind: "single", hostId: "host-b", args: ["ch-discord-1"] });
  assert.deepEqual(routeMobileCall("channelResume", [connB], ctx), { kind: "single", hostId: "host-b", args: ["ch-discord-1"] });
  assert.deepEqual(routeMobileCall("channelRemove", [connB], ctx), { kind: "single", hostId: "host-b", args: ["ch-discord-1"] });
  assert.deepEqual(routeMobileCall("channelTest", [connB], ctx), { kind: "single", hostId: "host-b", args: ["ch-discord-1"] });
  assert.deepEqual(routeMobileCall("channelPairApprove", ["PAIR-99", connB], ctx), { kind: "single", hostId: "host-b", args: ["PAIR-99", "ch-discord-1"] });
  assert.deepEqual(routeMobileCall("channelPairDeny", ["PAIR-99", connB], ctx), { kind: "single", hostId: "host-b", args: ["PAIR-99", "ch-discord-1"] });
  assert.deepEqual(routeMobileCall("channelLogs", [connB, { limit: 100 }], ctx), { kind: "single", hostId: "host-b", args: ["ch-discord-1", { limit: 100 }] });
  assert.deepEqual(routeMobileCall("channelsList", [], ctx), { kind: "single", hostId: "host-b", args: [] });

  // Rescoping channel* results preserves scoped connection/bot/turn IDs.
  const resList = rescopeMobileResult(
    "channelsList",
    [{ id: "ch-discord-1", kind: "discord", label: "B Discord", transport: "gateway", enabled: true, botId: "bot-b" }],
    "host-b",
    "host-a",
  );
  assert.equal(resList[0]?.id, connB);
  assert.equal(resList[0]?.botId, botB);
  const resLogs = rescopeMobileResult(
    "channelLogs",
    [{ time: 1, connectionId: "ch-discord-1", kind: "discord", decision: "replied", turnId: "t-42" }],
    "host-b",
    "host-a",
  );
  assert.equal(resLogs[0]?.connectionId, connB);
  assert.equal(resLogs[0]?.turnId, scopeId("host-b", "t-42"));
});

const makeSpace = (overrides: Record<string, unknown> = {}) => ({
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

test("unified built-in spaces: merges builtin+mine spaces across hosts and keeps custom & others' built-ins separate", () => {
  const hostA: PooledHostSnapshot = {
    pairing: { serverId: "host-a", name: "Desk Mac" } as any,
    link: "online",
    synced: true,
    parts: scopePartsForHost(
      {
        meta: { name: "Desk Mac", version: "1.0.0", capabilities: ["spaces-v1"] },
        spaces: [
          makeSpace({ id: "sp-today-a", name: "Today", builtin: "today", mine: true, count: 2, changed: 1, rev: 3, updatedAt: 500 }),
          makeSpace({ id: "sp-feed-a", name: "Feed", builtin: "feed", mine: true, count: 4, changed: 2, rev: 5, updatedAt: 600 }),
          makeSpace({ id: "sp-ideas-a", name: "Ideas", builtin: "ideas", mine: true, count: 1, rev: 2, updatedAt: 400 }),
          makeSpace({ id: "sp-goals-a", name: "Goals", builtin: "goals", mine: true, count: 3, rev: 1, updatedAt: 300 }),
          // Custom space named "Today" (no builtin): must NEVER merge by name.
          makeSpace({ id: "sp-custom-today-a", name: "Today", builtin: undefined, mine: true, count: 1, rev: 1, updatedAt: 200 }),
          // Another person's built-in space (mine: false): must stay separate.
          makeSpace({ id: "sp-maya-today-a", name: "Today", builtin: "today", mine: false, by: { id: "m1", name: "Maya" }, can: "view", count: 2, rev: 1, updatedAt: 250 }),
        ],
      },
      "host-a",
      "Desk Mac",
      "host-a",
    ) as Partial<Parts>,
    chats: {},
    running: {},
    texts: {},
  };

  const hostB: PooledHostSnapshot = {
    pairing: { serverId: "host-b", name: "Studio Linux" } as any,
    link: "online",
    synced: true,
    parts: scopePartsForHost(
      {
        meta: { name: "Studio Linux", version: "1.0.0", capabilities: ["spaces-v1"] },
        spaces: [
          makeSpace({ id: "sp-today-b", name: "Today", builtin: "today", mine: true, count: 3, changed: 2, rev: 7, updatedAt: 900 }),
          makeSpace({ id: "sp-feed-b", name: "Feed", builtin: "feed", mine: true, count: 2, changed: 1, rev: 4, updatedAt: 800 }),
          makeSpace({ id: "sp-ideas-b", name: "Ideas", builtin: "ideas", mine: true, count: 2, rev: 3, updatedAt: 700 }),
          makeSpace({ id: "sp-goals-b", name: "Goals", builtin: "goals", mine: true, count: 1, rev: 2, updatedAt: 650 }),
          // Custom space named "Today" on host B stays its own space too.
          makeSpace({ id: "sp-custom-today-b", name: "Today", builtin: undefined, mine: true, count: 5, rev: 1, updatedAt: 350 }),
          // Another person's built-in on host B stays separate.
          makeSpace({ id: "sp-dev-today-b", name: "Today", builtin: "today", mine: false, by: { id: "m2", name: "Dev" }, can: "view", count: 1, rev: 1, updatedAt: 260 }),
        ],
      },
      "host-b",
      "Studio Linux",
      "host-a",
    ) as Partial<Parts>,
    chats: {},
    running: {},
    texts: {},
  };

  assert.equal(isMergeableBuiltinSpace(makeSpace({ builtin: "today", mine: true }) as any), true);
  assert.equal(isMergeableBuiltinSpace(makeSpace({ builtin: "today", mine: false }) as any), false);
  assert.equal(isMergeableBuiltinSpace(makeSpace({ name: "Today", builtin: undefined, mine: true }) as any), false);

  const merged = mergeUnifiedParts([hostA, hostB], "host-a", "host-a");
  const spaces = merged.spaces ?? [];

  // 4 merged built-ins + 2 custom "Today" spaces + 2 other-people's built-in "Today" spaces = 8.
  assert.equal(spaces.length, 8);

  const today = spaces.find((s) => s.id === mergedBuiltinSpaceId("today"));
  assert.ok(today);
  assert.equal(isMergedBuiltinSpaceId(today.id), true);
  assert.equal(parseMergedBuiltinSpaceId(today.id), "today");
  assert.equal(today.count, 5);
  assert.equal(today.changed, 3);
  assert.equal(today.rev, 10);
  assert.equal(today.updatedAt, 900);
  assert.equal(today.merged?.offlineCount, 0);
  assert.deepEqual(
    today.merged?.sources.map((s) => ({ hostId: s.hostId, rawSpaceId: s.rawSpaceId })),
    [
      { hostId: "host-a", rawSpaceId: "sp-today-a" },
      { hostId: "host-b", rawSpaceId: "sp-today-b" },
    ],
  );

  // Feed/Ideas/Goals are each deduplicated to one virtual space.
  for (const kind of ["feed", "ideas", "goals"] as const) {
    const matches = spaces.filter((s) => s.builtin === kind && s.mine);
    assert.equal(matches.length, 1, kind);
    assert.equal(matches[0]?.id, mergedBuiltinSpaceId(kind));
    assert.equal(matches[0]?.merged?.sources.length, 2);
  }

  // Custom spaces named "Today" were NOT merged by name.
  const customTodays = spaces.filter((s) => !s.builtin && s.name === "Today");
  assert.equal(customTodays.length, 2);
  assert.deepEqual(customTodays.map((s) => s.id), ["sp-custom-today-a", scopeId("host-b", "sp-custom-today-b")]);

  // Other people's built-ins stayed separate per host.
  const othersTodays = spaces.filter((s) => s.builtin === "today" && !s.mine);
  assert.equal(othersTodays.length, 2);
  assert.deepEqual(othersTodays.map((s) => s.id), ["sp-maya-today-a", scopeId("host-b", "sp-dev-today-b")]);
});

test("unified built-in spaces: spaces.read fan-out combines panels, interleaves cards newest-first, and routes actions to source host", () => {
  const ctx = { primaryId: "host-a", settingsHostId: "host-a", poolIds: ["host-a", "host-b"] };

  // Rescope remote host-b spaces.read first (as link.ts does on fan-out).
  const remoteRead = rescopeMobileResult(
    "spaces.read",
    {
      id: "sp-feed-b",
      rev: 4,
      seenAt: 150,
      seenItems: { "card-b1": 150 },
      panels: [{ id: "pan-b1", key: "k-b", botId: "bot-b", title: "Linux Metrics", blocks: [], hidden: false, size: "small", revision: 1, updatedAt: 400, routine: null }],
      cards: [
        { id: "card-b1", botId: "bot-b", kind: "feed", title: "Linux alert", body: "", status: "open", read: false, createdAt: 500, updatedAt: 500 },
        { id: "card-b2", botId: "bot-b", kind: "feed", title: "Old linux note", body: "", status: "open", read: false, createdAt: 100, updatedAt: 100 },
      ],
    },
    "host-b",
    "host-a",
  );

  const primaryRead = {
    id: "sp-feed-a",
    rev: 5,
    seenAt: 200,
    seenItems: { "card-a1": 200 },
    panels: [{ id: "pan-a1", key: "k-a", botId: "bot-a", title: "Mac Metrics", blocks: [], hidden: false, size: "small", revision: 1, updatedAt: 300, routine: null }],
    cards: [
      { id: "card-a1", botId: "bot-a", kind: "feed", title: "Mac digest", body: "", status: "open", read: false, createdAt: 350, updatedAt: 350 },
    ],
  };

  const combined = combineMergedSpaceContent(
    mergedBuiltinSpaceId("feed"),
    9,
    [
      { hostId: "host-a", hostName: "Desk Mac", content: primaryRead as any },
      { hostId: "host-b", hostName: "Studio Linux", content: remoteRead as any },
    ],
    0,
  );

  assert.equal(combined.contributingHosts, 2);
  assert.equal(combined.offlineCount, 0);
  // Panels from both hosts carry hostId & hostName.
  assert.deepEqual(
    combined.panels.map((p) => ({ id: p.id, hostId: p.hostId, hostName: p.hostName })),
    [
      { id: "pan-a1", hostId: "host-a", hostName: "Desk Mac" },
      { id: scopeId("host-b", "pan-b1"), hostId: "host-b", hostName: "Studio Linux" },
    ],
  );
  // Cards are interleaved newest first across hosts, each tagged with its host.
  assert.deepEqual(
    combined.cards.map((c) => ({ id: c.id, createdAt: c.createdAt, hostId: c.hostId, hostName: c.hostName })),
    [
      { id: scopeId("host-b", "card-b1"), createdAt: 500, hostId: "host-b", hostName: "Studio Linux" },
      { id: "card-a1", createdAt: 350, hostId: "host-a", hostName: "Desk Mac" },
      { id: scopeId("host-b", "card-b2"), createdAt: 100, hostId: "host-b", hostName: "Studio Linux" },
    ],
  );

  // Actions on merged items route to each item's own source host via existing host scoping.
  const remoteCardId = combined.cards[0]!.id;
  const primaryCardId = combined.cards[1]!.id;
  const remotePanelId = combined.panels[1]!.id;

  assert.deepEqual(routeMobileCall("boardAct", [remoteCardId, "done"], ctx), {
    kind: "single",
    hostId: "host-b",
    args: ["card-b1", "done"],
  });
  assert.deepEqual(routeMobileCall("boardAct", [primaryCardId, "clear"], ctx), {
    kind: "single",
    hostId: "host-a",
    args: ["card-a1", "clear"],
  });
  assert.deepEqual(routeMobileCall("boardAct", [remoteCardId, "delete"], ctx), {
    kind: "single",
    hostId: "host-b",
    args: ["card-b1", "delete"],
  });
  assert.deepEqual(routeMobileCall("spaces.patchState", [remotePanelId, { ticked: true }, "Ticked"], ctx), {
    kind: "single",
    hostId: "host-b",
    args: ["pan-b1", { ticked: true }, "Ticked"],
  });
  assert.deepEqual(routeMobileCall("changePanel", [remotePanelId, "delete"], ctx), {
    kind: "single",
    hostId: "host-b",
    args: ["pan-b1", "delete"],
  });
});

test("unified built-in spaces: offline host drops out cleanly with quiet note and never blanks the space", () => {
  const hostOnline: PooledHostSnapshot = {
    pairing: { serverId: "host-a", name: "Desk Mac" } as any,
    link: "online",
    synced: true,
    parts: scopePartsForHost(
      {
        meta: { name: "Desk Mac", version: "1.0.0", capabilities: ["spaces-v1"] },
        spaces: [makeSpace({ id: "sp-today-a", name: "Today", builtin: "today", mine: true, count: 2, rev: 3 })],
      },
      "host-a",
      "Desk Mac",
      "host-a",
    ) as Partial<Parts>,
    chats: {},
    running: {},
    texts: {},
  };
  const hostOffline: PooledHostSnapshot = {
    pairing: { serverId: "host-b", name: "Studio Linux" } as any,
    link: "offline",
    synced: true,
    parts: scopePartsForHost(
      {
        meta: { name: "Studio Linux", version: "1.0.0", capabilities: ["spaces-v1"] },
        spaces: [makeSpace({ id: "sp-today-b", name: "Today", builtin: "today", mine: true, count: 4, rev: 9 })],
      },
      "host-b",
      "Studio Linux",
      "host-a",
    ) as Partial<Parts>,
    chats: {},
    running: {},
    texts: {},
  };

  const spaces = mergeUnifiedSpaces([hostOnline, hostOffline], "host-a");
  assert.equal(spaces.length, 1);
  const today = spaces[0]!;
  assert.equal(today.id, mergedBuiltinSpaceId("today"));
  // Only the online host is included in sources; offline host dropped out cleanly.
  assert.equal(today.merged?.sources.length, 1);
  assert.equal(today.merged?.sources[0]?.hostId, "host-a");
  assert.equal(today.merged?.offlineCount, 1);
  assert.equal(today.count, 2);
  assert.equal(offlineComputersNote(today.merged?.offlineCount ?? 0), "1 computer offline");
  assert.equal(offlineComputersNote(2), "2 computers offline");
  assert.equal(offlineComputersNote(0), undefined);

  // Target resolution for panel creation picks the online host.
  assert.deepEqual(resolveMergedSpaceTarget(today, "host-b"), {
    hostId: "host-a",
    spaceId: "sp-today-a",
    rawSpaceId: "sp-today-a",
  });

  // If a second host fails during spaces.read fan-out, the online host's content still renders (never blanks).
  const partial = combineMergedSpaceContent(
    today.id,
    today.rev,
    [
      {
        hostId: "host-a",
        hostName: "Desk Mac",
        content: {
          id: "sp-today-a",
          rev: 3,
          seenAt: 100,
          panels: [{ id: "pan-a1", key: "k", botId: "bot-a", title: "Still Here", blocks: [], hidden: false, size: "small", revision: 1, updatedAt: 100, routine: null }],
          cards: [],
        },
      },
      { hostId: "host-b", hostName: "Studio Linux", failed: true },
    ],
    0,
  );
  assert.equal(partial.panels.length, 1);
  assert.equal(partial.panels[0]?.title, "Still Here");
  assert.equal(partial.contributingHosts, 1);
  assert.equal(partial.offlineCount, 1);
  assert.equal(offlineComputersNote(partial.offlineCount ?? 0), "1 computer offline");
});
