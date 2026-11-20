// The terminal host's key store (desktop/host/keystore.mjs): where the host key comes from, what
// it wraps, and that the vault and the phone link keep their keys under it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL, KEYCHAIN_SERVICE, keyFrom, keychainAccount, openKeyStore, sealer } from "../desktop/host/keystore.mjs";
import { headlessHost } from "../desktop/host/headless.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { Vault } from "../desktop/vault.mjs";
import { LinkStore } from "../desktop/link/store.mjs";

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-keys-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A stand-in for /usr/bin/security: a keychain in memory. Nothing here asks the real one. */
function fakeKeychain({ locked = false } = {}) {
  const items = new Map();
  const calls = [];
  const run = async (args, input) => {
    calls.push({ args, input });
    if (locked) return { ok: false, code: 36, out: "" };
    if (args[0] === "find-generic-password") {
      const key = args[args.indexOf("-s") + 1] + "/" + args[args.indexOf("-a") + 1];
      return items.has(key) ? { ok: true, out: items.get(key) + "\n" } : { ok: false, code: 44, out: "" };
    }
    if (args[0] === "-i") {
      const [, service, account, , secret] = /-s "([^"]+)" -a "([^"]+)" -D "([^"]+)" -w "([^"]+)"/.exec(input);
      items.set(service + "/" + account, secret);
      return { ok: true, out: "" };
    }
    return { ok: false, code: 1, out: "" };
  };
  return { run, items, calls };
}

test("a host key is 32 bytes, as they are, in base64 or in hex", () => {
  const key = randomBytes(32);
  assert.deepEqual(keyFrom(key), key);
  assert.deepEqual(keyFrom(key.toString("base64") + "\n"), key);
  assert.deepEqual(keyFrom(Buffer.from(key.toString("hex"))), key);
  for (const bad of ["", "short", randomBytes(31), randomBytes(33).toString("base64"), null]) assert.equal(keyFrom(bad), null);
  assert.throws(() => sealer(randomBytes(16)), /32 bytes/);
});

test("what is wrapped opens only with the same key, whole", () => {
  const seal = sealer(randomBytes(32));
  const wrapped = seal.wrap("the vault's key");
  assert.match(wrapped, /^bk1\./);
  assert.notEqual(seal.wrap("the vault's key"), wrapped, "each wrapping has its own nonce");
  assert.equal(seal.unwrap(wrapped), "the vault's key");
  assert.equal(sealer(randomBytes(32)).unwrap(wrapped), null);
  const bytes = Buffer.from(wrapped.slice(4), "base64");
  bytes[bytes.length - 1] ^= 1;
  assert.equal(seal.unwrap("bk1." + bytes.toString("base64")), null);
  for (const bad of ["", "bk1.", "bk1.AAAA", "plain", null, 5]) assert.equal(seal.unwrap(bad), null);
});

test("a plain serve keeps its key in a file only its user reads, and finds it again", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const first = await openKeyStore({ dataDir, env: {}, platform: "linux" });
  assert.equal(first.source, "file");
  assert.equal(first.where, "key file " + join(dataDir, "host.key"));
  assert.equal(statSync(join(dataDir, "host.key")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dataDir, "keystore.json")).mode & 0o777, 0o600);
  const wrapped = first.wrap("secret");
  const again = await openKeyStore({ dataDir, env: {}, platform: "linux" });
  assert.equal(again.unwrap(wrapped), "secret");
  // A key file named on purpose is used where it is, and may sit outside the data folder.
  const elsewhere = join(tempDir(t), "etc", "host.key");
  const other = await openKeyStore({ dataDir: join(tempDir(t), "data"), env: { BOTKINS_KEY_FILE: elsewhere }, platform: "darwin" });
  assert.equal(other.source, "file");
  assert.equal(existsSync(elsewhere), true);
  assert.equal(other.unwrap(wrapped), null);
});

