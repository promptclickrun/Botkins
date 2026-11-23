// Cryptography for the Botkins link on the phone, in plain JavaScript (@noble): X25519 key
// agreement, HKDF-SHA256 and ChaCha20-Poly1305. The desktop does the same with Node's crypto
// (link-host/crypto.mjs); tests/link.test.ts checks the two against each other.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

let source: (length: number) => Uint8Array = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));
/** The phone app supplies its secure random source (expo-crypto) before anything is paired. */
export function setRandomSource(next: (length: number) => Uint8Array) {
  source = next;
}
export const randomBytes = (length: number) => source(length);

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;
LOOKUP["+".charCodeAt(0)] = 62;
LOOKUP["/".charCodeAt(0)] = 63;

export function b64u(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return out;
}

export function unb64u(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let held = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code] : -1;
    if (value < 0) throw new Error("Bad base64");
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 255;
    }
  }
  return out.subarray(0, at);
}

const encoder = new TextEncoder();
export const utf8 = (text: string) => encoder.encode(text);

/** UTF-8 to text. Uses the engine's decoder when it has one. */
export function fromUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const a = bytes[i++];
    let point = a;
    if (a >= 0xf0) point = ((a & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (a >= 0xe0) point = ((a & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (a >= 0xc0) point = ((a & 31) << 6) | (bytes[i++] & 63);
    out += String.fromCodePoint(point);
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function newKeyPair(): KeyPair {
  const secretKey = randomBytes(32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}
export const publicKeyOf = (secretKey: Uint8Array) => x25519.getPublicKey(secretKey);

/** The X25519 shared secret of our secret key and their public key. */
export function agree(secretKey: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  if (theirPublic.length !== 32) throw new Error("Bad public key");
  const secret = x25519.getSharedSecret(secretKey, theirPublic);
  if (secret.every((byte) => byte === 0)) throw new Error("Bad public key");
  return secret;
}

export const hkdf = (secret: Uint8Array, salt: Uint8Array, info: string, length = 32) => nobleHkdf(sha256, secret, salt, utf8(info), length);

/** ChaCha20-Poly1305: the ciphertext followed by its 16-byte tag. */
export const seal = (key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: string) => chacha20poly1305(key, nonce, utf8(aad)).encrypt(plaintext);
/** Opens what seal() made. Throws when the key, nonce, text or aad isn't the same. */
export const open = (key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: string) => chacha20poly1305(key, nonce, utf8(aad)).decrypt(sealed);

/** A sealed box with a random nonce in front, for the one-off pairing and session messages. */
export function box(key: Uint8Array, value: unknown, aad: string): string {
  const nonce = randomBytes(12);
  return b64u(concat(nonce, seal(key, nonce, utf8(JSON.stringify(value)), aad)));
}
export function unbox<T>(key: Uint8Array, text: string, aad: string): T {
  const bytes = unb64u(text);
  if (bytes.length < 28) throw new Error("Too short");
  return JSON.parse(fromUtf8(open(key, bytes.subarray(0, 12), bytes.subarray(12), aad))) as T;
}

/** The nonce of message `seq` in a session: four zero bytes, then the number, big-endian. */
export function seqNonce(seq: number): Uint8Array {
  const nonce = new Uint8Array(12);
  let rest = seq;
  for (let i = 11; i >= 4; i--) {
    nonce[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return nonce;
}
export function pushNonce(counter: number): Uint8Array {
  const nonce = seqNonce(counter);
  nonce[0] = 1;
  return nonce;
}
export const seqBytes = (seq: number) => seqNonce(seq).subarray(4);

/** A code as typed: upper case, without spaces or dashes. */
export const cleanCode = (text: string) => text.toUpperCase().replace(/[^0-9A-Z]/g, "");

export const INFO = {
  pair: "botkins/pair/v1",
  device: "botkins/device/v1",
  session: "botkins/session/v1",
  toHost: "botkins/c2s/v1",
  toPhone: "botkins/s2c/v1",
} as const;
