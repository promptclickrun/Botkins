// Unit tests for the Botkins Chromium extension modules (manifest, tab eligibility,
// key combo parsing, storage defaults, and DOM-first controller actions against mocked chrome.* APIs).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BrowserController,
  formatCdpError,
  isDifferentExtensionCdpError,
  isEligibleTab,
  isEligibleUrl,
  parseKeyCombo,
} from "../src/browser-controller.mjs";
import { DEFAULT_SETTINGS, defaultDeviceName, detectBrowserName, detectPlatform, loadState, savePatch } from "../src/storage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("manifest.json is valid MV3 with scripting permission and all referenced icons/assets exist", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.2.0");
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(manifest.permissions.includes("tabs"));
  assert.ok(manifest.permissions.includes("tabGroups"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("alarms"));
  for (const iconPath of Object.values(manifest.icons)) {
    assert.ok(existsSync(join(root, iconPath)), `missing icon ${iconPath}`);
  }
  assert.ok(existsSync(join(root, manifest.action.default_popup)));
  assert.ok(existsSync(join(root, manifest.options_page)));
  assert.ok(existsSync(join(root, manifest.background.service_worker)), "run `npm run build` first");
  assert.ok(existsSync(join(root, "dist/dom-driver.js")), "run `npm run build` first");
});

test("isEligibleUrl and isEligibleTab enforce OpenClaw/Claude tab boundaries", () => {
  assert.equal(isEligibleUrl("https://github.com/promptclickrun/Botkins"), true);
  assert.equal(isEligibleUrl("http://localhost:3000"), true);
  assert.equal(isEligibleUrl("chrome://settings"), false);
  assert.equal(isEligibleUrl("edge://extensions"), false);
  assert.equal(isEligibleUrl("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html"), false);
  assert.equal(isEligibleUrl("devtools://devtools/bundled/inspector.html"), false);

  const tab = { id: 10, url: "https://example.com", incognito: false, groupId: 7 };
  assert.equal(isEligibleTab(tab, { mode: "all", pausedTabIds: [] }, null), true);
  assert.equal(isEligibleTab(tab, { mode: "all", pausedTabIds: [10] }, null), false);
  assert.equal(isEligibleTab({ ...tab, incognito: true }, { mode: "all", pausedTabIds: [] }, null), false);
  assert.equal(isEligibleTab(tab, { mode: "group", pausedTabIds: [] }, 7), true);
  assert.equal(isEligibleTab(tab, { mode: "group", pausedTabIds: [] }, 99), false);
});

test("parseKeyCombo handles Enter, arrows, and modifier shortcuts", () => {
  assert.equal(parseKeyCombo("Enter").windowsVirtualKeyCode, 13);
  assert.equal(parseKeyCombo("Control+a").modifiers, 2);
  assert.equal(parseKeyCombo("Control+a").code, "KeyA");
  assert.equal(parseKeyCombo("Meta+Shift+k").modifiers, 4 | 8);
  assert.equal(parseKeyCombo("Escape").code, "Escape");
});

test("isDifferentExtensionCdpError and formatCdpError explain password-manager debugger blocks", () => {
  const raw = new Error("Cannot access a chrome-extension:// URL of different extension");
  assert.equal(isDifferentExtensionCdpError(raw), true);
  assert.equal(isDifferentExtensionCdpError(new Error("Target closed")), false);
  const formatted = formatCdpError(raw, "full-page screenshot");
  assert.match(formatted.message, /full-page screenshot/i);
  assert.match(formatted.message, /another extension/i);
  assert.match(formatted.message, /Proton Pass/i);
  assert.match(formatted.message, /different extension/i);
  // Calling formatCdpError twice does not double-wrap the message
  assert.equal(formatCdpError(formatted, "other"), formatted);
});

test("browser/platform detection and storage helpers", async () => {
  assert.equal(detectBrowserName("Mozilla/5.0 AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0"), "Edge");
  assert.equal(detectBrowserName("Mozilla/5.0 AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36"), "Chrome");
  assert.equal(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "darwin");
  assert.equal(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "win32");
  assert.match(defaultDeviceName("Work"), /\(Work\)$/);

  const mem = {};
  const fakeStorage = {
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => k in mem).map((k) => [k, mem[k]]));
    },
    async set(patch) {
      Object.assign(mem, patch);
    },
  };
  const initial = await loadState(fakeStorage);
  assert.equal(initial.settings.mode, DEFAULT_SETTINGS.mode);
  await savePatch({ settings: { ...initial.settings, mode: "group", profileLabel: "Personal" } }, fakeStorage);
  const reloaded = await loadState(fakeStorage);
  assert.equal(reloaded.settings.mode, "group");
  assert.equal(reloaded.settings.profileLabel, "Personal");
});

function createMockEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => {
      for (const fn of [...listeners]) fn(...args);
    },
    size: () => listeners.size,
  };
}

function createMockChrome({
  tabs,
  windows,
  onDriverCall,
  onMainWorldEval,
  onCdpCommand,
  onCaptureVisibleTab,
  failCdpAttach = null,
} = {}) {
  const attached = new Set();
  const cdpCalls = [];
  const scriptingCalls = [];
  const captureCalls = [];
  const installedFrames = new Set();

  const onActivated = createMockEvent();
  const onUpdated = createMockEvent();
  const onDetached = createMockEvent();
  const onRemoved = createMockEvent();
  const onFocusChanged = createMockEvent();
  const events = { onActivated, onUpdated, onDetached, onRemoved, onFocusChanged };
  const windowMap = new Map(
    (windows || [{ id: 1, focused: true }]).map((w) => [w.id, { ...w }]),
  );

  const chromeMock = {
    tabs: {
      onActivated,
      onUpdated,
      onDetached,
      onRemoved,
      query: async (q = {}) =>
        tabs.filter((t) => {
          if (q.active !== undefined && Boolean(t.active) !== Boolean(q.active)) return false;
          if (q.windowId !== undefined && t.windowId !== q.windowId) return false;
          return true;
        }),
      get: async (id) => {
        const found = tabs.find((t) => t.id === id);
        if (!found) throw new Error("No tab");
        return found;
      },
      create: async ({ url, active }) => {
        const nextId = Math.max(0, ...tabs.map((t) => t.id)) + 1;
        const next = {
          id: nextId,
          windowId: 1,
          title: "New",
          url,
          active: active !== false,
          pinned: false,
          groupId: -1,
          incognito: false,
          status: "complete",
        };
        if (next.active) {
          for (const t of tabs) if (t.windowId === next.windowId) t.active = false;
        }
        tabs.push(next);
        if (next.active) onActivated.emit({ tabId: next.id, windowId: next.windowId });
        return next;
      },
      update: async (id, patch) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error("No tab");
        const wasActive = Boolean(t.active);
        if (patch.active) {
          for (const other of tabs) if (other.windowId === t.windowId) other.active = false;
        }
        Object.assign(t, patch);
        if (patch.active && !wasActive) {
          onActivated.emit({ tabId: t.id, windowId: t.windowId });
        }
        return t;
      },
      remove: async (id) => {
        const idx = tabs.findIndex((x) => x.id === id);
        if (idx >= 0) {
          tabs.splice(idx, 1);
          onRemoved.emit(id);
        }
      },
      group: async ({ groupId, tabIds }) => {
        const gid = groupId ?? 55;
        for (const id of tabIds) {
          const t = tabs.find((x) => x.id === id);
          if (t) t.groupId = gid;
        }
        return gid;
      },
      captureVisibleTab: async (windowId, opts) => {
        captureCalls.push({ windowId, opts });
        if (onCaptureVisibleTab) return await onCaptureVisibleTab(windowId, opts, events);
        return "data:image/jpeg;base64,Vk1JR0U=";
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged,
      get: async (id) => windowMap.get(id) || { id, focused: true },
      update: async () => ({}),
    },
    tabGroups: {
      query: async () => (tabs.some((t) => t.groupId === 55) ? [{ id: 55, title: "Botkins" }] : []),
      update: async () => ({}),
    },
    scripting: {
      executeScript: async (injection) => {
        scriptingCalls.push(injection);
        const tabId = injection.target.tabId;
        const frameIds = injection.target.frameIds || (injection.target.allFrames ? [0, 2] : [0]);

        if (injection.files) {
          for (const fid of frameIds) installedFrames.add(`${tabId}:${fid}`);
          return frameIds.map((frameId) => ({ frameId, result: undefined }));
        }

        if (injection.world === "MAIN") {
          const [expression, awaitPromise] = injection.args || [];
          const result = onMainWorldEval
            ? await onMainWorldEval(tabId, expression, awaitPromise)
            : { ok: true, value: 42 };
          return [{ frameId: 0, result }];
        }

        const [action, payload, version] = injection.args || [];
        return Promise.all(
          frameIds.map(async (frameId) => {
            if (!installedFrames.has(`${tabId}:${frameId}`)) {
              return { frameId, result: { __needInstall: true, version } };
            }
            const res = onDriverCall
              ? await onDriverCall(tabId, frameId, action, payload)
              : { ok: true };
            return { frameId, result: res };
          }),
        );
      },
    },
    debugger: {
      onDetach: { addListener: () => {} },
      attach: async ({ tabId }) => {
        if (failCdpAttach) throw new Error(failCdpAttach);
        attached.add(tabId);
      },
      detach: async ({ tabId }) => {
        attached.delete(tabId);
      },
      sendCommand: async ({ tabId }, method, params) => {
        cdpCalls.push({ tabId, method, params });
        if (onCdpCommand) return onCdpCommand(tabId, method, params);
        if (method === "Page.captureScreenshot") return { data: "RlVMTFBBR0U=" };
        if (method === "Runtime.evaluate") return { result: { value: "cdp-eval-result" } };
        return {};
      },
    },
  };

  return { chromeMock, attached, cdpCalls, scriptingCalls, captureCalls, events };
}

