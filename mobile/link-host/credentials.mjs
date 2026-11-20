// Credentials: secrets a phone can save or point at, and a bot can use, without the phone (or a
// chat) ever seeing the value.
//
// Two kinds of entry share one list:
//   vault   the value is kept here, encrypted, in <dir>/credentials.json
//   linked  the value stays in a password manager (1Password, Bitwarden, Proton Pass) and is read
//           from it each time it is used
// A phone sees the list (names and a "Work / GitHub / token" line) and never a value. To use one it
// puts { "$credential": id } where the value belongs in a call; LinkHost swaps the value in on the
// computer (see resolve()).
//
// The vault file is written whole, atomically, readable only by the person (0600). Each value is
// AES-256-GCM under one random data key. The data key is wrapped with the same optional
// protect/reveal pair the link uses for its own key (the desktop passes its system keychain).
// Without them it sits in the file, which is fine for development only. When a wrapped key can't
// be opened in this run the vault is locked: the list still shows, nothing can be read or changed,
// and the file is left exactly as it is.
import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64u, random, unb64u } from "./crypto.mjs";
import { drivers } from "./managers.mjs";
import { Failure, searchDirs } from "./tools.mjs";

const KINDS = ["api-key", "login", "note"];
const MAX_ENTRIES = 300;
const MAX_VALUE = 16_000;
const MAX_READ = 64 * 1024;
const STATUS_TTL = 10_000;
const LOCKED = "The saved credentials are locked on this computer.";

const PUBLIC = ["id", "name", "kind", "username", "website", "notes", "source", "reference", "createdAt", "updatedAt"];

class Vault {
  constructor(dir, { protect, reveal } = {}) {
    Object.assign(this, { dir, file: join(dir, "credentials.json"), protect, reveal, entries: [], key: null, locked: null });
    this.load();
  }
  load() {
    let text;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      // No file yet is a new vault. A file that can't be read is left alone.
      if (error.code === "ENOENT") this.key = random(32);
      else this.locked = "The saved credentials can't be read.";
      return;
    }
    let saved;
    try {
      saved = JSON.parse(text);
      if (saved?.version !== 1 || typeof saved.key !== "string" || !Array.isArray(saved.entries)) throw new Error("damaged");
    } catch {
      this.locked = LOCKED;
      return;
    }
    // The list is shown even when the key can't be opened: only reading and changing need it.
    this.entries = saved.entries.filter((entry) => entry && typeof entry.id === "string" && typeof entry.name === "string");
    try {
      if (saved.wrapped && !this.reveal) throw new Error("locked");
      const key = unb64u(saved.wrapped ? this.reveal(saved.key) : saved.key);
      if (key.length !== 32) throw new Error("damaged");
      this.key = key;
    } catch {
      this.locked = LOCKED;
    }
  }
  /** Writes the vault. Throws when it is locked, so a vault that couldn't be opened is never overwritten. */
  persist() {
    if (this.locked) throw new Failure(LOCKED);
    let key;
    try {
      key = this.protect ? this.protect(b64u(this.key)) : b64u(this.key);
    } catch {
      throw new Failure("The computer's keychain didn't answer, so nothing was saved.");
    }
    const body = { version: 1, key, ...(this.protect && { wrapped: true }), entries: this.entries };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file + ".tmp", JSON.stringify(body, null, 1), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  /** The value as stored: nonce, ciphertext and tag. The entry's id is bound in, so a value can't be moved to another entry. */
  seal(id, value) {
    const nonce = random(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(id, "utf8"));
    const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return b64u(Buffer.concat([nonce, sealed, cipher.getAuthTag()]));
  }
  open(entry) {
    if (!this.key) throw new Failure(LOCKED);
    try {
      const bytes = unb64u(entry.secret);
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(entry.id, "utf8"));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8");
    } catch {
      throw new Failure("The saved value can't be opened.");
    }
  }
}

/** An optional text field: absent keeps what there is, empty clears it. */
function optional(input, key, before, limit, label) {
  const value = input[key];
  if (value === undefined) return before;
  if (value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > limit) throw new Failure("Use up to " + limit + " characters for the " + label + ".");
  return value.trim();
}

