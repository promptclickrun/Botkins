// End-to-end tests for Botkins Agent GitHub App installation binding, single-repo installation
// token minting, team delivery claim locks, isolation across installations, and secret-free logs
// on BOTH Cloudflare Worker (wrangler dev + GitHubRouter DO) and self-hosted Node relay (node/server.mjs).
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
  GITHUB_EVENTS_PATH,
  GITHUB_SETUP_PATH,
  encodeGitHubSetupState,
  githubClaimChallenge,
  githubInstallationsChallenge,
  githubSetupStateChallenge,
  githubSubscribeChallenge,
  githubTokenRequestChallenge,
  normalizeSubscribedRepos,
  verifyGitHubSetupState,
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
    setupState({ nonce = randomBytes(18).toString("base64url"), exp = nowSeconds() + 600 } = {}) {
      const sig = sign(null, Buffer.from(githubSetupStateChallenge(room, nonce, exp), "utf8"), privateKey).toString("base64url");
      return encodeGitHubSetupState({ v: 1, key, room, nonce, exp, sig });
    },
    subscribeFrame(repos, { ttlSeconds = 300, time = nowSeconds() } = {}) {
      const normalized = normalizeSubscribedRepos(repos);
      const exp = time + ttlSeconds;
      const sig = sign(null, Buffer.from(githubSubscribeChallenge(room, time, exp, normalized), "utf8"), privateKey).toString("base64url");
      return JSON.stringify({ type: "github-subscribe", v: 1, key, time, exp, repos: normalized, sig });
    },
    tokenFrame(repo, { requestId = randomBytes(8).toString("base64url"), time = nowSeconds(), permissions = { issues: "write", metadata: "read", pull_requests: "write" } } = {}) {
      const sorted = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b));
      const permKey = sorted.map(([k, v]) => `${k}=${v}`).join(",");
      const sig = sign(null, Buffer.from(githubTokenRequestChallenge(room, requestId, repo.toLowerCase(), time, permKey), "utf8"), privateKey).toString("base64url");
      return JSON.stringify({
        type: "github-token",
        v: 1,
        requestId,
        key,
        time,
        repo: repo.toLowerCase(),
        permissions: Object.fromEntries(sorted),
        sig,
      });
    },
    claimFrame(deliveryId, { requestId = randomBytes(8).toString("base64url"), time = nowSeconds() } = {}) {
      const sig = sign(null, Buffer.from(githubClaimChallenge(room, requestId, deliveryId, time), "utf8"), privateKey).toString("base64url");
      return JSON.stringify({ type: "github-claim", v: 1, requestId, key, time, deliveryId, sig });
    },
    listInstallationsFrame({ requestId = randomBytes(8).toString("base64url"), time = nowSeconds() } = {}) {
      const sig = sign(null, Buffer.from(githubInstallationsChallenge(room, requestId, time), "utf8"), privateKey).toString("base64url");
      return JSON.stringify({ type: "github-installations-list", v: 1, requestId, key, time, sig });
    },
  };
}

function hmacHeader(secret, body) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
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
    ws.on("open", () =>
      resolve({
        ws,
        messages,
        nextMessage(timeoutMs = 5000) {
          if (messages.length) return Promise.resolve(messages.shift());
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("Timed out waiting for host frame")), timeoutMs);
            waiters.push((m) => {
              clearTimeout(t);
              res(m);
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
      }),
    );
    ws.on("error", reject);
  });
}

/** Fake GitHub OAuth + REST API server that records token mint bodies to prove single-repo scoping. */
async function startFakeGitHubAppServer({ appId, clientId, clientSecret, codes, installations }) {
  const mintedRequests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url || "/", "http://127.0.0.1");

      // OAuth code exchange
      if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
        const body = JSON.parse(rawBody || "{}");
        if (body.client_id !== clientId || body.client_secret !== clientSecret) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad_client" }));
          return;
        }
        const entry = codes[body.code];
        if (!entry) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad_verification_code" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: entry.userToken, token_type: "bearer" }));
        return;
      }

      const auth = String(req.headers.authorization || "");
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

      if (req.method === "GET" && url.pathname === "/user") {
        const match = Object.values(codes).find((c) => c.userToken === bearer);
        if (!match) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Bad credentials" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ login: match.login }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/user/installations") {
        const match = Object.values(codes).find((c) => c.userToken === bearer);
        if (!match) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Bad credentials" }));
          return;
        }
        const list = match.installationIds
          .map((id) => installations[id])
          .filter(Boolean)
          .map((inst) => ({
            id: inst.id,
            app_id: Number(appId),
            account: { login: inst.accountLogin, type: inst.accountType },
            repository_selection: inst.repositorySelection || "selected",
            suspended_at: inst.suspended ? "2026-11-27T00:00:00Z" : null,
          }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ total_count: list.length, installations: list }));
        return;
      }

      const instReposMatch = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
      if (req.method === "GET" && instReposMatch) {
        const id = Number(instReposMatch[1]);
        const inst = installations[id];
        const match = Object.values(codes).find((c) => c.userToken === bearer);
        if (!inst || !match) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Not Found" }));
          return;
        }
        const userRepos = match.reposByInstallation?.[id] ?? inst.repos;
        const repositories = userRepos.map((entry) =>
          typeof entry === "string"
            ? { full_name: entry, permissions: { pull: true, push: true, admin: false } }
            : { full_name: entry.full_name, permissions: entry.permissions },
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ total_count: repositories.length, repositories }));
        return;
      }

      // Mint installation access token (requires RS256 App JWT)
      const mintMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
      if (req.method === "POST" && mintMatch) {
        const id = Number(mintMatch[1]);
        const inst = installations[id];
        if (!inst || !bearer || bearer.split(".").length !== 3) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Bad JWT" }));
          return;
        }
        const body = JSON.parse(rawBody || "{}");
        mintedRequests.push({ installationId: id, body });
        const tok = `ghs_SECRET_MINTED_${id}_${(body.repositories || ["all"]).join("_")}`;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            token: tok,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: body.permissions || { issues: "write" },
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    mintedRequests,
    close: () => server.close(),
  };
}

