// The Botkins relay: a Worker in front of Durable Objects for rooms, invite cards and the sealed
// copies of spaces shared by link.
//
// The host and phone wire formats are documented in ../README.md. A v3 room retains a bounded
// set of opaque requests in instance memory for short transport gaps. It never inspects their bodies.
// Logs contain only event kinds, counts and close codes or fixed reasons.

import { PendingRequests } from "./pending.ts";
import { DurableObject } from "cloudflare:workers";
import { HOST_GROUP_LENGTH, HOST_PROTOCOL, HOST_PROTOCOL_V3, PHONE_PROTOCOL, hex, hostProof, hostProofV3, networkOf, sha256, unhex } from "./pure.ts";
import { handleFeedback } from "./feedback.ts";
import { handlePush } from "./push.ts";
import { spaceFrame, spacePage } from "./space.ts";
import spaceFrameScript from "./space-frame.js.txt";
import spacePageScript from "./space-page.js.txt";
import {
  BASE64URL_22,
  BASE64URL_43,
  INVITE_ROUTE,
  MAX_MESSAGE,
  MAX_PER_FROM,
  MAX_PHONES,
  MAX_PHONE_MESSAGE,
  MAX_V3_HOSTS,
  NOTICE_ANSWER_ACCEPTED,
  NOTICE_HOST_CLOSED,
  NOTICE_OFFLINE,
  NOTICE_PHONE_CLOSED,
  REQUEST,
  ROOM_NAME,
  ROUTE,
  SPACE_PAGE_ROUTE,
  SPACE_PIECE,
  SPACE_ROUTE,
  V3_FAST_HEARTBEAT,
  V3_FAST_SILENCE,
  V3_HEARTBEAT_PROBE,
  V3_LEGACY_SILENCE,
  V3_RECONNECT_WINDOW,
  V3_RESEAT_CLOSE,
  type InviteBody,
  type SpaceOwnerState,
  MAX_SPACE_BYTES_ALL,
  admitSpace,
  checkInviteDelete,
  checkInvitePut,
  checkSpaceDelete,
  checkSpacePut,
  joinPage,
  mcpAuthRedirect,
  plain,
  prefixed,
  readU32,
  spaceBytes,
  spaceGoneUntil,
  spacePutAllowed,
  u32Bytes,
} from "./shared.ts";

const RECOVERY_KEY = "room:recovery";
const SEAT_KEY = "room:seat";
const PENDING_KEY = "room:pending";
// The Worker sets these two headers itself. The Durable Object is only reachable through this Worker.
const KIND_HEADER = "x-relay-kind";
const FROM_HEADER = "x-relay-from";
const HOST_VERSION_HEADER = "x-relay-host-version";
const HOST_GROUP_HEADER = "x-relay-host-group";
const INVITE_OWNER_HEADER = "x-relay-invite-owner";

const OPEN = 1;

async function putInvite(request: Request, env: Env, lookup: string): Promise<Response> {
  const checked = await checkInvitePut(request, lookup);
  if (checked instanceof Response) return checked;
  const forwarded = new Request("https://invite.internal/", {
    method: "PUT",
    headers: { "content-type": "application/json", [INVITE_OWNER_HEADER]: checked.owner },
    body: JSON.stringify(checked.body),
  });
  return env.INVITE.getByName(lookup).fetch(forwarded);
}

async function deleteInvite(request: Request, env: Env, lookup: string): Promise<Response> {
  const checked = await checkInviteDelete(request, lookup);
  if (checked instanceof Response) return checked;
  const forwarded = new Request("https://invite.internal/", {
    method: "DELETE",
    headers: { [INVITE_OWNER_HEADER]: checked.owner },
  });
  return env.INVITE.getByName(lookup).fetch(forwarded);
}

const SPACE_TIME_HEADER = "x-relay-space-time";
const SPACE_EXPIRES_HEADER = "x-relay-space-expires";
const SPACE_OWNER_HEADER = "x-relay-space-owner";

