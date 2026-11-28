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
// nothing while the queue survives, and acknowledges answers to the host with 0x06.
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
import { PendingRequests } from "../src/pending.ts";
import { spaceFrame, spacePage } from "../src/space.ts";
import {
  GITHUB_AGENT_SLUG_DEFAULT,
  GITHUB_BINDING_TTL_MS,
  GITHUB_CLAIM_MAX,
  GITHUB_CLAIM_TTL_MS,
  GITHUB_DELIVERY_DEDUPE_MAX,
  GITHUB_DELIVERY_DEDUPE_TTL_MS,
  GITHUB_EVENTS_PATH,
  GITHUB_NONCE_MAX,
  GITHUB_NONCE_TTL_MS,
  GITHUB_SETUP_PATH,
  agentAppOf,
  allowsLegacyUserTokenAuth,
  authorizeSubscribedRepos,
  bindingTtlMsOf,
  checkGitHubWebhookRequest,
  clampPermissionsForRepoAccess,
  fetchInstallationRepos,
  githubSetupResultPage,
  mintSingleRepoInstallationToken,
  normalizeRepoPermissions,
  verifyGitHubClaimRequest,
  verifyGitHubInstallationsListRequest,
  verifyGitHubInstallationOAuth,
  verifyGitHubSetupState,
  verifyGitHubSubscribe,
  verifyGitHubTokenRequest,
  verifyGitHubUnbindRequest,
} from "../src/github.ts";
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
  PAGE_CSS,
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
  mcpAuthRedirect,
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
const LIMITS = { sockets: 30, requests: 120, invites: 20, spaces: 60, githubIp: 120, githubInstall: 240 };
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

