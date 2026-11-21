// What both relays answer the same way: the Cloudflare Worker (index.ts) and the self-hosted Node relay
// (../node/server.mjs). Only web-standard Request and Response here, no Cloudflare imports, so Node loads
// this file as it is.

import { MAX_SKEW, base64url, hex, roomOf, sha256, verifyEd25519 } from "./pure.ts";

export const MAX_MESSAGE = 8 * 1024 * 1024; // from the computer
export const MAX_PHONE_MESSAGE = 6 * 1024 * 1024 + 64 * 1024; // from a phone
export const MAX_PHONES = 48;
// A household or an office behind one address may have several phones away at once on one computer.
export const MAX_PER_FROM = 8;
export const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
export const ROOM_NAME = BASE64URL_43;
export const ROUTE = /^\/v1\/(host|room)\/([^/]+)$/;
export const INVITE_ROUTE = /^\/v1\/invites\/([^/]+)$/;
export const MAX_INVITE_CARD = 4096;
export const MAX_INVITE_BODY = 16 * 1024;
export const MAX_INVITE_LIFE = 30 * 24 * 60 * 60 * 1000;
// A space shared by link: a sealed copy the computer puts out (mobile/docs/spaces.md, "Share by link").
export const SPACE_ROUTE = /^\/v1\/spaces\/([^/]+)$/;
export const SPACE_PAGE_ROUTE = /^\/s\/([^/]+)$/;
export const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/;
export const MAX_SPACE_BODY = 4 * 1024 * 1024;
/** A sealed copy is at least its nonce and its tag. */
export const MIN_SPACE_BODY = 12 + 16;
export const MAX_SPACE_LIFE = 7 * 24 * 60 * 60 * 1000;
export const MAX_SPACES_PER_KEY = 100;
export const SPACE_PUTS_PER_MINUTE = 30;
/** A copy is kept in pieces of this size, under the store's limit for one value. */
export const SPACE_PIECE = 256 * 1024;

export const MAX_V3_HOSTS = 2; // one active and one standby for a single authenticated runtime group
export const V3_RECONNECT_WINDOW = 15_000;
// v0.16.1 sends its application ping every 25 seconds. Keep enough room for a delayed ping. Recent
// binary host traffic or a newer host that proves a shorter heartbeat gets the shorter bound.
export const V3_LEGACY_SILENCE = 40_000;
export const V3_FAST_SILENCE = 15_000;
export const V3_FAST_HEARTBEAT = 12_000;
export const V3_HEARTBEAT_PROBE = 7_000;
export const V3_RESEAT_CLOSE = 4001;
// Pending bodies are opaque to the relay, and admission is bounded before any body is kept.
export const MAX_PENDING_REQUESTS = 48;
export const MAX_PENDING_BYTES = 16 * 1024 * 1024;
export const PENDING_LIFE = 5 * 60_000;

export const NOTICE_OFFLINE = 0x03;
export const NOTICE_PHONE_CLOSED = 0x04;
export const NOTICE_HOST_CLOSED = 0x05;
export const NOTICE_ANSWER_ACCEPTED = 0x06; // host-only cache acknowledgement; never sent to a phone
export const REQUEST = 0x01;

export function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! * 0x1000000) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!) >>> 0;
}

export function u32Bytes(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

/** `prefix` then `body`, in one allocation. */
export function prefixed(prefix: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

export const plain = (body: string, status = 200) =>
  new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function decodeBase64url(value: string): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return base64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

/** The body as bytes, or null when it is over `max` bytes. It stops reading at the limit. */
export async function readCappedBytes(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
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
  return all;
}

/** The body as UTF-8 text, or null when it is over `max` bytes or not UTF-8. It stops reading at the limit. */
export async function readCappedText(request: Request, max: number): Promise<string | null> {
  const all = await readCappedBytes(request, max);
  if (all === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all);
  } catch {
    return null;
  }
}

export type InviteBody = { card: string; expiresAt: number };

async function parseInviteBody(request: Request, nowMs: number): Promise<InviteBody | null> {
  const raw = await readCappedText(request, MAX_INVITE_BODY);
  if (raw === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(body) || typeof body.card !== "string") return null;
  const cardBytes = decodeBase64url(body.card);
  if (!cardBytes || cardBytes.length > MAX_INVITE_CARD) return null;
  if (
    typeof body.expiresAt !== "number" ||
    !Number.isSafeInteger(body.expiresAt) ||
    body.expiresAt <= nowMs ||
    body.expiresAt > nowMs + MAX_INVITE_LIFE
  ) {
    return null;
  }
  return { card: body.card, expiresAt: body.expiresAt };
}

type InviteProof = { key: string; time: string; sig: string; room: string };

async function inviteProof(request: Request, nowMs: number): Promise<InviteProof | null> {
  const key = request.headers.get("x-botkins-key");
  const time = request.headers.get("x-botkins-time");
  const sig = request.headers.get("x-botkins-sig");
  if (!key || !BASE64URL_43.test(key) || !time || !/^\d{1,12}$/.test(time) || !sig || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return null;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(time)) > MAX_SKEW) return null;
  return { key, time, sig, room: await roomOf(key) };
}

