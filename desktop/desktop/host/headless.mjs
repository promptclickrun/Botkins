// A host with no window and no display (desktop/host/index.mjs): what the terminal host
// (`botkins serve`) runs the workspace on, under plain Node, with no Electron.
//
// What a server can do, it does: the network, the key store that guards secrets at rest
// (desktop/host/keystore.mjs), updates. What needs a desktop it refuses with one sentence
// ("Choosing a file is not available on this host."), through `unavailable`, so the phone or the
// terminal that asked is told exactly that. Nothing here throws at start-up: a refusal happens
// when the thing is asked for.
//
// A phone needs none of the refused calls: every one has a call that opens nothing on the
// computer (desktop/link/methods.mjs: a file goes out and comes in as text, a folder is chosen
// from "listFolders"), and those work here as they do in the desktop app.
import { homedir } from "node:os";
import { join } from "node:path";
import { checkHost, unavailable } from "./index.mjs";
import { ScreenBrowser } from "./form-browser.mjs";
import { x11Screen } from "./x11screen.mjs";

/** What stays desktop-only, by the name `botkins doctor` and the docs give it. */
export const DESKTOP_ONLY = [
  "Viewing and controlling the screen, unless the service is given an X11 display (DISPLAY)",
  "The app's window: side panes, html apps in their own window, the side-pane website viewer (Linux with X11 can fill a form in Chromium on its screen)",
  "File and folder dialogs, opening a file or a link on the computer, and the clipboard",
  "Desktop notifications (a paired phone is still notified)",
  "Dictation and live voice in the app's own window (a phone's voice still works)",
  "Exporting the wiki as a PDF",
  "Picture thumbnails of files",
  "Using another computer's Botkins from this one",
];

/**
 * @param options.version   The app's version.
 * @param options.packaged  True for an installed copy, which looks for updates by itself.
 * @param options.keys      ({ dataDir, trial }) → the key store, or null to keep keys in files (desktop/host/keystore.mjs).
 * @param options.updates   () → the update service, or undefined when this copy can't update itself.
 * @param options.fetch     The network. Tests pass their own.
 * @param options.log       (line) → where a note for the person who runs the service goes.
 * @param options.env       The environment. On Linux, DISPLAY (and XAUTHORITY) give a phone the X11 screen (desktop/host/x11screen.mjs).
 */
export function headlessHost({ version, packaged = false, keys = async () => null, updates = () => undefined, fetch = (url, init) => globalThis.fetch(url, init), log = () => {}, env = process.env, platform = process.platform } = {}) {
  const refuse = (what) => () => {
    throw unavailable(what);
  };
  const refuseLater = (what) => async () => {
    throw unavailable(what);
  };
  const resumed = new Set();
  const x11 = platform === "linux" && /^[\w.-]*:\d+(\.\d+)?$/.test(env.DISPLAY ?? "") ? x11Screen({ display: env.DISPLAY, xauthority: env.XAUTHORITY || undefined }) : null;
  return checkHost({
    kind: "terminal",
    version: String(version ?? "0.0.0"),
    packaged,
    headless: true,
    // The shape "About" on a phone reads; it shows the Electron and Chromium rows only when they say something.
    info: () => ({ version: String(version ?? "0.0.0"), electron: "", chrome: "", node: process.versions.node, platform: process.platform, host: "terminal" }),
    displayStatus: () => (x11 ? { available: true, kind: "x11" } : { available: false, note: "This host has no display." }),
    keys,
    updates,
    fetch,
    notifications: null,
    images: null,
    ...(x11 && { formBrowser: new ScreenBrowser({ env }) }),
    screen: x11 ?? {
      displays: refuseLater("Viewing the screen"),
      capture: refuseLater("Viewing the screen"),
      permissions: async () => ({ screenRecording: false, accessibility: false }),
      granted: () => ({ system: false, screenRecording: false, accessibility: false }),
      request: refuseLater("Viewing the screen"),
    },
    shell: {
      openExternal: refuseLater("Opening a web page in a browser"),
      openPath: refuseLater("Opening a file or folder"),
      showItemInFolder: refuse("Showing a file in its folder"),
    },
    clipboard: { writeText: refuse("The clipboard") },
    dialogs: {
      save: refuseLater("Choosing where to save a file"),
      open: refuseLater("Choosing a file or folder"),
      ask: refuseLater("Asking a question on the computer's screen"),
      // Where the desktop app would put up an error box, the service's log gets the line.
      error: (title, text) => log(title + ": " + text),
    },
    paths: { documents: () => join(homedir(), "Documents") },
    pdf: refuseLater("Exporting a PDF"),
    // The cache is the window's own; a host without one has nothing to count or clear.
    cache: { size: async () => 0, clear: async () => {} },
    // How the app looks and what starts with the computer are the service manager's and nobody's: saved, and nothing to apply.
    theme: { set() {} },
    background: { apply() {}, refresh() {} },
    // A server doesn't sleep the way a laptop does. `resumed()` is there for a program that knows it woke.
    power: { onResume: (fn) => void resumed.add(fn) },
    resumed: () => {
      for (const fn of resumed) fn();
    },
    window: {
      focused: () => false,
      viewing: () => null,
      // There is no page to tell.
      send: () => false,
      openChat() {},
      openSettings() {},
      dictate() {},
      peerToPeer() {},
      fillSecurePage: refuseLater("Typing a saved credential into a page"),
    },
  });
}