/** A space's sealed copy: put and taken back by its computer, read by anyone with the link. */
async function handleSpace(request: Request, env: Env, limited: boolean, network: string, shareId: string): Promise<Response> {
  if (limited && !(await env.REQUESTS.limit({ key: network })).success) return plain("Too many requests", 429);
  if (!BASE64URL_22.test(shareId)) return plain("Not found", 404);
  const copy = env.SPACE.getByName(shareId);
  if (request.method === "GET") {
    if (limited && !(await env.SPACES.limit({ key: network })).success) return plain("Too many requests", 429);
    return copy.fetch(new Request("https://space.internal/"));
  }
  if (request.method === "PUT") {
    const checked = await checkSpacePut(request, shareId);
    if (checked instanceof Response) return checked;
    // How many copies one computer holds, and how often it puts one.
    const admitted = await env.SPACE_OWNER.getByName(checked.owner).fetch(
      new Request("https://owner.internal/admit", { method: "POST", headers: { [SPACE_OWNER_HEADER]: checked.owner }, body: JSON.stringify({ shareId, expiresAt: checked.expiresAt, size: checked.body.length }) }),
    );
    if (admitted.status === 507) return plain("Insufficient storage", 507);
    if (!admitted.ok) return plain("Too many requests", 429);
    return copy.fetch(
      new Request("https://space.internal/", {
        method: "PUT",
        headers: { [SPACE_TIME_HEADER]: String(checked.time), [SPACE_EXPIRES_HEADER]: String(checked.expiresAt) },
        body: checked.body,
      }),
    );
  }
  if (request.method === "DELETE") {
    const checked = await checkSpaceDelete(request, shareId);
    if (checked instanceof Response) return checked;
    const answer = await copy.fetch(new Request("https://space.internal/", { method: "DELETE", headers: { [SPACE_TIME_HEADER]: String(checked.time) } }));
    if (answer.status === 204 || answer.status === 404) {
      await env.SPACE_OWNER.getByName(checked.owner).fetch(new Request("https://owner.internal/forget", { method: "POST", headers: { [SPACE_OWNER_HEADER]: checked.owner }, body: JSON.stringify({ shareId }) }));
    }
    return answer;
  }
  return plain("Not found", 404);
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
    // Bug reports and feature requests become GitHub issues: its own checks, in ./feedback.ts.
    if (url.pathname === "/v1/feedback") return handleFeedback(request, env, limited, network);
    const space = SPACE_ROUTE.exec(url.pathname);
    if (space) return handleSpace(request, env, limited, network, space[1]!);
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
      if (url.pathname === "/mcp-auth") return mcpAuthRedirect(url);
      // A shared space's page is the same for every id: the relay never learns what a link opens.
      if (url.pathname === "/s/frame") return spaceFrame(spaceFrameScript);
      const page = SPACE_PAGE_ROUTE.exec(url.pathname);
      if (page) return BASE64URL_22.test(page[1]!) ? spacePage(spacePageScript) : plain("Not found", 404);
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

type StoredSpace = { time: number; expiresAt: number; size: number; pieces: number };

/**
 * One space's sealed copy, named by its share id. The bytes are opaque here: the key that opens
 * them is in the link's fragment and never reaches the relay. `gone` is the signed time of the last
 * DELETE, kept for a while so a PUT that was on its way cannot put the space out again.
 */
export class Space extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    // The body is read before anything is read from storage: from the first read to the write no other
    // request can run in between, so a DELETE is either wholly before this PUT's check or after its write.
    const body = request.method === "PUT" ? new Uint8Array(await request.arrayBuffer()) : null;
    const now = Date.now();
    const storage = this.ctx.storage;
    let held = (await storage.get<StoredSpace>("meta")) ?? null;
    let gone = (await storage.get<number>("gone")) ?? null;
    if (held && held.expiresAt <= now) {
      await this.drop(held);
      held = null;
    }
    if (gone !== null && spaceGoneUntil(gone) <= now) {
      await storage.delete("gone");
      gone = null;
    }

    if (request.method === "GET") {
      if (!held) return plain("Not found", 404);
      const pieces = await storage.get<Uint8Array>(pieceKeys(held.pieces));
      const whole = new Uint8Array(held.size);
      let at = 0;
      for (const key of pieceKeys(held.pieces)) {
        const piece = pieces.get(key);
        if (!piece || at + piece.length > held.size) return plain("Not found", 404);
        whole.set(piece, at);
        at += piece.length;
      }
      if (at !== held.size) return plain("Not found", 404);
      return new Response(whole, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
    const time = Number(request.headers.get(SPACE_TIME_HEADER));
    if (!Number.isSafeInteger(time)) return plain("Bad request", 400);
    if (request.method === "PUT") {
      const expiresAt = Number(request.headers.get(SPACE_EXPIRES_HEADER));
      if (!Number.isSafeInteger(expiresAt)) return plain("Bad request", 400);
      if (!body || !spacePutAllowed(held?.time ?? null, gone, time)) return plain("Conflict", 409);
      const entries: Record<string, unknown> = {};
      const count = Math.ceil(body.length / SPACE_PIECE);
      for (let n = 0; n < count; n++) entries["p:" + n] = body.subarray(n * SPACE_PIECE, (n + 1) * SPACE_PIECE);
      entries.meta = { time, expiresAt, size: body.length, pieces: count } satisfies StoredSpace;
      // One write: no await between them, so a reader sees the old copy or the new one, never a mix.
      const writes: Promise<unknown>[] = [];
      if (held && held.pieces > count) writes.push(storage.delete(pieceKeys(held.pieces).slice(count)));
      writes.push(storage.put(entries));
      await Promise.all(writes);
      await this.settle(expiresAt, gone);
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      if (held && time <= held.time) return plain("Conflict", 409);
      const last = Math.max(gone ?? 0, time);
      if (held) await this.drop(held);
      await storage.put("gone", last);
      await this.settle(null, last);
      return new Response(null, { status: held ? 204 : 404 });
    }
    return plain("Not found", 404);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const held = (await this.ctx.storage.get<StoredSpace>("meta")) ?? null;
    const gone = (await this.ctx.storage.get<number>("gone")) ?? null;
    const live = held && held.expiresAt > now ? held : null;
    const remembered = gone !== null && spaceGoneUntil(gone) > now ? gone : null;
    if (!live && remembered === null) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    if (held && !live) await this.drop(held);
    if (gone !== null && remembered === null) await this.ctx.storage.delete("gone");
    await this.settle(live?.expiresAt ?? null, remembered);
  }

  /** Wakes when the copy ends or when the taken-back time may be forgotten, whichever is first. */
  private async settle(expiresAt: number | null, gone: number | null): Promise<void> {
    const times = [expiresAt, gone === null ? null : spaceGoneUntil(gone)].filter((time): time is number => time !== null);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
  }

  private async drop(held: StoredSpace): Promise<void> {
    await this.ctx.storage.delete(["meta", ...pieceKeys(held.pieces)]);
  }
}

const pieceKeys = (count: number) => Array.from({ length: count }, (_unused, n) => "p:" + n);

/** One computer's copies, named by its relay key: how many it holds, how large they are together, and how often it puts one. */
export class SpaceOwner extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const owner = request.headers.get(SPACE_OWNER_HEADER) ?? "";
    const body = (await request.json()) as { shareId: string; expiresAt?: number; size?: number };
    const state = (await this.ctx.storage.get<SpaceOwnerState>("state")) ?? null;
    if (url.pathname === "/admit") {
      const next = admitSpace(state, body.shareId, Number(body.expiresAt), Number(body.size) || 0, Date.now());
      if (!next) return plain("Too many requests", 429);
      // The relay's storage for all copies together has room for this, or the copy is not taken.
      if (!(await this.tell(owner, next)).ok) return plain("Insufficient storage", 507);
      await this.ctx.storage.put("state", next);
      await this.ctx.storage.setAlarm(Math.max(...Object.values(next.live).map((copy) => copy.until)));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/forget" && state && Object.hasOwn(state.live, body.shareId)) {
      const { [body.shareId]: _gone, ...live } = state.live;
      const next = { ...state, live };
      await this.ctx.storage.put("state", next);
      await this.tell(owner, next);
    }
    return new Response(null, { status: 204 });
  }

  /** Tells the relay's one count of all copies what this computer holds now. */
  private tell(owner: string, state: SpaceOwnerState): Promise<Response> {
    const copies = Object.values(state.live);
    return this.env.SPACE_BUDGET.getByName("all").fetch(
      new Request("https://budget.internal/", { method: "POST", body: JSON.stringify({ owner, bytes: spaceBytes(state.live), until: Math.max(0, ...copies.map((copy) => copy.until)) }) }),
    );
  }

  /** Nothing is kept for a computer whose copies have all ended. */
  async alarm(): Promise<void> {
    const state = (await this.ctx.storage.get<SpaceOwnerState>("state")) ?? null;
    const ends = Object.values(state?.live ?? {}).map((copy) => copy.until).filter((time) => time > Date.now());
    if (ends.length) await this.ctx.storage.setAlarm(Math.max(...ends));
    else await this.ctx.storage.deleteAll();
  }
}

