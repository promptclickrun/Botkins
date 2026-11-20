// What the workspace asks of the program it runs in.
//
// The workspace (desktop/runtime.mjs and everything it builds) is plain Node. A few things it
// needs are not: a window to show a chat in, a file dialog, the system's keychain, a picture of the
// screen. Each of those is asked of a `host`, and there are two:
//
//   desktop/host/electron.mjs   the desktop app. Everything is there.
//   desktop/host/headless.mjs   the terminal host (`botkins serve`): a service with no window and
//                               no display. What it has no way to do, it says it can't.
//
// A host answers every member below. One that can't do something throws `unavailable("…")` from
// that member, so a call that needs it fails with one plain sentence ("Choosing a file is not
// available on this host.") that reaches the phone or the terminal as it is, and nothing crashes.
//
//   kind             "desktop" or "terminal"
//   version          the app's version
//   packaged         true for an installed copy (it looks for updates by itself)
//   headless         true when there is no window of the app's own to look at
//   info()           → what "About" shows: { version, platform, … }
//   displayStatus()  → headless only: { available, kind?, note? }, whether there is a display to show a phone
//   keys({ dataDir, trial }) → Promise of { wrap(text) → wrapped, unwrap(wrapped) → text | null,
//                      earlier?(wrapped) → boolean, adopted? }, the store that wraps the vault's
//                      key and the phone link's; or null to keep those keys in files in the data folder
//   updates()        → the update service (desktop/updates.mjs, AppUpdates), or undefined
//   fetch(url, init) → the network, with the system's own settings where the host knows them
//   notifications    a class like Electron's Notification ({ isSupported() }, show(), on()), or null
//   images           what makes thumbnails (Electron's nativeImage), or null
//   screen           { displays(), capture(), permissions(), granted(), request(kind) }: pictures of the screen
//   shell            { openExternal(url), openPath(path), showItemInFolder(path) }
//   clipboard        { writeText(text) }
//   dialogs          { save(options) → path | null, open(options) → [paths] | null,
//                      ask(options) → index of the button chosen, error(title, text) }
//   paths            { documents() }
//   pdf(html)        → Promise of the document as a PDF
//   cache            { size() → bytes, clear() }: the window's own cache
//   theme            { set("light" | "dark" | "system") }
//   background       { apply(settings.background), refresh() }: what starts with the computer, and the tray icon
//   power            { onResume(fn) }: fn() after the computer wakes
//   window           the app's own window:
//                      focused()            → the person is looking at it
//                      viewing()            → the chat it shows, or null
//                      send(channel, value) → tells the page; true when there was a page to tell
//                      openChat(chatId), openSettings(tab)
//                      dictate()            → the system's dictation, into the focused field
//                      peerToPeer(on)       → lets the page talk peer to peer (a live voice) or not
//                      fillSecurePage(plan, values, signal) → types saved values into the page a chat shows

import { Failure } from "../link/tools.mjs";

/**
 * The error a host throws for what it has no way to do. Its message is one sentence a person can
 * read, and it is one of the link's own failures, so a phone is told that sentence as it is.
 */
export class HostUnavailable extends Failure {
  constructor(what) {
    super(what + " is not available on this host.");
    this.name = "HostUnavailable";
    this.code = "HOST_UNAVAILABLE";
  }
}

/** `throw unavailable("Choosing a file")` → "Choosing a file is not available on this host." */
export const unavailable = (what) => new HostUnavailable(what);

/** Every member a host has, as "name" or "group.name". A function unless marked otherwise. */
export const HOST_MEMBERS = {
  kind: "string",
  version: "string",
  packaged: "boolean",
  headless: "boolean",
  info: "function",
  displayStatus: "function",
  keys: "function",
  updates: "function",
  fetch: "function",
  notifications: "any",
  images: "any",
  "screen.displays": "function",
  "screen.capture": "function",
  "screen.permissions": "function",
  "screen.granted": "function",
  "screen.request": "function",
  "shell.openExternal": "function",
  "shell.openPath": "function",
  "shell.showItemInFolder": "function",
  "clipboard.writeText": "function",
  "dialogs.save": "function",
  "dialogs.open": "function",
  "dialogs.ask": "function",
  "dialogs.error": "function",
  "paths.documents": "function",
  pdf: "function",
  "cache.size": "function",
  "cache.clear": "function",
  "theme.set": "function",
  "background.apply": "function",
  "background.refresh": "function",
  "power.onResume": "function",
  "window.focused": "function",
  "window.viewing": "function",
  "window.send": "function",
  "window.openChat": "function",
  "window.openSettings": "function",
  "window.dictate": "function",
  "window.peerToPeer": "function",
  "window.fillSecurePage": "function",
};

/** The members of `host` that are missing or of the wrong kind: [] for a whole host. */
export function missingMembers(host) {
  const missing = [];
  for (const [path, kind] of Object.entries(HOST_MEMBERS)) {
    let value = host;
    for (const step of path.split(".")) value = value?.[step];
    if (kind === "any" ? value === undefined : typeof value !== kind) missing.push(path);
  }
  return missing;
}

/** Throws when `host` is not a whole host. Both hosts are checked as they are built, so a member added here can't be forgotten in one. */
export function checkHost(host) {
  const missing = missingMembers(host);
  if (missing.length) throw new Error("This host is missing: " + missing.join(", "));
  return host;
}
