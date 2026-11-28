// Going to a place. A tab that is on the bar is shown as its tab; one that is not opens as a page
// with a back button (a tab left off the bar can't be shown as a tab: the phone's bar takes no
// route it doesn't show). Every other place has a page of its own.
import { type Href, router } from "expo-router";
import { usePrefs } from "@/state/prefs";
import type { PinId } from "@/state/tabs";
import { isPin, type PlaceId, placeRoute } from "./places";

const TAB_ROUTES: Record<PinId, string> = { home: "/home", chats: "/chats", spaces: "/spaces", work: "/work", market: "/market" };

/** Whether a tab is on the bar now. */
export const onBar = (id: PinId) => usePrefs.getState().bar.includes(id);

export function openPlace(id: PlaceId) {
  if (!isPin(id)) {
    const route = placeRoute(id);
    if (route) router.push(route as Href);
    return;
  }
  if (onBar(id)) router.navigate(TAB_ROUTES[id] as Href);
  else router.push({ pathname: "/place/[id]", params: { id } } as unknown as Href);
}

/**
 * Back to the Chats list from a page over it, when a chat is left for good: its tab when Chats is on
 * the bar, otherwise the first screen.
 */
export function backToChats() {
  router.dismissTo((onBar("chats") ? "/chats" : "/") as Href);
}
