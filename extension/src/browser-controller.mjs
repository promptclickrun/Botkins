// Eligible tab filtering, Botkins tab group management, DOM-first scripting automation,
// and ephemeral CDP/chrome.debugger fallback.
//
// Architecture (DOM-first, browser-use style):
// - Primary path uses `chrome.scripting.executeScript` with the injected isolated-world
//   DOM driver (`dist/dom-driver.js`), `world: "MAIN"` for `browser_eval`, and
//   `chrome.tabs.captureVisibleTab` for viewport screenshots.
// - Never attaches `chrome.debugger` during ordinary browsing, so tabs containing other
//   extensions' iframes (Proton Pass, 1Password, Bitwarden, Grammarly, etc.) work without
//   hitting Chrome's "Cannot access a chrome-extension:// URL of different extension" block.
// - Falls back to ephemeral `chrome.debugger` CDP sessions ONLY when required (fullPage
//   screenshots, CSP-blocked eval, raw `browser_cdp`, trusted input / file upload, or a
//   DOM path that reported failure) and ALWAYS detaches immediately in `finally`.
// - Respects `mode`:
//     "all":   every eligible ordinary tab (excluding chrome://, edge://, chrome-extension://,
//              devtools://, incognito, and user-paused tabs).
//     "group": only tabs in the orange "Botkins" tab group. Tabs opened by bots automatically land
//              in the group.

import { DRIVER_VERSION } from "./dom-driver.mjs";

const BLOCKED_SCHEMES = ["chrome:", "edge:", "chrome-extension:", "devtools:", "view-source:", "chrome-untrusted:"];
const CDP_VERSION = "1.3";
const DOM_DRIVER_FILE = "dist/dom-driver.js";

export function isEligibleUrl(url) {
  if (typeof url !== "string" || !url) return true; // newly created blank/loading tab
  const lower = url.toLowerCase();
  if (lower === "about:blank") return true;
  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme)) return false;
  }
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("file://");
}

export function isEligibleTab(tab, settings, groupId) {
  if (!tab || typeof tab.id !== "number") return false;
  if (tab.incognito) return false;
  const paused = Array.isArray(settings?.pausedTabIds) ? settings.pausedTabIds : [];
  if (paused.includes(tab.id)) return false;
  const url = tab.url || tab.pendingUrl || "";
  if (url && !isEligibleUrl(url)) return false;
  if (settings?.mode === "group") {
    return typeof groupId === "number" && tab.groupId === groupId;
  }
  return true;
}

export function isDifferentExtensionCdpError(err) {
  const msg = String(err?.message || err || "");
  return /cannot access a chrome-extension:\/\/.*different extension|cannot access a chrome-extension/i.test(msg);
}

export function formatCdpError(err, action = "this action") {
  if (err?.__botkinsCdpFormatted) return err;
  const msg = err instanceof Error ? err.message : String(err || "Chrome DevTools Protocol error");
  if (isDifferentExtensionCdpError(msg)) {
    const formatted = new Error(
      `Chrome blocked DevTools debugger access on this tab because another extension (such as Proton Pass, 1Password, Bitwarden, or Grammarly) injected a chrome-extension:// iframe. Standard DOM actions work without the debugger, but ${action} required CDP fallback. (${msg})`,
    );
    formatted.__botkinsCdpFormatted = true;
    return formatted;
  }
  return err instanceof Error ? err : new Error(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function urlOrigin(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.origin && parsed.origin !== "null" ? parsed.origin : parsed.protocol;
  } catch {
    return "";
  }
}

function screenshotAbortedError(message) {
  const err = new Error(message);
  err.__botkinsScreenshotAborted = true;
  return err;
}

// Zero-closure function serialized by chrome.scripting.executeScript into target frame(s).
function DISPATCH_DRIVER_FUNC(action, payload, expectedVersion) {
  const driver = globalThis.__botkinsDomDriver;
  if (!driver || driver.version !== expectedVersion) {
    return { __needInstall: true };
  }
  return driver.dispatch(action, payload);
}

// Zero-closure function serialized by chrome.scripting.executeScript into world: "MAIN".
async function EVAL_MAIN_WORLD_FUNC(expression, awaitPromise) {
  try {
    let value;
    try {
      const fn = new Function(`"use strict"; return (\n${expression}\n);`);
      value = fn();
    } catch (syntaxErr) {
      if (syntaxErr instanceof SyntaxError) {
        value = (0, eval)(expression);
      } else {
        throw syntaxErr;
      }
    }
    if (
      awaitPromise &&
      value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof value.then === "function"
    ) {
      value = await value;
    }
    if (value === undefined) return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(JSON.stringify(value)) };
    } catch {
      return { ok: true, value: String(value) };
    }
  } catch (err) {
    const name = err?.name || "";
    const message = err instanceof Error ? err.message : String(err);
    const cspBlocked =
      name === "EvalError" ||
      /unsafe-eval|Content Security Policy|EvalError/i.test(message);
    return { ok: false, cspBlocked, error: message };
  }
}

// Minimal CDP fallback expressions (only used if chrome.scripting cannot run on a page).
const CDP_SNAPSHOT_EXPR = (maxChars) => `(() => {
  const MAX = ${Math.min(Math.max(Number(maxChars) || 12000, 1000), 50000)};
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const selector = 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [contenteditable="true"]';
  const nodes = [...document.querySelectorAll(selector)].filter(visible).slice(0, 180);
  const elements = [];
  let idx = 0;
  for (const el of nodes) {
    const ref = 'e' + (++idx);
    try { el.setAttribute('data-botkins-ref', ref); } catch {}
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const isPw = tag === 'input' && (el.type || '').toLowerCase() === 'password';
    const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || (isPw ? '' : el.value) || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const box = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    const entry = {
      ref,
      tag,
      role: el.getAttribute('role') || tag,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      box,
    };
    if (el.type && tag === 'input') entry.type = el.type;
    if (name) { entry.name = name; entry.text = name; }
    if (isPw) { entry.hasValue = Boolean(el.value); entry.valueState = el.value ? 'filled' : 'empty'; }
    else if (tag === 'input' || tag === 'textarea' || tag === 'select') entry.value = String(el.value || '').slice(0, 200);
    if (tag === 'a' && el.href) entry.href = String(el.href).slice(0, 200);
    if (el.disabled) entry.disabled = true;
    elements.push(entry);
  }
  const rawText = (document.body?.innerText || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) },
    text: rawText.slice(0, MAX),
    truncated: rawText.length > MAX,
    elements,
  };
})()`;

