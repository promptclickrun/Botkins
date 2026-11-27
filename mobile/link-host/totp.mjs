// Pure Node RFC 6238 TOTP generator for vault-stored or manager-provided TOTP secrets.
//
// Accepts either a raw base32 secret (e.g. "JBSWY3DPEHPK3PXP") or an `otpauth://totp/...` URI.
// Key material is decoded into a Buffer and zeroed immediately after the HMAC completes so no
// raw key buffer lingers in heap memory.

import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALGORITHMS = new Map([
  ["SHA1", "sha1"],
  ["SHA-1", "sha1"],
  ["SHA256", "sha256"],
  ["SHA-256", "sha256"],
  ["SHA512", "sha512"],
  ["SHA-512", "sha512"],
]);

/** Decode an RFC 4648 base32 string (case-insensitive, spaces/hyphens/padding ignored) into a Buffer. */
export function decodeBase32(input) {
  const clean = String(input ?? "").toUpperCase().replace(/[\s=-]+/g, "");
  if (!clean) throw new Error("Empty TOTP secret.");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) throw new Error("Invalid base32 character in TOTP secret.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (bytes.length === 0) throw new Error("TOTP secret is too short.");
  return Buffer.from(bytes);
}

/** Parse either a raw base32 secret or an `otpauth://totp/...` URI into TOTP parameters. */
export function parseTotpSpec(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Empty TOTP secret.");
  if (/^otpauth:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("Invalid otpauth URI.");
    }
    if (url.hostname.toLowerCase() !== "totp") throw new Error("Only otpauth://totp URIs are supported.");
    const secret = url.searchParams.get("secret")?.trim();
    if (!secret) throw new Error("otpauth URI is missing its secret parameter.");
    const algoRaw = (url.searchParams.get("algorithm") || "SHA1").toUpperCase();
    const algorithm = ALGORITHMS.get(algoRaw);
    if (!algorithm) throw new Error("Unsupported TOTP algorithm.");
    const digits = Number(url.searchParams.get("digits") || 6);
    if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error("TOTP digits must be 6, 7, or 8.");
    const period = Number(url.searchParams.get("period") || 30);
    if (!Number.isInteger(period) || period < 10 || period > 300) throw new Error("TOTP period must be between 10 and 300 seconds.");
    return { secret, algorithm, digits, period };
  }
  return { secret: raw, algorithm: "sha1", digits: 6, period: 30 };
}

/**
 * Generate a current RFC 6238 TOTP code from a base32 secret or otpauth://totp URI.
 * If the input is already a 6-8 digit numeric code (e.g. returned directly by a password manager CLI),
 * return it unchanged when `allowCodePassthrough` is true.
 */
export function generateTotp(input, { now = Date.now(), allowCodePassthrough = false } = {}) {
  const raw = String(input ?? "").trim();
  if (allowCodePassthrough && /^\d{6,8}$/.test(raw)) {
    const period = 30;
    const epochSec = Math.floor(now / 1000);
    return { code: raw, period, remainingSeconds: period - (epochSec % period) };
  }
  const spec = parseTotpSpec(raw);
  const key = decodeBase32(spec.secret);
  const counterBuf = Buffer.alloc(8);
  try {
    const epochSec = Math.floor(now / 1000);
    const counter = Math.floor(epochSec / spec.period);
    counterBuf.writeBigUInt64BE(BigInt(counter), 0);
    const hmac = createHmac(spec.algorithm, key).update(counterBuf).digest();
    try {
      const offset = hmac[hmac.length - 1] & 0x0f;
      const binary =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
      const code = String(binary % (10 ** spec.digits)).padStart(spec.digits, "0");
      return {
        code,
        period: spec.period,
        remainingSeconds: spec.period - (epochSec % spec.period),
      };
    } finally {
      hmac.fill(0);
    }
  } finally {
    key.fill(0);
    counterBuf.fill(0);
  }
}
