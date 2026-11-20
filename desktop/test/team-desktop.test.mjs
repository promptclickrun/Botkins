import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { Workspace } from "./starter.mjs";
import { decide } from "../desktop/notify.mjs";
import { RemoteHosts } from "../desktop/remotehosts.mjs";
import * as linkClient from "../desktop/remote/link-client.mjs";

const team = {
  name: "Northstar",
  roles: [{
    id: "r_guest",
    name: "Guest",
    perms: {
      agents: ["view", "chat"],
      today: ["view"],
      skills: ["read"],
      mcp: ["view"],
      plugins: ["view"],
      settings: [],
    },
    bots: "all",
  }],
  groups: [{ id: "g_everyone", name: "Everyone", roleId: "r_guest" }],
  members: [{ id: "m_avery", name: "Avery", groupId: "g_everyone", joinedAt: 1, deviceIds: [] }],
  invites: [],
  requests: [],
};

test("member identity prefixes model input without changing the displayed message", async (t) => {
  const fake = fakeClient();
  const ws = new Workspace(tempDir(t), fake.client, () => {}, { team: () => team });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Help with this", {
    author: { memberId: "m_avery", name: "Avery" },
  });

  assert.equal(
    fake.log.sent[0][1],
    "[From Avery, a member of Northstar's team, not the owner]\nHelp with this",
  );
  assert.equal(ws.chat(chatId).messages[0].text, "Help with this");
  const ownerChat = ws.createChat("pip");
  await ws.send(ownerChat, "Owner message");
  assert.equal(fake.log.sent[1][1], "Owner message");
});

test("a member role without use permissions receives no MCP, skills or plugin tools", async (t) => {
  const fake = fakeClient();
  const ws = new Workspace(tempDir(t), fake.client, () => {}, { team: () => team });
  ws.integrations.saveServer({ name: "docs", command: "node" });
  ws.integrations.pluginsFor = () => ["/linked-plugin"];
  ws.plugins.session = async () => ({
    directories: ["/marketplace-plugin"],
    mcpServers: { marketplace: { type: "stdio", command: "plugin" } },
    hooks: [{ event: "agentStop", command: "done" }],
  });
  const chatId = ws.createChat("pip");

  await ws.send(chatId, "Use the available tools", {
    author: { memberId: "m_avery", name: "Avery" },
  });

  const config = [...fake.log.configs.values()][0];
  assert.deepEqual(config.mcp.servers, {});
  assert.deepEqual(config.skills.directories, []);
  assert.deepEqual(config.plugins.directories, []);
  assert.equal(config.hooks, undefined);
  const tools = config.tools.definitions.map((tool) => tool.name);
  assert.ok(!tools.includes("search_plugins"));
  assert.ok(!tools.includes("propose_plugin"));
});

test("a member's chat keeps the member's limits when the owner writes in it", (t) => {
  const fake = fakeClient();
  const ws = new Workspace(tempDir(t), fake.client, () => {}, { team: () => team });
  const chatId = ws.createChat("pip");
  const chat = ws.chat(chatId);
  chat.createdBy = "m_avery";
  chat.messages.push({ role: "user", text: "Owner note", time: Date.now() });
  assert.deepEqual(ws.accessForTurn(chat, {}), { member: true, skills: false, mcp: false, plugins: false });
  const ownerChat = ws.chat(ws.createChat("pip"));
  assert.deepEqual(ws.accessForTurn(ownerChat, {}), { member: false, skills: true, mcp: true, plugins: true });
});

test("a join request notification follows request preferences and opens Team requests", () => {
  const settings = {
    notifications: {
      replies: true,
      routines: true,
      requests: true,
      quietHours: { enabled: false, from: "22:00", to: "07:00" },
    },
  };
  const event = {
    type: "joinRequest",
    request: { id: "q_avery", name: "Avery" },
  };
  const context = {
    settings,
    focused: false,
    now: new Date("2026-11-20T12:00:00Z"),
    timeZone: "UTC",
  };

  assert.deepEqual(decide(event, context), {
    title: "Avery wants to join your team",
    body: "Review the request in Settings › Team.",
    settings: "Team:Requests",
  });
  assert.equal(
    decide({ type: "request", bot: { name: "Pip" }, request: { kind: "permission", title: "Run it", chatId: "chat", askedBy: { memberId: "m_avery", name: "Avery" } } }, {
      ...context,
      focused: true,
    })?.title,
    "Pip needs your approval",
    "a member turn still notifies its owner while the window is focused",
  );
  settings.notifications.requests = false;
  assert.equal(decide(event, context), null);
});

