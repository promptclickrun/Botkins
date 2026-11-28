// The same tool a model sees, including when a remote bot has a local namesake.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

const host = { serverId: "host-b", name: "Studio" };
function setup(t, answer, call, dir = join(tempDir(t), "data")) {
  const { client } = fakeClient(answer);
  const ws = new Workspace(dir, client, () => {});
  ws.teamworkPeers = {
    available: () => true,
    hosts: async (withPin) => [withPin ? { ...host, pin: "peer-pair" } : host],
    call: (id, op, data) => {
      assert.equal(id, "host-b");
      return op === "list" ? [{ id: "scout", name: "Remote Scout", role: "Research" }] : call(op, data);
    },
  };
  return ws;
}

test("a model discovers a remote bot and sends only its composed message, even with no local teammates", async (t) => {
  const requests = [];
  const ws = setup(t, async (_id, _options, session) => {
    const hosts = JSON.parse(await session.tool("list_host_teammates", {}));
    assert.deepEqual(hosts.hosts, [host]);
    const roster = JSON.parse(await session.tool("list_host_teammates", { host: "host-b" }));
    assert.equal(roster.bots[0].id, "scout");
    const result = JSON.parse(await session.tool("ask_teammate", {
      host: host.serverId, teammate: "scout", message: "Check the invoice total.", expecting: "A number",
    }));
    return { data: { content: "Studio says " + result.reply } };
  }, (op, data) => {
    if (op === "submit") {
      requests.push(data);
      return { status: "pending" };
    }
    assert.equal(op, "status");
    assert.deepEqual(data, { id: requests[0].id });
    return { status: "answered", reply: "52" };
  });
  ws.agents.setBotFlags("scout", { hidden: true });
  ws.agents.setBotFlags("patch", { teamwork: false });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Private notes that must stay on this host");
  assert.equal(ws.chat(chatId).messages.at(-1).text, "Studio says 52");
  assert.equal(requests.length, 1);
  const [sent] = requests;
  assert.equal(sent.message, "Check the invoice total.\n\nWhat they need back: A number");
  assert.equal(sent.sourceBotId, "pip");
  assert.equal(sent.sourceBotName, "Pip");
  assert.equal(sent.targetBotId, "scout");
  assert.doesNotMatch(JSON.stringify(sent), /Private notes/);
  const [ask] = ws.state.runs[0].teamwork;
  assert.deepEqual(ask.remote, { hostId: "host-b", hostName: "Studio", botName: "Remote Scout" });
  assert.equal(ask.id, sent.id);
  assert.equal(ask.status, "answered");
});

test("a lost submit reply retries the same id, and a denial comes back to the asking turn", async (t) => {
  const submitted = [];
  const ws = setup(t, async (_id, _options, session) => {
    let message;
    try { await session.tool("ask_teammate", { host: host.serverId, teammate: "scout", message: "Help" }); }
    catch (error) { message = error.message; }
    return { data: { content: message ?? "Unexpected reply" } };
  }, (op, data) => {
    assert.equal(op, "submit");
    submitted.push(data);
    if (submitted.length === 1) throw Object.assign(new Error("Lost reply"), { code: "TEAMWORK_OFFLINE" });
    return { status: "denied" };
  });
  const id = ws.createChat("pip");
  await ws.send(id, "Ask the other computer");
  assert.match(ws.chat(id).messages.at(-1).text, /declined|denied/i);
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[0], submitted[1]);
  assert.equal(ws.state.runs[0].teamwork[0].status, "failed");
});

test("cross-host tools are available only in eligible owner turns and check eligibility again when called", async (t) => {
  const ws = setup(t, undefined, () => { throw new Error("A request escaped"); });
  const bot = ws.bot("pip");
  const chat = ws.chat(ws.createChat("pip"));
  const run = { id: "test" }, task = { run };
  ws.active.set(chat.id, task);
  const tools = () => ws.teamwork.tools(bot, chat, run, task);
  const remote = tools().find((tool) => tool.name === "list_host_teammates");
  assert.ok(remote);
  bot.createdBy = "member";
  assert.ok(!tools().some((tool) => tool.name === "list_host_teammates"));
  delete bot.createdBy;
  ws.peopleOf = () => ({ invited: ["member"] });
  assert.ok(!tools().some((tool) => tool.name === "list_host_teammates"));
  await assert.rejects(remote.handler({}), /owner|private/i);
  ws.peopleOf = null;
  const ask = tools().find((tool) => tool.name === "ask_teammate");
  task.author = { memberId: "member", name: "Member" };
  await assert.rejects(ask.handler({ host: host.serverId, teammate: "scout", message: "From a member" }), /owner|private/i);
  delete task.author;
  chat.hostDispatch = true;
  assert.ok(!tools().some((tool) => tool.name === "list_host_teammates"));
  delete chat.hostDispatch;
  ws.setPreferences({ teamwork: false });
  await assert.rejects(ask.handler({ host: host.serverId, teammate: "scout", message: "Disabled" }), /Teamwork|available/i);
});

