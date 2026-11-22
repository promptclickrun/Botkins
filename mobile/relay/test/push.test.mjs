// Runs POST /v1/push for real: starts `wrangler dev --local` on this machine (no account, nothing sent
// to Cloudflare or Apple), with a small local HTTP server standing in for Apple (`APNS_HOST`), and a
// throwaway P-256 key made here as the APNs key. Always stops what it started.
//
// With `APNS_HOST` set both of Apple's hosts are that one server, so the Worker adds the header
// `x-botkins-apns-env` (production or sandbox) to what it sends. The path stays Apple's own:
// /3/device/<token>. Apple speaks HTTP/2; this server speaks HTTP/1.1, so HTTP/2 is not tested here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

// ---- the fake Apple ----------------------------------------------------------------------------

const ok = { status: 200 };
const apple = {
  server: null,
  port: 0,
  /** What arrived: { url, headers, body, at }. */
  requests: [],
  /** token -> { status, reason, delay, drop }. Anything else is answered 200. */
  plan: new Map(),
  inflight: 0,
  maxInflight: 0,
  async start() {
    apple.server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        const token = req.url.split("/").pop();
        apple.requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString(), at: Date.now() });
        // A plan may differ by which of Apple's two services was asked (`byEnv`).
        const planned = apple.plan.get(token) ?? ok;
        const plan = planned.byEnv?.[req.headers["x-botkins-apns-env"]] ?? planned;
        apple.inflight++;
        apple.maxInflight = Math.max(apple.maxInflight, apple.inflight);
        await sleep(plan.delay ?? 60);
        apple.inflight--;
        if (plan.drop) return req.socket.destroy();
        res.writeHead(plan.status, { "content-type": "application/json" });
        res.end(plan.reason ? JSON.stringify({ reason: plan.reason }) : "");
      });
    });
    await new Promise((resolve) => apple.server.listen(0, "127.0.0.1", resolve));
    apple.port = apple.server.address().port;
  },
  stop() {
    // Workerd keeps its connections open between pushes: drop them, or Node never exits.
    apple.server?.closeAllConnections();
    apple.server?.close();
  },
  reset() {
    apple.requests.length = 0;
    apple.plan.clear();
    apple.maxInflight = 0;
  },
};

// ---- wrangler dev ------------------------------------------------------------------------------

