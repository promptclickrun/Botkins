// POST /v1/push: forwards Apple push notifications for a paired computer.
//
// The computer signs a request with its Ed25519 key (the same key as its relay seat). The Worker
// checks that, signs a short-lived ES256 token with the team's APNs key (a Worker secret; a second
// one when Apple's test service has a key of its own), calls Apple once per item, and answers with
// Apple's result per item. It stores nothing. It never logs or echoes
// a device token, a key or a payload: logs hold counts only.
//
// This file loads in Node as well (no Cloudflare imports), so the helpers have unit tests.

import { base64url, verifyEd25519 } from "./pure.ts";

export const PUSH_PREFIX = "botkins-push-v1:";
/** The request body, in bytes. */
export const MAX_BODY = 64 * 1024;
export const MAX_ITEMS = 8;
/** One payload as JSON, in bytes (Apple's own limit for these push types). */
export const MAX_PAYLOAD = 4096;
export const MAX_SKEW = 300;
/** A token is made once for each 30 minute step, so every instance signs the same `iat`. */
export const IAT_STEP = 30 * 60;
/** A token is remade after 40 minutes. The step above already ends it sooner; this is the upper bound. */
export const JWT_LIFETIME_MS = 40 * 60 * 1000;
const APPLE_TIMEOUT_MS = 10_000;
const PRODUCTION_HOST = "https://api.push.apple.com";
const SANDBOX_HOST = "https://api.sandbox.push.apple.com";

const text = new TextEncoder();

/** What the computer signs: the UTF-8 bytes of this text. */
export const pushChallenge = (time: number | string, sends: string) => PUSH_PREFIX + time + ":" + sends;

export type PushType = "alert" | "background" | "liveactivity";
export type PushItem = {
  token: string;
  env: "production" | "sandbox";
  type: PushType;
  priority: 5 | 10;
  expiration: number;
  collapse?: string;
  /** The payload as JSON text, at most MAX_PAYLOAD bytes. Sent to Apple as it is. */
  body: string;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseItem(raw: unknown): PushItem | null {
  if (!isObject(raw)) return null;
  const { token, env, type, priority, expiration, collapse, payload } = raw;
  if (typeof token !== "string" || !/^[0-9a-f]{64,200}$/.test(token)) return null;
  if (env !== "production" && env !== "sandbox") return null;
  if (type !== "alert" && type !== "background" && type !== "liveactivity") return null;
  if (priority !== 5 && priority !== 10) return null;
  if (typeof expiration !== "number" || !Number.isInteger(expiration) || expiration < 0 || expiration > 86400) return null;
  // Up to 64 bytes. Visible ASCII only, so the value is safe as a header and counts one byte a character.
  if (collapse !== undefined && (typeof collapse !== "string" || !/^[\x21-\x7e]{1,64}$/.test(collapse))) return null;
  if (!isObject(payload) || !isObject(payload.aps)) return null;
  const body = JSON.stringify(payload);
  if (text.encode(body).length > MAX_PAYLOAD) return null;
  return { token, env, type, priority, expiration, ...(collapse === undefined ? {} : { collapse }), body };
}

/** The items in a `sends` string, or null if it is not 1 to 8 good items. */
export function parseSends(sends: string): PushItem[] | null {
  let value: unknown;
  try {
    value = JSON.parse(sends);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) return null;
  const items: PushItem[] = [];
  for (const raw of value) {
    const item = parseItem(raw);
    if (!item) return null;
    items.push(item);
  }
  return items;
}

/** The caller never chooses the topic: the app's id, plus a suffix for a Live Activity. */
export const topicFor = (base: string, type: PushType) => (type === "liveactivity" ? base + ".push-type.liveactivity" : base);

/** The address Apple gets the push at. `host`, when set, replaces both of Apple's hosts (tests only). */
export function apnsUrl(item: PushItem, host?: string): string {
  const origin = host ? host.replace(/\/+$/, "") : item.env === "sandbox" ? SANDBOX_HOST : PRODUCTION_HOST;
  return `${origin}/3/device/${item.token}`;
}

/** The headers of one push. A background push is always priority 5. `now` is in seconds. */
export function apnsHeaders(item: PushItem, topic: string, jwt: string, now: number): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: "bearer " + jwt,
    "apns-topic": topicFor(topic, item.type),
    "apns-push-type": item.type,
    "apns-priority": String(item.type === "background" ? 5 : item.priority),
    "apns-expiration": String(item.expiration === 0 ? 0 : now + item.expiration),
  };
  if (item.collapse !== undefined) headers["apns-collapse-id"] = item.collapse;
  return headers;
}

