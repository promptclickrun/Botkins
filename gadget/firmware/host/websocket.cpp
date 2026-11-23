#include "websocket.hpp"

#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstring>

#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include "botkins/crypto.hpp"
#include "botkins/sockets.hpp"

namespace botkins {

namespace {
#ifdef MSG_NOSIGNAL
const int kSendFlags = MSG_NOSIGNAL;  // a socket the other end closed answers EPIPE, not a signal
#else
const int kSendFlags = 0;
#endif
const char* kGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const size_t kMaxHandshake = 16 * 1024;
const int kSendMs = 10000;

using Clock = std::chrono::steady_clock;
int left(Clock::time_point deadline) { return (int)std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count(); }

/** Waits until the socket can be read (or written); -1 waits for ever. False when the time ran out or it failed. */
bool ready(int fd, bool writing, int ms) {
  pollfd one{fd, (short)(writing ? POLLOUT : POLLIN), 0};
  for (;;) {
    int got = poll(&one, 1, ms);
    if (got < 0 && errno == EINTR) continue;
    return got > 0;
  }
}

bool send_all(int fd, const uint8_t* data, size_t size, Clock::time_point deadline) {
  while (size) {
    ssize_t sent = ::send(fd, data, size, kSendFlags);
    if (sent > 0) {
      data += sent;
      size -= (size_t)sent;
    } else if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
      if (!ready(fd, true, left(deadline))) return false;
    } else return false;
  }
  return true;
}

// SHA-1, for the handshake's Sec-WebSocket-Accept only (RFC 3174).
void sha1(const uint8_t* data, size_t size, uint8_t out[20]) {
  uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
  auto rol = [](uint32_t x, int n) { return (x << n) | (x >> (32 - n)); };
  const uint64_t bits = (uint64_t)size * 8;
  // The message, a 1 bit, zeros, and its length in bits: a whole number of 64-byte blocks.
  const size_t total = ((size + 8) / 64 + 1) * 64;
  for (size_t block = 0; block < total; block += 64) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++) {
      uint32_t word = 0;
      for (int j = 0; j < 4; j++) {
        const size_t at = block + (size_t)i * 4 + j;
        uint8_t byte = at < size ? data[at] : at == size ? 0x80 : 0;
        if (at >= total - 8) byte = (uint8_t)(bits >> (8 * (total - 1 - at)));
        word = word << 8 | byte;
      }
      w[i] = word;
    }
    for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20) f = (b & c) | (~b & d), k = 0x5A827999;
      else if (i < 40) f = b ^ c ^ d, k = 0x6ED9EBA1;
      else if (i < 60) f = (b & c) | (b & d) | (c & d), k = 0x8F1BBCDC;
      else f = b ^ c ^ d, k = 0xCA62C1D6;
      const uint32_t t = rol(a, 5) + f + e + k + w[i];
      e = d, d = c, c = rol(b, 30), b = a, a = t;
    }
    h[0] += a, h[1] += b, h[2] += c, h[3] += d, h[4] += e;
  }
  for (int i = 0; i < 20; i++) out[i] = (uint8_t)(h[i / 4] >> (24 - 8 * (i % 4)));
}

/** Base64 with its padding, as HTTP headers carry it. */
std::string base64(const uint8_t* data, size_t size) {
  static const char* digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < size; i += 3) {
    const uint32_t n = (uint32_t)data[i] << 16 | (i + 1 < size ? data[i + 1] << 8 : 0) | (i + 2 < size ? data[i + 2] : 0);
    out += digits[n >> 18 & 63];
    out += digits[n >> 12 & 63];
    out += i + 1 < size ? digits[n >> 6 & 63] : '=';
    out += i + 2 < size ? digits[n & 63] : '=';
  }
  return out;
}

/** A header's value in a handshake answer whose names were lowercased, trimmed; "" when it is absent. */
std::string header(const std::string& lower, const std::string& head, const char* name) {
  const std::string key = std::string("\r\n") + name + ":";
  size_t at = lower.find(key);
  if (at == std::string::npos) return "";
  at += key.size();
  size_t end = head.find("\r\n", at);
  std::string value = head.substr(at, end == std::string::npos ? std::string::npos : end - at);
  while (!value.empty() && isspace((unsigned char)value.front())) value.erase(0, 1);
  while (!value.empty() && isspace((unsigned char)value.back())) value.pop_back();
  return value;
}
}  // namespace

HostSocket::~HostSocket() { close(); }

