// A host for tests (desktop/host/index.mjs): the headless one, with everything a test wants to
// answer or watch replaced. What it is asked is kept in `asked`, in order.
import { headlessHost } from "../desktop/host/headless.mjs";
import { checkHost } from "../desktop/host/index.mjs";

/** A stand-in for Electron's Notification: each one shown is kept in `Notification.shown`. */
export function fakeNotifications() {
  return class Notification {
    static shown = [];
    static isSupported = () => true;
    constructor(options) {
      this.options = options;
      this.handlers = {};
    }
    on(name, fn) {
      this.handlers[name] = fn;
    }
    show() {
      Notification.shown.push(this);
    }
    click() {
      this.handlers.click?.();
    }
  };
}

/**
 * @param answers.save / answers.open / answers.ask  What the dialogs answer: a value, or a function of the options.
 * @param answers.focused / answers.viewing          What the window says.
 * @param answers.keys                               The key store, as for headlessHost.
 * @returns the host, with `asked` ([[member, ...arguments]]) and `Notification`.
 */
export function fakeHost(answers = {}) {
  const asked = [];
  const note = (name, value) => (...args) => {
    asked.push([name, ...args]);
    return typeof value === "function" ? value(...args) : value;
  };
  const Notification = fakeNotifications();
  const base = headlessHost({ version: answers.version ?? "9.9.9", keys: answers.keys });
  const host = checkHost({
    ...base,
    kind: "test",
    headless: answers.headless ?? false,
    notifications: Notification,
    shell: { openExternal: note("shell.openExternal", Promise.resolve()), openPath: note("shell.openPath", Promise.resolve("")), showItemInFolder: note("shell.showItemInFolder") },
    clipboard: { writeText: note("clipboard.writeText") },
    dialogs: {
      save: note("dialogs.save", async (options) => (typeof answers.save === "function" ? answers.save(options) : answers.save ?? null)),
      open: note("dialogs.open", async (options) => (typeof answers.open === "function" ? answers.open(options) : answers.open ?? null)),
      ask: note("dialogs.ask", async (options) => (typeof answers.ask === "function" ? answers.ask(options) : answers.ask ?? 1)),
      error: note("dialogs.error"),
    },
    paths: { documents: () => answers.documents ?? "/documents" },
    pdf: note("pdf", async () => Buffer.from("%PDF-test")),
    theme: { set: note("theme.set") },
    background: { apply: note("background.apply", answers.background), refresh: note("background.refresh") },
    window: {
      ...base.window,
      focused: () => answers.focused === true,
      viewing: () => answers.viewing ?? null,
      send: note("window.send", true),
      openChat: note("window.openChat"),
      openSettings: note("window.openSettings"),
      peerToPeer: note("window.peerToPeer"),
    },
  });
  return Object.assign(host, { asked, Notification });
}
