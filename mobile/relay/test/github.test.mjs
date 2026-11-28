// Tests for POST /v1/github/events and host GitHub repo subscriptions:
// - Pure helpers (HMAC verification, payload trimming, subscribe signature, per-repo authorization)
// - End-to-end against both local wrangler dev (Cloudflare Worker + Durable Objects)
//   and the self-hosted Node relay (node/server.mjs): HMAC good/bad/missing, 413, 503 github_off,
//   IP and installation.id rate limits, per-repo read authorization (deny-by-default, private repo
//   isolation, public repo access, dropped repos reported), fan-out to authorized hosts only, and
//   deliveryId dedupe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { RelayHost, newRelayKey } from "../../link-host/relay.mjs";
import { createRelay } from "../node/server.mjs";
import { HOST_PROTOCOL_V3, hostChallengeV3, roomOf } from "../src/pure.ts";
import {
  GITHUB_DELIVERY_BODY_BYTES_LIMIT,
  GITHUB_EVENTS_PATH,
  GITHUB_ROUTE_REPOSITORIES_LIMIT,
  authorizeSubscribedRepos,
  checkGitHubRepoAccess,
  checkGitHubWebhookRequest,
  githubSubscribeChallenge,
  normalizeSubscribedRepos,
  signGitHubWebhook,
  trimGitHubWebhookPayload,
  verifyGitHubSignature,
  verifyGitHubSubscribe,
} from "../src/github.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSeconds = () => Math.floor(Date.now() / 1000);

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function makeHostIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "jwk" }).x;
  const room = await roomOf(key);
  const group = randomBytes(32).toString("base64url");
  return {
    key,
    privateKey,
    room,
    group,
    offer(seconds = nowSeconds()) {
      const sig = sign(null, Buffer.from(hostChallengeV3(room, group, String(seconds)), "utf8"), privateKey).toString("base64url");
      return [HOST_PROTOCOL_V3, `k.${key}`, `g.${group}`, `t.${seconds}`, `s.${sig}`];
    },
    subscribeFrame(repos, { ttlSeconds = 300, time = nowSeconds(), githubToken, repoTokens } = {}) {
      const normalized = normalizeSubscribedRepos(repos);
      const exp = time + ttlSeconds;
      const sig = sign(null, Buffer.from(githubSubscribeChallenge(room, time, exp, normalized), "utf8"), privateKey).toString("base64url");
      return JSON.stringify({
        type: "github-subscribe",
        v: 1,
        key,
        time,
        exp,
        repos: normalized,
        sig,
        ...(githubToken ? { githubToken } : {}),
        ...(repoTokens ? { repoTokens } : {}),
      });
    },
  };
}

function hmacHeader(secret, body) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function issueWebhookPayload(repo = "promptclickrun/Botkins", installationId = 9001, extra = {}) {
  return JSON.stringify({
    action: "opened",
    installation: { id: installationId },
    repository: { id: 12345, full_name: repo, html_url: `https://github.com/${repo}`, default_branch: "main" },
    sender: { login: "octocat", type: "User" },
    issue: {
      id: 777,
      number: 42,
      title: "Webhook test issue",
      body: "Hello from webhook",
      html_url: `https://github.com/${repo}/issues/42`,
      state: "open",
      updated_at: "2026-11-27T12:00:00Z",
      user: { login: "octocat", type: "User" },
      labels: [{ name: "bug", color: "ff0000" }],
      assignees: [{ login: "maintainer" }],
    },
    unrelated_blob: { should_be_dropped: true },
    ...extra,
  });
}

function openHostSocket(base, identity) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/v1/host/" + identity.room, identity.offer());
    const messages = [];
    const waiters = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text === "pong") return;
      const parsed = JSON.parse(text);
      if (waiters.length) waiters.shift()(parsed);
      else messages.push(parsed);
    });
    ws.once("open", () => {
      resolve({
        ws,
        messages,
        nextMessage(timeoutMs = 5000) {
          if (messages.length) return Promise.resolve(messages.shift());
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("timed out waiting for ws message")), timeoutMs);
            waiters.push((msg) => {
              clearTimeout(t);
              res(msg);
            });
          });
        },
        close() {
          return new Promise((res) => {
            if (ws.readyState === WebSocket.CLOSED) return res();
            ws.once("close", () => res());
            ws.close();
          });
        },
      });
    });
    ws.once("error", reject);
  });
}