/** The DER of a PEM `PRIVATE KEY` block (the .p8 file's text), or null. A literal `\n` counts as a line break. */
export function pemToPkcs8(pem: string): Uint8Array | null {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem.replaceAll("\\n", "\n"));
  const body = match?.[1]?.replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  try {
    return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The start of the 30 minute step `now` (seconds) is in. */
export const iatFor = (now: number) => Math.floor(now / IAT_STEP) * IAT_STEP;

/** An ES256 token for Apple. Web Crypto's ECDSA signature is the raw r||s, which is what a JWT wants. */
export async function makeJwt(key: CryptoKey, kid: string, iss: string, iat: number): Promise<string> {
  const part = (value: object) => base64url(text.encode(JSON.stringify(value)));
  const input = part({ alg: "ES256", kid }) + "." + part({ iss, iat });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text.encode(input)));
  return input + "." + base64url(signature);
}

// ---- the route -------------------------------------------------------------------------------

type Service = PushItem["env"];
/** One APNs key: the text of its .p8 file and its id. */
type Key = { pem: string; kid: string };
/** Each of Apple's two services has its key. They are the same key unless the test service has its own. */
export type Settings = { keys: Record<Service, Key>; team: string; topic: string };
type PushEnv = { [Name in "APNS_KEY_P8" | "APNS_KEY_ID" | "APNS_SANDBOX_KEY_P8" | "APNS_SANDBOX_KEY_ID" | "APNS_TEAM_ID" | "APNS_TOPIC"]?: string };
type Cached = { iat: number; madeAt: number; token: Promise<string | null> };
// A key's token and its imported form, by key. A Worker has one or two keys, so these stay tiny.
const jwtCache = new Map<string, Cached>();
const keyCache = new Map<string, Promise<CryptoKey | null>>();
const MAX_KEPT = 4;

/**
 * The push settings, or null while push is off. Apple makes a push key for one of its two services
 * or for both: `APNS_KEY_P8` is the key for production, and for the test service too unless
 * `APNS_SANDBOX_KEY_P8` and `APNS_SANDBOX_KEY_ID` name a second key for it.
 */
export function pushSettings(env: PushEnv): Settings | null {
  const { APNS_KEY_P8: pem, APNS_KEY_ID: kid, APNS_SANDBOX_KEY_P8: sandboxPem, APNS_SANDBOX_KEY_ID: sandboxKid, APNS_TEAM_ID: team, APNS_TOPIC: topic } = env;
  if (!pem || !kid || !team || !topic) return null;
  const production: Key = { pem, kid };
  const sandbox: Key = sandboxPem && sandboxKid ? { pem: sandboxPem, kid: sandboxKid } : production;
  return { keys: { production, sandbox }, team, topic };
}

function importKey(pem: string): Promise<CryptoKey | null> {
  let key = keyCache.get(pem);
  if (!key) {
    const der = pemToPkcs8(pem);
    key = der
      ? crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]).catch(() => null)
      : Promise.resolve(null);
    if (keyCache.size >= MAX_KEPT) keyCache.clear();
    keyCache.set(pem, key);
  }
  return key;
}

const cacheId = (key: Key, team: string) => key.kid + "|" + team + "|" + key.pem;

/** A key's token for Apple, made once and kept in memory for the 30 minute step it belongs to. Null when the key can't be used. */
function jwtFor(key: Key, team: string, nowMs: number): Promise<string | null> {
  const iat = iatFor(Math.floor(nowMs / 1000));
  const id = cacheId(key, team);
  const kept = jwtCache.get(id);
  if (kept && kept.iat === iat && nowMs - kept.madeAt < JWT_LIFETIME_MS) return kept.token;
  const token = importKey(key.pem).then((imported) => (imported ? makeJwt(imported, key.kid, team, iat).catch(() => null) : null));
  const entry: Cached = { iat, madeAt: nowMs, token };
  if (jwtCache.size >= MAX_KEPT) jwtCache.clear();
  jwtCache.set(id, entry);
  // A failed attempt is not kept, so the next request tries again.
  void token.then((value) => {
    if (value === null && jwtCache.get(id) === entry) jwtCache.delete(id);
  });
  return token;
}

const fail = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** The request body as text, or null when it is over `max` bytes. It stops reading at the limit. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all);
}

/** `env` is set only when Apple took the item on the other service than the one the caller named. */
type Result = { status: number; reason?: string; env?: "production" | "sandbox" };

