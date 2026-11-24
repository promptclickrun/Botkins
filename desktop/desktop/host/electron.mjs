// The desktop app as a host (desktop/host/index.mjs): everything the workspace asks for, done with
// Electron. The app's window, its tray icon and what starts with the computer stay in
// desktop/main.mjs, which hands this the few things of its own that the answers need.
import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} from "electron";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { env } from "../home.mjs";
import { hasEarlierKeychain, keyStore, lockedKeys, openWithEarlierKeychain } from "../keychain.mjs";
import { desktopUpdates } from "../mac-update.mjs";
import { screenAdapter } from "../screenshare.mjs";
import { releasePage } from "../updates.mjs";
import { checkHost } from "./index.mjs";

/** Prints a document to PDF in a hidden window that runs no scripts and loads nothing from anywhere. */
async function pdfOf(html) {
  const ses = session.fromPartition("botkins-wiki-export");
  const file = join(app.getPath("temp"), "botkins-export-" + randomUUID() + ".html");
  // The hidden window loads the document being printed and inline data, and nothing else.
  const own = pathToFileURL(file).href;
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url === own || /^(data|blob|about):/i.test(details.url)) }));
  await writeFile(file, html, { mode: 0o600 });
  const printer = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await printer.loadFile(file);
    return await printer.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally {
    printer.destroy();
    await rm(file, { force: true });
  }
}

/** What Electron's safeStorage wraps a key with: the system keychain's own key. */
const own = {
  wrap: (text) => safeStorage.encryptString(text).toString("base64"),
  unwrap: (data) => {
    try {
      return safeStorage.decryptString(Buffer.from(data, "base64"));
    } catch {
      return null;
    }
  },
};

/**
 * @param options.window          () → the app's window, or nothing when there is none.
 * @param options.showWindow      Opens the window, or brings it to the front.
 * @param options.viewing         () → the chat open in the window, or null.
 * @param options.fillSecurePage  (plan, values, signal) → fills the page a chat's viewer shows.
 * @param options.startup         "Run at startup" on this system (desktop/startup.mjs).
 * @param options.syncTray        Makes the tray icon agree with the settings.
 */
