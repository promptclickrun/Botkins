// The self-hosted Botkins relay: the Cloudflare Worker's protocol (../src/index.ts) on plain Node, for a
// server that should not depend on relay.botkins.app. The checks that decide who may do what are the
// Worker's own code (../src/pure.ts, ../src/shared.ts), so both relays refuse the same things.
//
// It runs behind a TLS proxy (Caddy in deploy/azure). Rooms live in memory: a restart drops sockets, and
// computers and phones reconnect on their own. Invite cards are kept in DATA_DIR/invites.json.
// Push notifications are forwarded, signed by the computer and unchanged, to PUSH_UPSTREAM, because only
// the Botkins relay holds the Apple key. Set PUSH_UPSTREAM=off to send none.
//
// Logs follow the Worker's rule: counts, socket kinds, close codes and fixed reasons, never a room name,
// key, lookup, card, `from` tag or message.

import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { HOST_PROTOCOL, PHONE_PROTOCOL, hex, hostProof, networkOf, sha256, unhex } from "../src/pure.ts";
import {
  BASE64URL_43,
  INVITE_ROUTE,
  MAX_MESSAGE,
  MAX_PER_FROM,
  MAX_PHONES,
  MAX_PHONE_MESSAGE,
  NOTICE_HOST_CLOSED,
  NOTICE_OFFLINE,
  NOTICE_PHONE_CLOSED,
  PAGE_CSS,
  REQUEST,
  ROOM_NAME,
  ROUTE,
  checkInviteDelete,
  checkInvitePut,
  joinPage,
  plain,
  prefixed,
  readCappedText,
  securePage,
} from "../src/shared.ts";

const MAX_PUSH_BODY = 64 * 1024;
const DEFAULT_PUSH_UPSTREAM = "https://relay.botkins.app";
// The Worker's limits (wrangler.jsonc), per network and per minute.
const LIMITS = { sockets: 30, requests: 120, invites: 20 };
const WINDOW_MS = 60_000;

const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

/** Fixed one-minute windows per key. Enough to stop a flood from one network; it is not an exact gate. */
class Limiter {
  constructor(limit, now = Date.now) {
    Object.assign(this, { limit, now, counts: new Map(), started: now() });
  }
  allow(key) {
    if (this.now() - this.started >= WINDOW_MS) {
      this.counts.clear();
      this.started = this.now();
    }
    const used = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, used);
    return used <= this.limit;
  }
}

/** Sealed invite cards by lookup, saved to one file so a restart keeps them. */
class Invites {
  constructor(file) {
    this.file = file;
    this.cards = new Map();
    if (!file) return;
    try {
      for (const [lookup, card] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) this.cards.set(lookup, card);
    } catch {
      // No file yet, or one that can't be read: start empty.
    }
    this.sweep();
  }
  get(lookup) {
    const card = this.cards.get(lookup);
    if (card && card.expiresAt <= Date.now()) {
      this.cards.delete(lookup);
      this.save();
      return null;
    }
    return card ?? null;
  }
  put(lookup, value) {
    this.cards.set(lookup, value);
    this.save();
  }
  delete(lookup) {
    this.cards.delete(lookup);
    this.save();
  }
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [lookup, card] of this.cards) if (card.expiresAt <= now) changed = this.cards.delete(lookup) || changed;
    if (changed) this.save();
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + ".tmp", JSON.stringify(Object.fromEntries(this.cards)), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
}

