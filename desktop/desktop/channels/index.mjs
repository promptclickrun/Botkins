// ChannelManager: owns external channel connections, vault secrets, inbound security enforcement
// (DM pairing/allowlist/open/off, group rules, rate limits, daily turn cap, attachment sandbox,
// prompt-injection framing), Botkins chat routing (via workspace's existing send/queue path),
// workflow channel triggers, reply formatting/splitting/threading, typing indicators, and audit logs.
//
// All configuration mutations are strictly owner-only; no bot tool can call into this manager.

import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ChannelAudit } from "./audit.mjs";
import { prepareOutboundChunks } from "./format.mjs";
import {
  channelSystemInstructions,
  evaluateChannelPermission,
  filterChannelTools,
  frameChannelMessage,
  saveChannelAttachment,
  scrubSecrets,
} from "./security.mjs";
import {
  CHANNEL_KINDS,
  CHANNEL_SECRET_SPECS,
  CHANNEL_TRANSPORTS,
  cleanText,
  DEFAULT_TRANSPORT,
  defaultPolicy,
  MAX_PENDING_PAIRINGS,
  normalizeInboundEvent,
  normalizePolicy,
  PAIRING_TTL_MS,
  publicConnection,
} from "./types.mjs";

const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const RATE_WINDOW_MS = 60_000;
const TYPING_INTERVAL_MS = 4_000;

function generatePairingCode() {
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) code += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  return code;
}

