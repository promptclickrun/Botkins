// The account profile that ties this Botkins installation to a hosted profile directory.
//
// This module is deliberately a main-process/service boundary.  The hosted session token and
// the verifier that completes a browser attempt are kept in one protected file and are never part
// of a renderer result or a command-line response.  The renderer only receives the person's
// profile identity and the public directory entries.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PROFILE_URL = "https://profile.botkins.app";
const VERSION = 1;
const LIMIT = 120;

const text = (value, max = LIMIT) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "");
const safeCode = (value) => text(value, 64).replace(/[^A-Za-z0-9_-]/g, "");
const hostView = (host) => {
  if (!host || typeof host !== "object") return null;
  const serverId = text(host.serverId, 128);
  const serverKey = text(host.serverKey, 256);
  if (!serverId || !serverKey) return null;
  return {
    serverId,
    serverKey,
    name: text(host.name) || "Computer",
    hosts: Array.isArray(host.hosts) ? host.hosts.filter((item) => typeof item === "string").slice(0, 16) : [],
    ...(host.member === true && { member: true }),
  };
};
const sessionView = (session) => {
  if (!session || typeof session !== "object") return null;
  const profileId = text(session.profileId ?? session.id, 160);
  if (!profileId) return null;
  return {
    profileId,
    name: text(session.name) || "Botkins profile",
    ...(text(session.email, 240) && { email: text(session.email, 240) }),
    ...(text(session.avatar, 32) && { avatar: text(session.avatar, 32) }),
    ...(text(session.deviceId, 160) && { deviceId: text(session.deviceId, 160) }),
  };
};

/** A profile manager needs only the public part of a session in the window. */
export const publicProfile = sessionView;

function startUrl(attempt) {
  const id = text(attempt?.id, 200);
  // The hosted page is intentionally fixed.  A response cannot redirect the app to an arbitrary
  // origin, and the short id is the only value in the fragment.
  return id ? PROFILE_URL + "/#" + encodeURIComponent(id) : "";
}
function apiOf(lib) {
  const api = lib?.profileApi;
  if (!api || typeof api.start !== "function" || typeof api.finish !== "function") {
    throw new Error("This Botkins build has no profile service yet.");
  }
  return api;
}

function isUnauthorized(error) {
  return Number(error?.status) === 401;
}

/**
 * @param options.file       The profile state file.
 * @param options.protect    { wrap(text) -> string, unwrap(string) -> text|null }.
 * @param options.lib        The bundled link client, including profileApi/profileConnect.
 * @param options.local      () -> LinkHost, or a LinkHost.
 * @param options.remote     () -> RemoteHosts.
 * @param options.fetch      The host's fetch implementation.
 * @param options.device     Public device facts sent to the host when connecting.
 * @param options.changed    Called after local profile state changes.
 */