test("BrowserController runs DOM-first without attaching debugger and keeps multi-frame refs", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Login", url: "https://example.com/login", active: true, pinned: false, groupId: -1, incognito: false, status: "complete" },
    { id: 2, windowId: 1, title: "Settings", url: "chrome://settings", active: false, pinned: false, groupId: -1, incognito: false, status: "complete" },
    { id: 4, windowId: 1, title: "Background", url: "https://example.com/bg", active: false, pinned: false, groupId: -1, incognito: false, status: "complete" },
  ];

  const driverCalls = [];
  const { chromeMock, attached, cdpCalls, captureCalls } = createMockChrome({
    tabs,
    onDriverCall: (_tabId, frameId, action, payload) => {
      driverCalls.push({ frameId, action, payload });
      if (action === "snapshot") {
        if (frameId === 0) {
          return {
            ok: true,
            title: "Login",
            url: "https://example.com/login",
            text: "Sign in",
            elements: [
              { ref: "e1", tag: "input", type: "email", role: "textbox", name: "Email", value: "", box: { x: 10, y: 10, width: 200, height: 32 }, x: 110, y: 26 },
            ],
          };
        }
        return {
          ok: true,
          title: "Subframe",
          url: "https://example.com/frame",
          text: "Frame button",
          elements: [
            { ref: "e1", tag: "button", role: "button", name: "Continue", text: "Continue", box: { x: 20, y: 20, width: 100, height: 30 }, x: 70, y: 35 },
          ],
        };
      }
      if (action === "click") return { ok: true, found: true, clicked: true, tag: "button", x: 70, y: 35 };
      if (action === "type") return { ok: true, found: true, typed: true, length: String(payload.text || "").length };
      if (action === "press") return { ok: true, pressed: payload.rawKey };
      if (action === "scroll") return { ok: true, found: true, scrollX: 0, scrollY: 600, scrollHeight: 2000 };
      if (action === "checkWait") return { ok: true, matched: true };
      return { ok: true };
    },
  });
  globalThis.chrome = chromeMock;

  let settings = { enabled: true, mode: "all", groupName: "Botkins", groupColor: "orange", pausedTabIds: [] };
  const ctrl = new BrowserController({
    getSettings: async () => settings,
    uploadScreenshot: async (b64, name) => `up_${name}_${b64.length}`,
  });

  // browser_tabs excludes chrome://settings
  const list = await ctrl.run("browser_tabs");
  assert.deepEqual(list.tabs.map((t) => t.id), [1, 4]);

  // browser_snapshot merges frames and assigns unique global refs e1 (frame 0) and e2 (frame 2)
  const snap = await ctrl.run("browser_snapshot", { tabId: 1 });
  assert.equal(snap.elements.length, 2);
  assert.equal(snap.elements[0].ref, "e1");
  assert.equal(snap.elements[0].frameId, undefined);
  assert.equal(snap.elements[1].ref, "e2");
  assert.equal(snap.elements[1].frameId, 2);
  assert.equal(cdpCalls.length, 0);
  assert.equal(attached.size, 0);

  // Clicking global ref e2 routes to frameId 2 with its local ref e1
  const clicked = await ctrl.run("browser_click", { tabId: 1, ref: "e2" });
  assert.equal(clicked.clicked, true);
  assert.equal(driverCalls.at(-1).frameId, 2);
  assert.equal(driverCalls.at(-1).payload.ref, "e1");

  // Typing into e1 routes to frame 0 without CDP
  const typed = await ctrl.run("browser_type", { tabId: 1, ref: "e1", text: "alice@example.com", clear: true });
  assert.equal(typed.typed, true);
  assert.equal(driverCalls.at(-1).frameId, 0);

  // Press, scroll, wait, and MAIN-world eval all skip CDP
  const pressed = await ctrl.run("browser_press", { tabId: 1, key: "Enter" });
  assert.equal(pressed.pressed, "Enter");
  const scrolled = await ctrl.run("browser_scroll", { tabId: 1, direction: "down" });
  assert.equal(scrolled.scrollY, 600);
  const waited = await ctrl.run("browser_wait", { tabId: 1, selector: "#done", timeoutMs: 500 });
  assert.equal(waited.matched, "selector");
  const evalRes = await ctrl.run("browser_eval", { tabId: 1, expression: "21 * 2" });
  assert.equal(evalRes.result, 42);
  assert.equal(cdpCalls.length, 0);

  // Viewport screenshot uses captureVisibleTab (no CDP), and restores active tab when capturing a background tab
  const bgShot = await ctrl.run("browser_screenshot", { tabId: 4 });
  assert.equal(bgShot.path, "up_browser-tab-4.jpg_8");
  assert.equal(captureCalls.length, 1);
  assert.equal(cdpCalls.length, 0);
  assert.equal(tabs.find((t) => t.id === 1).active, true);
  assert.equal(tabs.find((t) => t.id === 4).active, false);

  // Group mode: opening a tab automatically puts it in the Botkins group
  settings = { ...settings, mode: "group" };
  const opened = await ctrl.run("browser_open", { url: "https://example.org" });
  assert.equal(opened.tabId, 5);
  const groupList = await ctrl.run("browser_tabs");
  assert.deepEqual(groupList.tabs.map((t) => t.id), [5]);

  // Paused controller refuses tool calls cleanly
  settings = { ...settings, enabled: false };
  await assert.rejects(() => ctrl.run("browser_tabs"), /paused/i);
});