function issuePayload(repo, installationId, number = 10) {
  return JSON.stringify({
    action: "created",
    installation: { id: installationId },
    repository: { id: 100 + installationId, full_name: repo, html_url: `https://github.com/${repo}` },
    sender: { login: "alice", type: "User" },
    issue: { number, title: "Need help", html_url: `https://github.com/${repo}/issues/${number}`, state: "open", user: { login: "alice", type: "User" } },
    comment: { id: 500 + number, body: "@botkins-agent glory please look", html_url: `https://github.com/${repo}/issues/${number}#issuecomment-${500 + number}`, user: { login: "alice", type: "User" } },
  });
}

// Generate a throwaway RSA keypair for Botkins Agent App JWT signing.
const { privateKey: rsaKeyObj } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = rsaKeyObj.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = "5896932";
const CLIENT_ID = "Iv23liTestClientId";
const CLIENT_SECRET = "gh_secret_client_value";
const WEBHOOK_SECRET = "whsec_agent_product_test";

const FAKE_CODES = {
  code_alice_inst1: {
    userToken: "ghu_ALICE_SECRET_ONCE",
    login: "alice",
    installationIds: [1001],
    reposByInstallation: {
      1001: [
        { full_name: "acme/app", permissions: { pull: true, push: true, admin: true } },
        { full_name: "acme/docs", permissions: { pull: true, push: true, admin: false } },
      ],
    },
  },
  code_alice_team_inst1: {
    userToken: "ghu_ALICE_TEAM_SECRET",
    login: "alice-team",
    installationIds: [1001],
    reposByInstallation: {
      1001: [
        { full_name: "acme/app", permissions: { pull: true, push: true, admin: false } },
        { full_name: "acme/docs", permissions: { pull: true, push: true, admin: false } },
      ],
    },
  },
  code_bob_inst2: {
    userToken: "ghu_BOB_SECRET_ONCE",
    login: "bob",
    installationIds: [2002],
    reposByInstallation: {
      2002: [{ full_name: "beta/secret", permissions: { pull: true, push: true, admin: true } }],
    },
  },
  code_mallory_unauth: { userToken: "ghu_MALLORY_SECRET", login: "mallory", installationIds: [9999] },
  // Org security test codes:
  // - org_admin has full access to both selected org (3001) and all-repos org (3002)
  // - org_reader only has READ on one public repo in 3001 and 3002, never private repos
  code_org_admin_selected: {
    userToken: "ghu_ORG_ADMIN_SEL",
    login: "org-admin",
    installationIds: [3001],
    reposByInstallation: {
      3001: [
        { full_name: "orgsel/public-one", permissions: { pull: true, push: true, admin: true } },
        { full_name: "orgsel/private-secret", permissions: { pull: true, push: true, admin: true } },
      ],
    },
  },
  code_org_admin_selected_with_added: {
    userToken: "ghu_ORG_ADMIN_SEL_ADDED",
    login: "org-admin",
    installationIds: [3001],
    reposByInstallation: {
      3001: [
        { full_name: "orgsel/public-one", permissions: { pull: true, push: true, admin: true } },
        { full_name: "orgsel/private-secret", permissions: { pull: true, push: true, admin: true } },
        { full_name: "orgsel/newly-added", permissions: { pull: true, push: true, admin: true } },
      ],
    },
  },
  code_org_reader_selected: {
    userToken: "ghu_ORG_READER_SEL",
    login: "org-reader",
    installationIds: [3001],
    reposByInstallation: {
      3001: [{ full_name: "orgsel/public-one", permissions: { pull: true, push: false, admin: false } }],
    },
  },
  code_org_admin_all: {
    userToken: "ghu_ORG_ADMIN_ALL",
    login: "org-admin-all",
    installationIds: [3002],
    reposByInstallation: {
      3002: [
        { full_name: "orgall/public-one", permissions: { pull: true, push: true, admin: true } },
        { full_name: "orgall/private-secret", permissions: { pull: true, push: true, admin: true } },
      ],
    },
  },
  code_org_reader_all: {
    userToken: "ghu_ORG_READER_ALL",
    login: "org-reader-all",
    installationIds: [3002],
    reposByInstallation: {
      3002: [{ full_name: "orgall/public-one", permissions: { pull: true, push: false, admin: false } }],
    },
  },
};

