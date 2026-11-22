#include "botkins/crypto.hpp"

#include <cstring>

extern "C" {
#include "monocypher.h"
}

namespace botkins {

static void (*g_random)(uint8_t*, size_t) = nullptr;
void set_random(void (*fill)(uint8_t*, size_t)) { g_random = fill; }
void random_bytes(uint8_t* out, size_t size) {
  // No generator is a port's mistake. Zeros would make every key the same, so stop here instead.
  if (!g_random) __builtin_trap();
  g_random(out, size);
}

KeyPair key_pair_from_secret(const uint8_t secret[32]) {
  KeyPair pair;
  memcpy(pair.secret, secret, 32);
  crypto_x25519_public_key(pair.pub, pair.secret);
  return pair;
}
KeyPair new_key_pair() {
  uint8_t secret[32];
  random_bytes(secret, 32);
  KeyPair pair = key_pair_from_secret(secret);
  crypto_wipe(secret, 32);
  return pair;
}
bool agree(const uint8_t secret[32], const uint8_t their_pub[32], uint8_t out[32]) {
  crypto_x25519(out, secret, their_pub);
  static const uint8_t zero[32] = {0};
  return crypto_verify32(out, zero) != 0;
}

// ── SHA-256 (FIPS 180-4) ────────────────────────────────────────────────────────────────────────

namespace {
const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

struct Sha {
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  uint8_t block[64];
  size_t held = 0;
  uint64_t total = 0;

  static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
  void compress(const uint8_t* p) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) w[i] = (uint32_t)p[i * 4] << 24 | (uint32_t)p[i * 4 + 1] << 16 | (uint32_t)p[i * 4 + 2] << 8 | p[i * 4 + 3];
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  void update(const uint8_t* data, size_t size) {
    total += size;
    while (size) {
      size_t take = 64 - held < size ? 64 - held : size;
      memcpy(block + held, data, take);
      held += take; data += take; size -= take;
      if (held == 64) { compress(block); held = 0; }
    }
  }
  void finish(uint8_t out[32]) {
    uint64_t bits = total * 8;
    uint8_t pad = 0x80;
    update(&pad, 1);
    uint8_t zero = 0;
    while (held != 56) update(&zero, 1);
    uint8_t length[8];
    for (int i = 0; i < 8; i++) length[i] = (uint8_t)(bits >> (56 - 8 * i));
    update(length, 8);
    for (int i = 0; i < 8; i++) { out[i * 4] = h[i] >> 24; out[i * 4 + 1] = h[i] >> 16; out[i * 4 + 2] = h[i] >> 8; out[i * 4 + 3] = h[i]; }
  }
};
}  // namespace

void sha256(const uint8_t* data, size_t size, uint8_t out[32]) {
  Sha sha;
  sha.update(data, size);
  sha.finish(out);
}

namespace {
/** HMAC over several pieces, so HKDF needs no copies. */
struct Hmac {
  Sha inner;
  uint8_t outer_pad[64];
  Hmac(const uint8_t* key, size_t key_size) {
    uint8_t k[64] = {0};
    if (key_size > 64) sha256(key, key_size, k);
    else if (key_size) memcpy(k, key, key_size);
    uint8_t inner_pad[64];
    for (int i = 0; i < 64; i++) { inner_pad[i] = k[i] ^ 0x36; outer_pad[i] = k[i] ^ 0x5c; }
    inner.update(inner_pad, 64);
    crypto_wipe(k, 64);
    crypto_wipe(inner_pad, 64);
  }
  void update(const uint8_t* data, size_t size) { inner.update(data, size); }
  void finish(uint8_t out[32]) {
    uint8_t digest[32];
    inner.finish(digest);
    Sha outer;
    outer.update(outer_pad, 64);
    outer.update(digest, 32);
    outer.finish(out);
    crypto_wipe(outer_pad, 64);
  }
};
}  // namespace

