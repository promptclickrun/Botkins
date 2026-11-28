// Routing tests for node-host approval notifications and pending request taps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNodeJobChat, isNodeJobRequest, routeForNotification, routeForPendingRequest } from "../src/state/pushRouting";

test("identifies synthetic node-job chat ids and nodeJob flags", () => {
  assert.equal(isNodeJobChat("node-job-42"), true);
  assert.equal(isNodeJobChat("chat-42"), false);
  assert.equal(isNodeJobChat(undefined), false);
  assert.equal(isNodeJobRequest({ nodeJob: true, chatId: "anything" }), true);
  assert.equal(isNodeJobRequest({ chatId: "node-job-7" }), true);
  assert.equal(isNodeJobRequest({ chatId: "chat-7" }), false);
});

test("node-job push notification opens /node-approval directly and never /chat/[id]", () => {
  const decision = routeForNotification({
    chatId: "node-job-15",
    requestId: "req-99",
    host: "host-node",
    kind: "request",
    nodeJob: true,
    activeHostId: "host-node",
    pairedHostIds: ["host-source", "host-node"],
  });
  assert.equal(decision.switchHost, undefined);
  assert.deepEqual(decision.route, {
    pathname: "/node-approval",
    params: { request: "req-99", chat: "node-job-15", host: "host-node" },
  });
});

test("node-job push from a different paired host switches to that host and opens /node-approval", () => {
  const decision = routeForNotification({
    chatId: "node-job-16",
    requestId: "req-100",
    host: "host-node",
    kind: "request",
    nodeJob: true,
    activeHostId: "host-source",
    pairedHostIds: ["host-source", "host-node"],
  });
  assert.equal(decision.switchHost, "host-node");
  assert.deepEqual(decision.route, {
    pathname: "/node-approval",
    params: { request: "req-100", chat: "node-job-16", host: "host-node" },
  });
});

test("fallback node-job-* chatId without explicit nodeJob flag still opens /node-approval", () => {
  const decision = routeForNotification({
    chatId: "node-job-23",
    requestId: "req-101",
    host: "host-node",
    kind: "request",
    activeHostId: "host-source",
    pairedHostIds: ["host-source", "host-node"],
  });
  assert.equal(decision.switchHost, "host-node");
  assert.deepEqual(decision.route, {
    pathname: "/node-approval",
    params: { request: "req-101", chat: "node-job-23", host: "host-node" },
  });
});

test("approve.risky on a node-job notification routes to /node-approval instead of /open/answer chat screen", () => {
  const decision = routeForNotification({
    chatId: "node-job-24",
    requestId: "req-102",
    host: "host-node",
    kind: "request",
    nodeJob: true,
    actionIdentifier: "approve.risky",
    activeHostId: "host-source",
    pairedHostIds: ["host-source", "host-node"],
  });
  assert.equal(decision.switchHost, "host-node");
  assert.deepEqual(decision.route, {
    pathname: "/node-approval",
    params: { request: "req-102", chat: "node-job-24", host: "host-node" },
  });
});

test("regular chat notification still opens /chat/[id] and skips if already on screen", () => {
  const open = routeForNotification({
    chatId: "chat-1",
    requestId: "req-1",
    host: "host-a",
    kind: "request",
    activeHostId: "host-a",
    pairedHostIds: ["host-a", "host-b"],
  });
  assert.equal(open.switchHost, undefined);
  assert.deepEqual(open.route, { pathname: "/chat/[id]", params: { id: "chat-1" } });

  const sameScreen = routeForNotification({
    chatId: "chat-1",
    host: "host-a",
    kind: "request",
    activeHostId: "host-a",
    pairedHostIds: ["host-a"],
    chatOnScreen: "chat-1",
  });
  assert.equal(sameScreen.route, null);
});

test("Home NeedsYou pending request routes nodeJob to /node-approval and regular requests to /chat/[id]", () => {
  assert.deepEqual(routeForPendingRequest({ id: "r1", chatId: "node-job-5", nodeJob: true }), {
    pathname: "/node-approval",
    params: { request: "r1", chat: "node-job-5" },
  });
  assert.deepEqual(routeForPendingRequest({ id: "r2", chatId: "chat-5" }), {
    pathname: "/chat/[id]",
    params: { id: "chat-5" },
  });
});
