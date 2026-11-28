// GitHub App ("Botkins Agent") webhook ingress, installation binding (OAuth setup),
// per-repo installation token minting, team delivery claim locks, and payload trimming.
//
// No Cloudflare imports here so Node (self-hosted relay + unit tests) loads this file as-is.

import { MAX_SKEW, base64url, hex, roomOf, verifyEd25519 } from "./pure.ts";
import { BASE64URL_43, readCappedBytes, securePage, PAGE_CSS } from "./shared.ts";
import { appJwt } from "./feedback.ts";

export const GITHUB_EVENTS_PATH = "/v1/github/events";
export const GITHUB_SETUP_PATH = "/v1/github/setup";
export const GITHUB_AGENT_SLUG_DEFAULT = "botkins-agent";
export const GITHUB_DELIVERY_BODY_BYTES_LIMIT = 512 * 1024; // 512 KiB
export const GITHUB_ROUTE_REPOSITORIES_LIMIT = 100;
export const GITHUB_ROUTE_TTL_SECONDS = 300;
export const GITHUB_ROUTE_TTL_MS = GITHUB_ROUTE_TTL_SECONDS * 1000;
export const GITHUB_SETUP_STATE_TTL_SECONDS = 600; // 10 minutes
export const GITHUB_SETUP_STATE_TTL_MS = GITHUB_SETUP_STATE_TTL_SECONDS * 1000;
export const GITHUB_DELIVERY_DEDUPE_TTL_MS = 10 * 60_000;
export const GITHUB_DELIVERY_DEDUPE_MAX = 4096;
export const GITHUB_CLAIM_TTL_MS = 10 * 60_000;
export const GITHUB_CLAIM_MAX = 4096;
export const GITHUB_NONCE_TTL_MS = 15 * 60_000;
export const GITHUB_NONCE_MAX = 4096;
export const GITHUB_API_BASE_DEFAULT = "https://api.github.com";
export const GITHUB_WEB_BASE_DEFAULT = "https://github.com";
export const GITHUB_AUTH_CHECK_TIMEOUT_MS = 8_000;
export const GITHUB_OAUTH_TIMEOUT_MS = 10_000;
export const GITHUB_AUTH_TOKEN_MAX_LEN = 512;
export const GITHUB_AUTH_CONCURRENCY = 6;

export const GITHUB_RAW_WEBHOOK_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_suite",
  "status",
  "push",
  "installation",
  "installation_repositories",
] as const;

export const GITHUB_RAW_WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set(GITHUB_RAW_WEBHOOK_EVENTS);

export const GITHUB_EVENT_NAME_RE = /^[a-z_]{1,64}$/;
export const GITHUB_DELIVERY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const GITHUB_SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/i;
export const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
export const GITHUB_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const GITHUB_SIG_RE = /^[A-Za-z0-9_-]{86}$/;
export const GITHUB_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/i;

export const GITHUB_SUBSCRIBE_PREFIX = "botkins-github-sub-v1:";
export const GITHUB_SETUP_STATE_PREFIX = "botkins-github-setup-v1:";
export const GITHUB_TOKEN_REQ_PREFIX = "botkins-github-token-v1:";
export const GITHUB_CLAIM_PREFIX = "botkins-github-claim-v1:";
export const GITHUB_INSTALLATIONS_REQ_PREFIX = "botkins-github-installs-v1:";
export const GITHUB_UNBIND_PREFIX = "botkins-github-unbind-v1:";

/** Permissions requested when minting a single-repository installation token for a host. */
export const GITHUB_ALLOWED_TOKEN_PERMISSIONS = [
  "issues",
  "pull_requests",
  "contents",
  "checks",
  "statuses",
  "metadata",
] as const;

export type GitHubTokenPermissionKey = (typeof GITHUB_ALLOWED_TOKEN_PERMISSIONS)[number];
export type GitHubTokenPermissionLevel = "read" | "write";

const MAX_PERMISSION_LEVEL: Record<GitHubTokenPermissionKey, GitHubTokenPermissionLevel> = {
  issues: "write",
  pull_requests: "write",
  contents: "write",
  checks: "read",
  statuses: "read",
  metadata: "read",
};

const DEFAULT_TOKEN_PERMISSIONS: Record<string, GitHubTokenPermissionLevel> = {
  issues: "write",
  pull_requests: "write",
  metadata: "read",
};

const textEnc = new TextEncoder();

