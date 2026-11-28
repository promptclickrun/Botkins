// Botkins Browser Control MV3 Service Worker.
//
// Manages:
// 1. Botkins Profile sign-in (profile.botkins.app passkey/code flow) and direct Link pairing fallback.
// 2. Multi-host connections (connect to one or more of your Botkins hosts, over LAN/Tailscale or relay).
// 3. Dispatching incoming `browser_*` asks to BrowserController (DOM-first via chrome.scripting, with ephemeral chrome.debugger fallback) and returning results.
// 4. Lightweight MV3 alarm watchdog (1 min) to restore connections if Chrome ever restarts the worker.
import {
  BrowserHostClient,
  pair,
  parsePairingUrl,
  profileApi,
  profileConnect,
  relayFetch,
} from "./link-bridge.mjs";
import { BrowserController } from "./browser-controller.mjs";
import {
  DEFAULT_SETTINGS,
  defaultDeviceName,
  detectBrowserName,
  detectPlatform,
  loadState,
  savePatch,
} from "./storage.mjs";

const WATCHDOG_ALARM = "botkins-watchdog";
const ENROLL_POLL_ALARM = "botkins-enroll-poll";

const clients = new Map(); // serverId -> BrowserHostClient
const hostStatus = new Map(); // serverId -> { state, route, error }
const handledAsks = new Set();

function makeDeviceDescriptor(settings) {
  return {
    name: defaultDeviceName(settings?.profileLabel),
    platform: detectPlatform(),
    kind: "browser",
  };
}

function makeBrowserState(settings) {
  return {
    enabled: settings.enabled !== false,
    mode: settings.mode === "group" ? "group" : "all",
    browser: detectBrowserName(),
    profile: String(settings.profileLabel || "").trim(),
    version: chrome.runtime?.getManifest?.().version || "0.2.0",
  };
}

function makeRelayFetcher() {
  return relayFetch((url, init) => globalThis.fetch(url, init), {
    WebSocket: globalThis.WebSocket,
  });
}

