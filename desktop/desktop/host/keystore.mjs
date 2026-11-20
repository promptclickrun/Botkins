// The terminal host's key store: what wraps the credential vault's key and the phone link's
// private key at rest on a computer with no desktop session to ask (desktop/host/headless.mjs).
//
// Both keys are 32 bytes, kept in the data folder (<data>/vault.json, <data>/link/link.json) and
// wrapped here with AES-256-GCM under one more key, the host key. Where the host key comes from
// decides what a copy of the data folder is worth to someone who has nothing else:
//
//   systemd   The service's unit hands it over as a credential (LoadCredential= or
//             LoadCredentialEncrypted=, see desktop/terminal/service.mjs): a file named
//             "botkins-key" in $CREDENTIALS_DIRECTORY, a memory-only folder that only this
//             service can read, and only while it runs. On disk the key is a root-only file
//             (/etc/botkins/host.key, mode 0400, which the service's own user can't open), or
//             with systemd-creds a file encrypted to this machine's TPM or host secret.
//   keychain  macOS: a generic password in the keychain of the person the service runs as, read
//             and written with /usr/bin/security.
//   file      A key file, <data>/host.key unless BOTKINS_KEY_FILE names another, readable by the
//             service's user only. This is what a plain `botkins serve` in a terminal uses.
//
// What this is for, plainly. It protects the secrets in a copy of the data folder that left the
// computer without the host key: a backup, a disk image of the data volume, a folder synced or
// attached somewhere by mistake. With "systemd" and "keychain" the host key is never in that
// folder. With "file" in the data folder it is, and the wrapping then only keeps a secret out of
// a casual read of one file. It does not protect against someone who is root on the running
// computer, or who runs code as the service's user: the service itself holds the keys in memory
// while it runs, as it must to use them. No store here can do more than the system's own
// accounts and permissions do.
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CREDENTIAL = "botkins-key";
export const KEYCHAIN_SERVICE = "Botkins Terminal Host";
export const SOURCES = ["auto", "systemd", "keychain", "file"];
const PREFIX = "bk1.";
const PROBE = "botkins-host-key";

/** A 32-byte key from what a key file or credential holds: the bytes themselves, base64 or hex. */
export function keyFrom(bytes) {
  if (!bytes) return null;
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  if (raw.length === 32) return Buffer.from(raw);
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    const key = Buffer.from(text, "base64");
    if (key.length === 32) return key;
  }
  return null;
}