const CDP_FIND_ELEMENT_EXPR = ({ selector, ref, text }) => `(() => {
  const sel = ${JSON.stringify(selector || "")};
  const ref = ${JSON.stringify(ref || "")};
  const txt = ${JSON.stringify(text || "")};
  let el = null;
  if (ref) el = document.querySelector('[data-botkins-ref=' + JSON.stringify(ref) + ']');
  if (!el && sel) el = document.querySelector(sel);
  if (!el && txt) {
    const needle = txt.trim().toLowerCase();
    const candidates = [...document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], input[type="submit"], input[type="button"], label')];
    el = candidates.find((c) => ((c.innerText || c.getAttribute('aria-label') || c.value || '').trim().toLowerCase()) === needle)
      || candidates.find((c) => ((c.innerText || c.getAttribute('aria-label') || c.value || '').trim().toLowerCase()).includes(needle));
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    width: r.width,
    height: r.height,
  };
})()`;

const KEY_CODES = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

export function parseKeyCombo(combo) {
  const parts = String(combo || "").split("+").map((p) => p.trim()).filter(Boolean);
  let modifiers = 0;
  const main = parts.pop() || "Enter";
  for (const mod of parts) {
    const m = mod.toLowerCase();
    if (m === "alt" || m === "option") modifiers |= 1;
    else if (m === "control" || m === "ctrl") modifiers |= 2;
    else if (m === "meta" || m === "cmd" || m === "command") modifiers |= 4;
    else if (m === "shift") modifiers |= 8;
  }
  const known = KEY_CODES[main];
  if (known) return { ...known, modifiers };
  const ch = main;
  const upper = ch.toUpperCase();
  const code = ch.length === 1 && /[a-z]/i.test(ch) ? "Key" + upper : ch.length === 1 && /[0-9]/.test(ch) ? "Digit" + ch : ch;
  return {
    key: ch,
    code,
    windowsVirtualKeyCode: ch.length === 1 ? upper.charCodeAt(0) : 0,
    ...(ch.length === 1 && modifiers === 0 && { text: ch }),
    modifiers,
  };
}

function stripDataUrlPrefix(dataUrl) {
  const str = String(dataUrl || "");
  const idx = str.indexOf("base64,");
  return idx >= 0 ? str.slice(idx + 7) : str;
}

