// The credential vault: every secret Botkins keeps (MCP server keys, header and environment
// values, OAuth tokens and client secrets) lives here, encrypted, and nowhere else.
//
//   <data>/vault.json   { version, key, entries: { id: { label, kind, owner, createdAt, updatedAt, iv, tag, data } } }
//
// Each entry is sealed with AES-256-GCM under the vault's own 256-bit key. The entry's id is
// bound into the seal, so one entry's ciphertext can't be passed off as another's. The vault key
// itself is wrapped by the operating system (the macOS Keychain or Windows DPAPI, through
// Electron's safeStorage) in the installed app. A development or test run has no keychain to ask,
// so its key sits in <data>/vault.key, readable by this user only.
//
// The app's page never receives a secret: it gets the list of entries (what each is and who uses
// it) and can replace or remove one. The workspace file holds references ("vault:<id>"), not values.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REF = "vault:";
const MAX_ENTRIES = 2000;
const MAX_SECRET = 64000;

export const isRef = (value) => typeof value === "string" && value.startsWith(REF);

export class Vault {
  /**
   * @param dir       The data folder.
   * @param keyStore  { wrap(base64) → string, unwrap(string) → base64 | null } from the operating
   *                  system's secret storage. Without one the key is kept in a file beside the vault.
   *                  With `earlier(string) → boolean` it also says which wrapping only the app's
   *                  earlier keychain entry opens (desktop/keychain.mjs).
   */
  constructor(dir, keyStore) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "vault.json");
    this.keyFile = join(dir, "vault.key");
    this.keyStore = typeof keyStore?.wrap === "function" && typeof keyStore?.unwrap === "function" ? keyStore : null;
    this.entries = {};
    this.key = null;
    // The vault key as the app wrapped it under its earlier name. It stays in the
    // file as it is, beside this app's own wrapping, so an earlier version still opens the vault.
    this.earlier = null;
    // True when a vault exists here that this run can't open. It is then left exactly as it is:
    // nothing is read from it, written to it or removed from it until the person resets it.
    this.locked = false;
    this.load();
  }
  /** "keychain" when the operating system guards the vault key, "file" for a development run. */
  get protection() {
    return this.keyStore ? "keychain" : "file";
  }
  load() {
    if (!existsSync(this.file)) return this.fresh();
    let saved = null;
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      saved = null;
    }
    const key = saved && this.unwrap(saved.key);
    if (key && saved.entries && typeof saved.entries === "object") {
      this.key = key;
      this.entries = saved.entries;
      if (this.keyStore && saved.key?.by === "os" && typeof saved.key.data === "string") {
        const own = typeof saved.key.botkins === "string";
        const helped = this.keyStore.earlier?.(saved.key.data) === true;
        if (own || helped) this.earlier = saved.key.data;
        // Opened with the earlier keychain entry's help, and this app's own wrapping is missing or
        // no longer opens (its keychain entry was removed, say): it is written, beside the earlier one.
        const ownOpens = own && this.keyFrom(this.keyStore.unwrap(saved.key.botkins)) !== null;
        if (helped && !ownOpens) {
          try {
            this.save();
          } catch {}
        }
      }
      // A vault made by a development run is taken over by the installed app: its key moves to the keychain.
      if (this.keyStore && saved.key?.by === "file") {
        try {
          this.save();
          rmSync(this.keyFile, { force: true });
        } catch {}
      }
      return;
    }
    // The file can't be read, or its key isn't available to this run (the installed app's vault in a
    // development run, another computer, a keychain that didn't answer). It may open again later,
    // so it stays untouched.
    this.locked = true;
    this.reason = !saved ? "damaged" : saved.key?.by === "os" && !this.keyStore ? "installed-app" : "key";
    this.entries = saved?.entries && typeof saved.entries === "object" ? saved.entries : {};
  }
  /** Starts an empty vault with a new key. When that can't be saved, the vault stays locked. */
  fresh() {
    this.key = randomBytes(32);
    this.entries = {};
    this.earlier = null;
    this.locked = false;
    delete this.reason;
    try {
      this.save();
    } catch (error) {
      this.locked = true;
      this.reason = "key";
      console.error("Credential vault:", error.message);
    }
  }
  /**
   * Sets a vault that can't be opened aside (it is renamed, not deleted) and starts an empty one.
   * Only the person asks for this: everything that was stored has to be entered again.
   */
  reset() {
    if (!this.locked) return false;
    try {
      if (existsSync(this.file)) renameSync(this.file, this.file.replace(/\.json$/, ".unreadable-" + Date.now() + ".json"));
    } catch {}
    this.fresh();
    return !this.locked;
  }
  /** The key in an unwrapped text, or null when the text isn't a 32-byte key. */
  keyFrom(text) {
    const key = typeof text === "string" && text ? Buffer.from(text, "base64") : null;
    return key?.length === 32 ? key : null;
  }
  unwrap(stored) {
    try {
      if (stored?.by === "os" && this.keyStore) {
        // This app's own wrapping first, then the one from before the rename.
        for (const data of [stored.botkins, stored.data]) {
          const key = typeof data === "string" ? this.keyFrom(this.keyStore.unwrap(data)) : null;
          if (key) return key;
        }
        return null;
      }
      if (stored?.by === "file") {
        const key = Buffer.from(readFileSync(this.keyFile, "utf8").trim(), "base64");
        return key.length === 32 ? key : null;
      }
    } catch {}
    return null;
  }
  save() {
    if (this.locked) return;
    let key;
    if (this.keyStore) {
      const wrapped = this.keyStore.wrap(this.key.toString("base64"));
      key = this.earlier ? { by: "os", data: this.earlier, botkins: wrapped } : { by: "os", data: wrapped };
    }
    else {
      if (!existsSync(this.keyFile) || readFileSync(this.keyFile, "utf8").trim() !== this.key.toString("base64"))
        writeFileSync(this.keyFile, this.key.toString("base64") + "\n", { mode: 0o600 });
      key = { by: "file" };
    }
    writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, key, entries: this.entries }), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  /** A vault reference as stored in the workspace file. */
  ref(id) {
    return REF + id;
  }
  id(ref) {
    const id = isRef(ref) ? ref.slice(REF.length) : ref;
    return typeof id === "string" && /^[\w-]{1,80}$/.test(id) ? id : null;
  }
  /**
   * Stores a secret and returns its reference. With `id`, replaces that entry's secret.
   * @param meta { label, kind, owner }: what the person sees, the kind of credential, and the
   *             thing that uses it (such as "mcp:<server id>").
   */
  put(secret, meta = {}, id) {
    if (typeof secret !== "string" || !secret || secret.length > MAX_SECRET) throw new Error("Invalid secret");
    if (this.locked)
      throw new Error(
        this.reason === "installed-app"
          ? "This copy of Botkins can't open the credential vault, which belongs to the installed app. Keys and sign-ins can't be saved from here."
          : "Botkins can't open its credential vault on this computer, so it can't save this. Reset the vault in Settings › Credentials, then enter your keys again.",
      );
    id = id ? this.id(id) : randomUUID();
    if (!id) throw new Error("Invalid vault entry");
    if (!this.entries[id] && Object.keys(this.entries).length >= MAX_ENTRIES) throw new Error("The vault is full.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const now = Date.now();
    const old = this.entries[id];
    this.entries[id] = {
      label: String(meta.label ?? old?.label ?? "Credential").slice(0, 200),
      kind: String(meta.kind ?? old?.kind ?? "secret").slice(0, 40),
      owner: String(meta.owner ?? old?.owner ?? "").slice(0, 200),
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    this.save();
    return this.ref(id);
  }
  /** The secret behind a reference, or null when there is none or it can't be read. */
  get(ref) {
    const id = this.id(ref);
    const entry = id && this.entries[id];
    if (!entry || this.locked) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(entry.iv, "base64"));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
  has(ref) {
    const id = this.id(ref);
    return !!id && !!this.entries[id];
  }
  remove(ref) {
    const id = this.id(ref);
    if (this.locked || !id || !this.entries[id]) return false;
    const entry = this.entries[id];
    delete this.entries[id];
    try {
      this.save();
    } catch (error) {
      this.entries[id] = entry;
      throw error;
    }
    return true;
  }
  /** Removes every entry of an owner that `keep` (a set of references) doesn't name. */
  prune(owner, keep = new Set()) {
    if (this.locked) return 0;
    let removed = 0;
    for (const [id, entry] of Object.entries(this.entries))
      if (entry.owner === owner && !keep.has(this.ref(id))) {
        delete this.entries[id];
        removed++;
      }
    if (removed) this.save();
    return removed;
  }
  /** What the app's page may see: every entry without its secret. */
  list() {
    return Object.entries(this.entries)
      .map(([id, e]) => ({ id, label: String(e?.label ?? ""), kind: String(e?.kind ?? ""), owner: String(e?.owner ?? ""), createdAt: e?.createdAt, updatedAt: e?.updatedAt }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
}
