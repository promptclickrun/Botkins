// The Botkins relay: a Worker in front of Durable Objects for rooms and invite cards.
//
// The host and phone wire formats are documented in ../README.md. A v3 room retains a bounded
// set of opaque requests for transport recovery. It never inspects their bodies. Logs contain only
// event kinds, counts and close codes or fixed reasons.

import { DurableObject } from "cloudflare:workers";
import { HOST_GROUP_LENGTH, HOST_PROTOCOL, HOST_PROTOCOL_V3, MAX_SKEW, PHONE_PROTOCOL, base64url, hex, hostProof, hostProofV3, networkOf, roomOf, sha256, unhex, verifyEd25519 } from "./pure.ts";
import { handlePush } from "./push.ts";

const MAX_MESSAGE = 8 * 1024 * 1024; // from the computer
const MAX_PHONE_MESSAGE = 6 * 1024 * 1024 + 64 * 1024; // from a phone
const MAX_PHONES = 48;
const MAX_V3_HOSTS = 2; // one active and one standby for a single authenticated runtime group
const V3_RECONNECT_WINDOW = 15_000;
// v0.16.1 sends its application ping every 25 seconds. Keep enough room for a delayed ping and
// use the runtime timestamp rather than waking the object for every heartbeat. Recent binary host
// traffic or a newer host that proves a shorter heartbeat gets the shorter bound.
const V3_LEGACY_SILENCE = 40_000;
const V3_FAST_SILENCE = 15_000;
const V3_FAST_HEARTBEAT = 12_000;
const V3_HEARTBEAT_PROBE = 7_000;
const V3_RESEAT_CLOSE = 4001;
// Pending bodies are opaque to the relay. Chunks stay below Durable Object per-value limits, and
// admission is bounded before any body is copied into storage.
const PENDING_CHUNK = 64 * 1024;
const MAX_PENDING_REQUESTS = 48;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const PENDING_LIFE = 5 * 60_000;
const RECOVERY_KEY = "room:recovery";
const SEAT_KEY = "room:seat";
const PENDING_KEY = "room:pending";
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
const HOST_VERSION_HEADER = "x-relay-host-version";
const HOST_GROUP_HEADER = "x-relay-host-group";
const INVITE_OWNER_HEADER = "x-relay-invite-owner";

const OPEN = 1;
const NOTICE_OFFLINE = 0x03;
const NOTICE_PHONE_CLOSED = 0x04;
const NOTICE_HOST_CLOSED = 0x05;
const NOTICE_ANSWER_ACCEPTED = 0x06; // host-only cache acknowledgement; never sent to a phone
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

    let hostVersion = "";
    let hostGroup = "";
    if (kind === "host") {
      // The computer proves it owns the room by signing with the key the room is a hash of.
      // Nothing secret is sent, so nothing here can be replayed for long: the signature holds a time.
      if (offered.includes(HOST_PROTOCOL_V3)) {
        if (!(await hostProofV3(offered, room, Math.floor(Date.now() / 1000)))) return plain("Unauthorized", 401);
        hostVersion = "v3";
        hostGroup = offered.find((entry) => entry.startsWith("g."))?.slice(2) ?? "";
        if (!new RegExp(`^[A-Za-z0-9_-]{${HOST_GROUP_LENGTH}}$`).test(hostGroup)) return plain("Unauthorized", 401);
      } else {
        if (!(await hostProof(offered, room, Math.floor(Date.now() / 1000)))) return plain("Unauthorized", 401);
        hostVersion = "v2";
      }
    } else if (!offered.includes(PHONE_PROTOCOL)) {
      return plain("Bad request", 400);
    }

    // `from` stands for the client's network without revealing it, and differs per room.
    const from = hex((await sha256(room + ":" + network)).subarray(0, 8));

    // Build the headers from scratch: nothing the client sent can reach the Durable Object.
    const headers: Record<string, string> = { Upgrade: "websocket", [KIND_HEADER]: kind, [FROM_HEADER]: from };
    if (kind === "host") {
      headers[HOST_VERSION_HEADER] = hostVersion;
      if (hostVersion === "v3") headers[HOST_GROUP_HEADER] = hostGroup;
    }
    const forwarded = new Request("https://room.internal/", { headers });
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
type HostAttachment = {
  kind: "host";
  version?: "v2" | "v3";
  group?: string;
  role?: "active" | "standby";
  openedAt?: number;
  lastBinaryAt?: number;
  lastAutoResponseAt?: number;
  autoProbeAt?: number;
  autoProbeCount?: number;
  heartbeat?: "legacy" | "fast";
  notified: boolean;
  closing?: boolean;
};
type PhoneAttachment = { kind: "phone"; ids: Uint8Array; at: number; notified: boolean };
type Attachment = HostAttachment | PhoneAttachment;
type RecoveryState = { version: "v3"; group: string; until: number; phones?: string[] };
type SeatState = { version: "v3"; group: string };
type PendingItem = { id: number; ids: string; requestId: number; size: number; at: number; sent: boolean };
type PendingDone = { ids: string; requestId: number; at: number };
type PendingState = { next: number; total: number; items: PendingItem[]; done: PendingDone[] };

