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

const guestOriginPins = new WeakMap();
const pinnedGuestIds = new Map();

/** True only for an HTTPS URL (or loopback HTTP when explicitly opted in for local tests) matching expectedOrigin with no embedded credentials. */
export function isApprovedHttpsUrl(address, expectedOrigin, { allowLocalHttp = false } = {}) {
  try {
    const url = new URL(String(address));
    if (url.username || url.password) return false;
    const isHttps = url.protocol === "https:";
    const isLocalHttp = allowLocalHttp && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (!isHttps && !isLocalHttp) return false;
    return typeof expectedOrigin === "string" && expectedOrigin.length > 0 && url.origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function pinGuestOrigin(guest, origin) {
  if (!guest || !origin) return;
  guestOriginPins.set(guest, { origin });
  if (typeof guest.id === "number") pinnedGuestIds.set(guest.id, origin);
}

export function clearGuestOriginPin(guest) {
  if (!guest) return;
  guestOriginPins.delete(guest);
  if (typeof guest.id === "number") pinnedGuestIds.delete(guest.id);
}

/** For the window's "did-attach-webview": the guest stays on the web, in its own view. */
export function guardGuest(guest) {
  const allowedByPin = (url) => {
    const pin = guestOriginPins.get(guest);
    return !pin || isApprovedHttpsUrl(url, pin.origin);
  };
  guest.setWindowOpenHandler(({ url }) => {
    // A link that asks for a new window is followed in the viewer itself, unless origin-pinned off-origin.
    if (viewable(url) && allowedByPin(url)) guest.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  const stop = (event, url) => {
    const target = event?.url ?? url;
    if (!viewable(target) || !allowedByPin(target)) event.preventDefault();
  };
  guest.on("will-navigate", stop);
  guest.on("will-redirect", stop);
  guest.once?.("destroyed", () => clearGuestOriginPin(guest));
  guest.setWebRTCIPHandlingPolicy?.("disable_non_proxied_udp");
}

/** Once, for the viewer's storage (session.fromPartition(VIEWER_PARTITION)): no permission and no download, ever. */
export function guardViewerSession(session) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler?.(() => false);
  session.on("will-download", (event) => event.preventDefault());
  session.webRequest?.onBeforeRequest?.((details, callback) => {
    const origin = typeof details?.webContentsId === "number" ? pinnedGuestIds.get(details.webContentsId) : undefined;
    if (origin && !isApprovedHttpsUrl(details.url, origin)) {
      return callback({ cancel: true });
    }
    callback({});
  });
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

  const expectedOrigin = location.origin;
  const getAttr = (el, name) => (el ? Element.prototype.getAttribute.call(el, name) : null);
  const hasAttr = (el, name) => Boolean(el && Element.prototype.hasAttribute.call(el, name));
  const tagOf = (el) => {
    if (!el) return "";
    const getter = Object.getOwnPropertyDescriptor(Element.prototype, "tagName")?.get;
    return String(getter ? getter.call(el) : el.tagName || "").toLowerCase();
  };
  const getForm = (el) => {
    if (!el) return null;
    if (hasAttr(el, "form")) {
      const formId = getAttr(el, "form");
      if (!formId) return null;
      const byId = document.getElementById(formId);
      return byId && tagOf(byId) === "form" ? byId : null;
    }
    const tag = tagOf(el);
    const proto = tag === "input" ? HTMLInputElement.prototype
      : tag === "button" ? HTMLButtonElement.prototype
      : tag === "textarea" ? HTMLTextAreaElement.prototype
      : tag === "select" ? HTMLSelectElement.prototype
      : null;
    const getter = proto ? Object.getOwnPropertyDescriptor(proto, "form")?.get : null;
    if (getter) {
      const own = getter.call(el);
      if (own && tagOf(own) === "form") return own;
    }
    const closest = Element.prototype.closest.call(el, "form");
    return closest && tagOf(closest) === "form" ? closest : null;
  };
  const isSubmitControl = (el) => {
    const tag = tagOf(el);
    if (tag === "button") {
      const t = (getAttr(el, "type") || "").trim().toLowerCase();
      return !t || (t !== "button" && t !== "reset");
    }
    if (tag === "input") {
      const t = (getAttr(el, "type") || "").trim().toLowerCase();
      return t === "submit" || t === "image";
    }
    return false;
  };
  const isApprovedDest = (rawAttr) => {
    try {
      const trimmed = rawAttr === null || rawAttr === undefined ? "" : String(rawAttr).trim();
      // Per HTML spec, missing or empty action/formaction submits to document URL (not <base href>).
      const resolved = trimmed
        ? new URL(trimmed, document.baseURI || document.URL || location.href)
        : new URL(document.URL || location.href);
      return resolved.protocol === "https:" && !resolved.username && !resolved.password && resolved.origin === expectedOrigin;
    } catch {
      return false;
    }
  };
  const associatedSubmitters = (form) => {
    const list = [];
    const seen = new Set();
    const candidates = document.querySelectorAll("button, input");
    for (const el of candidates) {
      if (!isSubmitControl(el)) continue;
      if (getForm(el) === form && !seen.has(el)) {
        seen.add(el);
        list.push(el);
      }
    }
    return list;
  };
  const validateFormDestination = (form) => {
    if (!form) return isApprovedDest(null);
    if (!isApprovedDest(getAttr(form, "action"))) return false;
    for (const submitter of associatedSubmitters(form)) {
      if (hasAttr(submitter, "formaction") && !isApprovedDest(getAttr(submitter, "formaction"))) {
        return false;
      }
    }
    return true;
  };
  const validateSubmitTarget = (target) => {
    if (!target) return false;
    const tag = tagOf(target);
    if (tag === "a" || tag === "area") return false;
    if (hasAttr(target, "formaction") && !isApprovedDest(getAttr(target, "formaction"))) return false;
    if (hasAttr(target, "form")) {
      const targetForm = getForm(target);
      if (!targetForm || !validateFormDestination(targetForm)) return false;
    } else {
      const targetForm = getForm(target);
      if (targetForm && !validateFormDestination(targetForm)) return false;
    }
    return true;
  };

  const setNative = (input, val) => {
    const prev = input.value;
    const proto = tagOf(input) === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
    const key = getAttr(input, "name") || getAttr(input, "id") || "";
    const isTextarea = tagOf(input) === "textarea";
    const inputType = isTextarea ? "textarea" : (getAttr(input, "type") || "text").trim().toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || key in Object.prototype || input.disabled || input.readOnly ||
        !input.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ||
        (!isTextarea && !["text", "email", "password", "tel", "search", "number"].includes(inputType))) continue;
    inputs.set(key, inputs.has(key) ? null : input);
  }
  if (action === "inspect") {
    const buttons = [];
    for (const btn of document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')) {
      if (btn.disabled || !btn.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const label = String(btn.innerText || btn.value || getAttr(btn, "aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!label) continue;
      const btnId = getAttr(btn, "id");
      const btnName = getAttr(btn, "name");
      const selector = btnId ? "#" + CSS.escape(btnId) : btnName ? `${tagOf(btn)}[name="${CSS.escape(btnName)}"]` : undefined;
      buttons.push({ text: label, ...(selector && { selector }), type: (getAttr(btn, "type") || getAttr(btn, "role") || "button").toLowerCase() });
      if (buttons.length >= 32) break;
    }
    return {
      url: address,
      fields: [...inputs].filter(([, input]) => input).slice(0, 64).map(([key, input]) => ({ key, type: tagOf(input) === "textarea" ? "textarea" : (getAttr(input, "type") || "text").toLowerCase() })),
      ...(buttons.length > 0 && { buttons }),
    };
  }
  const selected = [];
  for (const field of fields) {
    if (!Object.hasOwn(values, field.key)) continue;
    const input = inputs.get(field.key);
    if (!input) return { ok: false, reason: "unavailable" };
    selected.push([input, values[field.key]]);
  }

  // Fail closed BEFORE writing any secret if any target input's effective form submit destination leaves the approved HTTPS origin.
  for (const [input] of selected) {
    if (hasAttr(input, "form") && !getForm(input)) return { ok: false, reason: "destination-denied" };
    const form = getForm(input);
    if (!validateFormDestination(form)) return { ok: false, reason: "destination-denied" };
  }

  const wantsSubmit = action === "fill_submit" || Boolean(submit);
  const resolveSubmit = () => {
    const sub = submit && typeof submit === "object" ? submit : {};
    if (typeof sub.selector === "string" && sub.selector.trim()) {
      let target = null;
      try {
        target = document.querySelector(sub.selector);
      } catch {}
      if (!target || target.disabled) return { ok: false, reason: "unavailable" };
      if (!validateSubmitTarget(target)) return { ok: false, reason: "destination-denied" };
      return { ok: true, kind: "click", target };
    }
    if (typeof sub.buttonText === "string" && sub.buttonText.trim()) {
      const needle = sub.buttonText.replace(/\s+/g, " ").trim().toLowerCase();
      let exact = null;
      let partial = null;
      for (const btn of document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')) {
        if (btn.disabled || !btn.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const label = String(btn.innerText || btn.value || getAttr(btn, "aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!label) continue;
        if (label === needle) {
          exact = btn;
          break;
        }
        if (!partial && label.includes(needle)) partial = btn;
      }
      const target = exact || partial;
      if (!target) return { ok: false, reason: "unavailable" };
      if (!validateSubmitTarget(target)) return { ok: false, reason: "destination-denied" };
      return { ok: true, kind: "click", target };
    }
    if (selected.length > 0) {
      const last = selected[selected.length - 1][0];
      const form = getForm(last);
      if (!form) return { ok: false, reason: "unavailable" };
      if (!validateFormDestination(form)) return { ok: false, reason: "destination-denied" };
      const defaultSubmitter = associatedSubmitters(form).find((el) => !el.disabled) || null;
      if (defaultSubmitter && !validateSubmitTarget(defaultSubmitter)) return { ok: false, reason: "destination-denied" };
      return { ok: true, kind: "form", form, defaultSubmitter };
    }
    return { ok: false, reason: "unavailable" };
  };

  if (wantsSubmit) {
    const preSubmit = resolveSubmit();
    if (!preSubmit.ok) return preSubmit;
  }

  for (const [input, value] of selected) setNative(input, value);
  for (const [input] of selected) {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  if (wantsSubmit) {
    // Re-verify document origin, token, form destinations, and submitter immediately before submitting.
    if (location.href !== url || (token && globalThis.botkinsFormDocument !== token)) return { ok: false, reason: "destination-denied" };
    for (const [input] of selected) {
      const form = getForm(input);
      if (!validateFormDestination(form)) return { ok: false, reason: "destination-denied" };
    }
    const resolved = resolveSubmit();
    if (!resolved.ok) return resolved;
    if (resolved.kind === "click") {
      resolved.target.click();
    } else if (resolved.kind === "form") {
      if (typeof resolved.form.requestSubmit === "function") {
        resolved.form.requestSubmit(resolved.defaultSubmitter || undefined);
      } else if (resolved.defaultSubmitter) {
        resolved.defaultSubmitter.click();
      } else {
        HTMLFormElement.prototype.submit.call(resolved.form);
      }
    }
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

/** Installs a CDP Fetch browser-boundary guard that aborts any request leaving expectedOrigin or downgrading off HTTPS. */
export async function attachOriginBoundaryGuard(send, subscribe, expectedOrigin) {
  let blocked = null;
  let onBlocked = null;
  const unsubscribe = subscribe((method, params) => {
    if (method !== "Fetch.requestPaused") return;
    const requestId = params?.requestId;
    const targetUrl = params?.request?.url || "";
    if (!requestId) return;
    if (isApprovedHttpsUrl(targetUrl, expectedOrigin)) {
      void send("Fetch.continueRequest", { requestId }).catch(() => {});
      return;
    }
    if (!blocked) {
      blocked = { url: targetUrl, method: params?.request?.method, resourceType: params?.resourceType };
      onBlocked?.(blocked);
    }
    void send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
  });
  try {
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return {
    get blocked() { return blocked; },
    waitForBlock(ms, signal) {
      if (blocked) return Promise.resolve(blocked);
      return new Promise((resolve) => {
        const done = (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          onBlocked = null;
          resolve(value);
        };
        const onAbort = () => done(blocked);
        const timer = setTimeout(() => done(blocked), ms);
        onBlocked = (info) => done(info);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    async detach() {
      unsubscribe();
      try {
        await send("Fetch.disable");
      } catch {}
    },
  };
}

export async function fillPageFields(send, plan, values, signal, options = {}) {
  const targetUrl = plan.document?.url ?? plan.url;
  let expectedOrigin = "";
  try {
    const parsed = new URL(String(targetUrl));
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) expectedOrigin = parsed.origin;
  } catch {}
  if (!expectedOrigin) throw new Error("Open an HTTPS sign-in page.");

  const { subscribe, keepGuard, settleMs = 150 } = options;
  if (plan.submit && typeof subscribe !== "function") {
    throw new Error("Auto-submit is disabled because browser-boundary destination enforcement is unavailable.");
  }

  let guard = null;
  if (typeof subscribe === "function") {
    guard = await attachOriginBoundaryGuard(send, subscribe, expectedOrigin);
  }
  let keepActive = false;
  try {
    const action = plan.submit ? "fill_submit" : "fill";
    const filled = await callInPage(send, browserForm, [action, targetUrl, plan.fields, values, plan.document?.token ?? null, plan.submit ?? null], signal);
    if (filled !== true) {
      if (filled && typeof filled === "object" && filled.reason === "destination-denied") {
        throw new Error("Refused to deliver credentials: effective submit destination is outside the approved HTTPS origin.");
      }
      throw new Error(plan.submit ? "The requested fields or submit button are unavailable." : "The requested fields are unavailable.");
    }
    if (guard) {
      const blocked = await guard.waitForBlock(settleMs, signal);
      if (blocked) {
        throw new Error("Blocked credential submission outside the approved HTTPS origin at the browser boundary.");
      }
      if (keepGuard) {
        keepGuard(guard);
        keepActive = true;
      }
    }
  } finally {
    if (guard && !keepActive) await guard.detach();
  }
}

export async function fillSecurePage(guest, plan, values, signal) {
  const debuggerApi = guest.debugger;
  if (guest.isDestroyed() || guest.getURL() !== plan.url || debuggerApi.isAttached()) throw new Error("Open the requested page.");
  let expectedOrigin = "";
  try {
    const parsed = new URL(String(plan.url));
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) expectedOrigin = parsed.origin;
  } catch {}
  if (!expectedOrigin) throw new Error("Open an HTTPS sign-in page.");
  debuggerApi.attach();
  pinGuestOrigin(guest, expectedOrigin);
  const subscribe = typeof debuggerApi.on === "function"
    ? (listener) => {
        const handler = (_event, method, params) => listener(method, params);
        debuggerApi.on("message", handler);
        return () => debuggerApi.removeListener?.("message", handler);
      }
    : undefined;
  try {
    await fillPageFields(debuggerApi.sendCommand.bind(debuggerApi), plan, values, signal, { subscribe });
  } finally {
    if (!guest.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
  }
}
