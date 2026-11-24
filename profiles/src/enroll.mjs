import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  DAY,
  MINUTE,
  ORIGIN,
  RP,
  Failure,
  changed,
  decode,
  digits,
  encode,
  ensure,
  field,
  hash,
  key,
  otpHash,
  random,
  stmt,
} from "./common.mjs";

import { avatar } from "./account.mjs";

const lifetime = 15 * MINUTE;
const gone = "This sign-in has expired. Start again in the app.";
const invalidPasskey = "Botkins could not verify that passkey. Try the sign-in again.";

export async function start(db, input, now) {
  const label = field(input.label),
    verifier = key(input.challenge);
  const day = Math.floor(now / DAY);
  const admission = await stmt(
    db,
    "INSERT INTO admission(day,started) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET started=started+1 WHERE started<600",
    day,
  ).run();
  ensure(changed(admission), 429, "The daily sign-in limit has been reached. Try again tomorrow.");
  const id = random(24),
    code = digits();
  await db.batch([
    stmt(db, "DELETE FROM enrollments WHERE expires<=?", now),
    stmt(db, "DELETE FROM admission WHERE day<?", day - 1),
    stmt(db, "DELETE FROM mail WHERE at<?", now - DAY),
    stmt(db, "DELETE FROM proofs WHERE expires<=?", now),
    stmt(
      db,
      "INSERT INTO enrollments(id,device,verifier_hash,code,label,created,expires) VALUES(?,?,?,?,?,?,?)",
      id,
      random(24),
      verifier,
      code,
      label,
      now,
      now + lifetime,
    ),
  ]);
  return { id, code };
}

async function attempt(db, input, now) {
  ensure(typeof input.id === "string" && /^[\w-]{32}$/.test(input.id));
  const flow = await stmt(db, "SELECT * FROM enrollments WHERE id=? AND expires>?", input.id, now).first();
  ensure(flow, 410, gone);
  return flow;
}

export async function browserFlow(env, action, input, now) {
  const db = env.DB,
    flow = await attempt(db, input, now);
  const browser = await hash(key(input.browser));
  if (action === "open" && !flow.browser_hash) {
    ensure(/^\d{6}$/.test(input.code), 403, "Enter the six digits shown in Botkins.");
    const result = await stmt(
      db,
      `UPDATE enrollments SET guesses=guesses+1, browser_hash=CASE WHEN code=? THEN ? END
      WHERE id=? AND browser_hash IS NULL AND guesses<5`,
      input.code,
      browser,
      flow.id,
    ).run();
    ensure(
      changed(result) && flow.code === input.code,
      403,
      "That device code was not accepted. Check the app or restart sign-in.",
    );
    flow.browser_hash = browser;
  }
  ensure(flow.browser_hash === browser, 403, "Open sign-in from this installation of Botkins.");
  if (action === "open") return { label: flow.label, state: flow.state, mode: flow.mode };
  if (action === "options") return options(db, flow, input);
  if (action === "verify") return verify(db, flow, input);
  ensure(flow.state === "verified", 409, "Verify your passkey on this sign-in first.");
  if (action === "email") return sendCode(env, flow, now);
  if (action === "code") {
    ensure(typeof input.otp === "string" && /^\d{6}$/.test(input.otp), 400, "Enter the six-digit email code.");
    const proof = await otpHash(env, flow.id, input.otp);
    const update = await stmt(
      db,
      `UPDATE enrollments SET otp_tries=otp_tries+1,
      state=CASE WHEN otp_hash=? THEN 'approved' ELSE state END, otp_hash=CASE WHEN otp_hash=? THEN NULL ELSE otp_hash END
      WHERE id=? AND state='verified' AND otp_hash IS NOT NULL AND otp_until>? AND otp_tries<5 RETURNING state`,
      proof,
      proof,
      flow.id,
      now,
    ).first();
    ensure(
      update?.state === "approved",
      403,
      "That code is incorrect or expired. Check your email or start again.",
    );
    return { state: "approved" };
  }
  throw new Failure(404, "Unknown action.");
}