export interface GitHubAgentAppConfig {
  appId: string;
  appSlug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

export interface GitHubSetupStatePayload {
  v: 1;
  key: string;
  room: string;
  nonce: string;
  exp: number;
  sig: string;
}

export interface GitHubInstallationBinding {
  installationId: number;
  accountLogin: string;
  accountType: string;
  installerLogin: string;
  repositorySelection: "all" | "selected";
  repos: string[];
  suspended: boolean;
  updatedAt: number;
}

export interface GitHubSubscribeMessage {
  type: "github-subscribe";
  v: 1;
  key: string;
  time: number;
  exp: number;
  repos: string[];
  sig: string;
  /** Legacy self-hosted fallback only (when GITHUB_ALLOW_USER_TOKEN_AUTH=1 and no App credentials). */
  githubToken?: string;
  repoTokens?: Record<string, string>;
}

export interface GitHubSubscribeVerified {
  ok: true;
  repos: string[];
  expiresAt: number;
  /** Ephemeral per-repo read proofs (only used when legacy self-hosted user-token mode is explicitly enabled). */
  proofs: Record<string, string>;
}

export interface GitHubRepoAuthResult {
  allowed: string[];
  denied: string[];
}

export interface GitHubDeliveryFrame {
  type: "github-delivery";
  version: 1;
  deliveryId: string;
  event: string;
  action: string | null;
  repository: string;
  installationId: number | null;
  receivedAt: string;
  payload: Record<string, unknown>;
}

export interface GitHubInstallationSyncFrame {
  type: "github-installations";
  version: 1;
  appSlug: string;
  installations: Array<{
    installationId: number;
    accountLogin: string;
    accountType: string;
    installerLogin: string;
    repositorySelection: "all" | "selected";
    repos: string[];
    suspended: boolean;
    updatedAt: number;
  }>;
}

export interface GitHubTokenRequestVerified {
  ok: true;
  requestId: string;
  repo: string;
  permissions: Record<string, GitHubTokenPermissionLevel>;
}

export interface GitHubClaimRequestVerified {
  ok: true;
  requestId: string;
  deliveryId: string;
}

export interface GitHubUnbindRequestVerified {
  ok: true;
  requestId: string;
  installationId: number;
}

/** Reads Botkins Agent GitHub App configuration from Worker or Node env. Never reuses GITHUB_APP_* (Intake). */
export function agentAppOf(env: {
  GITHUB_AGENT_APP_ID?: string;
  GITHUB_AGENT_APP_SLUG?: string;
  GITHUB_AGENT_APP_KEY?: string;
  GITHUB_AGENT_CLIENT_ID?: string;
  GITHUB_AGENT_CLIENT_SECRET?: string;
}): GitHubAgentAppConfig | null {
  const appId = typeof env.GITHUB_AGENT_APP_ID === "string" ? env.GITHUB_AGENT_APP_ID.trim() : "";
  const rawSlug = typeof env.GITHUB_AGENT_APP_SLUG === "string" ? env.GITHUB_AGENT_APP_SLUG.trim() : "";
  const appSlug = rawSlug && GITHUB_SLUG_RE.test(rawSlug) ? rawSlug.toLowerCase() : GITHUB_AGENT_SLUG_DEFAULT;
  const privateKey = typeof env.GITHUB_AGENT_APP_KEY === "string" ? env.GITHUB_AGENT_APP_KEY : "";
  const clientId = typeof env.GITHUB_AGENT_CLIENT_ID === "string" ? env.GITHUB_AGENT_CLIENT_ID.trim() : "";
  const clientSecret = typeof env.GITHUB_AGENT_CLIENT_SECRET === "string" ? env.GITHUB_AGENT_CLIENT_SECRET.trim() : "";
  if (!/^\d{1,12}$/.test(appId) || !privateKey.trim() || !clientId || !clientSecret) return null;
  return { appId, appSlug, privateKey, clientId, clientSecret };
}

/** Reads whether legacy user-token repo verification is explicitly enabled (self-hosted relays without App creds). */
export function allowsLegacyUserTokenAuth(env: {
  GITHUB_ALLOW_USER_TOKEN_AUTH?: string;
  GITHUB_AGENT_APP_ID?: string;
  GITHUB_AGENT_APP_KEY?: string;
  GITHUB_AGENT_CLIENT_ID?: string;
  GITHUB_AGENT_CLIENT_SECRET?: string;
}): boolean {
  const flag = String(env.GITHUB_ALLOW_USER_TOKEN_AUTH ?? "").trim().toLowerCase();
  if (flag !== "1" && flag !== "true" && flag !== "yes") return false;
  return agentAppOf(env) === null;
}

/** Constant-time byte array equality (always scans full length when lengths match). */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Computes `sha256=<lowercase hex>` HMAC-SHA256 for GitHub webhook signatures. */
export async function signGitHubWebhook(secret: string, rawBody: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEnc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const body = new Uint8Array(rawBody.byteLength);
  body.set(rawBody);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return "sha256=" + hex(mac);
}

/** Verifies `x-hub-signature-256` against `rawBody` using constant-time comparison. */
export async function verifyGitHubSignature(secret: string, rawBody: Uint8Array, signatureHeader: string | null): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const trimmed = signatureHeader.trim();
  if (!GITHUB_SIGNATURE_RE.test(trimmed)) return false;
  const expected = await signGitHubWebhook(secret, rawBody);
  return constantTimeEqualBytes(textEnc.encode(expected), textEnc.encode(trimmed.toLowerCase()));
}

/** Normalizes, lowercases, deduplicates, sorts, and caps up to 100 `owner/repo` names. */
export function normalizeSubscribedRepos(rawRepos: unknown): string[] | null {
  if (!Array.isArray(rawRepos)) return null;
  if (rawRepos.length > GITHUB_ROUTE_REPOSITORIES_LIMIT) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawRepos) {
    if (typeof item !== "string") return null;
    const cleaned = item.trim();
    if (!GITHUB_REPO_RE.test(cleaned)) return null;
    const lower = cleaned.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  out.sort();
  return out;
}

