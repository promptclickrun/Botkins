// Unit tests of the push helpers (src/push.ts). Node reads the TypeScript directly.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, it } from "node:test";
import { verifyEd25519 } from "../src/pure.ts";
import {
  IAT_STEP,
  MAX_PAYLOAD,
  apnsHeaders,
  apnsUrl,
  iatFor,
  makeJwt,
  parseSends,
  pemToPkcs8,
  pushChallenge,
  pushSettings,
  topicFor,
} from "../src/push.ts";

const token = "ab".repeat(32);
const item = (change = {}) => ({
  token,
  env: "production",
  type: "alert",
  priority: 10,
  expiration: 3600,
  collapse: "chat-1",
  payload: { aps: { alert: { title: "t" } } },
  ...change,
});
const sends = (...items) => JSON.stringify(items);

describe("pushChallenge", () => {
  it("is the prefix, the time and the exact sends text", () => {
    assert.equal(pushChallenge(1700000000, '[{"a":1}]'), 'botkins-push-v1:1700000000:[{"a":1}]');
    assert.equal(pushChallenge("5", "x"), "botkins-push-v1:5:x");
  });
});

describe("verifyEd25519", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "jwk" }).x;
  const message = pushChallenge(1700000000, sends(item()));
  const signature = sign(null, Buffer.from(message), privateKey).toString("base64url");

  it("accepts a good signature and refuses a changed message, key or signature", async () => {
    assert.equal(await verifyEd25519(key, signature, message), true);
    assert.equal(await verifyEd25519(key, signature, message + " "), false);
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x;
    assert.equal(await verifyEd25519(other, signature, message), false);
    assert.equal(await verifyEd25519(key, "A".repeat(86), message), false);
  });

  it("refuses what is not the right length or alphabet, without throwing", async () => {
    assert.equal(await verifyEd25519(key.slice(1), signature, message), false);
    assert.equal(await verifyEd25519(key, signature.slice(1), message), false);
    assert.equal(await verifyEd25519("+".repeat(43), signature, message), false);
    assert.equal(await verifyEd25519(key, "", message), false);
  });
});