// A reference is { "$credential": id }, or that plus `prefix`: a scheme word and a space put in
// front of the value, as an Authorization header needs ("Bearer ").
const PREFIX = /^[A-Za-z][A-Za-z0-9-]{0,19} $/;
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Anything that claims to be a reference, whether or not it is shaped right. */
const claimsRef = (value) => isPlain(value) && Object.hasOwn(value, "$credential");
const isRef = (value) => {
  if (!claimsRef(value) || typeof value.$credential !== "string") return false;
  const keys = Object.keys(value);
  return keys.length === 1 || (keys.length === 2 && typeof value.prefix === "string" && PREFIX.test(value.prefix));
};
/** The value as the call gets it. A prefix isn't repeated when the saved value already starts with that scheme. */
const filled = (ref, value) => (ref.prefix && !value.toLowerCase().startsWith(ref.prefix.toLowerCase()) ? ref.prefix + value : value);
const MAX_DEPTH = 64;
const MIN_SCRUB = 6; // shorter values are not searched for in answers
const NOT_THERE = "A credential can't be used there.";

/**
 * Where a call may carry a reference, as [path into the arguments, whether a prefix is honored].
 * These are the only places, and each takes a value one level down at most:
 *   respond                 the answer's `value`, and the values directly in its `content`
 *   saveMcpServer           the values directly in `env` and `headers` (a prefix too), and `oauth.clientSecret`
 *   connectProviderService  the `key` (a prefix too)
 *   providerUseToken        the token itself (the second argument)
 *   link.voice.key          the key itself (the second argument)
 */
function places(method, args) {
  const found = [];
  const each = (path, object, prefix) => {
    if (isPlain(object)) for (const key of Object.keys(object)) if (key !== "__proto__") found.push([[...path, key], prefix]);
  };
  if (method === "respond" && isPlain(args[1])) {
    found.push([[1, "value"], false]);
    each([1, "content"], args[1].content, false);
  } else if (method === "saveMcpServer" && isPlain(args[0])) {
    each([0, "env"], args[0].env, false);
    each([0, "headers"], args[0].headers, true);
    if (isPlain(args[0].oauth)) found.push([[0, "oauth", "clientSecret"], false]);
  } else if (method === "connectProviderService" && isPlain(args[2])) found.push([[2, "key"], true]);
  else if (method === "link.voice.key" || method === "providerUseToken") found.push([[1], false]);
  // A plugin's settings (docs/plugins.md): each value of "plugins.configure", and of "plugins.install"'s `config`.
  else if (method === "plugins.configure") each([1], args[1], false);
  else if (method === "plugins.install" && isPlain(args[1])) each([1, "config"], args[1].config, false);
  return found;
}
const at = (root, path) => path.reduce((value, key) => (value !== null && typeof value === "object" && Object.hasOwn(value, key) ? value[key] : undefined), root);