test("a key that is not the folder's own is refused in one sentence, and never replaced", async (t) => {
  const dataDir = join(tempDir(t), "data");
  await openKeyStore({ dataDir, env: {}, platform: "linux" });
  const file = join(dataDir, "host.key");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, randomBytes(32).toString("base64") + "\n");
  await assert.rejects(openKeyStore({ dataDir, env: {}, platform: "linux" }), /is not the one this data folder's secrets were wrapped with/);
  rmSync(file);
  await assert.rejects(openKeyStore({ dataDir, env: {}, platform: "linux" }), /The key file .* is missing/);
  assert.equal(existsSync(file), false, "a missing key is never made anew over wrapped secrets");
  writeFileSync(file, "not a key\n");
  await assert.rejects(openKeyStore({ dataDir, env: {}, platform: "linux" }), /doesn't hold a 32-byte key/);
  writeFileSync(file, original);
  assert.equal((await openKeyStore({ dataDir, env: {}, platform: "linux" })).source, "file");
  await assert.rejects(openKeyStore({ dataDir, source: "tpm" }), /A key source is one of/);
});

test("under systemd the key is the unit's credential, and is never written to the data folder", async (t) => {
  const dir = tempDir(t);
  const dataDir = join(dir, "data");
  const credentials = join(dir, "credentials");
  mkdirSync(credentials);
  const key = randomBytes(32);
  writeFileSync(join(credentials, CREDENTIAL), key.toString("base64") + "\n", { mode: 0o400 });
  const env = { CREDENTIALS_DIRECTORY: credentials };
  const store = await openKeyStore({ dataDir, env, platform: "linux" });
  assert.equal(store.source, "systemd");
  assert.equal(store.where, "systemd credential");
  assert.equal(existsSync(join(dataDir, "host.key")), false);
  assert.equal(sealer(key).unwrap(store.wrap("secret")), "secret");
  assert.doesNotMatch(readFileSync(join(dataDir, "keystore.json"), "utf8"), new RegExp(key.toString("base64").slice(0, 20)));
  // Started by hand, outside the unit: the folder's key is not there, and no other key takes its place.
  await assert.rejects(openKeyStore({ dataDir, env: {}, platform: "linux" }), /The service's unit didn't hand over the host key/);
  assert.equal(existsSync(join(dataDir, "host.key")), false);
  // A credential of raw bytes works too (systemd-creds hands the key over as it was encrypted).
  rmSync(join(credentials, CREDENTIAL));
  writeFileSync(join(credentials, CREDENTIAL), key);
  assert.equal((await openKeyStore({ dataDir, env, platform: "linux" })).unwrap(store.wrap("again")), "again");
});

test("on macOS the key is a keychain entry of the data folder's own, written without showing it to a process list", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const keychain = fakeKeychain();
  const store = await openKeyStore({ dataDir, env: {}, platform: "darwin", run: keychain.run });
  assert.equal(store.source, "keychain");
  assert.match(store.where, /macOS keychain/);
  const account = keychainAccount(dataDir);
  assert.match(account, /^host-key-[0-9a-f]{16}$/);
  const secret = keychain.items.get(KEYCHAIN_SERVICE + "/" + account);
  assert.ok(keyFrom(secret));
  for (const call of keychain.calls) assert.ok(!call.args.join(" ").includes(secret), "the key is never an argument");
  assert.equal(existsSync(join(dataDir, "host.key")), false);
  const wrapped = store.wrap("secret");
  assert.equal((await openKeyStore({ dataDir, env: {}, platform: "darwin", run: keychain.run })).unwrap(wrapped), "secret");
  // Another data folder has another entry.
  assert.notEqual(keychainAccount(join(tempDir(t), "data")), account);
  // The entry is gone, or the keychain is locked: said so, and no new key is made over the wrapped secrets.
  keychain.items.clear();
  await assert.rejects(openKeyStore({ dataDir, env: {}, platform: "darwin", run: keychain.run }), /The host key is missing from the keychain/);
  assert.equal(keychain.items.size, 0);
  await assert.rejects(openKeyStore({ dataDir: join(tempDir(t), "data"), env: {}, platform: "darwin", run: fakeKeychain({ locked: true }).run }), /The keychain didn't answer/);
  await assert.rejects(openKeyStore({ dataDir: join(tempDir(t), "data"), source: "keychain", env: {}, platform: "linux" }), /macOS key source/);
});

test("the vault and the phone link keep their keys under the host key, and stay shut without it", async (t) => {
  const dir = tempDir(t);
  const dataDir = join(dir, "data");
  const keyFile = join(dir, "etc", "host.key");
  const keys = () => openKeyStore({ dataDir, keyFile, env: {}, platform: "linux" });
  const before = process.env.BOTKINS_PROVIDERS;
  process.env.BOTKINS_PROVIDERS = "grok";
  t.after(() => (before === undefined ? delete process.env.BOTKINS_PROVIDERS : (process.env.BOTKINS_PROVIDERS = before)));
  const start = () => createRuntime({ host: headlessHost({ version: "1.0.0", keys }), dataDir, link: { port: 0, announce: false } });
  let runtime = await start();
  const ref = runtime.workspace.vault.put("sk-live-1234567890", { label: "Key", kind: "secret", owner: "test" });
  const serverId = runtime.link.status().serverId;
  await runtime.stop();
  // On disk: both keys wrapped, no key file beside them, and the secret nowhere in the clear.
  const vault = JSON.parse(readFileSync(join(dataDir, "vault.json"), "utf8"));
  assert.equal(vault.key.by, "os");
  assert.match(vault.key.data, /^bk1\./);
  assert.equal(existsSync(join(dataDir, "vault.key")), false);
  const link = JSON.parse(readFileSync(join(dataDir, "link", "link.json"), "utf8"));
  assert.equal(link.wrapped, true);
  assert.match(link.privateKey, /^bk1\./);
  for (const file of ["vault.json", "link/link.json", "workspace.json", "keystore.json"]) assert.doesNotMatch(readFileSync(join(dataDir, file), "utf8"), /sk-live-1234567890/);
  // The same key opens them again.
  runtime = await start();
  assert.equal(runtime.workspace.vault.get(ref), "sk-live-1234567890");
  assert.equal(runtime.link.status().serverId, serverId);
  await runtime.stop();
  // A copy of the data folder alone, on another computer: nothing opens, and nothing is overwritten.
  const stolen = sealer(randomBytes(32));
  const copy = new Vault(dataDir, stolen);
  assert.equal(copy.locked, true);
  assert.equal(copy.get(ref), null);
  assert.equal(new LinkStore(join(dataDir, "link"), { protect: stolen.wrap, reveal: (data) => stolen.unwrap(data) ?? (() => { throw new Error("locked"); })() }).data.locked, "locked");
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "vault.json"), "utf8")), vault);
});
