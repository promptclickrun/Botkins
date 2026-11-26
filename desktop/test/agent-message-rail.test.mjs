// Backend metadata tests for bot-to-bot messages (teamwork, task handoffs, remote dispatch)
// and desktop/link rail-coverage deduplication.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Tasks } from "../desktop/tasks.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";
import { isStepCoveredByRail } from "../desktop/link/activityModel.mjs";

function setup(t, reply, options = {}) {
  const dir = tempDir(t);
  const fake = fakeClient(reply, options.extra);
  const ws = new Workspace(join(dir, "data"), fake.client, () => {});
  return { dir, ws, ...fake };
}

test("teamwork ask stamps structured from metadata on run.teamwork and helper chat messages", async (t) => {
  const { ws } = setup(t, async (id, _options, session) => {
    if (id.includes("-team-")) return { data: { content: "Scout answer: tide is at 14:20" } };
    const out = JSON.parse(await session.tool("ask_teammate", { teammate: "Scout", message: "Check the tide chart" }));
    return { data: { content: "Got it: " + out.reply } };
  });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "When is high tide?");

  const run = ws.state.runs.find((r) => r.chatId === chatId);
  assert.ok(run, "run recorded");
  assert.equal(run.teamwork?.length, 1);
  const ask = run.teamwork[0];
  assert.deepEqual(ask.from, {
    kind: "bot",
    botId: "pip",
    name: "Pip",
    chatId,
    via: "teamwork",
  });
  assert.equal(ask.botId, "scout");
  assert.equal(ask.status, "answered");
  assert.equal(ask.reply, "Scout answer: tide is at 14:20");

  // Helper conversation also stores structured `from` metadata on the incoming message.
  const chat = ws.chat(chatId);
  const helperMsgs = chat.helpers?.scout?.messages ?? [];
  assert.equal(helperMsgs.length, 2);
  assert.equal(helperMsgs[0].role, "user");
  assert.deepEqual(helperMsgs[0].from, {
    kind: "bot",
    botId: "pip",
    name: "Pip",
    chatId,
    via: "teamwork",
  });
  assert.equal(typeof helperMsgs[0].time, "number");
});

test("task_create by a bot for another bot stamps run.taskHandoffs and incoming from metadata on the task chat", async (t) => {
  const { ws } = setup(t, async () => ({ data: { content: "Task finished cleanly" } }));
  const tasks = new Tasks(ws);
  const pip = ws.bot("pip");
  const scout = ws.bot("scout");
  const sourceChatId = ws.createChat(pip.id);
  const sourceRun = { id: "r-source", chatId: sourceChatId, botId: pip.id, status: "Working", time: Date.now() };
  ws.state.runs.unshift(sourceRun);
  const active = {};
  ws.active.set(sourceChatId, active);
  const tools = Object.fromEntries(tasks.tools(pip, ws.chat(sourceChatId), sourceRun, active).map((tool) => [tool.name, tool]));

  const created = JSON.parse(await tools.task_create.handler({
    title: "Audit mobile header spacing",
    details: "Check compact breakpoints and dark mode contrast.",
    bot: scout.name,
    priority: "high",
    status: "later",
  }));
  assert.ok(created.id);

  // Source run records the outgoing task handoff card metadata.
  assert.equal(sourceRun.taskHandoffs?.length, 1);
  const handoff = sourceRun.taskHandoffs[0];
  assert.equal(handoff.taskId, created.id);
  assert.equal(handoff.title, "Audit mobile header spacing");
  assert.equal(handoff.botId, scout.id);
  assert.equal(handoff.fromBotId, pip.id);
  assert.equal(handoff.priority, "high");
  assert.deepEqual(handoff.from, {
    kind: "bot",
    botId: pip.id,
    name: pip.name,
    chatId: sourceChatId,
    via: "task",
  });

  // Starting the task stamps `from` on the task chat's opening user message with originating chatId.
  const task = tasks.get(created.id);
  assert.equal(task.fromChatId, sourceChatId);
  tasks.start(created.id);
  await Promise.all([...ws.locks.values()].map((p) => p.catch(() => {})));

  const taskChat = ws.chat(task.chatId);
  assert.ok(taskChat, "task chat created");
  const firstUser = taskChat.messages.find((m) => m.role === "user");
  assert.ok(firstUser, "task opening user message exists");
  assert.deepEqual(firstUser.from, {
    kind: "bot",
    botId: pip.id,
    name: pip.name,
    chatId: sourceChatId,
    via: "task",
  });
  // Handoff record also gets linked to the task chatId once started.
  assert.equal(handoff.chatId, task.chatId);
});

