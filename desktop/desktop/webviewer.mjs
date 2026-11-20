// The side pane's website viewer (docs/SIDE_PANE.md): a guest page inside the app's window
// (Electron's <webview>), for a website a bot showed with side_pane_web or the person went on to
// from there. The guest is somebody else's page, so it gets nothing of the app:
//
//   - its own storage, kept in memory and gone when the app quits (VIEWER_PARTITION);
//   - no preload, no Node, a sandbox, and no say over its own settings: whatever the page that
//     embeds it asked for is overwritten here, in the main process;
//   - http and https only, never an address literal on the local network, no sign-in in the address;
//   - no new windows (a link that wants one opens in the same viewer), no downloads, and no
//     permission of any kind (camera, microphone, location, notifications, clipboard, devices).
//
// Nothing else in the app may be a guest: an attach that isn't the viewer's is refused.
import { localNetworkLiteral } from "./sidepane.mjs";

/** The viewer's storage. No "persist:" in the name, so Electron keeps it in memory only. */
export const VIEWER_PARTITION = "side-pane-web";

/** True for an address the viewer may load. */
export function viewable(address) {
  try {
    const url = new URL(String(address));
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !localNetworkLiteral(url.hostname);
  } catch {
    return false;
  }
}

/** For the window's "will-attach-webview": lets the viewer's guest in, with settings set here, and nothing else. */
export function attachViewer(event, preferences, params) {
  if (params?.partition !== VIEWER_PARTITION || !viewable(params?.src)) return void event.preventDefault();
  for (const key of ["preload", "preloadURL"]) delete preferences[key];
  for (const key of ["preload", "allowpopups", "webpreferences", "nodeintegration", "nodeintegrationinsubframes", "disablewebsecurity", "enableblinkfeatures", "disableblinkfeatures", "plugins"]) delete params[key];
  Object.assign(preferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    plugins: false,
    experimentalFeatures: false,
  });
}

/** For the window's "did-attach-webview": the guest stays on the web, in its own view. */
export function guardGuest(guest) {
  guest.setWindowOpenHandler(({ url }) => {
    // A link that asks for a new window is followed in the viewer itself.
    if (viewable(url)) guest.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  const stop = (event, url) => {
    if (!viewable(event?.url ?? url)) event.preventDefault();
  };
  guest.on("will-navigate", stop);
  guest.on("will-redirect", stop);
  guest.setWebRTCIPHandlingPolicy?.("disable_non_proxied_udp");
}

/** Once, for the viewer's storage (session.fromPartition(VIEWER_PARTITION)): no permission and no download, ever. */
export function guardViewerSession(session) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler?.(() => false);
  session.on("will-download", (event) => event.preventDefault());
}

// This function runs in Chromium's isolated world in the guest's current main document.
// The debugger passes values as structured arguments. The script source contains no secrets.
function fillNamedInputs(url, fields, values) {
  if (location.href !== url || document.visibilityState !== "visible") return false;
  const inputs = [];
  for (const field of fields) {
    if (!Object.hasOwn(values, field.key)) continue;
    const matches = [...document.getElementsByName(field.key)].filter(input => input instanceof HTMLInputElement &&
      ["text", "email", "password", "tel", "search", "number"].includes(input.type) && input.checkVisibility() && !input.disabled && !input.readOnly);
    if (matches.length !== 1) return false;
    inputs.push([matches[0], values[field.key]]);
  }
  for (const [input, value] of inputs) input.value = value;
  for (const [input] of inputs) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
}

export async function fillSecurePage(guest, plan, values, signal) {
  const debuggerApi = guest.debugger;
  if (guest.isDestroyed() || guest.getURL() !== plan.url || debuggerApi.isAttached()) throw new Error("Open the requested page.");
  debuggerApi.attach();
  try {
    const { frameTree } = await debuggerApi.sendCommand("Page.getFrameTree");
    const { executionContextId } = await debuggerApi.sendCommand("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id, worldName: "Botkins secure input",
    });
    signal.throwIfAborted();
    const { result, exceptionDetails } = await debuggerApi.sendCommand("Runtime.callFunctionOn", {
      executionContextId, functionDeclaration: fillNamedInputs.toString(), returnByValue: true,
      arguments: [plan.url, plan.fields, values].map(value => ({ value })),
    });
    if (exceptionDetails || result?.value !== true) throw new Error("The requested fields are unavailable.");
  } finally {
    if (!guest.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
  }
}
