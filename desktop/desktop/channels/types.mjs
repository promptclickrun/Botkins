// Shared types, constants, defaults, and sanitization helpers for Channel Hooks.
// Secrets never live in connection records: only vault references ("vault:<id>") are stored.

export const CHANNEL_KINDS = Object.freeze(["slack", "telegram", "discord", "imessage"]);

export const CHANNEL_TRANSPORTS = Object.freeze({
  slack: Object.freeze(["socket_mode", "webhook"]),
  telegram: Object.freeze(["long_polling", "webhook"]),
  discord: Object.freeze(["gateway", "webhook"]),
  imessage: Object.freeze(["imsg_local", "imsg_node"]),
});

export const DEFAULT_TRANSPORT = Object.freeze({
  slack: "socket_mode",
  telegram: "long_polling",
  discord: "gateway",
  imessage: "imsg_local",
});

/** Credential keys each channel kind expects in the vault (labels for guided UI / CLI). */
export const CHANNEL_SECRET_SPECS = Object.freeze({
  slack: Object.freeze([
    Object.freeze({ key: "appToken", label: "App-level token (xapp-...)", required: true }),
    Object.freeze({ key: "botToken", label: "Bot user OAuth token (xoxb-...)", required: true }),
  ]),
  telegram: Object.freeze([
    Object.freeze({ key: "botToken", label: "Bot token from @BotFather", required: true }),
  ]),
  discord: Object.freeze([
    Object.freeze({ key: "botToken", label: "Bot token", required: true }),
  ]),
  imessage: Object.freeze([]),
});

export const DM_POLICIES = Object.freeze(["pairing", "allowlist", "open", "off"]);
export const GROUP_MODES = Object.freeze(["mention", "all"]);
export const TOOL_PROFILES = Object.freeze(["restricted", "standard"]);
export const CONNECTION_STATES = Object.freeze([
  "connected",
  "reconnecting",
  "auth_error",
  "disabled",
  "paused",
  "waiting_permission",
  "disconnected",
]);

export const DEFAULT_LIMITS = Object.freeze({
  senderPerMinute: 10,
  connectionPerMinute: 60,
  maxInboundLength: 4000,
  maxAttachmentBytes: 5 * 1024 * 1024,
  allowedAttachmentTypes: Object.freeze(["image/*", "text/plain", "application/pdf"]),
  dailyTurnCap: 200,
});

export const PAIRING_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_PAIRINGS = 100;

export function defaultPolicy() {
  return {
    dm: "pairing",
    allowlist: [],
    groups: {
      enabled: false,
      mode: "mention",
      channels: [],
    },
    toolProfile: "restricted",
    ignoreBots: true,
    notifyPhone: false,
    limits: {
      ...DEFAULT_LIMITS,
      allowedAttachmentTypes: [...DEFAULT_LIMITS.allowedAttachmentTypes],
    },
  };
}

export function cleanText(value, max = 120) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max)
    : "";
}

