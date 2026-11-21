// The self-hosted Botkins relay: the Cloudflare Worker's protocol (../src/index.ts) on plain Node, for a
// server that should not depend on relay.botkins.app. The checks that decide who may do what are the
// Worker's own code (../src/pure.ts, ../src/shared.ts), so both relays refuse the same things.
//
// It runs behind a TLS proxy (Caddy in deploy/azure). Rooms live in memory: a restart drops sockets, and
// computers and phones reconnect on their own. Invite cards are kept in DATA_DIR/invites.json, and the
// sealed copies of spaces shared by link in DATA_DIR/spaces (one file each, and spaces.json).
//
// It speaks both host protocols, as the Worker does. A botkins.host.v3 room has an active and a standby
// socket from one runtime group, keeps a bounded set of opaque requests so a host socket reset loses
// nothing, and acknowledges each answer to the host with 0x06. The Worker keeps that state in Durable
// Object storage and wakes on an alarm; here it is the room's own fields and one timer.
// Push notifications are forwarded, signed by the computer and unchanged, to PUSH_UPSTREAM, because only
// the Botkins relay holds the Apple key. Set PUSH_UPSTREAM=off to send none.
//
// Logs follow the Worker's rule: counts, socket kinds, close codes and fixed reasons, never a room name,
// key, lookup, card, `from` tag or message.

import { createServer } from "node:http";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { HOST_GROUP_LENGTH, HOST_PROTOCOL, HOST_PROTOCOL_V3, PHONE_PROTOCOL, hex, hostProof, hostProofV3, networkOf, sha256, unhex } from "../src/pure.ts";
import { spaceFrame, spacePage } from "../src/space.ts";
import {
  BASE64URL_22,
  BASE64URL_43,
  INVITE_ROUTE,
  MAX_MESSAGE,
  MAX_PENDING_BYTES,
  MAX_PENDING_REQUESTS,
  MAX_PER_FROM,
  MAX_PHONES,
  MAX_PHONE_MESSAGE,
  MAX_V3_HOSTS,
  NOTICE_ANSWER_ACCEPTED,
  NOTICE_HOST_CLOSED,
  NOTICE_OFFLINE,
  NOTICE_PHONE_CLOSED,
  PAGE_CSS,
  PENDING_LIFE,
  REQUEST,
  ROOM_NAME,
  ROUTE,
  SPACE_PAGE_ROUTE,
  SPACE_ROUTE,
  V3_FAST_HEARTBEAT,
  V3_FAST_SILENCE,
  V3_LEGACY_SILENCE,
  V3_RECONNECT_WINDOW,
  V3_RESEAT_CLOSE,
  MAX_SPACE_BYTES_ALL,
  admitSpace,
  checkInviteDelete,
  checkInvitePut,
  checkSpaceDelete,
  checkSpacePut,
  joinPage,
  plain,
  prefixed,
  readCappedText,
  readU32,
  securePage,
  spaceGoneUntil,
  spacePutAllowed,
  u32Bytes,
} from "../src/shared.ts";

const MAX_PUSH_BODY = 64 * 1024;
const DEFAULT_PUSH_UPSTREAM = "https://relay.botkins.app";
// The Worker's limits (wrangler.jsonc), per network and per minute.
const LIMITS = { sockets: 30, requests: 120, invites: 20, spaces: 60 };
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

/**
 * The sealed copies of spaces shared by link, by share id: the Worker's Space and SpaceOwner. The bytes
 * are opaque here. Each copy is one file, and spaces.json holds when each was signed and ends, and the
 * signed time of each recent DELETE, so a restart keeps them.
 */