/**
 * How much all computers' copies take together: one object for the whole relay, asked only when a
 * copy is put or taken back, never when one is read. A computer's row says what it holds and until
 * when; a row is counted until then, so the count can only be too high, never too low.
 */
export class SpaceBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS owners (owner TEXT PRIMARY KEY, bytes INTEGER NOT NULL, until INTEGER NOT NULL)");
  }

  async fetch(request: Request): Promise<Response> {
    const { owner, bytes, until } = (await request.json()) as { owner: string; bytes: number; until: number };
    if (typeof owner !== "string" || !owner || !Number.isSafeInteger(bytes) || !Number.isSafeInteger(until)) return plain("Bad request", 400);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM owners WHERE until <= ?", Date.now());
    if (bytes <= 0) {
      sql.exec("DELETE FROM owners WHERE owner = ?", owner);
      return new Response(null, { status: 204 });
    }
    const others = Number(sql.exec("SELECT COALESCE(SUM(bytes), 0) AS total FROM owners WHERE owner != ?", owner).one().total);
    const before = Number(sql.exec("SELECT COALESCE(SUM(bytes), 0) AS total FROM owners WHERE owner = ?", owner).one().total);
    // A computer that holds less than before is always let through, also on a full relay.
    if (bytes > before && others + bytes > (Number(this.env.SPACE_BYTES_MAX) || MAX_SPACE_BYTES_ALL)) return plain("Insufficient storage", 507);
    sql.exec("INSERT INTO owners (owner, bytes, until) VALUES (?, ?, ?) ON CONFLICT (owner) DO UPDATE SET bytes = excluded.bytes, until = excluded.until", owner, bytes, until);
    return new Response(null, { status: 204 });
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
  sampledAt?: number;
  heartbeat?: "legacy" | "fast";
  notified: boolean;
  closing?: boolean;
};
type PhoneAttachment = { kind: "phone"; ids: Uint8Array; at: number; notified: boolean; closing?: boolean };
type Attachment = HostAttachment | PhoneAttachment;
type RecoveryState = { version: "v3"; group: string; until: number; phones?: string[] };
type SeatState = { version: "v3"; group: string };

