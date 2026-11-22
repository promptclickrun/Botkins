// What a hold on a link in a message offers (LinkHold.tsx draws it). Plain logic, no React Native
// imports, so the tests can run it. The menu is the message's own native menu with other items
// while a link is under the finger, so each item's id carries its link: a menu can be answered
// after the link has been let go.
import type { MenuAction } from "@react-native-menu/menu";

export type LinkChoice = "open" | "copy" | "share";

const PREFIX = "link-";
const WEB = /^https?:\/\//i;

/** Only web links open in the in-app browser; a mailto: or tel: link is only copied or shared. */
export const isWebLink = (url: string) => WEB.test(url);

function decoded(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** What "Copy link" puts on the clipboard: a web link as written, an email address or a phone number without its scheme. */
export function linkText(url: string): string {
  if (/^mailto:/i.test(url)) return decoded(url.slice(7).split("?")[0]!);
  if (/^tel:/i.test(url)) return decoded(url.slice(4).split(/[;?]/)[0]!);
  return url;
}

/** The menu's title: the link, cut short. */
export function linkTitle(url: string, max = 56): string {
  const text = linkText(url);
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** The items for a link: Open link (web links), Copy link (or email address, phone number) and Share…. */
export function linkActions(url: string): MenuAction[] {
  const copy = /^mailto:/i.test(url) ? "Copy email address" : /^tel:/i.test(url) ? "Copy phone number" : "Copy link";
  return [
    ...(isWebLink(url) ? [{ id: PREFIX + "open:" + url, title: "Open link", image: "safari" }] : []),
    { id: PREFIX + "copy:" + url, title: copy, image: "doc.on.doc" },
    { id: PREFIX + "share:" + url, title: "Share…", image: "square.and.arrow.up" },
  ];
}

/** Reads a menu item's id back: which choice, for which link. `null` for any other item (the message's own). */
export function parseLinkAction(id: string): { choice: LinkChoice; url: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const colon = rest.indexOf(":");
  const choice = rest.slice(0, colon);
  if (colon < 0 || (choice !== "open" && choice !== "copy" && choice !== "share")) return null;
  return { choice, url: rest.slice(colon + 1) };
}