test("BrowserController uses ephemeral CDP only on fallbacks/fullPage/raw cdp and never leaves debugger attached", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "CSP Page", url: "https://strict.example.com", active: true, pinned: false, groupId: -1, incognito: false, status: "complete" },
  ];

  const { chromeMock, attached, cdpCalls } = createMockChrome({
    tabs,
    onDriverCall: (_tabId, _frameId, action) => {
      if (action === "press") return { ok: false, needsCdp: true, error: "Needs trusted key event" };
      return { ok: true };
    },
    onMainWorldEval: () => ({ ok: false, cspBlocked: true, error: "EvalError: unsafe-eval blocked" }),
  });
  globalThis.chrome = chromeMock;

  const ctrl = new BrowserController({
    getSettings: async () => ({ enabled: true, mode: "all", groupName: "Botkins", groupColor: "orange", pausedTabIds: [] }),
    uploadScreenshot: async (b64, name) => `up_${name}_${b64.length}`,
  });

  // CSP-blocked eval falls back to ephemeral CDP and detaches immediately
  const evalRes = await ctrl.run("browser_eval", { tabId: 1, expression: "window.location.href" });
  assert.equal(evalRes.result, "cdp-eval-result");
  assert.equal(attached.size, 0);
  assert.ok(cdpCalls.some((c) => c.method === "Runtime.evaluate"));

  // fullPage screenshot uses ephemeral CDP and detaches immediately
  const fullShot = await ctrl.run("browser_screenshot", { tabId: 1, fullPage: true });
  assert.equal(fullShot.path, "up_browser-tab-1.jpg_12");
  assert.equal(attached.size, 0);
  assert.ok(cdpCalls.some((c) => c.method === "Page.captureScreenshot"));

  // press fallback uses CDP Input.dispatchKeyEvent and detaches immediately
  const pressRes = await ctrl.run("browser_press", { tabId: 1, key: "Escape" });
  assert.equal(pressRes.pressed, "Escape");
  assert.equal(attached.size, 0);
  assert.ok(cdpCalls.some((c) => c.method === "Input.dispatchKeyEvent"));

  // Raw browser_cdp attaches and detaches immediately
  await ctrl.run("browser_cdp", { tabId: 1, method: "DOM.getDocument", params: { depth: 1 } });
  assert.equal(attached.size, 0);
  assert.ok(cdpCalls.some((c) => c.method === "DOM.getDocument"));
});

