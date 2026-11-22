// What a board gives the core. A port (firmware/esp32 for a real board, firmware/host for a
// computer) fills in these four small interfaces; everything else is the core's.
#pragma once
#include <cstddef>
#include <cstdint>
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