/**
 * Local stub for `https://api.github.com` used by both Worker (via `GITHUB_API_BASE`) and Node relay tests.
 * Models public repos, private repos readable only by specific tokens, and unreachable/non-existent repos.
 */
async function startFakeGitHubApi(catalog) {
  const requests = [];
  const server = createServer((req, res) => {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    requests.push({ method: req.method, url: req.url, hasAuth: Boolean(token) });
    const match = /^\/repos\/([^/]+\/[^/?]+)$/.exec(req.url || "");
    if (req.method !== "GET" || !match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    const repo = match[1].toLowerCase();
    const entry = catalog[repo];
    if (!entry) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    if (!entry.private) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ full_name: entry.full_name || repo, private: false, permissions: token ? { pull: true } : undefined }));
      return;
    }
    // Private repo: only authorized tokens see it (with permissions.pull).
    const allowedTokens = new Set(entry.tokens || []);
    if (!token || !allowedTokens.has(token)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        full_name: entry.full_name || repo,
        private: true,
        permissions: { pull: entry.pull !== false },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

describe("github webhook pure helpers", () => {
  it("verifies HMAC-SHA256 in constant time and rejects tampered/missing signatures", async () => {
    const body = new TextEncoder().encode(issueWebhookPayload());
    const sig = await signGitHubWebhook("top-secret", body);
    assert.equal(await verifyGitHubSignature("top-secret", body, sig), true);
    assert.equal(await verifyGitHubSignature("top-secret", body, sig.toUpperCase()), true);
    assert.equal(await verifyGitHubSignature("wrong-secret", body, sig), false);
    assert.equal(await verifyGitHubSignature("top-secret", body, null), false);
    assert.equal(await verifyGitHubSignature("top-secret", body, "sha1=deadbeef"), false);
    const tampered = new TextEncoder().encode(issueWebhookPayload("promptclickrun/Other"));
    assert.equal(await verifyGitHubSignature("top-secret", tampered, sig), false);
  });

  it("caps subscribed repos at 100 and verifies Ed25519 subscribe messages with ephemeral proofs", async () => {
    const host = await makeHostIdentity();
    const ok = await verifyGitHubSubscribe(
      host.subscribeFrame(["Owner/RepoB", "owner/repoa", "owner/repoa"], {
        githubToken: "gho_shared",
        repoTokens: { "Owner/RepoB": "ghs_specific" },
      }),
      host.room,
    );
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.repos, ["owner/repoa", "owner/repob"]);
    assert.equal(ok.proofs["owner/repoa"], "gho_shared");
    assert.equal(ok.proofs["owner/repob"], "ghs_specific");

    const tooMany = Array.from({ length: GITHUB_ROUTE_REPOSITORIES_LIMIT + 1 }, (_, i) => `owner/repo-${i}`);
    assert.equal(normalizeSubscribedRepos(tooMany), null);

    const otherHost = await makeHostIdentity();
    const wrongRoom = await verifyGitHubSubscribe(host.subscribeFrame(["owner/repo"]), otherHost.room);
    assert.equal(wrongRoom.ok, false);
  });

  it("authorizes repos deny-by-default: requires pull permission for private repos, allows public, caches within TTL", async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url: String(url), auth: init?.headers?.authorization || null });
      const repo = String(url).split("/repos/")[1];
      if (repo === "org/public") {
        return Response.json({ full_name: "org/public", private: false });
      }
      if (repo === "org/private-ok" && init?.headers?.authorization === "Bearer tok-good") {
        return Response.json({ full_name: "org/private-ok", private: true, permissions: { pull: true } });
      }
      if (repo === "org/private-nopull" && init?.headers?.authorization === "Bearer tok-good") {
        return Response.json({ full_name: "org/private-nopull", private: true, permissions: { pull: false } });
      }
      return new Response("Not Found", { status: 404 });
    };

    assert.equal(await checkGitHubRepoAccess("org/private-ok", undefined, { fetch: fakeFetch }), false);
    assert.equal(await checkGitHubRepoAccess("org/private-ok", "tok-wrong", { fetch: fakeFetch }), false);
    assert.equal(await checkGitHubRepoAccess("org/private-nopull", "tok-good", { fetch: fakeFetch }), false);
    assert.equal(await checkGitHubRepoAccess("org/private-ok", "tok-good", { fetch: fakeFetch }), true);
    assert.equal(await checkGitHubRepoAccess("org/public", undefined, { fetch: fakeFetch }), true);

    calls.length = 0;
    const res = await authorizeSubscribedRepos(
      ["org/cached", "org/private-ok", "org/private-denied", "org/public"],
      { "org/private-ok": "tok-good", "org/private-denied": "tok-wrong" },
      { cachedAllowed: new Set(["org/cached"]), fetch: fakeFetch },
    );
    assert.deepEqual(res.allowed, ["org/cached", "org/private-ok", "org/public"]);
    assert.deepEqual(res.denied, ["org/private-denied"]);
    assert.ok(!calls.some((c) => c.url.endsWith("/org/cached")), "cached repo skips GitHub lookup within TTL");
  });

  it("trims webhook payload to needed fields and enforces 413 / 503 / rate limits", async () => {
    const secret = "whsec_unit";
    const body = issueWebhookPayload();
    const trimmed = trimGitHubWebhookPayload("issues", JSON.parse(body));
    assert.equal(trimmed.unrelated_blob, undefined);
    assert.equal(trimmed.issue.number, 42);
    assert.equal(trimmed.repository.full_name, "promptclickrun/Botkins");

    const makeReq = (payload, hdrs = {}) =>
      new Request("https://relay.test" + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "del-unit-1",
          "x-hub-signature-256": hmacHeader(secret, payload),
          ...hdrs,
        },
        body: payload,
      });

    const allow = { checkIp: async () => true, checkInstallation: async () => true };

    const off = await checkGitHubWebhookRequest(makeReq(body), undefined, allow);
    assert.ok(off instanceof Response);
    assert.equal(off.status, 503);
    assert.deepEqual(await off.json(), { error: "github_off" });

    const huge = JSON.stringify({ pad: "x".repeat(GITHUB_DELIVERY_BODY_BYTES_LIMIT + 100) });
    const big = await checkGitHubWebhookRequest(makeReq(huge), secret, allow);
    assert.ok(big instanceof Response);
    assert.equal(big.status, 413);

    const ipDenied = await checkGitHubWebhookRequest(makeReq(body), secret, { checkIp: async () => false, checkInstallation: async () => true });
    assert.ok(ipDenied instanceof Response);
    assert.equal(ipDenied.status, 429);

    const instDenied = await checkGitHubWebhookRequest(makeReq(body), secret, { checkIp: async () => true, checkInstallation: async () => false });
    assert.ok(instDenied instanceof Response);
    assert.equal(instDenied.status, 429);
  });
});

