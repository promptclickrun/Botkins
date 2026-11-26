// Tests for singular chat navigation (no duplicate stacking) and notification response de-duplication.
// Also drives expo-router's real StackRouter with our `chatRouteId` to verify cold/warm stack transitions.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  type ChatHref,
  chatInStack,
  chatRouteId,
  createResponseDeduper,
  navigateToChat,
  type NotificationResponseLike,
  type StackState,
} from "../src/features/chat/chatNavigation";

const require = createRequire(import.meta.url);
const { StackRouter } = require("../node_modules/expo-router/build/react-navigation/routers/StackRouter.js") as {
  StackRouter: (options: Record<string, unknown>) => {
    getStateForAction: (state: any, action: any, options: any) => { state: any };
  };
};

/** Minimal real expo-router StackRouter harness configured the same way `_layout.tsx` configures `chat/[id]`. */
function createStackHarness(initialRoutes: { name: string; params?: Record<string, unknown> }[]) {
  const router = StackRouter({});
  const routeNames = ["(tabs)", "chat/[id]", "bot/[id]/index", "open/chat/[id]", "artifacts/view"];
  const options = {
    routeNames,
    routeParamList: {},
    routeGetIdList: {
      "chat/[id]": (o: { params?: Record<string, unknown> }) => chatRouteId("chat/[id]", o.params ?? {}),
    },
  };
  let seq = 1;
  let state: any = {
    stale: false,
    type: "stack",
    key: "root-stack",
    index: initialRoutes.length - 1,
    routeKeySeq: initialRoutes.length + 1,
    routeNames,
    routes: initialRoutes.map((r) => ({ ...r, key: `${r.name}-${seq++}` })),
  };
  const calls: { op: string; arg: unknown }[] = [];

  const dispatch = (action: any) => {
    const res = router.getStateForAction(state, action, options);
    assert.ok(res && res.state, `unhandled action ${action.type}`);
    state = res.state;
  };

  const nav = {
    push(href: ChatHref) {
      calls.push({ op: "push", arg: href });
      dispatch({ type: "PUSH", payload: { name: "chat/[id]", params: href.params } });
    },
    dismissTo(href: ChatHref | "/") {
      calls.push({ op: "dismissTo", arg: href });
      if (href === "/") dispatch({ type: "POP_TO", payload: { name: "(tabs)" } });
      else dispatch({ type: "POP_TO", payload: { name: "chat/[id]", params: href.params } });
    },
    setParams(params: Record<string, string | undefined>) {
      calls.push({ op: "setParams", arg: params });
      const top = state.routes[state.index];
      state = {
        ...state,
        routes: state.routes.map((r: any, i: number) => (i === state.index ? { ...r, params: { ...r.params, ...params } } : r)),
      };
      void top;
    },
    pushScreen(name: string, params?: Record<string, unknown>) {
      dispatch({ type: "PUSH", payload: { name, params } });
    },
    goBack() {
      dispatch({ type: "GO_BACK" });
    },
  };

  const routeIds = () =>
    (state.routes as { name: string; params?: Record<string, unknown> }[]).map((r) =>
      r.name === "chat/[id]" ? `chat:${r.params?.id}` : r.name,
    );

  return {
    get state(): StackState {
      return state;
    },
    calls,
    nav,
    routeIds,
  };
}

function response(identifier: string, actionIdentifier = "expo.modules.notifications.actions.DEFAULT"): NotificationResponseLike {
  return { actionIdentifier, notification: { request: { identifier } } };
}

test("chatRouteId keys chat/[id] by params.id", () => {
  assert.equal(chatRouteId("chat/[id]", { id: "alfie-1" }), "alfie-1");
  assert.equal(chatRouteId("chat/[id]", { id: "" }), undefined);
  assert.equal(chatRouteId("chat/[id]", {}), undefined);
});

test("navigateToChat: same chat already on top is a no-op (or updates extra params in place)", () => {
  const stack = createStackHarness([{ name: "(tabs)" }, { name: "chat/[id]", params: { id: "alfie" } }]);
  const result = navigateToChat({ id: "alfie" }, stack.nav, stack.state);
  assert.equal(result, "noop");
  assert.equal(stack.calls.length, 0);
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie"]);

  // Updating extra params (e.g. jump to message `at`) updates params without stacking a copy.
  const withAt = navigateToChat({ id: "alfie", at: "42" }, stack.nav, stack.state);
  assert.equal(withAt, "params");
  assert.deepEqual(stack.calls, [{ op: "setParams", arg: { at: "42" } }]);
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie"]);
  assert.equal(stack.state.routes[1].params?.at, "42");
});