test("stopping the source turn cancels the exact pending request on the target", async (t) => {
  const submitted = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const ws = setup(t, async (_id, _options, session) => {
    await session.tool("ask_teammate", { host: host.serverId, teammate: "scout", message: "Wait for approval" });
    return { data: { content: "Answered" } };
  }, (op, data) => {
    if (op === "submit") submitted.resolve(data.id);
    if (op === "cancel") cancelled.resolve(data.id);
    return { status: op === "cancel" ? "cancelled" : "pending" };
  });
  const id = ws.createChat("pip");
  const turn = ws.send(id, "Ask Studio");
  // A turn that finished without submitting is a test failure, not an indefinite wait.
  const requestId = await Promise.race([submitted.promise, turn.then(() => { throw new Error("The turn never dispatched"); })]);
  await ws.stop(id);
  await turn;
  assert.equal(await cancelled.promise, requestId);
  assert.equal(ws.state.runs[0].teamwork[0].status, "stopped");
});

test("a restarted source withdraws a request even if its original Stop could not reach the destination", async t => {
  const dir = join(tempDir(t), "workspace");
  const submitted = Promise.withResolvers();
  const ws = setup(t, async (_id, _opts, session) => {
    await session.tool("ask_teammate", { host: host.serverId, teammate: "scout", message: "Wait" });
    return { data: { content: "" } };
  }, (op, payload) => {
    if (op === "submit") submitted.resolve(payload.id);
    if (op === "cancel") throw Object.assign(new Error("offline"), { code: "TEAMWORK_OFFLINE" });
    return { status: "pending" };
  }, dir);
  const chatId = ws.createChat("pip");
  const turn = ws.send(chatId, "Ask Studio");
  const id = await submitted.promise;
  await ws.stop(chatId);
  await turn;
  const cancellations = [];
  const restored = setup(t, undefined, (op, payload) => {
    cancellations.push([op, payload.id]);
    return { status: "cancelled" };
  }, dir);
  await restored.teamwork.outgoing.reconcile();
  assert.deepEqual(cancellations, [["cancel", id]]);
  await restored.teamwork.outgoing.reconcile();
  assert.equal(cancellations.length, 1);
  assert.equal(restored.snapshot().outgoingDispatches, undefined);
});

test("empty or whitespace host is treated as unset across ask_teammate, list_host_teammates, list_node_hosts, and node_* tools", async (t) => {
  const localCalls = [];
  const ws = setup(t, async (sessionId, _options, session) => {
    if (sessionId.includes("-team-")) {
      localCalls.push(sessionId);
      return { data: { content: "local scout reply" } };
    }
    const allHostsEmpty = JSON.parse(await session.tool("list_host_teammates", { host: "" }));
    assert.deepEqual(allHostsEmpty.hosts, [host]);
    const allHostsSpaces = JSON.parse(await session.tool("list_host_teammates", { host: "   " }));
    assert.deepEqual(allHostsSpaces.hosts, [host]);

    const allNodesEmpty = JSON.parse(await session.tool("list_node_hosts", { host: "" }));
    assert.equal(allNodesEmpty.hosts.length, 1);
    assert.equal(allNodesEmpty.hosts[0].serverId, host.serverId);
    const allNodesSpaces = JSON.parse(await session.tool("list_node_hosts", { host: "  \t " }));
    assert.equal(allNodesSpaces.hosts.length, 1);
    assert.equal(allNodesSpaces.hosts[0].serverId, host.serverId);

    const localFromEmpty = JSON.parse(await session.tool("ask_teammate", {
      host: "", teammate: "Scout", message: "Handle locally with empty host",
    }));
    assert.deepEqual(localFromEmpty, { teammate: "Scout", reply: "local scout reply" });

    const localFromSpaces = JSON.parse(await session.tool("ask_teammate", {
      host: "   ", teammate: "Scout", message: "Handle locally with whitespace host",
    }));
    assert.deepEqual(localFromSpaces, { teammate: "Scout", reply: "local scout reply" });

    await assert.rejects(
      session.tool("list_node_files", { host: "", project: "p1" }),
      /Choose a node host ID from list_node_hosts/,
    );
    await assert.rejects(
      session.tool("node_read_file", { host: "", path: "README.md" }),
      /Choose a node host ID from list_node_hosts/,
    );
    await assert.rejects(
      session.tool("node_exec", { host: "   ", command: "uname -a" }),
      /Choose a node host ID from list_node_hosts/,
    );

    return { data: { content: "All empty-host checks passed" } };
  }, (op) => {
    if (op === "capabilities") {
      return { name: "Studio", role: "standard", online: true, version: 1, bots: [], operations: ["fs.read"], projects: [] };
    }
    throw new Error("Unexpected remote call: " + op);
  });

  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Verify empty host handling");
  assert.equal(ws.chat(chatId).messages.at(-1).text, "All empty-host checks passed");
  assert.equal(localCalls.length, 2, "ask_teammate with empty/whitespace host ran locally both times");
  assert.equal(ws.state.runs[0].teamwork.every((ask) => !ask.remote), true);
});
