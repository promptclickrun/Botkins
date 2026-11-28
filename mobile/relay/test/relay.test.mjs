// Runs the relay for real: starts `wrangler dev` on this machine (local only, no account, no network
// to Cloudflare), talks to it with Node's own WebSocket and `http`, and always stops it afterwards.
// The wire format is in ../../tests/fake-relay.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import ResettableSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HOST = "botkins.host.v2";
const HOST_V3 = "botkins.host.v3";
const PHONE = "botkins.phone.v1";
const MiB = 1024 * 1024;
const MAX_PHONE = 6 * MiB + 64 * 1024; // a phone's largest message
const MAX_INVITE_LIFE = 30 * 24 * 60 * 60 * 1000;
const SPACE_BYTES_MAX = 12 * MiB;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---- wrangler dev ----------------------------------------------------------------------------

let child = null;
let output = "";
let base = ""; // http://127.0.0.1:port
let wsBase = ""; // ws://127.0.0.1:port
let stateDir = "";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stopDev() {
  if (child && child.exitCode === null && child.pid) {
    // wrangler starts workerd as a child: stop the whole group.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = "";
}
process.on("exit", stopDev);

// RELAY_TARGET=node runs this same suite against the self-hosted relay (../node/server.mjs).
const NODE_RELAY = process.env.RELAY_TARGET === "node";

async function startDev() {
  const port = await freePort();
  stateDir = mkdtempSync(path.join(tmpdir(), "botkins-relay-"));
  // No Cloudflare credentials reach the child, and nothing is sent to anyone.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLOUDFLARE_")));
  Object.assign(env, { WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" });
  const args = NODE_RELAY
    ? [path.join(root, "node/server.mjs")]
    : [
      path.join(root, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--local",
      "--ip=127.0.0.1",
      `--port=${port}`,
      "--inspector-port=0",
      `--persist-to=${stateDir}`,
      "--show-interactive-dev-session=false",
      // Every socket of a test run comes from one address, so the per-network limits are off here.
      "--var=RATE_LIMITS:off",
      // All copies of shared spaces together: 12 MiB here, so a test can fill it.
      `--var=SPACE_BYTES_MAX:${SPACE_BYTES_MAX}`,
    ];
  // The Node relay trusts the address header only when told to, as it does behind its proxy.
  if (NODE_RELAY) Object.assign(env, { PORT: String(port), HOST: "127.0.0.1", RATE_LIMITS: "off", CLIENT_IP_HEADER: "cf-connecting-ip", DATA_DIR: stateDir, PUSH_UPSTREAM: "off", SPACE_BYTES_MAX: String(SPACE_BYTES_MAX) });
  child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The relay stopped early:\n" + output);
    try {
      const response = await fetch(base + "/v1/health");
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("The relay did not answer in time:\n" + output);
}

// ---- helpers ---------------------------------------------------------------------------------

const roomOf = (publicKey) => createHash("sha256").update("botkins-relay-room-v1:" + publicKey).digest("base64url");
/** Everything the relay must never log: lookups, cards, keys, rooms, signatures, and conn/from bytes. */
const secrets = new Set();
/** A computer's identity: an Ed25519 key pair and the room its public key gives. */
const newRoom = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "jwk" }).x; // the raw 32 bytes, base64url
  const room = roomOf(key);
  secrets.add(key).add(room);
  return { key, room, privateKey };
};
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** The subprotocols a computer offers. Options change one part, to make a bad offer. */
function proof(r, { seconds = nowSeconds(), signedRoom = r.room, signer = r.privateKey, key = r.key } = {}) {
  const signature = sign(null, Buffer.from(`botkins-relay-host-v2:${signedRoom}:${seconds}`), signer).toString("base64url");
  secrets.add(signature);
  return [HOST, "k." + key, "t." + seconds, "s." + signature];
}

const newLookup = () => {
  const lookup = randomBytes(32).toString("base64url");
  secrets.add(lookup);
  return lookup;
};
const newInviteCard = () => randomBytes(48).toString("base64url");

/** The headers a host signs when it publishes or deletes an invite card. */
function inviteProof(r, lookup, { card, expiresAt, seconds = nowSeconds(), signer = r.privateKey, signedCard = card, signedExpiresAt = expiresAt, action = "put" } = {}) {
  const message =
    action === "put"
      ? `botkins-relay-invite-v1:${r.room}:${lookup}:${signedExpiresAt}:${createHash("sha256").update(signedCard).digest("base64url")}:${seconds}`
      : `botkins-relay-invite-del-v1:${r.room}:${lookup}:${seconds}`;
  const signature = sign(null, Buffer.from(message), signer).toString("base64url");
  secrets.add(lookup);
  if (card) secrets.add(card);
  secrets.add(signature);
  return { "x-botkins-key": r.key, "x-botkins-time": String(seconds), "x-botkins-sig": signature };
}

// ---- spaces shared by link ---------------------------------------------------------------------

const MAX_SPACE_LIFE = 7 * 24 * 60 * 60 * 1000;
/** A link's id belongs to the computer's key and a salt. */
const shareIdOf = (key, salt) => createHash("sha256").update("botkins-space-id-v1:" + key + ":" + salt).digest().subarray(0, 16).toString("base64url");
const newShare = (r) => {
  const salt = randomBytes(16).toString("base64url");
  const id = shareIdOf(r.key, salt);
  secrets.add(id).add(salt);
  return { id, salt };
};
/** A sealed copy as the relay sees it: bytes it cannot read. */
const sealedCopy = (size = 300) => randomBytes(size);
/** The headers a computer signs when it puts out or takes back a space's copy. */
function spaceProof(r, share, { body, expiresAt, seconds = nowSeconds(), signer = r.privateKey, salt = share.salt, signedBody = body, signedExpiresAt = expiresAt, action = "put" } = {}) {
  const message =
    action === "put"
      ? `botkins-relay-space-v1:${r.room}:${share.id}:${signedExpiresAt}:${createHash("sha256").update(signedBody).digest("base64url")}:${seconds}`
      : `botkins-relay-space-del-v1:${r.room}:${share.id}:${seconds}`;
  const signature = sign(null, Buffer.from(message), signer).toString("base64url");
  secrets.add(signature);
  return { "x-botkins-key": r.key, "x-botkins-time": String(seconds), "x-botkins-sig": signature, "x-botkins-salt": salt, ...(action === "put" && { "x-botkins-expires": String(expiresAt) }) };
}
const putSpace = (r, share, body, options = {}) => {
  const expiresAt = options.expiresAt ?? Date.now() + 60 * 60 * 1000;
  return fetch(base + `/v1/spaces/${share.id}`, { method: "PUT", headers: spaceProof(r, share, { ...options, body, expiresAt }), body });
};
const deleteSpace = (r, share, options = {}) => fetch(base + `/v1/spaces/${share.id}`, { method: "DELETE", headers: spaceProof(r, share, { ...options, action: "delete" }) });
const readSpace = (share) => fetch(base + `/v1/spaces/${share.id}`);

const putInvite = (r, lookup, body, options) =>
  fetch(base + `/v1/invites/${lookup}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...inviteProof(r, lookup, { ...body, ...options }) },
    body: JSON.stringify(body),
  });
const deleteInvite = (r, lookup, options) =>
  fetch(base + `/v1/invites/${lookup}`, {
    method: "DELETE",
    headers: inviteProof(r, lookup, { ...options, action: "delete" }),
  });
const bytes = (...parts) => Buffer.concat(parts.map((part) => (typeof part === "number" ? Buffer.from([part]) : Buffer.from(part))));
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** A phone request: [0x01][id u32][route u8][n u8][session][body]. */
const request = (id, body = "", route = 4) => bytes(0x01, u32(id), route, 0, Buffer.from(body));

/** A socket with a queue of what it received, so tests can await the next message. */
class Client {
  constructor(url, protocols, address) {
    this.queue = [];
    this.waiting = [];
    this.closeInfo = null;
    this.closeWaiters = [];
    this.opened = new Promise((resolve, reject) => {
      // A local client can name its own address: wrangler dev passes CF-Connecting-IP through.
      this.ws = address ? new WebSocket(url, { protocols, headers: { "CF-Connecting-IP": address } }) : protocols[0] === HOST_V3 ? new ResettableSocket(url, protocols) : new WebSocket(url, protocols);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => {
        if (this.ws._receiver) this.ws._receiver.once("conclude", (code, reason) => {
          this.closeInfo = { code, reason: reason.toString() };
          for (const waiter of this.closeWaiters) waiter(this.closeInfo);
        });
        resolve(this);
      };
      this.ws.onerror = () => reject(new Error("The socket did not open"));
      this.ws.onclose = (event) => {
        this.closeInfo = { code: event.code, reason: event.reason };
        for (const waiter of this.closeWaiters) waiter(this.closeInfo);
        reject(new Error("The socket closed before it opened"));
      };
    });
    this.opened.catch(() => {});
    this.ws.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data);
      if (typeof data !== "string" && data.length >= 16) secrets.add(data.subarray(0, 8).toString("hex")).add(data.subarray(8, 16).toString("hex"));
      const waiter = this.waiting.shift();
      if (waiter) waiter(data);
      else this.queue.push(data);
    };
  }
  get protocol() {
    return this.ws.protocol;
  }
  send(data) {
    this.ws.send(data);
  }
  next(ms = 5000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No message arrived")), ms);
      this.waiting.push((data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }
  /** Passes when nothing arrives for `ms`. */
  async silent(ms = 400) {
    await sleep(ms);
    assert.equal(this.queue.length, 0, "A message arrived that should not have");
  }
  /**
   * Resolves with the close code. When the relay closes a socket from another socket's event (a replaced
   * computer, a 49th phone), workerd sends the Close frame at once but leaves the TCP connection open, and
   * Node's WebSocket reports the close only after its own 10 second timeout. So these waits are long.
   */
  closed(ms = 15_000) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The socket did not close")), ms);
      this.closeWaiters.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

const open = []; // every client of the run, closed at the end
async function connect(url, protocols, address) {
  const client = new Client(url, protocols, address);
  open.push(client);
  await client.opened;
  return client;
}
const host = (r, options) => connect(`${wsBase}/v1/host/${r.room}`, proof(r, options));
function proofV3(r, group, { seconds = nowSeconds(), signedRoom = r.room, signer = r.privateKey, key = r.key } = {}) {
  const signature = sign(null, Buffer.from(`botkins-relay-host-v3:${signedRoom}:${group}:${seconds}`), signer).toString("base64url");
  secrets.add(signature);
  return [HOST_V3, "k." + key, "g." + group, "t." + seconds, "s." + signature];
}
const hostV3 = (r, group, options) => connect(`${wsBase}/v1/host/${r.room}`, proofV3(r, group, options));
const phone = (r, address) => connect(`${wsBase}/v1/room/${r.room}`, [PHONE], address);

/** Resolves when a socket that must be refused fails to open, and fails if it ever opens. */
async function refused(url, protocols) {
  const client = new Client(url, protocols);
  open.push(client);
  await assert.rejects(client.opened);
  assert.notEqual(client.ws.readyState, 1);
}

/** A raw upgrade request, to see the status line and headers a WebSocket client hides. */
function rawGet(pathname, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, headers: res.headers, body: "" });
    });
    req.on("error", reject);
    req.end();
  });
}
const upgrade = (protocols) => ({
  Connection: "Upgrade",
  Upgrade: "websocket",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
  ...(protocols ? { "Sec-WebSocket-Protocol": protocols } : {}),
});

// ---- tests -----------------------------------------------------------------------------------

describe(NODE_RELAY ? "relay (node)" : "relay (wrangler dev)", { timeout: 300_000 }, () => {
  before(startDev, { timeout: 120_000 });
  after(async () => {
    for (const client of open) client.close();
    await sleep(200);
    stopDev();
  });

  it("leaves a host-only room asleep and immediately reports a long-silent host offline", { timeout: 70_000 }, async () => {
    const room = newRoom();
    await hostV3(room, randomBytes(32).toString("base64url"));
    // Allow the bounded opening probes to finish. Run first so other rooms cannot add wake logs.
    await sleep(30_000);
    const wakes = (output.match(/"event":"wake"/g) ?? []).length;
    await sleep(27_000); // Beyond the 40-second legacy silence limit plus 15 seconds of recovery.
    if (!NODE_RELAY) assert.equal((output.match(/"event":"wake"/g) ?? []).length, wakes);
    const client = await phone(room);
    client.send(request(1));
    assert.deepEqual(await client.next(), bytes(0x05));
    assert.deepEqual(await client.next(), bytes(0x03, u32(1)));
  });

  it("schedules no recurring liveness alarm for an idle host+phone room and still reaps a silent host on phone send", { timeout: 70_000 }, async () => {
    const room = newRoom();
    const group = randomBytes(32).toString("base64url");
    const h = await hostV3(room, group);
    const p = await phone(room);
    // Establish fast heartbeat via two nearby auto-response pings sampled during the opening probes.
    h.send("ping");
    assert.equal(await h.next(), "pong");
    await sleep(8_000);
    h.send("ping");
    assert.equal(await h.next(), "pong");
    await sleep(8_000); // Second opening probe at +14s records heartbeat="fast" and clears alarms.

    // Keep the room idle with only auto-response pings for >20s (past V3_FAST_SILENCE=15s).
    // Before the fix, scheduleAlarm() re-armed a liveness alarm every ~10-15s forever.
    const wakesBeforeIdle = (output.match(/"event":"wake"/g) ?? []).length;
    for (let i = 0; i < 4; i++) {
      await sleep(5_000);
      h.send("ping");
      assert.equal(await h.next(), "pong");
    }
    if (!NODE_RELAY) assert.equal((output.match(/"event":"wake"/g) ?? []).length, wakesBeforeIdle, "no recurring liveness alarm wakes while idle with phone connected");

    // Stop pinging past V3_FAST_SILENCE (15s). A phone request must still reap the silent host
    // and enter recovery, then deliver [0x05] when the recovery window expires.
    await sleep(16_000);
    p.send(request(88, "after-silent-host"));
    assert.deepEqual(await p.next(20_000), bytes(0x05));
    p.send(request(89, "after-recovery-expired"));
    assert.deepEqual(await p.next(), bytes(0x03, u32(89)));
    assert.equal((await h.closed()).code, 4001);
  });

  it("does not re-drop a lingering server-closed host socket across hibernation or reseats", { timeout: 90_000 }, async () => {
    const room = newRoom();
    const group = randomBytes(32).toString("base64url");
    const nextGroup = randomBytes(32).toString("base64url");
    const h1 = await hostV3(room, group);
    const h2 = await hostV3(room, group);
    // Freeze h1 so it never acknowledges the server's 4001 close frame, leaving it attached in CLOSING.
    h1.ws._socket.pause();
    h1.ws._socket.removeAllListeners("data");
    try {
      const dropsBefore = (output.match(/"event":"drop"/g) ?? []).length;
      const h3 = await hostV3(room, group);
      // Let child stdout flush before inspecting logged drop counts.
      await sleep(100);
      assert.equal((output.match(/"event":"drop"/g) ?? []).length - dropsBefore, 1, "initial reseat drops h1 once");

      // Establish fast heartbeat on h2 and h3 so opening probes finish by +14s, then hibernate.
      h2.send("ping");
      h3.send("ping");
      await sleep(8_000);
      h2.send("ping");
      h3.send("ping");
      await sleep(20_000); // Past opening probes + hibernation window (~10s).

      // A fourth same-group socket must evict h2 (the oldest live socket), NOT re-drop h1,
      // and must keep the room bounded to two live sockets (h3 + h4) plus the lingering h1.
      const wakesBeforeReseat = (output.match(/"event":"wake"/g) ?? []).length;
      const h4 = await hostV3(room, group);
      await sleep(100);
      if (!NODE_RELAY) assert.ok((output.match(/"event":"wake"/g) ?? []).length > wakesBeforeReseat, "room hibernated even with a lingering closing socket");
      assert.equal((await h2.closed()).code, 4001, "reseat evicts live h2 instead of re-dropping closing h1");

      // A new group takeover must only drop the two live seats (h3, h4), never re-drop h1.
      const dropsBeforeTakeover = (output.match(/"event":"drop"/g) ?? []).length;
      const replacement = await hostV3(room, nextGroup);
      assert.equal((await h3.closed()).code, 4000);
      assert.equal((await h4.closed()).code, 4000);
      await sleep(100);
      assert.equal((output.match(/"event":"drop"/g) ?? []).length - dropsBeforeTakeover, 2, "takeover drops only the 2 live seats, not the already-closing zombie");
      replacement.close();
    } finally {
      h1.ws.terminate();
    }
  });

  it("delivers and acknowledges an answer whose request is absent from room memory", async () => {
    const room = newRoom();
    const host = await hostV3(room, randomBytes(32).toString("base64url"));
    const client = await phone(room);
    host.send("ping");
    assert.equal(await host.next(), "pong");
    client.send(request(1));
    const ids = (await host.next()).subarray(0, 16);
    // Establish a fast cadence before the second phone joins. Its admission replaces the
    // opening probe with the 15-second silence deadline, leaving time for a real hibernation.
    await sleep(100);
    host.send("ping");
    assert.equal(await host.next(), "pong");
    await phone(room);
    const wakes = (output.match(/"event":"wake"/g) ?? []).length;
    await sleep(11_500);
    // Node retains the first request. Both targets also get a cache reply with no local entry.
    for (const id of [1, 2]) {
      const answer = bytes(0x02, u32(id), 0, 200);
      host.send(bytes(ids.subarray(0, 8), answer));
      assert.deepEqual(await client.next(), answer);
      assert.deepEqual(await host.next(), bytes(ids, 0x06, u32(id)));
    }
    if (!NODE_RELAY) assert.ok((output.match(/"event":"wake"/g) ?? []).length > wakes);
    client.close();
    assert.deepEqual(await host.next(), bytes(ids, 0x04));
    host.send(bytes(ids.subarray(0, 8), 0x02, u32(3)));
    const ack = await host.next();
    assert.deepEqual(ack.subarray(0, 8), ids.subarray(0, 8));
    assert.deepEqual(ack.subarray(16), bytes(0x06, u32(3)));
  });

  it("forwards a pushed part and replays its request until the final answer", async () => {
    const room = newRoom();
    const group = randomBytes(32).toString("base64url");
    const host = await hostV3(room, group);
    const standby = await hostV3(room, group);
    const client = await phone(room);
    client.send(request(9));
    const frame = await host.next();
    const part = bytes(0x07, u32(9), 123);
    host.send(bytes(frame.subarray(0, 8), part));
    assert.deepEqual(await client.next(), part);
    await host.silent(100);
    host.close();
    assert.deepEqual(await standby.next(), frame);
    const answer = bytes(0x02, u32(9), 0, 200);
    standby.send(bytes(frame.subarray(0, 8), answer));
    assert.deepEqual(await client.next(), answer);
    assert.deepEqual(await standby.next(), bytes(frame.subarray(0, 16), 0x06, u32(9)));
    standby.send(bytes(frame.subarray(0, 8), answer));
    assert.deepEqual(await standby.next(), bytes(frame.subarray(0, 16), 0x06, u32(9)));
    await client.silent(100);
  });

  it("answers health and the front page, and 404s everything else", async () => {
    const health = await fetch(base + "/v1/health");
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"ok":true}');
    const front = await fetch(base + "/");
    assert.equal(front.status, 200);
    assert.match(front.headers.get("content-type"), /^text\/plain/);
    assert.ok(!(await front.text()).trim().includes("\n"));
    for (const p of ["/nope", "/v1/health/", "/v1/host", "/v1/host/", "/v1/room/short", `/v1/room/${"a".repeat(44)}`, `/v1/host/${"a".repeat(42)}!`]) {
      assert.equal((await rawGet(p)).status, 404, p);
    }
    assert.equal((await rawGet("/v1/health", {}, "POST")).status, 404);
    assert.equal((await rawGet("/v1/health", {}, "DELETE")).status, 404);
  });

  it("serves the self-contained join page with CSP, no referrer and no cache", async () => {
    const response = await fetch(base + "/join#c=01234-ABCDE&k=" + "A".repeat(43));
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[^']+'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(html, /location\.hash/);
    assert.match(html, /botkins:\/\/join\?c=/);
    assert.match(html, /Don't have it open\? Open Botkins and enter this code\./);
    assert.doesNotMatch(html, /<script[^>]+\bsrc=/);
    assert.doesNotMatch(html, /<link[^>]+\bhref=/);
  });

  it("bounces /mcp-auth to botkins://mcp-auth with the query intact, fixed target, no cache and no referrer", async () => {
    const code = "oauth-code-" + randomBytes(12).toString("base64url");
    const state = "oauth-state-" + randomBytes(12).toString("base64url");
    secrets.add(code).add(state);
    const query = `?code=${code}&state=${state}&iss=https%3A%2F%2Fauth.cloudflare.com`;
    const res = await rawGet("/mcp-auth" + query);
    assert.equal(res.status, 302);
    assert.equal(res.headers["location"], "botkins://mcp-auth" + query);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["referrer-policy"], "no-referrer");

    const errQuery = `?error=access_denied&error_description=User+denied&state=${state}`;
    const errRes = await rawGet("/mcp-auth" + errQuery);
    assert.equal(errRes.status, 302);
    assert.equal(errRes.headers["location"], "botkins://mcp-auth" + errQuery);

    const bare = await rawGet("/mcp-auth");
    assert.equal(bare.status, 302);
    assert.equal(bare.headers["location"], "botkins://mcp-auth");

    // Fixed target only: no open redirect, no subpaths, GET only.
    const tricky = await rawGet("/mcp-auth?redirect=https://evil.example&next=//evil.example");
    assert.equal(tricky.status, 302);
    assert.equal(tricky.headers["location"], "botkins://mcp-auth?redirect=https://evil.example&next=//evil.example");
    assert.equal((await rawGet("/mcp-auth/extra")).status, 404);
    assert.equal((await rawGet("/mcp-auth?code=x", {}, "POST")).status, 404);
  });

  it("publishes, replaces, reads and deletes an invite card", async () => {
    const owner = newRoom();
    const lookup = newLookup();
    const expiresAt = Date.now() + 60_000;
    const first = newInviteCard();
    assert.equal((await putInvite(owner, lookup, { card: first, expiresAt })).status, 204);
    const read = await fetch(base + `/v1/invites/${lookup}`);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { card: first });

    const replacement = newInviteCard();
    assert.equal((await putInvite(owner, lookup, { card: replacement, expiresAt })).status, 204);
    assert.deepEqual(await (await fetch(base + `/v1/invites/${lookup}`)).json(), { card: replacement });
    assert.equal((await deleteInvite(owner, lookup)).status, 204);
    assert.equal((await fetch(base + `/v1/invites/${lookup}`)).status, 404);
    assert.equal((await deleteInvite(owner, lookup)).status, 404);
  });

  it("refuses an invite with a bad signature or stale time", async () => {
    const owner = newRoom();
    const other = newRoom();
    const body = { card: newInviteCard(), expiresAt: Date.now() + 60_000 };
    const bad = newLookup();
    assert.equal((await putInvite(owner, bad, body, { signer: other.privateKey })).status, 401);
    assert.equal((await fetch(base + `/v1/invites/${bad}`)).status, 404);

    const stale = newLookup();
    assert.equal((await putInvite(owner, stale, body, { seconds: nowSeconds() - 301 })).status, 401);
    assert.equal((await fetch(base + `/v1/invites/${stale}`)).status, 404);
  });

  it("lets only the publishing key replace or delete an invite", async () => {
    const owner = newRoom();
    const other = newRoom();
    const lookup = newLookup();
    const expiresAt = Date.now() + 60_000;
    const card = newInviteCard();
    assert.equal((await putInvite(owner, lookup, { card, expiresAt })).status, 204);

    assert.equal((await putInvite(other, lookup, { card: newInviteCard(), expiresAt })).status, 403);
    assert.equal((await deleteInvite(other, lookup)).status, 403);
    assert.deepEqual(await (await fetch(base + `/v1/invites/${lookup}`)).json(), { card });
    assert.equal((await deleteInvite(owner, lookup)).status, 204);
  });

  it("rejects invite expiry over 30 days and an oversized card", async () => {
    const owner = newRoom();
    const tooLong = { card: newInviteCard(), expiresAt: Date.now() + MAX_INVITE_LIFE + 60_000 };
    assert.equal((await putInvite(owner, newLookup(), tooLong)).status, 400);
    const tooLarge = { card: randomBytes(4097).toString("base64url"), expiresAt: Date.now() + 60_000 };
    assert.equal((await putInvite(owner, newLookup(), tooLarge)).status, 400);
  });

  it("answers 404 for an unknown invite lookup", async () => {
    assert.equal((await fetch(base + `/v1/invites/${newLookup()}`)).status, 404);
  });

  it("answers 426 to a plain GET on a valid room path", async () => {
    const r = newRoom();
    assert.equal((await rawGet(`/v1/host/${r.room}`)).status, 426);
    assert.equal((await rawGet(`/v1/room/${r.room}`)).status, 426);
  });

  it("refuses every bad computer offer, with 401 and no upgrade", async () => {
    const r = newRoom();
    const other = newRoom();
    const url = `${wsBase}/v1/host/${r.room}`;
    const now = nowSeconds();
    const good = proof(r);
    const bad = {
      "a key that gives another room": proof(r, { key: other.key, signer: other.privateKey }),
      "a signature by another key": proof(r, { signer: other.privateKey }),
      "a signature over another room": proof(r, { signedRoom: other.room }),
      "a time 301 seconds old": proof(r, { seconds: now - 301 }),
      // Two seconds past the limit: `now` was read before the relay reads its clock, and one
      // second ticking in between would leave an offer exactly at the limit, which is allowed.
      "a time 302 seconds ahead": proof(r, { seconds: now + 302 }),
      "a time that is not a number": proof(r, { seconds: "12x" }),
      "no protocol name": good.slice(1),
      "no key": good.filter((entry) => !entry.startsWith("k.")),
      "no time": good.filter((entry) => !entry.startsWith("t.")),
      "no signature": good.filter((entry) => !entry.startsWith("s.")),
      "two keys": [...good, "k." + other.key],
      "two times": [...good, "t." + (now + 1)],
      "two signatures": [...good, "s." + proof(r, { seconds: now + 1 })[3].slice(2)],
      "the old token form": ["botkins.host.v1", "t." + randomBytes(32).toString("base64url")],
      "the old name with a good proof": ["botkins.host.v1", ...good.slice(1)],
      "a short key": [HOST, "k.AAAA", good[2], good[3]],
    };
    for (const [why, protocols] of Object.entries(bad)) {
      await refused(url, protocols).catch((error) => {
        error.message = why + ": " + error.message;
        throw error;
      });
      const res = await rawGet(`/v1/host/${r.room}`, upgrade(protocols.join(", ")));
      assert.equal(res.status, 401, why);
      assert.equal(res.headers["sec-websocket-protocol"], undefined, why);
    }
    // A phone needs its own protocol; a computer's offer is no use to it.
    await refused(`${wsBase}/v1/room/${r.room}`, []);
    await refused(`${wsBase}/v1/room/${r.room}`, [HOST]);
    assert.equal((await rawGet(`/v1/room/${r.room}`, upgrade())).status, 400);
  });

  it("lets a good proof in, selects botkins.host.v2 and echoes nothing else", async () => {
    const r = newRoom();
    const h = await host(r);
    assert.equal(h.protocol, HOST);
    const p = await phone(r);
    assert.equal(p.protocol, PHONE);
    const res = await rawGet(`/v1/host/${r.room}`, upgrade(proof(r).reverse().join(", ")));
    assert.equal(res.status, 101);
    assert.equal(res.headers["sec-websocket-protocol"], HOST);
    // Times up to 300 seconds off, either way, are fine.
    await host(r, { seconds: nowSeconds() - 290 });
    await host(r, { seconds: nowSeconds() + 290 });
  });

  it("answers ping with pong on both kinds of socket", async () => {
    const r = newRoom();
    const h = await host(r);
    const p = await phone(r);
    for (const client of [h, p]) {
      client.send("ping");
      assert.equal(await client.next(), "pong");
    }
    // Any other text is ignored.
    p.send("hello");
    h.send("hello");
    await p.silent();
    await h.silent(100);
  });

  it("passes a phone request to the computer as [conn 8][from 8] + the message, byte for byte", async () => {
    const r = newRoom();
    const h = await host(r);
    const p = await phone(r);
    const message = request(7, "x".repeat(300));
    p.send(message);
    const got = await h.next();
    assert.ok(Buffer.isBuffer(got));
    assert.equal(got.length, 16 + message.length);
    assert.ok(got.subarray(16).equals(message));
    assert.notDeepEqual(got.subarray(0, 8), Buffer.alloc(8));
  });

  it("gives two sockets from one address the same `from` and different `conn`", async () => {
    const r = newRoom();
    const h = await host(r);
    const a = await phone(r);
    const b = await phone(r);
    a.send(request(1));
    b.send(request(2));
    const first = await h.next();
    const second = await h.next();
    assert.ok(first.subarray(8, 16).equals(second.subarray(8, 16)), "same from");
    assert.ok(!first.subarray(0, 8).equals(second.subarray(0, 8)), "different conn");
  });

  it("sends the computer's answer only to the right phone, with the 8 bytes stripped", async () => {
    const r = newRoom();
    const h = await host(r);
    const a = await phone(r);
    const b = await phone(r);
    a.send(request(1));
    b.send(request(2));
    const fromA = await h.next();
    const fromB = await h.next();
    // Which request came from which phone is read from the request id (at offset 17).
    const toB = fromA.readUInt32BE(17) === 2 ? fromA : fromB;
    const answer = bytes(0x02, u32(2), Buffer.from([0x00, 0xc8]), "ok");
    h.send(bytes(toB.subarray(0, 8), answer));
    assert.ok((await b.next()).equals(answer));
    await a.silent();
  });

  it("drops an answer for a conn that does not exist", async () => {
    const r = newRoom();
    const h = await host(r);
    const p = await phone(r);
    h.send(bytes(randomBytes(8), 0x02, u32(1), Buffer.from([0, 200])));
    h.send(bytes(randomBytes(5))); // shorter than 9 bytes
    h.send(bytes(randomBytes(8))); // exactly 8: no body, dropped
    await p.silent();
    // The room still works afterwards.
    p.send(request(1));
    assert.ok(await h.next());
  });

  it("tells a phone with [0x03][id] when no computer is connected", async () => {
    const r = newRoom();
    const p = await phone(r);
    p.send(request(0x01020304));
    assert.ok((await p.next()).equals(bytes(0x03, u32(0x01020304))));
    // Not a request (too short or another type): nothing comes back.
    p.send(bytes(0x09, 1, 2, 3, 4));
    p.send(bytes(0x01, 1));
    await p.silent();
  });

  it("tells every phone [0x05] when the computer's socket closes, and not the phones of another room", async () => {
    const r = newRoom();
    const other = newRoom();
    const h = await host(r);
    const one = await phone(r);
    const two = await phone(r);
    const elsewhere = await phone(other);
    await host(other);
    h.close();
    assert.ok((await one.next()).equals(bytes(0x05)));
    assert.ok((await two.next()).equals(bytes(0x05)));
    await elsewhere.silent();
    // With the computer gone, a new request is answered "offline" as before.
    one.send(request(9));
    assert.ok((await one.next()).equals(bytes(0x03, u32(9))));
  });

  it("sends the computer [conn][from][0x04] when a phone closes", async () => {
    const r = newRoom();
    const h = await host(r);
    const p = await phone(r);
    p.send(request(1));
    const seen = await h.next();
    p.close();
    const notice = await h.next();
    assert.ok(notice.equals(bytes(seen.subarray(0, 16), 0x04)));
    await h.silent(); // only once
  });

  it("replaces the first computer socket with the second (4000), and traffic follows", { timeout: 60_000 }, async () => {
    const r = newRoom();
    const first = await host(r);
    const p = await phone(r);
    const second = await host(r);
    const firstClosed = first.closed();
    // The phone hears that the first computer socket went away.
    assert.ok((await p.next()).equals(bytes(0x05)));
    p.send(request(5));
    const got = await second.next();
    assert.ok(got.subarray(16).equals(request(5)));
    second.send(bytes(got.subarray(0, 8), 0x02, u32(5), Buffer.from([0, 200])));
    assert.ok((await p.next()).equals(bytes(0x02, u32(5), Buffer.from([0, 200]))));
    await first.silent(100);
    assert.equal((await firstClosed).code, 4000);
  });

  it("reseats a new proven v3 host when both same-group sockets are stale", { timeout: 90_000 }, async () => {
    const r = newRoom();
    const group = randomBytes(32).toString("base64url");
    const first = await hostV3(r, group);
    const second = await hostV3(r, group);
    const p = await phone(r);
    p.send(request(34, "held-before-reseat"));
    const held = await first.next();
    assert.equal(held.readUInt32BE(17), 34);
    // v0.16.1 left both sockets OPEN when the host process disappeared. A new connection
    // must be able to take the bounded two-seat room instead of receiving HTTP 409 forever.
    const replacement = await hostV3(r, group);
    assert.equal(replacement.protocol, HOST_V3);
    const replay = await replacement.next(5_000);
    assert.equal(replay.readUInt32BE(17), 34);
    replacement.send(bytes(replay.subarray(0, 8), 0x02, u32(34), Buffer.from([0, 200])));
    assert.equal((await p.next()).readUInt32BE(1), 34);
    const firstClosed = first.closed().then((info) => ({ client: first, info })).catch(() => null);
    const secondClosed = second.closed().then((info) => ({ client: second, info })).catch(() => null);
    const closed = await Promise.race([firstClosed, secondClosed]);
    assert.ok(closed);
    assert.equal(closed.info.code, 4001);
    await (closed.client === first ? second : first).silent(100);
  });

  it("re-seats after recent pings and binary traffic, keeping the newest active", { timeout: 60_000 }, async () => {
    const r = newRoom();
    const group = randomBytes(32).toString("base64url");
    const first = await hostV3(r, group);
    const second = await hostV3(r, group);
    const p = await phone(r);

    first.send("ping");
    assert.equal(await first.next(), "pong");
    p.send(request(51, "answered-before-reseat"));
    const answered = await first.next();
    first.send(bytes(answered.subarray(0, 8), 0x02, u32(51), Buffer.from([0, 200])));
    await p.next();
    assert.equal((await first.next())[16], 0x06);
    await sleep(20);
    second.send("ping");
    assert.equal(await second.next(), "pong");
    await sleep(20);
    p.send(request(52, "pending-before-reseat"));
    const pending = await first.next();

    const replacement = await hostV3(r, group);
    assert.equal((await first.closed()).code, 4001);
    await second.silent(100);
    const replay = await replacement.next(5_000);
    assert.equal(replay.readUInt32BE(17), pending.readUInt32BE(17));
    replacement.send(bytes(replay.subarray(0, 8), 0x02, u32(52), Buffer.from([0, 200])));
    assert.equal((await p.next()).readUInt32BE(1), 52);
  });

  it("keeps repeated same-group reseats bounded and replays each pending request", { timeout: 120_000 }, async () => {
    const r = newRoom();
    const group = randomBytes(32).toString("base64url");
    const first = await hostV3(r, group);
    const second = await hostV3(r, group);
    const p = await phone(r);
    let active = first;
    let standby = second;

    for (const id of [61, 62]) {
      p.send(request(id, "repeat"));
      const sent = await active.next();
      assert.equal(sent.readUInt32BE(17), id);
      const next = await hostV3(r, group);
      const replay = await next.next(5_000);
      assert.equal(replay.readUInt32BE(17), id);
      next.send(bytes(replay.subarray(0, 8), 0x02, u32(id), Buffer.from([0, 200])));
      assert.equal((await p.next()).readUInt32BE(1), id);
      assert.equal((await next.next())[16], 0x06);
      const oldActive = active;
      const oldStandby = standby;
      const activeClosed = oldActive.closed().then((info) => ({ client: oldActive, info })).catch(() => null);
      const standbyClosed = oldStandby.closed().then((info) => ({ client: oldStandby, info })).catch(() => null);
      const closed = await Promise.race([activeClosed, standbyClosed]);
      assert.ok(closed);
      assert.equal(closed.info.code, 4001);
      [active, standby] = [next, closed.client === oldActive ? oldStandby : oldActive];
    }
  });

  it("learns a short heartbeat while idle, then reaps a silent v3 socket", { timeout: 60_000 }, async () => {
    const r = newRoom();
    const group = randomBytes(32).toString("base64url");
    const h = await hostV3(r, group);
    const standby = await hostV3(r, group);
    const p = await phone(r);
    h.send("ping");
    assert.equal(await h.next(), "pong");
    standby.send("ping");
    assert.equal(await standby.next(), "pong");
    p.send(request(71, "silent-active-in-flight"));
    const original = await h.next();

    // Keep the standby's transport alive while the active establishes and then stops its short
    // heartbeat. These pongs are intentionally not consumed until the promotion replay arrives.
    const keepStandbyAlive = (async () => {
      for (let i = 0; i < 8; i++) {
        await sleep(3_000);
        standby.send("ping");
        standby.send(bytes(0)); // Binary activity keeps the replay queue resident during this test.
      }
    })();
    // The hibernation-friendly probe samples this first auto-response around seven seconds.
    await sleep(8_000);
    h.send("ping");
    assert.equal(await h.next(), "pong");
    // The second probe observes the short cadence; its 15-second deadline then closes only h.
    await sleep(18_000);
    let replay;
    for (;;) {
      const frame = await standby.next(5_000);
      if (typeof frame === "string") {
        assert.equal(frame, "pong");
        continue;
      }
      replay = frame;
      break;
    }
    assert.deepEqual(replay.subarray(0, 16), original.subarray(0, 16));
    assert.equal(replay.readUInt32BE(17), 71);
    standby.send(bytes(replay.subarray(0, 8), 0x02, u32(71), Buffer.from([0, 200])));
    assert.equal((await p.next()).readUInt32BE(1), 71);
    await keepStandbyAlive;
    assert.equal((await h.closed()).code, 4001);
  });

  it("keeps same-group v3 active/standby sockets and takes over on a new group", { timeout: 60_000 }, async () => {
    const r = newRoom();
    const group = randomBytes(32).toString("base64url");
    const nextGroup = randomBytes(32).toString("base64url");
    const active = await hostV3(r, group);
    const p = await phone(r);
    const standby = await hostV3(r, group);

    // The first same-group socket is active; the second is standby. There is no promotion frame.
    p.send(request(31, "active"));
    const first = await active.next();
    assert.ok(first.subarray(16).equals(request(31, "active")));
    await standby.silent(100);
    active.send(bytes(first.subarray(0, 8), 0x02, u32(31), Buffer.from([0, 200])));
    await p.next();

    const activeClosed = active.closed();
    active.close();
    await activeClosed;
    await p.silent(250);
    p.send(request(32, "standby"));
    const second = await standby.next();
    assert.ok(second.subarray(16).equals(request(32, "standby")));

    // A distinct authenticated runtime group takes over all old sockets. The room sends one normal
    // host-closed notice during that gap; the new group then receives traffic without a promotion frame.
    const standbyClosed = standby.closed();
    const replacement = await hostV3(r, nextGroup);
    assert.equal((await standbyClosed).code, 4000);
    assert.ok((await p.next()).equals(bytes(0x05)));
    p.send(request(33, "replacement"));
    const third = await replacement.next();
    assert.ok(third.subarray(16).equals(request(33, "replacement")));
  });

  it("holds bounded v3 requests through a short reconnect and forwards them in order", { timeout: 60_000 }, async () => {
    const r = newRoom();
    const group = randomBytes(32).toString("base64url");
    const active = await hostV3(r, group);
    const p = await phone(r);
    p.send(request(41, "before-drop"));
    const first = await active.next();
    assert.equal(first.readUInt32BE(17), 41);

    const activeClosed = active.closed();
    active.close();
    await activeClosed;
    await sleep(150);
    p.send(request(42, "during-reconnect"));
    await p.silent(100);

    const resumed = await hostV3(r, group);
    const replayOne = await resumed.next();
    const replayTwo = await resumed.next();
    assert.equal(replayOne.readUInt32BE(17), 41);
    assert.equal(replayTwo.readUInt32BE(17), 42);
    for (const replay of [replayOne, replayTwo]) resumed.send(bytes(replay.subarray(0, 8), 0x02, u32(replay.readUInt32BE(17)), Buffer.from([0, 200])));
    assert.equal((await p.next()).readUInt32BE(1), 41);
    assert.equal((await p.next()).readUInt32BE(1), 42);
  });

  it("passes CF-Connecting-IP through, and gives one `from` to one network (IPv6 by /64)", async () => {
    const r = newRoom();
    const h = await host(r);
    const fromOf = async (address) => {
      const p = await phone(r, address);
      p.send(request(1));
      return (await h.next()).subarray(8, 16).toString("hex");
    };
    const a = await fromOf("203.0.113.7");
    assert.notEqual(a, await fromOf("203.0.113.8"));
    assert.equal(await fromOf("203.0.113.7"), a);
    // The same IPv4 address in its IPv6 form is the same source.
    assert.equal(await fromOf("::ffff:203.0.113.7"), a);
    // Every address in one /64 is one source; the next /64 is another.
    const v6 = await fromOf("2001:db8:1:2::1");
    assert.equal(await fromOf("2001:DB8:1:2:ffff:ffff:ffff:ffff"), v6);
    assert.notEqual(await fromOf("2001:db8:1:3::1"), v6);
    assert.notEqual(v6, a);
  });

  it("closes an address's oldest socket (4008) when it opens a ninth, and tells the computer", { timeout: 60_000 }, async () => {
    const r = newRoom();
    const h = await host(r);
    const elsewhere = await phone(r, "198.51.100.9");
    const mine = [];
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const p = await phone(r, "203.0.113.50");
      p.send(request(i));
      ids.push((await h.next()).subarray(0, 16));
      mine.push(p);
    }
    const oldestClosed = mine[0].closed();
    const fifth = await phone(r, "203.0.113.50"); // the ninth from this address
    // The computer hears about the oldest one, and only about it.
    assert.ok((await h.next()).equals(bytes(ids[0], 0x04)));
    fifth.send(request(9));
    const got = await h.next();
    assert.ok(got.subarray(16).equals(request(9)));
    assert.ok(got.subarray(8, 16).equals(ids[0].subarray(8)), "same from");
    await h.silent();
    // The others, and the other address, are untouched.
    mine[1].send(request(10));
    assert.ok((await h.next()).subarray(16).equals(request(10)));
    elsewhere.send(request(11));
    assert.ok((await h.next()).subarray(16).equals(request(11)));
    assert.equal((await oldestClosed).code, 4008);
  });

  it("closes the room's oldest socket (4008) when a 49th arrives from a mix of addresses", { timeout: 60_000 }, async () => {
    const r = newRoom();
    const h = await host(r);
    const phones = [];
    const ids = [];
    for (let i = 0; i < 48; i++) {
      const p = await phone(r, `198.51.100.${i % 8}`); // six sockets each from eight addresses
      p.send(request(i));
      ids.push((await h.next()).subarray(0, 16));
      phones.push(p);
    }
    const firstClosed = phones[0].closed();
    const secondClosed = phones[1].closed();
    const extra = await phone(r, "198.51.100.200");
    assert.ok((await h.next()).equals(bytes(ids[0], 0x04)));
    await h.silent(); // one notice, for one socket
    extra.send(request(100));
    assert.ok((await h.next()).subarray(16).equals(request(100)));
    // The next newcomer takes the next oldest.
    const another = await phone(r, "198.51.100.201");
    assert.ok((await h.next()).equals(bytes(ids[1], 0x04)));
    another.send(request(101));
    assert.ok((await h.next()).subarray(16).equals(request(101)));
    phones[47].send(request(102));
    assert.ok((await h.next()).subarray(16).equals(request(102)));
    assert.equal((await firstClosed).code, 4008);
    assert.equal((await secondClosed).code, 4008);
  });

  it("limits a phone's message to 6 MiB + 64 KiB and the computer's to 8 MiB", async () => {
    const r = newRoom();
    const h = await host(r);
    const p = await phone(r);

    const big = Buffer.concat([Buffer.from([0x01]), randomBytes(MiB - 1)]);
    p.send(big);
    const got = await h.next(15_000);
    assert.equal(got.length, 16 + MiB);
    assert.ok(got.subarray(16).equals(big));
    h.send(bytes(got.subarray(0, 8), randomBytes(MiB)));
    assert.equal((await p.next(15_000)).length, MiB);

    // A phone: exactly 6 MiB + 64 KiB passes, one byte more closes it.
    p.send(Buffer.alloc(MAX_PHONE, 1));
    assert.equal((await h.next(30_000)).length, 16 + MAX_PHONE);
    p.send(Buffer.alloc(MAX_PHONE + 1, 1));
    assert.equal((await p.closed(30_000)).code, 1009);
    // The computer hears that the phone is gone, and nothing of the oversized message.
    const notice = await h.next();
    assert.equal(notice.length, 17);
    assert.equal(notice[16], 0x04);
    await h.silent();

    // The computer: exactly 8 MiB passes, one byte more closes it.
    const q = await phone(r);
    q.send(request(1));
    const conn = (await h.next()).subarray(0, 8);
    h.send(Buffer.concat([conn, Buffer.alloc(8 * MiB - 8, 2)]));
    assert.equal((await q.next(30_000)).length, 8 * MiB - 8);
    h.send(Buffer.alloc(8 * MiB + 1, 1));
    assert.equal((await h.closed(30_000)).code, 1009);
    // The phone gets nothing of the oversized message, only the word that the computer is gone.
    assert.ok((await q.next()).equals(bytes(0x05)));
    await q.silent(100);
  });

  it("keeps two rooms apart", async () => {
    const one = newRoom();
    const two = newRoom();
    const hostOne = await host(one);
    const hostTwo = await host(two);
    const phoneOne = await phone(one);
    const phoneTwo = await phone(two);
    phoneOne.send(request(1, "one"));
    phoneTwo.send(request(2, "two"));
    const gotOne = await hostOne.next();
    const gotTwo = await hostTwo.next();
    assert.ok(gotOne.subarray(16).equals(request(1, "one")));
    assert.ok(gotTwo.subarray(16).equals(request(2, "two")));
    await hostOne.silent(100);
    await hostTwo.silent(100);
    // An answer carrying room one's conn, sent by room two's computer, goes nowhere.
    hostTwo.send(bytes(gotOne.subarray(0, 8), 0x02, u32(1), Buffer.from([0, 200])));
    await phoneOne.silent();
    await phoneTwo.silent(100);
  });

  it("keeps working after 15 seconds of silence, in both directions", { timeout: 60_000 }, async (t) => {
    const r = newRoom();
    const h = await host(r);
    const p = await phone(r);
    p.send(request(1));
    const before = await h.next();
    const wakesBefore = (output.match(/"event":"wake"/g) ?? []).length;
    await sleep(15_000);
    p.send(request(2));
    const after = await h.next();
    assert.ok(after.subarray(0, 16).equals(before.subarray(0, 16)), "same conn and from after the pause");
    assert.ok(after.subarray(16).equals(request(2)));
    h.send(bytes(after.subarray(0, 8), 0x02, u32(2), Buffer.from([0, 200])));
    assert.ok((await p.next()).equals(bytes(0x02, u32(2), Buffer.from([0, 200]))));
    h.send(bytes(after.subarray(0, 8), 0x02, u32(3), Buffer.from([0, 200])));
    assert.ok((await p.next()).equals(bytes(0x02, u32(3), Buffer.from([0, 200]))));
    p.close();
    assert.equal((await h.next()).length, 17);
    // The Node relay keeps rooms in memory and has nothing to hibernate.
    if (NODE_RELAY) return;
    const wakes = (output.match(/"event":"wake"/g) ?? []).length - wakesBefore;
    // The object logs "wake" each time it starts: after the pause it must have started again, which
    // proves it hibernated and the sockets, tags and attachments survived.
    t.diagnostic(`the object woke ${wakes} time(s) after the pause`);
    assert.ok(wakes >= 1, "the object never hibernated, so this test proved nothing");
  });

  it("keeps a current phone waiting through abrupt loss and new requests", async () => {
    const room = newRoom();
    const group = randomBytes(32).toString("base64url");
    const host = new ResettableSocket(wsBase + "/v1/host/" + room.room, proofV3(room, group));
    try {
      await once(host, "open");
      const phoneSocket = await phone(room);
      const forwarded = once(host, "message");
      phoneSocket.send(request(41));
      const [first] = await forwarded;
      const closed = once(host, "close");
      host.terminate(); // TCP teardown without a WebSocket close frame.
      await closed;
      await sleep(100);
      phoneSocket.send(request(42));
      await sleep(100);
      const notices = phoneSocket.queue.map((frame) => frame[0]);
      assert.deepEqual(notices, [], "A transport reset must not send host-closed/offline to a waiting phone");
      const replacement = await hostV3(room, group);
      const replay = [await replacement.next(), await replacement.next()];
      assert.deepEqual(replay.map((frame) => frame.readUInt32BE(17)), [41, 42]);
      for (const frame of replay) {
        assert.deepEqual(frame.subarray(0, 16), first.subarray(0, 16));
        const answer = bytes(0x02, frame.subarray(17, 21), 0, 200);
        replacement.send(bytes(frame.subarray(0, 8), answer));
        assert.deepEqual(await phoneSocket.next(), answer);
      }
    } finally {
      host.terminate();
    }
  });

  it("replays held requests in order near the end of the reconnect window", { timeout: 35_000 }, async () => {
    const r = newRoom();
    const group = randomBytes(32).toString("base64url");
    const h = await hostV3(r, group);
    const p = await phone(r);
    p.send(request(10, "in flight"));
    const original = await h.next();
    h.close();
    await h.closed();
    p.send(request(11, "in the gap"));
    await sleep(200);
    await sleep(11_500);
    const replacement = await hostV3(r, group);
    for (const id of [10, 11]) {
      const replay = await replacement.next();
      assert.deepEqual(replay.subarray(0, 16), original.subarray(0, 16));
      assert.equal(replay.readUInt32BE(17), id);
      const reply = bytes(0x02, u32(id), 0, 200);
      replacement.send(bytes(replay.subarray(0, 8), reply));
      assert.deepEqual(await p.next(), reply);
    }
  });

  it("refuses overflow with an offline answer and preserves earlier held requests", { timeout: 30_000 }, async () => {
    for (const [count, payload] of [[48, Buffer.alloc(0)], [3, Buffer.alloc(5 * MiB)]]) {
      const room = newRoom();
      const group = randomBytes(32).toString("base64url");
      const host = await hostV3(room, group);
      const client = await phone(room);
      client.send(request(1, payload));
      const initial = await host.next();
      host.close();
      await host.closed();
      for (let id = 2; id <= count + 1; id++) client.send(request(id, payload));
      assert.deepEqual(await client.next(), bytes(0x03, u32(count + 1)));
      const replacement = await hostV3(room, group);
      for (let id = 1; id <= count; id++) {
        const frame = await replacement.next();
        assert.deepEqual(frame.subarray(0, 16), initial.subarray(0, 16));
        assert.equal(frame.readUInt32BE(17), id);
        assert.equal(frame.length, initial.length);
      }
      client.close();
      replacement.close();
    }
  });

  it("tells a returning host which phone left during the gap", async () => {
    const r = newRoom();
    const group = randomBytes(32).toString("base64url");
    const host = await hostV3(r, group);
    const leaving = await phone(r);
    const staying = await phone(r);
    leaving.send(request(1));
    const first = await host.next();
    staying.send(request(1));
    const second = await host.next();
    host.close();
    await host.closed();
    leaving.close();
    await leaving.closed();
    const back = await hostV3(r, group);
    const notice = await back.next();
    assert.deepEqual(notice, bytes(first.subarray(0, 16), 0x04));
    assert.deepEqual(await back.next(), second);
  });

  it("ends outstanding phone calls at grace expiry and refuses later requests until a host returns", { timeout: 35_000 }, async () => {
    const r = newRoom();
    const group = randomBytes(32).toString("base64url");
    const h = await hostV3(r, group);
    const p = await phone(r);
    p.send(request(21)); await h.next();
    h.close(); await h.closed();
    p.send(request(22));
    assert.deepEqual(await p.next(22_000), bytes(0x05));
    p.send(request(23));
    assert.deepEqual(await p.next(), bytes(0x03, u32(23)));
    const replacement = await hostV3(r, group);
    await replacement.silent(150);
    p.send(request(24));
    assert.equal((await replacement.next()).readUInt32BE(17), 24);
  });

  it("keeps a space's sealed copy for its computer, hands it to anyone with the id, and replaces it only with a newer one", async () => {
    const r = newRoom();
    const share = newShare(r);
    assert.equal((await readSpace(share)).status, 404);
    const t = nowSeconds();
    // Larger than one piece of the store, so it is kept in several.
    const first = sealedCopy(700 * 1024);
    assert.equal((await putSpace(r, share, first, { seconds: t - 2 })).status, 204);
    const read = await readSpace(share);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.match(read.headers.get("content-type"), /^application\/octet-stream/);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), first);
    // A smaller, newer copy replaces it whole.
    const second = sealedCopy(300);
    assert.equal((await putSpace(r, share, second, { seconds: t - 1 })).status, 204);
    assert.deepEqual(Buffer.from(await (await readSpace(share)).arrayBuffer()), second);
    // One signed at the same time, or earlier, does not.
    assert.equal((await putSpace(r, share, sealedCopy(), { seconds: t - 1 })).status, 409);
    assert.equal((await putSpace(r, share, sealedCopy(), { seconds: t - 2 })).status, 409);
    assert.deepEqual(Buffer.from(await (await readSpace(share)).arrayBuffer()), second);
  });

  it("refuses a copy that is not that computer's, is not signed, lives too long or is too large", async () => {
    const r = newRoom();
    const other = newRoom();
    const share = newShare(r);
    const body = sealedCopy();
    const expiresAt = Date.now() + 60_000;
    const send = (headers, bytes = body, id = share.id) => fetch(base + `/v1/spaces/${id}`, { method: "PUT", headers, body: bytes });
    const good = () => spaceProof(r, share, { body, expiresAt });
    // The id must come from the key and the salt.
    assert.equal((await send(spaceProof(other, share, { body, expiresAt }))).status, 403, "another computer's key");
    assert.equal((await send(spaceProof(r, share, { body, expiresAt, salt: randomBytes(16).toString("base64url") }))).status, 403, "another salt");
    assert.equal((await send({ ...good(), "x-botkins-salt": "short" })).status, 400);
    // The signature covers the body, the id, when it ends and when it was signed.
    assert.equal((await send(spaceProof(r, share, { body, expiresAt, signer: other.privateKey }))).status, 401, "another key signed");
    assert.equal((await send(spaceProof(r, share, { body, expiresAt, signedBody: sealedCopy() }))).status, 401, "another body");
    assert.equal((await send(spaceProof(r, share, { body, expiresAt, signedExpiresAt: expiresAt + 1 }))).status, 401, "another end");
    assert.equal((await send(spaceProof(r, share, { body, expiresAt, seconds: nowSeconds() - 302 }))).status, 401, "signed too long ago");
    const { "x-botkins-sig": _sig, ...unsigned } = good();
    assert.equal((await send(unsigned)).status, 401);
    // Seven days at most, and not already over.
    assert.equal((await putSpace(r, share, body, { expiresAt: Date.now() + MAX_SPACE_LIFE + 60_000 })).status, 400);
    assert.equal((await putSpace(r, share, body, { expiresAt: Date.now() - 1 })).status, 400);
    // 4 MiB at most, and at least a nonce and a tag.
    assert.equal((await putSpace(r, share, sealedCopy(4 * MiB + 1))).status, 413);
    assert.equal((await putSpace(r, share, sealedCopy(27))).status, 400);
    assert.equal((await readSpace(share)).status, 404, "nothing was kept");
    assert.equal((await putSpace(r, share, sealedCopy(4 * MiB))).status, 204, "the largest copy");
    assert.equal((await (await readSpace(share)).arrayBuffer()).byteLength, 4 * MiB);
    // An id of another shape is no space, and no other method is answered.
    assert.equal((await fetch(base + "/v1/spaces/short")).status, 404);
    assert.equal((await fetch(base + `/v1/spaces/${share.id}`, { method: "POST" })).status, 404);
  });

  it("takes a space's copy back, and a copy signed before that cannot put it out again", async () => {
    const r = newRoom();
    const other = newRoom();
    const share = newShare(r);
    const t = nowSeconds();
    assert.equal((await putSpace(r, share, sealedCopy(), { seconds: t - 10 })).status, 204);
    // Only its computer takes it back, and only with a later time than the copy's.
    assert.equal((await deleteSpace(other, share)).status, 403);
    assert.equal((await deleteSpace(r, share, { signer: other.privateKey })).status, 401);
    assert.equal((await deleteSpace(r, share, { seconds: t - 10 })).status, 409);
    assert.equal((await readSpace(share)).status, 200);
    assert.equal((await deleteSpace(r, share, { seconds: t - 5 })).status, 204);
    assert.equal((await readSpace(share)).status, 404);
    assert.equal((await deleteSpace(r, share, { seconds: t - 4 })).status, 404, "nothing left to take back");
    // A PUT that was on its way when the DELETE arrived was signed earlier: it is refused.
    assert.equal((await putSpace(r, share, sealedCopy(), { seconds: t - 6 })).status, 409);
    assert.equal((await putSpace(r, share, sealedCopy(), { seconds: t - 4 })).status, 409);
    assert.equal((await readSpace(share)).status, 404);
    // Shared again later, it is put out again.
    const again = sealedCopy();
    assert.equal((await putSpace(r, share, again, { seconds: t })).status, 204);
    assert.deepEqual(Buffer.from(await (await readSpace(share)).arrayBuffer()), again);
    // A DELETE for a copy that was never put is remembered too.
    const never = newShare(r);
    assert.equal((await deleteSpace(r, never, { seconds: t - 1 })).status, 404);
    assert.equal((await putSpace(r, never, sealedCopy(), { seconds: t - 1 })).status, 409);
  });

  it("lets one computer put a copy 30 times a minute", async () => {
    const r = newRoom();
    const share = newShare(r);
    const t = nowSeconds() - 100;
    const answers = [];
    for (let n = 0; n < 31; n++) answers.push((await putSpace(r, share, sealedCopy(64), { seconds: t + n })).status);
    assert.deepEqual(answers, [...Array(30).fill(204), 429]);
    // Another computer is not held back by it.
    const other = newRoom();
    assert.equal((await putSpace(other, newShare(other), sealedCopy(64))).status, 204);
  });

  it("holds only so much of all computers' copies together, and makes room when one is taken back", async () => {
    // This relay holds 12 MiB (1 GiB when deployed). Computers put 4 MiB copies until it is full.
    const made = [];
    let full = null;
    for (let n = 0; n < 4 && !full; n++) {
      const r = newRoom();
      const share = newShare(r);
      const status = (await putSpace(r, share, sealedCopy(4 * MiB), { seconds: nowSeconds() - 20 })).status;
      if (status === 507) full = { r, share };
      else {
        assert.equal(status, 204);
        made.push({ r, share });
      }
    }
    assert.ok(full, "a copy is refused once all copies together are over what the relay holds");
    assert.equal((await readSpace(full.share)).status, 404);
    // A computer that holds a copy may still replace it with a smaller one.
    assert.equal((await putSpace(made[0].r, made[0].share, sealedCopy(1000), { seconds: nowSeconds() - 10 })).status, 204);
    // And a copy taken back makes room for another.
    assert.equal((await putSpace(full.r, full.share, sealedCopy(4 * MiB), { seconds: nowSeconds() - 9 })).status, 204);
    for (const one of [...made, full]) assert.equal((await deleteSpace(one.r, one.share)).status, 204);
    const after = newRoom();
    assert.equal((await putSpace(after, newShare(after), sealedCopy(4 * MiB))).status, 204, "taken back: there is room again");
  });

  it("serves the same page for every shared space, and an empty frame for a panel's own page", async () => {
    const id = randomBytes(16).toString("base64url");
    const page = await rawGet(`/s/${id}`);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    const csp = page.headers["content-security-policy"];
    for (const part of ["default-src 'none'", "img-src 'self' data:", "connect-src 'self'", "frame-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(part), part);
    const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(csp)?.[1];
    assert.ok(nonce && page.body.includes(`<script nonce="${nonce}">`) && page.body.includes(`<style nonce="${nonce}">`));
    assert.ok(!csp.includes("unsafe"), "the page runs only its own script");
    // The page holds nothing of any space: not the id it was asked for.
    assert.ok(!page.body.includes(id));
    assert.ok(page.body.includes("Made with Botkins"));
    assert.notEqual(/'nonce-([0-9a-f]{32})'/.exec((await rawGet(`/s/${id}`)).headers["content-security-policy"])[1], nonce, "a new nonce each time");
    for (const bad of ["/s/short", `/s/${"a".repeat(23)}`, `/s/${"a".repeat(21)}!`, `/s/${id}/more`]) assert.equal((await rawGet(bad)).status, 404, bad);

    const frame = await rawGet("/s/frame");
    assert.equal(frame.status, 200);
    const policy = frame.headers["content-security-policy"];
    for (const part of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "sandbox allow-scripts", "frame-ancestors 'self'"]) assert.ok(policy.includes(part), part);
    assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(policy));
    assert.equal(frame.headers["cache-control"], "no-store");
  });

  it("serves a Botkin's picture for the page, and nothing else from that folder", async () => {
    const picture = await fetch(base + "/s/botkin/beacon-original.webp");
    assert.equal(picture.status, 200);
    assert.match(picture.headers.get("content-type"), /^image\/webp/);
    assert.equal(Buffer.from(await picture.arrayBuffer()).subarray(8, 12).toString("latin1"), "WEBP");
    for (const p of ["/s/botkin/layers/beacon-accent.webp", "/s/botkin/nobody-original.webp", "/s/botkin/.assetsignore", "/s/botkin/"]) {
      const answer = await rawGet(p);
      assert.ok(answer.status === 404 || !/^image\//.test(answer.headers["content-type"] ?? ""), p);
    }
  });

  it("never logs an invite lookup, card, key, signature, room name, conn or from tag", () => {
    // wrangler dev prints each request's URL itself; production invocation logs are off. Check the relay's lines.
    const logged = output.split("\n").filter((line) => line.startsWith('{"event":'));
    assert.ok(logged.length > 20, "the relay logged its events");
    const text = logged.join("\n");
    assert.ok(secrets.size > 20);
    for (const secret of secrets) assert.ok(!text.includes(secret), "A secret value appears in the logs");
    for (const line of logged) assert.deepEqual(Object.keys(JSON.parse(line)).filter((key) => !["event", "kind", "code", "reason", "phones", "sockets"].includes(key)), []);
  });
});
