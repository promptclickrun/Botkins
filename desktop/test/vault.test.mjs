// The credential vault (desktop/vault.mjs): secrets encrypted at rest, listed without their values.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Vault, isRef } from "../desktop/vault.mjs";
import { tempDir } from "./fake-copilot.mjs";

test("a secret goes in and comes out, and the file never holds it as text", (t) => {
  const dir = tempDir(t);
  const vault = new Vault(dir);
  const ref = vault.put("s3cret-value-äö", { label: "tickets · API_KEY", kind: "environment", owner: "mcp:1" });
  assert.ok(isRef(ref) && /^vault:[0-9a-f-]{36}$/.test(ref));
  assert.equal(vault.get(ref), "s3cret-value-äö");
  assert.equal(vault.has(ref), true);
  const text = readFileSync(join(dir, "vault.json"), "utf8");
  assert.doesNotMatch(text, /s3cret/);
  assert.equal(statSync(join(dir, "vault.json")).mode & 0o777, 0o600);
  // The list shows what each entry is, never its value.
  const [entry] = vault.list();
  assert.deepEqual(Object.keys(entry).sort(), ["createdAt", "id", "kind", "label", "owner", "updatedAt"]);
  assert.deepEqual([entry.label, entry.kind, entry.owner], ["tickets · API_KEY", "environment", "mcp:1"]);
  // The same secret stored twice doesn't look the same on disk.
  const again = vault.put("s3cret-value-äö", { label: "b", owner: "mcp:1" });
  const saved = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8")).entries;
  assert.notEqual(saved[ref.slice(6)].data, saved[again.slice(6)].data);
  // Replacing keeps the entry and its creation time.
  const before = vault.list().find((e) => e.id === ref.slice(6));
  assert.equal(vault.put("new-value", {}, ref), ref);
  assert.equal(vault.get(ref), "new-value");
  assert.equal(vault.list().find((e) => e.id === ref.slice(6)).createdAt, before.createdAt);
  // A restart reads it back; removing is final.
  assert.equal(new Vault(dir).get(ref), "new-value");
  assert.equal(vault.remove(ref), true);
  assert.equal(vault.get(ref), null);
  assert.equal(vault.remove(ref), false);
  for (const bad of ["", 7, null, "x".repeat(64001)]) assert.throws(() => vault.put(bad, {}), /Invalid secret/);
  assert.equal(vault.get("vault:../../etc/passwd"), null);
  assert.equal(vault.get("not-a-ref"), null);
});

test("a failed removal keeps the encrypted entry in memory and on disk", (t) => {
  const dir = tempDir(t);
  const vault = new Vault(dir);
  const ref = vault.put("fixture-token", {});
  t.mock.method(vault, "save", () => { throw new Error("Storage unavailable"); });
  assert.throws(() => vault.remove(ref), /Storage unavailable/);
  assert.equal(vault.get(ref), "fixture-token");
  assert.equal(new Vault(dir).get(ref), "fixture-token");
});

test("one entry's ciphertext can't stand in for another's, and a changed one doesn't open", (t) => {
  const dir = tempDir(t);
  const vault = new Vault(dir);
  const a = vault.put("alpha", { label: "a" });
  const b = vault.put("bravo", { label: "b" });
  const saved = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8"));
  const [ia, ib] = [a.slice(6), b.slice(6)];
  [saved.entries[ia], saved.entries[ib]] = [saved.entries[ib], saved.entries[ia]];
  writeFileSync(join(dir, "vault.json"), JSON.stringify(saved));
  const swapped = new Vault(dir);
  assert.equal(swapped.get(a), null, "b's ciphertext under a's id is refused");
  assert.equal(swapped.get(b), null);
  // Back in place they open; with one byte changed they don't.
  [saved.entries[ia], saved.entries[ib]] = [saved.entries[ib], saved.entries[ia]];
  const data = Buffer.from(saved.entries[ia].data, "base64");
  data[0] ^= 1;
  saved.entries[ia].data = data.toString("base64");
  writeFileSync(join(dir, "vault.json"), JSON.stringify(saved));
  const tampered = new Vault(dir);
  assert.equal(tampered.get(a), null);
  assert.equal(tampered.get(b), "bravo");
});