/** Normalizes a repo list from GitHub installation payloads (ignores invalid entries, no 100 cap). */
export function normalizeInstallationRepos(rawRepos: unknown): string[] {
  if (!Array.isArray(rawRepos)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawRepos) {
    const rawName = typeof item === "string" ? item : (item && typeof item === "object" ? (item as Record<string, unknown>).full_name : "");
    if (typeof rawName !== "string") continue;
    const cleaned = rawName.trim().toLowerCase();
    if (!GITHUB_REPO_RE.test(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  out.sort();
  return out;
}

/** Canonical signing string for host GitHub subscription messages. */
export function githubSubscribeChallenge(room: string, time: number, exp: number, repos: string[]): string {
  return `${GITHUB_SUBSCRIBE_PREFIX}${room}:${time}:${exp}:${repos.join(",")}`;
}

/** Canonical signing string for the GitHub App installation OAuth `state` parameter. */
export function githubSetupStateChallenge(room: string, nonce: string, exp: number): string {
  return `${GITHUB_SETUP_STATE_PREFIX}${room}:${nonce}:${exp}`;
}

/** Canonical signing string for a host WebSocket installation token request. */
export function githubTokenRequestChallenge(room: string, requestId: string, repo: string, time: number, permissionsKey: string): string {
  return `${GITHUB_TOKEN_REQ_PREFIX}${room}:${requestId}:${repo}:${time}:${permissionsKey}`;
}

/** Canonical signing string for a host WebSocket delivery claim lock request. */
export function githubClaimChallenge(room: string, requestId: string, deliveryId: string, time: number): string {
  return `${GITHUB_CLAIM_PREFIX}${room}:${requestId}:${deliveryId}:${time}`;
}

/** Canonical signing string for listing a room's bound installations over WebSocket. */
export function githubInstallationsChallenge(room: string, requestId: string, time: number): string {
  return `${GITHUB_INSTALLATIONS_REQ_PREFIX}${room}:${requestId}:${time}`;
}

/** Canonical signing string for unbinding an installation from a room over WebSocket. */
export function githubUnbindChallenge(room: string, requestId: string, installationId: number, time: number): string {
  return `${GITHUB_UNBIND_PREFIX}${room}:${requestId}:${installationId}:${time}`;
}

function decodeBase64UrlText(raw: string): string | null {
  if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const padded = raw.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (raw.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Encodes a signed GitHub setup state object into a compact base64url string safe for `?state=`. */
export function encodeGitHubSetupState(payload: GitHubSetupStatePayload): string {
  return base64url(textEnc.encode(JSON.stringify(payload)));
}

/**
 * Decodes and cryptographically verifies the `state` query parameter returned to `GET /v1/github/setup`.
 * Requires valid Ed25519 signature over `githubSetupStateChallenge(room, nonce, exp)`, matching `roomOf(key)`,
 * valid nonce, and `nowSec < exp <= nowSec + 630`.
 */
export async function verifyGitHubSetupState(
  rawState: string | null | undefined,
  nowMs = Date.now(),
): Promise<{ ok: true; room: string; key: string; nonce: string; exp: number } | { ok: false; error: string }> {
  if (typeof rawState !== "string" || !rawState.trim()) return { ok: false, error: "missing_state" };
  const decoded = decodeBase64UrlText(rawState.trim());
  if (!decoded) return { ok: false, error: "bad_state" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "bad_state" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "bad_state" };
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== 1) return { ok: false, error: "bad_state" };
  const key = typeof rec.key === "string" ? rec.key : "";
  const room = typeof rec.room === "string" ? rec.room : "";
  const nonce = typeof rec.nonce === "string" ? rec.nonce : "";
  const sig = typeof rec.sig === "string" ? rec.sig : "";
  const exp = typeof rec.exp === "number" ? rec.exp : NaN;
  if (!BASE64URL_43.test(key) || !BASE64URL_43.test(room) || !GITHUB_NONCE_RE.test(nonce) || !GITHUB_SIG_RE.test(sig)) {
    return { ok: false, error: "bad_state" };
  }
  if (!Number.isSafeInteger(exp)) return { ok: false, error: "bad_state" };

  const nowSec = Math.floor(nowMs / 1000);
  if (exp <= nowSec) return { ok: false, error: "expired_state" };
  if (exp > nowSec + GITHUB_SETUP_STATE_TTL_SECONDS + 60) return { ok: false, error: "bad_exp" };

  if ((await roomOf(key)) !== room) return { ok: false, error: "wrong_room" };
  const challenge = githubSetupStateChallenge(room, nonce, exp);
  if (!(await verifyEd25519(key, sig, challenge))) return { ok: false, error: "bad_sig" };

  return { ok: true, room, key, nonce, exp };
}

/** Normalizes and clamps requested installation token permissions against the App's safe ceiling. */
export function normalizeTokenPermissions(raw: unknown): { permissions: Record<string, GitHubTokenPermissionLevel>; key: string } | null {
  if (raw === undefined || raw === null) {
    const sorted = Object.entries(DEFAULT_TOKEN_PERMISSIONS).sort(([a], [b]) => a.localeCompare(b));
    return {
      permissions: Object.fromEntries(sorted),
      key: sorted.map(([k, v]) => `${k}=${v}`).join(","),
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries: Array<[string, GitHubTokenPermissionLevel]> = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(MAX_PERMISSION_LEVEL, k)) return null;
    if (v !== "read" && v !== "write") return null;
    const maxLevel = MAX_PERMISSION_LEVEL[k as GitHubTokenPermissionKey];
    if (v === "write" && maxLevel !== "write") return null;
    entries.push([k, v]);
  }
  if (!entries.length) {
    return normalizeTokenPermissions(undefined);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  return {
    permissions: Object.fromEntries(entries),
    key: entries.map(([k, v]) => `${k}=${v}`).join(","),
  };
}

function cleanProofToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > GITHUB_AUTH_TOKEN_MAX_LEN) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parses and verifies a host's `github-subscribe` JSON control message.
 */
export async function verifyGitHubSubscribe(
  rawText: string,
  expectedRoom: string,
  nowMs = Date.now(),
): Promise<GitHubSubscribeVerified | { ok: false; error: string }> {
  let msg: unknown;
  try {
    msg = JSON.parse(rawText);
  } catch {
    return { ok: false, error: "bad_json" };
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { ok: false, error: "bad_shape" };
  const rec = msg as Record<string, unknown>;
  if (rec.type !== "github-subscribe" || rec.v !== 1) return { ok: false, error: "bad_type" };
  const key = typeof rec.key === "string" ? rec.key : "";
  const sig = typeof rec.sig === "string" ? rec.sig : "";
  const time = typeof rec.time === "number" ? rec.time : NaN;
  const exp = typeof rec.exp === "number" ? rec.exp : NaN;
  if (!BASE64URL_43.test(key) || !GITHUB_SIG_RE.test(sig)) return { ok: false, error: "bad_key" };
  if (!Number.isSafeInteger(time) || !Number.isSafeInteger(exp)) return { ok: false, error: "bad_time" };

  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - time) > MAX_SKEW) return { ok: false, error: "stale_time" };
  if (exp <= nowSec || exp - time > GITHUB_ROUTE_TTL_SECONDS + 30) return { ok: false, error: "bad_exp" };

  const repos = normalizeSubscribedRepos(rec.repos);
  if (repos === null) return { ok: false, error: "bad_repos" };

  if ((await roomOf(key)) !== expectedRoom) return { ok: false, error: "wrong_room" };
  const challenge = githubSubscribeChallenge(expectedRoom, time, exp, repos);
  if (!(await verifyEd25519(key, sig, challenge))) return { ok: false, error: "bad_sig" };

  const sharedToken = cleanProofToken(rec.githubToken);
  const rawRepoTokens =
    rec.repoTokens && typeof rec.repoTokens === "object" && !Array.isArray(rec.repoTokens)
      ? (rec.repoTokens as Record<string, unknown>)
      : null;
  const proofs: Record<string, string> = {};
  if (rawRepoTokens) {
    for (const [k, v] of Object.entries(rawRepoTokens)) {
      const repoLow = k.trim().toLowerCase();
      const tok = cleanProofToken(v);
      if (tok && GITHUB_REPO_RE.test(repoLow)) proofs[repoLow] = tok;
    }
  }
  if (sharedToken) {
    for (const repo of repos) {
      if (!proofs[repo]) proofs[repo] = sharedToken;
    }
  }

  return { ok: true, repos, expiresAt: exp * 1000, proofs };
}

/** Verifies a host WebSocket `github-token` request asking for a single-repository installation token. */
export async function verifyGitHubTokenRequest(
  rec: Record<string, unknown>,
  expectedRoom: string,
  nowMs = Date.now(),
): Promise<GitHubTokenRequestVerified | { ok: false; error: string }> {
  if (rec.type !== "github-token" || rec.v !== 1) return { ok: false, error: "bad_type" };
  const requestId = typeof rec.requestId === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(rec.requestId) ? rec.requestId : "";
  const key = typeof rec.key === "string" ? rec.key : "";
  const sig = typeof rec.sig === "string" ? rec.sig : "";
  const time = typeof rec.time === "number" ? rec.time : NaN;
  const rawRepo = typeof rec.repo === "string" ? rec.repo.trim().toLowerCase() : "";
  if (!requestId || !BASE64URL_43.test(key) || !GITHUB_SIG_RE.test(sig) || !GITHUB_REPO_RE.test(rawRepo)) {
    return { ok: false, error: "bad_request" };
  }
  if (!Number.isSafeInteger(time)) return { ok: false, error: "bad_time" };
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - time) > MAX_SKEW) return { ok: false, error: "stale_time" };
  const perm = normalizeTokenPermissions(rec.permissions);
  if (!perm) return { ok: false, error: "bad_permissions" };
  if ((await roomOf(key)) !== expectedRoom) return { ok: false, error: "wrong_room" };
  const challenge = githubTokenRequestChallenge(expectedRoom, requestId, rawRepo, time, perm.key);
  if (!(await verifyEd25519(key, sig, challenge))) return { ok: false, error: "bad_sig" };
  return { ok: true, requestId, repo: rawRepo, permissions: perm.permissions };
}

/** Verifies a host WebSocket `github-claim` request for exclusive per-delivery mention handling in teams. */
export async function verifyGitHubClaimRequest(
  rec: Record<string, unknown>,
  expectedRoom: string,
  nowMs = Date.now(),
): Promise<GitHubClaimRequestVerified | { ok: false; error: string }> {
  if (rec.type !== "github-claim" || rec.v !== 1) return { ok: false, error: "bad_type" };
  const requestId = typeof rec.requestId === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(rec.requestId) ? rec.requestId : "";
  const deliveryId = typeof rec.deliveryId === "string" && GITHUB_DELIVERY_ID_RE.test(rec.deliveryId.trim()) ? rec.deliveryId.trim() : "";
  const key = typeof rec.key === "string" ? rec.key : "";
  const sig = typeof rec.sig === "string" ? rec.sig : "";
  const time = typeof rec.time === "number" ? rec.time : NaN;
  if (!requestId || !deliveryId || !BASE64URL_43.test(key) || !GITHUB_SIG_RE.test(sig)) {
    return { ok: false, error: "bad_request" };
  }
  if (!Number.isSafeInteger(time)) return { ok: false, error: "bad_time" };
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - time) > MAX_SKEW) return { ok: false, error: "stale_time" };
  if ((await roomOf(key)) !== expectedRoom) return { ok: false, error: "wrong_room" };
  const challenge = githubClaimChallenge(expectedRoom, requestId, deliveryId, time);
  if (!(await verifyEd25519(key, sig, challenge))) return { ok: false, error: "bad_sig" };
  return { ok: true, requestId, deliveryId };
}