/** The pairing page: the pairing link stays in the fragment, which the browser never sends here. */
function pairPage(qrSource) {
  return securePage(
    "Pair with Botkins",
    PAGE_CSS +
      `
    .qr { width: 240px; height: 240px; margin: 0 auto 20px; padding: 12px; border-radius: 16px; background: #fff; }
    .qr svg { display: block; width: 100%; height: 100%; }
    .name { margin: 0 0 4px; font-weight: 700; }`,
    `  <main>
    <h1>Pair with Botkins</h1>
    <p id="intro" class="intro" hidden>Scan this code with your phone's camera, or open this page on your phone.</p>
    <p id="name" class="name" hidden></p>
    <div id="qr" class="qr" hidden></div>
    <div id="code" class="code" hidden></div>
    <a id="open" class="button" hidden>Open in Botkins</a>
    <p id="help" class="help" hidden>The code works once. If it expired, ask your server for a new pairing link.</p>
    <p id="error" class="error">This pairing link is missing or invalid.</p>
  </main>`,
    `
    ${qrSource}
    (() => {
      const query = location.hash.slice(1);
      const params = new URLSearchParams(query);
      const one = (name) => (params.getAll(name).length === 1 ? params.get(name) : null);
      const key = one("k") || "";
      const code = (one("c") || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
      const hosts = (one("h") || "").split(",").filter(Boolean);
      if (!/^[A-Za-z0-9_-]{43}$/.test(key) || code.length < 8 || !hosts.length || (one("v") && one("v") !== "1")) return;
      const link = "botkins://pair?" + query;
      const qr = qrcode(0, "M");
      qr.addData(link, "Byte");
      qr.make();
      const count = qr.getModuleCount();
      const size = count + 8;
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 " + size + " " + size);
      svg.setAttribute("shape-rendering", "crispEdges");
      let d = "";
      for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += "M" + (c + 4) + " " + (r + 4) + "h1v1h-1z";
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "#15171a");
      svg.appendChild(path);
      document.getElementById("qr").appendChild(svg);
      const name = (one("n") || "").slice(0, 60);
      if (name) {
        document.getElementById("name").textContent = name;
        document.getElementById("name").hidden = false;
      }
      document.getElementById("code").textContent = code.replace(/(.{4})(?=.)/g, "$1-");
      document.getElementById("open").href = link;
      for (const id of ["intro", "qr", "code", "open", "help"]) document.getElementById(id).hidden = false;
      document.getElementById("error").hidden = true;
    })();
  `,
  );
}

/** The vendored QR generator (MIT) as a plain script for the pairing page. */
function loadQrSource(file) {
  return readFileSync(file, "utf8")
    .replace(/^export const qrcode = /m, "const qrcode = ")
    .replace(/^export default qrcode;$/m, "")
    .replace(/^export const stringToBytes = .*$/m, "");
}

/**
 * A relay server. Options (all optional):
 *   dataDir        where invite cards are kept (none: memory only)
 *   pushUpstream   where push requests go, or "off"
 *   clientIpHeader the header a trusted proxy puts the client's address in; its last entry is used.
 *                  Without one, the socket's own address is used.
 *   limits         false turns the per-network limits off (tests from one address)
 *   qrFile         the vendored QR generator for the pairing page
 */
