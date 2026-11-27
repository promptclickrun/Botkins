// Other computers' Botkins that this app is paired to, and using one of them from this window
// (desktop/link/CONTRACT.md, "desktop as a client").
//
// This app is then a client like a paired phone: it holds a credential of its own for each host,
// follows the host's state, and sends the window's calls there. Nothing of the host's is copied
// into this computer's own workspace, which keeps running untouched: its bots, chats and routines
// are there again the moment the person switches back to "This computer".
//
//   pair      a code from the host (Settings › Phone › Pair there), with the host's address, or
//             the pairing link the host shows. The host lists this app as a device of kind "desktop".
//   use       makes one host the one the window shows, or none (this computer). The choice is
//             kept, so the app opened again is on the same computer as when it was closed (resume).
//   forget    unpairs: the host is told, and the credential is deleted here.
//
// The credential (the link's `Pairing`, which holds this app's secret key) is kept wrapped by
// `protect`: the system keychain's key in the installed app, as for the vault. A trial run keeps
// it in its own data folder, readable by this user only, and never touches the keychain.
//
// What the window gets while a host is in use is that host's state, rebuilt from the parts the
// link sends (snapshotOf). A chat's messages are there for the chats the window is looking at;
// the rest are listed with their last line, as on a phone.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_MARK_CHATS_READ, REMOTE_METHODS } from "./link/methods.mjs";
import { cleanBotVoice, effectiveTts } from "./link/voice.mjs";
import { diffRemoteNotifications, parseScopedId } from "./unified-hosts.mjs";

/** What this app can do as a client, by the name another build would look for. */
export const REMOTE_HOSTS = "remote-hosts-v1";
/** A client follows at most this many chats in detail (the link's own limit). */
const WATCHED = 4;

const MISSING_CHAT_RE = /^unknown chat\b(?!\s+flag\b)|\bchat\b.*\b(?:no longer (?:exists|available)|not found|gone)\b/i;
const UNAVAILABLE_MEMBER_CHAT = "That chat belongs to the owner or another member.";

/** Per-chat `setChatFlags` fallback errors that mean the chat is gone or not visible to this member. */
export function isSkippedMarkReadError(message) {
  const text = String(message ?? "").trim();
  return text === UNAVAILABLE_MEMBER_CHAT || MISSING_CHAT_RE.test(text);
}

/** Calls about this window and this computer: they run here whichever host is shown. */
export const HERE = new Set([
  "snapshot", "appInfo", "sendFeedback", "appUpdateStatus", "checkAppUpdate", "installAppUpdate", "setAppUpdateAuto", "openAppRelease",
  "viewing",
  "openLink",
  "copyText",
  "showEmojiPanel",
  "artifactMessagePage",
  "artifactMedia",
  "closeArtifactMedia",
  "openSignIn",
  "remoteHosts",
  "remoteScreen",
  "pairRemoteHost",
  "takeTeamJoin",
  "findTeamInvite",
  "startTeamJoin",
  "checkTeamJoin",
  "teamJoins",
  "cancelTeamJoin",
  "useRemoteHost",
  "setUnifiedHosts",
  "setUnifiedHostIncluded",
  "setSettingsHost",
  "forgetRemoteHost",
  "renameRemoteHost",
  // Account profile calls belong to this installation, even while another host is selected.
  "profileStatus",
  "profileStart",
  "profileOpen",
  "profileFinish",
  "profileRefresh",
  "profileHome",
  "profileUpdate",
  "profileDisconnect",
  "profileReconnect",
  "profileDeleteAccount",
  "profileOptOut",
  "profileSignOut",
  "profileApprove",
  "profileRevoke",
  "profileConnect",
  "profileMarkMigrationPrompted",
]);
/** Window calls that are the link's own on another computer, by the name the link knows them. */
const LINK_NAMES = { inviteToChat: "link.team.inviteToChat", removeFromChat: "link.team.removeFromChat", voiceOptions: "link.voice.options" };
/** Settings that belong to the window a person sits at, not to the computer whose bots it shows. */
const OWN_SETTINGS = ["appearance", "sidebar", "background", "onboarded"];

/**
 * A settings change made while another computer is in use, in two: what is this window's own
 * (applied here) and what is the other computer's (sent there). Either may be null.
 */
export function splitPreferences(patch) {
  const own = {};
  const theirs = {};
  for (const [key, value] of Object.entries(patch && typeof patch === "object" ? patch : {})) (OWN_SETTINGS.includes(key) ? own : theirs)[key] = value;
  return { own: Object.keys(own).length ? own : null, theirs: Object.keys(theirs).length ? theirs : null };
}

const text = (value, most = 60) => (typeof value === "string" && value.trim() ? value.trim().slice(0, most) : "");

/**
 * The host's state as the window reads it, from the link's parts: `parts` by name, with
 * "chat:<id>" (a page of a chat's messages and their runs) and "run:<id>" (a chat's running turn)
 * for the chats being followed. `own` is this computer's own settings: how the window looks stays
 * the person's choice here.
 */