test("navigateToChat: chat already in the stack under another screen pops back to it instead of stacking", () => {
  const stack = createStackHarness([
    { name: "(tabs)" },
    { name: "chat/[id]", params: { id: "alfie" } },
    { name: "bot/[id]/index", params: { id: "bot-alfie" } },
  ]);
  assert.equal(chatInStack(stack.state, "alfie"), "below");

  const result = navigateToChat({ id: "alfie" }, stack.nav, stack.state);
  assert.equal(result, "dismissTo");
  assert.equal(stack.calls[0]?.op, "dismissTo");
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie"]);

  // One back press now leaves the chat straight to Home.
  stack.nav.goBack();
  assert.deepEqual(stack.routeIds(), ["(tabs)"]);
});

test("navigateToChat: a different chat pushes normally and preserves the previous chat underneath", () => {
  const stack = createStackHarness([{ name: "(tabs)" }, { name: "chat/[id]", params: { id: "alfie" } }]);

  const result = navigateToChat({ id: "gordie" }, stack.nav, stack.state);
  assert.equal(result, "push");
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie", "chat:gordie"]);

  // Returning to alfie from gordie pops gordie instead of stacking alfie again.
  const back = navigateToChat({ id: "alfie" }, stack.nav, stack.state);
  assert.equal(back, "dismissTo");
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie"]);
});

test("dangerouslySingular on StackRouter prevents duplicates even when stack state is unavailable during transition", () => {
  const stack = createStackHarness([{ name: "(tabs)" }, { name: "chat/[id]", params: { id: "alfie" } }]);
  // Simulate calling navigateToChat without stack state (e.g. navigationRef not yet ready or race).
  const first = navigateToChat({ id: "alfie" }, stack.nav, undefined);
  const second = navigateToChat({ id: "alfie" }, stack.nav, undefined);
  assert.equal(first, "push");
  assert.equal(second, "push");
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie"]);
});

test("notification response deduper handles each (identifier, actionIdentifier) once", () => {
  const deduper = createResponseDeduper();
  const tap = response("req-1");
  assert.equal(deduper.claim(tap), true);
  assert.equal(deduper.claim(tap), false);
  // Same request identifier with a different action identifier is distinct.
  assert.equal(deduper.claim(response("req-1", "alert.take")), true);
  assert.equal(deduper.claim(response("req-1", "alert.take")), false);
  // A new notification tap is handled normally.
  assert.equal(deduper.claim(response("req-2")), true);
});

test("notification tap on cold start: getLastNotificationResponse + listener fire for the same tap -> one navigation", () => {
  const deduper = createResponseDeduper();
  const stack = createStackHarness([{ name: "(tabs)" }]);
  const tap = response("routine-alfie-1");

  const openFrom = (res: NotificationResponseLike | null, chatId: string) => {
    if (!res || !deduper.claim(res)) return;
    navigateToChat({ id: chatId }, stack.nav, stack.state);
  };

  // Both listener and getLastNotificationResponse deliver the same tap during cold start.
  openFrom(tap, "alfie");
  openFrom(tap, "alfie");

  assert.equal(stack.calls.length, 1);
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie"]);
});

test("notification tap on warm start: tapping repeated routine notifications for Alfie never stacks", () => {
  const deduper = createResponseDeduper();
  const stack = createStackHarness([
    { name: "(tabs)" },
    { name: "chat/[id]", params: { id: "alfie" } },
    { name: "artifacts/view", params: { id: "art-1" } },
  ]);

  const openFrom = (res: NotificationResponseLike | null, chatId: string) => {
    if (!res || !deduper.claim(res)) return;
    navigateToChat({ id: chatId }, stack.nav, stack.state);
  };

  // Routine 1 notification arrives while user is on an artifact opened from Alfie's chat.
  openFrom(response("routine-1"), "alfie");
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie"]);

  // Routine 2 notification arrives while Alfie's chat is already on top.
  openFrom(response("routine-2"), "alfie");
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie"]);

  // One back press returns straight to Home.
  stack.nav.goBack();
  assert.deepEqual(stack.routeIds(), ["(tabs)"]);
});

test("deep link resetToHome over existing chat clears /open/chat/[id] without duplicating Home or chat", () => {
  const stack = createStackHarness([
    { name: "(tabs)" },
    { name: "chat/[id]", params: { id: "alfie" } },
    { name: "open/chat/[id]", params: { id: "alfie" } },
  ]);

  // showChat(id) calls navigateToChat({ id }, router, state, { resetToHome: true }).
  const result = navigateToChat({ id: "alfie" }, stack.nav, stack.state, { resetToHome: true });
  assert.equal(result, "push");
  assert.deepEqual(stack.calls.map((c) => c.op), ["dismissTo", "push"]);
  assert.deepEqual(stack.routeIds(), ["(tabs)", "chat:alfie"]);
  stack.nav.goBack();
  assert.deepEqual(stack.routeIds(), ["(tabs)"]);
});
