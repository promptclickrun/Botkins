// What the link keeps on disk: this computer's identity, the phones paired with it, and the
// Botkin each bot is shown as on a phone (the desktop app has its own pictures for bots).
// One JSON file, written whole and readable only by the person (0600).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { b64u, newKeyPair, random, unb64u } from "./crypto.mjs";
import { DEFAULT_RELAY_URL, newRelayKey, validRelayKey } from "./relay.mjs";
import { defaultTeam } from "./team.mjs";
import { headIds as HEADS } from "./botkin-heads.mjs";

export const DEFAULT_PORT = 47610;
/** Who set the screen's level from a phone, as it is saved: { deviceId, name, at }, or null when it is not that. */
export function setBy(value) {
  if (value === null || typeof value !== "object" || typeof value.deviceId !== "string" || !value.deviceId || !Number.isFinite(value.at)) return null;
  return { deviceId: value.deviceId.slice(0, 40), name: String(value.name ?? "Phone").slice(0, 60), at: value.at };
}

/** What phones may do with this computer's screen: nothing, watch it, or watch and use it. */
export const SCREEN_MODES = ["off", "view", "control"];
export const MAX_OWNER_DEVICES = 20;
export const MAX_MEMBER_DEVICES = 60;
const MAX_PROFILE_TEXT = 300;
const MAX_PROFILE_BINDINGS = 64;
const MAX_PROFILE_REVOKED_DEVICES = 64;
function profileText(value, limit = MAX_PROFILE_TEXT) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
function profileBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const profileId = profileText(value.profileId);
  const deviceId = profileText(value.deviceId);
  const name = profileText(value.name, 60);
  const statusKey = profileText(value.statusKey, 1024);
  if (!profileId || !deviceId || !name || !statusKey) return null;
  const revokedDeviceIds = Array.isArray(value.revokedDeviceIds) ? [...new Set(value.revokedDeviceIds.filter((id) => profileText(id)).slice(-MAX_PROFILE_REVOKED_DEVICES))] : [];
  return { profileId, deviceId, name, statusKey, ...(value.revoked === true && { revoked: true }), ...(revokedDeviceIds.length && { revokedDeviceIds }) };
}
function loadProfiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { owner: null, members: {} };
  const members = Object.fromEntries(Object.entries(value.members && typeof value.members === "object" && !Array.isArray(value.members) ? value.members : {}).slice(0, MAX_PROFILE_BINDINGS).flatMap(([id, binding]) => {
    const cleanId = profileText(id, 200);
    const clean = profileBinding(binding);
    return cleanId && clean ? [[cleanId, clean]] : [];
  }));
  return { owner: profileBinding(value.owner), members };
}
/** A paired device is a phone or a computer (another Botkins app that uses this one). */
/** "gadget": a small device that talks with a bot (gadget.mjs). It is named, never guessed from a platform. */
export const DEVICE_KINDS = ["phone", "desktop", "gadget"];
const DESKTOP_PLATFORMS = ["darwin", "macos", "mac", "win32", "windows", "linux", "desktop"];
/** The kind a device says it is, else the kind its platform makes it. A phone when nothing says otherwise, as before. */
export const deviceKind = (kind, platform) => (DEVICE_KINDS.includes(kind) ? kind : DESKTOP_PLATFORMS.includes(String(platform ?? "").toLowerCase()) ? "desktop" : "phone");
const KIND_NAMES = { desktop: "Computer", gadget: "Gadget" };
const deviceName = (name, kind) => String(name || (KIND_NAMES[kind] ?? "Phone")).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) || (KIND_NAMES[kind] ?? "Phone");
/** The name of the person a device belongs to ("Jordan"), cleaned; "" when there is none. A device's `name` stays its model. */
export const personName = (value) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60).trim() : "");
// A host that stores looks itself advertises the character catalogs it can save.
export { HEADS_CAPABILITY, headCapabilities } from "./botkin-heads.mjs";
const hash = (text) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

/** The eye styles of the design kit. "oval" is every character's own, and is not saved. */
export const LOOK_EYES = ["oval", "button", "smile", "sleepy", "wink", "curious"];

