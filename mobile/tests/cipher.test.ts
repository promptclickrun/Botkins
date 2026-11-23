// The computer's end seals with ChaCha20-Poly1305 from one of two places: Node's own crypto, or
// @noble/ciphers where the runtime has none (Electron, which is where the desktop app runs
// link-host/crypto.mjs). Both have to produce the same bytes, or a phone can't pair with the app.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CIPHER, open, seal } from "../link-host/crypto.mjs";
import { open as phoneOpen, seal as phoneSeal } from "../src/link/crypto";

const module = fileURLToPath(new URL("../link-host/crypto.mjs", import.meta.url));
// A second process loads the same file with the library chosen, seals what it is handed and opens what this one sealed.
const SCRIPT = `
  const { CIPHER, seal, open } = await import(process.argv[1]);
  const cases = JSON.parse(await new Promise((done) => { let text = ""; process.stdin.on("data", (d) => (text += d)).on("end", () => done(text)); }));
  const hex = (b) => Buffer.from(b).toString("hex");
  const out = cases.map((c) => {
    const [key, nonce, plain, sealed] = [c.key, c.nonce, c.plain, c.sealed].map((h) => Buffer.from(h, "hex"));
    let opened = null, wrongAad = "refused", wrongTag = "refused";
    try { opened = hex(open(key, nonce, sealed, c.aad)); } catch {}
    try { open(key, nonce, sealed, c.aad + "x"); wrongAad = "accepted"; } catch {}
    try { const bad = Buffer.from(sealed); bad[bad.length - 1] ^= 1; open(key, nonce, bad, c.aad); wrongTag = "accepted"; } catch {}
    return { sealed: hex(seal(key, nonce, plain, c.aad)), opened, wrongAad, wrongTag };
  });
  console.log(JSON.stringify({ CIPHER, out }));
`;

test("Node's cipher and the library seal the same bytes and open each other's", () => {
  assert.equal(CIPHER, process.env.BOTKINS_LINK_CIPHER === "noble" ? "noble" : "node");
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
  // Every length around the cipher's 64-byte blocks and the tag's 16-byte ones, then some large ones.
  const sizes = [...Array(131).keys(), 255, 256, 257, 1023, 4096, 65_537, 300_000];
  const cases = sizes.map((size, index) => {
    const [key, nonce, plain] = [randomBytes(32), randomBytes(12), randomBytes(size)];
    const aad = ["", "pair:abc", "rpc:" + "s".repeat(index % 40), "ok:é✓"][index % 4];
    return { key: hex(key), nonce: hex(nonce), plain: hex(plain), aad, sealed: hex(seal(key, nonce, plain, aad)) };
  });
  const reply = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", SCRIPT, module], { input: JSON.stringify(cases), env: { ...process.env, BOTKINS_LINK_CIPHER: "noble" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  );
  assert.equal(reply.CIPHER, "noble");
  cases.forEach((c, index) => {
    const theirs = reply.out[index];
    assert.equal(theirs.sealed, c.sealed, "sealed differently at " + sizes[index] + " bytes");
    assert.equal(theirs.opened, c.plain, "did not open at " + sizes[index] + " bytes");
    assert.equal(theirs.wrongAad, "refused");
    assert.equal(theirs.wrongTag, "refused");
    // The phone's own code agrees with both.
    const [key, nonce, plain] = [c.key, c.nonce, c.plain].map((text) => Buffer.from(text, "hex"));
    assert.equal(hex(phoneSeal(key, nonce, plain, c.aad)), c.sealed);
    assert.equal(hex(phoneOpen(key, nonce, Buffer.from(theirs.sealed, "hex"), c.aad)), c.plain);
    assert.equal(hex(open(key, nonce, Buffer.from(theirs.sealed, "hex"), c.aad)), c.plain);
  });
});

test("host and phone encode the session push counter outside the entire RPC nonce domain", async () => {
  const host = await import("../link-host/crypto.mjs");
  const phone = await import("../src/link/crypto");
  for (const n of [1, 255, 256, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
    const push = host.pushNonce(n);
    assert.deepEqual(push, Buffer.from(phone.pushNonce(n)));
    assert.equal(push.readUInt32BE(0), 0x01000000);
    assert.equal(push.readBigUInt64BE(4), BigInt(n));
    assert.equal(host.seqNonce(n).readUInt32BE(0), 0);
    assert.deepEqual(host.seqNonce(n), Buffer.from(phone.seqNonce(n)));
  }
});