const FAKE_INSTALLATIONS = {
  1001: { id: 1001, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", repos: ["acme/app", "acme/docs"] },
  2002: { id: 2002, accountLogin: "beta", accountType: "Organization", repositorySelection: "selected", repos: ["beta/secret"] },
  3001: { id: 3001, accountLogin: "orgsel", accountType: "Organization", repositorySelection: "selected", repos: ["orgsel/public-one", "orgsel/private-secret"] },
  3002: { id: 3002, accountLogin: "orgall", accountType: "Organization", repositorySelection: "all", repos: ["orgall/public-one", "orgall/private-secret"] },
  9999: { id: 9999, accountLogin: "mallory", accountType: "User", repositorySelection: "selected", repos: ["mallory/other"] },
};

describe("GitHub setup state verification (pure)", () => {
  it("accepts valid state and rejects forged, tampered, or expired state", async () => {
    const host = await makeHostIdentity();
    const good = host.setupState();
    const ok = await verifyGitHubSetupState(good);
    assert.equal(ok.ok, true);
    assert.equal(ok.room, host.room);

    // Expired state rejected
    const expired = host.setupState({ exp: nowSeconds() - 10 });
    const expRes = await verifyGitHubSetupState(expired);
    assert.equal(expRes.ok, false);
    assert.equal(expRes.error, "expired_state");

    // Forged state (wrong room / tampered payload) rejected
    const other = await makeHostIdentity();
    const forgedObj = JSON.parse(Buffer.from(good, "base64url").toString("utf8"));
    forgedObj.room = other.room;
    const forged = Buffer.from(JSON.stringify(forgedObj), "utf8").toString("base64url");
    const forgedRes = await verifyGitHubSetupState(forged);
    assert.equal(forgedRes.ok, false);

    // Tampered signature rejected
    const badSigObj = JSON.parse(Buffer.from(good, "base64url").toString("utf8"));
    badSigObj.sig = "A".repeat(86);
    const badSig = Buffer.from(JSON.stringify(badSigObj), "utf8").toString("base64url");
    assert.equal((await verifyGitHubSetupState(badSig)).ok, false);
  });
});

/** Runs the full product security & multi-tenant suite against either Worker or Node relay. */
function runRelayProductSuite(name, getTarget) {
  describe(`Botkins Agent product flow on ${name}`, () => {
    it("rejects forged/expired/unauthorized setup, binds installations, isolates across installations, enforces single-repo tokens, grants 1 team claim per mention, handles uninstall/repo removal, and never logs tokens", async () => {
      const { base, fakeGitHub, getLogs } = getTarget();

      const hostA1 = await makeHostIdentity(); // team room 1 on installation 1001
      const hostA2 = await makeHostIdentity(); // team room 2 on installation 1001
      const hostB = await makeHostIdentity(); // separate installation 2002
      const unboundHost = await makeHostIdentity(); // never installed

      const connA1 = await openHostSocket(base, hostA1);
      const connA2 = await openHostSocket(base, hostA2);
      const connB = await openHostSocket(base, hostB);
      const connUnbound = await openHostSocket(base, unboundHost);

      try {
        // 1. Forged & expired state are rejected at GET /v1/github/setup
        const expiredRes = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=1001&code=code_alice_inst1&state=${encodeURIComponent(hostA1.setupState({ exp: nowSeconds() - 5 }))}`,
        );
        assert.equal(expiredRes.status, 400);

        const forgedRes = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=1001&code=code_alice_inst1&state=not-valid-state`,
        );
        assert.equal(forgedRes.status, 400);

        // Unauthorized user trying to bind installation 1001 gets rejected
        const unauthBind = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=1001&code=code_mallory_unauth&state=${encodeURIComponent(unboundHost.setupState())}`,
        );
        assert.equal(unauthBind.status, 400);

        // 2. Legitimate OAuth setup binds installation 1001 to hostA1 and hostA2, and 2002 to hostB
        const stateA1 = hostA1.setupState();
        const bindA1 = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=1001&code=code_alice_inst1&state=${encodeURIComponent(stateA1)}`,
        );
        assert.equal(bindA1.status, 200);
        const pushA1 = await connA1.nextMessage();
        assert.equal(pushA1.type, "github-installations");
        assert.equal(pushA1.installations.length, 1);
        assert.equal(pushA1.installations[0].installationId, 1001);

        // Replaying the same state nonce is rejected
        const replayRes = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=1001&code=code_alice_inst1&state=${encodeURIComponent(stateA1)}`,
        );
        assert.equal(replayRes.status, 400);

        const bindA2 = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=1001&code=code_alice_team_inst1&state=${encodeURIComponent(hostA2.setupState())}`,
        );
        assert.equal(bindA2.status, 200);
        await connA2.nextMessage(); // github-installations push

        const bindB = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=2002&code=code_bob_inst2&state=${encodeURIComponent(hostB.setupState())}`,
        );
        assert.equal(bindB.status, 200);
        await connB.nextMessage(); // github-installations push

        // 3. Subscribe: unbound room is denied; bound rooms are allowed only for their installation's repos
        connUnbound.ws.send(unboundHost.subscribeFrame(["acme/app", "beta/secret"]));
        const unboundSub = await connUnbound.nextMessage();
        assert.equal(unboundSub.ok, true);
        assert.deepEqual(unboundSub.allowed, []);
        assert.deepEqual(unboundSub.denied, ["acme/app", "beta/secret"]);

        connA1.ws.send(hostA1.subscribeFrame(["acme/app", "beta/secret"]));
        const subA1 = await connA1.nextMessage();
        assert.deepEqual(subA1.allowed, ["acme/app"]);
        assert.deepEqual(subA1.denied, ["beta/secret"]);

        connA2.ws.send(hostA2.subscribeFrame(["acme/app"]));
        const subA2 = await connA2.nextMessage();
        assert.deepEqual(subA2.allowed, ["acme/app"]);

        connB.ws.send(hostB.subscribeFrame(["beta/secret", "acme/app"]));
        const subB = await connB.nextMessage();
        assert.deepEqual(subB.allowed, ["beta/secret"]);
        assert.deepEqual(subB.denied, ["acme/app"]);

        // 4. Installation isolation: webhook for installation 1001 (acme/app) reaches ONLY hostA1 & hostA2, never hostB or unboundHost
        const acmeBody = issuePayload("acme/app", 1001, 42);
        const acmeRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-github-delivery": "del-team-1",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, acmeBody),
          },
          body: acmeBody,
        });
        assert.equal(acmeRes.status, 202);
        assert.equal((await acmeRes.json()).delivered, 2);

        const frameA1 = await connA1.nextMessage();
        const frameA2 = await connA2.nextMessage();
        assert.equal(frameA1.deliveryId, "del-team-1");
        assert.equal(frameA2.deliveryId, "del-team-1");

        // 5. Team claim lock: both hostA1 and hostA2 race to claim del-team-1 -> exactly ONE wins
        connA1.ws.send(hostA1.claimFrame("del-team-1"));
        connA2.ws.send(hostA2.claimFrame("del-team-1"));
        const [claimA1, claimA2] = await Promise.all([connA1.nextMessage(), connA2.nextMessage()]);
        assert.equal(claimA1.ok, true);
        assert.equal(claimA2.ok, true);
        assert.equal(Number(claimA1.claimed) + Number(claimA2.claimed), 1, "exactly one team room must win the claim lock");

        // Webhook for installation 2002 (beta/secret) reaches ONLY hostB
        const betaBody = issuePayload("beta/secret", 2002, 7);
        const betaRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-github-delivery": "del-beta-1",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, betaBody),
          },
          body: betaBody,
        });
        assert.equal(betaRes.status, 202);
        assert.equal((await betaRes.json()).delivered, 1);
        const frameB = await connB.nextMessage();
        assert.equal(frameB.repository, "beta/secret");

        await sleep(120);
        assert.equal(connUnbound.messages.length, 0, "unbound room must never receive frames");

        // 6. Single-repo installation tokens: bound room gets single-repo token; unbound or cross-installation denied
        connUnbound.ws.send(unboundHost.tokenFrame("acme/app"));
        const unboundTok = await connUnbound.nextMessage();
        assert.equal(unboundTok.ok, false);
        assert.equal(unboundTok.error, "not_bound");

        connB.ws.send(hostB.tokenFrame("acme/app"));
        const crossTok = await connB.nextMessage();
        assert.equal(crossTok.ok, false);
        assert.equal(crossTok.error, "not_bound");

        const beforeMintCount = fakeGitHub.mintedRequests.length;
        connA1.ws.send(hostA1.tokenFrame("acme/app", { permissions: { issues: "write", metadata: "read" } }));
        const goodTok = await connA1.nextMessage();
        assert.equal(goodTok.ok, true);
        assert.ok(goodTok.token.startsWith("ghs_SECRET_MINTED_1001_"));
        const lastMint = fakeGitHub.mintedRequests.at(-1);
        assert.equal(fakeGitHub.mintedRequests.length, beforeMintCount + 1);
        assert.deepEqual(lastMint.body.repositories, ["app"], "minted token must be strictly scoped to a single repository");
        assert.deepEqual(lastMint.body.permissions, { issues: "write", metadata: "read" });

        // 7. installation_repositories.removed drops acme/app from installation 1001
        const removeRepoBody = JSON.stringify({
          action: "removed",
          installation: { id: 1001, account: { login: "acme", type: "Organization" }, repository_selection: "selected" },
          repositories_removed: [{ full_name: "acme/app" }],
        });
        const rmRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "installation_repositories",
            "x-github-delivery": "del-rm-repo-1",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, removeRepoBody),
          },
          body: removeRepoBody,
        });
        assert.equal(rmRes.status, 202);
        const syncedA1 = await connA1.nextMessage();
        assert.equal(syncedA1.type, "github-installations");
        assert.deepEqual(syncedA1.installations[0].repos, ["acme/docs"]);
        await connA2.nextMessage(); // syncedA2

        // Token request for removed repo is now refused
        connA1.ws.send(hostA1.tokenFrame("acme/app"));
        const removedTok = await connA1.nextMessage();
        assert.equal(removedTok.ok, false);
        assert.equal(removedTok.error, "not_bound");

        // 8. installation.deleted removes the binding entirely
        const delInstBody = JSON.stringify({
          action: "deleted",
          installation: { id: 2002, account: { login: "beta", type: "Organization" } },
        });
        const delInstRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "installation",
            "x-github-delivery": "del-inst-2002",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, delInstBody),
          },
          body: delInstBody,
        });
        assert.equal(delInstRes.status, 202);
        const syncedB = await connB.nextMessage();
        assert.equal(syncedB.type, "github-installations");
        assert.deepEqual(syncedB.installations, []);

        connB.ws.send(hostB.tokenFrame("beta/secret"));
        const deletedTok = await connB.nextMessage();
        assert.equal(deletedTok.ok, false);
        assert.equal(deletedTok.error, "not_bound");

        // 9. Verify no OAuth user tokens, minted installation tokens, or client secret appear in logs
        const logs = getLogs();
        assert.ok(!logs.includes("ghu_ALICE_SECRET_ONCE"), "user OAuth token must never appear in logs");
        assert.ok(!logs.includes("ghs_SECRET_MINTED_"), "minted installation token must never appear in logs");
        assert.ok(!logs.includes(CLIENT_SECRET), "OAuth client secret must never appear in logs");
      } finally {
        await Promise.all([connA1.close(), connA2.close(), connB.close(), connUnbound.close()]);
      }
    });

    it("enforces per-room org repo isolation (selected and all), clamps read-only tokens, prevents narrower bind from shrinking other rooms, ignores auto-added repos until re-verify, and revokes on member_removed", async () => {
      const { base, fakeGitHub } = getTarget();

      const adminSel = await makeHostIdentity();
      const readerSel = await makeHostIdentity();
      const adminAll = await makeHostIdentity();
      const readerAll = await makeHostIdentity();

      const connAdminSel = await openHostSocket(base, adminSel);
      const connReaderSel = await openHostSocket(base, readerSel);
      const connAdminAll = await openHostSocket(base, adminAll);
      const connReaderAll = await openHostSocket(base, readerAll);

      try {
        // 1. Admin binds selected org (3001) with access to public-one + private-secret
        const r1 = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=3001&code=code_org_admin_selected&state=${encodeURIComponent(adminSel.setupState())}`,
        );
        assert.equal(r1.status, 200);
        const pushAdminSel = await connAdminSel.nextMessage();
        assert.deepEqual(pushAdminSel.installations[0].repos, ["orgsel/private-secret", "orgsel/public-one"]);
        assert.equal(pushAdminSel.installations[0].installerLogin, "org-admin");

        // 2. Narrower read-only org member binds the SAME installation (3001) with ONLY orgsel/public-one (read-only)
        const r2 = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=3001&code=code_org_reader_selected&state=${encodeURIComponent(readerSel.setupState())}`,
        );
        assert.equal(r2.status, 200);
        const pushReaderSel = await connReaderSel.nextMessage();
        assert.deepEqual(pushReaderSel.installations[0].repos, ["orgsel/public-one"]);
        assert.equal(pushReaderSel.installations[0].installerLogin, "org-reader");

        // 3. First room (adminSel) MUST NOT have lost orgsel/private-secret after readerSel bound
        connAdminSel.ws.send(adminSel.listInstallationsFrame());
        const adminListAfter = await connAdminSel.nextMessage();
        assert.deepEqual(adminListAfter.installations[0].repos, ["orgsel/private-secret", "orgsel/public-one"]);

        // 4. Read-only member trying to subscribe to orgsel/private-secret is DENIED; only public-one allowed
        connReaderSel.ws.send(readerSel.subscribeFrame(["orgsel/public-one", "orgsel/private-secret"]));
        const readerSub = await connReaderSel.nextMessage();
        assert.deepEqual(readerSub.allowed, ["orgsel/public-one"]);
        assert.deepEqual(readerSub.denied, ["orgsel/private-secret"]);

        // Admin can subscribe to both
        connAdminSel.ws.send(adminSel.subscribeFrame(["orgsel/public-one", "orgsel/private-secret"]));
        const adminSub = await connAdminSel.nextMessage();
        assert.deepEqual(adminSub.allowed, ["orgsel/private-secret", "orgsel/public-one"]);

        // Webhook for orgsel/private-secret reaches ONLY adminSel, NEVER readerSel
        const privSelBody = issuePayload("orgsel/private-secret", 3001, 91);
        const privSelRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-github-delivery": "del-orgsel-priv-1",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, privSelBody),
          },
          body: privSelBody,
        });
        assert.equal(privSelRes.status, 202);
        assert.equal((await privSelRes.json()).delivered, 1);
        const adminFrame = await connAdminSel.nextMessage();
        assert.equal(adminFrame.repository, "orgsel/private-secret");
        await sleep(100);
        assert.equal(connReaderSel.messages.length, 0, "read-only org member must not receive private repo events (selected)");

        // Read-only member asking for token on orgsel/private-secret is DENIED
        connReaderSel.ws.send(readerSel.tokenFrame("orgsel/private-secret"));
        const readerPrivTok = await connReaderSel.nextMessage();
        assert.equal(readerPrivTok.ok, false);
        assert.equal(readerPrivTok.error, "not_bound");

        // Read-only member asking for contents/issues/pull_requests WRITE on orgsel/public-one is CLAMPED to read
        connReaderSel.ws.send(
          readerSel.tokenFrame("orgsel/public-one", {
            permissions: { contents: "write", issues: "write", metadata: "read", pull_requests: "write" },
          }),
        );
        const readerPubTok = await connReaderSel.nextMessage();
        assert.equal(readerPubTok.ok, true);
        const readerMint = fakeGitHub.mintedRequests.at(-1);
        assert.deepEqual(readerMint.body.repositories, ["public-one"]);
        assert.deepEqual(readerMint.body.permissions, {
          contents: "read",
          issues: "read",
          metadata: "read",
          pull_requests: "read",
        });

        // Admin asking for write on orgsel/private-secret still gets write
        connAdminSel.ws.send(
          adminSel.tokenFrame("orgsel/private-secret", {
            permissions: { contents: "write", issues: "write", metadata: "read" },
          }),
        );
        const adminPrivTok = await connAdminSel.nextMessage();
        assert.equal(adminPrivTok.ok, true);
        assert.deepEqual(fakeGitHub.mintedRequests.at(-1).body.permissions, {
          contents: "write",
          issues: "write",
          metadata: "read",
        });

        // 5. Same isolation check when repository_selection === "all" (installation 3002)
        assert.equal(
          (await fetch(`${base}${GITHUB_SETUP_PATH}?installation_id=3002&code=code_org_admin_all&state=${encodeURIComponent(adminAll.setupState())}`)).status,
          200,
        );
        await connAdminAll.nextMessage();
        assert.equal(
          (await fetch(`${base}${GITHUB_SETUP_PATH}?installation_id=3002&code=code_org_reader_all&state=${encodeURIComponent(readerAll.setupState())}`)).status,
          200,
        );
        await connReaderAll.nextMessage();

        connReaderAll.ws.send(readerAll.subscribeFrame(["orgall/public-one", "orgall/private-secret"]));
        const readerAllSub = await connReaderAll.nextMessage();
        assert.deepEqual(readerAllSub.allowed, ["orgall/public-one"]);
        assert.deepEqual(readerAllSub.denied, ["orgall/private-secret"]);

        connAdminAll.ws.send(adminAll.subscribeFrame(["orgall/private-secret"]));
        assert.deepEqual((await connAdminAll.nextMessage()).allowed, ["orgall/private-secret"]);

        // Private repo webhook in "all" org reaches ONLY adminAll, NEVER readerAll
        const privAllBody = issuePayload("orgall/private-secret", 3002, 92);
        const privAllRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-github-delivery": "del-orgall-priv-1",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, privAllBody),
          },
          body: privAllBody,
        });
        assert.equal(privAllRes.status, 202);
        assert.equal((await privAllRes.json()).delivered, 1);
        assert.equal((await connAdminAll.nextMessage()).repository, "orgall/private-secret");
        await sleep(100);
        assert.equal(connReaderAll.messages.length, 0, "read-only org member must not receive private repo events (all)");

        // Read-only member in "all" org cannot mint token for private repo
        connReaderAll.ws.send(readerAll.tokenFrame("orgall/private-secret"));
        const readerAllPrivTok = await connReaderAll.nextMessage();
        assert.equal(readerAllPrivTok.ok, false);
        assert.equal(readerAllPrivTok.error, "not_bound");

        // 6. installation_repositories "added" must NOT grant existing rooms access until they re-verify
        const addRepoBody = JSON.stringify({
          action: "added",
          installation: { id: 3001, account: { login: "orgsel", type: "Organization" }, repository_selection: "selected" },
          repositories_added: [{ full_name: "orgsel/newly-added" }],
        });
        const addRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "installation_repositories",
            "x-github-delivery": "del-add-repo-3001",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, addRepoBody),
          },
          body: addRepoBody,
        });
        assert.equal(addRes.status, 202);
        // Drain pushed installation updates
        const pushAfterAddAdmin = await connAdminSel.nextMessage();
        assert.ok(!pushAfterAddAdmin.installations[0].repos.includes("orgsel/newly-added"));
        const pushAfterAddReader = await connReaderSel.nextMessage();
        assert.ok(!pushAfterAddReader.installations[0].repos.includes("orgsel/newly-added"));

        // Neither room can subscribe to or mint a token for orgsel/newly-added before re-verifying
        connAdminSel.ws.send(adminSel.subscribeFrame(["orgsel/newly-added"]));
        assert.deepEqual((await connAdminSel.nextMessage()).allowed, []);
        connAdminSel.ws.send(adminSel.tokenFrame("orgsel/newly-added"));
        assert.equal((await connAdminSel.nextMessage()).ok, false);

        // Webhook for orgsel/newly-added does not reach either room
        const addedEvBody = issuePayload("orgsel/newly-added", 3001, 93);
        const addedEvRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-github-delivery": "del-added-before-reauth",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, addedEvBody),
          },
          body: addedEvBody,
        });
        assert.equal(addedEvRes.status, 204);

        // Once adminSel re-verifies via OAuth setup, adminSel gets orgsel/newly-added; readerSel still does NOT
        const reverify = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=3001&code=code_org_admin_selected_with_added&state=${encodeURIComponent(adminSel.setupState())}`,
        );
        assert.equal(reverify.status, 200);
        const reverifiedPush = await connAdminSel.nextMessage();
        assert.ok(reverifiedPush.installations[0].repos.includes("orgsel/newly-added"));

        connAdminSel.ws.send(adminSel.subscribeFrame(["orgsel/newly-added"]));
        assert.deepEqual((await connAdminSel.nextMessage()).allowed, ["orgsel/newly-added"]);
        connReaderSel.ws.send(readerSel.subscribeFrame(["orgsel/newly-added"]));
        assert.deepEqual((await connReaderSel.nextMessage()).allowed, []);

        // 7. organization.member_removed expires ONLY the removed member's room binding (readerSel), leaving adminSel active
        const memberRemovedBody = JSON.stringify({
          action: "member_removed",
          installation: { id: 3001, account: { login: "orgsel", type: "Organization" } },
          organization: { login: "orgsel" },
          membership: { user: { login: "org-reader" } },
        });
        const remRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "organization",
            "x-github-delivery": "del-org-member-removed-1",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, memberRemovedBody),
          },
          body: memberRemovedBody,
        });
        assert.equal(remRes.status, 202);
        const readerExpiredPush = await connReaderSel.nextMessage();
        assert.equal(readerExpiredPush.type, "github-installations");
        assert.equal(readerExpiredPush.installations[0].expired, true);
        assert.deepEqual(readerExpiredPush.installations[0].repos, []);

        // Removed member can no longer mint tokens or receive events
        connReaderSel.ws.send(readerSel.tokenFrame("orgsel/public-one"));
        assert.equal((await connReaderSel.nextMessage()).ok, false);
        // Admin is unaffected
        connAdminSel.ws.send(adminSel.tokenFrame("orgsel/newly-added"));
        assert.equal((await connAdminSel.nextMessage()).ok, true);
      } finally {
        await Promise.all([connAdminSel.close(), connReaderSel.close(), connAdminAll.close(), connReaderAll.close()]);
      }
    });

    it("bound RelayHost subscribes with no user token, gets its bound repos, and receives frames even when unbound fallback opt-in is on", async () => {
      const { base, getLogs } = getTarget();
      const waitFor = async (fn, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (fn()) return;
          await sleep(25);
        }
        throw new Error("Timed out waiting for condition");
      };

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
          return { githubToken: "gho_must_never_be_sent_when_bound" };
        },
        githubAllowUserTokenProof: true,
        WebSocket: RecordingWebSocket,
      });

      host.start();
      try {
        await waitFor(() => host.connected);

        // Bind installation 1001 to this RelayHost's room
        const { url: installUrl } = host.createGithubInstallUrl("botkins-agent");
        const stateParam = new URL(installUrl).searchParams.get("state");
        const bindRes = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=1001&code=code_alice_inst1&state=${encodeURIComponent(stateParam)}`,
        );
        assert.equal(bindRes.status, 200);
        await waitFor(() => host.hasLiveGithubBinding());

        // Subscribe via RelayHost: must send NO githubToken even though githubAllowUserTokenProof is true
        host.setGithubRepos(["acme/app", "beta/secret"]);
        await waitFor(() => acks.length >= 1);

        assert.equal(proofCalls, 0, "bound host must never invoke user-token proof provider");
        assert.equal(sentSubFrames.length, 1);
        assert.equal(sentSubFrames[0].githubToken, undefined, "bound host must send no githubToken on github-subscribe");
        assert.deepEqual(acks[0].allowed, ["acme/app"]);
        assert.deepEqual(acks[0].denied, ["beta/secret"]);

        // Webhook for acme/app arrives at the bound RelayHost
        const deliveryId = `del-bound-host-${randomBytes(4).toString("hex")}`;
        const body = issuePayload("acme/app", 1001, 77);
        const res = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-github-delivery": deliveryId,
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, body),
          },
          body,
        });
        assert.equal(res.status, 202);
        await waitFor(() => deliveries.some((d) => d.deliveryId === deliveryId));
        const frame = deliveries.find((d) => d.deliveryId === deliveryId);
        assert.equal(frame.repository, "acme/app");
        assert.ok(!getLogs().includes("gho_must_never_be_sent_when_bound"));
      } finally {
        host.stop();
      }
    });
  });
}

/** Runs binding-expiry tests against a short-TTL instance (both Cloudflare Worker and Node relay). */
function runExpirySuite(name, getShortTtlTarget) {
  describe(`GitHub binding expiry on ${name}`, () => {
    it("stops events and token minting once a per-room binding expires, and resumes after re-authorization", async () => {
      const { base } = getShortTtlTarget();
      const host = await makeHostIdentity();
      const conn = await openHostSocket(base, host);
      try {
        // Bind installation 1001 with short TTL (~400ms)
        const bindRes = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=1001&code=code_alice_inst1&state=${encodeURIComponent(host.setupState())}`,
        );
        assert.equal(bindRes.status, 200);
        const push1 = await conn.nextMessage();
        assert.equal(push1.installations[0].expired, false);
        assert.ok(push1.installations[0].expiresAt > Date.now());

        // Subscribe and verify token works before expiry
        conn.ws.send(host.subscribeFrame(["acme/app"]));
        assert.deepEqual((await conn.nextMessage()).allowed, ["acme/app"]);
        conn.ws.send(host.tokenFrame("acme/app"));
        assert.equal((await conn.nextMessage()).ok, true);

        // Wait for binding to expire
        await sleep(550);

        // Expired binding stops webhook deliveries even though the 300s repo subscription has not expired yet
        const expiredEvBody = issuePayload("acme/app", 1001, 501);
        const expiredEvRes = await fetch(`${base}${GITHUB_EVENTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-github-delivery": "del-after-expiry-1",
            "x-hub-signature-256": hmacHeader(WEBHOOK_SECRET, expiredEvBody),
          },
          body: expiredEvBody,
        });
        assert.equal(expiredEvRes.status, 204);
        await sleep(80);
        assert.equal(conn.messages.length, 0, "expired binding must stop events");

        // Expired binding denies token minting
        conn.ws.send(host.tokenFrame("acme/app"));
        const expTok = await conn.nextMessage();
        assert.equal(expTok.ok, false);
        assert.equal(expTok.error, "not_bound");

        // Expired binding denies new subscriptions
        conn.ws.send(host.subscribeFrame(["acme/app"]));
        assert.deepEqual((await conn.nextMessage()).allowed, []);

        // Listing installations reports expired: true so host UI prompts re-authorization
        conn.ws.send(host.listInstallationsFrame());
        const listed = await conn.nextMessage();
        assert.equal(listed.installations[0].expired, true);
        assert.deepEqual(listed.installations[0].repos, []);

        // Re-authorizing restores events and tokens
        const rebindRes = await fetch(
          `${base}${GITHUB_SETUP_PATH}?installation_id=1001&code=code_alice_inst1&state=${encodeURIComponent(host.setupState())}`,
        );
        assert.equal(rebindRes.status, 200);
        const push2 = await conn.nextMessage();
        assert.equal(push2.installations[0].expired, false);
        assert.deepEqual(push2.installations[0].repos, ["acme/app", "acme/docs"]);

        conn.ws.send(host.tokenFrame("acme/app"));
        assert.equal((await conn.nextMessage()).ok, true);
      } finally {
        await conn.close();
      }
    });
  });
}

// ---- Cloudflare Worker (wrangler dev) target ---------------------------------------------------

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
  const dir = mkdtempSync(path.join(tmpdir(), "botkins-gh-agent-"));
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

let workerFakeGh;
let workerDev;
let workerShortTtlDev;

before(async () => {
  workerFakeGh = await startFakeGitHubAppServer({
    appId: APP_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    codes: FAKE_CODES,
    installations: FAKE_INSTALLATIONS,
  });
  workerDev = await startDev({
    RATE_LIMITS: "off",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_AGENT_APP_ID: APP_ID,
    GITHUB_AGENT_APP_SLUG: "botkins-agent",
    GITHUB_AGENT_APP_KEY: APP_PEM,
    GITHUB_AGENT_CLIENT_ID: CLIENT_ID,
    GITHUB_AGENT_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_API_BASE: workerFakeGh.base,
    GITHUB_WEB_BASE: workerFakeGh.base,
  });
  workerShortTtlDev = await startDev({
    RATE_LIMITS: "off",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_AGENT_APP_ID: APP_ID,
    GITHUB_AGENT_APP_SLUG: "botkins-agent",
    GITHUB_AGENT_APP_KEY: APP_PEM,
    GITHUB_AGENT_CLIENT_ID: CLIENT_ID,
    GITHUB_AGENT_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_API_BASE: workerFakeGh.base,
    GITHUB_WEB_BASE: workerFakeGh.base,
    GITHUB_BINDING_TTL_MS: "400",
  });
});

after(() => {
  stopAll();
  workerFakeGh?.close();
});

runRelayProductSuite("Cloudflare Worker (wrangler dev)", () => ({
  base: workerDev.base,
  fakeGitHub: workerFakeGh,
  getLogs: () => workerDev.output,
}));

runExpirySuite("Cloudflare Worker (wrangler dev)", () => ({
  base: workerShortTtlDev.base,
}));

// ---- Self-hosted Node relay target -------------------------------------------------------------

let nodeFakeGh;
let nodeServer;
let nodeBase;
let nodeShortServer;
let nodeShortBase;
let nodeDir;
let nodeShortDir;
let nodeLogs = "";
const origLog = console.log;

describe("Node relay setup & teardown", () => {
  before(async () => {
    nodeDir = mkdtempSync(path.join(tmpdir(), "botkins-node-gh-agent-"));
    nodeShortDir = mkdtempSync(path.join(tmpdir(), "botkins-node-gh-agent-ttl-"));
    nodeFakeGh = await startFakeGitHubAppServer({
      appId: APP_ID,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      codes: FAKE_CODES,
      installations: FAKE_INSTALLATIONS,
    });
    nodeLogs = "";
    console.log = (...args) => {
      nodeLogs += args.join(" ") + "\n";
    };
    nodeServer = createRelay({
      dataDir: nodeDir,
      limits: false,
      githubWebhookSecret: WEBHOOK_SECRET,
      githubAgentAppId: APP_ID,
      githubAgentAppSlug: "botkins-agent",
      githubAgentAppKey: APP_PEM,
      githubAgentClientId: CLIENT_ID,
      githubAgentClientSecret: CLIENT_SECRET,
      githubApiBase: nodeFakeGh.base,
      githubWebBase: nodeFakeGh.base,
    });
    await new Promise((res) => nodeServer.listen(0, "127.0.0.1", res));
    nodeBase = `http://127.0.0.1:${nodeServer.address().port}`;

    nodeShortServer = createRelay({
      dataDir: nodeShortDir,
      limits: false,
      githubWebhookSecret: WEBHOOK_SECRET,
      githubAgentAppId: APP_ID,
      githubAgentAppSlug: "botkins-agent",
      githubAgentAppKey: APP_PEM,
      githubAgentClientId: CLIENT_ID,
      githubAgentClientSecret: CLIENT_SECRET,
      githubApiBase: nodeFakeGh.base,
      githubWebBase: nodeFakeGh.base,
      githubBindingTtlMs: 400,
    });
    await new Promise((res) => nodeShortServer.listen(0, "127.0.0.1", res));
    nodeShortBase = `http://127.0.0.1:${nodeShortServer.address().port}`;
  });

  after(() => {
    console.log = origLog;
    nodeServer?.closeAllConnections?.();
    nodeServer?.close();
    nodeShortServer?.closeAllConnections?.();
    nodeShortServer?.close();
    nodeFakeGh?.close();
    rmSync(nodeDir, { recursive: true, force: true });
    rmSync(nodeShortDir, { recursive: true, force: true });
  });

  runRelayProductSuite("Self-hosted Node relay (node/server.mjs)", () => ({
    base: nodeBase,
    fakeGitHub: nodeFakeGh,
    getLogs: () => nodeLogs,
  }));

  runExpirySuite("Self-hosted Node relay (node/server.mjs)", () => ({
    base: nodeShortBase,
  }));
});