/**
 * A look as it may be saved. Throws for anything else.
 *   { head, palette }                         one of the kit's characters in one of its palettes
 *   { ..., eyes }                             the eyes it has at rest (one of LOOK_EYES; "oval" is left out)
 *   { head, palette: "custom", colors }       its own colors: [shell, accent, faceplate, eyes], each "#rrggbb"
 * `colors` is kept only with the palette "custom", and "custom" always has it.
 */
export function cleanLook(look) {
  const id = (value) => (typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value) ? value : null);
  const head = id(look?.head);
  const palette = id(look?.palette);
  if (!head || !palette) throw new Error("That look can't be saved.");
  const clean = { head, palette };
  if (look.eyes != null) {
    if (!LOOK_EYES.includes(look.eyes)) throw new Error("That look can't be saved.");
    if (look.eyes !== "oval") clean.eyes = look.eyes;
  }
  if (palette === "custom") {
    const colors = look.colors;
    if (!Array.isArray(colors) || colors.length !== 4 || !colors.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) throw new Error("That look can't be saved.");
    clean.colors = colors.map((color) => color.toLowerCase());
  }
  return clean;
}

/**
 * A new random id for a device or a server: `bytes` random bytes as base64url. One that starts with
 * "-" is drawn again, because a command line reads such a word as an option (`botkins devices remove
 * <id>`). About one in 64 does. An id stays opaque; ids saved before this are as they were.
 */
export function newId(bytes, draw = random) {
  for (;;) {
    const id = b64u(draw(bytes));
    if (!id.startsWith("-")) return id;
  }
}

