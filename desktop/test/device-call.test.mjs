// A paired device's call on its way to the app's handlers (desktop/device-call.mjs): an answer to
// a bot's request arrives, and what a team member does is marked as theirs.
import assert from "node:assert/strict";
import test from "node:test";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { Workspace } from "./starter.mjs";
import { deviceCall } from "../desktop/device-call.mjs";

const avery = { kind: "member", memberId: "m_avery", name: "Avery" };

function open(t) {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {});
  // The handlers a paired device reaches here, as desktop/main.mjs wires them.
  const handlers = {
    createChat: (...args) => ws.createChat(...args),
    send: (...args) => ws.send(...args),
    recordVoiceLine: (...args) => ws.recordVoiceLine(...args),
    respond: (id, answer) => ws.interactions.respond(id, answer),
  };
  return { ws, call: deviceCall({ workspace: ws, handlers, folders: {} }) };
}

/** A turn under way that asks the person one question. Returns the request and the bot's wait. */
function ask(ws, chatId, question) {
  const chat = ws.chat(chatId);
  const task = { stopped: false, run: { id: "run-" + chatId } };
  const waiting = ws.interactions.question(chat, task, question);
  const request = ws.snapshot().requests.find((item) => item.chatId === chatId);
  return { request, waiting };
}

test("an answer from a paired phone reaches the bot's question", async (t) => {
  const { ws, call } = open(t);
  const chatId = ws.createChat("pip");
  const { request, waiting } = ask(ws, chatId, { question: "Audience?", choices: ["Team", "Public"], allowFreeform: false });

  await call("respond", [request.id, { action: "answer", value: "Team" }]);

  assert.deepEqual(await waiting, { answer: "Team", wasFreeform: false });
  assert.equal(ws.snapshot().requests.length, 0);
  const receipt = ws.chat(chatId).messages.at(-1);
  assert.equal(receipt.text, "Team");
  assert.equal(receipt.answer.requestId, request.id);
  assert.equal(receipt.author, undefined, "the owner's answer names no member");
});

test("a paired phone can approve, deny and dismiss", async (t) => {
  const { ws, call } = open(t);
  const chatId = ws.createChat("pip");
  const chat = ws.chat(chatId);
  const permission = () => ws.interactions.permission(chat, { stopped: false }, { kind: "shell", title: "Run a command", detail: "ls" });

  const allowed = permission();
  await call("respond", [ws.snapshot().requests[0].id, { action: "approve" }]);
  assert.deepEqual(await allowed, { allow: true, interactive: true });

  const denied = permission();
  await call("respond", [ws.snapshot().requests[0].id, { action: "deny" }]);
  assert.deepEqual(await denied, { allow: false });

  const { request, waiting } = ask(ws, chatId, { question: "Which?", choices: ["A", "B"] });
  await call("respond", [request.id, { action: "cancel" }]);
  await assert.rejects(waiting, /dismissed/);
});

test("a request that has already closed says so", async (t) => {
  const { call } = open(t);
  await assert.rejects(call("respond", ["gone", { action: "cancel" }]), /already closed/);
});

test("a team member's answer is marked as theirs", async (t) => {
  const { ws, call } = open(t);
  const chatId = await call("createChat", ["pip"], { principal: avery });
  assert.equal(ws.chat(chatId).createdBy, "m_avery");
  const { request, waiting } = ask(ws, chatId, { question: "Audience?", choices: ["Team", "Public"], allowFreeform: false });

  await call("respond", [request.id, { action: "answer", value: "Public" }], { principal: avery });

  assert.deepEqual(await waiting, { answer: "Public", wasFreeform: false });
  const receipt = ws.chat(chatId).messages.at(-1);
  assert.equal(receipt.answer.requestId, request.id);
  assert.deepEqual(receipt.author, { memberId: "m_avery", name: "Avery" });
});

test("a team member's message is marked as theirs", async (t) => {
  const { ws, call } = open(t);
  const chatId = ws.createChat("pip");
  await call("send", [chatId, "Help with this"], { principal: avery });
  assert.deepEqual(ws.chat(chatId).messages[0].author, { memberId: "m_avery", name: "Avery" });
});

test("a team member's message leaves the owner's earlier messages alone", async (t) => {
  const { ws, call } = open(t);
  const chatId = await call("createChat", ["pip"], { principal: avery });
  await ws.send(chatId, "From the owner");
  await call("send", [chatId, "From Avery"], { principal: avery });
  const said = ws.chat(chatId).messages.filter((message) => message.role === "user").map((message) => [message.text, message.author?.name]);
  assert.deepEqual(said, [["From the owner", undefined], ["From Avery", "Avery"]]);
});

