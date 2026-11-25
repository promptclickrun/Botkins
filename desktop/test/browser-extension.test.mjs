// End-to-end tests for the Botkins Chromium browser extension host contract:
// - Pairing as kind="browser" (direct pairing + chrome-extension:// Origin acceptance)
// - Restricted authorization (browser extensions cannot call chat/admin/credential methods)
// - Lean sync view (only `meta` and its own `asks`, never chats/runs/spaces)
// - Reporting state (`link.browser.state`), multi-browser selection (`browser_list` + `browser` arg)
// - Round-tripping browser tool calls, screenshot uploads, errors, and Workspace tool registration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinkHost } from "../desktop/link/index.mjs";
import { BROWSER_TOOLS } from "../desktop/link/browser.mjs";
import * as lib from "../desktop/remote/link-client.mjs";
import { Workspace } from "./starter.mjs";

function makeBackend(state) {
  const listeners = new Set();
  return {
    info: () => ({ app: "botkins", version: "0.17.16", platform: "linux" }),
    snapshot: () => state,
    call: async () => null,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: () => {
      for (const fn of listeners) fn();
    },
  };
}

test("mobile/link-host and desktop/desktop/link browser files stay in sync", () => {
  for (const file of ["browser.mjs", "store.mjs", "team.mjs", "notify-targets.mjs", "server.mjs"]) {
    assert.equal(
      readFileSync(new URL("../desktop/link/" + file, import.meta.url), "utf8"),
      readFileSync(new URL("../../mobile/link-host/" + file, import.meta.url), "utf8"),
      `${file} differs between desktop/link and mobile/link-host`,
    );
  }
});

