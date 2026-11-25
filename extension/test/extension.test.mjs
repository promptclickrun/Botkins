// Unit tests for the Botkins Chromium extension modules (manifest, tab eligibility,
// key combo parsing, storage defaults, and controller actions against mocked chrome.* APIs).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BrowserController, isEligibleTab, isEligibleUrl, parseKeyCombo } from "../src/browser-controller.mjs";
import { DEFAULT_SETTINGS, defaultDeviceName, detectBrowserName, detectPlatform, loadState, savePatch } from "../src/storage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("manifest.json is valid MV3 and all referenced icons/assets exist", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
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

test("BrowserController runs tabs, open, click, type, screenshot, and respects group/paused modes", async () => {
  const tabs = [
    { id: 1, windowId: 1, title: "Docs", url: "https://botkins.app", active: true, pinned: false, groupId: -1, incognito: false, status: "complete" },
    { id: 2, windowId: 1, title: "Settings", url: "chrome://settings", active: false, pinned: false, groupId: -1, incognito: false, status: "complete" },
  ];
  const cdpCalls = [];
  const attached = new Set();
  globalThis.chrome = {
    tabs: {
      query: async (q = {}) => tabs.filter((t) => (q.active ? t.active : true)),
      get: async (id) => {
        const found = tabs.find((t) => t.id === id);
        if (!found) throw new Error("No tab");
        return found;
      },
      create: async ({ url, active }) => {
        const next = { id: 3, windowId: 1, title: "New", url, active: active !== false, pinned: false, groupId: -1, incognito: false, status: "complete" };
        tabs.push(next);
        return next;
      },
      update: async (id, patch) => {
        const t = tabs.find((x) => x.id === id);
        Object.assign(t, patch);
        return t;
      },
      remove: async (id) => {
        const idx = tabs.findIndex((x) => x.id === id);
        if (idx >= 0) tabs.splice(idx, 1);
      },
      group: async ({ groupId, tabIds }) => {
        const gid = groupId ?? 55;
        for (const id of tabIds) {
          const t = tabs.find((x) => x.id === id);
          if (t) t.groupId = gid;
        }
        return gid;
      },
    },
    tabGroups: {
      query: async () => (tabs.some((t) => t.groupId === 55) ? [{ id: 55, title: "Botkins" }] : []),
      update: async () => ({}),
    },
    debugger: {
      onDetach: { addListener: () => {} },
      attach: async ({ tabId }) => {
        attached.add(tabId);
      },
      detach: async ({ tabId }) => {
        attached.delete(tabId);
      },
      sendCommand: async ({ tabId }, method, params) => {
        cdpCalls.push({ tabId, method, params });
        if (method === "Page.captureScreenshot") return { data: "AAAA" };
        if (method === "Runtime.evaluate") return { result: { value: { tag: "button", x: 100, y: 200 } } };
        return {};
      },
    },
  };

  let settings = { enabled: true, mode: "all", groupName: "Botkins", groupColor: "orange", pausedTabIds: [] };
  const ctrl = new BrowserController({
    getSettings: async () => settings,
    uploadScreenshot: async (b64, name) => `up_${name}_${b64.length}`,
  });

  // browser_tabs excludes chrome://settings
  const list = await ctrl.run("browser_tabs");
  assert.equal(list.tabs.length, 1);
  assert.equal(list.tabs[0].id, 1);

  // browser_click uses chrome.debugger mouse events
  const clicked = await ctrl.run("browser_click", { tabId: 1, selector: "button" });
  assert.equal(clicked.clicked, true);
  assert.ok(cdpCalls.some((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed"));

  // browser_screenshot captures and uploads
  const shot = await ctrl.run("browser_screenshot", { tabId: 1 });
  assert.equal(shot.path, "up_browser-tab-1.jpg_4");

  // Group mode: opening a tab automatically puts it in the Botkins group
  settings = { ...settings, mode: "group" };
  const opened = await ctrl.run("browser_open", { url: "https://example.org" });
  assert.equal(opened.tabId, 3);
  const groupList = await ctrl.run("browser_tabs");
  assert.deepEqual(groupList.tabs.map((t) => t.id), [3]);

  // Paused controller refuses tool calls cleanly
  settings = { ...settings, enabled: false };
  await assert.rejects(() => ctrl.run("browser_tabs"), /paused/i);

  await ctrl.detachAllExcept();
  assert.equal(attached.size, 0);
});
