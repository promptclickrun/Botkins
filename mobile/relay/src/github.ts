// GitHub webhook ingress helpers and payload trimming for POST /v1/github/events
// and host repository subscriptions over the authenticated host relay connection.
//
// No Cloudflare imports here so Node (self-hosted relay + unit tests) loads this file as-is.

import { MAX_SKEW, hex, roomOf, verifyEd25519 } from "./pure.ts";
import { BASE64URL_43, readCappedBytes } from "./shared.ts";

export const GITHUB_EVENTS_PATH = "/v1/github/events";
export const GITHUB_DELIVERY_BODY_BYTES_LIMIT = 512 * 1024; // 512 KiB
export const GITHUB_ROUTE_REPOSITORIES_LIMIT = 100;
export const GITHUB_ROUTE_TTL_SECONDS = 300;
export const GITHUB_ROUTE_TTL_MS = GITHUB_ROUTE_TTL_SECONDS * 1000;
export const GITHUB_DELIVERY_DEDUPE_TTL_MS = 10 * 60_000;
export const GITHUB_DELIVERY_DEDUPE_MAX = 4096;
export const GITHUB_API_BASE_DEFAULT = "https://api.github.com";
export const GITHUB_AUTH_CHECK_TIMEOUT_MS = 8_000;
export const GITHUB_AUTH_TOKEN_MAX_LEN = 512;
export const GITHUB_AUTH_CONCURRENCY = 6;

export const GITHUB_RAW_WEBHOOK_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "check_suite",
] as const;

export const GITHUB_RAW_WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set(GITHUB_RAW_WEBHOOK_EVENTS);

export const GITHUB_EVENT_NAME_RE = /^[a-z_]{1,64}$/;
export const GITHUB_DELIVERY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const GITHUB_SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/i;
export const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

export const GITHUB_SUBSCRIBE_PREFIX = "botkins-github-sub-v1:";

const textEnc = new TextEncoder();

export interface GitHubSubscribeMessage {
  type: "github-subscribe";
  v: 1;
  key: string;
  time: number;
  exp: number;
  repos: string[];
  sig: string;
  /** Optional short-lived GitHub read token (per-host) or per-repo proof map (`owner/repo` -> token). Never persisted or logged. */
  githubToken?: string;
  repoTokens?: Record<string, string>;
}

export interface GitHubSubscribeVerified {
  ok: true;
  repos: string[];
  expiresAt: number;
  /** Ephemeral per-repo read proofs (only kept for the duration of the authorization check, never stored). */
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

/** Canonical signing string for host GitHub subscription messages. */
export function githubSubscribeChallenge(room: string, time: number, exp: number, repos: string[]): string {
  return `${GITHUB_SUBSCRIBE_PREFIX}${room}:${time}:${exp}:${repos.join(",")}`;
}

function cleanProofToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > GITHUB_AUTH_TOKEN_MAX_LEN) return null;
  // Reject whitespace or control characters so it can never inject headers.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parses and verifies a host's `github-subscribe` JSON control message.
 * Requires the host's Ed25519 key to match `expectedRoom`, time within MAX_SKEW, and exp <= time + TTL.
 * Extracts ephemeral per-repo proof tokens (`repoTokens[repo]` or fallback `githubToken`); tokens are
 * never signed into storage and never persisted by the relay.
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
  if (!BASE64URL_43.test(key) || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return { ok: false, error: "bad_key" };
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

/**
 * Checks whether the subscribing host is authorized to read `repo` via GitHub's `GET /repos/{owner}/{repo}`.
 *
 * Deny-by-default rules:
 * - Only `200 OK` with a JSON object where `full_name` matches `repo` (case-insensitively) can pass.
 * - If the repo is private (`private !== false`), a proof token MUST have been presented AND
 *   `permissions?.pull === true` MUST be returned by GitHub.
 * - If the repo is explicitly public (`private === false`), read access is granted (with or without token).
 * - Any non-200 response (401/403/404/5xx), malformed JSON, timeout, or network error denies access.
 * - The proof token is used strictly for the outbound request and never stored or logged.
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
    // Guard against unexpected redirect/mismatch unless GitHub returned the requested repo (or renamed repo with pull permission).
    const isPublic = body.private === false;
    const perms = body.permissions && typeof body.permissions === "object" && !Array.isArray(body.permissions)
      ? (body.permissions as Record<string, unknown>)
      : null;
    const hasPull = perms?.pull === true;
    if (fullName && fullName !== cleanRepo && !hasPull) return false;
    if (isPublic) return true;
    // Private (or unknown visibility): require proof token AND explicit `permissions.pull === true`.
    return Boolean(tok && hasPull);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies every requested repo against GitHub (skipping GitHub calls for repos already cached as
 * active for this room within the subscription TTL). Drops any unauthorized repo (deny-by-default)
 * and returns `{ allowed, denied }`. Never stores or returns proof tokens.
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
 * Extracts only the fields needed by Botkins workflows from a verified GitHub webhook payload.
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

  if (event === "pull_request" || event === "pull_request_review") {
    const pr = trimIssueOrPr(raw.pull_request, true);
    if (pr) out.pull_request = pr;
  }

  if (event === "issue_comment" && raw.comment && typeof raw.comment === "object") {
    const c = raw.comment as Record<string, unknown>;
    const commentOut: Record<string, unknown> = {};
    if (typeof c.id === "number") commentOut.id = c.id;
    if (typeof c.body === "string") commentOut.body = clampString(c.body, 32 * 1024);
    if (typeof c.html_url === "string") commentOut.html_url = clampString(c.html_url, 500);
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

export interface CheckedGitHubWebhook {
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
 * - JSON object with repository.full_name (400 / 202 for ping)
 */
export async function checkGitHubWebhookRequest(
  request: Request,
  secret: string | undefined,
  limiters: GitHubIngressLimiters,
  nowMs = Date.now(),
): Promise<CheckedGitHubWebhook | Response> {
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

  const instRaw = obj.installation && typeof obj.installation === "object" ? (obj.installation as Record<string, unknown>).id : undefined;
  const installationId = typeof instRaw === "number" && Number.isSafeInteger(instRaw) && instRaw > 0 ? instRaw : null;
  const installKey = installationId !== null ? `installation:${installationId}` : "installation:none";
  if (!(await limiters.checkInstallation(installKey))) {
    return fail("rate_limited", 429);
  }

  if (event === "ping") {
    return Response.json({ ok: true, event: "ping", deliveryId }, { status: 202, headers: { "cache-control": "no-store" } });
  }

  const repoRaw = obj.repository && typeof obj.repository === "object" ? (obj.repository as Record<string, unknown>).full_name : undefined;
  const repository = typeof repoRaw === "string" ? repoRaw.trim() : "";
  if (!GITHUB_REPO_RE.test(repository)) {
    return fail("bad_request", 400);
  }

  const action = typeof obj.action === "string" ? clampString(obj.action, 64) : null;
  const receivedAt = new Date(nowMs).toISOString();
  const trimmed = trimGitHubWebhookPayload(event, obj);

  return {
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
