// Cryptography for the Botkins link, on Node's own crypto: X25519 key agreement, HKDF-SHA256 and
// ChaCha20-Poly1305. The phone does the same with @noble (src/link/crypto.ts); tests/link.test.ts
// checks the two against each other.
//
// One cipher is not everywhere: Electron's Node is built on BoringSSL, which has no
// "chacha20-poly1305" (createCipheriv throws "Unknown cipher"), and Electron is where the desktop
// app runs this file. There the messages are sealed with @noble/ciphers, the library the phone
// uses, so an app on Electron must have that package installed. Plain Node needs nothing. CIPHER
// says which one is in use; BOTKINS_LINK_CIPHER=noble picks the library on plain Node too, so a
// test can check one against the other.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const hasNodeCipher = () => {
  try {
    createCipheriv("chacha20-poly1305", Buffer.alloc(32), Buffer.alloc(12), { authTagLength: 16 });
    return true;
  } catch {
    return false;
  }
};
/** Where ChaCha20-Poly1305 comes from in this process: "node" (its own crypto) or "noble" (@noble/ciphers). */
export const CIPHER = process.env.BOTKINS_LINK_CIPHER === "noble" || !hasNodeCipher() ? "noble" : "node";
// Loaded only where it is needed, and with require so this file needs no top-level await (the
// phone's tests load it through a CommonJS transform, which has none). Without the package nothing
// could be sealed, and a phone would be told its pairing code is wrong, so this fails here, at
// once and by name.
function library() {
  try {
    return createRequire(import.meta.url)("@noble/ciphers/chacha.js").chacha20poly1305;
  } catch (error) {
    throw new Error("The Botkins link needs the package @noble/ciphers here: this runtime has no ChaCha20-Poly1305 of its own.", { cause: error });
  }
}
const noble = CIPHER === "noble" ? library() : null;

export const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
export const unb64u = (text) => Buffer.from(String(text), "base64url");
export const random = (length) => randomBytes(length);

/** A new X25519 pair as raw 32-byte keys. */
export function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: unb64u(publicKey.export({ format: "jwk" }).x), privateKey: unb64u(jwk.d) };
}

const publicFrom = (raw) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64u(raw) }, format: "jwk" });

/** The X25519 shared secret of our private key and their public key (raw keys). */
export function agree(pair, theirPublic) {
  if (theirPublic.length !== 32) throw new Error("Bad public key");
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: b64u(pair.publicKey), d: b64u(pair.privateKey) }, format: "jwk" });
  const secret = diffieHellman({ privateKey, publicKey: publicFrom(theirPublic) });
  // An all-zero secret means the other side sent a low-order point.
  if (secret.every((byte) => byte === 0)) throw new Error("Bad public key");
  return secret;
}

export const hkdf = (secret, salt, info, length = 32) => Buffer.from(hkdfSync("sha256", secret, salt, Buffer.from(info, "utf8"), length));

/** ChaCha20-Poly1305: the ciphertext followed by its 16-byte tag. */
export function seal(key, nonce, plaintext, aad) {
  if (noble) return Buffer.from(noble(key, nonce, Buffer.from(aad, "utf8")).encrypt(plaintext));
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"), { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Opens what seal() made. Throws when the key, nonce, text or aad isn't the same. */
export function open(key, nonce, sealed, aad) {
  if (sealed.length < 16) throw new Error("Too short");
  if (noble) return Buffer.from(noble(key, nonce, Buffer.from(aad, "utf8")).decrypt(sealed));
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, "utf8"), { plaintextLength: sealed.length - 16 });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

/** A sealed box with a random nonce in front, for the one-off pairing and session messages. */
export function box(key, value, aad) {
  const nonce = randomBytes(12);
  return b64u(Buffer.concat([nonce, seal(key, nonce, Buffer.from(JSON.stringify(value), "utf8"), aad)]));
}
export function unbox(key, text, aad) {
  const bytes = unb64u(text);
  if (bytes.length < 28) throw new Error("Too short");
  return JSON.parse(open(key, bytes.subarray(0, 12), bytes.subarray(12), aad).toString("utf8"));
}

/** The nonce of message `seq` in a session: four zero bytes, then the number, big-endian. */
export function seqNonce(seq) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

// The first four bytes of every RPC nonce are zero.
export function pushNonce(counter) {
  const nonce = seqNonce(counter);
  nonce[0] = 1;
  return nonce;
}

// Pairing codes leave out the characters people confuse (0 O 1 I).
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function newCode(length = 12) {
  let code = "";
  // 32 characters, so every byte maps evenly onto the alphabet.
  for (const byte of randomBytes(length)) code += CODE_ALPHABET[byte & 31];
  return code;
}
/** A code as typed: upper case, without spaces or dashes. */
export const cleanCode = (text) => String(text ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");

export const INFO = {
  pair: "botkins/pair/v1",
  device: "botkins/device/v1",
  toHost: "botkins/c2s/v1",
  toPhone: "botkins/s2c/v1",
};
