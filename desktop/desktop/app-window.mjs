// Opens a bot's HTML app in its own sandboxed window: an in-memory session per app, no network,
// no Node, no permissions, and a small bridge for data and answers (desktop/app-preload.cjs).
import { BrowserWindow, dialog, ipcMain, protocol, session, shell } from "electron";
import { fileURLToPath } from "node:url";
import { guardedPage, unshadow } from "./view-guard.mjs";

export const APP_SCHEME = "botkins-app";
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join("; ");

/** Must run before the app is ready. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);
}

export class AppWindows {
  constructor(apps, { onAnswer }) {
    this.apps = apps;
    this.onAnswer = onAnswer;
    this.open = new Map(); // app id → window
    this.owners = new Map(); // webContents id → app id
    apps.onRemove = (ids) => this.close(ids);
    apps.onChange = (app, changed) => {
      const w = this.open.get(app.id);
      if (!w || w.isDestroyed()) return;
      if (changed.html) w.reload();
      else if (changed.data) w.webContents.send("app:data", apps.data(app.id));
    };
    const appFor = (event) => {
      const id = this.owners.get(event.sender.id);
      if (!id) throw new Error("Unknown app window");
      return id;
    };
    ipcMain.handle("app:data", (event) => this.apps.data(appFor(event)));
    const lastAnswer = new Map();
    ipcMain.handle("app:answer", (event, text) => {
      const id = appFor(event);
      const app = this.apps.get(id);
      if (!app.sendsAnswers) throw new Error("This app doesn't send answers.");
      if (typeof text !== "string" || !text.trim()) throw new Error("Send a non-empty answer.");
      // Answers become ordinary message text: never a command, and at most one every two seconds.
      if (/^\s*\//.test(text)) throw new Error("An answer can't start with a slash command.");
      if (Date.now() - (lastAnswer.get(id) ?? 0) < 2000) throw new Error("Wait a moment before sending another answer.");
      lastAnswer.set(id, Date.now());
      this.onAnswer(app, text.slice(0, 32000));
    });
    ipcMain.handle("app:close", (event) => {
      this.open.get(appFor(event))?.close();
    });
  }
  /** Asks before an app opens a web page in the browser; one question at a time. */
  async confirmExternal(id, url, window) {
    if (!/^https?:\/\//i.test(url) || this.asking) return;
    this.asking = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        buttons: ["Open in browser", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: this.apps.get(id).title + " wants to open a web page.",
        detail: url.slice(0, 2000),
      });
      if (response === 0) await shell.openExternal(url);
    } finally {
      this.asking = false;
    }
  }
  close(ids) {
    for (const id of ids) {
      const w = this.open.get(id);
      if (w && !w.isDestroyed()) w.close();
    }
  }
  show(id, parent) {
    const app = this.apps.get(id);
    const existing = this.open.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const ses = session.fromPartition("botkins-app-" + id);
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
    // WebRTC is not a request and not under the page's policy: a page could open a TCP connection
    // to a TURN server of its choosing. The window's WebRTC setting below stops UDP and sends TCP
    // through the session's proxy, so the session is given a proxy that is not there (a closed port
    // on this computer; "<-loopback>" so that addresses of this computer go to it too). The app's
    // own page does not go through a proxy. This holds whatever the page's code does; the guard in
    // the page (desktop/view-guard.mjs) is the first layer.
    const noNetwork = ses.setProxy({ proxyRules: "http://127.0.0.1:1", proxyBypassRules: "<-loopback>" }).catch((error) => console.error("App window proxy:", error.message));
    // Belt and braces with the CSP: cancel every request that isn't the app's own page or inline data.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const own = details.url.startsWith(APP_SCHEME + "://" + id + "/") || /^(data|blob):/i.test(details.url);
      callback({ cancel: !own });
    });
    if (!ses.protocol.isProtocolHandled(APP_SCHEME))
      ses.protocol.handle(APP_SCHEME, (request) => {
        const url = new URL(request.url);
        if (url.hostname !== id || (url.pathname !== "/" && url.pathname !== "/index.html"))
          return new Response("Not found", { status: 404 });
        // The guard runs before anything of the app's own (desktop/view-guard.mjs).
        return new Response(guardedPage(unshadow(this.apps.page(id))), {
          headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP },
        });
      });
    const w = new BrowserWindow({
      width: 720,
      height: 640,
      minWidth: 360,
      minHeight: 320,
      title: app.title,
      parent: undefined,
      backgroundColor: parent?.getBackgroundColor?.() ?? "#ffffff",
      autoHideMenuBar: true,
      webPreferences: {
        preload: fileURLToPath(new URL("./app-preload.cjs", import.meta.url)),
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: false,
      },
    });
    w.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    const wcId = w.webContents.id;
    this.open.set(id, w);
    this.owners.set(wcId, id);
    w.webContents.setWindowOpenHandler(({ url }) => {
      void this.confirmExternal(id, url, w);
      return { action: "deny" };
    });
    w.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(APP_SCHEME + "://" + id + "/")) {
        event.preventDefault();
        void this.confirmExternal(id, url, w);
      }
    });
    w.webContents.on("will-redirect", (event, url) => {
      if (!url.startsWith(APP_SCHEME + "://" + id + "/")) event.preventDefault();
    });
    w.on("page-title-updated", (event) => event.preventDefault());
    w.on("closed", () => {
      this.open.delete(id);
      this.owners.delete(wcId);
    });
    // The page loads once the session has its proxy, so nothing of it runs before that.
    void noNetwork.then(() => !w.isDestroyed() && w.loadURL(APP_SCHEME + "://" + id + "/"));
  }
  closeAll() {
    for (const w of this.open.values()) if (!w.isDestroyed()) w.close();
  }
}