export class ProfileManager {
  constructor({ file, protect = null, lib, local, remote, fetch = globalThis.fetch, device, changed = () => {}, log = () => {} } = {}) {
    Object.assign(this, { file, protect, lib, local, remote, fetch, device, changed, log });
    this.session = null;
    this.pending = null;
    this.directory = null;
    this.optedOut = false;
    this.migrationPrompted = false;
    this.pendingBindings = [];
    this.boundHosts = {};
    this.binding = false;
    this.generation = 0;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      let value = saved?.protected;
      if (value && this.protect?.unwrap) value = this.protect.unwrap(value);
      else if (saved?.plain && !this.protect) value = saved.plain;
      if (typeof value !== "string") return;
      const state = JSON.parse(value);
      if (!this.protect?.wrap || !this.protect?.unwrap) {
        // A development/trial folder may not have a keychain. It can remember the person's
        // local-only choice, but never resurrect a token, verifier or profile-bound retry.
        this.optedOut = state.optedOut === true;
        this.migrationPrompted = state.migrationPrompted === true;
        this.save();
        return;
      }
      this.session = state.session && typeof state.session === "object" ? state.session : null;
      this.pending = state.pending && typeof state.pending === "object" ? state.pending : null;
      this.optedOut = state.optedOut === true;
      this.migrationPrompted = state.migrationPrompted === true;
      this.pendingBindings = Array.isArray(state.pendingBindings) ? state.pendingBindings.filter((id) => typeof id === "string") : [];
      this.boundHosts = state.boundHosts && typeof state.boundHosts === "object" ? state.boundHosts : {};
    } catch {
      // A locked or damaged profile is treated as signed out.  The file stays untouched so the
      // next start with the right key can resume it.
    }
  }

  save() {
    if (!this.file) return;
    const state = JSON.stringify({
      version: VERSION,
      // This object contains the session token and browser verifier.  Keep the whole object under
      // one protected value so neither secret can accidentally be logged or inspected in JSON.
      session: this.session,
      pending: this.pending,
      optedOut: this.optedOut,
      migrationPrompted: this.migrationPrompted,
      pendingBindings: this.pendingBindings,
      boundHosts: this.boundHosts,
    });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const kept = this.protect?.wrap && this.protect?.unwrap
      ? { protected: this.protect.wrap(state) }
      : { plain: JSON.stringify({ version: VERSION, optedOut: this.optedOut, migrationPrompted: this.migrationPrompted }) };
    const temporary = this.file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
    try {
      writeFileSync(temporary, JSON.stringify(kept) + "\n", { mode: 0o600 });
      renameSync(temporary, this.file);
    } finally {
      try { unlinkSync(temporary); } catch {}
    }
  }

  profileApi() {
    return apiOf(this.lib);
  }

  token() {
    return typeof this.session?.token === "string" && this.session.token ? this.session.token : null;
  }

  pendingUrl() {
    return this.pending ? startUrl(this.pending) : null;
  }

  status({ existing = false } = {}) {
    return {
      signedIn: !!this.token(),
      profile: sessionView(this.session),
      pending: this.pending
        ? { id: text(this.pending.id, 200), code: safeCode(this.pending.code), url: startUrl(this.pending), label: text(this.pending.label) || "This device" }
        : null,
      optedOut: this.optedOut,
      migration: {
        needed: !!existing && !this.token() && !this.optedOut && !this.migrationPrompted,
        prompted: this.migrationPrompted,
      },
      hosts: this.directory?.hosts ?? [],
      devices: this.directory?.devices ?? [],
      pendingDevices: this.directory?.pending ?? [],
    };
  }

  async start(label = "This device") {
    const api = this.profileApi();
    const attempt = await api.start(text(label) || "This device");
    if (!attempt || !text(attempt.id, 200) || !text(attempt.verifier, 4000)) throw new Error("The profile service did not start a sign-in.");
    this.pending = {
      id: text(attempt.id, 200),
      verifier: String(attempt.verifier),
      code: safeCode(attempt.code),
      label: text(label) || "This device",
    };
    this.save();
    this.changed();
    return { id: this.pending.id, url: startUrl(this.pending), code: this.pending.code, label: this.pending.label };
  }

  async finish() {
    if (!this.pending) return null;
    const epoch = this.generation;
    const api = this.profileApi();
    let session;
    try {
      session = await api.finish({ id: this.pending.id, verifier: this.pending.verifier });
    } catch (error) {
      if (epoch !== this.generation || this.pending === null) return null;
      if (isUnauthorized(error)) this.invalidate();
      throw error;
    }
    if (epoch !== this.generation || this.pending === null) return null;
    if (!session) return null;
    if (!text(session.token, 64) || !text(session.profileId, 1)) throw new Error("The profile service returned an incomplete session.");
    this.session = { ...session };
    this.pending = null;
    this.optedOut = false;
    this.migrationPrompted = true;
    this.directory = null;
    this.save();
    this.changed();
    // Binding is best effort.  A sleeping or offline computer is kept as a retry, while the
    // profile sign-in itself succeeds and can be used on this computer immediately.
    await this.bindAll();
    await this.refresh().catch((error) => this.log("Profile directory: " + (error?.message ?? error)));
    return sessionView(this.session);
  }

  invalidate() {
    this.generation++;
    this.remoteHosts()?.dropProfileBound?.();
    this.session = null;
    this.directory = null;
    this.pending = null;
    this.pendingBindings = [];
    this.boundHosts = {};
    this.save();
    this.changed();
  }

  async home() {
    const token = this.token();
    if (!token) return null;
    const epoch = this.generation;
    try {
      const answer = await this.profileApi().home(token);
      if (epoch !== this.generation || token !== this.token()) return null;
      this.directory = {
        hosts: Array.isArray(answer?.hosts) ? answer.hosts.map(hostView).filter(Boolean) : [],
        devices: Array.isArray(answer?.devices) ? answer.devices.map((device) => ({ id: text(device?.id, 160), label: text(device?.label) || "Device", current: device?.current === true })).filter((device) => device.id) : [],
        // The pending device's approval code is entered from that device and is never copied into
        // renderer state, CLI JSON or logs. The approver supplies it through the protected input.
        pending: Array.isArray(answer?.pending) ? answer.pending.map((device) => ({ id: text(device?.id, 160), label: text(device?.label) || "Device" })).filter((device) => device.id) : [],
        profile: sessionView(answer?.profile) ?? sessionView(this.session),
      };
      if (this.session && this.directory.profile) {
        const { email: _email, avatar: _avatar, ...sessionWithoutProfileFields } = this.session;
        this.session = {
          ...sessionWithoutProfileFields,
          name: this.directory.profile.name,
          ...(this.directory.profile.email && { email: this.directory.profile.email }),
          ...(this.directory.profile.avatar && { avatar: this.directory.profile.avatar }),
        };
        this.save();
      }
      this.changed();
      return this.status();
    } catch (error) {
      if (epoch !== this.generation || token !== this.token()) return null;
      if (isUnauthorized(error)) this.invalidate();
      throw error;
    }
  }

  async refresh({ retry = true } = {}) {
    const answer = await this.home();
    if (retry && this.token()) await this.bindAll();
    return answer ?? this.status();
  }

  async optOut() {
    await this.clearAccount({ optedOut: true });
    return this.status();
  }

  async signOut() {
    await this.clearAccount({ optedOut: false });
    return this.status();
  }

  /**
   * Account loss is also a credential boundary. Drop profile-enrolled remote pairings before
   * network calls, then best-effort revoke this device while the old token is still available. The
   * hosted directory is intentionally preserved for the account and other devices. An offline
   * service is logged explicitly; no old token or pairing is retained locally for a later retry.
   */
  async clearAccount({ optedOut }) {
    this.generation++;
    const token = this.token();
    const deviceId = text(this.session?.deviceId, 160);
    this.remoteHosts()?.dropProfileBound?.();
    if (token) {
      try {
        if (deviceId && typeof this.profileApi().revoke === "function") await this.profileApi().revoke(token, deviceId);
      } catch (error) {
        this.log("Profile device revoke could not reach the service; local profile access was removed: " + (error?.message ?? error));
      }
    }
    this.session = null;
    this.pending = null;
    this.directory = null;
    this.pendingBindings = [];
    this.boundHosts = {};
    this.optedOut = optedOut === true;
    this.migrationPrompted = true;
    this.save();
    this.changed();
  }

  markMigrationPrompted() {
    this.migrationPrompted = true;
    this.save();
    this.changed();
    return this.status();
  }

  async approve(id, code) {
    const token = this.token();
    if (!token) throw new Error("Sign in to manage your profile.");
    try {
      await this.profileApi().approve(token, text(id, 160), safeCode(code));
      return this.refresh({ retry: false });
    } catch (error) {
      if (isUnauthorized(error)) this.invalidate();
      throw error;
    }
  }

  async revoke(id) {
    const token = this.token();
    if (!token) throw new Error("Sign in to manage your profile.");
    try {
      await this.profileApi().revoke(token, text(id, 160));
      return this.refresh({ retry: false });
    } catch (error) {
      if (isUnauthorized(error)) this.invalidate();
      throw error;
    }
  }

  localHost() {
    return typeof this.local === "function" ? this.local() : this.local;
  }

  remoteHosts() {
    return typeof this.remote === "function" ? this.remote() : this.remote;
  }

  localDescriptor() {
    const link = this.localHost();
    const status = link?.status?.() ?? {};
    // A profile sign-in alone must not publish this installation. The local Link is a host only
    // after the person explicitly enabled phone access and the listener is actually up.
    if (status.enabled !== true || status.listening !== true) return null;
    // `LinkHost.profileDescriptor()` is intentionally only callable after a binding and would
    // throw here. The public server key is safe to read from the host's local store.
    const key = status.serverKey ?? (link?.store?.data?.keys?.publicKey?.toString?.("base64url") ?? "");
    const hosts = Array.isArray(status.addresses)
      ? status.addresses.map((entry) => typeof entry === "string" ? entry : text(entry?.address) ? text(entry.address) + ":" + String(status.port ?? "") : "").filter(Boolean)
      : [];
    return hostView({ serverId: status.serverId, serverKey: key, name: status.name, hosts });
  }

  rememberHost(descriptor) {
    if (!this.directory?.hosts) return;
    this.directory = { ...this.directory, hosts: [...this.directory.hosts.filter((host) => host.serverId !== descriptor.serverId), descriptor] };
  }

  async bindLocal(epoch) {
    const token = this.token();
    const link = this.localHost();
    if (!token || typeof link?.bindOwnerProfile !== "function") return null;
    const before = this.localDescriptor();
    if (!before) throw new Error("This computer has no profile identity yet.");
    const ticket = await this.profileApi().proof(token, "bind", before.serverId, before.serverKey);
    if (epoch !== undefined && (epoch !== this.generation || token !== this.token())) return null;
    const descriptor = hostView(await link.bindOwnerProfile(ticket));
    if (!descriptor) throw new Error("This computer returned no profile identity.");
    if (epoch !== undefined && (epoch !== this.generation || token !== this.token())) return null;
    await this.profileApi().putHost(token, descriptor);
    this.rememberHost(descriptor);
    this.changed();
    return descriptor;
  }

  async bindRemote(id, epoch) {
    const token = this.token();
    const remote = this.remoteHosts();
    if (!token || !remote || typeof remote.bindProfile !== "function") return null;
    const before = remote.profileDescriptor?.(id);
    if (!before) throw new Error("That computer is no longer paired.");
    const ticket = await this.profileApi().proof(token, "bind", before.serverId, before.serverKey);
    if (epoch !== undefined && (epoch !== this.generation || token !== this.token())) return null;
    const descriptor = hostView(await remote.bindProfile(id, ticket));
    if (!descriptor) throw new Error("That computer returned no profile identity.");
    if (epoch !== undefined && (epoch !== this.generation || token !== this.token())) return null;
    await this.profileApi().putHost(token, descriptor);
    this.rememberHost(descriptor);
    this.changed();
    return descriptor;
  }

  async bindAll() {
    if (this.binding) return [];
    this.binding = true;
    try {
      const token = this.token();
      const epoch = this.generation;
      if (!token) return [];
      const ids = new Set(this.pendingBindings);
      const local = this.localDescriptor();
      if (local) ids.add(local.serverId);
      for (const host of this.remoteHosts()?.list?.() ?? []) ids.add(host.id);
      const done = [];
      let dirty = false;
      for (const id of ids) {
        try {
          if (epoch !== this.generation || token !== this.token()) break;
          const before = local?.serverId === id ? local : this.remoteHosts()?.profileDescriptor?.(id);
          if (!before) continue;
          const fingerprint = JSON.stringify({ serverKey: before.serverKey, name: before.name, hosts: before.hosts, member: before.member === true });
          if (this.boundHosts[id] === fingerprint && !this.pendingBindings.includes(id)) continue;
          const descriptor = local?.serverId === id ? await this.bindLocal(epoch) : await this.bindRemote(id, epoch);
          if (descriptor) {
            this.boundHosts[id] = JSON.stringify({ serverKey: descriptor.serverKey, name: descriptor.name, hosts: descriptor.hosts, member: descriptor.member === true });
            done.push(descriptor.serverId);
            this.pendingBindings = this.pendingBindings.filter((value) => value !== id);
            dirty = true;
          }
        } catch (error) {
          if (epoch !== this.generation || token !== this.token()) break;
          if (!this.pendingBindings.includes(id)) this.pendingBindings.push(id), dirty = true;
          this.log("Profile bind for " + id + ": " + (error?.message ?? error));
        }
      }
      if (dirty) {
        this.save();
        this.changed();
      }
      return done;
    } finally {
      this.binding = false;
    }
  }

  async connect(serverId) {
    const token = this.token();
    const epoch = this.generation;
    const host = this.directory?.hosts?.find((entry) => entry.serverId === String(serverId));
    const remote = this.remoteHosts();
    if (!token) throw new Error("Sign in to use profile computers.");
    if (!host) throw new Error("That profile computer is no longer listed. Refresh the profile.");
    if (!remote || typeof remote.adoptPairing !== "function") throw new Error("Connecting to another computer is not available on this host.");
    if (typeof this.lib?.profileConnect !== "function") throw new Error("This Botkins build has no profile computer connection yet.");
    const pairing = await this.lib.profileConnect(remote.transport(), host, this.device ?? {}, (publicKey) => {
      if (epoch !== this.generation || token !== this.token()) throw new Error("The profile session ended while connecting.");
      return this.profileApi().proof(token, "connect", host.serverId, host.serverKey, publicKey);
    });
    if (epoch !== this.generation || token !== this.token()) throw new Error("The profile session ended while connecting.");
    const result = remote.adoptPairing(pairing, { name: host.name, member: host.member });
    this.changed();
    return result;
  }
}