/** { wrap(text) → "bk1.…", unwrap(wrapped) → text | null } under a 32-byte key. */
export function sealer(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("A host key is 32 bytes.");
  return {
    wrap(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
    },
    unwrap(wrapped) {
      try {
        if (typeof wrapped !== "string" || !wrapped.startsWith(PREFIX)) return null;
        const bytes = Buffer.from(wrapped.slice(PREFIX.length), "base64");
        if (bytes.length < 28) return null;
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
}

/** Runs /usr/bin/security. `input` goes to its standard input, so a key is never on a command line. */
function security(args, input) {
  return new Promise((resolve) => {
    const child = execFile("/usr/bin/security", args, { timeout: 15_000, encoding: "utf8" }, (error, stdout) => resolve({ ok: !error, code: error?.code, out: String(stdout ?? "") }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** The keychain account a data folder's key is kept under, so two data folders never share one. */
export const keychainAccount = (dataDir) => {
  let real = dataDir;
  try {
    real = realpathSync(dataDir);
  } catch {
    // Not made yet: its name as given.
  }
  return "host-key-" + createHash("sha256").update(real).digest("hex").slice(0, 16);
};

async function fromKeychain(dataDir, run, create) {
  const account = keychainAccount(dataDir);
  const found = await run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
  if (found.ok) {
    const key = keyFrom(found.out);
    if (!key) throw new Error("The keychain entry “" + KEYCHAIN_SERVICE + "” doesn't hold a host key.");
    return key;
  }
  // 44: there is no such entry. Anything else (a locked keychain, no session to ask) is said as it is.
  if (found.code !== 44) throw new Error("The keychain didn't answer (security exited with " + found.code + "). Unlock the login keychain of the person this service runs as, or choose a key file with BOTKINS_KEY_FILE.");
  if (!create) throw new Error("The host key is missing from the keychain (“" + KEYCHAIN_SERVICE + "”), so this data folder's secrets can't be opened.");
  const key = randomBytes(32);
  // Through `security -i`, which reads commands from its input: the key is never an argument a
  // process list could show. -U updates an entry that appeared meanwhile.
  const added = await run(["-i"], 'add-generic-password -U -s "' + KEYCHAIN_SERVICE + '" -a "' + account + '" -D "Botkins host key" -w "' + key.toString("base64") + '"\n');
  const check = added.ok ? await run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]) : added;
  if (!check.ok || !keyFrom(check.out)?.equals(key)) throw new Error("The keychain wouldn't keep the host key. Unlock the login keychain, or choose a key file with BOTKINS_KEY_FILE.");
  return key;
}

function fromFile(file, create) {
  if (existsSync(file)) {
    const key = keyFrom(readFileSync(file));
    if (!key) throw new Error("The key file " + file + " doesn't hold a 32-byte key.");
    return key;
  }
  if (!create) throw new Error("The key file " + file + " is missing, so this data folder's secrets can't be opened.");
  const key = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // "wx": never over a key that appeared meanwhile.
  writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  return key;
}

/**
 * Opens the host's key store for a data folder.
 * @param options.dataDir  The workspace's data folder. <dataDir>/keystore.json remembers where
 *   the key came from and a small text wrapped with it, so a later start with another key says
 *   so in one sentence instead of quietly locking the vault and the phone link.
 * @param options.source   "auto" (the unit's credential when there is one, else the keychain on
 *   macOS, else a key file), or one of "systemd", "keychain", "file".
 * @param options.keyFile  The key file for "file". BOTKINS_KEY_FILE, else <dataDir>/host.key.
 * @returns { wrap, unwrap, source, where }: `where` says where the key is kept, for `botkins doctor`.
 */
export async function openKeyStore({ dataDir, source = "auto", keyFile, env = process.env, platform = process.platform, run = security } = {}) {
  if (!SOURCES.includes(source)) throw new Error("A key source is one of: " + SOURCES.join(", ") + ".");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const marker = join(dataDir, "keystore.json");
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(marker, "utf8"));
  } catch {
    saved = null;
  }
  const credential = env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, CREDENTIAL) : null;
  const file = keyFile || env.BOTKINS_KEY_FILE || join(dataDir, "host.key");
  let chosen = source;
  if (chosen === "auto") {
    if (credential && existsSync(credential)) chosen = "systemd";
    // A key file named on purpose wins over the keychain; so does the store this folder already uses.
    else if (keyFile || env.BOTKINS_KEY_FILE) chosen = "file";
    else if (SOURCES.includes(saved?.source) && saved.source !== "auto") chosen = saved.source;
    else chosen = platform === "darwin" ? "keychain" : "file";
  }
  // A new key is made only for a folder that has none yet: never for one whose secrets an earlier key wrapped.
  const create = !saved;
  let key;
  let where;
  if (chosen === "systemd") {
    if (!credential || !existsSync(credential)) throw new Error("The service's unit didn't hand over the host key (the credential “" + CREDENTIAL + "”). Run `botkins service install` again, or start the service with systemd.");
    key = keyFrom(readFileSync(credential));
    if (!key) throw new Error("The credential “" + CREDENTIAL + "” doesn't hold a 32-byte key.");
    where = "systemd credential";
  } else if (chosen === "keychain") {
    if (platform !== "darwin") throw new Error("The keychain is a macOS key source.");
    key = await fromKeychain(dataDir, run, create);
    where = "macOS keychain (“" + KEYCHAIN_SERVICE + "”)";
  } else {
    key = fromFile(file, create);
    where = "key file " + file;
  }
  const seal = sealer(key);
  if (saved) {
    if (seal.unwrap(saved.probe) !== PROBE) throw new Error("The host key from the " + where + " is not the one this data folder's secrets were wrapped with (" + (saved.source ?? "unknown") + "). Put the earlier key back, or move " + marker + " aside to start with new secrets.");
  }
  if (!saved || saved.source !== chosen) {
    writeFileSync(marker + ".tmp", JSON.stringify({ version: 1, source: chosen, probe: saved?.probe ?? seal.wrap(PROBE) }) + "\n", { mode: 0o600 });
    renameSync(marker + ".tmp", marker);
  }
  return { wrap: seal.wrap, unwrap: seal.unwrap, source: chosen, where };
}