export function snapshotOf(parts, own = {}) {
  const live = parts.live ?? {};
  const detailed = new Map();
  const chats = (Array.isArray(parts.chats) ? parts.chats : []).map((summary) => {
    const detail = parts["chat:" + summary.id];
    for (const run of detail?.runs ?? []) detailed.set(run.id, run);
    const running = parts["run:" + summary.id];
    if (running?.id) detailed.set(running.id, running);
    return {
      ...summary,
      messages: detail?.messages ?? [],
      // Where the loaded page starts and how many messages the chat has in all.
      ...(detail ? { loaded: { from: detail.from ?? 0, total: detail.total ?? detail.messages?.length ?? 0 } } : { loaded: null }),
      ...(detail?.pane && { pane: detail.pane }),
      ...(detail?.todos && { todos: detail.todos }),
    };
  });
  const listed = Array.isArray(parts.runs) ? parts.runs : [];
  const seen = new Set(listed.map((run) => run.id));
  const runs = [...listed.map((run) => detailed.get(run.id) ?? run), ...[...detailed.values()].filter((run) => !seen.has(run.id))];
  const settings = { ...(parts.settings ?? {}) };
  for (const key of OWN_SETTINGS) if (own[key] !== undefined) settings[key] = own[key];
  return {
    settings,
    ...(parts.team && { team: parts.team }),
    ...(parts.phones && typeof parts.phones === "object" && {
      remotePhones: Object.entries(parts.phones)
        .filter(([, phone]) => phone?.kind !== "gadget" && phone?.kind !== "browser")
        .map(([id, phone]) => ({
          id,
          name: phone.name,
          kind: phone.kind,
          platform: phone.platform,
          canNotify: phone.push?.routines === true,
        })),
    }),
    bots: parts.bots ?? [],
    sections: parts.sections ?? [],
    // The paired person's own sections on the Chats page ("chat-sections-v1"); each chat says its own.
    ...(Array.isArray(parts.chatSections) && { chatSections: parts.chatSections }),
    chats,
    runs,
    streams: live.streams ?? {},
    intents: live.intents ?? {},
    thinking: live.thinking ?? {},
    speakers: live.speakers ?? {},
    typing: live.typing ?? {},
    queued: live.queued ?? {},
    requests: live.requests ?? [],
    panels: parts.panels ?? [],
    board: parts.board ?? [],
    // The spaces the paired person can open, in their order ("spaces-v1"). A host without Spaces
    // sends none, and the window then shows the Today page from `panels` and `board`.
    ...(Array.isArray(parts.spaces) && { spaces: parts.spaces }),
    // Admin mode as the other computer keeps it for this device, when this device is its owner's.
    ...(parts.meta?.you?.kind === "owner" && typeof parts.meta.you.admin === "boolean" && { adminMode: parts.meta.you.admin }),
    tasks: parts.tasks ?? [],
    // The Proactive agent: the computer's switch and each bot's agent (a member is sent only their own).
    ...(parts.proactive && { proactive: parts.proactive }),
    projects: parts.projects ?? [],
    mcpServers: parts.mcp ?? [],
    plugins: parts.plugins ?? [],
    skills: parts.skills ?? { folders: [], plugins: [], disabled: [] },
    templates: parts.templates ?? [],
    wiki: { revision: parts.revs?.wiki ?? 0 },
    artifacts: { revision: parts.revs?.artifacts ?? 0 },
    providers: { revision: parts.revs?.providers ?? 0 },
    // Things of the host's own computer that a client has no part in.
    frames: [],
    apps: [],
    macTools: { available: false },
  };
}

