// Opens a chat screen without ever stacking the same chat id twice.
import { router } from "expo-router";
import { navigationRef } from "expo-router/build/global-state/navigationRef";
import { type ChatParams, navigateToChat, type StackState } from "./chatNavigation";

export { chatInStack, chatRouteId, navigateToChat, type ChatParams } from "./chatNavigation";

function rootStackState(): StackState | undefined {
  if (!navigationRef.isReady()) return undefined;
  return navigationRef.getRootState() as StackState | undefined;
}

/**
 * Navigates to a chat without pushing a duplicate copy of the same chat id:
 * already on top -> update extra params in place (or no-op);
 * in the stack under another screen -> pop back to it;
 * absent -> push.
 */
export function openChat(id: string, extra?: Omit<ChatParams, "id">, options?: { resetToHome?: boolean }) {
  const params: ChatParams = {
    id,
    ...(extra?.draft !== undefined && { draft: extra.draft }),
    ...(extra?.board !== undefined && { board: extra.board }),
    ...(extra?.at !== undefined && { at: extra.at }),
  };
  navigateToChat(params, router, rootStackState(), options);
}