test("BrowserController surfaces a clear error when CDP fallback hits another extension's frame", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Scotch Login", url: "https://scissorsscotch.com/scotch-login", active: true, pinned: false, groupId: -1, incognito: false, status: "complete" },
  ];

  const { chromeMock, attached } = createMockChrome({
    tabs,
    failCdpAttach: "Cannot access a chrome-extension:// URL of different extension",
  });
  globalThis.chrome = chromeMock;

  const ctrl = new BrowserController({
    getSettings: async () => ({ enabled: true, mode: "all", groupName: "Botkins", groupColor: "orange", pausedTabIds: [] }),
    uploadScreenshot: async (b64, name) => `up_${name}_${b64.length}`,
  });

  await assert.rejects(
    () => ctrl.run("browser_screenshot", { tabId: 1, fullPage: true }),
    /another extension.*Proton Pass/i,
  );
  await assert.rejects(
    () => ctrl.run("browser_cdp", { tabId: 1, method: "DOM.getDocument" }),
    /different extension/i,
  );
  assert.equal(attached.size, 0);
});

test("BrowserController discards viewport screenshot when active tab or URL/origin changes mid-capture", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Target", url: "https://example.com/app", active: true, pinned: false, groupId: -1, incognito: false, status: "complete" },
    { id: 2, windowId: 1, title: "Bank Account", url: "https://bank.private.example/secrets", active: false, pinned: false, groupId: -1, incognito: false, status: "complete" },
  ];

  let uploaded = [];
  let captureBehavior = "switch-tab";
  const { chromeMock, cdpCalls } = createMockChrome({
    tabs,
    onCaptureVisibleTab: async () => {
      if (captureBehavior === "switch-tab") {
        // Simulate the user switching to a private tab while captureVisibleTab runs.
        tabs[0].active = false;
        tabs[1].active = true;
        return "data:image/jpeg;base64,U0VDUkVUX0JBTktfSU1BR0U=";
      }
      if (captureBehavior === "change-origin") {
        // Simulate the target tab navigating to another origin mid-capture.
        tabs[0].url = "https://other-origin.example/private";
        return "data:image/jpeg;base64,T1RIRVJfT1JJR0lOX0lNQUdF";
      }
      if (captureBehavior === "change-window") {
        tabs[0].windowId = 2;
        return "data:image/jpeg;base64,TU9WRURfV0lORE9X";
      }
      return "data:image/jpeg;base64,Vk1JR0U=";
    },
  });
  globalThis.chrome = chromeMock;

  const ctrl = new BrowserController({
    getSettings: async () => ({ enabled: true, mode: "all", groupName: "Botkins", groupColor: "orange", pausedTabIds: [] }),
    uploadScreenshot: async (b64, name) => {
      uploaded.push({ b64, name });
      return `up_${name}`;
    },
  });

  // Case 1: Active tab switches mid-capture -> discard image, do not upload, do not leak private URL/title, no CDP fallback.
  await assert.rejects(
    () => ctrl.run("browser_screenshot", { tabId: 1 }),
    (err) => {
      assert.match(err.message, /discarded/i);
      assert.match(err.message, /active tab/i);
      assert.doesNotMatch(err.message, /bank\.private\.example|Bank Account/i);
      return true;
    },
  );
  assert.equal(uploaded.length, 0, "wrong-tab image must never be uploaded");
  assert.equal(cdpCalls.length, 0, "tab-switch abort must not fall back to CDP");

  // Case 2: Target tab URL/origin changes mid-capture -> discard image, do not upload.
  tabs[0].active = true;
  tabs[1].active = false;
  captureBehavior = "change-origin";
  await assert.rejects(
    () => ctrl.run("browser_screenshot", { tabId: 1 }),
    (err) => {
      assert.match(err.message, /discarded/i);
      assert.match(err.message, /URL or origin changed/i);
      assert.doesNotMatch(err.message, /other-origin\.example/i);
      return true;
    },
  );
  assert.equal(uploaded.length, 0, "navigated-tab image must never be uploaded");
  assert.equal(cdpCalls.length, 0);

  // Case 3: Target tab moves to a different window mid-capture -> discard image, do not upload.
  tabs[0].url = "https://example.com/app";
  tabs[0].windowId = 1;
  captureBehavior = "change-window";
  await assert.rejects(
    () => ctrl.run("browser_screenshot", { tabId: 1 }),
    /discarded/i,
  );
  assert.equal(uploaded.length, 0);
  assert.equal(cdpCalls.length, 0);
});