/** How a secret may be written when it is echoed: as it is, inside JSON, and inside a web address. Longest first. */
function forms(secrets) {
  const out = new Set();
  for (const secret of secrets) {
    // A very short value would blank out unrelated text (ids, words), and hides nothing worth hiding.
    if (typeof secret !== "string" || secret.length < MIN_SCRUB) continue;
    out.add(secret);
    out.add(JSON.stringify(secret).slice(1, -1));
    out.add(encodeURIComponent(secret));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** `value` with every secret in any of its strings replaced by "•••" (an answer or an error on its way to a phone). */
export function scrub(value, secrets, depth = 0) {
  if (typeof value === "string") return forms(secrets).reduce((text, secret) => text.split(secret).join("•••"), value);
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((inner) => scrub(inner, secrets, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrub(inner, secrets, depth + 1)]));
}

export class Credentials {
  /**
   * @param options.dir         Folder for credentials.json.
   * @param options.protect / options.reveal  Wrap the data key (a keychain).
   * @param options.searchPath  Folders to find the password managers' tools in (a test passes its own).
   * @param options.platform    Pretend to be another system (a test of the Windows .cmd message uses it).
   * @param options.onChange    Called after anything a phone shows has changed.
   */
  constructor({ dir, protect, reveal, searchPath, now = Date.now, platform, onChange = () => {} }) {
    this.vault = new Vault(dir, { protect, reveal });
    this.now = now;
    this.onChange = onChange;
    this.drivers = new Map(drivers({ dirs: searchDirs(searchPath), now, platform }).map((driver) => [driver.id, driver]));
    this.statuses = null;
  }

  get locked() {
    return !!this.vault.locked;
  }
  /** What every phone sees: no values, and no ids inside a password manager. */
  list() {
    return this.vault.entries.map((entry) => Object.fromEntries(PUBLIC.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])));
  }
  find(id) {
    const entry = this.vault.entries.find((e) => e.id === id);
    if (!entry) throw new Failure("That credential no longer exists.");
    return entry;
  }
  writable() {
    // Read on a phone and in the app's own window alike, so it names the app, not "your computer".
    if (this.vault.locked) throw new Failure(LOCKED + " Open Botkins on it to unlock them.");
  }
  /** Replaces the entries and writes them. A write that fails leaves the list as it was. */
  commit(entries) {
    const before = this.vault.entries;
    this.vault.entries = entries;
    try {
      this.vault.persist();
    } catch (error) {
      this.vault.entries = before;
      throw error;
    }
    this.onChange();
  }

  // ── Saving ────────────────────────────────────────────────────────────────────────────────

  /** Creates or changes a vault entry. `value: null` or no value keeps the saved one. Returns the id. */
  async save(input) {
    this.writable();
    if (!input || typeof input !== "object") throw new Failure("That credential can't be saved.");
    const before = input.id == null ? null : this.find(input.id);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 80) throw new Failure("Give the credential a name of up to 80 characters.");
    const kind = input.kind ?? before?.kind ?? "api-key";
    if (!KINDS.includes(kind)) throw new Failure("That kind of credential isn't supported.");
    const { value } = input;
    const entry = {
      ...before,
      id: before?.id ?? "cred-" + b64u(random(9)),
      name,
      kind,
      source: before?.source ?? "vault",
      createdAt: before?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };
    for (const [key, limit, label] of [["username", 200, "username"], ["website", 300, "website"], ["notes", 2000, "notes"]]) {
      const next = optional(input, key, before?.[key], limit, label);
      if (next === undefined) delete entry[key];
      else entry[key] = next;
    }
    if (before && before.source !== "vault") {
      if (value != null) throw new Failure("A linked credential is read from its password manager. Change it there.");
    } else if (typeof value === "string") {
      if (!value.trim() || value.length > MAX_VALUE) throw new Failure("A value is up to " + MAX_VALUE.toLocaleString("en-US") + " characters.");
      entry.secret = this.vault.seal(entry.id, value);
    } else if (value == null) {
      if (!before) throw new Failure("Enter the value to save.");
    } else throw new Failure("That value can't be saved.");
    if (!before && this.vault.entries.length >= MAX_ENTRIES) throw new Failure("Too many saved credentials. Remove one first.");
    this.commit(before ? this.vault.entries.map((e) => (e.id === before.id ? entry : e)) : [...this.vault.entries, entry]);
    return entry.id;
  }
  remove(id) {
    this.writable();
    const entry = this.find(id);
    this.commit(this.vault.entries.filter((e) => e !== entry));
  }

  // ── Reading (on the computer only) ─────────────────────────────────────────────────────────

  /** The value of a credential, read now. Only LinkHost's own code calls this; no answer to a phone holds it. */
  async read(id) {
    const entry = this.find(id);
    const value = entry.source === "vault" ? this.vault.open(entry) : await this.driver(entry.source).read(entry.ref ?? {});
    if (typeof value !== "string" || !value) throw new Failure("The value is empty.");
    if (value.length > MAX_READ) throw new Failure("The value is too long to use.");
    return value;
  }
  /** Whether a credential can be read right now. The value is dropped. */
  async check(id) {
    try {
      await this.read(id);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: reason(error) };
    }
  }
  /**
   * Fills in the references of a call. Only the places listed in places() may hold one; a reference
   * anywhere else, in this call or any other, stops the call with "A credential can't be used there."
   * and is never passed on. A value that can't be read stops it too. Returns { args, secrets }: the
   * arguments with the values in (a copy), and every value put in, to be kept out of the answer.
   */
  async resolve(method, args) {
    const slots = [];
    const allowed = new Set();
    for (const [path, prefix] of places(method, args)) {
      const ref = at(args, path);
      if (!claimsRef(ref)) continue;
      if (!isRef(ref)) throw new Failure(NOT_THERE);
      allowed.add(ref);
      slots.push({ path, ref, prefix });
    }
    const walk = (value, depth) => {
      if (depth > MAX_DEPTH) throw new Failure("That call is nested too deeply.");
      if (claimsRef(value) && !allowed.has(value)) throw new Failure(NOT_THERE);
      if (value !== null && typeof value === "object") for (const inner of Object.values(value)) walk(inner, depth + 1);
    };
    walk(args, 0);
    if (!slots.length) return { args, secrets: [] };
    const values = new Map();
    for (const { ref } of slots) {
      if (values.has(ref.$credential)) continue;
      try {
        values.set(ref.$credential, await this.read(ref.$credential));
      } catch (error) {
        throw new Failure("That credential can't be read right now: " + reason(error));
      }
    }
    const next = structuredClone(args);
    const secrets = new Set();
    for (const { path, ref, prefix } of slots) {
      const raw = values.get(ref.$credential);
      const value = filled(prefix ? ref : {}, raw);
      at(next, path.slice(0, -1))[path.at(-1)] = value;
      secrets.add(raw).add(value);
    }
    return { args: next, secrets: [...secrets] };
  }

  // ── Password managers ──────────────────────────────────────────────────────────────────────

  driver(id) {
    const driver = typeof id === "string" ? this.drivers.get(id) : null;
    if (!driver) throw new Failure("That password manager isn't supported.");
    return driver;
  }
  /** Runs a driver call. Anything that isn't a short, safe Failure becomes a plain sentence. */
  async guard(driver, call) {
    try {
      return await call(driver);
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure("Couldn't read " + driver.name + ".");
    }
  }
  async managers(refresh = false) {
    if (!refresh && this.statuses && this.now() - this.statuses.at < STATUS_TTL) return this.statuses.list;
    const list = await Promise.all([...this.drivers.values()].map((driver) => this.guard(driver, (d) => d.status()).catch((error) => ({ id: driver.id, name: driver.name, state: "error", message: error.message }))));
    this.statuses = { at: this.now(), list };
    return list;
  }
  async unlock(manager, secret) {
    const driver = this.driver(manager);
    if (!driver.unlock) throw new Failure("Unlock " + driver.name + " on your computer.");
    const password = secret?.password;
    if (typeof password !== "string" || !password || password.length > 1024) throw new Failure("Enter the master password.");
    await this.guard(driver, (d) => d.unlock(password));
    this.statuses = null;
    return this.guard(driver, (d) => d.status());
  }
  async lock(manager) {
    const driver = this.driver(manager);
    if (!driver.lock) throw new Failure("Lock " + driver.name + " on your computer.");
    await this.guard(driver, (d) => d.lock());
    this.statuses = null;
    return this.guard(driver, (d) => d.status());
  }
  vaults(manager) {
    return this.guard(this.driver(manager), (d) => d.vaults());
  }
  items(manager, vaultId, query) {
    return this.guard(this.driver(manager), (d) => d.items(vaultId, query));
  }
  item(manager, vaultId, itemId) {
    return this.guard(this.driver(manager), (d) => d.item(vaultId, itemId));
  }
  /** Saves a field of a password manager item as a credential. Only its place is kept, never its value. */
  async link(input) {
    this.writable();
    // What was sent is checked before anything of it is read.
    if (!input || typeof input !== "object") throw new Failure("That field isn't valid.");
    const driver = this.driver(input.manager);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 80) throw new Failure("Give the credential a name of up to 80 characters.");
    if (this.vault.entries.length >= MAX_ENTRIES) throw new Failure("Too many saved credentials. Remove one first.");
    const { vaultId, itemId, fieldId } = input;
    if (typeof fieldId !== "string" || !fieldId || fieldId.length > 200) throw new Failure("That field isn't valid.");
    // Asking the manager proves the place exists and gives the text the phone shows.
    const vault = (await this.guard(driver, (d) => d.vaults())).find((v) => v.id === vaultId);
    if (!vault) throw new Failure("That vault isn't there.");
    const item = await this.guard(driver, (d) => d.item(vaultId, itemId));
    const field = item.fields.find((f) => f.id === fieldId);
    if (!field) throw new Failure("That field isn't on the item.");
    const entry = {
      id: "cred-" + b64u(random(9)),
      name,
      kind: "api-key",
      source: driver.id,
      reference: [vault.name, item.title, field.label].join(" / ").slice(0, 300),
      ref: { manager: driver.id, vaultId, itemId, fieldId },
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.commit([...this.vault.entries, entry]);
    return entry.id;
  }
}

/** Why a read failed, as a sentence. Only a Failure's own words are used. */
function reason(error) {
  return error instanceof Failure ? error.message : "Something went wrong.";
}
