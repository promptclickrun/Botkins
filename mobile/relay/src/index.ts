// The Botkins relay: a Worker in front of one Durable Object per room.
//
// The wire format is in ../../tests/fake-relay.ts (its header), and that class is the reference this
// file must match. The relay only passes sealed messages between a computer and its phones. It never
// reads or keeps a message body, and it never logs a key, a signature, a room name, a `from` tag or
// message contents: logs hold counts, socket kinds and close codes only.

import { DurableObject } from "cloudflare:workers";
import { HOST_PROTOCOL, PHONE_PROTOCOL, hex, hostProof, networkOf, sha256, unhex } from "./pure.ts";
import { handlePush } from "./push.ts";

const MAX_MESSAGE = 8 * 1024 * 1024; // from the computer
const MAX_PHONE_MESSAGE = 6 * 1024 * 1024 + 64 * 1024; // from a phone
const MAX_PHONES = 16;
// A household or an office behind one address may have several phones away at once on one computer.
const MAX_PER_FROM = 8;
const ROOM_NAME = /^[A-Za-z0-9_-]{43}$/;
const ROUTE = /^\/v1\/(host|room)\/([^/]+)$/;
// The Worker sets these two headers itself. The Durable Object is only reachable through this Worker.
const KIND_HEADER = "x-relay-kind";
const FROM_HEADER = "x-relay-from";

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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // One network (an IPv4 address, or an IPv6 /64) is one source for the limits and for `from`.
    const network = networkOf(request.headers.get("CF-Connecting-IP") ?? "local");
    // The generated type knows only the deployed value ("on"); a local test run passes "off".
    const limited = (env.RATE_LIMITS as string) !== "off";
    // Push notifications: its own checks, in ./push.ts. It counts against the network limit first.
    if (url.pathname === "/v1/push") return handlePush(request, env, limited, network);
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