/** Verifies a host WebSocket `github-installations-list` request. */
export async function verifyGitHubInstallationsListRequest(
  rec: Record<string, unknown>,
  expectedRoom: string,
  nowMs = Date.now(),
): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  if (rec.type !== "github-installations-list" || rec.v !== 1) return { ok: false, error: "bad_type" };
  const requestId = typeof rec.requestId === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(rec.requestId) ? rec.requestId : "";
  const key = typeof rec.key === "string" ? rec.key : "";
  const sig = typeof rec.sig === "string" ? rec.sig : "";
  const time = typeof rec.time === "number" ? rec.time : NaN;
  if (!requestId || !BASE64URL_43.test(key) || !GITHUB_SIG_RE.test(sig)) return { ok: false, error: "bad_request" };
  if (!Number.isSafeInteger(time)) return { ok: false, error: "bad_time" };
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - time) > MAX_SKEW) return { ok: false, error: "stale_time" };
  if ((await roomOf(key)) !== expectedRoom) return { ok: false, error: "wrong_room" };
  const challenge = githubInstallationsChallenge(expectedRoom, requestId, time);
  if (!(await verifyEd25519(key, sig, challenge))) return { ok: false, error: "bad_sig" };
  return { ok: true, requestId };
}

/** Verifies a host WebSocket `github-unbind` request. */
export async function verifyGitHubUnbindRequest(
  rec: Record<string, unknown>,
  expectedRoom: string,
  nowMs = Date.now(),
): Promise<GitHubUnbindRequestVerified | { ok: false; error: string }> {
  if (rec.type !== "github-unbind" || rec.v !== 1) return { ok: false, error: "bad_type" };
  const requestId = typeof rec.requestId === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(rec.requestId) ? rec.requestId : "";
  const installationId = typeof rec.installationId === "number" && Number.isSafeInteger(rec.installationId) && rec.installationId > 0 ? rec.installationId : 0;
  const key = typeof rec.key === "string" ? rec.key : "";
  const sig = typeof rec.sig === "string" ? rec.sig : "";
  const time = typeof rec.time === "number" ? rec.time : NaN;
  if (!requestId || !installationId || !BASE64URL_43.test(key) || !GITHUB_SIG_RE.test(sig)) return { ok: false, error: "bad_request" };
  if (!Number.isSafeInteger(time)) return { ok: false, error: "bad_time" };
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - time) > MAX_SKEW) return { ok: false, error: "stale_time" };
  if ((await roomOf(key)) !== expectedRoom) return { ok: false, error: "wrong_room" };
  const challenge = githubUnbindChallenge(expectedRoom, requestId, installationId, time);
  if (!(await verifyEd25519(key, sig, challenge))) return { ok: false, error: "bad_sig" };
  return { ok: true, requestId, installationId };
}

function githubApiHeaders(authHeader: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: authHeader,
    "user-agent": "botkins-relay",
    "x-github-api-version": "2022-11-28",
  };
}

/**
 * Exchanges the GitHub App installation OAuth `code` for a one-time user token, confirms that
 * `installationId` appears in `GET /user/installations` for that user, resolves the user's login
 * and the installation's repository list, and discards the user token immediately.
 */
export async function verifyGitHubInstallationOAuth(
  app: GitHubAgentAppConfig,
  code: string,
  installationId: number,
  options: { fetch?: typeof fetch; apiBase?: string; webBase?: string } = {},
): Promise<
  | {
      ok: true;
      installation: GitHubInstallationBinding;
    }
  | { ok: false; error: string; status: number }
> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase || GITHUB_API_BASE_DEFAULT).replace(/\/+$/, "");
  const webBase = (options.webBase || GITHUB_WEB_BASE_DEFAULT).replace(/\/+$/, "");

  // 1. Exchange code for a short-lived user access token (never stored or logged).
  let userToken = "";
  try {
    const tokenRes = await fetcher(`${webBase}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "botkins-relay",
      },
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
      }),
      signal: AbortSignal.timeout(GITHUB_OAUTH_TIMEOUT_MS),
    });
    if (!tokenRes.ok) return { ok: false, error: "oauth_exchange_failed", status: 502 };
    const tokenBody = (await tokenRes.json().catch(() => null)) as Record<string, unknown> | null;
    if (!tokenBody || typeof tokenBody.access_token !== "string" || !tokenBody.access_token.trim()) {
      return { ok: false, error: "oauth_exchange_rejected", status: 401 };
    }
    userToken = tokenBody.access_token.trim();
  } catch {
    return { ok: false, error: "oauth_exchange_unreachable", status: 502 };
  }

  // 2. Confirm installationId appears in GET /user/installations for that user (paginated up to 5 pages).
  let matchedInst: Record<string, unknown> | null = null;
  try {
    for (let page = 1; page <= 5; page++) {
      const instRes = await fetcher(`${apiBase}/user/installations?per_page=100&page=${page}`, {
        method: "GET",
        headers: githubApiHeaders(`Bearer ${userToken}`),
        signal: AbortSignal.timeout(GITHUB_OAUTH_TIMEOUT_MS),
      });
      if (!instRes.ok) {
        return { ok: false, error: "user_installations_failed", status: instRes.status === 401 ? 401 : 502 };
      }
      const data = (await instRes.json().catch(() => null)) as { installations?: unknown[] } | null;
      const list = Array.isArray(data?.installations) ? data.installations : [];
      for (const entry of list) {
        if (entry && typeof entry === "object" && Number((entry as Record<string, unknown>).id) === installationId) {
          matchedInst = entry as Record<string, unknown>;
          break;
        }
      }
      if (matchedInst || list.length < 100) break;
    }
  } catch {
    return { ok: false, error: "user_installations_unreachable", status: 502 };
  }

  if (!matchedInst) {
    return { ok: false, error: "installation_not_authorized", status: 403 };
  }

  const instAppId = matchedInst.app_id;
  if (instAppId !== undefined && String(instAppId) !== app.appId) {
    return { ok: false, error: "wrong_app", status: 403 };
  }

  // 3. Read installer login and accessible repositories for this installation, then discard userToken.
  let installerLogin = "";
  try {
    const userRes = await fetcher(`${apiBase}/user`, {
      method: "GET",
      headers: githubApiHeaders(`Bearer ${userToken}`),
      signal: AbortSignal.timeout(GITHUB_OAUTH_TIMEOUT_MS),
    });
    if (userRes.ok) {
      const u = (await userRes.json().catch(() => null)) as Record<string, unknown> | null;
      if (typeof u?.login === "string") installerLogin = u.login.trim();
    }
  } catch {}

  const repos: string[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const repoRes = await fetcher(
        `${apiBase}/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
        {
          method: "GET",
          headers: githubApiHeaders(`Bearer ${userToken}`),
          signal: AbortSignal.timeout(GITHUB_OAUTH_TIMEOUT_MS),
        },
      );
      if (!repoRes.ok) break;
      const data = (await repoRes.json().catch(() => null)) as { repositories?: unknown[] } | null;
      const list = Array.isArray(data?.repositories) ? data.repositories : [];
      for (const r of list) {
        if (r && typeof r === "object" && typeof (r as Record<string, unknown>).full_name === "string") {
          repos.push((r as Record<string, unknown>).full_name as string);
        }
      }
      if (list.length < 100) break;
    }
  } catch {}

  // Discard userToken — do not return or log it.
  userToken = "";

  const account = matchedInst.account && typeof matchedInst.account === "object"
    ? (matchedInst.account as Record<string, unknown>)
    : {};
  const accountLogin = typeof account.login === "string" ? account.login.trim() : installerLogin;
  const accountType = typeof account.type === "string" ? account.type.trim() : "User";
  const repositorySelection = matchedInst.repository_selection === "all" ? "all" : "selected";
  const suspended = Boolean(matchedInst.suspended_at);

  return {
    ok: true,
    installation: {
      installationId,
      accountLogin,
      accountType,
      installerLogin: installerLogin || accountLogin,
      repositorySelection,
      repos: normalizeInstallationRepos(repos),
      suspended,
      updatedAt: Date.now(),
    },
  };
}

/**
 * Mints a GitHub App installation access token scoped strictly to ONE repository (`repoShortName`)
 * and the minimal validated `permissions`. Never logs or caches the token on disk.
 */
