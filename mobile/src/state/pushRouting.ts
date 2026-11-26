// Pure routing decisions for incoming push notifications and pending request taps.
// Kept free of React Native / Expo imports so it can be unit-tested directly under Node.
import { spaceRoute } from "../features/spaces/logic";

export type NotificationRouteTarget =
  | { pathname: "/node-approval"; params: { request?: string; chat?: string; host?: string } }
  | { pathname: "/open/answer"; params: { request: string; chat: string; host?: string } }
  | { pathname: "/settings/team"; params: { section: "requests" } }
  | "/settings/desktop"
  | { pathname: "/chat/[id]"; params: { id: string } }
  | ReturnType<typeof spaceRoute>;

export type NotificationTapInput = {
  chatId?: string;
  requestId?: string;
  host?: string;
  kind?: string;
  nodeJob?: boolean;
  actionIdentifier?: string;
  spaceId?: string;
  panelId?: string;
  activeHostId?: string;
  pairedHostIds: string[];
  chatOnScreen?: string;
};

export type NotificationRoutingDecision = {
  /** Non-empty when the phone should switch to another paired computer before/while navigating. */
  switchHost?: string;
  /** Target Expo Router destination, or null when nothing should open. */
  route: NotificationRouteTarget | null;
};

/** Synthetic chat ids created by a node host for remote operation approvals (not backed by a chat). */
export function isNodeJobChat(chatId: string | undefined): boolean {
  return typeof chatId === "string" && chatId.startsWith("node-job-");
}

/** True when a notification or pending request belongs to a node-host job rather than a real chat. */
export function isNodeJobRequest(input: { chatId?: string; nodeJob?: boolean } | null | undefined): boolean {
  if (!input) return false;
  return input.nodeJob === true || isNodeJobChat(input.chatId);
}

/** Destination when tapping a pending request row (for example in Home's NeedsYou list). */
export function routeForPendingRequest(request: { id: string; chatId: string; nodeJob?: boolean }, host?: string): NotificationRouteTarget {
  if (isNodeJobRequest(request)) {
    return {
      pathname: "/node-approval",
      params: {
        request: request.id,
        ...(request.chatId && { chat: request.chatId }),
        ...(host && { host }),
      },
    };
  }
  return { pathname: "/chat/[id]", params: { id: request.chatId } };
}

/**
 * Decides which host to switch to and which screen to open when a push notification is tapped.
 * Node-job permission notifications always open the dedicated approval sheet (`/node-approval`)
 * directly and never route to `/chat/[id]`.
 */
export function routeForNotification(input: NotificationTapInput): NotificationRoutingDecision {
  const { chatId, requestId, host, kind, nodeJob, actionIdentifier, spaceId, panelId, activeHostId, pairedHostIds, chatOnScreen } = input;
  const switchHost = host && host !== activeHostId && pairedHostIds.includes(host) ? host : undefined;

  if (isNodeJobRequest({ chatId, nodeJob })) {
    return {
      switchHost,
      route: {
        pathname: "/node-approval",
        params: {
          ...(requestId && { request: requestId }),
          ...(chatId && { chat: chatId }),
          ...(host && { host }),
        },
      },
    };
  }

  if (actionIdentifier === "approve.risky") {
    if (requestId && chatId) {
      return {
        route: { pathname: "/open/answer", params: { request: requestId, chat: chatId, ...(host && { host }) } },
      };
    }
    return { route: null };
  }

  if (!chatId && kind !== "team" && kind !== "update" && kind !== "space") {
    return { route: null };
  }

  if (kind === "team") {
    return { switchHost, route: { pathname: "/settings/team", params: { section: "requests" } } };
  }
  if (kind === "update") {
    return { switchHost, route: "/settings/desktop" };
  }
  if (kind === "space") {
    return { switchHost, route: spaceRoute(spaceId, panelId) };
  }
  if (!chatId) {
    return { switchHost, route: null };
  }
  if (chatOnScreen === chatId && !switchHost) {
    return { route: null };
  }
  return { switchHost, route: { pathname: "/chat/[id]", params: { id: chatId } } };
}