async function options(db, flow, input) {
  ensure(flow.state === "new" || flow.state === "challenge", 409);
  const create = input.mode === "create";
  ensure(create || input.mode === "signin");
  let options,
    profile = null,
    name = null,
    email = null;
  if (create) {
    name = field(input.name, 60);
    email = field(input.email, 254).toLowerCase();
    ensure(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email), 400, "Enter a valid email address.");
    profile = random(24);
    options = await generateRegistrationOptions({
      rpName: "Botkins",
      rpID: RP,
      userID: decode(profile),
      userName: email,
      userDisplayName: name,
      supportedAlgorithmIDs: [-7, -257],
      attestationType: "none",
      authenticatorSelection: { userVerification: "required", residentKey: "required" },
    });
  } else
    options = await generateAuthenticationOptions({
      rpID: RP,
      userVerification: "required",
      allowCredentials: [],
    });
  const result = await stmt(
    db,
    `UPDATE enrollments SET state='challenge',mode=?,challenge=?,profile=?,email=?,name=?,avatar=?
    WHERE id=? AND state IN ('new','challenge')`,
    input.mode,
    options.challenge,
    profile,
    email,
    name,
    avatar(input.avatar),
    flow.id,
  ).run();
  ensure(changed(result), 409);
  return { options };
}

async function verify(db, flow, input) {
  ensure(flow.state === "challenge" && flow.challenge, 409);
  const response = input.credential;
  ensure(
    response?.type === "public-key" &&
      typeof response.id === "string" &&
      response.id.length <= 2048 &&
      response.response,
  );
  const expected = {
    response,
    expectedChallenge: flow.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP,
    requireUserVerification: true,
  };
  // Consume first. A retried, failed or raced ceremony needs a fresh challenge.
  ensure(
    changed(
      await stmt(
        db,
        "UPDATE enrollments SET state='checking',challenge=NULL WHERE id=? AND state='challenge' AND challenge=?",
        flow.id,
        flow.challenge,
      ).run(),
    ),
    409,
  );
  try {
    if (flow.mode === "create") {
      const result = await verifyRegistrationResponse({
        ...expected,
        supportedAlgorithmIDs: [-7, -257],
        requireUserPresence: true,
      });
      ensure(result.verified, 403, invalidPasskey);
      const cred = result.registrationInfo.credential;
      await stmt(
        db,
        "UPDATE enrollments SET state='verified',credential=?,public_key=?,counter=? WHERE id=? AND state='checking'",
        cred.id,
        encode(cred.publicKey),
        cred.counter,
        flow.id,
      ).run();
    } else {
      const owner = await stmt(db, "SELECT * FROM profiles WHERE credential=?", response.id).first();
      ensure(
        owner && (!response.response.userHandle || response.response.userHandle === owner.id),
        403,
        invalidPasskey,
      );
      const result = await verifyAuthenticationResponse({
        ...expected,
        credential: { id: owner.credential, publicKey: decode(owner.public_key), counter: owner.counter },
      });
      ensure(result.verified, 403, invalidPasskey);
      const resultSet = await db.batch([
        stmt(
          db,
          "UPDATE profiles SET counter=? WHERE id=? AND counter=?",
          result.authenticationInfo.newCounter,
          owner.id,
          owner.counter,
        ),
        stmt(
          db,
          `UPDATE enrollments SET state='verified',profile=?,name=?,email=? WHERE id=? AND state='checking' AND changes()=1`,
          owner.id,
          owner.name,
          owner.email,
          flow.id,
        ),
      ]);
      ensure(changed(resultSet[1]), 409, "Another sign-in completed first. Try again.");
    }
  } catch (error) {
    await stmt(db, "UPDATE enrollments SET state='new' WHERE id=? AND state='checking'", flow.id).run();
    if (error instanceof Failure) throw error;
    throw new Failure(403, invalidPasskey);
  }
  return { state: "verified", mode: flow.mode };
}