test("BrowserController discards screenshot when user switches to tab B and back to A during capture", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Tab A", url: "https://example.com/a", active: true, pinned: false, groupId: -1, incognito: false, status: "complete" },
    { id: 2, windowId: 1, title: "Tab B Private", url: "https://private.example/b", active: false, pinned: false, groupId: -1, incognito: false, status: "complete" },
  ];

  const uploaded = [];
  let mode = "always-bounce";
  let attemptCount = 0;

  const { chromeMock, cdpCalls, captureCalls, events } = createMockChrome({
    tabs,
    onCaptureVisibleTab: async (_windowId, _opts, ev) => {
      attemptCount += 1;
      if (mode === "always-bounce" || (mode === "bounce-once" && attemptCount === 1)) {
        // User switches from Tab A -> Tab B -> back to Tab A while captureVisibleTab is in flight.
        // Both pre-check and post-check see Tab A active, yet the captured image could be Tab B.
        tabs[0].active = false;
        tabs[1].active = true;
        ev.onActivated.emit({ tabId: 2, windowId: 1 });
        tabs[1].active = false;
        tabs[0].active = true;
        ev.onActivated.emit({ tabId: 1, windowId: 1 });
        return "data:image/jpeg;base64,U0VDUkVUX1RBQl9CX0lNQUdF";
      }
      return "data:image/jpeg;base64,Q0xFQU5fVEFCX0FfSU1BR0U=";
    },
  });
  globalThis.chrome = chromeMock;

  const ctrl = new BrowserController({
    getSettings: async () => ({ enabled: true, mode: "all", groupName: "Botkins", groupColor: "orange", pausedTabIds: [] }),
    uploadScreenshot: async (b64, name) => {
      uploaded.push({ b64, name });
      return `up_${name}`;
    },
  });

  // Case 1: Switching B -> A happens during both initial capture and single retry -> no image returned/uploaded.
  await assert.rejects(
    () => ctrl.run("browser_screenshot", { tabId: 1 }),
    (err) => {
      assert.match(err.message, /discarded/i);
      assert.match(err.message, /active tab/i);
      assert.doesNotMatch(err.message, /Tab B Private|private\.example/i);
      return true;
    },
  );
  assert.equal(captureCalls.length, 2, "should discard and retry once before erroring");
  assert.equal(uploaded.length, 0, "tainted B->A image must never be uploaded or returned");
  assert.equal(cdpCalls.length, 0, "tab-switch abort must not fall back to CDP");
  assert.equal(events.onActivated.size(), 0, "onActivated listener must be cleaned up");
  assert.equal(events.onFocusChanged.size(), 0, "onFocusChanged listener must be cleaned up");
  assert.equal(events.onUpdated.size(), 0, "onUpdated listener must be cleaned up");

  // Case 2: Switching B -> A happens on first attempt only -> first image discarded, retry returns clean Tab A image.
  mode = "bounce-once";
  attemptCount = 0;
  captureCalls.length = 0;
  const cleanShot = await ctrl.run("browser_screenshot", { tabId: 1 });
  assert.equal(captureCalls.length, 2);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].b64, "Q0xFQU5fVEFCX0FfSU1BR0U=", "only the clean retry image may be uploaded");
  assert.equal(cleanShot.path, "up_browser-tab-1.jpg");
  assert.equal(events.onActivated.size(), 0);
  assert.equal(events.onFocusChanged.size(), 0);
  assert.equal(events.onUpdated.size(), 0);
});