test("a team member's answer that leaves no line in the chat marks nobody else's message", async (t) => {
  const { ws, call } = open(t);
  const chatId = await call("createChat", ["pip"], { principal: avery });
  await ws.send(chatId, "From the owner");
  // An approval asked outside a run writes no receipt.
  const allowed = ws.interactions.permission(ws.chat(chatId), { stopped: false }, { kind: "shell", title: "Run a command", detail: "ls" });
  await call("respond", [ws.snapshot().requests[0].id, { action: "approve" }], { principal: avery });
  assert.deepEqual(await allowed, { allow: true, interactive: true });
  assert.equal(ws.chat(chatId).messages.find((message) => message.role === "user").author, undefined);
});

test("a call about a space is handed the person who made it, whatever the device sent", async (t) => {
  const { ws } = open(t);
  const seen = [];
  const handlers = Object.fromEntries(["spaces.rename", "spaces.read", "spaces.patchState", "changePanel", "refreshPanel", "boardAct"].map((name) => [name, (...args) => void seen.push([name, ...args])]));
  const call = deviceCall({ workspace: ws, handlers, folders: {} });
  // The owner, by a device with no team, and by one the link names as the owner.
  await call("spaces.rename", ["s_1", "Launch"]);
  await call("spaces.read", ["s_1"], { principal: { kind: "owner" } });
  // A member. The person goes in after what the call takes, in the same place when the device left something out,
  await call("spaces.patchState", ["p_1", { done: true }], { principal: avery });
  await call("refreshPanel", ["p_1"], { principal: avery });
  // and a device that adds a person of its own choosing is not heard.
  await call("spaces.rename", ["s_1", "Mine", "owner"], { principal: avery });
  await call("changePanel", ["p_1", "hide", "owner", "extra"], { principal: avery });
  await call("boardAct", ["c_1", "clear"], { principal: avery });
  assert.deepEqual(seen, [
    ["spaces.rename", "s_1", "Launch", "owner"],
    ["spaces.read", "s_1", "owner"],
    ["spaces.patchState", "p_1", { done: true }, undefined, "m_avery"],
    ["refreshPanel", "p_1", "m_avery"],
    ["spaces.rename", "s_1", "Mine", "m_avery"],
    ["changePanel", "p_1", "hide", "m_avery"],
    ["boardAct", "c_1", "clear", undefined, "m_avery"],
  ]);
});

test("a bot a member makes or copies is marked as theirs, and one without the mark is the owner's", async (t) => {
  const { ws } = open(t);
  const handlers = { addBot: (...args) => ws.agents.create(...args), duplicateBot: (...args) => ws.agents.duplicateBot(...args) };
  const call = deviceCall({ workspace: ws, handlers, folders: {} });
  const made = await call("addBot", [{ name: "Avery's helper", role: "Helper", instructions: "Help." }], { principal: avery });
  assert.equal(ws.bot(made).createdBy, "m_avery");
  // A copy answers its id, and is the person's who made the copy: a member's copy of the owner's bot is the member's,
  const copied = await call("duplicateBot", ["pip"], { principal: avery });
  assert.equal(typeof copied, "string");
  assert.deepEqual([ws.bot(copied).createdBy, "createdBy" in ws.bot("pip")], ["m_avery", false]);
  // and the owner's copy of a member's bot is the owner's.
  const owners = await call("duplicateBot", [made]);
  assert.equal("createdBy" in ws.bot(owners), false);
  const mine = await call("addBot", [{ name: "Mine", role: "Helper", instructions: "Help." }], { principal: { kind: "owner" } });
  assert.equal("createdBy" in ws.bot(mine), false);
  // The mark is kept when the app starts again.
  assert.equal(new Workspace(ws.dir, fakeClient().client, () => {}).bot(made).createdBy, "m_avery");
});

test("a member's spoken request is updated and runs once in their name", async (t) => {
  const { ws, call } = open(t);
  const context = { principal: avery };
  const id = await call("createChat", ["pip"], context);
  await call("recordVoiceLine", [id, "call:1", "Check", false], context);
  await call("recordVoiceLine", [id, "call:1", "Check the time", true], context);
  await call("send", [id, "Check the time", { voiceId: "call:1" }], context);
  const said = ws.chat(id).messages.filter(message => message.role === "user");
  assert.equal(said.length, 1);
  assert.equal(said[0].text, "Check the time");
  assert.deepEqual(said[0].author, { memberId: avery.memberId, name: avery.name });
  assert.ok(said[0].runId);
});