function todayKey(now = Date.now()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class ChannelManager {
  /**
   * @param {object} deps
   * @param {object} deps.workspace - Workspace instance (state, submit, save, notify, events, workflows, board, dir)
   * @param {object} deps.vault - Vault instance (put, get, remove, isRef)
   * @param {object} [deps.adapters] - Map or object of kind -> adapterFactory
   * @param {function} [deps.nodeBridge] - Optional bridge for node-host iMessage operations
   * @param {function} [deps.notifyOwner] - Optional callback({ title, body, connectionId }) when daily cap is hit
   * @param {function} [deps.now] - Clock override for deterministic tests
   */
  constructor({ workspace, vault, adapters = {}, nodeBridge = null, notifyOwner = null, now = () => Date.now() }) {
    this.workspace = workspace;
    this.vault = vault;
    this.nodeBridge = nodeBridge;
    this.notifyOwner = notifyOwner;
    this.now = now;
    this.adapterFactories = new Map(Object.entries(adapters));
    /** @type {Map<string, { adapter: object, controller: AbortController }>} */
    this.running = new Map();
    /** @type {Map<string, object>} */
    this.statuses = new Map();
    /** @type {Map<string, number[]>} */
    this.senderRates = new Map();
    /** @type {Map<string, number[]>} */
    this.connectionRates = new Map();
    /** @type {Map<string, { timer: any, connectionId: string, conversationId: string, threadId?: string }>} */
    this.typingTimers = new Map();
    /** @type {Map<string, { connectionId: string, conversationId: string, threadId?: string, senderId: string }>} */
    this.pendingReplies = new Map();

    this.sandboxDir = workspace?.dir ? join(workspace.dir, "channel-attachments") : null;
    this.audit = new ChannelAudit(workspace?.dir ?? null, {
      getSecrets: () => this.allSecretValues(),
    });

    this._onTurn = (payload) => {
      void this.handleTurnFinished(payload).catch(() => {});
    };
    this.workspace?.events?.on?.("turn", this._onTurn);
  }

  /** Registers an adapter factory for a channel kind ("slack", "telegram", "discord", "imessage"). */
  registerAdapter(kind, factory) {
    this.adapterFactories.set(kind, factory);
  }

  /** Ensures workspace.state.channels exists as an array. */
  connections() {
    if (!Array.isArray(this.workspace.state.channels)) {
      this.workspace.state.channels = [];
    }
    return this.workspace.state.channels;
  }

  /** Finds a connection by id or case-insensitive label. */
  find(ref) {
    const clean = cleanText(String(ref ?? ""), 160);
    if (!clean) return null;
    const list = this.connections();
    return (
      list.find((c) => c.id === clean) ??
      list.find((c) => c.label.toLowerCase() === clean.toLowerCase()) ??
      null
    );
  }

  /** Scrubs any channel vault secret from text (defense-in-depth). */
  scrub(text) {
    return scrubSecrets(text, this.allSecretValues());
  }

  /** Collects all stored vault secret values across connections (for defense-in-depth scrubbing). */
  allSecretValues() {
    const values = [];
    if (!this.vault) return values;
    for (const conn of this.connections()) {
      for (const ref of Object.values(conn.vaultRefs ?? {})) {
        if (!ref) continue;
        try {
          const val = this.vault.get(ref);
          if (typeof val === "string" && val.length >= 4) values.push(val);
        } catch {
          // Vault may be locked or missing key.
        }
      }
    }
    return values;
  }

  /** Resolves the plaintext secrets map for a connection (in memory only, never persisted or returned). */
  resolveSecrets(conn) {
    const out = {};
    if (!this.vault) return out;
    for (const [key, ref] of Object.entries(conn.vaultRefs ?? {})) {
      if (!ref) continue;
      const val = this.vault.get(ref);
      if (val != null) out[key] = val;
    }
    return out;
  }

  /** Returns sanitized connections for UI / CLI / owner phone. */
  list() {
    return this.connections().map((conn) => publicConnection(conn, this.statuses.get(conn.id)));
  }

  /** Returns sanitized connections bound to a specific bot (for the bot page "Published to" badge). */
  forBot(botId) {
    return this.list().filter((c) => c.botId === botId);
  }

  /** Returns the raw connection record for a chat with `chat.channel`, or null. */
  connectionForChat(chat) {
    const cid = chat?.channel?.connectionId;
    return cid ? this.connections().find((c) => c.id === cid) ?? null : null;
  }

  /** Returns the effective toolProfile ("restricted" | "standard") for a channel chat. */
  toolProfileForChat(chat) {
    const conn = this.connectionForChat(chat);
    if (!conn) return null;
    return conn.policy?.toolProfile === "standard" ? "standard" : "restricted";
  }

  /** System instructions injected for a channel chat. */
  systemInstructionsForChat(chat) {
    const conn = this.connectionForChat(chat);
    return conn ? channelSystemInstructions(conn) : "";
  }

  /** Filters tools for a channel chat. */
  filterToolsForChat(chat, tools) {
    const profile = this.toolProfileForChat(chat);
    if (!profile) return tools;
    return filterChannelTools(tools, profile);
  }

  /** Evaluates a permission request for a channel chat. */
  evaluatePermissionForChat(chat, request) {
    const profile = this.toolProfileForChat(chat);
    if (!profile) return null;
    return evaluateChannelPermission(request, profile);
  }

  /** Updates runtime status safely (scrubbing secrets) and notifies subscribers. */
  setStatus(connectionId, next) {
    const scrubbedDetail = scrubSecrets(next?.detail ?? "", this.allSecretValues());
    const prev = this.statuses.get(connectionId) ?? {};
    this.statuses.set(connectionId, {
      ...prev,
      ...next,
      detail: scrubbedDetail,
    });
    this.workspace?.notify?.();
  }

  /** Adds a new channel connection. Secrets are written to the vault and replaced with refs. */
  async add(input = {}) {
    const kind = cleanText(String(input.kind ?? ""), 32).toLowerCase();
    if (!CHANNEL_KINDS.includes(kind)) {
      throw new Error(`Unsupported channel kind "${kind}". Choose one of: ${CHANNEL_KINDS.join(", ")}.`);
    }
    const allowedTransports = CHANNEL_TRANSPORTS[kind];
    let transport = cleanText(String(input.transport ?? ""), 32) || DEFAULT_TRANSPORT[kind];
    if (kind === "imessage" && input.nodeHostId && !input.transport) {
      transport = "imsg_node";
    }
    if (!allowedTransports.includes(transport)) {
      throw new Error(`Unsupported transport "${transport}" for ${kind}.`);
    }
    const label = cleanText(input.label, 80) || `${kind.charAt(0).toUpperCase() + kind.slice(1)} channel`;
    const botId = cleanText(input.botId, 120);
    if (botId && !this.workspace.state.bots.some((b) => b.id === botId)) {
      throw new Error(`Unknown bot "${botId}".`);
    }
    const nodeHostId = kind === "imessage" && transport === "imsg_node"
      ? cleanText(input.nodeHostId, 160)
      : "";
    if (kind === "imessage" && transport === "imsg_node" && !nodeHostId) {
      throw new Error("iMessage via node requires a node host ID.");
    }

    const id = "ch_" + randomUUID().replace(/-/g, "").slice(0, 12);
    const vaultRefs = {};
    const specs = CHANNEL_SECRET_SPECS[kind] ?? [];
    const providedSecrets = input.secrets && typeof input.secrets === "object" ? input.secrets : {};

    for (const spec of specs) {
      const raw = typeof providedSecrets[spec.key] === "string" ? providedSecrets[spec.key].trim() : "";
      if (spec.required && !raw) {
        throw new Error(`Missing required credential "${spec.key}" (${spec.label}) for ${kind}.`);
      }
      if (raw) {
        if (!this.vault) throw new Error("Vault is unavailable; cannot store channel credentials.");
        vaultRefs[spec.key] = this.vault.put(raw, {
          kind: "channel",
          label: `${label} (${spec.key})`,
          owner: id,
        });
      }
    }

    const now = this.now();
    const policy = normalizePolicy(input.policy, defaultPolicy());
    const conn = {
      id,
      kind,
      label,
      transport,
      vaultRefs,
      enabled: input.enabled !== false,
      paused: Boolean(input.paused),
      botId: botId || this.workspace.state.bots[0]?.id || "",
      ...(nodeHostId && { nodeHostId }),
      ...(input.webhookRouteId && { webhookRouteId: cleanText(input.webhookRouteId, 80) }),
      policy,
      pendingPairings: [],
      dailyUsage: { date: todayKey(now), turns: 0, capNotified: false },
      createdAt: now,
      updatedAt: now,
    };

    this.connections().push(conn);
    this.workspace.save();
    if (conn.enabled && !conn.paused && input.autoStart !== false) {
      await this.startConnection(conn.id).catch(() => {});
    } else {
      this.setStatus(conn.id, { state: !conn.enabled ? "disabled" : "paused", detail: "" });
    }
    return publicConnection(conn, this.statuses.get(conn.id));
  }

  /** Updates a channel connection (label, botId, secrets, nodeHostId, policy, enabled). */
  async update(ref, patch = {}) {
    const conn = this.find(ref);
    if (!conn) throw new Error(`Unknown channel "${ref}".`);
    if (patch.label !== undefined) {
      const label = cleanText(patch.label, 80);
      if (label) conn.label = label;
    }
    if (patch.botId !== undefined) {
      const botId = cleanText(patch.botId, 120);
      if (botId && !this.workspace.state.bots.some((b) => b.id === botId)) {
        throw new Error(`Unknown bot "${botId}".`);
      }
      conn.botId = botId;
    }
    if (patch.nodeHostId !== undefined && conn.kind === "imessage") {
      const nodeHostId = cleanText(patch.nodeHostId, 160);
      if (nodeHostId) {
        conn.nodeHostId = nodeHostId;
        conn.transport = "imsg_node";
      } else {
        delete conn.nodeHostId;
        conn.transport = "imsg_local";
      }
    }
    if (patch.policy && typeof patch.policy === "object") {
      conn.policy = normalizePolicy(patch.policy, normalizePolicy(conn.policy));
    }
    if (patch.secrets && typeof patch.secrets === "object") {
      if (!this.vault) throw new Error("Vault is unavailable.");
      const specs = CHANNEL_SECRET_SPECS[conn.kind] ?? [];
      for (const spec of specs) {
        if (typeof patch.secrets[spec.key] === "string" && patch.secrets[spec.key].trim()) {
          const oldRef = conn.vaultRefs?.[spec.key];
          if (oldRef) this.vault.remove(oldRef);
          conn.vaultRefs[spec.key] = this.vault.put(patch.secrets[spec.key].trim(), {
            kind: "channel",
            label: `${conn.label} (${spec.key})`,
            owner: conn.id,
          });
        }
      }
    }
    if (typeof patch.enabled === "boolean") conn.enabled = patch.enabled;
    conn.updatedAt = this.now();
    this.workspace.save();

    if (patch.secrets || patch.enabled !== undefined || patch.nodeHostId !== undefined) {
      await this.stopConnection(conn.id);
      if (conn.enabled && !conn.paused) {
        await this.startConnection(conn.id).catch(() => {});
      } else {
        this.setStatus(conn.id, { state: !conn.enabled ? "disabled" : "paused", detail: "" });
      }
    }
    return publicConnection(conn, this.statuses.get(conn.id));
  }

  /** Removes a connection, stops its adapter, and deletes its vault credentials. */
  async remove(ref) {
    const conn = this.find(ref);
    if (!conn) throw new Error(`Unknown channel "${ref}".`);
    await this.stopConnection(conn.id);
    if (this.vault) {
      for (const vaultRef of Object.values(conn.vaultRefs ?? {})) {
        if (vaultRef) this.vault.remove(vaultRef);
      }
    }
    this.statuses.delete(conn.id);
    const list = this.connections();
    const idx = list.findIndex((c) => c.id === conn.id);
    if (idx >= 0) list.splice(idx, 1);
    this.workspace.save();
    return { removed: true, id: conn.id };
  }

  /** Re-binds a connection to a different Botkins bot. */
  bind(ref, botRef) {
    const conn = this.find(ref);
    if (!conn) throw new Error(`Unknown channel "${ref}".`);
    const cleanBot = cleanText(String(botRef ?? ""), 120);
    const bot =
      this.workspace.state.bots.find((b) => b.id === cleanBot) ??
      this.workspace.state.bots.find((b) => b.name.toLowerCase() === cleanBot.toLowerCase());
    if (!bot) throw new Error(`Unknown bot "${botRef}".`);
    conn.botId = bot.id;
    conn.updatedAt = this.now();
    this.workspace.save();
    return publicConnection(conn, this.statuses.get(conn.id));
  }

  /** Updates policy on a connection. */
  setPolicy(ref, patch = {}) {
    const conn = this.find(ref);
    if (!conn) throw new Error(`Unknown channel "${ref}".`);
    const current = normalizePolicy(conn.policy);
    const merged = {
      ...current,
      ...patch,
      groups: patch.groups ? { ...current.groups, ...patch.groups } : current.groups,
      limits: patch.limits ? { ...current.limits, ...patch.limits } : current.limits,
    };
    conn.policy = normalizePolicy(merged, current);
    conn.updatedAt = this.now();
    this.workspace.save();
    return publicConnection(conn, this.statuses.get(conn.id));
  }

  /** Pauses a connection (stops inbound/outbound processing). */
  async pause(ref) {
    const conn = this.find(ref);
    if (!conn) throw new Error(`Unknown channel "${ref}".`);
    conn.paused = true;
    conn.updatedAt = this.now();
    await this.stopConnection(conn.id);
    this.setStatus(conn.id, { state: "paused", detail: "Paused by owner" });
    this.workspace.save();
    return publicConnection(conn, this.statuses.get(conn.id));
  }

  /** Resumes a paused connection. */
  async resume(ref) {
    const conn = this.find(ref);
    if (!conn) throw new Error(`Unknown channel "${ref}".`);
    conn.paused = false;
    conn.enabled = true;
    conn.updatedAt = this.now();
    this.workspace.save();
    await this.startConnection(conn.id).catch(() => {});
    return publicConnection(conn, this.statuses.get(conn.id));
  }

  /** Lists pending pairing requests across all connections or one connection. */
  pairList(ref) {
    const now = this.now();
    const list = ref ? [this.find(ref)].filter(Boolean) : this.connections();
    const results = [];
    for (const conn of list) {
      conn.pendingPairings = (conn.pendingPairings ?? []).filter((p) => !p.expiresAt || p.expiresAt > now);
      for (const p of conn.pendingPairings) {
        results.push({
          connectionId: conn.id,
          connectionLabel: conn.label,
          kind: conn.kind,
          code: p.code,
          senderId: p.senderId,
          display: p.display || p.senderId,
          conversationId: p.conversationId,
          createdAt: p.createdAt,
          expiresAt: p.expiresAt,
        });
      }
    }
    return results;
  }

  /** Approves a one-time pairing code and allowlists that sender. */
  async pairApprove(code, ref) {
    const cleanCode = cleanText(String(code ?? ""), 32).toUpperCase();
    if (!cleanCode) throw new Error("Pairing code is required.");
    const now = this.now();
    const targets = ref ? [this.find(ref)].filter(Boolean) : this.connections();
    for (const conn of targets) {
      conn.pendingPairings = (conn.pendingPairings ?? []).filter((p) => !p.expiresAt || p.expiresAt > now);
      const idx = conn.pendingPairings.findIndex((p) => p.code.toUpperCase() === cleanCode);
      if (idx < 0) continue;
      const [pending] = conn.pendingPairings.splice(idx, 1);
      conn.policy = normalizePolicy(conn.policy);
      if (!conn.policy.allowlist.some((a) => a.senderId === pending.senderId)) {
        conn.policy.allowlist.push({
          senderId: pending.senderId,
          display: pending.display || pending.senderId,
          addedAt: now,
          source: "pairing",
        });
      }
      conn.updatedAt = now;
      this.workspace.save();
      this.audit.record({
        connectionId: conn.id,
        kind: conn.kind,
        senderId: pending.senderId,
        conversationId: pending.conversationId,
        decision: "pairing_approved",
      });
      // Notify sender on the channel that pairing succeeded (best effort).
      const live = this.running.get(conn.id);
      if (live?.adapter?.send && pending.conversationId) {
        await live.adapter
          .send({
            conversationId: pending.conversationId,
            text: "You're paired! Send a message whenever you're ready.",
          })
          .catch(() => {});
      }
      return {
        approved: true,
        connectionId: conn.id,
        senderId: pending.senderId,
        display: pending.display || pending.senderId,
      };
    }
    throw new Error(`No pending pairing request matches code "${cleanCode}".`);
  }

  /** Denies and removes a pending pairing code. */
  pairDeny(code, ref) {
    const cleanCode = cleanText(String(code ?? ""), 32).toUpperCase();
    if (!cleanCode) throw new Error("Pairing code is required.");
    const targets = ref ? [this.find(ref)].filter(Boolean) : this.connections();
    for (const conn of targets) {
      const idx = (conn.pendingPairings ?? []).findIndex((p) => p.code.toUpperCase() === cleanCode);
      if (idx < 0) continue;
      const [pending] = conn.pendingPairings.splice(idx, 1);
      conn.updatedAt = this.now();
      this.workspace.save();
      this.audit.record({
        connectionId: conn.id,
        kind: conn.kind,
        senderId: pending.senderId,
        conversationId: pending.conversationId,
        decision: "pairing_denied",
      });
      return {
        denied: true,
        connectionId: conn.id,
        senderId: pending.senderId,
      };
    }
    throw new Error(`No pending pairing request matches code "${cleanCode}".`);
  }

  /** Tests a connection's adapter credentials/connectivity without sending a message to strangers. */
  async test(ref) {
    const conn = this.find(ref);
    if (!conn) throw new Error(`Unknown channel "${ref}".`);
    const factory = this.adapterFactories.get(conn.kind);
    if (!factory) {
      return { ok: false, state: "disconnected", detail: `No adapter registered for ${conn.kind}.` };
    }
    const secrets = this.resolveSecrets(conn);
    const adapter = factory({ connection: conn, nodeBridge: this.nodeBridge });
    try {
      if (typeof adapter.test === "function") {
        const result = await adapter.test({ connection: conn, secrets, nodeBridge: this.nodeBridge });
        return {
          ok: Boolean(result?.ok),
          state: result?.state || (result?.ok ? "connected" : "auth_error"),
          detail: scrubSecrets(result?.detail || "", this.allSecretValues()),
          ...(result?.identity && { identity: result.identity }),
        };
      }
      const status = this.statuses.get(conn.id);
      return {
        ok: status?.state === "connected",
        state: status?.state || "disconnected",
        detail: status?.detail || "",
      };
    } catch (error) {
      return {
        ok: false,
        state: "auth_error",
        detail: scrubSecrets(error?.message || "Connection test failed.", this.allSecretValues()),
      };
    }
  }

  /** Returns metadata-only audit log entries. */
  logs(ref, { limit = 100 } = {}) {
    const conn = ref ? this.find(ref) : null;
    if (ref && !conn) throw new Error(`Unknown channel "${ref}".`);
    return this.audit.list({ connectionId: conn?.id, limit });
  }

  /** Starts all enabled, unpaused connections. */
  async startAll() {
    for (const conn of this.connections()) {
      if (conn.enabled && !conn.paused) {
        await this.startConnection(conn.id).catch(() => {});
      } else {
        this.setStatus(conn.id, { state: !conn.enabled ? "disabled" : "paused", detail: "" });
      }
    }
  }

  /** Stops all running connections and cleans up timers/listeners. */
  async stopAll() {
    this.workspace?.events?.off?.("turn", this._onTurn);
    for (const timerInfo of this.typingTimers.values()) clearInterval(timerInfo.timer);
    this.typingTimers.clear();
    const ids = [...this.running.keys()];
    await Promise.allSettled(ids.map((id) => this.stopConnection(id)));
  }

  /** Starts one connection's adapter. */
  async startConnection(connectionId) {
    const conn = this.connections().find((c) => c.id === connectionId);
    if (!conn) return;
    await this.stopConnection(connectionId);
    if (!conn.enabled) {
      this.setStatus(connectionId, { state: "disabled", detail: "" });
      return;
    }
    if (conn.paused) {
      this.setStatus(connectionId, { state: "paused", detail: "" });
      return;
    }
    const factory = this.adapterFactories.get(conn.kind);
    if (!factory) {
      this.setStatus(connectionId, { state: "disconnected", detail: `No adapter registered for ${conn.kind}.` });
      return;
    }
    const controller = new AbortController();
    const adapter = factory({ connection: conn, nodeBridge: this.nodeBridge });
    this.running.set(connectionId, { adapter, controller });
    const secrets = this.resolveSecrets(conn);
    try {
      await adapter.start({
        connection: conn,
        secrets,
        signal: controller.signal,
        nodeBridge: this.nodeBridge,
        onStatus: (status) => this.setStatus(connectionId, status),
        onMessage: (event) => this.handleInbound(connectionId, event),
      });
    } catch (error) {
      this.running.delete(connectionId);
      const isAuth = error?.code === "CHANNEL_AUTH_ERROR" || /auth|token|unauthorized|401|403|disallowed intent/i.test(error?.message || "");
      this.setStatus(connectionId, {
        state: isAuth ? "auth_error" : "disconnected",
        detail: scrubSecrets(error?.message || "Failed to start channel.", this.allSecretValues()),
      });
      throw error;
    }
  }

  /** Stops one running connection's adapter. */
  async stopConnection(connectionId) {
    const entry = this.running.get(connectionId);
    if (!entry) return;
    this.running.delete(connectionId);
    entry.controller.abort();
    try {
      await entry.adapter.stop?.();
    } catch {
      // Ignore shutdown errors.
    }
  }

  /**
   * Webhook ingress hook shaped for link/server.mjs `webhooks/<routeId>`.
   * Returns `{ handled: boolean, status?: number, body?: any }`.
   */
  async handleWebhook(routeId, req) {
    const conn = this.connections().find((c) => c.webhookRouteId === routeId && c.enabled && !c.paused);
    if (!conn) return { handled: false };
    const live = this.running.get(conn.id);
    let adapter = live?.adapter;
    if (!adapter) {
      const factory = this.adapterFactories.get(conn.kind);
      if (!factory) return { handled: false };
      adapter = factory({ connection: conn, nodeBridge: this.nodeBridge });
    }
    if (typeof adapter.handleWebhook !== "function") return { handled: false };
    const secrets = this.resolveSecrets(conn);
    const outcome = await adapter.handleWebhook({ ...req, connection: conn, secrets });
    const events = Array.isArray(outcome?.events) ? outcome.events : outcome?.event ? [outcome.event] : [];
    for (const ev of events) {
      await this.handleInbound(conn.id, ev);
    }
    return {
      handled: true,
      status: outcome?.status ?? 200,
      body: outcome?.body ?? { ok: true },
    };
  }

  /** Checks sliding 1-minute rate limits for sender and connection. */
  checkRateLimit(conn, senderId) {
    const now = this.now();
    const cutoff = now - RATE_WINDOW_MS;
    const limits = normalizePolicy(conn.policy).limits;

    const senderKey = `${conn.id}:${senderId}`;
    const sList = (this.senderRates.get(senderKey) ?? []).filter((t) => t > cutoff);
    if (sList.length >= limits.senderPerMinute) {
      this.senderRates.set(senderKey, sList);
      return { ok: false, reason: "sender_rate_limit" };
    }

    const cList = (this.connectionRates.get(conn.id) ?? []).filter((t) => t > cutoff);
    if (cList.length >= limits.connectionPerMinute) {
      this.connectionRates.set(conn.id, cList);
      return { ok: false, reason: "connection_rate_limit" };
    }

    sList.push(now);
    cList.push(now);
    this.senderRates.set(senderKey, sList);
    this.connectionRates.set(conn.id, cList);
    return { ok: true };
  }

  /** Checks and updates the daily turn cap. Notifies owner once per day when hit. */
  checkDailyCap(conn) {
    const now = this.now();
    const today = todayKey(now);
    const limits = normalizePolicy(conn.policy).limits;
    if (!conn.dailyUsage || conn.dailyUsage.date !== today) {
      conn.dailyUsage = { date: today, turns: 0, capNotified: false };
    }
    if (conn.dailyUsage.turns >= limits.dailyTurnCap) {
      if (!conn.dailyUsage.capNotified) {
        conn.dailyUsage.capNotified = true;
        this.workspace.save();
        this.notifyDailyCapHit(conn, limits.dailyTurnCap);
      }
      return { ok: false };
    }
    return { ok: true };
  }

  notifyDailyCapHit(conn, cap) {
    const title = `Channel "${conn.label}" hit its daily turn cap (${cap})`;
    const body = `Inbound messages on ${conn.kind} ("${conn.label}") are paused for the rest of today after reaching ${cap} turns. Raise the daily cap or review activity in Settings › Channels.`;
    if (typeof this.notifyOwner === "function") {
      try {
        this.notifyOwner({ title, body, connectionId: conn.id, kind: conn.kind });
      } catch {
        // Best effort.
      }
    } else if (this.workspace?.board?.post) {
      try {
        const botId = conn.botId || this.workspace.state.bots[0]?.id;
        if (botId) this.workspace.board.post(botId, { kind: "feed", title, body });
      } catch {
        // Best effort.
      }
    }
  }

  /** Finds or creates the dedicated Botkins chat for (connectionId, conversationId, threadId). */
  findOrCreateChat(conn, event) {
    const threadKey = event.threadId || "";
    const existing = this.workspace.state.chats.find(
      (c) =>
        c.channel?.connectionId === conn.id &&
        c.channel?.conversationId === event.conversationId &&
        (c.channel?.threadId || "") === threadKey,
    );
    if (existing) {
      // Keep bound bot synced if owner rebound the channel.
      if (conn.botId && existing.botId !== conn.botId) {
        existing.botId = conn.botId;
        existing.restartSession = true;
      }
      return existing;
    }
    const botId = conn.botId || this.workspace.state.bots[0]?.id;
    if (!botId) throw new Error(`Channel "${conn.label}" has no bot bound.`);
    const title = `${conn.label}: ${event.sender.display || event.conversationId}`.slice(0, 80);
    const created = this.workspace.createChat(botId, title);
    const chat = typeof created === "string" ? this.workspace.chat(created) : created;
    chat.title = title;
    chat.channel = {
      connectionId: conn.id,
      kind: conn.kind,
      label: conn.label,
      conversationId: event.conversationId,
      ...(event.threadId && { threadId: event.threadId }),
    };
    this.workspace.save();
    return chat;
  }

  /** Starts periodic typing indicator on the adapter while the bot is working. */
  startTyping(chatId, connectionId, conversationId, threadId) {
    this.stopTyping(chatId);
    const live = this.running.get(connectionId);
    if (typeof live?.adapter?.typing !== "function") return;
    const ping = () => {
      live.adapter.typing({ conversationId, threadId }).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, TYPING_INTERVAL_MS);
    timer.unref?.();
    this.typingTimers.set(chatId, { timer, connectionId, conversationId, threadId });
  }

  stopTyping(chatId) {
    const info = this.typingTimers.get(chatId);
    if (!info) return;
    clearInterval(info.timer);
    this.typingTimers.delete(chatId);
  }

  /**
   * Core inbound message pipeline. Every adapter feeds normalized events here.
   */
  async handleInbound(connectionId, rawEvent) {
    const conn = this.connections().find((c) => c.id === connectionId);
    if (!conn || !conn.enabled || conn.paused) return { decision: "denied", reason: "inactive" };

    const event = normalizeInboundEvent({ ...rawEvent, channel: rawEvent?.channel || conn.kind });
    if (!event.conversationId || !event.sender.id) {
      return { decision: "denied", reason: "invalid_event" };
    }

    this.setStatus(conn.id, { lastEventAt: this.now() });
    const policy = normalizePolicy(conn.policy);

    // 1. Ignore bot's own messages and other bots' messages by default.
    if (policy.ignoreBots && (event.isSelf || event.sender.isBot)) {
      this.audit.record({
        connectionId: conn.id,
        kind: conn.kind,
        senderId: event.sender.id,
        conversationId: event.conversationId,
        threadId: event.threadId,
        decision: "ignored_bot",
        reason: event.isSelf ? "self_message" : "bot_sender",
      });
      return { decision: "ignored_bot" };
    }

    // 2. Enforce DM or Group policy BEFORE burning rate/daily quotas or starting a turn.
    if (event.isDirect) {
      if (policy.dm === "off") {
        this.audit.record({
          connectionId: conn.id,
          kind: conn.kind,
          senderId: event.sender.id,
          conversationId: event.conversationId,
          threadId: event.threadId,
          decision: "denied",
          reason: "dm_off",
        });
        return { decision: "denied", reason: "dm_off" };
      }
      const allowlisted = policy.allowlist.some((a) => a.senderId === event.sender.id);
      if (policy.dm === "allowlist" && !allowlisted) {
        this.audit.record({
          connectionId: conn.id,
          kind: conn.kind,
          senderId: event.sender.id,
          conversationId: event.conversationId,
          threadId: event.threadId,
          decision: "denied",
          reason: "not_allowlisted",
        });
        return { decision: "denied", reason: "not_allowlisted" };
      }
      if (policy.dm === "pairing" && !allowlisted) {
        const now = this.now();
        conn.pendingPairings = (conn.pendingPairings ?? []).filter((p) => !p.expiresAt || p.expiresAt > now);
        let pending = conn.pendingPairings.find((p) => p.senderId === event.sender.id);
        if (!pending) {
          let code = generatePairingCode();
          while (conn.pendingPairings.some((p) => p.code === code)) code = generatePairingCode();
          pending = {
            code,
            senderId: event.sender.id,
            display: event.sender.display,
            conversationId: event.conversationId,
            createdAt: now,
            expiresAt: now + PAIRING_TTL_MS,
          };
          conn.pendingPairings.push(pending);
          if (conn.pendingPairings.length > MAX_PENDING_PAIRINGS) {
            conn.pendingPairings.shift();
          }
          this.workspace.save();
        }
        this.audit.record({
          connectionId: conn.id,
          kind: conn.kind,
          senderId: event.sender.id,
          conversationId: event.conversationId,
          threadId: event.threadId,
          decision: "paired",
          reason: "pairing_code_issued",
        });
        const live = this.running.get(conn.id);
        if (live?.adapter?.send) {
          await live.adapter
            .send({
              conversationId: event.conversationId,
              threadId: event.threadId,
              text: `Pairing required. Ask the owner to approve code ${pending.code} in Botkins (or run \`botkins channels pair approve ${pending.code}\`).`,
            })
            .catch(() => {});
        }
        return { decision: "paired", code: pending.code };
      }
    } else {
      // Group message policy: off by default; when on, only listed channels and mention/all mode.
      if (!policy.groups.enabled) {
        this.audit.record({
          connectionId: conn.id,
          kind: conn.kind,
          senderId: event.sender.id,
          conversationId: event.conversationId,
          threadId: event.threadId,
          decision: "denied",
          reason: "groups_off",
        });
        return { decision: "denied", reason: "groups_off" };
      }
      if (!policy.groups.channels.includes(event.conversationId)) {
        this.audit.record({
          connectionId: conn.id,
          kind: conn.kind,
          senderId: event.sender.id,
          conversationId: event.conversationId,
          threadId: event.threadId,
          decision: "denied",
          reason: "channel_not_listed",
        });
        return { decision: "denied", reason: "channel_not_listed" };
      }
      if (policy.groups.mode === "mention" && !event.mentionsBot) {
        this.audit.record({
          connectionId: conn.id,
          kind: conn.kind,
          senderId: event.sender.id,
          conversationId: event.conversationId,
          threadId: event.threadId,
          decision: "denied",
          reason: "mention_required",
        });
        return { decision: "denied", reason: "mention_required" };
      }
    }

    // 3. Enforce maximum inbound length.
    if (event.text.length > policy.limits.maxInboundLength) {
      this.audit.record({
        connectionId: conn.id,
        kind: conn.kind,
        senderId: event.sender.id,
        conversationId: event.conversationId,
        threadId: event.threadId,
        decision: "denied",
        reason: "max_inbound_length",
      });
      return { decision: "denied", reason: "max_inbound_length" };
    }

    // 4. Enforce per-sender and per-connection rate limits.
    const rate = this.checkRateLimit(conn, event.sender.id);
    if (!rate.ok) {
      this.audit.record({
        connectionId: conn.id,
        kind: conn.kind,
        senderId: event.sender.id,
        conversationId: event.conversationId,
        threadId: event.threadId,
        decision: "rate_limited",
        reason: rate.reason,
      });
      return { decision: "rate_limited", reason: rate.reason };
    }

    // 5. Enforce daily turn cap (notifies owner when hit).
    const cap = this.checkDailyCap(conn);
    if (!cap.ok) {
      this.audit.record({
        connectionId: conn.id,
        kind: conn.kind,
        senderId: event.sender.id,
        conversationId: event.conversationId,
        threadId: event.threadId,
        decision: "rate_limited",
        reason: "daily_turn_cap",
      });
      return { decision: "rate_limited", reason: "daily_turn_cap" };
    }

    // 6. Validate and sandbox attachments (type + size limits).
    const savedAttachments = [];
    for (const att of event.attachments) {
      if (!this.sandboxDir) continue;
      try {
        const saved = await saveChannelAttachment(this.sandboxDir, conn.id, att, policy.limits);
        if (saved) savedAttachments.push(saved);
      } catch (err) {
        this.audit.record({
          connectionId: conn.id,
          kind: conn.kind,
          senderId: event.sender.id,
          conversationId: event.conversationId,
          threadId: event.threadId,
          decision: "denied",
          reason: err?.message || "attachment_rejected",
        });
        return { decision: "denied", reason: "attachment_rejected" };
      }
    }

    // 7. Fire workflow `channel` trigger with the exact documented fields.
    try {
      this.workspace?.workflows?.onChannelMessage?.({
        channel: conn.kind,
        connection: conn.id,
        conversation: event.conversationId,
        sender: event.sender.id,
        text: event.text,
        isDirect: event.isDirect,
        mentionsBot: event.mentionsBot,
      });
    } catch {
      // Never block inbound turn on workflow listener error.
    }

    // 8. Route through Workspace's existing send/queue path (no second agent loop!).
    const chat = this.findOrCreateChat(conn, event);
    const safeInbound = { ...event, text: this.scrub(event.text) };
    const framed = frameChannelMessage(safeInbound, conn);
    conn.dailyUsage.turns += 1;
    this.workspace.save();

    this.audit.record({
      connectionId: conn.id,
      kind: conn.kind,
      senderId: event.sender.id,
      conversationId: event.conversationId,
      threadId: event.threadId,
      decision: "allowed",
    });

    this.pendingReplies.set(chat.id, {
      connectionId: conn.id,
      conversationId: event.conversationId,
      threadId: event.threadId,
      senderId: event.sender.id,
    });
    this.startTyping(chat.id, conn.id, event.conversationId, event.threadId);

    // Submit through workspace's existing send/queue path.
    const submitPromise = this.workspace.submit(chat.id, framed, {
      attachments: savedAttachments,
      title: `${conn.label}: ${event.sender.display}`.slice(0, 100),
    });
    if (submitPromise && typeof submitPromise.catch === "function") {
      submitPromise.catch((err) => {
        this.stopTyping(chat.id);
        this.audit.record({
          connectionId: conn.id,
          kind: conn.kind,
          senderId: event.sender.id,
          conversationId: event.conversationId,
          threadId: event.threadId,
          decision: "error",
          reason: scrubSecrets(err?.message || "turn_failed", this.allSecretValues()),
        });
      });
    }

    return { decision: "allowed", chatId: chat.id };
  }

  /**
   * Called whenever a workspace turn finishes. If the chat belongs to a channel connection,
   * formats and splits the reply to the adapter's capabilities and posts it back in-thread.
   */
  async handleTurnFinished({ chat, run }) {
    if (!chat?.channel?.connectionId || !run) return;
    this.stopTyping(chat.id);

    const conn = this.connections().find((c) => c.id === chat.channel.connectionId);
    if (!conn || !conn.enabled || conn.paused) return;

    const live = this.running.get(conn.id);
    if (!live?.adapter?.send) return;

    const meta = this.pendingReplies.get(chat.id) ?? {
      connectionId: conn.id,
      conversationId: chat.channel.conversationId,
      threadId: chat.channel.threadId,
      senderId: "",
    };

    if (run.silent || run.noOutput) return;

    // Find assistant messages committed during this run.
    const replies = (chat.messages ?? []).filter(
      (m) => m.role === "assistant" && m.runId === run.id && typeof m.text === "string" && m.text.trim(),
    );
    const rawText = replies.map((m) => m.text.trim()).join("\n\n").trim();
    if (!rawText) return;

    // Defense-in-depth: never echo any vault secret back into an external channel.
    const safeText = scrubSecrets(rawText, this.allSecretValues());
    const chunks = prepareOutboundChunks(safeText, live.adapter.capabilities);
    if (!chunks.length) return;

    try {
      for (const chunk of chunks) {
        await live.adapter.send({
          conversationId: meta.conversationId,
          threadId: meta.threadId,
          text: chunk,
        });
      }
      this.audit.record({
        connectionId: conn.id,
        kind: conn.kind,
        senderId: meta.senderId,
        conversationId: meta.conversationId,
        threadId: meta.threadId,
        decision: "reply_sent",
        turnId: run.id,
        replyParts: chunks.length,
      });
    } catch (error) {
      this.audit.record({
        connectionId: conn.id,
        kind: conn.kind,
        senderId: meta.senderId,
        conversationId: meta.conversationId,
        threadId: meta.threadId,
        decision: "error",
        reason: scrubSecrets(error?.message || "reply_send_failed", this.allSecretValues()),
        turnId: run.id,
      });
    }
  }
}
