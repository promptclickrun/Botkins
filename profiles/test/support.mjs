import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { encodeCBOR } from "@levischuck/tiny-cbor";
import worker from "../src/index.mjs";
import { ORIGIN, RP, hash, random } from "../src/common.mjs";

// D1's prepared-statement interface backed by SQLite, with transactional batches and changes().
export function setup(t) {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec("PRAGMA foreign_keys=ON");
  const folder = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(folder).sort()) sql.exec(readFileSync(new URL(file, folder), "utf8"));
  function statement(query, values = []) {
    const prepared = sql.prepare(query);
    return {
      bind: (...args) => statement(query, args),
      first: () => prepared.get(...values) || null,
      all: () => ({ results: prepared.all(...values) }),
      run: () => ({ meta: { changes: prepared.run(...values).changes } }),
      execute() {
        if (prepared.columns().length) return this.all();
        return this.run();
      },
    };
  }
  const DB = {
    prepare: statement,
    batch(items) {
      sql.exec("BEGIN");
      try {
        const out = items.map((i) => i.execute());
        sql.exec("COMMIT");
        return out;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const mail = [];
  const env = { DB, PROFILE_SECRET: random(), EMAIL: { send: async (msg) => mail.push(msg) } };
  const fetchWorker = (url, init) => worker.fetch(new Request(url, init), env);
  async function api(path, body = {}, token, expected = 200) {
    const res = await fetchWorker(ORIGIN + "/v1/" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(path.startsWith("browser/") && { Origin: ORIGIN }),
        ...(token && { Authorization: "Bearer " + token }),
      },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    assert.equal(res.status, expected, path + " " + JSON.stringify(result?.error || ""));
    return result;
  }
  async function begin(label) {
    const verifier = random();
    const { id, code } = await api("enroll/start", { label, challenge: await hash(verifier) });
    const browser = random();
    const page = (action, body = {}, expected = 200) =>
      api("browser/" + action, { id, browser, ...body }, null, expected);
    await page("open", { code });
    return {
      id,
      code,
      page,
      verifier,
      finish: (expected = 200) => api("enroll/finish", { id, verifier }, null, expected),
    };
  }
  return { sql, env, mail, api, begin, fetchWorker };
}

export function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }),
    bytes = randomBytes(32),
    id = bytes.toString("base64url");
  const cose = encodeCBOR(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]),
  );
  let count = 0;
  function credential(options, create) {
    const client = Buffer.from(
      JSON.stringify({
        type: create ? "webauthn.create" : "webauthn.get",
        challenge: options.challenge,
        origin: ORIGIN,
        crossOrigin: false,
      }),
    );
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++count);
    const auth = Buffer.concat([
      createHash("sha256").update(RP).digest(),
      Buffer.of(create ? 69 : 5),
      counter,
      ...(create ? [Buffer.alloc(16), Buffer.from([0, bytes.length]), bytes, cose] : []),
    ]);
    const response = { clientDataJSON: client.toString("base64url") };
    if (create)
      response.attestationObject = Buffer.from(
        encodeCBOR(
          new Map([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", auth],
          ]),
        ),
      ).toString("base64url");
    else {
      response.authenticatorData = auth.toString("base64url");
      response.signature = sign(
        "sha256",
        Buffer.concat([auth, createHash("sha256").update(client).digest()]),
        privateKey,
      ).toString("base64url");
    }
    return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response };
  }
  return { credential };
}

export async function passkey(flow, auth, mode = "signin", emailAddress = "person@example.test") {
  const { options } = await flow.page("options", {
    mode,
    email: emailAddress,
    name: "River",
    avatar: "🌱",
  });
  await flow.page("verify", { credential: auth.credential(options, mode === "create") });
}
export async function email(flow, fixture) {
  await flow.page("email");
  const code = /code is (\d{6})/.exec(fixture.mail.at(-1).text)[1];
  await flow.page("code", { otp: code });
}
export async function signup(fixture, auth = authenticator(), emailAddress) {
  const flow = await fixture.begin("Original desktop");
  await passkey(flow, auth, "create", emailAddress);
  await email(flow, fixture);
  const { session } = await flow.finish();
  return { auth, flow, session };
}
