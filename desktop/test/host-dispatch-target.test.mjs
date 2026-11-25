import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";

const peer = { profileId: "owner-id", serverId: "left", serverKey: "left-key", name: "Laptop",
  targetId: "right", targetKey: "right-key", targetName: "Desktop", verify: async () => {} };
const payload = () => ({ id: randomUUID(), sourceBotId: "pip", sourceBotName: "Pip", targetBotId: "scout", message: "  exact\nmessage  ", createdAt: Date.now() });
function setup(t, dir = tempDir(t)) {
  const fake = fakeClient(async () => ({ data: { content: "answer" } }));
  const ws = new Workspace(dir, fake.client, () => {});
  return { ws, dir, log: fake.log, call: (op, arg, from = peer) => ws.hostDispatch.receive(from, op, arg) };
}
const settle = async (call, body) => {
  for (let i = 0; i < 50; i++) {
    const result = await call("status", { id: body.id });
    if (!["pending", "working"].includes(result.status)) return result;
    await tick();
  }
  assert.fail("No dispatch result");
};

test("a verified peer can replay an owner decision but cannot change the message or receive a second delivery", async t => {
  const { ws, call, log, dir } = setup(t);
  const body = payload();
  assert.deepEqual(await call("submit", body), { status: "pending" });
  const [card] = ws.interactions.snapshot();
  assert.equal(card.dispatch, true);
  assert.equal(card.detail, body.message);
  assert.equal(log.sent.length, 0);
  assert.throws(() => ws.interactions.respond(card.id, { action: "remember" }, true, "member"), /owner/i);
  assert.throws(() => ws.interactions.respond(card.id, { action: "approve" }, false), /owner/i);
  await assert.rejects(call("submit", { ...body, message: "other" }));
  await assert.rejects(call("status", body, { ...peer, serverKey: "other-key" }));
  await call("submit", body);
  assert.equal(ws.interactions.snapshot().length, 1);
  ws.interactions.respond(card.id, { action: "today" });
  assert.deepEqual(await settle(call, body), { status: "answered", reply: "answer" });
  assert.equal(log.sent.length, 1);
  assert.equal(log.sent[0][1], body.message);
  const config = log.configs.get(log.sent[0][0]);
  assert.deepEqual(config.tools.availableTools, []);
  assert.deepEqual(config.tools.definitions, []);
  assert.equal(config.skills.enabled, false);
  const next = setup(t, dir);
  assert.deepEqual(await next.call("submit", body), { status: "answered", reply: "answer" });
  const follow = payload();
  await next.call("submit", follow);
  assert.deepEqual(await settle(next.call, follow), { status: "answered", reply: "answer" });
  next.ws.clearApprovals(card.chatId);
  const another = payload();
  assert.deepEqual(await next.call("submit", another), { status: "pending" });
  assert.deepEqual(await next.call("cancel", another), { status: "cancelled" });
  assert.equal(next.ws.interactions.snapshot().length, 0);
});

test("cancel can overtake delivery, pending requests reattach once, and closed cards cannot approve", async t => {
  const { ws, dir, call, log } = setup(t);
  const first = payload();
  assert.deepEqual(await call("cancel", first), { status: "cancelled" });
  assert.deepEqual(await call("submit", first), { status: "cancelled" });
  const pending = payload();
  await call("submit", pending);
  assert.equal(Object.hasOwn(ws.snapshot(), "hostDispatch"), false);
  const next = setup(t, dir);
  await Promise.all([next.call("submit", pending), next.call("status", pending)]);
  const [card] = next.ws.interactions.snapshot();
  assert.equal(next.ws.interactions.snapshot().length, 1);
  assert.equal(next.ws.snapshot().streams[card.chatId], "");
  await next.ws.stop(card.chatId);
  assert.deepEqual(await next.call("status", pending), { status: "cancelled" });
  assert.throws(() => next.ws.interactions.respond(card.id, { action: "approve" }), /closed/);
  assert.equal(next.log.sent.length + log.sent.length, 0);
});

test("only eligible bots are visible and eligible when the approved message reaches the helper", async t => {
  const { ws, call, log } = setup(t);
  ws.bot("pip").hidden = true;
  ws.bot("patch").teamwork = false;
  assert.deepEqual(await call("list"), [{ id: "scout", name: "Scout", role: "Research partner" }]);
  await assert.rejects(call("submit", { ...payload(), message: "a".repeat(16001) }));
  const body = payload();
  await call("submit", body);
  ws.bot("scout").hidden = true;
  ws.interactions.respond(ws.interactions.snapshot()[0].id, { action: "approve" });
  assert.equal((await settle(call, body)).status, "failed");
  ws.bot("scout").hidden = false;
  const lost = payload();
  await call("submit", lost, { ...peer, verify: async () => { throw new Error("Removed"); } });
  ws.interactions.respond(ws.interactions.snapshot()[0].id, { action: "remember" });
  assert.equal((await settle(call, lost)).status, "failed");
  assert.deepEqual(await call("submit", payload()), { status: "pending" }, "restoring the old identity does not grant access");
  assert.equal(log.sent.length, 0);
});