export class BrowserController {
  constructor({ getSettings, uploadScreenshot }) {
    this.getSettings = getSettings;
    this.uploadScreenshot = uploadScreenshot;
    this.attached = new Set(); // active ephemeral debugger sessions
    this.cdpQueues = new Map(); // tabId -> Promise chain
    this.tabRefs = new Map(); // tabId -> Map<globalRef, { frameId, localRef, tag, type, role }>
    this.taintedTabs = new Map(); // tabId -> { origin, url } tabs that received a vault credential
    this._onTaintedTabUpdated = (tabId, changeInfo) => {
      if (this.taintedTabs.has(tabId) && (changeInfo?.status === "loading" || typeof changeInfo?.url === "string")) {
        this.untaintTab(tabId);
      }
    };
    this._watchingTaintedUpdates = false;

    if (typeof chrome !== "undefined" && chrome.debugger?.onDetach) {
      chrome.debugger.onDetach.addListener((source) => {
        if (typeof source?.tabId === "number") {
          this.attached.delete(source.tabId);
        }
      });
    }
    if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        this.tabRefs.delete(tabId);
        this.attached.delete(tabId);
        this.untaintTab(tabId);
      });
    }
  }

  taintTab(tabId, info) {
    this.taintedTabs.set(tabId, info);
    if (!this._watchingTaintedUpdates && typeof chrome !== "undefined" && chrome.tabs?.onUpdated?.addListener) {
      chrome.tabs.onUpdated.addListener(this._onTaintedTabUpdated);
      this._watchingTaintedUpdates = true;
    }
  }

  untaintTab(tabId) {
    this.taintedTabs.delete(tabId);
    if (this._watchingTaintedUpdates && this.taintedTabs.size === 0 && typeof chrome !== "undefined" && chrome.tabs?.onUpdated?.removeListener) {
      chrome.tabs.onUpdated.removeListener(this._onTaintedTabUpdated);
      this._watchingTaintedUpdates = false;
    }
  }

  assertNotTainted(tab, action) {
    const taint = this.taintedTabs.get(tab.id);
    if (!taint) return;
    const currentUrl = tab.url || tab.pendingUrl || "";
    const currentOrigin = urlOrigin(currentUrl);
    if (currentOrigin && currentOrigin !== taint.origin) {
      this.untaintTab(tab.id);
      return;
    }
    throw new Error(
      `Blocked: tab ${tab.id} received a vault credential and cannot run ${action} until it navigates to a new page.`,
    );
  }

  async findBotkinsGroup(windowId) {
    if (!chrome.tabGroups?.query) return null;
    const settings = await this.getSettings();
    const title = settings.groupName || "Botkins";
    const groups = await chrome.tabGroups.query(typeof windowId === "number" ? { windowId, title } : { title });
    return groups[0]?.id ?? null;
  }

  async ensureTabInGroup(tabId, windowId) {
    if (!chrome.tabs?.group || !chrome.tabGroups?.update) return null;
    const settings = await this.getSettings();
    let groupId = await this.findBotkinsGroup(windowId);
    if (groupId != null) {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
      return groupId;
    }
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, {
      title: settings.groupName || "Botkins",
      color: settings.groupColor || "orange",
      collapsed: false,
    });
    return groupId;
  }

  async detachAllExcept(keepIds = new Set()) {
    for (const tabId of [...this.attached]) {
      if (keepIds.has(tabId)) continue;
      await this.detach(tabId);
    }
  }

  async detach(tabId) {
    this.attached.delete(tabId);
    try {
      await chrome.debugger?.detach?.({ tabId });
    } catch {}
  }

  // Runs a CDP session ephemerally and ALWAYS detaches in `finally` so no debugger
  // is ever left attached to the tab.
  async withDebugger(tabId, fn, actionDesc = "this action") {
    const prev = this.cdpQueues.get(tabId) || Promise.resolve();
    let release;
    const current = new Promise((r) => (release = r));
    this.cdpQueues.set(tabId, prev.then(() => current));

    await prev;
    let shouldDetach = false;
    try {
      if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand) {
        throw new Error("chrome.debugger API is unavailable.");
      }
      try {
        await chrome.debugger.attach({ tabId }, CDP_VERSION);
        this.attached.add(tabId);
        shouldDetach = true;
      } catch (err) {
        if (/already attached/i.test(String(err?.message || err))) {
          this.attached.add(tabId);
          shouldDetach = true;
        } else {
          throw formatCdpError(err, actionDesc);
        }
      }
      return await fn(async (method, params = {}) => {
        try {
          return await chrome.debugger.sendCommand({ tabId }, method, params);
        } catch (err) {
          throw formatCdpError(err, actionDesc);
        }
      });
    } catch (err) {
      throw formatCdpError(err, actionDesc);
    } finally {
      if (shouldDetach) {
        await this.detach(tabId);
      }
      release();
      if (this.cdpQueues.get(tabId) === current) {
        this.cdpQueues.delete(tabId);
      }
    }
  }

  async cdp(tabId, method, params = {}, actionDesc = `CDP ${method}`) {
    return await this.withDebugger(tabId, (send) => send(method, params), actionDesc);
  }

  async evaluateCdp(tabId, expression, awaitPromise = true, actionDesc = "JavaScript evaluation") {
    return await this.withDebugger(
      tabId,
      async (send) => {
        const res = await send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise,
          userGesture: true,
        });
        if (res?.exceptionDetails) {
          const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Script evaluation failed";
          throw new Error(msg);
        }
        return res?.result?.value;
      },
      actionDesc,
    );
  }

  hasScripting() {
    return typeof chrome !== "undefined" && typeof chrome.scripting?.executeScript === "function";
  }

  async executeScripting(target, spec) {
    if (!this.hasScripting()) {
      throw new Error("chrome.scripting API is unavailable.");
    }
    return await chrome.scripting.executeScript({ target, ...spec });
  }

  // Runs a DOM driver action in the target frame(s), automatically injecting
  // `dist/dom-driver.js` whenever a frame does not yet have the current driver installed.
  async execDriver(tabId, action, payload = {}, { allFrames = false, frameIds = null } = {}) {
    let target = frameIds ? { tabId, frameIds } : allFrames ? { tabId, allFrames: true } : { tabId, frameIds: [0] };
    let usedAllFrames = Boolean(allFrames && !frameIds);

    const invoke = async (tgt, act, data) => {
      try {
        return await this.executeScripting(tgt, {
          func: DISPATCH_DRIVER_FUNC,
          args: [act, data, DRIVER_VERSION],
        });
      } catch (err) {
        if (tgt.allFrames) {
          usedAllFrames = false;
          target = { tabId, frameIds: [0] };
          return await this.executeScripting(target, {
            func: DISPATCH_DRIVER_FUNC,
            args: [act, data, DRIVER_VERSION],
          });
        }
        throw err;
      }
    };

    let results = (await invoke(target, action, payload)) || [];
    const needingInstall = results.filter((r) => r?.result?.__needInstall === true);

    if (needingInstall.length > 0) {
      const installFrameIds = needingInstall
        .map((r) => r.frameId)
        .filter((id) => typeof id === "number");
      const installTarget =
        installFrameIds.length > 0 ? { tabId, frameIds: installFrameIds } : target;
      try {
        await this.executeScripting(installTarget, { files: [DOM_DRIVER_FILE] });
      } catch (err) {
        if (installTarget.allFrames) {
          usedAllFrames = false;
          await this.executeScripting({ tabId, frameIds: [0] }, { files: [DOM_DRIVER_FILE] });
        } else {
          throw err;
        }
      }
      const rerunPayload =
        action === "snapshot" && !usedAllFrames
          ? { ...payload, traverseSameOriginIframes: true }
          : payload;
      const rerunResults = (await invoke(installTarget, action, rerunPayload)) || [];
      const rerunByFrame = new Map(rerunResults.map((r) => [r?.frameId ?? 0, r]));
      results = results.map((r) => {
        const fid = r?.frameId ?? 0;
        return r?.result?.__needInstall && rerunByFrame.has(fid) ? rerunByFrame.get(fid) : r;
      });
    }

    const normalized = results
      .filter((r) => r && r.result != null && r.result.__needInstall !== true)
      .map((r) => ({ frameId: typeof r.frameId === "number" ? r.frameId : 0, result: r.result }))
      .sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));

    return { frames: normalized, usedAllFrames };
  }

  async findTargetFrame(tabId, query) {
    if (query.ref) {
      const mapped = this.tabRefs.get(tabId)?.get(query.ref);
      if (mapped) return { frameId: mapped.frameId, localRef: mapped.localRef };
    }
    const { frames } = await this.execDriver(tabId, "probe", query, { allFrames: true });
    const hit = frames.find((f) => f.result?.found === true);
    if (hit) return { frameId: hit.frameId, localRef: query.ref };
    return null;
  }

  async resolveTab(tabId) {
    const settings = await this.getSettings();
    const groupId = settings.mode === "group" ? await this.findBotkinsGroup() : null;
    if (typeof tabId === "number") {
      const tab = await chrome.tabs.get(tabId);
      if (!isEligibleTab(tab, settings, groupId)) {
        throw new Error(
          settings.mode === "group"
            ? `Tab ${tabId} is not in the "${settings.groupName || "Botkins"}" tab group or is paused/restricted.`
            : `Tab ${tabId} is paused, incognito, or an internal browser page.`,
        );
      }
      return tab;
    }
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const eligibleActive = activeTabs.find((tab) => isEligibleTab(tab, settings, groupId));
    if (eligibleActive) return eligibleActive;
    const allTabs = await chrome.tabs.query({});
    const eligible = allTabs.filter((tab) => isEligibleTab(tab, settings, groupId));
    if (eligible.length) return eligible[0];
    throw new Error(
      settings.mode === "group"
        ? `No open tab in the "${settings.groupName || "Botkins"}" tab group. Use browser_open to open one, or switch access mode to All tabs in the extension.`
        : "No eligible browser tab is open. Use browser_open to open one.",
    );
  }

  async waitForLoad(tabId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") return tab;
      } catch {
        return null;
      }
      await sleep(150);
    }
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  async runSnapshot(tab, args) {
    const maxChars = Math.min(Math.max(Number(args.maxChars) || 12000, 1000), 50000);
    if (this.hasScripting()) {
      try {
        const { frames, usedAllFrames } = await this.execDriver(
          tab.id,
          "snapshot",
          {
            maxChars,
            maxElements: 200,
            traverseSameOriginIframes: false,
            includeBlankIframes: true,
          },
          { allFrames: true },
        );

        // If allFrames fell back to top frame only, re-run snapshot allowing same-origin iframe traversal.
        let frameSnapshots = frames;
        if (!usedAllFrames && frames.length === 1 && frames[0].frameId === 0) {
          const retry = await this.execDriver(
            tab.id,
            "snapshot",
            {
              maxChars,
              maxElements: 200,
              traverseSameOriginIframes: true,
              includeBlankIframes: true,
            },
            { frameIds: [0] },
          );
          if (retry.frames.length) frameSnapshots = retry.frames;
        }

        if (frameSnapshots.length > 0) {
          const top = frameSnapshots.find((f) => f.frameId === 0) || frameSnapshots[0];
          const refMap = new Map();
          const elements = [];
          const textParts = [];
          let globalIdx = 0;

          for (const frame of frameSnapshots) {
            const snap = frame.result;
            if (!snap) continue;
            // Skip about:blank / about:srcdoc subframes because their parent frame already walked them.
            const frameUrlLower = String(snap.url || "").toLowerCase();
            if (frame.frameId !== 0 && (frameUrlLower === "about:blank" || frameUrlLower === "about:srcdoc")) {
              continue;
            }
            if (snap.text) {
              textParts.push(frame.frameId === 0 ? snap.text : `[frame ${frame.frameId}: ${snap.url || "subframe"}]\n${snap.text}`);
            }
            for (const el of snap.elements || []) {
              if (elements.length >= 250) break;
              const globalRef = "e" + ++globalIdx;
              refMap.set(globalRef, {
                frameId: frame.frameId,
                localRef: el.ref,
                tag: el.tag,
                type: el.type || "",
                role: el.role || "",
              });
              const out = { ...el, ref: globalRef };
              if (frame.frameId !== 0) {
                out.frameId = frame.frameId;
                if (snap.url && snap.url !== top.result?.url) out.frameUrl = snap.url.slice(0, 200);
              }
              elements.push(out);
            }
          }

          this.tabRefs.set(tab.id, refMap);
          const combinedText = textParts.join("\n\n").trim();
          return {
            tabId: tab.id,
            url: top.result?.url || tab.url || "",
            title: top.result?.title || tab.title || "",
            viewport: top.result?.viewport || { width: 0, height: 0, scrollX: 0, scrollY: 0 },
            text: combinedText.slice(0, maxChars),
            truncated: combinedText.length > maxChars || Boolean(top.result?.truncated),
            elements,
            ...(frameSnapshots.length > 1 && { frames: frameSnapshots.length }),
          };
        }
      } catch {
        // Fall through to ephemeral CDP fallback only when scripting fails.
      }
    }

    const snap = await this.evaluateCdp(tab.id, CDP_SNAPSHOT_EXPR(maxChars), false, "page snapshot");
    this.tabRefs.delete(tab.id);
    return { tabId: tab.id, ...(snap || {}) };
  }

  async runScreenshot(tab, args) {
    const quality = Math.min(Math.max(Number(args.quality) || 70, 20), 90);
    const targetTabId = tab.id;
    const targetWindowId = tab.windowId;
    const expectedUrl = tab.url || tab.pendingUrl || "";
    const expectedOrigin = urlOrigin(expectedUrl);
    let b64 = null;
    let verifiedTab = tab;

    const assertTargetTabStable = async (phase) => {
      let activeAfter;
      let currentTab;
      try {
        [activeAfter] = await chrome.tabs.query({ active: true, windowId: targetWindowId });
        currentTab = await chrome.tabs.get(targetTabId);
      } catch {
        throw screenshotAbortedError(
          `Screenshot discarded: could not verify target tab ${targetTabId} in window ${targetWindowId} ${phase}.`,
        );
      }
      if (!activeAfter || activeAfter.id !== targetTabId) {
        throw screenshotAbortedError(
          `Screenshot discarded: active tab in window ${targetWindowId} changed away from target tab ${targetTabId} ${phase}.`,
        );
      }
      if (!currentTab || currentTab.windowId !== targetWindowId || currentTab.active === false) {
        throw screenshotAbortedError(
          `Screenshot discarded: target tab ${targetTabId} is no longer active in window ${targetWindowId} ${phase}.`,
        );
      }
      const currentUrl = currentTab.url || currentTab.pendingUrl || "";
      const pendingMismatch =
        typeof currentTab.pendingUrl === "string" &&
        currentTab.pendingUrl.length > 0 &&
        currentTab.pendingUrl !== expectedUrl;
      if (pendingMismatch || currentUrl !== expectedUrl || urlOrigin(currentUrl) !== expectedOrigin) {
        throw screenshotAbortedError(
          `Screenshot discarded: target tab ${targetTabId} URL or origin changed ${phase}.`,
        );
      }
      return currentTab;
    };

    if (args.fullPage === true) {
      const shot = await this.cdp(
        targetTabId,
        "Page.captureScreenshot",
        { format: "jpeg", quality, captureBeyondViewport: true },
        "full-page screenshot (try fullPage: false for a viewport screenshot without the debugger)",
      );
      b64 = shot?.data || null;
    } else if (typeof chrome.tabs?.captureVisibleTab === "function") {
      let prevActiveId = null;
      let sawInterference = false;
      try {
        let preTab;
        try {
          preTab = await chrome.tabs.get(targetTabId);
        } catch {
          throw screenshotAbortedError(
            `Screenshot discarded: target tab ${targetTabId} is no longer available before capture.`,
          );
        }
        const preUrl = preTab.url || preTab.pendingUrl || "";
        const prePendingMismatch =
          typeof preTab.pendingUrl === "string" &&
          preTab.pendingUrl.length > 0 &&
          preTab.pendingUrl !== expectedUrl;
        if (
          preTab.windowId !== targetWindowId ||
          prePendingMismatch ||
          preUrl !== expectedUrl ||
          urlOrigin(preUrl) !== expectedOrigin
        ) {
          throw screenshotAbortedError(
            `Screenshot discarded: target tab ${targetTabId} changed window or URL before capture.`,
          );
        }

        let latestPreTab = preTab;
        const [activeBefore] = await chrome.tabs.query({ active: true, windowId: targetWindowId });
        if (!activeBefore || activeBefore.id !== targetTabId) {
          if (activeBefore && activeBefore.id !== targetTabId) prevActiveId = activeBefore.id;
          await chrome.tabs.update(targetTabId, { active: true });
          await sleep(80);
          latestPreTab = await assertTargetTabStable("before capture");
        }

        const initialStatus = latestPreTab.status;
        const MAX_CAPTURE_ATTEMPTS = 2;
        const addListener = (event, fn) => {
          if (typeof event?.addListener === "function") event.addListener(fn);
        };
        const removeListener = (event, fn) => {
          if (typeof event?.removeListener === "function") event.removeListener(fn);
        };

        for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt++) {
          let generation = 0;
          const startGeneration = generation;
          let dirtyReason = null;
          let canRetry = true;
          let targetWindowFocused = null;

          const markDirty = (reason, retryable = true) => {
            generation += 1;
            if (!dirtyReason || (!retryable && canRetry)) {
              dirtyReason = reason;
            }
            if (!retryable) canRetry = false;
          };

          const onActivated = (activeInfo) => {
            if (!activeInfo || activeInfo.windowId === targetWindowId || activeInfo.tabId === targetTabId) {
              markDirty(`active tab in window ${targetWindowId} changed during capture`, true);
            }
          };

          const onFocusChanged = (windowId) => {
            const focusedNow = windowId === targetWindowId;
            if (targetWindowFocused === null || targetWindowFocused || focusedNow) {
              markDirty(`window ${targetWindowId} focus changed during capture`, true);
            }
            targetWindowFocused = focusedNow;
          };

          const onUpdated = (tabId, changeInfo, updatedTab) => {
            if (tabId !== targetTabId) return;
            if (updatedTab?.windowId !== undefined && updatedTab.windowId !== targetWindowId) {
              markDirty(`target tab ${targetTabId} moved out of window ${targetWindowId} during capture`, false);
              return;
            }
            if (typeof changeInfo?.url === "string") {
              markDirty(`target tab ${targetTabId} URL changed during capture`, false);
              return;
            }
            if (changeInfo?.status === "loading") {
              markDirty(`target tab ${targetTabId} started navigating during capture`, false);
              return;
            }
            if (changeInfo?.status === "complete") {
              markDirty(
                `target tab ${targetTabId} finished navigating during capture`,
                initialStatus !== "complete",
              );
            }
          };

          const onDetached = (tabId) => {
            if (tabId === targetTabId) {
              markDirty(`target tab ${targetTabId} was detached from window ${targetWindowId} during capture`, false);
            }
          };

          const onRemoved = (tabId) => {
            if (tabId === targetTabId) {
              markDirty(`target tab ${targetTabId} was closed during capture`, false);
            }
          };

          addListener(chrome.tabs?.onActivated, onActivated);
          addListener(chrome.windows?.onFocusChanged, onFocusChanged);
          addListener(chrome.tabs?.onUpdated, onUpdated);
          addListener(chrome.tabs?.onDetached, onDetached);
          addListener(chrome.tabs?.onRemoved, onRemoved);

          let dataUrl = null;
          try {
            if (typeof chrome.windows?.get === "function") {
              try {
                const win = await chrome.windows.get(targetWindowId);
                if (generation === startGeneration && typeof win?.focused === "boolean") {
                  targetWindowFocused = win.focused;
                }
              } catch {}
            }

            await assertTargetTabStable("before capture");
            if (generation !== startGeneration) {
              sawInterference = true;
              if (canRetry && attempt + 1 < MAX_CAPTURE_ATTEMPTS) continue;
              throw screenshotAbortedError(
                `Screenshot discarded: ${dirtyReason || `active tab in window ${targetWindowId} changed during capture`}.`,
              );
            }

            try {
              dataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, { format: "jpeg", quality });
            } catch (capErr) {
              if (generation !== startGeneration) {
                sawInterference = true;
                if (canRetry && attempt + 1 < MAX_CAPTURE_ATTEMPTS) continue;
                throw screenshotAbortedError(
                  `Screenshot discarded: ${dirtyReason || `active tab in window ${targetWindowId} changed during capture`}.`,
                );
              }
              throw capErr;
            }

            if (generation !== startGeneration) {
              // Explicitly discard captured image data whenever a tab/window/navigation event arrived.
              dataUrl = null;
              sawInterference = true;
              if (canRetry && attempt + 1 < MAX_CAPTURE_ATTEMPTS) continue;
              throw screenshotAbortedError(
                `Screenshot discarded: ${dirtyReason || `active tab in window ${targetWindowId} changed during capture`}.`,
              );
            }

            try {
              verifiedTab = await assertTargetTabStable("during capture");
            } catch (verifyErr) {
              dataUrl = null;
              throw verifyErr;
            }

            if (generation !== startGeneration) {
              dataUrl = null;
              sawInterference = true;
              if (canRetry && attempt + 1 < MAX_CAPTURE_ATTEMPTS) continue;
              throw screenshotAbortedError(
                `Screenshot discarded: ${dirtyReason || `active tab in window ${targetWindowId} changed during capture`}.`,
              );
            }

            b64 = stripDataUrlPrefix(dataUrl);
            break;
          } finally {
            removeListener(chrome.tabs?.onActivated, onActivated);
            removeListener(chrome.windows?.onFocusChanged, onFocusChanged);
            removeListener(chrome.tabs?.onUpdated, onUpdated);
            removeListener(chrome.tabs?.onDetached, onDetached);
            removeListener(chrome.tabs?.onRemoved, onRemoved);
          }
        }
      } catch (err) {
        if (err?.__botkinsScreenshotAborted) throw err;
        await assertTargetTabStable("during capture");
        // Fall back to ephemeral CDP viewport capture only if captureVisibleTab fails while target tab is still active and unchanged.
        const shot = await this.cdp(targetTabId, "Page.captureScreenshot", { format: "jpeg", quality }, "viewport screenshot fallback");
        b64 = shot?.data || null;
      } finally {
        if (prevActiveId != null && !sawInterference) {
          const [activeNow] = await chrome.tabs.query({ active: true, windowId: targetWindowId }).catch(() => []);
          if (!activeNow || activeNow.id === targetTabId) {
            await chrome.tabs.update(prevActiveId, { active: true }).catch(() => {});
          }
        }
      }
    } else {
      const shot = await this.cdp(targetTabId, "Page.captureScreenshot", { format: "jpeg", quality }, "screenshot");
      b64 = shot?.data || null;
    }

    if (!b64) throw new Error("Screenshot capture returned no image data.");
    const path = await this.uploadScreenshot(b64, `browser-tab-${targetTabId}.jpg`, "image/jpeg");
    return {
      tabId: targetTabId,
      url: verifiedTab.url || tab.url || "",
      title: verifiedTab.title || tab.title || "",
      format: "jpeg",
      path,
    };
  }

  async clickViaCdp(tab, args, hintCoords = null) {
    return await this.withDebugger(
      tab.id,
      async (send) => {
        let x = Number.isFinite(hintCoords?.x) ? hintCoords.x : Number(args.x);
        let y = Number.isFinite(hintCoords?.y) ? hintCoords.y : Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          const evalRes = await send("Runtime.evaluate", {
            expression: CDP_FIND_ELEMENT_EXPR(args),
            returnByValue: true,
            awaitPromise: false,
            userGesture: true,
          });
          const found = evalRes?.result?.value;
          if (!found) throw new Error("Element not found for click.");
          x = found.x;
          y = found.y;
        }
        const clicks = args.doubleClick ? 2 : 1;
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (let i = 1; i <= clicks; i++) {
          await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: i });
          await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: i });
        }
        await sleep(150);
        const after = await chrome.tabs.get(tab.id).catch(() => tab);
        return { clicked: true, tabId: tab.id, x: Math.round(x), y: Math.round(y), url: after.url || "", title: after.title || "" };
      },
      "trusted click fallback",
    );
  }

  async runClick(tab, args) {
    if (this.hasScripting()) {
      try {
        let domRes = null;
        if (args.ref) {
          const mapped = this.tabRefs.get(tab.id)?.get(args.ref);
          if (mapped) {
            const { frames } = await this.execDriver(
              tab.id,
              "click",
              { ref: mapped.localRef, doubleClick: Boolean(args.doubleClick) },
              { frameIds: [mapped.frameId] },
            );
            domRes = frames[0]?.result || null;
          } else {
            const hit = await this.findTargetFrame(tab.id, { ref: args.ref });
            if (hit) {
              const { frames } = await this.execDriver(
                tab.id,
                "click",
                { ref: hit.localRef, doubleClick: Boolean(args.doubleClick) },
                { frameIds: [hit.frameId] },
              );
              domRes = frames[0]?.result || null;
            }
          }
        } else if (args.selector || args.text) {
          const payload = { selector: args.selector, text: args.text, doubleClick: Boolean(args.doubleClick) };
          const topRun = await this.execDriver(tab.id, "click", payload, { frameIds: [0] });
          domRes = topRun.frames[0]?.result || null;
          if (!domRes?.ok && !domRes?.found && !domRes?.needsCdp) {
            const hit = await this.findTargetFrame(tab.id, { selector: args.selector, text: args.text });
            if (hit && hit.frameId !== 0) {
              const subRun = await this.execDriver(tab.id, "click", payload, { frameIds: [hit.frameId] });
              domRes = subRun.frames[0]?.result || domRes;
            }
          }
        } else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
          const topRun = await this.execDriver(
            tab.id,
            "click",
            { x: Number(args.x), y: Number(args.y), doubleClick: Boolean(args.doubleClick) },
            { frameIds: [0] },
          );
          domRes = topRun.frames[0]?.result || null;
        } else {
          throw new Error("Provide ref, selector, text, or x/y coordinates to click.");
        }

        if (domRes?.ok) {
          await sleep(150);
          const after = await chrome.tabs.get(tab.id).catch(() => tab);
          return {
            clicked: true,
            tabId: tab.id,
            x: domRes.x,
            y: domRes.y,
            url: after.url || "",
            title: after.title || "",
          };
        }
        if (domRes && !domRes.needsCdp) {
          throw new Error(domRes.error || "Element not found for click.");
        }
        if (domRes?.needsCdp) {
          return await this.clickViaCdp(tab, args, Number.isFinite(domRes.x) && Number.isFinite(domRes.y) ? { x: domRes.x, y: domRes.y } : null);
        }
      } catch (err) {
        // Re-throw clear DOM lookup errors instead of falling back to CDP unnecessarily.
        if (err instanceof Error && /not found|provide ref|extension's iframe/i.test(err.message)) {
          throw err;
        }
        // Otherwise fall back to ephemeral CDP click.
      }
    }

    return await this.clickViaCdp(tab, args);
  }

  async typeViaCdp(tab, args) {
    const text = String(args.text ?? "");
    return await this.withDebugger(
      tab.id,
      async (send) => {
        if (args.ref || args.selector) {
          const evalRes = await send("Runtime.evaluate", {
            expression: CDP_FIND_ELEMENT_EXPR(args),
            returnByValue: true,
            awaitPromise: false,
            userGesture: true,
          });
          const found = evalRes?.result?.value;
          if (!found) throw new Error("Input element not found.");
          await send("Input.dispatchMouseEvent", { type: "mousePressed", x: found.x, y: found.y, button: "left", clickCount: 1 });
          await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: found.x, y: found.y, button: "left", clickCount: 1 });
        }
        if (args.clear) {
          await send("Runtime.evaluate", {
            expression: `(() => {
              const el = document.activeElement;
              if (!el) return;
              if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
              else if (el.isContentEditable) { el.textContent = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
            })()`,
            returnByValue: true,
            awaitPromise: false,
          });
        }
        if (text) {
          await send("Input.insertText", { text });
        }
        if (args.submit) {
          const enter = parseKeyCombo("Enter");
          await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...enter });
          await send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
          await send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
        }
        return { typed: true, tabId: tab.id, length: text.length };
      },
      "trusted typing fallback",
    );
  }

  async runType(tab, args) {
    const text = String(args.text ?? "");
    if (this.hasScripting()) {
      try {
        const basePayload = {
          text,
          clear: Boolean(args.clear),
          submit: Boolean(args.submit),
        };
        let domRes = null;

        if (args.ref) {
          const mapped = this.tabRefs.get(tab.id)?.get(args.ref);
          if (mapped) {
            const { frames } = await this.execDriver(tab.id, "type", { ...basePayload, ref: mapped.localRef }, { frameIds: [mapped.frameId] });
            domRes = frames[0]?.result || null;
          } else {
            const hit = await this.findTargetFrame(tab.id, { ref: args.ref });
            if (hit) {
              const { frames } = await this.execDriver(tab.id, "type", { ...basePayload, ref: hit.localRef }, { frameIds: [hit.frameId] });
              domRes = frames[0]?.result || null;
            }
          }
        } else if (args.selector) {
          const topRun = await this.execDriver(tab.id, "type", { ...basePayload, selector: args.selector }, { frameIds: [0] });
          domRes = topRun.frames[0]?.result || null;
          if (!domRes?.ok && !domRes?.found && !domRes?.needsCdp) {
            const hit = await this.findTargetFrame(tab.id, { selector: args.selector });
            if (hit && hit.frameId !== 0) {
              const subRun = await this.execDriver(tab.id, "type", { ...basePayload, selector: args.selector }, { frameIds: [hit.frameId] });
              domRes = subRun.frames[0]?.result || domRes;
            }
          }
        } else {
          const topRun = await this.execDriver(tab.id, "type", basePayload, { frameIds: [0] });
          domRes = topRun.frames[0]?.result || null;
          if (!domRes?.ok && !domRes?.found && !domRes?.needsCdp) {
            const hit = await this.findTargetFrame(tab.id, { focused: true });
            if (hit && hit.frameId !== 0) {
              const subRun = await this.execDriver(tab.id, "type", basePayload, { frameIds: [hit.frameId] });
              domRes = subRun.frames[0]?.result || domRes;
            }
          }
        }

        if (domRes?.ok) {
          return { typed: true, tabId: tab.id, length: text.length };
        }
        if (domRes?.reason === "file-input") {
          throw new Error(domRes.error || "File inputs cannot be filled by typing; use browser_cdp with DOM.setFileInputFiles.");
        }
        if (domRes && !domRes.needsCdp) {
          throw new Error(domRes.error || "Input element not found.");
        }
      } catch (err) {
        if (err instanceof Error && /not found|disabled|file input|option not found|no focused/i.test(err.message)) {
          throw err;
        }
        // Otherwise fall back to ephemeral CDP typing.
      }
    }

    return await this.typeViaCdp(tab, args);
  }

  async runSelect(tab, args) {
    const payload = {
      ...(args.value != null && { value: args.value }),
      ...(args.text != null && { text: args.text }),
      ...(args.label != null && { label: args.label }),
      ...(args.index != null && { index: args.index }),
    };

    let domRes = null;
    if (args.ref) {
      const mapped = this.tabRefs.get(tab.id)?.get(args.ref);
      if (mapped) {
        const { frames } = await this.execDriver(tab.id, "select", { ...payload, ref: mapped.localRef }, { frameIds: [mapped.frameId] });
        domRes = frames[0]?.result || null;
      } else {
        const hit = await this.findTargetFrame(tab.id, { ref: args.ref });
        if (hit) {
          const { frames } = await this.execDriver(tab.id, "select", { ...payload, ref: hit.localRef }, { frameIds: [hit.frameId] });
          domRes = frames[0]?.result || null;
        }
      }
    } else if (args.selector) {
      const topRun = await this.execDriver(tab.id, "select", { ...payload, selector: args.selector }, { frameIds: [0] });
      domRes = topRun.frames[0]?.result || null;
      if (!domRes?.ok && !domRes?.found) {
        const hit = await this.findTargetFrame(tab.id, { selector: args.selector });
        if (hit && hit.frameId !== 0) {
          const subRun = await this.execDriver(tab.id, "select", { ...payload, selector: args.selector }, { frameIds: [hit.frameId] });
          domRes = subRun.frames[0]?.result || domRes;
        }
      }
    } else {
      throw new Error("Provide ref or selector for select.");
    }

    if (!domRes?.ok) {
      throw new Error(domRes?.error || "Select element not found.");
    }
    return { selected: true, tabId: tab.id, value: domRes.value, text: domRes.text };
  }

  async runPress(tab, args) {
    const spec = parseKeyCombo(args.key);
    if (this.hasScripting()) {
      try {
        const { frames } = await this.execDriver(
          tab.id,
          "press",
          { ...spec, rawKey: String(args.key) },
          { frameIds: [0] },
        );
        const domRes = frames[0]?.result;
        if (domRes?.ok) {
          return { pressed: String(args.key), tabId: tab.id };
        }
      } catch {
        // Fall through to ephemeral CDP Input.dispatchKeyEvent fallback.
      }
    }

    await this.withDebugger(
      tab.id,
      async (send) => {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...spec });
        if (spec.text) {
          await send("Input.dispatchKeyEvent", { type: "char", text: spec.text, modifiers: spec.modifiers });
        }
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...spec });
      },
      "keyboard press fallback",
    );
    return { pressed: String(args.key), tabId: tab.id };
  }

  async runScroll(tab, args) {
    const dir = args.direction || "down";
    const amount = Math.min(Math.max(Number(args.amount) || 600, 50), 10000);
    if (this.hasScripting()) {
      try {
        const mapped = args.ref ? this.tabRefs.get(tab.id)?.get(args.ref) : null;
        const frameIds = mapped ? [mapped.frameId] : [0];
        const { frames } = await this.execDriver(
          tab.id,
          "scroll",
          {
            direction: dir,
            amount,
            ...(args.selector && { selector: args.selector }),
            ...(mapped ? { ref: mapped.localRef } : args.ref ? { ref: args.ref } : {}),
          },
          { frameIds },
        );
        const pos = frames[0]?.result;
        if (pos?.ok) {
          return { tabId: tab.id, scrollX: pos.scrollX, scrollY: pos.scrollY, scrollHeight: pos.scrollHeight };
        }
        if (pos && pos.found === false) {
          throw new Error(pos.error || "Scroll target element not found.");
        }
      } catch (err) {
        if (err instanceof Error && /not found/i.test(err.message)) throw err;
        // Fall through to CDP fallback only if scripting fails.
      }
    }

    const pos = await this.evaluateCdp(
      tab.id,
      `(() => {
        const target = ${JSON.stringify(args.selector || "")} ? document.querySelector(${JSON.stringify(args.selector || "")}) : null;
        const scroller = target || document.scrollingElement || document.documentElement;
        if (${JSON.stringify(dir)} === 'top') scroller.scrollTop = 0;
        else if (${JSON.stringify(dir)} === 'bottom') scroller.scrollTop = scroller.scrollHeight;
        else if (${JSON.stringify(dir)} === 'up') scroller.scrollBy(0, -${amount});
        else scroller.scrollBy(0, ${amount});
        return { scrollX: Math.round(scroller.scrollLeft || window.scrollX), scrollY: Math.round(scroller.scrollTop || window.scrollY), scrollHeight: scroller.scrollHeight };
      })()`,
      false,
      "scroll fallback",
    );
    return { tabId: tab.id, ...(pos || {}) };
  }

  async runWait(tab, args) {
    const hasCondition = Boolean(args.selector || args.text || args.urlContains);
    if (!hasCondition) {
      const ms = Math.min(Math.max(Number(args.ms) || 1000, 50), 15_000);
      await sleep(ms);
      return { waitedMs: ms, tabId: tab.id };
    }
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 10_000, 200), 25_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (args.urlContains) {
        const current = await chrome.tabs.get(tab.id);
        if ((current.url || "").includes(args.urlContains)) {
          return { matched: "url", tabId: tab.id, url: current.url };
        }
      }
      if (args.selector || args.text) {
        let matched = false;
        if (this.hasScripting()) {
          try {
            const { frames } = await this.execDriver(
              tab.id,
              "checkWait",
              { selector: args.selector || "", text: args.text || "" },
              { allFrames: true },
            );
            matched = frames.some((f) => f.result?.matched === true);
          } catch {
            matched = Boolean(
              await this.evaluateCdp(
                tab.id,
                `(() => {
                  const sel = ${JSON.stringify(args.selector || "")};
                  const txt = ${JSON.stringify(args.text || "")};
                  if (sel && !document.querySelector(sel)) return false;
                  if (txt && !(document.body?.innerText || '').includes(txt)) return false;
                  return true;
                })()`,
                false,
                "wait condition fallback",
              ),
            );
          }
        } else {
          matched = Boolean(
            await this.evaluateCdp(
              tab.id,
              `(() => {
                const sel = ${JSON.stringify(args.selector || "")};
                const txt = ${JSON.stringify(args.text || "")};
                if (sel && !document.querySelector(sel)) return false;
                if (txt && !(document.body?.innerText || '').includes(txt)) return false;
                return true;
              })()`,
              false,
              "wait condition",
            ),
          );
        }
        if (matched) return { matched: args.selector ? "selector" : "text", tabId: tab.id };
      }
      await sleep(250);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for page condition.`);
  }

  async runEval(tab, args) {
    this.assertNotTainted(tab, "browser_eval");
    const expression = String(args.expression || "");
    const awaitPromise = args.awaitPromise !== false;

    if (this.hasScripting()) {
      let cspBlocked = false;
      let scriptingFailed = false;
      try {
        const results = await this.executeScripting(
          { tabId: tab.id },
          {
            world: "MAIN",
            func: EVAL_MAIN_WORLD_FUNC,
            args: [expression, awaitPromise],
          },
        );
        const res = results?.[0]?.result;
        if (res?.ok === true) {
          return { tabId: tab.id, result: res.value ?? null };
        }
        if (res?.ok === false && res.cspBlocked) {
          cspBlocked = true;
        } else if (res?.ok === false) {
          throw new Error(res.error || "Script evaluation failed");
        } else {
          scriptingFailed = true;
        }
      } catch (err) {
        if (!cspBlocked && !scriptingFailed) {
          // If it's a normal error thrown from res.ok === false above, rethrow directly.
          if (err instanceof Error && !/scripting|executeScript|Cannot access|world/i.test(err.message)) {
            throw err;
          }
          scriptingFailed = true;
        }
      }

      if (cspBlocked || scriptingFailed) {
        const value = await this.evaluateCdp(
          tab.id,
          expression,
          awaitPromise,
          cspBlocked ? "JavaScript evaluation (page CSP blocked MAIN-world eval)" : "JavaScript evaluation fallback",
        );
        return { tabId: tab.id, result: value ?? null };
      }
    }

    const value = await this.evaluateCdp(tab.id, expression, awaitPromise, "JavaScript evaluation");
    return { tabId: tab.id, result: value ?? null };
  }

  async runSecureFill(tab, args) {
    if (!this.hasScripting()) {
      throw new Error("Secure credential fill requires Chrome scripting API support.");
    }
    const expectedOrigin = urlOrigin(args.expectedOrigin || "");
    if (!expectedOrigin) {
      throw new Error("Secure credential fill requires a valid expectedOrigin.");
    }
    const tabUrl = tab.url || tab.pendingUrl || "";
    const currentOrigin = urlOrigin(tabUrl);
    if (!currentOrigin || currentOrigin !== expectedOrigin) {
      throw new Error(`Origin mismatch: active tab is on ${currentOrigin || "an unknown origin"}, not ${expectedOrigin}.`);
    }
    if (!tabUrl.startsWith("https://")) {
      const localOk = Boolean(args.allowLocalHttp) && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//i.test(tabUrl);
      if (!localOk) {
        throw new Error("Secure credential fill requires an HTTPS page.");
      }
    }

    if (args.submit) {
      throw new Error(
        "Auto-submit is disabled for extension_fill because Chrome MV3 cannot enforce submit destinations at the browser network boundary. Fill without submit, or use page_fill_submit in the host sign-in browser.",
      );
    }

    const rawFields = Array.isArray(args.fields) ? args.fields : [];
    if (!rawFields.length) throw new Error("No fields provided for secure fill.");

    // Determine target frame: if refs map to a single frame, target it; otherwise top frame (0).
    // Cross-origin frames are always rejected inside dom-driver's secureFill origin check.
    let targetFrameId = 0;
    const mappedFields = [];
    for (const f of rawFields) {
      if (f?.ref) {
        const mapped = this.tabRefs.get(tab.id)?.get(f.ref);
        if (mapped) {
          if (targetFrameId !== 0 && targetFrameId !== mapped.frameId) {
            throw new Error("All fields in one secure fill must belong to the same frame.");
          }
          targetFrameId = mapped.frameId;
          mappedFields.push({ ...f, ref: mapped.localRef });
          continue;
        }
      }
      mappedFields.push({ ...f });
    }

    // Taint the tab before injecting secrets so subsequent browser_eval / browser_cdp calls
    // cannot read the filled secret back into model context.
    this.taintTab(tab.id, { origin: expectedOrigin, url: tabUrl });

    try {
      const { frames } = await this.execDriver(
        tab.id,
        "secureFill",
        {
          expectedOrigin,
          allowLocalHttp: Boolean(args.allowLocalHttp),
          fields: mappedFields,
          submit: false,
        },
        { frameIds: [targetFrameId] },
      );
      const res = frames[0]?.result;
      if (!res?.ok) {
        throw new Error(res?.error || "Secure credential fill failed.");
      }
      return {
        filled: true,
        tabId: tab.id,
        filledCount: Number(res.filledCount || 0),
        submitted: false,
        origin: res.origin || expectedOrigin,
      };
    } finally {
      // Drop references to plaintext values immediately after injection.
      for (const f of mappedFields) f.value = "";
      for (const f of rawFields) {
        if (f && typeof f === "object") f.value = "";
      }
    }
  }

  async run(toolName, args = {}) {
    const settings = await this.getSettings();
    if (settings.enabled === false) {
      throw new Error("Botkins Browser Control is paused in the extension popup.");
    }

    switch (toolName) {
      case "browser_tabs": {
        const groupId = await this.findBotkinsGroup();
        const all = await chrome.tabs.query({});
        const eligible = all.filter((tab) => isEligibleTab(tab, settings, groupId));
        return {
          mode: settings.mode,
          tabs: eligible.map((t) => ({
            id: t.id,
            windowId: t.windowId,
            title: t.title || "",
            url: t.url || t.pendingUrl || "",
            active: t.active === true,
            pinned: t.pinned === true,
            inGroup: groupId != null && t.groupId === groupId,
          })),
        };
      }

      case "browser_open": {
        const url = String(args.url || "").trim();
        if (!url || !isEligibleUrl(url)) throw new Error("Provide an http:// or https:// URL to open.");
        const created = await chrome.tabs.create({ url, active: args.active !== false });
        if (settings.mode === "group") {
          await this.ensureTabInGroup(created.id, created.windowId);
        }
        const settled = await this.waitForLoad(created.id, 8000);
        return {
          tabId: created.id,
          windowId: created.windowId,
          title: settled?.title || created.title || "",
          url: settled?.url || created.url || url,
        };
      }

      case "browser_navigate": {
        const tab = await this.resolveTab(args.tabId);
        this.tabRefs.delete(tab.id);
        this.untaintTab(tab.id);
        const action = args.action || (args.url ? "goto" : "reload");
        if (action === "goto") {
          const url = String(args.url || "").trim();
          if (!url || !isEligibleUrl(url)) throw new Error("Provide a valid http:// or https:// URL.");
          await chrome.tabs.update(tab.id, { url });
        } else if (action === "back") {
          await chrome.tabs.goBack(tab.id);
        } else if (action === "forward") {
          await chrome.tabs.goForward(tab.id);
        } else if (action === "reload") {
          await chrome.tabs.reload(tab.id);
        }
        const settled = await this.waitForLoad(tab.id, 10_000);
        return { tabId: tab.id, title: settled?.title || "", url: settled?.url || "" };
      }

      case "browser_close_tab": {
        const tab = await this.resolveTab(args.tabId);
        this.tabRefs.delete(tab.id);
        this.untaintTab(tab.id);
        await this.detach(tab.id);
        await chrome.tabs.remove(tab.id);
        return { closed: true, tabId: tab.id };
      }

      case "browser_snapshot": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runSnapshot(tab, args);
      }

      case "browser_screenshot": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runScreenshot(tab, args);
      }

      case "browser_click": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runClick(tab, args);
      }

      case "browser_type": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runType(tab, args);
      }

      case "browser_secure_fill": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runSecureFill(tab, args);
      }

      case "browser_select": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runSelect(tab, args);
      }

      case "browser_press": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runPress(tab, args);
      }

      case "browser_scroll": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runScroll(tab, args);
      }

      case "browser_wait": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runWait(tab, args);
      }

      case "browser_eval": {
        const tab = await this.resolveTab(args.tabId);
        return await this.runEval(tab, args);
      }

      case "browser_cdp": {
        const tab = await this.resolveTab(args.tabId);
        this.assertNotTainted(tab, "browser_cdp");
        const method = String(args.method || "").trim();
        if (!method) throw new Error("CDP `method` is required.");
        const result = await this.cdp(
          tab.id,
          method,
          args.params && typeof args.params === "object" ? args.params : {},
          `raw CDP command "${method}"`,
        );
        return { tabId: tab.id, result: result ?? null };
      }

      default:
        throw new Error(`Unsupported browser tool: ${toolName}`);
    }
  }
}
