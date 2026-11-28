// Pure helpers for opening a chat without stacking duplicates and de-duplicating notification taps.
// Kept free of React Native imports so Node tests can exercise both directly.

export type ChatParams = { id: string; draft?: string; board?: string; at?: string };
export type ChatHref = { pathname: "/chat/[id]"; params: ChatParams };
export type StackRoute = { name: string; params?: Record<string, unknown> };
export type StackState = { routes: readonly StackRoute[]; index?: number };

export type ChatRouter = {
  push: (href: ChatHref) => void;
  dismissTo: (href: ChatHref | "/") => void;
  setParams: (params: Record<string, string | undefined>) => void;
};

/** Route id for `chat/[id]` (`Stack.Screen dangerouslySingular`). Keyed on `params.id`. */
export function chatRouteId(_name: string, params: Record<string, unknown>): string | undefined {
  const id = params?.id;
  return typeof id === "string" && id ? id : undefined;
}

/** Whether `chat/[id]` for `id` is already in the active stack (and whether it is on top). */
export function chatInStack(state: StackState | undefined, id: string): "top" | "below" | "absent" {
  if (!state?.routes.length) return "absent";
  const top = state.index ?? state.routes.length - 1;
  const active = state.routes.slice(0, top + 1);
  for (let i = active.length - 1; i >= 0; i--) {
    const route = active[i];
    if (route?.name === "chat/[id]" && route.params?.id === id) return i === top ? "top" : "below";
  }
  return "absent";
}

/**
 * Navigates to `chat/[id]` without ever stacking the same chat twice:
 * - Already on top: updates any extra params (`draft`, `board`, `at`) in place and does not push.
 * - Already in the stack below another screen: pops back to it (`dismissTo`) so Back never repeats it.
 * - Absent (or stack state unavailable): pushes it (`dangerouslySingular` on the screen still guards against duplicates).
 */
export function navigateToChat(
  params: ChatParams,
  nav: ChatRouter,
  state?: StackState,
  options?: { resetToHome?: boolean },
): "noop" | "params" | "dismissTo" | "push" {
  const href: ChatHref = { pathname: "/chat/[id]", params };
  if (options?.resetToHome) {
    // Resetting to Home clears transient `/open/*` screens and any prior chat below it;
    // the synchronous `state` snapshot predates `dismissTo("/")`, so push directly after it.
    nav.dismissTo("/");
    nav.push(href);
    return "push";
  }
  const where = chatInStack(state, params.id);
  if (where === "top") {
    const extra: Record<string, string | undefined> = {};
    if (params.draft !== undefined) extra.draft = params.draft;
    if (params.board !== undefined) extra.board = params.board;
    if (params.at !== undefined) extra.at = params.at;
    if (Object.keys(extra).length === 0) return "noop";
    nav.setParams(extra);
    return "params";
  }
  if (where === "below") {
    nav.dismissTo(href);
    return "dismissTo";
  }
  nav.push(href);
  return "push";
}

export type NotificationResponseLike = {
  actionIdentifier?: string;
  notification?: { request?: { identifier?: string } };
};

/**
 * Tracks handled notification responses by `(request.identifier, actionIdentifier)` so the
 * cold-start `getLastNotificationResponse()` path and `addNotificationResponseReceivedListener`
 * (or a re-render before `clearLastNotificationResponse()` settles) cannot handle the same tap twice.
 */
export function createResponseDeduper(maxEntries = 32) {
  const seen = new Set<string>();
  return {
    /** Returns `true` the first time this response is seen; `false` for duplicates. */
    claim(response: NotificationResponseLike | null | undefined): boolean {
      const id = response?.notification?.request?.identifier;
      if (!id) return true;
      const key = id + "\0" + (response.actionIdentifier ?? "");
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > maxEntries) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
    reset() {
      seen.clear();
    },
  };
}
