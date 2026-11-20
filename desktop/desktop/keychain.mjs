// Keys the system keychain guards, across the app's rename.
//
// The installed app wraps two keys with Electron's safeStorage: the credential vault's key
// (<data>/vault.json) and the phone link's private key (<data>/link/link.json). On macOS
// safeStorage keeps its own secret in a keychain entry named after the app: "Commander Safe
// Storage" before the rename, "Botkins Safe Storage" after it. A process named Botkins can't open
// what the first entry wrapped. (Windows keeps safeStorage's secret in the data folder, under the
// person's own account, so nothing changes there.)
//
// So, when the data folder holds a key this app can't open and the Mac still has the earlier
// entry, the app starts itself once more as a helper: a process that takes the earlier name, opens
// the keys it is handed, prints them to its parent and exits. It opens no window and uses a
// throwaway folder. macOS asks the person once whether Botkins may use "Commander Safe Storage",
// because the app's identity changed with its name. The vault then saves its key under the new
// entry as well, beside the earlier wrapping, which is never overwritten: an earlier Commander
// still opens the same vault. The phone link's key is saved under the new entry in the same start
// (desktop/main.mjs), so the helper is needed once.
//
// What the helper is, plainly: this app, asked on its command line to decrypt what it is handed
// with the earlier entry. Any program running as the same person could start it the same way.
// macOS still asks the person each time, unless they chose "Always Allow" for that entry, which is
// why the app asks them to choose "Allow": once is enough.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_NAME } from "./home.mjs";

/** Starts the app as the helper. */
export const HELPER_FLAG = "--open-commander-keys";
const MARK = "@@botkins-keys@@";

const json = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * The wrapped keys in a data folder that `unwrap` can't open.
 * @param unwrap  (wrapped) → text, or null when this app's keychain entry can't open it.
 */
export function lockedKeys(dataDir, unwrap) {
  // Opened means a key came out. The wrong keychain entry usually fails outright, but now and then
  // it "decrypts" a wrapping into junk, which must count as locked or the helper would never run.
  const opens = (data) => typeof data === "string" && isKey(unwrap(data));
  const locked = [];
  const key = json(join(dataDir, "vault.json"))?.key;
  if (key?.by === "os" && typeof key.data === "string" && !opens(key.botkins) && !opens(key.data)) locked.push(key.data);
  const link = json(join(dataDir, "link", "link.json"));
  if (link?.wrapped === true && typeof link.privateKey === "string" && !opens(link.privateKey)) locked.push(link.privateKey);
  return locked;
}

/** True for the text of a 32-byte key in base64, which is what both wrapped keys are. */
export function isKey(text) {
  return typeof text === "string" && /^[A-Za-z0-9+/_-]{43}=?$/.test(text) && Buffer.from(text, "base64").length === 32;
}

/** True when this Mac's keychain has the entry the app used under its earlier name. Asks the person nothing. */
export function hasEarlierKeychain({ platform = process.platform, run = spawnSync, name = LEGACY_NAME } = {}) {
  if (platform !== "darwin") return false;
  try {
    return run("/usr/bin/security", ["find-generic-password", "-s", name + " Safe Storage"], { stdio: "ignore", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** True in the process that was started as the helper. */
export const isKeyHelper = (argv = process.argv) => argv.includes(HELPER_FLAG);

/**
 * The helper process. Takes the earlier name before Electron sets up safeStorage, reads
 * { items: [wrapped…] } from its input, and prints { values: [text or null…] } for its parent.
 */
export function runKeyHelper({ app, safeStorage, name = LEGACY_NAME, input = process.stdin, output = process.stdout, dir = process.env.BOTKINS_KEYS_DIR }) {
  app.setName(name);
  // Its own folder, so it never meets the running app's files or its single-instance lock.
  if (dir) app.setPath("userData", dir);
  app.dock?.hide();
  app.whenReady().then(async () => {
    let result;
    try {
      let text = "";
      for await (const chunk of input) text += chunk;
      const { items } = JSON.parse(text);
      if (!Array.isArray(items) || items.length > 20 || !safeStorage.isEncryptionAvailable()) throw new Error("Nothing to open.");
      result = {
        values: items.map((item) => {
          try {
            return safeStorage.decryptString(Buffer.from(String(item), "base64"));
          } catch {
            return null;
          }
        }),
      };
    } catch (error) {
      result = { error: String(error?.message ?? error) };
    }
    output.write("\n" + MARK + JSON.stringify(result) + "\n", () => app.exit(0));
  });
}

/**
 * Opens keys with the earlier keychain entry, in a helper process.
 * @param items  Wrapped keys.
 * @param start  { command, args }: how to start this app again (the helper flag is added).
 * @returns Map of wrapped → text, holding the ones that opened. Empty when the helper can't run
 *   or the person says no.
 */
export function openWithEarlierKeychain(items, { command = process.execPath, args = [], timeoutMs = 3 * 60_000, launch = spawn } = {}) {
  return new Promise((resolve) => {
    const opened = new Map();
    if (!items.length) return resolve(opened);
    const dir = mkdtempSync(join(tmpdir(), "botkins-keys-"));
    const env = { ...process.env, BOTKINS_KEYS_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    let out = "";
    let finished = false;
    let child;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      try {
        const line = out.split("\n").find((l) => l.startsWith(MARK));
        const { values } = JSON.parse(line.slice(MARK.length));
        items.forEach((item, index) => {
          if (typeof values?.[index] === "string") opened.set(item, values[index]);
        });
      } catch {
        // No answer: nothing opened.
      }
      resolve(opened);
    };
    // The person may take a while over the keychain's question; after that the app goes on without.
    // A helper waiting on that question doesn't answer a polite signal, so it is killed, and the
    // app doesn't wait to hear that it ended.
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {}
      finish();
    }, timeoutMs);
    try {
      child = launch(command, [...args, HELPER_FLAG], { stdio: ["pipe", "pipe", "ignore"], env });
      child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
      child.on("error", finish);
      child.on("close", finish);
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ items }));
    } catch {
      finish();
    }
  });
}

/**
 * The key store the vault and the phone link use: this app's keychain entry, and what the earlier
 * entry opened for this run (`opened`, from openWithEarlierKeychain).
 * @param own  { wrap(text) → wrapped, unwrap(wrapped) → text or null }
 */
export function keyStore(own, opened = new Map()) {
  return {
    wrap: own.wrap,
    // What the earlier entry opened wins: it was only asked about wrappings this app's entry
    // couldn't open into a key, and this app's entry may still turn one of those into junk.
    unwrap: (data) => opened.get(data) ?? own.unwrap(data) ?? null,
    /** True for a wrapping only the earlier keychain entry opens. The vault keeps such a wrapping as it is. */
    earlier: (data) => opened.has(data),
  };
}
