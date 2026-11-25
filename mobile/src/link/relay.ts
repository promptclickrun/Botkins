// The phone's end of the relay: how a phone away from the computer's network still reaches it.
// The computer keeps an active socket and, with v3, a standby; the phone opens one too, and the relay
// passes the link's own (already sealed) requests, intermediate 0x07 follow parts and final answers between them. The wire format is the
// header of tests/fake-relay.ts. Nothing here depends on React Native or Node.
//
// A relay address is one more entry in the saved host list: `relay!<room>@<authority>`. The client
// builds URLs from host entries as `http://<entry>/botkins/v1/<route>`, so `relayFetch` wraps a
// fetch and carries every URL whose host is such an entry over the socket; the rest go untouched.
import { type ResourceHandle, trackResource } from "../state/ledger";
import type { FetchLike } from "./client";
import { fromUtf8, utf8 } from "./crypto";

export const PHONE_PROTOCOL = "botkins.phone.v1";
/** The relay closes a socket that sends more than this. */
const MAX_MESSAGE = 8 * 1024 * 1024;

const RELAY_ENTRY = /^relay!([A-Za-z0-9_-]{43})@(.+)$/;
// A plain host name or address with an optional port. `[::1]` is the one bracketed literal (loopback).
const AUTHORITY = /^(\[::1\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/;

export type RelayHost = {
  /** The entry as saved: `relay!<room>@<authority>`. */
  entry: string;
  room: string;
  /** The relay's address: host, and port when it has one. */
  authority: string;
  host: string;
  /** The socket to open: wss://<authority>/v1/room/<room> (ws:// only for loopback). */
  url: string;
};

/** Reads a `relay!<room>@<authority>` entry. Null when it is not one, or is malformed. */
export function parseRelayHost(entry: string): RelayHost | null {
  const match = RELAY_ENTRY.exec(entry);
  if (!match) return null;
  const [, room, authority] = match;
  const parts = AUTHORITY.exec(authority);
  if (!parts || parts[1].includes("..")) return null;
  if (parts[2] !== undefined && (Number(parts[2]) < 1 || Number(parts[2]) > 65535)) return null;
  const host = parts[1];
  const loopback = host === "127.0.0.1" || host.toLowerCase() === "localhost" || host === "[::1]";
  return { entry, room, authority, host, url: (loopback ? "ws://" : "wss://") + authority + "/v1/room/" + room };
}

export const isRelayHost = (entry: string) => parseRelayHost(entry) !== null;

/** The saved entry for a room on a relay. */
export const makeRelayHost = (room: string, authority: string) => "relay!" + room + "@" + authority;

type Listener = ((event: any) => void) | null;
/** The part of the WebSocket interface the relay uses (React Native's and Node's sockets have it). */
export type RelaySocket = {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: Listener;
  onmessage: Listener;
  onclose: Listener;
  onerror: Listener;
};
export type RelaySocketClass = new (url: string, protocols?: string | string[]) => RelaySocket;

export type RelayOptions = {
  /** The socket class. Defaults to the engine's WebSocket. */
  WebSocket?: RelaySocketClass;
  /** A socket with nothing pending closes after this long. Default 30 s. */
  idleMs?: number;
  /** A socket that has not opened by then has failed. Default 8 s. */
  connectMs?: number;
  /** While a request is pending, "ping" is sent this often. Default 25 s. */
  pingMs?: number;
  /** A socket that has heard nothing this long after a ping is dead. Default 10 s. */
  deadMs?: number;
};

/** The fetch `relayFetch` makes. `check` pings every open relay socket and ends those that stay silent for `ms` (3 s). `rest` closes sockets cleanly when the app goes to background (`force: true` closes even if a backgrounded request was still pending). */
export type RelayFetch = FetchLike & { supportsPush: true; check(ms?: number): void; rest(options?: { force?: boolean }): void };

const ROUTES: Record<string, number> = { hello: 1, pair: 2, session: 3, rpc: 4, join: 5, profile: 6 };
const URL_SHAPE = /^https?:\/\/([^/?#]+)\/botkins\/v1\/(hello|pair|session|rpc|join|profile)$/;
const OPEN = 1;
type Timer = ReturnType<typeof setTimeout>;
type Pending = { onPart?(part: Uint8Array): void; resolve(response: RelayResponse): void; reject(error: Error): void; frame: Uint8Array; settle(): void };
type RelayResponse = Awaited<ReturnType<FetchLike>>;

function respond(status: number, body: Uint8Array): RelayResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(fromUtf8(body)),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  };
}

const header = (headers: Record<string, string> | undefined, name: string) => {
  for (const key in headers) if (key.toLowerCase() === name) return headers[key];
  return "";
};

/** One socket's life: from `new WebSocket` to the close. A later request makes a new Conn. */
class Conn {
  socket: RelaySocket | null = null;
  opened = false;
  dead = false;
  /** A check is under way: the socket must be heard from before its deadline. */
  private checking = false;
  pending = new Map<number, Pending>();
  nextId = 0;
  private timers: { connect?: Timer; idle?: Timer; ping?: ReturnType<typeof setInterval>; dead?: Timer } = {};
  private socketLedger: ResourceHandle;
  private pingLedger?: ResourceHandle;

  constructor(
    private room: RelayHost,
    private options: Required<Omit<RelayOptions, "WebSocket">> & { WebSocket: RelaySocketClass },
    private gone: (conn: Conn) => void,
  ) {
    this.socketLedger = trackResource("socket", "relay", "room-socket", room.host);
    try {
      const socket = new options.WebSocket(room.url, [PHONE_PROTOCOL]);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => this.open();
      socket.onmessage = (event) => this.message(event?.data);
      socket.onerror = () => {};
      socket.onclose = () => this.finish(new Error("The relay connection closed"));
      this.timers.connect = setTimeout(() => this.finish(new Error("The relay didn't answer")), options.connectMs);
    } catch (error) {
      queueMicrotask(() => this.finish(error instanceof Error ? error : new Error("The relay can't be reached")));
    }
  }

  get usable() {
    return !this.dead && (!this.opened || this.socket?.readyState === OPEN);
  }

  /** A fresh id that no pending request holds. */
  allocate(): number {
    for (let tries = 0; tries <= 0xffffffff; tries++) {
      const id = this.nextId;
      this.nextId = (this.nextId + 1) >>> 0;
      if (!this.pending.has(id)) return id;
    }
    throw new Error("Too many requests are waiting");
  }

  add(id: number, pending: Pending) {
    this.pending.set(id, pending);
    if (this.opened) this.transmit(id, pending);
    this.watch();
  }

  forget(id: number) {
    this.pending.delete(id);
    this.watch();
  }

  private transmit(id: number, pending: Pending) {
    try {
      this.socket?.send(pending.frame);
    } catch (error) {
      this.pending.delete(id);
      pending.settle();
      pending.reject(error instanceof Error ? error : new Error("The relay can't be reached"));
      this.finish(new Error("The relay connection failed"));
    }
  }

  private open() {
    if (this.dead) return;
    this.opened = true;
    clearTimeout(this.timers.connect);
    for (const [id, pending] of [...this.pending]) if (!this.dead) this.transmit(id, pending);
    this.watch();
  }

  private message(data: unknown) {
    if (this.dead) return;
    // Anything at all from the relay shows the socket is alive.
    this.checking = false;
    clearTimeout(this.timers.dead);
    this.timers.dead = undefined;
    if (typeof data === "string" || !data) return;
    const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (bytes?.[0] === 0x05) {
      // The computer's own socket to the relay closed: nothing that is waiting will be answered.
      const waiting = [...this.pending.values()];
      this.pending.clear();
      for (const pending of waiting) {
        pending.settle();
        pending.reject(new Error("Your computer left the relay"));
      }
      return this.watch();
    }
    if (!bytes || bytes.length < 5) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = view.getUint32(1);
    const pending = this.pending.get(id);
    // An answer for a request that was given up on is ignored.
    if (!pending) return;
    if (bytes[0] === 0x07) {
      try {
        pending.onPart?.(bytes.subarray(5));
      } catch (error) {
        this.forget(id);
        pending.settle();
        pending.reject(error instanceof Error ? error : new Error("Invalid follow part"));
      }
      return;
    }
    if (bytes[0] === 0x02 && bytes.length >= 7) {
      this.pending.delete(id);
      pending.settle();
      pending.resolve(respond(view.getUint16(5), bytes.slice(7)));
      this.watch();
    } else if (bytes[0] === 0x03) {
      this.pending.delete(id);
      pending.settle();
      pending.reject(new Error("Your computer isn't connected to the relay"));
      this.watch();
    }
  }

  /** Starts or stops the timers to match what is pending. */
  private watch() {
    if (this.dead || !this.opened) return;
    const { timers, options } = this;
    if (this.pending.size > 0) {
      clearTimeout(timers.idle);
      timers.idle = undefined;
      if (!timers.ping) {
        this.pingLedger = trackResource("timer", "relay:ping", "keepalive", this.room.host);
        timers.ping = setInterval(() => {
          this.pingLedger?.bump();
          try {
            this.socket?.send("ping");
          } catch {
            return this.finish(new Error("The relay connection failed"));
          }
          timers.dead ??= setTimeout(() => this.finish(new Error("The relay stopped answering")), options.deadMs);
        }, options.pingMs);
      }
    } else {
      clearInterval(timers.ping);
      timers.ping = undefined;
      this.pingLedger?.release();
      this.pingLedger = undefined;
      // A check keeps its deadline even with nothing waiting: the next request must not land on a dead socket.
      if (!this.checking) {
        clearTimeout(timers.dead);
        timers.dead = undefined;
      }
      timers.idle ??= setTimeout(() => this.finish(new Error("The relay connection was idle")), options.idleMs);
    }
  }

  /**
   * Proves the socket is alive now: a ping, and the end of the socket when nothing is heard within
   * `ms`. A socket the system closed under a suspended app still says it is open, and without this
   * a request waits on it until the next regular ping.
   */
  check(ms: number) {
    if (this.dead || !this.opened) return;
    try {
      this.socket?.send("ping");
    } catch {
      return this.finish(new Error("The relay connection failed"));
    }
    this.checking = true;
    clearTimeout(this.timers.dead);
    this.timers.dead = setTimeout(() => this.finish(new Error("The relay stopped answering")), ms);
  }

  /** Ends this socket for good: stops every timer, closes it, and fails what was waiting. */
  finish(error: Error) {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.timers.connect);
    clearTimeout(this.timers.idle);
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.dead);
    this.timers = {};
    this.pingLedger?.release();
    this.pingLedger = undefined;
    this.socketLedger.release();
    this.gone(this);
    const socket = this.socket;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    }
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const pending of waiting) {
      pending.settle();
      pending.reject(error);
    }
  }
}

