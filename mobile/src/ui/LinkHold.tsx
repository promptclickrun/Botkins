// A hold on a link inside a message offers that link's menu (Open link, Copy link, Share…) and not
// the message's.
//
// The message's menu is one native menu around the whole message (HoldMenu), and it can't be told
// to stay shut: on iOS it is a context menu interaction, and on Android the menu view takes every
// touch itself and opens on its own long press, whatever the text inside does with the press. So
// the link doesn't fight it. The link's press only says which link the finger is on (`begin`), and
// the same menu is given that link's items to open with. Both platforms read a menu's items when it
// opens, a few hundred milliseconds after the finger lands, long after a state update has arrived.
//
// - A link says so on press-in; when the press ends, `end` takes the link back after a moment. A tap,
//   or a press that wanders off, leaves the message's own menu in place again.
// - On Android a menu answers with the item at a position in the *current* items, so the items must
//   not change while it is open: `end` leaves them until `onCloseMenu`. (An iOS menu item carries its
//   own id and needs no wait.)
// - A press held as long as a hold is not a tap (`isTap`): a finger lifted after the menu opened must
//   not also open the link. Text has no `delayLongPress`, so its own long press (500 ms) comes after
//   a menu that opens at about 400.
import type { MenuComponentProps } from "@react-native-menu/menu";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Share } from "react-native";
import { showToast } from "@/state/store";
import { HoldMenu } from "./HoldMenu";
import { isWebLink, type LinkChoice, linkActions, linkText, linkTitle, parseLinkAction } from "./linkMenu";
import { HOLD_MS } from "./Tap";

/** What a link in a message calls. `null` outside a TextHoldMenu: a link then only opens on a tap. */
export type LinkHoldApi = { begin: (url: string) => void; end: () => void; isTap: () => boolean };
export const LinkHold = createContext<LinkHoldApi | null>(null);

/** How long a link stays chosen after the finger leaves it; the menu has opened long before. */
const RELEASE_MS = 250;
const nothing = () => {};

export function openLink(url: string) {
  if (!isWebLink(url)) return;
  void WebBrowser.openBrowserAsync(url).catch(() => {});
}

/** Press handlers for a link's `Text`: a tap opens it; inside a TextHoldMenu, a hold offers its menu instead. */
export function linkPress(hold: LinkHoldApi | null, url: string, open: () => void) {
  if (!hold) return { onPress: open };
  // A long-press handler is what stops Text from calling onPress when a held press ends.
  return { onPress: () => hold.isTap() && open(), onPressIn: () => hold.begin(url), onPressOut: hold.end, onLongPress: nothing };
}

export const MessageLink = createContext(openLink);

function runChoice(choice: LinkChoice, url: string, open: (url: string) => void) {
  if (choice === "open") open(url);
  else if (choice === "copy") void Clipboard.setStringAsync(linkText(url)).then(() => showToast("Copied", "success"));
  else void Share.share({ message: linkText(url) }).catch(() => {});
}

type TextHoldMenuProps = Omit<MenuComponentProps, "shouldOpenOnLongPress" | "onPressAction"> & {
  onPressAction: NonNullable<MenuComponentProps["onPressAction"]>;
};

/**
 * A HoldMenu around a message's text. A hold on a link in `children` (a Markdown) opens that link's
 * menu; a hold anywhere else opens `actions`, as a HoldMenu does.
 */
export function TextHoldMenu({ actions, onPressAction, onOpenMenu, onCloseMenu, title, children, ...props }: TextHoldMenuProps) {
  const open = useContext(MessageLink);
  const [url, setUrl] = useState<string>();
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const waiting = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const api = useMemo<LinkHoldApi>(
    () => ({
      begin: (next) => {
        clearTimeout(timer.current);
        startedAt.current = Date.now();
        setUrl(next);
      },
      end: () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => !waiting.current && setUrl(undefined), RELEASE_MS);
      },
      isTap: () => Date.now() - startedAt.current < HOLD_MS,
    }),
    [],
  );
  return (
    <HoldMenu
      {...props}
      title={url ? linkTitle(url) : title}
      actions={url ? linkActions(url) : actions}
      onOpenMenu={() => {
        // Only Android needs the wait. iOS can report an open menu that then never shows, and
        // would never report it closed.
        waiting.current = Platform.OS === "android";
        onOpenMenu?.();
      }}
      onCloseMenu={() => {
        waiting.current = false;
        setUrl(undefined);
        onCloseMenu?.();
      }}
      onPressAction={(event) => {
        const link = parseLinkAction(event.nativeEvent.event);
        if (link) runChoice(link.choice, link.url, open);
        else onPressAction(event);
      }}
    >
      <LinkHold.Provider value={api}>{children}</LinkHold.Provider>
    </HoldMenu>
  );
}
