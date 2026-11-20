// The Botkins relay: a Worker in front of Durable Objects for rooms and invite cards.
//
// The wire format is in ../../tests/fake-relay.ts (its header), and that class is the reference this
// file must match. The relay only passes sealed messages between a computer and its phones. It never
// reads or keeps a message body, and it never logs a lookup, a key, a signature, a card, a room name,
// a `from` tag or message contents: logs hold counts, socket kinds and close codes only.

import { DurableObject } from "cloudflare:workers";
import { HOST_PROTOCOL, MAX_SKEW, PHONE_PROTOCOL, base64url, hex, hostProof, networkOf, roomOf, sha256, unhex, verifyEd25519 } from "./pure.ts";
import { handlePush } from "./push.ts";

const MAX_MESSAGE = 8 * 1024 * 1024; // from the computer
const MAX_PHONE_MESSAGE = 6 * 1024 * 1024 + 64 * 1024; // from a phone
const MAX_PHONES = 48;
// A household or an office behind one address may have several phones away at once on one computer.
const MAX_PER_FROM = 8;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const ROOM_NAME = BASE64URL_43;
const ROUTE = /^\/v1\/(host|room)\/([^/]+)$/;
const INVITE_ROUTE = /^\/v1\/invites\/([^/]+)$/;
const MAX_INVITE_CARD = 4096;
const MAX_INVITE_BODY = 16 * 1024;
const MAX_INVITE_LIFE = 30 * 24 * 60 * 60 * 1000;
// The Worker sets these two headers itself. The Durable Object is only reachable through this Worker.
const KIND_HEADER = "x-relay-kind";
const FROM_HEADER = "x-relay-from";
const INVITE_OWNER_HEADER = "x-relay-invite-owner";

const OPEN = 1;
const NOTICE_OFFLINE = 0x03;
const NOTICE_PHONE_CLOSED = 0x04;
const NOTICE_HOST_CLOSED = 0x05;
const REQUEST = 0x01;

/** `prefix` then `body`, in one allocation. */
function prefixed(prefix: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

const plain = (body: string, status = 200) =>
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

async function readCappedText(request: Request, max: number): Promise<string | null> {
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
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all);
  } catch {
    return null;
  }
}

type InviteBody = { card: string; expiresAt: number };

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

async function putInvite(request: Request, env: Env, lookup: string): Promise<Response> {
  const nowMs = Date.now();
  const body = await parseInviteBody(request, nowMs);
  if (!body) return plain("Bad request", 400);
  const proof = await inviteProof(request, nowMs);
  if (!proof) return plain("Unauthorized", 401);
  const cardHash = base64url(await sha256(body.card));
  const message = `botkins-relay-invite-v1:${proof.room}:${lookup}:${body.expiresAt}:${cardHash}:${proof.time}`;
  if (!(await verifyEd25519(proof.key, proof.sig, message))) return plain("Unauthorized", 401);
  const forwarded = new Request("https://invite.internal/", {
    method: "PUT",
    headers: { "content-type": "application/json", [INVITE_OWNER_HEADER]: proof.key },
    body: JSON.stringify(body),
  });
  return env.INVITE.getByName(lookup).fetch(forwarded);
}

async function deleteInvite(request: Request, env: Env, lookup: string): Promise<Response> {
  const nowMs = Date.now();
  const proof = await inviteProof(request, nowMs);
  if (!proof) return plain("Unauthorized", 401);
  const message = `botkins-relay-invite-del-v1:${proof.room}:${lookup}:${proof.time}`;
  if (!(await verifyEd25519(proof.key, proof.sig, message))) return plain("Unauthorized", 401);
  const forwarded = new Request("https://invite.internal/", {
    method: "DELETE",
    headers: { [INVITE_OWNER_HEADER]: proof.key },
  });
  return env.INVITE.getByName(lookup).fetch(forwarded);
}