/** One room. Nothing lives in memory between events: every handler finds sockets by tag. */
export class Room extends DurableObject<Env> {
  // Membership and the replay index change together. Each event finishes its bounded storage
  // work before another event changes either one. None of these handlers waits on a peer.

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    log("wake", { sockets: ctx.getWebSockets().length });
  }

  fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.upgrade(request));
  }

  private async upgrade(request: Request): Promise<Response> {
    const kind = request.headers.get(KIND_HEADER);
    const from = request.headers.get(FROM_HEADER) ?? "";
    if (request.headers.get("Upgrade") !== "websocket" || !/^[0-9a-f]{16}$/.test(from)) {
      return plain("Bad request", 400);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (kind === "host") {
      const version = request.headers.get(HOST_VERSION_HEADER);
      const group = request.headers.get(HOST_GROUP_HEADER) ?? "";
      if (version !== "v2" && version !== "v3") return plain("Bad request", 400);
      if (version === "v3" && !new RegExp(`^[A-Za-z0-9_-]{${HOST_GROUP_LENGTH}}$`).test(group)) return plain("Bad request", 400);

      const oldHosts = this.open("host");
      const oldSides = oldHosts.map((ws) => ws.deserializeAttachment() as Attachment | null);
      let recovery = await this.recovery();
      if (!oldHosts.length && !recovery) {
        const previous = await this.seatedV3();
        if (previous) recovery = await this.beginRecovery(previous.group);
      }
      const resume = version === "v3" && recovery?.group === group && recovery.until > Date.now();
      const sameGroup =
        version === "v3" &&
        oldHosts.length > 0 &&
        oldSides.every((side) => side?.kind === "host" && side.version === "v3" && side.group === group);
      let role: "active" | "standby" = "active";
      let replayPending = resume;
      if (!sameGroup) {
        // v2 keeps its historical one-seat behavior. A v3 group may replace v2 or a distinct v3
        // runtime, but sockets from one v3 group are active/standby peers and stay together.
        const replacingV3 = oldSides.some((side) => side?.kind === "host" && side.version === "v3");
        const staleRecovery = !!recovery && (version !== "v3" || recovery.group !== group || recovery.until <= Date.now());
        if (replacingV3 || staleRecovery) {
          // A new incarnation must not inherit opaque requests from the old one. Fail them before
          // closing the old seats; v3's normal disconnect path waits for the reconnect window.
          await this.failRecovery(!(staleRecovery && !replacingV3 && oldHosts.length > 0));
        }
        for (const old of oldHosts) await this.end(old, 4000, "replaced");
      } else {
        // A reconnect from the same proven runtime is not a competing computer. With two existing
        // seats, retire only the stalest/oldest peer and make this newest proven socket active.
        const reseat = await this.reseatSameGroup(oldHosts, Date.now());
        role = reseat.role;
        replayPending ||= reseat.replay;
      }
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({
        kind: "host",
        version,
        ...(version === "v3" ? { group } : {}),
        role: version === "v3" ? role : "active",
        openedAt: Date.now(),
        notified: false,
      } satisfies Attachment);
      if (version === "v3") {
        await this.ctx.storage.put(SEAT_KEY, { version: "v3", group } satisfies SeatState);
        if (recovery) await this.clearRecovery();
        // A standby join must not erase a pending-body expiry alarm. Recompute it after any
        // reconnect alarm is cleared, including when the active seat was already present.
        await this.scheduleAlarm();
        if (replayPending) {
          for (const ids of recovery?.phones ?? []) {
            if (!this.open("c:" + ids.slice(0, 16)).length) send(server, prefixed(unhex(ids), Uint8Array.of(NOTICE_PHONE_CLOSED)));
          }
          await this.drainPending(server, true);
        }
      } else {
        await this.ctx.storage.delete(SEAT_KEY);
        await this.clearRecovery();
        await this.clearPending();
      }
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
      for (const ws of closed) await this.end(ws, 4008, "replaced");

      const conn = crypto.getRandomValues(new Uint8Array(8));
      const ids = prefixed(conn, unhex(from));
      this.ctx.acceptWebSocket(server, ["phone", "c:" + hex(conn)]);
      server.serializeAttachment({ kind: "phone", ids, at: Date.now(), notified: false } satisfies Attachment);
    } else {
      return plain("Bad request", 400);
    }
    log("open", { kind, phones: this.open("phone").length });
    const protocol = kind === "host" ? (request.headers.get(HOST_VERSION_HEADER) === "v3" ? HOST_PROTOCOL_V3 : HOST_PROTOCOL) : PHONE_PROTOCOL;
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": protocol } });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.message(ws, message));
  }

  private async message(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // "ping" never gets here (auto-response). Any other text is ignored.
    if (typeof message === "string" || ws.readyState !== OPEN) return;
    const bytes = new Uint8Array(message);
    const side = ws.deserializeAttachment() as Attachment | null;
    if (message.byteLength > (side?.kind === "phone" ? MAX_PHONE_MESSAGE : MAX_MESSAGE)) return this.end(ws, 1009, "too big");

    if (side?.kind === "phone") {
      const host = this.activeHost();
      if (!host) {
        // A v3 host has a short, durable reconnect window. Keep opaque requests for that window;
        // an old/v2 room still gets the immediate per-request offline answer.
        let recovery = await this.recovery();
        // A simultaneous loss can deliver a phone frame before either close callback has written
        // the grace record. The durable seat marker closes that small event-ordering gap.
        if (!recovery) {
          const seat = await this.seatedV3();
          if (seat) {
            await this.beginRecovery(seat.group);
            recovery = await this.recovery();
          }
        }
        if (recovery && recovery.until > Date.now()) {
          if (!(await this.storePending(side.ids, bytes)) && bytes.length >= 5 && bytes[0] === REQUEST) {
            ws.send(prefixed(Uint8Array.of(NOTICE_OFFLINE), bytes.subarray(1, 5)));
          }
        } else if (bytes.length >= 5 && bytes[0] === REQUEST) {
          ws.send(prefixed(Uint8Array.of(NOTICE_OFFLINE), bytes.subarray(1, 5)));
        }
        return;
      }
      // If a reconnect just drained opaque requests, preserve their arrival order before a new
      // request. This is a bounded storage read, not a wait for the host to answer anything.
      const hostSide = host.deserializeAttachment() as Attachment | null;
      const pendingAllowed = hostSide?.kind === "host" && hostSide.version === "v3";
      if (pendingAllowed && (bytes.length < 5 || bytes[0] !== REQUEST)) return;
      if (pendingAllowed) await this.drainPending(host);
      if (pendingAllowed && bytes.length >= 5 && bytes[0] === REQUEST) {
        const pending = await this.storePending(side.ids, bytes);
        if (!pending) {
          ws.send(prefixed(Uint8Array.of(NOTICE_OFFLINE), bytes.subarray(1, 5)));
        } else if (send(host, prefixed(side.ids, bytes))) {
          await this.markPendingSent(pending.id);
        }
      } else {
        send(host, prefixed(side.ids, bytes));
      }
    } else if (side?.kind === "host") {
      if (side.closing) return;
      if (side.version === "v3") {
        ws.serializeAttachment({ ...side, lastBinaryAt: Date.now() } satisfies Attachment);
      }
      // [conn 8] + the answer. A short message, or a phone that is gone, is dropped.
      if (bytes.length < 9) return;
      if (side.version === "v3" && bytes.length >= 13 && bytes[8] === 0x02) {
        const accepted = await this.ackPending(bytes.subarray(0, 8), readU32(bytes, 9));
        if (!accepted) return;
        // Commit the room's durable answer acknowledgement before forwarding the answer. The
        // host can now evict its replay cache, while a duplicate answer gets this idempotent ack.
        send(ws, prefixed(unhex(accepted.ids), prefixed(Uint8Array.of(NOTICE_ANSWER_ACCEPTED), u32Bytes(accepted.requestId))));
        if (accepted.duplicate) return;
      }
      const phone = this.open("c:" + hex(bytes.subarray(0, 8)))[0];
      // A view of the same bytes: the 8 are stripped without a copy.
      if (phone) send(phone, bytes.subarray(8));
    }
  }

  webSocketClose(ws: WebSocket, code: number): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.closed(ws, code));
  }

  private async closed(ws: WebSocket, code: number): Promise<void> {
    log("close", { kind: this.kindOf(ws), code });
    const side = ws.deserializeAttachment() as Attachment | null;
    await this.ended(ws);
    if (side?.kind === "host" && !side.closing && !side.notified) await this.hostEnded(side);
    if (side?.kind === "phone") await this.dropPendingFor(side.ids);
    // Complete the handshake. Codes that cannot be sent (1005, 1006, ...) go without a code.
    try {
      if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code);
      else ws.close();
    } catch {
      // Already closed.
    }
  }

  webSocketError(ws: WebSocket): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.errored(ws));
  }

  private async errored(ws: WebSocket): Promise<void> {
    log("error", { kind: this.kindOf(ws) });
    const side = ws.deserializeAttachment() as Attachment | null;
    await this.ended(ws);
    if (side?.kind === "host" && !side.closing && !side.notified) await this.hostEnded(side);
    if (side?.kind === "phone") await this.dropPendingFor(side.ids);
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

  /** The role survives hibernation; old v2 attachments without one use a safe compatibility fallback. */
  private activeHost(): WebSocket | null {
    const hosts = this.open("host");
    return hosts.find((ws) => (ws.deserializeAttachment() as Attachment | null)?.kind === "host" && (ws.deserializeAttachment() as HostAttachment).role === "active") ?? hosts[0] ?? null;
  }

  /**
   * Reads activity without requiring a message event. Auto-replies are handled while the object is
   * hibernated; the timestamp is therefore the only liveness signal that survives a quiet object.
   * Binary host traffic is also retained in the attachment, so a busy host is never judged from an
   * older ping that happened before its last answer.
   */
  private hostActivity(ws: WebSocket): { side: HostAttachment; last: number; deadline: number } | null {
    const raw = ws.deserializeAttachment() as Attachment | null;
    if (raw?.kind !== "host" || raw.version !== "v3") return null;
    const now = Date.now();
    let side = raw;
    // Attachments written by v0.16.1 have no baseline. Seed it on the first wake so a deploy does
    // not compare an idle legacy socket with Unix epoch and immediately re-arm the same alarm.
    if (!side.openedAt || !Number.isSafeInteger(side.openedAt)) {
      side = { ...side, openedAt: now };
      ws.serializeAttachment(side satisfies Attachment);
    }
    let autoAt = 0;
    try {
      autoAt = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    } catch {
      // Older local workerd builds did not expose the timestamp accessor. Binary traffic and the
      // conservative legacy deadline still give those builds safe stale-seat behavior.
    }
    if (autoAt > 0 && autoAt !== side.lastAutoResponseAt) {
      const interval = side.lastAutoResponseAt && autoAt > side.lastAutoResponseAt ? autoAt - side.lastAutoResponseAt : 0;
      side = {
        ...side,
        lastAutoResponseAt: autoAt,
        ...(interval > 0 && !side.heartbeat
          ? { heartbeat: interval <= V3_FAST_HEARTBEAT ? ("fast" as const) : ("legacy" as const), autoProbeAt: undefined }
          : interval <= 0 && !side.heartbeat
            ? { autoProbeAt: Math.max(autoAt + V3_HEARTBEAT_PROBE, now + V3_HEARTBEAT_PROBE) }
            : {}),
      };
      ws.serializeAttachment(side satisfies Attachment);
    }
    const last = Math.max(side.openedAt ?? 0, side.lastBinaryAt ?? 0, side.lastAutoResponseAt ?? 0, autoAt);
    const silence = side.heartbeat === "fast" ? V3_FAST_SILENCE : V3_LEGACY_SILENCE;
    if (!side.heartbeat && side.autoProbeAt === undefined) {
      side = {
        ...side,
        autoProbeAt: (side.lastAutoResponseAt ?? side.openedAt ?? now) + V3_HEARTBEAT_PROBE,
        autoProbeCount: side.autoProbeCount ?? 1,
      };
      ws.serializeAttachment(side satisfies Attachment);
    }
    if (!side.heartbeat && !autoAt && side.autoProbeAt !== undefined && side.autoProbeAt <= now && (side.autoProbeCount ?? 0) < 2) {
      side = { ...side, autoProbeAt: now + V3_HEARTBEAT_PROBE, autoProbeCount: (side.autoProbeCount ?? 0) + 1 };
      ws.serializeAttachment(side satisfies Attachment);
    }
    const probe = !side.heartbeat && side.autoProbeAt && side.autoProbeAt > now ? side.autoProbeAt : Infinity;
    return { side, last, deadline: Math.min(last + silence, probe) };
  }

  /**
   * Same-group replacement is a repair of one runtime's two-seat transport, not a takeover. With
   * two seats, the newest proven socket is always active and the survivor is standby; the close
   * code is deliberately not 4000, which means a different computer took the room to 0.16.1.
   */
  private async reseatSameGroup(hosts: WebSocket[], now: number): Promise<{ role: "active" | "standby"; replay: boolean }> {
    const ordered = hosts
      .map((ws) => {
        const raw = ws.deserializeAttachment() as Attachment | null;
        const activity = this.hostActivity(ws);
        return { ws, side: activity?.side ?? raw, activity };
      })
      .filter((entry): entry is { ws: WebSocket; side: HostAttachment; activity: { side: HostAttachment; last: number; deadline: number } | null } => entry.side?.kind === "host" && entry.side.version === "v3");
    if (!ordered.length) return { role: "active", replay: true };

    const active = ordered.find((entry) => entry.side.role === "active") ?? ordered[0]!;
    const stale = ordered.filter((entry) => entry.activity && entry.activity.deadline <= now);
    const staleActive = stale.some((entry) => entry.ws === active.ws);
    if (ordered.length < MAX_V3_HOSTS && !staleActive) {
      // The first standby joins before either legacy 25-second ping has fired. That alone is not
      // evidence of a dead active, so do not churn a healthy-looking one during normal startup.
      return { role: "standby", replay: false };
    }
    // Two OPEN seats are a full re-seat, even when both recently answered a ping. A ping proves
    // only that the old transport was alive before this admission; the new proven socket must be
    // the active route. Evict the least recently heard seat, demote the survivor, and replay the
    // bounded opaque request index on the incoming active socket.
    const leastRecent = [...ordered].sort((a, b) => {
      const last = (entry: (typeof ordered)[number]) => entry.activity?.last ?? entry.side.openedAt ?? 0;
      const delta = last(a) - last(b);
      return delta || (a.side.openedAt ?? 0) - (b.side.openedAt ?? 0);
    })[0]!;
    await this.end(leastRecent.ws, V3_RESEAT_CLOSE, "replaced");
    const survivor = ordered.find((entry) => entry.ws !== leastRecent.ws);
    if (survivor) survivor.ws.serializeAttachment({ ...survivor.side, role: "standby" } satisfies Attachment);
    return { role: "active", replay: true };
  }

  alarm(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.expire());
  }

  private async expire(): Promise<void> {
    const now = Date.now();
    await this.reapStaleHosts(now);
    const recovery = await this.recovery();
    if (recovery && this.activeHost()) {
      await this.clearRecovery();
    } else if (recovery && recovery.until <= now) {
      // The old runtime did not return. Fail both queued and in-flight phones once, then leave
      // subsequent requests to the normal immediate [0x03][id] path.
      await this.failRecovery();
    }
    await this.expirePending(now);
    await this.scheduleAlarm();
  }

  /** Runs only at an alarm deadline; no interval or timer keeps the Durable Object resident. */
  private async reapStaleHosts(now: number): Promise<void> {
    const hosts = this.open("host");
    const entries = hosts
      .map((ws) => {
        const raw = ws.deserializeAttachment() as Attachment | null;
        const activity = this.hostActivity(ws);
        return { ws, side: activity?.side ?? raw, activity };
      })
      .filter((entry): entry is { ws: WebSocket; side: HostAttachment; activity: { side: HostAttachment; last: number; deadline: number } | null } => entry.side?.kind === "host" && entry.side.version === "v3");
    const stale = entries.filter((entry) => entry.activity && entry.activity.deadline <= now);
    if (!stale.length) return;
    const active = entries.find((entry) => entry.side.role === "active") ?? entries[0];
    const staleActive = !!active && stale.some((entry) => entry.ws === active.ws);
    const victims = staleActive ? stale : stale.filter((entry) => entry.ws !== active?.ws);
    for (const victim of victims) await this.end(victim.ws, V3_RESEAT_CLOSE, "replaced");

    const survivors = entries.filter((entry) => !victims.some((victim) => victim.ws === entry.ws));
    if (staleActive && survivors.length) {
      const promoted = survivors[0]!;
      promoted.ws.serializeAttachment({ ...promoted.side, role: "active" } satisfies Attachment);
      for (const survivor of survivors.slice(1)) {
        survivor.ws.serializeAttachment({ ...survivor.side, role: "standby" } satisfies Attachment);
      }
      await this.drainPending(promoted.ws, true);
    } else if (!survivors.length) {
      const group = stale[0]?.side.group;
      if (group) await this.beginRecovery(group);
    }
  }

  private async recovery(): Promise<RecoveryState | null> {
    const stored = await this.ctx.storage.get<RecoveryState>(RECOVERY_KEY);
    if (!stored || stored.version !== "v3" || !/^[A-Za-z0-9_-]{43}$/.test(stored.group) || !Number.isSafeInteger(stored.until)) return null;
    return stored;
  }

  private async seatedV3(): Promise<SeatState | null> {
    const stored = await this.ctx.storage.get<SeatState>(SEAT_KEY);
    return stored?.version === "v3" && /^[A-Za-z0-9_-]{43}$/.test(stored.group) ? stored : null;
  }

  private async beginRecovery(group: string, leaving?: Uint8Array): Promise<RecoveryState | null> {
    if (this.open("host").length) return null;
    const current = await this.recovery();
    if (current?.group === group) return current;
    const phones = this.open("phone").map(ws => hex((ws.deserializeAttachment() as PhoneAttachment).ids));
    if (leaving && !phones.includes(hex(leaving))) phones.push(hex(leaving));
    const recovery = { version: "v3", group, until: Date.now() + V3_RECONNECT_WINDOW, phones } satisfies RecoveryState;
    await this.ctx.storage.put(RECOVERY_KEY, recovery);
    await this.scheduleAlarm();
    return recovery;
  }

  private async clearRecovery(): Promise<void> {
    await this.ctx.storage.delete(RECOVERY_KEY);
    await this.ctx.storage.deleteAlarm();
  }

  private async hostEnded(side: HostAttachment): Promise<void> {
    const other = this.open("host");
    if (other.length) {
      if (side.version === "v3") {
        const currentActive = other.find((ws) => (ws.deserializeAttachment() as Attachment | null)?.kind === "host" && (ws.deserializeAttachment() as HostAttachment).role === "active");
        const standby = side.role === "active" || !currentActive ? other.find((ws) => {
          const candidate = ws.deserializeAttachment() as Attachment | null;
          return candidate?.kind === "host" && candidate.role !== "active";
        }) ?? other[0] : null;
        if (standby) {
          const candidate = standby.deserializeAttachment() as HostAttachment;
          standby.serializeAttachment({ ...candidate, role: "active" } satisfies Attachment);
          await this.drainPending(standby, true);
        }
      }
      return;
    }
    if (side.version === "v3" && side.group && /^[A-Za-z0-9_-]{43}$/.test(side.group)) {
      await this.beginRecovery(side.group);
    } else {
      await this.ctx.storage.delete(SEAT_KEY);
      await this.clearPending(true);
      await this.clearRecovery();
      await this.scheduleAlarm();
    }
  }

  /** Ends a v3 reconnect window or an explicit cross-runtime takeover. */
  private async failRecovery(notify = true): Promise<void> {
    await this.clearPending(true);
    await this.clearRecovery();
    await this.ctx.storage.delete(SEAT_KEY);
    await this.scheduleAlarm();
    if (notify) for (const phone of this.open("phone")) send(phone, Uint8Array.of(NOTICE_HOST_CLOSED));
  }

  private async pending(): Promise<PendingState> {
    const stored = await this.ctx.storage.get<PendingState>(PENDING_KEY);
    if (!stored || !Number.isSafeInteger(stored.next) || !Number.isSafeInteger(stored.total) || !Array.isArray(stored.items)) {
      return { next: 1, total: 0, items: [], done: [] };
    }
    const items = stored.items.filter(
      (item) =>
        item &&
        Number.isSafeInteger(item.id) &&
        /^[0-9a-f]{32}$/.test(item.ids) &&
        Number.isSafeInteger(item.requestId) &&
        Number.isSafeInteger(item.size) &&
        item.size >= 0 &&
        Number.isSafeInteger(item.at) &&
        typeof item.sent === "boolean",
    );
    const total = items.reduce((sum, item) => sum + item.size, 0);
    const done = (Array.isArray(stored.done) ? stored.done : []).filter(
      (item) => item && /^[0-9a-f]{32}$/.test(item.ids) && Number.isSafeInteger(item.requestId) && Number.isSafeInteger(item.at),
    ).filter((item) => item.at + PENDING_LIFE > Date.now()).slice(-128);
    return { next: stored.next > 0 ? stored.next : 1, total, items, done };
  }

  private chunkKey(id: number, at: number): string {
    return `room:pending:${id}:${at}`;
  }

  private async storePending(ids: Uint8Array, body: Uint8Array): Promise<PendingItem | null> {
    if (body.length < 5 || body[0] !== REQUEST || body.length > MAX_PHONE_MESSAGE) return null;
    const state = await this.pending();
    if (state.items.length >= MAX_PENDING_REQUESTS || state.total + body.length > MAX_PENDING_BYTES) return null;
    const conn = hex(ids);
    const requestId = readU32(body, 1);
    const now = Date.now();
    state.done = state.done.filter((entry) => entry.at + PENDING_LIFE > now);
    if (state.items.some((entry) => entry.ids === conn && entry.requestId === requestId) || state.done.some((entry) => entry.ids === conn && entry.requestId === requestId)) return null;
    const id = state.next > 0 && state.next < 2_000_000_000 ? state.next : 1;
    const item: PendingItem = { id, ids: conn, requestId, size: body.length, at: now, sent: false };
    const puts: Record<string, Uint8Array> = {};
    for (let at = 0; at < body.length; at += PENDING_CHUNK) puts[this.chunkKey(id, at / PENDING_CHUNK)] = body.slice(at, Math.min(body.length, at + PENDING_CHUNK));
    try {
      await this.ctx.storage.put(puts);
      await this.ctx.storage.put(PENDING_KEY, { next: id + 1, total: state.total + body.length, items: [...state.items, item], done: state.done } satisfies PendingState);
      await this.scheduleAlarm();
      return item;
    } catch {
      await this.ctx.storage.delete(Object.keys(puts)).catch(() => {});
      return null;
    }
  }

  private async readPendingBody(item: PendingItem): Promise<Uint8Array | null> {
    const count = Math.ceil(item.size / PENDING_CHUNK);
    const values = await this.ctx.storage.get<Uint8Array>(Array.from({ length: count }, (_, at) => this.chunkKey(item.id, at)));
    const body = new Uint8Array(item.size);
    for (let at = 0; at < count; at++) {
      const chunk = values.get(this.chunkKey(item.id, at));
      if (!chunk) return null;
      body.set(new Uint8Array(chunk), at * PENDING_CHUNK);
    }
    return body;
  }

  private async deletePendingItem(item: PendingItem): Promise<void> {
    const count = Math.ceil(item.size / PENDING_CHUNK);
    await this.ctx.storage.delete(Array.from({ length: count }, (_, at) => this.chunkKey(item.id, at)));
  }

  private async markPendingSent(id: number): Promise<void> {
    const state = await this.pending();
    const item = state.items.find((entry) => entry.id === id);
    if (!item || item.sent) return;
    item.sent = true;
    await this.ctx.storage.put(PENDING_KEY, state satisfies PendingState);
  }

  private async removePending(id: number, tombstone: boolean): Promise<PendingItem | null> {
    const state = await this.pending();
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return null;
    await this.deletePendingItem(item);
    state.items = state.items.filter((entry) => entry.id !== id);
    state.total -= item.size;
    if (tombstone) state.done.push({ ids: item.ids, requestId: item.requestId, at: Date.now() });
    if (state.items.length || state.done.length) await this.ctx.storage.put(PENDING_KEY, state satisfies PendingState);
    else await this.ctx.storage.delete(PENDING_KEY);
    await this.scheduleAlarm();
    return item;
  }

  private async drainPending(host = this.activeHost(), force = false): Promise<void> {
    if (!host) return;
    const state = await this.pending();
    for (const item of [...state.items]) {
      if (item.sent && !force) continue;
      const body = await this.readPendingBody(item);
      if (!body) {
        this.notifyOffline(item);
        await this.removePending(item.id, true);
        continue;
      }
      if (!send(host, prefixed(unhex(item.ids), body))) break;
      await this.markPendingSent(item.id);
    }
  }

  private async ackPending(conn: Uint8Array, requestId: number): Promise<(PendingItem | PendingDone) & { duplicate: boolean } | null> {
    const state = await this.pending();
    const item = state.items.find((entry) => entry.requestId === requestId && entry.ids.startsWith(hex(conn)));
    if (!item) {
      const done = state.done.find((entry) => entry.requestId === requestId && entry.ids.startsWith(hex(conn)));
      return done ? { ...done, duplicate: true } : null;
    }
    await this.removePending(item.id, true);
    return { ...item, duplicate: false };
  }

  private async dropPendingFor(ids: Uint8Array): Promise<void> {
    const prefix = hex(ids);
    const state = await this.pending();
    const dropped = state.items.filter((item) => item.ids === prefix);
    if (!dropped.length && !state.done.some((item) => item.ids === prefix)) return;
    for (const item of dropped) await this.deletePendingItem(item);
    state.items = state.items.filter((item) => item.ids !== prefix);
    state.total = state.items.reduce((sum, item) => sum + item.size, 0);
    state.done = state.done.filter((item) => item.ids !== prefix);
    if (state.items.length || state.done.length) await this.ctx.storage.put(PENDING_KEY, state satisfies PendingState);
    else await this.ctx.storage.delete(PENDING_KEY);
    await this.scheduleAlarm();
  }

  private async clearPending(keepDone = false): Promise<void> {
    const state = await this.pending();
    for (const item of state.items) await this.deletePendingItem(item);
    if (keepDone && state.done.length) await this.ctx.storage.put(PENDING_KEY, { next: state.next, total: 0, items: [], done: state.done } satisfies PendingState);
    else await this.ctx.storage.delete(PENDING_KEY);
  }

  private async expirePending(now: number): Promise<void> {
    const state = await this.pending();
    const expired = state.items.filter((item) => item.at + PENDING_LIFE <= now);
    if (!expired.length) return;
    for (const item of expired) {
      this.notifyOffline(item);
      await this.removePending(item.id, true);
    }
  }

  private notifyOffline(item: PendingItem): void {
    const phone = this.open("c:" + item.ids.slice(0, 16))[0];
    if (phone) send(phone, prefixed(Uint8Array.of(NOTICE_OFFLINE), Uint8Array.of((item.requestId >>> 24) & 255, (item.requestId >>> 16) & 255, (item.requestId >>> 8) & 255, item.requestId & 255)));
  }

  private async scheduleAlarm(): Promise<void> {
    const recovery = await this.recovery();
    const state = await this.pending();
    const hostDeadlines = this.open("host").map((ws) => this.hostActivity(ws)?.deadline ?? Infinity);
    const times = [recovery?.until ?? Infinity, ...hostDeadlines, ...state.items.map((item) => item.at + PENDING_LIFE), ...state.done.map((item) => item.at + PENDING_LIFE)].filter(Number.isFinite);
    if (state.items.length || state.done.length) await this.ctx.storage.put(PENDING_KEY, state satisfies PendingState);
    else await this.ctx.storage.delete(PENDING_KEY);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  /** Tells the other side, once, that a socket is gone: the computer about a phone, every phone about the computer. */
  private async ended(ws: WebSocket): Promise<void> {
    const side = ws.deserializeAttachment() as Attachment | null;
    if (!side || side.notified) return;
    ws.serializeAttachment({ ...side, notified: true } satisfies Attachment);
    if (side.kind === "phone") {
      const host = this.activeHost();
      if (host) send(host, prefixed(side.ids, Uint8Array.of(NOTICE_PHONE_CLOSED)));
      else {
        const seat = await this.seatedV3();
        if (seat) await this.beginRecovery(seat.group, side.ids);
      }
    } else if (side.version !== "v3") {
      // What the phones still wait for will not be answered; they can try again at once. A v3
      // standby is already a usable seat, so its active peer disappearing is intentionally silent.
      for (const phone of this.open("phone")) if (phone !== ws) send(phone, Uint8Array.of(NOTICE_HOST_CLOSED));
    }
  }

  /** Closes a socket from this side. The reason is always one of our own fixed words. */
  private async end(ws: WebSocket, code: number, reason: string): Promise<void> {
    log("drop", { kind: this.kindOf(ws), code, reason });
    const side = ws.deserializeAttachment() as Attachment | null;
    const replacing = reason === "replaced";
    if (side?.kind === "host") ws.serializeAttachment({ ...side, closing: true } satisfies Attachment);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    await this.ended(ws);
    // A deliberate protocol close (for example, an oversized v3 host frame) still needs to
    // promote standby or arm the reconnect window. Replacement closes are handled by the new seat.
    if (side?.kind === "host" && !replacing) await this.hostEnded({ ...side, closing: true });
  }
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! * 0x1000000) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!) >>> 0;
}

function u32Bytes(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

function send(ws: WebSocket, data: Uint8Array): boolean {
  if (ws.readyState !== OPEN) return false;
  try {
    ws.send(data);
    return true;
  } catch {
    // The socket closed between the check and the send.
    return false;
  }
}

/** One JSON line. Callers pass counts, kinds, codes and our own reasons, never names or contents. */
function log(event: string, fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
