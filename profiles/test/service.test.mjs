import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, authenticator, passkey, email, signup } from "./support.mjs";
import { DAY, random } from "../src/common.mjs";

test("a fresh installation needs a passkey and verified email, and can finish a lost response again", async (t) => {
  const f = setup(t),
    a = authenticator(),
    flow = await f.begin("Laptop");
  await f.api("home", {}, null, 401);
  await f.api("proofs/issue", {}, null, 401);
  await flow.page("email", {}, 409);
  await passkey(flow, a, "create");
  assert.equal((await flow.finish()).session, null);
  await email(flow, f);
  const { session } = await flow.finish();
  assert.equal(session.email, "person@example.test");
  assert.deepEqual((await flow.finish()).session, session);
  const home = await f.api("home", {}, session.token);
  assert.equal(home.profile.avatar, "🌱");
  assert.deepEqual(home.devices, [{ id: session.deviceId, label: "Laptop", current: true }]);
  assert.deepEqual(home.hosts, []);
  await f.api("enroll/finish", { id: flow.id, verifier: random() }, null, 403);
  await flow.page("code", { otp: "000000" }, 409);
});

test("either a trusted installation or the email code can admit the same profile after passkey verification", async (t) => {
  const f = setup(t),
    { auth, session } = await signup(f);
  const phone = await f.begin("Phone");
  await f.api("devices/approve", { id: phone.id, code: phone.code }, session.token, 409);
  await passkey(phone, auth);
  assert.equal((await phone.finish()).session, null);
  const { pending } = await f.api("home", {}, session.token);
  assert.deepEqual(pending, [{ id: phone.id, code: phone.code, label: "Phone" }]);
  await f.api("devices/approve", { id: phone.id, code: phone.code }, session.token);
  const second = (await phone.finish()).session;
  assert.equal(second.profileId, session.profileId);
  assert.notEqual(second.token, session.token);
  const other = await f.begin("Workstation");
  await passkey(other, auth);
  await email(other, f);
  assert.equal((await other.finish()).session.profileId, session.profileId);
  const home = await f.api("home", {}, session.token);
  assert.equal(home.devices.length, 3);
  await f.api("devices/revoke", { deviceId: second.deviceId }, session.token);
  await f.api("home", {}, second.token, 401);
  await phone.finish(409);
});

test("only same-account devices see directory entries and host proofs are single use and bound to the new Link key", async (t) => {
  const f = setup(t),
    { session } = await signup(f),
    token = session.token;
  const host = { serverId: "host-A", serverKey: random(), name: "Build Mac", hosts: ["127.0.0.1:47610"] };
  await f.api("hosts/put", host, token);
  await f.api("hosts/put", { ...host, serverKey: random() }, token, 409);
  assert.equal((await f.api("home", {}, token)).hosts[0].name, host.name);
  const outsider = await signup(f, authenticator(), "another@example.test");
  assert.deepEqual((await f.api("home", {}, outsider.session.token)).hosts, []);
  const outsideTarget = { ...host, publicKey: random(), purpose: "connect" };
  await f.api("proofs/issue", outsideTarget, outsider.session.token, 403);
  const target = {
    serverId: host.serverId,
    serverKey: host.serverKey,
    publicKey: random(),
    purpose: "connect",
  };
  const { ticket } = await f.api("proofs/issue", target, token);
  await f.api("proofs/redeem", { ...target, ticket, publicKey: random() }, null, 403);
  const proof = await f.api("proofs/redeem", { ...target, ticket });
  assert.equal(proof.profileId, session.profileId);
  assert.equal(proof.deviceId, session.deviceId);
  await f.api("proofs/redeem", { ...target, ticket }, null, 403);
  assert.equal((await f.api("devices/status", { statusKey: proof.statusKey })).active, true);
  await f.api("devices/revoke", { deviceId: session.deviceId }, token);
  assert.equal((await f.api("devices/status", { statusKey: proof.statusKey })).active, false);
});

test("email reservations stop at the rolling service budget, and verification guesses are bounded", async (t) => {
  const f = setup(t),
    flow = await f.begin("New phone");
  await passkey(flow, authenticator(), "create");
  const insert = f.sql.prepare("INSERT INTO mail(at,recipient,flow) VALUES(?,?,?)");
  for (let i = 0; i < 60; i++) insert.run(Date.now(), "r" + i, "f" + i);
  await flow.page("email", {}, 429);
  assert.equal(f.mail.length, 0);
  f.sql.exec("UPDATE mail SET at=at-" + String(DAY + 1000));
  await flow.page("email");
  assert.equal(f.mail.length, 1);
  await flow.page("email", {}, 429);
  const real = /code is (\d{6})/.exec(f.mail[0].text)[1];
  const wrong = real === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) await flow.page("code", { otp: wrong }, 403);
  await flow.page("code", { otp: real }, 403);
  assert.equal((await flow.finish()).session, null);
});