export function electronHost({ window, showWindow, viewing, fillSecurePage, startup, syncTray }) {
  const live = () => {
    const win = window();
    return win && !win.isDestroyed() ? win : null;
  };
  /** Shows the window and tells its page, once the page can hear. */
  const tell = (channel, value) => {
    showWindow();
    const win = window();
    const deliver = () => window()?.webContents.send(channel, value);
    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => setTimeout(deliver, 300));
    else deliver();
  };
  /**
   * Whether the system keychain guards this run's keys. A trial run (a data folder of its own)
   * never asks it, so it can never put a keychain question on the person's screen, unless
   * BOTKINS_KEYCHAIN=1 asks for a deliberate check; and only the installed app has a keychain
   * entry of its own to ask.
   */
  const guarded = (trial) => app.isPackaged && (!trial || env("KEYCHAIN") === "1") && safeStorage.isEncryptionAvailable();
  return checkHost({
    kind: "desktop",
    version: app.getVersion(),
    packaged: app.isPackaged,
    headless: false,
    info: () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
    }),
    displayStatus: () => ({ available: true }),
    /** The keychain's own wrapping, for what the desktop app keeps besides the vault and the link (the computers it is paired to); null in a run that doesn't ask the keychain. */
    protect: ({ trial, profile = false }) => {
      if (!guarded(trial)) return null;
      if (profile && process.platform === "linux") {
        const backend = safeStorage.getSelectedStorageBackend();
        if (backend === "basic_text" || backend === "unknown") return null;
      }
      return own;
    },
    // In the installed app the vault's key and the link's are wrapped by the system keychain. A
    // development run keeps them in files in its own data folder, so it never asks for keychain access.
    async keys({ dataDir, trial }) {
      if (!guarded(trial)) return null;
      // Keys wrapped by an earlier version sit under that name's keychain entry. A
      // helper process opens them once (desktop/keychain.mjs); macOS asks the person to allow it.
      const locked = lockedKeys(dataDir, own.unwrap);
      let earlier = new Map();
      if (locked.length && hasEarlierKeychain()) {
        // Said first, so the system's question that follows makes sense. Once is enough: this start
        // saves both keys under Botkins' own keychain entry.
        const { response } = await dialog.showMessageBox({
          type: "info",
          buttons: ["Continue", "Not now"],
          defaultId: 0,
          cancelId: 1,
          message: "Allow Botkins to use your saved keys",
          detail: "Your credentials and paired phones are protected by a keychain entry from an earlier version. macOS will ask whether Botkins may use it. Enter your password and choose Allow.\n\nIf you choose Not now, they stay locked and untouched, and Botkins asks again next time.",
        });
        if (response === 0) earlier = await openWithEarlierKeychain(locked, { args: app.isPackaged ? [] : [app.getAppPath()] });
      }
      // `adopted`: a key was opened with the earlier entry, so what holds it is saved again under Botkins' own.
      return Object.assign(keyStore(own, earlier), { adopted: earlier.size > 0 });
    },
    updates({ auto, idle }) {
      const updates = desktopUpdates({ app, native: autoUpdater, auto, idle, notify: version => {
        if (!Notification.isSupported()) return;
        const note = new Notification({ title: "Botkins update available", body: "Version " + version + " is available. Click to review it." });
        note.on("click", async () => {
          showWindow();
          const install = updates.state.canInstall;
          const choice = await dialog.showMessageBox(window(), { message: "Botkins " + version + " is available.",
            detail: install ? "Download the update and restart Botkins. Active chats resume after restart." : "View the release and its downloads on GitHub.",
            buttons: [install ? "Update and restart" : "Open release", "Later"], cancelId: 1 });
          if (choice.response !== 0) return;
          if (!install) return shell.openExternal(releasePage);
          try { await updates.install(); } catch (error) { dialog.showErrorBox("Botkins update", error.message); }
        });
        note.show();
      } });
      return updates;
    },
    fetch: (url, init) => net.fetch(url, init),
    notifications: Notification,
    images: nativeImage,
    // Pictures of the screen for a phone that may watch it (desktop/screenshare.mjs).
    screen: screenAdapter({ screen, desktopCapturer, systemPreferences, openExternal: (url) => shell.openExternal(url) }),
    shell: {
      openExternal: (url) => shell.openExternal(url),
      openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => shell.showItemInFolder(path),
    },
    clipboard: { writeText: (text) => clipboard.writeText(text) },
    dialogs: {
      async save(options) {
        const { canceled, filePath } = await dialog.showSaveDialog(window(), options);
        return canceled || !filePath ? null : filePath;
      },
      async open(options) {
        const result = await dialog.showOpenDialog(window(), options);
        return result.canceled ? null : result.filePaths;
      },
      ask: async (options) => (await dialog.showMessageBox(window(), options)).response,
      error: (title, text) => dialog.showErrorBox(title, text),
    },
    paths: { documents: () => app.getPath("documents") },
    pdf: pdfOf,
    cache: {
      size: () => session.defaultSession.getCacheSize(),
      clear: () => session.defaultSession.clearCache(),
    },
    theme: {
      set(source) {
        nativeTheme.themeSource = source;
      },
    },
    background: {
      /** Makes the system agree with Settings › General: what starts with the computer, and the icon. */
      apply(background) {
        startup.set(background?.runAtStartup === true);
        syncTray();
      },
      refresh: () => syncTray(),
    },
    power: { onResume: (fn) => powerMonitor.on("resume", fn) },
    window: {
      focused() {
        const win = live();
        return !!win && win.isVisible() && win.isFocused();
      },
      viewing: () => viewing(),
      send(channel, value) {
        const win = live();
        if (!win) return false;
        win.webContents.send(channel, value);
        return true;
      },
      openChat: (chatId) => tell("open-chat", chatId),
      openSettings: (tab) => tell("open-settings", tab),
      // The system's own dictation, into the focused field (macOS: Edit › Start Dictation).
      dictate() {
        const win = live();
        if (!win) return;
        win.focus();
        win.webContents.focus();
        Menu.sendActionToFirstResponder("startDictation:");
      },
      // Nothing in the window talks peer to peer, except a live voice over WebRTC while it is open.
      peerToPeer(on) {
        live()?.webContents.setWebRTCIPHandlingPolicy(on ? "default_public_interface_only" : "disable_non_proxied_udp");
      },
      fillSecurePage: (plan, values, signal) => fillSecurePage(plan, values, signal),
    },
  });
}
