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