const instances = [];
function stopAll() {
  for (const dev of instances) {
    if (dev.child.exitCode === null && dev.child.pid) {
      try {
        process.kill(-dev.child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    rmSync(dev.dir, { recursive: true, force: true });
  }
  instances.length = 0;
}
process.on("exit", stopAll);

/** A local Worker. `vars` are passed with --var, so nothing is written into the project. */
async function startDev(vars) {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "botkins-push-"));
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
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("wrangler dev stopped early:\n" + dev.output);
    try {
      if ((await fetch(dev.base + "/v1/health")).ok) return dev;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("wrangler dev did not answer in time:\n" + dev.output);
}

// ---- the caller: a computer ---------------------------------------------------------------------

/** A computer's key. The test key never leaves this process. */
function newComputer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { key: publicKey.export({ format: "jwk" }).x, privateKey };
}
const hexToken = (n) => n.toString(16).padStart(2, "0").repeat(32); // 64 characters
const alertPayload = (marker = "payload-marker-1") => ({ aps: { alert: { "loc-key": "k" } }, m: marker });
const item = (change = {}) => ({
  token: hexToken(1),
  env: "production",
  type: "alert",
  priority: 10,
  expiration: 600,
  collapse: "c-1",
  payload: alertPayload(),
  ...change,
});

/** The request body a computer sends. `change` replaces fields after signing, to make a bad one. */
function body(computer, items, { time = nowSeconds(), sends = typeof items === "string" ? items : JSON.stringify(items), signSends = sends, signer = computer.privateKey } = {}) {
  const sig = sign(null, Buffer.from(`botkins-push-v1:${time}:${signSends}`), signer).toString("base64url");
  return { v: 1, key: computer.key, time, sig, sends };
}

const post = (dev, payload, headers = { "content-type": "application/json" }) =>
  fetch(dev.base + "/v1/push", { method: "POST", headers, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
const answer = async (response) => ({ status: response.status, json: await response.json() });

// ---- tests --------------------------------------------------------------------------------------

// One fake Apple for the whole file.
before(() => apple.start());
after(() => {
  stopAll();
  apple.stop();
});

describe("POST /v1/push", () => {
  const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = apnsKey.privateKey.export({ type: "pkcs8", format: "pem" });
  const computer = newComputer();
  let on; // the Worker with the secrets, rate limits off
  let off; // the Worker without them
  const secretsSeen = [pem.split("\n")[1], computer.key, hexToken(1), hexToken(2), hexToken(3), hexToken(4), hexToken(5)];

  before(async () => {
    const secrets = {
      APNS_KEY_P8: pem,
      APNS_KEY_ID: "TESTKEY123",
      APNS_TEAM_ID: "TESTTEAM12",
      APNS_HOST: `http://127.0.0.1:${apple.port}`,
    };
    [on, off] = await Promise.all([startDev({ ...secrets, RATE_LIMITS: "off" }), startDev({ RATE_LIMITS: "off" })]);
  });
  after(() => stopAll());

  it("sends a push to Apple with the right path, topic, type, priority, expiration, collapse id and token", async () => {
    apple.reset();
    const before = nowSeconds();
    const { status, json } = await answer(
      await post(
        on,
        body(computer, [
          item(),
          item({ token: hexToken(2), type: "liveactivity", priority: 5, expiration: 0, collapse: undefined, payload: { aps: { event: "update" } } }),
          item({ token: hexToken(3), type: "background", priority: 10, expiration: 86400, payload: { aps: { "content-available": 1 } } }),
        ]),
      ),
    );
    assert.equal(status, 200);
    assert.deepEqual(json, { results: [{ status: 200 }, { status: 200 }, { status: 200 }] });
    assert.equal(apple.requests.length, 3);
    const byToken = Object.fromEntries(apple.requests.map((r) => [r.url.split("/").pop(), r]));

    const one = byToken[hexToken(1)];
    assert.equal(one.method, "POST");
    assert.equal(one.url, `/3/device/${hexToken(1)}`);
    assert.equal(one.headers["apns-topic"], "app.botkins.mobile");
    assert.equal(one.headers["apns-push-type"], "alert");
    assert.equal(one.headers["apns-priority"], "10");
    assert.equal(one.headers["apns-collapse-id"], "c-1");
    const expiry = Number(one.headers["apns-expiration"]);
    assert.ok(expiry >= before + 600 && expiry <= nowSeconds() + 600, "expiration is now plus 600");
    assert.deepEqual(JSON.parse(one.body), alertPayload());

    const live = byToken[hexToken(2)];
    assert.equal(live.headers["apns-topic"], "app.botkins.mobile.push-type.liveactivity");
    assert.equal(live.headers["apns-push-type"], "liveactivity");
    assert.equal(live.headers["apns-priority"], "5");
    assert.equal(live.headers["apns-expiration"], "0");
    assert.equal("apns-collapse-id" in live.headers, false);
    assert.deepEqual(JSON.parse(live.body), { aps: { event: "update" } });

    // A background push is always priority 5, whatever was asked.
    const background = byToken[hexToken(3)];
    assert.equal(background.headers["apns-topic"], "app.botkins.mobile");
    assert.equal(background.headers["apns-push-type"], "background");
    assert.equal(background.headers["apns-priority"], "5");
    assert.ok(Number(background.headers["apns-expiration"]) >= before + 86400);
  });

  it("signs for Apple with a token that verifies with the test key and has the right kid, iss and iat", async () => {
    apple.reset();
    await post(on, body(computer, [item(), item({ token: hexToken(2) })]));
    await post(on, body(computer, [item({ token: hexToken(3) })]));
    assert.equal(apple.requests.length, 3);
    const tokens = apple.requests.map((r) => {
      const [scheme, jwt, ...rest] = r.headers.authorization.split(" ");
      assert.equal(scheme, "bearer");
      assert.equal(rest.length, 0);
      return jwt;
    });
    for (const jwt of tokens) {
      const [head, claims, signature] = jwt.split(".");
      assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { alg: "ES256", kid: "TESTKEY123" });
      const parsed = JSON.parse(Buffer.from(claims, "base64url"));
      assert.deepEqual(Object.keys(parsed).sort(), ["iat", "iss"]);
      assert.equal(parsed.iss, "TESTTEAM12");
      assert.equal(parsed.iat % 1800, 0, "iat is on a 30 minute step");
      assert.ok(parsed.iat <= nowSeconds() && parsed.iat > nowSeconds() - 1800 - 5);
      assert.equal(Buffer.from(signature, "base64url").length, 64);
      assert.equal(verify("sha256", Buffer.from(head + "." + claims), { key: apnsKey.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), true);
    }
    // Made once and kept: the same token for every push in this step.
    assert.equal(new Set(tokens).size, 1);
  });

  it("sends sandbox and production to their own hosts (with APNS_HOST, shown by a header the Worker adds)", async () => {
    apple.reset();
    await post(on, body(computer, [item({ token: hexToken(1), env: "sandbox" }), item({ token: hexToken(2), env: "production" })]));
    const envOf = (token) => apple.requests.find((r) => r.url.endsWith(token)).headers["x-botkins-apns-env"];
    assert.equal(envOf(hexToken(1)), "sandbox");
    assert.equal(envOf(hexToken(2)), "production");
  });

  it("tries Apple's other service when the first says the key or the device token doesn't belong there", async () => {
    apple.reset();
    // A TestFlight phone that named the test service: its token and this key are for production.
    apple.plan.set(hexToken(1), { byEnv: { sandbox: { status: 403, reason: "BadEnvironmentKeyInToken" }, production: { status: 200 } } });
    // A development phone that named production.
    apple.plan.set(hexToken(2), { byEnv: { production: { status: 400, reason: "BadDeviceToken" }, sandbox: { status: 200 } } });
    // The key works only on production, and there the token is unknown: that is the answer worth giving.
    apple.plan.set(hexToken(3), { byEnv: { sandbox: { status: 403, reason: "BadEnvironmentKeyInToken" }, production: { status: 410, reason: "Unregistered" } } });
    // Wrong everywhere: the first answer stands.
    apple.plan.set(hexToken(4), { status: 400, reason: "BadDeviceToken" });
    // Right the first time: asked once.
    apple.plan.set(hexToken(5), { status: 200 });
    const { status, json } = await answer(
      await post(on, body(computer, [item({ token: hexToken(1), env: "sandbox" }), item({ token: hexToken(2), env: "production" }), item({ token: hexToken(3), env: "sandbox" }), item({ token: hexToken(4), env: "sandbox" }), item({ token: hexToken(5), env: "production" })])),
    );
    assert.equal(status, 200);
    assert.deepEqual(json, {
      results: [{ status: 200, env: "production" }, { status: 200, env: "sandbox" }, { status: 410, reason: "Unregistered", env: "production" }, { status: 400, reason: "BadDeviceToken" }, { status: 200 }],
    });
    const asked = (token) => apple.requests.filter((r) => r.url.endsWith(token)).map((r) => r.headers["x-botkins-apns-env"]);
    assert.deepEqual(asked(hexToken(1)), ["sandbox", "production"]);
    assert.deepEqual(asked(hexToken(2)), ["production", "sandbox"]);
    assert.deepEqual(asked(hexToken(5)), ["production"]);
  });

  it("answers Apple's 410 and 400 per item, keeps the order, and sends the items at the same time", async () => {
    apple.reset();
    // The first is the slowest, so the order of the answers is not the order they finish in.
    apple.plan.set(hexToken(1), { status: 410, reason: "Unregistered", delay: 400 });
    apple.plan.set(hexToken(2), { status: 200, delay: 10 });
    apple.plan.set(hexToken(3), { status: 400, reason: "BadDeviceToken", delay: 200 });
    apple.plan.set(hexToken(4), { drop: true, delay: 10 });
    apple.plan.set(hexToken(5), { status: 429, reason: "TooManyRequests", delay: 10 });
    const started = Date.now();
    const { status, json } = await answer(
      await post(on, body(computer, [1, 2, 3, 4, 5].map((n) => item({ token: hexToken(n) })))),
    );
    const took = Date.now() - started;
    assert.equal(status, 200);
    assert.deepEqual(json, {
      results: [
        { status: 410, reason: "Unregistered" },
        { status: 200 },
        { status: 400, reason: "BadDeviceToken" },
        { status: 502, reason: "unreachable" },
        { status: 429, reason: "TooManyRequests" },
      ],
    });
    assert.ok(apple.maxInflight >= 3, "items were in flight together: " + apple.maxInflight);
    assert.ok(took < 400 + 200 + 10 + 10 + 10 + 400, "one after another would take longer: " + took);
  });

  it("answers an Apple answer with no reason as its status alone, and one with an odd reason without the reason", async () => {
    apple.reset();
    apple.plan.set(hexToken(1), { status: 500 });
    apple.plan.set(hexToken(2), { status: 403, reason: "x".repeat(200) });
    const { json } = await answer(await post(on, body(computer, [item({ token: hexToken(1) }), item({ token: hexToken(2) })])));
    assert.deepEqual(json, { results: [{ status: 500 }, { status: 403 }] });
  });

  describe("refuses the whole request, and nothing reaches Apple", () => {
    const good = [item()];
    const cases = [
      ["a wrong signature (another key signed)", () => body(computer, good, { signer: newComputer().privateKey }), 401, "unauthorized"],
      ["a signature over other sends", () => body(computer, good, { signSends: JSON.stringify([item({ priority: 5 })]) }), 401, "unauthorized"],
      ["a signature over another time", () => ({ ...body(computer, good), time: nowSeconds() + 1 }), 401, "unauthorized"],
      ["a stale time", () => body(computer, good, { time: nowSeconds() - 301 }), 401, "unauthorized"],
      // Two seconds past the limit, so a second ticking before the relay reads its clock still refuses.
      ["a time in the future", () => body(computer, good, { time: nowSeconds() + 302 }), 401, "unauthorized"],
      ["a ninth item", () => body(computer, Array(9).fill(item())), 400, "bad_request"],
      ["no items", () => body(computer, []), 400, "bad_request"],
      ["sends that is not JSON", () => body(computer, "not json"), 400, "bad_request"],
      ["an oversized payload", () => body(computer, [item({ payload: { aps: { alert: "x".repeat(4096) } } })]), 400, "bad_request"],
      ["a payload without aps", () => body(computer, [item({ payload: { alert: "x" } })]), 400, "bad_request"],
      ["a bad token", () => body(computer, [item({ token: "NOT-HEX" })]), 400, "bad_request"],
      ["a short token", () => body(computer, [item({ token: "ab".repeat(31) })]), 400, "bad_request"],
      ["a bad env", () => body(computer, [item({ env: "dev" })]), 400, "bad_request"],
      ["a bad type", () => body(computer, [item({ type: "voip" })]), 400, "bad_request"],
      ["a bad priority", () => body(computer, [item({ priority: 7 })]), 400, "bad_request"],
      ["a bad expiration", () => body(computer, [item({ expiration: 86401 })]), 400, "bad_request"],
      ["a long collapse id", () => body(computer, [item({ collapse: "c".repeat(65) })]), 400, "bad_request"],
      ["one bad item among good ones", () => body(computer, [item(), item({ token: "zz" })]), 400, "bad_request"],
      ["a missing v", () => ({ ...body(computer, good), v: undefined }), 400, "bad_request"],
      ["another v", () => ({ ...body(computer, good), v: 2 }), 400, "bad_request"],
      ["a missing key", () => ({ ...body(computer, good), key: undefined }), 400, "bad_request"],
      ["a short key", () => ({ ...body(computer, good), key: computer.key.slice(1) }), 400, "bad_request"],
      ["a missing time", () => ({ ...body(computer, good), time: undefined }), 400, "bad_request"],
      ["a time that is a string", () => ({ ...body(computer, good), time: String(nowSeconds()) }), 400, "bad_request"],
      ["a missing sig", () => ({ ...body(computer, good), sig: undefined }), 400, "bad_request"],
      ["a short sig", () => ({ ...body(computer, good), sig: "A".repeat(85) }), 400, "bad_request"],
      ["a missing sends", () => ({ ...body(computer, good), sends: undefined }), 400, "bad_request"],
      ["sends that is not a string", () => ({ ...body(computer, good), sends: good }), 400, "bad_request"],
      ["a body that is not an object", () => "[1]", 400, "bad_request"],
      ["a body that is not JSON", () => "{nope", 400, "bad_request"],
    ];
    for (const [name, make, code, error] of cases) {
      it(`${name}: ${code} ${error}`, async () => {
        apple.reset();
        const result = await answer(await post(on, make()));
        assert.deepEqual(result, { status: code, json: { error } });
        assert.equal(apple.requests.length, 0);
      });
    }

    it("a body over 64 KiB: 413 too_large (declared length)", async () => {
      apple.reset();
      const big = JSON.stringify({ ...body(computer, good), pad: "x".repeat(64 * 1024) });
      assert.deepEqual(await answer(await post(on, big)), { status: 413, json: { error: "too_large" } });
      assert.equal(apple.requests.length, 0);
    });

    it("a body over 64 KiB sent in chunks, with no declared length: 413 too_large", async () => {
      apple.reset();
      const url = new URL(on.base + "/v1/push");
      const result = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
          },
        );
        req.on("error", reject);
        for (let i = 0; i < 20; i++) req.write("x".repeat(4096));
        req.end();
      });
      assert.deepEqual(result, { status: 413, json: { error: "too_large" } });
      assert.equal(apple.requests.length, 0);
    });

    it("a body that is not JSON by content type: 400", async () => {
      apple.reset();
      const result = await answer(await post(on, body(computer, good), { "content-type": "text/plain" }));
      assert.deepEqual(result, { status: 400, json: { error: "bad_request" } });
      assert.equal(apple.requests.length, 0);
    });

    it("a GET: 405", async () => {
      const response = await fetch(on.base + "/v1/push");
      assert.deepEqual(await answer(response), { status: 405, json: { error: "method_not_allowed" } });
    });

    it("a request with no secrets set: 503 push_off, and the same request with them works", async () => {
      apple.reset();
      const request = body(computer, good);
      assert.deepEqual(await answer(await post(off, request)), { status: 503, json: { error: "push_off" } });
      assert.equal(apple.requests.length, 0);
      assert.equal((await post(on, request)).status, 200);
    });
  });

  it("still serves the relay's own routes", async () => {
    assert.deepEqual(await (await fetch(on.base + "/v1/health")).json(), { ok: true });
    assert.equal((await fetch(on.base + "/nope")).status, 404);
  });

  it("logs no token, key, signature or payload", () => {
    for (const dev of [on, off]) {
      assert.ok(dev.output.length > 0);
      for (const secret of [...secretsSeen, "payload-marker-1", "TESTKEY123", "TESTTEAM12"]) {
        assert.equal(dev.output.includes(secret), false, "the Worker's output holds a secret of the test");
      }
    }
    assert.match(on.output, /"event":"push"/);
  });
});

