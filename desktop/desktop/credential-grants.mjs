// Owner-managed standing grants, audit log, and per-bot rate limiting for vault credential use.
//
// Standing grants are keyed strictly by:
//   (botId, credentialId, destination, operation)
// where `destination` is a canonical pinned origin (e.g. "https://scissorsscotch.com") for web/HTTP
// targets, a pinned command signature for `env_exec`, or an app identifier for `app_fill`.
//
// Levels:
//   - "ask"    (default; no persisted standing grant — prompt the owner each time)
//   - "today"  (allow until local midnight; pruned automatically after expiry)
//   - "always" (allow until revoked)
//   - "deny"   (refuse immediately without prompting, until revoked)
//
// Group chats and non-owner members never receive standing grants.
// No credential value ever enters grants, audit records, or persisted JSON.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pinOrigin } from "./link/domain-match.mjs";

export const GRANT_LEVELS = new Set(["ask", "today", "always", "deny"]);
export const CREDENTIAL_OPERATIONS = new Set([
  "page_fill",
  "page_fill_submit",
  "extension_fill",
  "https_form",
  "bearer_get",
  "https_header",
  "env_exec",
  "app_fill",
]);

export const OPERATION_LABELS = {
  page_fill: "Fill sign-in browser",
  page_fill_submit: "Fill and submit sign-in browser",
  extension_fill: "Fill in Chrome/Edge extension",
  https_form: "Submit HTTPS form",
  bearer_get: "HTTPS GET with Bearer token",
  https_header: "HTTPS request with secret header",
  env_exec: "Run command with secret in environment",
  app_fill: "Fill native app field",
};

const MAX_GRANTS = 500;
const MAX_AUDIT = 500;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_USES_PER_WINDOW = 20;
const DEFAULT_MAX_FAILURES_PER_WINDOW = 8;

const safeText = (value, max = 160) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const id = (prefix) => prefix + "-" + randomBytes(6).toString("hex");

/** Compute local end-of-day timestamp matching desktop/node-host.mjs's "Allow for today" rule. */
export function endOfLocalDay(now = Date.now()) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

/**
 * Canonicalize the pinned destination key for a credential operation.
 * Web and HTTP operations strictly pin to `origin` (scheme + ASCII host + port).
 * `env_exec` pins to the exact command + argument list hash so a grant for one command never
 * authorizes a different command or arguments.
 * `app_fill` pins to `app:<normalized-app-name>`.
 */
export function normalizeDestination(operation, destination, { allowLocalHttp = false } = {}) {
  if (!CREDENTIAL_OPERATIONS.has(operation)) {
    throw new Error("Unsupported credential operation: " + String(operation ?? ""));
  }
  if (operation === "env_exec") {
    const cmd = typeof destination === "string" ? destination.trim() : String(destination?.command ?? "").trim();
    const args = Array.isArray(destination?.args) ? destination.args.map((a) => String(a)) : [];
    const envVar = typeof destination === "object" && destination?.envVar ? String(destination.envVar).trim() : "";
    const cwd = typeof destination === "object" && destination?.cwd ? String(destination.cwd).trim() : "";
    if (!cmd) throw new Error("env_exec requires a command.");
    const digest = createHash("sha256")
      .update(JSON.stringify({ cmd, args, envVar, cwd }))
      .digest("hex")
      .slice(0, 16);
    const displayArgs = args.length ? " " + args.join(" ") : "";
    const envPart = envVar ? ` [${envVar}]` : "";
    return {
      key: `exec:${cmd}:${digest}`,
      label: safeText(`${cmd}${displayArgs}${envPart}`, 160),
    };
  }
  if (operation === "app_fill") {
    const app = typeof destination === "string" ? destination.trim() : String(destination?.app ?? "").trim();
    if (!app) throw new Error("app_fill requires an application name or bundle ID.");
    const clean = safeText(app, 120);
    return {
      key: `app:${clean.toLowerCase()}`,
      label: clean,
    };
  }
  const url = typeof destination === "string" ? destination : String(destination?.url ?? "");
  const origin = pinOrigin(url, { allowLocalHttp });
  if (!origin) {
    throw new Error("Destination must be a valid HTTPS origin (no credentials in URL, no non-HTTPS schemes).");
  }
  return { key: origin, label: origin };
}