/** A checked invite PUT: the owner's key and the body to keep, or the answer that refuses it. */
export async function checkInvitePut(request: Request, lookup: string): Promise<{ owner: string; body: InviteBody } | Response> {
  const nowMs = Date.now();
  const body = await parseInviteBody(request, nowMs);
  if (!body) return plain("Bad request", 400);
  const proof = await inviteProof(request, nowMs);
  if (!proof) return plain("Unauthorized", 401);
  const cardHash = base64url(await sha256(body.card));
  const message = `botkins-relay-invite-v1:${proof.room}:${lookup}:${body.expiresAt}:${cardHash}:${proof.time}`;
  if (!(await verifyEd25519(proof.key, proof.sig, message))) return plain("Unauthorized", 401);
  return { owner: proof.key, body };
}

/** A checked invite DELETE: the owner's key, or the answer that refuses it. */
export async function checkInviteDelete(request: Request, lookup: string): Promise<{ owner: string } | Response> {
  const proof = await inviteProof(request, Date.now());
  if (!proof) return plain("Unauthorized", 401);
  const message = `botkins-relay-invite-del-v1:${proof.room}:${lookup}:${proof.time}`;
  if (!(await verifyEd25519(proof.key, proof.sig, message))) return plain("Unauthorized", 401);
  return { owner: proof.key };
}

/** A link's id: it belongs to the computer's relay key and a salt, so nobody else can put a copy under it. */
export async function shareIdOf(publicKey: string, salt: string): Promise<string> {
  return base64url((await sha256("botkins-space-id-v1:" + publicKey + ":" + salt)).subarray(0, 16));
}

/** The key, time and salt of a space request, when the id in the address is that key's and salt's. */
async function spaceProof(request: Request, shareId: string, nowMs: number): Promise<InviteProof | Response> {
  const proof = await inviteProof(request, nowMs);
  if (!proof) return plain("Unauthorized", 401);
  const salt = request.headers.get("x-botkins-salt");
  if (!salt || !BASE64URL_22.test(salt)) return plain("Bad request", 400);
  if ((await shareIdOf(proof.key, salt)) !== shareId) return plain("Forbidden", 403);
  return proof;
}

export type SpacePut = { owner: string; body: Uint8Array; expiresAt: number; time: number };

/** A checked PUT of a space's copy: what to keep, or the answer that refuses it. Nothing of the body is read before the id is known to be the key's. */
export async function checkSpacePut(request: Request, shareId: string): Promise<SpacePut | Response> {
  const nowMs = Date.now();
  const proof = await spaceProof(request, shareId, nowMs);
  if (proof instanceof Response) return proof;
  const expires = request.headers.get("x-botkins-expires") ?? "";
  const expiresAt = /^\d{1,16}$/.test(expires) ? Number(expires) : NaN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowMs || expiresAt > nowMs + MAX_SPACE_LIFE) return plain("Bad request", 400);
  const body = await readCappedBytes(request, MAX_SPACE_BODY);
  if (body === null) return plain("Too large", 413);
  if (body.length < MIN_SPACE_BODY) return plain("Bad request", 400);
  const hash = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  const message = `botkins-relay-space-v1:${proof.room}:${shareId}:${expiresAt}:${hash}:${proof.time}`;
  if (!(await verifyEd25519(proof.key, proof.sig, message))) return plain("Unauthorized", 401);
  return { owner: proof.key, body, expiresAt, time: Number(proof.time) };
}

/** A checked DELETE of a space's copy: the owner's key and the signed time, or the answer that refuses it. */
export async function checkSpaceDelete(request: Request, shareId: string): Promise<{ owner: string; time: number } | Response> {
  const proof = await spaceProof(request, shareId, Date.now());
  if (proof instanceof Response) return proof;
  const message = `botkins-relay-space-del-v1:${proof.room}:${shareId}:${proof.time}`;
  if (!(await verifyEd25519(proof.key, proof.sig, message))) return plain("Unauthorized", 401);
  return { owner: proof.key, time: Number(proof.time) };
}