export function createRelay({ dataDir, pushUpstream = DEFAULT_PUSH_UPSTREAM, clientIpHeader, limits = true, qrFile, fetch = globalThis.fetch } = {}) {
  const invites = new Invites(dataDir ? join(dataDir, "invites.json") : null);
  const sweeper = setInterval(() => invites.sweep(), WINDOW_MS);
  sweeper.unref();
  const limiters = { sockets: new Limiter(LIMITS.sockets), requests: new Limiter(LIMITS.requests), invites: new Limiter(LIMITS.invites) };
  const allowed = (kind, network) => !limits || limiters[kind].allow(network);
  const qrSource = loadQrSource(qrFile ?? fileURLToPath(new URL("../../link-host/vendor/qrcode.mjs", import.meta.url)));
  /** room → { host, phones: Map<connHex, phone> } */
  const rooms = new Map();
  const hosts = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, handleProtocols: () => HOST_PROTOCOL });
  const phones = new WebSocketServer({ noServer: true, maxPayload: MAX_PHONE_MESSAGE, handleProtocols: () => PHONE_PROTOCOL });

  const networkFor = (req) => {
    const header = clientIpHeader && req.headers[clientIpHeader.toLowerCase()];
    const value = Array.isArray(header) ? header.at(-1) : header;
    const address = value ? value.split(",").at(-1).trim() : req.socket.remoteAddress;
    return networkOf(address || "local");
  };
  const roomFor = (name) => {
    let room = rooms.get(name);
    if (!room) rooms.set(name, (room = { host: null, phones: new Map() }));
    return room;
  };
  const forget = (name, room) => {
    if (!room.host && !room.phones.size && rooms.get(name) === room) rooms.delete(name);
  };
  const send = (ws, data) => {
    if (ws.readyState === ws.OPEN) ws.send(data, { binary: typeof data !== "string" });
  };

  /** Tells the other side, once, that a socket is gone. */
  function ended(name, room, side) {
    if (side.notified) return;
    side.notified = true;
    if (side.kind === "phone") {
      room.phones.delete(side.conn);
      if (room.host) send(room.host.ws, prefixed(side.ids, Uint8Array.of(NOTICE_PHONE_CLOSED)));
    } else {
      if (room.host === side) room.host = null;
      for (const phone of room.phones.values()) send(phone.ws, Uint8Array.of(NOTICE_HOST_CLOSED));
    }
    forget(name, room);
  }
  function end(name, room, side, code, reason) {
    log("drop", { kind: side.kind, code, reason });
    ended(name, room, side);
    try {
      side.ws.close(code, reason);
    } catch {
      side.ws.terminate();
    }
  }

  function attach(ws, name, room, side) {
    side.ws = ws;
    ws.on("message", (data, binary) => {
      if (!binary) {
        if (data.toString() === "ping") ws.send("pong");
        return;
      }
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (side.kind === "phone") {
        if (!room.host) {
          if (bytes.length >= 5 && bytes[0] === REQUEST) send(ws, prefixed(Uint8Array.of(NOTICE_OFFLINE), bytes.subarray(1, 5)));
          return;
        }
        send(room.host.ws, prefixed(side.ids, bytes));
      } else {
        if (bytes.length < 9) return;
        const phone = room.phones.get(hex(bytes.subarray(0, 8)));
        if (phone) send(phone.ws, bytes.subarray(8));
      }
    });
    ws.on("close", (code) => {
      log("close", { kind: side.kind, code });
      ended(name, room, side);
    });
    ws.on("error", () => {
      log("error", { kind: side.kind });
      ended(name, room, side);
    });
    log("open", { kind: side.kind, phones: room.phones.size });
  }

  function acceptHost(ws, name) {
    const room = roomFor(name);
    // One computer socket per room: a new one replaces the old.
    if (room.host) end(name, room, room.host, 4000, "replaced");
    const side = { kind: "host", notified: false };
    room.host = side;
    attach(ws, name, room, side);
  }

  function acceptPhone(ws, name, from) {
    const room = roomFor(name);
    // A new phone is never turned away. Its address's oldest socket makes room first, then the room's.
    const list = [...room.phones.values()].sort((a, b) => a.at - b.at);
    const closing = new Set();
    const same = list.filter((phone) => phone.from === from);
    if (same.length >= MAX_PER_FROM) closing.add(same[0]);
    if (list.length - closing.size >= MAX_PHONES) closing.add(list.find((phone) => !closing.has(phone)));
    for (const phone of closing) end(name, room, phone, 4008, "replaced");
    const conn = crypto.getRandomValues(new Uint8Array(8));
    const side = { kind: "phone", conn: hex(conn), from, ids: prefixed(conn, unhex(from)), at: Date.now(), notified: false };
    // The room may have been forgotten while the oldest sockets closed; keep the live one.
    const live = roomFor(name);
    live.phones.set(side.conn, side);
    attach(ws, name, live, side);
  }

  async function forwardPush(request) {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    if (pushUpstream === "off") return Response.json({ error: "push_off" }, { status: 503 });
    const body = await readCappedText(request, MAX_PUSH_BODY);
    if (body === null) return Response.json({ error: "too_large" }, { status: 413 });
    try {
      const upstream = await fetch(pushUpstream.replace(/\/+$/, "") + "/v1/push", {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      return new Response(await upstream.text(), { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch {
      log("push_upstream_unreachable");
      return Response.json({ error: "upstream_unreachable" }, { status: 502 });
    }
  }

  async function invite(request, network, lookup) {
    if (!allowed("requests", network)) return plain("Too many requests", 429);
    if (!BASE64URL_43.test(lookup)) return plain("Not found", 404);
    if (request.method === "GET") {
      if (!allowed("invites", network)) return plain("Too many requests", 429);
      const card = invites.get(lookup);
      return card ? Response.json({ card: card.card }, { headers: { "cache-control": "no-store" } }) : plain("Not found", 404);
    }
    if (request.method === "PUT") {
      const checked = await checkInvitePut(request, lookup);
      if (checked instanceof Response) return checked;
      const current = invites.get(lookup);
      if (current && current.owner !== checked.owner) return plain("Forbidden", 403);
      invites.put(lookup, { ...checked.body, owner: checked.owner });
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      const checked = await checkInviteDelete(request, lookup);
      if (checked instanceof Response) return checked;
      const current = invites.get(lookup);
      if (!current) return plain("Not found", 404);
      if (current.owner !== checked.owner) return plain("Forbidden", 403);
      invites.delete(lookup);
      return new Response(null, { status: 204 });
    }
    return plain("Not found", 404);
  }

  /** Everything that is not a new socket, as the Worker answers it. */
  async function answer(request, network) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/push") {
      if (!allowed("requests", network)) return Response.json({ error: "rate_limited" }, { status: 429 });
      return forwardPush(request);
    }
    const inviteRoute = INVITE_ROUTE.exec(url.pathname);
    if (inviteRoute) return invite(request, network, inviteRoute[1]);
    if (!allowed("requests", network)) return plain("Too many requests", 429);
    if (request.method !== "GET") return plain("Not found", 404);
    if (url.pathname === "/") return plain("Botkins relay. Messages pass through sealed.");
    if (url.pathname === "/v1/health") return Response.json({ ok: true });
    if (url.pathname === "/join") return joinPage();
    if (url.pathname === "/pair") return pairPage(qrSource);
    const route = ROUTE.exec(url.pathname);
    if (!route || !ROOM_NAME.test(route[2])) return plain("Not found", 404);
    return plain("Expected a WebSocket", 426);
  }

  const toRequest = (req) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
    return new Request(new URL(req.url ?? "/", "http://relay.local"), { method: req.method, headers, body, duplex: "half" });
  };

  const server = createServer(async (req, res) => {
    try {
      const response = await answer(toRequest(req), networkFor(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Error\n");
    }
  });

  /** An answer on a socket that asked to upgrade and was refused: a plain HTTP response, then close. */
  async function refuse(socket, response) {
    const body = Buffer.from(await response.arrayBuffer());
    const head = [`HTTP/1.1 ${response.status} ${response.statusText || "Refused"}`, "Connection: close", `Content-Length: ${body.length}`];
    for (const [name, value] of response.headers) if (name !== "content-length") head.push(`${name}: ${value}`);
    socket.end(Buffer.concat([Buffer.from(head.join("\r\n") + "\r\n\r\n"), body]));
  }

  server.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    try {
      const network = networkFor(req);
      const url = new URL(req.url ?? "/", "http://relay.local");
      const route = ROUTE.exec(url.pathname);
      const room = route?.[2] ?? "";
      if (req.method !== "GET" || !route || !ROOM_NAME.test(room) || req.headers.upgrade?.toLowerCase() !== "websocket") {
        return refuse(socket, await answer(toRequest(req), network));
      }
      if (!allowed("sockets", network)) return refuse(socket, plain("Too many requests", 429));
      const offered = String(req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (route[1] === "host") {
        if (!(await hostProof(offered, room, Math.floor(Date.now() / 1000)))) return refuse(socket, plain("Unauthorized", 401));
        hosts.handleUpgrade(req, socket, head, (ws) => acceptHost(ws, room));
      } else {
        if (!offered.includes(PHONE_PROTOCOL)) return refuse(socket, plain("Bad request", 400));
        // `from` stands for the client's network without revealing it, and differs per room.
        const from = hex((await sha256(room + ":" + network)).subarray(0, 8));
        phones.handleUpgrade(req, socket, head, (ws) => acceptPhone(ws, room, from));
      }
    } catch {
      socket.destroy();
    }
  });

  server.on("close", () => clearInterval(sweeper));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8080);
  const server = createRelay({
    dataDir: process.env.DATA_DIR || undefined,
    pushUpstream: process.env.PUSH_UPSTREAM || DEFAULT_PUSH_UPSTREAM,
    clientIpHeader: process.env.CLIENT_IP_HEADER || undefined,
    limits: process.env.RATE_LIMITS !== "off",
    qrFile: process.env.QR_FILE || undefined,
  });
  server.listen(port, process.env.HOST || "0.0.0.0", () => log("listening", { code: port }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));
}