export function positiveInt(value, fallback, min = 1, max = 1_000_000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizePolicy(raw = {}, base = defaultPolicy()) {
  const dm = DM_POLICIES.includes(raw.dm) ? raw.dm : base.dm;
  const toolProfile = TOOL_PROFILES.includes(raw.toolProfile) ? raw.toolProfile : base.toolProfile;
  const ignoreBots = typeof raw.ignoreBots === "boolean" ? raw.ignoreBots : base.ignoreBots;
  const notifyPhone = typeof raw.notifyPhone === "boolean" ? raw.notifyPhone : Boolean(base.notifyPhone);
  const rawGroups = raw.groups && typeof raw.groups === "object" ? raw.groups : {};
  const groups = {
    enabled: typeof rawGroups.enabled === "boolean" ? rawGroups.enabled : base.groups.enabled,
    mode: GROUP_MODES.includes(rawGroups.mode) ? rawGroups.mode : base.groups.mode,
    channels: Array.isArray(rawGroups.channels)
      ? [...new Set(rawGroups.channels.map((c) => cleanText(String(c), 160)).filter(Boolean))].slice(0, 200)
      : [...base.groups.channels],
  };
  const rawAllow = Array.isArray(raw.allowlist) ? raw.allowlist : base.allowlist;
  const seen = new Set();
  const allowlist = [];
  for (const entry of rawAllow) {
    const senderId = cleanText(typeof entry === "string" ? entry : entry?.senderId, 160);
    if (!senderId || seen.has(senderId)) continue;
    seen.add(senderId);
    allowlist.push({
      senderId,
      display: cleanText(typeof entry === "object" ? entry?.display : "", 120),
      addedAt: Number(entry?.addedAt) || Date.now(),
      source: cleanText(typeof entry === "object" ? entry?.source : "", 40) || "manual",
    });
  }
  const rawLimits = raw.limits && typeof raw.limits === "object" ? raw.limits : {};
  const limits = {
    senderPerMinute: positiveInt(rawLimits.senderPerMinute, base.limits.senderPerMinute, 1, 1000),
    connectionPerMinute: positiveInt(rawLimits.connectionPerMinute, base.limits.connectionPerMinute, 1, 10000),
    maxInboundLength: positiveInt(rawLimits.maxInboundLength, base.limits.maxInboundLength, 64, 32000),
    maxAttachmentBytes: positiveInt(rawLimits.maxAttachmentBytes, base.limits.maxAttachmentBytes, 1024, 50 * 1024 * 1024),
    allowedAttachmentTypes: Array.isArray(rawLimits.allowedAttachmentTypes)
      ? [...new Set(rawLimits.allowedAttachmentTypes.map((t) => cleanText(String(t).toLowerCase(), 80)).filter(Boolean))].slice(0, 32)
      : [...base.limits.allowedAttachmentTypes],
    dailyTurnCap: positiveInt(rawLimits.dailyTurnCap, base.limits.dailyTurnCap, 1, 100000),
  };
  return { dm, allowlist, groups, toolProfile, ignoreBots, notifyPhone, limits };
}

export function normalizeInboundEvent(raw = {}) {
  const channel = cleanText(raw.channel, 32).toLowerCase();
  const conversationId = cleanText(String(raw.conversationId ?? ""), 200);
  const threadId = raw.threadId != null && String(raw.threadId).trim() !== ""
    ? cleanText(String(raw.threadId), 200)
    : undefined;
  const senderObj = raw.sender && typeof raw.sender === "object" ? raw.sender : {};
  const sender = {
    id: cleanText(String(senderObj.id ?? ""), 200),
    display: cleanText(String(senderObj.display || senderObj.id || "Unknown"), 120),
    ...(senderObj.isBot && { isBot: true }),
  };
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments
        .filter((a) => a && typeof a === "object")
        .slice(0, 10)
        .map((a) => ({
          name: cleanText(String(a.name || "attachment"), 160) || "attachment",
          contentType: cleanText(String(a.contentType || a.mimeType || "application/octet-stream").toLowerCase(), 120),
          size: Number.isFinite(Number(a.size)) ? Math.max(0, Number(a.size)) : 0,
          ...(typeof a.url === "string" && a.url ? { url: a.url } : {}),
          ...(typeof a.localPath === "string" && a.localPath ? { localPath: a.localPath } : {}),
          ...(typeof a.fetchData === "function" ? { fetchData: a.fetchData } : {}),
          ...(a.data instanceof Uint8Array || Buffer.isBuffer(a.data) ? { data: a.data } : {}),
        }))
    : [];
  return {
    channel,
    conversationId,
    ...(threadId && { threadId }),
    sender,
    isDirect: Boolean(raw.isDirect),
    mentionsBot: Boolean(raw.mentionsBot),
    ...(raw.isSelf && { isSelf: true }),
    text: typeof raw.text === "string" ? raw.text : "",
    attachments,
    receivedAt: Number(raw.receivedAt) || Date.now(),
  };
}

/**
 * Returns the UI/CLI/phone-safe view of a connection. Vault references and raw secret values
 * are NEVER included—only which credential keys are present (`configuredSecrets`).
 */
export function publicConnection(conn, runtimeStatus) {
  const vaultRefs = conn.vaultRefs && typeof conn.vaultRefs === "object" ? conn.vaultRefs : {};
  const now = Date.now();
  const pendingPairings = (conn.pendingPairings ?? [])
    .filter((p) => !p.expiresAt || p.expiresAt > now)
    .map((p) => ({
      code: p.code,
      senderId: p.senderId,
      display: p.display || p.senderId,
      conversationId: p.conversationId,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
    }));
  const status = runtimeStatus ?? {
    state: !conn.enabled ? "disabled" : conn.paused ? "paused" : "disconnected",
    detail: "",
  };
  return {
    id: conn.id,
    kind: conn.kind,
    label: conn.label,
    transport: conn.transport,
    enabled: Boolean(conn.enabled),
    paused: Boolean(conn.paused),
    botId: conn.botId || "",
    ...(conn.nodeHostId && { nodeHostId: conn.nodeHostId }),
    ...(conn.webhookRouteId && { webhookRouteId: conn.webhookRouteId }),
    configuredSecrets: Object.keys(vaultRefs).filter((k) => Boolean(vaultRefs[k])),
    policy: normalizePolicy(conn.policy),
    pendingPairings,
    dailyUsage: conn.dailyUsage ? { date: conn.dailyUsage.date, turns: conn.dailyUsage.turns } : { date: "", turns: 0 },
    status: {
      state: status.state,
      detail: status.detail || "",
      ...(status.backoffMs ? { backoffMs: status.backoffMs } : {}),
      ...(status.nextRetryAt ? { nextRetryAt: status.nextRetryAt } : {}),
      ...(status.connectedAt ? { connectedAt: status.connectedAt } : {}),
      ...(status.lastEventAt ? { lastEventAt: status.lastEventAt } : {}),
    },
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}
