import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIMessageAdapter,
  createNodeChannelBridge,
  IMESSAGE_CAPABILITIES,
  isAutomationPermissionBlock,
  normalizeImsgEvent,
  runImsgSend,
} from "../desktop/channels/adapters/imessage.mjs";
import { ChannelManager } from "../desktop/channels/index.mjs";
import { NodeHost } from "../desktop/node-host.mjs";

function makeFakeVault() {
  const entries = new Map();
  let seq = 0;
  return {
    add({ name, value }) {
      const id = `v-${++seq}`;
      entries.set(id, { id, name, value });
      return { id, name };
    },
    get(id) {
      return entries.get(id) ?? null;
    },
    reveal(id) {
      return entries.get(id)?.value ?? "";
    },
    remove(id) {
      entries.delete(id);
    },
  };
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("close", 0, "SIGTERM");
  };
  return child;
}

function makeFakeWorkspaceForNode(name = "Studio Mac", imessageAdapter = null) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-node-imsg-"));
  const interactions = new EventEmitter();
  const pendingAsks = new Map();
  const ws = {
    dir,
    closing: false,
    nodeAdapters: imessageAdapter ? { imessage: imessageAdapter } : {},
    hostDispatch: { roster: () => [] },
    hostName: () => name,
    projects: { list: () => [] },
    state: { projects: [], bots: [], chats: [] },
    save: () => {},
    notify: () => {},
    interactions: {
      entries: pendingAsks,
      snapshot: () => [],
      request: async (_chat, _task, view) => {
        return new Promise((resolve) => {
          pendingAsks.set(view.id || `ask-${pendingAsks.size + 1}`, { view, resolve });
          interactions.emit("ask", { view, resolve });
        });
      },
      cancel: (id) => {
        const item = pendingAsks.get(id);
        if (item) {
          pendingAsks.delete(id);
          item.resolve({ action: "cancel" });
        }
      },
    },
    _interactions: interactions,
    _pendingAsks: pendingAsks,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return ws;
}

function makePeerIdentity() {
  return {
    profileId: "owner-profile-1",
    serverId: "bot-host-1",
    serverKey: "server-key-pub-1",
    targetId: "node-mac-1",
    targetKey: "target-key-pub-1",
    name: "Cloud Host",
    hostName: "Cloud Host",
    verify: async () => {},
  };
}