async function attempt(item: PushItem, settings: Settings, host: string | undefined, nowMs: number): Promise<Result> {
  // The key of the service this attempt goes to.
  const key = settings.keys[item.env];
  const jwt = await jwtFor(key, settings.team, nowMs);
  if (!jwt) return { status: 503, reason: "KeyUnusable" };
  const headers = apnsHeaders(item, settings.topic, jwt, Math.floor(nowMs / 1000));
  // With a replacement host (tests) both of Apple's hosts are the same server, so say which was meant.
  if (host) headers["x-botkins-apns-env"] = item.env;
  try {
    const response = await fetch(apnsUrl(item, host), {
      method: "POST",
      headers,
      body: item.body,
      signal: AbortSignal.timeout(APPLE_TIMEOUT_MS),
    });
    if (response.status === 200) {
      await response.body?.cancel().catch(() => {});
      return { status: 200 };
    }
    let reason: string | undefined;
    try {
      const parsed: unknown = JSON.parse((await response.text()).slice(0, 2048));
      // Apple's reason is one CamelCase word. Anything else is left out.
      if (isObject(parsed) && typeof parsed.reason === "string" && /^[A-Za-z0-9]{1,64}$/.test(parsed.reason)) reason = parsed.reason;
    } catch {
      // No body, or not JSON.
    }
    // A rejected token must not stay for the rest of its step.
    if (response.status === 403 && reason === "ExpiredProviderToken") jwtCache.delete(cacheId(key, settings.team));
    return reason ? { status: response.status, reason } : { status: response.status };
  } catch {
    return { status: 502, reason: "unreachable" };
  }
}

/**
 * Sends one item. A phone can name the wrong one of Apple's two services (an app can't always tell
 * which it is on), and Apple then answers that the key or the device token doesn't belong there.
 * In that case the item is tried once on the other service, with that service's key. When that works,
 * the answer says which service took it (`env`), so the caller can remember.
 */
async function sendOne(item: PushItem, settings: Settings, host: string | undefined, nowMs: number): Promise<Result> {
  const first = await attempt(item, settings, host, nowMs);
  // Apple's page names the second one; a phone showed the first. Both mean the key is for the other service.
  const keyForOther = (reason?: string) => reason === "BadEnvironmentKeyInToken" || reason === "BadEnvironmentKeyIdInToken";
  const wrongService = (first.status === 403 && keyForOther(first.reason)) || (first.status === 400 && first.reason === "BadDeviceToken");
  if (!wrongService) return first;
  const other: PushItem = { ...item, env: item.env === "production" ? "sandbox" : "production" };
  const second = await attempt(other, settings, host, nowMs);
  if (second.status === 200) return { status: 200, env: other.env };
  // The key can't be used on the first service at all, so what the second one says is the real answer.
  if (keyForOther(first.reason) && !(second.status === 403 && keyForOther(second.reason))) return { ...second, env: other.env };
  return first;
}

/**
 * Answers POST /v1/push. `limited` is false when RATE_LIMITS is "off" (local tests); `network` is the
 * caller's network as the Worker knows it. The order of the checks is the order of the errors:
 * network limit, method, push on, size, shape, time, signature, items, key limit.
 */
export async function handlePush(request: Request, env: Env, limited: boolean, network: string): Promise<Response> {
  if (limited && !(await env.REQUESTS.limit({ key: network })).success) return fail("rate_limited", 429);
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  const settings = pushSettings(env);
  if (!settings) return fail("push_off", 503);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail("bad_request", 400);

  const raw = await readCapped(request, MAX_BODY);
  if (raw === null) return fail("too_large", 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("bad_request", 400);
  }
  if (!isObject(body)) return fail("bad_request", 400);
  const { v, key, time, sig, sends } = body;
  if (v !== 1 || typeof sends !== "string" || typeof time !== "number" || !Number.isSafeInteger(time) || time < 0) return fail("bad_request", 400);
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key) || typeof sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(sig)) {
    return fail("bad_request", 400);
  }

  const nowMs = Date.now();
  if (Math.abs(Math.floor(nowMs / 1000) - time) > MAX_SKEW) return fail("unauthorized", 401);
  if (!(await verifyEd25519(key, sig, pushChallenge(time, sends)))) return fail("unauthorized", 401);

  const items = parseSends(sends);
  if (!items) return fail("bad_request", 400);

  // One count for each item, in one call: `delta` weights it. The call is allowed while the count is
  // below the limit, so one request may end up to 7 over. It is counted per key, after the signature,
  // so nobody can use up another computer's allowance.
  if (limited && !(await env.PUSHES.limit({ key, delta: items.length })).success) return fail("rate_limited", 429);

  // Without the main key nothing can be sent. A second key that can't be used stops only the test
  // service: its items answer 503 KeyUnusable.
  const { production, sandbox } = settings.keys;
  if (!(await jwtFor(production, settings.team, nowMs))) {
    console.log(JSON.stringify({ event: "push_key_unusable", service: "production" }));
    return fail("push_off", 503);
  }
  if (sandbox !== production && !(await jwtFor(sandbox, settings.team, nowMs))) console.log(JSON.stringify({ event: "push_key_unusable", service: "sandbox" }));

  const results = await Promise.all(items.map((item) => sendOne(item, settings, env.APNS_HOST || undefined, nowMs)));
  console.log(JSON.stringify({ event: "push", items: results.length, delivered: results.filter((r) => r.status === 200).length }));
  return Response.json({ results }, { headers: { "cache-control": "no-store" } });
}