bool HostSocket::open(const std::string& url, const std::string& protocol, int timeout_ms, size_t max_message, Events events) {
  const Clock::time_point deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  if (url.compare(0, 5, "ws://") != 0 || fd_ >= 0) return false;
  const size_t slash = url.find('/', 5);
  const std::string authority = url.substr(5, slash == std::string::npos ? std::string::npos : slash - 5);
  const std::string path = slash == std::string::npos ? "/" : url.substr(slash);
  // 80 when the address names no port.
  const size_t bracket = authority.rfind(']');
  const size_t colon = authority.rfind(':');
  const bool has_port = colon != std::string::npos && (bracket == std::string::npos || colon > bracket);
  int fd = connect_to(has_port ? authority : authority + ":80", timeout_ms);
  if (fd < 0) return false;

  uint8_t nonce[16];
  random_bytes(nonce, sizeof nonce);
  const std::string key = base64(nonce, sizeof nonce);
  const std::string ask = "GET " + path + " HTTP/1.1\r\nHost: " + authority + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
                          "\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: " + protocol + "\r\n\r\n";
  std::string answer;
  size_t end = std::string::npos;
  bool ok = send_all(fd, (const uint8_t*)ask.data(), ask.size(), deadline);
  while (ok && end == std::string::npos) {
    char chunk[1024];
    if (!ready(fd, false, left(deadline))) ok = false;
    else {
      ssize_t got = recv(fd, chunk, sizeof chunk, 0);
      if (got > 0) answer.append(chunk, (size_t)got);
      else if (got == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) ok = false;
      end = answer.find("\r\n\r\n");
      if (end == std::string::npos && answer.size() > kMaxHandshake) ok = false;
    }
  }
  if (ok) {
    // 101, the accept that proves a WebSocket server read this key, and the one subprotocol offered.
    const std::string head = answer.substr(0, end);
    std::string lower = head;
    for (char& c : lower) c = (char)tolower((unsigned char)c);
    const std::string proof = key + kGuid;
    uint8_t digest[20];
    sha1((const uint8_t*)proof.data(), proof.size(), digest);
    ok = head.compare(0, 13, "HTTP/1.1 101 ") == 0 && header(lower, head, "sec-websocket-accept") == base64(digest, sizeof digest) &&
         header(lower, head, "sec-websocket-protocol") == protocol;
  }
  if (!ok) {
    ::close(fd);
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(write_);
    fd_ = fd;
  }
  events_ = std::move(events);
  max_message_ = max_message;
  closing_ = false;
  // What came after the handshake is already the first frames.
  reader_ = std::thread([this, rest = answer.substr(end + 4)] { read_loop(rest); });
  return true;
}

bool HostSocket::write_frame(uint8_t opcode, const uint8_t* data, size_t size, int timeout_ms) {
  if (fd_ < 0) return false;
  const Clock::time_point deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  // FIN, the opcode, then the length with the mask bit (a client masks every frame), then the mask.
  uint8_t head[14];
  size_t at = 0;
  head[at++] = (uint8_t)(0x80 | opcode);
  if (size < 126) head[at++] = (uint8_t)(0x80 | size);
  else if (size <= 0xffff) {
    head[at++] = 0x80 | 126;
    head[at++] = (uint8_t)(size >> 8);
    head[at++] = (uint8_t)size;
  } else {
    head[at++] = 0x80 | 127;
    for (int i = 7; i >= 0; i--) head[at++] = (uint8_t)((uint64_t)size >> (8 * i));
  }
  uint8_t* mask = head + at;
  random_bytes(mask, 4);
  at += 4;
  bool ok = send_all(fd_, head, at, deadline);
  // Masked a piece at a time, so a large message is never copied whole.
  uint8_t piece[2048];
  for (size_t done = 0; ok && done < size;) {
    const size_t count = size - done < sizeof piece ? size - done : sizeof piece;
    for (size_t i = 0; i < count; i++) piece[i] = data[done + i] ^ mask[(done + i) & 3];
    ok = send_all(fd_, piece, count, deadline);
    done += count;
  }
  // A frame cut off midway leaves the stream unreadable: the connection ends, and the reader says so.
  if (!ok) shutdown(fd_, SHUT_RDWR);
  return ok;
}

bool HostSocket::send(const uint8_t* data, size_t size, bool binary) {
  std::lock_guard<std::mutex> lock(write_);
  if (closing_) return false;
  return write_frame(binary ? 0x2 : 0x1, data, size, kSendMs);
}