class Spaces {
  constructor(dir, max = MAX_SPACE_BYTES_ALL) {
    this.dir = dir;
    /** All copies together, in bytes. */
    this.max = max;
    /** share id → { owner, time, expiresAt, size, body? } (`body` only without a folder). */
    this.copies = new Map();
    /** share id → the signed time (seconds) of its last DELETE. */
    this.gone = new Map();
    /** owner key → the minute's count of puts. What it holds is counted from `copies`. */
    this.puts = new Map();
    if (!dir) return;
    try {
      const saved = JSON.parse(readFileSync(join(dir, "spaces.json"), "utf8"));
      for (const [id, copy] of Object.entries(saved.copies ?? {})) {
        if (BASE64URL_22.test(id) && copy && typeof copy.owner === "string" && Number.isSafeInteger(copy.time) && Number.isSafeInteger(copy.expiresAt) && Number.isSafeInteger(copy.size)) this.copies.set(id, copy);
      }
      for (const [id, time] of Object.entries(saved.gone ?? {})) if (BASE64URL_22.test(id) && Number.isSafeInteger(time)) this.gone.set(id, time);
    } catch {
      // No file yet, or one that can't be read: start empty.
    }
    // A file that no copy stands for (the relay stopped between writing it and noting it) is removed.
    try {
      for (const name of readdirSync(join(dir, "spaces"))) if (!this.copies.has(name.replace(/\.bin$/, ""))) rmSync(join(dir, "spaces", name), { force: true });
    } catch {
      // No folder yet.
    }
    this.sweep();
  }
  file(id) {
    return join(this.dir, "spaces", id + ".bin");
  }
  held(id) {
    const copy = this.copies.get(id);
    return copy && copy.expiresAt > Date.now() ? copy : null;
  }
  goneAt(id) {
    const time = this.gone.get(id);
    return time !== undefined && spaceGoneUntil(time) > Date.now() ? time : null;
  }
  read(id) {
    const copy = this.held(id);
    if (!copy) return null;
    if (!this.dir) return copy.body;
    try {
      const body = readFileSync(this.file(id));
      return body.length === copy.size ? body : null;
    } catch {
      return null;
    }
  }
  /**
   * 204, 409 when the copy is not newer than what is held or was taken back, 429 when the computer has
   * too many, too much or puts too often, 507 when all copies together would be over what this relay holds.
   */
  put(id, { owner, body, expiresAt, time }) {
    const now = Date.now();
    const live = Object.fromEntries([...this.copies].filter(([, copy]) => copy.owner === owner && copy.expiresAt > now).map(([key, copy]) => [key, { until: copy.expiresAt, size: copy.size }]));
    const admitted = admitSpace({ live, puts: this.puts.get(owner) }, id, expiresAt, body.length, now);
    if (!admitted) return 429;
    let all = body.length;
    for (const [key, copy] of this.copies) if (key !== id && copy.expiresAt > now) all += copy.size;
    if (all > this.max && body.length > (this.held(id)?.size ?? 0)) return 507;
    this.puts.set(owner, admitted.puts);
    if (!spacePutAllowed(this.held(id)?.time ?? null, this.goneAt(id), time)) return 409;
    if (this.dir) {
      mkdirSync(join(this.dir, "spaces"), { recursive: true, mode: 0o700 });
      writeFileSync(this.file(id) + ".tmp", body, { mode: 0o600 });
      renameSync(this.file(id) + ".tmp", this.file(id));
    }
    this.copies.set(id, { owner, time, expiresAt, size: body.length, ...(!this.dir && { body: Buffer.from(body) }) });
    this.save();
    return 204;
  }
  /** 204, 404 when nothing was held, 409 when the DELETE is not later than the copy. */
  delete(id, time) {
    const copy = this.held(id);
    if (copy && time <= copy.time) return 409;
    this.gone.set(id, Math.max(this.goneAt(id) ?? 0, time));
    this.drop(id);
    this.save();
    return copy ? 204 : 404;
  }
  drop(id) {
    this.copies.delete(id);
    if (this.dir) rmSync(this.file(id), { force: true });
  }
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, copy] of this.copies) {
      if (copy.expiresAt > now) continue;
      this.drop(id);
      changed = true;
    }
    for (const [id, time] of this.gone) if (spaceGoneUntil(time) <= now) changed = this.gone.delete(id) || changed;
    for (const [owner, puts] of this.puts) if (now - puts.start >= WINDOW_MS) this.puts.delete(owner);
    if (changed) this.save();
  }
  save() {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, "spaces.json");
    writeFileSync(file + ".tmp", JSON.stringify({ copies: Object.fromEntries(this.copies), gone: Object.fromEntries(this.gone) }), { mode: 0o600 });
    renameSync(file + ".tmp", file);
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
 *   botkinsDir     the folder of Botkin pictures a shared space's page shows (the phone app's assets/botkins)
 *   spaceBytesMax  how much all copies of shared spaces may take together (1 GiB)
 */