test("team IPC handlers call the LinkHost owner API", async () => {
  const { teamHandlers } = await import("../desktop/team-ipc.mjs");
  const calls = [];
  const returned = {};
  const methods = {
    team: [],
    saveRole: [{ id: "r_custom" }],
    deleteRole: ["r_custom"],
    saveGroup: [{ id: "g_custom" }],
    deleteGroup: ["g_custom", "g_everyone"],
    createInvite: [{ groupId: "g_everyone", days: 7, maxUses: 5 }],
    revokeInvite: ["i_invite"],
    approve: ["q_request", "g_everyone"],
    deny: ["q_request"],
    moveMember: ["m_member", "g_everyone"],
    removeMember: ["m_member"],
    renameTeam: ["Northstar"],
  };
  const host = Object.fromEntries(
    Object.entries(methods).map(([name]) => [
      name,
      (...args) => {
        calls.push([name, args]);
        return returned;
      },
    ]),
  );
  const handlers = teamHandlers(() => host);
  const actions = [
    ["team", "team"],
    ["saveTeamRole", "saveRole"],
    ["deleteTeamRole", "deleteRole"],
    ["saveTeamGroup", "saveGroup"],
    ["deleteTeamGroup", "deleteGroup"],
    ["createTeamInvite", "createInvite"],
    ["revokeTeamInvite", "revokeInvite"],
    ["approveTeamRequest", "approve"],
    ["denyTeamRequest", "deny"],
    ["moveTeamMember", "moveMember"],
    ["removeTeamMember", "removeMember"],
    ["renameTeam", "renameTeam"],
  ];
  for (const [handler, method] of actions) {
    assert.equal(await handlers[handler](...methods[method]), returned);
  }
  assert.deepEqual(calls, actions.map(([, method]) => [method, methods[method]]));
});

test("a desktop join resumes a protocol invite through pending, approved, denied and closed states", async (t) => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return { ok: true };
  };
  let next = { result: { status: "pending", requestId: "q_one", team: { name: "Northstar" } }, attempt: undefined };
  const lib = {
    ...linkClient,
    findInvite: async (fetcher, code, relayBase, serverKey) => {
      await fetcher("invite:" + relayBase + ":" + serverKey);
      return {
        code,
        serverId: "server-one",
        serverKey: "B".repeat(43),
        name: "Northstar",
        hosts: ["127.0.0.1:9876"],
        room: "C".repeat(43),
        relayBase,
      };
    },
    startJoin: async (fetcher, target, device) => {
      await fetcher("join:start:" + device.kind);
      const attempt = { target, device, keys: { publicKey: "D".repeat(43), secretKey: "never-store-plain" } };
      return { ...next, attempt };
    },
    checkJoin: async (fetcher, attempt) => {
      await fetcher("join:check:" + attempt.target.code);
      if (next instanceof Error) throw next;
      return next.result;
    },
  };
  const protectedFile = join(tempDir(t), "remote-hosts.json");
  const protect = {
    wrap: (text) => "sealed:" + Buffer.from(text).toString("base64"),
    unwrap: (text) => Buffer.from(String(text).replace(/^sealed:/, ""), "base64").toString(),
  };
  const remote = new RemoteHosts({
    file: protectedFile,
    protect,
    lib,
    fetch,
    device: { name: "Laptop", platform: "linux" },
  });
  const target = await remote.findTeamInvite("botkins://join?c=ABCDE-FG123&k=" + "B".repeat(43));
  assert.equal(target.code, "ABCDEFG123");
  const pending = await remote.startTeamJoin(target);
  assert.equal(pending.status, "pending");
  assert.match(calls[0], /^invite:/);

  const reopened = new RemoteHosts({ file: protectedFile, protect, lib, fetch, device: { name: "Laptop", platform: "linux" } });
  assert.equal(reopened.teamJoins()[0].status, "pending");
  assert.ok(!readFileSync(protectedFile, "utf8").includes("never-store-plain"));
  const pairing = {
    serverId: "server-one",
    serverKey: "B".repeat(43),
    deviceId: "device-one",
    secretKey: "paired-secret",
    hosts: ["127.0.0.1:9876"],
    name: "Northstar",
    member: true,
  };
  next = { result: { status: "approved", pairing } };
  assert.equal((await reopened.checkTeamJoin(pending.id)).status, "approved");
  assert.equal(reopened.list()[0].member, true);

  next = { result: { status: "pending", requestId: "q_two", team: { name: "Northstar" } } };
  const denied = await reopened.startTeamJoin(target);
  next = { result: { status: "denied" } };
  assert.equal((await reopened.checkTeamJoin(denied.id)).status, "denied");

  next = { result: { status: "pending", requestId: "q_three", team: { name: "Northstar" } } };
  const closed = await reopened.startTeamJoin(target);
  next = Object.assign(new Error("closed"), { code: "join_closed" });
  assert.equal((await reopened.checkTeamJoin(closed.id)).status, "closed");
  assert.equal(reopened.teamJoins().length, 0);
});

test("a member turn labels approval requests for the owner", (t) => {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, { team: () => team });
  const chat = ws.chat(ws.createChat("pip"));
  const task = { stopped: false, author: { memberId: "m_avery", name: "Avery" } };
  const pending = ws.interactions.request(chat, task, {
    kind: "permission",
    title: "Run the command",
  });
  const request = ws.interactions.snapshot()[0];
  assert.deepEqual(request.askedBy, task.author);
  ws.interactions.respond(request.id, { action: "deny" });
  return pending;
});