export async function mintSingleRepoInstallationToken(
  app: Pick<GitHubAgentAppConfig, "appId" | "privateKey">,
  installationId: number,
  repoFullName: string,
  permissions: Record<string, GitHubTokenPermissionLevel>,
  options: { fetch?: typeof fetch; apiBase?: string; nowMs?: number } = {},
): Promise<{ ok: true; token: string; expiresAt: string; permissions: Record<string, string> } | { ok: false; error: string; status: number }> {
  const cleanRepo = repoFullName.trim().toLowerCase();
  if (!GITHUB_REPO_RE.test(cleanRepo)) return { ok: false, error: "bad_repo", status: 400 };
  const slash = cleanRepo.indexOf("/");
  const repoShortName = cleanRepo.slice(slash + 1);
  if (!repoShortName) return { ok: false, error: "bad_repo", status: 400 };

  const jwt = await appJwt(app.appId, app.privateKey, options.nowMs ?? Date.now());
  if (!jwt) return { ok: false, error: "app_key_invalid", status: 500 };

  const fetcher = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase || GITHUB_API_BASE_DEFAULT).replace(/\/+$/, "");

  try {
    const res = await fetcher(`${apiBase}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        ...githubApiHeaders(`Bearer ${jwt}`),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repositories: [repoShortName],
        permissions,
      }),
      signal: AbortSignal.timeout(GITHUB_OAUTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: res.status === 404 || res.status === 422 ? "repo_not_in_installation" : "github_token_failed", status: res.status };
    }
    const body = (await res.json().catch(() => null)) as {
      token?: string;
      expires_at?: string;
      permissions?: Record<string, string>;
    } | null;
    if (!body || typeof body.token !== "string" || !body.token.trim()) {
      return { ok: false, error: "github_token_invalid", status: 502 };
    }
    const expiresAt = typeof body.expires_at === "string" && body.expires_at
      ? body.expires_at
      : new Date((options.nowMs ?? Date.now()) + 55 * 60_000).toISOString();
    return {
      ok: true,
      token: body.token.trim(),
      expiresAt,
      permissions: body.permissions && typeof body.permissions === "object" ? body.permissions : permissions,
    };
  } catch {
    return { ok: false, error: "github_unreachable", status: 502 };
  }
}

/** Fetches the full repo list for an installation using the App JWT (used on `installation.created` when selection=all). */
export async function fetchInstallationRepos(
  app: Pick<GitHubAgentAppConfig, "appId" | "privateKey">,
  installationId: number,
  options: { fetch?: typeof fetch; apiBase?: string } = {},
): Promise<string[]> {
  const jwt = await appJwt(app.appId, app.privateKey);
  if (!jwt) return [];
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase || GITHUB_API_BASE_DEFAULT).replace(/\/+$/, "");
  try {
    const tokenRes = await fetcher(`${apiBase}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { ...githubApiHeaders(`Bearer ${jwt}`), "content-type": "application/json" },
      body: JSON.stringify({ permissions: { metadata: "read" } }),
      signal: AbortSignal.timeout(GITHUB_OAUTH_TIMEOUT_MS),
    });
    if (!tokenRes.ok) return [];
    const tokenBody = (await tokenRes.json().catch(() => null)) as { token?: string } | null;
    const tok = typeof tokenBody?.token === "string" ? tokenBody.token.trim() : "";
    if (!tok) return [];
    const out: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const repoRes = await fetcher(`${apiBase}/installation/repositories?per_page=100&page=${page}`, {
        method: "GET",
        headers: githubApiHeaders(`Bearer ${tok}`),
        signal: AbortSignal.timeout(GITHUB_OAUTH_TIMEOUT_MS),
      });
      if (!repoRes.ok) break;
      const data = (await repoRes.json().catch(() => null)) as { repositories?: unknown[] } | null;
      const list = Array.isArray(data?.repositories) ? data.repositories : [];
      for (const r of list) {
        if (r && typeof r === "object" && typeof (r as Record<string, unknown>).full_name === "string") {
          out.push((r as Record<string, unknown>).full_name as string);
        }
      }
      if (list.length < 100) break;
    }
    return normalizeInstallationRepos(out);
  } catch {
    return [];
  }
}

/** Renders the post-install browser confirmation / error HTML page for `GET /v1/github/setup`. */
export function githubSetupResultPage(result: { ok: boolean; accountLogin?: string; repoCount?: number; message?: string }): Response {
  const title = result.ok ? "Botkins Agent connected" : "GitHub setup could not finish";
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const bodyHtml = result.ok
    ? `  <main>
    <h1>Botkins Agent connected</h1>
    <p class="intro">${esc(result.accountLogin ? `Connected ${result.accountLogin} (${result.repoCount ?? 0} ${result.repoCount === 1 ? "repository" : "repositories"}).` : "Your GitHub installation is now linked to your Botkins host.")}</p>
    <p class="help">You can close this tab and return to Botkins Settings &rsaquo; GitHub.</p>
    <a class="button" href="botkins://settings/github">Open Botkins</a>
  </main>`
    : `  <main>
    <h1>GitHub setup could not finish</h1>
    <p class="error">${esc(result.message || "The setup link is invalid or expired. Start again from Botkins Settings › GitHub.")}</p>
    <p class="help">Nothing was saved. Return to Botkins and try installing again.</p>
  </main>`;
  const page = securePage(title, PAGE_CSS, bodyHtml, "");
  return new Response(page.body, {
    status: result.ok ? 200 : 400,
    headers: page.headers,
  });
}

/**
 * Legacy self-hosted-only check (gated behind explicit GITHUB_ALLOW_USER_TOKEN_AUTH=1 when no App creds exist).
 */
export async function checkGitHubRepoAccess(
  repo: string,
  proofToken: string | undefined,
  options: { fetch?: typeof fetch; apiBase?: string } = {},
): Promise<boolean> {
  const cleanRepo = String(repo || "").trim().toLowerCase();
  if (!GITHUB_REPO_RE.test(cleanRepo)) return false;
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = (options.apiBase || GITHUB_API_BASE_DEFAULT).replace(/\/+$/, "");
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "botkins-relay",
    "x-github-api-version": "2022-11-28",
  };
  const tok = cleanProofToken(proofToken);
  if (tok) headers.authorization = `Bearer ${tok}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_AUTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetcher(`${base}/repos/${cleanRepo}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (res.status !== 200) return false;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const fullName = typeof body.full_name === "string" ? body.full_name.trim().toLowerCase() : "";
    const isPublic = body.private === false;
    const perms = body.permissions && typeof body.permissions === "object" && !Array.isArray(body.permissions)
      ? (body.permissions as Record<string, unknown>)
      : null;
    const hasPull = perms?.pull === true;
    if (fullName && fullName !== cleanRepo && !hasPull) return false;
    if (isPublic) return true;
    return Boolean(tok && hasPull);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Legacy self-hosted-only batch repo verifier (used only when GITHUB_ALLOW_USER_TOKEN_AUTH=1).
 */
export async function authorizeSubscribedRepos(
  repos: string[],
  proofs: Record<string, string>,
  options: {
    cachedAllowed?: ReadonlySet<string>;
    fetch?: typeof fetch;
    apiBase?: string;
  } = {},
): Promise<GitHubRepoAuthResult> {
  const allowed: string[] = [];
  const denied: string[] = [];
  const toCheck: string[] = [];

  for (const repo of repos) {
    if (options.cachedAllowed?.has(repo)) {
      allowed.push(repo);
    } else {
      toCheck.push(repo);
    }
  }

  for (let i = 0; i < toCheck.length; i += GITHUB_AUTH_CONCURRENCY) {
    const batch = toCheck.slice(i, i + GITHUB_AUTH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (repo) => ({
        repo,
        ok: await checkGitHubRepoAccess(repo, proofs[repo], options),
      })),
    );
    for (const item of results) {
      if (item.ok) allowed.push(item.repo);
      else denied.push(item.repo);
    }
  }

  allowed.sort();
  denied.sort();
  return { allowed, denied };
}

function clampString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length <= max ? value : value.slice(0, max);
}

function trimActor(actor: unknown): { login: string; type?: string } | undefined {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) return undefined;
  const a = actor as Record<string, unknown>;
  const login = clampString(a.login, 100);
  if (!login) return undefined;
  const type = typeof a.type === "string" ? clampString(a.type, 40) : undefined;
  return type ? { login, type } : { login };
}