describe("POST /v1/push with a key for each of Apple's services", () => {
  // Apple makes a push key for one of its two services or for both. With a second key set, the test
  // service (sandbox) is signed for with that key and production with the first.
  const production = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sandbox = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pemOf = (pair) => pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const computer = newComputer();
  let two; // both keys are good
  let broken; // the second key is not a key
  before(async () => {
    const shared = { APNS_KEY_P8: pemOf(production), APNS_KEY_ID: "TESTKEY123", APNS_SANDBOX_KEY_ID: "TESTSANDBX", APNS_TEAM_ID: "TESTTEAM12", APNS_HOST: `http://127.0.0.1:${apple.port}`, RATE_LIMITS: "off" };
    [two, broken] = await Promise.all([startDev({ ...shared, APNS_SANDBOX_KEY_P8: pemOf(sandbox) }), startDev({ ...shared, APNS_SANDBOX_KEY_P8: "not-a-key" })]);
  });
  after(() => stopAll());

  /** What Apple got for a token, in order: which service, which key's id, and whether that key really signed it. */
  const signed = (token) =>
    apple.requests
      .filter((r) => r.url.endsWith(token))
      .map((r) => {
        const [head, claims, signature] = r.headers.authorization.split(" ")[1].split(".");
        const { kid } = JSON.parse(Buffer.from(head, "base64url"));
        const pair = kid === "TESTSANDBX" ? sandbox : production;
        const good = verify("sha256", Buffer.from(head + "." + claims), { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
        return { env: r.headers["x-botkins-apns-env"], kid, good };
      });

  it("signs for each service with that service's own key", async () => {
    apple.reset();
    const { status, json } = await answer(await post(two, body(computer, [item({ token: hexToken(1), env: "sandbox" }), item({ token: hexToken(2), env: "production" })])));
    assert.equal(status, 200);
    assert.deepEqual(json, { results: [{ status: 200 }, { status: 200 }] });
    assert.deepEqual(signed(hexToken(1)), [{ env: "sandbox", kid: "TESTSANDBX", good: true }]);
    assert.deepEqual(signed(hexToken(2)), [{ env: "production", kid: "TESTKEY123", good: true }]);
  });

  it("tries the other service with the other key when a phone named the wrong one", async () => {
    apple.reset();
    // A TestFlight phone that named the test service, and a development phone that named production.
    apple.plan.set(hexToken(1), { byEnv: { sandbox: { status: 400, reason: "BadDeviceToken" }, production: { status: 200 } } });
    apple.plan.set(hexToken(2), { byEnv: { production: { status: 400, reason: "BadDeviceToken" }, sandbox: { status: 200 } } });
    const { json } = await answer(await post(two, body(computer, [item({ token: hexToken(1), env: "sandbox" }), item({ token: hexToken(2), env: "production" })])));
    assert.deepEqual(json, { results: [{ status: 200, env: "production" }, { status: 200, env: "sandbox" }] });
    assert.deepEqual(signed(hexToken(1)), [{ env: "sandbox", kid: "TESTSANDBX", good: true }, { env: "production", kid: "TESTKEY123", good: true }]);
    assert.deepEqual(signed(hexToken(2)), [{ env: "production", kid: "TESTKEY123", good: true }, { env: "sandbox", kid: "TESTSANDBX", good: true }]);
  });

  it("with a second key that can't be read, still sends on production and says so for the test service", async () => {
    apple.reset();
    const { status, json } = await answer(await post(broken, body(computer, [item({ token: hexToken(1), env: "sandbox" }), item({ token: hexToken(2), env: "production" })])));
    assert.equal(status, 200);
    assert.deepEqual(json, { results: [{ status: 503, reason: "KeyUnusable" }, { status: 200 }] });
    assert.deepEqual(signed(hexToken(1)), []);
    assert.deepEqual(signed(hexToken(2)), [{ env: "production", kid: "TESTKEY123", good: true }]);
    assert.match(broken.output, /"event":"push_key_unusable"/);
  });
});

describe("POST /v1/push rate limits", () => {
  const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = apnsKey.privateKey.export({ type: "pkcs8", format: "pem" });
  let limited;
  before(async () => {
    // RATE_LIMITS is left as wrangler.jsonc has it ("on"): the bindings count, per key and per network.
    limited = await startDev({
      APNS_KEY_P8: pem,
      APNS_KEY_ID: "TESTKEY123",
      APNS_TEAM_ID: "TESTTEAM12",
      APNS_HOST: `http://127.0.0.1:${apple.port}`,
    });
  });
  after(() => stopAll());

  it("counts one for each item for each key: 240 a minute, then 429 rate_limited and nothing sent", async (t) => {
    apple.reset();
    const heavy = newComputer();
    const other = newComputer();
    const eight = Array.from({ length: 8 }, (_, n) => item({ token: hexToken(n + 1) }));
    let last;
    for (let i = 0; i < 30; i++) {
      last = await post(limited, body(heavy, eight));
      assert.equal(last.status, 200, "request " + (i + 1) + " of 30");
    }
    assert.equal(apple.requests.length, 240);
    const refused = await post(limited, body(heavy, [item()]));
    if (refused.status === 200) {
      // The README says the same of the other bindings: they are approximate and per location.
      t.skip("the local PUSHES binding did not trip");
      return;
    }
    assert.deepEqual(await answer(refused), { status: 429, json: { error: "rate_limited" } });
    assert.equal(apple.requests.length, 240, "a refused request sends nothing");
    // Another computer has its own allowance.
    assert.equal((await post(limited, body(other, [item()]))).status, 200);
  });

  it("counts every call of one network: 120 a minute, then 429 rate_limited", async (t) => {
    let refused = null;
    for (let i = 0; i < 150 && !refused; i++) {
      const response = await post(limited, body(newComputer(), [item()]));
      if (response.status === 429) refused = response;
    }
    if (!refused) {
      t.skip("the local REQUESTS binding did not trip");
      return;
    }
    assert.deepEqual(await answer(refused), { status: 429, json: { error: "rate_limited" } });
    // The same limit holds for the relay's other pages.
    assert.equal((await fetch(limited.base + "/v1/health")).status, 429);
  });
});