/** Persisted GitHub App installation bindings for the self-hosted Node relay (DATA_DIR/github-bindings.json). */
class GitHubBindings {
  constructor(file, ttlMs = GITHUB_BINDING_TTL_MS) {
    this.file = file;
    this.ttlMs = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : GITHUB_BINDING_TTL_MS;
    /** installationId (number) -> { installationId, accountLogin, accountType, installerLogin, repositorySelection, repos: Set<string>, suspended, updatedAt } */
    this.installations = new Map();
    /** room -> Map<installationId, { installerLogin, boundAt, expiresAt, repos: Map<repoLower, { pull, push, admin }> }> */
    this.roomBindings = new Map();
    /** installationId -> Set<room> */
    this.instToRooms = new Map();
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const inst of Array.isArray(saved.installations) ? saved.installations : []) {
        const id = Number(inst?.installationId);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        this.installations.set(id, {
          installationId: id,
          accountLogin: String(inst.accountLogin || ""),
          accountType: String(inst.accountType || "User"),
          installerLogin: String(inst.installerLogin || ""),
          repositorySelection: inst.repositorySelection === "all" ? "all" : "selected",
          repos: new Set(Array.isArray(inst.repos) ? inst.repos.map((r) => String(r).toLowerCase()) : []),
          suspended: Boolean(inst.suspended),
          updatedAt: Number(inst.updatedAt) || Date.now(),
        });
      }
      if (saved.roomBindings && typeof saved.roomBindings === "object") {
        for (const [room, entries] of Object.entries(saved.roomBindings)) {
          if (!ROOM_NAME.test(room) || !Array.isArray(entries)) continue;
          for (const entry of entries) {
            const id = Number(entry?.installationId);
            if (!this.installations.has(id)) continue;
            const boundAt = Number(entry.boundAt) || Date.now();
            const expiresAt = Number(entry.expiresAt) || boundAt + this.ttlMs;
            const repoMap = new Map();
            for (const rp of normalizeRepoPermissions(entry.repoPermissions ?? [])) {
              repoMap.set(rp.fullName, { pull: rp.pull, push: rp.push, admin: rp.admin });
            }
            if (!this.roomBindings.has(room)) this.roomBindings.set(room, new Map());
            this.roomBindings.get(room).set(id, {
              installerLogin: String(entry.installerLogin || ""),
              boundAt,
              expiresAt,
              repos: repoMap,
            });
            if (!this.instToRooms.has(id)) this.instToRooms.set(id, new Set());
            this.instToRooms.get(id).add(room);
          }
        }
      }
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const roomBindings = {};
    for (const [room, map] of this.roomBindings.entries()) {
      roomBindings[room] = [...map.entries()].map(([installationId, binding]) => ({
        installationId,
        installerLogin: binding.installerLogin,
        boundAt: binding.boundAt,
        expiresAt: binding.expiresAt,
        repoPermissions: [...binding.repos.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([fullName, perms]) => ({ fullName, ...perms })),
      }));
    }
    const payload = {
      installations: [...this.installations.values()].map((i) => ({ ...i, repos: [...i.repos].sort() })),
      roomBindings,
    };
    writeFileSync(this.file + ".tmp", JSON.stringify(payload), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  bind(room, inst, now = Date.now(), ttlMs = this.ttlMs) {
    const id = Number(inst.installationId);
    const prevInst = this.installations.get(id);
    const installerLogin = String(inst.installerLogin || inst.accountLogin || "");
    const normalizedPerms = Array.isArray(inst.repoPermissions)
      ? normalizeRepoPermissions(inst.repoPermissions)
      : normalizeRepoPermissions(
          (Array.isArray(inst.repos) ? inst.repos : []).map((r) => ({ fullName: r, pull: true, push: false, admin: false })),
        );

    // Preserve installation-level repo set additively (never let one user's narrower view wipe it).
    const instRepos = new Set(prevInst ? prevInst.repos : []);
    for (const rp of normalizedPerms) instRepos.add(rp.fullName);
    this.installations.set(id, {
      installationId: id,
      accountLogin: String(inst.accountLogin || prevInst?.accountLogin || ""),
      accountType: String(inst.accountType || prevInst?.accountType || "User"),
      installerLogin: prevInst?.installerLogin || installerLogin,
      repositorySelection: inst.repositorySelection === "all" ? "all" : "selected",
      repos: instRepos,
      suspended: Boolean(inst.suspended),
      updatedAt: Number(inst.updatedAt) || now,
    });

    const repoMap = new Map();
    for (const rp of normalizedPerms) {
      repoMap.set(rp.fullName, { pull: rp.pull, push: rp.push, admin: rp.admin });
    }
    const effectiveTtl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : this.ttlMs;
    const expiresAt = now + effectiveTtl;
    if (!this.roomBindings.has(room)) this.roomBindings.set(room, new Map());
    this.roomBindings.get(room).set(id, {
      installerLogin,
      boundAt: now,
      expiresAt,
      repos: repoMap,
    });
    if (!this.instToRooms.has(id)) this.instToRooms.set(id, new Set());
    this.instToRooms.get(id).add(room);
    this.save();
    return expiresAt;
  }
  unbind(room, installationId) {
    this.roomBindings.get(room)?.delete(installationId);
    if (this.roomBindings.get(room)?.size === 0) this.roomBindings.delete(room);
    this.instToRooms.get(installationId)?.delete(room);
    if (!this.instToRooms.get(installationId)?.size) {
      this.instToRooms.delete(installationId);
      this.installations.delete(installationId);
    }
    this.save();
  }
  listForRoom(room, now = Date.now()) {
    const map = this.roomBindings.get(room);
    if (!map) return [];
    const ids = [...map.keys()].sort((a, b) => a - b);
    const out = [];
    for (const id of ids) {
      const inst = this.installations.get(id);
      const binding = map.get(id);
      if (!inst || !binding || inst.suspended) continue;
      const expired = binding.expiresAt <= now;
      const repoPermissions = expired
        ? []
        : [...binding.repos.entries()]
            .filter(([, p]) => p.pull)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([fullName, p]) => ({ fullName, pull: Boolean(p.pull), push: Boolean(p.push), admin: Boolean(p.admin) }));
      out.push({
        installationId: inst.installationId,
        accountLogin: inst.accountLogin,
        accountType: inst.accountType,
        installerLogin: binding.installerLogin || inst.installerLogin,
        repositorySelection: inst.repositorySelection,
        repos: repoPermissions.map((rp) => rp.fullName),
        repoPermissions,
        suspended: inst.suspended,
        updatedAt: inst.updatedAt,
        boundAt: binding.boundAt,
        expiresAt: binding.expiresAt,
        expired,
      });
    }
    return out;
  }
  /** True only when the room has an active, non-expired binding for `installationId` whose per-room repo set includes `repoLower`. */
  isRoomBoundToInstallationRepo(room, installationId, repoLower, now = Date.now()) {
    const inst = this.installations.get(installationId);
    if (!inst || inst.suspended) return false;
    const binding = this.roomBindings.get(room)?.get(installationId);
    if (!binding || binding.expiresAt <= now) return false;
    const perms = binding.repos.get(repoLower);
    return Boolean(perms?.pull);
  }
  /** Resolves `{ installationId, canWrite }` strictly from this room's non-expired verified repo set (never installation_repos or "all"). */
  resolveForRepo(room, repoLower, now = Date.now()) {
    const map = this.roomBindings.get(room);
    if (!map) return null;
    const ids = [...map.keys()].sort((a, b) => a - b);
    let readFallback = null;
    for (const id of ids) {
      const inst = this.installations.get(id);
      const binding = map.get(id);
      if (!inst || !binding || inst.suspended || binding.expiresAt <= now) continue;
      const perms = binding.repos.get(repoLower);
      if (!perms?.pull) continue;
      const canWrite = Boolean(perms.push || perms.admin);
      if (canWrite) return { installationId: id, canWrite: true };
      if (!readFallback) readFallback = { installationId: id, canWrite: false };
    }
    return readFallback;
  }
  applyEvent(ev) {
    const id = ev.installationId;
    const affectedRooms = [...(this.instToRooms.get(id) ?? [])];
    if (ev.event === "installation") {
      if (ev.action === "deleted" || ev.action === "suspend") {
        for (const room of affectedRooms) {
          this.roomBindings.get(room)?.delete(id);
          if (this.roomBindings.get(room)?.size === 0) this.roomBindings.delete(room);
        }
        this.instToRooms.delete(id);
        this.installations.delete(id);
        this.save();
        return affectedRooms;
      }
      const existing = this.installations.get(id);
      if (existing && (ev.action === "unsuspend" || ev.action === "created" || ev.action === "new_permissions_accepted")) {
        if (ev.accountLogin) existing.accountLogin = ev.accountLogin;
        if (ev.accountType) existing.accountType = ev.accountType;
        existing.repositorySelection = ev.repositorySelection === "all" ? "all" : "selected";
        existing.suspended = false;
        existing.updatedAt = Date.now();
        // Bookkeeping only on installation-level repos; never expand room bindings without fresh OAuth.
        if (Array.isArray(ev.repositories) && ev.repositories.length > 0) {
          existing.repos = new Set(ev.repositories.map((r) => String(r).toLowerCase()));
        }
        this.save();
      }
      return affectedRooms;
    }
    if (ev.event === "installation_repositories") {
      const existing = this.installations.get(id);
      if (existing) {
        existing.repositorySelection = ev.repositorySelection === "all" ? "all" : "selected";
        existing.updatedAt = Date.now();
        // Bookkeeping only: NEVER add newly added installation repos to existing rooms automatically.
        for (const r of ev.repositoriesAdded ?? []) existing.repos.add(String(r).toLowerCase());
        // Removals immediately revoke access from installation_repos AND every bound room.
        for (const r of ev.repositoriesRemoved ?? []) {
          const lower = String(r).toLowerCase();
          existing.repos.delete(lower);
          for (const room of affectedRooms) {
            this.roomBindings.get(room)?.get(id)?.repos.delete(lower);
          }
        }
        this.save();
      }
      return affectedRooms;
    }
    return affectedRooms;
  }
  applyMembershipEvent(ev, now = Date.now()) {
    const isRemoval =
      (ev.event === "organization" && ev.action === "member_removed") ||
      (ev.event === "membership" && ev.action === "removed");
    const memberLower = String(ev.memberLogin || "").trim().toLowerCase();
    const accountLower = String(ev.accountLogin || "").trim().toLowerCase();
    if (!isRemoval || !memberLower) return [];
    const affected = new Set();
    for (const [room, map] of this.roomBindings.entries()) {
      for (const [instId, binding] of map.entries()) {
        const inst = this.installations.get(instId);
        if (!inst) continue;
        const instMatch = ev.installationId !== null
          ? instId === ev.installationId
          : Boolean(accountLower && inst.accountLogin.toLowerCase() === accountLower);
        if (!instMatch) continue;
        if (binding.installerLogin.toLowerCase() !== memberLower) continue;
        binding.repos.clear();
        binding.expiresAt = now - 1;
        affected.add(room);
      }
    }
    if (affected.size) this.save();
    return [...affected];
  }
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
export function createRelay({
  dataDir,
  pushUpstream = DEFAULT_PUSH_UPSTREAM,
  clientIpHeader,
  limits = true,
  qrFile,
  botkinsDir,
  spaceBytesMax,
  githubWebhookSecret,
  githubAgentAppId,
  githubAgentAppSlug,
  githubAgentAppKey,
  githubAgentClientId,
  githubAgentClientSecret,
  githubAllowUserTokenAuth,
  githubApiBase,
  githubWebBase,
  githubBindingTtlMs,
  fetch = globalThis.fetch,
} = {}) {
  const invites = new Invites(dataDir ? join(dataDir, "invites.json") : null);
  const spaces = new Spaces(dataDir || null, spaceBytesMax);
  const effectiveBindingTtlMs =
    Number.isSafeInteger(githubBindingTtlMs) && githubBindingTtlMs > 0
      ? githubBindingTtlMs
      : bindingTtlMsOf(process.env);
  const githubBindings = new GitHubBindings(dataDir ? join(dataDir, "github-bindings.json") : null, effectiveBindingTtlMs);
  const githubEnv = {
    GITHUB_AGENT_APP_ID: githubAgentAppId,
    GITHUB_AGENT_APP_SLUG: githubAgentAppSlug,
    GITHUB_AGENT_APP_KEY: githubAgentAppKey,
    GITHUB_AGENT_CLIENT_ID: githubAgentClientId,
    GITHUB_AGENT_CLIENT_SECRET: githubAgentClientSecret,
    GITHUB_ALLOW_USER_TOKEN_AUTH: githubAllowUserTokenAuth ? "1" : "",
  };
  const githubAgentApp = agentAppOf(githubEnv);
  const githubAppSlug = githubAgentApp?.appSlug || githubAgentAppSlug || GITHUB_AGENT_SLUG_DEFAULT;
  const legacyUserTokenMode = allowsLegacyUserTokenAuth(githubEnv);
  /** repoLower -> Map<room, expiresAtMs> */
  const githubSubsByRepo = new Map();
  /** room -> Set<repoLower> */
  const githubReposByRoom = new Map();
  /** deliveryId -> expiresAtMs */
  const githubSeenDeliveries = new Map();
  /** nonce -> expiresAtMs */
  const githubUsedNonces = new Map();
  /** deliveryId -> { room, until } */
  const githubDeliveryClaims = new Map();
  const sweepGithub = () => {
    const now = Date.now();
    for (const [id, until] of githubSeenDeliveries) if (until <= now) githubSeenDeliveries.delete(id);
    for (const [n, until] of githubUsedNonces) if (until <= now) githubUsedNonces.delete(n);
    for (const [id, entry] of githubDeliveryClaims) if (entry.until <= now) githubDeliveryClaims.delete(id);
    for (const [repo, byRoom] of githubSubsByRepo) {
      for (const [room, until] of byRoom) if (until <= now) byRoom.delete(room);
      if (!byRoom.size) githubSubsByRepo.delete(repo);
    }
  };
  const activeRoomGithubSubs = (room, minUntil) => {
    const now = Date.now();
    const out = new Set();
    const prev = githubReposByRoom.get(room);
    if (!prev) return out;
    for (const repo of prev) {
      const until = githubSubsByRepo.get(repo)?.get(room) ?? 0;
      if (until > now && until >= minUntil) out.add(repo);
    }
    return out;
  };
  const setRoomGithubSubs = (room, repos, expiresAt) => {
    const prev = githubReposByRoom.get(room);
    if (prev) {
      for (const repo of prev) {
        const map = githubSubsByRepo.get(repo);
        if (map) {
          map.delete(room);
          if (!map.size) githubSubsByRepo.delete(repo);
        }
      }
      githubReposByRoom.delete(room);
    }
    if (!repos.length || expiresAt <= Date.now()) return;
    const next = new Set();
    for (const repo of repos) {
      const lower = repo.toLowerCase();
      next.add(lower);
      let map = githubSubsByRepo.get(lower);
      if (!map) githubSubsByRepo.set(lower, (map = new Map()));
      map.set(room, expiresAt);
    }
    githubReposByRoom.set(room, next);
  };
  const pruneRoomUnboundSubs = (room) => {
    const prev = githubReposByRoom.get(room);
    if (!prev) return;
    for (const repo of [...prev]) {
      if (githubBindings.resolveForRepo(room, repo) === null) {
        prev.delete(repo);
        const map = githubSubsByRepo.get(repo);
        if (map) {
          map.delete(room);
          if (!map.size) githubSubsByRepo.delete(repo);
        }
      }
    }
    if (!prev.size) githubReposByRoom.delete(room);
  };
  const pushInstallationsToRoom = (roomName) => {
    const host = rooms.get(roomName)?.activeHost();
    if (!host) return;
    send(
      host.ws,
      JSON.stringify({
        type: "github-installations",
        version: 1,
        appSlug: githubAppSlug,
        installations: githubBindings.listForRoom(roomName),
      }),
    );
  };
  const sweeper = setInterval(() => (invites.sweep(), spaces.sweep(), sweepGithub()), WINDOW_MS);
  sweeper.unref();
  const limiters = {
    sockets: new Limiter(LIMITS.sockets),
    requests: new Limiter(LIMITS.requests),
    invites: new Limiter(LIMITS.invites),
    spaces: new Limiter(LIMITS.spaces),
    githubIp: new Limiter(LIMITS.githubIp),
    githubInstall: new Limiter(LIMITS.githubInstall),
  };
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
      this.pending = new PendingRequests();
      this.timer = null;
      this.due = Infinity;
    }

