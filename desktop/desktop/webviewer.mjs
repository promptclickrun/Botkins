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
function browserForm(action, url, fields, values, token, submit) {
  if (document.visibilityState !== "visible" || location.protocol !== "https:" || location.username || location.password) return false;
  const address = location.origin + location.pathname;
  if (action === "bind") {
    if (address !== url) return false;
    // This random mark lives only in this document's isolated world. Reloading even the
    // exact same URL invalidates approval, as does switching tabs or starting a new browser.
    globalThis.botkinsFormDocument ??= crypto.randomUUID();
    return { url: location.href, token: globalThis.botkinsFormDocument };
  }
  if ((action === "fill" || action === "fill_submit") && (location.href !== url || (token && globalThis.botkinsFormDocument !== token))) return false;

  const setNative = (input, val) => {
    const prev = input.value;
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") desc.set.call(input, val);
    else input.value = val;
    if (input._valueTracker && typeof input._valueTracker.setValue === "function") {
      try {
        input._valueTracker.setValue(prev);
      } catch {}
    }
  };

  const inputs = new Map();
  for (const input of document.querySelectorAll("input, textarea")) {
    const key = input.name || input.id;
    const isTextarea = input.tagName === "TEXTAREA";
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || key in Object.prototype || input.disabled || input.readOnly ||
        !input.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ||
        (!isTextarea && !["text", "email", "password", "tel", "search", "number"].includes(input.type))) continue;
    inputs.set(key, inputs.has(key) ? null : input);
  }
  if (action === "inspect") {
    const buttons = [];
    for (const btn of document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')) {
      if (btn.disabled || !btn.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const label = String(btn.innerText || btn.value || btn.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!label) continue;
      const selector = btn.id ? "#" + CSS.escape(btn.id) : btn.name ? `${btn.tagName.toLowerCase()}[name="${CSS.escape(btn.name)}"]` : undefined;
      buttons.push({ text: label, ...(selector && { selector }), type: (btn.type || btn.getAttribute("role") || "button").toLowerCase() });
      if (buttons.length >= 32) break;
    }
    return {
      url: address,
      fields: [...inputs].filter(([, input]) => input).slice(0, 64).map(([key, input]) => ({ key, type: input.tagName === "TEXTAREA" ? "textarea" : input.type })),
      ...(buttons.length > 0 && { buttons }),
    };
  }
  const selected = [];
  for (const field of fields) {
    if (!Object.hasOwn(values, field.key)) continue;
    const input = inputs.get(field.key);
    if (!input) return false;
    selected.push([input, values[field.key]]);
  }
  for (const [input, value] of selected) setNative(input, value);
  for (const [input] of selected) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  if (action === "fill_submit" || submit) {
    // Re-verify document origin/token immediately before submitting.
    if (location.href !== url || (token && globalThis.botkinsFormDocument !== token)) return false;
    const sub = submit && typeof submit === "object" ? submit : {};
    let clicked = false;
    if (typeof sub.selector === "string" && sub.selector.trim()) {
      let target = null;
      try {
        target = document.querySelector(sub.selector);
      } catch {}
      if (!target || target.disabled) return false;
      target.click();
      clicked = true;
    } else if (typeof sub.buttonText === "string" && sub.buttonText.trim()) {
      const needle = sub.buttonText.replace(/\s+/g, " ").trim().toLowerCase();
      let exact = null;
      let partial = null;
      for (const btn of document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a')) {
        if (btn.disabled || !btn.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const label = String(btn.innerText || btn.value || btn.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!label) continue;
        if (label === needle) {
          exact = btn;
          break;
        }
        if (!partial && label.includes(needle)) partial = btn;
      }
      const target = exact || partial;
      if (!target) return false;
      target.click();
      clicked = true;
    }
    if (!clicked && selected.length > 0) {
      const last = selected[selected.length - 1][0];
      const form = last.form || last.closest("form");
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else {
          const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
          if (btn) btn.click();
          else form.submit();
        }
        clicked = true;
      }
    }
    if (!clicked) return false;
  }
  return true;
}

/** Runs only our fixed function in the current main document, outside the website’s JS world. */
export async function callInPage(send, fn, args, signal) {
  const { frameTree } = await send("Page.getFrameTree");
  const { executionContextId } = await send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id, worldName: "Botkins secure input",
  });
  signal?.throwIfAborted();
  const { result, exceptionDetails } = await send("Runtime.callFunctionOn", {
    executionContextId, functionDeclaration: fn.toString(), returnByValue: true,
    arguments: args.map(value => ({ value })),
  });
  if (exceptionDetails) throw new Error("The requested fields are unavailable.");
  return result?.value;
}

export function inspectForm(send) {
  return callInPage(send, browserForm, ["inspect"]);
}

export function bindForm(send, url) {
  return callInPage(send, browserForm, ["bind", url]);
}

export async function fillPageFields(send, plan, values, signal) {
  const action = plan.submit ? "fill_submit" : "fill";
  const filled = await callInPage(send, browserForm, [action, plan.document?.url ?? plan.url, plan.fields, values, plan.document?.token ?? null, plan.submit ?? null], signal);
  if (filled !== true) throw new Error(plan.submit ? "The requested fields or submit button are unavailable." : "The requested fields are unavailable.");
}

export async function fillSecurePage(guest, plan, values, signal) {
  const debuggerApi = guest.debugger;
  if (guest.isDestroyed() || guest.getURL() !== plan.url || debuggerApi.isAttached()) throw new Error("Open the requested page.");
  debuggerApi.attach();
  try {
    await fillPageFields(debuggerApi.sendCommand.bind(debuggerApi), plan, values, signal);
  } finally {
    if (!guest.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
  }
}
