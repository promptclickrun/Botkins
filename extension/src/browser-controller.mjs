// Eligible tab filtering, Botkins tab group management, and CDP/chrome.debugger automation.
//
// Follows the OpenClaw / Claude model:
// - Uses chrome.debugger (no blocking remote-debugging consent modal, works unattended).
// - Lazily attaches debugger on demand and detaches after idle so the yellow banner disappears
//   when bots are not actively browsing.
// - Respects `mode`:
//     "all":   every eligible ordinary tab (excluding chrome://, edge://, chrome-extension://,
//              devtools://, incognito, and user-paused tabs).
//     "group": only tabs in the orange "Botkins" tab group. Tabs opened by bots automatically land
//              in the group.

const BLOCKED_SCHEMES = ["chrome:", "edge:", "chrome-extension:", "devtools:", "view-source:", "chrome-untrusted:"];
const CDP_VERSION = "1.3";
const IDLE_DETACH_MS = 20_000;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside the target page via Runtime.evaluate to produce a compact accessibility/DOM snapshot
// with stable `data-botkins-ref` handles (`e1`, `e2`, ...) for reliable clicking and typing.
const SNAPSHOT_EXPR = (maxChars) => `(() => {
  const MAX = ${Math.min(Math.max(Number(maxChars) || 12000, 1000), 50000)};
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const cssPath = (el) => {
    if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.getAttribute('data-testid')) {
        parts.unshift(part + '[data-testid=' + JSON.stringify(cur.getAttribute('data-testid')) + ']');
        break;
      }
      if (cur.getAttribute('name') && ['input','textarea','select','button'].includes(part)) {
        part += '[name=' + JSON.stringify(cur.getAttribute('name')) + ']';
      } else {
        const parent = cur.parentElement;
        if (parent) {
          const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
          if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const selector = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [contenteditable="true"]';
  const nodes = [...document.querySelectorAll(selector)].filter(visible).slice(0, 180);
  const elements = [];
  let idx = 0;
  for (const el of nodes) {
    const ref = 'e' + (++idx);
    try { el.setAttribute('data-botkins-ref', ref); } catch {}
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const entry = {
      ref,
      tag,
      selector: cssPath(el),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
    if (el.type && tag === 'input') entry.type = el.type;
    if (el.getAttribute('role')) entry.role = el.getAttribute('role');
    if (text) entry.text = text;
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

const FIND_ELEMENT_EXPR = ({ selector, ref, text }) => `(() => {
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
  let main = parts.pop() || "Enter";
  for (const mod of parts) {
    const m = mod.toLowerCase();
    if (m === "alt" || m === "option") modifiers |= 1;
    else if (m === "control" || m === "ctrl") modifiers |= 2;
    else if (m === "meta" || m === "cmd" || m === "command") modifiers |= 4;
    else if (m === "shift") modifiers |= 8;
  }
  const known = KEY_CODES[main];
  if (known) return { ...known, modifiers };
  const ch = main.length === 1 ? main : main;
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

export class BrowserController {
  constructor({ getSettings, uploadScreenshot }) {
    this.getSettings = getSettings;
    this.uploadScreenshot = uploadScreenshot;
    this.attached = new Map(); // tabId -> { timer }
    if (typeof chrome !== "undefined" && chrome.debugger?.onDetach) {
      chrome.debugger.onDetach.addListener((source) => {
        if (typeof source?.tabId === "number") {
          const entry = this.attached.get(source.tabId);
          if (entry?.timer) clearTimeout(entry.timer);
          this.attached.delete(source.tabId);
        }
      });
    }
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
    for (const [tabId, entry] of [...this.attached.entries()]) {
      if (keepIds.has(tabId)) continue;
      if (entry?.timer) clearTimeout(entry.timer);
      this.attached.delete(tabId);
      try {
        await chrome.debugger.detach({ tabId });
      } catch {}
    }
  }

  async ensureAttached(tabId) {
    const existing = this.attached.get(tabId);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void this.detach(tabId), IDLE_DETACH_MS);
      return;
    }
    try {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
    } catch (err) {
      if (!/already attached/i.test(String(err?.message || err))) throw err;
    }
    const timer = setTimeout(() => void this.detach(tabId), IDLE_DETACH_MS);
    this.attached.set(tabId, { timer });
  }

  async detach(tabId) {
    const entry = this.attached.get(tabId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.attached.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {}
  }

  async cdp(tabId, method, params = {}) {
    await this.ensureAttached(tabId);
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  }

  async evaluate(tabId, expression, awaitPromise = true) {
    const res = await this.cdp(tabId, "Runtime.evaluate", {
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
        await this.detach(tab.id);
        await chrome.tabs.remove(tab.id);
        return { closed: true, tabId: tab.id };
      }

      case "browser_snapshot": {
        const tab = await this.resolveTab(args.tabId);
        const snap = await this.evaluate(tab.id, SNAPSHOT_EXPR(args.maxChars), false);
        return { tabId: tab.id, ...(snap || {}) };
      }

      case "browser_screenshot": {
        const tab = await this.resolveTab(args.tabId);
        const quality = Math.min(Math.max(Number(args.quality) || 70, 20), 90);
        const shot = await this.cdp(tab.id, "Page.captureScreenshot", {
          format: "jpeg",
          quality,
          ...(args.fullPage === true && { captureBeyondViewport: true }),
        });
        if (!shot?.data) throw new Error("Screenshot capture returned no image data.");
        const path = await this.uploadScreenshot(shot.data, `browser-tab-${tab.id}.jpg`, "image/jpeg");
        return {
          tabId: tab.id,
          url: tab.url || "",
          title: tab.title || "",
          format: "jpeg",
          path,
        };
      }

      case "browser_click": {
        const tab = await this.resolveTab(args.tabId);
        let x = Number(args.x);
        let y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          const found = await this.evaluate(tab.id, FIND_ELEMENT_EXPR(args), false);
          if (!found) throw new Error("Element not found for click.");
          x = found.x;
          y = found.y;
        }
        const clicks = args.doubleClick ? 2 : 1;
        await this.cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (let i = 1; i <= clicks; i++) {
          await this.cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: i });
          await this.cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: i });
        }
        await sleep(150);
        const after = await chrome.tabs.get(tab.id).catch(() => tab);
        return { clicked: true, tabId: tab.id, x: Math.round(x), y: Math.round(y), url: after.url || "", title: after.title || "" };
      }

      case "browser_type": {
        const tab = await this.resolveTab(args.tabId);
        const text = String(args.text ?? "");
        if (args.ref || args.selector) {
          const found = await this.evaluate(tab.id, FIND_ELEMENT_EXPR(args), false);
          if (!found) throw new Error("Input element not found.");
          await this.cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: found.x, y: found.y, button: "left", clickCount: 1 });
          await this.cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: found.x, y: found.y, button: "left", clickCount: 1 });
        }
        if (args.clear) {
          await this.evaluate(
            tab.id,
            `(() => {
              const el = document.activeElement;
              if (!el) return;
              if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
              else if (el.isContentEditable) { el.textContent = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
            })()`,
            false,
          );
        }
        if (text) {
          await this.cdp(tab.id, "Input.insertText", { text });
        }
        if (args.submit) {
          const enter = parseKeyCombo("Enter");
          await this.cdp(tab.id, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...enter });
          await this.cdp(tab.id, "Input.dispatchKeyEvent", { type: "char", text: "\r" });
          await this.cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...enter });
        }
        return { typed: true, tabId: tab.id, length: text.length };
      }

      case "browser_press": {
        const tab = await this.resolveTab(args.tabId);
        const spec = parseKeyCombo(args.key);
        await this.cdp(tab.id, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...spec });
        if (spec.text) {
          await this.cdp(tab.id, "Input.dispatchKeyEvent", { type: "char", text: spec.text, modifiers: spec.modifiers });
        }
        await this.cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...spec });
        return { pressed: String(args.key), tabId: tab.id };
      }

      case "browser_scroll": {
        const tab = await this.resolveTab(args.tabId);
        const dir = args.direction || "down";
        const amount = Math.min(Math.max(Number(args.amount) || 600, 50), 10000);
        const pos = await this.evaluate(
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
        );
        return { tabId: tab.id, ...(pos || {}) };
      }

      case "browser_wait": {
        const tab = await this.resolveTab(args.tabId);
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
            if ((current.url || "").includes(args.urlContains)) return { matched: "url", tabId: tab.id, url: current.url };
          }
          if (args.selector || args.text) {
            const ok = await this.evaluate(
              tab.id,
              `(() => {
                const sel = ${JSON.stringify(args.selector || "")};
                const txt = ${JSON.stringify(args.text || "")};
                if (sel && !document.querySelector(sel)) return false;
                if (txt && !(document.body?.innerText || '').includes(txt)) return false;
                return true;
              })()`,
              false,
            );
            if (ok) return { matched: args.selector ? "selector" : "text", tabId: tab.id };
          }
          await sleep(250);
        }
        throw new Error(`Timed out after ${timeoutMs}ms waiting for page condition.`);
      }

      case "browser_eval": {
        const tab = await this.resolveTab(args.tabId);
        const value = await this.evaluate(tab.id, String(args.expression || ""), args.awaitPromise !== false);
        return { tabId: tab.id, result: value ?? null };
      }

      case "browser_cdp": {
        const tab = await this.resolveTab(args.tabId);
        const method = String(args.method || "").trim();
        if (!method) throw new Error("CDP `method` is required.");
        const result = await this.cdp(tab.id, method, args.params && typeof args.params === "object" ? args.params : {});
        return { tabId: tab.id, result: result ?? null };
      }

      default:
        throw new Error(`Unsupported browser tool: ${toolName}`);
    }
  }
}