export class RemoteHosts {
  /**
   * @param options.file     Where the paired hosts are kept.
   * @param options.protect  { wrap(text) → string, unwrap(string) → text | null } for the credentials, or null to
   *                         keep them as they are (a trial run's own folder).
   * @param options.lib      The link's client library (desktop/remote/link-client.mjs), or a stand-in.
   * @param options.fetch    The fetch the link uses. Tests pass one that reaches a host in the same process.
   * @param options.device   { name, platform } as the host will list this app.
   * @param options.changed  Called when what the window shows changed: a host's state, or which host is in use.
   */
  constructor({ file = null, protect = null, persistProfileKeys = true, lib, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, device, changed = () => {}, onEvent = () => {}, log = () => {} }) {
    Object.assign(this, { file, protect, lib, fetch, WebSocket, device, changed, onEvent, log });
    this.persistProfileKeys = persistProfileKeys && typeof protect?.wrap === "function" && typeof protect?.unwrap === "function";
    this.hosts = [];
    this.current = null;
    this.client = null;
    this.parts = {};
    this.state = "idle";
    this.route = null;
    this.watching = [];
    this.unified = false;
    this.excluded = new Set();
    this.pool = new Map();
    this.joins = new Map();
    // The host that was in use when the app was last closed (resume() goes back to it).
    this.remembered = null;
    this.rememberedUnified = false;
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const entry of Array.isArray(saved?.hosts) ? saved.hosts : []) {
        // Profile connections are account-bound credentials.  A development or headless host
        // without a usable vault may still use one for this process, but must never resurrect a
        // profile private key from the plaintext compatibility file.
        if (entry.profileBound === true && !this.persistProfileKeys) continue;
        const pairing = this.open(entry.pairing);
        if (pairing?.serverId && pairing.secretKey) this.hosts.push({ id: pairing.serverId, name: text(entry.name) || text(pairing.name) || "Computer", team: text(entry.team), member: pairing.member === true, profileBound: entry.profileBound === true, addedAt: Number(entry.addedAt) || Date.now(), pairing });
      }
      for (const entry of Array.isArray(saved?.joins) ? saved.joins : []) {
        const attempt = this.open(entry.attempt);
        if (attempt?.keys?.secretKey && attempt?.target?.code) {
          const id = text(entry.id) || attempt.keys.publicKey || attempt.target.code;
          this.joins.set(id, {
            id,
            attempt,
            team: text(entry.team) || text(attempt.target?.name) || "the team",
            createdAt: Number(entry.createdAt) || Date.now(),
            status: "pending",
            ...(text(entry.requestId) && { requestId: text(entry.requestId) }),
          });
        }
      }
      if (Array.isArray(saved?.excludedHosts)) {
        for (const id of saved.excludedHosts) if (typeof id === "string" && id) this.excluded.add(id);
      }
      if (saved?.unified === true) this.rememberedUnified = true;
      if (typeof saved?.current === "string" && this.hosts.some((host) => host.id === saved.current)) this.remembered = saved.current;
    } catch {
      // No host paired yet, or a file that can't be read: the person pairs again.
    }
  }
  seal(pairing) {
    const json = JSON.stringify(pairing);
    return this.protect ? { wrapped: this.protect.wrap(json) } : { plain: json };
  }
  open(kept) {
    try {
      if (kept?.wrapped && this.protect) return JSON.parse(this.protect.unwrap(kept.wrapped));
      if (kept?.plain && !this.protect) return JSON.parse(kept.plain);
    } catch {
      // A credential that can't be read is the same as none.
    }
    return null;
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    // `current` is the host in use (its id, which is no secret), or null for this computer.
    const current = this.hosts.some((host) => host.id === this.current) ? this.current : null;
    const excludedHosts = [...this.excluded].filter((id) => this.hosts.some((host) => host.id === id));
    writeFileSync(this.file, JSON.stringify({
      current,
      unified: this.unified === true,
      ...(excludedHosts.length > 0 && { excludedHosts }),
      // Keep profile-obtained private keys in memory when there is no protected store.  Legacy
      // manual pairings retain their existing trial-file behavior for local development.
      hosts: this.hosts.filter((host) => host.profileBound !== true || this.persistProfileKeys).map((host) => ({
        name: host.name,
        addedAt: host.addedAt,
        ...(host.team && { team: host.team }),
        ...(host.profileBound === true && { profileBound: true }),
        pairing: this.seal(host.pairing),
      })),
      joins: [...this.joins.values()].map((entry) => ({
        id: entry.id,
        team: entry.team,
        createdAt: entry.createdAt,
        ...(entry.requestId && { requestId: entry.requestId }),
        attempt: this.seal(entry.attempt),
      })),
    }, null, 2), { mode: 0o600 });
  }
  /**
   * Goes back to the host that was in use when the app was last closed, if it is still paired.
   * Called once when the app starts. Returns what is in use, or null for this computer.
   */
  resume() {
    const wantUnified = this.rememberedUnified;
    const id = this.remembered;
    this.remembered = null;
    this.rememberedUnified = false;
    if (wantUnified) {
      this.setUnified(true);
      return null;
    }
    return id && !this.current && this.hosts.some((host) => host.id === id) ? this.use(id) : this.inUse();
  }
  /** Whether the person has opted to operate all bots in one unified view. */
  unifiedEnabled() {
    return this.unified === true;
  }
  /** Paired hosts currently included in the unified view. */
  includedHosts() {
    return this.hosts.filter((host) => !this.excluded.has(host.id));
  }
  /** True when unified multi-host mode is active with at least one included remote host. */
  isUnified() {
    return this.unified === true && this.includedHosts().length > 0;
  }
  /** Turns unified multi-host view on or off and reconciles live connections. */
  setUnified(enabled) {
    const next = enabled === true;
    if (next === this.unified) {
      if (next) this.syncPool();
      return this.unified;
    }
    this.unified = next;
    if (next) {
      this.stop();
      this.current = null;
      this.syncPool();
    } else {
      this.stopPool();
    }
    this.save();
    this.changed();
    return this.unified;
  }
  /** Includes or excludes one paired host from the unified view. */
  setHostIncluded(id, included) {
    const host = this.find(id);
    if (included) this.excluded.delete(host.id);
    else this.excluded.add(host.id);
    if (this.unified) this.syncPool();
    this.save();
    this.changed();
    return !this.excluded.has(host.id);
  }
  /** Opens/closes pooled LinkClient connections to match all included hosts when unified mode is on. */
  syncPool() {
    if (!this.unified) {
      this.stopPool();
      return;
    }
    const wanted = new Set(this.includedHosts().map((h) => h.id));
    for (const [id, slot] of this.pool) {
      if (!wanted.has(id)) {
        slot.client.stop();
        this.pool.delete(id);
      }
    }
    for (const host of this.includedHosts()) {
      const existing = this.pool.get(host.id);
      if (existing) {
        if (existing.state !== "online" && existing.state !== "connecting") existing.client.wake("network");
        continue;
      }
      const slot = { host, client: null, parts: {}, state: "connecting", route: null, watching: [], initialized: false };
      const client = new this.lib.LinkClient(host.pairing, {
        fetch: this.transport(),
        onParts: (parts) => {
          if (this.pool.get(host.id)?.client !== client) return;
          const prev = slot.initialized ? { live: slot.parts.live, runs: slot.parts.runs } : null;
          for (const [name, value] of Object.entries(parts)) {
            if (value === null || value === undefined) delete slot.parts[name];
            else slot.parts[name] = value;
          }
          if (!slot.initialized && (slot.parts.bots || slot.parts.chats || slot.parts.live)) {
            slot.initialized = true;
          } else if (slot.initialized) {
            const hostName = text(slot.parts.meta?.name) || host.name;
            for (const event of diffRemoteNotifications(prev, slot.parts, { hostId: host.id, hostName })) {
              try { this.onEvent?.(event); } catch { /* notification listener errors never break sync */ }
            }
          }
          this.changed();
        },
        onState: (state) => {
          if (this.pool.get(host.id)?.client !== client) return;
          slot.state = state;
          this.changed();
        },
        onHosts: (hosts) => {
          if (this.pool.get(host.id)?.client !== client || !Array.isArray(hosts)) return;
          host.pairing = { ...host.pairing, hosts };
          this.save();
        },
        onRoute: (route) => {
          if (this.pool.get(host.id)?.client !== client) return;
          slot.route = route;
          this.changed();
        },
      });
      slot.client = client;
      this.pool.set(host.id, slot);
      client.start();
    }
  }
  stopPool() {
    for (const slot of this.pool.values()) slot.client.stop();
    this.pool.clear();
  }
  stopAll() {
    this.stop();
    this.stopPool();
  }
  /** Wakes all pooled connections (or the single active connection) to reconnect right away. */
  retryHost(id) {
    if (this.unified && id) {
      const slot = this.pool.get(id);
      if (slot) {
        slot.client.wake("network");
        return;
      }
    }
    this.wake();
  }
  /** Per-host snapshots and metadata for unified composition. */
  unifiedEntries(own) {
    const entries = [];
    for (const host of this.includedHosts()) {
      const slot = this.pool.get(host.id);
      if (!slot) continue;
      const name = text(slot.parts.meta?.name) || host.name;
      const team = text(slot.parts.team?.team?.name) || host.team;
      entries.push({
        host: {
          id: host.id,
          name,
          state: slot.state,
          route: slot.route,
          version: slot.parts.meta?.version ?? null,
          capabilities: slot.parts.meta?.capabilities ?? [],
          ...(host.member && { member: true }),
          ...(team && { team }),
        },
        snapshot: snapshotOf(slot.parts, own),
      });
    }
    return entries;
  }
  /** Live status rows for every remote host currently in the unified view. */
  unifiedHostsStatus() {
    return this.includedHosts().map((host) => {
      const slot = this.pool.get(host.id);
      const team = text(slot?.parts.team?.team?.name) || host.team;
      return {
        id: host.id,
        name: text(slot?.parts.meta?.name) || host.name,
        state: slot?.state ?? "idle",
        route: slot?.route ?? null,
        version: slot?.parts.meta?.version ?? null,
        capabilities: slot?.parts.meta?.capabilities ?? [],
        bots: Array.isArray(slot?.parts.bots) ? slot.parts.bots.filter((b) => !b.hidden).length : 0,
        requests: Array.isArray(slot?.parts.live?.requests) ? slot.parts.live.requests.length : 0,
        ...(host.member && { member: true }),
        ...(team && { team }),
      };
    });
  }
  /** Partitions watched scoped chat IDs across all pooled remote hosts. */
  watchUnified(chatIds) {
    const byHost = new Map();
    for (const id of Array.isArray(chatIds) ? chatIds : []) {
      const parsed = parseScopedId(id);
      if (!parsed) continue;
      const list = byHost.get(parsed.hostId) ?? [];
      if (!list.includes(parsed.rawId) && list.length < WATCHED) list.push(parsed.rawId);
      byHost.set(parsed.hostId, list);
    }
    for (const [hostId, slot] of this.pool) {
      const next = byHost.get(hostId) ?? [];
      if (JSON.stringify(next) === JSON.stringify(slot.watching)) continue;
      slot.watching = next;
      slot.client.watch(next);
    }
  }
  /** Tells every online pooled host whether the window is focused and if its chat is on screen. */
  presenceUnified(front, viewingChat) {
    const parsed = parseScopedId(viewingChat);
    for (const [hostId, slot] of this.pool) {
      if (slot.state !== "online") continue;
      const chatId = parsed && parsed.hostId === hostId ? parsed.rawId : undefined;
      void slot.client.call("link.push.presence", front, chatId).catch(() => {});
    }
  }
  find(id) {
    const host = this.hosts.find((h) => h.id === id);
    if (!host) throw new Error("That computer is no longer paired.");
    return host;
  }
  /** The link's fetch: the plain one, and through the relay when the host lists it and a socket exists. */
  transport() {
    return this.WebSocket && this.lib.relayFetch ? this.lib.relayFetch(this.fetch, { WebSocket: this.WebSocket }) : this.fetch;
  }

  /** What Settings and the switcher show. Nothing of a credential is in it. */
  list() {
    return this.hosts.map((host) => {
      const slot = this.pool.get(host.id);
      const active = slot ? { parts: slot.parts, state: slot.state, route: slot.route } : host.id === this.current ? { parts: this.parts, state: this.state, route: this.route } : null;
      const team = active ? text(active.parts.team?.team?.name) || host.team : host.team;
      return {
        id: host.id,
        name: host.name,
        addedAt: host.addedAt,
        ...(host.member && { member: true }),
        ...(team && { team }),
        current: !this.unified && host.id === this.current,
        included: !this.excluded.has(host.id),
        ...(active && { state: active.state, route: active.route, version: active.parts.meta?.version, capabilities: active.parts.meta?.capabilities ?? [] }),
      };
    });
  }
  /** Public descriptor used by the profile directory; no client secret is returned. */
  profileDescriptor(id) {
    const host = this.find(id);
    return {
      serverId: host.id,
      serverKey: host.pairing.serverKey,
      name: host.name,
      hosts: Array.isArray(host.pairing.hosts) ? [...host.pairing.hosts] : [],
      ...(host.member && { member: true }),
    };
  }
  /** Binds an already paired host to the signed-in profile, even when it is not in use. */
  async bindProfile(id, ticket) {
    const host = this.find(id);
    const client = new this.lib.LinkClient(host.pairing, { fetch: this.transport(), onParts() {}, onState() {} });
    try {
      const descriptor = await client.call("link.profile.bind", ticket);
      host.profileBound = true;
      this.save();
      this.changed();
      return descriptor;
    } catch (error) {
      if (error?.code === "offline") throw new Error(host.name + " can't be reached right now.");
      throw new Error(String(error?.message ?? error));
    } finally {
      client.stop();
    }
  }
  /** Removes this installation's profile principal from an already paired host. */
  async unbindProfile(id, profileId) {
    const host = this.find(id);
    const client = new this.lib.LinkClient(host.pairing, { fetch: this.transport(), onParts() {}, onState() {} });
    try {
      await client.call("link.profile.unbind", profileId);
      host.profileBound = false;
      this.save();
      this.changed();
    } catch (error) {
      if (error?.code === "offline") throw new Error(host.name + " can't be reached right now.");
      throw new Error(String(error?.message ?? error));
    } finally {
      client.stop();
    }
  }
  /** Stores a pairing returned by the profile directory's sealed connection flow. */
  adoptPairing(pairing, { name, member = false, team } = {}) {
    if (!pairing?.serverId || !pairing?.serverKey || !pairing?.secretKey) throw new Error("That profile computer returned an invalid pairing.");
    const earlier = this.hosts.find((host) => host.id === pairing.serverId);
    const host = {
      id: pairing.serverId,
      name: earlier?.name || text(name) || text(pairing.name) || "Computer",
      ...(text(team) && { team: text(team) }),
      ...(member === true && { member: true }),
      profileBound: true,
      addedAt: earlier?.addedAt || Date.now(),
      pairing,
    };
    const inUse = this.current === host.id;
    if (inUse) {
      this.stop();
      this.current = null;
    }
    const pooled = this.pool.get(host.id);
    if (pooled) {
      pooled.client.stop();
      this.pool.delete(host.id);
    }
    this.hosts = [...this.hosts.filter((item) => item.id !== host.id), host];
    this.save();
    if (inUse) this.use(host.id);
    else if (this.unified) this.syncPool();
    this.changed();
    return { id: host.id, name: host.name, ...(host.member && { member: true }) };
  }
  /** Drops credentials obtained through the profile directory on account loss. Manual pairings remain. */
  dropProfileBound() {
    const removed = this.hosts.filter((host) => host.profileBound === true);
    if (!removed.length) return 0;
    if (this.current && removed.some((host) => host.id === this.current)) {
      this.stop();
      this.current = null;
    }
    if (this.remembered && removed.some((host) => host.id === this.remembered)) this.remembered = null;
    this.hosts = this.hosts.filter((host) => host.profileBound !== true);
    if (this.unified) this.syncPool();
    this.save();
    this.changed();
    return removed.length;
  }
  /** The host in use as the window names it, or null for this computer. */
  inUse() {
    if (!this.current) return null;
    const host = this.find(this.current);
    return {
      id: host.id,
      name: text(this.parts.meta?.name) || host.name,
      state: this.state,
      route: this.route,
      version: this.parts.meta?.version ?? null,
      capabilities: this.parts.meta?.capabilities ?? [],
      ...(host.member && { member: true }),
      ...((text(this.parts.team?.team?.name) || host.team) && { team: text(this.parts.team?.team?.name) || host.team }),
    };
  }

  /** Finds a team invite card from a code or Botkins join link. */
  async findTeamInvite(value) {
    const input = String(value ?? "").trim();
    const target = this.lib.parseJoinUrl(input);
    const code = target?.code ?? this.lib.normalizeCode(input);
    let relayBase;
    if (target && /^https:/i.test(input)) {
      try {
        relayBase = new URL(input).origin;
      } catch {
        // The parser already refused malformed links.
      }
    }
    try {
      return await this.lib.findInvite(this.transport(), code, relayBase, target?.serverKey);
    } catch (error) {
      throw this.teamJoinError(error, "this team");
    }
  }
  teamJoins() {
    return [...this.joins.values()].map((entry) => ({
      id: entry.id,
      team: entry.team,
      status: entry.status,
      createdAt: entry.createdAt,
      ...(entry.requestId && { requestId: entry.requestId }),
    }));
  }
  async startTeamJoin(target, deviceName) {
    const name = text(target?.name) || "the team";
    let outcome;
    try {
      outcome = await this.lib.startJoin(this.transport(), target, {
        name: text(deviceName) || text(this.device?.name) || "Computer",
        platform: this.device?.platform ?? process.platform,
        kind: "desktop",
      });
    } catch (error) {
      throw this.teamJoinError(error, name);
    }
    const attempt = outcome.attempt;
    const id = text(attempt?.keys?.publicKey) || this.lib.normalizeCode(target?.code);
    if (outcome.result?.status === "pending") {
      this.joins.set(id, {
        id,
        attempt,
        team: text(outcome.result.team?.name) || name,
        createdAt: Date.now(),
        status: "pending",
        requestId: outcome.result.requestId,
      });
      this.save();
      this.changed();
      return { ...this.teamJoinView(id), status: "pending" };
    }
    if (outcome.result?.status === "approved") return this.finishTeamJoin(id, name, outcome.result);
    return this.finishTeamJoin(id, name, outcome.result);
  }
  teamJoinView(id) {
    const entry = this.joins.get(id);
    return entry
      ? { id: entry.id, team: entry.team, status: entry.status, createdAt: entry.createdAt, ...(entry.requestId && { requestId: entry.requestId }) }
      : { id, team: "the team", status: "pending" };
  }
  teamJoinError(error, name) {
    if (error?.code === "join_closed") return new Error("This invite has expired or was used.");
    if (error?.code === "offline" || error?.code === "not-found") {
      return new Error("Can't reach " + name + " right now. Try again when the owner's computer is on.");
    }
    return new Error(String(error?.message ?? error));
  }
  finishTeamJoin(id, name, result) {
    const entry = this.joins.get(id);
    const team = entry?.team || text(name) || "the team";
    if (result?.status === "approved" && result.pairing) {
      this.joins.delete(id);
      const pairing = { ...result.pairing, member: true };
      const earlier = this.hosts.find((host) => host.id === pairing.serverId);
      const host = {
        id: pairing.serverId,
        name: earlier?.name || text(pairing.name) || team,
        team,
        member: true,
        addedAt: earlier?.addedAt || Date.now(),
        pairing,
      };
      this.hosts = [...this.hosts.filter((item) => item.id !== pairing.serverId), host];
      this.save();
      this.changed();
      return { id: host.id, team, status: "approved" };
    }
    if (result?.status === "denied") {
      this.joins.delete(id);
      this.save();
      this.changed();
    }
    return { id, team, status: result?.status ?? "pending" };
  }
  async checkTeamJoin(id) {
    const entry = this.joins.get(id);
    if (!entry) throw new Error("That join request is no longer waiting.");
    try {
      const result = await this.lib.checkJoin(this.transport(), entry.attempt);
      if (result?.status === "pending") {
        if (result.requestId) entry.requestId = result.requestId;
        if (result.team?.name) entry.team = text(result.team.name) || entry.team;
        this.save();
        return this.teamJoinView(id);
      }
      return this.finishTeamJoin(id, entry.team, result);
    } catch (error) {
      if (error?.code === "join_closed") {
        this.joins.delete(id);
        this.save();
        this.changed();
        return { id, team: entry.team, status: "closed" };
      }
      if (error?.code === "offline" || error?.code === "not-found") {
        return { ...this.teamJoinView(id), status: "offline" };
      }
      throw this.teamJoinError(error, entry.team);
    }
  }
  cancelTeamJoin(id) {
    if (this.joins.delete(id)) {
      this.save();
      this.changed();
    }
  }

  /**
   * Pairs with a host: `link` is the pairing link its QR code holds, or `address` and `code` are
   * what the person typed. Pairing again with a host replaces this app's earlier entry for it.
   */
  async pair({ link, address, code, name } = {}) {
    let target = typeof link === "string" && link.trim() ? this.lib.parsePairingUrl(link.trim()) : null;
    if (!target) {
      if (typeof link === "string" && link.trim()) throw new Error("That isn't a Botkins pairing link.");
      const host = this.lib.normalizeHost(String(address ?? ""));
      if (!host) throw new Error("Enter the other computer's address, such as 192.168.1.20.");
      if (!text(code)) throw new Error("Enter the pairing code the other computer shows.");
      target = { hosts: [host], code: String(code) };
    }
    let pairing;
    const unreached = "The other computer couldn't be reached. Check the address, and that both are on the same network.";
    const said = { code: "That code isn't right. Check it on the other computer.", closed: "That code is no longer open. Start pairing again on the other computer.", protocol: "The two apps are different versions. Update Botkins on both computers.", offline: unreached, "not-found": unreached };
    for (let attempt = 1; !pairing; attempt++) {
      try {
        pairing = await this.lib.pair(this.transport(), target, { name: text(name) || text(this.device?.name) || "Computer", platform: this.device?.platform ?? process.platform, kind: "desktop" });
      } catch (error) {
        // A computer that is busy can be slow to answer the first time: asked again, twice at most.
        // Nothing reached it, so no try of the code was used.
        if ((error?.code === "offline" || error?.code === "not-found") && attempt < 3) continue;
        throw new Error(said[error?.code] ?? String(error?.message ?? error));
      }
    }
    // Paired with this host before: the name the person gave it here is kept.
    const earlier = this.hosts.find((host) => host.id === pairing.serverId);
    const entry = { id: pairing.serverId, name: earlier?.name || text(pairing.name) || text(target.name) || "Computer", addedAt: Date.now(), pairing };
    // Pairing again with the host in use: the window goes on with the new credential.
    const inUse = this.current === entry.id;
    if (inUse) {
      this.stop();
      this.current = null;
    }
    const pooled = this.pool.get(entry.id);
    if (pooled) {
      pooled.client.stop();
      this.pool.delete(entry.id);
    }
    // The host is told to drop this app's earlier entry, so it lists this app once.
    if (earlier && earlier.pairing.deviceId !== pairing.deviceId) await this.once(pairing, "link.devices.remove", earlier.pairing.deviceId);
    this.hosts = [...this.hosts.filter((host) => host.id !== entry.id), entry];
    this.save();
    if (inUse) this.use(entry.id);
    else if (this.unified) this.syncPool();
    this.changed();
    return { id: entry.id, name: entry.name };
  }
  rename(id, name) {
    const host = this.find(id);
    if (!text(name)) throw new Error("Give the computer a name.");
    host.name = text(name);
    this.save();
    this.changed();
  }
  /** Unpairs. The host is told when it can be reached; either way the credential is gone from here. */
  async forget(id) {
    const host = this.find(id);
    const pooled = this.pool.get(id);
    if (this.current === id) {
      await this.client?.call("link.unpair").catch(() => {});
      this.stop();
      this.current = null;
    } else if (pooled) {
      await pooled.client.call("link.unpair").catch(() => {});
      pooled.client.stop();
      this.pool.delete(id);
    } else await this.once(host.pairing, "link.unpair");
    this.excluded.delete(id);
    this.hosts = this.hosts.filter((h) => h !== host);
    this.save();
    this.changed();
  }
  /** One call to a host that isn't in use, given a few seconds. A host that can't be reached is left be. */
  async once(pairing, method, ...args) {
    const client = new this.lib.LinkClient(pairing, { fetch: this.transport(), onParts() {}, onState() {} });
    let timer;
    try {
      await Promise.race([client.call(method, ...args).catch(() => {}), new Promise((resolve) => (timer = setTimeout(resolve, 5000)))]);
    } finally {
      clearTimeout(timer);
      client.stop();
    }
  }
  stop() {
    const client = this.client;
    const stoppingScreen = this.stopScreen();
    if (stoppingScreen) void stoppingScreen.finally(() => client?.stop());
    else client?.stop();
    this.client = null;
    this.parts = {};
    this.state = "idle";
    this.route = null;
    this.watching = [];
  }
  /** Shows a host in the window (its id), or this computer (null). */
  use(id) {
    if (this.unified) {
      this.unified = false;
      this.stopPool();
    }
    if (id === null || id === undefined || id === "") {
      this.stop();
      this.current = null;
      this.save();
      this.changed();
      return null;
    }
    const host = this.find(id);
    if (this.current === host.id && this.client) {
      // Choosing the computer in use again while it can't be reached is Try again: it is looked
      // for at once, at every address, also one where a different computer answered before.
      if (this.state !== "online") this.client.wake("network");
      return this.inUse();
    }
    this.stop();
    this.current = host.id;
    this.state = "connecting";
    this.save();
    let initialized = false;
    const client = (this.client = new this.lib.LinkClient(host.pairing, {
      fetch: this.transport(),
      onParts: (parts) => {
        if (this.client !== client) return;
        const prev = initialized ? { live: this.parts.live, runs: this.parts.runs } : null;
        for (const [name, value] of Object.entries(parts)) value === null || value === undefined ? delete this.parts[name] : (this.parts[name] = value);
        if (!initialized && (this.parts.bots || this.parts.chats || this.parts.live)) {
          initialized = true;
        } else if (initialized) {
          const hostName = text(this.parts.meta?.name) || host.name;
          for (const event of diffRemoteNotifications(prev, this.parts, { hostId: host.id, hostName })) {
            try { this.onEvent?.(event); } catch { /* ignore */ }
          }
        }
        this.changed();
      },
      onState: (state) => {
        if (this.client !== client) return;
        this.state = state;
        this.changed();
      },
      onHosts: (hosts) => {
        // The host said where it can be reached now: remembered for the next start.
        if (this.client !== client || !Array.isArray(hosts)) return;
        host.pairing = { ...host.pairing, hosts };
        this.save();
      },
      onRoute: (route) => {
        if (this.client !== client) return;
        this.route = route;
        this.changed();
      },
    }));
    client.start();
    this.changed();
    return this.inUse();
  }
  /** The chats the window is looking at: the host sends their messages and their running turn. */
  watch(chatIds) {
    if (this.isUnified()) {
      this.watchUnified(chatIds);
      return;
    }
    const next = [...new Set((Array.isArray(chatIds) ? chatIds : []).filter((id) => typeof id === "string" && id))].slice(0, WATCHED);
    if (JSON.stringify(next) === JSON.stringify(this.watching)) return;
    this.watching = next;
    this.client?.watch(next);
  }
  wake() {
    if (this.unified) {
      for (const slot of this.pool.values()) slot.client.wake();
      return;
    }
    this.client?.wake();
  }
  /** End only this window's viewer. A later viewer on the same paired device waits for the old stop. */
  stopScreen() {
    const viewer = this.screenViewer;
    if (!viewer) return this.screenStops?.get(this.current);
    this.screenViewer = null;
    viewer.abort.abort();
    this.screenStops ??= new Map();
    const previous = this.screenStops.get(viewer.hostId);
    const stopping = Promise.resolve(previous).then(() => viewer.client.callWithSignal("link.screen.stop", AbortSignal.timeout(5000))).catch(() => {});
    this.screenStops.set(viewer.hostId, stopping);
    stopping.finally(() => { if (this.screenStops.get(viewer.hostId) === stopping) this.screenStops.delete(viewer.hostId); });
    return stopping;
  }

  async screenRequest(hostId, id, operation, ...args) {
    const slot = this.pool.get(hostId);
    const client = slot ? slot.client : hostId === this.current ? this.client : null;
    if (!client) throw new Error("That computer is no longer selected.");
    if (this.find(hostId).member) throw new Error("Only an owner device can view this computer.");
    if (typeof id !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)) throw new Error("Invalid screen viewer.");
    if (operation === "start") {
      const previous = this.stopScreen();
      const viewer = { hostId, id, client, abort: new AbortController() };
      this.screenViewer = viewer;
      try {
        await previous;
        viewer.abort.signal.throwIfAborted();
        return await client.callWithSignal("link.screen.info", viewer.abort.signal);
      } catch (error) {
        if (this.screenViewer === viewer) this.stopScreen();
        throw error;
      }
    }
    const viewer = this.screenViewer;
    if (!viewer || id !== viewer.id || viewer.client !== client) {
      if (operation === "stop") return;
      throw new Error("This screen viewer has closed.");
    }
    const call = (method, ...values) => client.callWithSignal(method, viewer.abort.signal, ...values);
    switch (operation) {
      case "stop": return this.stopScreen();
      case "frame": return call("link.screen.frame", args[0]);
      case "openVideo": return call("link.screen.video.open", id, args[0]);
      case "readVideo": return call("link.screen.video.read", id, args[0]);
      case "closeVideo": return call("link.screen.video.close", id);
      case "input": return call("link.screen.input", args[0], args[1]);
      default: throw new Error("Unknown screen viewer action.");
    }
  }
  snapshot(own) {
    return snapshotOf(this.parts, own);
  }
  /**
   * One of the window's calls while a host is in use: sent to the host when a client may make it
   * (the link's own list), refused in words otherwise. "revoked" unpairs here too.
   */
  async call(name, args) {
    if (!this.client || !this.current) throw new Error("No other computer is in use.");
    return this.callHost(this.current, name, args);
  }
  /** Calls a method on a specific connected remote host (either in the unified pool or `this.current`). */
  async callHost(hostId, name, args = []) {
    const host = this.find(hostId);
    const slot = this.pool.get(hostId);
    const client = slot ? slot.client : this.current === hostId ? this.client : null;
    const parts = slot ? slot.parts : this.current === hostId ? this.parts : null;
    const state = slot ? slot.state : this.current === hostId ? this.state : "offline";
    if (!client || !parts) throw new Error(host.name + " is not connected right now.");
    const stillActive = () => (slot ? this.pool.get(hostId)?.client === client : this.client === client && this.current === hostId);
    // The people in a chat: the other computer's link keeps them, and each chat it sends says who was invited.
    if (name === "chatPeople") {
      const chat = (parts.chats ?? []).find((item) => item.id === args[0]);
      return { createdBy: chat?.createdBy ?? "owner", invited: Array.isArray(chat?.invited) ? [...chat.invited] : [] };
    }
    if (name === "savedCredentials") {
      // The paired host already sends its owner the picker entries over the sealed link.
      // Only that host can resolve a selected reference when it receives the approval.
      if (host.member || state !== "online" || !Array.isArray(parts.credentials)) throw new Error("The paired host’s saved credentials are unavailable.");
      return { entries: parts.credentials };
    }
    // A bot's own voice ("bot-voice-v1"): the card reads the shared choices the host sends this person (never a key; an owner's
    // device and a role that manages bots get them), and lists voices and reads a sample through the host's providers.
    if (name === "voiceSettings") {
      const voice = parts.voice;
      if (!voice) throw new Error(host.name + " doesn't share its voice settings with this person.");
      return { ...voice, ready: true, device: { stt: true, tts: true } };
    }
    if (name === "speak") {
      const [text, options = {}] = args;
      const shared = parts.voice;
      const own = cleanBotVoice((parts.bots ?? []).find((bot) => bot.id === options.botId)?.voice)?.tts;
      // "This computer" is the voice for the bot (or for everyone): the window reads it with its own.
      if (!shared || effectiveTts(shared.tts, own).provider === "device") return { device: true };
      const spoken = await this.callHost(hostId, "link.voice.speak", [{ text, ...options }]);
      return { parts: [{ audio: new Uint8Array(Buffer.from(spoken.audio, "base64")), format: spoken.format }] };
    }
    name = LINK_NAMES[name] ?? name;
    if (!name.startsWith("link.") && !REMOTE_METHODS.has(name)) throw new Error("That can only be done on " + host.name + " itself.");
    if (state === "revoked") throw new Error(host.name + " no longer knows this computer. Pair again to use it.");
    if (name === "markChatsRead") {
      const ids = Array.isArray(args[0]) ? [...new Set(args[0].filter((id) => typeof id === "string" && id))] : [];
      if (ids.length === 0) return null;
      const formatError = (error) => (error?.code === "offline" ? host.name + " can't be reached right now." : String(error?.message ?? error));
      const unknownBatch = /unknown method|not supported|not allowed|unsupported|not a function|can't be done from a phone/i;
      let useFallback = !(parts.meta?.capabilities ?? []).includes("mark-chats-read-v1");
      if (!useFallback) {
        for (let i = 0; i < ids.length; i += MAX_MARK_CHATS_READ) {
          if (!stillActive()) return null;
          try {
            await client.call("markChatsRead", ids.slice(i, i + MAX_MARK_CHATS_READ));
          } catch (error) {
            if (!stillActive()) return null;
            const message = formatError(error);
            if (i === 0 && unknownBatch.test(message)) {
              useFallback = true;
              break;
            }
            throw new Error(message);
          }
        }
        if (!useFallback) return null;
      }
      const errors = [];
      for (const id of ids) {
        if (!stillActive()) return null;
        try {
          await client.call("setChatFlags", id, { unread: false });
        } catch (error) {
          if (!stillActive()) return null;
          const message = formatError(error);
          if (isSkippedMarkReadError(message)) continue;
          errors.push(message);
        }
      }
      if (errors.length === 1) throw new Error(errors[0]);
      if (errors.length > 1) {
        const uniqueErrors = [...new Set(errors)];
        throw new Error(`Couldn't mark ${errors.length} chats as read: ${uniqueErrors.slice(0, 3).join("; ")}`);
      }
      return null;
    }
    try {
      return await client.call(name, ...args);
    } catch (error) {
      if (error?.code === "offline") throw new Error(host.name + " can't be reached right now.");
      throw new Error(String(error?.message ?? error));
    }
  }
}