describe("iMessage adapter — normalization and local imsg transport", () => {
  it("normalizes DMs, group messages, RPC wrappers, and self messages", () => {
    const dm = normalizeImsgEvent({
      chat_id: 42,
      sender: "user-101",
      sender_name: "Alex",
      text: "Hello from iMessage",
      is_from_me: false,
      date: "2026-04-15T12:00:00Z",
    });
    assert.equal(dm.channel, "imessage");
    assert.equal(dm.conversationId, "42");
    assert.equal(dm.sender.id, "user-101");
    assert.equal(dm.sender.display, "Alex");
    assert.equal(dm.isDirect, true);
    assert.equal(dm.isFromSelf, false);
    assert.equal(dm.text, "Hello from iMessage");

    const group = normalizeImsgEvent(
      {
        method: "message",
        params: {
          chat_id: 99,
          sender: "user-202",
          text: "Hey @helper can you check this?",
          is_group: true,
          is_from_me: false,
        },
      },
      { botAliases: ["helper"] },
    );
    assert.equal(group.isDirect, false);
    assert.equal(group.mentionsBot, true);

    const selfMsg = normalizeImsgEvent({
      chat_id: 42,
      sender: "me",
      text: "Echo",
      is_from_me: true,
    });
    assert.equal(selfMsg.isFromSelf, true);
  });

  it("spawns imsg watch --json without a shell and delivers inbound events", async () => {
    const spawned = [];
    let activeChild = null;
    const adapter = createIMessageAdapter({
      findImsg: () => "/usr/local/bin/imsg",
      spawnProcess: (file, args, opts) => {
        spawned.push({ file, args, opts });
        activeChild = makeFakeChild();
        return activeChild;
      },
      reconnectBaseMs: 20,
      reconnectMaxMs: 60,
    });

    const statuses = [];
    const inbound = [];
    await adapter.start({
      connection: { id: "conn-1", kind: "imessage", transport: "imsg_local" },
      secrets: {},
      onStatus: (s) => statuses.push(s),
      onMessage: (m) => inbound.push(m),
    });

    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].file, "/usr/local/bin/imsg");
    assert.deepEqual(spawned[0].args, ["watch", "--json"]);
    assert.equal(spawned[0].opts.shell, false);
    assert.equal(statuses.at(-1).state, "connected");

    activeChild.stdout.emit(
      "data",
      JSON.stringify({ chat_id: 7, sender: "sender-1", sender_name: "Sam", text: "Ping" }) + "\n",
    );
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].conversationId, "7");
    assert.equal(inbound[0].text, "Ping");

    await adapter.stop();
    assert.equal(activeChild.killed, true);
  });

  it("sends replies using arg-array imsg send --chat-id, handles leading dashes safely, and splits long replies", async () => {
    const calls = [];
    const adapter = createIMessageAdapter({
      findImsg: () => "/opt/homebrew/bin/imsg",
      spawnProcess: () => makeFakeChild(),
      launch: async (file, args) => {
        calls.push({ file, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await adapter.start({
      connection: { id: "conn-2", kind: "imessage", transport: "imsg_local" },
      secrets: {},
      onStatus: () => {},
      onMessage: () => {},
    });

    // Leading dash in text must be joined with --text=... so it can never act as a CLI flag.
    await adapter.send({ conversationId: "42", text: "- first item" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "/opt/homebrew/bin/imsg");
    assert.deepEqual(calls[0].args, ["send", "--chat-id", "42", "--text=- first item"]);

    // Long reply over 4000 chars splits into multiple sends.
    calls.length = 0;
    const longReply = "a".repeat(IMESSAGE_CAPABILITIES.maxLength + 500);
    const res = await adapter.send({ conversationId: "42", text: longReply });
    assert.equal(res.ok, true);
    assert.ok(calls.length >= 2);
    for (const c of calls) {
      const textIdx = c.args.indexOf("--text");
      const sentText = textIdx >= 0 ? c.args[textIdx + 1] : c.args.find((a) => a.startsWith("--text=")).slice(7);
      assert.ok(sentText.length <= IMESSAGE_CAPABILITIES.maxLength);
    }

    await adapter.stop();
  });

  it("reconnects with backoff when imsg watch exits unexpectedly", async () => {
    const children = [];
    const adapter = createIMessageAdapter({
      findImsg: () => "/usr/local/bin/imsg",
      spawnProcess: () => {
        const c = makeFakeChild();
        children.push(c);
        return c;
      },
      reconnectBaseMs: 25,
      reconnectMaxMs: 100,
    });

    const statuses = [];
    await adapter.start({
      connection: { id: "conn-3", kind: "imessage", transport: "imsg_local" },
      secrets: {},
      onStatus: (s) => statuses.push(s),
      onMessage: () => {},
    });
    assert.equal(children.length, 1);

    // Simulate watcher crash
    children[0].emit("close", 1, null);
    assert.equal(statuses.at(-1).state, "reconnecting");

    await new Promise((r) => setTimeout(r, 60));
    assert.ok(children.length >= 2, "expected watcher to respawn after backoff");
    assert.equal(statuses.at(-1).state, "connected");

    await adapter.stop();
  });

  it("reports waiting_permission instead of hanging when local macOS Automation blocks imsg send", async () => {
    const res = await runImsgSend({
      chatId: "42",
      text: "Hello",
      findImsg: () => "/opt/homebrew/bin/imsg",
      launch: async () => ({
        code: 1,
        stdout: "",
        stderr: "execution error: Not authorized to send Apple events to Messages. (-1743)",
        timedOut: false,
      }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.waitingForPermission, true);
    assert.equal(res.detail, "waiting for macOS permission");

    const timedOutRes = await runImsgSend({
      chatId: "42",
      text: "Hello",
      findImsg: () => "/opt/homebrew/bin/imsg",
      launch: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true }),
      nodeLabel: "Studio Mac",
    });
    assert.equal(timedOutRes.ok, false);
    assert.equal(timedOutRes.waitingForPermission, true);
    assert.equal(timedOutRes.detail, "waiting for macOS permission on Studio Mac");
    assert.equal(isAutomationPermissionBlock("(-1743)", false), true);
  });
});

describe("iMessage via Mac node host — capabilities, grants, forwarding, and Automation status", () => {
  it("advertises channel.imessage.watch and channel.imessage.send only when enabled and exec policy allows", () => {
    const ws = makeFakeWorkspaceForNode("Studio Mac", {
      startWatch: () => ({ stop() {} }),
      send: async () => ({ ok: true }),
    });
    try {
      const node = new NodeHost(ws, { enabled: true, name: "Studio Mac", execPolicy: { mode: "allowlist" } });
      const capIds = node.capabilities().operations.map((o) => o.id);
      assert.ok(capIds.includes("channel.imessage.watch"));
      assert.ok(capIds.includes("channel.imessage.send"));

      node.setExecMode("deny");
      const deniedIds = node.capabilities().operations.map((o) => o.id);
      assert.ok(!deniedIds.includes("channel.imessage.watch"));
      assert.ok(!deniedIds.includes("channel.imessage.send"));
      node.close();
    } finally {
      ws.cleanup();
    }
  });

  it("enforces exec policy and node grants on channel.imessage.watch and channel.imessage.send", async () => {
    const sent = [];
    const ws = makeFakeWorkspaceForNode("Studio Mac", {
      startWatch: () => ({ stop() {} }),
      send: async (args) => {
        sent.push(args);
        return { ok: true };
      },
    });
    try {
      const node = new NodeHost(ws, { enabled: true, name: "Studio Mac", execPolicy: { mode: "deny" } });
      const peer = makePeerIdentity();

      const waitDone = async (id) => {
        const deadline = Date.now() + 2000;
        let status = await node.receive(peer, "job.status", { id });
        while ((status.status === "pending" || status.status === "working") && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 15));
          status = await node.receive(peer, "job.status", { id });
        }
        return status;
      };

      // Denied by exec policy
      await assert.rejects(
        () =>
          node.receive(peer, "job.submit", {
            id: "11111111-1111-4111-8111-111111111111",
            sourceBotId: "bot-1",
            sourceBotName: "Helper",
            operation: "channel.imessage.send",
            params: { chatId: "12", text: "Blocked" },
            createdAt: Date.now(),
          }),
        /exec policy denies/i,
      );

      // Enable exec policy -> requires grant/approval; denying refuses execution
      node.setExecMode("allowlist");
      ws._interactions.once("ask", ({ resolve }) => resolve({ action: "deny" }));
      const deniedId = "22222222-2222-4222-8222-222222222222";
      await node.receive(peer, "job.submit", {
        id: deniedId,
        sourceBotId: "bot-1",
        sourceBotName: "Helper",
        operation: "channel.imessage.send",
        params: { chatId: "12", text: "Should not send" },
        createdAt: Date.now(),
      });
      const deniedStatus = await waitDone(deniedId);
      assert.equal(deniedStatus.status, "denied");
      assert.equal(sent.length, 0);

      // Approving ("remember") creates a grant and executes send
      ws._interactions.once("ask", ({ resolve }) => resolve({ action: "remember" }));
      const okId = "33333333-3333-4333-8333-333333333333";
      await node.receive(peer, "job.submit", {
        id: okId,
        sourceBotId: "bot-1",
        sourceBotName: "Helper",
        operation: "channel.imessage.send",
        params: { chatId: "12", text: "Allowed reply" },
        createdAt: Date.now(),
      });
      const okStatus = await waitDone(okId);
      assert.equal(okStatus.status, "completed");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].chatId, "12");
      assert.equal(sent[0].text, "Allowed reply");

      // Second send reuses the remembered grant without prompting again
      let askedAgain = false;
      ws._interactions.once("ask", ({ resolve }) => {
        askedAgain = true;
        resolve({ action: "deny" });
      });
      const secondId = "44444444-4444-4444-8444-444444444444";
      await node.receive(peer, "job.submit", {
        id: secondId,
        sourceBotId: "bot-1",
        sourceBotName: "Helper",
        operation: "channel.imessage.send",
        params: { chatId: "12", text: "Second reply" },
        createdAt: Date.now(),
      });
      const secondStatus = await waitDone(secondId);
      assert.equal(secondStatus.status, "completed");
      assert.equal(askedAgain, false);
      assert.equal(sent.length, 2);

      // Revoking the grant blocks the next call (asks again)
      const grant = node.activeGrants().find((g) => g.operation === "channel.imessage.send");
      assert.ok(grant);
      node.revokeGrant(grant.id);
      ws._interactions.once("ask", ({ resolve }) => resolve({ action: "deny" }));
      const revokedId = "55555555-5555-4555-8555-555555555555";
      await node.receive(peer, "job.submit", {
        id: revokedId,
        sourceBotId: "bot-1",
        sourceBotName: "Helper",
        operation: "channel.imessage.send",
        params: { chatId: "12", text: "After revoke" },
        createdAt: Date.now(),
      });
      const revokedStatus = await waitDone(revokedId);
      assert.equal(revokedStatus.status, "denied");
      assert.equal(sent.length, 2);

      node.close();
    } finally {
      ws.cleanup();
    }
  });

  it("forwards inbound iMessages from a Mac node, sends replies back, and surfaces Automation permission waits", async () => {
    let pushFromMac = null;
    let blockNextSend = false;
    const sentOnMac = [];

    const nodeWs = makeFakeWorkspaceForNode("Studio Mac", {
      startWatch: ({ onEvent }) => {
        pushFromMac = onEvent;
        return { stop() {} };
      },
      send: async ({ chatId, text, nodeName }) => {
        if (blockNextSend) {
          return {
            ok: false,
            waitingForPermission: true,
            detail: `waiting for macOS permission on ${nodeName}`,
          };
        }
        sentOnMac.push({ chatId, text });
        return { ok: true };
      },
    });

    const nodeHost = new NodeHost(nodeWs, {
      enabled: true,
      name: "Studio Mac",
      execPolicy: { mode: "allowlist" },
    });
    // Auto-approve the first-time node grants for this test
    nodeWs._interactions.on("ask", ({ resolve }) => resolve({ action: "remember" }));

    const peer = makePeerIdentity();

    // Minimal bot host workspace wired to the Mac node via teamworkPeers + createNodeChannelBridge
    const events = new EventEmitter();
    const chats = new Map();
    const bot = { id: "bot-1", name: "Helper" };
    let runSeq = 0;
    const botHostWs = {
      events,
      state: { bots: [bot], chats: [], channels: [] },
      save: () => {},
      notify: () => {},
      bot: (id) => (id === "bot-1" ? bot : null),
      chat: (id) => chats.get(id) ?? null,
      createChat: (botId, title) => {
        const id = `chat-${chats.size + 1}`;
        const chatObj = { id, botId, title, messages: [] };
        chats.set(id, chatObj);
        botHostWs.state.chats.push(chatObj);
        return id;
      },
      submit: async (chatId, text) => {
        const c = chats.get(chatId);
        const run = { id: `run-${++runSeq}` };
        c.messages.push({ role: "user", text, runId: run.id });
        setTimeout(() => {
          const reply = "Reply from bot host!";
          c.messages.push({ role: "assistant", text: reply, runId: run.id });
          events.emit("turn", { chat: c, run });
        }, 10);
      },
      teamworkPeers: {
        hosts: async () => [{ serverId: "node-mac-1", name: "Studio Mac", pin: "pin-1" }],
        call: async (hostId, operation, payload) => {
          assert.equal(hostId, "node-mac-1");
          if (operation === "capabilities") return nodeHost.capabilities();
          return nodeHost.receive(peer, operation, payload);
        },
      },
    };

    const vault = makeFakeVault();
    const bridge = createNodeChannelBridge(botHostWs, { pollMs: 15, timeoutMs: 5000 });
    const manager = new ChannelManager({ workspace: botHostWs, vault, nodeBridge: bridge });
    manager.registerAdapter("imessage", ({ nodeBridge }) =>
      createIMessageAdapter({ nodeBridge, pollIntervalMs: 30 }),
    );

    try {
      const conn = await manager.add({
        kind: "imessage",
        label: "Mac iMessage",
        transport: "imsg_node",
        nodeHostId: "node-mac-1",
        botId: "bot-1",
        policy: { dm: "open" },
      });

      const check = await manager.test(conn.id);
      assert.equal(check.ok, true);

      await manager.startConnection(conn.id);
      assert.ok(typeof pushFromMac === "function", "expected Mac node watcher to start");

      // Push an inbound iMessage on the Mac node -> forwarded over teamwork-peers -> triggers bot turn -> reply sent on Mac node
      pushFromMac(
        normalizeImsgEvent({
          chat_id: 55,
          sender: "friend-1",
          sender_name: "Taylor",
          text: "Hi from phone",
          is_from_me: false,
        }),
      );

      // Wait for poll -> bot turn -> send on Mac node
      const deadline = Date.now() + 2000;
      while (sentOnMac.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(sentOnMac.length, 1);
      assert.equal(sentOnMac[0].chatId, "55");
      assert.equal(sentOnMac[0].text, "Reply from bot host!");

      // Now simulate macOS Automation blocking Messages control on the Mac node
      blockNextSend = true;
      pushFromMac(
        normalizeImsgEvent({
          chat_id: 55,
          sender: "friend-1",
          sender_name: "Taylor",
          text: "Trigger blocked send",
          is_from_me: false,
        }),
      );

      const waitDeadline = Date.now() + 2000;
      let status = null;
      while (Date.now() < waitDeadline) {
        status = manager.list().find((c) => c.id === conn.id)?.status;
        if (status?.state === "waiting_permission") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(status?.state, "waiting_permission");
      assert.equal(status?.detail, "waiting for macOS permission on Studio Mac");
    } finally {
      await manager.stopAll();
      nodeHost.close();
      nodeWs.cleanup();
    }
  });
});