describe("parseSends", () => {
  it("reads a good item as it is, with the payload kept as JSON text", () => {
    const [one] = parseSends(sends(item()));
    assert.equal(one.token, token);
    assert.equal(one.env, "production");
    assert.equal(one.type, "alert");
    assert.equal(one.priority, 10);
    assert.equal(one.expiration, 3600);
    assert.equal(one.collapse, "chat-1");
    assert.deepEqual(JSON.parse(one.body), { aps: { alert: { title: "t" } } });
  });

  it("keeps other keys of the payload, and leaves collapse out when it is not given", () => {
    const { collapse, ...rest } = item({ payload: { aps: { "content-available": 1 }, k: "sealed" } });
    const [one] = parseSends(sends(rest));
    assert.equal("collapse" in one, false);
    assert.deepEqual(JSON.parse(one.body), { aps: { "content-available": 1 }, k: "sealed" });
  });

  it("takes 1 to 8 items and no more", () => {
    assert.equal(parseSends("[]"), null);
    assert.equal(parseSends(sends(...Array(8).fill(item()))).length, 8);
    assert.equal(parseSends(sends(...Array(9).fill(item()))), null);
  });

  it("refuses what is not an array of items", () => {
    for (const bad of ["", "nope", "{}", "null", "7", '"x"', "[null]", "[1]", "[[]]"]) assert.equal(parseSends(bad), null, bad);
  });

  it("refuses a bad token", () => {
    for (const bad of ["", "AB".repeat(32), "ab".repeat(31), "ab".repeat(101), "zz".repeat(32), "ab".repeat(32) + " ", 12, null]) {
      assert.equal(parseSends(sends(item({ token: bad }))), null, String(bad));
    }
    assert.ok(parseSends(sends(item({ token: "ab".repeat(100) }))), "200 characters is the most");
  });

  it("refuses a bad env, type, priority or expiration", () => {
    for (const change of [
      { env: "dev" },
      { env: "" },
      { type: "voip" },
      { type: "ALERT" },
      { priority: 1 },
      { priority: "10" },
      { priority: 7 },
      { expiration: -1 },
      { expiration: 86401 },
      { expiration: 1.5 },
      { expiration: "60" },
    ]) {
      assert.equal(parseSends(sends(item(change))), null, JSON.stringify(change));
    }
    for (const change of [{ env: "sandbox" }, { type: "background" }, { type: "liveactivity" }, { priority: 5 }, { expiration: 0 }, { expiration: 86400 }]) {
      assert.ok(parseSends(sends(item(change))), JSON.stringify(change));
    }
  });

  it("limits collapse to 64 visible ASCII characters", () => {
    assert.ok(parseSends(sends(item({ collapse: "x".repeat(64) }))));
    for (const bad of ["x".repeat(65), "", "a b", "é", "a\nb", 5, null]) assert.equal(parseSends(sends(item({ collapse: bad }))), null, String(bad));
  });

  it("needs a payload object with an aps object", () => {
    for (const payload of [undefined, null, [], "x", 1, {}, { aps: null }, { aps: [] }, { aps: "x" }, { alert: "x" }]) {
      assert.equal(parseSends(sends(item({ payload }))), null, JSON.stringify(payload));
    }
  });

  it("limits a payload to 4096 bytes of JSON, counted in UTF-8", () => {
    const fits = (n) => ({ aps: { alert: "x".repeat(n) } });
    const base = JSON.stringify(fits(0)).length;
    assert.ok(parseSends(sends(item({ payload: fits(MAX_PAYLOAD - base) }))));
    assert.equal(parseSends(sends(item({ payload: fits(MAX_PAYLOAD - base + 1) }))), null);
    // Two bytes a character: half as many fit.
    const wide = (n) => ({ aps: { alert: "é".repeat(n) } });
    assert.ok(parseSends(sends(item({ payload: wide((MAX_PAYLOAD - base) / 2) }))));
    assert.equal(parseSends(sends(item({ payload: wide((MAX_PAYLOAD - base) / 2 + 1) }))), null);
  });

  it("refuses the whole list when one item is bad", () => {
    assert.equal(parseSends(sends(item(), item({ priority: 3 }))), null);
  });
});

describe("topicFor, apnsUrl and apnsHeaders", () => {
  const base = "app.botkins.mobile";
  const [alert] = parseSends(sends(item()));
  const parse = (change) => parseSends(sends(item(change)))[0];

  it("adds the live activity suffix, and only for a live activity", () => {
    assert.equal(topicFor(base, "alert"), base);
    assert.equal(topicFor(base, "background"), base);
    assert.equal(topicFor(base, "liveactivity"), base + ".push-type.liveactivity");
  });

  it("picks Apple's host by env, or the replacement host for both", () => {
    assert.equal(apnsUrl(alert), `https://api.push.apple.com/3/device/${token}`);
    assert.equal(apnsUrl(parse({ env: "sandbox" })), `https://api.sandbox.push.apple.com/3/device/${token}`);
    assert.equal(apnsUrl(alert, "http://127.0.0.1:9/"), `http://127.0.0.1:9/3/device/${token}`);
    assert.equal(apnsUrl(parse({ env: "sandbox" }), "http://127.0.0.1:9"), `http://127.0.0.1:9/3/device/${token}`);
  });

  it("sets Apple's headers", () => {
    assert.deepEqual(apnsHeaders(alert, base, "J", 1000), {
      authorization: "bearer J",
      "apns-topic": base,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "4600",
      "apns-collapse-id": "chat-1",
    });
  });

  it("sends expiration 0 as 0, and leaves out a collapse id that was not given", () => {
    const { collapse, ...rest } = item({ expiration: 0 });
    const headers = apnsHeaders(parseSends(sends(rest))[0], base, "J", 1000);
    assert.equal(headers["apns-expiration"], "0");
    assert.equal("apns-collapse-id" in headers, false);
  });

  it("always sends a background push with priority 5", () => {
    const headers = apnsHeaders(parse({ type: "background", priority: 10 }), base, "J", 1000);
    assert.equal(headers["apns-priority"], "5");
    assert.equal(headers["apns-push-type"], "background");
    assert.equal(apnsHeaders(parse({ type: "liveactivity", priority: 5 }), base, "J", 1000)["apns-priority"], "5");
    assert.equal(apnsHeaders(parse({ type: "liveactivity", priority: 10 }), base, "J", 1000)["apns-topic"], base + ".push-type.liveactivity");
  });
});

