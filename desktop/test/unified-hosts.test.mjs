// Unified multi-host pooling: scoped IDs, state composition, IPC call routing/rescoping,
// remote notification diffing, and RemoteHosts persistence + control-socket API.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  composeUnifiedDesktopState,
  diffRemoteNotifications,
  hostOfId,
  isScopedId,
  LOCAL_HOST_ID,
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
