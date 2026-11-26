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
  assert.equal(tools.some((tool) => tool.name === "secure.fill"), false, "secure.fill must never be a bot-callable browser tool");
  // Browser tools run unattended without per-click approval prompts.
  assert.equal(tools.find((tool) => tool.name === "browser_click").skipPermission, true);
});

async function runExtensionSecureFillE2E(t, { viaRelay }) {
  const dir = mkdtempSync(join(tmpdir(), viaRelay ? "botkins-secfill-relay-" : "botkins-secfill-direct-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sentinelEmail = "SENTINEL_LINK_EMAIL_a7c31f@example.test";
  const sentinelPass = "SENTINEL_LINK_PASS_9d2e4b!";
  const hostLogs = [];

  const cleanups = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) await fn();
  });

  let relay = null;
  let relayUrl = null;
  if (viaRelay) {
    const { createRelay } = await import("../../mobile/relay/node/server.mjs");
    relay = createRelay({ limits: false, pushUpstream: "off" });
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    relayUrl = "http://127.0.0.1:" + relay.address().port;
    cleanups.push(async () => {
      const closed = new Promise((resolve) => relay.close(resolve));
      relay.closeAllConnections?.();
      await closed;
    });
  }

  let host;
  const listeners = new Set();
  const ws = new Workspace(
    dir,
    async () => ({
      createSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
      resumeSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
      deleteSession: async () => {},
    }),
    () => {
      for (const fn of listeners) fn();
    },
    {
      browserTools: () => ({
        tools: () => host?.browserTools() || [],
        devices: () => host?.browserDevices() || [],
        call: (name, args, ctx) => host.callBrowserTool(name, args, ctx),
        secureFill: (deviceId, payload, options) => host.secureFillBrowser(deviceId, payload, options),
      }),
    },
  );
  const backend = {
    info: () => ({ app: "botkins", version: "0.17.16", platform: "linux" }),
    snapshot: () => ws.snapshot(),
    call: async (method, args) => {
      if (method === "respond") return ws.interactions.respond(...args);
      return null;
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  host = new LinkHost({
    dir: join(dir, "link"),
    port: 0,
    relay: viaRelay ? { url: relayUrl } : false,
    backend,
    log: (...args) => hostLogs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
  });
  cleanups.push(async () => host.stop());
  await host.setEnabled(true);
  if (viaRelay) host.setRelay({ enabled: true, url: relayUrl });

  if (viaRelay) {
    const deadline = Date.now() + 8000;
    while (!host.status().relay?.connected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(host.status().relay?.connected, true, "LinkHost should connect to local relay");
  }

  const pairingInfo = host.startPairing();
  const target = lib.parsePairingUrl(pairingInfo.url);
  assert.ok(target);

  let clientFetch;
  const wireFrames = [];
  if (viaRelay) {
    const relayHost = target.hosts.find((h) => lib.isRelayHost(h));
    assert.ok(relayHost, "pairing URL must include relay host");
    target.hosts = [relayHost];
    const failDirect = () => Promise.reject(new TypeError("Direct LAN disabled in relay test"));
    const BaseWS = globalThis.WebSocket;
    class InspectingWebSocket extends BaseWS {
      constructor(url, protocols) {
        super(url, protocols);
        this.addEventListener("message", async (ev) => {
          const buf = ev.data instanceof Blob ? Buffer.from(await ev.data.arrayBuffer()) : Buffer.from(ev.data);
          wireFrames.push(buf);
        });
      }
      send(data) {
        if (typeof data !== "string") wireFrames.push(Buffer.from(data));
        return super.send(data);
      }
    }
    clientFetch = lib.relayFetch(failDirect, { idleMs: 50, WebSocket: InspectingWebSocket });
  } else {
    target.hosts = [`127.0.0.1:${host.port}`];
    const extOrigin = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    clientFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), Origin: extOrigin } });
  }

  // Save the sentinel password in the host credential vault and pair an owner phone to answer via $credential ref.
  const savedCredId = await host.credentials.save({ name: "Portal Login", value: sentinelPass });
  const phonePairing = await lib.pair(
    fetch,
    { hosts: [`127.0.0.1:${host.port}`], code: host.startPairing().code },
    { name: "Owner Phone", platform: "ios" },
  );
  const phoneUpdates = [];
  const phone = new lib.LinkClient(phonePairing, {
    fetch,
    onState() {},
    onParts: (p) => phoneUpdates.push(p),
  });
  cleanups.push(() => phone.stop());
  phone.start();

  const extPairingInfo = host.startPairing();
  const extTarget = lib.parsePairingUrl(extPairingInfo.url);
  extTarget.hosts = viaRelay ? extTarget.hosts.filter((h) => lib.isRelayHost(h)) : [`127.0.0.1:${host.port}`];

  const pairing = await lib.pair(clientFetch, extTarget, {
    name: viaRelay ? "Chrome (Relay)" : "Chrome (Direct)",
    platform: "darwin",
    kind: "browser",
  });

  const receivedSecureFills = [];
  let onlineResolve;
  const online = new Promise((r) => (onlineResolve = r));
  const handledAsks = new Set();

  const client = new lib.LinkClient(pairing, {
    fetch: clientFetch,
    onState: (s) => {
      if (s === "online") onlineResolve?.();
    },
    onParts: (parts) => {
      if (!Array.isArray(parts.asks)) return;
      for (const ask of parts.asks) {
        if (handledAsks.has(ask.id)) continue;
        handledAsks.add(ask.id);
        if (ask.tool === "browser_tabs") {
          void client.call("link.browser.answer", ask.id, {
            ok: true,
            result: {
              mode: "all",
              tabs: [{ id: 70, title: "Portal Login", url: "https://portal.example.test/signin", active: true }],
            },
          });
        } else if (ask.tool === "secure.fill") {
          receivedSecureFills.push(JSON.parse(JSON.stringify(ask.args)));
          // Return only { filled, missing } (never echoing values), just like BrowserController.runSecureFill.
          void client.call("link.browser.answer", ask.id, {
            ok: true,
            result: {
              filled: ask.args.fields.map((f) => f.key),
              missing: [],
              leakedFieldIgnoredByHost: "should-be-stripped",
            },
          });
        }
      }
    },
  });
  cleanups.push(() => client.stop());
  client.start();
  await online;

  await client.call("link.browser.state", {
    enabled: true,
    mode: "all",
    browser: "Chrome",
    profile: viaRelay ? "Relay" : "Direct",
    version: "0.2.1",
  });

  // secure.fill cannot be invoked via callBrowserTool (bot-callable path).
  await assert.rejects(() => host.callBrowserTool("secure.fill", { tabId: 70 }), /no browser tool/i);

  const chat = ws.chat(ws.createChat("pip"));
  const run = { id: "run-e2e", chatId: chat.id, botId: "pip" };
  const task = { stopped: false, run };
  ws.active.set(chat.id, task);
  t.after(() => ws.active.delete(chat.id));

  const [askTool, useTool] = ws.secureInputs.tools(ws.bot("pip"), chat, run, task);
  const askPromise = askTool.handler({
    title: "Sign in to portal",
    operation: "page_fill",
    url: "https://portal.example.test/signin",
    fields: [
      { key: "LoginModel.Email", label: "Email", kind: "text" },
      { key: "LoginModel.Password", label: "Password", kind: "password" },
    ],
  });

  // Wait for secure prompt to appear
  const promptDeadline = Date.now() + 5000;
  while (ws.interactions.snapshot().length === 0 && Date.now() < promptDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const [req] = ws.interactions.snapshot();
  assert.equal(req.kind, "secure");
  assert.match(req.detail, /https:\/\/portal\.example\.test/);
  assert.match(req.detail, viaRelay ? /Browser: Chrome \(Relay\)/ : /Browser: Chrome \(Direct\)/);
  assert.match(req.detail, /Tab: Portal Login/);

  await phone.call("respond", req.id, {
    action: "accept",
    content: { "LoginModel.Email": sentinelEmail, "LoginModel.Password": { $credential: savedCredId } },
  });

  const askOut = await askPromise;
  const handlesObj = JSON.parse(askOut);
  assert.deepEqual(Object.keys(handlesObj.handles), ["LoginModel.Email", "LoginModel.Password"]);

  const useOut = await useTool.handler({ handles: handlesObj.handles, submit: true });
  const parsedUse = JSON.parse(useOut);
  assert.deepEqual(parsedUse, {
    applied: true,
    filled: ["LoginModel.Email", "LoginModel.Password"],
    missing: [],
  });
  assert.equal(Object.hasOwn(parsedUse, "leakedFieldIgnoredByHost"), false);

  assert.equal(receivedSecureFills.length, 1);
  assert.equal(receivedSecureFills[0].tabId, 70);
  assert.equal(receivedSecureFills[0].origin, "https://portal.example.test");
  assert.equal(receivedSecureFills[0].submit, true);
  assert.deepEqual(receivedSecureFills[0].fields, [
    { key: "LoginModel.Email", kind: "text", value: sentinelEmail },
    { key: "LoginModel.Password", kind: "password", value: sentinelPass },
  ]);

  // Verify the host cleared pending asks and cached asks view for the extension immediately after completion.
  assert.deepEqual(host.browser.asksFor(pairing.deviceId), []);
  const cachedAsksJson = host.browser.views.get(pairing.deviceId)?.get("asks")?.json ?? "";
  assert.equal(cachedAsksJson.includes(sentinelEmail), false, "sentinel leaked into cached browser view");
  assert.equal(cachedAsksJson.includes(sentinelPass), false, "sentinel leaked into cached browser view");

  // Sentinel redaction audit across host logs, workspace snapshot, persisted store, phone updates, wire frames, and tool outputs.
  const allLogs = hostLogs.join("\n");
  const snapStr = JSON.stringify(ws.snapshot());
  const diskStr = readFileSync(join(dir, "workspace.json"), "utf8");
  const phoneStr = JSON.stringify(phoneUpdates);
  for (const sentinel of [sentinelEmail, sentinelPass]) {
    assert.equal(allLogs.includes(sentinel), false, "sentinel leaked into host logs");
    assert.equal(snapStr.includes(sentinel), false, "sentinel leaked into workspace snapshot");
    assert.equal(diskStr.includes(sentinel), false, "sentinel leaked into workspace.json");
    assert.equal(phoneStr.includes(sentinel), false, "sentinel leaked into phone sync parts");
    assert.equal(askOut.includes(sentinel), false, "sentinel leaked into request_secure_input output");
    assert.equal(useOut.includes(sentinel), false, "sentinel leaked into use_secure_input output");
    if (viaRelay) {
      assert.ok(wireFrames.length > 0, "relay test must have captured wire frames");
      const needle = Buffer.from(sentinel, "utf8");
      for (const frame of wireFrames) {
        assert.equal(frame.includes(needle), false, "sentinel appeared unsealed in relay wire frame");
      }
    }
  }
}

test("secure.fill works end-to-end over direct Link with dotted field keys and zero sentinel leakage", async (t) => {
  await runExtensionSecureFillE2E(t, { viaRelay: false });
});

test("secure.fill works end-to-end sealed over the Botkins Relay with zero sentinel leakage", async (t) => {
  await runExtensionSecureFillE2E(t, { viaRelay: true });
});