void hmac_sha256(const uint8_t* key, size_t key_size, const uint8_t* data, size_t size, uint8_t out[32]) {
  Hmac mac(key, key_size);
  mac.update(data, size);
  mac.finish(out);
}

void hkdf(const uint8_t* ikm, size_t ikm_size, const uint8_t* salt, size_t salt_size, std::string_view info, uint8_t out[32]) {
  // RFC 5869. One block of output is all the link ever asks for.
  uint8_t prk[32];
  static const uint8_t no_salt[32] = {0};
  hmac_sha256(salt_size ? salt : no_salt, salt_size ? salt_size : 32, ikm, ikm_size, prk);
  Hmac expand(prk, 32);
  expand.update((const uint8_t*)info.data(), info.size());
  const uint8_t one = 1;
  expand.update(&one, 1);
  expand.finish(out);
  crypto_wipe(prk, 32);
}

// ── ChaCha20-Poly1305 ───────────────────────────────────────────────────────────────────────────

Bytes seal(const uint8_t key[32], const uint8_t nonce[12], const uint8_t* plain, size_t size, std::string_view aad) {
  Bytes out(size + 16);
  crypto_aead_ctx ctx;
  crypto_aead_init_ietf(&ctx, key, nonce);
  // One message for each context: Monocypher's first message is RFC 8439's.
  crypto_aead_write(&ctx, out.data(), out.data() + size, (const uint8_t*)aad.data(), aad.size(), plain, size);
  crypto_wipe(&ctx, sizeof ctx);
  return out;
}
bool open(const uint8_t key[32], const uint8_t nonce[12], const uint8_t* sealed, size_t size, std::string_view aad, Bytes& out) {
  if (size < 16) return false;
  out.resize(size - 16);
  crypto_aead_ctx ctx;
  crypto_aead_init_ietf(&ctx, key, nonce);
  int bad = crypto_aead_read(&ctx, out.data(), sealed + size - 16, (const uint8_t*)aad.data(), aad.size(), sealed, size - 16);
  crypto_wipe(&ctx, sizeof ctx);
  if (bad) out.clear();
  return !bad;
}
void seq_nonce(uint64_t seq, uint8_t out[12]) {
  memset(out, 0, 4);
  for (int i = 0; i < 8; i++) out[4 + i] = (uint8_t)(seq >> (56 - 8 * i));
}

// ── base64 ──────────────────────────────────────────────────────────────────────────────────────

std::string b64u(const uint8_t* data, size_t size) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  out.reserve((size * 4 + 2) / 3);
  size_t i = 0;
  for (; i + 2 < size; i += 3) {
    uint32_t n = (uint32_t)data[i] << 16 | (uint32_t)data[i + 1] << 8 | data[i + 2];
    out += alphabet[n >> 18]; out += alphabet[(n >> 12) & 63]; out += alphabet[(n >> 6) & 63]; out += alphabet[n & 63];
  }
  if (size - i == 1) {
    uint32_t n = (uint32_t)data[i] << 16;
    out += alphabet[n >> 18]; out += alphabet[(n >> 12) & 63];
  } else if (size - i == 2) {
    uint32_t n = (uint32_t)data[i] << 16 | (uint32_t)data[i + 1] << 8;
    out += alphabet[n >> 18]; out += alphabet[(n >> 12) & 63]; out += alphabet[(n >> 6) & 63];
  }
  return out;
}
bool unb64(std::string_view text, Bytes& out) {
  out.clear();
  out.reserve(text.size() * 3 / 4);
  uint32_t held = 0;
  int bits = 0;
  for (char c : text) {
    int v;
    if (c >= 'A' && c <= 'Z') v = c - 'A';
    else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
    else if (c >= '0' && c <= '9') v = c - '0' + 52;
    else if (c == '-' || c == '+') v = 62;
    else if (c == '_' || c == '/') v = 63;
    else if (c == '=') break;
    else return false;
    held = held << 6 | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back((uint8_t)(held >> bits));
    }
  }
  return true;
}

