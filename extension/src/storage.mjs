// Browser extension storage schema and helpers.
// Keeps state persisted in chrome.storage.local so MV3 service worker restarts lose nothing.

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  mode: "all", // "all" (every eligible tab except paused ones) | "group" (only tabs in the Botkins tab group)
  groupName: "Botkins",
  groupColor: "orange",
  profileLabel: "",
  pausedTabIds: [], // session-level paused tab ids
});

export function detectBrowserName(ua = typeof navigator !== "undefined" ? navigator.userAgent : "") {
  if (/Edg\//i.test(ua)) return "Edge";
  if (/Brave/i.test(ua)) return "Brave";
  if (/Vivaldi/i.test(ua)) return "Vivaldi";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/Arc\//i.test(ua)) return "Arc";
  return "Chrome";
}

export function detectPlatform(ua = typeof navigator !== "undefined" ? navigator.userAgent : "") {
  if (/Mac OS X|Macintosh/i.test(ua)) return "darwin";
  if (/Windows/i.test(ua)) return "win32";
  if (/Linux|CrOS/i.test(ua)) return "linux";
  return "desktop";
}

export function defaultDeviceName(profileLabel = "") {
  const browser = detectBrowserName();
  const label = String(profileLabel || "").trim();
  return label ? `${browser} (${label})`.slice(0, 60) : `${browser} Extension`;
}

export async function loadState(storage = chrome.storage.local) {
  const raw = await storage.get([
    "settings",
    "profileSession",
    "pendingEnroll",
    "hosts",
    "pairings",
    "enabledHosts",
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  if (!Array.isArray(settings.pausedTabIds)) settings.pausedTabIds = [];
  return {
    settings,
    profileSession: raw.profileSession ?? null,
    pendingEnroll: raw.pendingEnroll ?? null,
    hosts: Array.isArray(raw.hosts) ? raw.hosts : [], // ProfileHost[]
    pairings: raw.pairings && typeof raw.pairings === "object" ? raw.pairings : {}, // serverId -> Pairing
    enabledHosts: raw.enabledHosts && typeof raw.enabledHosts === "object" ? raw.enabledHosts : {}, // serverId -> boolean
  };
}

export async function savePatch(patch, storage = chrome.storage.local) {
  await storage.set(patch);
}
