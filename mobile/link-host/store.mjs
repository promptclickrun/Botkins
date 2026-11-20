// What the link keeps on disk: this computer's identity, the phones paired with it, and the
// Botkin each bot is shown as on a phone (the desktop app has its own pictures for bots).
// One JSON file, written whole and readable only by the person (0600).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { b64u, newKeyPair, random, unb64u } from "./crypto.mjs";
import { DEFAULT_RELAY_URL, newRelayKey, validRelayKey } from "./relay.mjs";

export const DEFAULT_PORT = 47610;
/** What phones may do with this computer's screen: nothing, watch it, or watch and use it. */
export const SCREEN_MODES = ["off", "view", "control"];
const MAX_DEVICES = 20;
/** A paired device is a phone or a computer (another Botkins app that uses this one). */
export const DEVICE_KINDS = ["phone", "desktop"];
const DESKTOP_PLATFORMS = ["darwin", "macos", "mac", "win32", "windows", "linux", "desktop"];
/** The kind a device says it is, else the kind its platform makes it. A phone when nothing says otherwise, as before. */
export const deviceKind = (kind, platform) => (DEVICE_KINDS.includes(kind) ? kind : DESKTOP_PLATFORMS.includes(String(platform ?? "").toLowerCase()) ? "desktop" : "phone");
const deviceName = (name, kind) => String(name || (kind === "desktop" ? "Computer" : "Phone")).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) || (kind === "desktop" ? "Computer" : "Phone");
// The Botkins characters, by id. A bot without a look is given the least used one.
const HEADS = ["beacon", "crumb", "fathom", "goggle", "luna", "morel", "muse", "oakley", "pearl", "pip", "posy", "pounce", "ramble", "skiff", "spool", "sprig", "tinker", "toast", "wick", "wicket"];
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

export class LinkStore {
  /**
   * @param dir      Folder for link.json.
   * @param options.protect / options.reveal  Optional pair that wraps the private key (the desktop
   *   app passes its keychain). Without them the key is kept as it is.
   */
  constructor(dir, { protect, reveal } = {}) {
    Object.assign(this, { dir, file: join(dir, "link.json"), protect, reveal });
    this.data = this.load();
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
          devices: Array.isArray(saved.devices) ? saved.devices.filter((d) => d?.id && d.publicKey).map((d) => ({ ...d, kind: deviceKind(d.kind, d.platform) })) : [],
          looks: saved.looks && typeof saved.looks === "object" ? saved.looks : {},
          screen: SCREEN_MODES.includes(saved.screen) ? saved.screen : "off",
          relay: this.loadRelay(saved),
          // What each phone set up, by device id: where its notifications go, and what bots may use on it.
          push: saved.push && typeof saved.push === "object" ? saved.push : {},
          sources: saved.sources && typeof saved.sources === "object" ? saved.sources : {},
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
    return { serverId: b64u(random(12)), keys: newKeyPair(), port: DEFAULT_PORT, enabled: false, name: "", devices: [], looks: {}, screen: "off", relay: { enabled: false, url: DEFAULT_RELAY_URL, key: null }, push: {}, sources: {} };
  }
  save() {
    // A store that couldn't open its key never overwrites the file it failed to read.
    if (this.data.locked) return;
    const { keys, serverId, port, enabled, name, devices, looks, screen, relay, push, sources } = this.data;
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
      push,
      sources,
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
  addDevice({ name, platform, kind, publicKey }) {
    if (this.data.devices.length >= MAX_DEVICES) throw new Error("Too many paired devices. Remove one first.");
    const is = deviceKind(kind, platform);
    const device = {
      id: b64u(random(9)),
      name: deviceName(name, is),
      platform: String(platform || "").slice(0, 20),
      kind: is,
      publicKey: b64u(publicKey),
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
  /** Gives a paired device another name. False when there is no such device. */
  renameDevice(id, name) {
    const device = this.device(id);
    if (!device) return false;
    if (typeof name !== "string" || !name.trim()) throw new Error("Give the device a name.");
    device.name = deviceName(name, device.kind);
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