export class LinkStore {
  /**
   * @param dir      Folder for link.json.
   * @param options.protect / options.reveal  Optional pair that wraps the private key (the desktop
   *   app passes its keychain). Without them the key is kept as it is.
   */
  constructor(dir, { protect, reveal } = {}) {
    Object.assign(this, { dir, file: join(dir, "link.json"), protect, reveal });
    this.data = this.load();
    if (this.migrateTeam && !this.data.locked) this.save();
  }
  load() {
    // Only a file that isn't there is a new identity. A file that is there and can't be read or
    // understood is left exactly as it is, and the link stays off: a new identity written over it
    // would strand every paired phone.
    let saved;
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      return error.code === "ENOENT" ? this.fresh() : { ...this.fresh(), locked: "unreadable" };
    }
    if (saved?.version === 1 && saved.serverId && saved.publicKey && saved.privateKey) {
      try {
        this.migrateTeam = !Object.hasOwn(saved, "team");
        const privateKey = unb64u(saved.wrapped && this.reveal ? this.reveal(saved.privateKey) : saved.privateKey);
        // A key wrapped by a keychain this run can't open is left alone: the link stays off.
        if (saved.wrapped && !this.reveal) throw new Error("locked");
        if (privateKey.length !== 32) throw new Error("damaged");
        return {
          serverId: saved.serverId,
          keys: { publicKey: unb64u(saved.publicKey), privateKey },
          port: Number(saved.port) || DEFAULT_PORT,
          enabled: saved.enabled === true,
          name: typeof saved.name === "string" ? saved.name : "",
          // A device paired before kinds were kept has none: it gets the one its platform makes it.
          devices: Array.isArray(saved.devices) ? saved.devices.filter((d) => d?.id && d.publicKey).map((d) => ({ ...d, kind: deviceKind(d.kind, d.platform), ...(typeof d.memberId === "string" && d.memberId ? { memberId: d.memberId } : {}) })) : [],
          looks: saved.looks && typeof saved.looks === "object" ? saved.looks : {},
          screen: SCREEN_MODES.includes(saved.screen) ? saved.screen : "off",
          // The phone that last set the level from afar (a headless host), or nothing when it was set here.
          screenSetBy: setBy(saved.screenSetBy),
          relay: this.loadRelay(saved),
          // What each phone set up, by device id: where its notifications go, and what bots may use on it.
          push: saved.push && typeof saved.push === "object" ? saved.push : {},
          sources: saved.sources && typeof saved.sources === "object" ? saved.sources : {},
          profiles: loadProfiles(saved.profiles),
          team: this.revealCopies(this.loadTeam(saved.team), saved.wrapped),
        };
      } catch (error) {
        return { ...this.fresh(), locked: error.message };
      }
    }
    return this.fresh();
  }
  /**
   * The relay settings: off unless switched on, the default relay unless another was chosen, and the
   * relay key pair (the private half unwrapped here). A file from before keys, with only a token, has no
   * key yet; one is made when it is needed.
   */
  loadRelay(saved) {
    const relay = saved.relay && typeof saved.relay === "object" ? saved.relay : {};
    const stored = relay.key && typeof relay.key === "object" ? relay.key : {};
    const privateKey = typeof stored.privateKey === "string" && saved.wrapped && this.reveal ? this.reveal(stored.privateKey) : stored.privateKey;
    const key = { publicKey: stored.publicKey, privateKey };
    return { enabled: relay.enabled === true, url: typeof relay.url === "string" && relay.url ? relay.url : DEFAULT_RELAY_URL, key: validRelayKey(key) ? key : null };
  }
  /**
   * A copy of a shared space that is still to be taken back from a relay may hold the relay key it was
   * put with, when that key was replaced since. Its private half is wrapped on disk like the key in use.
   */
  revealCopies(team, wrapped) {
    const copies = (team.spaceCopies ?? []).map((copy) => {
      if (!copy?.key) return copy;
      const { key, ...rest } = copy;
      let privateKey = key.privateKey;
      try {
        if (wrapped && this.reveal) privateKey = this.reveal(privateKey);
      } catch {
        privateKey = "";
      }
      const opened = { publicKey: key.publicKey, privateKey };
      // A key that can't be opened is dropped: that copy ends by itself.
      return validRelayKey(opened) ? { ...rest, key: opened } : rest;
    });
    return { ...team, spaceCopies: copies };
  }
  loadTeam(saved) {
    const base = defaultTeam();
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return base;
    return {
      name: typeof saved.name === "string" && saved.name.trim() ? saved.name.trim().slice(0, 60) : base.name,
      roles: Array.isArray(saved.roles) ? saved.roles : base.roles,
      groups: Array.isArray(saved.groups) ? saved.groups : base.groups,
      members: Array.isArray(saved.members) ? saved.members : [],
      invites: Array.isArray(saved.invites) ? saved.invites : [],
      requests: Array.isArray(saved.requests) ? saved.requests : [],
      // "team-people-v1": who was invited to each chat, and each member's own view of bots and chats.
      chats: saved.chats && typeof saved.chats === "object" && !Array.isArray(saved.chats) ? saved.chats : {},
      views: saved.views && typeof saved.views === "object" && !Array.isArray(saved.views) ? saved.views : {},
      // "spaces-v1": how each space is shared, copies still to delete from a relay, the switch for links, and the one-time move.
      spaces: saved.spaces && typeof saved.spaces === "object" && !Array.isArray(saved.spaces) ? saved.spaces : {},
      spaceCopies: Array.isArray(saved.spaceCopies) ? saved.spaceCopies : [],
      linkSharing: saved.linkSharing === true,
      ...(saved.spacesMoved === true && { spacesMoved: true }),
      // The day of the last once-a-day alert about spaces, and when it went (space-alerts.mjs).
      ...(typeof saved.spaceDigest?.day === "string" && { spaceDigest: { day: saved.spaceDigest.day.slice(0, 10), at: Number(saved.spaceDigest.at) || 0 } }),
    };
  }
  /** The relay key pair, made the first time it is needed. Only its public half is ever shown or sent. */
  relayKey() {
    if (!this.data.relay.key) this.set({ relay: { ...this.data.relay, key: newRelayKey() } });
    return this.data.relay.key;
  }
  /** A new relay key, so a new room. */
  resetRelayKey() {
    this.set({ relay: { ...this.data.relay, key: newRelayKey() } });
    return this.data.relay.key;
  }
  fresh() {
    return { serverId: newId(12), keys: newKeyPair(), port: DEFAULT_PORT, enabled: false, name: "", devices: [], looks: {}, screen: "off", relay: { enabled: false, url: DEFAULT_RELAY_URL, key: null }, push: {}, sources: {}, profiles: { owner: null, members: {} }, team: defaultTeam() };
  }
  save() {
    // A store that couldn't open its key never overwrites the file it failed to read.
    if (this.data.locked) return;
    const { keys, serverId, port, enabled, name, devices, looks, screen, screenSetBy, relay, push, sources, profiles, team } = this.data;
    const secret = b64u(keys.privateKey);
    const body = {
      version: 1,
      serverId,
      publicKey: b64u(keys.publicKey),
      privateKey: this.protect ? this.protect(secret) : secret,
      ...(this.protect && { wrapped: true }),
      port,
      enabled,
      name,
      devices,
      looks,
      screen,
      ...(screenSetBy && { screenSetBy }),
      push,
      sources,
      profiles: loadProfiles(profiles),
      // An old relay key kept to take a shared space's copy back is wrapped like the one in use.
      team: !this.protect || !(team.spaceCopies ?? []).some((copy) => copy?.key) ? team : { ...team, spaceCopies: team.spaceCopies.map((copy) => (copy?.key ? { ...copy, key: { publicKey: copy.key.publicKey, privateKey: this.protect(copy.key.privateKey) } } : copy)) },
      // The relay's private key is wrapped like the link's own.
      relay: { enabled: relay.enabled, url: relay.url, key: relay.key && { publicKey: relay.key.publicKey, privateKey: this.protect ? this.protect(relay.key.privateKey) : relay.key.privateKey } },
    };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(body, null, 1), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  /** The name phones show for this computer. */
  get name() {
    return this.data.name || hostname().replace(/\.local$/i, "") || "Computer";
  }
  device(id) {
    return this.data.devices.find((d) => d.id === id) ?? null;
  }
  /**
   * `presenceKey` is the phone's second public key (P-256, SPKI as base64url), kept only when the
   * phone paired straight with this computer: what it signs with to turn the screen on (grant.mjs).
   */
  addDevice({ name, platform, kind, publicKey, presenceKey, memberId, person, profile }) {
    const member = typeof memberId === "string" && memberId ? memberId : null;
    const count = this.data.devices.filter((device) => (member ? device.memberId : !device.memberId)).length;
    if (count >= (member ? MAX_MEMBER_DEVICES : MAX_OWNER_DEVICES)) throw new Error(member ? "Too many member devices. Remove one first." : "Too many paired owner devices. Remove one first.");
    // A gadget is the owner's (gadget.mjs). A team member's device that calls itself one is a phone, with a member's cut of everything.
    const is = member && kind === "gadget" ? "phone" : deviceKind(kind, platform);
    const who = personName(person);
    const device = {
      id: newId(9),
      name: deviceName(name, is),
      ...(who && { person: who }),
      platform: String(platform || "").slice(0, 20),
      kind: is,
      publicKey: b64u(publicKey),
      ...(member && { memberId: member }),
      ...(presenceKey && { presenceKey }),
      ...(profile && { profile: profileBinding(profile) }),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.data.devices.push(device);
    this.save();
    return device;
  }
  /** Where a phone's notifications go and what it wants to hear ({ token, env, start?, prefs, activities }), or null. */
  push(deviceId) {
    return Object.hasOwn(this.data.push ?? {}, deviceId) ? this.data.push[deviceId] : null;
  }
  setPush(deviceId, record) {
    if (!this.device(deviceId)) return;
    const push = { ...this.data.push };
    if (record) push[deviceId] = record;
    else delete push[deviceId];
    this.data.push = push;
    this.save();
  }
  /** What bots may use on a phone, by source: { calendar: "read", … }. */
  sources(deviceId) {
    return Object.hasOwn(this.data.sources ?? {}, deviceId) ? this.data.sources[deviceId] : {};
  }
  setSources(deviceId, sources) {
    if (!this.device(deviceId)) return;
    this.data.sources = { ...this.data.sources, [deviceId]: sources };
    this.save();
  }
  /**
   * What is kept for a gadget (gadget.mjs): its bot and chat, and what it said of itself (board,
   * firmware, the rate of its speaker). A null or empty value takes a field away.
   */
  setGadget(id, patch) {
    const device = this.device(id);
    if (device?.kind !== "gadget") return false;
    const gadget = { ...device.gadget };
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value == null || value === "") delete gadget[key];
      else gadget[key] = value;
    }
    if (JSON.stringify(gadget) === JSON.stringify(device.gadget ?? {})) return true;
    device.gadget = gadget;
    this.save();
    return true;
  }
  /** Gives a paired device another name. False when there is no such device. */
  /** Admin mode for one of the owner's devices: whether it is shown every member's spaces, bots and chats. Never a member's device. */
  setAdmin(id, on) {
    const device = this.device(id);
    if (!device || device.memberId) return false;
    if (on === true) device.admin = true;
    else delete device.admin;
    this.save();
    return true;
  }
  renameDevice(id, name) {
    const device = this.device(id);
    if (!device) return false;
    if (typeof name !== "string" || !name.trim()) throw new Error("Give the device a name.");
    device.name = deviceName(name, device.kind);
    this.save();
    return true;
  }
  /**
   * Names the person a paired device belongs to. False when there is no such device. A team
   * member's device names the member: the member and all of their devices take the name.
   */
  setPerson(id, person) {
    const device = this.device(id);
    if (!device) return false;
    const who = personName(person);
    if (!who) throw new Error("Give the person a name.");
    if (device.memberId) this.nameMember(device.memberId, who);
    device.person = who;
    this.save();
    return true;
  }
  /** A member and all of their devices take a name, with no save of its own. */
  nameMember(memberId, who) {
    const member = this.data.team?.members?.find((item) => item.id === memberId);
    if (member) member.name = who;
    for (const other of this.data.devices) if (other.memberId === memberId) other.person = who;
    return !!member;
  }
  /** The owner names a member: the member and all of their devices take the name. False when there is no such member. */
  renameMember(memberId, name) {
    const who = personName(name);
    if (!who) throw new Error("Give the person a name.");
    if (!this.nameMember(memberId, who)) return false;
    this.save();
    return true;
  }
  removeDevice(id) {
    const before = this.data.devices.length;
    // What the phone set up goes with it.
    for (const kept of ["push", "sources"]) {
      if (!Object.hasOwn(this.data[kept] ?? {}, id)) continue;
      const next = { ...this.data[kept] };
      delete next[id];
      this.data[kept] = next;
    }
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    for (const member of this.data.team?.members ?? []) if (Array.isArray(member.deviceIds)) member.deviceIds = member.deviceIds.filter((deviceId) => deviceId !== id);
    if (this.data.devices.length !== before) this.save();
    return this.data.devices.length !== before;
  }
  touch(id) {
    const device = this.device(id);
    if (!device) return;
    const now = Date.now();
    // Written at most once a minute per phone.
    const stale = now - (device.lastSeenAt ?? 0) > 60_000;
    device.lastSeenAt = now;
    if (stale) this.save();
  }
  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }
  /** Saves the Botkin a bot is shown as. */
  setLook(botId, look) {
    if (typeof botId !== "string" || !botId || botId.length > 80) throw new Error("That look can't be saved.");
    this.data.looks = { ...this.data.looks, [botId]: cleanLook(look) };
    this.save();
  }
  /**
   * Gives every bot a look and forgets the looks of bots that are gone. A new bot gets a character
   * few other bots have, so a small team is all different, and keeps it from then on.
   */
  syncLooks(botIds) {
    const known = new Set(botIds);
    const looks = { ...this.data.looks };
    let changed = false;
    for (const id of Object.keys(looks)) {
      if (known.has(id)) continue;
      delete looks[id];
      changed = true;
    }
    for (const id of botIds) {
      if (looks[id]) continue;
      const used = new Map(HEADS.map((head) => [head, 0]));
      for (const look of Object.values(looks)) if (used.has(look.head)) used.set(look.head, used.get(look.head) + 1);
      const fewest = Math.min(...used.values());
      const free = HEADS.filter((head) => used.get(head) === fewest);
      looks[id] = { head: free[hash(id) % free.length], palette: "original" };
      changed = true;
    }
    if (!changed) return;
    this.data.looks = looks;
    this.save();
  }
}