void HostSocket::read_loop(std::string buffer) {
  std::string message;  // a message in fragments, until its last
  uint8_t kind = 0;
  int code = 0;
  auto refuse = [this, &code](int reason) {
    std::lock_guard<std::mutex> lock(write_);
    const uint8_t body[2] = {(uint8_t)(reason >> 8), (uint8_t)reason};
    write_frame(0x8, body, 2, 1000);
    code = reason;
  };
  for (;;) {
    // A frame: its header, then its payload, read whole before it is used.
    size_t need = 2, length = 0;
    bool masked = false;
    if (buffer.size() >= 2) {
      const uint8_t second = (uint8_t)buffer[1];
      masked = second & 0x80;
      length = second & 0x7f;
      need = 2 + (length == 126 ? 2 : length == 127 ? 8 : 0) + (masked ? 4 : 0);
      if (buffer.size() >= need) {
        if (length == 126) length = (size_t)(uint8_t)buffer[2] << 8 | (uint8_t)buffer[3];
        else if (length == 127) {
          uint64_t big = 0;
          for (int i = 0; i < 8; i++) big = big << 8 | (uint8_t)buffer[2 + i];
          length = big > max_message_ ? max_message_ + 1 : (size_t)big;
        }
        if (length > max_message_) {
          refuse(1009);
          break;
        }
        need += length;
        if (buffer.capacity() < need) buffer.reserve(need);
      }
    }
    if (buffer.size() < need) {
      char chunk[2048];
      if (!ready(fd_, false, -1)) break;
      ssize_t got = recv(fd_, chunk, sizeof chunk, 0);
      if (got > 0) buffer.append(chunk, (size_t)got);
      else if (got == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) break;
      continue;
    }
    const uint8_t first = (uint8_t)buffer[0];
    const bool fin = first & 0x80;
    const uint8_t opcode = first & 0x0f;
    const size_t start = need - length;
    if (masked)
      for (size_t i = 0; i < length; i++) buffer[start + i] ^= buffer[start - 4 + (i & 3)];
    const uint8_t* payload = (const uint8_t*)buffer.data() + start;

    if (opcode == 0x8) {
      // The other end closes: say the same back, then stop.
      code = length >= 2 ? payload[0] << 8 | payload[1] : 1005;
      std::lock_guard<std::mutex> lock(write_);
      if (!closing_) write_frame(0x8, payload, length >= 2 ? 2 : 0, 1000);
      break;
    } else if (opcode == 0x9) {
      std::lock_guard<std::mutex> lock(write_);
      if (!closing_) write_frame(0xA, payload, length, kSendMs);
    } else if (opcode == 0x1 || opcode == 0x2 || opcode == 0x0) {
      if ((opcode == 0x0) != (kind != 0)) {
        // A continuation with no message begun, or a new message inside another.
        refuse(1002);
        break;
      }
      if (opcode != 0x0 && fin) {
        if (events_.message) events_.message(payload, length, opcode == 0x2);
      } else {
        if (opcode != 0x0) kind = opcode;
        if (message.size() + length > max_message_) {
          refuse(1009);
          break;
        }
        message.append((const char*)payload, length);
        if (fin) {
          if (events_.message) events_.message((const uint8_t*)message.data(), message.size(), kind == 0x2);
          message = std::string();
          kind = 0;
        }
      }
    } else if (opcode != 0xA) {
      refuse(1002);
      break;
    }
    buffer.erase(0, need);
  }
  {
    std::lock_guard<std::mutex> lock(write_);
    if (fd_ >= 0) shutdown(fd_, SHUT_RDWR);
  }
  if (!closing_ && events_.closed) events_.closed(code);
}

void HostSocket::close() {
  {
    std::lock_guard<std::mutex> lock(write_);
    if (!closing_.exchange(true) && fd_ >= 0) {
      const uint8_t body[2] = {1000 >> 8, 1000 & 0xff};
      write_frame(0x8, body, 2, 1000);
    }
    if (fd_ >= 0) shutdown(fd_, SHUT_RDWR);
  }
  if (reader_.joinable()) {
    if (reader_.get_id() == std::this_thread::get_id()) reader_.detach();
    else reader_.join();
  }
  std::lock_guard<std::mutex> lock(write_);
  if (fd_ >= 0) ::close(fd_);
  fd_ = -1;
}

}  // namespace botkins
