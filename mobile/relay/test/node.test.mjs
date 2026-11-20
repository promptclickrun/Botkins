// What only the self-hosted relay (../node/server.mjs) does: the pairing page, forwarding pushes to the
// Botkins relay, and keeping invite cards across a restart. The protocol itself is covered by
// relay.test.mjs with RELAY_TARGET=node.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createRelay } from "../node/server.mjs";

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function start(options = {}) {
  const server = createRelay({ limits: false, pushUpstream: "off", ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((resolve) => server.close(resolve)) };
}

describe("self-hosted relay", () => {
  it("serves the pairing page with its link only in the fragment, a strict CSP and no outside assets", async () => {
    const { base, stop } = await start();
    try {
      const response = await fetch(base + "/pair");
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      const csp = response.headers.get("content-security-policy");
      assert.match(csp, /default-src 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline/);
      assert.match(html, /location\.hash/);
      assert.match(html, /botkins:\/\/pair\?/);
      // The QR generator is inlined, and nothing is loaded from anywhere.
      assert.match(html, /const qrcode = function/);
      assert.doesNotMatch(html, /^export /m);
      assert.doesNotMatch(html, /<script[^>]+\bsrc=/);
    } finally {
      await stop();
    }
  });

  it("forwards a push request unchanged to the upstream relay and returns its answer", async () => {
    const seen = [];
    const fetch_ = async (url, init) => {
      seen.push({ url, body: init.body, type: init.headers["content-type"] });
      return new Response(JSON.stringify({ results: [{ status: 200 }] }), { status: 200 });
    };
    const { base, stop } = await start({ pushUpstream: "https://upstream.example/", fetch: fetch_ });
    try {
      const body = JSON.stringify({ v: 1, key: "k", time: 1, sig: "s", sends: "[]" });
      const response = await fetch(base + "/v1/push", { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { results: [{ status: 200 }] });
      assert.deepEqual(seen, [{ url: "https://upstream.example/v1/push", body, type: "application/json" }]);
      assert.equal((await fetch(base + "/v1/push")).status, 405);
    } finally {
      await stop();
    }
  });

  it("answers push_off when forwarding is off, and 502 when the upstream can't be reached", async () => {
    const off = await start();
    try {
      const response = await fetch(off.base + "/v1/push", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "push_off" });
    } finally {
      await off.stop();
    }
    const down = await start({ pushUpstream: "https://upstream.example", fetch: () => Promise.reject(new TypeError("down")) });
    try {
      const response = await fetch(down.base + "/v1/push", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 502);
    } finally {
      await down.stop();
    }
  });

  it("keeps an invite card across a restart, and only until it expires", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "botkins-relay-node-"));
    dirs.push(dataDir);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const key = publicKey.export({ format: "jwk" }).x;
    const room = createHash("sha256").update("botkins-relay-room-v1:" + key).digest("base64url");
    const lookup = randomBytes(32).toString("base64url");
    const card = randomBytes(48).toString("base64url");
    const expiresAt = Date.now() + 1500;
    const seconds = Math.floor(Date.now() / 1000);
    const cardHash = createHash("sha256").update(card).digest("base64url");
    const sig = sign(null, Buffer.from(`botkins-relay-invite-v1:${room}:${lookup}:${expiresAt}:${cardHash}:${seconds}`), privateKey).toString("base64url");

    const first = await start({ dataDir });
    const put = await fetch(first.base + `/v1/invites/${lookup}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-botkins-key": key, "x-botkins-time": String(seconds), "x-botkins-sig": sig },
      body: JSON.stringify({ card, expiresAt }),
    });
    assert.equal(put.status, 204);
    await first.stop();

    const second = await start({ dataDir });
    try {
      assert.deepEqual(await (await fetch(second.base + `/v1/invites/${lookup}`)).json(), { card });
      await new Promise((resolve) => setTimeout(resolve, 1600));
      assert.equal((await fetch(second.base + `/v1/invites/${lookup}`)).status, 404);
    } finally {
      await second.stop();
    }
  });
});