test("person-created tasks do not stamp bot from metadata", async (t) => {
  const { ws } = setup(t, async () => ({ data: { content: "Person task done" } }));
  const tasks = new Tasks(ws);
  const id = tasks.save({ title: "Person task", body: "Check metrics", botId: "scout", status: "later" });
  const task = tasks.get(id);
  tasks.start(id);
  await Promise.all([...ws.locks.values()].map((p) => p.catch(() => {})));

  const taskChat = ws.chat(task.chatId);
  const firstUser = taskChat.messages.find((m) => m.role === "user");
  assert.ok(firstUser);
  assert.equal(firstUser.from, undefined);
});

test("remote host dispatch stamps remote from metadata on the recipient chat message", async (t) => {
  const { ws } = setup(t, async () => ({ data: { content: "Remote reply" } }));
  const peer = {
    profileId: "owner-id",
    serverId: "vps-host",
    serverKey: "vps-key",
    name: "Alfie VPS",
    targetId: "mac-host",
    targetKey: "mac-key",
    targetName: "Mac Studio",
    verify: async () => {},
  };
  const body = {
    id: randomUUID(),
    sourceBotId: "alfie",
    sourceBotName: "Alfie",
    targetBotId: "scout",
    message: "Please verify the release notes",
    createdAt: Date.now(),
  };

  assert.deepEqual(await ws.hostDispatch.receive(peer, "submit", body), { status: "pending" });
  const [card] = ws.interactions.snapshot();
  ws.interactions.respond(card.id, { action: "approve" });
  let finalRes;
  for (let i = 0; i < 50; i++) {
    finalRes = await ws.hostDispatch.receive(peer, "status", { id: body.id });
    if (!["pending", "working"].includes(finalRes.status)) break;
    await tick();
  }
  assert.equal(finalRes.status, "answered");
  const dispatchChat = ws.state.chats.find((c) => c.hostDispatch);
  assert.ok(dispatchChat, "hostDispatch chat created");
  const incoming = dispatchChat.messages.find((m) => m.role === "user" && m.text === body.message);
  assert.ok(incoming, "incoming remote message recorded");
  assert.deepEqual(incoming.from, {
    kind: "bot",
    botId: "alfie",
    name: "Alfie",
    hostId: "vps-host",
    hostName: "Alfie VPS",
    via: "remote",
  });
});

test("isStepCoveredByRail suppresses duplicate ask_teammate and task_create steps when rail cards exist", () => {
  const runWithTeamwork = { teamwork: [{ id: "tw1", botId: "scout", name: "Scout", message: "hi", status: "done", started: 1 }] };
  const runWithHandoff = { taskHandoffs: [{ id: "th1", taskId: "t1", title: "Task", botId: "scout", botName: "Scout", started: 1 }] };

  assert.equal(isStepCoveredByRail({ id: "s1", name: "ask_teammate", status: "Done" }, runWithTeamwork), true);
  assert.equal(isStepCoveredByRail({ id: "s2", name: "ask_teammate", status: "Running" }, runWithTeamwork), true);
  assert.equal(isStepCoveredByRail({ id: "s3", name: "ask_teammate", status: "Failed" }, runWithTeamwork), false, "failed tool calls stay visible in activity");
  assert.equal(isStepCoveredByRail({ id: "s4", name: "ask_teammate", status: "Done" }, {}), false, "without teamwork entries, fallback step stays visible");

  assert.equal(isStepCoveredByRail({ id: "s5", name: "task_create", status: "Done" }, runWithHandoff), true);
  assert.equal(isStepCoveredByRail({ id: "s6", name: "task_create", status: "Done" }, {}), false, "person-only or self tasks without handoff stay visible");
  assert.equal(isStepCoveredByRail({ id: "s7", name: "read", status: "Done" }, runWithTeamwork), false);
});