test("BrowserController discards screenshot on window focus change or tabs.onUpdated navigation during capture", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Target", url: "https://example.com/app", active: true, pinned: false, groupId: -1, incognito: false, status: "complete" },
    { id: 3, windowId: 2, title: "Other Window Tab", url: "https://other.example/", active: true, pinned: false, groupId: -1, incognito: false, status: "complete" },
  ];

  const uploaded = [];
  let scenario = "focus-bounce";

  const { chromeMock, cdpCalls, captureCalls, events } = createMockChrome({
    tabs,
    windows: [
      { id: 1, focused: true },
      { id: 2, focused: false },
    ],
    onCaptureVisibleTab: async (_windowId, _opts, ev) => {
      if (scenario === "focus-bounce") {
        ev.onFocusChanged.emit(2);
        ev.onFocusChanged.emit(1);
        return "data:image/jpeg;base64,V1JPTkdfV0lORE9X";
      }
      if (scenario === "url-bounce") {
        // URL changes and reverts during capture: post-check sees expectedUrl, but onUpdated catches it.
        ev.onUpdated.emit(1, { url: "https://private.example/redirect" }, { ...tabs[0], url: "https://private.example/redirect" });
        ev.onUpdated.emit(1, { url: "https://example.com/app" }, { ...tabs[0] });
        return "data:image/jpeg;base64,UkVESVJFQ1RfRlJBTUU=";
      }
      if (scenario === "nav-loading") {
        ev.onUpdated.emit(1, { status: "loading" }, { ...tabs[0], status: "loading" });
        return "data:image/jpeg;base64,TE9BRElOR19GUkFNRQ==";
      }
      if (scenario === "benign-and-other-window") {
        // Benign title/favicon update on target tab and activation in a different window must NOT abort capture.
        ev.onUpdated.emit(1, { title: "Target (1)" }, { ...tabs[0], title: "Target (1)" });
        ev.onActivated.emit({ tabId: 3, windowId: 2 });
        return "data:image/jpeg;base64,Q0xFQU5fSU1BR0U=";
      }
      return "data:image/jpeg;base64,Q0xFQU5fSU1BR0U=";
    },
  });
  globalThis.chrome = chromeMock;

  const ctrl = new BrowserController({
    getSettings: async () => ({ enabled: true, mode: "all", groupName: "Botkins", groupColor: "orange", pausedTabIds: [] }),
    uploadScreenshot: async (b64, name) => {
      uploaded.push({ b64, name });
      return `up_${name}`;
    },
  });

  // 1. Repeated window focus changes discard and error after single retry.
  await assert.rejects(
    () => ctrl.run("browser_screenshot", { tabId: 1 }),
    (err) => {
      assert.match(err.message, /discarded/i);
      assert.match(err.message, /focus changed/i);
      return true;
    },
  );
  assert.equal(captureCalls.length, 2);
  assert.equal(uploaded.length, 0);
  assert.equal(cdpCalls.length, 0);

  // 2. tabs.onUpdated URL change discards immediately without retry or upload.
  scenario = "url-bounce";
  captureCalls.length = 0;
  await assert.rejects(
    () => ctrl.run("browser_screenshot", { tabId: 1 }),
    (err) => {
      assert.match(err.message, /discarded/i);
      assert.match(err.message, /URL changed/i);
      assert.doesNotMatch(err.message, /private\.example/i);
      return true;
    },
  );
  assert.equal(captureCalls.length, 1);
  assert.equal(uploaded.length, 0);
  assert.equal(cdpCalls.length, 0);

  // 3. tabs.onUpdated navigation start (status: "loading") discards immediately.
  scenario = "nav-loading";
  captureCalls.length = 0;
  await assert.rejects(
    () => ctrl.run("browser_screenshot", { tabId: 1 }),
    (err) => {
      assert.match(err.message, /discarded/i);
      assert.match(err.message, /navigating/i);
      return true;
    },
  );
  assert.equal(captureCalls.length, 1);
  assert.equal(uploaded.length, 0);
  assert.equal(cdpCalls.length, 0);

  // 4. Benign title update on target tab and tab activation in another window succeed normally.
  scenario = "benign-and-other-window";
  captureCalls.length = 0;
  const okShot = await ctrl.run("browser_screenshot", { tabId: 1 });
  assert.equal(captureCalls.length, 1);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].b64, "Q0xFQU5fSU1BR0U=");
  assert.equal(okShot.path, "up_browser-tab-1.jpg");
  assert.equal(events.onActivated.size(), 0);
  assert.equal(events.onFocusChanged.size(), 0);
  assert.equal(events.onUpdated.size(), 0);
});