function unwrapDestination(destination) {
  const raw = destination && typeof destination === "object" && typeof destination.key === "string" ? destination.key : String(destination ?? "");
  if (!raw || raw === "[object Object]") return "";
  return raw;
}

/** Composite lookup key for a grant tuple. */
export function grantTupleKey({ botId, credentialId, destination, operation }) {
  return JSON.stringify([String(botId ?? ""), String(credentialId ?? ""), unwrapDestination(destination), String(operation ?? "")]);
}

function writeAtomic0600(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Persistent standing grants + audit log + per-bot rate limiter.
 */
export class CredentialGrants {
  constructor({
    dir,
    file,
    now = Date.now,
    rateWindowMs = DEFAULT_RATE_WINDOW_MS,
    maxUsesPerWindow = DEFAULT_MAX_USES_PER_WINDOW,
    maxFailuresPerWindow = DEFAULT_MAX_FAILURES_PER_WINDOW,
    onChange = () => {},
  } = {}) {
    this.file = file || (dir ? join(dir, "credential-grants.json") : null);
    this.now = now;
    this.rateWindowMs = rateWindowMs;
    this.maxUsesPerWindow = maxUsesPerWindow;
    this.maxFailuresPerWindow = maxFailuresPerWindow;
    this.onChange = onChange;
    this.grants = [];
    this.auditEntries = [];
    this.rateBuckets = new Map(); // botId -> { uses: number[], failures: number[] }
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed?.grants)) {
        this.grants = parsed.grants
          .filter((g) => g && typeof g.id === "string" && typeof g.botId === "string" && typeof g.credentialId === "string" && typeof g.destination === "string" && CREDENTIAL_OPERATIONS.has(g.operation) && ["today", "always", "deny"].includes(g.level))
          .slice(0, MAX_GRANTS);
      }
      if (Array.isArray(parsed?.audit)) {
        this.auditEntries = parsed.audit
          .filter((a) => a && typeof a.id === "string" && typeof a.outcome === "string")
          .slice(-MAX_AUDIT);
      }
    } catch {
      // Corrupt or unreadable grant file fails closed (no standing grants).
      this.grants = [];
      this.auditEntries = [];
    }
  }

  save() {
    if (this.file) {
      writeAtomic0600(this.file, { version: 1, grants: this.grants, audit: this.auditEntries });
    }
    this.onChange();
  }

  /** Remove expired "today" grants. Returns true if anything changed. */
  pruneExpired() {
    const t = this.now();
    const before = this.grants.length;
    this.grants = this.grants.filter((g) => g.level !== "today" || (Number.isFinite(g.expiresAt) && g.expiresAt > t));
    if (this.grants.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Look up the active standing grant for (botId, credentialId, destination, operation).
   * Returns null when the effective level is default "ask" (or an expired "today" grant).
   */
  lookup({ botId, credentialId, destination, operation }) {
    this.pruneExpired();
    const target = grantTupleKey({ botId, credentialId, destination, operation });
    const found = this.grants.find((g) => grantTupleKey(g) === target);
    if (!found) return null;
    if (found.level === "today" && (!Number.isFinite(found.expiresAt) || found.expiresAt <= this.now())) return null;
    return { ...found };
  }

  /** Evaluate whether a standing grant allows, denies, or requires asking for this request. */
  check({ botId, credentialId, destination, operation, isOwnerPrivateChat = true }) {
    const grant = this.lookup({ botId, credentialId, destination, operation });
    if (!grant) return { allowed: false, level: "ask", grant: null };
    if (grant.level === "deny") return { allowed: false, level: "deny", grant };
    // Group chats and non-owner members NEVER receive standing allow grants.
    if (!isOwnerPrivateChat) return { allowed: false, level: "ask", grant: null };
    if (grant.level === "always" || grant.level === "today") {
      return { allowed: true, level: grant.level, grant };
    }
    return { allowed: false, level: "ask", grant: null };
  }

  /**
   * Create or update a standing grant. Passing level "ask" removes any standing grant for that tuple.
   */
  setGrant({
    botId,
    botName = "",
    credentialId,
    credentialName = "",
    source = "vault",
    destination,
    destinationLabel = "",
    operation,
    level,
    expiresAt = null,
    isOwnerPrivateChat = true,
  }) {
    if (isOwnerPrivateChat === false) {
      throw new Error("Standing credential grants are only allowed in a private owner chat.");
    }
    const destKey = unwrapDestination(destination);
    if (!botId || !credentialId || !destKey || !CREDENTIAL_OPERATIONS.has(operation)) {
      throw new Error("A grant requires botId, credentialId, destination, and a valid operation.");
    }
    destination = destKey;
    if (!GRANT_LEVELS.has(level)) {
      throw new Error("Invalid grant level: " + String(level));
    }
    this.pruneExpired();
    const key = grantTupleKey({ botId, credentialId, destination, operation });
    const idx = this.grants.findIndex((g) => grantTupleKey(g) === key);

    if (level === "ask") {
      if (idx !== -1) {
        this.grants.splice(idx, 1);
        this.save();
      }
      return null;
    }

    const now = this.now();
    const resolvedExpires = level === "today" ? (Number.isFinite(expiresAt) ? expiresAt : endOfLocalDay(now)) : null;
    const next = {
      id: idx !== -1 ? this.grants[idx].id : id("cg"),
      botId: String(botId),
      botName: safeText(botName || botId, 80),
      credentialId: String(credentialId),
      credentialName: safeText(credentialName || credentialId, 120),
      source: safeText(source || "vault", 40),
      destination: String(destination),
      destinationLabel: safeText(destinationLabel || destination, 160),
      operation,
      level,
      createdAt: idx !== -1 ? this.grants[idx].createdAt : now,
      updatedAt: now,
      expiresAt: resolvedExpires,
      lastUsedAt: idx !== -1 ? this.grants[idx].lastUsedAt ?? null : null,
      useCount: idx !== -1 ? this.grants[idx].useCount ?? 0 : 0,
    };

    if (idx !== -1) this.grants[idx] = next;
    else {
      this.grants.unshift(next);
      if (this.grants.length > MAX_GRANTS) this.grants.length = MAX_GRANTS;
    }
    this.save();
    return { ...next };
  }

  /** Alias for setGrant. */
  set(input) {
    return this.setGrant(input);
  }

  /** Record that a standing grant was used (updates lastUsedAt and useCount). */
  touchGrant(grantId) {
    const found = this.grants.find((g) => g.id === grantId);
    if (!found) return;
    found.lastUsedAt = this.now();
    found.useCount = (found.useCount ?? 0) + 1;
    this.save();
  }

  markUsed(grantId) {
    return this.touchGrant(grantId);
  }

  recordUse(grantId) {
    return this.touchGrant(grantId);
  }

  /** Revoke one grant by ID (returns true if found & removed, false otherwise). */
  revoke(grantId) {
    this.pruneExpired();
    if (!grantId) {
      const count = this.grants.length;
      this.grants = [];
      this.save();
      return count > 0;
    }
    const idx = this.grants.findIndex((g) => g.id === grantId);
    if (idx === -1) return false;
    this.grants.splice(idx, 1);
    this.save();
    return true;
  }

  /** Revoke all grants associated with a deleted credential. */
  revokeForCredential(credentialId) {
    const before = this.grants.length;
    this.grants = this.grants.filter((g) => g.credentialId !== credentialId);
    if (this.grants.length !== before) this.save();
    return before - this.grants.length;
  }

  /** List active standing grants (newest / most recently used first). */
  listGrants({ botId, credentialId } = {}) {
    this.pruneExpired();
    return this.grants
      .filter((g) => (!botId || g.botId === botId) && (!credentialId || g.credentialId === credentialId))
      .map((g) => ({
        ...g,
        operationLabel: OPERATION_LABELS[g.operation] ?? g.operation,
      }));
  }

  list(filter = {}) {
    return this.listGrants(filter);
  }

  /**
   * Append an audit entry (who, what, where, when, outcome — never secret values).
   * Optional `scrubFn` scrubs any accidental secret echo from `reason`.
   */
  recordAudit({
    botId,
    botName = "",
    credentialId = "",
    credentialName = "",
    source = "vault",
    destination = "",
    operation = "",
    outcome,
    grantLevel = null,
    reason = "",
    scrubFn = null,
  }) {
    const cleanReason = reason ? safeText(scrubFn ? scrubFn(reason) : reason, 200) : "";
    const entry = {
      id: id("ca"),
      at: this.now(),
      botId: safeText(botId, 80),
      botName: safeText(botName || botId, 80),
      credentialId: safeText(credentialId, 80),
      credentialName: safeText(credentialName || credentialId, 120),
      source: safeText(source || "vault", 40),
      destination: safeText(destination, 160),
      operation: safeText(operation, 40),
      operationLabel: OPERATION_LABELS[operation] ?? safeText(operation, 40),
      outcome: safeText(outcome, 40),
      ...(grantLevel && { grantLevel: safeText(grantLevel, 20) }),
      ...(cleanReason && { reason: cleanReason }),
    };
    this.auditEntries.push(entry);
    if (this.auditEntries.length > MAX_AUDIT) this.auditEntries.splice(0, this.auditEntries.length - MAX_AUDIT);
    this.save();
    return { ...entry };
  }

  /** Return recent audit entries, newest first. */
  listAudit({ limit = 100, botId, credentialId } = {}) {
    const cap = Math.max(1, Math.min(Number(limit) || 100, MAX_AUDIT));
    return this.auditEntries
      .filter((a) => (!botId || a.botId === botId) && (!credentialId || a.credentialId === credentialId))
      .slice(-cap)
      .reverse()
      .map((a) => ({ ...a }));
  }

  audit(options = {}) {
    return this.listAudit(options);
  }

  /**
   * Check per-bot rate limit before executing or prompting.
   * Returns `{ ok: true, allowed: true }` or `{ ok: false, allowed: false, retryAfterMs, reason }`.
   */
  checkRateLimit(botId) {
    const key = String(botId || "unknown");
    const t = this.now();
    const cutoff = t - this.rateWindowMs;
    let bucket = this.rateBuckets.get(key);
    if (!bucket) {
      bucket = { uses: [], failures: [] };
      this.rateBuckets.set(key, bucket);
    }
    bucket.uses = bucket.uses.filter((ts) => ts > cutoff);
    bucket.failures = bucket.failures.filter((ts) => ts > cutoff);
    if (bucket.failures.length >= this.maxFailuresPerWindow) {
      const retryAfterMs = Math.max(1000, this.rateWindowMs - (t - bucket.failures[0]));
      return { ok: false, allowed: false, retryAfterMs, reason: "Too many denied or failed credential attempts for this bot. Wait a minute before trying again." };
    }
    if (bucket.uses.length >= this.maxUsesPerWindow) {
      const retryAfterMs = Math.max(1000, this.rateWindowMs - (t - bucket.uses[0]));
      return { ok: false, allowed: false, retryAfterMs, reason: "Credential rate limit reached for this bot. Wait a minute before trying again." };
    }
    bucket.uses.push(t);
    return { ok: true, allowed: true };
  }

  /** Record a failed/denied attempt in the rate limiter bucket. */
  recordRateFailure(botId) {
    const key = String(botId || "unknown");
    const t = this.now();
    const cutoff = t - this.rateWindowMs;
    let bucket = this.rateBuckets.get(key);
    if (!bucket) {
      bucket = { uses: [], failures: [] };
      this.rateBuckets.set(key, bucket);
    }
    bucket.failures = bucket.failures.filter((ts) => ts > cutoff);
    bucket.failures.push(t);
  }
}