async function sendCode(env, flow, now) {
  ensure(
    env.EMAIL && typeof env.PROFILE_SECRET === "string",
    503,
    "Email verification is temporarily unavailable.",
  );
  const db = env.DB,
    code = digits(),
    digest = await otpHash(env, flow.id, code);
  const recipient = await hash(flow.email);
  // A single SQLite statement reserves the send before the external side effect, including failed deliveries.
  const reservation = await stmt(
    db,
    `INSERT INTO mail(at,recipient,flow) SELECT ?,?,? WHERE
    (SELECT COUNT(*) FROM mail WHERE at>?)<60 AND
    (SELECT COUNT(*) FROM mail WHERE recipient=? AND at>?)<5 AND
    NOT EXISTS(SELECT 1 FROM mail WHERE flow=? AND at>?)`,
    now,
    recipient,
    flow.id,
    now - DAY,
    recipient,
    now - DAY,
    flow.id,
    now - MINUTE,
  ).run();
  ensure(
    changed(reservation),
    429,
    "Email sending is limited. Wait before requesting another code, or use a trusted device.",
  );
  const saved = await stmt(
    db,
    "UPDATE enrollments SET otp_hash=?,otp_until=? WHERE id=? AND state='verified' AND otp_tries<5",
    digest,
    Math.min(flow.expires, now + 10 * MINUTE),
    flow.id,
  ).run();
  ensure(changed(saved), 409, "Start a new sign-in to request a code.");
  try {
    await env.EMAIL.send({
      from: { email: "profiles@login.botkins.app", name: "Botkins" },
      to: flow.email,
      subject: "Your Botkins verification code",
      text:
        "Your Botkins verification code is " +
        code +
        ". Enter it only in the Botkins profile page you opened for " +
        flow.label +
        ". It expires within ten minutes.",
    });
  } catch {
    await stmt(db, "UPDATE enrollments SET otp_hash=NULL WHERE id=? AND otp_hash=?", flow.id, digest).run();
    throw new Failure(503, "Email could not be sent. Try again later or use a trusted device.");
  }
  return { sent: true };
}

export async function finish(db, input, now) {
  const flow = await attempt(db, input, now);
  const verifier = key(input.verifier);
  ensure((await hash(verifier)) === flow.verifier_hash, 403);
  if (flow.state !== "approved" && flow.state !== "complete") return { session: null };
  // Deriving a unique installation token from its private verifier also makes a lost completion response retryable.
  const token = await hash("botkins-profile-token-v1/" + flow.id + "/" + verifier),
    tokenHash = await hash(token);
  if (flow.state === "approved") {
    await db.batch([
      stmt(
        db,
        `INSERT INTO profiles(id,email,name,credential,public_key,counter,avatar)
        SELECT profile,email,name,credential,public_key,counter,avatar FROM enrollments
        WHERE id=? AND state='approved' AND mode='create' ON CONFLICT DO NOTHING`,
        flow.id,
      ),
      stmt(
        db,
        `INSERT INTO devices(id,profile,label,token_hash,status_key)
        SELECT e.device,e.profile,e.label,?,? FROM enrollments e JOIN profiles p ON p.id=e.profile
        WHERE e.id=? AND e.state='approved' AND (SELECT COUNT(*) FROM devices WHERE profile=e.profile)<32 ON CONFLICT DO NOTHING`,
        tokenHash,
        random(),
        flow.id,
      ),
      stmt(
        db,
        `UPDATE enrollments SET state='complete',credential=NULL,public_key=NULL,otp_hash=NULL
        WHERE id=? AND EXISTS(SELECT 1 FROM devices WHERE token_hash=?)`,
        flow.id,
        tokenHash,
      ),
    ]);
  }
  const session = await stmt(
    db,
    `SELECT d.id AS deviceId,p.id AS profileId,p.name,p.email FROM devices d
    JOIN profiles p ON p.id=d.profile WHERE token_hash=?`,
    tokenHash,
  ).first();
  ensure(
    session,
    409,
    "This installation could not be linked. Sign in with your existing passkey or remove an unused device.",
  );
  return { session: { ...session, token } };
}
