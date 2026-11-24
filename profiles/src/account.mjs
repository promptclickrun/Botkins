import { MINUTE, changed, ensure, field, hash, key, random, serverID, stmt } from "./common.mjs";

export const avatars = ["", "🌱", "🌊", "🌙", "☀️", "🦊", "🐈", "🌻", "🪐"];
export function avatar(value) {
  ensure(avatars.includes(value ?? ""));
  return value ?? "";
}

async function home(db, user, now) {
  const [hosts, devices, pending, profile] = await db.batch([
    stmt(
      db,
      "SELECT server_id AS serverId,server_key AS serverKey,name,routes,member FROM hosts WHERE profile=? ORDER BY name,server_id",
      user.profile,
    ),
    stmt(db, "SELECT id,label FROM devices WHERE profile=? ORDER BY label,id", user.profile),
    stmt(
      db,
      "SELECT id,label,code FROM enrollments WHERE profile=? AND state='verified' AND mode='signin' AND expires>? ORDER BY created",
      user.profile,
      now,
    ),
    stmt(db, "SELECT id,name,email,avatar FROM profiles WHERE id=?", user.profile),
  ]);
  return {
    profile: profile.results[0],
    hosts: hosts.results.map(({ routes, member, ...rest }) => ({
      ...rest,
      hosts: JSON.parse(routes),
      member: !!member,
    })),
    devices: devices.results.map((d) => ({ ...d, current: d.id === user.id })),
    pending: pending.results,
  };
}

function routes(values) {
  ensure(Array.isArray(values) && values.length <= 32);
  const allowed =
    /^(?:relay![A-Za-z0-9_-]{43}@)?(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[A-Fa-f0-9:.]+\])(?::[0-9]{1,5})?$/;
  for (const addr of values) ensure(typeof addr === "string" && addr.length <= 320 && allowed.test(addr));
  return [...new Set(values)];
}

export async function accountAction(db, user, path, input, now) {
  if (path === "home") return home(db, user, now);
  if (path === "profile/update") {
    await stmt(
      db,
      "UPDATE profiles SET name=?,avatar=? WHERE id=?",
      field(input.name, 60),
      avatar(input.avatar),
      user.profile,
    ).run();
  } else if (path === "profile/delete") {
    const email = field(input.confirmationEmail, 254).toLowerCase();
    ensure(email === user.email, 400, "Enter your verified email address to delete this profile.");
    // The trigger removes this account's directory, devices, credentials, proofs and sign-ins atomically.
    const result = await stmt(
      db,
      "DELETE FROM profiles WHERE id=? AND email=? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND profile=profiles.id)",
      user.profile,
      email,
      user.id,
    ).run();
    ensure(changed(result), 401, "Sign in again to delete this profile.");
  } else if (path === "devices/approve") {
    const result = await stmt(
      db,
      `UPDATE enrollments SET state='approved',otp_hash=NULL WHERE id=? AND code=? AND
      profile=? AND state='verified' AND mode='signin' AND expires>? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND profile=?)`,
      field(input.id, 40),
      field(input.code, 6),
      user.profile,
      now,
      user.id,
      user.profile,
    ).run();
    ensure(changed(result), 409, "This request was already handled or expired.");
  } else if (path === "devices/revoke") {
    await stmt(
      db,
      "DELETE FROM devices WHERE id=? AND profile=?",
      field(input.deviceId, 40),
      user.profile,
    ).run();
  } else if (path === "hosts/put") {
    const id = serverID(input.serverId),
      serverKey = key(input.serverKey),
      name = field(input.name, 120),
      addresses = routes(input.hosts);
    const result = await stmt(
      db,
      `INSERT INTO hosts(profile,server_id,server_key,name,routes,member) SELECT ?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM hosts WHERE profile=? AND server_id=?) OR (SELECT COUNT(*) FROM hosts WHERE profile=?)<256
      ON CONFLICT(profile,server_id) DO UPDATE SET name=excluded.name,routes=excluded.routes,member=excluded.member
      WHERE hosts.server_key=excluded.server_key`,
      user.profile,
      id,
      serverKey,
      name,
      JSON.stringify(addresses),
      input.member === true ? 1 : 0,
      user.profile,
      id,
      user.profile,
    ).run();
    ensure(changed(result), 409, "This host key changed or the profile directory is full.");
  } else if (path === "hosts/remove") {
    await stmt(
      db,
      "DELETE FROM hosts WHERE profile=? AND server_id=?",
      user.profile,
      serverID(input.serverId),
    ).run();
  } else if (path === "proofs/issue") {
    const { purpose, serverId, serverKey, publicKey } = proofTarget(input);
    if (purpose === "connect")
      ensure(
        await stmt(
          db,
          "SELECT 1 FROM hosts WHERE profile=? AND server_id=? AND server_key=?",
          user.profile,
          serverId,
          serverKey,
        ).first(),
        403,
        "This computer is not linked to your profile.",
      );
    const ticket = random();
    const result = await db.batch([
      stmt(db, "DELETE FROM proofs WHERE expires<=?", now),
      stmt(
        db,
        `INSERT INTO proofs(hash,device,purpose,server_id,server_key,public_key,expires)
        SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM proofs WHERE device=?)<64`,
        await hash(ticket),
        user.id,
        purpose,
        serverId,
        serverKey,
        publicKey,
        now + 2 * MINUTE,
        user.id,
      ),
    ]);
    ensure(changed(result[1]), 429, "Too many simultaneous host connections. Try again shortly.");
    return { ticket };
  } else ensure(false, 404, "Unknown profile operation.");
  return { ok: true };
}

function proofTarget(input) {
  const purpose = input.purpose;
  ensure(purpose === "bind" || purpose === "connect");
  return {
    purpose,
    serverId: serverID(input.serverId),
    serverKey: key(input.serverKey),
    publicKey: purpose === "connect" ? key(input.publicKey) : "",
  };
}

export async function redeem(db, input, now) {
  const target = proofTarget(input);
  const proof = await stmt(
    db,
    `DELETE FROM proofs WHERE hash=? AND purpose=? AND server_id=? AND server_key=? AND public_key=? AND expires>? RETURNING device`,
    await hash(key(input.ticket)),
    target.purpose,
    target.serverId,
    target.serverKey,
    target.publicKey,
    now,
  ).first();
  const device =
    proof &&
    (await stmt(
      db,
      `SELECT d.profile AS profileId,d.id AS deviceId,p.name,d.status_key AS statusKey
    FROM devices d JOIN profiles p ON d.profile=p.id WHERE d.id=?`,
      proof.device,
    ).first());
  ensure(device, 403, "This host proof expired or the device was removed.");
  return device;
}