describe("the token for Apple", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });

  it("reads a .p8 as PEM, with line breaks or with a literal \\n, and refuses anything else", () => {
    assert.ok(pemToPkcs8(pem));
    assert.ok(pemToPkcs8(pem.trim().replaceAll("\n", "\\n")));
    assert.equal(pemToPkcs8(""), null);
    assert.equal(pemToPkcs8("-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----"), null);
    assert.equal(pemToPkcs8(publicKey.export({ type: "spki", format: "pem" })), null);
  });

  it("rounds iat down to a 30 minute step", () => {
    assert.equal(IAT_STEP, 1800);
    assert.equal(iatFor(1800), 1800);
    assert.equal(iatFor(1800 + 1799), 1800);
    assert.equal(iatFor(1800 * 5 + 1), 1800 * 5);
    assert.equal(iatFor(1_700_000_000) % 1800, 0);
  });

  it("makes an ES256 token with kid, iss and iat that verifies with the public key", async () => {
    const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const jwt = await makeJwt(key, "KEYID12345", "TEAMID6789", 1_800_000);
    const [head, claims, signature] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { alg: "ES256", kid: "KEYID12345" });
    assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), { iss: "TEAMID6789", iat: 1_800_000 });
    assert.equal(Buffer.from(signature, "base64url").length, 64);
    assert.equal(
      verify("sha256", Buffer.from(head + "." + claims), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
      true,
    );
    assert.equal(
      verify("sha256", Buffer.from(head + "." + claims + "x"), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
      false,
    );
  });
});

describe("the push settings", () => {
  const base = { APNS_KEY_P8: "pem-1", APNS_KEY_ID: "KEYID12345", APNS_TEAM_ID: "TEAMID1234", APNS_TOPIC: "app.example" };

  it("is off until the key, its id, the team and the topic are all set", () => {
    for (const name of Object.keys(base)) assert.equal(pushSettings({ ...base, [name]: "" }), null, name);
    assert.equal(pushSettings({}), null);
  });

  it("uses the one key for both of Apple's services", () => {
    const settings = pushSettings(base);
    assert.deepEqual(settings, { keys: { production: { pem: "pem-1", kid: "KEYID12345" }, sandbox: { pem: "pem-1", kid: "KEYID12345" } }, team: "TEAMID1234", topic: "app.example" });
    assert.equal(settings.keys.sandbox, settings.keys.production);
  });

  it("uses a second key for the test service, only when both its text and its id are set", () => {
    const two = pushSettings({ ...base, APNS_SANDBOX_KEY_P8: "pem-2", APNS_SANDBOX_KEY_ID: "SANDBOX123" });
    assert.deepEqual(two.keys, { production: { pem: "pem-1", kid: "KEYID12345" }, sandbox: { pem: "pem-2", kid: "SANDBOX123" } });
    for (const half of [{ APNS_SANDBOX_KEY_P8: "pem-2" }, { APNS_SANDBOX_KEY_ID: "SANDBOX123" }]) {
      const settings = pushSettings({ ...base, ...half });
      assert.equal(settings.keys.sandbox, settings.keys.production);
    }
  });
});