/**
 * Whether a copy signed at `time` (seconds) may replace what is held. It must be later than the copy
 * held, and later than the last time the copy was taken back: a PUT that was on its way when its
 * DELETE arrived must not put the space out again.
 */
export const spacePutAllowed = (heldTime: number | null, goneTime: number | null, time: number) => time > Math.max(heldTime ?? 0, goneTime ?? 0);

/** How long (milliseconds since 1970) a taken-back time must be remembered: until no PUT that old can still be signed. */
export const spaceGoneUntil = (goneTime: number) => (goneTime + 2 * MAX_SKEW) * 1000;

/**
 * One computer's copies: how many it may hold and how often it may put one. `live` is share id →
 * when it ends, `puts` the current minute's count. Answers what to keep, or null when it is refused.
 */
export type SpaceOwnerState = { live: Record<string, number>; puts: { start: number; count: number } };
export function admitSpace(state: SpaceOwnerState | null, shareId: string, expiresAt: number, nowMs: number): SpaceOwnerState | null {
  const live = Object.fromEntries(Object.entries(state?.live ?? {}).filter(([, ends]) => ends > nowMs));
  const window = state?.puts && nowMs - state.puts.start < 60_000 ? state.puts : { start: nowMs, count: 0 };
  if (window.count >= SPACE_PUTS_PER_MINUTE) return null;
  if (!Object.hasOwn(live, shareId) && Object.keys(live).length >= MAX_SPACES_PER_KEY) return null;
  live[shareId] = expiresAt;
  return { live, puts: { start: window.start, count: window.count + 1 } };
}

/** A self-contained page: one nonce for its style and script, no outside assets, no referrer, no cache. */
export function securePage(title: string, css: string, body: string, script: string): Response {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style nonce="${nonce}">${css}</style>
</head>
<body>
${body}
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export const PAGE_CSS = `
    :root { color-scheme: light dark; --paper: #f7f8fa; --card: #fff; --ink: #15171a; --muted: #656b73; --line: #dfe3e8; --accent: #246bfe; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
    main { width: min(100%, 440px); padding: 36px; border: 1px solid var(--line); border-radius: 24px; background: var(--card); box-shadow: 0 18px 60px #00000012; text-align: center; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -.03em; }
    .intro, .help, .error { color: var(--muted); }
    .intro { margin: 0 0 24px; }
    .code { margin: 12px 0 24px; font: 700 32px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; }
    .button { display: inline-block; width: 100%; padding: 13px 18px; border-radius: 12px; background: var(--accent); color: #fff; font-weight: 700; text-decoration: none; }
    .button:focus-visible { outline: 3px solid #8bb0ff; outline-offset: 3px; }
    .help { margin: 20px 0 0; font-size: 14px; }
    .error { margin: 24px 0 0; }
    [hidden] { display: none; }
    @media (prefers-color-scheme: dark) {
      :root { --paper: #111315; --card: #1b1e22; --ink: #f4f5f7; --muted: #a6adb5; --line: #30353b; --accent: #6f9dff; }
    }
  `;

export function joinPage(): Response {
  return securePage(
    "Join in Botkins",
    PAGE_CSS,
    `  <main>
    <h1>Join in Botkins</h1>
    <p class="intro">Open this invite in the Botkins app.</p>
    <div id="code" class="code" hidden></div>
    <a id="open" class="button" hidden>Open in Botkins</a>
    <p id="help" class="help" hidden>Don't have it open? Open Botkins and enter this code.</p>
    <p id="error" class="error">This invite link is missing or invalid.</p>
  </main>`,
    `
    (() => {
      const params = new URLSearchParams(location.hash.slice(1));
      const raw = params.get("c") || "";
      const clean = raw.replace(/[\\s-]/g, "").toUpperCase().replaceAll("I", "1").replaceAll("L", "1").replaceAll("O", "0");
      const key = params.get("k") || "";
      const codeOk = params.getAll("c").length === 1 && /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/.test(clean);
      const keyOk = params.getAll("k").length === 1 && /^[A-Za-z0-9_-]{43}$/.test(key);
      if (!codeOk || !keyOk) return;
      const code = clean.slice(0, 5) + "-" + clean.slice(5);
      document.getElementById("code").textContent = code;
      document.getElementById("open").href = "botkins://join?c=" + encodeURIComponent(clean) + "&k=" + encodeURIComponent(key);
      document.getElementById("code").hidden = false;
      document.getElementById("open").hidden = false;
      document.getElementById("help").hidden = false;
      document.getElementById("error").hidden = true;
    })();
  `,
  );
}