/**
 * A fetch that carries requests for relay entries over a relay socket, and hands every other URL to
 * `fetcher` untouched. One socket per relay entry, opened on first use and closed when idle.
 */
export function relayFetch(fetcher: FetchLike, options: RelayOptions = {}): RelayFetch {
  const settings = {
    WebSocket: options.WebSocket ?? ((globalThis as { WebSocket?: unknown }).WebSocket as RelaySocketClass),
    idleMs: options.idleMs ?? 30_000,
    connectMs: options.connectMs ?? 8_000,
    pingMs: options.pingMs ?? 25_000,
    deadMs: options.deadMs ?? 10_000,
  };
  const conns = new Map<string, Conn>();

  const send: FetchLike = (url, init) => {
    const match = URL_SHAPE.exec(url);
    const room = match ? parseRelayHost(match[1]) : null;
    if (!match || !room) return fetcher(url, init);

    const signal = init?.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    const session = header(init?.headers, "x-botkins-session");
    const body = typeof init?.body === "string" ? utf8(init.body) : (init?.body ?? new Uint8Array(0));
    if (!/^[\x20-\x7e]*$/.test(session) || session.length > 255) return Promise.reject(new Error("That session can't be sent"));
    const route = ROUTES[match[2]];
    const frame = new Uint8Array(7 + session.length + body.length);
    frame[0] = 0x01;
    frame[5] = route;
    frame[6] = session.length;
    for (let i = 0; i < session.length; i++) frame[7 + i] = session.charCodeAt(i);
    frame.set(body, 7 + session.length);
    if (frame.length > MAX_MESSAGE) return Promise.reject(new Error("That is too large to send"));

    let conn = conns.get(room.entry);
    if (!conn || !conn.usable) {
      conn?.finish(new Error("The relay connection was lost"));
      conn = new Conn(room, settings, (gone) => conns.get(room.entry) === gone && conns.delete(room.entry));
      conns.set(room.entry, conn);
    }
    const live = conn;
    let id: number;
    try {
      id = live.allocate();
    } catch (error) {
      return Promise.reject(error);
    }
    new DataView(frame.buffer).setUint32(1, id);

    return new Promise<RelayResponse>((resolve, reject) => {
      const onAbort = () => {
        live.forget(id);
        reject(abortError());
      };
      const settle = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      live.add(id, { resolve, reject, frame, settle, onPart: init?.onPart });
    });
  };
  return Object.assign(send, {
    supportsPush: true as const,
    check: (ms = 3000) => {
      for (const conn of [...conns.values()]) conn.check(ms);
    },
    rest: ({ force = false } = {}) => {
      for (const conn of [...conns.values()]) {
        if (force || conn.pending.size === 0) conn.finish(new Error("The app went to the background"));
      }
    },
  });
}

function abortError() {
  const error = new Error("The request was cancelled");
  error.name = "AbortError";
  return error;
}
