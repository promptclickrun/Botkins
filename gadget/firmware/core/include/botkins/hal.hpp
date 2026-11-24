// What a board gives the core. A port (firmware/esp32 for a real board, firmware/host for a
// computer) fills in these four small interfaces, and a fifth for the relay if it can;
// everything else is the core's.
#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace botkins {

struct HttpResponse {
  /** 0 when the address didn't answer. */
  int status = 0;
  std::string body;
};

/** One HTTP request, waited for. `host` is "address:port". Called from two threads at once. */
struct Transport {
  virtual ~Transport() = default;
  virtual HttpResponse request(const std::string& host, const char* method, const std::string& path, const std::vector<std::pair<std::string, std::string>>& headers, const std::string& body, int timeout_ms) = 0;
  /** Whether a `relay!<room>@<relay>` host is carried (the core's RelayTransport). Others skip those entries. */
  virtual bool relays() const { return false; }
};

/**
 * A WebSocket client: one connection, whole binary and text messages. The core uses it for the relay
 * (botkins/relay.hpp), so a board without one reaches its computer only on its own network, and for
 * live voice (botkins/live.hpp: the live provider's own socket). A board's needs wss:// (TLS, checked
 * against the usual certificate authorities); ws:// is only for a server on the same machine
 * (127.0.0.1, localhost).
 */
struct Socket {
  struct Events {
    /** One whole message, its fragments joined. From the socket's own thread. */
    std::function<void(const uint8_t* data, size_t size, bool binary)> message;
    /**
     * The connection ended without `close()`: the other end closed it (its close code), or it failed
     * (0). Called at most once, from the socket's own thread, after the last `message`.
     */
    std::function<void(int code)> closed;
  };
  virtual ~Socket() = default;
  /**
   * Connects to `url` (its path and query whole) offering one subprotocol, which the server must
   * choose; an empty `protocol` offers none, and the server must then name none. Waits up to
   * `timeout_ms`. Events come only after it returned true. A message longer than `max_message` closes
   * the connection (1009).
   */
  virtual bool open(const std::string& url, const std::string& protocol, int timeout_ms, size_t max_message, Events events) = 0;
  /** Sends one message whole. Safe from any thread, also while another sends. False when the connection is gone. */
  virtual bool send(const uint8_t* data, size_t size, bool binary) = 0;
  /** Closes the connection, from any thread but the socket's own (not inside an event). No event comes after it returns. */
  virtual void close() = 0;
};

/** A few small named values that outlive a restart: the key, the introduction, the Wi-Fi network. */
struct Storage {
  virtual ~Storage() = default;
  virtual bool load(const char* name, std::string& value) = 0;
  virtual void save(const char* name, const std::string& value) = 0;
  virtual void erase(const char* name) = 0;
};

/** The network the gadget joins. A port with a cable, or a computer, is always "on". */
struct Network {
  virtual ~Network() = default;
  /** Starts joining; returns at once. An empty name leaves the network. */
  virtual void join(const std::string& ssid, const std::string& password) = 0;
  /** "off", "joining", "on" or "failed". */
  virtual const char* state() = 0;
  virtual std::string address() = 0;
  /** The signal of the network in use, in dBm (-30 is strong, -85 weak). 0 when it isn't known. */
  virtual int signal() { return 0; }
};

/** The speaker: 16-bit mono samples. `write` returns when they are queued to play, so it paces the reader. */
struct Speaker {
  virtual ~Speaker() = default;
  virtual bool begin(int rate) = 0;
  virtual void write(const int16_t* samples, size_t count) = 0;
  /** Plays out what is queued, or drops it when `cut`. */
  virtual void end(bool cut) = 0;
  /**
   * The person asked for quiet: drop what is queued now, so the sound stops at once and a `write`
   * that waits returns. Called from any thread, also when nothing plays. `end(true)` follows.
   */
  virtual void cut() {}
};

}  // namespace botkins
