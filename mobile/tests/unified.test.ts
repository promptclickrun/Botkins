// Mobile unified multi-host mode: ID scoping, multi-host parts merging,
// RPC routing/fanout, result rescoping, and per-host status aggregation.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Parts } from "../src/link/types";
import {
  buildUnifiedHostsStatus,
  idForHost,
  isScopedId,
  mergeUnifiedParts,
  parseScopedId,
  rescopeMobileResult,
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