test("a remembered pair cannot approve other bots, host keys, owners or the reverse direction", async t => {
  const { ws, call } = setup(t);
  const first = payload();
  await call("submit", first);
  ws.interactions.respond(ws.interactions.snapshot()[0].id, { action: "remember" });
  await settle(call, first);
  for (const [from, body] of [
    [peer, { ...payload(), sourceBotId: "other" }], [peer, { ...payload(), targetBotId: "patch" }],
    [{ ...peer, targetKey: "rotated" }, payload()], [{ ...peer, profileId: "other" }, payload()],
    [{ ...peer, serverId: peer.targetId, serverKey: peer.targetKey, targetId: peer.serverId, targetKey: peer.serverKey }, payload()],
  ]) {
    assert.deepEqual(await call("submit", body, from), { status: "pending" });
    ws.interactions.respond(ws.interactions.snapshot()[0].id, { action: "deny" });
    await tick();
    assert.deepEqual(await call("status", body, from), { status: "denied" });
  }
  ws.clearApprovals();
  await call("submit", payload());
  assert.equal(ws.interactions.snapshot().length, 1);
});

test("today ends at destination midnight even across restart", async t => {
  const { ws, call, dir } = setup(t);
  const base = new Date(2026, 10, 24, 23, 59, 58);
  t.mock.timers.enable({ apis: ["Date"], now: base });
  const body = payload();
  await call("submit", body);
  ws.interactions.respond(ws.interactions.snapshot()[0].id, { action: "today" });
  assert.equal((await settle(call, body)).status, "answered");
  t.mock.timers.tick(2000);
  const after = setup(t, dir);
  assert.deepEqual(await after.call("submit", payload()), { status: "pending" });
});

test("clearing a remembered grant during session preparation prevents delivery", async t => {
  const { ws, call, log } = setup(t);
  const first = payload();
  await call("submit", first);
  const [card] = ws.interactions.snapshot();
  ws.interactions.respond(card.id, { action: "remember" });
  assert.equal((await settle(call, first)).status, "answered");
  let enter, release;
  const checking = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const next = payload();
  await call("submit", next, { ...peer, verify: async () => { enter(); await gate; } });
  await checking;
  ws.clearApprovals(card.chatId);
  release();
  assert.equal((await settle(call, next)).status, "failed");
  assert.equal(log.sent.length, 1);
});

test("a crash after delivery is possible never resends a working request", async t => {
  const { ws, call, dir } = setup(t);
  const body = payload();
  let enter, release;
  const checking = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await call("submit", body, { ...peer, verify: async () => { enter(); await gate; } });
  ws.interactions.respond(ws.interactions.snapshot()[0].id, { action: "approve" });
  await tick();
  await call("status", body);
  await checking;
  const next = setup(t, dir);
  assert.equal((await next.call("submit", body)).status, "failed");
  assert.equal(next.log.sent.length, 0);
  ws.hostDispatch.close();
  release();
  await tick();
});

test("approving a card while the source is offline waits for that request's source before delivery", async t => {
  const { ws, call, log } = setup(t);
  const body = payload();
  await call("submit", body);
  ws.interactions.respond(ws.interactions.snapshot()[0].id, { action: "remember" });
  await tick(30);
  assert.equal(log.sent.length, 0);
  await call("cancel", { id: body.id });
  assert.deepEqual(await call("status", body), { status: "cancelled" });
  assert.equal(log.sent.length, 0);
});

test("choosing today on a second pending card cannot shorten an existing permanent grant", async t => {
  const { ws, call } = setup(t);
  const first = payload(), second = payload();
  await call("submit", first);
  await call("submit", second);
  const [always, today] = ws.interactions.snapshot();
  ws.interactions.respond(always.id, { action: "remember" });
  await settle(call, first);
  ws.interactions.respond(today.id, { action: "today" });
  await settle(call, second);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 86400000 });
  const later = payload();
  await call("submit", later);
  assert.equal(ws.interactions.snapshot().length, 0);
  assert.equal((await settle(call, later)).status, "answered");
});

test("allow this time covers one message even when the target workspace normally approves all tools", async t => {
  const { ws, call, log } = setup(t);
  ws.setPreferences({ approval: "all" });
  const first = payload();
  await call("submit", first);
  const [card] = ws.interactions.snapshot();
  assert.equal(log.sent.length, 0);
  ws.interactions.respond(card.id, { action: "approve" });
  assert.equal((await settle(call, first)).status, "answered");
  assert.equal((await call("submit", first)).status, "answered");
  const next = payload();
  await call("submit", next);
  const [again] = ws.interactions.snapshot();
  assert.notEqual(again.id, card.id);
  assert.equal(log.sent.length, 1);
  ws.interactions.respond(again.id, { action: "deny" });
  assert.equal((await settle(call, next)).status, "denied");
  assert.equal(log.sent.length, 1);
});
