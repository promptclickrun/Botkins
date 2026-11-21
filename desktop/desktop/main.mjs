import {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  session,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { chunk, fileDetails, publicFile } from "./artifact-files.mjs";
import { ArtifactMedia } from "./artifact-media.mjs";
import { HERE, RemoteHosts, splitPreferences } from "./remotehosts.mjs";
import { adminModeStore, hasAdminMode, ownerWindowView } from "./admin-view.mjs";
import { fillSecurePage, VIEWER_PARTITION, attachViewer, guardGuest, guardViewerSession } from "./webviewer.mjs";
import { APP_SCHEME, AppWindows, registerAppScheme } from "./app-window.mjs";
import { FRAME_CSP } from "./frames.mjs";
import { adoptFolder, APP_NAME, dataHome, env } from "./home.mjs";
import { canvasColor } from "./preferences.mjs";
import { computerName } from "./nearby.mjs";
import { HIDDEN_FLAG, loginItem, startedHidden } from "./startup.mjs";
import { parseJoinUrl } from "./remote/link-client.mjs";
// The workspace, its calls and the phone link are built in desktop/runtime.mjs, on a host. This
// file is the desktop app around them: Electron's start, the window, the tray icon, what a page in
// the window may load, and the calls only this window makes.
import { createRuntime, isSplitHost } from "./runtime.mjs";
import { withOwnerChatSections } from "./chat-sections-ipc.mjs";
import { electronHost } from "./host/electron.mjs";

// Use the Botkins path for an existing installation. A development run never changes it.
if (app.isPackaged && !env("DATA_DIR")) adoptFolder({ appData: app.getPath("appData") });
const home = dataHome({ appData: app.getPath("appData"), override: env("DATA_DIR") });
app.setName(APP_NAME);
app.setPath("userData", home.dir);
registerAppScheme();
app.setAsDefaultProtocolClient("botkins");
let appWindows;
let pendingPrefill = null;
let pendingTeamJoin = null;
/** This computer's own Admin mode choice (desktop/admin-view.mjs). */
let adminMode = null;
const html = fileURLToPath(new URL("../dist/index.html", import.meta.url));
const artifactMedia = new ArtifactMedia(APP_SCHEME);
let win,
  tray,
  workspace,
  // The workspace as one running thing (desktop/runtime.mjs): its calls, the model providers and the phone link.
  runtime,
  // Other computers' Botkins this app is paired to, and the one the window shows (desktop/remotehosts.mjs).
  remote,
  // Phone access (desktop/link): the runtime's LinkHost.
  link,
  quitting = false,
  pending = false;
// "Run at startup" is asked of the system only by the installed app on its own data. A trial run
// (a test, a development build on a folder of its own) writes its entry inside that folder instead,
// so it never changes what starts with this computer.
const startup = loginItem(app.isPackaged && home.from !== "override" ? { electron: app } : { home: join(home.dir, "startup") });
let updateQuit = false;
// The control socket of this app (desktop/terminal/control-start.mjs), or null while it is off or did not start.
let control = null;
autoUpdater.on("before-quit-for-update", () => {
  updateQuit = true;
  workspace?.save();
});

// The chat open in the window, as the page last said (handlers.viewing).
let viewingChat = null;
const viewerGuests = new Set();
/**
 * What the window shows: this computer's workspace, or the state of the other computer in use
 * (with this window's own look). `remote` says which, and lists the computers this app is paired to.
 */
const appSnapshot = () => {
  const using = remote?.inUse() ?? null;
  return {
    // This computer's own workspace goes to its window as the owner is shown it: the owner's view
    // of the spaces, and with Admin mode off only what the owner is part of (desktop/admin-view.mjs).
    // The chats left come with the owner's own sections, which the link keeps ("chat-sections-v1").
    // Another computer's snapshot is already cut for this device by that computer's link.
    ...(using ? remote.snapshot(workspace.state.settings) : withOwnerChatSections(ownerWindowView(workspace.snapshot(), link, adminMode?.get() === true), link)),
    ...(!using && link ? { team: link.team() } : {}),
    phones: { revision: runtime.phoneRevision() },
    remote: { using, hosts: remote?.list() ?? [] },
  };
};
/** The id of the custom view whose frame loaded from this address, or null. */
function frameIdOf(address) {
  try {
    const url = new URL(address);
    return url.protocol === APP_SCHEME + ":" ? (/^frame-([0-9a-f-]{36})$/.exec(url.hostname)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}
/** The window hears of a change at most every 35 ms. */
function push() {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    if (win && !win.isDestroyed())
      win.webContents.send("changed", appSnapshot());
  }, 35);
}
function openTeamJoin(value) {
  const url = String(value ?? "").trim();
  if (!parseJoinUrl(url)) return false;
  pendingTeamJoin = url;
  showWindow();
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send("open-team-join", url);
  }
  return true;
}
function showWindow() {
  // Asked for before the app has started (a Dock click while the keychain's question is open):
  // the window opens by itself when the start is done.
  if (!workspace) return;
  if (!win || win.isDestroyed()) openWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
/** Closing the window leaves Botkins running: when the person keeps it on (Settings › General), or while there is work to do. */
function keepInBackground() {
  return (
    workspace.state.settings.background?.keepRunning !== false ||
    workspace.active.size > 0 ||
    workspace.panels.all.some((p) => p.routine?.enabled) ||
    workspace.state.chats.some((c) =>
      c.schedules?.some((s) => s.enabled !== false && s.nextAt != null),
    )
  );
}
function ensureTray() {
  if (tray) return;
  // The two Botkins. In the macOS menu bar they are a template image (one color, tinted by the
  // system, with a sharper copy beside it for Retina screens); elsewhere the app icon in color.
  const mac = process.platform === "darwin";
  const image = nativeImage.createFromPath(fileURLToPath(new URL(mac ? "../dist/trayTemplate.png" : "../dist/tray.png", import.meta.url)));
  const icon = mac ? image : image.resize({ width: 20, height: 20 });
  if (mac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open " + APP_NAME, click: showWindow },
      { type: "separator" },
      { label: "Quit " + APP_NAME, click: () => app.quit() },
    ]),
  );
  tray.on("click", showWindow);
}
/** The icon is there while Botkins is set to stay on, and whenever it runs with no window to come back to. */
function syncTray() {
  const windowOpen = !!win && !win.isDestroyed() && win.isVisible();
  if (workspace.state.settings.background?.keepRunning !== false || !windowOpen) ensureTray();
  else if (tray) {
    tray.destroy();
    tray = null;
  }
}
function openWindow() {
  win = new BrowserWindow({
    width: 1190,
    height: 830,
    minWidth: 760,
    minHeight: 560,
    title: APP_NAME,
    // The theme's own paper, so the window never flashes another color while its page loads.
    backgroundColor: canvasColor(workspace?.state.settings.appearance, nativeTheme.shouldUseDarkColors),
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The preload also runs inside each custom view's frame, in a world of its own that the
      // view's page cannot reach. There it does one thing: it says when the person touched,
      // clicked or pressed a key in that view (desktop/preload.cjs, "frame-gesture" below). The
      // window cannot see input in a frame of another origin, and the page's word for it is not
      // enough. The frame gets no bridge and no call: the preload gives the app's bridge to the
      // main frame only, and every call below is refused unless the window's own page made it.
      nodeIntegrationInSubFrames: true,
      // The side pane's website viewer is a guest of this window. What a guest may be is decided
      // below, in the main process (desktop/webviewer.mjs), whatever the page asks for.
      webviewTag: true,
    },
  });
  win.webContents.on("will-attach-webview", attachViewer);
  win.webContents.on("did-attach-webview", (_event, guest) => {
    guardGuest(guest);
    viewerGuests.add(guest);
    guest.once("destroyed", () => viewerGuests.delete(guest));
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // A page a bot wrote (an html block) must not talk peer to peer. This stops UDP for the whole
  // window. It does not stop TCP, and the window itself needs WebRTC for live voice, so a view's
  // page has the ways to open such a connection taken away in the page (desktop/view-guard.mjs).
  win.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // The window frames pages of html blocks and nothing else; a frame never goes anywhere.
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !event.url.startsWith(APP_SCHEME + "://frame-")) event.preventDefault();
  });
  win.on("close", (event) => {
    if (!quitting && !updateQuit && keepInBackground()) {
      ensureTray();
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
  win.on("show", syncTray);
  win.on("hide", syncTray);
  win.loadFile(html);
}
const teamUrlFrom = (argv) => argv.find((value) => typeof value === "string" && parseJoinUrl(value));
pendingTeamJoin = teamUrlFrom(process.argv) ?? null;
app.on("open-url", (event, url) => {
  event.preventDefault();
  openTeamJoin(url);
});
if (!app.requestSingleInstanceLock()) app.quit();
else
  app.whenReady().then(async () => {
    // Opening Botkins while it runs shows its window. A second start by the computer at sign-in stays quiet.
    app.on("second-instance", (_event, argv) => {
      const url = teamUrlFrom(argv);
      if (!url && !argv.includes(HIDDEN_FLAG)) showWindow();
      if (url) openTeamJoin(url);
    });
    app.on("activate", showWindow);
    const dataDir = join(app.getPath("userData"), "data");
    // A trial run (a data folder of its own: the tests, a development copy) never reads or writes
    // anything of the person's in the system keychain, browses a folder of its own and stays quiet
    // on the network (desktop/runtime.mjs says what each environment variable asks for instead).
    const trial = home.from === "override";
    const host = electronHost({
      window: () => win,
      showWindow,
      viewing: () => viewingChat,
      // A saved credential is typed into the page a chat's website viewer shows, and only there.
      fillSecurePage: (plan, values, signal) => {
        if (remote?.inUse() || viewingChat !== plan.chatId) throw new Error("Open the chat on this computer.");
        const matches = [...viewerGuests].filter(g => !g.isDestroyed() && g.getURL() === plan.url);
        if (matches.length !== 1) throw new Error("Open the requested page in this chat.");
        return fillSecurePage(matches[0], plan, values, signal);
      },
      startup,
      syncTray,
    });
    // Other computers this app is paired to. Each credential is wrapped like the vault's key: by the
    // system keychain's key in the installed app, and kept in a trial run's own folder otherwise.
    remote = new RemoteHosts({
      file: join(dataDir, "remote-hosts.json"),
      protect: host.protect({ trial }),
      lib: await import("./remote/link-client.mjs"),
      device: { name: computerName(), platform: process.platform },
      changed: () => push(),
      log: (line) => console.error(line),
    });
    // The app opens on the computer it was on when it was closed: this one, or a paired one.
    remote.resume();
    // Admin mode is each owner device's own. This window's choice is this computer's, off at first.
    adminMode = adminModeStore(join(dataDir, "window.json"));
    runtime = await createRuntime({ host, dataDir, trial, pushed: () => (push(), control?.changed()) });
    ({ workspace, link } = runtime);
    // An app's answer goes into its chat's message box for the person to review and send.
    appWindows = new AppWindows(workspace.apps, {
      onAnswer: (appInfo, text) => {
        const fresh = !win || win.isDestroyed();
        showWindow();
        // A window that is just opening picks the answer up when its page asks for it.
        if (fresh || win.webContents.isLoading()) pendingPrefill = { chatId: appInfo.chatId, text };
        else win.webContents.send("prefill", { chatId: appInfo.chatId, text });
      },
    });
    // Html blocks of panels and cards load from botkins-app://frame-<id>/ into sandboxed frames
    // in the app's window (desktop/frames.mjs), with rules of their own.
    session.defaultSession.protocol.handle(APP_SCHEME, (request) => {
      const url = new URL(request.url);
      if (url.hostname.startsWith("media-")) return artifactMedia.response(request);
      const id = /^frame-([0-9a-f-]{36})$/.exec(url.hostname)?.[1];
      try {
        if (!id || (url.pathname !== "/" && url.pathname !== "/index.html")) throw new Error("Not found");
        return new Response(workspace.frames.page(id), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": FRAME_CSP,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "x-dns-prefetch-control": "off",
            "referrer-policy": "no-referrer",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    });
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      // A frame in this window shows a page of an html block and nothing else, whoever asks.
      if (details.resourceType === "subFrame" && !details.url.startsWith(APP_SCHEME + "://frame-")) return callback({ cancel: true });
      const from = details.frame?.url ?? "";
      // Belt and braces with the frame's own rules: it loads itself and inline data, nothing else.
      if (from.startsWith(APP_SCHEME + "://")) {
        const own = from.split("/").slice(0, 3).join("/") + "/";
        return callback({ cancel: !(details.url.startsWith(own) || /^(data|blob):/i.test(details.url)) });
      }
      callback({});
    });
    // A website in the side pane's viewer gets no permission and downloads nothing.
    guardViewerSession(session.fromPartition(VIEWER_PARTITION));
    // The microphone is for the app's own page (dictation and Live Voice) and only for sound: no
    // camera, and never for a frame (an html block). Every other permission is decided as before.
    const ownPage = (contents, url) => !!win && !win.isDestroyed() && contents === win.webContents && String(url ?? "").startsWith(pathToFileURL(html).href);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission !== "media") return callback(true);
      const kinds = details?.mediaTypes ?? [];
      callback(ownPage(contents, details?.requestingUrl) && details?.isMainFrame !== false && kinds.length > 0 && kinds.every((kind) => kind === "audio"));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (permission !== "media") return true;
      return !!contents && ownPage(contents, details?.requestingUrl ?? contents.getURL()) && details?.isMainFrame !== false && details?.mediaType !== "video";
    });
    const handlers = {
      ...runtime.handlers,
      // The calls only this window makes: about the window itself, and about the other computers
      // it can show. None is in REMOTE_METHODS (desktop/link/methods.mjs), so a phone makes none.
      takeTeamJoin: () => {
        const url = pendingTeamJoin;
        pendingTeamJoin = null;
        return url;
      },
      findTeamInvite: (input) => remote.findTeamInvite(input),
      startTeamJoin: (target) => remote.startTeamJoin(target),
      checkTeamJoin: (id) => remote.checkTeamJoin(id),
      teamJoins: () => remote.teamJoins(),
      cancelTeamJoin: (id) => remote.cancelTeamJoin(id),
      // The page says which chat is open in the window (or none), so a phone isn't pinged for a
      // reply the person is already looking at.
      viewing: (chatId) => {
        viewingChat = typeof chatId === "string" && chatId ? chatId : null;
        // While another computer is in use: it sends the messages of the chat on screen, and
        // learns that this window has it in front (so it doesn't ping a phone for that chat).
        if (remote.inUse()) {
          remote.watch(viewingChat ? [viewingChat] : []);
          void remote.call("link.push.presence", [!!win && !win.isDestroyed() && win.isFocused(), viewingChat ?? undefined]).catch(() => {});
        }
      },
      // Other computers' Botkins this app uses (Settings › Phone & devices, and the switcher). A phone can't make these calls.
      remoteHosts: () => ({ using: remote.inUse(), hosts: remote.list() }),
      pairRemoteHost: (input) => remote.pair({ link: input?.link, address: input?.address, code: input?.code }),
      useRemoteHost: (id) => {
        const using = remote.use(typeof id === "string" && id ? id : null);
        if (using && viewingChat) viewingChat = null;
        return using;
      },
      forgetRemoteHost: (id) => remote.forget(String(id)),
      renameRemoteHost: (id, name) => remote.rename(String(id), name),
      artifactMedia: async (id, localPath) => {
        const hostId = remote.inUse()?.id;
        if (hostId) {
          if (localPath) throw new Error("Choose an artifact on the paired computer.");
          const read = (offset, length) => {
            if (remote.inUse()?.id !== hostId) throw new Error("The paired computer changed.");
            return remote.call("artifacts.read", [id, { offset, length }]);
          };
          const { artifact } = await read(0, 1);
          return artifactMedia.add(artifact.mime, artifact.size, read);
        }
        const info = localPath ? fileDetails(localPath) : workspace.artifacts.entry(id)?.info;
        if (!info) throw new Error("This file is unavailable.");
        return artifactMedia.add(info.mime, info.size, (offset, length) => chunk(info, publicFile(info), { offset, length }));
      },
      closeArtifactMedia: (url) => artifactMedia.close(url),
      artifactMessagePage: (chatId, index) => {
        if (!remote.inUse() || typeof chatId !== "string" || !Number.isSafeInteger(index) || index < 0) throw new Error("Choose a message on the paired computer.");
        return remote.call("link.messages", [chatId, index + 11, 32]);
      },
      snapshot: () => appSnapshot(),
      openApp: (id) => appWindows.show(id, win),
      takePrefill: () => {
        const value = pendingPrefill;
        pendingPrefill = null;
        return value;
      },
      // The link's name for the call, so the window says the same thing on this computer and when
      // it uses another (there the name goes to that computer, which keeps the choice for this device).
      "link.team.setAdminMode": (on) => {
        if (!hasAdminMode(link)) throw new Error("Admin mode needs a newer phone link than this copy of Botkins has.");
        const now = adminMode.set(on === true);
        push();
        return now;
      },
    };
    // A real touch, click or key press inside a custom view (desktop/preload.cjs). The view is named
    // by the address its frame loaded from, never by what was sent; anything else is not heard.
    // The window is told which view, and decides what that allows (a save of an app panel's state).
    ipcMain.on("frame-gesture", (event) => {
      const frame = event.senderFrame;
      if (!win || win.isDestroyed() || event.sender !== win.webContents || !frame || frame === win.webContents.mainFrame) return;
      const id = frameIdOf(frame.url);
      if (id) win.webContents.send("frame-gesture", { frame: id });
    });
    for (const [name, fn] of Object.entries(handlers))
      ipcMain.handle(name, (event, ...args) => {
        if (
          event.senderFrame?.url !== pathToFileURL(html).href ||
          event.sender !== win.webContents
        )
          throw new Error("Unknown window");
        // While another computer is in use, the window's calls go there. Calls about this window
        // itself stay here, and so does how the window looks.
        if (remote.inUse() && !HERE.has(name)) {
          if (name !== "setPreferences") return remote.call(name, args);
          const { own, theirs } = splitPreferences(args[0]);
          if (own) fn(own);
          return theirs ? remote.call(name, [theirs]) : undefined;
        }
        return fn(...args);
      });
    // "Run at startup" names this program by its path: said again on every start, so an app that was
    // moved or updated keeps starting. A refusal here is not worth stopping for.
    try {
      startup.set(workspace.state.settings.background?.runAtStartup === true);
    } catch (error) {
      console.error("Run at startup:", error.message);
    }
    // Started by the computer at sign-in: no window, only the icon. Any other start opens the window.
    if (!startedHidden()) openWindow();
    syncTray();
    // The control socket, and the `botkins` command for a bot's shell (desktop/terminal/reach.mjs). A trial
    // run (tests, a development copy) has none, except the workspace of the two-container host, which is
    // a trial run by its folder and whose bots need the command. A socket that does not start is one line in
    // the log and never stops the app, so the import is inside the try.
    if (!trial || isSplitHost()) {
      try {
        const { startAppControl } = await import("./terminal/control-start.mjs");
        control = await startAppControl({ runtime, root: home.dir, version: app.getVersion(), keys: () => (app.isPackaged && !trial ? { source: "keychain", where: "system keychain" } : null), say: (line) => console.error(line) });
      } catch (error) {
        console.error("Control socket: not started (" + error.message + ").");
      }
    }
    runtime.begin();
    app.on("window-all-closed", () => { if (!updateQuit) app.quit(); });
    app.on("before-quit", (event) => {
      if (quitting) return;
      quitting = true;
      appWindows?.closeAll();
      event.preventDefault();
      const force = setTimeout(() => app.exit(), 5000);
      Promise.resolve(control?.close()).catch(() => {}).then(() => runtime.stop()).finally(() => {
        clearTimeout(force);
        app.quit();
      });
    });
  });