export function createRelay({ dataDir, pushUpstream = DEFAULT_PUSH_UPSTREAM, clientIpHeader, limits = true, qrFile, botkinsDir, spaceBytesMax, fetch = globalThis.fetch } = {}) {
  const invites = new Invites(dataDir ? join(dataDir, "invites.json") : null);
  const spaces = new Spaces(dataDir || null, spaceBytesMax);
  const sweeper = setInterval(() => (invites.sweep(), spaces.sweep()), WINDOW_MS);
  sweeper.unref();
  const limiters = { sockets: new Limiter(LIMITS.sockets), requests: new Limiter(LIMITS.requests), invites: new Limiter(LIMITS.invites), spaces: new Limiter(LIMITS.spaces) };
  const spacePageScript = readFileSync(new URL("../src/space-page.js.txt", import.meta.url), "utf8");
  const spaceFrameScript = readFileSync(new URL("../src/space-frame.js.txt", import.meta.url), "utf8");
  const pictures = botkinsDir ?? fileURLToPath(new URL("../../assets/botkins", import.meta.url));
  const allowed = (kind, network) => !limits || limiters[kind].allow(network);
  const qrSource = loadQrSource(qrFile ?? fileURLToPath(new URL("../../link-host/vendor/qrcode.mjs", import.meta.url)));
  /** name → Room. A room is dropped once it has no socket and nothing left to remember. */
  const rooms = new Map();
  const hosts = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, handleProtocols: (_offered, req) => req.relayProtocol });
  const phones = new WebSocketServer({ noServer: true, maxPayload: MAX_PHONE_MESSAGE, handleProtocols: () => PHONE_PROTOCOL });
  const GROUP = new RegExp(`^[A-Za-z0-9_-]{${HOST_GROUP_LENGTH}}$`);

  const networkFor = (req) => {
    const header = clientIpHeader && req.headers[clientIpHeader.toLowerCase()];
    const value = Array.isArray(header) ? header.at(-1) : header;
    const address = value ? value.split(",").at(-1).trim() : req.socket.remoteAddress;
    return networkOf(address || "local");
  };
  const send = (ws, data) => {
    if (ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(data, { binary: typeof data !== "string" });
      return true;
    } catch {
      // The socket closed between the check and the send.
      return false;
    }
  };
  const isRequest = (bytes) => bytes.length >= 5 && bytes[0] === REQUEST;
  const offline = (requestId) => prefixed(Uint8Array.of(NOTICE_OFFLINE), u32Bytes(requestId));

  /**
   * One room: the Worker's Room (../src/index.ts), with its storage as plain fields. Every method runs
   * to its end without waiting, so no two events interleave. The method names and their order of work
   * follow the Worker's, so the two can be read side by side.
   */
  class Room {
    constructor(name) {
      this.name = name;
      /** Host sockets: { kind, ws, version, group, role, openedAt, lastBinaryAt, lastPingAt, heartbeat, notified, closing }. */
      this.hosts = [];
      /** conn (hex) → { kind, ws, conn, from, ids, at, notified }. */
      this.phones = new Map();
      /** The v3 reconnect window: { group, until, phones: [ids hex] }, or null. */
      this.recovery = null;
      /** The runtime group that last took the seat with v3, or null. */
      this.seat = null;
      /** Opaque requests kept for replay, and the ones already answered: the Worker's PendingState. */
      this.next = 1;
      this.total = 0;
      this.items = [];
      this.done = [];
      this.timer = null;
      this.due = Infinity;
    }

    openHosts() {
      return this.hosts.filter((side) => side.ws.readyState === side.ws.OPEN);
    }
    openPhones() {
      return [...this.phones.values()].filter((side) => side.ws.readyState === side.ws.OPEN);
    }
    openPhone(conn) {
      const side = this.phones.get(conn);
      return side && side.ws.readyState === side.ws.OPEN ? side : null;
    }
    activeHost() {
      const open = this.openHosts();
      return open.find((side) => side.role === "active") ?? open[0] ?? null;
    }

    /**
     * When a v3 host socket was last heard, and when it counts as silent. The Worker has to sample its
     * runtime's auto-response time at an alarm; this relay sees every ping, so it reads the cadence directly.
     */
    activity(side) {
      const last = Math.max(side.openedAt, side.lastBinaryAt ?? 0, side.lastPingAt ?? 0);
      return { last, deadline: last + (side.heartbeat === "fast" ? V3_FAST_SILENCE : V3_LEGACY_SILENCE) };
    }

    pinged(side) {
      if (side.kind !== "host" || side.version !== "v3") return;
      const now = Date.now();
      const interval = side.lastPingAt ? now - side.lastPingAt : 0;
      if (interval > 0 && !side.heartbeat) side.heartbeat = interval <= V3_FAST_HEARTBEAT ? "fast" : "legacy";
      side.lastPingAt = now;
    }

    acceptHost(ws, version, group) {
      const now = Date.now();
      const oldHosts = this.openHosts();
      let recovery = this.recovery;
      if (!oldHosts.length && !recovery && this.seat) recovery = this.beginRecovery(this.seat.group);
      const resume = version === "v3" && recovery?.group === group && recovery.until > now;
      const sameGroup = version === "v3" && oldHosts.length > 0 && oldHosts.every((side) => side.version === "v3" && side.group === group);
      let role = "active";
      let replayPending = resume;
      if (!sameGroup) {
        // v2 keeps its one-seat behavior. A v3 group may replace v2 or a distinct v3 runtime, but
        // sockets from one v3 group are active/standby peers and stay together.
        const replacingV3 = oldHosts.some((side) => side.version === "v3");
        const staleRecovery = !!recovery && (version !== "v3" || recovery.group !== group || recovery.until <= now);
        // A new incarnation must not inherit opaque requests from the old one.
        if (replacingV3 || staleRecovery) this.failRecovery(!(staleRecovery && !replacingV3 && oldHosts.length > 0));
        for (const old of oldHosts) this.end(old, 4000, "replaced");
      } else {
        // A reconnect from the same proven runtime is not a competing computer.
        const reseat = this.reseatSameGroup(oldHosts, now);
        role = reseat.role;
        replayPending ||= reseat.replay;
      }
      const side = { kind: "host", ws, version, group: version === "v3" ? group : undefined, role: version === "v3" ? role : "active", openedAt: now, notified: false, closing: false };
      this.hosts.push(side);
      if (version === "v3") {
        this.seat = { group };
        this.recovery = null;
        if (replayPending) {
          for (const ids of recovery?.phones ?? []) {
            if (!this.openPhone(ids.slice(0, 16))) send(ws, prefixed(unhex(ids), Uint8Array.of(NOTICE_PHONE_CLOSED)));
          }
          this.drainPending(side, true);
        }
      } else {
        this.seat = null;
        this.recovery = null;
        this.clearPending();
      }
      this.attach(side);
    }

    acceptPhone(ws, from) {
      // A new phone is never turned away. Its address's oldest socket makes room first, then the room's.
      const list = this.openPhones().sort((a, b) => a.at - b.at);
      const closing = new Set();
      const same = list.filter((phone) => phone.from === from);
      if (same.length >= MAX_PER_FROM) closing.add(same[0]);
      if (list.length - closing.size >= MAX_PHONES) closing.add(list.find((phone) => !closing.has(phone)));
      for (const phone of closing) this.end(phone, 4008, "replaced");
      const conn = crypto.getRandomValues(new Uint8Array(8));
      const side = { kind: "phone", ws, conn: hex(conn), from, ids: prefixed(conn, unhex(from)), at: Date.now(), notified: false };
      this.phones.set(side.conn, side);
      this.attach(side);
    }

    attach(side) {
      const { ws } = side;
      ws.on("message", (data, binary) => {
        if (!binary) {
          // Any other text is ignored.
          if (data.toString() !== "ping") return;
          this.pinged(side);
          send(ws, "pong");
        } else {
          this.message(side, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
        this.settle();
      });
      ws.on("close", (code) => {
        log("close", { kind: side.kind, code });
        this.closed(side);
      });
      ws.on("error", () => {
        log("error", { kind: side.kind });
        this.closed(side);
      });
      log("open", { kind: side.kind, phones: this.openPhones().length });
      this.settle();
    }

    message(side, bytes) {
      if (side.ws.readyState !== side.ws.OPEN) return;
      if (side.kind === "phone") {
        const host = this.activeHost();
        if (!host) {
          // A v3 host has a short reconnect window. Keep opaque requests for that window; a v2 room
          // still gets the immediate per-request offline answer.
          if (!this.recovery && this.seat) this.beginRecovery(this.seat.group);
          const held = this.recovery && this.recovery.until > Date.now() ? this.storePending(side.ids, bytes) : null;
          if (!held && isRequest(bytes)) send(side.ws, offline(readU32(bytes, 1)));
          return;
        }
        if (host.version !== "v3") {
          send(host.ws, prefixed(side.ids, bytes));
          return;
        }
        if (!isRequest(bytes)) return;
        // If a reconnect just drained held requests, they keep their arrival order before a new one.
        this.drainPending(host);
        const pending = this.storePending(side.ids, bytes);
        if (!pending) send(side.ws, offline(readU32(bytes, 1)));
        else if (send(host.ws, prefixed(side.ids, bytes))) pending.sent = true;
        return;
      }
      if (side.closing) return;
      if (side.version === "v3") side.lastBinaryAt = Date.now();
      // [conn 8] + the answer. A short message, or a phone that is gone, is dropped.
      if (bytes.length < 9) return;
      if (side.version === "v3" && bytes.length >= 13 && bytes[8] === 0x02) {
        const accepted = this.ackPending(bytes.subarray(0, 8), readU32(bytes, 9));
        if (!accepted) return;
        // The host can now evict its replay cache; a duplicate answer gets the same acknowledgement.
        send(side.ws, prefixed(unhex(accepted.ids), prefixed(Uint8Array.of(NOTICE_ANSWER_ACCEPTED), u32Bytes(accepted.requestId))));
        if (accepted.duplicate) return;
      }
      const phone = this.openPhone(hex(bytes.subarray(0, 8)));
      if (phone) send(phone.ws, bytes.subarray(8));
    }

    /** A socket is gone, by its own close or by an error. `ws` reports both, so the second call finds nothing to do. */
    closed(side) {
      const first = !side.notified && !side.closing;
      if (side.kind === "host") this.hosts = this.hosts.filter((entry) => entry !== side);
      else if (this.phones.get(side.conn) === side) this.phones.delete(side.conn);
      this.ended(side);
      if (side.kind === "host" && first) this.hostEnded(side);
      if (side.kind === "phone") this.dropPendingFor(side.ids);
      this.settle();
    }

    /**
     * Same-group replacement repairs one runtime's two-seat transport; it is not a takeover. With two
     * seats, the newest proven socket is always active and the survivor is standby. The close code is
     * not 4000, which tells a host that a different computer took the room.
     */
    reseatSameGroup(hosts, now) {
      const ordered = hosts.map((side) => ({ side, ...this.activity(side) }));
      if (!ordered.length) return { role: "active", replay: true };
      const active = ordered.find((entry) => entry.side.role === "active") ?? ordered[0];
      const staleActive = active.deadline <= now;
      // The first standby joins before either ping has fired. That alone is not evidence of a dead active.
      if (ordered.length < MAX_V3_HOSTS && !staleActive) return { role: "standby", replay: false };
      // Two open seats are a full re-seat, even when both recently answered a ping: the new proven
      // socket must be the active route. The least recently heard seat goes, the survivor is standby.
      const leastRecent = [...ordered].sort((a, b) => a.last - b.last || a.side.openedAt - b.side.openedAt)[0];
      this.end(leastRecent.side, V3_RESEAT_CLOSE, "replaced");
      for (const entry of ordered) if (entry !== leastRecent) entry.side.role = "standby";
      return { role: "active", replay: true };
    }

    /** The room's one timer fired: the Worker's alarm. */
    expire() {
      this.timer = null;
      this.due = Infinity;
      const now = Date.now();
      this.reapStaleHosts(now);
      if (this.recovery && this.activeHost()) this.recovery = null;
      // The old runtime did not return. Fail both queued and in-flight phones once.
      else if (this.recovery && this.recovery.until <= now) this.failRecovery();
      this.expirePending(now);
      this.settle();
    }

    reapStaleHosts(now) {
      const entries = this.openHosts().filter((side) => side.version === "v3");
      const stale = entries.filter((side) => this.activity(side).deadline <= now);
      if (!stale.length) return;
      const active = entries.find((side) => side.role === "active") ?? entries[0];
      const staleActive = stale.includes(active);
      const victims = staleActive ? stale : stale.filter((side) => side !== active);
      for (const victim of victims) this.end(victim, V3_RESEAT_CLOSE, "replaced");
      const survivors = entries.filter((side) => !victims.includes(side));
      if (staleActive && survivors.length) {
        survivors.forEach((side, at) => (side.role = at === 0 ? "active" : "standby"));
        this.drainPending(survivors[0], true);
      } else if (!survivors.length && stale[0].group) {
        this.beginRecovery(stale[0].group);
      }
    }

    beginRecovery(group, leaving) {
      if (this.openHosts().length) return null;
      if (this.recovery?.group === group) return this.recovery;
      // Every phone the computer has not been told about. One whose close has begun counts too: `ws`
      // reports a close only when the connection is gone, so a phone and the computer leaving together
      // can arrive here in either order.
      const ids = [...this.phones.values()].filter((side) => !side.notified).map((side) => hex(side.ids));
      if (leaving && !ids.includes(hex(leaving))) ids.push(hex(leaving));
      this.recovery = { group, until: Date.now() + V3_RECONNECT_WINDOW, phones: ids };
      return this.recovery;
    }

    hostEnded(side) {
      const other = this.openHosts();
      if (other.length) {
        if (side.version !== "v3") return;
        const currentActive = other.find((entry) => entry.role === "active");
        const standby = side.role === "active" || !currentActive ? (other.find((entry) => entry.role !== "active") ?? other[0]) : null;
        if (standby) {
          standby.role = "active";
          this.drainPending(standby, true);
        }
        return;
      }
      if (side.version === "v3" && side.group) {
        this.beginRecovery(side.group);
      } else {
        this.seat = null;
        this.clearPending(true);
        this.recovery = null;
      }
    }

    /** Ends a v3 reconnect window or an explicit cross-runtime takeover. */
    failRecovery(notify = true) {
      this.clearPending(true);
      this.recovery = null;
      this.seat = null;
      if (notify) for (const phone of this.openPhones()) send(phone.ws, Uint8Array.of(NOTICE_HOST_CLOSED));
    }

    pruneDone(now = Date.now()) {
      this.done = this.done.filter((entry) => entry.at + PENDING_LIFE > now).slice(-128);
    }

    storePending(ids, body) {
      if (!isRequest(body) || body.length > MAX_PHONE_MESSAGE) return null;
      if (this.items.length >= MAX_PENDING_REQUESTS || this.total + body.length > MAX_PENDING_BYTES) return null;
      const conn = hex(ids);
      const requestId = readU32(body, 1);
      const now = Date.now();
      this.pruneDone(now);
      const same = (entry) => entry.ids === conn && entry.requestId === requestId;
      if (this.items.some(same) || this.done.some(same)) return null;
      // A copy: the bytes the socket handed over belong to its read buffer.
      const item = { id: this.next, ids: conn, requestId, size: body.length, at: now, sent: false, body: body.slice() };
      this.next = this.next < 2_000_000_000 ? this.next + 1 : 1;
      this.items.push(item);
      this.total += item.size;
      return item;
    }

    removePending(item) {
      this.items = this.items.filter((entry) => entry !== item);
      this.total -= item.size;
      this.done.push({ ids: item.ids, requestId: item.requestId, at: Date.now() });
    }

    drainPending(host, force = false) {
      for (const item of [...this.items]) {
        if (item.sent && !force) continue;
        if (!send(host.ws, prefixed(unhex(item.ids), item.body))) break;
        item.sent = true;
      }
    }

    ackPending(conn, requestId) {
      this.pruneDone();
      const prefix = hex(conn);
      const same = (entry) => entry.requestId === requestId && entry.ids.startsWith(prefix);
      const item = this.items.find(same);
      if (!item) {
        const done = this.done.find(same);
        return done ? { ...done, duplicate: true } : null;
      }
      this.removePending(item);
      return { ids: item.ids, requestId, duplicate: false };
    }

    dropPendingFor(ids) {
      const prefix = hex(ids);
      this.items = this.items.filter((item) => item.ids !== prefix);
      this.total = this.items.reduce((sum, item) => sum + item.size, 0);
      this.done = this.done.filter((item) => item.ids !== prefix);
    }

    clearPending(keepDone = false) {
      this.items = [];
      this.total = 0;
      if (!keepDone) this.done = [];
    }

    expirePending(now) {
      for (const item of this.items.filter((entry) => entry.at + PENDING_LIFE <= now)) {
        const phone = this.openPhone(item.ids.slice(0, 16));
        if (phone) send(phone.ws, offline(item.requestId));
        this.removePending(item);
      }
      this.pruneDone(now);
    }

    /** Tells the other side, once, that a socket is gone: the computer about a phone, every phone about the computer. */
    ended(side) {
      if (side.notified) return;
      side.notified = true;
      if (side.kind === "phone") {
        const host = this.activeHost();
        if (host) send(host.ws, prefixed(side.ids, Uint8Array.of(NOTICE_PHONE_CLOSED)));
        else if (this.seat) this.beginRecovery(this.seat.group, side.ids);
      } else if (side.version !== "v3") {
        // What the phones still wait for will not be answered; they can try again at once. A v3
        // standby is already a usable seat, so its active peer disappearing is silent.
        for (const phone of this.openPhones()) send(phone.ws, Uint8Array.of(NOTICE_HOST_CLOSED));
      }
    }

    /** Closes a socket from this side, to make room for another. The reason is one of our own fixed words. */
    end(side, code, reason) {
      log("drop", { kind: side.kind, code, reason });
      if (side.kind === "host") side.closing = true;
      try {
        side.ws.close(code, reason);
      } catch {
        side.ws.terminate();
      }
      this.ended(side);
    }

    /** After every event: set the timer for the next deadline, and drop the room when nothing is left. */
    settle() {
      const times = [
        this.recovery?.until ?? Infinity,
        ...this.openHosts().map((side) => (side.version === "v3" ? this.activity(side).deadline : Infinity)),
        ...this.items.map((item) => item.at + PENDING_LIFE),
        ...this.done.map((item) => item.at + PENDING_LIFE),
      ];
      const due = Math.min(...times);
      if (due !== this.due) {
        clearTimeout(this.timer);
        this.timer = null;
        this.due = due;
        if (Number.isFinite(due)) {
          // Never sooner than a few milliseconds, so a deadline that is not yet due cannot spin.
          this.timer = setTimeout(() => this.expire(), Math.max(5, due - Date.now()));
          this.timer.unref();
        }
      }
      if (!this.hosts.length && !this.phones.size && !this.recovery && !this.seat && !this.items.length && !this.done.length && rooms.get(this.name) === this) {
        rooms.delete(this.name);
      }
    }
  }

  const roomFor = (name) => {
    let room = rooms.get(name);
    if (!room) rooms.set(name, (room = new Room(name)));
    return room;
  };

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

  /** A space's sealed copy: put and taken back by its computer, read by anyone with the link. */
  async function space(request, network, shareId) {
    if (!allowed("requests", network)) return plain("Too many requests", 429);
    if (!BASE64URL_22.test(shareId)) return plain("Not found", 404);
    if (request.method === "GET") {
      if (!allowed("spaces", network)) return plain("Too many requests", 429);
      const body = spaces.read(shareId);
      if (!body) return plain("Not found", 404);
      return new Response(body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
    const status = { 204: () => new Response(null, { status: 204 }), 404: () => plain("Not found", 404), 409: () => plain("Conflict", 409), 429: () => plain("Too many requests", 429), 507: () => plain("Insufficient storage", 507) };
    if (request.method === "PUT") {
      const checked = await checkSpacePut(request, shareId);
      return checked instanceof Response ? checked : status[spaces.put(shareId, checked)]();
    }
    if (request.method === "DELETE") {
      const checked = await checkSpaceDelete(request, shareId);
      return checked instanceof Response ? checked : status[spaces.delete(shareId, checked.time)]();
    }
    return plain("Not found", 404);
  }

  /** A Botkin picture for a shared space's page. Only a plain name: nothing else in the folder is reachable. */
  function picture(name) {
    if (!/^[a-z0-9]+-[a-z]+\.webp$/.test(name)) return plain("Not found", 404);
    try {
      return new Response(readFileSync(join(pictures, name)), { headers: { "content-type": "image/webp", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
    } catch {
      return plain("Not found", 404);
    }
  }

  /** Everything that is not a new socket, as the Worker answers it. */
  async function answer(request, network) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/push") {
      if (!allowed("requests", network)) return Response.json({ error: "rate_limited" }, { status: 429 });
      return forwardPush(request);
    }
    const spaceRoute = SPACE_ROUTE.exec(url.pathname);
    if (spaceRoute) return space(request, network, spaceRoute[1]);
    const inviteRoute = INVITE_ROUTE.exec(url.pathname);
    if (inviteRoute) return invite(request, network, inviteRoute[1]);
    if (!allowed("requests", network)) return plain("Too many requests", 429);
    if (request.method !== "GET") return plain("Not found", 404);
    if (url.pathname === "/") return plain("Botkins relay. Messages pass through sealed.");
    if (url.pathname === "/v1/health") return Response.json({ ok: true });
    if (url.pathname === "/join") return joinPage();
    if (url.pathname === "/pair") return pairPage(qrSource);
    if (url.pathname === "/s/frame") return spaceFrame(spaceFrameScript);
    if (url.pathname.startsWith("/s/botkin/")) return picture(url.pathname.slice("/s/botkin/".length));
    const page = SPACE_PAGE_ROUTE.exec(url.pathname);
    if (page) return BASE64URL_22.test(page[1]) ? spacePage(spacePageScript) : plain("Not found", 404);
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
        // The computer proves it owns the room by signing with the key the room is a hash of.
        const now = Math.floor(Date.now() / 1000);
        const v3 = offered.includes(HOST_PROTOCOL_V3);
        const group = v3 ? (offered.find((entry) => entry.startsWith("g."))?.slice(2) ?? "") : "";
        if (v3 ? !(await hostProofV3(offered, room, now)) || !GROUP.test(group) : !(await hostProof(offered, room, now))) {
          return refuse(socket, plain("Unauthorized", 401));
        }
        req.relayProtocol = v3 ? HOST_PROTOCOL_V3 : HOST_PROTOCOL;
        hosts.handleUpgrade(req, socket, head, (ws) => roomFor(room).acceptHost(ws, v3 ? "v3" : "v2", group));
      } else {
        if (!offered.includes(PHONE_PROTOCOL)) return refuse(socket, plain("Bad request", 400));
        // `from` stands for the client's network without revealing it, and differs per room.
        const from = hex((await sha256(room + ":" + network)).subarray(0, 8));
        phones.handleUpgrade(req, socket, head, (ws) => roomFor(room).acceptPhone(ws, from));
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
    botkinsDir: process.env.BOTKINS_DIR || undefined,
    spaceBytesMax: Number(process.env.SPACE_BYTES_MAX) || undefined,
  });
  server.listen(port, process.env.HOST || "0.0.0.0", () => log("listening", { code: port }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));
}