test("creating another profile with the same verified email cannot replace its existing credential", async (t) => {
  const f = setup(t),
    { auth, session } = await signup(f),
    again = await f.begin("Another installation");
  await passkey(again, authenticator(), "create");
  await email(again, f);
  await again.finish(409);
  const original = await f.begin("Returning installation");
  await passkey(original, auth);
  await f.api("devices/approve", { id: original.id, code: original.code }, session.token);
  assert.equal((await original.finish()).session.profileId, session.profileId);
});

test("expired attempts and expired or consumed device proofs cannot establish a session", async (t) => {
  const f = setup(t),
    { session } = await signup(f);
  const flow = await f.begin("Old laptop");
  f.sql.prepare("UPDATE enrollments SET expires=0 WHERE id=?").run(flow.id);
  await flow.finish(410);
  const target = { serverId: "my-host", serverKey: random(), purpose: "bind" };
  const { ticket } = await f.api("proofs/issue", target, session.token);
  f.sql.exec("UPDATE proofs SET expires=0");
  await f.api("proofs/redeem", { ...target, ticket }, null, 403);
});

test("deleting a trusted profile requires its verified email and clears only that account's data", async (t) => {
  const f = setup(t);
  const { session, auth } = await signup(f);
  const other = await signup(f, authenticator(), "separate@example.test");
  const host = { serverId: "owned", serverKey: random(), name: "Home", hosts: ["127.0.0.1:4001"] };
  await f.api("hosts/put", host, session.token);
  const target = { ...host, purpose: "connect", publicKey: random() };
  const proof = await f.api("proofs/issue", target, session.token);
  const pending = await f.begin("Pending phone");
  await passkey(pending, auth);
  const pairing = await f.api("proofs/issue", { ...host, purpose: "bind" }, session.token);
  const status = await f.api("proofs/redeem", { ...host, purpose: "bind", ticket: pairing.ticket });
  await f.api("profile/delete", { confirmationEmail: session.email }, null, 401);
  await f.api("profile/delete", { confirmationEmail: other.session.email }, session.token, 400);
  assert.equal((await f.api("home", {}, session.token)).hosts.length, 1);
  await f.api("profile/delete", { confirmationEmail: session.email }, session.token);
  await f.api("home", {}, session.token, 401);
  await f.api("proofs/redeem", { ...target, ticket: proof.ticket }, null, 403);
  assert.equal((await f.api("devices/status", { statusKey: status.statusKey })).active, false);
  await pending.finish(410);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM hosts WHERE profile=?").get(session.profileId).n, 0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM profiles WHERE email=?").get(session.email).n, 0);
  assert.equal((await f.api("home", {}, other.session.token)).devices.length, 1);
});
test("the public service limits enrollment starts and repeated sends to one recipient", async (t) => {
  const f = setup(t),
    { auth } = await signup(f);
  // One signup email plus four distinct approved passkey ceremonies exhaust this destination.
  for (let n = 0; n < 4; n++) {
    const phone = await f.begin("Phone " + n);
    await passkey(phone, auth);
    await phone.page("email");
  }
  const next = await f.begin("Another phone");
  await passkey(next, auth);
  await next.page("email", {}, 429);
  assert.equal(f.mail.length, 5);
  const today = Math.floor(Date.now() / DAY);
  f.sql.prepare("UPDATE admission SET started=599 WHERE day=?").run(today);
  await f.begin("Last allowed start");
  const before = f.sql.prepare("SELECT count(*) AS n FROM enrollments").get().n;
  await f.api("enroll/start", { label: "Beyond budget", challenge: random() }, null, 429);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM enrollments").get().n, before);
});

test("chromium extensions can enroll and read hosts, while web origins and admin routes remain blocked", async (t) => {
  const f = setup(t),
    { session } = await signup(f);
  const extOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const callWithOrigin = async (path, body, token, origin) => {
    const res = await f.fetchWorker("https://profile.botkins.app/v1/" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...(token && { Authorization: "Bearer " + token }),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  // Allowed for extension: enroll/start, home, proofs/issue, devices/revoke
  const started = await callWithOrigin("enroll/start", { label: "Chrome", challenge: random() }, null, extOrigin);
  assert.equal(started.status, 200);
  const home = await callWithOrigin("home", {}, session.token, extOrigin);
  assert.equal(home.status, 200);
  // Blocked for extension: profile/delete, browser/*, arbitrary web origins
  const del = await callWithOrigin("profile/delete", { confirmationEmail: session.email }, session.token, extOrigin);
  assert.equal(del.status, 403);
  const web = await callWithOrigin("home", {}, session.token, "https://evil.example");
  assert.equal(web.status, 403);
  const badExt = await callWithOrigin("home", {}, session.token, "chrome-extension://not-valid-id");
  assert.equal(badExt.status, 403);
});
