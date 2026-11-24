import { Buffer } from "node:buffer";

export const ORIGIN = "https://profile.botkins.app";
export const RP = new URL(ORIGIN).hostname;
export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const encode = (value) => Buffer.from(value).toString("base64url");
export const decode = (value) => new Uint8Array(Buffer.from(value, "base64url"));
export const random = (bytes = 32) => encode(crypto.getRandomValues(new Uint8Array(bytes)));
export const hash = async (text) => encode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
export function digits() {
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= 4294000000);
  return String(value[0] % 1000000).padStart(6, "0");
}
export async function otpHash(env, id, code) {
  ensure(
    typeof env.PROFILE_SECRET === "string" && env.PROFILE_SECRET.length >= 32,
    503,
    "Email verification is temporarily unavailable.",
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.PROFILE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + "/" + code)));
}
export class Failure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function ensure(ok, status = 400, message = "That request is invalid.") {
  if (!ok) throw new Failure(status, message);
}
export function field(value, max = 80) {
  ensure(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= max &&
      !/[\u0000-\u001f\u007f]/u.test(value),
  );
  return value.trim();
}
export function key(value) {
  ensure(typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value));
  return value;
}
export function serverID(value) {
  ensure(typeof value === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(value));
  return value;
}
export const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
export const changed = (result) => result.meta.changes > 0;
export const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
export async function bodyOf(request) {
  ensure(request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "application/json", 415);
  ensure(Number(request.headers.get("Content-Length") ?? 0) <= 32_768, 413);
  const reader = request.body?.getReader();
  ensure(reader);
  const buffer = new Uint8Array(32768);
  let used = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (used + value.length > buffer.length) {
      await reader.cancel();
      throw new Failure(413, "That request is too large.");
    }
    buffer.set(value, used);
    used += value.length;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(buffer.subarray(0, used)));
  } catch {
    throw new Failure(400, "Invalid JSON.");
  }
  ensure(body && typeof body === "object" && !Array.isArray(body));
  return body;
}
export async function currentDevice(db, request) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  const device =
    token &&
    (await stmt(
      db,
      "SELECT d.id,d.profile,p.name,p.email FROM devices d JOIN profiles p ON p.id=d.profile WHERE d.token_hash=?",
      await hash(token),
    ).first());
  ensure(device, 401, "Sign in to your Botkins profile on this device.");
  return device;
}
