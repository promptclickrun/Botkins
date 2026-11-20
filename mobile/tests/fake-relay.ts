// The Botkins relay, in memory, for tests. It behaves like the real one (relay/src/index.ts, a
// Cloudflare Worker with one Durable Object per room), and this header is the relay's wire format.
//
// WHY A RELAY. A phone that is away from the computer's network can't reach it. The computer keeps
// one outgoing WebSocket open to the relay; the phone opens one too; the relay passes messages
// between them. Every message it passes is one of the link's own requests or answers, which are
// already sealed end to end (see link-host/server.mjs), so the relay learns sizes and timing only.
//
// ROOMS. The computer makes an Ed25519 key pair and keeps the private key. Its room is
//   room = base64url(SHA-256("botkins-relay-room-v1:" + base64url(publicKey)))     (43 characters)
// Only the computer can prove it owns a room (it signs with the key; nothing secret is ever sent,
// so the relay's operator can't take the seat later). Anyone who knows the room's name can knock,
// and the computer's own checks (pairing code, device keys, sessions) decide what gets in.
//
// SOCKETS.
//   Computer:  wss://<relay>/v1/host/<room>
//              subprotocols ["botkins.host.v2", "k." + base64url(publicKey), "t." + seconds, "s." + base64url(signature)]
//              `seconds` is the Unix time now; the signature is Ed25519 over the UTF-8 text
//              "botkins-relay-host-v2:" + room + ":" + seconds. The relay lets the socket in when the
//              key gives this room, the time is within 300 seconds of its own, and the signature holds.
//              Anything else is refused (the socket fails to open).
//   Phone:     wss://<relay>/v1/room/<room>   subprotocols ["botkins.phone.v1"]
//   A room has one computer socket (a new one replaces the old, which is closed with 4000).
//   A room has up to 48 phone sockets, and up to 8 from one network address (`from`, below). A new
//   phone socket is never turned away: when its address already has 8, that address's oldest socket
//   is closed with 4008; then, when the room has 48, the room's oldest is closed with 4008.
//   The text message "ping" is answered with "pong" on either socket; nothing else is text.
//
// MESSAGES (binary; numbers are big-endian).
//   Phone → relay        [0x01][id u32][route u8][n u8][session: n ASCII bytes][body…]      a request
//                        route: 1 hello, 2 pair, 3 session, 4 rpc. `session` is the rpc call's
//                        session id (empty for the other routes). `body` is the HTTP body the phone
//                        would have posted (empty for hello).
//   Relay → computer     [conn 8][from 8] + the phone's message, unchanged
//                        `conn` names the phone's socket; `from` stands for the phone's network
//                        address (the same for every socket from one address; for IPv6, from one
//                        /64), for rate limits. It is 8 bytes of SHA-256(room + ":" + address).
//   Computer → relay     [conn 8][0x02][id u32][status u16][body…]                           an answer
//   Relay → phone        the same without the first 8 bytes: [0x02][id u32][status u16][body…]
//   Relay → phone        [0x03][id u32]            the computer isn't connected; nothing was passed on
//   Relay → computer     [conn 8][from 8][0x04]    that phone's socket closed
//   Relay → every phone  [0x05]                    the computer's socket closed: whatever the phone
//                                                  still waits for will not be answered
//   A computer's message over 8 MiB, or a phone's over 6 MiB + 64 KiB, closes the socket that sent
//   it (1009). An answer for a `conn` that is gone is dropped.
import { createHash, createPublicKey, verify } from "node:crypto";

export const HOST_PROTOCOL = "botkins.host.v2";
export const PHONE_PROTOCOL = "botkins.phone.v1";
export const MAX_MESSAGE = 8 * 1024 * 1024;
export const MAX_PHONE_MESSAGE = 6 * 1024 * 1024 + 64 * 1024;
export const MAX_PHONES = 48;
export const MAX_PER_FROM = 8;
export const MAX_SKEW = 300;