async function updateBadge() {
  try {
    const state = await loadState();
    if (state.settings.enabled === false) {
      await chrome.action.setBadgeText({ text: "OFF" });
      await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
      return;
    }
    const connected = [...hostStatus.values()].filter((s) => s.state === "online").length;
    if (connected > 0) {
      await chrome.action.setBadgeText({ text: connected > 1 ? String(connected) : "ON" });
      await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    } else if (clients.size > 0) {
      await chrome.action.setBadgeText({ text: "..." });
      await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch {}
}

async function ensureHostConnected(serverId, pairing) {
  if (clients.has(serverId)) return clients.get(serverId);
  const controller = new BrowserController({
    getSettings: async () => (await loadState()).settings,
    uploadScreenshot: async (b64, name, mime) => {
      const client = clients.get(serverId);
      if (!client) throw new Error("Host disconnected during screenshot upload.");
      return client.uploadBase64(b64, name, mime);
    },
  });

  const client = new BrowserHostClient(pairing, {
    getBrowserState: async () => makeBrowserState((await loadState()).settings),
    onState: (state, error) => {
      hostStatus.set(serverId, { ...(hostStatus.get(serverId) || {}), state, error });
      void updateBadge();
      if (state === "revoked") {
        void handleRevokedHost(serverId);
      }
    },
    onRoute: (route) => {
      hostStatus.set(serverId, { ...(hostStatus.get(serverId) || {}), route });
    },
    onHosts: async (hosts) => {
      const current = await loadState();
      const existing = current.pairings[serverId];
      if (!existing) return;
      const nextPairings = { ...current.pairings, [serverId]: { ...existing, hosts } };
      await savePatch({ pairings: nextPairings });
    },
    onAsks: (asks) => {
      for (const ask of asks) {
        if (!ask?.id || handledAsks.has(ask.id)) continue;
        handledAsks.add(ask.id);
        if (handledAsks.size > 500) {
          const oldest = handledAsks.values().next().value;
          handledAsks.delete(oldest);
        }
        void executeAsk(serverId, client, controller, ask);
      }
    },
  });
  clients.set(serverId, client);
  hostStatus.set(serverId, { state: "connecting", route: null, error: "" });
  client.start();
  void updateBadge();
  return client;
}

async function executeAsk(serverId, client, controller, ask) {
  try {
    const result =
      ask.tool === "secure.fill"
        ? await controller.runSecureFill(ask.args || {})
        : await controller.run(ask.tool, ask.args || {});
    await client.answerAsk(ask.id, { ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || "Browser tool failed.");
    const payload = { ok: false, error: message };
    if (err && typeof err === "object" && typeof err.secureCode === "string") {
      payload.code = err.secureCode;
    }
    await client.answerAsk(ask.id, payload).catch(() => {});
  } finally {
    if (ask.tool === "secure.fill" && Array.isArray(ask.args?.fields)) {
      for (const f of ask.args.fields) {
        if (f && typeof f === "object") f.value = "";
      }
      ask.args.fields.length = 0;
    }
  }
}

async function handleRevokedHost(serverId) {
  const client = clients.get(serverId);
  if (client) {
    client.stop();
    clients.delete(serverId);
  }
  const state = await loadState();
  const nextPairings = { ...state.pairings };
  delete nextPairings[serverId];
  const nextEnabled = { ...state.enabledHosts, [serverId]: false };
  await savePatch({ pairings: nextPairings, enabledHosts: nextEnabled });
  hostStatus.set(serverId, { state: "revoked", route: null, error: "Removed on host." });
  void updateBadge();
}

async function disconnectHost(serverId) {
  const client = clients.get(serverId);
  if (client) {
    client.stop();
    clients.delete(serverId);
  }
  hostStatus.delete(serverId);
  void updateBadge();
}

async function syncAllConnections() {
  const state = await loadState();
  const desired = new Set();
  for (const [serverId, pairing] of Object.entries(state.pairings)) {
    if (state.enabledHosts[serverId] !== false) {
      desired.add(serverId);
      await ensureHostConnected(serverId, pairing);
    }
  }
  for (const serverId of [...clients.keys()]) {
    if (!desired.has(serverId)) await disconnectHost(serverId);
  }
  await updateBadge();
}

async function pushStateToAllClients() {
  const state = await loadState();
  const payload = makeBrowserState(state.settings);
  await Promise.all([...clients.values()].map((c) => c.reportBrowserState(payload)));
  await updateBadge();
}

// ── Profile sign-in & host directory ────────────────────────────────────────────────────────────

async function startProfileSignIn() {
  const state = await loadState();
  const label = defaultDeviceName(state.settings.profileLabel);
  const attempt = await profileApi.start(label);
  const pendingEnroll = { ...attempt, startedAt: Date.now() };
  await savePatch({ pendingEnroll });
  await chrome.tabs.create({ url: attempt.url, active: true });
  await chrome.alarms.create(ENROLL_POLL_ALARM, { periodInMinutes: 0.5 });
  return { id: attempt.id, code: attempt.code, url: attempt.url };
}

async function checkProfileSignIn() {
  const state = await loadState();
  const attempt = state.pendingEnroll;
  if (!attempt) return { status: "idle", profileSession: state.profileSession };
  try {
    const session = await profileApi.finish(attempt);
    if (!session) return { status: "pending", code: attempt.code, url: attempt.url };
    await chrome.alarms.clear(ENROLL_POLL_ALARM);
    await savePatch({ profileSession: session, pendingEnroll: null });
    const refreshed = await refreshProfileHosts(session.token);
    return { status: "signed_in", profileSession: session, hosts: refreshed.hosts };
  } catch (err) {
    if (Number(err?.status) === 410) {
      await chrome.alarms.clear(ENROLL_POLL_ALARM);
      await savePatch({ pendingEnroll: null });
      return { status: "expired", error: err.message };
    }
    return { status: "pending", code: attempt.code, url: attempt.url, error: err?.message };
  }
}

async function cancelProfileSignIn() {
  await chrome.alarms.clear(ENROLL_POLL_ALARM);
  await savePatch({ pendingEnroll: null });
  return { ok: true };
}

async function refreshProfileHosts(tokenOverride) {
  const state = await loadState();
  const token = tokenOverride || state.profileSession?.token;
  if (!token) throw new Error("Not signed in to a Botkins profile.");
  const home = await profileApi.home(token);
  const hosts = (home.hosts || []).filter((h) => !h.member);
  const nextSession = {
    ...state.profileSession,
    name: home.profile?.name || state.profileSession?.name,
    email: home.profile?.email || state.profileSession?.email,
    avatar: home.profile?.avatar || "",
  };
  // Refresh stored routes for any already-paired host in the profile directory.
  const nextPairings = { ...state.pairings };
  for (const host of hosts) {
    if (nextPairings[host.serverId] && Array.isArray(host.hosts) && host.hosts.length) {
      const merged = [...host.hosts, ...(nextPairings[host.serverId].hosts || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 8);
      nextPairings[host.serverId] = { ...nextPairings[host.serverId], name: host.name, hosts: merged };
    }
  }
  await savePatch({ profileSession: nextSession, hosts, pairings: nextPairings });
  return { profileSession: nextSession, hosts };
}

async function connectProfileHost(serverId) {
  const state = await loadState();
  const session = state.profileSession;
  if (!session?.token) throw new Error("Sign in to your Botkins profile first.");
  const host = state.hosts.find((h) => h.serverId === serverId);
  if (!host) throw new Error("Host not found in your Botkins profile.");
  let pairing = state.pairings[serverId];
  if (!pairing) {
    const fetcher = makeRelayFetcher();
    try {
      pairing = await profileConnect(
        fetcher,
        host,
        makeDeviceDescriptor(state.settings),
        (publicKey) => profileApi.proof(session.token, "connect", host.serverId, host.serverKey, publicKey),
      );
    } finally {
      fetcher.rest?.();
    }
  }
  const nextPairings = { ...state.pairings, [serverId]: pairing };
  const nextEnabled = { ...state.enabledHosts, [serverId]: true };
  await savePatch({ pairings: nextPairings, enabledHosts: nextEnabled });
  await ensureHostConnected(serverId, pairing);
  return { ok: true, pairing: { serverId: pairing.serverId, name: pairing.name, deviceId: pairing.deviceId } };
}

async function toggleHost(serverId, enabled) {
  const state = await loadState();
  if (enabled) {
    if (state.pairings[serverId]) {
      await savePatch({ enabledHosts: { ...state.enabledHosts, [serverId]: true } });
      await ensureHostConnected(serverId, state.pairings[serverId]);
      return { ok: true };
    }
    return await connectProfileHost(serverId);
  }
  await savePatch({ enabledHosts: { ...state.enabledHosts, [serverId]: false } });
  await disconnectHost(serverId);
  return { ok: true };
}

async function pairDirect(pairingInput) {
  const target = parsePairingUrl(String(pairingInput || "").trim());
  if (!target) throw new Error("Paste a valid botkins://pair?... link from Settings › Phone.");
  const state = await loadState();
  const fetcher = makeRelayFetcher();
  let pairing;
  try {
    pairing = await pair(fetcher, target, makeDeviceDescriptor(state.settings));
  } finally {
    fetcher.rest?.();
  }
  const nextPairings = { ...state.pairings, [pairing.serverId]: pairing };
  const nextEnabled = { ...state.enabledHosts, [pairing.serverId]: true };
  await savePatch({ pairings: nextPairings, enabledHosts: nextEnabled });
  await ensureHostConnected(pairing.serverId, pairing);
  return { ok: true, host: { serverId: pairing.serverId, name: pairing.name } };
}

async function forgetHost(serverId) {
  const client = clients.get(serverId);
  if (client) {
    await client.unpair();
  }
  await disconnectHost(serverId);
  const state = await loadState();
  const nextPairings = { ...state.pairings };
  delete nextPairings[serverId];
  const nextEnabled = { ...state.enabledHosts };
  delete nextEnabled[serverId];
  await savePatch({ pairings: nextPairings, enabledHosts: nextEnabled });
  return { ok: true };
}

async function signOutProfile() {
  const state = await loadState();
  if (state.profileSession?.token && state.profileSession?.deviceId) {
    await profileApi.revoke(state.profileSession.token, state.profileSession.deviceId).catch(() => {});
  }
  for (const serverId of [...clients.keys()]) {
    await disconnectHost(serverId);
  }
  await chrome.alarms.clear(ENROLL_POLL_ALARM);
  await savePatch({
    profileSession: null,
    pendingEnroll: null,
    hosts: [],
    pairings: {},
    enabledHosts: {},
  });
  await updateBadge();
  return { ok: true };
}

// ── UI Snapshot & Message Handler ───────────────────────────────────────────────────────────────

async function getUiSnapshot() {
  const state = await loadState();
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const byId = new Map();
  for (const host of state.hosts) {
    byId.set(host.serverId, {
      serverId: host.serverId,
      name: host.name,
      source: "profile",
      paired: Boolean(state.pairings[host.serverId]),
      enabled: state.enabledHosts[host.serverId] === true,
      status: hostStatus.get(host.serverId) || { state: "offline", route: null, error: "" },
    });
  }
  for (const [serverId, pairing] of Object.entries(state.pairings)) {
    if (!byId.has(serverId)) {
      byId.set(serverId, {
        serverId,
        name: pairing.name,
        source: "direct",
        paired: true,
        enabled: state.enabledHosts[serverId] !== false,
        status: hostStatus.get(serverId) || { state: "offline", route: null, error: "" },
      });
    }
  }
  return {
    settings: state.settings,
    browserName: detectBrowserName(),
    profile: state.profileSession
      ? {
          name: state.profileSession.name,
          email: state.profileSession.email,
          avatar: state.profileSession.avatar || "",
        }
      : null,
    pendingEnroll: state.pendingEnroll
      ? { id: state.pendingEnroll.id, code: state.pendingEnroll.code, url: state.pendingEnroll.url }
      : null,
    hosts: [...byId.values()],
    activeTab: activeTab
      ? {
          id: activeTab.id,
          title: activeTab.title || "",
          url: activeTab.url || "",
          paused: state.settings.pausedTabIds.includes(activeTab.id),
        }
      : null,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "get_status":
          return sendResponse({ ok: true, data: await getUiSnapshot() });
        case "start_profile_signin":
          return sendResponse({ ok: true, data: await startProfileSignIn() });
        case "check_profile_signin":
          return sendResponse({ ok: true, data: await checkProfileSignIn() });
        case "cancel_profile_signin":
          return sendResponse({ ok: true, data: await cancelProfileSignIn() });
        case "refresh_hosts":
          return sendResponse({ ok: true, data: await refreshProfileHosts() });
        case "toggle_host":
          return sendResponse({ ok: true, data: await toggleHost(message.serverId, Boolean(message.enabled)) });
        case "pair_direct":
          return sendResponse({ ok: true, data: await pairDirect(message.url) });
        case "forget_host":
          return sendResponse({ ok: true, data: await forgetHost(message.serverId) });
        case "sign_out":
          return sendResponse({ ok: true, data: await signOutProfile() });
        case "update_settings": {
          const state = await loadState();
          const next = { ...DEFAULT_SETTINGS, ...state.settings, ...(message.patch || {}) };
          await savePatch({ settings: next });
          await pushStateToAllClients();
          return sendResponse({ ok: true, data: await getUiSnapshot() });
        }
        case "toggle_pause_tab": {
          const state = await loadState();
          const tabId = Number(message.tabId);
          const paused = new Set(state.settings.pausedTabIds || []);
          if (paused.has(tabId)) paused.delete(tabId);
          else paused.add(tabId);
          await savePatch({ settings: { ...state.settings, pausedTabIds: [...paused] } });
          return sendResponse({ ok: true, data: await getUiSnapshot() });
        }
        case "add_tab_to_group": {
          const tabId = Number(message.tabId);
          const tab = await chrome.tabs.get(tabId);
          const ctrl = new BrowserController({ getSettings: async () => (await loadState()).settings, uploadScreenshot: async () => "" });
          await ctrl.ensureTabInGroup(tab.id, tab.windowId);
          return sendResponse({ ok: true, data: await getUiSnapshot() });
        }
        default:
          return sendResponse({ ok: false, error: "Unknown message type." });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true;
});

// Clean up pausedTabIds when tabs close.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  if (state.settings.pausedTabIds.includes(tabId)) {
    const next = state.settings.pausedTabIds.filter((id) => id !== tabId);
    await savePatch({ settings: { ...state.settings, pausedTabIds: next } });
  }
});

// Alarms keep connections resilient across MV3 service worker restarts and complete profile sign-in.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === WATCHDOG_ALARM) {
    await syncAllConnections();
    for (const client of clients.values()) client.wake();
  } else if (alarm.name === ENROLL_POLL_ALARM) {
    await checkProfileSignIn();
  }
});

async function boot() {
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  await syncAllConnections();
}

chrome.runtime.onInstalled.addListener(() => void boot());
chrome.runtime.onStartup.addListener(() => void boot());
void boot();