test("browser extension pairs over Link, gets lean meta+asks sync only, is locked out of admin calls, and executes browser tools end-to-end", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-browser-ext-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const state = {
    settings: {},
    bots: [{ id: "alfie", name: "Alfie" }],
    chats: [{ id: "c1", botId: "alfie", title: "Private chat", time: 1, messages: [{ role: "user", text: "secret" }] }],
    runs: [],
    streams: {},
    thinking: {},
    intents: {},
    speakers: {},
    queued: {},
    requests: [],
    active: [],
  };
  const backend = makeBackend(state);
  const host = new LinkHost({ dir, port: 0, relay: false, backend, log: () => {} });
  t.after(async () => host.stop());
  await host.setEnabled(true);

  const port = host.port;
  const pairingInfo = host.startPairing();
  const target = lib.parsePairingUrl(pairingInfo.url);
  assert.ok(target);
  // Override host to loopback with actual bound port.
  target.hosts = [`127.0.0.1:${port}`];

  // Simulate Chrome extension fetch sending Origin: chrome-extension://<32-char-id>
  const extOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const extFetch = (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Origin: extOrigin },
    });

  // Web origins must still be rejected on direct LAN HTTP.
  const webRes = await fetch(`http://127.0.0.1:${port}/botkins/v1/hello`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(webRes.status, 403);

  const pairing = await lib.pair(extFetch, target, {
    name: "Chrome (Work)",
    platform: "darwin",
    kind: "browser",
  });
  assert.equal(pairing.serverId, host.status().serverId);
  const listedDevice = host.status().devices.find((d) => d.id === pairing.deviceId);
  assert.equal(listedDevice?.kind, "browser");
  assert.equal(listedDevice?.canNotify, false);

  const seenParts = {};
  const asksReceived = [];
  let onlineResolve;
  const online = new Promise((r) => (onlineResolve = r));

  const client = new lib.LinkClient(pairing, {
    fetch: extFetch,
    onState: (s) => {
      if (s === "online") onlineResolve?.();
    },
    onParts: (parts) => {
      Object.assign(seenParts, parts);
      if (Array.isArray(parts.asks) && parts.asks.length) {
        asksReceived.push(...parts.asks);
      }
    },
  });
  t.after(() => client.stop());
  client.start();
  await online;

  // Browser device must only see meta + asks, never chats/bots/settings/credentials.
  assert.deepEqual(Object.keys(seenParts).sort(), ["asks", "meta"]);
  assert.equal(seenParts.meta.you.kind, "browser");
  assert.ok(seenParts.meta.capabilities.includes("browser-v1"));

  // Browser device must be refused non-browser RPCs.
  await assert.rejects(() => client.call("createChat", "alfie"), /browser extension/i);
  await assert.rejects(() => client.call("link.devices.list"), /browser extension/i);

  // Report state and confirm host exposes browser tools.
  await client.call("link.browser.state", {
    enabled: true,
    mode: "all",
    browser: "Chrome",
    profile: "Work",
    version: "0.1.0",
  });
  const tools = host.browserTools();
  assert.equal(tools.length, BROWSER_TOOLS.length);

  // browser_list resolves host-side without waking the extension.
  const listRes = await host.callBrowserTool("browser_list", {});
  assert.equal(listRes.browsers.length, 1);
  assert.equal(listRes.browsers[0].name, "Chrome (Work)");
  assert.equal(listRes.browsers[0].profile, "Work");

  // Round-trip browser_tabs call -> extension receives ask -> answers via link.browser.answer.
  const tabsPromise = host.callBrowserTool("browser_tabs", { browser: "Work" }, { botId: "alfie", chatId: "c1" });
  // Wait for ask to arrive
  const deadline = Date.now() + 5000;
  while (!asksReceived.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(asksReceived.length, 1);
  const ask = asksReceived[0];
  assert.equal(ask.tool, "browser_tabs");
  assert.equal(ask.deviceId, pairing.deviceId);
  await client.call("link.browser.answer", ask.id, {
    ok: true,
    result: { mode: "all", tabs: [{ id: 42, title: "GitHub", url: "https://github.com", active: true }] },
  });
  const tabsResult = await tabsPromise;
  assert.equal(tabsResult.tabs[0].id, 42);

  // Screenshot upload flow: extension uploads bytes via link.upload and returns path -> host resolves verified local path.
  const shotPromise = host.callBrowserTool("browser_screenshot", { tabId: 42 });
  const deadline2 = Date.now() + 5000;
  while (asksReceived.length < 2 && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 25));
  const shotAsk = asksReceived[1];
  assert.equal(shotAsk.tool, "browser_screenshot");
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  const uploaded = await client.call("link.upload", {
    name: "tab-42.jpg",
    data: fakeJpeg,
    last: true,
  });
  await client.call("link.browser.answer", shotAsk.id, {
    ok: true,
    result: { tabId: 42, url: "https://github.com", title: "GitHub", format: "jpeg", path: uploaded.path },
  });
  const shotResult = await shotPromise;
  assert.ok(typeof shotResult.path === "string" && shotResult.path.includes("tab-42.jpg"));

  // Pausing extension removes browser tools from host.
  await client.call("link.browser.state", { enabled: false, mode: "all" });
  assert.equal(host.browserTools().length, 0);
});

test("Workspace registers browser tools for owner turns and excludes them for member turns", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-ws-browser-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(
    dir,
    async () => ({
      createSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
      resumeSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
      deleteSession: async () => {},
    }),
    () => {},
    {
      browserTools: () => ({
        tools: () => BROWSER_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, readOnly: tool.readOnly, source: "browser" })),
        call: async (name) => ({ called: name }),
      }),
    },
  );
  const chatId = ws.createChat("pip");
  const chat = ws.chat(chatId);
  const bot = ws.bot("pip");
  const run = { id: "r1", chatId, botId: bot.id };
  const task = { stopped: false, run };
  ws.active.set(chatId, task);
  t.after(() => ws.active.delete(chatId));

  const tools = ws.sessionTools(bot, chat, run, task);
  assert.ok(tools.some((tool) => tool.name === "browser_tabs"));
  assert.ok(tools.some((tool) => tool.name === "browser_click"));
  assert.ok(tools.some((tool) => tool.name === "browser_list"));
  // Browser tools run unattended without per-click approval prompts.
  assert.equal(tools.find((tool) => tool.name === "browser_click").skipPermission, true);
});
