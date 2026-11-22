// Cryptography for the Botkins link on a gadget: X25519, HKDF-SHA256 and ChaCha20-Poly1305, the
// same three the computer uses (mobile/link-host/crypto.mjs). X25519 and the cipher are
// Monocypher's (third_party/monocypher); SHA-256 is here. Nothing in this file needs the platform
// except random bytes, which the port gives with set_random().
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace botkins {

using Bytes = std::vector<uint8_t>;

/** The port's source of random bytes (the chip's generator). Set once, before anything else. */
void set_random(void (*fill)(uint8_t* out, size_t size));
void random_bytes(uint8_t* out, size_t size);

struct KeyPair {
  uint8_t pub[32];
  uint8_t secret[32];
};
KeyPair new_key_pair();
KeyPair key_pair_from_secret(const uint8_t secret[32]);
/** The X25519 shared secret. False when the other side sent a low-order point (an all-zero secret). */
bool agree(const uint8_t secret[32], const uint8_t their_pub[32], uint8_t out[32]);

void sha256(const uint8_t* data, size_t size, uint8_t out[32]);
void hmac_sha256(const uint8_t* key, size_t key_size, const uint8_t* data, size_t size, uint8_t out[32]);
/** HKDF-SHA256 with 32 bytes out, as the link uses it everywhere. */
void hkdf(const uint8_t* ikm, size_t ikm_size, const uint8_t* salt, size_t salt_size, std::string_view info, uint8_t out[32]);

/** ChaCha20-Poly1305 (IETF): the ciphertext followed by its 16-byte tag. */
Bytes seal(const uint8_t key[32], const uint8_t nonce[12], const uint8_t* plain, size_t size, std::string_view aad);
/** Opens what seal() made. False when the key, nonce, text or aad isn't the same. */
bool open(const uint8_t key[32], const uint8_t nonce[12], const uint8_t* sealed, size_t size, std::string_view aad, Bytes& out);
/** The nonce of message `seq` in a session: four zero bytes, then the number, big-endian. */
void seq_nonce(uint64_t seq, uint8_t out[12]);

/** base64url without padding. The reader takes either alphabet, with or without padding. */
std::string b64u(const uint8_t* data, size_t size);
inline std::string b64u(const Bytes& data) { return b64u(data.data(), data.size()); }
bool unb64(std::string_view text, Bytes& out);

/** A sealed box with a random nonce in front, as base64url: the one-off session messages. */
std::string box(const uint8_t key[32], std::string_view json, std::string_view aad);
bool unbox(const uint8_t key[32], std::string_view text, std::string_view aad, std::string& json);

/** Checks the three primitives against the vectors of their RFCs. A port runs it once in a debug build. */
bool crypto_self_test();

}  // namespace botkins