function trimLabels(raw: unknown): Array<{ name: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string }> = [];
  for (const item of raw) {
    if (out.length >= 100) break;
    const name = typeof item === "string" ? clampString(item, 100) : clampString((item as Record<string, unknown>)?.name, 100);
    if (name) out.push({ name });
  }
  return out;
}

function trimAssignees(raw: unknown): Array<{ login: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ login: string }> = [];
  for (const item of raw) {
    if (out.length >= 100) break;
    const login = typeof item === "string" ? clampString(item, 100) : clampString((item as Record<string, unknown>)?.login, 100);
    if (login) out.push({ login });
  }
  return out;
}

function trimIssueOrPr(raw: unknown, isPr: boolean): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof item.id === "number") out.id = item.id;
  if (typeof item.number === "number") out.number = item.number;
  if (typeof item.title === "string") out.title = clampString(item.title, 500);
  if (typeof item.body === "string") out.body = clampString(item.body, 32 * 1024);
  if (typeof item.html_url === "string") out.html_url = clampString(item.html_url, 500);
  if (typeof item.state === "string") out.state = clampString(item.state, 40);
  if (typeof item.updated_at === "string") out.updated_at = clampString(item.updated_at, 64);
  if (typeof item.created_at === "string") out.created_at = clampString(item.created_at, 64);
  if (typeof item.author_association === "string") out.author_association = clampString(item.author_association, 40);
  const user = trimActor(item.user);
  if (user) out.user = user;
  const labels = trimLabels(item.labels);
  if (labels.length) out.labels = labels;
  const assignees = trimAssignees(item.assignees);
  if (assignees.length) out.assignees = assignees;
  if (item.pull_request && typeof item.pull_request === "object") out.pull_request = {};
  if (isPr) {
    if (typeof item.merged === "boolean") out.merged = item.merged;
    if (typeof item.merged_at === "string") out.merged_at = clampString(item.merged_at, 64);
    if (item.base && typeof item.base === "object") {
      const base = item.base as Record<string, unknown>;
      if (typeof base.ref === "string") out.base = { ref: clampString(base.ref, 200) };
    }
    if (item.head && typeof item.head === "object") {
      const head = item.head as Record<string, unknown>;
      const headOut: Record<string, string> = {};
      if (typeof head.ref === "string") headOut.ref = clampString(head.ref, 200);
      if (typeof head.sha === "string") headOut.sha = clampString(head.sha, 64);
      if (Object.keys(headOut).length) out.head = headOut;
    }
    if (Array.isArray(item.requested_reviewers)) {
      const reviewers = trimAssignees(item.requested_reviewers);
      if (reviewers.length) out.requested_reviewers = reviewers;
    }
  }
  return out;
}

/**
 * Extracts only the fields needed by Botkins workflows and @mentions from a verified GitHub webhook payload.
 * Never retains secrets, tokens, or unrelated bloat.
 */
export function trimGitHubWebhookPayload(event: string, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof raw.action === "string") out.action = clampString(raw.action, 64);
  const sender = trimActor(raw.sender);
  if (sender) out.sender = sender;

  if (raw.repository && typeof raw.repository === "object") {
    const repo = raw.repository as Record<string, unknown>;
    out.repository = {
      ...(typeof repo.id === "number" ? { id: repo.id } : {}),
      ...(typeof repo.full_name === "string" ? { full_name: clampString(repo.full_name, 201) } : {}),
      ...(typeof repo.html_url === "string" ? { html_url: clampString(repo.html_url, 500) } : {}),
      ...(typeof repo.default_branch === "string" ? { default_branch: clampString(repo.default_branch, 200) } : {}),
    };
  }

  if (raw.label && typeof raw.label === "object") {
    const lbl = raw.label as Record<string, unknown>;
    if (typeof lbl.name === "string") out.label = { name: clampString(lbl.name, 100) };
  }

  const assignee = trimActor(raw.assignee);
  if (assignee) out.assignee = assignee;

  const requestedReviewer = trimActor(raw.requested_reviewer);
  if (requestedReviewer) out.requested_reviewer = requestedReviewer;

  if (event === "issues" || event === "issue_comment") {
    const issue = trimIssueOrPr(raw.issue, false);
    if (issue) out.issue = issue;
  }

  if (event === "pull_request" || event === "pull_request_review" || event === "pull_request_review_comment") {
    const pr = trimIssueOrPr(raw.pull_request, true);
    if (pr) out.pull_request = pr;
  }

  if ((event === "issue_comment" || event === "pull_request_review_comment") && raw.comment && typeof raw.comment === "object") {
    const c = raw.comment as Record<string, unknown>;
    const commentOut: Record<string, unknown> = {};
    if (typeof c.id === "number") commentOut.id = c.id;
    if (typeof c.body === "string") commentOut.body = clampString(c.body, 32 * 1024);
    if (typeof c.html_url === "string") commentOut.html_url = clampString(c.html_url, 500);
    if (typeof c.path === "string") commentOut.path = clampString(c.path, 500);
    if (typeof c.updated_at === "string") commentOut.updated_at = clampString(c.updated_at, 64);
    if (typeof c.created_at === "string") commentOut.created_at = clampString(c.created_at, 64);
    if (typeof c.author_association === "string") commentOut.author_association = clampString(c.author_association, 40);
    const user = trimActor(c.user);
    if (user) commentOut.user = user;
    out.comment = commentOut;
  }

  if (event === "pull_request_review" && raw.review && typeof raw.review === "object") {
    const r = raw.review as Record<string, unknown>;
    const reviewOut: Record<string, unknown> = {};
    if (typeof r.id === "number") reviewOut.id = r.id;
    if (typeof r.state === "string") reviewOut.state = clampString(r.state, 40);
    if (typeof r.body === "string") reviewOut.body = clampString(r.body, 32 * 1024);
    if (typeof r.html_url === "string") reviewOut.html_url = clampString(r.html_url, 500);
    if (typeof r.submitted_at === "string") reviewOut.submitted_at = clampString(r.submitted_at, 64);
    if (typeof r.author_association === "string") reviewOut.author_association = clampString(r.author_association, 40);
    const user = trimActor(r.user);
    if (user) reviewOut.user = user;
    out.review = reviewOut;
  }

  if (event === "check_suite" && raw.check_suite && typeof raw.check_suite === "object") {
    const cs = raw.check_suite as Record<string, unknown>;
    const csOut: Record<string, unknown> = {};
    if (typeof cs.id === "number") csOut.id = cs.id;
    if (typeof cs.status === "string") csOut.status = clampString(cs.status, 40);
    if (typeof cs.conclusion === "string") csOut.conclusion = clampString(cs.conclusion, 40);
    if (typeof cs.head_branch === "string") csOut.head_branch = clampString(cs.head_branch, 200);
    if (typeof cs.head_sha === "string") csOut.head_sha = clampString(cs.head_sha, 64);
    if (typeof cs.updated_at === "string") csOut.updated_at = clampString(cs.updated_at, 64);
    if (Array.isArray(cs.pull_requests)) {
      csOut.pull_requests = cs.pull_requests
        .slice(0, 10)
        .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
        .map((p) => ({
          ...(typeof p.number === "number" ? { number: p.number } : {}),
          ...(typeof p.url === "string" ? { url: clampString(p.url, 500) } : {}),
          ...(p.head && typeof p.head === "object" && typeof (p.head as Record<string, unknown>).ref === "string"
            ? { head: { ref: clampString((p.head as Record<string, unknown>).ref, 200), sha: clampString((p.head as Record<string, unknown>).sha, 64) } }
            : {}),
          ...(p.base && typeof p.base === "object" && typeof (p.base as Record<string, unknown>).ref === "string"
            ? { base: { ref: clampString((p.base as Record<string, unknown>).ref, 200) } }
            : {}),
        }));
    }
    out.check_suite = csOut;
  }

  return out;
}

