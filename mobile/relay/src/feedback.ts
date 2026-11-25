// POST /v1/feedback: a bug report or a feature request becomes an issue on the Botkins repo.
//
// Two ways in, each with its own check. Issues are opened as the "Botkins Intake" GitHub App, installed
// on the repo alone with Issues: write. Its id, installation id and private key are Worker secrets that
// only this route uses; the relay signs a short JWT and trades it for an installation token, kept until
// just before it expires.
//
//
//   from a computer   { v: 1, key, time, sig, report }   sig = Ed25519 over "botkins-feedback-v1:" + time + ":" + report
//                     The computer signs with the relay key it already has. Phones send through their
//                     computer (link.feedback.send), so the key never leaves it.
//   from the website  { v: 1, turnstile, report }        a Cloudflare Turnstile token, checked with Cloudflare.
//
// `report` is the JSON text of { kind, title, body, app?, platform?, version? }. The issue says where
// it came from and what the sender chose to write; the relay adds nothing else (no address, no key).
// Logs hold the outcome only. Without the app's settings or the repo the route answers 503 feedback_off.
//
// This file loads in Node as well (no Cloudflare imports), so the helpers have unit tests.

import { base64url, verifyEd25519 } from "./pure.ts";
import { pemToPkcs8 } from "./push.ts";

export const FEEDBACK_PREFIX = "botkins-feedback-v1:";
export const MAX_BODY = 32 * 1024;
export const MAX_TITLE = 120;
export const MAX_TEXT = 8000;
export const MAX_SKEW = 300;
export const KINDS = ["bug", "feature"] as const;
export type Kind = (typeof KINDS)[number];
export type Source = "app" | "website";
export type Report = { kind: Kind; title: string; body: string; app?: string; platform?: string; version?: string };

const SITE_ORIGINS = new Set(["https://botkins.app", "https://www.botkins.app"]);
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const GITHUB_TIMEOUT_MS = 10_000;

/** What a computer signs: the UTF-8 bytes of this text. */
export const feedbackChallenge = (time: number | string, report: string) => FEEDBACK_PREFIX + time + ":" + report;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Text as one line: control characters out, spaces folded, trimmed, at most `max` characters. */
function line(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A short label such as an app name or version: letters, digits and a few marks only. */
function label(value: unknown): string | undefined {
  const text = line(value, 40);
  return /^[A-Za-z0-9 ._()+-]{1,40}$/.test(text) ? text : undefined;
}

/** The report in `text`, or null when it is not a good one. */
export function parseReport(text: string): Report | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const kind = value.kind;
  if (kind !== "bug" && kind !== "feature") return null;
  const title = line(value.title, MAX_TITLE);
  if (title.length < 4) return null;
  if (typeof value.body !== "string") return null;
  // Keep the person's lines; drop other control characters.
  const body = value.body.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (body.length < 4 || body.length > MAX_TEXT) return null;
  const app = label(value.app);
  const platform = label(value.platform);
  const version = label(value.version);
  return { kind, title, body, ...(app && { app }), ...(platform && { platform }), ...(version && { version }) };
}

/**
 * The issue for a report. Mentions are broken so a report can't ping people, and the body is quoted
 * as the sender's own words under a fixed heading.
 */
export function issueFor(report: Report, source: Source): { title: string; body: string; labels: string[] } {
  const quiet = (text: string) => text.replace(/@(?=[A-Za-z0-9-])/g, "@\u200b");
  const where = source === "app" ? "the Botkins app" : "botkins.app";
  const details = [
    report.app && "App: " + report.app,
    report.version && "Version: " + report.version,
    report.platform && "Platform: " + report.platform,
  ].filter(Boolean);
  const body = [
    "_" + (report.kind === "bug" ? "Bug report" : "Feature request") + " sent from " + where + "._",
    "",
    quiet(report.body),
    ...(details.length ? ["", "---", ...details.map((item) => "- " + item)] : []),
  ].join("\n");
  return {
    title: quiet(report.title),
    body,
    labels: [report.kind === "bug" ? "bug" : "enhancement", source === "app" ? "from-app" : "from-website"],
  };
}

/** CORS headers for the website's own pages, none for anyone else. */
export function corsFor(origin: string | null): Record<string, string> {
  if (!origin || !SITE_ORIGINS.has(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600", vary: "origin" };
}

export type FeedbackEnv = {
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  /** PEM text of the app's PKCS#8 private key. */
  GITHUB_APP_KEY?: string;
  TURNSTILE_SECRET?: string;
  FEEDBACK_REPO?: string;
  REQUESTS: RateLimit;
  FEEDBACK: RateLimit;
};

/** Owner and name of the repo, or null when the setting is missing or malformed. */
export function repoOf(env: Pick<FeedbackEnv, "FEEDBACK_REPO">): string | null {
  const repo = env.FEEDBACK_REPO ?? "";
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) ? repo : null;
}

const GITHUB_API = "https://api.github.com";
const githubHeaders = (auth: string) => ({ accept: "application/vnd.github+json", authorization: auth, "user-agent": "botkins-relay", "x-github-api-version": "2022-11-28" });

/** The app's settings, or null when one is missing or malformed. */
export function appOf(env: Pick<FeedbackEnv, "GITHUB_APP_ID" | "GITHUB_APP_INSTALLATION_ID" | "GITHUB_APP_KEY">): { id: string; installation: string; key: string } | null {
  const id = env.GITHUB_APP_ID?.trim() ?? "";
  const installation = env.GITHUB_APP_INSTALLATION_ID?.trim() ?? "";
  if (!/^\d{1,12}$/.test(id) || !/^\d{1,12}$/.test(installation) || !env.GITHUB_APP_KEY) return null;
  return { id, installation, key: env.GITHUB_APP_KEY };
}

/** A GitHub App JWT (RS256), valid for nine minutes from a minute ago, as GitHub asks. */
export async function appJwt(appId: string, pem: string, nowMs = Date.now()): Promise<string | null> {
  const der = pemToPkcs8(pem);
  if (!der) return null;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    return null;
  }
  const now = Math.floor(nowMs / 1000);
  const enc = new TextEncoder();
  const part = (value: object) => base64url(enc.encode(JSON.stringify(value)));
  const head = part({ alg: "RS256", typ: "JWT" }) + "." + part({ iat: now - 60, exp: now + 540, iss: appId });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head)));
  return head + "." + base64url(sig);
}