    openHosts() {
      return this.hosts.filter((side) => side.ws.readyState === side.ws.OPEN && !side.closing);
    }
    openPhones() {
      return [...this.phones.values()].filter((side) => side.ws.readyState === side.ws.OPEN && !side.closing);
    }
    openPhone(conn) {
      const side = this.phones.get(conn);
      return side && side.ws.readyState === side.ws.OPEN && !side.closing ? side : null;
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
      this.expirePending(now);
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
        this.pending.clear();
      }
      this.attach(side);
    }

    acceptPhone(ws, from) {
      this.expirePending(Date.now());
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
      this.reapStaleHosts(Date.now());
      this.attach(side);
    }

    attach(side) {
      const { ws } = side;
      ws.on("message", (data, binary) => {
        if (!binary) {
          const text = data.toString();
          if (text === "ping") {
            this.pinged(side);
            send(ws, "pong");
          } else if (side.kind === "host" && !side.closing && text.length <= 64 * 1024 && text.startsWith("{")) {
            void this.handleHostControl(ws, text);
          }
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

    async handleHostControl(ws, text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        send(ws, JSON.stringify({ type: "github-subscribed", ok: false, error: "bad_json" }));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const msgType = typeof parsed.type === "string" ? parsed.type : "";
      const apiBase = githubApiBase || process.env.GITHUB_API_BASE || undefined;

      if (msgType === "github-token") {
        const checked = await verifyGitHubTokenRequest(parsed, this.name);
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId : "";
        if (!checked.ok) {
          send(ws, JSON.stringify({ type: "github-token-result", requestId, ok: false, error: checked.error }));
          return;
        }
        if (!githubAgentApp) {
          send(ws, JSON.stringify({ type: "github-token-result", requestId: checked.requestId, ok: false, error: "app_not_configured" }));
          return;
        }
        const access = githubBindings.resolveForRepo(this.name, checked.repo);
        if (!access) {
          send(ws, JSON.stringify({ type: "github-token-result", requestId: checked.requestId, ok: false, error: "not_bound" }));
          return;
        }
        const effectivePermissions = clampPermissionsForRepoAccess(checked.permissions, access.canWrite);
        const minted = await mintSingleRepoInstallationToken(
          githubAgentApp,
          access.installationId,
          checked.repo,
          effectivePermissions,
          {
            fetch,
            apiBase,
          },
        );
        if (!minted.ok) {
          log("github_token", { status: minted.status, error: minted.error });
          send(ws, JSON.stringify({ type: "github-token-result", requestId: checked.requestId, ok: false, error: minted.error }));
          return;
        }
        log("github_token", { status: 201 });
        send(
          ws,
          JSON.stringify({
            type: "github-token-result",
            requestId: checked.requestId,
            ok: true,
            repo: checked.repo,
            installationId: access.installationId,
            token: minted.token,
            expiresAt: minted.expiresAt,
            permissions: minted.permissions,
          }),
        );
        return;
      }

      if (msgType === "github-claim") {
        const checked = await verifyGitHubClaimRequest(parsed, this.name);
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId : "";
        if (!checked.ok) {
          send(ws, JSON.stringify({ type: "github-claim-result", requestId, ok: false, claimed: false, error: checked.error }));
          return;
        }
        sweepGithub();
        const existing = githubDeliveryClaims.get(checked.deliveryId);
        let claimed = false;
        if (existing && existing.until > Date.now()) {
          claimed = existing.room === this.name;
        } else {
          githubDeliveryClaims.set(checked.deliveryId, { room: this.name, until: Date.now() + GITHUB_CLAIM_TTL_MS });
          while (githubDeliveryClaims.size > GITHUB_CLAIM_MAX) {
            const oldest = githubDeliveryClaims.keys().next().value;
            if (oldest === undefined) break;
            githubDeliveryClaims.delete(oldest);
          }
          claimed = true;
        }
        send(ws, JSON.stringify({ type: "github-claim-result", requestId: checked.requestId, ok: true, claimed }));
        return;
      }

      if (msgType === "github-installations-list") {
        const checked = await verifyGitHubInstallationsListRequest(parsed, this.name);
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId : "";
        if (!checked.ok) {
          send(ws, JSON.stringify({ type: "github-installations-result", requestId, ok: false, error: checked.error }));
          return;
        }
        send(
          ws,
          JSON.stringify({
            type: "github-installations-result",
            requestId: checked.requestId,
            ok: true,
            appSlug: githubAppSlug,
            installations: githubBindings.listForRoom(this.name),
          }),
        );
        return;
      }

      if (msgType === "github-unbind") {
        const checked = await verifyGitHubUnbindRequest(parsed, this.name);
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId : "";
        if (!checked.ok) {
          send(ws, JSON.stringify({ type: "github-unbind-result", requestId, ok: false, error: checked.error }));
          return;
        }
        githubBindings.unbind(this.name, checked.installationId);
        pruneRoomUnboundSubs(this.name);
        send(
          ws,
          JSON.stringify({
            type: "github-unbind-result",
            requestId: checked.requestId,
            ok: true,
            installations: githubBindings.listForRoom(this.name),
          }),
        );
        return;
      }

      if (msgType !== "github-subscribe") return;

      const checked = await verifyGitHubSubscribe(text, this.name);
      if (!checked.ok) {
        send(ws, JSON.stringify({ type: "github-subscribed", ok: false, error: checked.error }));
        return;
      }

      let allowedRepos = [];
      let deniedRepos = [];
      if (legacyUserTokenMode) {
        const cachedAllowed = activeRoomGithubSubs(this.name, checked.expiresAt);
        const res = await authorizeSubscribedRepos(checked.repos, checked.proofs, {
          cachedAllowed,
          fetch,
          apiBase,
        });
        allowedRepos = res.allowed;
        deniedRepos = res.denied;
      } else {
        for (const repo of checked.repos) {
          if (githubBindings.resolveForRepo(this.name, repo) !== null) allowedRepos.push(repo);
          else deniedRepos.push(repo);
        }
        allowedRepos.sort();
        deniedRepos.sort();
      }
      setRoomGithubSubs(this.name, allowedRepos, checked.expiresAt);
      send(
        ws,
        JSON.stringify({
          type: "github-subscribed",
          ok: true,
          count: allowedRepos.length,
          allowed: allowedRepos,
          denied: deniedRepos,
          expiresAt: checked.expiresAt,
        }),
      );
    }

    message(side, bytes) {
      this.expirePending(Date.now());
      if (side.ws.readyState !== side.ws.OPEN) return;
      if (side.kind === "phone") {
        this.reapStaleHosts(Date.now());
        const host = this.activeHost();
        if (!host) {
          // A v3 host has a short reconnect window. Keep opaque requests for that window; a v2 room
          // still gets the immediate per-request offline answer.
          if (!this.recovery && this.seat) this.beginRecovery(this.seat.group);
          const held = this.recovery && this.recovery.until > Date.now() ? this.pending.add(side.ids, bytes) : null;
          if (!held && isRequest(bytes)) send(side.ws, offline(readU32(bytes, 1)));
          return;
        }
        if (host.version !== "v3") {
          send(host.ws, prefixed(side.ids, bytes));
          return;
        }
        if (!isRequest(bytes)) return;
        // If a reconnect just drained held requests, they keep their arrival order before a new one.
        const pending = this.pending.add(side.ids, bytes);
        if (!pending) send(side.ws, offline(readU32(bytes, 1)));
        else this.drainPending(host);
        return;
      }
      if (side.closing) return;
      if (side.version === "v3") side.lastBinaryAt = Date.now();
      // [conn 8] + the answer. A short message, or a phone that is gone, is dropped.
      if (bytes.length < 9) return;
      const conn = hex(bytes.subarray(0, 8));
      const phone = this.openPhone(conn);
      if (side.version === "v3" && bytes.length >= 13 && bytes[8] === 0x02) {
        const accepted = this.pending.accept(conn, readU32(bytes, 9), phone?.ids);
        send(side.ws, prefixed(unhex(accepted.ids), prefixed(Uint8Array.of(NOTICE_ANSWER_ACCEPTED), bytes.subarray(9, 13))));
        if (accepted.duplicate) return;
      }
      if (phone) send(phone.ws, bytes.subarray(8));
    }

    /** A socket is gone, by its own close or by an error. `ws` reports both, so the second call finds nothing to do. */
    closed(side) {
      this.expirePending(Date.now());
      const first = !side.notified && !side.closing;
      if (side.kind === "host") this.hosts = this.hosts.filter((entry) => entry !== side);
      else if (this.phones.get(side.conn) === side) this.phones.delete(side.conn);
      this.ended(side);
      if (side.kind === "host" && first) this.hostEnded(side);
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
      this.expirePending(now);
      this.reapStaleHosts(now);
      if (this.recovery && this.activeHost()) this.recovery = null;
      // The old runtime did not return. Fail both queued and in-flight phones once.
      else if (this.recovery && this.recovery.until <= now) this.failRecovery();
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
        this.beginRecovery(stale[0].group, undefined, Math.max(...stale.map(side => this.activity(side).deadline)) + V3_RECONNECT_WINDOW);
      }
    }

    beginRecovery(group, leaving, until = Date.now() + V3_RECONNECT_WINDOW) {
      if (this.openHosts().length) return null;
      if (this.recovery?.group === group) return this.recovery;
      if (until <= Date.now()) {
        this.failRecovery();
        return null;
      }
      // Every phone the computer has not been told about. One whose close has begun counts too: `ws`
      // reports a close only when the connection is gone, so a phone and the computer leaving together
      // can arrive here in either order.
      const ids = [...this.phones.values()].filter((side) => !side.notified).map((side) => hex(side.ids));
      if (leaving && !ids.includes(hex(leaving))) ids.push(hex(leaving));
      this.recovery = { group, until, phones: ids };
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
        this.pending.clear(true);
        this.recovery = null;
      }
    }

    /** Ends a v3 reconnect window or an explicit cross-runtime takeover. */
    failRecovery(notify = true) {
      this.pending.clear(true);
      this.recovery = null;
      this.seat = null;
      setRoomGithubSubs(this.name, [], 0);
      if (notify) for (const phone of this.openPhones()) send(phone.ws, Uint8Array.of(NOTICE_HOST_CLOSED));
    }

    drainPending(host, replay = false) {
      this.pending.drain(item => send(host.ws, prefixed(unhex(item.ids), item.body)), replay);
    }

    expirePending(now) {
      this.pending.expire(now, item => {
        const phone = this.openPhone(item.ids.slice(0, 16));
        if (phone) send(phone.ws, offline(item.requestId));
      });
    }

    /** Tells the other side, once, that a socket is gone: the computer about a phone, every phone about the computer. */
    ended(side) {
      if (side.notified) return;
      side.notified = true;
      if (side.kind === "phone") {
        this.pending.drop(side.ids);
        const host = this.activeHost();
        if (host) send(host.ws, prefixed(side.ids, Uint8Array.of(NOTICE_PHONE_CLOSED)));
        else if (this.seat) this.beginRecovery(this.seat.group, side.ids);
      } else if (side.version !== "v3") {
        // What the phones still wait for will not be answered; they can try again at once. A v3
        // standby is already a usable seat, so its active peer disappearing is silent.
        for (const phone of this.openPhones()) send(phone.ws, Uint8Array.of(NOTICE_HOST_CLOSED));
        if (!this.openHosts().length) setRoomGithubSubs(this.name, [], 0);
      }
    }

    /** Closes a socket from this side, to make room for another. The reason is one of our own fixed words. */
    end(side, code, reason) {
      if (side.closing) return;
      log("drop", { kind: side.kind, code, reason });
      side.closing = true;
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
        this.pending.nextExpiry(),
        ...(this.pending.length ? this.openHosts() : []).map((side) => (side.version === "v3" ? this.activity(side).deadline : Infinity)),
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
      if (!this.hosts.length && !this.phones.size && !this.recovery && !this.seat && rooms.get(this.name) === this) {
        rooms.delete(this.name);
      }
    }
  }

  const roomFor = (name) => {
    let room = rooms.get(name);
    if (!room) rooms.set(name, (room = new Room(name)));
    return room;
  };

  async function forwardPush(request, route = "/v1/push", off = "push_off") {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    if (pushUpstream === "off") return Response.json({ error: off }, { status: 503 });
    const body = await readCappedText(request, MAX_PUSH_BODY);
    if (body === null) return Response.json({ error: "too_large" }, { status: 413 });
    try {
      const upstream = await fetch(pushUpstream.replace(/\/+$/, "") + route, {
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

  async function handleGitHubSetup(request, network) {
    if (!allowed("requests", network)) return plain("Too many requests", 429);
    if (request.method !== "GET") return plain("Method not allowed", 405);
    if (!githubAgentApp) {
      return githubSetupResultPage({ ok: false, message: "Botkins Agent GitHub App credentials are not configured on this relay." });
    }
    const url = new URL(request.url);
    const code = (url.searchParams.get("code") ?? "").trim();
    const stateParam = (url.searchParams.get("state") ?? "").trim();
    const instParam = (url.searchParams.get("installation_id") ?? "").trim();
    const installationId = /^\d{1,12}$/.test(instParam) ? Number(instParam) : 0;
    if (!code || !stateParam || !installationId) {
      return githubSetupResultPage({ ok: false, message: "Missing installation_id, code, or state from GitHub." });
    }
    const verifiedState = await verifyGitHubSetupState(stateParam);
    if (!verifiedState.ok) {
      log("github_setup", { status: 400, reason: verifiedState.error });
      return githubSetupResultPage({
        ok: false,
        message: verifiedState.error === "expired_state"
          ? "This install link expired (10-minute limit). Start again from Botkins Settings › GitHub."
          : "This install link signature is invalid. Start again from Botkins Settings › GitHub.",
      });
    }
    sweepGithub();
    if (githubUsedNonces.has(verifiedState.nonce)) {
      log("github_setup", { status: 400, reason: "replayed_nonce" });
      return githubSetupResultPage({ ok: false, message: "This install link was already used. Start again from Botkins Settings › GitHub." });
    }
    githubUsedNonces.set(verifiedState.nonce, Math.max(Date.now() + GITHUB_NONCE_TTL_MS, verifiedState.exp * 1000));
    while (githubUsedNonces.size > GITHUB_NONCE_MAX) {
      const oldest = githubUsedNonces.keys().next().value;
      if (oldest === undefined) break;
      githubUsedNonces.delete(oldest);
    }

    const oauth = await verifyGitHubInstallationOAuth(githubAgentApp, code, installationId, {
      fetch,
      apiBase: githubApiBase || process.env.GITHUB_API_BASE || undefined,
      webBase: githubWebBase || process.env.GITHUB_WEB_BASE || undefined,
    });
    if (!oauth.ok) {
      log("github_setup", { status: oauth.status, reason: oauth.error });
      return githubSetupResultPage({
        ok: false,
        message: oauth.error === "installation_not_authorized"
          ? "GitHub confirmed you do not have access to that installation."
          : "GitHub could not verify this installation. Please try again.",
      });
    }

    githubBindings.bind(verifiedState.room, oauth.installation, Date.now(), effectiveBindingTtlMs);
    pruneRoomUnboundSubs(verifiedState.room);
    pushInstallationsToRoom(verifiedState.room);
    log("github_setup", { status: 200, repos: oauth.installation.repos.length });
    return githubSetupResultPage({
      ok: true,
      accountLogin: oauth.installation.accountLogin,
      repoCount: oauth.installation.repos.length,
    });
  }

  async function handleGitHubEvents(request, network) {
    const checked = await checkGitHubWebhookRequest(request, githubWebhookSecret, {
      checkIp: async () => allowed("githubIp", network),
      checkInstallation: async (key) => allowed("githubInstall", key),
    });
    if (checked instanceof Response) return checked;

    const now = Date.now();
    sweepGithub();
    if (githubSeenDeliveries.has(checked.deliveryId)) {
      log("github_delivery", { event: checked.event, status: 202, duplicate: 1, delivered: 0 });
      return Response.json({ ok: true, duplicate: true, delivered: 0 }, { status: 202, headers: { "cache-control": "no-store" } });
    }
    githubSeenDeliveries.set(checked.deliveryId, now + GITHUB_DELIVERY_DEDUPE_TTL_MS);
    while (githubSeenDeliveries.size > GITHUB_DELIVERY_DEDUPE_MAX) {
      const oldest = githubSeenDeliveries.keys().next().value;
      if (oldest === undefined) break;
      githubSeenDeliveries.delete(oldest);
    }

    if (checked.kind === "installation") {
      let repos = checked.repositories;
      if (
        checked.event === "installation" &&
        (checked.action === "created" || checked.action === "unsuspend") &&
        checked.repositorySelection === "all" &&
        githubAgentApp
      ) {
        const fetched = await fetchInstallationRepos(githubAgentApp, checked.installationId, {
          fetch,
          apiBase: githubApiBase || process.env.GITHUB_API_BASE || undefined,
        });
        if (fetched.length) repos = fetched;
      }
      const affectedRooms = githubBindings.applyEvent({ ...checked, repositories: repos });
      for (const roomName of affectedRooms) {
        pruneRoomUnboundSubs(roomName);
        pushInstallationsToRoom(roomName);
      }
      log("github_installation_event", { event: checked.event, action: checked.action, rooms: affectedRooms.length });
      return Response.json({ ok: true }, { status: 202, headers: { "cache-control": "no-store" } });
    }

    if (checked.kind === "membership") {
      const affectedRooms = githubBindings.applyMembershipEvent(checked, now);
      for (const roomName of affectedRooms) {
        pruneRoomUnboundSubs(roomName);
        pushInstallationsToRoom(roomName);
      }
      log("github_membership_event", { event: checked.event, action: checked.action, rooms: affectedRooms.length });
      return Response.json({ ok: true }, { status: 202, headers: { "cache-control": "no-store" } });
    }

    const targets = githubSubsByRepo.get(checked.repositoryLower);
    if (!targets || !targets.size) {
      log("github_delivery", { event: checked.event, status: 204, delivered: 0 });
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    const frameText = JSON.stringify(checked.frame);
    let delivered = 0;
    let eligibleCount = 0;
    for (const [roomName, until] of targets) {
      if (until <= now) continue;
      const boundOk =
        checked.installationId !== null &&
        githubBindings.isRoomBoundToInstallationRepo(roomName, checked.installationId, checked.repositoryLower, now);
      if (!boundOk && !legacyUserTokenMode) continue;
      eligibleCount++;
      const host = rooms.get(roomName)?.activeHost();
      if (host && send(host.ws, frameText)) delivered++;
    }
    log("github_delivery", { event: checked.event, status: delivered > 0 ? 202 : 204, targets: eligibleCount, delivered });
    return delivered > 0
      ? Response.json({ ok: true, delivered }, { status: 202, headers: { "cache-control": "no-store" } })
      : new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  /** Everything that is not a new socket, as the Worker answers it. */
  async function answer(request, network) {
    const url = new URL(request.url);
    if (url.pathname === GITHUB_EVENTS_PATH) {
      return handleGitHubEvents(request, network);
    }
    if (url.pathname === GITHUB_SETUP_PATH) {
      return handleGitHubSetup(request, network);
    }
    if (url.pathname === "/v1/push") {
      if (!allowed("requests", network)) return Response.json({ error: "rate_limited" }, { status: 429 });
      return forwardPush(request);
    }
    // A computer's signed bug report or feature request goes on to the upstream relay, which holds
    // the GitHub token and checks the signature. This relay never sees a token of its own.
    if (url.pathname === "/v1/feedback") {
      if (!allowed("requests", network)) return Response.json({ error: "rate_limited" }, { status: 429 });
      return forwardPush(request, "/v1/feedback", "feedback_off");
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
    if (url.pathname === "/mcp-auth") return mcpAuthRedirect(url);
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
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || undefined,
    githubAgentAppId: process.env.GITHUB_AGENT_APP_ID || undefined,
    githubAgentAppSlug: process.env.GITHUB_AGENT_APP_SLUG || undefined,
    githubAgentAppKey: process.env.GITHUB_AGENT_APP_KEY || undefined,
    githubAgentClientId: process.env.GITHUB_AGENT_CLIENT_ID || undefined,
    githubAgentClientSecret: process.env.GITHUB_AGENT_CLIENT_SECRET || undefined,
    githubAllowUserTokenAuth: process.env.GITHUB_ALLOW_USER_TOKEN_AUTH === "1" || process.env.GITHUB_ALLOW_USER_TOKEN_AUTH === "true",
    limits: process.env.RATE_LIMITS !== "off",
    qrFile: process.env.QR_FILE || undefined,
    botkinsDir: process.env.BOTKINS_DIR || undefined,
    spaceBytesMax: Number(process.env.SPACE_BYTES_MAX) || undefined,
  });
  server.listen(port, process.env.HOST || "0.0.0.0", () => log("listening", { code: port }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));
}