test("the vault key is wrapped by the system's secret storage when there is one", (t) => {
  const dir = tempDir(t);
  const calls = [];
  const keychain = {
    wrap: (text) => (calls.push("wrap"), "wrapped:" + [...text].reverse().join("")),
    unwrap: (data) => (calls.push("unwrap"), [...data.slice(8)].reverse().join("")),
  };
  const vault = new Vault(dir, keychain);
  const ref = vault.put("token", { label: "x" });
  assert.equal(vault.protection, "keychain");
  const saved = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8"));
  assert.equal(saved.key.by, "os");
  assert.ok(saved.key.data.startsWith("wrapped:"));
  assert.equal(new Vault(dir, keychain).get(ref), "token");
  // With a keychain that doesn't give the key (another computer, a reset), the vault is locked:
  // nothing is read, written or removed, and the file stays byte for byte.
  const before = readFileSync(join(dir, "vault.json"), "utf8");
  const other = new Vault(dir, { wrap: keychain.wrap, unwrap: () => null });
  assert.deepEqual([other.locked, other.reason], [true, "key"]);
  assert.equal(other.get(ref), null);
  assert.equal(other.list().length, 1, "what it holds is still listed");
  assert.throws(() => other.put("x", { label: "y" }), /can't open its credential vault/);
  assert.equal(other.remove(ref), false);
  assert.equal(other.prune("", new Set()), 0);
  assert.equal(readFileSync(join(dir, "vault.json"), "utf8"), before);
  // The same goes for a development run (no keychain) on the installed app's vault, and for a damaged file.
  const dev = new Vault(dir);
  assert.deepEqual([dev.locked, dev.reason], [true, "installed-app"]);
  assert.throws(() => dev.put("x", {}), /belongs to the installed app/);
  assert.equal(readFileSync(join(dir, "vault.json"), "utf8"), before);
  assert.equal(new Vault(dir, keychain).get(ref), "token", "with the key back it opens again");
  const damaged = tempDir(t);
  writeFileSync(join(damaged, "vault.json"), "{ not json");
  const broken = new Vault(damaged, keychain);
  assert.deepEqual([broken.locked, broken.reason], [true, "damaged"]);
  assert.equal(readFileSync(join(damaged, "vault.json"), "utf8"), "{ not json");
  // Resetting is the person's choice: the old file is kept under another name and a new vault starts.
  assert.equal(broken.reset(), true);
  assert.equal(broken.locked, false);
  assert.ok(readdirSync(damaged).some((name) => /^vault\.unreadable-\d+\.json$/.test(name)));
  assert.equal(broken.get(broken.put("fresh", { label: "f" })), "fresh");
  assert.equal(broken.reset(), false, "a vault that opens isn't reset");
  // A keychain that fails while the first vault is made doesn't stop the app: the vault is just unavailable.
  const original = console.error;
  console.error = () => {};
  t.after(() => (console.error = original));
  const failing = new Vault(tempDir(t), { wrap: () => { throw new Error("keychain is locked"); }, unwrap: () => null });
  assert.equal(failing.locked, true);
  // A vault a development run made is taken over by the installed app: its key moves into the keychain.
  const plain = tempDir(t);
  const fileVault = new Vault(plain);
  const kept = fileVault.put("dev", { label: "d" });
  assert.equal(fileVault.protection, "file");
  const adopted = new Vault(plain, keychain);
  assert.equal(adopted.get(kept), "dev");
  assert.equal(JSON.parse(readFileSync(join(plain, "vault.json"), "utf8")).key.by, "os");
  assert.ok(!existsSync(join(plain, "vault.key")), "the key file is gone once the keychain holds the key");
});

test("entries of an owner that are no longer referenced are pruned", (t) => {
  const vault = new Vault(tempDir(t));
  const keep = vault.put("one", { label: "keep", owner: "mcp:1" });
  vault.put("two", { label: "drop", owner: "mcp:1" });
  const other = vault.put("three", { label: "other", owner: "mcp:2" });
  assert.equal(vault.prune("mcp:1", new Set([keep])), 1);
  assert.deepEqual(vault.list().map((e) => e.label), ["keep", "other"]);
  assert.equal(vault.get(other), "three");
});