/** One installation token per Worker instance, reused until five minutes before GitHub ends it. */
let cached: { installation: string; token: string; until: number } | null = null;
export const forgetInstallationToken = () => void (cached = null);

async function installationToken(app: { id: string; installation: string; key: string }, fetcher: typeof fetch): Promise<string | null> {
  const now = Date.now();
  if (cached && cached.installation === app.installation && cached.until > now) return cached.token;
  const jwt = await appJwt(app.id, app.key, now);
  if (!jwt) return null;
  const response = await fetcher(GITHUB_API + "/app/installations/" + app.installation + "/access_tokens", { method: "POST", headers: githubHeaders("Bearer " + jwt), signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
  if (response.status !== 201) {
    console.log(JSON.stringify({ event: "feedback_token", status: response.status }));
    return null;
  }
  const answer = (await response.json()) as { token?: string; expires_at?: string };
  if (typeof answer.token !== "string") return null;
  const expires = Date.parse(answer.expires_at ?? "") || now + 60 * 60_000;
  cached = { installation: app.installation, token: answer.token, until: expires - 5 * 60_000 };
  return answer.token;
}

async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > max ? null : text;
}

async function turnstileOk(secret: string, token: string, ip: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const response = await fetcher(TURNSTILE_URL, { method: "POST", body: form, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    const answer = (await response.json()) as { success?: boolean };
    return answer.success === true;
  } catch {
    return false;
  }
}

export async function handleFeedback(request: Request, env: FeedbackEnv, limited: boolean, network: string, fetcher: typeof fetch = fetch): Promise<Response> {
  const cors = corsFor(request.headers.get("origin"));
  const fail = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store", ...cors } });
  if (request.method === "OPTIONS") return new Response(null, { status: cors["access-control-allow-origin"] ? 204 : 403, headers: cors });
  if (limited && !(await env.REQUESTS.limit({ key: network })).success) return fail("rate_limited", 429);
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  const repo = repoOf(env);
  const app = appOf(env);
  if (!app || !repo) return fail("feedback_off", 503);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail("bad_request", 400);

  const raw = await readCapped(request, MAX_BODY);
  if (raw === null) return fail("too_large", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("bad_request", 400);
  }
  if (!isObject(body) || body.v !== 1 || typeof body.report !== "string") return fail("bad_request", 400);

  let source: Source;
  let limitKey: string;
  if (typeof body.key === "string") {
    const { key, time, sig, report } = body;
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || typeof sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return fail("bad_request", 400);
    if (typeof time !== "number" || !Number.isSafeInteger(time)) return fail("bad_request", 400);
    if (Math.abs(Math.floor(Date.now() / 1000) - time) > MAX_SKEW) return fail("unauthorized", 401);
    if (!(await verifyEd25519(key, sig, feedbackChallenge(time, report)))) return fail("unauthorized", 401);
    source = "app";
    limitKey = "key:" + key;
  } else if (typeof body.turnstile === "string" && body.turnstile.length > 0 && body.turnstile.length <= 2048) {
    if (!env.TURNSTILE_SECRET) return fail("feedback_off", 503);
    if (!(await turnstileOk(env.TURNSTILE_SECRET, body.turnstile, request.headers.get("CF-Connecting-IP") ?? "", fetcher))) return fail("unauthorized", 401);
    source = "website";
    limitKey = "net:" + network;
  } else return fail("bad_request", 400);

  const report = parseReport(body.report);
  if (!report) return fail("bad_report", 400);
  // Counted after the check, per computer key or per network, so nobody uses up another's allowance.
  if (limited && !(await env.FEEDBACK.limit({ key: limitKey })).success) return fail("rate_limited", 429);

  const issue = issueFor(report, source);
  try {
    const token = await installationToken(app, fetcher);
    if (!token) return fail("github_failed", 502);
    const response = await fetcher(GITHUB_API + "/repos/" + repo + "/issues", {
      method: "POST",
      headers: { ...githubHeaders("token " + token), "content-type": "application/json" },
      body: JSON.stringify(issue),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    // A token GitHub no longer takes (the app was reinstalled, the key rotated) is made again next time.
    if (response.status === 401) forgetInstallationToken();
    if (!response.ok) {
      console.log(JSON.stringify({ event: "feedback", source, status: response.status }));
      return fail("github_failed", 502);
    }
    const created = (await response.json()) as { number?: number; html_url?: string };
    console.log(JSON.stringify({ event: "feedback", source, status: 201 }));
    return Response.json({ number: created.number, url: created.html_url }, { status: 201, headers: { "cache-control": "no-store", ...cors } });
  } catch {
    console.log(JSON.stringify({ event: "feedback", source, status: "unreachable" }));
    return fail("github_failed", 502);
  }
}