/** The room of a computer's relay key (the raw 32-byte Ed25519 public key, base64url). */
export const roomOf = (publicKey: string) => createHash("sha256").update("botkins-relay-room-v1:" + publicKey).digest("base64url");
/** What the computer signs to take its seat. */
export const hostChallenge = (room: string, seconds: number | string) => "botkins-relay-host-v2:" + room + ":" + seconds;

/** Whether a computer's offer (its subprotocols) proves it owns `room` at the relay's time `now` (seconds). */
export function hostProof(offered: string[], room: string, now: number): boolean {
  const one = (prefix: string) => {
    const found = offered.filter((entry) => entry.startsWith(prefix));
    return found.length === 1 ? found[0].slice(prefix.length) : null;
  };
  const [publicKey, seconds, signature] = [one("k."), one("t."), one("s.")];
  if (!offered.includes(HOST_PROTOCOL) || !publicKey || !seconds || !signature || !/^\d{1,12}$/.test(seconds)) return false;
  if (roomOf(publicKey) !== room || Math.abs(now - Number(seconds)) > MAX_SKEW) return false;
  try {
    const raw = Buffer.from(publicKey, "base64url");
    if (raw.length !== 32) return false;
    // A raw Ed25519 public key, wrapped as the DER that Node reads.
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(hostChallenge(room, seconds)), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

type Listener = ((event: any) => void) | null;

/** The part of the WebSocket interface both ends use: the four `on…` handlers, `send`, `close`, `readyState`, `binaryType`. */
export class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  protocol = "";
  onopen: Listener = null;
  onmessage: Listener = null;
  onclose: Listener = null;
  onerror: Listener = null;
  /** Set by the relay when the socket is let in. */
  kind: "host" | "phone" | null = null;
  room = "";
  conn = new Uint8Array(8);
  from = new Uint8Array(8);
  sent = 0;
  constructor(
    public url: string,
    public protocols: string | string[] = [],
    private relay?: FakeRelay,
  ) {
    setTimeout(() => this.relay?.connect(this), 0);
  }
  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("The socket is not open");
    this.sent++;
    const message = typeof data === "string" ? data : data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
    setTimeout(() => this.relay?.receive(this, message), 0);
  }
  close(code = 1000, reason = "") {
    if (this.readyState >= FakeSocket.CLOSING) return;
    this.readyState = FakeSocket.CLOSING;
    setTimeout(() => this.relay?.closed(this, code, reason), 0);
  }
  /** Delivers a message from the relay. */
  deliver(data: string | Uint8Array) {
    if (this.readyState !== FakeSocket.OPEN) return;
    const payload = typeof data === "string" ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    setTimeout(() => this.readyState === FakeSocket.OPEN && this.onmessage?.({ data: payload }), 0);
  }
  /** Ends the socket from the relay's side. */
  end(code: number, reason = "") {
    if (this.readyState === FakeSocket.CLOSED) return;
    const opened = this.readyState !== FakeSocket.CONNECTING;
    this.readyState = FakeSocket.CLOSED;
    setTimeout(() => {
      if (!opened) this.onerror?.({ message: "The relay refused the connection" });
      this.onclose?.({ code, reason, wasClean: opened });
    }, 0);
  }
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const key = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export class FakeRelay {
  /** room → its sockets */
  private rooms = new Map<string, { host: FakeSocket | null; phones: Map<string, FakeSocket> }>();
  private next = 1;
  /** Every message the relay passed on, for tests that check what it could see. */
  passed: Uint8Array[] = [];
  /** The network address tag given to the next phone socket (8 bytes). */
  nextFrom = new Uint8Array(8);
  /** When true, new sockets fail to open (the relay is down). */
  down = false;
  /** The relay's clock, in seconds. Tests move it to try a computer whose clock is off. */
  now = () => Math.floor(Date.now() / 1000);

  /** A WebSocket class bound to this relay: `new relay.WebSocket(url, protocols)`. */
  get WebSocket() {
    const relay = this;
    return class extends FakeSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, relay);
      }
    } as unknown as typeof WebSocket;
  }

  private roomAt(name: string) {
    let room = this.rooms.get(name);
    if (!room) this.rooms.set(name, (room = { host: null, phones: new Map() }));
    return room;
  }
  hostOf(room: string) {
    return this.rooms.get(room)?.host ?? null;
  }
  phonesIn(room: string) {
    return [...(this.rooms.get(room)?.phones.values() ?? [])];
  }
  /** Cuts the computer's socket, as a network drop would. */
  dropHost(room: string) {
    const entry = this.rooms.get(room);
    if (!entry?.host) return;
    entry.host.end(1006);
    entry.host = null;
    this.hostLeft(entry);
  }
  /** Tells every phone in a room that the computer's socket is gone. */
  private hostLeft(room: { phones: Map<string, FakeSocket> }) {
    for (const phone of room.phones.values()) phone.deliver(Uint8Array.of(0x05));
  }
  /** Cuts every phone socket in a room. */
  dropPhones(room: string) {
    for (const phone of this.phonesIn(room)) this.closed(phone, 1006, "");
  }

  connect(socket: FakeSocket) {
    if (this.down) return socket.end(1006);
    const match = /^wss?:\/\/[^/]+\/v1\/(host|room)\/([A-Za-z0-9_-]{43})$/.exec(socket.url);
    const offered = Array.isArray(socket.protocols) ? socket.protocols : [socket.protocols];
    if (!match) return socket.end(1006);
    const [, kind, name] = match;
    if (kind === "host") {
      if (!hostProof(offered, name, this.now())) return socket.end(1006);
      const room = this.roomAt(name);
      if (room.host) {
        room.host.end(4000, "replaced");
        this.hostLeft(room);
      }
      room.host = socket;
      socket.kind = "host";
      socket.protocol = HOST_PROTOCOL;
    } else {
      if (!offered.includes(PHONE_PROTOCOL)) return socket.end(1006);
      const room = this.roomAt(name);
      socket.kind = "phone";
      socket.protocol = PHONE_PROTOCOL;
      socket.conn = new Uint8Array(8);
      new DataView(socket.conn.buffer).setUint32(4, this.next++);
      socket.from = this.nextFrom.slice();
      // A new phone always gets in. Its own address's oldest socket makes room first, then the room's.
      const oldest = (list: FakeSocket[]) => list[0];
      const same = [...room.phones.values()].filter((phone) => key(phone.from) === key(socket.from));
      if (same.length >= MAX_PER_FROM) this.closed(oldest(same), 4008, "replaced");
      if (room.phones.size >= MAX_PHONES) this.closed(oldest([...room.phones.values()]), 4008, "replaced");
      room.phones.set(key(socket.conn), socket);
    }
    socket.room = name;
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.({});
  }

  receive(socket: FakeSocket, message: string | Uint8Array) {
    if (socket.readyState !== FakeSocket.OPEN) return;
    if (typeof message === "string") {
      if (message === "ping") socket.deliver("pong");
      return;
    }
    if (message.length > (socket.kind === "phone" ? MAX_PHONE_MESSAGE : MAX_MESSAGE)) return this.closed(socket, 1009, "too big");
    const room = this.roomAt(socket.room);
    if (socket.kind === "phone") {
      if (!room.host || room.host.readyState !== FakeSocket.OPEN) {
        // Nothing is passed on: the phone is told at once, for a request it can name.
        if (message.length >= 5 && message[0] === 0x01) socket.deliver(concat(Uint8Array.of(0x03), message.subarray(1, 5)));
        return;
      }
      const forwarded = concat(socket.conn, socket.from, message);
      this.passed.push(forwarded);
      room.host.deliver(forwarded);
    } else if (socket.kind === "host") {
      if (message.length < 9) return;
      const phone = room.phones.get(key(message.subarray(0, 8)));
      if (!phone) return;
      this.passed.push(message);
      phone.deliver(message.subarray(8));
    }
  }

  closed(socket: FakeSocket, code: number, reason: string) {
    const room = this.rooms.get(socket.room);
    if (room && socket.kind === "host" && room.host === socket) {
      room.host = null;
      this.hostLeft(room);
    }
    if (room && socket.kind === "phone" && room.phones.delete(key(socket.conn))) room.host?.deliver(concat(socket.conn, socket.from, Uint8Array.of(0x04)));
    socket.end(code, reason);
  }
}