/** Socket attachments survive hibernation. The bounded request queue can be lost on any wake. */
export class Room extends DurableObject<Env> {
  private readonly pending = new PendingRequests();
  private savedSeat?: SeatState | null;
  private savedRecovery?: RecoveryState | null;
  private holdTimer?: ReturnType<typeof setTimeout>;

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
    this.expirePending();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (kind === "host") {
      const version = request.headers.get(HOST_VERSION_HEADER);
      const group = request.headers.get(HOST_GROUP_HEADER) ?? "";
      if (version !== "v2" && version !== "v3") return plain("Bad request", 400);
      if (version === "v3" && !new RegExp(`^[A-Za-z0-9_-]{${HOST_GROUP_LENGTH}}$`).test(group)) return plain("Bad request", 400);

      await this.cleanLegacyPending();
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
          this.failPending(!(staleRecovery && !replacingV3 && oldHosts.length > 0));
        }
        for (const old of oldHosts) await this.end(old, 4000, "replaced");
      } else {
        // A reconnect from the same proven runtime is not a competing computer. With two existing
        // seats, retire only the stalest/oldest peer and make this newest proven socket active.
        const reseat = await this.reseatSameGroup(oldHosts, Date.now());
        role = reseat.role;
        replayPending ||= reseat.replay;
      }
      this.releaseHold();
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({
        kind: "host",
        version,
        ...(version === "v3" ? { group } : {}),
        role: version === "v3" ? role : "active",
        openedAt: Date.now(),
        notified: false,
      } satisfies Attachment);
      await this.setSeat(version === "v3" ? group : null);
      if (recovery) await this.clearRecovery();
      if (version === "v3") {
        if (replayPending) {
          for (const ids of recovery?.phones ?? []) {
            if (!this.open("c:" + ids.slice(0, 16)).length) send(server, prefixed(unhex(ids), Uint8Array.of(NOTICE_PHONE_CLOSED)));
          }
          this.drainPending(server, true);
        }
      } else {
        this.pending.clear();
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
      await this.reapStaleHosts(Date.now());
    } else {
      return plain("Bad request", 400);
    }
    await this.scheduleAlarm();
    log("open", { kind, phones: this.open("phone").length });
    const protocol = kind === "host" ? (request.headers.get(HOST_VERSION_HEADER) === "v3" ? HOST_PROTOCOL_V3 : HOST_PROTOCOL) : PHONE_PROTOCOL;
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": protocol } });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    this.expirePending();
    // "ping" never gets here (auto-response). Any other text is ignored.
    if (typeof message === "string" || ws.readyState !== OPEN) return;
    const bytes = new Uint8Array(message);
    const side = ws.deserializeAttachment() as Attachment | null;
    if (message.byteLength > (side?.kind === "phone" ? MAX_PHONE_MESSAGE : MAX_MESSAGE)) return this.ctx.blockConcurrencyWhile(() => this.end(ws, 1009, "too big"));

    if (side?.kind === "phone") {
      if (side.closing) return;
      const now = Date.now();
      const hosts = this.open("host");
      if (hosts.some(host => (this.hostActivity(host)?.deadline ?? Infinity) <= now)) {
        return this.ctx.blockConcurrencyWhile(async () => {
          await this.reapStaleHosts(now);
          await this.forwardRequest(ws, side, bytes);
          await this.scheduleAlarm();
        });
      }
      if (!hosts.length) {
        return this.ctx.blockConcurrencyWhile(async () => {
          await this.holdOrRefuse(ws, side.ids, bytes);
          await this.scheduleAlarm();
        });
      }
      return this.forwardRequest(ws, side, bytes);
    } else if (side?.kind === "host") {
      if (side.closing) return;
      if (side.version === "v3") {
        ws.serializeAttachment({ ...side, lastBinaryAt: Date.now() } satisfies Attachment);
      }
      // [conn 8] + the answer. A short message, or a phone that is gone, is dropped.
      if (bytes.length < 9) return;
      const conn = hex(bytes.subarray(0, 8));
      const phone = this.open("c:" + conn)[0];
      if (side.version === "v3" && bytes.length >= 13 && bytes[8] === 0x02) {
        const hadPending = this.pending.length > 0;
        const phoneSide = phone?.deserializeAttachment() as PhoneAttachment | undefined;
        const accepted = this.pending.accept(conn, readU32(bytes, 9), phoneSide?.ids);
        send(ws, prefixed(unhex(accepted.ids), prefixed(Uint8Array.of(NOTICE_ANSWER_ACCEPTED), bytes.subarray(9, 13))));
        if (accepted.duplicate) return;
        // A view of the same bytes: the 8 are stripped without a copy.
        if (phone) send(phone, bytes.subarray(8));
        if (hadPending && !this.pending.length) return this.scheduleAlarm();
        return;
      }
      // A view of the same bytes: the 8 are stripped without a copy.
      if (phone) send(phone, bytes.subarray(8));
    }
  }

  private forwardRequest(ws: WebSocket, side: PhoneAttachment, bytes: Uint8Array): void | Promise<void> {
    const host = this.activeHost();
    if (!host) return this.holdOrRefuse(ws, side.ids, bytes);
    if ((host.deserializeAttachment() as HostAttachment).version !== "v3") {
      send(host, prefixed(side.ids, bytes));
      return;
    }
    if (bytes.length < 5 || bytes[0] !== REQUEST) return;
    const hadPending = this.pending.length > 0;
    const pending = this.pending.add(side.ids, bytes);
    if (pending) {
      this.drainPending(host);
      if (!hadPending) return this.scheduleAlarm();
    } else send(ws, prefixed(Uint8Array.of(NOTICE_OFFLINE), bytes.subarray(1, 5)));
  }

  private async holdOrRefuse(ws: WebSocket, ids: Uint8Array, bytes: Uint8Array): Promise<void> {
    if (bytes.length < 5 || bytes[0] !== REQUEST) return;
    // A phone frame can precede the last host's close handler.
    let recovery = await this.recovery();
    if (!recovery) {
      const seat = await this.seatedV3();
      if (seat) recovery = await this.beginRecovery(seat.group);
    }
    if (recovery && recovery.until > Date.now() && this.pending.add(ids, bytes)) {
      this.holdUntil(recovery.until);
    } else {
      send(ws, prefixed(Uint8Array.of(NOTICE_OFFLINE), bytes.subarray(1, 5)));
    }
  }

  webSocketClose(ws: WebSocket, code: number): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.closed(ws, code));
  }

  private async closed(ws: WebSocket, code: number): Promise<void> {
    this.expirePending();
    log("close", { kind: this.kindOf(ws), code });
    const side = ws.deserializeAttachment() as Attachment | null;
    await this.ended(ws);
    if (side?.kind === "host" && !side.closing && !side.notified) await this.hostEnded(side);
    await this.scheduleAlarm();
    // Complete the handshake only if we did not already initiate a close. Repeating ws.close()
    // on a server-closed hibernated socket keeps the object from hibernating until TCP timeout.
    if (!side?.closing) {
      try {
        if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code);
        else ws.close();
      } catch {
        // Already closed.
      }
    }
  }

  webSocketError(ws: WebSocket): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.errored(ws));
  }

  private async errored(ws: WebSocket): Promise<void> {
    this.expirePending();
    log("error", { kind: this.kindOf(ws) });
    const side = ws.deserializeAttachment() as Attachment | null;
    await this.ended(ws);
    if (side?.kind === "host" && !side.closing && !side.notified) await this.hostEnded(side);
    await this.scheduleAlarm();
    if (!side?.closing) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
  }

  /**
   * The room's sockets with a tag that are still open and not already closing from our side.
   * A server-closed socket whose peer never completes the close handshake can linger in
   * `getWebSockets` across hibernation with `readyState === OPEN`; checking `side.closing`
   * keeps it out of seat selection, reaping and alarms, and prevents duplicate `ws.close()` calls.
   */
  private open(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => {
      if (ws.readyState !== OPEN) return false;
      const side = ws.deserializeAttachment() as Attachment | null;
      return !side?.closing;
    });
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
    if (autoAt > 0 && (autoAt !== side.lastAutoResponseAt || (!side.heartbeat && side.sampledAt !== now))) {
      const interval = autoAt - (side.lastAutoResponseAt ?? 0);
      // Two nearby pongs prove a fast cadence. Widely spaced samples can miss intervening pings.
      const fast = side.lastAutoResponseAt && side.sampledAt && now - side.sampledAt <= V3_FAST_HEARTBEAT &&
        interval > 0 && interval <= V3_FAST_HEARTBEAT;
      side = { ...side, sampledAt: now, lastAutoResponseAt: autoAt, heartbeat: side.heartbeat ?? (fast ? "fast" : undefined) };
      ws.serializeAttachment(side satisfies Attachment);
    }
    const last = Math.max(side.openedAt ?? 0, side.lastBinaryAt ?? 0, side.lastAutoResponseAt ?? 0);
    const silence = side.heartbeat === "fast" ? V3_FAST_SILENCE : V3_LEGACY_SILENCE;
    return { side, last, deadline: last + silence };
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
    // the active route. Evict down to one survivor (least recently heard first), demote that
    // survivor to standby, and replay the bounded opaque request index on the incoming active seat.
    const sorted = [...ordered].sort((a, b) => {
      const last = (entry: (typeof ordered)[number]) => entry.activity?.last ?? entry.side.openedAt ?? 0;
      const delta = last(a) - last(b);
      return delta || (a.side.openedAt ?? 0) - (b.side.openedAt ?? 0);
    });
    const evictCount = Math.max(1, sorted.length - (MAX_V3_HOSTS - 1));
    for (const victim of sorted.slice(0, evictCount)) {
      await this.end(victim.ws, V3_RESEAT_CLOSE, "replaced");
    }
    const survivor = sorted[evictCount];
    if (survivor) survivor.ws.serializeAttachment({ ...survivor.side, role: "standby" } satisfies Attachment);
    return { role: "active", replay: true };
  }

  alarm(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.expire());
  }

  private async expire(): Promise<void> {
    const now = Date.now();
    this.expirePending();
    if (this.open("phone").length) await this.reapStaleHosts(now);
    const recovery = await this.recovery();
    if (recovery && this.activeHost()) {
      await this.clearRecovery();
    } else if (recovery && recovery.until <= now) {
      // The old runtime did not return. Fail both queued and in-flight phones once, then leave
      // subsequent requests to the normal immediate [0x03][id] path.
      await this.failRecovery();
    }
    await this.scheduleAlarm();
  }

  /** Check on phone activity and on a liveness alarm. */
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
      this.drainPending(promoted.ws, true);
    } else if (!survivors.length) {
      const group = stale[0]?.side.group;
      if (group) {
        const until = Math.max(...stale.map(entry => entry.activity!.deadline)) + V3_RECONNECT_WINDOW;
        if (until <= now) await this.failRecovery();
        else await this.beginRecovery(group, undefined, until);
      }
    }
  }

  private async recovery(): Promise<RecoveryState | null> {
    if (this.savedRecovery !== undefined) return this.savedRecovery;
    const stored = await this.ctx.storage.get<RecoveryState>(RECOVERY_KEY);
    this.savedRecovery = stored?.version === "v3" && BASE64URL_43.test(stored.group) && Number.isSafeInteger(stored.until) ? stored : null;
    return this.savedRecovery;
  }

  private async seatedV3(): Promise<SeatState | null> {
    if (this.savedSeat !== undefined) return this.savedSeat;
    const stored = await this.ctx.storage.get<SeatState>(SEAT_KEY);
    this.savedSeat = stored?.version === "v3" && BASE64URL_43.test(stored.group) ? stored : null;
    return this.savedSeat;
  }

  private async setSeat(group: string | null): Promise<void> {
    if (((await this.seatedV3())?.group ?? null) === group) return;
    const seat = group ? { version: "v3", group } satisfies SeatState : null;
    if (seat) await this.ctx.storage.put(SEAT_KEY, seat);
    else await this.ctx.storage.delete(SEAT_KEY);
    this.savedSeat = seat;
  }

  private async beginRecovery(group: string, leaving?: Uint8Array, until = Date.now() + V3_RECONNECT_WINDOW): Promise<RecoveryState | null> {
    if (this.open("host").length) return null;
    const current = await this.recovery();
    if (current?.group === group) {
      // A phone leaving can open the window before the host's own close: still keep what is in flight.
      this.holdUntil(current.until);
      return current;
    }
    const phones = this.open("phone").map(ws => hex((ws.deserializeAttachment() as PhoneAttachment).ids));
    if (leaving && !phones.includes(hex(leaving))) phones.push(hex(leaving));
    const recovery = { version: "v3", group, until, phones } satisfies RecoveryState;
    this.holdUntil(until);
    await this.ctx.storage.put(RECOVERY_KEY, recovery);
    this.savedRecovery = recovery;
    await this.scheduleAlarm();
    return recovery;
  }

  private async clearRecovery(): Promise<void> {
    this.releaseHold();
    await this.ctx.storage.delete(RECOVERY_KEY);
    this.savedRecovery = null;
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
          this.drainPending(standby, true);
        }
      }
      return;
    }
    if (side.version === "v3" && side.group && /^[A-Za-z0-9_-]{43}$/.test(side.group)) {
      await this.beginRecovery(side.group);
    } else {
      this.pending.clear(true);
    }
  }

  /** Ends a v3 reconnect window or an explicit cross-runtime takeover. */
  private async failRecovery(): Promise<void> {
    if (await this.recovery()) await this.clearRecovery();
    await this.setSeat(null);
    this.failPending();
  }

  private failPending(notify = true): void {
    this.pending.clear(true);
    if (notify) for (const phone of this.open("phone")) send(phone, Uint8Array.of(NOTICE_HOST_CLOSED));
  }

  private drainPending(host: WebSocket, replay = false): void {
    this.pending.drain(item => send(host, prefixed(unhex(item.ids), item.body)), replay);
  }

  private expirePending(): void {
    this.pending.expire(Date.now(), item => {
      const phone = this.open("c:" + item.ids.slice(0, 16))[0];
      if (phone) send(phone, prefixed(Uint8Array.of(NOTICE_OFFLINE), u32Bytes(item.requestId)));
    });
    if (!this.pending.length) this.releaseHold();
  }

  private holdUntil(until: number): void {
    if (!this.pending.length || this.holdTimer !== undefined) return;
    // The durable alarm handles expiry, including after eviction. This timer only retains the
    // queue through the short gap and is cancelled when the host returns or the queue empties.
    this.holdTimer = setTimeout(() => { this.holdTimer = undefined; }, Math.max(0, until - Date.now()));
  }

  private releaseHold(): void {
    if (this.holdTimer !== undefined) clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
  }

  private async cleanLegacyPending(): Promise<void> {
    // Old chunk keys can outlive their index. Bound the values read in each pass.
    if (await this.ctx.storage.get(PENDING_KEY) !== undefined) await this.ctx.storage.delete(PENDING_KEY);
    for (;;) {
      const keys = await this.ctx.storage.list({ prefix: PENDING_KEY + ":", limit: 32 });
      if (!keys.size) return;
      await this.ctx.storage.delete([...keys.keys()]);
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const recovery = await this.recovery();
    let due = Math.min(recovery?.until ?? Infinity, this.pending.nextExpiry());
    const hasPending = this.pending.length > 0;
    const now = Date.now();
    for (const host of this.open("host")) {
      const activity = this.hostActivity(host);
      if (!activity) continue;
      // Only watch host liveness while a request is actually in flight (not for idle open phones).
      if (hasPending) due = Math.min(due, activity.deadline);
      const { openedAt, heartbeat } = activity.side;
      if (!heartbeat && openedAt) {
        // Four samples at fixed offsets from admission. Later events cannot extend the probe.
        const step = Math.floor((now - openedAt) / V3_HEARTBEAT_PROBE) + 1;
        if (step <= 4) due = Math.min(due, openedAt + step * V3_HEARTBEAT_PROBE);
      }
    }
    const current = await this.ctx.storage.getAlarm();
    if (Number.isFinite(due)) {
      if (current !== due) await this.ctx.storage.setAlarm(due);
    } else if (current !== null) await this.ctx.storage.deleteAlarm();
  }

  /** Tells the other side, once, that a socket is gone: the computer about a phone, every phone about the computer. */
  private async ended(ws: WebSocket): Promise<void> {
    const side = ws.deserializeAttachment() as Attachment | null;
    if (!side || side.notified) return;
    ws.serializeAttachment({ ...side, notified: true } satisfies Attachment);
    if (side.kind === "phone") {
      this.pending.drop(side.ids);
      if (!this.pending.length) this.releaseHold();
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
    const side = ws.deserializeAttachment() as Attachment | null;
    if (side?.closing) return;
    log("drop", { kind: this.kindOf(ws), code, reason });
    const replacing = reason === "replaced";
    if (side) ws.serializeAttachment({ ...side, closing: true } satisfies Attachment);
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