// ---- Local wrangler dev harness ----------------------------------------------------------------

const instances = [];
function stopAll() {
  for (const dev of instances) {
    if (dev.child.exitCode === null && dev.child.pid) {
      try {
        process.kill(-dev.child.pid, "SIGTERM");
      } catch {}
    }
    rmSync(dev.dir, { recursive: true, force: true });
  }
  instances.length = 0;
}
process.on("exit", stopAll);

async function startDev(vars) {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "botkins-gh-relay-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLOUDFLARE_")));
  Object.assign(env, { WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" });
  const child = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--local",
      "--ip=127.0.0.1",
      `--port=${port}`,
      "--inspector-port=0",
      `--persist-to=${dir}`,
      "--show-interactive-dev-session=false",
      ...Object.entries(vars).map(([name, value]) => `--var=${name}:${value}`),
    ],
    { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const dev = { child, dir, base: `http://127.0.0.1:${port}`, output: "" };
  instances.push(dev);
  child.stdout.on("data", (chunk) => (dev.output += chunk));
  child.stderr.on("data", (chunk) => (dev.output += chunk));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev stopped early:\n${dev.output}`);
    try {
      const res = await fetch(`${dev.base}/v1/health`);
      if (res.ok) return dev;
    } catch {}
    await sleep(150);
  }
  throw new Error(`wrangler dev did not become ready:\n${dev.output}`);
}

function stopDev(dev) {
  if (!dev) return;
  if (dev.child.exitCode === null && dev.child.pid) {
    try {
      process.kill(-dev.child.pid, "SIGTERM");
    } catch {}
  }
  rmSync(dev.dir, { recursive: true, force: true });
}

const TEST_CATALOG = {
  "promptclickrun/botkins": { full_name: "promptclickrun/Botkins", private: false },
  "promptclickrun/otherrepo": { full_name: "promptclickrun/OtherRepo", private: false },
  "promptclickrun/botkins-website": {
    full_name: "promptclickrun/botkins-website",
    private: true,
    tokens: ["tok_owner_private"],
  },
};

describe("POST /v1/github/events on Cloudflare Worker (wrangler dev)", () => {
  const SECRET = "whsec_worker_test_secret";
  let fakeGitHub;
  let dev;
  let devOff;

  before(async () => {
    fakeGitHub = await startFakeGitHubApi(TEST_CATALOG);
    [dev, devOff] = await Promise.all([
      startDev({ RATE_LIMITS: "off", GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_API_BASE: fakeGitHub.base, GITHUB_ALLOW_USER_TOKEN_AUTH: "1" }),
      startDev({ RATE_LIMITS: "off", GITHUB_API_BASE: fakeGitHub.base }),
    ]);
  });

  after(() => {
    stopDev(dev);
    stopDev(devOff);
    fakeGitHub?.close();
  });

  it("answers 503 github_off when GITHUB_WEBHOOK_SECRET is unset (and leaves other routes untouched)", async () => {
    const health = await fetch(devOff.base + "/v1/health");
    assert.equal(health.status, 200);

    const body = issueWebhookPayload();
    const res = await fetch(devOff.base + GITHUB_EVENTS_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "del-off-1",
        "x-hub-signature-256": hmacHeader(SECRET, body),
      },
      body,
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "github_off" });
  });

  it("rejects bad/missing HMAC with 401 and bodies > 512 KiB with 413", async () => {
    const body = issueWebhookPayload();

    const missing = await fetch(dev.base + GITHUB_EVENTS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": "del-nosig" },
      body,
    });
    assert.equal(missing.status, 401);

    const bad = await fetch(dev.base + GITHUB_EVENTS_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "del-badsig",
        "x-hub-signature-256": hmacHeader("wrong", body),
      },
      body,
    });
    assert.equal(bad.status, 401);

    const huge = JSON.stringify({ pad: "a".repeat(GITHUB_DELIVERY_BODY_BYTES_LIMIT + 1024) });
    const tooLarge = await fetch(dev.base + GITHUB_EVENTS_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "del-big",
        "x-hub-signature-256": hmacHeader(SECRET, huge),
      },
      body: huge,
    });
    assert.equal(tooLarge.status, 413);
  });

  it("fans out verified events only to subscribed hosts and dedupes on x-github-delivery", async () => {
    const hostA = await makeHostIdentity();
    const hostB = await makeHostIdentity();
    const connA = await openHostSocket(dev.base, hostA);
    const connB = await openHostSocket(dev.base, hostB);

    try {
      connA.ws.send(hostA.subscribeFrame(["promptclickrun/Botkins"]));
      const ackA = await connA.nextMessage();
      assert.equal(ackA.type, "github-subscribed");
      assert.equal(ackA.ok, true);
      assert.equal(ackA.count, 1);
      assert.deepEqual(ackA.allowed, ["promptclickrun/botkins"]);
      assert.deepEqual(ackA.denied, []);

      connB.ws.send(hostB.subscribeFrame(["promptclickrun/OtherRepo"]));
      const ackB = await connB.nextMessage();
      assert.equal(ackB.type, "github-subscribed");
      assert.equal(ackB.ok, true);

      const body = issueWebhookPayload("promptclickrun/Botkins", 555);
      const res1 = await fetch(dev.base + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "del-fanout-1",
          "x-hub-signature-256": hmacHeader(SECRET, body),
        },
        body,
      });
      assert.equal(res1.status, 202);
      const json1 = await res1.json();
      assert.equal(json1.delivered, 1);

      const delivered = await connA.nextMessage();
      assert.equal(delivered.type, "github-delivery");
      assert.equal(delivered.deliveryId, "del-fanout-1");
      assert.equal(delivered.event, "issues");
      assert.equal(delivered.action, "opened");
      assert.equal(delivered.repository, "promptclickrun/Botkins");
      assert.equal(delivered.installationId, 555);
      assert.equal(delivered.payload.issue.number, 42);
      assert.equal(delivered.payload.unrelated_blob, undefined);

      // Duplicate deliveryId is deduped and not forwarded again.
      const dupRes = await fetch(dev.base + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "del-fanout-1",
          "x-hub-signature-256": hmacHeader(SECRET, body),
        },
        body,
      });
      assert.equal(dupRes.status, 202);
      const dupJson = await dupRes.json();
      assert.equal(dupJson.duplicate, true);
      assert.equal(dupJson.delivered, 0);

      await sleep(150);
      assert.equal(connB.messages.length, 0);
      assert.equal(connA.messages.length, 0);
    } finally {
      await connA.close();
      await connB.close();
    }
  });

  it("denies unauthorized repo subscriptions by default and delivers private-repo events only to the authorized room", async () => {
    const ownerHost = await makeHostIdentity();
    const strangerHost = await makeHostIdentity();
    const ownerConn = await openHostSocket(dev.base, ownerHost);
    const strangerConn = await openHostSocket(dev.base, strangerHost);

    try {
      // Stranger tries to subscribe to private repo + missing repo without valid proof -> both dropped & reported.
      strangerConn.ws.send(
        strangerHost.subscribeFrame(["promptclickrun/botkins-website", "promptclickrun/nonexistent"], {
          githubToken: "tok_stranger_invalid",
        }),
      );
      const strangerAck = await strangerConn.nextMessage();
      assert.equal(strangerAck.type, "github-subscribed");
      assert.equal(strangerAck.ok, true);
      assert.equal(strangerAck.count, 0);
      assert.deepEqual(strangerAck.allowed, []);
      assert.deepEqual(strangerAck.denied, ["promptclickrun/botkins-website", "promptclickrun/nonexistent"]);

      // Owner subscribes to the private repo with valid read proof (plus an unauthorized repo that gets dropped).
      ownerConn.ws.send(
        ownerHost.subscribeFrame(["promptclickrun/botkins-website", "promptclickrun/nonexistent"], {
          githubToken: "tok_owner_private",
        }),
      );
      const ownerAck = await ownerConn.nextMessage();
      assert.equal(ownerAck.type, "github-subscribed");
      assert.equal(ownerAck.ok, true);
      assert.equal(ownerAck.count, 1);
      assert.deepEqual(ownerAck.allowed, ["promptclickrun/botkins-website"]);
      assert.deepEqual(ownerAck.denied, ["promptclickrun/nonexistent"]);

      // Private repo webhook delivery arrives -> ONLY ownerHost receives it; strangerHost gets nothing.
      const privateBody = issueWebhookPayload("promptclickrun/botkins-website", 777);
      const res = await fetch(dev.base + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "del-private-worker-1",
          "x-hub-signature-256": hmacHeader(SECRET, privateBody),
        },
        body: privateBody,
      });
      assert.equal(res.status, 202);
      const json = await res.json();
      assert.equal(json.delivered, 1);

      const frame = await ownerConn.nextMessage();
      assert.equal(frame.type, "github-delivery");
      assert.equal(frame.deliveryId, "del-private-worker-1");
      assert.equal(frame.repository, "promptclickrun/botkins-website");

      await sleep(150);
      assert.equal(strangerConn.messages.length, 0, "unauthorized host must never receive private repo frames");
      assert.ok(!dev.output.includes("tok_owner_private"), "relay logs must never leak proof tokens");
    } finally {
      await ownerConn.close();
      await strangerConn.close();
    }
  });

  it("enforces RelayHost unbound opt-in off vs opt-in on against Cloudflare Worker", async () => {
    const waitFor = async (fn, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(25);
      }
      throw new Error("Timed out waiting for condition");
    };

    const runHostScenario = async (allowUserToken) => {
      const sentSubFrames = [];
      const acks = [];
      const deliveries = [];
      let proofCalls = 0;

      class RecordingWebSocket extends WebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          this.on("message", (data, isBinary) => {
            if (isBinary) return;
            const text = data.toString();
            if (text.startsWith("{")) {
              try {
                const parsed = JSON.parse(text);
                if (parsed.type === "github-subscribed") acks.push(parsed);
              } catch {}
            }
          });
        }
        send(data, ...rest) {
          if (typeof data === "string" && data.startsWith("{")) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "github-subscribe") sentSubFrames.push(parsed);
            } catch {}
          }
          return super.send(data, ...rest);
        }
      }

      const host = new RelayHost({
        url: dev.base,
        key: newRelayKey(),
        serve: async () => ({ status: 200, body: Buffer.from("") }),
        onGithubDelivery: (frame) => deliveries.push(frame),
        getGithubAuthProof: async () => {
          proofCalls++;
          return { githubToken: "tok_owner_private" };
        },
        githubAllowUserTokenProof: allowUserToken,
        WebSocket: RecordingWebSocket,
      });

      host.start();
      try {
        await waitFor(() => host.connected);
        host.setGithubRepos(["promptclickrun/Botkins", "promptclickrun/botkins-website"]);
        await waitFor(() => acks.length >= 1);
        return { sentSubFrames, acks, deliveries, proofCalls, host };
      } catch (err) {
        host.stop();
        throw err;
      }
    };

    // Unbound host with opt-in OFF: no token sent, public repo allowed, private repo denied, no private frames delivered
    const off = await runHostScenario(false);
    try {
      assert.equal(off.proofCalls, 0, "opt-in off must never invoke auth proof provider");
      assert.equal(off.sentSubFrames.length, 1);
      assert.equal(off.sentSubFrames[0].githubToken, undefined, "opt-in off must send no githubToken on host side");
      assert.deepEqual(off.acks[0].allowed, ["promptclickrun/botkins"]);
      assert.deepEqual(off.acks[0].denied, ["promptclickrun/botkins-website"]);

      const privBody = issueWebhookPayload("promptclickrun/botkins-website", 778);
      const privRes = await fetch(dev.base + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "del-worker-optin-off-priv",
          "x-hub-signature-256": hmacHeader(SECRET, privBody),
        },
        body: privBody,
      });
      assert.equal(privRes.status, 204);
      await sleep(100);
      assert.equal(off.deliveries.length, 0);
    } finally {
      off.host.stop();
    }

    // Unbound host with opt-in ON: keeps today's behavior (sends token, gets private repo allowed and receives frames)
    const on = await runHostScenario(true);
    try {
      assert.equal(on.proofCalls, 1);
      assert.equal(on.sentSubFrames.length, 1);
      assert.equal(on.sentSubFrames[0].githubToken, "tok_owner_private");
      assert.deepEqual(on.acks[0].allowed, ["promptclickrun/botkins", "promptclickrun/botkins-website"]);
      assert.deepEqual(on.acks[0].denied, []);

      const privBody = issueWebhookPayload("promptclickrun/botkins-website", 779);
      const privRes = await fetch(dev.base + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "del-worker-optin-on-priv",
          "x-hub-signature-256": hmacHeader(SECRET, privBody),
        },
        body: privBody,
      });
      assert.equal(privRes.status, 202);
      assert.equal((await privRes.json()).delivered, 1);
      await waitFor(() => on.deliveries.length >= 1);
      assert.equal(on.deliveries[0].deliveryId, "del-worker-optin-on-priv");
      assert.equal(on.deliveries[0].repository, "promptclickrun/botkins-website");
      assert.ok(!dev.output.includes("tok_owner_private"), "relay logs must never leak proof tokens");
    } finally {
      on.host.stop();
    }
  });
});

describe("POST /v1/github/events on self-hosted Node relay (parity + authz + rate limit)", () => {
  const SECRET = "whsec_node_test";
  let fakeGitHub;
  let server;
  let base;

  before(async () => {
    fakeGitHub = await startFakeGitHubApi(TEST_CATALOG);
    server = createRelay({
      limits: true,
      githubWebhookSecret: SECRET,
      githubApiBase: fakeGitHub.base,
      githubAllowUserTokenAuth: true,
      clientIpHeader: "x-test-ip",
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.closeAllConnections?.();
    server?.close();
    fakeGitHub?.close();
  });

  it("denies unauthorized repos, isolates private-repo deliveries to authorized rooms, dedupes, and enforces IP rate limit", async () => {
    const ownerHost = await makeHostIdentity();
    const strangerHost = await makeHostIdentity();
    const ownerConn = await openHostSocket(base, ownerHost);
    const strangerConn = await openHostSocket(base, strangerHost);

    try {
      // Stranger subscribes to private repo without valid read access -> dropped and reported in `denied`.
      strangerConn.ws.send(
        strangerHost.subscribeFrame(["promptclickrun/botkins-website", "promptclickrun/Botkins"], {
          githubToken: "tok_stranger",
        }),
      );
      const strangerAck = await strangerConn.nextMessage();
      assert.equal(strangerAck.ok, true);
      assert.deepEqual(strangerAck.allowed, ["promptclickrun/botkins"]);
      assert.deepEqual(strangerAck.denied, ["promptclickrun/botkins-website"]);

      // Owner subscribes to private repo with valid read token -> allowed.
      ownerConn.ws.send(
        ownerHost.subscribeFrame(["promptclickrun/botkins-website"], {
          githubToken: "tok_owner_private",
        }),
      );
      const ownerAck = await ownerConn.nextMessage();
      assert.equal(ownerAck.ok, true);
      assert.deepEqual(ownerAck.allowed, ["promptclickrun/botkins-website"]);
      assert.deepEqual(ownerAck.denied, []);

      // Private repo delivery reaches ONLY ownerHost.
      const privateBody = issueWebhookPayload("promptclickrun/botkins-website", 888);
      const privRes = await fetch(base + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "node-priv-1",
          "x-hub-signature-256": hmacHeader(SECRET, privateBody),
          "x-test-ip": "10.0.0.1",
        },
        body: privateBody,
      });
      assert.equal(privRes.status, 202);
      assert.equal((await privRes.json()).delivered, 1);

      const frame = await ownerConn.nextMessage();
      assert.equal(frame.deliveryId, "node-priv-1");
      assert.equal(frame.repository, "promptclickrun/botkins-website");

      await sleep(100);
      assert.equal(strangerConn.messages.length, 0, "unauthorized host must not receive private repo frames on Node relay");

      // Dedupe on same deliveryId.
      const dup = await fetch(base + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "node-priv-1",
          "x-hub-signature-256": hmacHeader(SECRET, privateBody),
          "x-test-ip": "10.0.0.1",
        },
        body: privateBody,
      });
      assert.equal(dup.status, 202);
      assert.equal((await dup.json()).duplicate, true);

      // Per-IP rate limit (120/min) trips on 121st request from a single IP.
      let got429 = false;
      for (let i = 0; i < 125; i++) {
        const r = await fetch(base + GITHUB_EVENTS_PATH, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-github-delivery": `node-rl-${i}`,
            "x-hub-signature-256": hmacHeader(SECRET, "{}"),
            "x-test-ip": "10.0.0.99",
          },
          body: "{}",
        });
        if (r.status === 429) {
          got429 = true;
          break;
        }
      }
      assert.equal(got429, true, "expected 429 after exceeding per-IP GitHub webhook limit");
    } finally {
      await ownerConn.close();
      await strangerConn.close();
    }
  });

  it("enforces RelayHost unbound opt-in off vs opt-in on against self-hosted Node relay", async () => {
    const waitFor = async (fn, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(25);
      }
      throw new Error("Timed out waiting for condition");
    };

    const runHostScenario = async (allowUserToken) => {
      const sentSubFrames = [];
      const acks = [];
      const deliveries = [];
      let proofCalls = 0;

      class RecordingWebSocket extends WebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          this.on("message", (data, isBinary) => {
            if (isBinary) return;
            const text = data.toString();
            if (text.startsWith("{")) {
              try {
                const parsed = JSON.parse(text);
                if (parsed.type === "github-subscribed") acks.push(parsed);
              } catch {}
            }
          });
        }
        send(data, ...rest) {
          if (typeof data === "string" && data.startsWith("{")) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "github-subscribe") sentSubFrames.push(parsed);
            } catch {}
          }
          return super.send(data, ...rest);
        }
      }

      const host = new RelayHost({
        url: base,
        key: newRelayKey(),
        serve: async () => ({ status: 200, body: Buffer.from("") }),
        onGithubDelivery: (frame) => deliveries.push(frame),
        getGithubAuthProof: async () => {
          proofCalls++;
          return { githubToken: "tok_owner_private" };
        },
        githubAllowUserTokenProof: allowUserToken,
        WebSocket: RecordingWebSocket,
      });

      host.start();
      try {
        await waitFor(() => host.connected);
        host.setGithubRepos(["promptclickrun/Botkins", "promptclickrun/botkins-website"]);
        await waitFor(() => acks.length >= 1);
        return { sentSubFrames, acks, deliveries, proofCalls, host };
      } catch (err) {
        host.stop();
        throw err;
      }
    };

    // Unbound host with opt-in OFF: no token sent, public repo allowed, private repo denied
    const off = await runHostScenario(false);
    try {
      assert.equal(off.proofCalls, 0);
      assert.equal(off.sentSubFrames.length, 1);
      assert.equal(off.sentSubFrames[0].githubToken, undefined, "opt-in off must send no githubToken on host side");
      assert.deepEqual(off.acks[0].allowed, ["promptclickrun/botkins"]);
      assert.deepEqual(off.acks[0].denied, ["promptclickrun/botkins-website"]);

      const privBody = issueWebhookPayload("promptclickrun/botkins-website", 889);
      const privRes = await fetch(base + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "node-optin-off-priv",
          "x-hub-signature-256": hmacHeader(SECRET, privBody),
          "x-test-ip": "10.0.0.2",
        },
        body: privBody,
      });
      assert.equal(privRes.status, 204);
      await sleep(100);
      assert.equal(off.deliveries.length, 0);
    } finally {
      off.host.stop();
    }

    // Unbound host with opt-in ON: sends token, gets private repo allowed, receives frames
    const on = await runHostScenario(true);
    try {
      assert.equal(on.proofCalls, 1);
      assert.equal(on.sentSubFrames.length, 1);
      assert.equal(on.sentSubFrames[0].githubToken, "tok_owner_private");
      assert.deepEqual(on.acks[0].allowed, ["promptclickrun/botkins", "promptclickrun/botkins-website"]);
      assert.deepEqual(on.acks[0].denied, []);

      const privBody = issueWebhookPayload("promptclickrun/botkins-website", 890);
      const privRes = await fetch(base + GITHUB_EVENTS_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "node-optin-on-priv",
          "x-hub-signature-256": hmacHeader(SECRET, privBody),
          "x-test-ip": "10.0.0.3",
        },
        body: privBody,
      });
      assert.equal(privRes.status, 202);
      assert.equal((await privRes.json()).delivered, 1);
      await waitFor(() => on.deliveries.length >= 1);
      assert.equal(on.deliveries[0].deliveryId, "node-optin-on-priv");
      assert.equal(on.deliveries[0].repository, "promptclickrun/botkins-website");
    } finally {
      on.host.stop();
    }
  });
});