function joinPage(): Response {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Join in Botkins</title>
  <style nonce="${nonce}">
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
  </style>
</head>
<body>
  <main>
    <h1>Join in Botkins</h1>
    <p class="intro">Open this invite in the Botkins app.</p>
    <div id="code" class="code" hidden></div>
    <a id="open" class="button" hidden>Open in Botkins</a>
    <p id="help" class="help" hidden>Don't have it open? Open Botkins and enter this code.</p>
    <p id="error" class="error">This invite link is missing or invalid.</p>
  </main>
  <script nonce="${nonce}">
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
  </script>
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // One network (an IPv4 address, or an IPv6 /64) is one source for the limits and for `from`.
    const network = networkOf(request.headers.get("CF-Connecting-IP") ?? "local");
    // The generated type knows only the deployed value ("on"); a local test run passes "off".
    const limited = (env.RATE_LIMITS as string) !== "off";
    // Push notifications: its own checks, in ./push.ts. It counts against the network limit first.
    if (url.pathname === "/v1/push") return handlePush(request, env, limited, network);
    const invite = INVITE_ROUTE.exec(url.pathname);
    if (invite) {
      const lookup = invite[1]!;
      if (limited && !(await env.REQUESTS.limit({ key: network })).success) return plain("Too many requests", 429);
      if (!BASE64URL_43.test(lookup)) return plain("Not found", 404);
      if (request.method === "GET") {
        if (limited && !(await env.INVITES.limit({ key: network })).success) return plain("Too many requests", 429);
        return env.INVITE.getByName(lookup).fetch(new Request("https://invite.internal/"));
      }
      if (request.method === "PUT") return putInvite(request, env, lookup);
      if (request.method === "DELETE") return deleteInvite(request, env, lookup);
      return plain("Not found", 404);
    }
    const route = ROUTE.exec(url.pathname);
    const room = route?.[2] ?? "";
    // Only a GET that asks for a socket on a well-formed room is a new socket. Whatever else comes
    // in (another method, a bad name, a plain page) is counted as an ordinary request first, so no
    // kind of junk gets past the limits.
    const socket = request.method === "GET" && !!route && ROOM_NAME.test(room) && request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (!socket) {
      if (limited && !(await env.REQUESTS.limit({ key: network })).success) return plain("Too many requests", 429);
      if (request.method !== "GET") return plain("Not found", 404);
      if (url.pathname === "/") return plain("Botkins relay. Messages pass through sealed.");
      if (url.pathname === "/v1/health") return Response.json({ ok: true });
      if (url.pathname === "/join") return joinPage();
      if (!route || !ROOM_NAME.test(room)) return plain("Not found", 404);
      return plain("Expected a WebSocket", 426);
    }
    const kind = route[1] === "host" ? "host" : "phone";
    // New sockets are counted before any other work is done for them.
    if (limited && !(await env.SOCKETS.limit({ key: network })).success) return plain("Too many requests", 429);

    const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (kind === "host") {
      // The computer proves it owns the room by signing with the key the room is a hash of.
      // Nothing secret is sent, so nothing here can be replayed for long: the signature holds a time.
      if (!(await hostProof(offered, room, Math.floor(Date.now() / 1000)))) return plain("Unauthorized", 401);
    } else if (!offered.includes(PHONE_PROTOCOL)) {
      return plain("Bad request", 400);
    }

    // `from` stands for the client's network without revealing it, and differs per room.
    const from = hex((await sha256(room + ":" + network)).subarray(0, 8));

    // Build the headers from scratch: nothing the client sent can reach the Durable Object.
    const forwarded = new Request("https://room.internal/", {
      headers: { Upgrade: "websocket", [KIND_HEADER]: kind, [FROM_HEADER]: from },
    });
    return env.ROOM.getByName(room).fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;

type StoredInvite = { card: string; expiresAt: number; owner: string };

async function readStoredInvite(storage: DurableObjectStorage): Promise<StoredInvite | null> {
  const stored = await storage.get<StoredInvite>("invite");
  if (!stored || typeof stored.card !== "string" || typeof stored.owner !== "string" || !Number.isSafeInteger(stored.expiresAt)) return null;
  return stored;
}

/** One sealed invite card, named by the hash of its invite code. */
export class Invite extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const owner = request.headers.get(INVITE_OWNER_HEADER);
    const stored = await readStoredInvite(this.ctx.storage);
    const now = Date.now();
    if (stored && stored.expiresAt <= now) await this.clear();
    const current = stored && stored.expiresAt > now ? stored : null;

    if (request.method === "GET") {
      if (!current) return plain("Not found", 404);
      return Response.json({ card: current.card }, { headers: { "cache-control": "no-store" } });
    }
    if (!owner) return plain("Bad request", 400);
    if (request.method === "PUT") {
      if (current && current.owner !== owner) return plain("Forbidden", 403);
      let body: InviteBody;
      try {
        body = (await request.json()) as InviteBody;
      } catch {
        return plain("Bad request", 400);
      }
      await this.ctx.storage.put("invite", { ...body, owner } satisfies StoredInvite);
      await this.ctx.storage.setAlarm(body.expiresAt);
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      if (!current) return plain("Not found", 404);
      if (current.owner !== owner) return plain("Forbidden", 403);
      await this.clear();
      return new Response(null, { status: 204 });
    }
    return plain("Not found", 404);
  }

  async alarm(): Promise<void> {
    const stored = await readStoredInvite(this.ctx.storage);
    if (stored && stored.expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(stored.expiresAt);
      return;
    }
    await this.clear();
  }

  private async clear(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

/**
 * What each socket carries through hibernation. A phone's `ids` is `[conn 8][from 8]`, the prefix
 * the computer sees, and `at` is when it opened (milliseconds), to find the oldest. `notified` is set
 * once the other side has been told this socket is gone.
 */
type Attachment = { kind: "host"; notified: boolean } | { kind: "phone"; ids: Uint8Array; at: number; notified: boolean };

/** One room. Nothing lives in memory between events: every handler finds sockets by tag. */
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    log("wake", { sockets: ctx.getWebSockets().length });
  }

  async fetch(request: Request): Promise<Response> {
    const kind = request.headers.get(KIND_HEADER);
    const from = request.headers.get(FROM_HEADER) ?? "";
    if (request.headers.get("Upgrade") !== "websocket" || !/^[0-9a-f]{16}$/.test(from)) {
      return plain("Bad request", 400);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (kind === "host") {
      // One computer socket per room: a new one replaces the old.
      for (const old of this.open("host")) this.end(old, 4000, "replaced");
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ kind: "host", notified: false } satisfies Attachment);
    } else if (kind === "phone") {
      // A new phone is never turned away. Its address's oldest socket makes room first, then the room's.
      const phones = this.open("phone")
        .map((ws) => ({ ws, side: ws.deserializeAttachment() as Attachment | null }))
        .filter((phone): phone is { ws: WebSocket; side: Extract<Attachment, { kind: "phone" }> } => phone.side?.kind === "phone")
        .sort((a, b) => a.side.at - b.side.at);
      const same = phones.filter((phone) => hex(phone.side.ids.subarray(8)) === from);
      const closed = new Set<WebSocket>();
      if (same.length >= MAX_PER_FROM) closed.add(same[0]!.ws);
      if (phones.length - closed.size >= MAX_PHONES) closed.add(phones.find((phone) => !closed.has(phone.ws))!.ws);
      for (const ws of closed) this.end(ws, 4008, "replaced");

      const conn = crypto.getRandomValues(new Uint8Array(8));
      const ids = prefixed(conn, unhex(from));
      this.ctx.acceptWebSocket(server, ["phone", "c:" + hex(conn)]);
      server.serializeAttachment({ kind: "phone", ids, at: Date.now(), notified: false } satisfies Attachment);
    } else {
      return plain("Bad request", 400);
    }
    log("open", { kind, phones: this.open("phone").length });
    const protocol = kind === "host" ? HOST_PROTOCOL : PHONE_PROTOCOL;
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": protocol } });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // "ping" never gets here (auto-response). Any other text is ignored.
    if (typeof message === "string" || ws.readyState !== OPEN) return;
    const bytes = new Uint8Array(message);
    const side = ws.deserializeAttachment() as Attachment | null;
    if (message.byteLength > (side?.kind === "phone" ? MAX_PHONE_MESSAGE : MAX_MESSAGE)) return this.end(ws, 1009, "too big");

    if (side?.kind === "phone") {
      const host = this.open("host")[0];
      if (!host) {
        // Nothing is passed on. A request gets told at once, so it can name the one that failed.
        if (bytes.length >= 5 && bytes[0] === REQUEST) ws.send(prefixed(Uint8Array.of(NOTICE_OFFLINE), bytes.subarray(1, 5)));
        return;
      }
      send(host, prefixed(side.ids, bytes));
    } else if (side?.kind === "host") {
      // [conn 8] + the answer. A short message, or a phone that is gone, is dropped.
      if (bytes.length < 9) return;
      const phone = this.open("c:" + hex(bytes.subarray(0, 8)))[0];
      // A view of the same bytes: the 8 are stripped without a copy.
      if (phone) send(phone, bytes.subarray(8));
    }
  }

  webSocketClose(ws: WebSocket, code: number): void {
    log("close", { kind: this.kindOf(ws), code });
    this.ended(ws);
    // Complete the handshake. Codes that cannot be sent (1005, 1006, ...) go without a code.
    try {
      if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code);
      else ws.close();
    } catch {
      // Already closed.
    }
  }

  webSocketError(ws: WebSocket): void {
    log("error", { kind: this.kindOf(ws) });
    this.ended(ws);
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  /** The room's sockets with a tag that are still open. A closing socket can linger in `getWebSockets`. */
  private open(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === OPEN);
  }

  private kindOf(ws: WebSocket): string {
    return (ws.deserializeAttachment() as Attachment | null)?.kind ?? "unknown";
  }

  /** Tells the other side, once, that a socket is gone: the computer about a phone, every phone about the computer. */
  private ended(ws: WebSocket): void {
    const side = ws.deserializeAttachment() as Attachment | null;
    if (!side || side.notified) return;
    ws.serializeAttachment({ ...side, notified: true } satisfies Attachment);
    if (side.kind === "phone") {
      const host = this.open("host")[0];
      if (host) send(host, prefixed(side.ids, Uint8Array.of(NOTICE_PHONE_CLOSED)));
    } else {
      // What the phones still wait for will not be answered; they can try again at once.
      for (const phone of this.open("phone")) if (phone !== ws) send(phone, Uint8Array.of(NOTICE_HOST_CLOSED));
    }
  }

  /** Closes a socket from this side. The reason is always one of our own fixed words. */
  private end(ws: WebSocket, code: number, reason: string): void {
    log("drop", { kind: this.kindOf(ws), code, reason });
    this.ended(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}

function send(ws: WebSocket, data: Uint8Array): void {
  try {
    ws.send(data);
  } catch {
    // The socket closed between the check and the send.
  }
}

/** One JSON line. Callers pass counts, kinds, codes and our own reasons, never names or contents. */
function log(event: string, fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