std::string box(const uint8_t key[32], std::string_view json, std::string_view aad) {
  Bytes out(12);
  random_bytes(out.data(), 12);
  Bytes sealed = seal(key, out.data(), (const uint8_t*)json.data(), json.size(), aad);
  out.insert(out.end(), sealed.begin(), sealed.end());
  return b64u(out);
}
bool unbox(const uint8_t key[32], std::string_view text, std::string_view aad, std::string& json) {
  Bytes bytes, plain;
  if (!unb64(text, bytes) || bytes.size() < 28) return false;
  if (!open(key, bytes.data(), bytes.data() + 12, bytes.size() - 12, aad, plain)) return false;
  json.assign((const char*)plain.data(), plain.size());
  return true;
}

// ── Self test ───────────────────────────────────────────────────────────────────────────────────

namespace {
Bytes hex(const char* text) {
  Bytes out;
  auto nibble = [](char c) { return c <= '9' ? c - '0' : (c | 32) - 'a' + 10; };
  for (size_t i = 0; text[i] && text[i + 1]; i += 2) out.push_back((uint8_t)(nibble(text[i]) << 4 | nibble(text[i + 1])));
  return out;
}
}  // namespace

bool crypto_self_test() {
  // SHA-256("abc"), FIPS 180-4.
  uint8_t digest[32];
  sha256((const uint8_t*)"abc", 3, digest);
  if (Bytes(digest, digest + 32) != hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")) return false;
  // HKDF-SHA256, RFC 5869 test case 1 (its first 32 bytes).
  Bytes ikm(22, 0x0b), salt = hex("000102030405060708090a0b0c"), info = hex("f0f1f2f3f4f5f6f7f8f9");
  uint8_t okm[32];
  hkdf(ikm.data(), ikm.size(), salt.data(), salt.size(), std::string_view((const char*)info.data(), info.size()), okm);
  if (Bytes(okm, okm + 32) != hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf")) return false;
  // X25519, RFC 7748 section 6.1.
  Bytes alice = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  Bytes bob_pub = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  KeyPair pair = key_pair_from_secret(alice.data());
  if (Bytes(pair.pub, pair.pub + 32) != hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")) return false;
  uint8_t shared[32];
  if (!agree(alice.data(), bob_pub.data(), shared)) return false;
  if (Bytes(shared, shared + 32) != hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")) return false;
  // ChaCha20-Poly1305, RFC 8439 section 2.8.2.
  Bytes key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
  Bytes nonce = hex("070000004041424344454647"), aad = hex("50515253c0c1c2c3c4c5c6c7");
  const char* plain = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
  Bytes sealed = seal(key.data(), nonce.data(), (const uint8_t*)plain, strlen(plain), std::string_view((const char*)aad.data(), aad.size()));
  if (sealed.size() != strlen(plain) + 16) return false;
  if (Bytes(sealed.end() - 16, sealed.end()) != hex("1ae10b594f09e26a7e902ecbd0600691")) return false;
  if (Bytes(sealed.begin(), sealed.begin() + 16) != hex("d31a8d34648e60db7b86afbc53ef7ec2")) return false;
  Bytes opened;
  if (!open(key.data(), nonce.data(), sealed.data(), sealed.size(), std::string_view((const char*)aad.data(), aad.size()), opened)) return false;
  if (std::string(opened.begin(), opened.end()) != plain) return false;
  sealed[3] ^= 1;
  if (open(key.data(), nonce.data(), sealed.data(), sealed.size(), std::string_view((const char*)aad.data(), aad.size()), opened)) return false;
  // base64url both ways, for every length of tail.
  for (size_t size = 0; size < 7; size++) {
    Bytes raw(size), back;
    for (size_t i = 0; i < size; i++) raw[i] = (uint8_t)(250 + i);
    if (!unb64(b64u(raw), back) || back != raw) return false;
  }
  return true;
}

}  // namespace botkins
