// The phone link on Electron's runtime. The app runs desktop/link/ on Electron, whose Node has no
// "chacha20-poly1305" cipher, so the link seals with @noble/ciphers there. Plain Node (where the other
// link tests run) never takes that path, and pairing with a phone failed in the real app while every
// test passed. Here the host runs on Electron (test/fixtures/link-electron-host.mjs) and this process,
// plain Node with the cipher of its own, plays the phone over the real protocol on 127.0.0.1.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agree, b64u, box, CIPHER, cleanCode, hkdf, INFO, newKeyPair, open, random, seal, seqNonce, unb64u, unbox } from "../desktop/link/crypto.mjs";

const electron = createRequire(import.meta.url)("electron");
const fixture = fileURLToPath(new URL("./fixtures/link-electron-host.mjs", import.meta.url));

/** Starts the link on Electron's Node and returns what it printed. Closing `stdin` stops it. */
async function startHost(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-link-electron-"));
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.BOTKINS_LINK_CIPHER; // the host must choose its cipher by what its runtime has
  const child = spawn(electron, [fixture, dir], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(child, "exit");
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 10_000);
    await exited;
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  });
  const line = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("The host on Electron printed nothing in 30 seconds. " + stderr)), 30_000);
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) (clearTimeout(timer), resolve(text.split("\n")[0]));
    });
    child.once("exit", (code) => (clearTimeout(timer), reject(new Error("The host on Electron exited (" + code + ") before it was ready. " + stderr))));
  });
  return JSON.parse(line);
}

test("a phone on Node's cipher pairs with and calls a host that seals with noble on Electron", async (t) => {
  const host = await startHost(t);
  // The host really is on Electron, without the cipher of its own.
  assert.ok(host.electron, "the host did not run on Electron");
  assert.equal(host.cipher, "noble");
  // This side is plain Node, so the two ends use two different ChaCha20-Poly1305 implementations.
  assert.equal(CIPHER, "node", "the test's own process must use Node's cipher");

  const base = "http://127.0.0.1:" + host.port + "/botkins/v1/";
  const post = (route, body, headers = {}) => fetch(base + route, { method: "POST", headers: { "content-type": "application/octet-stream", ...headers }, body });

  const hello = await (await fetch(base + "hello")).json();
  assert.equal(hello.serverId, host.serverId);
  assert.equal(hello.publicKey, host.publicKey);
  assert.equal(hello.pairing, true);

  const serverPublic = unb64u(host.publicKey);
  const mine = newKeyPair();
  const secret = agree(mine, serverPublic);
  const pairKey = (code) => hkdf(secret, Buffer.from(cleanCode(code)), INFO.pair);
  const pairBody = (code) => JSON.stringify({ publicKey: b64u(mine.publicKey), box: box(pairKey(code), { name: "Test phone", platform: "ios" }, "pair:" + host.serverId) });

  // A wrong code is turned away (the code survives a few wrong tries) …
  const wrong = await post("pair", pairBody((host.code[0] === "A" ? "B" : "A") + host.code.slice(1)));
  assert.equal(wrong.status, 403);
  assert.deepEqual(await wrong.json(), { error: "pair_failed" });

  // … and the right one pairs: Electron opens what Node sealed, and Node opens the answer.
  const paired = await post("pair", pairBody(host.code));
  assert.equal(paired.status, 200);
  const answer = unbox(pairKey(host.code), (await paired.json()).box, "paired:" + host.serverId);
  assert.equal(answer.serverId, host.serverId);
  assert.equal(typeof answer.device, "string");
  assert.equal(typeof answer.name, "string");
  assert.ok(Array.isArray(answer.hosts));

  // A session: a fresh key exchange mixed into the device key, then keys for each direction.
  const deviceKey = hkdf(secret, Buffer.from(answer.device), INFO.device);
  const eph = newKeyPair();
  const nonce = random(16);
  const opened = await post("session", JSON.stringify({ device: answer.device, eph: b64u(eph.publicKey), box: box(deviceKey, { eph: b64u(eph.publicKey), nonce: b64u(nonce) }, "session:" + host.serverId) }));
  assert.equal(opened.status, 200);
  const ok = unbox(deviceKey, (await opened.json()).box, "session-ok:" + host.serverId);
  const salt = Buffer.concat([nonce, unb64u(ok.nonce)]);
  const master = hkdf(Buffer.concat([agree(eph, unb64u(ok.eph)), deviceKey]), salt, "botkins/session/v1");
  const toHost = hkdf(master, salt, INFO.toHost);
  const toPhone = hkdf(master, salt, INFO.toPhone);

  // One sealed call: the number in front, then the message sealed under that number.
  const seq = Buffer.alloc(8);
  seq.writeBigUInt64BE(1n);
  const sealed = seal(toHost, seqNonce(1), Buffer.from(JSON.stringify({ m: "link.sync", a: [{}] }), "utf8"), "rpc:" + ok.session);
  const reply = await post("rpc", Buffer.concat([seq, sealed]), { "x-botkins-session": ok.session });
  assert.equal(reply.status, 200);
  const text = open(toPhone, seqNonce(1), Buffer.from(await reply.arrayBuffer()), "ok:" + ok.session).toString("utf8");
  const result = JSON.parse(text);
  assert.ok("r" in result, text);
  assert.equal(typeof result.r, "object");
});