export interface CheckedGitHubInstallationEvent {
  kind: "installation";
  deliveryId: string;
  event: "installation" | "installation_repositories";
  action: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repositories: string[];
  repositoriesAdded: string[];
  repositoriesRemoved: string[];
  receivedAt: string;
}

export interface CheckedGitHubWebhook {
  kind: "delivery";
  deliveryId: string;
  event: string;
  action: string | null;
  repository: string;
  repositoryLower: string;
  installationId: number | null;
  receivedAt: string;
  frame: GitHubDeliveryFrame;
}

export interface GitHubIngressLimiters {
  checkIp: () => Promise<boolean>;
  checkInstallation: (installationKey: string) => Promise<boolean>;
}

/**
 * Validates an inbound `POST /v1/github/events` request:
 * - method POST only (405)
 * - GITHUB_WEBHOOK_SECRET configured (503 `github_off`)
 * - IP rate limit (429)
 * - content-type application/json (415)
 * - 512 KiB body cap (413)
 * - x-github-event, x-github-delivery, x-hub-signature-256 constant-time HMAC-SHA256 (401)
 * - installation.id rate limit (429)
 * - handles `ping` (202), `installation` & `installation_repositories` lifecycle events, and repo events
 */
export async function checkGitHubWebhookRequest(
  request: Request,
  secret: string | undefined,
  limiters: GitHubIngressLimiters,
  nowMs = Date.now(),
): Promise<CheckedGitHubWebhook | CheckedGitHubInstallationEvent | Response> {
  const fail = (error: string, status: number) =>
    Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

  if (request.method !== "POST") return fail("method_not_allowed", 405);
  const webhookSecret = typeof secret === "string" ? secret.trim() : "";
  if (!webhookSecret) return fail("github_off", 503);

  if (!(await limiters.checkIp())) return fail("rate_limited", 429);

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) return fail("unsupported_media_type", 415);

  const event = (request.headers.get("x-github-event") ?? "").trim().toLowerCase();
  const deliveryId = (request.headers.get("x-github-delivery") ?? "").trim();
  const signature = request.headers.get("x-hub-signature-256");

  if (!GITHUB_EVENT_NAME_RE.test(event) || !GITHUB_DELIVERY_ID_RE.test(deliveryId)) {
    return fail("unauthorized", 401);
  }

  const rawBody = await readCappedBytes(request, GITHUB_DELIVERY_BODY_BYTES_LIMIT);
  if (rawBody === null) return fail("too_large", 413);

  if (!(await verifyGitHubSignature(webhookSecret, rawBody, signature))) {
    return fail("unauthorized", 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBody));
  } catch {
    return fail("bad_request", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("bad_request", 400);
  }
  const obj = parsed as Record<string, unknown>;

  const instObj = obj.installation && typeof obj.installation === "object" ? (obj.installation as Record<string, unknown>) : null;
  const instRaw = instObj?.id;
  const installationId = typeof instRaw === "number" && Number.isSafeInteger(instRaw) && instRaw > 0 ? instRaw : null;
  const installKey = installationId !== null ? `installation:${installationId}` : "installation:none";
  if (!(await limiters.checkInstallation(installKey))) {
    return fail("rate_limited", 429);
  }

  const receivedAt = new Date(nowMs).toISOString();

  if (event === "ping") {
    return Response.json({ ok: true, event: "ping", deliveryId }, { status: 202, headers: { "cache-control": "no-store" } });
  }

  if (event === "installation" || event === "installation_repositories") {
    if (!installationId) return fail("bad_request", 400);
    const action = typeof obj.action === "string" ? clampString(obj.action, 64).toLowerCase() : "";
    const account = instObj?.account && typeof instObj.account === "object" ? (instObj.account as Record<string, unknown>) : {};
    const accountLogin = typeof account.login === "string" ? clampString(account.login, 100) : "";
    const accountType = typeof account.type === "string" ? clampString(account.type, 40) : "User";
    const selectionRaw = obj.repository_selection ?? instObj?.repository_selection;
    const repositorySelection = selectionRaw === "all" ? "all" : "selected";
    return {
      kind: "installation",
      deliveryId,
      event,
      action,
      installationId,
      accountLogin,
      accountType,
      repositorySelection,
      repositories: normalizeInstallationRepos(obj.repositories),
      repositoriesAdded: normalizeInstallationRepos(obj.repositories_added),
      repositoriesRemoved: normalizeInstallationRepos(obj.repositories_removed),
      receivedAt,
    };
  }

  const repoRaw = obj.repository && typeof obj.repository === "object" ? (obj.repository as Record<string, unknown>).full_name : undefined;
  const repository = typeof repoRaw === "string" ? repoRaw.trim() : "";
  if (!GITHUB_REPO_RE.test(repository)) {
    return fail("bad_request", 400);
  }

  const action = typeof obj.action === "string" ? clampString(obj.action, 64) : null;
  const trimmed = trimGitHubWebhookPayload(event, obj);

  return {
    kind: "delivery",
    deliveryId,
    event,
    action,
    repository,
    repositoryLower: repository.toLowerCase(),
    installationId,
    receivedAt,
    frame: {
      type: "github-delivery",
      version: 1,
      deliveryId,
      event,
      action,
      repository,
      installationId,
      receivedAt,
      payload: trimmed,
    },
  };
}
